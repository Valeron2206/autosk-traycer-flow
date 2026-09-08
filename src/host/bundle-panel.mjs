/** Running the four-seat panel over a governance bundle candidate (#37).
 *
 * The seats are fixed by the contract: four routes at four efforts, and the
 * point of naming them is that they cannot be substituted. A panel run with
 * three of the four routes and a convenient stand-in is not this panel, and an
 * attestation that says it is would be the most consequential false sentence
 * this program could produce.
 *
 * So the substitution is refused where it would happen — when the seats are
 * built — rather than noticed later by an attestation reader. By then the run
 * has already happened and the verdicts already exist, which is exactly when
 * "close enough" becomes tempting.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

import { REQUIRED_SEATS } from './governance-bundle.mjs';
import { runPanel } from './panel.mjs';

/**
 * The four seats, built from the contract's own list.
 *
 * A supplied route that is not the required one is refused here: the seat is
 * the route, and a seat with another route is another seat wearing its name.
 */
export function seatsFor({ candidateDigest, routes, context, dispatch, runState }) {
  demand(typeof candidateDigest === 'string' && candidateDigest.length === 64,
    'bundle_attestation_mismatch', 'A panel runs on one candidate digest', { candidateDigest });
  return immutable(REQUIRED_SEATS.map((required) => {
    const route = routes[required.seat];
    demand(Boolean(route), 'bundle_panel_incomplete', 'No route was supplied for a required seat',
      { seat: required.seat });
    demand(route.route_id === required.route, 'bundle_panel_incomplete',
      'A seat may not be run on another route',
      { seat: required.seat, required: required.route, supplied: route.route_id });
    demand(route.requested_effort === required.effort, 'bundle_panel_incomplete',
      'A seat may not be run at another effort',
      { seat: required.seat, required: required.effort, supplied: route.requested_effort });
    return Object.freeze({
      seat: required.seat,
      // The registry carries one carrier per seat — `panel.opus`, `panel.astra`
      // and the rest — because each seat reads the candidate through its own
      // lens. Inventing a key here would ask the registry a question it does
      // not answer.
      role: 'panel',
      stage: required.seat,
      route,
      requested_effort: required.effort,
      context: { ...context, seat: required.seat, candidate_digest: candidateDigest },
      dispatch: { ...dispatch, seat: required.seat, candidate_identity: candidateDigest },
      // What the host recorded about this seat's run. Without it the run
      // cannot be evaluated, and a seat whose run cannot be confirmed is
      // neither a pass nor a fail.
      ...(typeof runState === 'function' ? runState(required.seat) : (runState ?? {})),
    });
  }));
}

/**
 * Runs the panel and assembles the attestation.
 *
 * A seat that did not answer produces no verdict rather than an absent one:
 * the attestation reader counts verdicts, and an entry saying "unavailable"
 * would be a verdict about the candidate that nobody gave.
 */
export function runBundlePanel(deps) {
  const { candidateDigest, routes, context, dispatch, releaseActor, runState } = deps;
  const seats = seatsFor({ candidateDigest, routes, context, dispatch, runState });
  const panel = runPanel(seats, deps);

  const verdicts = [];
  const unavailable = [];
  for (const result of panel.seats) {
    const required = REQUIRED_SEATS.find((entry) => entry.seat === result.seat);
    if (result.outcome !== 'answered') {
      unavailable.push(Object.freeze({ seat: result.seat, outcome: result.outcome, reasons: result.reasons }));
      continue;
    }
    verdicts.push(Object.freeze({
      seat: result.seat,
      route: required.route,
      effort: required.effort,
      // The candidate the panel ran on. Reading it back off the seat would
      // look like the seat's own statement and be the same host value, so it
      // says what it is: the model's binding to this step is enforced
      // upstream, where a result carrying another step's identity is refused
      // before it becomes an answer.
      candidate_digest: candidateDigest,
      verdict: result.record?.outcome ?? 'no_verdict',
    }));
  }

  return Object.freeze({
    panel,
    attestation: Object.freeze({
      candidate_digest: candidateDigest,
      verdicts: immutable(verdicts),
      // Recorded, never inferred: somebody is releasing this.
      release_actor: releaseActor ?? null,
    }),
    // Named separately, because "three seats passed" and "four seats passed"
    // read the same in a summary that only counts passes.
    unavailable: immutable(unavailable),
  });
}
