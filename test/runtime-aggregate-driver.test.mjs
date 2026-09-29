/**
 * Tests for aggregate verification on the exact staging tree (issue #9 driver).
 *
 * Real worktrees and real commands. The two facts being defended are that the
 * checks ran on the tree the record names, and that a machine which could not
 * run them is never recorded as a product that failed them.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { acceptanceErrors, aggregateErrors, aggregateRecordHash } from "../src/host/epic-staging.mjs";
import {
  checkoutStaging,
  checksDigest,
  removeWorktree,
  runCheck,
  verifyAggregate,
} from "../src/host/aggregate-driver.mjs";

const execFileAsync = promisify(execFile);
const code = (name) => (error) => error.code === name;

/**
 * The instruction lock in force, which the caller hands the driver: the
 * record binds it, and no state pins it (review of 11e, H1).
 */
const LOCK = "d".repeat(64);

const gitIn = (root) => (args, { cwd, env = {}, input } = {}) => {
  const pending = execFileAsync("git", args, {
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
  });
  pending.child.stdin.on("error", () => {});
  pending.child.stdin.end(input ?? "");
  return pending.then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error) => ({ code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) }),
  );
};

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

/**
 * A repository with one staged commit holding `check.sh`, the staging state
 * that names it, and the path its throwaway worktree is checked out at.
 */
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
    project_identity: `sha256:${"0".repeat(64)}`,
    epic_id: "e-1",
    staging_commit_oid,
    staging_tree_oid,
    receipts: [{ ticket_id: "T-1" }],
  };
  return { root, git, state, dir: path.join(root, "verify-worktree") };
}

