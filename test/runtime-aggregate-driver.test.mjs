/**
 * Tests for aggregate verification on the exact staging tree (issue #9 driver).
 *
 * Real worktrees and real commands. The two facts being defended are that the
 * checks ran on the tree the record names, and that a machine which could not
 * run them is never recorded as a product that failed them.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { aggregateBinding, aggregateErrors } from "../src/host/epic-staging.mjs";
import {
  checkoutStaging,
  checksDigest,
  removeWorktree,
  runCheck,
  verifyAggregate,
} from "../src/host/aggregate-driver.mjs";

const execFileAsync = promisify(execFile);
const code = (name) => (error) => error.code === name;

const gitIn = (root) => async (args, { cwd, env = {} } = {}) =>
  execFileAsync("git", args, {
    cwd: cwd ?? root,
    env: {
      PATH: process.env.PATH,
      HOME: root,
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

/** The injected runner: a command that could not start reports `code: null`. */
const runner = async (command, args, { cwd, env }) =>
  execFileAsync(command, args, { cwd, env: { PATH: process.env.PATH, ...env } }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error) => ({
      code: error.code === "ENOENT" ? null : (typeof error.code === "number" ? error.code : 1),
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error),
    }),
  );

async function staging(t, { checkContent }) {
  const root = await mkdtemp(path.join(tmpdir(), "autosk-aggregate-"));
  t.after(async () => {
    await execFileAsync("chmod", ["-R", "u+w", root]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const git = gitIn(root);
  await git(["init", "--quiet", "--initial-branch=main"]);
  await writeFile(path.join(root, "check.sh"), checkContent, { mode: 0o755 });
  await git(["add", "check.sh"]);
  await git(["commit", "--quiet", "-m", "staged"]);
  const staging_commit_oid = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const staging_tree_oid = (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim();
  const state = {
    project_identity: `sha256:${"0".repeat(58)}`,
    epic_id: "e-1",
    staging_commit_oid,
    staging_tree_oid,
    receipts: [{ ticket_id: "T-1" }],
    aggregate: { verification_config_digest: "c".repeat(64), instruction_lock_digest: "d".repeat(64) },
  };
  return { root, git, state, dir: path.join(root, "verify-worktree") };
}

test("the checks run on the exact staging tree, and the record is bound to it", async (t) => {
  const { git, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  const checks = [{ id: "unit", command: "./check.sh" }];

  const aggregate = await verifyAggregate({ git, run: runner, state, checks, dir });
  assert.equal(aggregate.outcome, "pass");
  assert.equal(aggregate.environment_outcome, "ok");
  assert.equal(aggregate.staging_commit_oid, state.staging_commit_oid);
  // Bound by the module, so a PASS cannot be carried to another tree.
  assert.equal(aggregate.binding, aggregateBinding({ ...state, aggregate }));
  assert.deepEqual(aggregateErrors({ ...state, aggregate }), []);
  const elsewhere = { ...state, staging_tree_oid: "f".repeat(40) };
  assert.ok(
    aggregateErrors({ ...elsewhere, aggregate }).some((error) => error.reason === "aggregate_binding_void"),
  );
  // And the throwaway worktree is gone.
  assert.equal(aggregate.worktree_removed, true);
  assert.equal((await git(["worktree", "list"])).stdout.includes("verify-worktree"), false);
});

test("a check that ran and failed is a product failure", async (t) => {
  const { git, state, dir } = await staging(t, { checkContent: "#!/bin/sh\necho 'assertion failed' >&2\nexit 3\n" });
  const aggregate = await verifyAggregate({
    git,
    run: runner,
    state,
    checks: [{ id: "unit", command: "./check.sh" }],
    dir,
  });
  assert.equal(aggregate.outcome, "fail");
  assert.equal(aggregate.environment_outcome, "ok");
  assert.equal(aggregate.results[0].exit_code, 3);
  assert.ok(aggregateErrors({ ...state, aggregate }).some((error) => error.reason === "aggregate_failed"));
});

test("a machine that could not run the checks is not a product that failed them", async (t) => {
  const { git, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  const aggregate = await verifyAggregate({
    git,
    run: runner,
    state,
    checks: [{ id: "unit", command: "./there-is-no-such-tool" }, { id: "later", command: "./check.sh" }],
    dir,
  });
  assert.equal(aggregate.environment_outcome, "environment_failure");
  // Not `fail`: collapsing the two would make "the tests failed"
  // indistinguishable from "the machine could not run them".
  assert.equal(aggregate.outcome, "indeterminate");
  // The run stopped there: the later check would have reported on a machine
  // already known not to be running them.
  assert.equal(aggregate.results.length, 1);
  const errors = aggregateErrors({ ...state, aggregate });
  assert.ok(errors.some((error) => error.reason === "environment_failure"));
  assert.ok(!errors.some((error) => error.reason === "aggregate_failed"));
});

test("a worktree that is not at the staging commit is refused before anything runs", async (t) => {
  const { git, root, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  await writeFile(path.join(root, "drift.txt"), "later\n");
  await git(["add", "drift.txt"]);
  await git(["commit", "--quiet", "-m", "drift"]);
  const moved = (await git(["rev-parse", "HEAD"])).stdout.trim();

  // A verification of the wrong tree is worse than no verification, because it
  // produces a PASS.
  await assert.rejects(
    () => verifyAggregate({
      git,
      run: runner,
      state: { ...state, staging_commit_oid: moved },
      checks: [{ id: "unit", command: "./check.sh" }],
      dir,
    }),
    code("aggregate_binding_void"),
  );
  // Refused, and nothing left behind: the next run does not inherit the
  // worktree this one refused to work in.
  assert.equal((await git(["worktree", "list"])).stdout.includes("verify-worktree"), false);
});

test("the checkout is read back, and a detached worktree carries no second name", async (t) => {
  const { git, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  const checkout = await checkoutStaging(git, { dir, commit: state.staging_commit_oid });
  assert.equal(checkout.tree_oid, state.staging_tree_oid);
  const head = await git(["symbolic-ref", "-q", "HEAD"], { cwd: dir });
  assert.notEqual(head.code, 0, "the worktree HEAD is detached");
  const removed = await removeWorktree(git, dir);
  assert.equal(removed.removed, true);
  // Removing one that is not there says so rather than reporting success.
  const again = await removeWorktree(git, dir);
  assert.equal(again.removed, false);
  assert.ok(again.detail.length > 0);
});

test("a staging commit the repository does not have is an environment failure", async (t) => {
  const { git, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  // git cannot check out an object it does not have, and that is a statement
  // about the machine rather than about the product.
  await assert.rejects(
    () => verifyAggregate({
      git,
      run: runner,
      state: { ...state, staging_commit_oid: "0".repeat(40) },
      checks: [{ id: "unit", command: "./check.sh" }],
      dir,
    }),
    code("environment_failure"),
  );
});

test("a checkout that is not where it was asked to be is refused, and cleaned up", async (t) => {
  const { git, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  const calls = [];
  // The read-back exists for a checkout that lands somewhere else. Real git
  // does not do that, which is exactly why the dependency is injected.
  const lying = async (args, options) => {
    calls.push(args.join(" "));
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      return { code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
    }
    return git(args, options);
  };
  await assert.rejects(
    () => checkoutStaging(lying, { dir, commit: state.staging_commit_oid }),
    code("aggregate_binding_void"),
  );
  assert.ok(calls.some((call) => call.startsWith("worktree remove")), calls.join(" | "));
  assert.equal((await git(["worktree", "list"])).stdout.includes("verify-worktree"), false);
});

test("a command that could not start and one that exited non-zero are different outcomes", async (t) => {
  const { root } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  const missing = await runCheck(runner, { id: "gone", command: "./there-is-no-such-tool" }, { cwd: root, env: {} });
  assert.equal(missing.outcome, "environment_failure");
  const failed = await runCheck(runner, { id: "false", command: "/bin/sh", args: ["-c", "exit 1"] }, { cwd: root, env: {} });
  assert.equal(failed.outcome, "fail");
  const passed = await runCheck(runner, { id: "true", command: "/bin/sh", args: ["-c", "exit 0"] }, { cwd: root, env: {} });
  assert.equal(passed.outcome, "pass");
});

test("the checks that ran are what the configuration digest is over", () => {
  const digest = checksDigest([{ id: "unit", command: "npm", args: ["test"] }]);
  assert.notEqual(digest, checksDigest([{ id: "unit", command: "npm", args: ["test", "--fast"] }]));
  assert.notEqual(digest, checksDigest([{ id: "other", command: "npm", args: ["test"] }]));
  assert.equal(digest, checksDigest([{ id: "unit", command: "npm", args: ["test"] }]));
});
