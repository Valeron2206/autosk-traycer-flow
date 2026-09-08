/** Evidence durability, harness proof and retention (#27).
 *
 * Two rules do most of the work here. Durability is derived from the class,
 * because otherwise "this one is durable" becomes something a producer can
 * assert about a class the policy says is transient. And a record that was cut
 * to fit and does not say so is a diagnostic that reads as complete, which is
 * worse than a missing one — the reader has no reason to doubt it.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

/** Durability is a property of the class, never a per-record opinion. */
export const CLASS_DURABILITY = Object.freeze({
  verdict: 'durable',
  verification: 'durable',
  verification_harness_run: 'durable',
  restoration_receipt: 'durable',
  mutation_fixture: 'transient',
  temporary_harness_source: 'transient',
  temporary_harness_binary: 'transient',
  integration_receipt: 'durable',
  protocol_runtime_instruction_lock: 'durable',
  human_approval_waiver: 'durable',
  provider_raw_output: 'restricted',
  temporary_log: 'expirable',
  screenshot: 'expirable',
  profile: 'expirable',
  worktree_trace: 'expirable',
  quarantined_sensitive: 'restricted',
});

/** Outcomes that are not a product PASS and may not be rolled into one. */
export const NON_PRODUCT_OUTCOMES = immutable([
  'mutation_not_applied',
  'green_control_failed',
  'tool_error',
  'tool_timeout',
  'restore_failed',
  'timeout',
  'indeterminate',
]);

/** What a harness run must prove before its outcome means anything. */
export const HARNESS_PROOFS = immutable([
  'mutation_application_proof',
  'expected_killer',
  'observed_red_signature',
  'green_controls',
  'before_identity',
  'after_identity',
  'restore_receipt',
]);

export const REFUSALS = immutable([
  'evidence_class_durability_conflict',
  'evidence_referenced_deletion',
  'evidence_missing_durable',
  'evidence_corrupt',
  'evidence_truncated_as_complete',
  'evidence_cross_project_path',
  'evidence_retention_retroactive',
  'evidence_unredactable',
  'evidence_restore_unverified',
  'evidence_tool_outcome_as_product',
]);

/** Durability derived from the class, and a record that disagrees is refused. */
export function durabilityErrors(record) {
  const expected = CLASS_DURABILITY[record.class];
  if (!expected) {
    return [{ reason: 'evidence_class_durability_conflict', detail: `unknown class ${record.class}` }];
  }
  if (record.durability !== expected) {
    return [{
      reason: 'evidence_class_durability_conflict',
      detail: `${record.class} is ${expected}, recorded ${record.durability}`,
    }];
  }
  return [];
}

/**
 * A record that was cut to fit says so, and says how big it was.
 *
 * One field too many only if truncation never happens.
 */
export function truncationErrors(record) {
  if (!record.truncated) return [];
  const errors = [];
  if (!Number.isInteger(record.original_size_bytes)) {
    errors.push({ reason: 'evidence_truncated_as_complete', detail: 'no original size recorded' });
  } else if (record.original_size_bytes <= record.size_bytes) {
    errors.push({
      reason: 'evidence_truncated_as_complete',
      detail: `original ${record.original_size_bytes} is not larger than stored ${record.size_bytes}`,
    });
  }
  if (!record.truncation_policy) {
    errors.push({ reason: 'evidence_truncated_as_complete', detail: 'no truncation policy recorded' });
  }
  return errors;
}

/** A path that leaves the project is not evidence about this project. */
export function pathErrors(record, projectRoot) {
  if (!record.path.startsWith(`${projectRoot}/`) && !record.path.startsWith('.autosk')) {
    return [{ reason: 'evidence_cross_project_path', detail: record.path }];
  }
  return [];
}

/**
 * A harness run proves it ran.
 *
 * Storing only a final PASS is refused: a PASS with no proof that the mutation
 * was applied, that the killer fired, that the green controls passed and that
 * the original state was restored is a claim about a run nobody can distinguish
 * from a run that did nothing.
 */
export function harnessRunErrors(run) {
  const errors = [];
  for (const proof of HARNESS_PROOFS) {
    if (run[proof] === undefined || run[proof] === null) {
      errors.push({ reason: 'evidence_corrupt', detail: `missing ${proof}` });
    }
  }
  for (const field of ['batch_contract_digest', 'harness_source_digest', 'mutation_set_digest']) {
    if (!run[field]) errors.push({ reason: 'evidence_corrupt', detail: `missing ${field}` });
  }
  // Tool and environment failures are recorded separately from product
  // outcomes: a harness that could not run is not a product that passed.
  if (NON_PRODUCT_OUTCOMES.includes(run.batch_outcome) && run.product_outcome === 'pass') {
    errors.push({
      reason: 'evidence_tool_outcome_as_product',
      detail: `${run.batch_outcome} recorded alongside a product pass`,
    });
  }
  return errors;
}

