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
 * The read-back asks the repository, never the checkout: the checks run code
 * models wrote in it, so no Git command here discovers a repository from
 * inside it (docs/contracts/platform-support.md §5b, review of 9b65ad3, M4).
 *
 * The checks run under the model account, which opens no Git directory of the
 * project, so a check that calls `git` would find no repository in the checkout
 * (round 9 of #39, R9-1). A run given a handout directory writes what the launch
 * builds the account's own repository from, and hands it to every check beside
 * its directory and environment (`git-view.mjs`, ADR-110). The launch builds the
 * view under the account and this never reads it: no command here starts inside
 * the checkout.
 *
 * Injected: `git(args, { cwd, env, input } = {})` and `run(command, args, { cwd,
 * env, handout })`, both returning `{ code, stdout, stderr }`; `run` reports a
 * command that could not start as `code: null`; and `realpath(path)`, for the
 * same reason the delta driver takes it: the module resolves paths, it does not
 * read the filesystem itself.
 */
import { canonicalBytes, closedRecord, demand, digest, immutable, oneObjectFormat } from '../runtime/contracts.mjs';

import { aggregateRecordHash } from './epic-staging.mjs';
import { handOutGitView } from './git-view.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const PROJECT_IDENTITY = /^sha256:[a-f0-9]{64}$/u;
const VERIFICATION_CONFIG_DOMAIN = 'autosk-flow/verification-config/v1';

/** A string the record's canonical identity can carry: present, non-empty, NFC, no NUL or lone surrogate. */
function identityString(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    canonicalBytes(value);
    return true;
  } catch {
    return false;
  }
}

async function ask(git, args, options = {}) {
  const result = await git(args, options);
  if (result.code !== 0) {
    demand(false, 'environment_failure', `git ${args[0]} exited ${result.code}`,
      { args: immutable([...args]), stderr: (result.stderr ?? '').trim().slice(0, 200) });
  }
  return result;
}

/**
 * The worktrees the repository records, each as its porcelain fields.
 *
 * `git worktree list --porcelain` answers from the common Git directory's own
 * record of each worktree — its path and its HEAD — and opens no worktree's
 * `.git`, so a gitfile or repository a model plants in a checkout cannot
 * answer for it (review of 9b65ad3, M4). `-z` ends each field with NUL and
 * each worktree with another, so a path that holds a newline stays one path
 * (narrow re-review of 0ea81de, Low 11).
 */
async function worktrees(git) {
  const listed = await ask(git, ['worktree', 'list', '--porcelain', '-z']);
  return listed.stdout.split('\0\0').map((entry) => Object.fromEntries(entry.split('\0')
    .map((line) => [line.split(' ', 1)[0], line.slice(line.indexOf(' ') + 1)])));
}

/**
 * Checks the staging commit out into a throwaway worktree, and proves it did.
 *
 * `--detach` because a branch here would be a second name for the staging
 * commit that could then move independently of it. The proof is read from the
 * repository, run where the caller's `git` runs and never from inside the
 * checkout: the one worktree this run added, at the checkout's real path and
 * the staging commit, and the tree of that commit. Discovering the repository
 * from the checkout would ask whatever `.git` is there now, and a model can
 * write the checkout (review of 9b65ad3, M4). A worktree some other run adds
 * meanwhile fails the proof closed, and this run's is removed; so does a new
 * worktree Git recorded anywhere but the directory asked for (narrow re-review
 * of 0ea81de, Low 11).
 */
