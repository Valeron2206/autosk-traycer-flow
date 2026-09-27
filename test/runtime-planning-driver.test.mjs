/**
 * Tests for publishing a planning artefact to the planning ref (issue #5 driver).
 *
 * The state machine already has its own tests. What is tested here is the half
 * it cannot check: that a real repository produces the observation the machine
 * reads, and that its actions do what they say to real objects and refs.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { publicationDecision } from "../src/host/planning-publication.mjs";
import {
  advanceRef,
  observeObject,
  observeRef,
  publishedTrailers,
  reflogEntries,
  rewriteExactObject,
  writeCommitObject,
} from "../src/host/planning-driver.mjs";
import { readRef, reflogDepth } from "../src/host/staging-driver.mjs";
import { gitRefCustody } from "./support/git-ref-custody.mjs";

const execFileAsync = promisify(execFile);
const code = (name) => (error) => error.code === name;
// The helper's grammar (ADR-095): the host asks for no ref outside it, so the
// fixture names the planning ref and the live candidate keepalive by an Epic
// ref key, as epic-planning-ref.md does.
const EPIC_KEY = "a916c907fd14e54bfb1f3591a573675ccb1fdfeb49a8875c3c10c6bc00c5fb37";
const PLANNING_REF = `refs/autosk/epics/${EPIC_KEY}/planning`;
const KEEPALIVE_REF = `refs/autosk/epics/${EPIC_KEY}/candidates/${"c".repeat(64)}`;

const gitIn = (cwd) => async (args, { env = {}, stdin } = {}) => {
  const child = execFileAsync("git", args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_AUTHOR_NAME: "autosk test",
      GIT_AUTHOR_EMAIL: "test@autosk.invalid",
      GIT_COMMITTER_NAME: "autosk test",
      GIT_COMMITTER_EMAIL: "test@autosk.invalid",
      ...env,
    },
  });
  if (stdin !== undefined) {
    child.child.stdin.end(stdin);
  }
  return child.then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error) => ({ code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) }),
  );
};

const identity = { name: "autosk-flow", email: "flow@autosk.invalid", date: "2026-01-01T00:00:00+00:00" };

const trailers = {
  "Autosk-Anchor-Version": "3",
  "Autosk-Epic-ID": "e-1",
  "Autosk-Operation-ID": "op-1",
  "Autosk-Payload-Kind": "artifact",
  "Autosk-Project-Instruction-Digest": "a".repeat(64),
  "Autosk-Project-Root-SHA256": "b".repeat(64),
  "Autosk-Protocol-Digest": "c".repeat(64),
  "Autosk-Runtime-Lock-Digest": "d".repeat(64),
  "Autosk-Artifact-Identity": "brief@1",
  "Autosk-Verdict-Or-Waiver-Digest": "e".repeat(64),
};

async function repository(t, { objectFormat = "sha1" } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "autosk-planning-"));
  t.after(async () => {
    await execFileAsync("chmod", ["-R", "u+w", root]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const git = gitIn(root);
  await git(["init", "--quiet", "--initial-branch=main", `--object-format=${objectFormat}`]);
  await writeFile(path.join(root, "plan.md"), "the plan\n");
  await git(["add", "plan.md"]);
  await git(["commit", "--quiet", "-m", "base"]);
  const parent = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const tree = (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim();
  await git(["update-ref", "--create-reflog", PLANNING_REF, parent, ""]);
  await git(["update-ref", "--create-reflog", KEEPALIVE_REF, parent, ""]);
  const keepalive = { ref: KEEPALIVE_REF, oid: parent };
  return { root, git, parent, tree, keepalive, custody: gitRefCustody(root) };
}

test("a publication is written, advanced and verified, in that order", async (t) => {
  const { git, parent, tree, keepalive, custody } = await repository(t);
  const before = await reflogDepth(git, PLANNING_REF);

  // Prepared: the ref is at the parent and no object exists yet.
  const prepared = await observeRef(git, { ref: PLANNING_REF, expectedParent: parent, reflogBefore: before });
  assert.deepEqual({ ref: prepared.ref, reflog: prepared.reflog }, { ref: "expected_parent", reflog: "checkpoint" });
  assert.equal(await observeObject(git, { recordedOid: null }), "absent");
  assert.equal(
    publicationDecision({ phase: "prepared", ...prepared, object: "absent", keepalive: "valid" }).action,
    "write_commit_object",
  );

  const commit = await writeCommitObject(git, { tree, parent, payloadKind: "artifact", trailers, identity });
  assert.equal(await observeObject(git, { recordedOid: commit.oid, expectedBytes: commit.bytes }), "matching");
  const created = await observeRef(git, {
    ref: PLANNING_REF,
    expectedParent: parent,
    expectedCommit: commit.oid,
    reflogBefore: before,
  });
  assert.equal(
    publicationDecision({ phase: "commit_created", ...created, object: "matching", keepalive: "valid" }).action,
    "cas_advance_ref",
  );

  const advanced = await advanceRef(git, { custody, ref: PLANNING_REF, expectedParent: parent, commit: commit.oid, keepalive });
  assert.equal(advanced.advanced, true);
  assert.equal(await readRef(git, PLANNING_REF), commit.oid);

  const after = await observeRef(git, {
    ref: PLANNING_REF,
    expectedParent: parent,
    expectedCommit: commit.oid,
    reflogBefore: before,
  });
  assert.deepEqual({ ref: after.ref, reflog: after.reflog }, { ref: "expected_commit", reflog: "one_new_matching" });
  const verdict = publicationDecision({ phase: "ref_advanced", ...after, object: "matching", keepalive: "valid" });
  assert.deepEqual({ ...verdict }, { action: "verify_and_record", phase: "verified", next_step: "select_next" });
});

test("the trailers are in the published object, and their order is the machine's", async (t) => {
  const { git, parent, tree } = await repository(t);
  const commit = await writeCommitObject(git, { tree, parent, payloadKind: "artifact", trailers, identity });
  const published = await publishedTrailers(git, commit.oid);
  assert.deepEqual({ ...published }, trailers);
  // Sorted by code point, so two hosts that listed them differently still
  // produce one commit.
  const body = commit.bytes.split("\n\n").at(-1).trim().split("\n");
  assert.deepEqual(body, [...body].sort());
  assert.ok(commit.bytes.includes("\n\nautosk-flow planning publication\n\n"), commit.message);
  assert.ok(commit.bytes.startsWith("tree "), commit.bytes.slice(0, 40));
});

test("the same publication produces the same object, so a prune can be reconstructed", async (t) => {
  const { git, parent, tree } = await repository(t);
  const first = await writeCommitObject(git, { tree, parent, payloadKind: "artifact", trailers, identity });
  const second = await writeCommitObject(git, { tree, parent, payloadKind: "artifact", trailers, identity });
  // Identity and both dates are given rather than taken from the environment.
  assert.equal(second.oid, first.oid);

  const later = await writeCommitObject(git, {
    tree,
    parent,
    payloadKind: "artifact",
    trailers,
    identity: { ...identity, date: "2026-06-01T00:00:00+00:00" },
  });
  assert.notEqual(later.oid, first.oid);

  // The dates are the given ones, in the object: git records them to the
  // second, so two writes a moment apart would otherwise agree by accident.
  const epoch = String(Math.floor(Date.parse(identity.date) / 1000));
  assert.ok(first.bytes.includes(`author autosk-flow <flow@autosk.invalid> ${epoch} `), first.bytes);
  assert.ok(first.bytes.includes(`committer autosk-flow <flow@autosk.invalid> ${epoch} `), first.bytes);

  const rewritten = await rewriteExactObject(git, { recordedOid: first.oid, bytes: first.bytes });
  assert.deepEqual({ ...rewritten }, { oid: first.oid, reconstructed: true });
  await assert.rejects(
    () => rewriteExactObject(git, { recordedOid: first.oid, bytes: later.bytes }),
    code("planning_publication_corrupt"),
  );
});

test("an object that is gone is pruned when it was recorded, and absent when it was not", async (t) => {
  const { git, parent, tree } = await repository(t);
  const commit = await writeCommitObject(git, { tree, parent, payloadKind: "artifact", trailers, identity });
  assert.equal(await observeObject(git, { recordedOid: commit.oid }), "matching");
  // The same emptiness, two different facts: only the durable record tells them
  // apart, and the difference decides whether to write or to reconstruct.
  assert.equal(await observeObject(git, { recordedOid: null }), "absent");
  assert.equal(await observeObject(git, { recordedOid: "0".repeat(40) }), "pruned");
  assert.equal(
    publicationDecision({
      phase: "commit_created",
      ref: "expected_parent",
      reflog: "checkpoint",
      object: "pruned",
      keepalive: "valid",
    }).action,
    "rewrite_exact_object",
  );
});

test("an object whose bytes are not the recorded ones is a mismatch, not a match", async (t) => {
  const { git, parent, tree } = await repository(t);
  const commit = await writeCommitObject(git, { tree, parent, payloadKind: "artifact", trailers, identity });
  const other = await writeCommitObject(git, {
    tree,
    parent,
    payloadKind: "artifact",
    trailers: { ...trailers, "Autosk-Operation-ID": "op-2" },
    identity,
  });
  assert.equal(await observeObject(git, { recordedOid: commit.oid, expectedBytes: other.bytes }), "mismatch");
  assert.equal(
    publicationDecision({
      phase: "prepared",
      ref: "expected_parent",
      reflog: "checkpoint",
      object: "mismatch",
      keepalive: "valid",
    }).park_reason,
    "planning_publication_corrupt",
  );
});

test("a ref somebody else moved is not where this operation left it", async (t) => {
  const { git, parent, tree, keepalive, custody } = await repository(t);
  const commit = await writeCommitObject(git, { tree, parent, payloadKind: "artifact", trailers, identity });
  const foreign = await writeCommitObject(git, {
    tree,
    parent,
    payloadKind: "artifact",
    trailers: { ...trailers, "Autosk-Operation-ID": "op-foreign" },
    identity,
  });
  const before = await reflogDepth(git, PLANNING_REF);
  await git(["update-ref", "--create-reflog", PLANNING_REF, foreign.oid, parent]);

  const observed = await observeRef(git, {
    ref: PLANNING_REF,
    expectedParent: parent,
    expectedCommit: commit.oid,
    reflogBefore: before,
  });
  assert.equal(observed.ref, "other");
  // One entry was added, and it is not this operation's commit: a movement is
  // only this one's when the entry points where this one pointed.
  assert.equal(observed.reflog, "changed");
  assert.equal(
    publicationDecision({ phase: "commit_created", ...observed, object: "matching", keepalive: "valid" })
      .park_reason,
    "planning_ref_foreign_movement",
  );
  // And the CAS refuses, so nothing overwrites what they did.
  const attempt = await advanceRef(git, { custody, ref: PLANNING_REF, expectedParent: parent, commit: commit.oid, keepalive });
  assert.equal(attempt.advanced, false);
  assert.equal(await readRef(git, PLANNING_REF), foreign.oid);
});

test("a ref moved away and back is caught by the reflog, not by the OID", async (t) => {
  const { git, parent, tree } = await repository(t);
  const foreign = await writeCommitObject(git, {
    tree,
    parent,
    payloadKind: "artifact",
    trailers: { ...trailers, "Autosk-Operation-ID": "op-foreign" },
    identity,
  });
  const before = await reflogDepth(git, PLANNING_REF);
  await git(["update-ref", "--create-reflog", PLANNING_REF, foreign.oid, parent]);
  await git(["update-ref", "--create-reflog", PLANNING_REF, parent, foreign.oid]);

  // The ref is back where it belongs. That is not evidence that nothing
  // happened to it.
  const observed = await observeRef(git, { ref: PLANNING_REF, expectedParent: parent, reflogBefore: before });
  assert.equal(observed.ref, "expected_parent");
  assert.equal(observed.reflog, "changed");
  assert.equal(
    publicationDecision({ phase: "prepared", ...observed, object: "absent", keepalive: "valid" }).park_reason,
    "planning_ref_foreign_movement",
  );
});

test("a ref whose reflog cannot be read is unknown rather than assumed", async (t) => {
  const { git, parent } = await repository(t);
  // Without a recorded starting depth there is nothing to count from, even on a
  // ref that does keep a reflog.
  const uncounted = await observeRef(git, { ref: PLANNING_REF, expectedParent: parent });
  assert.equal(uncounted.reflog, "unknown");
  assert.ok((await reflogEntries(git, PLANNING_REF)).length > 0);
  await git(["update-ref", "refs/autosk/planning/no-log", parent, ""]);
  // Git keeps no reflog for a ref outside refs/heads unless one is asked for,
  // and a movement that cannot be counted is not a movement that did not
  // happen.
  assert.deepEqual([...(await reflogEntries(git, "refs/autosk/planning/no-log"))], []);
  // Counting against an empty reflog would read every foreign movement as a
  // checkpoint: zero minus zero is zero however the ref got there.
  const observed = await observeRef(git, {
    ref: "refs/autosk/planning/no-log",
    expectedParent: parent,
    reflogBefore: 0,
  });
  assert.equal(observed.reflog, "unknown");
  const blind = await observeRef(git, { ref: "refs/autosk/planning/no-log", expectedParent: parent });
  assert.equal(blind.reflog, "unknown");
  assert.equal(
    publicationDecision({ phase: "prepared", ...blind, object: "absent", keepalive: "valid" }).park_reason,
    "planning_ref_foreign_movement",
  );
});

test("a git that could not run is reported as corrupt, never as a clean observation", async (t) => {
  const { root } = await repository(t);
  const elsewhere = await mkdtemp(path.join(tmpdir(), "autosk-not-a-repo-"));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  await assert.rejects(
    () => writeCommitObject(gitIn(elsewhere), {
      tree: "0".repeat(40),
      payloadKind: "artifact",
      trailers,
      identity,
    }),
    code("planning_publication_corrupt"),
  );
  await assert.rejects(() => publishedTrailers(gitIn(root), "0".repeat(40)), code("planning_publication_corrupt"));
});

// --- debt 11a: the helper writes the planning ref; the host asks --------------

test("advancing the planning ref is a request to the helper that verifies the live keepalive", async (t) => {
  // ADR-095. `advance_planning` verifies the live candidate keepalive and
  // CAS-advances the planning ref in one helper transaction; with no parent the
  // request is `init`, a create at an expected-absent ref.
  const { git, parent, tree, keepalive, custody } = await repository(t);
  const commit = await writeCommitObject(git, { tree, parent, payloadKind: "artifact", trailers, identity });
  await advanceRef(git, { custody, ref: PLANNING_REF, expectedParent: parent, commit: commit.oid, keepalive });
  const fresh = `refs/autosk/epics/${"d".repeat(64)}/planning`;
  const created = await advanceRef(git, { custody, ref: fresh, expectedParent: null, commit: parent });
  assert.equal(created.advanced, true);
  assert.equal(created.expected_parent, null);
  assert.deepEqual(JSON.parse(JSON.stringify(custody.requests)), [
    {
      action: "advance_planning",
      ref_updates: [
        { operation: "verify", ref: KEEPALIVE_REF, expected_old_oid: parent, new_oid: parent },
        { operation: "update", ref: PLANNING_REF, expected_old_oid: parent, new_oid: commit.oid },
      ],
    },
    { action: "init", ref_updates: [{ operation: "update", ref: fresh, expected_old_oid: null, new_oid: parent }] },
  ]);
  assert.equal(await readRef(git, fresh), parent);
  assert.equal(await reflogDepth(git, fresh), 1);
});

test("a keepalive that moved refuses the whole advance, so the planning ref stays at its parent", async (t) => {
  const { git, parent, tree, custody } = await repository(t);
  const commit = await writeCommitObject(git, { tree, parent, payloadKind: "artifact", trailers, identity });
  const stale = { ref: KEEPALIVE_REF, oid: commit.oid };
  const attempt = await advanceRef(git, { custody, ref: PLANNING_REF, expectedParent: parent, commit: commit.oid, keepalive: stale });
  assert.equal(attempt.advanced, false);
  assert.equal(attempt.observed, parent);
  assert.equal(await readRef(git, PLANNING_REF), parent);
});

test("with no helper the planning ref is not advanced and the host writes nothing itself", async (t) => {
  const { git, parent, tree, keepalive } = await repository(t);
  const commit = await writeCommitObject(git, { tree, parent, payloadKind: "artifact", trailers, identity });
  const depth = await reflogDepth(git, PLANNING_REF);
  await assert.rejects(
    () => advanceRef(git, { ref: PLANNING_REF, expectedParent: parent, commit: commit.oid, keepalive }),
    code("planning_ref_capability_missing"),
  );
  assert.equal(await readRef(git, PLANNING_REF), parent);
  assert.equal(await reflogDepth(git, PLANNING_REF), depth);
});

test("an advance with no keepalive, or outside the helper's grammar, is refused before any request", async (t) => {
  const { git, parent, tree, keepalive, custody } = await repository(t);
  const commit = await writeCommitObject(git, { tree, parent, payloadKind: "artifact", trailers, identity });
  await assert.rejects(
    () => advanceRef(git, { custody, ref: PLANNING_REF, expectedParent: parent, commit: commit.oid }),
    code("cas_conflict"),
  );
  await assert.rejects(
    () => advanceRef(git, { custody, ref: "refs/autosk/planning/e-1", expectedParent: parent, commit: commit.oid, keepalive }),
    code("cas_conflict"),
  );
  assert.equal(custody.requests.length, 0);
});

// --- debt 11d: one object format ----------------------------------------------

test("a SHA-256 repository publishes the same way: its ref and reflog are read, not missed (R7-31)", async (t) => {
  // Round 7 of #39, R7-31: reflogEntries took only 40-hex lines, so in a
  // SHA-256 repository every reflog read as empty and every observation as
  // `unknown`, which parks a publication that moved nothing (ADR-098).
  const { git, parent, tree, keepalive, custody } = await repository(t, { objectFormat: "sha256" });
  assert.equal(parent.length, 64);
  const before = await reflogDepth(git, PLANNING_REF);
  assert.equal(before, 1);
  assert.deepEqual([...(await reflogEntries(git, PLANNING_REF))], [parent]);
  const prepared = await observeRef(git, { ref: PLANNING_REF, expectedParent: parent, reflogBefore: before });
  assert.deepEqual({ ...prepared }, { ref: "expected_parent", reflog: "checkpoint", oid: parent });

  const commit = await writeCommitObject(git, { tree, parent, payloadKind: "artifact", trailers, identity });
  assert.equal(commit.oid.length, 64);
  assert.equal(await observeObject(git, { recordedOid: commit.oid, expectedBytes: commit.bytes }), "matching");
  const advanced = await advanceRef(git, { custody, ref: PLANNING_REF, expectedParent: parent, commit: commit.oid, keepalive });
  assert.deepEqual({ advanced: advanced.advanced, observed: advanced.observed, reflog_before: advanced.reflog_before },
    { advanced: true, observed: commit.oid, reflog_before: 1 });
  const after = await observeRef(git, { ref: PLANNING_REF, expectedParent: parent, expectedCommit: commit.oid, reflogBefore: before });
  assert.deepEqual({ ...after }, { ref: "expected_commit", reflog: "one_new_matching", oid: commit.oid });
  assert.equal(publicationDecision({ phase: "ref_advanced", ...after, object: "matching", keepalive: "valid" }).action, "verify_and_record");
});