/**
 * The cleanup plan.
 *
 * The reference inventory is built first: deleting before knowing what points
 * at what is how a PASS loses its evidence.
 */
export function cleanupPlan(records, { references, nowMs, policy }) {
  demand(references instanceof Set, 'evidence_referenced_deletion',
    'The reference inventory is built before anything is deleted');
  const deletable = [];
  const kept = [];
  for (const record of records) {
    const durability = CLASS_DURABILITY[record.class];
    if (references.has(record.evidence_id)) {
      // Active or referenced evidence is never deleted, whatever its class says.
      kept.push({ evidence_id: record.evidence_id, reason: 'referenced' });
      continue;
    }
    if (durability === 'durable' || durability === 'restricted') {
      kept.push({ evidence_id: record.evidence_id, reason: 'durable_class' });
      continue;
    }
    if (record.class === 'temporary_harness_source' || record.class === 'temporary_harness_binary') {
      // An ephemeral harness is not deleted until the restore is verified and a
      // durable receipt exists.
      if (record.restore_verified !== true || !record.restore_receipt_id) {
        kept.push({ evidence_id: record.evidence_id, reason: 'restore_unverified' });
        continue;
      }
    }
    if (record.expires_at && Date.parse(record.expires_at) > nowMs) {
      kept.push({ evidence_id: record.evidence_id, reason: 'not_expired' });
      continue;
    }
    deletable.push(record.evidence_id);
  }
  return Object.freeze({
    // Through the safe adapter, never an ordinary unlink.
    adapter: policy?.adapter ?? 'safe_project_fs',
    delete: immutable(deletable.sort()),
    keep: immutable(kept.map(Object.freeze)),
  });
}

/** Evidence may go away; it may not go away silently. */
export function tombstoneFor(record, { reason, nowMs, actor, operationId }) {
  demand(typeof reason === 'string' && reason.length > 0, 'evidence_referenced_deletion',
    'A deletion records why');
  demand(Boolean(actor) && Boolean(operationId), 'evidence_referenced_deletion',
    'A deletion records who and which operation');
  return Object.freeze({
    evidence_id: record.evidence_id,
    hash: record.hash,
    reason,
    deleted_at: new Date(nowMs).toISOString(),
    actor,
    operation_id: operationId,
  });
}

/**
 * Retention is pinned per Epic, and a change is a versioned decision.
 *
 * A shorter retention may not be applied to evidence produced under a longer
 * one — that would delete, retroactively, what someone was promised would keep.
 */
export function retentionChangeErrors(previous, next) {
  const errors = [];
  if (!next.decision_ref) {
    errors.push({ reason: 'evidence_retention_retroactive', detail: 'a retention change is a recorded decision' });
  }
  if (next.horizon_ms < previous.horizon_ms && next.applies_to !== 'evidence_produced_after_change') {
    errors.push({
      reason: 'evidence_retention_retroactive',
      detail: 'a shorter retention may not reach evidence produced under the longer one',
    });
  }
  return errors;
}

/** An artifact that cannot be redacted is not stored at all. */
export function storageDecision(candidate) {
  if (candidate.redactable === false) {
    // The escalation is a decision, not a quiet write.
    return Object.freeze({ store: false, reason: 'evidence_unredactable', escalate: true });
  }
  if (candidate.class === 'quarantined_sensitive' && !candidate.decision_ref) {
    return Object.freeze({ store: false, reason: 'evidence_unredactable', escalate: true });
  }
  return Object.freeze({ store: true });
}

/** Missing durable evidence invalidates the gate that depended on it. */
export function dependentGateErrors(gate, presentIds) {
  return (gate.evidence_ids ?? [])
    .filter((id) => !presentIds.has(id))
    .map((id) => ({ reason: 'evidence_missing_durable', detail: id }));
}

/** A failed restore keeps its diagnostics and forbids ordinary cleanup. */
export function restoreFailureHold(records) {
  const failed = records.some((record) => record.batch_outcome === 'restore_failed');
  if (!failed) return Object.freeze({ hold: false });
  return Object.freeze({
    hold: true,
    reason: 'evidence_restore_unverified',
    detail: 'ordinary cleanup is forbidden until a recovery decision',
  });
}
