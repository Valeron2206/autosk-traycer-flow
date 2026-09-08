/**
 * Tests for applying an approved delta to staging (issue #8 driver).
 *
 * Real repositories, real blobs, real refs. The rule being tested throughout is
 * that the driver may reference bytes that were approved and may not produce
 * any: every tree it writes is assembled from blobs that already exist.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { deltaDigest, integrationProof } from "../src/host/approved-delta.mjs";
import {
  appliedEntries,
  applyDelta,
  assertCleanEnvironment,
  composeTree,
  integrationReceipt,
  worktreeState,
} from "../src/host/delta-driver.mjs";
import { readRef, stagingRef } from "../src/host/staging-driver.mjs";

const execFileAsync = promisify(execFile);
const code = (name) => (error) => error.code === name;

const gitIn = (cwd) => async (args, { env = {} } = {}) =>
  execFileAsync("git", args, {
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
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error) => ({ code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) }),
  );

async function repository(t) {
  const root = await mkdtemp(path.join(tmpdir(), "autosk-delta-"));
  t.after(async () => {
    await execFileAsync("chmod", ["-R", "u+w", root]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const git = gitIn(root);
  await git(["init", "--quiet", "--initial-branch=main"]);
  await writeFile(path.join(root, "keep.txt"), "kept\n");
  await git(["add", "keep.txt"]);
  await git(["commit", "--quiet", "-m", "base"]);
  const commit_oid = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const tree_oid = (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim();
  const ref = stagingRef("e-1");
  await git(["update-ref", ref, commit_oid, ""]);
  // Outside the project on purpose: an index file left inside it is untracked
  // state that looks like somebody's work.
  const indexFile = path.join(await mkdtemp(path.join(tmpdir(), "autosk-index-")), "apply.index");
  t.after(() => rm(path.dirname(indexFile), { recursive: true, force: true }));
  return { root, git, ref, base: { commit_oid, tree_oid }, indexFile };
}

/** A blob that exists in the repository, the way a Ticket's approved bytes do. */
async function blob(git, root, content) {
  const file = path.join(root, `.blob-${Math.random().toString(36).slice(2)}`);
  await writeFile(file, content);
  const oid = (await git(["hash-object", "-w", file])).stdout.trim();
  await rm(file);
  return oid;
}

function delta(base, entries, overrides = {}) {
  const body = {
    operation_id: "op-1",
    base_commit_oid: base.commit_oid,
    base_tree_oid: base.tree_oid,
    candidate_tree_oid: "c".repeat(40),
    pathspec: ["src/**"],
    entries,
    ...overrides,
  };
  return { ...body, delta_digest: deltaDigest(body) };
}

test("an approved delta lands as a staging commit, and the worktree is untouched", async (t) => {
  const { git, root, ref, base, indexFile } = await repository(t);
  const oid = await blob(git, root, "export const a = 1;\n");
  const d = delta(base, [{ path: "src/a.ts", status: "A", new_blob: oid, new_mode: "100644" }]);

  const result = await applyDelta(git, { delta: d, realpath, ref, base, indexFile, message: "T-1" });
  assert.equal(result.applied, true);
  assert.deepEqual([...result.applied_entries], [{ path: "src/a.ts", new_blob: oid, new_mode: "100644" }]);
  assert.deepEqual(integrationProof(d, result), []);
  assert.equal(integrationReceipt(d, result).phase, "ref_advanced");
  assert.equal(await readRef(git, ref), result.commit_oid);

  // The apply ran in a temporary index: nothing in the operator's tree moved,
  // and the branch they are on is where it was.
  const status = await worktreeState(git);
  assert.deepEqual([...status.untracked], []);
  assert.equal(status.dirty, false);
  assert.equal(await readFile(path.join(root, "keep.txt"), "utf8"), "kept\n");
  assert.equal(await readRef(git, "refs/heads/main"), base.commit_oid);
});

