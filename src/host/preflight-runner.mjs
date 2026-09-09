/** Running the provider preflight against real processes (#26).
 *
 * The route record `routeAdmission` reads is a set of claims: this route
 * authenticates, this route smoke-tests, this route applied the effort that was
 * asked for. Something has to establish them, and the interesting part is that
 * a provider which quietly substitutes a default is indistinguishable from one
 * that complied — unless the run looks at what came back rather than at the
 * exit code.
 *
 * So the effort is `observed` only when the provider echoed it, `reported` when
 * it claimed compliance in prose, and `unconfirmable` when it said nothing.
 * Those are three different things and only the first is evidence.
 *
 * Injected `run(command, args, { timeoutMs })` returns
 * `{ code, stdout, stderr, timedOut }`; `code: null` means it never started.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

import { classifyExit, dispatchOutcome, waitExceeded } from './provider-preflight.mjs';

/** Phrases a provider uses when it ignored something it was given. */
const DROPPED_PARAMETER = [
  /unsupported parameter '([^']+)'/iu,
  /parameter ([A-Za-z_]+) is not supported/iu,
  /ignoring ([A-Za-z_]+)/iu,
  /using the default/iu,
];

/**
 * A warning that a parameter was dropped, read from what the provider said.
 *
 * A warning nobody parses is a warning nobody needed to send, and this is the
 * one case where prose is the only signal a provider gives.
 */
export function detectDroppedParameter(stderr, stdout = '') {
  for (const text of [stderr, stdout]) {
    for (const pattern of DROPPED_PARAMETER) {
      const match = pattern.exec(text ?? '');
      if (match) return match[1] ?? 'effort';
    }
  }
  return null;
}

/**
 * How well the effort is known, from the result rather than from the request.
 *
 * `observed` requires the provider to have echoed the value. Anything less is
 * the request repeated back by the caller to itself.
 */
export function effortConfirmation(result, requestedEffort) {
  if (!result) return 'unconfirmable';
  if (result.effort_echoed === true && result.effort !== undefined) {
    return result.effort === requestedEffort ? 'observed' : 'reported';
  }
  if (result.effort !== undefined) return 'reported';
  return 'unconfirmable';
}

/**
 * One probe of a route, with its budget.
 *
 * A probe that hangs is not a failed probe: it is a probe that did not answer,
 * and the budget is what turns that into a decision.
 */
export async function probe(run, { command, args, timeouts, parseResult }) {
  const started = Date.now();
  const result = await run(command, args, { timeoutMs: timeouts.wall_clock_ms });
  const elapsed = Date.now() - started;
  const exceeded = waitExceeded({ idleMs: elapsed, elapsedMs: elapsed }, timeouts);
  const parsed = result.stdout ? parseResult(result.stdout) : null;
  const classification = classifyExit({
    exit_code: result.code,
    structured_result: parsed !== null,
    timed_out: result.timedOut === true || exceeded !== null,
    orphans: result.orphans ?? 0,
    tree_killed: result.treeKilled !== false,
  });
  return Object.freeze({
    classification,
    outcome: dispatchOutcome(classification),
    exit_code: result.code,
    result: parsed,
    stderr: (result.stderr ?? '').slice(0, 400),
    elapsed_ms: elapsed,
    exceeded,
  });
}

/**
 * The smoke test: the route is asked to do the smallest real thing.
 *
 * `passed` means a structured result came back. An exit code of zero with
 * nothing structured is the case this exists to catch.
 */
export async function runSmoke(run, route, { timeouts, parseResult }) {
  const observed = await probe(run, {
    command: route.command,
    args: [...(route.args ?? []), '--mode', route.mode ?? 'ok', '--model', route.model_id, '--effort', route.requested_effort],
    timeouts,
    parseResult,
  });
  if (observed.outcome === 'timeout') return Object.freeze({ state: 'timed_out', observed });
  if (observed.outcome === 'route_result_missing') return Object.freeze({ state: 'failed', observed });
  // A non-zero exit with no result is already `route_result_missing`: a second
  // check for it here would be a line that cannot run.
  return Object.freeze({ state: 'passed', observed });
}

/** Authentication, read from the provider's own answer. */
export function authState(observed) {
  if (/authentication|credential|token/iu.test(observed.stderr) && observed.exit_code !== 0) {
    return 'expired';
  }
  if (observed.exit_code === null) return 'unknown';
  return observed.result === null && observed.exit_code !== 0 ? 'unknown' : 'valid';
}

/**
 * Whether the provider says it does not offer the model this route names.
 *
 * Only its own words count. Inferring it from a failure would report an expired
 * credential as an unsupported model, and send somebody to change the route
 * when the fix is to log in.
 */
export function modelSupported(observed, modelId) {
  return !new RegExp(`model ${modelId} is not available`, 'iu').test(observed.stderr ?? '');
}

/**
 * The route record, assembled from what the provider actually did.
 *
 * Every field `routeAdmission` reads is filled from an observation here, so a
 * route that was never probed cannot be admitted by describing it well.
 */
export async function preflightRoute(run, route, { timeouts, nowMs, ttlMs = 15 * 60 * 1000, parseResult }) {
  demand(typeof route.route_id === 'string' && route.route_id.length > 0, 'route_smoke_failed',
    'A route has an id', { route });
  const smoke = await runSmoke(run, route, { timeouts, parseResult });
  const observed = smoke.observed;
  const dropped = detectDroppedParameter(observed.stderr, observed.stdout ?? '');
  const confirmation = effortConfirmation(observed.result, route.requested_effort);
  return Object.freeze({
    route_id: route.route_id,
    model_id: route.model_id,
    failure_domain: route.failure_domain,
    requested_effort: route.requested_effort,
    // Read back, not repeated: the provider's own answer or nothing.
    effective_effort: observed.result?.effort ?? (confirmation === 'unconfirmable' ? route.requested_effort : null),
    effort_confirmation: confirmation,
    permission_modes: immutable([...(route.permission_modes ?? [])]),
    model_supported: modelSupported(observed, route.model_id),
    auth: Object.freeze({ state: authState(observed) }),
    smoke: Object.freeze({ state: smoke.state, elapsed_ms: observed.elapsed_ms }),
    warning_detection: Object.freeze({ dropped_parameter: dropped }),
    // Carried from the route's configuration, not inferred from the probe: a
    // probe that loaded nothing extra this once is not a statement about what
    // the provider would load on a real run.
    auto_context: Object.freeze({
      disposition: route.auto_context?.disposition ?? null,
      instruction_lock_digest: route.auto_context?.instruction_lock_digest ?? null,
    }),
    expires_at: new Date(nowMs + ttlMs).toISOString(),
    retry_budget: route.retry_budget,
    observed_at: new Date(nowMs).toISOString(),
  });
}
