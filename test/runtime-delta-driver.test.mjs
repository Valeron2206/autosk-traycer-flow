/**
 * Tests for applying an approved delta to staging (issue #8 driver).
 *
 * Real repositories, real blobs, real refs. The rule being tested throughout is
 * that the driver may reference bytes that were approved and may not produce
 * any: every tree it writes is assembled from blobs that already exist.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as nodeFs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { deltaDigest, integrationProof } from "../src/host/approved-delta.mjs";
import { FlowError } from "../src/runtime/contracts.mjs";
import * as deltaModule from "../src/host/delta-driver.mjs";
import {
  appliedEntries,
  applyDelta as applyDeltaWith,
  assertCleanEnvironment,
  composeTree,
  integrationReceipt,
  worktreeState,
} from "../src/host/delta-driver.mjs";
import * as custodyModule from "../src/host/ref-custody.mjs";
import { recipeJournal } from "../src/host/staging-lineage.mjs";
import { readRef, reflogDepth, stagingRef } from "../src/host/staging-driver.mjs";
import { gitRefCustody } from "./support/git-ref-custody.mjs";
import { memoryRecipes } from "./support/memory-recipes.mjs";

const execFileAsync = promisify(execFile);
const code = (name) => (error) => error.code === name;
/** A stop of the graph at apply_staging, with the contract's own name as its cause (debt 13a, R9-3, ADR-109). */
const stop = (name, cause) => (error) => error.code === name && error.details?.cause === cause;

// The identity of the host's commit (debt 12g): fixed, so the same delta on the same base is the same commit.
const AUTHOR = Object.freeze({ name: "autosk flow", email: "flow@autosk.invalid", date: "1700000000 +0000" });

// One recipe journal per repository, the product's own file journal over the real filesystem: an apply is journaled
// where its repository's staging is. Tests that stand for a crash, or tamper with a recipe, hand their own.
const journals = new WeakMap();
/** The product's journal: one file per apply key in a directory of the Epic's own. */
const journalAt = (fs, directory) => recipeJournal(fs, { directory });
/** Edits one apply's recipe on disk, as bit rot or a careless hand does: the file of that apply key. */
const tamper = async (directory, applyKey) => {
  const target = path.join(directory, `${applyKey}.recipe`);
  await writeFile(target, (await readFile(target, "utf8")).replace('"message":"T-1"', '"message":"T-9"'));
};
/** What the journal holds, read from its files (a file per key), in key order. */
const recipesIn = async (directory) => Promise.all((await readdir(directory)).filter((name) => name.endsWith(".recipe")).sort()
  .map(async (name) => JSON.parse(await readFile(path.join(directory, name), "utf8"))));
const applyDelta = (git, options) => applyDeltaWith(git, { recipes: journals.get(git), author: AUTHOR, ...options });

const gitIn = (cwd) => async (args, { env = {}, stdin } = {}) => {
  const call = execFileAsync("git", args, {
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
  // `hash-object --stdin` writes a commit again from the bytes a recipe recorded.
  if (stdin !== undefined) call.child.stdin.end(stdin);
  return call.then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error) => ({ code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) }),
  );
};

