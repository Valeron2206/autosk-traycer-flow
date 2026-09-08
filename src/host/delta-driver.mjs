/** Applying an approved delta to staging, against a real repository.
 *
 * #8 decides what a delta is and what proves it was integrated; this performs
 * the integration. The rule that shapes every line here: the driver may
 * reference blobs that already exist and were approved, and may not produce
 * content. A conflict resolved by writing new content produces bytes nobody
 * reviewed, and no amount of care in choosing them makes them reviewed.
 *
 * The apply runs in a temporary index, so the operator's worktree and index are
 * not touched — an integration that requires a clean checkout is an integration
 * that cannot run while someone is working.
 *
 * The injected `git(args, { env } = {})` runs one command and returns
 * `{ code, stdout, stderr }`, applying `env` on top of its own. `realpath` is
 * injected for the same reason: the module resolves paths, it does not read the
 * filesystem itself.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

import {
  collisionErrors,
  environmentErrors,
  integrationProof,
  revalidate,
  withinPathspec,
} from './approved-delta.mjs';
import { readRef, reflogDepth, swapTarget } from './staging-driver.mjs';

/** One git invocation. A command that could not run says nothing about the product. */
async function ask(git, args, options = {}) {
  const result = await git(args, options);
  if (result.code !== 0) {
    demand(false, 'environment_failure', `git ${args[0]} exited ${result.code}`,
      { args: immutable([...args]), stderr: (result.stderr ?? '').trim().slice(0, 200) });
  }
  return result;
}

/**
 * The environment an apply may run in.
 *
 * Refused rather than cleaned in place: cleaning it would hide how it got
 * there, and an inherited variable silently redirects every command that
 * follows.
 */
export function assertCleanEnvironment(env) {
  const errors = environmentErrors(env);
  demand(errors.length === 0, 'inherited_git_env', 'The environment carries inherited Git variables',
    { names: immutable(errors.map((error) => error.detail)) });
}

/** What the worktree holds that is not committed, read rather than assumed. */
export async function worktreeState(git, options = {}) {
  const status = await ask(git, ['status', '--porcelain', '--untracked-files=all'], options);
  const untracked = [];
  let dirty = false;
  for (const line of status.stdout.split('\n')) {
    if (line.startsWith('?? ')) untracked.push(line.slice(3).trim());
    else if (line.trim().length > 0) dirty = true;
  }
  return Object.freeze({ untracked: immutable(untracked), dirty });
}

/**
 * Where the temporary index may live.
 *
 * Not inside the project: a leftover index file there is untracked state that
 * looks like somebody's work, and the next apply refuses on the collision it
 * created itself.
 */
