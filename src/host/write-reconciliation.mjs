/** Quarantine and four-source reconciliation for artifact write receipts (#22).
 *
 * Four sources can disagree about one artifact: the canonical bytes on disk,
 * the task metadata, the receipt, and temporary model output. Choosing the most
 * recent one is choosing whichever process happened to finish last — which is
 * exactly the failure being diagnosed. So a divergence parks the workflow with
 * a report naming every source, including the ones that agreed.
 *
 * A report that lists only the odd one out cannot be checked by a reader who
 * does not already know the answer.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

/** The four, in a fixed order so two reports of one divergence read the same. */
export const SOURCES = immutable(['canonical_bytes', 'task_metadata', 'receipt', 'model_output']);

export const RECONCILIATION_STATES = immutable(['unreconciled', 'agreed', 'diverged']);

/** Human dispositions. There is no automatic release. */
export const DISPOSITIONS = immutable(['pending', 'inspect', 'transform', 'reject', 'restore']);

export const QUARANTINE_REASONS = immutable([
  'oversized',
  'not_regular_file',
  'malformed_for_class',
  'policy_undetermined',
]);

export const REFUSALS = immutable([
  'write_destination_invalid',
  'write_previous_mismatch',
  'write_not_regular',
  'write_too_large',
  'write_readback_mismatch',
  'write_mode_mismatch',
  'write_helper_unavailable',
  'write_out_of_scope',
  'receipt_stale_pending',
]);

/**
 * Whether an artifact must be held rather than published.
 *
 * Oversized, special, malformed for its class, or a policy nobody could
 * determine — none of those is a pass. The source is not destroyed: a
 * quarantine that deletes what it could not classify is a data-loss path
 * wearing a safety name.
 */
export function quarantineDecision(candidate, policy) {
  const reasons = [];
  if (candidate.size_bytes > policy.max_bytes) reasons.push('oversized');
  if (!candidate.regular_single_linked) reasons.push('not_regular_file');
  if (candidate.class_valid === false) reasons.push('malformed_for_class');
  if (candidate.policy_known === false) reasons.push('policy_undetermined');
  if (reasons.length === 0) return Object.freeze({ state: 'none' });
  demand(typeof candidate.quarantine_path === 'string' && candidate.quarantine_path.length > 0,
    'write_destination_invalid', 'A held artifact needs a quarantine path', { path: candidate.path });
  demand(candidate.quarantine_path !== candidate.path, 'write_destination_invalid',
    'The quarantine path is never a canonical artifact path', { path: candidate.path });
  return Object.freeze({
    state: 'held',
    reason: reasons[0],
    reasons: immutable(reasons),
    path: candidate.quarantine_path,
    // Pending until a human records one: every automatic release is a policy
    // decision made without the person who owns the consequence.
    disposition: 'pending',
  });
}

/** Applies a human disposition to a held artifact. */
export function applyDisposition(quarantine, disposition, { by }) {
  demand(quarantine.state === 'held', 'write_destination_invalid',
    'Only a held artifact takes a disposition');
  demand(DISPOSITIONS.includes(disposition) && disposition !== 'pending',
    'write_destination_invalid', 'Unknown disposition', { disposition });
  demand(typeof by === 'string' && by.length > 0, 'write_destination_invalid',
    'A disposition names who made it');
  return Object.freeze({ ...quarantine, disposition, disposed_by: by });
}

/**
 * Compares the four sources.
 *
 * A source that was not observed is `unknown`, and an unknown source is not
 * agreement: the comparison has not been made for it, which is a different
 * fact from having been made and matched.
 */
export function reconcile(observations) {
  const report = SOURCES.map((source) => ({
    source,
    // Every source is named, including the ones that agreed.
    state: Object.hasOwn(observations, source) ? 'observed' : 'unknown',
    digest: observations[source] ?? null,
  }));
  const observed = report.filter((entry) => entry.state === 'observed');
  if (observed.length < SOURCES.length) {
    return Object.freeze({ state: 'unreconciled', report: immutable(report.map(Object.freeze)) });
  }
  const digests = new Set(observed.map((entry) => entry.digest));
  if (digests.size === 1) {
    return Object.freeze({ state: 'agreed', report: immutable(report.map(Object.freeze)) });
  }
  return Object.freeze({ state: 'diverged', report: immutable(report.map(Object.freeze)) });
}

/**
 * What a divergence does to the workflow.
 *
 * It parks. Choosing the most recent source is choosing whichever process
 * happened to finish last, and that is the failure being diagnosed rather than
 * a way to resolve it.
 */
export function workflowEffect(reconciliation) {
  switch (reconciliation.state) {
    case 'agreed':
      return Object.freeze({ effect: 'proceed' });
    case 'unreconciled':
      // Not a formality: a write that landed and was read back established what
      // is on disk and nothing about the other three.
      return Object.freeze({ effect: 'compare_before_verifying' });
    case 'diverged':
      return Object.freeze({
        effect: 'park',
        report: reconciliation.report,
        detail: reconciliation.report
          .filter((entry) => entry.state === 'observed')
          .map((entry) => `${entry.source}=${entry.digest}`)
          .join(' '),
      });
    default:
      return demand(false, 'write_readback_mismatch', 'Unknown reconciliation state',
        { state: reconciliation.state });
  }
}

/** A receipt is verified only when the comparison ran and agreed. */
export function isVerified(receipt) {
  return receipt.phase === 'verified' && receipt.reconciliation?.state === 'agreed';
}

/**
 * A pending receipt from a previous run.
 *
 * It is not evidence that its write completed — it is evidence that a write
 * started and nobody recorded how it ended.
 */
export function stalePendingErrors(receipts, { runId }) {
  return receipts
    .filter((receipt) => receipt.phase === 'pending' && receipt.run_id !== runId)
    .map((receipt) => ({ reason: 'receipt_stale_pending', detail: receipt.receipt_id }));
}

/** A receipt records one write, and nothing about where the task stands. */
export function taskStatusLeakErrors(receipt) {
  const forbidden = ['task_status', 'step', 'workflow_position', 'task_state'];
  return forbidden
    .filter((field) => Object.hasOwn(receipt, field))
    .map((field) => ({ reason: 'write_destination_invalid', detail: `a receipt carries no ${field}` }));
}
