/** Building the execution base tree, against a real repository.
 *
 * #7 decides which predecessors compose a Ticket's base and in what order; this
 * builds it. The order is the recorded one, replayed exactly: a diamond DAG
 * applied in two orders can produce two trees, and then "the same base" would
 * mean two different things on a retry.
 *
 * The composition is assembled in a temporary index from blobs that already
 * exist, for the same reason the delta apply is: a base built from content
 * nobody approved is not a base anybody approved.
 *
 * The injected `git(args, { env } = {})` runs one command and returns
 * `{ code, stdout, stderr }`.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

import { assertIndexOutsideProject } from './delta-driver.mjs';

async function ask(git, args, options = {}) {
  const result = await git(args, options);
  if (result.code !== 0) {
    demand(false, 'composition_failed', `git ${args[0]} exited ${result.code}`,
      { args: immutable([...args]), stderr: (result.stderr ?? '').trim().slice(0, 200) });
  }
  return result;
}

/**
 * Which of these objects the repository actually holds.
 *
 * Asked rather than assumed: a composition recorded against an object that was
 * since pruned is a record pointing at nothing, and `baseAdmission` refuses on
 * exactly that.
 */
export async function objectsPresent(git, oids) {
  const present = new Set();
  for (const oid of new Set(oids.filter(Boolean))) {
    const result = await git(['cat-file', '-e', oid]);
    if (result.code === 0) present.add(oid);
  }
  return present;
}

/**
 * Builds the composition in the recorded order.
 *
 * Two predecessors that write the same path with the same bytes are one
 * change made twice, and compose. Two that write it differently do not, and
 * that is a refusal rather than a last-writer-wins tree — the loser's PASS was
 * about content this base would not contain.
 */
export async function composeBase(git, { planningHead, predecessors, order, indexFile, realpath, identity }) {
  await assertIndexOutsideProject(git, { indexFile, realpath });
  const env = { GIT_INDEX_FILE: indexFile };
  const byId = new Map(predecessors.map((predecessor) => [predecessor.ticket_id, predecessor]));
  const written = new Map();

  try {
    await ask(git, ['read-tree', planningHead], { env });
    for (const id of order) {
      const predecessor = byId.get(id);
      demand(predecessor !== undefined, 'missing_predecessor_binding',
        'The composition order names a predecessor that was not supplied', { ticket_id: id });
      for (const entry of predecessor.entries ?? []) {
        const previous = written.get(entry.path);
        if (previous && (previous.new_blob !== entry.new_blob || previous.new_mode !== entry.new_mode)) {
          return Object.freeze({
            ok: false,
            reason: 'incompatible_overlapping_deltas',
            detail: `${entry.path}: ${previous.ticket_id} and ${id} differ`,
          });
        }
        if (entry.status === 'D') {
          await ask(git, ['update-index', '--force-remove', '--', entry.path], { env });
        } else {
          if (entry.status === 'R') {
            await ask(git, ['update-index', '--force-remove', '--', entry.from_path], { env });
          }
          await ask(git, [
            'update-index', '--add', '--cacheinfo', `${entry.new_mode},${entry.new_blob},${entry.path}`,
          ], { env });
        }
        written.set(entry.path, { ...entry, ticket_id: id });
      }
    }
    const tree = await ask(git, ['write-tree'], { env });
    const commit = await ask(git, ['commit-tree', tree.stdout.trim(), '-p', planningHead, '-m', identity.message], {
      env: {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_AUTHOR_DATE: identity.date,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
        GIT_COMMITTER_DATE: identity.date,
      },
    });
    return Object.freeze({
      ok: true,
      tree_oid: tree.stdout.trim(),
      commit_oid: commit.stdout.trim(),
      composed: immutable([...order]),
    });
  } catch (error) {
    // A composition that could not be built is reported as one, with what git
    // said about it — never as a base that is simply different.
    if (error?.code === 'missing_predecessor_binding') throw error;
    return Object.freeze({ ok: false, reason: 'composition_failed', detail: error?.message ?? String(error) });
  }
}

/**
 * The tree a composition produces, without keeping it.
 *
 * Used to answer whether a recorded base still recomputes: the digest binds the
 * tree, so a base whose predecessors now compose to another tree is a base
 * about a tree that no longer exists.
 */
export async function recomposedTree(git, options) {
  const built = await composeBase(git, options);
  return built.ok ? built.tree_oid : null;
}
