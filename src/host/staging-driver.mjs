/** The staging ref and the final CAS, performed against a real repository.
 *
 * #9 decides; this file does. The split matters because the interesting
 * failures here are not decisions at all — they are the moment between reading
 * a ref and writing it, the difference between a branch that is back by name
 * and one that never left, and a git that could not run being reported as a
 * product failure.
 *
 * Every git invocation is injected, so the same driver runs against a real
 * repository and against a fixture. Nothing here re-decides what #9 already
 * decided: the driver produces observations and performs writes, and the guards
 * say what they mean.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

/** The private ref an Epic accumulates on. Never a branch the user can see. */
export function stagingRef(epicId) {
  demand(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(epicId ?? ''), 'cas_conflict',
    'An Epic id has to be a single ref component', { epic_id: epicId });
  return `refs/autosk/epics/${epicId}/staging`;
}

/**
 * One git invocation.
 *
 * A non-zero exit from a command that was supposed to answer a question is an
 * environment failure, not a statement about the product — the one distinction
 * #9 refuses to let the gate blur.
 */
async function ask(git, args, { tolerate = [] } = {}) {
  const result = await git(args);
  if (result.code !== 0 && !tolerate.includes(result.code)) {
    demand(false, 'environment_failure', `git ${args[0]} exited ${result.code}`,
      { args: immutable([...args]), stderr: (result.stderr ?? '').trim().slice(0, 200) });
  }
  return result;
}

/** The OID a ref holds, or null when it holds nothing. */
export async function readRef(git, ref) {
  const result = await ask(git, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { tolerate: [1] });
  const oid = result.stdout.trim();
  return oid.length === 40 ? oid : null;
}

/** How many entries a ref's reflog holds. Counted, never assumed. */
export async function reflogDepth(git, ref) {
  const result = await ask(git, ['reflog', 'show', '--format=%H', ref], { tolerate: [1, 128] });
  return result.stdout.split('\n').filter((line) => line.trim().length === 40).length;
}

/**
 * Creates the staging ref at the recorded base.
 *
 * `update-ref` with an old value of the empty string means *must not exist*, so
 * two Epics racing to create the same staging ref is a conflict git reports
 * rather than a window this code has to reason about.
 */
export async function createStaging(git, { epicId, base }) {
  const ref = stagingRef(epicId);
  // `--create-reflog` because git keeps reflogs only for refs under
  // `refs/heads`, `refs/remotes`, `refs/notes` and HEAD. A staging ref with no
  // reflog cannot answer the one question the post-CAS check asks it — whether
  // the ref moved once — and asking the operator to set
  // `core.logAllRefUpdates` would change how their whole repository behaves.
  const result = await git(['update-ref', '--create-reflog', ref, base, '']);
  if (result.code === 0) return Object.freeze({ ref, oid: base, created: true });
  const held = await readRef(git, ref);
  if (held === base) {
    // The same ref at the same base is the operation already having happened,
    // which is what a retry after a crash looks like.
    return Object.freeze({ ref, oid: held, created: false });
  }
  demand(false, 'cas_conflict', 'The staging ref exists at another commit',
    { ref, expected: base, held });
}

/**
 * Whether a movement is one this Epic can account for.
 *
 * A fast-forward this Epic recorded and a commit someone else pushed look
 * identical as OIDs. The difference is whether the observed commit is one this
 * Epic wrote down — and overwriting a movement nobody can attribute is the one
 * outcome that cannot be undone by retrying.
 */
export async function attributable(git, { observed, recorded }) {
  for (const oid of recorded) {
    const result = await git(['merge-base', '--is-ancestor', observed, oid]);
    if (result.code === 0) return true;
    if (result.code !== 1) {
      demand(false, 'environment_failure', `git merge-base exited ${result.code}`, { observed, oid });
    }
  }
  return false;
}

/**
 * What the target ref currently is, in the shape #9's guards consume.
 *
 * `reflog_entries` is a delta, not a total: a long-lived branch has a long
 * reflog and that says nothing about this operation. What the guards ask is
 * whether the ref moved once during the window, and that is the difference
 * between the depth before and the depth now.
 */
export async function observeTarget(git, { ref, recorded = [], recordedResult, reflogBefore = 0 }) {
  const oid = await readRef(git, ref);
  demand(oid !== null, 'environment_failure', 'The target ref does not exist', { ref });
  const tree = await ask(git, ['rev-parse', `${oid}^{tree}`]);
  const depth = await reflogDepth(git, ref);
  const observation = {
    oid,
    tree_oid: tree.stdout.trim(),
    reflog_entries: depth - reflogBefore,
    attributed_to_this_epic: await attributable(git, { observed: oid, recorded }),
  };
  if (recordedResult) {
    const contained = await git(['merge-base', '--is-ancestor', recordedResult, oid]);
    if (contained.code !== 0 && contained.code !== 1) {
      demand(false, 'environment_failure', `git merge-base exited ${contained.code}`, { ref, oid });
    }
    observation.contains_recorded_result = contained.code === 0;
  }
  return Object.freeze(observation);
}

/**
 * The one movement of the target ref.
 *
 * The compare-and-swap is git's, not this file's: `update-ref <ref> <new>
 * <old>` fails if the ref does not hold `<old>` at write time. Reading the ref
 * and then writing it would leave exactly the window this issue exists to
 * close, and would pass every test that does not race.
 *
 * The result is a record for `applySwap`, which decides what it means.
 */
export async function swapTarget(git, { ref, expectedOld, newOid }) {
  const result = await git(['update-ref', '--create-reflog', ref, newOid, expectedOld]);
  if (result.code === 0) {
    return Object.freeze({ swapped: true, expected_old_oid: expectedOld, new_oid: newOid });
  }
  // Refused. What the ref holds now is read afterwards and reported as an
  // observation, not as the reason: the reason is that the swap did not happen.
  const held = await readRef(git, ref);
  return Object.freeze({
    swapped: false,
    expected_old_oid: expectedOld,
    new_oid: newOid,
    observed_old_oid: held,
  });
}

/**
 * Removes the staging ref, and only when it still holds what was recorded.
 *
 * Cleanup that deletes whatever is there would destroy the evidence in exactly
 * the case worth keeping: a staging ref that moved after the aggregate passed.
 */
export async function cleanupStaging(git, { epicId, expectedOid }) {
  const ref = stagingRef(epicId);
  const result = await git(['update-ref', '-d', ref, expectedOid]);
  if (result.code === 0) return Object.freeze({ ref, deleted: true });
  const held = await readRef(git, ref);
  return Object.freeze({ ref, deleted: false, reason: 'staging_moved_after_pass', held });
}
