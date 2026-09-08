/** Epic staging: approved Tickets accumulate privately, and the target moves once.
 *
 * Moving the target once per Ticket looks simpler and is not. Two Tickets that
 * are individually green can regress together, and by the time the second is
 * integrated the first is already on the user's branch. Aggregate verification
 * exists because *individually green* is not a property of the set.
 *
 * Everything here is about one sentence: a PASS is about a tree, not about an
 * intention. Acceptance is of an identity, not of a plan to produce one.
 */
import { createHash } from 'node:crypto';

import { demand, immutable } from '../runtime/contracts.mjs';

export const PHASES = immutable([
  'staging_created',
  'tickets_applied',
  'aggregate_verified',
  'accepted',
  'target_advanced',
  'post_cas_verified',
]);

export const PARK_REASONS = immutable([
  'aggregate_failed',
  'aggregate_binding_void',
  'staging_moved_after_pass',
  'target_moved',
  'foreign_target_movement',
  'acceptance_missing',
  'acceptance_stale',
  'cas_conflict',
  'post_cas_mismatch',
  'environment_failure',
  'receipt_missing',
]);

/**
 * What the aggregate record is bound to.
 *
 * The staging identity plus the configuration and the instruction lock, so a
 * PASS cannot be carried to a tree it was not run on or to a rule set it was
 * not run under.
 */
export function aggregateBinding(state) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        project: state.project_identity,
        epic_id: state.epic_id,
        staging_commit_oid: state.staging_commit_oid,
        staging_tree_oid: state.staging_tree_oid,
        verification_config_digest: state.aggregate?.verification_config_digest,
        instruction_lock_digest: state.aggregate?.instruction_lock_digest,
        tickets: [...(state.receipts ?? [])].map((receipt) => receipt.ticket_id).sort(),
      }),
      'utf8',
    )
    .digest('hex');
}

/**
 * Whether the aggregate still describes what would be pushed.
 *
 * Any change to staging after the PASS voids the binding: the record is about
 * the tree it ran on, and a tree that moved is a different subject.
 */
export function aggregateErrors(state) {
  const errors = [];
  const aggregate = state.aggregate;
  if (!aggregate) return [{ reason: 'aggregate_failed', detail: 'no aggregate record' }];

  // A command failure and an environment failure are different outcomes: only
  // one of them is a statement about the product.
  if (aggregate.environment_outcome === 'environment_failure') {
    errors.push({ reason: 'environment_failure', detail: aggregate.detail ?? 'the machine could not run the checks' });
  } else if (aggregate.outcome !== 'pass') {
    errors.push({ reason: 'aggregate_failed', detail: aggregate.outcome });
  }
  if (aggregate.binding !== aggregateBinding(state)) {
    errors.push({ reason: 'aggregate_binding_void', detail: 'the binding does not recompute' });
  }
  if (aggregate.staging_commit_oid !== state.staging_commit_oid) {
    errors.push({ reason: 'staging_moved_after_pass', detail: state.staging_commit_oid });
  }
  return errors;
}

/** Every applied Ticket leaves a durable receipt, or the set is not what it claims. */
export function receiptErrors(state, expectedTickets) {
  const present = new Set(state.receipts.map((receipt) => receipt.ticket_id));
  return expectedTickets
    .filter((ticket) => !present.has(ticket))
    .map((ticket) => ({ reason: 'receipt_missing', detail: ticket }));
}

/**
 * Whether the acceptance still applies.
 *
 * Acceptance is of an identity: if the staging tree changed afterwards, the
 * acceptance no longer applies to what would be pushed.
 */
export function acceptanceErrors(state) {
  const acceptance = state.acceptance;
  if (!acceptance) return [{ reason: 'acceptance_missing', detail: 'nothing was accepted' }];
  const errors = [];
  if (acceptance.kind === 'auto_policy' && !acceptance.policy_ref) {
    // A pinned auto-policy is held to the same binding as a person.
    errors.push({ reason: 'acceptance_missing', detail: 'an auto-policy names the policy that pinned it' });
  }
  if (acceptance.kind === 'human' && !acceptance.approver) {
    errors.push({ reason: 'acceptance_missing', detail: 'a human acceptance names who accepted' });
  }
  if (acceptance.staging_commit_oid !== state.staging_commit_oid
    || acceptance.staging_tree_oid !== state.staging_tree_oid) {
    errors.push({ reason: 'acceptance_stale', detail: 'the accepted identity is not the current one' });
  }
  if (acceptance.aggregate_record_hash !== state.aggregate?.record_hash) {
    errors.push({ reason: 'acceptance_stale', detail: 'the accepted aggregate record is not the current one' });
  }
  const accepted = [...(acceptance.tickets ?? [])].sort().join(',');
  const included = [...state.receipts.map((receipt) => receipt.ticket_id)].sort().join(',');
  if (accepted !== included) {
    errors.push({ reason: 'acceptance_stale', detail: 'the accepted Ticket set is not the included one' });
  }
  return errors;
}

