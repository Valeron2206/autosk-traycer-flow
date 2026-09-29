/**
 * Tests for the staging ref and the final CAS against real repositories
 * (issue #9 driver).
 *
 * These run git. A driver whose compare-and-swap is only described is a driver
 * whose window nobody has closed, so every case here creates a repository,
 * moves refs in it, and reads back what actually happened.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { applySwap, casAdmission, postCasErrors, resumePlan } from "../src/host/epic-staging.mjs";
import {
  assertStagingRef,
  cleanupStaging,
  createStaging,
  epicRefKey,
  observeTarget,
  readRef,
  reflogDepth,
  stagingRef,
  swapTarget,
} from "../src/host/staging-driver.mjs";
import * as stagingDriver from "../src/host/staging-driver.mjs";
import { gitRefCustody } from "./support/git-ref-custody.mjs";

// epicRefKey("0".repeat(64), "e-1"), spelled out so a broken derivation fails a
// test rather than the module load; the golden-vector test checks the derivation.
const EPIC_KEY = "a916c907fd14e54bfb1f3591a573675ccb1fdfeb49a8875c3c10c6bc00c5fb37";

const execFileAsync = promisify(execFile);
const code = (name) => (error) => error.code === name;

/** The injected git: the real one, with its exit status kept rather than thrown. */
const gitIn = (cwd) => async (args) =>
  execFileAsync("git", args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_AUTHOR_NAME: "autosk test",
      GIT_AUTHOR_EMAIL: "test@autosk.invalid",
      GIT_COMMITTER_NAME: "autosk test",
      GIT_COMMITTER_EMAIL: "test@autosk.invalid",
    },
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error) => ({ code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) }),
  );