async function repository(t, { objectFormat = "sha1" } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "autosk-delta-"));
  t.after(async () => {
    await execFileAsync("chmod", ["-R", "u+w", root]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const git = gitIn(root);
  await git(["init", "--quiet", "--initial-branch=main", `--object-format=${objectFormat}`]);
  await writeFile(path.join(root, "keep.txt"), "kept\n");
  await git(["add", "keep.txt"]);
  await git(["commit", "--quiet", "-m", "base"]);
  const commit_oid = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const tree_oid = (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim();
  const epicRefKey = "a916c907fd14e54bfb1f3591a573675ccb1fdfeb49a8875c3c10c6bc00c5fb37";
  const ref = stagingRef(epicRefKey);
  // The staging ref exists before the apply under test: the fixture makes it like the helper's create_staging
  // would (an expected-absent update with a reflog), so that no test depends on the request identity for its setup.
  // The helper writes it in the product (ADR-095), and the tests hand every driver the helper's git-backed stand-in.
  await git(["update-ref", "--create-reflog", "-m", "fixture: staging created", ref, commit_oid]);
  const custody = gitRefCustody(root);
  // Outside the project on purpose: an index file left inside it is untracked
  // state that looks like somebody's work.
  const indexFile = path.join(await mkdtemp(path.join(tmpdir(), "autosk-index-")), "apply.index");
  t.after(() => rm(path.dirname(indexFile), { recursive: true, force: true }));
  const recipesDir = path.join(path.dirname(indexFile), "recipes");
  await mkdir(recipesDir);
  journals.set(git, journalAt(nodeFs, recipesDir));
  return { root, git, ref, base: { commit_oid, tree_oid }, indexFile, custody, recipesDir, epicRefKey };
}

/** A blob that exists in the repository, the way a Ticket's approved bytes do. */
async function blob(git, root, content) {
  const file = path.join(root, `.blob-${Math.random().toString(36).slice(2)}`);
  await writeFile(file, content);
  const oid = (await git(["hash-object", "-w", file])).stdout.trim();
  await rm(file);
  return oid;
}

let operations = 0;
function delta(base, entries, overrides = {}) {
  const body = {
    // Each apply is its own operation (debt 12g), as the host's is.
    operation_id: `op-${++operations}`,
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
  const { git, root, ref, base, indexFile, custody } = await repository(t);
  const oid = await blob(git, root, "export const a = 1;\n");
  const d = delta(base, [{ path: "src/a.ts", status: "A", new_blob: oid, new_mode: "100644" }]);

  const result = await applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" });
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
  const { git, root, ref, base, indexFile, custody } = await repository(t);
  const script = await blob(git, root, "#!/bin/sh\nexit 0\n");
  const link = await blob(git, root, "a.ts");
  const binary = await blob(git, root, Buffer.from([0, 1, 2, 250, 251, 0]));
  const d = delta(base, [
    { path: "src/run.sh", status: "A", new_blob: script, new_mode: "100755" },
    { path: "src/link", status: "A", new_blob: link, new_mode: "120000" },
    { path: "src/data.bin", status: "A", new_blob: binary, new_mode: "100644" },
  ]);

  const result = await applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-2" });
  const byPath = new Map(result.applied_entries.map((entry) => [entry.path, entry]));
  assert.equal(byPath.get("src/run.sh").new_mode, "100755");
  assert.equal(byPath.get("src/link").new_mode, "120000");
  assert.equal(byPath.get("src/data.bin").new_blob, binary);
  assert.deepEqual(integrationProof(d, result), []);
});

test("a second independent Ticket integrates without losing the first", async (t) => {
  const { git, root, ref, base, indexFile, custody } = await repository(t);
  const first = await blob(git, root, "one\n");
  const second = await blob(git, root, "two\n");
  const d1 = delta(base, [{ path: "src/one.ts", status: "A", new_blob: first, new_mode: "100644" }]);
  const r1 = await applyDelta(git, { custody, delta: d1, realpath, ref, base, indexFile, message: "T-1" });

  // The base for the second Ticket is where the first left staging: a full-tree
  // comparison here would call the first Ticket's file an unapproved change.
  const nextBase = { commit_oid: r1.commit_oid, tree_oid: r1.tree_oid };
  const d2 = delta(nextBase, [{ path: "src/two.ts", status: "A", new_blob: second, new_mode: "100644" }]);
  const r2 = await applyDelta(git, { custody,
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
  const { git, root, ref, base, indexFile, custody } = await repository(t);
  const first = await blob(git, root, "one\n");
  const d1 = delta(base, [{ path: "src/one.ts", status: "A", new_blob: first, new_mode: "100644" }]);
  const r1 = await applyDelta(git, { custody, delta: d1, realpath, ref, base, indexFile, message: "T-1" });

  const stale = delta(base, [{ path: "src/two.ts", status: "A", new_blob: first, new_mode: "100644" }]);
  await assert.rejects(
    () => applyDelta(git, { custody, delta: stale, realpath, ref, base: { commit_oid: r1.commit_oid, tree_oid: r1.tree_oid }, indexFile, message: "T-2" }),
    code("delta_stale"),
  );
  assert.equal(await readRef(git, ref), r1.commit_oid);
});

test("deletions and renames move exactly what they name", async (t) => {
  const { git, root, ref, base, indexFile, custody } = await repository(t);
  const content = await blob(git, root, "moved\n");
  const added = delta(base, [{ path: "src/old.ts", status: "A", new_blob: content, new_mode: "100644" }]);
  const first = await applyDelta(git, { custody, delta: added, realpath, ref, base, indexFile, message: "T-1" });
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
  const second = await applyDelta(git, { custody, delta: renamed, realpath, ref, base: afterAdd, indexFile, message: "T-2" });
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
  const third = await applyDelta(git, { custody, delta: deleted, realpath, ref, base: afterRename, indexFile, message: "T-3" });
  const left = (await git(["ls-tree", "-r", "--name-only", third.tree_oid])).stdout;
  assert.ok(!left.includes("src/new.ts"), left);
  // A deletion is approved and absent, which is what the proof has to accept.
  assert.deepEqual(integrationProof(deleted, third), []);
});

test("a removal the delta did not approve is caught by the proof", async (t) => {
  const { git, root, ref, base, indexFile, custody } = await repository(t);
  const first = await blob(git, root, "one\n");
  const second = await blob(git, root, "two\n");
  const seed = delta(base, [
    { path: "src/one.ts", status: "A", new_blob: first, new_mode: "100644" },
    { path: "src/two.ts", status: "A", new_blob: second, new_mode: "100644" },
  ]);
  const seeded = await applyDelta(git, { custody, delta: seed, realpath, ref, base, indexFile, message: "seed" });
  const next = { commit_oid: seeded.commit_oid, tree_oid: seeded.tree_oid };

  // The apply removes a second file nobody approved. Nothing in the resulting
  // tree shows it: the only evidence is what is no longer there.
  const approved = delta(next, [{ path: "src/one.ts", status: "D", old_blob: first, old_mode: "100644" }]);
  const wider = delta(next, [
    { path: "src/one.ts", status: "D", old_blob: first, old_mode: "100644" },
    { path: "src/two.ts", status: "D", old_blob: second, old_mode: "100644" },
  ]);
  const result = await applyDelta(git, { custody, delta: wider, realpath, ref, base: next, indexFile, message: "T-2" });
  assert.deepEqual([...result.removed_paths], ["src/one.ts", "src/two.ts"]);
  const errors = integrationProof(approved, result);
  assert.ok(errors.some((error) => /src\/two.ts: removed and not approved/u.test(error.detail)), JSON.stringify(errors));
});

test("an apply that loses another Ticket's work is caught by the proof", async (t) => {
  const { git, root, ref, base, indexFile, custody } = await repository(t);
  const first = await blob(git, root, "one\n");
  const second = await blob(git, root, "two\n");
  const d1 = delta(base, [{ path: "src/one.ts", status: "A", new_blob: first, new_mode: "100644" }]);
  const r1 = await applyDelta(git, { custody, delta: d1, realpath, ref, base, indexFile, message: "T-1" });
  const next = { commit_oid: r1.commit_oid, tree_oid: r1.tree_oid };

  // The second Ticket's delta removes the first Ticket's file along the way.
  const d2 = delta(next, [
    { path: "src/two.ts", status: "A", new_blob: second, new_mode: "100644" },
    { path: "src/one.ts", status: "D", old_blob: first, old_mode: "100644" },
  ]);
  const r2 = await applyDelta(git, { custody,
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
  const { git, root, ref, base, indexFile, custody } = await repository(t);
  const oid = await blob(git, root, "a\n");
  // Outside the Ticket's pathspec: approved for one place, applied to another.
  const outside = delta(base, [{ path: "docs/a.md", status: "A", new_blob: oid, new_mode: "100644" }]);
  await assert.rejects(
    () => applyDelta(git, { custody, delta: outside, realpath, ref, base, indexFile, message: "T-1" }),
    stop("delta_stale", "scope_violation"),
  );
  assert.equal(await readRef(git, ref), base.commit_oid);
});

test("an untracked file at an approved path refuses the apply and is not destroyed", async (t) => {
  const { git, root, ref, base, indexFile, custody } = await repository(t);
  const oid = await blob(git, root, "approved\n");
  await execFileAsync("mkdir", ["-p", path.join(root, "src")]);
  await writeFile(path.join(root, "src/a.ts"), "someone's uncommitted work\n");
  const d = delta(base, [{ path: "src/a.ts", status: "A", new_blob: oid, new_mode: "100644" }]);
  const worktree = await worktreeState(git);
  assert.ok(worktree.untracked.includes("src/a.ts"));

  await assert.rejects(
    () => applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1", worktree }),
    stop("environment_failure", "untracked_collision"),
  );
  // Fail-closed, and the file is still theirs.
  assert.equal(await readFile(path.join(root, "src/a.ts"), "utf8"), "someone's uncommitted work\n");
  assert.equal(await readRef(git, ref), base.commit_oid);
});

test("an inherited Git environment is refused rather than cleaned in place", async (t) => {
  const { git, root, ref, base, indexFile, custody } = await repository(t);
  const oid = await blob(git, root, "a\n");
  const d = delta(base, [{ path: "src/a.ts", status: "A", new_blob: oid, new_mode: "100644" }]);
  await assert.rejects(
    () => applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1", env: { GIT_DIR: "/elsewhere/.git" } }),
    stop("environment_failure", "inherited_git_env"),
  );
  assert.throws(() => assertCleanEnvironment({ GIT_INDEX_FILE: "/tmp/x" }), code("inherited_git_env"));
  assert.doesNotThrow(() => assertCleanEnvironment({ PATH: "/usr/bin" }));
  assert.equal(await readRef(git, ref), base.commit_oid);
});

test("the staging ref moving under the apply is a refusal, not a retry", async (t) => {
  const { git, root, ref, base, indexFile, custody } = await repository(t);
  const oid = await blob(git, root, "a\n");
  const foreign = await blob(git, root, "foreign\n");
  const d = delta(base, [{ path: "src/a.ts", status: "A", new_blob: oid, new_mode: "100644" }]);

  // Somebody advances staging between the recorded base and the apply.
  const other = delta(base, [{ path: "src/foreign.ts", status: "A", new_blob: foreign, new_mode: "100644" }]);
  await applyDelta(git, { custody, delta: other, realpath, ref, base, indexFile, message: "foreign" });

  // The stop the graph has for it (debt 12g): the staging line and the receipts no longer agree, which is
  // receipt_missing at apply_staging. The driver's own name for it, foreign_ref_movement, was a code no edge carries.
  await assert.rejects(
    () => applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" }),
    code("receipt_missing"),
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

test("an entry whose mode changed alone is applied, and the list is in path order", async (t) => {
  // Three facts decide whether a path is "applied": it is new, its bytes
  // changed, or its mode changed. Only the first two were exercised, so the
  // mode half of the condition could have been dropped — and a mode change has
  // no textual diff, which is exactly why the delta contract carries modes.
  const { git, root, base, indexFile } = await repository(t);
  const same = await blob(git, root, "same\n");
  const first = delta(base, [
    { path: "src/b.ts", status: "A", new_blob: same, new_mode: "100644" },
    { path: "src/a.ts", status: "A", new_blob: same, new_mode: "100644" },
  ]);
  const firstTree = await composeTree(git, { delta: first, base: base.commit_oid, indexFile, realpath });

  // Same bytes, different mode, and *not declared* by the delta: the second
  // loop is the one that has to notice it. Declared paths are listed anyway, so
  // the mode half of the condition can only be tested on an undeclared one.
  const modeOnly = delta(base, [
    { path: "src/b.ts", status: "A", new_blob: same, new_mode: "100755" },
    { path: "src/a.ts", status: "A", new_blob: same, new_mode: "100644" },
  ]);
  const secondTree = await composeTree(git, { delta: modeOnly, base: base.commit_oid, indexFile, realpath });
  const declaresNeither = delta(base, []);
  const entries = await appliedEntries(git, { tree: secondTree, baseTree: firstTree, delta: declaresNeither });
  assert.deepEqual([...entries].map((entry) => entry.path), ["src/b.ts"]);
  assert.equal(entries[0].new_mode, "100755");

  // Identical trees report nothing, so the difference above is the mode and not
  // the comparison itself.
  assert.deepEqual(
    [...await appliedEntries(git, { tree: firstTree, baseTree: firstTree, delta: declaresNeither })],
    [],
  );

  // And the list is ordered by path, whatever order the tree walk produced.
  const all = await appliedEntries(git, { tree: secondTree, baseTree: base.tree_oid, delta: declaresNeither });
  assert.deepEqual([...all].map((entry) => entry.path), ["src/a.ts", "src/b.ts"]);
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
  const { git, root, ref, base, indexFile, custody } = await repository(t);
  const oid = await blob(git, root, "a\n");
  const d = delta(base, [{ path: "src/a.ts", status: "A", new_blob: oid, new_mode: "100644" }]);
  const result = await applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" });
  const receipt = integrationReceipt(d, result);
  assert.equal(receipt.phase, "ref_advanced");
  assert.equal(receipt.staging_commit_oid, result.commit_oid);
  assert.deepEqual([...receipt.errors], []);

  // A result whose ref never moved is not `ref_advanced`, whatever else holds.
  const unmoved = integrationReceipt(d, { ...result, applied: false });
  assert.equal(unmoved.phase, "prepared");
});

// --- debt 10b: the host moves only the private staging ref ------------------

test("an apply refuses a ref that is not an Epic's staging ref, and moves nothing", async (t) => {
  // ADR-088. The daemon's integrateApproved is the only writer of a target
  // ref; the host's expected-old CAS moves the private staging ref and nothing
  // else. Pointed at the user's branch, the apply is refused before any write.
  const { git, root, base, indexFile, custody } = await repository(t);
  const oid = await blob(git, root, "a\n");
  const d = delta(base, [{ path: "src/a.ts", status: "A", new_blob: oid, new_mode: "100644" }]);
  for (const ref of ["refs/heads/main", "refs/autosk/epics/e-1/staging", `refs/autosk/epics/${"a".repeat(64)}/planning`]) {
    await assert.rejects(
      () => applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" }),
      code("custody_request_invalid"),
      ref,
    );
  }
  assert.equal(await readRef(git, "refs/heads/main"), base.commit_oid);
});

test("no module under src/ calls swapTarget, and only swapTarget runs update-ref", async () => {
  // ADR-095 amends ADR-088. The helper writes every ref under refs/autosk/**,
  // the staging ref included, and the daemon's integrateApproved alone moves a
  // target ref. So no host code writes a ref: swapTarget stays the target-CAS
  // mechanics integrateApproved's adapter carries (ADR-012) and has no caller
  // in src/, and it is the one place under src/ that names `update-ref`. A
  // guard inside it is still not taken: its own tests exercise it on a branch.
  const { readdir } = await import("node:fs/promises");
  const src = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "src");
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".mjs")) files.push(full);
    }
  };
  await walk(src);
  const owner = (text, index) => [...text.slice(0, index).matchAll(/export\s+(?:async\s+)?function\s+(\w+)/gu)].at(-1)?.[1];
  const calls = [];
  const writers = [];
  for (const file of files.sort()) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/\bswapTarget\s*\(/gu)) {
      if (/export\s+async\s+function\s+$/u.test(text.slice(0, match.index))) continue;
      calls.push(`${path.relative(src, file)}:${owner(text, match.index)}`);
    }
    // Code, not prose: a comment may name the command in backticks, an
    // argument is a quoted string.
    for (const match of text.matchAll(/['"]update-ref['"]/gu)) {
      writers.push(`${path.relative(src, file)}:${owner(text, match.index)}`);
    }
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(writers, ["host/staging-driver.mjs:swapTarget"]);
  // And nothing imports it, under its own name, an alias or a namespace.
  const importers = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gu)) {
      if (!/staging-driver\.mjs$/u.test(match[2])) continue;
      const names = match[1].split(",").map((part) => part.trim().split(/\s+as\s+/u)[0]).filter(Boolean);
      if (names.includes("swapTarget")) importers.push(path.relative(src, file));
    }
    if (/import\s*\*\s*as\s+\w+\s*from\s*['"][^'"]*staging-driver\.mjs['"]/u.test(text)) importers.push(`${path.relative(src, file)} (namespace)`);
  }
  assert.deepEqual(importers, []);
});

// --- debt 11a: the helper moves the staging ref; the host asks ---------------

test("an apply advances staging by asking the helper, with the recorded base as expected old", async (t) => {
  const { git, root, ref, base, indexFile, custody } = await repository(t);
  const oid = await blob(git, root, "a\n");
  const d = delta(base, [{ path: "src/a.ts", status: "A", new_blob: oid, new_mode: "100644" }]);
  const result = await applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" });
  assert.deepEqual(JSON.parse(JSON.stringify(custody.requests.at(-1))), {
    action: "advance_staging",
    ...custodyModule.custodyIdentity(deltaModule.applyKey({ ref, delta: d, base }), "advance_staging"),
    ref_updates: [{ operation: "update", ref, expected_old_oid: base.commit_oid, new_oid: result.commit_oid }],
  });
  assert.equal(await readRef(git, ref), result.commit_oid);
  assert.equal(result.ref_movement.reflog_entries, 1);
});

test("with no helper an apply commits nothing to staging and refuses as a missing capability", async (t) => {
  // The product default: a host with no helper does not write the staging ref
  // itself (ADR-095); the helper is #5 implementation work.
  const { git, root, ref, base, indexFile } = await repository(t);
  const oid = await blob(git, root, "a\n");
  const d = delta(base, [{ path: "src/a.ts", status: "A", new_blob: oid, new_mode: "100644" }]);
  const depth = await reflogDepth(git, ref);
  await assert.rejects(
    () => applyDelta(git, { delta: d, realpath, ref, base, indexFile, message: "T-1" }),
    code("planning_ref_capability_missing"),
  );
  assert.equal(await readRef(git, ref), base.commit_oid);
  assert.equal(await reflogDepth(git, ref), depth);
});

test("a staging ref the helper finds moved is reported, not overwritten", async (t) => {
  // The helper's expected-old mismatch is the swap not happening; the result
  // carries what the ref held, from the helper's own observation.
  const { git, root, ref, base, indexFile, custody } = await repository(t);
  const oid = await blob(git, root, "a\n");
  const d = delta(base, [{ path: "src/a.ts", status: "A", new_blob: oid, new_mode: "100644" }]);
  const foreign = "9".repeat(40);
  const racing = {
    advance_staging: async (request) => ({
      action: request.action,
      status: "not_applied",
      not_applied_reason: "expected_old_mismatch",
      ref_observations: request.ref_updates.map((update) => ({
        operation: update.operation,
        ref: update.ref,
        expected_old_oid: update.expected_old_oid,
        requested_new_oid: update.new_oid,
        observed_old_oid: foreign,
        observed_new_oid: foreign,
      })),
    }),
  };
  const result = await applyDelta(git, { custody: racing, delta: d, realpath, ref, base, indexFile, message: "T-1" });
  assert.equal(result.applied, false);
  assert.equal(result.ref_movement.observed_old_oid, foreign);
  assert.equal(result.ref_movement.expected_old_oid, base.commit_oid);
  assert.equal(integrationReceipt(d, result).phase, "prepared");
  assert.equal(await readRef(git, ref), base.commit_oid);
  assert.equal(custody.requests.length, 0);
});

// --- debt 11d: one object format ----------------------------------------------

test("a SHA-256 repository integrates the same way: the trees are read back, not missed (R7-31)", async (t) => {
  // The tree reader took only 40-hex blob lines (the class of R7-31), so in a
  // SHA-256 repository an apply read back no entry and no removal, and the
  // integration proof refused a delta that landed exactly (ADR-098).
  const { git, root, ref, base, indexFile, custody } = await repository(t, { objectFormat: "sha256" });
  assert.equal(base.commit_oid.length, 64);
  const one = await blob(git, root, "one\n");
  const two = await blob(git, root, "two\n");
  const wide = { candidate_tree_oid: "c".repeat(64) };
  const added = delta(base, [
    { path: "src/one.ts", status: "A", new_blob: one, new_mode: "100644" },
    { path: "src/two.ts", status: "A", new_blob: two, new_mode: "100644" },
  ], wide);
  const first = await applyDelta(git, { custody, delta: added, realpath, ref, base, indexFile, message: "T-1" });
  assert.deepEqual([...first.applied_entries], [
    { path: "src/one.ts", new_blob: one, new_mode: "100644" },
    { path: "src/two.ts", new_blob: two, new_mode: "100644" },
  ]);
  assert.deepEqual(integrationProof(added, first), []);
  assert.equal(integrationReceipt(added, first).phase, "ref_advanced");

  const afterAdd = { commit_oid: first.commit_oid, tree_oid: first.tree_oid };
  const changed = await blob(git, root, "one, changed\n");
  const edited = delta(afterAdd, [
    { path: "src/one.ts", status: "M", old_blob: one, new_blob: changed, old_mode: "100644", new_mode: "100644" },
    { path: "src/two.ts", status: "D", old_blob: two, old_mode: "100644" },
  ], wide);
  const second = await applyDelta(git, { custody, delta: edited, realpath, ref, base: afterAdd, indexFile, message: "T-2" });
  assert.deepEqual([...second.applied_entries], [{ path: "src/one.ts", new_blob: changed, new_mode: "100644" }]);
  assert.deepEqual([...second.removed_paths], ["src/two.ts"]);
  assert.deepEqual(integrationProof(edited, second), []);
  assert.deepEqual({ ...second.ref_movement }, {
    ref,
    expected_old_oid: first.commit_oid,
    observed_old_oid: first.commit_oid,
    post_state: "known",
    reflog_entries: 1,
  });
  assert.equal(await readRef(git, ref), second.commit_oid);
});

test("in a SHA-256 repository a delta naming a 40-hex blob is refused as the delta it is, before git writes (review L2)", async (t) => {
  // ADR-098. Without the one-format check the blob reached `git update-index
  // --cacheinfo`, which exits 129 on it, and the apply was refused as
  // `environment_failure`: a broken machine instead of a malformed delta.
  const { git, ref, base, indexFile, custody } = await repository(t, { objectFormat: "sha256" });
  const narrow = delta(base, [{ path: "src/a.ts", status: "A", new_blob: "b".repeat(40), new_mode: "100644" }],
    { candidate_tree_oid: "c".repeat(64) });
  await assert.rejects(() => applyDelta(git, { custody, delta: narrow, realpath, ref, base, indexFile, message: "T-1" }),
    stop("delta_stale", "containment_mismatch"));
  assert.equal(await readRef(git, ref), base.commit_oid);
  // The fixture makes the staging ref itself now, so nothing at all was asked of the helper.
  assert.deepEqual(custody.requests.map((request) => request.action), []);
});

// --- debt 12g (R8-9): a crash-safe apply keeps its operation identity --------------

/** The scoped key an apply's recipe and request pair rest on (`applyKey`), for the delta on that ref and base. */
const keyOf = (d, ref, base) => deltaModule.applyKey({ ref, delta: d, base });

/** A helper that does what the stand-in does, and then the host process dies before it hears of it. */
function dyingAfterCommit(custody) {
  return Object.freeze({
    advance_staging: async (request) => {
      await custody.advance_staging(request);
      throw new Error("the host died before it read the helper's answer");
    },
  });
}

/** A helper that is asked and never commits: the host died on the way to it. */
const dyingBeforeCommit = Object.freeze({
  advance_staging: async () => {
    throw new Error("the host died before the helper was asked");
  },
});

/**
 * A filesystem whose journal write dies part of the way, the process gone with it: `at` is `write` (half of the
 * temporary file's bytes reach the disk), `sync` (the bytes are written, and not made durable), `link` (the file is
 * whole and has no name yet) or `afterLink` (the recipe has its name and the save never returned).
 */
function dyingFs(at) {
  const died = () => new Error("SIGKILL during the recipe write");
  return {
    ...nodeFs,
    // The process is gone: nothing it would have cleaned up is cleaned up, so what a crash leaves is left.
    unlink: async () => { throw died(); },
    link: async (from, to) => {
      if (at === "link") throw died();
      await nodeFs.link(from, to);
      if (at === "afterLink") throw died();
    },
    open: async (file, flags, mode) => {
      const handle = await nodeFs.open(file, flags, mode);
      return new Proxy(handle, {
        get(target, name) {
          if (name === "write" && at === "write") {
            return async (buffer, offset = 0, length = buffer.length - offset) => {
              await target.write(buffer, offset, Math.floor(length / 2));
              throw died();
            };
          }
          if (name === "sync" && at === "sync") return async () => { throw died(); };
          const value = target[name];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
}

/** A filesystem whose first `open` waits at a gate, so that another apply can run between what a save read and what it writes. */
function gatedFs() {
  let release;
  let reached;
  const gate = new Promise((resolve) => { release = resolve; });
  const arrived = new Promise((resolve) => { reached = resolve; });
  let first = true;
  return {
    release,
    arrived,
    fs: {
      ...nodeFs,
      open: async (file, flags, mode) => {
        if (first) {
          first = false;
          reached();
          await gate;
        }
        return nodeFs.open(file, flags, mode);
      },
    },
  };
}

/** A filesystem that fails one kind of call with an errno, as a full disk or a locked-down directory does. */
function failingFs(what, errno) {
  const error = () => Object.assign(new Error(`${errno}: the journal's disk said no`), { code: errno });
  return {
    ...nodeFs,
    readFile: async (file, ...rest) => {
      if (what === "read") throw error();
      return nodeFs.readFile(file, ...rest);
    },
    open: async (file, flags, mode) => {
      const handle = await nodeFs.open(file, flags, mode);
      return new Proxy(handle, {
        get(target, name) {
          if (name === "write" && what === "write") return async () => { throw error(); };
          const value = target[name];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
}

async function seeded(t, content = "a\n") {
  const repo = await repository(t);
  const oid = await blob(repo.git, repo.root, content);
  const d = delta(repo.base, [{ path: "src/a.ts", status: "A", new_blob: oid, new_mode: "100644" }]);
  return { ...repo, oid, d };
}

/** Another Epic's apply of a delta of its own, on the same repository and base: its own staging ref, index and delta. */
async function seededOn(repo, content, suffix) {
  const epic = { ref: stagingRef(suffix.repeat(64).slice(0, 64)), indexFile: path.join(path.dirname(repo.indexFile), `epic-${suffix}.index`) };
  await repo.git(["update-ref", "--create-reflog", "-m", "fixture: staging created", epic.ref, repo.base.commit_oid]);
  const oid = await blob(repo.git, repo.root, content);
  return { ...epic, d: delta(repo.base, [{ path: `src/${suffix}.ts`, status: "A", new_blob: oid, new_mode: "100644" }]) };
}

/** The same repository's second Epic: its own staging ref at the same base. */
async function secondEpic(repo) {
  const ref = stagingRef("b".repeat(64));
  await repo.git(["update-ref", "--create-reflog", "-m", "fixture: staging created", ref, repo.base.commit_oid]);
  const indexFile = path.join(path.dirname(repo.indexFile), "second.index");
  return { ref, indexFile };
}

test("the recipe is durable before the helper is asked, and the request carries the operation's identity", async (t) => {
  const { git, ref, base, indexFile, custody, d } = await seeded(t);
  const recipes = memoryRecipes();
  const key = keyOf(d, ref, base);
  const seen = [];
  const watching = {
    advance_staging: async (request) => {
      // Asked now: the recipe is already durable, and names the commit this request advances to.
      const recipe = await recipes.load(key);
      seen.push({ recipe, request: JSON.parse(JSON.stringify(request)) });
      return custody.advance_staging(request);
    },
  };
  const depth = await reflogDepth(git, ref);
  const result = await applyDeltaWith(git, { custody: watching, recipes, author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" });
  assert.equal(seen.length, 1);
  const { recipe, request } = seen[0];
  assert.ok(recipe, "no recipe was recorded before the helper was asked");
  assert.equal(recipe.expected_commit_oid, request.ref_updates[0].new_oid);
  assert.equal(recipe.expected_commit_oid, result.commit_oid);
  assert.equal(recipe.operation_id, d.operation_id);
  assert.equal(recipe.apply_key, key);
  assert.equal(recipe.delta_digest, d.delta_digest);
  assert.equal(recipe.ref, ref);
  assert.equal(recipe.base_commit_oid, base.commit_oid);
  assert.equal(recipe.base_tree_oid, base.tree_oid);
  assert.equal(recipe.tree_oid, result.tree_oid);
  assert.equal(recipe.message, "T-1");
  assert.deepEqual(recipe.author, AUTHOR);
  // The pair the daemon-side intent requires, derived from the scoped key, and the same one the recipe names.
  const identity = custodyModule.custodyIdentity(key, "advance_staging");
  assert.deepEqual([request.owner_operation_id, request.request_id], [identity.owner_operation_id, identity.request_id]);
  assert.deepEqual([recipe.owner_operation_id, recipe.request_id], [identity.owner_operation_id, identity.request_id]);
  // The reflog depth the apply started from, which a retry counts its own one movement against.
  assert.equal(recipe.reflog_before, depth);
  assert.equal(recipe.schema, 1);
  // The exact bytes of the commit are recorded (the planning recipe's discipline), so a prune costs nothing.
  assert.equal(Buffer.from(recipe.commit_object_bytes_base64, "base64").toString("utf8"), (await git(["cat-file", "commit", recipe.expected_commit_oid])).stdout);
  // Closed: what the recipe holds is what the commit and the request are made from, and nothing else.
  assert.deepEqual(Object.keys(recipe).sort(), [
    "apply_key", "author", "base_commit_oid", "base_tree_oid", "commit_object_bytes_base64", "delta_digest", "expected_commit_oid",
    "message", "operation_id", "owner_operation_id", "ref", "reflog_before", "reflog_head", "request_id", "schema", "tree_oid",
  ]);
});

test("the recipe fixes the commit: it is the commit git itself makes from the same tree, parent, identity and message", async (t) => {
  const { git, ref, base, indexFile, custody, d } = await seeded(t);
  const result = await applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" });
  const env = {
    GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email, GIT_AUTHOR_DATE: AUTHOR.date,
    GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email, GIT_COMMITTER_DATE: AUTHOR.date,
  };
  const again = await git(["commit-tree", result.tree_oid, "-p", base.commit_oid, "-m", "T-1"], { env });
  assert.equal(again.stdout.trim(), result.commit_oid);
  // Author and committer are the recorded identity, whatever the process's own configuration says.
  const raw = (await git(["cat-file", "commit", result.commit_oid])).stdout;
  assert.match(raw, /\nauthor autosk flow <flow@autosk\.invalid> 1700000000 \+0000\n/u);
  assert.match(raw, /\ncommitter autosk flow <flow@autosk\.invalid> 1700000000 \+0000\n/u);
});

test("the repository's commit encoding does not change the commit: the recipe pins UTF-8 (review L3)", async (t) => {
  const { git, ref, base, indexFile, custody, d } = await seeded(t);
  await git(["config", "i18n.commitEncoding", "ISO-8859-1"]);
  const result = await applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1 é" });
  const raw = (await git(["cat-file", "commit", result.commit_oid])).stdout;
  assert.doesNotMatch(raw, /^encoding /mu, "the commit carries an encoding header");
  assert.match(raw, /\n\nT-1 é\n$/u);
  const env = {
    GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email, GIT_AUTHOR_DATE: AUTHOR.date,
    GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email, GIT_COMMITTER_DATE: AUTHOR.date,
  };
  const plain = await git(["-c", "i18n.commitEncoding=UTF-8", "commit-tree", result.tree_oid, "-p", base.commit_oid, "-m", "T-1 é"], { env });
  assert.equal(plain.stdout.trim(), result.commit_oid);
});

test("a crash after the helper committed and before the receipt: the retry recognises its own commit and asks nothing", async (t) => {
  const { git, ref, base, indexFile, custody, recipesDir, d } = await seeded(t);
  const options = { author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" };
  await assert.rejects(() => applyDeltaWith(git, { ...options, recipes: journalAt(nodeFs, recipesDir), custody: dyingAfterCommit(custody) }), /the host died/u);
  // The helper did commit, and no receipt exists: the recipe is all the host has kept.
  const committed = await readRef(git, ref);
  assert.notEqual(committed, base.commit_oid);
  assert.equal(custody.requests.length, 1, "the one advance");
  const [recipe] = await recipesIn(recipesDir);
  assert.equal(committed, recipe.expected_commit_oid);

  // The retry, in a new process (a journal read from the file again): the ref is at the recipe's commit, so the
  // apply was done. No second request.
  const result = await applyDeltaWith(git, { ...options, recipes: journalAt(nodeFs, recipesDir), custody });
  assert.equal(custody.requests.length, 1, "a second request was asked for an apply already done");
  assert.equal(result.applied, true);
  assert.equal(result.recovered_from_recipe, true);
  assert.equal(result.commit_oid, committed);
  assert.equal(result.tree_oid, recipe.tree_oid);
  assert.equal(result.ref_movement.reflog_entries, 1);
  assert.equal(result.ref_movement.observed_old_oid, base.commit_oid);
  assert.deepEqual(integrationProof(d, result), []);
  // The receipt is written from the recipe: the phase the operation actually reached.
  const receipt = integrationReceipt(d, result);
  assert.equal(receipt.phase, "ref_advanced");
  assert.equal(receipt.staging_commit_oid, committed);
  assert.equal(receipt.staging_tree_oid, recipe.tree_oid);
  assert.equal(await readRef(git, ref), committed);
  // A first apply is not a recovery.
  const other = await seeded(t, "b\n");
  assert.equal((await applyDelta(other.git, { custody: other.custody, delta: other.d, realpath, ref: other.ref, base: other.base, indexFile: other.indexFile, message: "T-1" })).recovered_from_recipe, false);
});

test("a retry after the receipt was written is the apply already done: the same result, nothing asked", async (t) => {
  const { git, ref, base, indexFile, custody, d } = await seeded(t);
  const options = { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" };
  const first = await applyDelta(git, options);
  assert.equal(integrationReceipt(d, first).phase, "ref_advanced");
  const again = await applyDelta(git, options);
  assert.equal(custody.requests.length, 1, "a completed apply asked the helper again");
  assert.equal(again.applied, true);
  assert.equal(again.commit_oid, first.commit_oid);
  assert.equal(again.tree_oid, first.tree_oid);
  assert.deepEqual(integrationProof(d, again), []);
  assert.equal(integrationReceipt(d, again).phase, "ref_advanced");
});

test("a crash before the helper was asked: the retry asks under the same identity for the same commit", async (t) => {
  const { git, ref, base, indexFile, custody, recipesDir, d } = await seeded(t);
  const options = { delta: d, realpath, ref, base, indexFile };
  await assert.rejects(() => applyDeltaWith(git, { ...options, recipes: journalAt(nodeFs, recipesDir), author: AUTHOR, custody: dyingBeforeCommit, message: "T-1" }), /the host died/u);
  assert.equal(await readRef(git, ref), base.commit_oid);
  const recipe = (await recipesIn(recipesDir))[0];
  // The retry regenerates the message and the clock, as a careless caller would; the recipe wins.
  const later = { name: "someone else", email: "else@autosk.invalid", date: "1800000000 +0200" };
  const result = await applyDeltaWith(git, { ...options, recipes: journalAt(nodeFs, recipesDir), custody, author: later, message: "a different message" });
  assert.equal(result.applied, true);
  assert.equal(result.recovered_from_recipe, false);
  assert.equal(result.commit_oid, recipe.expected_commit_oid);
  const request = custody.requests.at(-1);
  assert.equal(typeof recipe.request_id, "string");
  assert.deepEqual([request.owner_operation_id, request.request_id], [recipe.owner_operation_id, recipe.request_id]);
  assert.equal(request.ref_updates[0].new_oid, recipe.expected_commit_oid);
  assert.match((await git(["cat-file", "commit", result.commit_oid])).stdout, /author autosk flow <flow@autosk\.invalid> 1700000000 \+0000/u);
  // One recipe was ever recorded for the operation, however often it was asked.
  assert.equal((await recipesIn(recipesDir)).length, 1);
});

test("a retry finds the commit object pruned and rewrites the very bytes it recorded, whatever the repository's config says now", async (t) => {
  const { git, root, ref, base, indexFile, custody, recipesDir, d } = await seeded(t);
  const options = { author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" };
  await assert.rejects(() => applyDeltaWith(git, { ...options, recipes: journalAt(nodeFs, recipesDir), custody: dyingBeforeCommit }), /the host died/u);
  const { expected_commit_oid: expected } = (await recipesIn(recipesDir))[0];
  assert.equal((await git(["cat-file", "-e", `${expected}^{commit}`])).code, 0);
  // gc prunes an unreferenced object once it is old enough; the test removes it by hand, and changes what
  // `commit-tree` would make of the same fields before the retry (review L3).
  await rm(path.join(root, ".git", "objects", expected.slice(0, 2), expected.slice(2)), { force: true });
  assert.notEqual((await git(["cat-file", "-e", `${expected}^{commit}`])).code, 0);
  await git(["config", "i18n.commitEncoding", "ISO-8859-1"]);
  const result = await applyDeltaWith(git, { ...options, recipes: journalAt(nodeFs, recipesDir), custody });
  assert.equal(result.commit_oid, expected);
  assert.equal(await readRef(git, ref), expected);
});

test("a retry after the helper answered not_applied at the recipe's own commit is the apply done", async (t) => {
  // Two attempts under one identity race; the helper commits one and refuses the other, and what it
  // observed is the recipe's commit.
  const { git, ref, base, indexFile, custody, d } = await seeded(t);
  const twice = {
    advance_staging: async (request) => {
      await custody.advance_staging(request);
      return custody.advance_staging(request);
    },
  };
  const result = await applyDelta(git, { custody: twice, delta: d, realpath, ref, base, indexFile, message: "T-1" });
  assert.equal(result.applied, true);
  assert.equal(result.recovered_from_recipe, true);
  assert.equal(result.ref_movement.reflog_entries, 1);
  assert.deepEqual(integrationProof(d, result), []);
});

test("staging moved by someone else is receipt_missing, named by where it went, and the helper is not asked", async (t) => {
  const { git, ref, base, indexFile, custody, recipesDir, d } = await seeded(t);
  const tree = base.tree_oid;
  // A commit on top of the base, and a commit on nothing the line holds.
  const beyond = (await git(["commit-tree", tree, "-p", base.commit_oid, "-m", "foreign"])).stdout.trim();
  const unrelated = (await git(["commit-tree", tree, "-m", "elsewhere"])).stdout.trim();
  for (const [moved, movement] of [[beyond, "beyond"], [unrelated, "unrelated"]]) {
    await git(["update-ref", ref, moved]);
    const error = await applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" }).then(() => null, (thrown) => thrown);
    assert.equal(error?.code, "receipt_missing", movement);
    assert.equal(error.details.movement, movement);
    assert.equal(error.details.held, moved);
    // No recipe yet, so the base is the one value the ref may hold; and refusing records no recipe.
    assert.deepEqual([...error.details.expected], [base.commit_oid], movement);
    assert.equal(custody.requests.length, 0, `${movement}: the helper was asked`);
  }
  assert.deepEqual(await recipesIn(recipesDir), [], "a refused apply recorded a recipe");
});

test("with a recipe on record, a staging ref that is neither the base nor its commit is refused naming both", async (t) => {
  const { git, ref, base, indexFile, custody, recipesDir, d } = await seeded(t);
  const options = { author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" };
  await assert.rejects(() => applyDeltaWith(git, { ...options, recipes: journalAt(nodeFs, recipesDir), custody: dyingBeforeCommit }), /the host died/u);
  const { expected_commit_oid: own } = (await recipesIn(recipesDir))[0];
  const foreign = (await git(["commit-tree", base.tree_oid, "-p", base.commit_oid, "-m", "foreign"])).stdout.trim();
  await git(["update-ref", ref, foreign]);
  const error = await applyDeltaWith(git, { ...options, recipes: journalAt(nodeFs, recipesDir), custody }).then(() => null, (thrown) => thrown);
  assert.equal(error?.code, "receipt_missing");
  assert.deepEqual([...error.details.expected], [base.commit_oid, own]);
  assert.equal(error.details.movement, "beyond");
  assert.equal(custody.requests.length, 0);
});

test("a staging ref rewound to a commit its receipts cover is refused as receipt_missing, moved 'behind'; nothing is asked (12a's open stop)", async (t) => {
  const { git, root, ref, base, indexFile, custody, d } = await seeded(t);
  const first = await applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" });
  const foreign = await blob(git, root, "second\n");
  const second = delta({ commit_oid: first.commit_oid, tree_oid: first.tree_oid }, [{ path: "src/b.ts", status: "A", new_blob: foreign, new_mode: "100644" }]);
  const two = await applyDelta(git, { custody, delta: second, realpath, ref, base: { commit_oid: first.commit_oid, tree_oid: first.tree_oid }, indexFile, message: "T-2" });
  assert.equal(await readRef(git, ref), two.commit_oid);
  // The principal's own tool rewinds the ref to the first receipted commit.
  await git(["update-ref", ref, first.commit_oid]);
  const third = delta({ commit_oid: two.commit_oid, tree_oid: two.tree_oid }, [{ path: "src/c.ts", status: "A", new_blob: foreign, new_mode: "100644" }]);
  const asked = custody.requests.length;
  const error = await applyDelta(git, { custody, delta: third, realpath, ref, base: { commit_oid: two.commit_oid, tree_oid: two.tree_oid }, indexFile, message: "T-3" })
    .then(() => null, (thrown) => thrown);
  assert.equal(error?.code, "receipt_missing");
  assert.equal(error.details.movement, "behind");
  assert.equal(error.details.held, first.commit_oid);
  assert.equal(custody.requests.length, asked);
});

test("a rewind to the base after the helper committed is not overwritten by a second request, and the operation cannot be re-run (review L1)", async (t) => {
  const { git, ref, base, indexFile, custody, recipesDir, d } = await seeded(t);
  const options = { author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" };
  await assert.rejects(() => applyDeltaWith(git, { ...options, recipes: journalAt(nodeFs, recipesDir), custody: dyingAfterCommit(custody) }), /the host died/u);
  const landed = await readRef(git, ref);
  // The user's own tool moves the ref back to the base: the reflog now shows the movement the recipe started before.
  await git(["update-ref", "-m", "user's tool", ref, base.commit_oid, landed]);
  const asked = custody.requests.length;
  const error = await applyDeltaWith(git, { ...options, recipes: journalAt(nodeFs, recipesDir), custody }).then(() => null, (thrown) => thrown);
  assert.equal(error?.code, "receipt_missing");
  assert.equal(error.details.movement, "behind");
  assert.equal(error.details.cause, "reflog");
  assert.equal(custody.requests.length, asked, "the retry asked the helper to move the ref forward again");
  assert.equal(await readRef(git, ref), base.commit_oid, "the user's rewind was overwritten");
});

test("a rebuild at the same base re-applies under a fresh operation: a new recipe and a new request pair, the same deterministic commit (review M2)", async (t) => {
  const { git, ref, base, indexFile, custody, d } = await seeded(t);
  const first = await applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" });
  // The user's tool rewinds the ref to the base; the recovery rebuilds staging there and re-applies.
  await git(["update-ref", ref, base.commit_oid]);
  await assert.rejects(() => applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" }), code("receipt_missing"));
  const asked = custody.requests.length;
  const fresh = delta(base, d.entries.map((entry) => ({ ...entry })));
  assert.notEqual(fresh.operation_id, d.operation_id);
  const again = await applyDelta(git, { custody, delta: fresh, realpath, ref, base, indexFile, message: "T-1" });
  assert.equal(again.applied, true);
  assert.equal(again.recovered_from_recipe, false);
  assert.equal(again.commit_oid, first.commit_oid, "the recipe's commit is a function of its fields");
  assert.equal(custody.requests.length, asked + 1);
  const [before, now] = custody.requests.filter((request) => request.action === "advance_staging").slice(-2);
  assert.notEqual(now.request_id, before.request_id, "the rebuilt request reused the pair of one that already committed");
  assert.notEqual(now.owner_operation_id, before.owner_operation_id);
});

test("a re-stage onto a moved target re-applies the delta on its new base under the same operation id, with a pair of its own (review M2)", async (t) => {
  const { git, root, ref, base, indexFile, custody, oid, d } = await seeded(t);
  const first = await applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" });
  await writeFile(path.join(root, "keep.txt"), "moved\n");
  await git(["commit", "--quiet", "-am", "target moved"]);
  const moved = { commit_oid: (await git(["rev-parse", "HEAD"])).stdout.trim(), tree_oid: (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim() };
  await git(["update-ref", "-d", ref]);
  await git(["update-ref", "--create-reflog", "-m", "fixture: staging re-created", ref, moved.commit_oid]);
  const restaged = delta(moved, [{ path: "src/a.ts", status: "A", new_blob: oid, new_mode: "100644" }], { operation_id: d.operation_id });
  const again = await applyDelta(git, { custody, delta: restaged, realpath, ref, base: moved, indexFile, message: "T-1" });
  assert.equal(again.applied, true);
  assert.notEqual(again.commit_oid, first.commit_oid);
  const requests = custody.requests.filter((request) => request.action === "advance_staging");
  assert.equal(requests.length, 2);
  assert.notEqual(requests[1].request_id, requests[0].request_id);
  assert.notEqual(requests[1].owner_operation_id, requests[0].owner_operation_id);
});

test("two Epics that name an operation alike ask under different pairs and keep their own recipes (review M2)", async (t) => {
  const repo = await seeded(t);
  const { git, ref, base, indexFile, custody, d } = repo;
  const second = await secondEpic(repo);
  const same = { operation_id: d.operation_id };
  const dB = delta(base, d.entries.map((entry) => ({ ...entry })), same);
  await applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" });
  const result = await applyDelta(git, { custody, delta: dB, realpath, ref: second.ref, base, indexFile: second.indexFile, message: "T-1" });
  assert.equal(result.applied, true);
  const [a, b] = custody.requests.filter((request) => request.action === "advance_staging");
  assert.notEqual(a.request_id, b.request_id);
  assert.notEqual(a.owner_operation_id, b.owner_operation_id);
  assert.notEqual(keyOf(d, ref, base), keyOf(dB, second.ref, base));
});

test("a foreign write of the recipe's own OID is not adopted: the newest reflog entry must be the helper's (review L2)", async (t) => {
  const { git, ref, base, indexFile, custody, recipesDir, d } = await seeded(t);
  const options = { author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" };
  await assert.rejects(() => applyDeltaWith(git, { ...options, recipes: journalAt(nodeFs, recipesDir), custody: dyingBeforeCommit }), /the host died/u);
  const { expected_commit_oid: own } = (await recipesIn(recipesDir))[0];
  // Somebody's tool writes the very OID before the retry (the bytes are public in the repository).
  await git(["update-ref", "-m", "someone's tool", ref, own, base.commit_oid]);
  const error = await applyDeltaWith(git, { ...options, recipes: journalAt(nodeFs, recipesDir), custody }).then(() => null, (thrown) => thrown);
  assert.equal(error?.code, "receipt_missing");
  assert.equal(error.details.cause, "reflog");
  assert.equal(custody.requests.length, 0);
});

test("a helper that says committed while the ref is not at the commit is refused, not reported as an apply", async (t) => {
  const { git, ref, base, indexFile, custody, d } = await seeded(t);
  const moved = (await git(["commit-tree", base.tree_oid, "-p", base.commit_oid, "-m", "after the helper"])).stdout.trim();
  const then = {
    advance_staging: async (request) => {
      const answer = await custody.advance_staging(request);
      await git(["update-ref", ref, moved]);
      return answer;
    },
  };
  const error = await applyDelta(git, { custody: then, delta: d, realpath, ref, base, indexFile, message: "T-1" }).then(() => null, (thrown) => thrown);
  assert.equal(error?.code, "receipt_missing");
  assert.equal(error.details.held, moved);
});

test("a delta whose operation id another delta used gets its own recipe and is judged by where the ref is (review M2)", async (t) => {
  const { git, root, ref, base, indexFile, custody, d } = await seeded(t);
  await applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" });
  const asked = custody.requests.length;
  const other = await blob(git, root, "other\n");
  const reused = delta(base, [{ path: "src/x.ts", status: "A", new_blob: other, new_mode: "100644" }], { operation_id: d.operation_id });
  // The staging ref is past the base now, so another delta on that base is a movement that is not its own.
  const error = await applyDelta(git, { custody, delta: reused, realpath, ref, base, indexFile, message: "T-1" }).then(() => null, (thrown) => thrown);
  assert.equal(error?.code, "receipt_missing");
  assert.equal(error.details.movement, "beyond");
  assert.equal(custody.requests.length, asked);
});

test("an apply with no recipe journal, or no host identity, is refused before anything is written or asked", async (t) => {
  const { git, ref, base, indexFile, custody, d } = await seeded(t);
  const depth = await reflogDepth(git, ref);
  for (const recipes of [undefined, null, {}, { load: async () => null }, { save: async () => {} }]) {
    await assert.rejects(() => applyDeltaWith(git, { custody, recipes, author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" }), code("custody_request_invalid"));
  }
  // Git refuses a date of fewer than nine digits, so it is refused here rather than as a failed git.
  for (const author of [undefined, null, {}, { ...AUTHOR, date: "yesterday" }, { ...AUTHOR, date: "12345678 +0000" }, { ...AUTHOR, name: "a<b" }, { ...AUTHOR, email: "no at sign" }]) {
    await assert.rejects(() => applyDeltaWith(git, { custody, recipes: memoryRecipes(), author, delta: d, realpath, ref, base, indexFile, message: "T-1" }), code("custody_request_invalid"), JSON.stringify(author));
  }
  assert.equal(custody.requests.length, 0);
  assert.equal(await reflogDepth(git, ref), depth);
  // Nine digits are a date git takes.
  const result = await applyDeltaWith(git, { custody, recipes: memoryRecipes(), author: { ...AUTHOR, date: "123456789 +0000" }, delta: d, realpath, ref, base, indexFile, message: "T-1" });
  assert.equal(result.applied, true);
});

test("a SHA-256 repository recovers its own commit the same way", async (t) => {
  const probe = await execFileAsync("git", ["init", "--object-format=sha256", "--bare", await mkdtemp(path.join(tmpdir(), "autosk-probe-"))]).then(() => true, () => false);
  if (!probe) return t.skip("this git has no SHA-256 object format");
  const { git, root, ref, base, indexFile, custody, recipesDir } = await repository(t, { objectFormat: "sha256" });
  const oid = await blob(git, root, "wide\n");
  const d = delta(base, [{ path: "src/a.ts", status: "A", new_blob: oid, new_mode: "100644" }], { candidate_tree_oid: "c".repeat(64) });
  const options = { author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" };
  await assert.rejects(() => applyDeltaWith(git, { ...options, recipes: journalAt(nodeFs, recipesDir), custody: dyingAfterCommit(custody) }), /the host died/u);
  const asked = custody.requests.length;
  const result = await applyDeltaWith(git, { ...options, recipes: journalAt(nodeFs, recipesDir), custody });
  assert.equal(result.commit_oid.length, 64);
  assert.equal(result.recovered_from_recipe, true);
  assert.equal(custody.requests.length, asked);
});

// --- the recipe journal, through the driver: crash during a save, interleaving, corruption, I/O (review N1-N4, L5) ---

const leftovers = async (directory) => (await readdir(directory)).filter((name) => name.endsWith(".pending"));

test("a crash during the recipe write leaves no recipe and no fragment another read can see: the helper was never asked, the retry applies, and other operations are unaffected", async (t) => {
  const { git, root, ref, base, indexFile, custody, recipesDir, d } = await seeded(t);
  const first = await applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" });
  const base2 = { commit_oid: first.commit_oid, tree_oid: first.tree_oid };
  const two = await blob(git, root, "two\n");
  const d2 = delta(base2, [{ path: "src/b.ts", status: "A", new_blob: two, new_mode: "100644" }]);
  const options = { author: AUTHOR, delta: d2, realpath, ref, base: base2, indexFile, message: "T-2" };
  const asked = custody.requests.length;
  await assert.rejects(() => applyDeltaWith(git, { ...options, recipes: journalAt(dyingFs("write"), recipesDir), custody }), /SIGKILL/u);
  assert.equal(custody.requests.length, asked, "the helper was asked before the recipe was durable");
  assert.equal((await recipesIn(recipesDir)).length, 1, "a fragment was left where a recipe is read");
  assert.equal((await leftovers(recipesDir)).length, 1, "the abandoned temporary file is what a crash leaves, and nothing reads it");
  // The retry, and an unrelated operation after it, are not wedged by what the crash left.
  const retried = await applyDeltaWith(git, { ...options, recipes: journalAt(nodeFs, recipesDir), custody });
  assert.equal(retried.applied, true);
  const three = await blob(git, root, "three\n");
  const base3 = { commit_oid: retried.commit_oid, tree_oid: retried.tree_oid };
  const d3 = delta(base3, [{ path: "src/c.ts", status: "A", new_blob: three, new_mode: "100644" }]);
  const last = await applyDelta(git, { custody, delta: d3, realpath, ref, base: base3, indexFile, message: "T-3" });
  assert.equal(last.applied, true);
  const held = await recipesIn(recipesDir);
  assert.equal(held.length, 3, "one recipe per apply");
});

test("a save that dies between its fsync and its link, or after the link, is absent or whole: never half (review N1)", async (t) => {
  for (const at of ["sync", "link", "afterLink"]) {
    const { git, ref, base, indexFile, custody, recipesDir, d } = await seeded(t);
    const options = { author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" };
    await assert.rejects(() => applyDeltaWith(git, { ...options, recipes: journalAt(dyingFs(at), recipesDir), custody }), /SIGKILL/u, at);
    assert.equal(custody.requests.length, 0, `${at}: the helper was asked over a save that never returned`);
    const held = await recipesIn(recipesDir);
    assert.equal(held.length, at === "afterLink" ? 1 : 0, at);
    const result = await applyDeltaWith(git, { ...options, recipes: journalAt(nodeFs, recipesDir), custody });
    assert.equal(result.applied, true, at);
    assert.equal(custody.requests.length, 1, at);
    assert.equal((await recipesIn(recipesDir)).length, 1, at);
  }
});

test("another Epic's save, begun before an operation's recipe was written and finished after, cannot cut that recipe (review N1, J1)", async (t) => {
  const repo = await seeded(t);
  const { git, ref, base, indexFile, custody, recipesDir, d } = repo;
  // A crash left the journal as a crash leaves it: a save that died in its write.
  const crashed = await seededOn(repo, "crashed\n", "0");
  await assert.rejects(() => applyDeltaWith(git, { custody, recipes: journalAt(dyingFs("write"), recipesDir), author: AUTHOR, delta: crashed.d, realpath, ref: crashed.ref, base, indexFile: crashed.indexFile, message: "T-0" }), /SIGKILL/u);
  // Epic B begins its save: it has read the journal and waits before it writes.
  const other = await seededOn(repo, "other\n", "1");
  const gate = gatedFs();
  const b = applyDeltaWith(git, { custody, recipes: journalAt(gate.fs, recipesDir), author: AUTHOR, delta: other.d, realpath, ref: other.ref, base, indexFile: other.indexFile, message: "T-B" });
  await gate.arrived;
  // Meanwhile Epic A saves its recipe, the helper commits, and A's host dies before the receipt.
  const options = { author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-A" };
  await assert.rejects(() => applyDeltaWith(git, { ...options, recipes: journalAt(nodeFs, recipesDir), custody: dyingAfterCommit(custody) }), /the host died/u);
  gate.release();
  assert.equal((await b).applied, true);
  // A's retry finds its recipe and its own commit: the apply already done, nothing asked.
  const asked = custody.requests.length;
  const retried = await applyDeltaWith(git, { ...options, recipes: journalAt(nodeFs, recipesDir), custody });
  assert.equal(retried.applied, true);
  assert.equal(retried.recovered_from_recipe, true);
  assert.equal(custody.requests.length, asked);
});

test("a writer that dies mid-write cannot fuse a fragment with the line another writes after it (review N1, J2)", async (t) => {
  const repo = await seeded(t);
  const { git, ref, base, indexFile, custody, recipesDir, d } = repo;
  // Epic B has read the journal, clean, and waits before it writes.
  const other = await seededOn(repo, "other\n", "1");
  const gate = gatedFs();
  const options = { author: AUTHOR, delta: other.d, realpath, ref: other.ref, base, indexFile: other.indexFile, message: "T-B" };
  const b = applyDeltaWith(git, { ...options, custody: dyingAfterCommit(custody), recipes: journalAt(gate.fs, recipesDir) });
  await gate.arrived;
  // Epic A's writer is killed in the middle of its write.
  await assert.rejects(() => applyDeltaWith(git, { custody, recipes: journalAt(dyingFs("write"), recipesDir), author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-A" }), /SIGKILL/u);
  gate.release();
  await assert.rejects(() => b, /the host died/u);
  // B's helper committed and B's host died: its retry must still recognise its own commit, and A's must apply.
  const asked = custody.requests.length;
  const retried = await applyDeltaWith(git, { ...options, recipes: journalAt(nodeFs, recipesDir), custody });
  assert.equal(retried.recovered_from_recipe, true);
  assert.equal(custody.requests.length, asked);
  const again = await applyDeltaWith(git, { author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-A", recipes: journalAt(nodeFs, recipesDir), custody });
  assert.equal(again.applied, true);
});

test("a corrupt recipe stops its own key and no other: another Epic still applies, and a fresh operation is the way back (review N2)", async (t) => {
  const repo = await seeded(t);
  const { git, ref, base, indexFile, custody, recipesDir, d } = repo;
  await applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" });
  const stuckKey = keyOf(d, ref, base);
  await tamper(recipesDir, stuckKey);
  // The apply whose recipe it is cannot be judged, and nothing is asked over it.
  const asked = custody.requests.length;
  const stuck = await applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" }).then(() => null, (thrown) => thrown);
  assert.equal(stuck?.code, "receipt_missing");
  assert.equal(stuck.details.cause, "journal");
  assert.equal(custody.requests.length, asked);
  // Another Epic, in the same journal directory, is not stopped by it.
  const other = await seededOn(repo, "other\n", "1");
  const fine = await applyDelta(git, { custody, delta: other.d, realpath, ref: other.ref, base, indexFile: other.indexFile, message: "T-B" });
  assert.equal(fine.applied, true);
  // The way back for the stuck key: the file is quarantined, and the delta is re-applied under a fresh operation.
  await rename(path.join(recipesDir, `${stuckKey}.recipe`), path.join(recipesDir, `${stuckKey}.recipe.quarantined`));
  const fresh = delta(base, d.entries.map((entry) => ({ ...entry })));
  await git(["update-ref", "-m", "the person restores the line", ref, base.commit_oid]);
  const back = await applyDelta(git, { custody, delta: fresh, realpath, ref, base, indexFile, message: "T-1" });
  assert.equal(back.applied, true);
});

test("saves made at once across Epics keep every recipe (review M1, N1)", async (t) => {
  const repo = await seeded(t);
  const { git, ref, base, indexFile, custody, recipesDir, d } = repo;
  const second = await secondEpic(repo);
  const other = await blob(git, repo.root, "other\n");
  const dB = delta(base, [{ path: "src/b.ts", status: "A", new_blob: other, new_mode: "100644" }]);
  const journal = journalAt(nodeFs, recipesDir);
  const [a, b] = await Promise.all([
    applyDeltaWith(git, { custody, recipes: journal, author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" }),
    applyDeltaWith(git, { custody, recipes: journalAt(nodeFs, recipesDir), author: AUTHOR, delta: dB, realpath, ref: second.ref, base, indexFile: second.indexFile, message: "T-2" }),
  ]);
  assert.equal(a.applied && b.applied, true);
  const held = (await recipesIn(recipesDir)).map((recipe) => recipe.apply_key).sort();
  assert.deepEqual(held, [keyOf(d, ref, base), keyOf(dB, second.ref, base)].sort());
});

test("a journal that cannot write or read is an environment failure the graph has, nothing is asked, and a plain resume applies (review N3)", async (t) => {
  for (const [what, errno] of [["write", "ENOSPC"], ["write", "EDQUOT"], ["read", "EACCES"]]) {
    const { git, ref, base, indexFile, custody, recipesDir, d } = await seeded(t);
    const options = { author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" };
    const error = await applyDeltaWith(git, { ...options, recipes: journalAt(failingFs(what, errno), recipesDir), custody }).then(() => null, (thrown) => thrown);
    assert.equal(error?.code, "environment_failure", `${what} ${errno}`);
    assert.equal(error.details.cause, "journal_io");
    assert.equal(error.details.errno, errno);
    assert.equal(custody.requests.length, 0, `${what} ${errno}: the helper was asked`);
    assert.equal((await recipesIn(recipesDir)).length, 0);
    // The disk is back: nothing was half done, so nothing is restored, and the apply simply runs.
    const result = await applyDeltaWith(git, { ...options, recipes: journalAt(nodeFs, recipesDir), custody });
    assert.equal(result.applied, true, `${what} ${errno}`);
  }
});

test("a delete and re-create of the staging ref at the base cannot make a same-operation re-apply re-send the pair of a request that committed (review N4)", async (t) => {
  const { git, ref, base, indexFile, custody, d } = await seeded(t);
  await applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" });
  const advances = () => custody.requests.filter((request) => request.action === "advance_staging").length;
  // The documented restore: the moved ref is deleted and re-created at the base, which starts its reflog over —
  // the same depth as when the recipe was made — and by a different hand (its message and time are its own).
  await git(["update-ref", "-d", ref]);
  await git(["update-ref", "--create-reflog", "-m", "the person re-creates staging", ref, base.commit_oid]);
  assert.equal(await reflogDepth(git, ref), 1);
  const asked = advances();
  const error = await applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" }).then(() => null, (thrown) => thrown);
  assert.equal(error?.code, "receipt_missing");
  assert.equal(error.details.cause, "reflog");
  assert.equal(advances(), asked, "the pair of a request that already committed was sent again");
  // A fresh operation is what re-applies it.
  const fresh = delta(base, d.entries.map((entry) => ({ ...entry })));
  const again = await applyDelta(git, { custody, delta: fresh, realpath, ref, base, indexFile, message: "T-1" });
  assert.equal(again.applied, true);
  assert.equal(advances(), asked + 1);
});

/** A signed planning head as the base of staging (#17's signed-ancestry profile): the same tree, and a commit that carries a signature. */
async function signedBase(repo, t) {
  const { git, root, ref, base } = repo;
  const tool = path.join(path.dirname(repo.indexFile), "fakegpg");
  await writeFile(tool, '#!/bin/sh\necho "gpg: Signature made Thu Nov 14 22:13:20 2023 UTC" >&2\necho "gpg: Good signature from \\"Planner <p@x>\\"" >&2\nexit 0\n', { mode: 0o755 });
  const body = `tree ${base.tree_oid}\nauthor p <p@x> 1700000000 +0000\ncommitter p <p@x> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nplanning head\n`;
  const head = (await git(["hash-object", "-t", "commit", "-w", "--stdin"], { stdin: body })).stdout.trim();
  await git(["update-ref", "refs/heads/main", head]);
  await git(["update-ref", "-d", ref]);
  await git(["update-ref", "--create-reflog", "-m", "fixture: staging created", ref, head]);
  // The repository's own configuration, which the apply's git reads (the isolation nulls only the system and global files).
  await git(["config", "log.showSignature", "true"]);
  await git(["config", "gpg.program", tool]);
  return { commit_oid: head, tree_oid: base.tree_oid, root, t };
}

test("a display option of the repository cannot change what the reflog check reads: a signed base under log.showSignature is still a delete and re-create refused (review F1)", async (t) => {
  const repo = await seeded(t);
  const { git, ref, indexFile, custody, root } = repo;
  const base = await signedBase(repo, t);
  const oid = await blob(git, root, "signed\n");
  const d = delta(base, [{ path: "src/s.ts", status: "A", new_blob: oid, new_mode: "100644" }]);
  const options = { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" };
  const advances = () => custody.requests.filter((request) => request.action === "advance_staging").length;
  // The precondition, so that the test cannot pass without the configuration doing what it does: git prints a signature
  // report before the entry the reflog names, in front of whatever the format asks for.
  const shown = (await git(["reflog", "show", "--date=raw", "--format=%H%x1f%gs", "-n", "1", ref])).stdout;
  assert.match(shown, /^gpg: /mu, "the fixture's configuration does not show a signature");
  const first = await applyDelta(git, options);
  assert.equal(first.applied, true);
  const recorded = (await recipesIn(repo.recipesDir))[0];
  assert.match(recorded.reflog_head, /^[0-9a-f]{64}$/u);
  // The documented restore: the moved ref is deleted and made again at the base, by another hand.
  await git(["update-ref", "-d", ref]);
  await git(["update-ref", "--create-reflog", "-m", "the person re-creates staging", ref, base.commit_oid]);
  assert.match((await git(["reflog", "show", "--date=raw", "--format=%H%x1f%gs", "-n", "1", ref])).stdout, /^gpg: /mu);
  const asked = advances();
  const error = await applyDelta(git, options).then(() => null, (thrown) => thrown);
  assert.equal(error?.code, "receipt_missing");
  assert.equal(error.details.cause, "reflog");
  assert.equal(advances(), asked, "the pair of a request that already committed was sent again");
});

test("with a signature shown, a retry whose reflog has not moved is asked, and the recipe's head is the entry and not the report (review F1)", async (t) => {
  const repo = await seeded(t);
  const { git, ref, indexFile, custody, root } = repo;
  const base = await signedBase(repo, t);
  const oid = await blob(git, root, "signed\n");
  const d = delta(base, [{ path: "src/s.ts", status: "A", new_blob: oid, new_mode: "100644" }]);
  const options = { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" };
  const dead = await applyDelta(git, { ...options, custody: dyingBeforeCommit }).then(() => null, (thrown) => thrown);
  assert.match(dead?.message ?? "", /host died/u);
  const [held] = await recipesIn(repo.recipesDir);
  // What identifies the entry: the OID, selector, time, hand and message, in the fixed order, without any report in front of it.
  const entry = (await git(["-c", "log.showSignature=false", "reflog", "show", "--no-show-signature", "--date=raw", "--format=%H%x1f%gd%x1f%gn%x1f%ge%x1f%gs", "-n", "1", ref])).stdout.split("\n")[0].trim();
  assert.equal(held.reflog_head, createHash("sha256").update(entry, "utf8").digest("hex"));
  const again = await applyDelta(git, options);
  assert.equal(again.applied, true);
});

/** A git that fails the reflog reads `matches` selects, as a transient fault (a lock, a full disk) does. */
const failingReflog = (git, matches, exit = 128) => async (args, options) => (
  args.includes("reflog") && matches(args) ? { code: exit, stdout: "", stderr: "fatal: a transient fault" } : git(args, options));
const readsHead = (args) => args.includes("--date=raw");
const readsMessage = (args) => args.some((arg) => arg.startsWith("--format=") && arg.endsWith("%gs") && !arg.includes("%H"));
const readsDepth = (args) => args.includes("--format=%H");

test("a git that fails while the reflog is read is an environment failure and a plain resume, never a line-integrity refusal and never a recorded null (review F4)", async (t) => {
  const { git, ref, base, indexFile, custody, recipesDir, d } = await seeded(t);
  const options = { recipes: journals.get(git), author: AUTHOR, custody, delta: d, realpath, ref, base, indexFile, message: "T-1" };
  const advances = () => custody.requests.filter((request) => request.action === "advance_staging").length;
  // While the recipe is made: the head and the depth are read, and neither may be recorded from a failure.
  for (const [name, matches] of [["head", readsHead], ["depth", readsDepth]]) {
    const error = await applyDeltaWith(failingReflog(git, matches), options).then(() => null, (thrown) => thrown);
    assert.equal(error?.code, "environment_failure", `${name} at recipe time`);
    assert.match(error.message, /git reflog exited 128/u, name);
    assert.equal((await recipesIn(recipesDir)).length, 0, `${name}: a recipe was recorded from a failed read`);
    assert.equal(advances(), 0, `${name}: the helper was asked`);
  }
  // The crash before the helper committed: the recipe is on record, the ref is at the base, and the retry reads the reflog.
  const dead = await applyDelta(git, { ...options, custody: dyingBeforeCommit }).then(() => null, (thrown) => thrown);
  assert.match(dead?.message ?? "", /host died/u);
  const [held] = await recipesIn(recipesDir);
  assert.match(held.reflog_head, /^[0-9a-f]{64}$/u, "a head that exists was recorded as none");
  for (const [name, matches] of [["head", readsHead], ["depth", readsDepth]]) {
    const error = await applyDeltaWith(failingReflog(git, matches), options).then(() => null, (thrown) => thrown);
    assert.equal(error?.code, "environment_failure", `${name} at the retry`);
    assert.equal(advances(), 0, `${name}: the helper was asked over a reflog nobody could read`);
  }
  // Nothing is half done: the plain resume applies.
  const back = await applyDelta(git, options);
  assert.equal(back.applied, true);
  assert.equal(advances(), 1);
});

test("a git that fails while the newest reflog message is read leaves a recovery to the resume, not to the person (review F4)", async (t) => {
  const { git, ref, base, indexFile, custody, d } = await seeded(t);
  const options = { recipes: journals.get(git), author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" };
  const dead = await applyDelta(git, { ...options, custody: dyingAfterCommit(custody) }).then(() => null, (thrown) => thrown);
  assert.match(dead?.message ?? "", /host died/u);
  const asked = custody.requests.length;
  const error = await applyDeltaWith(failingReflog(git, readsMessage), { ...options, custody }).then(() => null, (thrown) => thrown);
  assert.equal(error?.code, "environment_failure");
  assert.equal(custody.requests.length, asked);
  const recovered = await applyDelta(git, { ...options, custody });
  assert.equal(recovered.recovered_from_recipe, true);
  assert.equal(custody.requests.length, asked, "the recovery asked the helper");
});

test("a recipe whose directory sync failed is not relied on by the retry: nothing is asked until the directory is durable (review F2)", async (t) => {
  const { git, ref, base, indexFile, custody, recipesDir, d } = await seeded(t);
  const options = { author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1", custody };
  const advances = () => custody.requests.filter((request) => request.action === "advance_staging").length;
  // The save links the recipe and the directory's fsync reports EIO: the save fails, and the name is on disk.
  const eio = {
    ...nodeFs,
    open: async (target, flags, mode) => {
      if (target === recipesDir) throw Object.assign(new Error("EIO: the directory cannot be made durable"), { code: "EIO" });
      return nodeFs.open(target, flags, mode);
    },
  };
  for (const attempt of ["the save", "the retry"]) {
    const error = await applyDeltaWith(git, { ...options, recipes: journalAt(eio, recipesDir) }).then(() => null, (thrown) => thrown);
    assert.equal(error?.code, "environment_failure", attempt);
    assert.equal(error.details.errno, "EIO", attempt);
    assert.equal((await recipesIn(recipesDir)).length, 1, `${attempt}: the linked recipe is on disk`);
    // The helper is not asked to commit a commit whose recipe the filesystem may lose with the power.
    assert.equal(advances(), 0, `${attempt}: the helper was asked before the recipe was durable`);
  }
  const done = await applyDeltaWith(git, { ...options, recipes: journalAt(nodeFs, recipesDir) });
  assert.equal(done.applied, true);
  assert.equal(advances(), 1);
});

test("after a quarantine the same operation is refused by name, and only a fresh operation re-applies: the committed pair is never re-sent (review F3)", async (t) => {
  const repo = await seeded(t);
  const { git, ref, base, indexFile, custody, recipesDir, d } = repo;
  const options = { recipes: journals.get(git), author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" };
  const advances = () => custody.requests.filter((request) => request.action === "advance_staging").length;
  // The helper commits and the host dies before the receipt; the recipe then cannot vouch.
  const dead = await applyDelta(git, { ...options, custody: dyingAfterCommit(custody) }).then(() => null, (thrown) => thrown);
  assert.match(dead?.message ?? "", /host died/u);
  const committed = await readRef(git, ref);
  const stuckKey = keyOf(d, ref, base);
  await tamper(recipesDir, stuckKey);
  const parked = await applyDelta(git, { ...options, custody }).then(() => null, (thrown) => thrown);
  assert.equal(parked?.code, "receipt_missing");
  assert.equal(parked.details.cause, "journal");
  // The person: quarantines the file, restores the line (the moved ref is put back at the base).
  await rename(path.join(recipesDir, `${stuckKey}.recipe`), path.join(recipesDir, `${stuckKey}.recipe.quarantined`));
  await git(["update-ref", "-m", "the person restores the line", ref, base.commit_oid, committed]);
  const asked = advances();
  // The resume re-applies the same delta under the same operation: the recipe that held the reflog guard is gone,
  // and a new one would carry the pair of the request that committed. It is refused, and nothing is asked.
  const again = await applyDelta(git, { ...options, custody }).then(() => null, (thrown) => thrown);
  assert.equal(again?.code, "receipt_missing");
  assert.equal(again.details.cause, "journal");
  assert.equal(again.details.apply_key, stuckKey);
  assert.equal(advances(), asked, "the pair of a request that already committed was sent again");
  assert.equal(await readRef(git, ref), base.commit_oid);
  assert.deepEqual((await readdir(recipesDir)).filter((name) => name.endsWith(".recipe")), [], "a quarantined key was given a recipe");
  // A fresh operation is the way back, under a pair of its own.
  const fresh = delta(base, d.entries.map((entry) => ({ ...entry })));
  const back = await applyDelta(git, { ...options, delta: fresh, custody });
  assert.equal(back.applied, true);
  assert.equal(advances(), asked + 1);
});

test("a recipe that is not this apply's, in any field the identity rests on, is refused as receipt_missing and nothing is asked (mutation of 12g)", async (t) => {
  const { git, ref, base, indexFile, custody, d } = await seeded(t);
  const recipes = memoryRecipes();
  const options = { recipes, author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" };
  await assert.rejects(() => applyDeltaWith(git, { ...options, custody: dyingBeforeCommit }), /the host died/u);
  const key = keyOf(d, ref, base);
  const honest = await recipes.load(key);
  const otherRef = `refs/autosk/epics/${"b".repeat(64)}/staging`;
  for (const [field, value] of [
    ["schema", 2],
    ["delta_digest", "f".repeat(64)],
    ["ref", otherRef],
    ["base_commit_oid", "9".repeat(40)],
    ["base_tree_oid", "8".repeat(40)],
    ["tree_oid", "7".repeat(40)],
    ["apply_key", "6".repeat(64)],
  ]) {
    recipes.held.set(key, { ...honest, [field]: value });
    const error = await applyDeltaWith(git, { ...options, custody }).then(() => null, (thrown) => thrown);
    assert.equal(error?.code, "receipt_missing", field);
    assert.equal(error.details.cause, "recipe", field);
  }
  assert.equal(custody.requests.length, 0, "the helper was asked over a recipe that is not this apply's");
  // The honest recipe is still good.
  recipes.held.set(key, honest);
  assert.equal((await applyDeltaWith(git, { ...options, custody })).applied, true);
});

test("a recipe whose commit cannot be written again from its bytes is refused, not asked (mutation of 12g)", async (t) => {
  const { git, root, ref, base, indexFile, custody, d } = await seeded(t);
  const recipes = memoryRecipes();
  const options = { recipes, author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" };
  await assert.rejects(() => applyDeltaWith(git, { ...options, custody: dyingBeforeCommit }), /the host died/u);
  const key = keyOf(d, ref, base);
  const honest = await recipes.load(key);
  await rm(path.join(root, ".git", "objects", honest.expected_commit_oid.slice(0, 2), honest.expected_commit_oid.slice(2)), { force: true });
  // The bytes are not the ones the recorded OID names: the same OID cannot come back.
  const forged = Buffer.from(Buffer.from(honest.commit_object_bytes_base64, "base64").toString("utf8").replace("flow@autosk.invalid", "else@autosk.invalid"));
  recipes.held.set(key, { ...honest, commit_object_bytes_base64: forged.toString("base64") });
  const error = await applyDeltaWith(git, { ...options, custody }).then(() => null, (thrown) => thrown);
  assert.equal(error?.code, "receipt_missing");
  assert.equal(error.details.cause, "recipe_bytes");
  assert.equal(custody.requests.length, 0);
  assert.equal(await readRef(git, ref), base.commit_oid);
});

test("every refusal a moved or unreadable staging apply makes is a stop the graph has at apply_staging (review M2)", async () => {
  const graph = JSON.parse(readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "resources/workflow-graph/workflow-graph.v1.json"), "utf8"));
  const parked = new Set(graph.recovery.filter((row) => row.parks_at.includes("apply_staging")).map((row) => row.reason));
  const source = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src/host/delta-driver.mjs"), "utf8");
  const journal = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src/host/staging-lineage.mjs"), "utf8");
  // The refusals the recipe and the journal add are one name, receipt_missing; the code the review found without an edge is gone.
  assert.ok(parked.has("receipt_missing"));
  // `state_identity_collision` is left at one place in the driver, the temporary index that would sit inside the project — a
  // host configuration fault, refused before any state exists — and nowhere in the journal.
  assert.equal((source.match(/'state_identity_collision'/gu) ?? []).length, 1);
  assert.doesNotMatch(journal, /'state_identity_collision'/u);
  // The codes an apply can still raise are the delta's own (`delta_stale`, the host's capability and formation faults),
  // each with an edge or a caller who cannot reach it: none of the 12g refusals is left without one.
  assert.ok(parked.has("delta_stale") && parked.has("planning_ref_capability_missing"));
});

test("a git that cannot run is an environment failure that names the command, `-c` options and all (mutation of 12g)", async (t) => {
  const { git, ref, base, indexFile, custody, recipesDir, d } = await seeded(t);
  const failing = (command) => async (args, options) => {
    const name = args[0] === "-c" ? args[2] : args[0];
    return name === command ? { code: 128, stdout: "", stderr: "boom" } : git(args, options);
  };
  // The commit is made with the encoding pinned, so its command opens with `-c`; the name is the command, not the flag.
  const commit = await applyDeltaWith(failing("commit-tree"), { recipes: journals.get(git), author: AUTHOR, custody, delta: d, realpath, ref, base, indexFile, message: "T-1" }).then(() => null, (thrown) => thrown);
  assert.equal(commit?.code, "environment_failure");
  assert.equal(commit.message, "git commit-tree exited 128");
  // Any other command names itself.
  const tree = await applyDeltaWith(failing("write-tree"), { recipes: journals.get(git), author: AUTHOR, custody, delta: d, realpath, ref, base, indexFile, message: "T-1" }).then(() => null, (thrown) => thrown);
  assert.equal(tree?.code, "environment_failure");
  assert.equal(tree.message, "git write-tree exited 128");
  assert.equal(custody.requests.length, 0);
});

// --- debt 13a (R9-3, R9-9, the #280 carry) ---------------------------------------

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const graphOf = () => JSON.parse(readFileSync(path.join(ROOT, "resources/workflow-graph/workflow-graph.v1.json"), "utf8"));
/** The park reasons the graph's edges out of apply_staging carry, from the edges and not from a list. */
const applyEdgeReasons = (graph) => {
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  return new Set(graph.transitions.filter((edge) => edge.from === "apply_staging")
    .flatMap((edge) => edge.guards.map((id) => guards.get(id).park_reason)));
};

test("a git that fails while the staging ref's place is read is an environment failure, not `unrelated` (#280 carry A)", async (t) => {
  const { git, root, ref, base, indexFile, custody, d } = await seeded(t);
  const foreign = (await git(["commit-tree", base.tree_oid, "-p", base.commit_oid, "-m", "foreign"])).stdout.trim();
  await git(["update-ref", "-m", "someone", ref, foreign]);
  const stderr = `fatal: ${"x".repeat(400)}`;
  // Exit 1 is git's "not an ancestor"; any other exit is git failing. Either of the two questions can fail.
  for (const [failsAt, exit] of [[0, 128], [1, 128], [0, 2], [1, 129]]) {
    let asked = 0;
    const failing = async (args, options) => {
      if (args[0] === "merge-base") {
        const now = asked;
        asked += 1;
        if (now === failsAt) return { code: exit, stdout: "", stderr };
        return { code: 1, stdout: "", stderr: "" };
      }
      return git(args, options);
    };
    const error = await applyDeltaWith(failing, { recipes: journals.get(git), author: AUTHOR, custody, delta: d, realpath, ref, base, indexFile, message: "T-1" })
      .then(() => null, (thrown) => thrown);
    assert.equal(error?.code, "environment_failure", `${failsAt}/${exit}: ${error?.code} ${error?.details?.movement}`);
    assert.equal(error.message, "git merge-base exited " + exit);
    assert.deepEqual([...error.details.args].slice(0, 2), ["merge-base", "--is-ancestor"]);
    assert.equal(error.details.stderr.length, 200, "the stderr is bounded");
  }
  assert.equal(custody.requests.length, 0);
  // Exit 1 is still "not an ancestor", and the movement stays one the graph names: the foreign commit descends from the base, so the ref is beyond it.
  const error = await applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" }).then(() => null, (thrown) => thrown);
  assert.equal(error?.code, "receipt_missing");
  assert.equal(error.details.movement, "beyond");
  assert.ok(root);
});

test("a recipe whose owner or request identity is not the one this apply derives is refused as receipt_missing, and the request carries the derived pair (#280 carry B)", async (t) => {
  const { git, ref, base, indexFile, custody, d } = await seeded(t);
  const recipes = memoryRecipes();
  const options = { recipes, author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" };
  await assert.rejects(() => applyDeltaWith(git, { ...options, custody: dyingBeforeCommit }), /the host died/u);
  const key = keyOf(d, ref, base);
  const honest = await recipes.load(key);
  const derived = custodyModule.custodyIdentity(key, "advance_staging");
  assert.equal(honest.owner_operation_id, derived.owner_operation_id);
  const stranger = custodyModule.custodyIdentity("another-operation", "advance_staging");
  for (const [what, fields] of [
    ["owner_operation_id", { owner_operation_id: stranger.owner_operation_id }],
    ["request_id", { request_id: stranger.request_id }],
    ["both", stranger],
    ["swapped", { owner_operation_id: derived.request_id, request_id: derived.owner_operation_id }],
    ["not a uuid", { request_id: "nope" }],
    ["absent", { owner_operation_id: undefined }],
  ]) {
    recipes.held.set(key, { ...honest, ...fields });
    const error = await applyDeltaWith(git, { ...options, custody }).then(() => null, (thrown) => thrown);
    assert.equal(error?.code, "receipt_missing", what);
    assert.equal(error.details.cause, "recipe", what);
  }
  assert.equal(custody.requests.length, 0, "the helper was asked over a recipe whose pair is not this apply's");
  recipes.held.set(key, honest);
  await applyDeltaWith(git, { ...options, custody });
  const [request] = custody.requests;
  assert.equal(request.owner_operation_id, derived.owner_operation_id);
  assert.equal(request.request_id, derived.request_id);
});

test("the recovery of a recipe's own commit names the helper by the derived owner, not by a stored one (#280 carry B)", async (t) => {
  const { git, ref, base, indexFile, custody, d } = await seeded(t);
  const recipes = memoryRecipes();
  const options = { recipes, author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" };
  await applyDeltaWith(git, { ...options, custody: dyingAfterCommit(custody) }).catch(() => {});
  const key = keyOf(d, ref, base);
  const honest = await recipes.load(key);
  // A stored owner that names another helper message would make the apply adopt a commit under a hand that is not the helper's.
  recipes.held.set(key, { ...honest, owner_operation_id: custodyModule.custodyIdentity("x", "advance_staging").owner_operation_id });
  const error = await applyDeltaWith(git, { ...options, custody }).then(() => null, (thrown) => thrown);
  assert.equal(error?.code, "receipt_missing");
  assert.equal(error.details.cause, "recipe");
});

/** Every refusal an apply makes before the ref moves, by the contract's name it starts from (approved-delta §9): the options that provoke it. */
async function refusalScenarios(t) {
  const repo = await repository(t);
  const { git, root, ref, base, indexFile, custody } = repo;
  const oid = await blob(git, root, "a\n");
  const d = delta(base, [{ path: "src/a.ts", status: "A", new_blob: oid, new_mode: "100644" }]);
  const options = { custody, recipes: journals.get(git), author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" };
  const outside = delta(base, [{ path: "docs/a.md", status: "A", new_blob: oid, new_mode: "100644" }]);
  const twice = delta(base, [{ path: "src/a.ts", status: "A", new_blob: oid, new_mode: "100644" }, { path: "src/a.ts", status: "A", new_blob: oid, new_mode: "100644" }]);
  return {
    repo,
    options,
    cases: [
      ["delta_stale", "delta_stale", { base: { commit_oid: "d".repeat(40), tree_oid: "e".repeat(40) } }],
      ["delta_stale", "delta_stale", { delta: { ...d, delta_digest: "0".repeat(64) } }],
      ["scope_violation", "delta_stale", { delta: outside }],
      ["containment_mismatch", "delta_stale", { delta: twice }],
      ["untracked_collision", "environment_failure", { worktree: { untracked: ["src/a.ts"], ignored: [] } }],
      ["ignored_collision", "environment_failure", { worktree: { untracked: [], ignored: ["src/a.ts"] } }],
      ["inherited_git_env", "environment_failure", { env: { GIT_INDEX_FILE: "/x" } }],
      ["state_identity_collision", "environment_failure", { indexFile: path.join(root, "apply.index") }],
    ],
  };
}

test("every refusal an apply makes before the ref moves is a stop the graph has at apply_staging, with the contract's name as its cause (R9-3, ADR-109)", async (t) => {
  const { repo, options, cases } = await refusalScenarios(t);
  const edges = applyEdgeReasons(graphOf());
  for (const [name, stopName, overrides] of cases) {
    const error = await applyDelta(repo.git, { ...options, ...overrides }).then(() => null, (thrown) => thrown);
    assert.equal(error?.code, stopName, name);
    assert.equal(error.details.cause, name, name);
    assert.ok(edges.has(error.code), `${name}: ${error.code} has no edge at apply_staging`);
  }
  // Nothing was written or asked: the ref is where it was and the helper heard nothing.
  assert.equal(await readRef(repo.git, repo.ref), repo.base.commit_oid);
  assert.equal(repo.custody.requests.length, 0);
});

test("the map of the contract's twelve names is closed, and each stop it names is one the graph carries at apply_staging (R9-3, ADR-109)", async () => {
  const { PARK_REASONS } = await import("../src/host/approved-delta.mjs");
  assert.deepEqual(Object.keys(deltaModule.APPLY_STOPS).sort(), [...PARK_REASONS].sort());
  const edges = applyEdgeReasons(graphOf());
  for (const [name, { before, after }] of Object.entries(deltaModule.APPLY_STOPS)) {
    for (const stopName of [before, after]) {
      if (stopName !== null) assert.ok(edges.has(stopName), `${name} maps to ${stopName}, which no edge out of apply_staging carries`);
    }
  }
  // What the apply reports is the stops the graph carries at apply_staging except the anchor's, which the apply never raises.
  assert.deepEqual([...deltaModule.APPLY_STOP_REASONS].sort(), [...edges].filter((reason) => reason !== "blocked_anchor").sort());
});

test("a refusal of the apply reaches the graph as its stop and never as a reasonless park: what a step body calls returns it, and every name of the map has a scenario (R9-3, ADR-109)", async (t) => {
  const { repo, options, cases } = await refusalScenarios(t);
  const covered = new Set();
  for (const [name, stopName, overrides] of cases) {
    const outcome = await deltaModule.applyWithOutcome(repo.git, { ...options, ...overrides });
    assert.equal(outcome.result, null, name);
    assert.equal(outcome.receipt, null, name);
    assert.equal(outcome.stop.reason, stopName, name);
    assert.equal(outcome.stop.cause, name, name);
    covered.add(name);
  }
  // A journal that cannot be read and a helper that is missing are stops too.
  const noHelper = await deltaModule.applyWithOutcome(repo.git, { ...options, custody: NO_HELPER });
  assert.equal(noHelper.stop.reason, "planning_ref_capability_missing");
  const broken = await deltaModule.applyWithOutcome(repo.git, { ...options, recipes: journalAt(failingFs("read", "EACCES"), path.dirname(repo.indexFile) + "/recipes") });
  assert.equal(broken.stop.reason, "environment_failure");
  assert.equal(broken.stop.cause, "journal_io");
  // A recipe that cannot vouch is receipt_missing, by its own cause.
  const recipes = memoryRecipes();
  await applyDeltaWith(repo.git, { ...options, recipes, custody: dyingBeforeCommit }).catch(() => {});
  const key = keyOf(options.delta, options.ref, options.base);
  recipes.held.set(key, { ...(await recipes.load(key)), delta_digest: "f".repeat(64) });
  const cannotVouch = await deltaModule.applyWithOutcome(repo.git, { ...options, recipes });
  assert.equal(cannotVouch.stop.reason, "receipt_missing");
  assert.equal(cannotVouch.stop.cause, "recipe");
  for (const [name, { before }] of Object.entries(deltaModule.APPLY_STOPS)) {
    if (before !== null && name !== "dirty_worktree") assert.ok(covered.has(name), `${name} has no scenario`);
  }
});

const NO_HELPER = Object.freeze({});

test("a request the host cannot form is a host invariant, `custody_request_invalid`: it is no stop, no park reason and no vocabulary entry, and a step body does not swallow it (R9-9, ADR-109)", async (t) => {
  const { repo, options } = await refusalScenarios(t);
  const error = await deltaModule.applyWithOutcome(repo.git, { ...options, author: { name: "x" }, recipes: memoryRecipes() }).then(() => null, (thrown) => thrown);
  assert.equal(error?.code, "custody_request_invalid");
  assert.equal(deltaModule.APPLY_STOP_REASONS.includes("custody_request_invalid"), false);
  assert.equal(repo.custody.requests.length, 0);
  const graph = graphOf();
  assert.equal(graph.recovery.some((row) => row.reason === "custody_request_invalid"), false);
  assert.equal(graph.guards.some((guard) => guard.park_reason === "custody_request_invalid"), false);
  const vocabulary = JSON.parse(readFileSync(path.join(ROOT, "resources/refusal-vocabulary/refusal-vocabulary.v1.json"), "utf8"));
  assert.equal(vocabulary.park_reasons.some((reason) => reason.code === "custody_request_invalid"), false);
});

test("a result the apply returns whose proof fails is receipt_missing, by the contract's name as its cause; movement outranks content (R9-3, ADR-109)", async (t) => {
  const { git, ref, base, indexFile, custody, d } = await seeded(t);
  const other = (await git(["commit-tree", base.tree_oid, "-p", base.commit_oid, "-m", "foreign"])).stdout.trim();
  // The helper is asked, and the ref has moved under it: git refuses the swap and reports what the ref holds.
  const racing = { advance_staging: async (request) => { await git(["update-ref", "-m", "someone", ref, other]); return custody.advance_staging(request); } };
  const foreign = await deltaModule.applyWithOutcome(git, { custody: racing, recipes: journals.get(git), author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" });
  assert.equal(foreign.result.applied, false);
  assert.equal(foreign.receipt.phase, "prepared");
  assert.equal(foreign.stop.reason, "receipt_missing");
  assert.equal(foreign.stop.cause, "foreign_ref_movement");
  assert.deepEqual([...foreign.stop.causes], ["foreign_ref_movement"]);
  // The resume re-enters the step and is refused by the movement checks before the helper is asked: it is no retry.
  const asked = custody.requests.length;
  const again = await deltaModule.applyWithOutcome(git, { custody, recipes: journals.get(git), author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" });
  assert.equal(again.stop.reason, "receipt_missing");
  assert.equal(again.stop.cause, "movement");
  assert.equal(custody.requests.length, asked);
});

test("a ref deleted under the apply, and a reflog with more than one entry, are receipt_missing with their own causes (R9-3, ADR-109)", async (t) => {
  const deleting = await seeded(t);
  const deletingCustody = { advance_staging: async (request) => { await deleting.git(["update-ref", "-d", deleting.ref]); return deleting.custody.advance_staging(request); } };
  const gone = await deltaModule.applyWithOutcome(deleting.git, { custody: deletingCustody, recipes: journals.get(deleting.git), author: AUTHOR, delta: deleting.d, realpath, ref: deleting.ref, base: deleting.base, indexFile: deleting.indexFile, message: "T-1" });
  assert.equal(gone.stop.reason, "receipt_missing");
  assert.equal(gone.stop.cause, "foreign_ref_movement");
  assert.deepEqual([...gone.stop.causes].sort(), ["foreign_ref_movement", "indeterminate_post_state", "reflog_ambiguous"]);

  const moving = await seeded(t);
  const away = (await moving.git(["commit-tree", moving.base.tree_oid, "-p", moving.base.commit_oid, "-m", "away"])).stdout.trim();
  // The helper commits, and the ref then goes away and comes back under the helper's own message: at the commit, with three entries.
  const wandering = {
    advance_staging: async (request) => {
      const answer = await moving.custody.advance_staging(request);
      await moving.git(["update-ref", "-m", "x", moving.ref, away]);
      await moving.git(["update-ref", "-m", `autosk-flow staging ${request.owner_operation_id}`, moving.ref, request.ref_updates[0].new_oid]);
      return answer;
    },
  };
  const ambiguous = await deltaModule.applyWithOutcome(moving.git, { custody: wandering, recipes: journals.get(moving.git), author: AUTHOR, delta: moving.d, realpath, ref: moving.ref, base: moving.base, indexFile: moving.indexFile, message: "T-1" });
  assert.equal(ambiguous.result.applied, true);
  assert.equal(ambiguous.receipt.phase, "prepared");
  assert.equal(ambiguous.stop.reason, "receipt_missing");
  assert.equal(ambiguous.stop.cause, "reflog_ambiguous");
  // A resume recovers the same commit from the recipe and asks nothing: the same stop, never a second request.
  const asked = moving.custody.requests.length;
  const resumed = await deltaModule.applyWithOutcome(moving.git, { custody: moving.custody, recipes: journals.get(moving.git), author: AUTHOR, delta: moving.d, realpath, ref: moving.ref, base: moving.base, indexFile: moving.indexFile, message: "T-1" });
  assert.equal(resumed.stop.cause, "reflog_ambiguous");
  assert.equal(moving.custody.requests.length, asked);
});

test("the receipt's own errors map to a stop by the map's `after` column, and an apply with no error has none (R9-3, ADR-109)", () => {
  const receipt = (...reasons) => ({ errors: reasons.map((reason) => ({ reason })) });
  assert.equal(deltaModule.applyOutcome(receipt()), null);
  for (const [reason, cause] of [
    ["foreign_ref_movement", "foreign_ref_movement"],
    ["indeterminate_post_state", "indeterminate_post_state"],
    ["reflog_ambiguous", "reflog_ambiguous"],
    ["unreviewed_bytes", "unreviewed_bytes"],
    ["containment_mismatch", "containment_mismatch"],
    ["scope_violation", "scope_violation"],
  ]) {
    const stopped = deltaModule.applyOutcome(receipt(reason));
    assert.equal(stopped.reason, "receipt_missing", reason);
    assert.equal(stopped.cause, cause, reason);
  }
  // Movement is named before content, whatever order the proof lists them in.
  assert.equal(deltaModule.applyOutcome(receipt("unreviewed_bytes", "reflog_ambiguous", "containment_mismatch")).cause, "reflog_ambiguous");
  assert.equal(deltaModule.applyOutcome(receipt("containment_mismatch", "unreviewed_bytes")).cause, "containment_mismatch");
  // A name the map does not know is still a stop: an error in a receipt never leaves the apply unnamed.
  assert.equal(deltaModule.applyOutcome(receipt("something_new")).reason, "receipt_missing");
});

test("a dirty worktree is no refusal of the apply: nothing under src/ calls worktreeErrors or resumeFrom, and the apply runs in a temporary index (R9-3, ADR-109)", async (t) => {
  const { git, ref, base, indexFile, custody, d } = await seeded(t);
  const result = await applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1", worktree: { dirty: true, linked: true, autostash: true, untracked: [], ignored: [] } });
  assert.equal(result.applied, true);
  for (const name of ["worktreeErrors", "resumeFrom"]) {
    for (const file of readdirSync(path.join(ROOT, "src/host")).filter((entry) => entry.endsWith(".mjs") && entry !== "approved-delta.mjs")) {
      assert.doesNotMatch(readFileSync(path.join(ROOT, "src/host", file), "utf8"), new RegExp(`\\b${name}\\s*[(,}]`, "u"), `${file} calls ${name}`);
    }
  }
  assert.equal(deltaModule.APPLY_STOPS.dirty_worktree.before, null);
});

test("approved-delta §9 carries the table of the map, row for row, and says whether a resume re-enters the step (R9-3, ADR-109)", () => {
  const contract = readFileSync(path.join(ROOT, "docs/contracts/approved-delta.md"), "utf8");
  const section = contract.slice(contract.indexOf("## 9. Park reasons"), contract.indexOf("## 10."));
  const rows = section.split("\n").filter((line) => /^\| `/u.test(line)).map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  assert.equal(rows.length, Object.keys(deltaModule.APPLY_STOPS).length);
  for (const cells of rows) {
    const name = cells[0].replaceAll("`", "");
    const entry = deltaModule.APPLY_STOPS[name];
    assert.ok(entry, `${name} is not in the map`);
    // A cell that names a stop opens with it; one that opens with a dash names none.
    const stops = (cell) => { const named = /^`([a-z_]+)`/u.exec(cell)?.[1]; return named === undefined ? [] : [named]; };
    assert.deepEqual(stops(cells[1]), entry.before === null ? [] : [entry.before], `${name} before`);
    assert.deepEqual(stops(cells[2]), entry.after === null ? [] : [entry.after], `${name} after`);
    assert.match(cells[3], /re-enters|not raised/u, `${name}: the row does not say whether a resume re-enters the step`);
  }
});

test("an apply whose journal's directory cannot be synced does not ask the helper: environment_failure, cause journal_io, the errno (#280 carry C)", async (t) => {
  const { git, ref, base, indexFile, custody, recipesDir, d } = await seeded(t);
  for (const errno of ["EISDIR", "EPERM", "EINVAL", "ENOTSUP"]) {
    const noSync = { ...nodeFs, open: async (file, flags, mode) => {
      if (file === recipesDir) throw Object.assign(new Error(`${errno}: no directory handle`), { code: errno });
      return nodeFs.open(file, flags, mode);
    } };
    const outcome = await deltaModule.applyWithOutcome(git, { custody, recipes: journalAt(noSync, recipesDir), author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" });
    assert.equal(outcome.stop.reason, "environment_failure", errno);
    assert.equal(outcome.stop.cause, "journal_io", errno);
  }
  // The helper was never asked, so a crash after its commit cannot strand a recipe no one knows to be durable.
  assert.equal(custody.requests.length, 0);
  assert.equal(await readRef(git, ref), base.commit_oid);
  // The resume, on a filesystem that syncs, applies.
  assert.equal((await applyDelta(git, { custody, delta: d, realpath, ref, base, indexFile, message: "T-1" })).applied, true);
});

// --- debt 13a, review-fix round ------------------------------------------------------------

test("a stop for the helper carries what it said: no helper, a capability refusal, an answer that is none, a client that fails (review M1, M3)", async (t) => {
  const { git, ref, base, indexFile, custody, d } = await seeded(t);
  const options = { recipes: journals.get(git), author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" };
  const answered = (reason) => ({ advance_staging: async (request) => ({
    action: request.action,
    status: "not_applied",
    not_applied_reason: reason,
    ref_observations: request.ref_updates.map((update) => ({ operation: update.operation, ref: update.ref, expected_old_oid: update.expected_old_oid, requested_new_oid: update.new_oid, observed_old_oid: update.expected_old_oid, observed_new_oid: update.expected_old_oid })),
  }) });
  for (const [what, helper, cause] of [
    ["no helper", {}, "no_helper"],
    ["packed refs", answered("packed_refs_drift"), "packed_refs_drift"],
    ["authorization", answered("authorization_invalid"), "authorization_invalid"],
    ["garbage", { advance_staging: async () => ({ status: "committed" }) }, "unanswered"],
    ["a socket reset", { advance_staging: async () => { throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); } }, "ECONNRESET"],
    ["a client with no code", { advance_staging: async () => { throw new Error("no code"); } }, "client_failed"],
  ]) {
    const outcome = await deltaModule.applyWithOutcome(git, { ...options, custody: helper });
    assert.equal(outcome.stop?.reason, "planning_ref_capability_missing", what);
    assert.equal(outcome.stop.cause, cause, what);
  }
  assert.equal(custody.requests.length, 0);
  assert.equal(await readRef(git, ref), base.commit_oid);
});

test("a helper that dies after it committed is a stop too, and the resume recovers the commit and asks nothing (review M3)", async (t) => {
  const { git, ref, base, indexFile, custody, d } = await seeded(t);
  const options = { recipes: journals.get(git), author: AUTHOR, delta: d, realpath, ref, base, indexFile, message: "T-1" };
  const timingOut = { advance_staging: async (request) => { await custody.advance_staging(request); throw Object.assign(new Error("late"), { code: "ETIMEDOUT" }); } };
  const first = await deltaModule.applyWithOutcome(git, { ...options, custody: timingOut });
  assert.equal(first.stop.reason, "planning_ref_capability_missing");
  assert.equal(first.stop.cause, "ETIMEDOUT");
  const asked = custody.requests.length;
  const resumed = await deltaModule.applyWithOutcome(git, { ...options, custody });
  assert.equal(resumed.stop, null);
  assert.equal(resumed.result.recovered_from_recipe, true);
  assert.equal(custody.requests.length, asked, "the resume asked the helper again");
});

test("a dependency the apply was handed that fails is an environment failure with the errno as its cause, never a raw error thrown into the daemon (review M3)", async (t) => {
  const { git, ref, base, indexFile, custody, d } = await seeded(t);
  const options = { custody, recipes: journals.get(git), author: AUTHOR, delta: d, ref, base, indexFile, message: "T-1" };
  for (const [what, extra, cause] of [
    ["realpath ENOENT", { realpath: async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } }, "ENOENT"],
    ["realpath EACCES", { realpath: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } }, "EACCES"],
  ]) {
    const outcome = await deltaModule.applyWithOutcome(git, { ...options, realpath, ...extra });
    assert.equal(outcome.stop?.reason, "environment_failure", what);
    assert.equal(outcome.stop.cause, cause, what);
  }
  const throwing = async (args, opts) => {
    if (args[0] === "write-tree") throw Object.assign(new Error("spawn git EAGAIN"), { code: "EAGAIN" });
    return git(args, opts);
  };
  const spawned = await deltaModule.applyWithOutcome(throwing, { ...options, realpath });
  assert.equal(spawned.stop?.reason, "environment_failure");
  assert.equal(spawned.stop.cause, "EAGAIN");
  // A journal that fails with a raw error is the journal's I/O.
  const raw = { load: async () => { throw Object.assign(new Error("io"), { code: "EIO" }); }, save: async () => {} };
  const journal = await deltaModule.applyWithOutcome(git, { ...options, realpath, recipes: raw });
  assert.equal(journal.stop?.reason, "environment_failure");
  assert.equal(journal.stop.cause, "journal_io");
  assert.equal(custody.requests.length, 0);
});

test("a delta that cannot be assembled as approved is delta_stale with a cause, not an environment failure: a missing blob, no mode (P2)", async (t) => {
  const { git, ref, base, indexFile, custody, d } = await seeded(t);
  const options = { custody, recipes: journals.get(git), author: AUTHOR, ref, base, indexFile, message: "T-1", realpath };
  const missing = delta(base, [{ path: "src/a.ts", status: "A", new_blob: "0".repeat(40), new_mode: "100644" }]);
  const noMode = delta(base, [{ path: "src/a.ts", status: "A", new_blob: d.entries[0].new_blob }]);
  for (const [what, bad] of [["a blob that is not in the repository", missing], ["an entry with no mode", noMode]]) {
    const outcome = await deltaModule.applyWithOutcome(git, { ...options, delta: bad });
    assert.equal(outcome.stop?.reason, "delta_stale", what);
    assert.equal(outcome.stop.cause, "containment_mismatch", what);
  }
  assert.equal(custody.requests.length, 0);
  assert.equal(await readRef(git, ref), base.commit_oid);
});

test("a submodule entry integrates: the proof reads a gitlink as the entry it is (P1)", async (t) => {
  const { git, ref, base, indexFile, custody } = await repository(t);
  // A gitlink names a commit of another repository, which need not exist here.
  const linked = delta(base, [{ path: "src/mod", status: "A", new_blob: "1".repeat(40), new_mode: "160000" }]);
  const result = await applyDelta(git, { custody, delta: linked, realpath, ref, base, indexFile, message: "T-1" });
  assert.equal(result.applied, true);
  assert.deepEqual([...result.applied_entries], [{ path: "src/mod", new_blob: "1".repeat(40), new_mode: "160000" }]);
  assert.deepEqual(integrationProof(linked, result), []);
  assert.equal(integrationReceipt(linked, result).phase, "ref_advanced");
  const outcome = deltaModule.applyOutcome(integrationReceipt(linked, result));
  assert.equal(outcome, null);
});

test("what a dependency's failure says: its message, its errno as the cause and the dependency named, and a failure that has neither (review M3)", async (t) => {
  const { git, ref, base, indexFile, custody, d } = await seeded(t);
  const options = { custody, recipes: journals.get(git), author: AUTHOR, delta: d, ref, base, indexFile, message: "T-1" };
  const caught = (promise) => promise.then(() => null, (thrown) => thrown);
  const named = await caught(applyDeltaWith(git, { ...options, realpath: async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } }));
  assert.equal(named.code, "environment_failure");
  assert.equal(named.message, "The apply's realpath failed: gone");
  assert.deepEqual({ ...named.details }, { cause: "ENOENT", errno: "ENOENT", dependency: "realpath" });
  const bare = await caught(applyDeltaWith(git, { ...options, realpath: async () => { throw {}; } }));
  assert.equal(bare.message, "The apply's realpath failed");
  assert.deepEqual({ ...bare.details }, { cause: "dependency_failed", errno: null, dependency: "realpath" });
  const journal = await caught(applyDeltaWith(git, { ...options, realpath, recipes: { load: async () => { throw Object.assign(new Error("io"), { code: "EIO" }); }, save: async () => {} } }));
  assert.equal(journal.message, "The apply's journal failed: io");
  assert.deepEqual({ ...journal.details }, { cause: "journal_io", errno: "EIO", dependency: "journal" });
  const runner = await caught(applyDeltaWith(async () => { throw Object.assign(new Error("spawn git EAGAIN"), { code: "EAGAIN" }); }, { ...options, realpath }));
  assert.equal(runner.message, "The apply's git runner failed: spawn git EAGAIN");
  assert.equal(runner.details.dependency, "git runner");
  // A refusal of ours that a dependency raises passes through as it is.
  const ours = await caught(applyDeltaWith(git, { ...options, realpath: async () => { throw new FlowError("receipt_missing", "ours", { cause: "journal" }); } }));
  assert.equal(ours.code, "receipt_missing");
  assert.equal(ours.message, "ours");
});
