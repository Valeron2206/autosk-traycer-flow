/** The dispatch gate: the same checks the doctor runs, asked a narrower question.
 *
 * Two implementations of one check agree until they do not, and the day they
 * disagree is the day a workflow starts on a project doctor calls broken. So
 * this does not re-check anything — it declares which checks each workflow
 * requires and refuses dispatch when the report does not satisfy them.
 *
 * The required sets live here rather than in the report, because a report that
 * decided who may proceed would be answering a question it was not asked. They
 * are keyed by the workflows the graph document registers, because a gate keyed
 * by anything else cannot be asked about the workflow a daemon is starting.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

import { readiness } from './doctor.mjs';
import { runChecks } from './doctor-checks.mjs';
import { buildReport } from './doctor.mjs';

/**
 * What each kind of work cannot start without.
 *
 * A workflow requires a category's checks by naming them; a check added to a
 * category later is picked up by `requiredFor` rather than being silently
 * missed, which is the reason categories exist at all. No phase names a
 * model-step check — the daemon's capabilities or the signer boundary: that
 * requirement follows from what a workflow runs, and is derived from the graph
 * below.
 */
export const PHASE_CHECKS = immutable({
  // The checks planning's own document work needs. Planning still runs agent
  // steps, and what a model step needs — the daemon's capabilities and the
  // signer boundary — is no phase's to list: `MODEL_STEP_CHECKS` below adds it
  // to every workflow whose first step reaches one, the planned Epic's
  // included (debt 10d, R6-11; debt 11c, R7-26).
  planning: immutable(['project_identity.git_worktree', 'project_identity.compat_manifest',
    'governance.contracts_present', 'scheduler.node_version']),
  // Implementation runs code and commits it.
  implementation: immutable(['project_identity.git_worktree', 'project_identity.compat_manifest',
    'daemon.binary_present', 'daemon.store_lock_helper', 'git_delivery.git_available',
    'security.no_traycer', 'scheduler.node_version']),
  // Dispatching a panel or a contest sends seats to providers, and the routes
  // it will use must at least be declared; whether they answer is
  // `providers.routes_live`, which no read-only check can establish and which
  // the dispatcher therefore does not require — it starts them itself.
  panel_dispatch: immutable(['project_identity.compat_manifest', 'providers.panel_routes_declared',
    'security.no_traycer', 'scheduler.node_version']),
  // A seat is a daemon-registered child task on one declared route: it needs
  // the daemon and its store-lock helper, because it answers only through
  // `submit_gate_result` into the store (03 §2, the child workflow contract).
  seat: immutable(['project_identity.compat_manifest', 'daemon.binary_present', 'daemon.store_lock_helper',
    'providers.panel_routes_declared', 'security.no_traycer', 'scheduler.node_version']),
  // Delivery is where a missing remote stops being a warning.
  delivery: immutable(['project_identity.git_worktree', 'git_delivery.git_available',
    'git_delivery.origin_configured', 'security.no_traycer']),
});

/**
 * Which kinds of work each registered workflow does, by its graph name.
 *
 * The keys must be exactly the graph's `workflows[].name`: `requiredChecks`
 * refuses a graph that registers a workflow this table does not know, and a
 * table entry the graph does not register, so the two cannot drift apart
 * silently. The planned Epic plans, dispatches its panel, contests and
 * Tickets, and delivers staging; Quick implements and integrates locally; a
 * seat of the panel or of a contest is a child task on a provider route; the
 * rest run against code.
 */
export const WORKFLOW_PHASES = immutable({
  'autosk-planned': ['planning', 'panel_dispatch', 'implementation', 'delivery'],
  'autosk-quick': ['implementation'],
  'autosk-ticket': ['implementation'],
  'autosk-code-review': ['implementation'],
  'autosk-panel-seat': ['seat'],
  'autosk-contest-seat': ['seat'],
  'autosk-arena-candidate': ['implementation'],
  'autosk-arena-judge': ['implementation'],
});

/**
 * What a workflow that runs a model step cannot start without.
 *
 * 01 §2 and 02 §5 make the signer boundary a precondition of model launch, and
 * 02 §3 a daemon that carries every capability the flow requires (ADR-083):
 * the daemon capability check hands the daemon's report to
 * `requireDaemonCapabilities` (ADR-097). Both are required of every workflow
 * whose first step reaches an agent step in the graph. The graph has no
 * model-free kind of agent step, so every `agent` step counts as one — and
 * every registered workflow's first step is itself an agent step, which is
 * what makes all eight require them today.
 */
