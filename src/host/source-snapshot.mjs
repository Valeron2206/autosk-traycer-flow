/** Immutable snapshots of external sources (#21).
 *
 * A verdict is about bytes. If the bytes a review read can change afterwards
 * without anyone noticing, the verdict is about nothing in particular — so a
 * normative external input is snapshotted, and the snapshot is what the review
 * is bound to.
 *
 * Two rules here look like details and are not: a snapshot may not live in a
 * transient evidence root, because #27's retention would delete the only copy
 * of a normative input; and a corrupt snapshot is repaired from the recorded
 * digest, never re-minted from whatever the live source says now.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

export const SOURCE_KINDS = immutable(['file', 'upload', 'api_export', 'generated_report', 'migration_input']);

export const CLEARANCE_STATES = immutable(['cleared', 'redacted', 'restricted']);

export const LIFECYCLE_STATES = immutable(['present', 'missing', 'deleted', 'superseded']);

export const REFUSALS = immutable([
  'snapshot_source_unavailable',
  'snapshot_source_not_regular',
  'snapshot_identity_uncertain',
  'snapshot_out_of_project',
  'snapshot_read_back_mismatch',
  'snapshot_retention_conflict',
  'snapshot_worktree_dirty',
  'snapshot_clearance_missing',
]);

/**
 * Where a snapshot may live.
 *
 * The transient-evidence rule is the one most likely to be broken by accident,
 * because an evidence directory is exactly where a snapshot looks like it
 * belongs — and then retention deletes the only copy of a normative input.
 */
export function locationErrors(snapshotPath, { transientRoots, worktreeRoots, projectRoot }) {
  const errors = [];
  for (const root of transientRoots) {
    if (snapshotPath === root || snapshotPath.startsWith(`${root}/`)) {
      errors.push({ reason: 'snapshot_retention_conflict', detail: root });
    }
  }
  for (const root of worktreeRoots) {
    if (snapshotPath === root || snapshotPath.startsWith(`${root}/`)) {
      // A snapshot that moves with the work is not a snapshot of anything.
      errors.push({ reason: 'snapshot_retention_conflict', detail: `${root} is the mutable worktree` });
    }
  }
  if (!snapshotPath.startsWith(`${projectRoot}/`)) {
    errors.push({ reason: 'snapshot_out_of_project', detail: snapshotPath });
  }
  return errors;
}

/**
 * Minting a snapshot.
 *
 * The source must be a regular file, the bytes must read back, the worktree
 * under review must stay clean, and a source under another project root needs
 * an explicit import that records the ownership change — reading someone
 * else's file and calling it yours is the failure that prevents.
 */
export function mintErrors(record, { source, worktree, location }) {
  const errors = [];
  if (!SOURCE_KINDS.includes(record.source_kind)) {
    errors.push({ reason: 'snapshot_identity_uncertain', detail: `unknown source kind ${record.source_kind}` });
  }
  if (source.available === false) {
    errors.push({ reason: 'snapshot_source_unavailable', detail: record.locator });
  }
  if (source.regular_file === false) {
    // A symlink, a directory or a device where a file was expected.
    errors.push({ reason: 'snapshot_source_not_regular', detail: record.locator });
  }
  if (record.provenance?.origin === 'imported' && !record.provenance.import_operation_id) {
    errors.push({ reason: 'snapshot_out_of_project', detail: 'an import records the ownership change' });
  }
  if (record.provenance?.owner_project && location.projectIdentity
    && record.provenance.owner_project !== location.projectIdentity
    && record.provenance.origin !== 'imported') {
    errors.push({ reason: 'snapshot_out_of_project', detail: record.provenance.owner_project });
  }
  // Two fields, not one: a snapshot that was never read back proves the write
  // returned, not that the bytes are there.
  if (!record.read_back_sha256) {
    errors.push({ reason: 'snapshot_read_back_mismatch', detail: 'the snapshot was not read back' });
  } else if (record.read_back_sha256 !== record.snapshot_sha256) {
    errors.push({ reason: 'snapshot_read_back_mismatch', detail: record.snapshot_path });
  }
  if (!CLEARANCE_STATES.includes(record.clearance)) {
    // A snapshot nobody may publish is not published by accident.
    errors.push({ reason: 'snapshot_clearance_missing', detail: String(record.clearance) });
  }
  if (worktree.dirty_after_mint) {
    // A mint that changes what is being reviewed has changed the thing it was
    // supposed to describe.
    errors.push({ reason: 'snapshot_worktree_dirty', detail: 'the mint dirtied the worktree under review' });
  }
  errors.push(...locationErrors(record.snapshot_path, location));
  return errors;
}

