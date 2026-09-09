/** The four-model panel: the orchestrator that composes the six pieces.
 *
 * Nothing here re-decides anything. The route guard is #26's, the carrier and
 * echo are #19's, the clearance is #20's, the submission path is #18's, the
 * store projection is #15's and the finding pipeline is #16's. This file is the
 * order they run in and what happens when one of them refuses — which is the
 * part that was still only described.
 *
 * A seat that could not be dispatched is not a seat that passed, and a seat
 * whose run cannot be confirmed is neither a pass nor a fail. Those two
 * sentences are most of the file.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

import { clearForDispatch, assertSendMatches } from './clearance.mjs';
import { canonicalMerge, computeGate } from './finding-registry.mjs';
import { evaluateRun } from './gate-projection.mjs';
import { applySubmission } from './model-result.mjs';
import { routeAdmission } from './provider-preflight.mjs';
import { compileCarrier, verifyEcho } from './stage-carrier.mjs';

/** What a seat's run can come to. Only one of them is an answer about the candidate. */
export const SEAT_OUTCOMES = immutable(['answered', 'unavailable', 'blocking_non_verdict']);

/**
 * A panel needs every declared seat to answer.
 *
 * Three passes and a silence is not a pass — the same rule the design candidate
 * already applies to the final attestation, applied here where the seats run.
 */
export function panelVerdict(seats, findingsGate) {
  const answered = seats.filter((seat) => seat.outcome === 'answered');
  const nonVerdicts = seats.filter((seat) => seat.outcome === 'blocking_non_verdict');
  const unavailable = seats.filter((seat) => seat.outcome === 'unavailable');
  if (nonVerdicts.length > 0) {
    return Object.freeze({
      verdict: 'blocking_non_verdict',
      reason: 'seat_non_verdict',
      seats: nonVerdicts.map((seat) => seat.seat).sort(),
    });
  }
  if (unavailable.length > 0) {
    // Not a smaller panel: a panel with a seat missing answers a different
    // question, and waiving one is a decision for #35 rather than a default.
    return Object.freeze({
      verdict: 'incomplete',
      reason: 'seat_unavailable',
      seats: unavailable.map((seat) => seat.seat).sort(),
    });
  }
  demand(answered.length === seats.length, 'seat_non_verdict', 'A seat has no recorded outcome');
  return Object.freeze({
    verdict: findingsGate.verdict === 'pass' ? 'pass' : 'blocked',
    reason: findingsGate.verdict === 'pass' ? 'gate_pass' : 'findings_gate',
    seats: seats.map((seat) => seat.seat).sort(),
  });
}

/**
 * Runs one seat, end to end.
 *
 * Returns a record rather than throwing: one seat's refusal is not the panel's
 * exception, and the panel has to be able to say which seat stopped and why.
 */
export function runSeat(seat, deps) {
  const { registry, carrierRegistry, bundle, anchors, scanner, personalDataReview, provider, nowMs, home } = deps;

  const admission = routeAdmission(seat.route, {
    nowMs,
    requestedEffort: seat.requested_effort,
    permissionMode: 'read_only',
    domainState: deps.domainState ?? {},
    policy: deps.policy ?? {},
  });
  if (!admission.admitted) {
    // A route that may not carry the dispatch produces no verdict at all. The
    // seat is unavailable, which is a different fact from a seat that answered.
    return Object.freeze({
      seat: seat.seat,
      outcome: 'unavailable',
      reasons: admission.reasons,
    });
  }

  let compiled;
  let cleared;
  try {
    compiled = compileCarrier(carrierRegistry, {
      role: seat.role,
      stage: seat.stage,
      context: seat.context,
      bundle,
      anchors,
    });
    cleared = clearForDispatch({
      body: compiled.body,
      dispatch: seat.dispatch,
      scanner,
      personalDataReview,
      home,
      exception: deps.exception,
    });
  } catch (error) {
    // A carrier that cannot be compiled and a body that cannot be cleared are
    // both "this seat was never dispatched", never "this seat found nothing".
    return Object.freeze({
      seat: seat.seat,
      outcome: 'unavailable',
      reasons: [{ reason: error.code, detail: error.message }],
    });
  }

  assertSendMatches(cleared.manifest, cleared.body);
  const output = provider.call(seat.route.route_id, cleared.body);

  let submission;
  try {
    submission = applySubmission(output, { dispatch: seat.dispatch, env: deps.env });
  } catch (error) {
    // An invalid or missing result does not clear a blocker and does not create
    // a PASS: the seat produced no answer the host can record.
    return Object.freeze({
      seat: seat.seat,
      outcome: 'blocking_non_verdict',
      reasons: [{ reason: error.code, detail: error.message }],
    });
  }

  const echoReasons = verifyEcho(compiled.headers, submission.record.received_attributions ?? []);
  if (echoReasons.length > 0) {
    // The seat answered a question the host cannot confirm it was asked.
    return Object.freeze({ seat: seat.seat, outcome: 'blocking_non_verdict', reasons: echoReasons });
  }

  const run = evaluateRun({
    before: seat.store_before,
    after: seat.store_after,
    journal: seat.journal ?? [],
    projectedFields: registry.projected_fields,
    projectionVersion: registry.projection_version,
    runVersion: seat.projection_version,
    comments: seat.comments,
  });
  if (run.verdict !== 'accepted') {
    return Object.freeze({ seat: seat.seat, outcome: 'blocking_non_verdict', reasons: run.reasons });
  }

  return Object.freeze({
    seat: seat.seat,
    outcome: 'answered',
    record: submission.record,
    transition: submission.transition,
    findings: submission.record.findings ?? [],
    manifest: cleared.manifest,
    carrier_digest: compiled.body_sha256,
  });
}

/**
 * Runs the panel.
 *
 * Seats are independent: one seat's refusal does not stop the others, because
 * the operator needs to know whether one route is down or four are.
 */
export function runPanel(seats, deps) {
  demand(Array.isArray(seats) && seats.length > 0, 'seat_non_verdict', 'A panel has seats');
  const results = seats.map((seat) => runSeat(seat, deps));
  const answered = results.filter((result) => result.outcome === 'answered');

  // The seats are shown byte-identical common fragments, so a disagreement is
  // about the lens. If the carriers differ, the seats were not asked the same
  // question and merging their findings would hide that.
  const carriers = new Set(answered.map((result) => result.carrier_digest));

  const raw = answered.flatMap((result) =>
    result.findings.map((finding) => ({ ...finding, seat: result.seat })),
  );
  const canonical = canonicalMerge(raw);
  const findingsGate = computeGate({ canonical_findings: canonical });
  const verdict = panelVerdict(results, findingsGate);

  return Object.freeze({
    seats: immutable(results),
    canonical_findings: immutable(canonical),
    findings_gate: findingsGate,
    verdict: verdict.verdict,
    reason: verdict.reason,
    // Reported rather than asserted: whether the answered seats saw the same
    // bytes is a fact the reader needs when the seats disagree. The set is
    // built from the answered seats, so "exactly one distinct carrier" already
    // means at least one seat answered — a second clause saying so could not
    // change the answer, and a condition that cannot change the answer reads
    // like a guarantee while guaranteeing nothing.
    identical_carriers: carriers.size === 1,
  });
}
