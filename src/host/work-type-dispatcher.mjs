/** Where the work-type gates are actually asked (#24).
 *
 * A playbook that is not consulted at a decision point is a document. There are
 * exactly two points where these gates change what happens: before a Ticket is
 * dispatched, when the prerequisites for its work type either exist or do not,
 * and before it is completed, when the evidence it produced either satisfies
 * its own contract or does not.
 *
 * Both are fail-closed, and both name the work type in the refusal — "the
 * prerequisites are missing" without saying which playbook asked for them is
 * the kind of refusal that gets waived.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

import {
  batchSufficiencyErrors,
  dispositionEvasions,
  listingObligation,
  perfVerdict,
  prerequisiteErrors,
  stalenessErrors,
} from './work-type-gates.mjs';

/** The two points. Anywhere else, these gates are not consulted at all. */
export const GATE_POINTS = immutable(['dispatch', 'completion']);

/**
 * Before dispatch: does the work type's playbook have what it asks for.
 *
 * Checked here rather than at completion because the missing thing is usually
 * cheap to produce now and impossible to produce afterwards — a failing
 * regression test before the fix cannot be written after it.
 */
export function dispatchAdmission(ticket) {
  const errors = prerequisiteErrors(ticket);
  if (errors.length === 0) {
    return Object.freeze({ decision: 'dispatch', work_type: ticket.work_type });
  }
  return Object.freeze({
    decision: 'park',
    work_type: ticket.work_type ?? null,
    reason: errors[0].reason,
    // Every reason, not the first: fixing them one round at a time is how a
    // Ticket spends four dispatches learning what its own playbook wanted.
    errors: immutable(errors.map(Object.freeze)),
  });
}

/**
 * Before completion: does the evidence satisfy the contract it was produced
 * under.
 *
 * The batch's own sufficiency, the staleness of its bindings, the listing it
 * owes, and — for a perf Ticket — whether the measured difference clears the
 * noise it declared before measuring.
 */
export function completionAdmission(ticket, { batch, current, artifact, measurement, dispositions }) {
  const errors = [];
  if (batch) {
    errors.push(...batchSufficiencyErrors(batch));
    if (current) errors.push(...stalenessErrors(batch, current));
  }
  if (artifact) {
    const owed = listingObligation(artifact);
    if (owed.owed) errors.push({ reason: owed.reason, detail: 'an exact listing is owed' });
  }
  if (dispositions) {
    errors.push(...dispositionEvasions(dispositions.before, dispositions.after));
  }
  let verdict = null;
  if (ticket.work_type === 'perf') {
    demand(measurement !== undefined, 'batch_proof_contract_incomplete',
      'A perf Ticket completes on a measurement', { ticket_id: ticket.ticket_id });
    verdict = perfVerdict(measurement);
    if (verdict === 'inconclusive') {
      // Inside the noise it declared before measuring: not an improvement, and
      // not a regression either.
      errors.push({ reason: 'batch_proof_contract_incomplete', detail: 'the difference is inside the declared noise' });
    }
  }
  return Object.freeze({
    decision: errors.length === 0 ? 'complete' : 'park',
    work_type: ticket.work_type ?? null,
    perf_verdict: verdict,
    errors: immutable(errors.map(Object.freeze)),
  });
}

/**
 * The gate for a point, so a caller cannot consult the wrong one.
 *
 * A completion check run at dispatch would pass on a Ticket that has produced
 * no evidence yet, which is the most comfortable way to have a gate and not be
 * gated.
 */
export function gate(point, ticket, context = {}) {
  demand(GATE_POINTS.includes(point), 'worktype_missing', 'Unknown gate point', { point });
  return point === 'dispatch' ? dispatchAdmission(ticket) : completionAdmission(ticket, context);
}
