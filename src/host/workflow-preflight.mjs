/** The dispatch gate: the same checks the doctor runs, asked a narrower question.
 *
 * Two implementations of one check agree until they do not, and the day they
 * disagree is the day a workflow starts on a project doctor calls broken. So
 * this does not re-check anything — it declares which checks each workflow
 * requires and refuses dispatch when the report does not satisfy them.
 *
 * The required sets live here rather than in the report, because a report that
 * decided who may proceed would be answering a question it was not asked.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

import { readiness } from './doctor.mjs';
import { runChecks } from './doctor-checks.mjs';
import { buildReport } from './doctor.mjs';

/**
 * What each workflow cannot start without.
 *
 * A workflow requires a category's checks by naming them; a check added to a
 * category later is picked up by `requiredFor` rather than being silently
 * missed, which is the reason categories exist at all.
 */
export const REQUIRED_CHECKS = immutable({
  // Planning touches no daemon and no provider: it reads and writes documents,
  // so requiring a daemon here would park work that has no need of one.
  planning: immutable(['project_identity.git_worktree', 'project_identity.compat_manifest',
    'governance.contracts_present', 'scheduler.node_version']),
  // Implementation runs code and commits it — and it is a model workflow, so
  // the signer boundary the flow asserts has to have been checked rather than
  // assumed. `unverifiable` blocks here, which is the point: a boundary nobody
  // declared is one nobody can check.
  implementation: immutable(['project_identity.git_worktree', 'project_identity.compat_manifest',
    'daemon.binary_present', 'daemon.store_lock_helper', 'git_delivery.git_available',
    'security.no_traycer', 'security.signer_boundary', 'scheduler.node_version']),
  // A panel dispatches to providers, and the routes it will use must at least
  // be declared; whether they answer is `providers.routes_live`, which no
  // read-only check can establish and which the panel therefore requires
  // deliberately — it starts them itself.
  panel: immutable(['project_identity.compat_manifest', 'providers.panel_routes_declared',
    'security.no_traycer', 'security.signer_boundary', 'scheduler.node_version']),
  // Delivery is where a missing remote stops being a warning.
  delivery: immutable(['project_identity.git_worktree', 'git_delivery.git_available',
    'git_delivery.origin_configured', 'security.no_traycer']),
});

export const WORKFLOWS = immutable(Object.keys(REQUIRED_CHECKS));

/** The checks a workflow requires, by name. */
export function requiredFor(workflow) {
  demand(Object.hasOwn(REQUIRED_CHECKS, workflow), 'doctor_required_set_unsatisfied',
    'Unknown workflow', { workflow });
  return REQUIRED_CHECKS[workflow];
}

/**
 * Decides whether a workflow may start against an existing report.
 *
 * Returns `{ ready, blocking }`; `blocking` names each check and why. A `warn`
 * on a required check blocks, and so does an `unverifiable` one — "we could not
 * test it" never becomes "it passed" for anyone who depends on it.
 */
export function admits(report, workflow, nowMs) {
  return readiness(report, requiredFor(workflow), nowMs);
}

/** Refuses dispatch, or returns the report that admitted it. */
export function assertAdmits(report, workflow, nowMs) {
  const { ready, blocking } = admits(report, workflow, nowMs);
  demand(ready, 'doctor_required_set_unsatisfied',
    `The ${workflow} workflow cannot start on this project`,
    { workflow, blocking: blocking.map((entry) => `${entry.id}:${entry.reason}`) });
  return report;
}

/** Runs the checks and decides in one step, for a caller that has no report yet. */
export async function preflight(env, workflow, { projectIdentity, runtimeIdentity, tool }) {
  const report = buildReport({
    checks: await runChecks(env),
    projectIdentity,
    runtimeIdentity,
    tool,
    generatedAt: new Date(env.nowMs()).toISOString(),
    home: env.home,
  });
  return { report, admission: admits(report, workflow, env.nowMs()) };
}