export async function checkoutStaging(git, { dir, commit, realpath }) {
  const before = new Set((await worktrees(git)).map((entry) => entry.worktree));
  await ask(git, ['worktree', 'add', '--detach', '--quiet', dir, commit]);
  try {
    const added = (await worktrees(git)).filter((entry) => !before.has(entry.worktree));
    // Git records the real path of the directory it checked out into.
    const at = await Promise.resolve().then(() => realpath(dir)).catch(() => null);
    demand(added.length === 1 && added[0].worktree === at, 'aggregate_binding_void',
      'The checkout is not the one worktree this run added, at the directory it was asked into',
      { added: immutable(added.map((entry) => entry.worktree ?? null)), at });
    const [checkout] = added;
    demand(checkout.HEAD === commit, 'aggregate_binding_void',
      'The worktree is not at the staging commit', { expected: commit, observed: checkout.HEAD ?? null });
    const tree = await ask(git, ['rev-parse', '--verify', `${commit}^{tree}`]);
    return Object.freeze({ dir, commit, tree_oid: tree.stdout.trim() });
  } catch (error) {
    // A refusal that leaves the worktree behind hands the next run the state
    // this one refused to work in.
    await removeWorktree(git, dir);
    throw error;
  }
}

/**
 * The handout of the staging commit: the commit and its line down to the
 * recorded target base, which the staging commit's history must contain.
 *
 * The module's own refusals are read here as this driver's: a Git command that
 * fails is the environment's, and a base the history does not hold is a record
 * that does not bind what it names.
 */