test("modes, symlinks and binary content survive the apply exactly", async (t) => {
  const { git, root, ref, base, indexFile } = await repository(t);
  const script = await blob(git, root, "#!/bin/sh\nexit 0\n");
  const link = await blob(git, root, "a.ts");
  const binary = await blob(git, root, Buffer.from([0, 1, 2, 250, 251, 0]));
  const d = delta(base, [
    { path: "src/run.sh", status: "A", new_blob: script, new_mode: "100755" },
    { path: "src/link", status: "A", new_blob: link, new_mode: "120000" },
    { path: "src/data.bin", status: "A", new_blob: binary, new_mode: "100644" },
  ]);

  const result = await applyDelta(git, { delta: d, realpath, ref, base, indexFile, message: "T-2" });
  const byPath = new Map(result.applied_entries.map((entry) => [entry.path, entry]));
  assert.equal(byPath.get("src/run.sh").new_mode, "100755");
  assert.equal(byPath.get("src/link").new_mode, "120000");
  assert.equal(byPath.get("src/data.bin").new_blob, binary);
  assert.deepEqual(integrationProof(d, result), []);
});

test("a second independent Ticket integrates without losing the first", async (t) => {
  const { git, root, ref, base, indexFile } = await repository(t);
  const first = await blob(git, root, "one\n");
  const second = await blob(git, root, "two\n");
  const d1 = delta(base, [{ path: "src/one.ts", status: "A", new_blob: first, new_mode: "100644" }]);
  const r1 = await applyDelta(git, { delta: d1, realpath, ref, base, indexFile, message: "T-1" });

  // The base for the second Ticket is where the first left staging: a full-tree
  // comparison here would call the first Ticket's file an unapproved change.
  const nextBase = { commit_oid: r1.commit_oid, tree_oid: r1.tree_oid };
  const d2 = delta(nextBase, [{ path: "src/two.ts", status: "A", new_blob: second, new_mode: "100644" }]);
  const r2 = await applyDelta(git, {
    delta: d2,
    realpath,
    ref,
    base: nextBase,
    indexFile,
    message: "T-2",
    otherTicketPaths: ["src/one.ts"],
  });

  assert.deepEqual(integrationProof(d2, r2), []);
  assert.deepEqual([...r2.preserved_from_other_tickets], [{ path: "src/one.ts", present: true }]);
});

test("a delta prepared against an older base is refused before anything is written", async (t) => {
  const { git, root, ref, base, indexFile } = await repository(t);
  const first = await blob(git, root, "one\n");
  const d1 = delta(base, [{ path: "src/one.ts", status: "A", new_blob: first, new_mode: "100644" }]);
  const r1 = await applyDelta(git, { delta: d1, realpath, ref, base, indexFile, message: "T-1" });

  const stale = delta(base, [{ path: "src/two.ts", status: "A", new_blob: first, new_mode: "100644" }]);
  await assert.rejects(
    () => applyDelta(git, { delta: stale, realpath, ref, base: { commit_oid: r1.commit_oid, tree_oid: r1.tree_oid }, indexFile, message: "T-2" }),
    code("delta_stale"),
  );
  assert.equal(await readRef(git, ref), r1.commit_oid);
});