test("the checks run on the exact staging tree, and the record is bound to it", async (t) => {
  const { git, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  const checks = [{ id: "unit", command: "./check.sh" }];

  const { aggregate, results, worktree_removed } = await verifyAggregate({ realpath, git, run: runner, state, checks, dir, instructionLockDigest: LOCK });
  assert.equal(aggregate.outcome, "pass");
  // A passing check carries no detail: attaching output to a pass would make
  // every green run look like it had something to say.
  assert.equal(results[0].detail, null);
  assert.equal(aggregate.environment_outcome, "ok");
  assert.equal(aggregate.staging_commit_oid, state.staging_commit_oid);
  // Bound by the module, so a PASS cannot be carried to another tree.
  assert.equal(aggregate.record_hash, aggregateRecordHash(state, aggregate));
  assert.deepEqual(aggregateErrors({ ...state, aggregate }), []);
  const elsewhere = { ...state, staging_tree_oid: "f".repeat(40) };
  assert.ok(
    aggregateErrors({ ...elsewhere, aggregate }).some((error) => error.reason === "aggregate_binding_void"),
  );
  // And the throwaway worktree is gone.
  assert.equal(worktree_removed, true);
  assert.equal((await git(["worktree", "list"])).stdout.includes("verify-worktree"), false);
});

test("a check that ran and failed is a product failure", async (t) => {
  const { git, state, dir } = await staging(t, { checkContent: "#!/bin/sh\necho 'assertion failed' >&2\nexit 3\n" });
  const { aggregate, results } = await verifyAggregate({ realpath,
    git,
    run: runner,
    state,
    checks: [{ id: "unit", command: "./check.sh" }],
    dir,
    instructionLockDigest: LOCK,
  });
  assert.equal(aggregate.outcome, "fail");
  assert.equal(aggregate.environment_outcome, "ok");
  assert.equal(results[0].exit_code, 3);
  // A failing check carries what it said; a passing one carries no detail at
  // all. `=== 0` decides which, and swapping it would attach a failure's output
  // to a pass and hide it on a failure.
  assert.ok(results[0].detail.length > 0);
  assert.ok(aggregateErrors({ ...state, aggregate }).some((error) => error.reason === "aggregate_failed"));
});

test("a machine that could not run the checks is not a product that failed them", async (t) => {
  const { git, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  const { aggregate, results } = await verifyAggregate({ realpath,
    git,
    run: runner,
    state,
    checks: [{ id: "unit", command: "./there-is-no-such-tool" }, { id: "later", command: "./check.sh" }],
    dir,
    instructionLockDigest: LOCK,
  });
  assert.equal(aggregate.environment_outcome, "environment_failure");
  // Not `fail`: collapsing the two would make "the tests failed"
  // indistinguishable from "the machine could not run them".
  assert.equal(aggregate.outcome, "indeterminate");
  // The run stopped there: the later check would have reported on a machine
  // already known not to be running them.
  assert.equal(results.length, 1);
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
    () => verifyAggregate({ realpath,
      git,
      run: runner,
      state: { ...state, staging_commit_oid: moved },
      checks: [{ id: "unit", command: "./check.sh" }],
      dir,
      instructionLockDigest: LOCK,
    }),
    code("aggregate_binding_void"),
  );
  // Refused, and nothing left behind: the next run does not inherit the
  // worktree this one refused to work in.
  assert.equal((await git(["worktree", "list"])).stdout.includes("verify-worktree"), false);
});

test("the checkout is read back, and a detached worktree carries no second name", async (t) => {
  const { git, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  const checkout = await checkoutStaging(git, { realpath, dir, commit: state.staging_commit_oid });
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
    () => verifyAggregate({ realpath,
      git,
      run: runner,
      state: { ...state, staging_commit_oid: "0".repeat(40) },
      checks: [{ id: "unit", command: "./check.sh" }],
      dir,
      instructionLockDigest: LOCK,
    }),
    code("environment_failure"),
  );
});

test("a checkout that is not where it was asked to be is refused, and cleaned up", async (t) => {
  // The read-back exists for a checkout that lands somewhere else. Real git
  // does not do that, which is exactly why the dependency is injected. The
  // repository's own record of its worktrees is what is read back (review of
  // 9b65ad3, M4), so that is where each lie is told: the new worktree at
  // another commit, and no new worktree at all.
  // Each lie is told in whichever porcelain the driver asked for: lines end
  // in a newline, or in NUL with `-z` (narrow re-review, Low 11). The third
  // lie is a new worktree at the staging commit that is not the directory the
  // checkout was asked into (narrow re-review, Low 11).
  const lies = {
    "at another commit": (listed, first, end) => listed.replace(new RegExp(`(${end}${end}worktree [^${end}]*${end}HEAD )[0-9a-f]+`, "u"), `$1${"a".repeat(40)}`),
    "not added": (listed, first) => first,
    "added somewhere else": (listed, first, end) => listed.replace(new RegExp(`(${end}${end}worktree [^${end}]*)`, "u"), "$1-elsewhere"),
  };
  for (const [name, lie] of Object.entries(lies)) {
    const { git, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
    const calls = [];
    let first = null;
    let added = false;
    const lying = async (args, options) => {
      calls.push(args.join(" "));
      const result = await git(args, options);
      if (args[0] === "worktree" && args[1] === "add") added = true;
      if (args[0] === "worktree" && args[1] === "list") {
        first ??= result.stdout;
        if (added) return { ...result, stdout: lie(result.stdout, first, args.includes("-z") ? "\0" : "\n") };
      }
      return result;
    };
    await assert.rejects(
      () => checkoutStaging(lying, { realpath, dir, commit: state.staging_commit_oid }),
      code("aggregate_binding_void"),
      name,
    );
    assert.ok(calls.some((call) => call.startsWith("worktree remove")), `${name}: ${calls.join(" | ")}`);
    assert.equal((await git(["worktree", "list"])).stdout.includes("verify-worktree"), false, name);
  }
});

test("a checkout whose directory name holds a newline is read back whole, from NUL-terminated porcelain (narrow re-review, Low 11)", async (t) => {
  const { git, state, root } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  // Line-based porcelain splits this name in two, and the read-back compares
  // the new worktree's path with the checkout's real path.
  const dir = path.join(root, "verify\nworktree");
  const asked = [];
  const recording = async (args, options) => {
    asked.push(args.join(" "));
    return git(args, options);
  };
  const checkout = await checkoutStaging(recording, { realpath, dir, commit: state.staging_commit_oid });
  assert.equal(checkout.commit, state.staging_commit_oid);
  assert.equal(checkout.tree_oid, state.staging_tree_oid);
  assert.ok(asked.filter((call) => call.startsWith("worktree list")).every((call) => call.split(" ").includes("-z")), asked.join(" | "));
  assert.equal((await removeWorktree(git, dir)).removed, true);
});

test("the checkout is read back from the repository's own records, never through the checkout, so a repository a model plants in it is never followed (review of 9b65ad3, M4)", async (t) => {
  const { git, root, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  // A repository a model could plant: a history of its own, whose HEAD is not
  // the staging commit.
  const planted = path.join(root, "planted");
  await mkdir(planted);
  const plantedGit = gitIn(planted);
  await plantedGit(["init", "--quiet", "--initial-branch=main"]);
  await writeFile(path.join(planted, "planted.txt"), "planted\n");
  await plantedGit(["add", "planted.txt"]);
  await plantedGit(["commit", "--quiet", "-m", "planted"]);
  const cwds = [];
  // The model plants the moment the checkout exists: the checkout's `.git`
  // becomes a gitfile naming the planted repository, which any Git command
  // discovering the repository from inside the checkout would follow.
  const planting = async (args, options = {}) => {
    cwds.push(options.cwd ?? null);
    const result = await git(args, options);
    if (args[0] === "worktree" && args[1] === "add") {
      await rm(path.join(dir, ".git"), { force: true });
      await writeFile(path.join(dir, ".git"), `gitdir: ${path.join(planted, ".git")}\n`);
    }
    return result;
  };
  const checkout = await checkoutStaging(planting, { realpath, dir, commit: state.staging_commit_oid });
  assert.equal(checkout.commit, state.staging_commit_oid);
  assert.equal(checkout.tree_oid, state.staging_tree_oid);
  // No Git command the driver ran started inside the checkout.
  const inside = cwds.filter((cwd) => cwd !== null && path.resolve(cwd).startsWith(path.resolve(dir)));
  assert.deepEqual(inside, []);
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
  // Review of 11e, H1: each check's full spec, not a tuple picked out of it —
  // a field the spec carries is part of it — in the order the run takes
  // them, and the environment the run hands every check.
  assert.notEqual(digest, checksDigest([{ id: "unit", command: "npm", args: ["test"], timeout_ms: 1000 }]));
  assert.notEqual(digest, checksDigest([{ id: "unit", command: "npm", args: ["test"] }], { CI: "1" }));
  const lint = { id: "lint", command: "npm", args: ["run", "lint"] };
  const unit = { id: "unit", command: "npm", args: ["test"] };
  assert.notEqual(checksDigest([unit, lint]), checksDigest([lint, unit]));
  // Absent args run as none, so they are the same configuration as empty ones.
  assert.equal(checksDigest([{ id: "unit", command: "./check.sh" }]), checksDigest([{ id: "unit", command: "./check.sh", args: [] }]));
  assert.match(digest, /^[a-f0-9]{64}$/u);
});

test("the outcomes this driver records are the staging record's outcomes", async () => {
  // R6-7: epic-staging §4, cond_428 and this driver record an environment
  // failure as outcome=indeterminate beside environment_outcome; the closed
  // schema must admit exactly that vocabulary, with one name per outcome.
  const { readFileSync } = await import("node:fs");
  const schema = JSON.parse(readFileSync(new URL("../resources/epic-staging/epic-staging.schema.json", import.meta.url), "utf8"));
  const { outcome, environment_outcome: environment } = schema.properties.aggregate.properties;
  assert.deepEqual([...outcome.enum].sort(), ["fail", "indeterminate", "pass"]);
  assert.deepEqual([...environment.enum].sort(), ["environment_failure", "ok"]);
  assert.ok(schema.properties.aggregate.required.includes("environment_outcome"));
});

// --- debt 11e: the record the driver writes is the schema's record (R7-17, ADR-099) ---

/** The staging schema's closed aggregate, as a schema of its own. */
const aggregateSchema = async () => {
  const { readFileSync } = await import("node:fs");
  const schema = JSON.parse(readFileSync(new URL("../resources/epic-staging/epic-staging.schema.json", import.meta.url), "utf8"));
  return { $schema: schema.$schema, ...schema.properties.aggregate };
};

/** A state whose Ticket ids are the schema's. */
const schemaState = (state) => ({ ...state, receipts: [{ ticket_id: "T01" }, { ticket_id: "T02" }] });

test("the record the driver writes is the staging schema's closed aggregate, and the run's evidence stays beside it (R7-17)", async (t) => {
  // Round 7 of #39, R7-17: the driver wrote detail, results, worktree_removed
  // and binding into the record and left out staging_tree_oid and
  // included_tickets, so no record it wrote fitted the closed schema.
  const { git, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  const { validateJsonSchema } = await import("../scripts/validate-planning-ref-design.mjs");
  const schema = await aggregateSchema();
  const run = await verifyAggregate({ realpath, git, run: runner, state: schemaState(state), checks: [{ id: "unit", command: "./check.sh" }], dir, instructionLockDigest: LOCK });
  assert.deepEqual(validateJsonSchema(JSON.parse(JSON.stringify(run.aggregate ?? null)), schema), []);
  assert.deepEqual(Object.keys(run.aggregate).sort(), [...schema.required].sort());
  assert.equal(run.aggregate.staging_commit_oid, state.staging_commit_oid);
  assert.equal(run.aggregate.staging_tree_oid, state.staging_tree_oid);
  assert.deepEqual(run.aggregate.included_tickets, ["T01", "T02"]);
  assert.equal(Object.isFrozen(run.aggregate), true);
  // What the run observed and did is reported beside the record, not in it.
  assert.deepEqual(run.results.map((result) => [result.id, result.outcome]), [["unit", "pass"]]);
  assert.equal(run.worktree_removed, true);
});

test("record_hash covers the whole record — tree, configuration, lock, Tickets, outcome — and the project and Epic it belongs to (R7-17)", async (t) => {
  // The acceptance binds aggregate_record_hash, so what the hash leaves out an
  // acceptance does not bind: the hash covered the outcome, the commit and the
  // results and left the tree, the configuration and the lock to `binding`.
  const { git, root, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  const checks = [{ id: "unit", command: "./check.sh" }];
  let runs = 0;
  // The configuration is the checks the run executes and the lock the one the
  // caller hands in (review of 11e, H1), so those two change through the run.
  const hashOf = async (value, { executed = checks, lock = LOCK } = {}) =>
    (await verifyAggregate({ realpath, git, run: runner, state: value, checks: executed, dir: `${dir}-${(runs += 1)}`, instructionLockDigest: lock })).aggregate.record_hash;
  const base = schemaState(state);
  const original = await hashOf(base);
  assert.match(original, /^[a-f0-9]{64}$/u);
  assert.equal(await hashOf(base), original, "the same record hashes the same");
  const changed = {
    configuration: [base, { executed: [{ id: "unit", command: "./check.sh", args: ["--again"] }] }],
    lock: [base, { lock: "f".repeat(64) }],
    tickets: [{ ...base, receipts: [{ ticket_id: "T01" }] }],
    epic: [{ ...base, epic_id: "e-2" }],
    project: [{ ...base, project_identity: `sha256:${"1".repeat(64)}` }],
  };
  for (const [label, [value, options]] of Object.entries(changed)) {
    assert.notEqual(await hashOf(value, options), original, label);
  }
  // Another tree: a second commit whose tree differs.
  await writeFile(path.join(root, "other.txt"), "other\n");
  await git(["add", "other.txt"]);
  await git(["commit", "--quiet", "-m", "other tree"]);
  const moved = {
    ...base,
    staging_commit_oid: (await git(["rev-parse", "HEAD"])).stdout.trim(),
    staging_tree_oid: (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim(),
  };
  assert.notEqual(await hashOf(moved), original, "tree");
});

test("a record rewritten after its run no longer recomputes, and is void (R7-17)", async (t) => {
  // A failed run whose outcome is edited to pass is a PASS nobody ran.
  const { git, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 3\n" });
  const base = schemaState(state);
  const run = await verifyAggregate({ realpath, git, run: runner, state: base, checks: [{ id: "unit", command: "./check.sh" }], dir, instructionLockDigest: LOCK });
  assert.equal(run.aggregate.outcome, "fail");
  assert.deepEqual(aggregateErrors({ ...base, aggregate: run.aggregate }).map((error) => error.reason), ["aggregate_failed"]);
  for (const rewrite of [
    { outcome: "pass" },
    { verification_config_digest: "e".repeat(64) },
    { instruction_lock_digest: "f".repeat(64) },
    { included_tickets: ["T01"] },
  ]) {
    const errors = aggregateErrors({ ...base, aggregate: { ...run.aggregate, ...rewrite } }).map((error) => error.reason);
    assert.ok(errors.includes("aggregate_binding_void"), JSON.stringify(rewrite));
  }
});

test("the driver writes no record that binds no configuration or instruction lock (R7-17)", async (t) => {
  // The lock and a pinned configuration are the caller's inputs, not the
  // state's (review of 11e, H1): the same three refusals, read from there.
  const { git, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  const checks = [{ id: "unit", command: "./check.sh" }];
  for (const [label, options] of [
    ["no lock", {}],
    ["a lock that is not a digest", { instructionLockDigest: "not a digest" }],
    ["a pinned configuration in uppercase hex", { instructionLockDigest: LOCK, verificationConfigDigest: checksDigest(checks).toUpperCase() }],
  ]) {
    await assert.rejects(
      () => verifyAggregate({ realpath, git, run: runner, state: schemaState(state), checks, dir, ...options }),
      code("aggregate_binding_void"),
      label,
    );
    // Refused before anything ran: no worktree was made for it.
    assert.equal((await git(["worktree", "list"])).stdout.includes("verify-worktree"), false);
  }
});

test("an aggregate over no Ticket is refused before anything runs, since the record names the Tickets it verified (R7-17)", async (t) => {
  const { git, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  for (const receipts of [[], undefined]) {
    await assert.rejects(
      () => verifyAggregate({ realpath, git, run: runner, state: { ...state, receipts }, checks: [{ id: "unit", command: "./check.sh" }], dir, instructionLockDigest: LOCK }),
      code("receipt_missing"),
    );
    assert.equal((await git(["worktree", "list"])).stdout.includes("verify-worktree"), false);
  }
});

// --- debt 11e review: the record binds what the run executed, and the run refuses what it cannot bind ---

/** A runner that records whether anything ran. */
const spying = () => {
  const calls = [];
  return { calls, run: async (command, args, options) => { calls.push([command, ...args]); return runner(command, args, options); } };
};

test("the record binds the checks the run executed: a re-run under another check set or command, with the prior record in state, is another record, and the acceptance of the prior one is stale (review H1)", async (t) => {
  // Review of 11e, H1: at 1707c7a the hash covered the check results; in b2b0bf5
  // it did not, and the configuration digest was carried forward from the
  // prior record in state, so a re-run under more checks produced the same
  // record_hash and the acceptance bound to it still admitted the CAS.
  const { git, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  const lock = LOCK;
  const unit = { id: "unit", command: "./check.sh" };
  const base = schemaState(state);
  const first = await verifyAggregate({ realpath, git, run: runner, state: base, checks: [unit], dir: `${dir}-first`, instructionLockDigest: lock });
  assert.equal(first.aggregate.verification_config_digest, checksDigest([unit]));
  // A re-run finds the prior record in the state it is handed.
  const rerun = (checks, label) => verifyAggregate({ realpath,
    git, run: runner, state: { ...base, aggregate: first.aggregate }, checks, dir: `${dir}-${label}`, instructionLockDigest: lock,
  });
  const widened = await rerun([unit, { id: "lint", command: "./check.sh", args: ["--lint"] }], "widened");
  const rewritten = await rerun([{ id: "unit", command: "/bin/sh", args: ["./check.sh"] }], "rewritten");
  for (const [label, run] of [["another check set", widened], ["another command under the same id", rewritten]]) {
    assert.notEqual(run.aggregate.verification_config_digest, first.aggregate.verification_config_digest, label);
    assert.notEqual(run.aggregate.record_hash, first.aggregate.record_hash, label);
    // The acceptance given for the prior record does not carry to this one.
    const stale = acceptanceErrors({ ...base, aggregate: run.aggregate, acceptance: { aggregate_record_hash: first.aggregate.record_hash } }, {});
    assert.ok(stale.some((error) => error.reason === "acceptance_stale" && /aggregate record/u.test(error.detail)), label);
  }
  // The same checks again are the same record.
  assert.equal((await rerun([unit], "same")).aggregate.record_hash, first.aggregate.record_hash);
});

test("a pinned verification configuration that the checks are not is refused before anything runs, and the lock is the caller's input (review H1)", async (t) => {
  const { git, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  const unit = { id: "unit", command: "./check.sh" };
  const lint = { id: "lint", command: "./check.sh", args: ["--lint"] };
  const lock = LOCK;
  const base = schemaState(state);
  for (const pinned of [checksDigest([lint]), checksDigest([unit, lint]), "e".repeat(64), "not a digest"]) {
    const spy = spying();
    await assert.rejects(
      () => verifyAggregate({ realpath, git, run: spy.run, state: base, checks: [unit], dir, instructionLockDigest: lock, verificationConfigDigest: pinned }),
      code("aggregate_binding_void"),
      pinned,
    );
    assert.deepEqual(spy.calls, [], "nothing ran");
    assert.equal((await git(["worktree", "list"])).stdout.includes("verify-worktree"), false);
  }
  // The pin the checks are is admitted, and the record binds it and the lock handed in.
  const pinned = await verifyAggregate({ realpath, git, run: runner, state: base, checks: [unit], dir, instructionLockDigest: lock, verificationConfigDigest: checksDigest([unit]) });
  assert.equal(pinned.aggregate.verification_config_digest, checksDigest([unit]));
  assert.equal(pinned.aggregate.instruction_lock_digest, lock);
  // A prior record's lock is not the lock in force: a state carrying one pins nothing.
  const carried = { ...base, aggregate: { ...pinned.aggregate, instruction_lock_digest: "f".repeat(64) } };
  const relocked = await verifyAggregate({ realpath, git, run: runner, state: carried, checks: [unit], dir: `${dir}-relocked`, instructionLockDigest: lock });
  assert.equal(relocked.aggregate.instruction_lock_digest, lock);
});

test("an identity the record needs and the state does not carry is refused before anything runs, so no evidence is lost to a late throw (review L1)", async (t) => {
  // Review of 11e, L1: a state without project_identity or epic_id, or a
  // receipt without ticket_id, ran every check, removed the worktree, and
  // only then threw invalid_identity while hashing the record. Every field
  // the record is hashed over is now checked before the checkout.
  const { git, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  const base = schemaState(state);
  const unit = { id: "unit", command: "./check.sh" };
  const { project_identity, ...withoutProject } = base;
  const { epic_id, ...withoutEpic } = base;
  const { staging_tree_oid, ...withoutTree } = base;
  for (const [label, value, reason] of [
    ["no project identity", withoutProject, "aggregate_binding_void"],
    ["a project identity that is not sha256:<64 hex>", { ...base, project_identity: "sha256:xyz" }, "aggregate_binding_void"],
    ["no Epic", withoutEpic, "aggregate_binding_void"],
    ["an empty Epic id", { ...base, epic_id: "" }, "aggregate_binding_void"],
    ["an Epic id the canonical identity cannot carry (not NFC)", { ...base, epic_id: "e\u0301-1" }, "aggregate_binding_void"],
    ["no staging tree", withoutTree, "aggregate_binding_void"],
    ["a staging commit and tree of two object formats", { ...base, staging_tree_oid: "a".repeat(64) }, "aggregate_binding_void"],
    ["a receipt without a Ticket", { ...base, receipts: [{ ticket_id: "T01" }, { delta_digest: "a".repeat(64) }] }, "receipt_missing"],
  ]) {
    const spy = spying();
    const asked = [];
    const watched = (args, options) => { asked.push(args.join(" ")); return git(args, options); };
    await assert.rejects(
      () => verifyAggregate({ realpath, git: watched, run: spy.run, state: value, checks: [unit], dir, instructionLockDigest: LOCK }),
      code(reason),
      label,
    );
    assert.deepEqual(spy.calls, [], `${label}: nothing ran`);
    assert.deepEqual(asked, [], `${label}: nothing was checked out`);
    assert.equal((await git(["worktree", "list"])).stdout.includes("verify-worktree"), false, label);
  }
  assert.equal(typeof project_identity, "string");
  assert.equal(typeof epic_id, "string");
  assert.equal(typeof staging_tree_oid, "string");
});

// --- debt 11e narrow re-review: what runs is what the digest covers, and a PASS runs something (L-b, nit) ---

/** A git that records what it was asked, so a refusal can be shown to come before the checkout. */
const watching = (git) => {
  const asked = [];
  return { asked, git: (args, options) => { asked.push(args.join(" ")); return git(args, options); } };
};

test("a check that is not a plain closed record is refused before anything runs, since the digest would not cover what runs (review L-b)", async (t) => {
  // Narrow re-review of 11e, L-b: checksDigest spread each check, so an
  // inherited id or command — which runCheck reads — was left out of the
  // digest, and a check running rm and one running ls had one digest.
  const inherited = (command) => Object.create({ id: "unit", command });
  assert.throws(() => checksDigest([inherited("rm")]), code("invalid_record"));
  assert.throws(() => checksDigest([{ id: "unit", get command() { return "rm"; } }]), code("invalid_record"));
  // A record with no prototype at all inherits nothing, so it is plain.
  const bare = Object.assign(Object.create(null), { id: "unit", command: "./check.sh" });
  assert.equal(checksDigest([bare]), checksDigest([{ id: "unit", command: "./check.sh" }]));
  const { git, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  const spy = spying();
  const watched = watching(git);
  await assert.rejects(
    () => verifyAggregate({ realpath, git: watched.git, run: spy.run, state: schemaState(state), checks: [inherited("./check.sh")], dir, instructionLockDigest: LOCK }),
    code("invalid_record"),
  );
  assert.deepEqual(spy.calls, [], "nothing ran");
  assert.deepEqual(watched.asked, [], "nothing was checked out");
});

test("an empty check set is refused before anything runs: a PASS over no check verifies nothing (review nit)", async (t) => {
  // Narrow re-review of 11e: `checks: []` ran nothing and recorded
  // outcome pass.
  const { git, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  for (const checks of [[], undefined]) {
    const spy = spying();
    const watched = watching(git);
    await assert.rejects(
      () => verifyAggregate({ realpath, git: watched.git, run: spy.run, state: schemaState(state), checks, dir, instructionLockDigest: LOCK }),
      code("aggregate_binding_void"),
      JSON.stringify(checks),
    );
    assert.deepEqual(spy.calls, [], "nothing ran");
    assert.deepEqual(watched.asked, [], "nothing was checked out");
  }
});

// Debt 13b (R9-1, ADR-110): the checks run under the model account, whose own
// `git` finds no repository in the checkout, so the run hands them a view.

/** A check runner that records the options each command was started with. */
const recording = () => {
  const started = [];
  return {
    started,
    run: async (command, args, options) => {
      started.push({ command, args, options });
      return { code: 0, stdout: "", stderr: "" };
    },
  };
};

test("a run given a handout directory writes the staging commit's handout and hands it to every check (R9-1)", async (t) => {
  const { git, root, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  const handoutDir = path.join(root, "handout");
  await mkdir(handoutDir);
  const plain = await verifyAggregate({ realpath, git, run: runner, state, checks: [{ id: "unit", command: "./check.sh" }], dir, instructionLockDigest: LOCK });
  assert.equal(plain.git_view, null);
  const spy = recording();
  const checks = [{ id: "one", command: "one" }, { id: "two", command: "two" }];
  const run = await verifyAggregate({ realpath, git, run: spy.run, state, checks, dir, handoutDir, instructionLockDigest: LOCK });
  assert.equal(run.git_view.commit, state.staging_commit_oid);
  assert.equal(run.git_view.since, state.staging_commit_oid, "no base in the state: the commit alone");
  assert.equal((await readdir(handoutDir)).includes(run.git_view.pack), true);
  // Every check is handed the same handout, beside its directory and environment.
  assert.deepEqual(spy.started.map((call) => call.options.handout), [run.git_view, run.git_view]);
  assert.deepEqual(spy.started.map((call) => call.options.cwd), [dir, dir]);
  // A view is evidence of the run and binds nothing: the record is the one a run without it writes.
  const bare = await verifyAggregate({ realpath, git, run: spy.run, state, checks, dir, instructionLockDigest: LOCK });
  assert.equal(run.aggregate.record_hash, bare.aggregate.record_hash);
  assert.equal(bare.git_view, null);
  assert.equal("handout" in spy.started.at(-1).options, false, "no handout was asked for, so none is handed");
});

test("the handout reaches down to the recorded target base, and no further (R9-1)", async (t) => {
  const { git, root, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  const base = state.staging_commit_oid;
  await writeFile(path.join(root, "next.txt"), "next\n");
  await git(["add", "next.txt"]);
  await git(["commit", "--quiet", "-m", "staged again"]);
  const staged = { ...state, staging_commit_oid: (await git(["rev-parse", "HEAD"])).stdout.trim(), staging_tree_oid: (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim(), recorded_target_base: base };
  const handoutDir = path.join(root, "handout");
  await mkdir(handoutDir);
  const run = await verifyAggregate({ realpath, git, run: recording().run, state: staged, checks: [{ id: "unit", command: "x" }], dir, handoutDir, instructionLockDigest: LOCK });
  assert.equal(run.git_view.commit, staged.staging_commit_oid);
  assert.equal(run.git_view.since, base);
  assert.equal(run.aggregate.outcome, "pass");
});

test("a recorded base that is not on the staging commit's history voids the binding before any check runs (R9-1)", async (t) => {
  const { git, root, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  await git(["checkout", "--quiet", "--orphan", "elsewhere"]);
  await writeFile(path.join(root, "elsewhere.txt"), "another line\n");
  await git(["add", "elsewhere.txt"]);
  await git(["commit", "--quiet", "-m", "another line"]);
  const foreign = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const handoutDir = path.join(root, "handout");
  await mkdir(handoutDir);
  const spy = recording();
  await assert.rejects(
    verifyAggregate({ realpath, git, run: spy.run, state: { ...state, recorded_target_base: foreign }, checks: [{ id: "unit", command: "x" }], dir, handoutDir, instructionLockDigest: LOCK }),
    code("aggregate_binding_void"),
  );
  assert.deepEqual(spy.started, [], "nothing ran");
  assert.equal((await git(["worktree", "list"])).stdout.includes("verify-worktree"), false, "the checkout was removed");
  assert.deepEqual(await readdir(handoutDir), []);
});

test("a handout that cannot be written is an environment failure, and the checkout is removed before anything runs (R9-1)", async (t) => {
  const { git, root, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  const handoutDir = path.join(root, "handout");
  await mkdir(handoutDir);
  const failing = async (args, options) => (args.includes("pack-objects") ? { code: 128, stdout: "", stderr: "fatal: no space left" } : git(args, options));
  const spy = recording();
  await assert.rejects(
    verifyAggregate({ realpath, git: failing, run: spy.run, state, checks: [{ id: "unit", command: "x" }], dir, handoutDir, instructionLockDigest: LOCK }),
    code("environment_failure"),
  );
  assert.deepEqual(spy.started, [], "nothing ran");
  assert.equal((await git(["worktree", "list"])).stdout.includes("verify-worktree"), false);
});

test("no Git command the driver runs starts inside the checkout, with a handout too, so the view is never read by autoskd (R9-1, requirement 3)", async (t) => {
  const { git, root, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  const handoutDir = path.join(root, "handout");
  await mkdir(handoutDir);
  const cwds = [];
  const watching = async (args, options = {}) => {
    cwds.push(options.cwd ?? null);
    const result = await git(args, options);
    // The launch replaces the checkout's gitfile by a repository of the model account's: every later command that discovered from here would read it.
    if (args[0] === "worktree" && args[1] === "add") {
      await rm(path.join(dir, ".git"), { force: true });
      await mkdir(path.join(dir, ".git"));
    }
    return result;
  };
  const run = await verifyAggregate({ realpath, git: watching, run: recording().run, state, checks: [{ id: "unit", command: "x" }], dir, handoutDir, instructionLockDigest: LOCK });
  assert.equal(run.git_view.commit, state.staging_commit_oid);
  assert.deepEqual(cwds.filter((cwd) => cwd !== null && path.resolve(cwd).startsWith(path.resolve(dir))), []);
});

test("a checkout whose tree is not the recorded one is refused before a handout is written (R9-1)", async (t) => {
  const { git, root, state, dir } = await staging(t, { checkContent: "#!/bin/sh\nexit 0\n" });
  const handoutDir = path.join(root, "handout");
  await mkdir(handoutDir);
  const spy = recording();
  await assert.rejects(
    verifyAggregate({ realpath, git, run: spy.run, state: { ...state, staging_tree_oid: "f".repeat(40) }, checks: [{ id: "unit", command: "x" }], dir, handoutDir, instructionLockDigest: LOCK }),
    code("aggregate_binding_void"),
  );
  assert.deepEqual(await readdir(handoutDir), [], "no handout for a tree the record does not name");
  assert.deepEqual(spy.started, []);
  assert.equal((await git(["worktree", "list"])).stdout.includes("verify-worktree"), false);
  // The same directory takes the handout of the tree the record does name.
  const run = await verifyAggregate({ realpath, git, run: spy.run, state, checks: [{ id: "unit", command: "x" }], dir, handoutDir, instructionLockDigest: LOCK });
  assert.equal(run.git_view.commit, state.staging_commit_oid);
  assert.deepEqual(await readdir(handoutDir), [run.git_view.idx, run.git_view.pack].sort());
});