export async function assertIndexOutsideProject(git, { indexFile, realpath }) {
  const top = await git(['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return;
  const root = top.stdout.trim();
  if (root.length === 0) return;
  // Both sides resolved, because git answers with the real path and a caller
  // holding a path through a symlink would compare two spellings of the same
  // directory and conclude they are different ones.
  const [resolvedRoot, resolvedDir] = await Promise.all([realpath(root), realpath(dirname(indexFile))]);
  demand(resolvedDir !== resolvedRoot && !resolvedDir.startsWith(`${resolvedRoot}/`),
    'state_identity_collision', 'The temporary index would sit inside the project',
    { indexFile, root: resolvedRoot });
}

/** The directory part of a path, without pulling in a path module for one line. */
function dirname(filePath) {
  const cut = filePath.lastIndexOf('/');
  return cut <= 0 ? '/' : filePath.slice(0, cut);
}

/**
 * Composes the tree an approved delta produces, in a temporary index.
 *
 * Every entry names a blob that already exists in the repository, so this is
 * assembly, not authorship: `update-index --cacheinfo` refuses an object that
 * is not there, and there is no path by which the driver could invent one.
 */
export async function composeTree(git, { delta, base, indexFile, realpath }) {
  await assertIndexOutsideProject(git, { indexFile, realpath });
  const env = { GIT_INDEX_FILE: indexFile };
  await ask(git, ['read-tree', base], { env });
  for (const entry of delta.entries) {
    if (entry.status === 'D') {
      await ask(git, ['update-index', '--force-remove', '--', entry.path], { env });
      continue;
    }
    if (entry.status === 'R') {
      // A rename is the old path leaving and the new one arriving. Recording it
      // as one operation is what makes the old path's disappearance reviewed.
      await ask(git, ['update-index', '--force-remove', '--', entry.from_path], { env });
    }
    await ask(git, [
      'update-index', '--add', '--cacheinfo', `${entry.new_mode},${entry.new_blob},${entry.path}`,
    ], { env });
  }
  const tree = await ask(git, ['write-tree'], { env });
  return tree.stdout.trim();
}

/**
 * What the written tree actually holds, for the paths this delta claims.
 *
 * Read back from the tree rather than echoed from the request: an apply that
 * reports what it was asked to do proves nothing about what it did.
 *
 * Compared against the base tree, because *introduced* means introduced by this
 * apply. A file another Ticket already integrated is in scope and was not
 * introduced here, and reporting it as unapproved is the full-tree false
 * negative this issue exists to remove.
 */
export async function appliedEntries(git, { tree, baseTree, delta, options = {} }) {
  const [now, before] = await Promise.all([
    listTree(git, tree, options),
    baseTree ? listTree(git, baseTree, options) : Promise.resolve(new Map()),
  ]);
  const applied = [];
  for (const path of new Set(delta.entries.map((entry) => entry.path))) {
    const held = now.get(path);
    if (held) applied.push(Object.freeze({ path, ...held }));
  }
  // Anything else in scope that this apply changed is reported too, so
  // introducing an unapproved path is visible to the proof rather than filtered
  // out here.
  for (const [path, held] of now) {
    if (applied.some((entry) => entry.path === path)) continue;
    if (!withinPathspec(delta.pathspec, path)) continue;
    const was = before.get(path);
    if (!was || was.new_blob !== held.new_blob || was.new_mode !== held.new_mode) {
      applied.push(Object.freeze({ path, ...held }));
    }
  }
  return immutable(applied.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}

/** One tree, as path → blob and mode. */
async function listTree(git, tree, options) {
  const listing = await ask(git, ['ls-tree', '-r', '--full-tree', tree], options);
  const held = new Map();
  for (const line of listing.stdout.split('\n')) {
    const match = /^(\d{6}) blob ([0-9a-f]{40})\t(.*)$/u.exec(line);
    if (match) held.set(match[3], { new_mode: match[1], new_blob: match[2] });
  }
  return held;
}

/**
 * What this apply removed, inside the Ticket's scope.
 *
 * A removal is invisible to a check that only inspects the paths still there,
 * so it is reported rather than left to be inferred from an absence.
 */
export async function removedPaths(git, { tree, baseTree, delta, options = {} }) {
  if (!baseTree) return immutable([]);
  const [now, before] = await Promise.all([
    listTree(git, tree, options),
    listTree(git, baseTree, options),
  ]);
  const gone = [];
  for (const path of before.keys()) {
    if (!now.has(path) && withinPathspec(delta.pathspec, path)) gone.push(path);
  }
  return immutable(gone.sort());
}

/** Whether paths another Ticket integrated are still in the tree. */
export async function preservedPaths(git, { tree, paths, options = {} }) {
  if (paths.length === 0) return immutable([]);
  const listing = await ask(git, ['ls-tree', '-r', '--full-tree', '--name-only', tree], options);
  const present = new Set(listing.stdout.split('\n').map((line) => line.trim()).filter(Boolean));
  return immutable(paths.map((path) => Object.freeze({ path, present: present.has(path) })));
}

/**
 * Applies one approved delta to the staging ref.
 *
 * The order is the one the contract requires: revalidate against the exact
 * base, refuse a collision rather than clear it, compose, commit, advance the
 * ref by compare-and-swap, and read back what the tree holds. Nothing here
 * resolves a conflict; a conflict is a refusal.
 */
export async function applyDelta(git, {
  delta,
  ref,
  base,
  indexFile,
  env = {},
  message,
  realpath,
  worktree,
  otherTicketPaths = [],
  options = {},
}) {
  assertCleanEnvironment(env);
  // Revalidated immediately before the apply, not when it was approved: the
  // staging base moves as other Tickets integrate, and `revalidate` validates
  // the delta as well as its base — a separate `validateDelta` call here would
  // be a second check with the same answer.
  const stale = revalidate(delta, base);
  demand(stale.length === 0, stale[0]?.reason ?? 'delta_stale', 'The delta does not validate against this base',
    { detail: stale[0]?.detail });
  if (worktree) {
    // Fail-closed, and the file stays where it is. Clearing it would destroy
    // work nobody has reviewed to make room for work that was.
    const collisions = collisionErrors(delta, worktree);
    demand(collisions.length === 0, collisions[0]?.reason ?? 'untracked_collision',
      'A file is in the way at an approved path', { detail: collisions[0]?.detail });
  }

  const held = await readRef(git, ref);
  demand(held === base.commit_oid, 'foreign_ref_movement', 'The staging ref is not at the recorded base',
    { ref, expected: base.commit_oid, held });

  const depthBefore = await reflogDepth(git, ref);
  const tree = await composeTree(git, { delta, base: base.commit_oid, indexFile, realpath });
  const commit = await ask(git, ['commit-tree', tree, '-p', base.commit_oid, '-m', message], options);
  const movement = await swapTarget(git, { ref, expectedOld: base.commit_oid, newOid: commit.stdout.trim() });
  const observed = await readRef(git, ref);

  return Object.freeze({
    operation_id: delta.operation_id,
    base_commit_oid: delta.base_commit_oid,
    tree_oid: tree,
    commit_oid: commit.stdout.trim(),
    applied: movement.swapped,
    applied_entries: await appliedEntries(git, { tree, baseTree: base.tree_oid, delta, options }),
    removed_paths: await removedPaths(git, { tree, baseTree: base.tree_oid, delta, options }),
    preserved_from_other_tickets: await preservedPaths(git, { tree, paths: otherTicketPaths, options }),
    conflicts_resolved_by_new_content: false,
    ref_movement: Object.freeze({
      ref,
      expected_old_oid: base.commit_oid,
      observed_old_oid: movement.swapped ? base.commit_oid : movement.observed_old_oid,
      post_state: observed === null ? 'unknown' : 'known',
      reflog_entries: (await reflogDepth(git, ref)) - depthBefore,
    }),
  });
}

/**
 * The integration receipt: the result, and what #8's guards make of it.
 *
 * Durable on purpose. A receipt that exists only while the process does cannot
 * tell a resumed run which phase it is in.
 */
export function integrationReceipt(delta, result) {
  const errors = integrationProof(delta, result);
  return Object.freeze({
    operation_id: result.operation_id,
    delta_digest: delta.delta_digest,
    base_commit_oid: result.base_commit_oid,
    staging_commit_oid: result.commit_oid,
    staging_tree_oid: result.tree_oid,
    phase: errors.length === 0 && result.applied ? 'ref_advanced' : 'prepared',
    errors: immutable(errors.map(Object.freeze)),
  });
}
