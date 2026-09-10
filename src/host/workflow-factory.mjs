/**
 * Builds the workflow an extension registers from the graph document.
 *
 * The document is already the state machine: steps, edges with priorities,
 * guards over a closed predicate enumeration, and one recovery row per park
 * reason. So this is a projection of it and not a second structure — the shape
 * was chosen in slice 2 and the job here is to stop restating it in code.
 *
 * Two operations carry the execution semantics, and they are separate because
 * they answer different questions with different data.
 *
 * Operation 1, selection. Out of the current step, every declared edge whose
 * guards all hold is a candidate, and the lowest priority among them wins. A
 * guard that does not hold DISQUALIFIES its edge; it does not park the flow.
 * That distinction is the whole point: a false guard is the ordinary way an
 * alternative is not taken, and parking on it would stop a flow every time it
 * chose the second of two paths. Parking happens only when no edge is a
 * candidate, and then the step's own `no_transition_reason` says why.
 *
 * Operation 2, resume. A parked flow may be resumed only at a target the PARK
 * REASON permits, not at one the step permits. Two reasons can park at the same
 * step and allow different targets, so reading permission off the step would let
 * a resume that one reason forbids be laundered through another that was never
 * the reason for this park.
 *
 * The engine calls both through ONE hook. `WorkflowDefinition.onTransit(ctx, to)`
 * is a veto, not a selector: the engine runs it for every transition — enroll,
 * step to step, resume — with the target already chosen, and a throw rejects the
 * move. So selection runs inside the step's own `onRun`, which is where the
 * choice is made, and `onTransit` checks the move against the same document.
 * One function decides and the same function verifies, which is the only way the
 * two cannot disagree.
 *
 * A guard's `park_reason` is the reason it names when it refuses an EXPLICITLY
 * REQUESTED target — the schema says so in as many words — and the veto is where
 * a target is explicitly requested. That field had no reader until this hook.
 *
 * Predicates are not evaluated here. The document enumerates them and says what
 * state each reads; whether one holds is the workflow's own business, so the
 * caller supplies a resolver. A predicate the document does not declare is
 * refused in both operations rather than treated as false: false is an answer,
 * and the honest answer to an undeclared id is that nobody can give one.
 *
 * The resolver is pure and synchronous: it is handed the task record the
 * predicates say they read, loaded once per decision. Letting it read state of
 * its own mid-decision would let two guards in one selection disagree about what
 * was true, which is not a state machine.
 */

import { graphDigest } from "./workflow-graph-canonical.mjs";

/**
 * Every way this factory refuses, which is not every reason a flow stops.
 *
 * These six are the factory's own: it issues them when the document cannot
 * answer. The reasons a flow parks with — a step's `no_transition_reason`, a
 * guard's `park_reason` — are the document's, drawn from the park vocabulary,
 * and are relayed rather than invented here.
 */
export const REFUSALS = Object.freeze([
  "graph_digest_stale",
  "guard_unknown",
  "no_transition_reason",
  "park_reason_ambiguous",
  "predicate_unknown",
  "resume_target_not_permitted",
  "step_unknown",
  "transition_not_declared",
]);

/**
 * The document indexed for the two operations.
 *
 * Built once per workflow rather than per transition: the maps below are read on
 * every step of every task, and rebuilding them from arrays each time would make
 * the cost of a decision grow with the size of the graph rather than with the
 * fan-out of the step being decided.
 */
export function index(document) {
  const steps = new Map(document.steps.map((step) => [step.name, step]));
  const guards = new Map(document.guards.map((guard) => [guard.id, guard]));
  const predicates = new Set(document.predicates.map((entry) => entry.id));

  const outgoing = new Map();
  for (const edge of document.transitions) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  }
  // Sorted once, so selection walks candidates in the order the data decides and
  // never in the order the array happened to be written.
  for (const [from, edges] of outgoing) {
    outgoing.set(
      from,
      [...edges].sort((left, right) => left.priority - right.priority),
    );
  }

  // Every reference the graph makes is resolved here, once, before any operation
  // runs. Checking it inside `holds` covered selection and the veto's ordinary
  // path and left operation 2 open: a resume never evaluates a guard, so a
  // document naming an undeclared predicate was admitted by the one operation
  // that never looks. Closure is a property of the document, so it is decided
  // where the document is read.
  for (const edge of document.transitions) {
    for (const name of [edge.from, edge.to]) {
      if (!steps.has(name)) throw new GraphRefusal("step_unknown", `${edge.id} names step ${name}`);
    }
    for (const id of edge.guards) {
      const guard = guards.get(id);
      if (!guard) throw new GraphRefusal("guard_unknown", `${edge.id} names guard ${id}`);
      if (typeof guard.park_reason !== "string") {
        throw new GraphRefusal("guard_unknown", `${guard.id} declares no park reason, so it can name nothing`);
      }
      if (!predicates.has(guard.predicate)) {
        throw new GraphRefusal("predicate_unknown", `guard ${guard.id} names predicate ${guard.predicate}`);
      }
    }
  }

  const recovery = new Map(document.recovery.map((row) => [row.reason, row]));
  return { steps, guards, predicates, outgoing, recovery, document };
}

