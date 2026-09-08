/** Provider preflight: what a route must prove before it can carry a seat.
 *
 * Checking that a catalog lists a model and that a synthetic call returns does
 * not establish that a route will do what the panel needs. A provider can
 * accept the model id and drop the requested reasoning effort, return a warning
 * nobody reads, offer no real read-only mode, hang with no timeout, or take
 * several routes down at once because they share a harness.
 *
 * **A silent downgrade destroys the panel identity.** Four seats chosen for
 * four different lenses are not four seats if two of them quietly ran at the
 * provider's default effort.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

export const REFUSALS = immutable([
  'route_model_unsupported',
  'route_effort_dropped',
  'route_effort_unconfirmable',
  'route_auth_expired',
  'route_smoke_failed',
  'route_permission_mode_unavailable',
  'route_preflight_expired',
  'route_failure_domain_down',
  'route_retry_budget_exhausted',
  'route_result_missing',
  'route_session_generation_conflict',
]);

/** How the effective effort was established. Its own field, deliberately. */
export const EFFORT_CONFIRMATION = immutable(['observed', 'reported', 'unconfirmable']);

/**
 * Whether an attestation still says anything.
 *
 * An expired attestation is not an attestation: the executable, the catalog and
 * the account can all have changed since.
 */
export function isExpired(route, nowMs) {
  return Date.parse(route.expires_at) <= nowMs;
}

/**
 * Whether a route may carry a dispatch, and why not when it may not.
 *
 * Returns every reason rather than the first: an operator fixing one thing at a
 * time on a route with three problems learns about them one deployment apart.
 */
export function routeAdmission(route, { nowMs, requestedEffort, permissionMode, domainState = {}, policy = {} }) {
  const reasons = [];

  if (isExpired(route, nowMs)) reasons.push({ reason: 'route_preflight_expired', detail: route.expires_at });
  if (route.auth?.state !== 'valid') reasons.push({ reason: 'route_auth_expired', detail: route.auth?.state ?? 'unknown' });
  if (route.smoke?.state !== 'passed') reasons.push({ reason: 'route_smoke_failed', detail: route.smoke?.state ?? 'unknown' });
  if (route.model_supported === false) reasons.push({ reason: 'route_model_unsupported', detail: route.model_id });

  // A warning about a dropped parameter makes the route unavailable, not
  // degraded: a warning nobody acts on is a warning nobody needed to send.
  if (route.warning_detection?.dropped_parameter) {
    reasons.push({ reason: 'route_effort_dropped', detail: route.warning_detection.dropped_parameter });
  }
  if (requestedEffort !== undefined) {
    // There is no silent substitution: a route never falls back to the
    // provider's default model or effort.
    if (route.requested_effort !== requestedEffort) {
      reasons.push({ reason: 'route_effort_dropped', detail: `attested for ${route.requested_effort}` });
    } else if (route.effective_effort !== requestedEffort && route.effort_confirmation !== 'unconfirmable') {
      reasons.push({ reason: 'route_effort_dropped', detail: `effective ${route.effective_effort}` });
    }
  }
  if (route.effort_confirmation === 'unconfirmable' && !policy.admits_unconfirmed_effort) {
    // Admitted only under an accepted policy — never by default.
    reasons.push({ reason: 'route_effort_unconfirmable', detail: route.route_id });
  }

  if (permissionMode && !(route.permission_modes ?? []).includes(permissionMode)) {
    // The provider's own permission mode is evidence, not a substitute for an
    // isolated workspace, and a mode it does not offer is not one to assume.
    reasons.push({ reason: 'route_permission_mode_unavailable', detail: permissionMode });
  }

  if (domainState[route.failure_domain] === 'down') {
    // A failure domain is a property of the harness, not of the model.
    reasons.push({ reason: 'route_failure_domain_down', detail: route.failure_domain });
  }

  const budget = route.retry_budget;
  if (budget && budget.used >= budget.max) {
    reasons.push({ reason: 'route_retry_budget_exhausted', detail: `${budget.used}/${budget.max}` });
  }

  return Object.freeze({ admitted: reasons.length === 0, reasons: reasons.map((entry) => Object.freeze(entry)) });
}

