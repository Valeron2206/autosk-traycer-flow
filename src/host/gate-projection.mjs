/** The gate projection: what may not move during a run, and who moved the rest.
 *
 * A read-only reviewer is protected by comparing store state before and after
 * its run, and both obvious comparisons are wrong. Hashing everything rejects a
 * reviewer's answer because another seat finished while it was working — four
 * seats run in parallel, which is not an edge case but the normal shape of a
 * Panel. Hashing too little lets a driver change the controlling anchor and
 * nothing notices.
 *
 * So the comparison is over a declared projection, plus a provenance check on
 * everything outside it. Both halves are here; neither is sufficient alone.
 */
import { createHash } from 'node:crypto';

import { demand, immutable } from '../runtime/contracts.mjs';

/** Hashed into the projection digest. Anything here moving means the run
 * answered a different question than the one asked. */
export const PROJECTED_FIELDS = immutable([
  'project_binding',
  'parent_child_relation',
  'run',
  'round',
  'attempt',
  'seat',
  'role',
  'artifact_identity',
  'candidate_identity',
  'base_hashes',
  'anchor_version',
  'protocol_lock',
  'runtime_lock',
  'instruction_lock',
  'creation_binding',
  'provider_session_binding',
  'reviewer_routing',
  'author_family',
  'fixer_family',
  'expected_blocker',
  'allowed_transitions',
  'result_schema',
  'accepted_findings',
]);

/**
 * May change during a run and on their own never invalidate a verdict.
 *
 * "On their own" is doing real work: a field here is exempt from the projection
 * hash and still needs provenance. It is not a licence.
 */
export const CONCURRENT_FIELDS = immutable([
  'autoskd_status',
  'autoskd_step',
  'timestamps',
  'worker_lease',
  'worker_activity',
  'engine_counters',
  'session_append_progress',
  'sibling_result',
  'sibling_terminal_status',
  'daemon_retry',
  'daemon_heartbeat',
]);

export const ACTORS = immutable(['daemon', 'driver', 'user', 'model', 'tool']);

export const PARK_REASONS = immutable([
  'projection_changed',
  'unknown_writer',
  'missing_provenance',
  'field_not_permitted',
  'frozen_prefix_modified',
  'projection_version_mismatch',
  'cross_project_record',
  'provenance_out_of_order',
]);

/**
 * The canonical form the digest is taken over.
 *
 * Object keys sorted and set-like arrays sorted, so two stores that differ only
 * in JSON key order produce the same digest. Timestamps outside the projection
 * are excluded rather than normalised: normalising them would mean deciding
 * they are equal, and they are simply not part of the question.
 */
export function canonical(value) {
  if (Array.isArray(value)) {
    const parts = value.map(canonical);
    return `[${[...parts].sort().join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The digest over exactly the declared fields, in a fixed order. */
export function projectionDigest(state, projectedFields = PROJECTED_FIELDS) {
  const projected = {};
  for (const field of [...projectedFields].sort()) {
    demand(PROJECTED_FIELDS.includes(field), 'projection_version_mismatch',
      'A projected field is not part of this projection version', { field });
    projected[field] = state[field] ?? null;
  }
  return createHash('sha256').update(canonical(projected), 'utf8').digest('hex');
}

/** The fields that actually differ between two states, projected or not. */
export function changedFields(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => canonical(before[key] ?? null) !== canonical(after[key] ?? null))
    .sort();
}

/**
 * The frozen prefix of a comments file.
 *
 * A sibling's `comments.jsonl` may not be compared as one hash: appends are the
 * normal traffic of a running Panel. The prefix up to the controlling
 * checkpoint is hashed and must not change; what follows may grow. An append
 * that rewrites earlier bytes is not an append, and this is what makes that
 * statement checkable.
 */
export function frozenPrefixDigest(lines, checkpoint) {
  demand(Number.isInteger(checkpoint) && checkpoint >= 0 && checkpoint <= lines.length,
    'frozen_prefix_modified', 'The checkpoint is outside the comments file',
    { checkpoint, lines: lines.length });
  return createHash('sha256').update(lines.slice(0, checkpoint).join('\n'), 'utf8').digest('hex');
}

/**
 * Checks the journal covers every out-of-projection change.
 *
 * The default is refusal: a change nobody claims is not assumed to be the
 * daemon's. That is the case a driver bug produces — an allowed-looking field
 * written by nobody in particular.
 */
export function provenanceErrors(journal, changed, { projectBinding }) {
  const errors = [];
  const claimed = new Map();
  let previousSequence = 0;
  for (const record of journal) {
    if (!ACTORS.includes(record.actor)) {
      errors.push({ reason: 'unknown_writer', detail: record.actor, operation_id: record.operation_id });
      continue;
    }
    if (record.project_binding !== projectBinding) {
      // Not "extra state to hash": a record that should not have been visible.
      errors.push({ reason: 'cross_project_record', detail: record.project_binding, operation_id: record.operation_id });
      continue;
    }
    if (record.sequence <= previousSequence) {
      errors.push({ reason: 'provenance_out_of_order', detail: String(record.sequence), operation_id: record.operation_id });
    }
    previousSequence = Math.max(previousSequence, record.sequence);
    for (const field of record.changed_fields) {
      if (!record.permitted_fields.includes(field)) {
        errors.push({ reason: 'field_not_permitted', detail: field, operation_id: record.operation_id });
        continue;
      }
      claimed.set(field, record.operation_id);
    }
  }
  for (const field of changed) {
    if (!claimed.has(field)) {
      errors.push({ reason: 'missing_provenance', detail: field, operation_id: null });
    }
  }
  return errors;
}

/**
 * Accepts a gate run, or refuses it with every reason.
 *
 * A projection change is a **blocking non-verdict**, not a pass, a fail or a
 * retry: the same question has to be asked again from a known state, and
 * calling it a retry would let the second answer inherit the first's authority.
 */
export function evaluateRun({ before, after, journal, projectedFields, projectionVersion, runVersion, comments }) {
  demand(projectionVersion === runVersion, 'projection_version_mismatch',
    'The run started under another projection version',
    { started: runVersion, evaluating: projectionVersion });

  const reasons = [];
  const digestBefore = projectionDigest(before, projectedFields);
  const digestAfter = projectionDigest(after, projectedFields);
  if (digestBefore !== digestAfter) {
    const moved = changedFields(before, after).filter((field) => projectedFields.includes(field));
    for (const field of moved) reasons.push({ reason: 'projection_changed', detail: field });
  }

  if (comments) {
    const prefixBefore = frozenPrefixDigest(comments.before, comments.checkpoint);
    const prefixAfter = frozenPrefixDigest(comments.after, comments.checkpoint);
    if (prefixBefore !== prefixAfter) {
      reasons.push({ reason: 'frozen_prefix_modified', detail: `checkpoint ${comments.checkpoint}` });
    }
  }

  const outside = changedFields(before, after).filter((field) => !projectedFields.includes(field));
  reasons.push(...provenanceErrors(journal, outside, { projectBinding: before.project_binding }));

  return Object.freeze({
    verdict: reasons.length === 0 ? 'accepted' : 'blocking_non_verdict',
    projection_digest_before: digestBefore,
    projection_digest_after: digestAfter,
    reasons: reasons.map((entry) => Object.freeze({ ...entry })),
  });
}