/** A refusal carrying the code the graph names for it. */
export class GraphRefusal extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.name = "GraphRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Whether every guard bound to an edge holds, and which one did not.
 *
 * Every guard here is declared and names a declared predicate, because `index`
 * refused the document otherwise. That check used to live in this loop, where it
 * covered the two operations that evaluate guards and missed the one that does
 * not: a resume answers from the park reason alone and never reaches here, so an
 * undeclared predicate was refused everywhere except the operation the ticket
 * names alongside the other.
 */
function holds(state, edge, evaluate) {
  for (const id of edge.guards) {
    const guard = state.guards.get(id);
    if (!evaluate(guard.predicate, guard)) return { ok: false, guard };
  }
  return { ok: true };
}

/**
 * Operation 1: which edge the flow takes out of `from`, or why it parks.
 *
 * Returns `{ take }` with the winning edge, or `{ park }` with the reason a step
 * gives for going nowhere — and, for a status step, `{ park: null, status }`,
 * because a status step is the end of a flow and is never asked to decide.
 */
export function select(state, from, evaluate) {
  const step = state.steps.get(from);
  if (!step) throw new GraphRefusal("step_unknown", from);
  // A status step drives a task status and runs nothing, so it never decides
  // where to go next and is never asked.
  if (step.kind === "status") return { park: null, status: step.status };

  for (const edge of state.outgoing.get(from) ?? []) {
    if (holds(state, edge, evaluate).ok) return { take: edge };
  }
  // The schema requires the field on every agent step, so the fallback is a code
  // no valid document can reach. It is here so that a document which finds a way
  // to reach it has a name for what it did.
  return { park: step.no_transition_reason ?? "no_transition_reason" };
}

/**
 * Operation 2: whether a parked flow may resume at `target`.
 *
 * Permission is read off the reason the flow parked with, never off the step it
 * parked at.
 */
export function permitsResume(state, reason, target) {
  if (reason === undefined) {
    throw new GraphRefusal(
      "resume_target_not_permitted",
      "the flow is parked and no park reason is recorded, so nothing permits a target",
    );
  }
  const row = state.recovery.get(reason);
  if (!row) throw new GraphRefusal("resume_target_not_permitted", `${reason} has no recovery row`);
  if (!state.steps.has(target)) throw new GraphRefusal("step_unknown", target);
  if (!row.resume_targets.includes(target)) {
    throw new GraphRefusal(
      "resume_target_not_permitted",
      `${reason} permits ${row.resume_targets.join(", ")} and not ${target}`,
    );
  }
  return true;
}

/**
 * The veto the engine runs for every transition: may the flow make this move?
 *
 * Returns nothing and throws a {@link GraphRefusal} when the answer is no, which
 * is the shape `onTransit` is specified in — the engine rejects the transition
 * on a throw and commits it otherwise.
 *
 * `context` is `{ step, parked, parkedWith }`: the step being left (empty on
 * enroll), whether the task is parked, and the reason it parked with.
 */
