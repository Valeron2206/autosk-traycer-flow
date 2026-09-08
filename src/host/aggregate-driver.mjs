/** Running aggregate verification on the exact staging tree.
 *
 * #9 says what the aggregate record binds and what makes it void. This runs the
 * checks that produce it, and the one thing it will not do is guess: a check
 * that ran and failed and a machine that could not run it are recorded as
 * different outcomes, because only one of them is a statement about the
 * product.
 *
 * The tree is checked out into a throwaway worktree at the exact staging
 * commit, and the checkout is read back before anything runs. A verification of
 * the wrong tree is worse than no verification, because it produces a PASS.
 *
 * Injected: `git(args, { cwd, env } = {})` and `run(command, args, { cwd, env })`,
 * both returning `{ code, stdout, stderr }`; `run` reports a command that could
 * not start as `code: null`.
 */
import { createHash } from 'node:crypto';

import { demand, immutable } from '../runtime/contracts.mjs';

import { aggregateBinding } from './epic-staging.mjs';

async function ask(git, args, options = {}) {
  const result = await git(args, options);
  if (result.code !== 0) {
    demand(false, 'environment_failure', `git ${args[0]} exited ${result.code}`,
      { args: immutable([...args]), stderr: (result.stderr ?? '').trim().slice(0, 200) });
  }
  return result;
}

/**
 * Checks the staging commit out into a throwaway worktree, and proves it did.
 *
 * `--detach` because a branch here would be a second name for the staging
 * commit that could then move independently of it.
 */
export async function checkoutStaging(git, { dir, commit }) {
  await ask(git, ['worktree', 'add', '--detach', '--quiet', dir, commit]);
  try {
    const head = await ask(git, ['rev-parse', 'HEAD'], { cwd: dir });
    const tree = await ask(git, ['rev-parse', 'HEAD^{tree}'], { cwd: dir });
    demand(head.stdout.trim() === commit, 'aggregate_binding_void',
      'The worktree is not at the staging commit', { expected: commit, observed: head.stdout.trim() });
    return Object.freeze({ dir, commit, tree_oid: tree.stdout.trim() });
  } catch (error) {
    // A refusal that leaves the worktree behind hands the next run the state
    // this one refused to work in.
    await removeWorktree(git, dir);
    throw error;
  }
}

/**
 * Removes the worktree, and says so when it could not.
 *
 * A left-behind worktree is state the next run inherits, so failing to remove
 * one is reported rather than swallowed by a cleanup that always "succeeds".
 */
export async function removeWorktree(git, dir) {
  const result = await git(['worktree', 'remove', '--force', dir]);
  return Object.freeze({ removed: result.code === 0, dir, detail: result.code === 0 ? null : (result.stderr ?? '').trim().slice(0, 200) });
}

/**
 * One verification command.
 *
 * A command that could not start did not fail — it did not run, and the two are
 * kept apart here rather than at the end, where the difference is already lost.
 */
export async function runCheck(run, check, { cwd, env }) {
  const started = Date.now();
  const result = await run(check.command, check.args ?? [], { cwd, env });
  const ms = Date.now() - started;
  if (result.code === null || result.code === undefined) {
    return Object.freeze({
      id: check.id,
      outcome: 'environment_failure',
      detail: (result.stderr ?? 'the command could not start').trim().slice(0, 200),
      ms,
    });
  }
  return Object.freeze({
    id: check.id,
    outcome: result.code === 0 ? 'pass' : 'fail',
    exit_code: result.code,
    detail: result.code === 0 ? null : (result.stderr ?? result.stdout ?? '').trim().slice(0, 200),
    ms,
  });
}

/**
 * Runs every check on the exact staging tree and records what happened.
 *
 * The record is bound by `aggregateBinding` to the staging identity, the
 * verification configuration and the instruction lock, so a PASS cannot be
 * carried to a tree it was not run on or to a rule set it was not run under.
 */
export async function verifyAggregate({ git, run, state, checks, dir, env = {} }) {
  const checkout = await checkoutStaging(git, { dir, commit: state.staging_commit_oid });
  const results = [];
  let cleanup;
  try {
    demand(checkout.tree_oid === state.staging_tree_oid, 'aggregate_binding_void',
      'The checked-out tree is not the recorded staging tree',
      { recorded: state.staging_tree_oid, observed: checkout.tree_oid });

    for (const check of checks) {
      const result = await runCheck(run, check, { cwd: dir, env });
      results.push(result);
      // An environment failure stops the run: the checks after it would report
      // on a machine already known not to be running them.
      if (result.outcome === 'environment_failure') break;
    }
  } finally {
    // Removed on every path, including the refusals: the worktree exists for
    // this run and nothing after it should inherit one.
    cleanup = await removeWorktree(git, dir);
  }
  const environmentFailure = results.find((result) => result.outcome === 'environment_failure');
  const failed = results.filter((result) => result.outcome === 'fail');
  const aggregate = {
    outcome: environmentFailure ? 'indeterminate' : failed.length === 0 ? 'pass' : 'fail',
    environment_outcome: environmentFailure ? 'environment_failure' : 'ok',
    detail: environmentFailure?.detail ?? (failed[0] ? `${failed[0].id} exited ${failed[0].exit_code}` : null),
    verification_config_digest: state.aggregate?.verification_config_digest ?? checksDigest(checks),
    instruction_lock_digest: state.aggregate?.instruction_lock_digest,
    staging_commit_oid: state.staging_commit_oid,
    results: immutable(results),
    worktree_removed: cleanup.removed,
  };
  aggregate.record_hash = createHash('sha256')
    .update(JSON.stringify({
      outcome: aggregate.outcome,
      environment_outcome: aggregate.environment_outcome,
      staging_commit_oid: aggregate.staging_commit_oid,
      results: results.map((result) => ({ id: result.id, outcome: result.outcome })),
    }), 'utf8')
    .digest('hex');
  aggregate.binding = aggregateBinding({ ...state, aggregate });
  return Object.freeze(aggregate);
}

/** The digest of the checks that were run, when the state does not carry one. */
export function checksDigest(checks) {
  return createHash('sha256')
    .update(JSON.stringify(checks.map((check) => [check.id, check.command, ...(check.args ?? [])])), 'utf8')
    .digest('hex');
}