export const MODEL_STEP_CHECKS = immutable(['daemon.capabilities_pinned', 'security.signer_boundary']);

/** The workflows a graph registers and where each starts, as the graph says. */
export function registeredWorkflows(graph) {
  demand(Array.isArray(graph?.workflows) && graph.workflows.length > 0, 'doctor_required_set_unsatisfied',
    'The graph registers no workflows, so there is nothing to admit');
  return graph.workflows;
}

/**
 * Whether an agent step is reachable from `first`, `first` itself included.
 *
 * A first step the graph does not declare is refused: read as "reaches
 * nothing", a typo would waive the boundary.
 */
export function runsModelStep(graph, first) {
  const kinds = new Map(graph.steps.map((step) => [step.name, step.kind]));
  demand(kinds.has(first), 'doctor_required_set_unsatisfied',
    'A workflow starts at a step the graph does not declare', { first_step: first });
  const outgoing = new Map();
  for (const edge of graph.transitions) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  // A Set visits what is added to it while it is walked, once each, so the
  // walk is a breadth-first search with nothing to count and no revisits.
  const seen = new Set([first]);
  for (const current of seen) {
    if (kinds.get(current) === 'agent') return true;
    for (const next of outgoing.get(current) ?? []) seen.add(next);
  }
  return false;
}

/** Every registered workflow's required set, keyed by its graph name. */
export function requiredChecks(graph) {
  const workflows = registeredWorkflows(graph);
  const names = workflows.map((entry) => entry.name);
  const duplicate = names.filter((name, index) => names.indexOf(name) !== index);
  demand(duplicate.length === 0, 'doctor_required_set_unsatisfied',
    'The graph registers a workflow twice', { duplicate });
  const undeclared = names.filter((name) => !Object.hasOwn(WORKFLOW_PHASES, name));
  const unregistered = Object.keys(WORKFLOW_PHASES).filter((name) => !names.includes(name));
  demand(undeclared.length === 0 && unregistered.length === 0, 'doctor_required_set_unsatisfied',
    'The graph registers other workflows than the gate declares sets for', { undeclared, unregistered });
  const sets = {};
  for (const { name, first_step: first } of workflows) {
    const ids = WORKFLOW_PHASES[name].flatMap((phase) => PHASE_CHECKS[phase]);
    if (runsModelStep(graph, first)) ids.push(...MODEL_STEP_CHECKS);
    sets[name] = [...new Set(ids)];
  }
  return immutable(sets);
}

/** The checks a workflow requires, by its graph name. */
export function requiredFor(graph, workflow) {
  const sets = requiredChecks(graph);
  demand(Object.hasOwn(sets, workflow), 'doctor_required_set_unsatisfied',
    'Unknown workflow', { workflow });
  return sets[workflow];
}

/**
 * Decides whether a workflow may start against an existing report.
 *
 * Returns `{ ready, blocking }`; `blocking` names each check and why. A `warn`
 * on a required check blocks, and so does an `unverifiable` one — "we could not
 * test it" never becomes "it passed" for anyone who depends on it.
 */
export function admits(report, graph, workflow, nowMs) {
  return readiness(report, requiredFor(graph, workflow), nowMs);
}

/** Refuses dispatch, or returns the report that admitted it. */
export function assertAdmits(report, graph, workflow, nowMs) {
  const { ready, blocking } = admits(report, graph, workflow, nowMs);
  demand(ready, 'doctor_required_set_unsatisfied',
    `The ${workflow} workflow cannot start on this project`,
    { workflow, blocking: blocking.map((entry) => `${entry.id}:${entry.reason}`) });
  return report;
}

/** Runs the checks and decides in one step, for a caller that has no report yet. */
export async function preflight(env, graph, workflow, { projectIdentity, runtimeIdentity, tool }) {
  const report = buildReport({
    checks: await runChecks(env),
    projectIdentity,
    runtimeIdentity,
    tool,
    generatedAt: new Date(env.nowMs()).toISOString(),
    home: env.home,
  });
  return { report, admission: admits(report, graph, workflow, env.nowMs()) };
}
