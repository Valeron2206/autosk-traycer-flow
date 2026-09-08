/**
 * Tests for building the execution base tree (issue #7 driver).
 *
 * The base is what a Ticket is implemented and verified against, so the whole
 * question here is whether the tree that comes out is the recorded one — the
 * same predecessors, in the recorded order, producing the same OID every time.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  baseAdmission,
  baseDigest,
  ensureComposition,
  overlapErrors,
  recordComposition,
} from "../src/host/execution-base.mjs";
import { composeBase, objectsPresent, recomposedTree } from "../src/host/execution-base-driver.mjs";

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

const identity = {
  name: "autosk-flow",
  email: "flow@autosk.invalid",
  date: "2026-01-01T00:00:00+00:00",
  message: "autosk-flow execution base",
};

async function repository(t) {
  const root = await mkdtemp(path.join(tmpdir(), "autosk-base-"));
  const indexRoot = await mkdtemp(path.join(tmpdir(), "autosk-base-index-"));
  t.after(async () => {
    await execFileAsync("chmod", ["-R", "u+w", root]).catch(() => {});
    await rm(root, { recursive: true, force: true });
    await rm(indexRoot, { recursive: true, force: true });
  });
  const git = gitIn(root);
  await git(["init", "--quiet", "--initial-branch=main"]);
  await writeFile(path.join(root, "plan.md"), "the plan\n");
  await git(["add", "plan.md"]);
  await git(["commit", "--quiet", "-m", "planning"]);
  const planningHead = (await git(["rev-parse", "HEAD"])).stdout.trim();
  return { root, git, planningHead, indexFile: path.join(indexRoot, "base.index") };
}

async function blob(git, root, content) {
  const file = path.join(root, `.blob-${Math.random().toString(36).slice(2)}`);
  await writeFile(file, content);
  const oid = (await git(["hash-object", "-w", file])).stdout.trim();
  await rm(file);
  return oid;
}

test("the base is the recorded order replayed, and it recomputes to the same tree", async (t) => {
  const { git, root, planningHead, indexFile } = await repository(t);
  const one = await blob(git, root, "one\n");
  const two = await blob(git, root, "two\n");
  const predecessors = [
    { ticket_id: "T-1", entries: [{ path: "src/one.ts", status: "A", new_blob: one, new_mode: "100644" }] },
    { ticket_id: "T-2", entries: [{ path: "src/two.ts", status: "A", new_blob: two, new_mode: "100644" }] },
  ];
  const order = ["T-1", "T-2"];

  const built = await composeBase(git, { planningHead, predecessors, order, indexFile, realpath, identity });
  assert.equal(built.ok, true);
  // Built twice, byte for byte: without that, a retry would produce a different
  // base and the recorded digest would mean nothing.
  const again = await composeBase(git, { planningHead, predecessors, order, indexFile, realpath, identity });
  assert.equal(again.commit_oid, built.commit_oid);
  assert.equal(await recomposedTree(git, { planningHead, predecessors, order, indexFile, realpath, identity }), built.tree_oid);

  const listed = (await git(["ls-tree", "-r", "--name-only", built.tree_oid])).stdout.split("\n");
  assert.deepEqual(listed.filter(Boolean).sort(), ["plan.md", "src/one.ts", "src/two.ts"]);

  // The identity and both dates are the given ones, in the object. Git records
  // them to the second, so two compositions a moment apart would otherwise
  // agree by accident and the reproducibility above would prove nothing.
  const raw = (await git(["cat-file", "commit", built.commit_oid])).stdout;
  const epoch = String(Math.floor(Date.parse(identity.date) / 1000));
  assert.ok(raw.includes(`author autosk-flow <flow@autosk.invalid> ${epoch} `), raw);
  assert.ok(raw.includes(`committer autosk-flow <flow@autosk.invalid> ${epoch} `), raw);

  const base = {
    ticket_id: "T-3",
    planning_head: planningHead,
    composition_order: order,
    predecessors,
    tree_oid: built.tree_oid,
    composition_commit_oid: built.commit_oid,
  };
  base.digest = baseDigest(base);
  assert.deepEqual({ ...recordComposition(base, built) }, {
    ticket_id: "T-3",
    digest: base.digest,
    composition_commit_oid: built.commit_oid,
    tree_oid: built.tree_oid,
  });
});

test("two orders of the same predecessors are two bases, and the digest says so", async (t) => {
  const { git, root, planningHead, indexFile } = await repository(t);
  const first = await blob(git, root, "first\n");
  const second = await blob(git, root, "second\n");
  // A diamond where both predecessors touch one path: the tree depends on the
  // order, which is why the order is recorded rather than recomputed.
  const predecessors = [
    { ticket_id: "T-1", entries: [{ path: "src/shared.ts", status: "A", new_blob: first, new_mode: "100644" }] },
    { ticket_id: "T-2", entries: [{ path: "src/shared.ts", status: "A", new_blob: second, new_mode: "100644" }] },
  ];
  assert.ok(overlapErrors(predecessors).some((error) => error.reason === "incompatible_overlapping_deltas"));

  const forward = await composeBase(git, { planningHead, predecessors, order: ["T-1", "T-2"], indexFile, realpath, identity });
  const backward = await composeBase(git, {
    planningHead,
    predecessors: [predecessors[1], predecessors[0]],
    order: ["T-2", "T-1"],
    indexFile,
    realpath,
    identity,
  });
  // Both refuse, and neither silently picks a winner: the loser's PASS was
  // about content the base would not contain.
  assert.equal(forward.ok, false);
  assert.equal(forward.reason, "incompatible_overlapping_deltas");
  assert.equal(backward.ok, false);
});

test("the same path written with the same bytes twice is one change made twice", async (t) => {
  const { git, root, planningHead, indexFile } = await repository(t);
  const shared = await blob(git, root, "shared\n");
  const predecessors = [
    { ticket_id: "T-1", entries: [{ path: "src/shared.ts", status: "A", new_blob: shared, new_mode: "100644" }] },
    { ticket_id: "T-2", entries: [{ path: "src/shared.ts", status: "A", new_blob: shared, new_mode: "100644" }] },
  ];
  assert.deepEqual(overlapErrors(predecessors), []);
  const built = await composeBase(git, { planningHead, predecessors, order: ["T-1", "T-2"], indexFile, realpath, identity });
  assert.equal(built.ok, true);
});

test("deletions and renames compose in order", async (t) => {
  const { git, root, planningHead, indexFile } = await repository(t);
  const moved = await blob(git, root, "moved\n");
  const predecessors = [
    { ticket_id: "T-1", entries: [{ path: "src/old.ts", status: "A", new_blob: moved, new_mode: "100644" }] },
    {
      ticket_id: "T-2",
      entries: [{
        path: "src/new.ts",
        from_path: "src/old.ts",
        status: "R",
        old_blob: moved,
        new_blob: moved,
        old_mode: "100644",
        new_mode: "100644",
      }],
    },
    { ticket_id: "T-3", entries: [{ path: "plan.md", status: "D", old_blob: "x", old_mode: "100644" }] },
  ];
  const built = await composeBase(git, {
    planningHead,
    predecessors,
    order: ["T-1", "T-2", "T-3"],
    indexFile,
    realpath,
    identity,
  });
  const listed = (await git(["ls-tree", "-r", "--name-only", built.tree_oid])).stdout.split("\n").filter(Boolean);
  assert.deepEqual(listed, ["src/new.ts"]);
});

test("an order naming a predecessor nobody supplied is a missing binding", async (t) => {
  const { git, root, planningHead, indexFile } = await repository(t);
  const one = await blob(git, root, "one\n");
  const predecessors = [
    { ticket_id: "T-1", entries: [{ path: "src/one.ts", status: "A", new_blob: one, new_mode: "100644" }] },
  ];
  await assert.rejects(
    () => composeBase(git, { planningHead, predecessors, order: ["T-1", "T-9"], indexFile, realpath, identity }),
    code("missing_predecessor_binding"),
  );
});

test("a composition that could not be built is reported as one, not as another base", async (t) => {
  const { git, planningHead, indexFile } = await repository(t);
  const predecessors = [
    { ticket_id: "T-1", entries: [{ path: "src/a.ts", status: "A", new_blob: "0".repeat(40), new_mode: "100644" }] },
  ];
  const built = await composeBase(git, { planningHead, predecessors, order: ["T-1"], indexFile, realpath, identity });
  assert.equal(built.ok, false);
  assert.equal(built.reason, "composition_failed");
  // And the module refuses to record it rather than recording a failure as a
  // base.
  const base = { ticket_id: "T-2", planning_head: planningHead, composition_order: ["T-1"], predecessors, tree_oid: "a".repeat(40) };
  base.digest = baseDigest(base);
  assert.throws(() => recordComposition(base, built), code("composition_failed"));
});

test("a composition that produced another tree is not the recorded base", async (t) => {
  const { git, root, planningHead, indexFile } = await repository(t);
  const one = await blob(git, root, "one\n");
  const predecessors = [
    { ticket_id: "T-1", entries: [{ path: "src/one.ts", status: "A", new_blob: one, new_mode: "100644" }] },
  ];
  const built = await composeBase(git, { planningHead, predecessors, order: ["T-1"], indexFile, realpath, identity });
  const base = {
    ticket_id: "T-2",
    planning_head: planningHead,
    composition_order: ["T-1"],
    predecessors,
    tree_oid: "b".repeat(40),
  };
  base.digest = baseDigest(base);
  assert.throws(() => recordComposition(base, built), code("base_mismatch"));
});

test("objects are asked for, so a pruned composition is not admitted", async (t) => {
  const { git, root, planningHead, indexFile } = await repository(t);
  const one = await blob(git, root, "one\n");
  const predecessors = [
    { ticket_id: "T-1", entries: [{ path: "src/one.ts", status: "A", new_blob: one, new_mode: "100644" }] },
  ];
  const built = await composeBase(git, { planningHead, predecessors, order: ["T-1"], indexFile, realpath, identity });
  const base = {
    ticket_id: "T-2",
    planning_head: planningHead,
    composition_order: ["T-1"],
    predecessors,
    tree_oid: built.tree_oid,
    composition_commit_oid: built.commit_oid,
  };
  base.digest = baseDigest(base);

  const objects = await objectsPresent(git, [built.commit_oid, built.tree_oid, "0".repeat(40)]);
  assert.equal(objects.has(built.commit_oid), true);
  assert.equal(objects.has("0".repeat(40)), false);
  const predecessorStates = { "T-1": { commit_oid: "c".repeat(40), delta_digest: "d".repeat(64), pass: "valid" } };
  assert.deepEqual(baseAdmission(base, { predecessorStates, objects }), []);

  // The object survived; recording it is the whole remaining step.
  assert.equal(ensureComposition(base, { objects, recordedMetadata: null }).action, "record_existing_object");
  const pruned = await objectsPresent(git, ["0".repeat(40)]);
  assert.equal(ensureComposition(base, { objects: pruned, recordedMetadata: null }).action, "create");
  assert.ok(
    baseAdmission(base, { predecessorStates, objects: pruned })
      .some((error) => error.reason === "unreachable_composition_object"),
  );
});

test("the temporary index may not sit inside the project", async (t) => {
  const { git, root, planningHead } = await repository(t);
  await assert.rejects(
    () => composeBase(git, {
      planningHead,
      predecessors: [],
      order: [],
      indexFile: path.join(root, "base.index"),
      realpath,
      identity,
    }),
    code("state_identity_collision"),
  );
});
