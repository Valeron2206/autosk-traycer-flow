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
 * decided: the driver produces observations and asks for writes, and the
 * guards say what they mean.
 *
 * The staging ref is under `refs/autosk/**`, so this file does not write it:
 * the separate-account ref-custody helper does, on the host's request through
 * `askCustody` (ADR-095). `swapTarget` stays here as the target-CAS mechanics
 * the daemon's `integrateApproved` adapter carries; no host code calls it.
 */
import { createHash } from 'node:crypto';

import { demand, immutable, oidFormat } from '../runtime/contracts.mjs';

import { NO_REF_CUSTODY, askCustody } from './ref-custody.mjs';

/**
 * The key an Epic's private refs are named by: the domain-separated SHA-256 of
 * the canonical `{epic_id, project_root_sha256}`, in lowercase hex. It is the
 * derivation `docs/contracts/epic-planning-ref.md` gives the planning ref, so
 * the planning and staging refs of one Epic sit under one name, and two
 * projects that both call an Epic `e-1` never share one. The expected-old CAS
 * compares the ref name byte for byte, which is why the spelling is fixed here.
 */
export function epicRefKey(projectRootSha256, epicId) {
  demand(/^[0-9a-f]{64}$/u.test(projectRootSha256 ?? '') && typeof epicId === 'string' && epicId.length > 0,
    'cas_conflict', 'An Epic ref key needs a project root digest and an Epic id',
    { project_root_sha256: projectRootSha256, epic_id: epicId });
  const canonical = `{"epic_id":${JSON.stringify(epicId)},"project_root_sha256":${JSON.stringify(projectRootSha256)}}`;
  return createHash('sha256').update(`autosk-flow/epic-ref-key/v1\0${canonical}`, 'utf8').digest('hex');
}

/**
 * The private ref an Epic accumulates on. Never a branch the user can see, and
 * never named by a display id: only an `epicRefKey` names it.
 */
export function stagingRef(key) {
  demand(/^[0-9a-f]{64}$/u.test(key ?? ''), 'cas_conflict',
    'A staging ref is named by the Epic ref key, 64 lowercase hex characters', { epic_ref_key: key });
  return `refs/autosk/epics/${key}/staging`;
}

/**
 * Refuses any ref but an Epic's private staging ref.
 *
 * An apply asks the helper to advance the staging ref and nothing else: the
 * daemon's `integrateApproved` is the only writer of an Epic's or a Quick run's
 * target ref (ADR-088), and the helper the only writer under `refs/autosk/**`
 * (ADR-095). An apply pointed at the user's branch would ask for a second
 * writer of it, and one that holds no authorization.
 */
export function assertStagingRef(ref) {
  demand(typeof ref === 'string' && /^refs\/autosk\/epics\/[0-9a-f]{64}\/staging$/u.test(ref), 'cas_conflict',
    'The host moves only an Epic\'s private staging ref', { ref });
  return ref;
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

/**
 * The OID a ref holds, or null when it holds nothing. The OID is read in
 * either object format, 40 hex (sha1) or 64 (sha256): in a SHA-256
 * repository a present ref is not an absent one (ADR-098).
 */
export async function readRef(git, ref) {
  const result = await ask(git, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { tolerate: [1] });
  const oid = result.stdout.trim();
  return oidFormat(oid) === null ? null : oid;
}

/** How many entries a ref's reflog holds, in either object format. Counted, never assumed. */
export async function reflogDepth(git, ref) {
  const result = await ask(git, ['reflog', 'show', '--format=%H', ref], { tolerate: [1, 128] });
  return result.stdout.split('\n').filter((line) => oidFormat(line.trim()) !== null).length;
}

/**
 * Creates the staging ref at `base`: for an Epic, the verified planning head,
 * which descends from the recorded target base the final CAS expects (or, after
 * a re-stage, the new `recorded_target_base`, whose first commit is one
 * receipted planning replay commit) (ADR-088).
 *
 * The helper's `create_staging` is an update at an expected-absent ref, so two
 * Epics racing to create the same staging ref is a conflict the helper reports
 * rather than a window this code has to reason about. The helper creates the
 * ref's reflog, because the post-CAS check asks the ref whether it moved once.
 */
export async function createStaging(custody = NO_REF_CUSTODY, { epicRefKey: key, base }) {
  const ref = stagingRef(key);
  const answer = await askCustody(custody, 'create_staging',
    [{ operation: 'update', ref, expected_old_oid: null, new_oid: base }]);
  if (answer.status === 'committed') return Object.freeze({ ref, oid: base, created: true });
  const held = answer.ref_observations[0].observed_old_oid;
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
 * The expected-old compare-and-swap of one ref.
 *
 * This is the mechanics, not the authority. The daemon's
 * `integrateApproved` is the only writer of an Epic's or a Quick run's target
 * ref, under the project mutex and an `IntegrationAuthorizationRecord`
 * (ADR-088); this is the verified CAS/reflog logic ADR-012 carries into the
 * autosk-owned adapter it calls. No host code calls it: the staging ref is the
 * ref-custody helper's to move (ADR-095), and a test keeps both the empty
 * caller inventory and this function as the one place under `src/` that runs
 * `update-ref`.
 *
 * The compare-and-swap is git's, not this file's: `update-ref <ref> <new>
 * <old>` fails if the ref does not hold `<old>` at write time. Reading the ref
 * and then writing it would leave exactly the window this issue exists to
 * close, and would pass every test that does not race.
 *
 * The result is a record for `applySwap`, which decides what it means.
 */
export async function swapTarget(git, { ref, expectedOld, newOid }) {
  // A ref under refs/autosk/** has one writer, the ref-custody helper
  // (ADR-095); these mechanics move a target ref and nothing under it.
  demand(typeof ref === 'string' && !ref.startsWith('refs/autosk/'), 'cas_conflict',
    'refs/autosk/** is the ref-custody helper\'s to write', { ref });
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
 * The helper's `delete_staging` deletes by expected OID, and its refusal says
 * what the ref holds instead.
 */
export async function cleanupStaging(custody = NO_REF_CUSTODY, { epicRefKey: key, expectedOid }) {
  const ref = stagingRef(key);
  const answer = await askCustody(custody, 'delete_staging',
    [{ operation: 'delete', ref, expected_old_oid: expectedOid, new_oid: null }]);
  if (answer.status === 'committed') return Object.freeze({ ref, deleted: true });
  const held = answer.ref_observations[0].observed_old_oid;
  return Object.freeze({ ref, deleted: false, reason: 'staging_moved_after_pass', held });
}