test("deletions and renames move exactly what they name", async (t) => {
  const { git, root, ref, base, indexFile } = await repository(t);
  const content = await blob(git, root, "moved\n");
  const added = delta(base, [{ path: "src/old.ts", status: "A", new_blob: content, new_mode: "100644" }]);
  const first = await applyDelta(git, { delta: added, realpath, ref, base, indexFile, message: "T-1" });
  const afterAdd = { commit_oid: first.commit_oid, tree_oid: first.tree_oid };

  const renamed = delta(afterAdd, [{
    path: "src/new.ts",
    from_path: "src/old.ts",
    status: "R",
    old_blob: content,
    new_blob: content,
    old_mode: "100644",
    new_mode: "100644",
  }]);
  const second = await applyDelta(git, { delta: renamed, realpath, ref, base: afterAdd, indexFile, message: "T-2" });
  const paths = (await git(["ls-tree", "-r", "--name-only", second.tree_oid])).stdout.split("\n");
  assert.ok(paths.includes("src/new.ts"), paths.join(","));
  assert.ok(!paths.includes("src/old.ts"), paths.join(","));
  assert.deepEqual(integrationProof(renamed, second), []);

  const afterRename = { commit_oid: second.commit_oid, tree_oid: second.tree_oid };
  const deleted = delta(afterRename, [{
    path: "src/new.ts",
    status: "D",
    old_blob: content,
    old_mode: "100644",
  }]);
  const third = await applyDelta(git, { delta: deleted, realpath, ref, base: afterRename, indexFile, message: "T-3" });
  const left = (await git(["ls-tree", "-r", "--name-only", third.tree_oid])).stdout;
  assert.ok(!left.includes("src/new.ts"), left);
  // A deletion is approved and absent, which is what the proof has to accept.
  assert.deepEqual(integrationProof(deleted, third), []);
});

test("a removal the delta did not approve is caught by the proof", async (t) => {
  const { git, root, ref, base, indexFile } = await repository(t);
  const first = await blob(git, root, "one\n");
  const second = await blob(git, root, "two\n");
  const seed = delta(base, [
    { path: "src/one.ts", status: "A", new_blob: first, new_mode: "100644" },
    { path: "src/two.ts", status: "A", new_blob: second, new_mode: "100644" },
  ]);
  const seeded = await applyDelta(git, { delta: seed, realpath, ref, base, indexFile, message: "seed" });
  const next = { commit_oid: seeded.commit_oid, tree_oid: seeded.tree_oid };

  // The apply removes a second file nobody approved. Nothing in the resulting
  // tree shows it: the only evidence is what is no longer there.
  const approved = delta(next, [{ path: "src/one.ts", status: "D", old_blob: first, old_mode: "100644" }]);
  const wider = delta(next, [
    { path: "src/one.ts", status: "D", old_blob: first, old_mode: "100644" },
    { path: "src/two.ts", status: "D", old_blob: second, old_mode: "100644" },
  ]);
  const result = await applyDelta(git, { delta: wider, realpath, ref, base: next, indexFile, message: "T-2" });
  assert.deepEqual([...result.removed_paths], ["src/one.ts", "src/two.ts"]);
  const errors = integrationProof(approved, result);
  assert.ok(errors.some((error) => /src\/two.ts: removed and not approved/u.test(error.detail)), JSON.stringify(errors));
});

