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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { applySwap, casAdmission, postCasErrors, resumePlan } from "../src/host/epic-staging.mjs";
import {
  attributable,
  cleanupStaging,
  createStaging,
  observeTarget,
  readRef,
  reflogDepth,
  stagingRef,
  swapTarget,
} from "../src/host/staging-driver.mjs";

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

async function repository(t) {
  const root = await mkdtemp(path.join(tmpdir(), "autosk-driver-"));
  t.after(async () => {
    await execFileAsync("chmod", ["-R", "u+w", root]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const git = gitIn(root);
  await git(["init", "--quiet", "--initial-branch=main"]);
  await writeFile(path.join(root, "a.txt"), "one\n");
  await git(["add", "a.txt"]);
  await git(["commit", "--quiet", "-m", "base"]);
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  return { root, git, head };
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
  const { git, head } = await repository(t);
  assert.equal(stagingRef("e-1"), "refs/autosk/epics/e-1/staging");
  const created = await createStaging(git, { epicId: "e-1", base: head });
  assert.deepEqual({ ...created }, { ref: "refs/autosk/epics/e-1/staging", oid: head, created: true });
  // A crash between creating the ref and recording it looks exactly like this.
  const again = await createStaging(git, { epicId: "e-1", base: head });
  assert.equal(again.created, false);
  assert.equal(await readRef(git, "refs/heads/main"), head);
  // And the ref is not a branch: nothing lists it as one.
  const branches = (await git(["branch", "--list"])).stdout;
  assert.ok(!branches.includes("e-1"), branches);
});

test("a staging ref already at another commit is a conflict, not an overwrite", async (t) => {
  const { git, root, head } = await repository(t);
  const other = await commitOnTop(git, root, { parent: head, file: "b.txt", content: "x\n", message: "other" });
  await createStaging(git, { epicId: "e-1", base: other.oid });
  await assert.rejects(() => createStaging(git, { epicId: "e-1", base: head }), code("cas_conflict"));
  assert.equal(await readRef(git, stagingRef("e-1")), other.oid);
});

test("the compare-and-swap is git's, so a concurrent movement refuses the write", async (t) => {
  const { git, root, head } = await repository(t);
  const staged = await commitOnTop(git, root, { parent: head, file: "b.txt", content: "staged\n", message: "staged" });
  // Someone else moves the branch after the base was recorded and before the
  // swap. A read-then-write driver would still overwrite it here.
  const foreign = await commitOnTop(git, root, { parent: head, file: "c.txt", content: "foreign\n", message: "foreign" });
  await git(["update-ref", "refs/heads/main", foreign.oid, head]);

  const result = await swapTarget(git, { ref: "refs/heads/main", expectedOld: head, newOid: staged.oid });
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

  const observed = await observeTarget(git, { ref: "refs/heads/main", recorded: [head, staged.oid] });
  assert.equal(observed.attributed_to_this_epic, false);
  const admission = casAdmission(state({ head, staged }), observed, ["T-1"]);
  assert.equal(admission.decision, "refused");
  assert.ok(admission.reasons.some((reason) => reason.reason === "foreign_target_movement"));
  // Refused means nothing happened: the ref and the bytes are what they were.
  assert.equal(await readRef(git, "refs/heads/main"), foreign.oid);
  assert.equal(await readFile(path.join(root, "c.txt"), "utf8"), before);
});

test("a movement this Epic recorded is attributable, and one it did not is not", async (t) => {
  const { git, root, head } = await repository(t);
  const mine = await commitOnTop(git, root, { parent: head, file: "b.txt", content: "mine\n", message: "mine" });
  const theirs = await commitOnTop(git, root, { parent: head, file: "c.txt", content: "theirs\n", message: "theirs" });
  assert.equal(await attributable(git, { observed: head, recorded: [mine.oid] }), true);
  assert.equal(await attributable(git, { observed: mine.oid, recorded: [mine.oid] }), true);
  assert.equal(await attributable(git, { observed: theirs.oid, recorded: [mine.oid] }), false);
});

test("the swap moves the ref once, and the read-back is checked against the accepted identity", async (t) => {
  const { git, root, head } = await repository(t);
  const staged = await commitOnTop(git, root, { parent: head, file: "b.txt", content: "staged\n", message: "staged" });
  const depthBefore = await reflogDepth(git, "refs/heads/main");

  const result = await swapTarget(git, { ref: "refs/heads/main", expectedOld: head, newOid: staged.oid });
  assert.equal(applySwap({ recorded_target_base: head }, result).outcome, "swapped");

  const after = await observeTarget(git, {
    ref: "refs/heads/main",
    recorded: [head, staged.oid],
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
  await swapTarget(git, { ref: "refs/heads/main", expectedOld: head, newOid: staged.oid });
  // Somebody resets it back and forward again during recovery.
  await git(["update-ref", "refs/heads/main", head, staged.oid]);
  await swapTarget(git, { ref: "refs/heads/main", expectedOld: head, newOid: staged.oid });

  const after = await observeTarget(git, {
    ref: "refs/heads/main",
    recorded: [head, staged.oid],
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

  const observed = await observeTarget(git, { ref: "refs/heads/main", recorded: [head, staged.oid] });
  assert.equal(casAdmission(accepted, observed, ["T-1"]).decision, "may_swap");
  const result = await swapTarget(git, { ref: "refs/heads/main", expectedOld: head, newOid: staged.oid });
  assert.equal(result.swapped, true);

  // And the retry after a crash between the swap and the read-back is complete
  // rather than in conflict.
  const again = await observeTarget(git, { ref: "refs/heads/main", recorded: [head, staged.oid] });
  assert.equal(casAdmission(accepted, again, ["T-1"]).decision, "already_complete");
});

test("cleanup removes the staging ref only while it holds what was recorded", async (t) => {
  const { git, root, head } = await repository(t);
  const staged = await commitOnTop(git, root, { parent: head, file: "b.txt", content: "staged\n", message: "staged" });
  await createStaging(git, { epicId: "e-1", base: staged.oid });
  const moved = await commitOnTop(git, root, { parent: staged.oid, file: "c.txt", content: "late\n", message: "late" });
  await git(["update-ref", stagingRef("e-1"), moved.oid, staged.oid]);

  // Deleting whatever is there would destroy the evidence in the one case worth
  // keeping.
  const refused = await cleanupStaging(git, { epicId: "e-1", expectedOid: staged.oid });
  assert.equal(refused.deleted, false);
  assert.equal(refused.reason, "staging_moved_after_pass");
  assert.equal(await readRef(git, stagingRef("e-1")), moved.oid);

  const removed = await cleanupStaging(git, { epicId: "e-1", expectedOid: moved.oid });
  assert.equal(removed.deleted, true);
  assert.equal(await readRef(git, stagingRef("e-1")), null);
});

test("a git that could not run is an environment failure, not a product refusal", async (t) => {
  const { root } = await repository(t);
  const elsewhere = await mkdtemp(path.join(tmpdir(), "autosk-not-a-repo-"));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  // The distinction #9 refuses to let the gate blur: none of these says
  // anything about the product.
  await assert.rejects(
    () => observeTarget(gitIn(elsewhere), { ref: "refs/heads/main" }),
    (error) => error.code === "environment_failure" && /rev-parse exited 128/u.test(error.message),
  );
  await assert.rejects(
    () => attributable(gitIn(root), { observed: "f".repeat(40), recorded: ["e".repeat(40)] }),
    (error) => error.code === "environment_failure" && /merge-base exited 128/u.test(error.message),
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
    recorded: [head, staged.oid],
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
    () => observeTarget(git, { ref: "refs/heads/main", recorded: [head], recordedResult: "0".repeat(40) }),
    (error) => error.code === "environment_failure" && /merge-base exited/u.test(error.message),
  );
  assert.equal(await readRef(git, "refs/heads/main"), head);
  assert.ok(staged.oid);
});

test("an Epic id that is not a single ref component is refused", () => {
  for (const bad of ["", "../escape", "a/b", "e 1", "-lead"]) {
    assert.throws(() => stagingRef(bad), code("cas_conflict"), bad);
  }
});

/** The durable record #9's guards read, bound to this repository's identities. */
function state({ head, staged }) {
  const base = {
    project_identity: `sha256:${"0".repeat(58)}`,
    epic_id: "e-1",
    staging_ref: stagingRef("e-1"),
    target_ref: "refs/heads/main",
    recorded_target_base: head,
    planning_head: head,
    receipts: [{ ticket_id: "T-1" }],
    phase: "accepted",
    staging_commit_oid: staged.oid,
    staging_tree_oid: staged.tree,
    post_cas: { expected_new_oid: staged.oid },
  };
  const aggregate = {
    outcome: "pass",
    environment_outcome: "ok",
    verification_config_digest: "c".repeat(64),
    instruction_lock_digest: "d".repeat(64),
    staging_commit_oid: base.staging_commit_oid,
    record_hash: "e".repeat(64),
  };
  base.aggregate = { ...aggregate, binding: aggregateBindingOf({ ...base, aggregate }) };
  base.acceptance = {
    kind: "human",
    approver: "owner",
    staging_commit_oid: base.staging_commit_oid,
    staging_tree_oid: base.staging_tree_oid,
    aggregate_record_hash: aggregate.record_hash,
    tickets: ["T-1"],
  };
  return base;
}

const { aggregateBinding: aggregateBindingOf } = await import("../src/host/epic-staging.mjs");