async function handOut(git, { dir, since }, commit) {
  try {
    return await handOutGitView(git, { dir, commit, line: [commit], since });
  } catch (error) {
    if (error?.code === 'git_view_git_failed') {
      demand(false, 'environment_failure', 'The Git view handout could not be written', { detail: error.message, ...error.details });
    }
    if (error?.code === 'git_view_boundary_invalid') {
      demand(false, 'aggregate_binding_void', 'The recorded target base is not on the staging commit\'s history', { commit, since: since ?? null });
    }
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
export async function runCheck(run, check, { cwd, env, handout }) {
  const started = Date.now();
  const result = await run(check.command, check.args ?? [], handout === undefined ? { cwd, env } : { cwd, env, handout });
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
 * Returns `{ aggregate, results, worktree_removed, git_view }`. `aggregate` is the record
 * the staging record carries, and exactly the closed `aggregate` of
 * `resources/epic-staging/epic-staging.schema.json`: the staging commit and
 * tree, the verification configuration and instruction-lock digests, the
 * included Tickets, the outcome, and `record_hash` over all of them and the
 * project and Epic (`aggregateRecordHash`), so a PASS cannot be carried to a
 * tree it was not run on or to a rule set it was not run under, and the
 * acceptance that binds the hash binds both. What each check did and whether
 * the throwaway worktree went are this run's evidence, reported beside the
 * record rather than written into it (debt 11e, ADR-099). So is `git_view`, the
 * handout the checks were given, or null when the run was given no handout
 * directory: it binds nothing, and the record is the same with or without it.
 *
 * The configuration digest is always the digest of what this run executes
 * (`checksDigest(checks, env)`), never one carried in: a prior record in the
 * state is the previous run's evidence and pins nothing, so a run under other
 * checks is another record, and the acceptance of the old one is stale. The
 * caller pins what it must: `verificationConfigDigest`, when given, is the
 * configuration the run must be, and one the checks are not is refused before
 * anything runs; `instructionLockDigest` is the instruction lock in force,
 * which the caller hands in and the record binds (review of 11e, H1).
 *
 * Everything the record is hashed over is checked before the checkout — the
 * project and Epic, the staging commit and tree, the lock, a Ticket for every
 * receipt — so a state the record cannot be written for runs nothing, rather
 * than running every check and losing the evidence to a late throw (review of
 * 11e, L1). So is the check set: it names at least one check, since a PASS
 * over none verifies nothing, and each check is a plain closed record, so the
 * digest covers exactly what `runCheck` reads (narrow re-review of 11e).
 */
export async function verifyAggregate({ git, run, realpath, state, checks, dir, handoutDir, env = {}, instructionLockDigest, verificationConfigDigest }) {
  demand(PROJECT_IDENTITY.test(state.project_identity) && identityString(state.epic_id)
      && oneObjectFormat([state.staging_commit_oid, state.staging_tree_oid]) !== null, 'aggregate_binding_void',
    'The aggregate record binds the project, the Epic and the staging commit and tree, and the state does not name them all',
    { project_identity: state.project_identity ?? null, epic_id: state.epic_id ?? null });
  demand(Array.isArray(checks) && checks.length > 0, 'aggregate_binding_void',
    'The aggregate runs at least one check: a PASS over none verifies nothing');
  const verification_config_digest = checksDigest(checks, env);
  demand(verificationConfigDigest === undefined || verificationConfigDigest === verification_config_digest, 'aggregate_binding_void',
    'The checks are not the verification configuration the caller pinned',
    { pinned: verificationConfigDigest, executed: verification_config_digest });
  const instruction_lock_digest = instructionLockDigest;
  demand(SHA256.test(instruction_lock_digest ?? ''), 'aggregate_binding_void',
    'The aggregate record binds the instruction lock in force, and the caller named none',
    { instruction_lock_digest: instruction_lock_digest ?? null });
  const receipts = state.receipts ?? [];
  demand(receipts.every((receipt) => identityString(receipt?.ticket_id)), 'receipt_missing',
    'Every receipt names the Ticket it integrated');
  const included = [...new Set(receipts.map((receipt) => receipt.ticket_id))].sort();
  demand(included.length > 0, 'receipt_missing', 'The aggregate verifies the Tickets the receipts name, and none is named');
  const checkout = await checkoutStaging(git, { dir, commit: state.staging_commit_oid, realpath });
  const results = [];
  let git_view = null;
  let cleanup;
  try {
    demand(checkout.tree_oid === state.staging_tree_oid, 'aggregate_binding_void',
      'The checked-out tree is not the recorded staging tree',
      { recorded: state.staging_tree_oid, observed: checkout.tree_oid });
    // Written for the tree the record names and no other, before anything runs.
    git_view = handoutDir === undefined ? null
      : await handOut(git, { dir: handoutDir, since: state.recorded_target_base }, state.staging_commit_oid);

    for (const check of checks) {
      const result = await runCheck(run, check, { cwd: dir, env, handout: git_view ?? undefined });
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
  const environmentFailure = results.some((result) => result.outcome === 'environment_failure');
  const failed = results.some((result) => result.outcome === 'fail');
  const aggregate = {
    staging_commit_oid: state.staging_commit_oid,
    staging_tree_oid: checkout.tree_oid,
    verification_config_digest,
    instruction_lock_digest,
    included_tickets: included,
    outcome: environmentFailure ? 'indeterminate' : failed ? 'fail' : 'pass',
    environment_outcome: environmentFailure ? 'environment_failure' : 'ok',
  };
  aggregate.record_hash = aggregateRecordHash(state, aggregate);
  return Object.freeze({
    aggregate: Object.freeze({ ...aggregate, included_tickets: immutable(aggregate.included_tickets) }),
    results: immutable(results),
    worktree_removed: cleanup.removed,
    git_view,
  });
}

/**
 * The verification configuration a run executes, as its digest.
 *
 * Each check's full spec, in the order the run takes them — its id, command
 * and args (absent args run as none, so they are `[]`) and every other field
 * it carries — and the environment the run hands every check, under one
 * domain-separated canonical digest. A caller that pins a configuration pins
 * this (review of 11e, H1).
 *
 * A check is a plain closed record, as the canonical identity holds `env`: an
 * inherited or accessor field is one `runCheck` reads and a copy of the own
 * fields would drop, so two checks running different commands would share a
 * digest. One that is not is refused (`invalid_record`) before anything is
 * digested (narrow re-review of 11e, L-b).
 */
export function checksDigest(checks, env = {}) {
  return digest(VERIFICATION_CONFIG_DOMAIN, {
    checks: checks.map((check) => {
      closedRecord(check, Object.keys(check));
      return { ...check, args: check.args ?? [] };
    }),
    env,
  });
}