export function admit(state, context, to, evaluate) {
  const { step, parked, parkedWith } = context;

  // A parked flow moves by operation 2 and by nothing else. A status target here
  // would be an operator flipping a status rather than the graph moving, and the
  // graph has nothing to say about it, so it is refused rather than waved past.
  if (parked) {
    if (!("step" in to)) {
      throw new GraphRefusal("transition_not_declared", "a parked flow resumes at a step, and the graph declares no status move");
    }
    // Re-entering the step it already stands at needs no permission ONLY when
    // nothing said why the flow stopped — the daemon's own park after an
    // infrastructure failure, which carries no reason because the graph did not
    // park it. A RECORDED reason governs every target including this one. The
    // first writing of this rule was unconditional, and a reason that permits
    // five targets and not this step admitted it anyway: re-entry runs the step's
    // body and its effects again, so "it grants nothing new" was not true either.
    if (parkedWith === undefined && to.step === step) return;
    permitsResume(state, parkedWith, to.step);
    return;
  }

  // Enroll: the engine leaves no step, so there is no edge to check. The one
  // move the document declares is into its first step.
  if (step === "") {
    if (!("step" in to) || to.step !== state.document.first_step) {
      const named = "step" in to ? to.step : `status ${to.status}`;
      throw new GraphRefusal("transition_not_declared", `enroll enters ${state.document.first_step} and not ${named}`);
    }
    return;
  }

  // Parking in place: the flow could not leave, and the reason it parks with is
  // the one selection gave. Any other status target is a move the graph does not
  // declare — the document says where a flow may go by declaring an edge.
  //
  // Selection is run here and nowhere else on this path. Running it for a
  // `{ step }` target too would let a malformed guard on some OTHER edge out of
  // this step decide the refusal for a move that edge has nothing to do with.
  if ("status" in to) {
    const decision = select(state, step, evaluate);
    if (decision.take) {
      throw new GraphRefusal("transition_not_declared", `${step} has a candidate edge, so it does not park`);
    }
    if (to.status !== "human") {
      throw new GraphRefusal("transition_not_declared", `${step} parks in human and not in ${to.status}`);
    }
    return;
  }

  if (!state.steps.has(to.step)) throw new GraphRefusal("step_unknown", to.step);
  // Several edges may join the same pair — a step parks in `human` for up to
  // twelve different conditions — so the move is admitted when any of them
  // holds, and refused with the reason of the one the graph would have preferred.
  const edges = (state.outgoing.get(step) ?? []).filter((edge) => edge.to === to.step);
  if (edges.length === 0) {
    throw new GraphRefusal("transition_not_declared", `${step} -> ${to.step} is not a declared edge`);
  }
  let refused;
  for (const edge of edges) {
    const verdict = holds(state, edge, evaluate);
    if (verdict.ok) return;
    refused ??= verdict.guard;
  }
  if (typeof refused.park_reason !== "string") {
    throw new GraphRefusal("guard_unknown", `${refused.id} declares no park reason, so it can refuse nothing by name`);
  }
  throw new GraphRefusal(refused.park_reason, `${step} -> ${to.step} is guarded by ${refused.id}`);
}

/**
 * The reason a parked flow carries, read from the task's metadata bag.
 *
 * `park.reason` is the plan's own notation for it — every recovery row's
 * `required_state` is written as `human с park.reason=<code>` — and the daemon
 * has no park reason of its own: `metadata` is free-form and opaque to it apart
 * from the `step_visits` counter it maintains.
 */
export function parkReasonOf(metadata) {
  const park = metadata?.park;
  return typeof park?.reason === "string" ? park.reason : undefined;
}

/**
 * The workflow definition an extension registers.
 *
 * `steps` and `firstStep` are the document's; `onTransit` is the veto above.
 * `graphDigest` travels with it so the daemon can cover what the declared shape
 * cannot: a declaration carries steps and hook names, and the transitions,
 * guards, caps and recovery targets that make this graph what it is are only
 * reachable through the document this was built from.
 *
 * `agents` supplies the body of each step's work, keyed by step name. Bodies are
 * code and belong to the distribution digest; which steps exist and which hooks
 * they declare is structure and belongs to this document.
 */
export function buildWorkflow(document, { evaluate, agents = {} } = {}) {
  if (typeof evaluate !== "function") {
    throw new TypeError("buildWorkflow needs a predicate evaluator; the document declares predicates and does not decide them");
  }
  // Computed, not believed. A document carrying a digest that does not describe
  // it would pin a task to a shape its graph does not have, and the field is an
  // ordinary property of an ordinary object the caller hands in. `validate:
  // workflow-graph` checks the file in this repository; it cannot check the
  // object this function was called with, which is the boundary that matters.
  const digest = graphDigest(document);
  if (document.canonical_digest !== undefined && document.canonical_digest !== digest) {
    throw new GraphRefusal(
      "graph_digest_stale",
      `the document carries ${document.canonical_digest} and its own bytes hash to ${digest}`,
    );
  }
  const state = index(document);
  // A document that cannot say why one of its parks happened is not executable,
  // and this is decided here rather than when such an edge is taken. A runtime
  // refusal fails the session, the engine then parks the task, and whatever an
  // earlier park recorded is still in `park.reason` — so the flow resumes on
  // permissions belonging to a stop that was already over. Clearing the reason
  // first only moved the hole onto the clearing's own error path, which round 1
  // attempt 3 measured. Nothing inside a running step can close it, because the
  // engine parks the task after the step gives up, and the factory has no write
  // that lands with the position.
  const ambiguous = [...state.outgoing.values()]
    .flat()
    .filter((edge) => parks(state, edge.to) && !nameable(state, edge));
  if (ambiguous.length > 0) {
    throw new GraphRefusal(
      "park_reason_ambiguous",
      `${ambiguous.length} edge(s) park the task without naming why: ${ambiguous.map((edge) => edge.id).join(", ")}`,
    );
  }
  const steps = {};
  for (const step of document.steps) {
    if (step.kind === "status") {
      steps[step.name] = { status: step.status };
      continue;
    }
    // The shipped document declares no `hooks` anywhere, so every agent step has
    // `onRun` and nothing else. A document that declares more is refused rather
    // than quietly built without them: hook presence is part of the shape the
    // daemon digests, and building fewer hooks than the document declares would
    // make the shape a function of this code instead of the document.
    if (step.hooks !== undefined && (step.hooks.length !== 1 || step.hooks[0] !== "onRun")) {
      throw new TypeError(`${step.name} declares hooks ${step.hooks.join(", ")}; this factory builds onRun`);
    }
    steps[step.name] = { onRun: (ctx) => run(state, step, agents[step.name], evaluate, ctx) };
  }

  return {
    name: document.workflow,
    firstStep: document.first_step,
    steps,
    graphDigest: digest,
    onTransit: async (ctx, to) => {
      // One store read per transition, because `TransitContext` carries the step
      // being left and not the status: whether the flow is parked, and with what
      // reason, is only on the record.
      const task = await ctx.tasks.current();
      const context = {
        step: ctx.step,
        parked: task.status === "human",
        parkedWith: parkReasonOf(task.metadata),
      };
      admit(state, context, to, (predicate, guard) => evaluate(predicate, guard, task));
    },
  };
}