/**
 * Deduplication by content, with provenance kept apart.
 *
 * Two sources that happen to have the same bytes are still two sources, and
 * collapsing their records would leave a later reader unable to say where
 * either came from.
 */
export function dedupePlan(records) {
  const byDigest = new Map();
  for (const record of records) {
    if (!byDigest.has(record.snapshot_sha256)) byDigest.set(record.snapshot_sha256, []);
    byDigest.get(record.snapshot_sha256).push(record);
  }
  return Object.freeze({
    stored_blobs: immutable([...byDigest.keys()].sort()),
    // One record per source, always.
    provenance_records: immutable(records.map((record) => record.locator).sort()),
    shared: immutable(
      [...byDigest.entries()]
        .filter(([, group]) => group.length > 1)
        .map(([digest, group]) => Object.freeze({ digest, locators: immutable(group.map((r) => r.locator).sort()) })),
    ),
  });
}

/** Binary bytes are hashed without text normalization. */
export function hashingMode(mediaType) {
  // A digest that depends on line endings is not an identity for a PNG.
  return mediaType.startsWith('text/') || mediaType === 'application/json' ? 'utf8_exact' : 'binary_exact';
}

/**
 * The drift guard, run immediately before acceptance.
 *
 * At acceptance rather than at mint, because the window that matters is
 * between reading and deciding.
 */
export function driftOutcome(observation) {
  if (observation.state === 'unchanged') return Object.freeze({ outcome: 'continue' });
  if (observation.state === 'unavailable' || observation.state === 'identity_uncertain') {
    return Object.freeze({
      outcome: 'human',
      reason: observation.state === 'unavailable' ? 'snapshot_source_unavailable' : 'snapshot_identity_uncertain',
    });
  }
  if (observation.state === 'superseded') {
    return Object.freeze({ outcome: 'approved_disposition_and_new_snapshot' });
  }
  if (observation.state === 'changed') {
    if (observation.normative === false) {
      // The row that leaks. "It is only a comment change" is a judgement; a
      // deterministic proof is a rule that produces the same answer for
      // everyone, and without one a non-normative change is treated as a
      // normative one.
      return observation.non_normative_proof
        ? Object.freeze({ outcome: 'continue', basis: observation.non_normative_proof })
        : Object.freeze({ outcome: 'new_anchor_and_full_review', reason: 'unproven_non_normative' });
    }
    return Object.freeze({ outcome: 'new_anchor_and_full_review' });
  }
  return demand(false, 'snapshot_identity_uncertain', 'Unknown drift state', { state: observation.state });
}

/**
 * Repairing a corrupt snapshot.
 *
 * Restored to the recorded digest, never re-minted from the live source:
 * re-minting would silently substitute today's bytes for the ones a verdict was
 * about, which is the failure this contract exists to prevent arriving through
 * the repair path.
 */
export function repairPlan(record, { availableCopies }) {
  const usable = availableCopies.filter((copy) => copy.sha256 === record.snapshot_sha256);
  if (usable.length === 0) {
    return Object.freeze({
      action: 'park',
      reason: 'snapshot_identity_uncertain',
      detail: 'no copy matches the recorded digest, and the live source is not a substitute',
    });
  }
  return Object.freeze({
    action: 'restore_from_recorded_identity',
    from: usable[0].location,
    sha256: record.snapshot_sha256,
  });
}

/** A superseded snapshot names what replaced it. */
export function lifecycleErrors(record) {
  if (!LIFECYCLE_STATES.includes(record.lifecycle)) {
    return [{ reason: 'snapshot_identity_uncertain', detail: `unknown lifecycle ${record.lifecycle}` }];
  }
  if (record.lifecycle === 'superseded' && !record.superseded_by) {
    return [{ reason: 'snapshot_identity_uncertain', detail: 'a superseded snapshot names its successor' }];
  }
  return [];
}