test("an apply that loses another Ticket's work is caught by the proof", async (t) => {
  const { git, root, ref, base, indexFile } = await repository(t);
  const first = await blob(git, root, "one\n");
  const second = await blob(git, root, "two\n");
  const d1 = delta(base, [{ path: "src/one.ts", status: "A", new_blob: first, new_mode: "100644" }]);
  const r1 = await applyDelta(git, { delta: d1, realpath, ref, base, indexFile, message: "T-1" });
  const next = { commit_oid: r1.commit_oid, tree_oid: r1.tree_oid };

  // The second Ticket's delta removes the first Ticket's file along the way.
  const d2 = delta(next, [
    { path: "src/two.ts", status: "A", new_blob: second, new_mode: "100644" },
    { path: "src/one.ts", status: "D", old_blob: first, old_mode: "100644" },
  ]);
  const r2 = await applyDelta(git, {
    delta: d2,
    realpath,
    ref,
    base: next,
    indexFile,
    message: "T-2",
    otherTicketPaths: ["src/one.ts"],
  });
  assert.deepEqual([...r2.preserved_from_other_tickets], [{ path: "src/one.ts", present: false }]);
  assert.ok(
    integrationProof(d2, r2).some((error) => /another Ticket's work was lost/u.test(error.detail)),
  );
});

test("a delta that does not validate is refused at apply time", async (t) => {
  const { git, root, ref, base, indexFile } = await repository(t);
  const oid = await blob(git, root, "a\n");
  // Outside the Ticket's pathspec: approved for one place, applied to another.
  const outside = delta(base, [{ path: "docs/a.md", status: "A", new_blob: oid, new_mode: "100644" }]);
  await assert.rejects(
    () => applyDelta(git, { delta: outside, realpath, ref, base, indexFile, message: "T-1" }),
    code("scope_violation"),
  );
  assert.equal(await readRef(git, ref), base.commit_oid);
});

test("an untracked file at an approved path refuses the apply and is not destroyed", async (t) => {
  const { git, root, ref, base, indexFile } = await repository(t);
  const oid = await blob(git, root, "approved\n");
  await execFileAsync("mkdir", ["-p", path.join(root, "src")]);
  await writeFile(path.join(root, "src/a.ts"), "someone's uncommitted work\n");
  const d = delta(base, [{ path: "src/a.ts", status: "A", new_blob: oid, new_mode: "100644" }]);
  const worktree = await worktreeState(git);
  assert.ok(worktree.untracked.includes("src/a.ts"));

  await assert.rejects(
    () => applyDelta(git, { delta: d, realpath, ref, base, indexFile, message: "T-1", worktree }),
    code("untracked_collision"),
  );
  // Fail-closed, and the file is still theirs.
  assert.equal(await readFile(path.join(root, "src/a.ts"), "utf8"), "someone's uncommitted work\n");
  assert.equal(await readRef(git, ref), base.commit_oid);
});

test("an inherited Git environment is refused rather than cleaned in place", async (t) => {
  const { git, root, ref, base, indexFile } = await repository(t);
  const oid = await blob(git, root, "a\n");
  const d = delta(base, [{ path: "src/a.ts", status: "A", new_blob: oid, new_mode: "100644" }]);
  await assert.rejects(
    () => applyDelta(git, { delta: d, realpath, ref, base, indexFile, message: "T-1", env: { GIT_DIR: "/elsewhere/.git" } }),
    code("inherited_git_env"),
  );
  assert.throws(() => assertCleanEnvironment({ GIT_INDEX_FILE: "/tmp/x" }), code("inherited_git_env"));
  assert.doesNotThrow(() => assertCleanEnvironment({ PATH: "/usr/bin" }));
  assert.equal(await readRef(git, ref), base.commit_oid);
});

test("the staging ref moving under the apply is a refusal, not a retry", async (t) => {
  const { git, root, ref, base, indexFile } = await repository(t);
  const oid = await blob(git, root, "a\n");
  const foreign = await blob(git, root, "foreign\n");
  const d = delta(base, [{ path: "src/a.ts", status: "A", new_blob: oid, new_mode: "100644" }]);

  // Somebody advances staging between the recorded base and the apply.
  const other = delta(base, [{ path: "src/foreign.ts", status: "A", new_blob: foreign, new_mode: "100644" }]);
  await applyDelta(git, { delta: other, realpath, ref, base, indexFile, message: "foreign" });

  await assert.rejects(
    () => applyDelta(git, { delta: d, realpath, ref, base, indexFile, message: "T-1" }),
    code("foreign_ref_movement"),
  );
});

test("the applied entries are read back from the tree, not echoed from the request", async (t) => {
  const { git, root, ref, base, indexFile } = await repository(t);
  const approved = await blob(git, root, "approved\n");
  const substituted = await blob(git, root, "substituted\n");
  const d = delta(base, [{ path: "src/a.ts", status: "A", new_blob: approved, new_mode: "100644" }]);

  // A tree composed from other bytes than the approved ones. The proof has to
  // notice, and it can only notice because the entries come from the tree.
  const tampered = delta(base, [{ path: "src/a.ts", status: "A", new_blob: substituted, new_mode: "100644" }]);
  const tree = await composeTree(git, { delta: tampered, base: base.commit_oid, indexFile, realpath });
  const entries = await appliedEntries(git, { tree, baseTree: base.tree_oid, delta: d });
  assert.deepEqual([...entries], [{ path: "src/a.ts", new_blob: substituted, new_mode: "100644" }]);

  const errors = integrationProof(d, {
    operation_id: d.operation_id,
    base_commit_oid: d.base_commit_oid,
    applied_entries: entries,
    ref_movement: { ref, expected_old_oid: base.commit_oid, observed_old_oid: base.commit_oid, post_state: "known", reflog_entries: 1 },
  });
  assert.ok(errors.some((error) => error.reason === "unreviewed_bytes"), JSON.stringify(errors));
  assert.equal(await readRef(git, ref), base.commit_oid);
});

test("a path introduced inside the Ticket's scope but not approved is reported", async (t) => {
  const { git, root, base, indexFile } = await repository(t);
  const approved = await blob(git, root, "approved\n");
  const extra = await blob(git, root, "extra\n");
  const d = delta(base, [{ path: "src/a.ts", status: "A", new_blob: approved, new_mode: "100644" }]);
  const wider = delta(base, [
    { path: "src/a.ts", status: "A", new_blob: approved, new_mode: "100644" },
    { path: "src/extra.ts", status: "A", new_blob: extra, new_mode: "100644" },
  ]);
  const tree = await composeTree(git, { delta: wider, base: base.commit_oid, indexFile, realpath });
  const entries = await appliedEntries(git, { tree, baseTree: base.tree_oid, delta: d });
  assert.equal(entries.length, 2);
  const errors = integrationProof(d, {
    operation_id: d.operation_id,
    base_commit_oid: d.base_commit_oid,
    applied_entries: entries,
    ref_movement: { ref: "r", expected_old_oid: "x", observed_old_oid: "x", post_state: "known", reflog_entries: 1 },
  });
  assert.ok(errors.some((error) => error.reason === "scope_violation"), JSON.stringify(errors));
});

test("a temporary index inside the project is refused", async (t) => {
  const { git, root, base } = await repository(t);
  const oid = await blob(git, root, "a\n");
  const d = delta(base, [{ path: "src/a.ts", status: "A", new_blob: oid, new_mode: "100644" }]);
  await assert.rejects(
    () => composeTree(git, { delta: d, base: base.commit_oid, realpath, indexFile: path.join(root, "apply.index") }),
    code("state_identity_collision"),
  );
  // Refused before writing it: nothing was left behind.
  assert.deepEqual([...(await worktreeState(git)).untracked], []);
});

test("a blob that is not in the repository cannot be composed into a tree", async (t) => {
  const { git, base, indexFile } = await repository(t);
  // The driver assembles from objects that exist; there is no path by which it
  // could invent one.
  const missing = delta(base, [{ path: "src/a.ts", status: "A", new_blob: "0".repeat(40), new_mode: "100644" }]);
  await assert.rejects(
    () => composeTree(git, { delta: missing, base: base.commit_oid, indexFile, realpath }),
    code("environment_failure"),
  );
});

test("a receipt records the phase the operation actually reached", async (t) => {
  const { git, root, ref, base, indexFile } = await repository(t);
  const oid = await blob(git, root, "a\n");
  const d = delta(base, [{ path: "src/a.ts", status: "A", new_blob: oid, new_mode: "100644" }]);
  const result = await applyDelta(git, { delta: d, realpath, ref, base, indexFile, message: "T-1" });
  const receipt = integrationReceipt(d, result);
  assert.equal(receipt.phase, "ref_advanced");
  assert.equal(receipt.staging_commit_oid, result.commit_oid);
  assert.deepEqual([...receipt.errors], []);

  // A result whose ref never moved is not `ref_advanced`, whatever else holds.
  const unmoved = integrationReceipt(d, { ...result, applied: false });
  assert.equal(unmoved.phase, "prepared");
});