/**
 * One step's run: do the work, then go where the graph says.
 *
 * The engine requires exactly one `ctx.transit` per run, so the decision is not
 * optional and not the work function's to make. A step body that wanted to
 * choose its own destination would be a second state machine beside the one the
 * document declares.
 */
async function run(state, step, work, evaluate, ctx) {
  if (work) await work(ctx);
  // Read after the work, not before: the predicates read the task record, and
  // what the step just recorded is exactly what the next decision is about.
  const task = await ctx.tasks.current();
  const decision = select(state, step.name, (predicate, guard) => evaluate(predicate, guard, task));
  if (decision.take) {
    // A declared edge into a parking step stops the task just as surely as
    // finding no candidate does, and operation 2 reads permission off the reason.
    // The first writing recorded a reason only on the second of those, so the
    // 202 edges the shipped graph draws into a human step parked with whatever
    // reason the PREVIOUS park had left behind, or with none at all — and a
    // resume the reason permits was refused because no reason was there.
    if (parks(state, decision.take.to)) await recordPark(ctx, parkReasonFor(state, decision.take));
    await ctx.transit({ step: decision.take.to });
    return;
  }
  await recordPark(ctx, decision.park);
  await ctx.transit({ status: "human" });
}

/** Whether arriving at this step stops the task where a resume must find it. */
export function parks(state, name) {
  const step = state.steps.get(name);
  return step.kind === "status" && step.status === "human";
}

/**
 * The reason the document names for parking on a taken edge.
 *
 * It is the `park_reason` of the guards that admitted it. The plan writes the
 * pairing into the predicate descriptions themselves — `cond_002` ends "human с
 * park.reason=planning_ref_capability_missing" and `guard_002` carries exactly
 * that reason — and 193 of the 202 edges into a human step are guarded by one
 * guard, so the document answers.
 *
 * Nine are guarded by several guards naming DIFFERENT reasons. An edge is taken
 * when all its guards hold, so at that moment every one of those reasons is
 * true and the document does not say which to record. Picking one would give the
 * next resume the permissions of a reason nobody chose, so this refuses instead
 * and the choice stays with whoever writes the document.
 */
export function parkReasonFor(state, edge) {
  const reasons = reasonsOn(state, edge);
  if (reasons.length === 1) return reasons[0];
  throw new GraphRefusal(
    "park_reason_ambiguous",
    reasons.length === 0
      ? `${edge.id} parks the task and no guard names a reason`
      : `${edge.id} parks the task and its guards name ${reasons.length} reasons: ${reasons.join(", ")}`,
  );
}

/** The distinct park reasons the guards of one edge name. */
function reasonsOn(state, edge) {
  return [...new Set(edge.guards.map((id) => state.guards.get(id).park_reason))];
}

/** Whether the document says which reason this edge parks with. */
export function nameable(state, edge) {
  return reasonsOn(state, edge).length === 1;
}

/**
 * Records why the flow parked, before it parks.
 *
 * A park whose reason is not recorded cannot be resumed: operation 2 reads
 * permission off the reason, so losing it would leave the task parked with
 * nothing able to say where it may go. That is why a failed write throws instead
 * of parking anyway.
 */
async function recordPark(ctx, reason) {
  const result = await ctx.exec(["autosk", "metadata", "set", ctx.tasks.currentId, "park.reason", reason], {
    cwd: ctx.projectRoot,
    env: { ...process.env, AUTOSK_CWD: ctx.projectRoot, AUTOSK_SESSION_TOKEN: ctx.sessionToken },
  });
  if (result.code !== 0) {
    throw new Error(`recording park reason ${reason} failed with ${result.code}: ${result.stderr}`);
  }
}