/**
 * Whether the final CAS may run.
 *
 * There is no per-Ticket intermediate movement of the target — not as an
 * optimisation, not as a fallback — so this is the only place the target moves,
 * and it runs only while the target still holds the recorded base.
 */
export function casAdmission(state, observedTarget, expectedTickets = []) {
  const reasons = [
    ...receiptErrors(state, expectedTickets),
    ...aggregateErrors(state),
    ...acceptanceErrors(state),
  ];
  if (observedTarget.oid === state.post_cas?.expected_new_oid) {
    // Idempotent: if the target already holds the recorded result, the
    // operation is complete rather than in conflict.
    return Object.freeze({ decision: 'already_complete', reasons: immutable(reasons.map(Object.freeze)) });
  }
  if (observedTarget.oid !== state.recorded_target_base) {
    // Two different facts, and the operator does different things about them.
    // A move this Epic can account for — a fast-forward it recorded, an
    // integration it performed — is `target_moved`, and the base is re-recorded
    // before anything else happens. A move nobody can attribute means someone
    // else acted on that branch, and overwriting it is the one outcome that
    // cannot be undone by retrying.
    reasons.push({
      reason: observedTarget.attributed_to_this_epic ? 'target_moved' : 'foreign_target_movement',
      detail: observedTarget.oid,
    });
  }
  return Object.freeze({
    decision: reasons.length === 0 ? 'may_swap' : 'refused',
    reasons: immutable(reasons.map(Object.freeze)),
  });
}

/**
 * What the swap must be able to say afterwards.
 *
 * A CAS that reported success is not evidence that the ref holds what was
 * intended, so the OID, the tree, containment and the reflog are read back.
 */
export function postCasErrors(state, observed) {
  const errors = [];
  if (observed.oid !== state.post_cas.expected_new_oid) {
    errors.push({ reason: 'post_cas_mismatch', detail: `target is ${observed.oid}` });
  }
  if (observed.tree_oid !== state.staging_tree_oid) {
    errors.push({ reason: 'post_cas_mismatch', detail: 'the target tree is not the accepted one' });
  }
  if (observed.contains_recorded_result !== true) {
    errors.push({ reason: 'post_cas_mismatch', detail: 'the recorded result is not contained' });
  }
  if (observed.reflog_entries !== 1) {
    errors.push({ reason: 'post_cas_mismatch', detail: `${observed.reflog_entries} reflog entries` });
  }
  return errors;
}

/**
 * Where a crash resumes.
 *
 * A crash after aggregate PASS and before the CAS resumes without another model
 * run: everything needed is recorded, and re-running a model at that point
 * would produce different bytes and quietly discard an approval that was about
 * the old ones.
 */
export function resumePlan(state) {
  demand(PHASES.includes(state.phase), 'aggregate_binding_void', 'Unknown phase', { phase: state.phase });
  const index = PHASES.indexOf(state.phase);
  return Object.freeze({
    next_phase: index === PHASES.length - 1 ? 'complete' : PHASES[index + 1],
    // The model runs again only while the work is still being produced.
    requires_model_run: index < PHASES.indexOf('aggregate_verified'),
  });
}

/**
 * The swap itself.
 *
 * The compare-and-swap can fail even after admission: the target can move in
 * the window between reading it and writing it, which is precisely why the
 * write is a compare-and-swap and not a write. A conflict here is not a
 * refusal to try — it is the try, reporting that the world moved.
 */
export function applySwap(state, casResult) {
  demand(casResult.expected_old_oid === state.recorded_target_base, 'cas_conflict',
    'The swap was attempted against another base',
    { expected: state.recorded_target_base, attempted: casResult.expected_old_oid });
  if (casResult.swapped) {
    return Object.freeze({ outcome: 'swapped', new_oid: casResult.new_oid });
  }
  return Object.freeze({
    outcome: 'conflict',
    reason: 'cas_conflict',
    detail: `the ref held ${casResult.observed_old_oid} at write time`,
  });
}

/**
 * An integration-fix Ticket is a Ticket.
 *
 * Its own id, its own acceptance criteria, and the ordinary verify, freeze and
 * review — not a patch applied under someone else's approval.
 */
export function integrationFixErrors(ticket, parent) {
  const errors = [];
  if (!ticket.ticket_id || ticket.ticket_id === parent.ticket_id) {
    errors.push({ reason: 'receipt_missing', detail: 'an integration fix has its own Ticket id' });
  }
  if (!ticket.acceptance_criteria || ticket.acceptance_criteria.length === 0) {
    errors.push({ reason: 'receipt_missing', detail: 'an integration fix has its own acceptance criteria' });
  }
  if (!ticket.manifest_overlay && !ticket.manifest_revision) {
    errors.push({ reason: 'receipt_missing', detail: 'an integration fix enters the manifest' });
  }
  if (ticket.reused_approval_of) {
    errors.push({ reason: 'acceptance_stale', detail: 'an integration fix is not applied under another approval' });
  }
  return errors;
}