async function repository(t, { objectFormat = "sha1" } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "autosk-driver-"));
  t.after(async () => {
    await execFileAsync("chmod", ["-R", "u+w", root]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const git = gitIn(root);
  await git(["init", "--quiet", "--initial-branch=main", `--object-format=${objectFormat}`]);
  await writeFile(path.join(root, "a.txt"), "one\n");
  await git(["add", "a.txt"]);
  await git(["commit", "--quiet", "-m", "base"]);
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  // The helper's stand-in: every write under refs/autosk/** goes through it.
  return { root, git, head, custody: gitRefCustody(root) };
}

/** A commit off the target branch, the way an Epic accumulates on staging. */
async function commitOnTop(git, root, { parent, file, content, message }) {
  await writeFile(path.join(root, file), content);
  await git(["add", file]);
  const tree = (await git(["write-tree"])).stdout.trim();
  const oid = (await git(["commit-tree", tree, "-p", parent, "-m", message])).stdout.trim();
  await git(["reset", "--quiet", "--hard", parent]);
  return { oid, tree };
}

test("the staging ref is private, and creating it twice at the same base is a retry", async (t) => {
  const { git, head, custody } = await repository(t);
  assert.equal(stagingRef(EPIC_KEY), `refs/autosk/epics/${EPIC_KEY}/staging`);
  const created = await createStaging(custody, { generation: 0, epicRefKey: EPIC_KEY, base: head });
  assert.deepEqual({ ...created }, { ref: `refs/autosk/epics/${EPIC_KEY}/staging`, oid: head, created: true });
  // A crash between creating the ref and recording it looks exactly like this.
  const again = await createStaging(custody, { generation: 0, epicRefKey: EPIC_KEY, base: head });
  assert.equal(again.created, false);
  assert.equal(await readRef(git, "refs/heads/main"), head);
  // And the ref is not a branch: nothing lists it as one.
  const branches = (await git(["for-each-ref", "--format=%(refname)", "refs/heads"])).stdout.trim().split("\n");
  assert.deepEqual(branches, ["refs/heads/main"]);
});

test("a staging ref already at another commit is a conflict, not an overwrite", async (t) => {
  const { git, root, head, custody } = await repository(t);
  const other = await commitOnTop(git, root, { parent: head, file: "b.txt", content: "x\n", message: "other" });
  await createStaging(custody, { generation: 0, epicRefKey: EPIC_KEY, base: other.oid });
  await assert.rejects(() => createStaging(custody, { generation: 0, epicRefKey: EPIC_KEY, base: head }), code("cas_conflict"));
  assert.equal(await readRef(git, stagingRef(EPIC_KEY)), other.oid);
});

test("the compare-and-swap is git's, so a concurrent movement refuses the write", async (t) => {
  const { git, root, head } = await repository(t);
  const staged = await commitOnTop(git, root, { parent: head, file: "b.txt", content: "staged\n", message: "staged" });
  // Someone else moves the branch after the base was recorded and before the
  // swap. A read-then-write driver would still overwrite it here.
  const foreign = await commitOnTop(git, root, { parent: head, file: "c.txt", content: "foreign\n", message: "foreign" });
  await git(["update-ref", "refs/heads/main", foreign.oid, head]);

  const result = await swapTarget(git, { ref: "refs/heads/main", expectedOld: head, newOid: staged.oid, state: { recorded_target_base: head } });
  assert.equal(result.swapped, false);
  assert.equal(result.observed_old_oid, foreign.oid);
  // The foreign commit is still what the branch holds: nothing was overwritten.
  assert.equal(await readRef(git, "refs/heads/main"), foreign.oid);
  const decision = applySwap({ recorded_target_base: head }, result);
  assert.equal(decision.outcome, "conflict");
  assert.equal(decision.reason, "cas_conflict");
});

test("a foreign movement is refused before the swap and the target keeps its bytes", async (t) => {
  const { git, root, head } = await repository(t);
  const staged = await commitOnTop(git, root, { parent: head, file: "b.txt", content: "staged\n", message: "staged" });
  const foreign = await commitOnTop(git, root, { parent: head, file: "c.txt", content: "foreign\n", message: "foreign" });
  await git(["update-ref", "refs/heads/main", foreign.oid, head]);
  await git(["reset", "--quiet", "--hard", "refs/heads/main"]);
  const before = await readFile(path.join(root, "c.txt"), "utf8");

  const observed = await observeTarget(git, { ref: "refs/heads/main" });
  const admission = casAdmission(state({ head, staged }), observed, ["T-1"]);
  assert.equal(admission.decision, "refused");
  assert.ok(admission.reasons.some((reason) => reason.reason === "foreign_target_movement"));
  // Refused means nothing happened: the ref and the bytes are what they were.
  assert.equal(await readRef(git, "refs/heads/main"), foreign.oid);
  assert.equal(await readFile(path.join(root, "c.txt"), "utf8"), before);
});

test("the swap moves the ref once, and the read-back is checked against the accepted identity", async (t) => {
  const { git, root, head } = await repository(t);
  const staged = await commitOnTop(git, root, { parent: head, file: "b.txt", content: "staged\n", message: "staged" });
  const depthBefore = await reflogDepth(git, "refs/heads/main");

  const result = await swapTarget(git, { ref: "refs/heads/main", expectedOld: head, newOid: staged.oid, state: { recorded_target_base: head } });
  assert.equal(applySwap({ recorded_target_base: head }, result).outcome, "swapped");

  const after = await observeTarget(git, {
    ref: "refs/heads/main",
    recordedResult: staged.oid,
    reflogBefore: depthBefore,
  });
  assert.equal(after.oid, staged.oid);
  assert.equal(after.tree_oid, staged.tree);
  assert.equal(after.contains_recorded_result, true);
  // A delta, not a total: the branch's own history says nothing about this one
  // operation.
  assert.equal(after.reflog_entries, 1);
  assert.deepEqual(postCasErrors(state({ head, staged }), after), []);
});

test("a ref that moved away and back reads as expected and is caught by the reflog", async (t) => {
  const { git, root, head } = await repository(t);
  const staged = await commitOnTop(git, root, { parent: head, file: "b.txt", content: "staged\n", message: "staged" });
  const depthBefore = await reflogDepth(git, "refs/heads/main");
  await swapTarget(git, { ref: "refs/heads/main", expectedOld: head, newOid: staged.oid, state: { recorded_target_base: head } });
  // Somebody resets it back and forward again during recovery.
  await git(["update-ref", "refs/heads/main", head, staged.oid]);
  await swapTarget(git, { ref: "refs/heads/main", expectedOld: head, newOid: staged.oid, state: { recorded_target_base: head } });

  const after = await observeTarget(git, {
    ref: "refs/heads/main",
    recordedResult: staged.oid,
    reflogBefore: depthBefore,
  });
  assert.equal(after.oid, staged.oid);
  assert.equal(after.reflog_entries, 3);
  assert.ok(postCasErrors(state({ head, staged }), after).some((error) => error.reason === "post_cas_mismatch"));
});

test("a crash after the aggregate passed resumes into the swap with no model run", async (t) => {
  const { git, root, head } = await repository(t);
  const staged = await commitOnTop(git, root, { parent: head, file: "b.txt", content: "staged\n", message: "staged" });
  const accepted = state({ head, staged });
  const plan = resumePlan({ ...accepted, phase: "accepted" });
  assert.equal(plan.requires_model_run, false);

  const observed = await observeTarget(git, { ref: "refs/heads/main" });
  assert.equal(casAdmission(accepted, observed, ["T-1"], casContext(accepted)).decision, "may_swap");
  const result = await swapTarget(git, { ref: "refs/heads/main", expectedOld: head, newOid: staged.oid, state: { recorded_target_base: head } });
  assert.equal(result.swapped, true);

  // And the retry after a crash between the swap and the read-back is complete
  // rather than in conflict.
  const again = await observeTarget(git, { ref: "refs/heads/main" });
  assert.equal(casAdmission(accepted, again, ["T-1"], casContext(accepted)).decision, "already_complete");
});

test("cleanup removes the staging ref only while it holds what was recorded", async (t) => {
  const { git, root, head, custody } = await repository(t);
  const staged = await commitOnTop(git, root, { parent: head, file: "b.txt", content: "staged\n", message: "staged" });
  await createStaging(custody, { generation: 0, epicRefKey: EPIC_KEY, base: staged.oid });
  const moved = await commitOnTop(git, root, { parent: staged.oid, file: "c.txt", content: "late\n", message: "late" });
  await git(["update-ref", stagingRef(EPIC_KEY), moved.oid, staged.oid]);

  // Deleting whatever is there would destroy the evidence in the one case worth
  // keeping.
  const refused = await cleanupStaging(custody, { generation: 0, epicRefKey: EPIC_KEY, expectedOid: staged.oid });
  assert.equal(refused.deleted, false);
  assert.equal(refused.reason, "staging_moved_after_pass");
  assert.equal(await readRef(git, stagingRef(EPIC_KEY)), moved.oid);

  const removed = await cleanupStaging(custody, { generation: 0, epicRefKey: EPIC_KEY, expectedOid: moved.oid });
  assert.equal(removed.deleted, true);
  assert.equal(await readRef(git, stagingRef(EPIC_KEY)), null);
});

test("a git that could not run is an environment failure, not a product refusal", async (t) => {
  const elsewhere = await mkdtemp(path.join(tmpdir(), "autosk-not-a-repo-"));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  // The distinction #9 refuses to let the gate blur: none of these says
  // anything about the product.
  await assert.rejects(
    () => observeTarget(gitIn(elsewhere), { ref: "refs/heads/main" }),
    (error) => error.code === "environment_failure" && /rev-parse exited 128/u.test(error.message),
  );
  // Asserted by its own message, because both guards answer with the same code
  // and a test that only reads the code cannot tell which one fired.
  await assert.rejects(
    () => observeTarget(async () => ({ code: 3, stdout: "", stderr: "broken" }), { ref: "refs/heads/main" }),
    (error) => error.code === "environment_failure" && /rev-parse exited 3/u.test(error.message),
  );
});

test("a target ref that does not exist is not read as an empty one", async (t) => {
  const { git } = await repository(t);
  await assert.rejects(
    () => observeTarget(git, { ref: "refs/heads/never" }),
    (error) => error.code === "environment_failure" && /does not exist/u.test(error.message),
  );
  assert.equal(await readRef(git, "refs/heads/never"), null);
});

test("a target that does not contain the recorded result fails the read-back", async (t) => {
  const { git, root, head } = await repository(t);
  const staged = await commitOnTop(git, root, { parent: head, file: "b.txt", content: "staged\n", message: "staged" });
  const elsewhere = await commitOnTop(git, root, { parent: head, file: "c.txt", content: "else\n", message: "else" });
  const depthBefore = await reflogDepth(git, "refs/heads/main");
  // The branch moved, and to something the accepted result is not in.
  await git(["update-ref", "refs/heads/main", elsewhere.oid, head]);

  const after = await observeTarget(git, {
    ref: "refs/heads/main",
    recordedResult: staged.oid,
    reflogBefore: depthBefore,
  });
  assert.equal(after.contains_recorded_result, false);
  const errors = postCasErrors(state({ head, staged }), after);
  assert.ok(errors.some((error) => /not contained/u.test(error.detail)), JSON.stringify(errors));
});

test("a containment question git could not answer is an environment failure", async (t) => {
  const { git, root, head } = await repository(t);
  const staged = await commitOnTop(git, root, { parent: head, file: "b.txt", content: "staged\n", message: "staged" });
  await assert.rejects(
    () => observeTarget(git, { ref: "refs/heads/main", recordedResult: "0".repeat(40) }),
    (error) => error.code === "environment_failure" && /merge-base exited/u.test(error.message),
  );
  assert.equal(await readRef(git, "refs/heads/main"), head);
  assert.ok(staged.oid);
});

test("a name that is not an Epic ref key is refused", () => {
  for (const bad of ["", "../escape", "a/b", "e 1", "-lead", "e-1"]) {
    assert.throws(() => stagingRef(bad), code("custody_request_invalid"), bad);
  }
});

/** The durable record #9's guards read, bound to this repository's identities. */
function state({ head, staged }) {
  const base = {
    project_identity: `sha256:${"0".repeat(64)}`,
    epic_id: "e-1",
    staging_ref: stagingRef(EPIC_KEY),
    target_ref: "refs/heads/main",
    recorded_target_base: head,
    planning_head: head,
    receipts: [{ ticket_id: "T-1", applied_commit_oid: staged.oid }],
    phase: "accepted",
    staging_commit_oid: staged.oid,
    staging_tree_oid: staged.tree,
    post_cas: { expected_new_oid: staged.oid },
  };
  // The record the staging schema closes, named by its digest (ADR-099).
  const aggregate = {
    outcome: "pass",
    environment_outcome: "ok",
    verification_config_digest: "c".repeat(64),
    instruction_lock_digest: "d".repeat(64),
    staging_commit_oid: base.staging_commit_oid,
    staging_tree_oid: base.staging_tree_oid,
    included_tickets: ["T-1"],
  };
  base.aggregate = { ...aggregate, record_hash: aggregateRecordHashOf(base, aggregate) };
  base.acceptance = {
    kind: "human",
    decision_id: "dec-1",
    staging_commit_oid: base.staging_commit_oid,
    staging_tree_oid: base.staging_tree_oid,
    aggregate_record_hash: base.aggregate.record_hash,
    included_tickets: ["T-1"],
    target_ref: base.target_ref,
    recorded_target_base: base.recorded_target_base,
    delivery_profile_digest: PROFILE.deliveryProfileDigest,
    delivery_mode: "merge",
    integration_authorization_id: "iar-1",
    integration_authorization_sha256: integrationAuthorizationHashOf(authorizationFor(base)),
  };
  return base;
}

/** The IntegrationAuthorizationRecord the acceptance stands on (debt 11b). */
function authorizationFor(accepted) {
  return {
    schema_version: 1,
    record_id: "iar-1",
    scope_id: "epic:e-1",
    project_root_sha256: "0".repeat(64),
    epic_id: accepted.epic_id,
    run_id: "run-1",
    target_ref: accepted.target_ref,
    initial_target_oid: accepted.recorded_target_base,
    ordered_ticket_commit_oids: [accepted.staging_commit_oid],
    ref_transition: { from_oid: accepted.recorded_target_base, to_oid: accepted.staging_commit_oid },
    final_tree_oid: accepted.staging_tree_oid,
    integration_plan_hash: "1".repeat(64),
    controlling_anchor_digest: "2".repeat(64),
    classifier_proof_hash: "3".repeat(64),
    relevant_authority_projection_hash: "4".repeat(64),
    dependency_head_hash: "5".repeat(64),
    intent_head_hash: "6".repeat(64),
    previous_authorization_head_hash: null,
    expires_at: "2100-01-01T00:00:00Z",
    terminal_disposition: "active",
    issued_by: "user_decision_record",
    user_decision_record_id: "udr-1",
    user_decision_record_hash: "7".repeat(64),
  };
}

/** What the CAS is asked under: the profile in force, the record the acceptance names, and the instant. */
const casContext = (accepted) => ({ ...PROFILE, authorization: authorizationFor(accepted), nowMs: Date.parse("2026-09-27T00:00:00Z") });

/** The delivery profile in force when the swap is admitted. */
const PROFILE = Object.freeze({ deliveryProfileDigest: "f".repeat(64) });

const { aggregateRecordHash: aggregateRecordHashOf, integrationAuthorizationHash: integrationAuthorizationHashOf } = await import("../src/host/epic-staging.mjs");

test("the staging ref is named by epic_ref_key, the same key the planning ref uses", async () => {
  // Round 6 of #39 (R6-1): the driver built the name from the raw Epic id,
  // while 01 §7 and epic-staging.md require the domain-separated key. The golden
  // vector is the planning-publication example, whose validator derives it.
  const { epicRefKey } = await import("../src/host/staging-driver.mjs");
  const example = JSON.parse(await readFile(new URL("../resources/planning-publication/publish-artifact-pass-operation.example.json", import.meta.url), "utf8"));
  const key = epicRefKey(example.project_root_sha256, example.epic_id);
  assert.equal(key, example.epic_ref_key);
  assert.equal(stagingRef(key), `refs/autosk/epics/${key}/staging`);
  // Another project with the same Epic id is another key.
  assert.notEqual(epicRefKey("b".repeat(64), example.epic_id), key);
  for (const bad of ["e-1", "epic-0001", key.toUpperCase(), key.slice(1), `${key}0`]) {
    assert.throws(() => stagingRef(bad), code("custody_request_invalid"), bad);
  }
  assert.equal(epicRefKey("0".repeat(64), "e-1"), EPIC_KEY);
  assert.throws(() => epicRefKey("not-a-digest", example.epic_id), code("custody_request_invalid"));
  for (const epicId of ["", undefined, 7, null]) {
    assert.throws(() => epicRefKey("0".repeat(64), epicId), code("custody_request_invalid"), String(epicId));
  }
});

test("the host moves only an Epic's staging ref: anything else is refused by name", () => {
  // ADR-088. integrateApproved is the only writer of a target ref, so the
  // host's apply accepts a staging ref named by an Epic ref key and nothing
  // else — not the user's branch, not a raw id, not another private ref.
  const staging = stagingRef(EPIC_KEY);
  assert.equal(assertStagingRef(staging), staging);
  for (const ref of [
    "refs/heads/main",
    "refs/autosk/epics/e-1/staging",
    `refs/autosk/epics/${EPIC_KEY}/planning`,
    `${staging}/x`,
    `x${staging}`,
    undefined,
    // A value that is not a string is refused even when it prints as one.
    { toString: () => staging },
  ]) {
    assert.throws(() => assertStagingRef(ref), code("custody_request_invalid"), String(ref));
  }
});

// --- debt 11a: the helper writes the staging ref; the host asks ----------------

test("creating and removing the staging ref are requests to the ref-custody helper", async (t) => {
  // ADR-095. The separate-account helper is the only writer of refs/autosk/**:
  // the driver forms the one request each action carries and reads the answer.
  const { git, head, custody } = await repository(t);
  const ref = stagingRef(EPIC_KEY);
  await createStaging(custody, { generation: 0, epicRefKey: EPIC_KEY, base: head });
  await cleanupStaging(custody, { generation: 0, epicRefKey: EPIC_KEY, expectedOid: head });
  // Each request carries a pair of its own, derived from what it asks (the ref, the generation, the commit): the create and
  // the delete are two requests.
  const pairs = custody.requests.map(({ owner_operation_id: owner, request_id: request }) => ({ owner, request }));
  for (const { owner, request } of pairs) assert.match(`${owner} ${request}`, /^[0-9a-f-]{36} [0-9a-f-]{36}$/u);
  assert.notEqual(pairs[0].request, pairs[1].request);
  assert.deepEqual(custody.requests.map(({ owner_operation_id: owner, request_id: request, ...rest }) => JSON.parse(JSON.stringify(rest))), [
    { action: "create_staging", ref_updates: [{ operation: "update", ref, expected_old_oid: null, new_oid: head }] },
    { action: "delete_staging", ref_updates: [{ operation: "delete", ref, expected_old_oid: head, new_oid: null }] },
  ]);
  assert.equal(await readRef(git, ref), null);
  // The helper created the ref's reflog, so the post-CAS check can count on it.
  await createStaging(custody, { generation: 0, epicRefKey: EPIC_KEY, base: head });
  assert.equal(await reflogDepth(git, ref), 1);
});

test("a create or a cleanup made under no generation of the staging record is refused before the helper is asked (debt 12g)", async (t) => {
  const { git, head, custody } = await repository(t);
  const ref = stagingRef(EPIC_KEY);
  for (const generation of [undefined, null, -1, 1.5, "0", Number.NaN]) {
    await assert.rejects(() => createStaging(custody, { epicRefKey: EPIC_KEY, base: head, generation }), code("custody_request_invalid"), String(generation));
    await assert.rejects(() => cleanupStaging(custody, { epicRefKey: EPIC_KEY, expectedOid: head, generation }), code("custody_request_invalid"), String(generation));
  }
  assert.equal(await readRef(git, ref), null);
  assert.equal(custody.requests.length, 0, "a request that named no generation was asked");
});

/** A helper stand-in that answers a repeated request as the daemon's journal does: the same answer, no second transaction. */
function replaying(custody) {
  const answered = new Map();
  const wrap = (action) => async (request) => {
    if (answered.has(request.request_id)) return answered.get(request.request_id);
    const answer = await custody[action](request);
    answered.set(request.request_id, answer);
    return answer;
  };
  return { requests: custody.requests, create_staging: wrap("create_staging"), delete_staging: wrap("delete_staging"), advance_staging: wrap("advance_staging") };
}

test("a re-stage or a rebuild asks under a pair of its own: the create and the delete of one generation are a retry, the next generation's are new requests (review N6)", async (t) => {
  const { git, head, custody } = await repository(t);
  const daemon = replaying(custody);
  const ref = stagingRef(EPIC_KEY);
  await createStaging(daemon, { epicRefKey: EPIC_KEY, base: head, generation: 0 });
  assert.equal(await readRef(git, ref), head);
  // The person's cleanup, then a rebuild at the same base: the record is the same, its generation is the next.
  await cleanupStaging(daemon, { epicRefKey: EPIC_KEY, expectedOid: head, generation: 0 });
  assert.equal(await readRef(git, ref), null);
  await createStaging(daemon, { epicRefKey: EPIC_KEY, base: head, generation: 1 });
  assert.equal(await readRef(git, ref), head, "the daemon answered a rebuild's create from the journal of the first create, and the ref was never made");
  await cleanupStaging(daemon, { epicRefKey: EPIC_KEY, expectedOid: head, generation: 1 });
  assert.equal(await readRef(git, ref), null, "the daemon answered a rebuild's delete from the journal of the first delete");
  // A re-stage onto a moved base: a new commit, a new generation, and the same again.
  const other = (await git(["commit-tree", (await git(["rev-parse", `${head}^{tree}`])).stdout.trim(), "-m", "moved"])).stdout.trim();
  await createStaging(daemon, { epicRefKey: EPIC_KEY, base: other, generation: 2 });
  assert.equal(await readRef(git, ref), other);
  // The same generation asked again is the retry it is: the daemon's answer is replayed, whatever the ref holds now.
  await git(["update-ref", "-d", ref]);
  const replayed = await createStaging(daemon, { epicRefKey: EPIC_KEY, base: other, generation: 2 });
  assert.equal(replayed.created, true);
  assert.equal(await readRef(git, ref), null, "a retry of one create made the ref again");
  // Four distinct creates and deletes, and one repeated request.
  const pairs = new Set(custody.requests.map((request) => request.request_id));
  assert.equal(custody.requests.length, 5);
  assert.equal(pairs.size, 5);
});

test("with no helper the staging ref is neither created nor removed, and the host writes nothing itself", async (t) => {
  // The product default client answers no action (the helper is #5 work), so
  // the drivers refuse rather than fall back to a direct `git update-ref`.
  const { git, head, custody } = await repository(t);
  const ref = stagingRef(EPIC_KEY);
  await assert.rejects(() => createStaging(undefined, { generation: 0, epicRefKey: EPIC_KEY, base: head }), code("planning_ref_capability_missing"));
  assert.equal(await readRef(git, ref), null);
  await createStaging(custody, { generation: 0, epicRefKey: EPIC_KEY, base: head });
  await assert.rejects(() => cleanupStaging(undefined, { generation: 0, epicRefKey: EPIC_KEY, expectedOid: head }), code("planning_ref_capability_missing"));
  assert.equal(await readRef(git, ref), head);
});

test("a refused create reads what the ref holds from the helper's answer", async () => {
  // No git runs in the driver at all: the answer carries the observation.
  const held = "4".repeat(40);
  const base = "5".repeat(40);
  const refusing = {
    create_staging: async (request) => ({
      action: request.action,
      status: "not_applied",
      not_applied_reason: "expected_old_mismatch",
      ref_observations: request.ref_updates.map((update) => ({
        operation: update.operation,
        ref: update.ref,
        expected_old_oid: update.expected_old_oid,
        requested_new_oid: update.new_oid,
        observed_old_oid: held,
        observed_new_oid: held,
      })),
    }),
  };
  await assert.rejects(() => createStaging(refusing, { generation: 0, epicRefKey: EPIC_KEY, base }), (error) =>
    error.code === "cas_conflict" && error.details.held === held && error.details.expected === base);
  const retried = await createStaging(refusing, { generation: 0, epicRefKey: EPIC_KEY, base: held });
  assert.deepEqual({ ...retried }, { ref: stagingRef(EPIC_KEY), oid: held, created: false });
});

test("swapTarget refuses any ref under refs/autosk/**, which is the helper's alone (review L4)", async (t) => {
  // ADR-095: the target-CAS mechanics the daemon's adapter carries move a
  // target ref; a private ref under refs/autosk/** has one writer, the helper.
  const { git, root, head, custody } = await repository(t);
  const staged = await commitOnTop(git, root, { parent: head, file: "b.txt", content: "staged\n", message: "staged" });
  await createStaging(custody, { generation: 0, epicRefKey: EPIC_KEY, base: head });
  for (const ref of [stagingRef(EPIC_KEY), `refs/autosk/epics/${EPIC_KEY}/planning`, "refs/autosk/anything"]) {
    await assert.rejects(() => swapTarget(git, { ref, expectedOld: head, newOid: staged.oid, state: { recorded_target_base: head } }), code("custody_request_invalid"), ref);
  }
  assert.equal(await readRef(git, stagingRef(EPIC_KEY)), head);
  // A target ref is still swapped.
  assert.equal((await swapTarget(git, { ref: "refs/heads/main", expectedOld: head, newOid: staged.oid, state: { recorded_target_base: head } })).swapped, true);
});

// --- debt 11d: one object format ----------------------------------------------

test("a SHA-256 repository's refs and reflogs are read as they are, not as absent (R7-31)", async (t) => {
  // Round 7 of #39, R7-31: readRef and the reflog readers took only 40-hex
  // OIDs, so in a SHA-256 repository a present ref read as absent and every
  // reflog as empty, and foreign movement was misread (ADR-098).
  const { git, root, head, custody } = await repository(t, { objectFormat: "sha256" });
  assert.equal(head.length, 64);
  assert.equal(await readRef(git, "refs/heads/main"), head);
  assert.equal(await reflogDepth(git, "refs/heads/main"), 1);
  const staged = await commitOnTop(git, root, { parent: head, file: "b.txt", content: "staged\n", message: "staged" });
  const ref = stagingRef(EPIC_KEY);
  assert.deepEqual({ ...(await createStaging(custody, { generation: 0, epicRefKey: EPIC_KEY, base: head })) }, { ref, oid: head, created: true });
  assert.equal(await readRef(git, ref), head);
  assert.equal(await reflogDepth(git, ref), 1);
  // Creating it again at the same base is the retry, read from what the ref holds.
  assert.equal((await createStaging(custody, { generation: 0, epicRefKey: EPIC_KEY, base: head })).created, false);

  const depthBefore = await reflogDepth(git, "refs/heads/main");
  assert.equal((await swapTarget(git, { ref: "refs/heads/main", expectedOld: head, newOid: staged.oid, state: { recorded_target_base: head } })).swapped, true);
  const after = await observeTarget(git, {
    ref: "refs/heads/main",
    recordedResult: staged.oid,
    reflogBefore: depthBefore,
  });
  assert.deepEqual({ ...after }, {
    oid: staged.oid,
    tree_oid: staged.tree,
    reflog_entries: 1,
    contains_recorded_result: true,
  });
  // A refused swap reports what the ref holds, in the repository's format.
  const refused = await swapTarget(git, { ref: "refs/heads/main", expectedOld: head, newOid: head, state: { recorded_target_base: head } });
  assert.deepEqual({ swapped: refused.swapped, observed_old_oid: refused.observed_old_oid }, { swapped: false, observed_old_oid: staged.oid });
  assert.deepEqual({ ...(await cleanupStaging(custody, { generation: 0, epicRefKey: EPIC_KEY, expectedOid: head })) }, { ref, deleted: true });
  assert.equal(await readRef(git, ref), null);
});

test("the target observation attributes no movement to the Epic: a rewind and a move into its own line are foreign at the CAS (R7-16)", async (t) => {
  // Round 7 of #39, R7-16: `attributable` called a movement this Epic's when
  // the target stood on an ancestor of a commit the Epic recorded — which a
  // rewind below the base and someone else's fast-forward into the Epic's
  // unlanded line both are. Under the one CAS neither is this Epic's: its only
  // movement is its own result, and that reads already_complete first.
  const { git, root, head: older } = await repository(t);
  const base = await commitOnTop(git, root, { parent: older, file: "b.txt", content: "base\n", message: "base" });
  await git(["update-ref", "refs/heads/main", base.oid, older]);
  const planning = await commitOnTop(git, root, { parent: base.oid, file: "plan.md", content: "plan\n", message: "planning head" });
  const staged = await commitOnTop(git, root, { parent: planning.oid, file: "t.txt", content: "T-1\n", message: "T-1 applied" });
  const accepted = state({ head: base.oid, staged });
  for (const [label, moved] of [["a rewind below the base", older], ["a move into the Epic's own line", planning.oid]]) {
    await git(["update-ref", "refs/heads/main", moved]);
    const observed = await observeTarget(git, { ref: "refs/heads/main" });
    assert.ok(!Object.hasOwn(observed, "attributed_to_this_epic"), `${label}: the observation attributes the movement`);
    const admission = casAdmission(accepted, observed, ["T-1"], casContext(accepted));
    assert.equal(admission.decision, "refused", label);
    assert.deepEqual(
      admission.reasons.filter((entry) => entry.reason.includes("target")).map((entry) => entry.reason),
      ["foreign_target_movement"],
      label,
    );
  }
  await git(["update-ref", "refs/heads/main", staged.oid]);
  const landed = await observeTarget(git, { ref: "refs/heads/main" });
  assert.equal(casAdmission(accepted, landed, ["T-1"], casContext(accepted)).decision, "already_complete");
});

test("a read of the reflog that fails is an environment failure unless the ref is not there, and only then is its depth none (review F4)", async (t) => {
  const { git, head } = await repository(t);
  const ref = stagingRef(EPIC_KEY);
  const failing = (exit) => async (args) => (args.includes("reflog") ? { code: exit, stdout: "", stderr: "fatal: a transient fault" } : git(args));
  // A ref that is not there has no reflog: none, and no failure. Git's own exit for it (128) is the exit a failing read shares.
  assert.equal(await reflogDepth(git, ref), 0);
  await git(["update-ref", "--create-reflog", "-m", "fixture: staging created", ref, head]);
  assert.equal(await reflogDepth(git, ref), 1);
  // The same exit from a ref that is there is a failing read: it says nothing about the line.
  for (const exit of [1, 2, 128]) {
    const error = await reflogDepth(failing(exit), ref).then(() => null, (thrown) => thrown);
    assert.equal(error?.code, "environment_failure", `exit ${exit}`);
    assert.equal(error.message, `git reflog exited ${exit}`);
  }
  // Another exit is a failure even for an absent ref: only git's two "no such ref" answers are read as none.
  await git(["update-ref", "-d", ref]);
  assert.equal(await reflogDepth(failing(1), ref), 0);
  assert.equal(await reflogDepth(failing(128), ref), 0);
  const other = await reflogDepth(failing(2), ref).then(() => null, (thrown) => thrown);
  assert.equal(other?.code, "environment_failure");
});

test("the newest reflog entry: none for an absent ref or a ref without a reflog, and a failing read of a ref that is there is not none (review F4)", async (t) => {
  const { git, head } = await repository(t);
  const ref = stagingRef(EPIC_KEY);
  const failing = (exit) => async (args) => (args.includes("reflog") ? { code: exit, stdout: "", stderr: "fatal: a transient fault" } : git(args));
  assert.equal(await stagingDriver.reflogNewest(git, ref, "%gs"), null);
  await git(["update-ref", "--create-reflog", "-m", "fixture: staging created", ref, head]);
  assert.equal(await stagingDriver.reflogNewest(git, ref, "%gs"), "fixture: staging created");
  for (const exit of [1, 2, 128]) {
    const error = await stagingDriver.reflogNewest(failing(exit), ref, "%gs").then(() => null, (thrown) => thrown);
    assert.equal(error?.code, "environment_failure", `exit ${exit}`);
    assert.equal(error.message, `git reflog exited ${exit}`);
  }
  await git(["update-ref", "-d", ref]);
  assert.equal(await stagingDriver.reflogNewest(failing(128), ref, "%gs"), null);
  assert.equal((await stagingDriver.reflogNewest(failing(2), ref, "%gs").then(() => null, (thrown) => thrown))?.code, "environment_failure");
});

test("the newest reflog entry is the marked line, whatever the repository prints around it, and a ref with no reflog has none (review F1)", async (t) => {
  const { root, git, head } = await repository(t);
  const ref = stagingRef(EPIC_KEY);
  const tool = path.join(path.dirname(root), `fakegpg-${path.basename(root)}`);
  t.after(() => rm(tool, { force: true }));
  await writeFile(tool, '#!/bin/sh\necho "gpg: Signature made Thu Nov 14 22:13:20 2023 UTC" >&2\necho "gpg: Good signature" >&2\nexit 0\n');
  await chmod(tool, 0o755);
  const tree = (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim();
  const body = `tree ${tree}\nauthor p <p@x> 1700000000 +0000\ncommitter p <p@x> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nsigned\n`;
  const signed = await new Promise((resolve, reject) => {
    const child = execFile("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: root, env: { PATH: process.env.PATH, HOME: root } }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim())));
    child.stdin.end(body);
  });
  await git(["config", "log.showSignature", "true"]);
  await git(["config", "gpg.program", tool]);
  // A ref whose entry names a signed commit: git writes a report in front of the entry, and the first line is not the entry.
  await git(["update-ref", "--create-reflog", "-m", "the entry", ref, signed]);
  assert.match((await git(["reflog", "show", "--format=%gs", "-n", "1", ref])).stdout.split("\n")[0], /^gpg: /u, "the fixture does not show a signature");
  assert.equal(await stagingDriver.reflogNewest(git, ref, "%gs"), "the entry");
  assert.equal(await stagingDriver.reflogNewest(git, ref, "%H%x1f%gs"), `${signed}\u001fthe entry`);
  // A ref that keeps no reflog has no entry, and that is not a failure.
  const bare = stagingRef("b".repeat(64));
  await git(["update-ref", bare, head]);
  assert.equal(await stagingDriver.reflogNewest(git, bare, "%gs"), null);
});

test("swapTarget asks git only for a swap from the base the record names: any other expected-old is refused before update-ref (debt 13a review N2)", async (t) => {
  const { git, root, head } = await repository(t);
  const staged = await commitOnTop(git, root, { parent: head, file: "b.txt", content: "staged\n", message: "staged" });
  const asked = [];
  const watching = async (args, options) => { asked.push(args[0]); return git(args, options); };
  const other = await commitOnTop(git, root, { parent: head, file: "c.txt", content: "other\n", message: "other" });
  for (const state of [{ recorded_target_base: other.oid }, { recorded_target_base: "" }, {}, undefined]) {
    await assert.rejects(() => swapTarget(watching, { ref: "refs/heads/main", expectedOld: head, newOid: staged.oid, state }), code("custody_request_invalid"), JSON.stringify(state));
  }
  assert.deepEqual(asked, [], "git was asked over a swap from a base the record does not name");
  assert.equal(await readRef(git, "refs/heads/main"), head);
  // From the recorded base it swaps.
  assert.equal((await swapTarget(watching, { ref: "refs/heads/main", expectedOld: head, newOid: staged.oid, state: { recorded_target_base: head } })).swapped, true);
});