/** Refuses a dispatch, or returns the route that carried it. */
export function assertAdmits(route, options) {
  const { admitted, reasons } = routeAdmission(route, options);
  // The refusal code is read from the first reason, so it is computed only when
  // there is one: passing `reasons[0].reason` directly would throw on the path
  // where the route is admitted, which is the path that matters most.
  if (!admitted) {
    demand(false, reasons[0].reason, 'The route may not carry this dispatch',
      { route_id: route.route_id, reasons: reasons.map((entry) => `${entry.reason}:${entry.detail}`) });
  }
  return route;
}

/**
 * Whether a new child may be created on a domain after an exhausted-provider error.
 *
 * Retrying into the same outage is how a bounded retry becomes an unbounded
 * one, so the domain has to be quiet for a cooldown before it carries another
 * child.
 */
export function domainReady(domain, { lastExhaustedAtMs, nowMs, cooldownMs }) {
  if (lastExhaustedAtMs === undefined) return true;
  return nowMs - lastExhaustedAtMs >= cooldownMs;
}

/**
 * The routes a failure domain takes with it.
 *
 * Cursor going down takes Grok and Kimi with it and leaves Codex and Claude
 * alone, and the record says so by naming the domain rather than the vendor.
 */
export function routesInDomain(routes, domain) {
  return routes.filter((route) => route.failure_domain === domain).map((route) => route.route_id).sort();
}

/**
 * Classifies how a provider process ended.
 *
 * A provider exit of zero without a valid structured result is a failure, not a
 * pass: "the process ended" is not "the work was done".
 */
export function classifyExit({ exit_code, structured_result, timed_out, orphans = 0, tree_killed }) {
  if (timed_out) {
    // A timeout kills the whole process tree, not the child it started, and an
    // orphan that outlives the driver is a leak the next run inherits.
    return orphans === 0 && tree_killed ? 'timeout_clean' : 'timeout_leaked';
  }
  if (!structured_result) return 'no_result';
  return exit_code === 0 ? 'ok' : 'result_with_nonzero_exit';
}

/** A dispatch outcome, from the process classification. */
export function dispatchOutcome(classification) {
  switch (classification) {
    case 'ok':
    case 'result_with_nonzero_exit':
      // The exit code is not the result in either direction.
      return 'submitted';
    case 'no_result':
      return 'route_result_missing';
    case 'timeout_clean':
    case 'timeout_leaked':
      return 'timeout';
    default:
      return demand(false, 'route_result_missing', 'Unknown process classification', { classification });
  }
}

/**
 * Both budgets, because one without the other leaves the other unbounded.
 *
 * A reply that keeps producing bytes forever is not idle, and a reply that
 * arrives in one burst after an hour was never idle either.
 */
export function waitExceeded({ idleMs, elapsedMs }, timeouts) {
  demand(Number.isInteger(timeouts?.idle_ms) && Number.isInteger(timeouts?.wall_clock_ms),
    'route_smoke_failed', 'A route declares both an idle and a wall-clock budget',
    { timeouts });
  if (idleMs >= timeouts.idle_ms) return 'idle';
  if (elapsedMs >= timeouts.wall_clock_ms) return 'wall_clock';
  return null;
}

/**
 * Binds a replacement session to the one it replaces.
 *
 * A generation and a `replaces` binding, so two attempts can never be read as
 * one — which is the whole point of replacing rather than resuming.
 */
export function replacementSession(previous, { session_id, nowMs }) {
  demand(session_id !== previous.session_id, 'route_session_generation_conflict',
    'A replacement session has its own id', { session_id });
  return Object.freeze({
    session_id,
    generation: previous.generation + 1,
    replaces: previous.session_id,
    created_at: new Date(nowMs).toISOString(),
  });
}

/** Refuses a resume that would let two generations be read as one. */
export function assertResumable(session, expected) {
  demand(session.session_id === expected.session_id, 'route_session_generation_conflict',
    'The session is not the one that was dispatched');
  demand(session.generation === expected.generation, 'route_session_generation_conflict',
    'The session generation moved', { expected: expected.generation, actual: session.generation });
  return session;
}

/** Diagnostics are redacted and bounded before they are stored. */
export function boundDiagnostics(text, { maxBytes = 4096, home } = {}) {
  let value = typeof text === 'string' ? text : '';
  if (home && home.length > 1) value = value.split(home).join('<home>');
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  return `${bytes.subarray(0, maxBytes - 1).toString('utf8')}…`;
}
