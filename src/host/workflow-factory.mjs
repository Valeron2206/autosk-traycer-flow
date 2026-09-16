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
  // The statuses the document says are driven by an operation outside the workflow.
  // Read here, once, for the same reason every other reference is: the veto must be
  // able to tell an operator flipping a status from an operation the document names.
  const externalOperations = new Map(
    (document.external_operations ?? []).map((operation) => [operation.status, operation]),
  );
  // Where a flow may start: the first step and the steps the other registered
  // workflows enter at. The veto needs it to tell an entry from a continuation.
  const entries = new Set([
    document.first_step,
    ...(document.entry_steps ?? []).map((entry) => entry.step),
  ]);
  return { steps, guards, predicates, outgoing, recovery, externalOperations, entries, document };
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
 * parked at. `park` is the task's park record — `park.receipts` names the
 * handling steps completed under it — and `visits` is the daemon's
 * `step_visits` counter, which the receipts are checked against.
 */
export function permitsResume(state, reason, target, park = {}, visits = {}) {
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
  // A target the row names among its own steps is the recovery surface itself —
  // resuming INTO a handled_at step is how the reason gets dealt with — so it
  // owes no further evidence. Anything else is permitted through an edge out of
  // one of them, and the two kinds of edge lend the permission differently. An
  // edge out of a parks_at step needs nothing more: the park on this reason is
  // the evidence the reason's stop was reached. An edge out of a handled_at
  // step lends it only once the step's handling has COMPLETED under this park
  // — and "this park" is derived, never written: the receipt records the visit
  // counts of the reason's parks_at steps as they stood at completion, and the
  // gate compares them to the counter the daemon bumps on every entry. Another
  // episode of the reason cannot begin without re-entering a step that can
  // produce it, so the watermark moves on its own and a receipt written under
  // an earlier episode stops matching — the same reason included, and however
  // the park record's own writes went. Without the check a task parked at
  // aggregate_verify resumes at draft_artifact on edges that are
  // record_aggregate_remediation's alone, and the artifact is redrawn with no
  // remediation record behind it.
  const named = new Set([...row.parks_at, ...(row.handled_at ?? [])]);
  if (named.has(target)) return true;
  const reaches = (name) => (state.outgoing.get(name) ?? []).some((edge) => edge.to === target);
  if (row.parks_at.some(reaches)) return true;
  const lending = (row.handled_at ?? []).filter(reaches);
  const receipts = park.receipts ?? {};
  const watermark = `${reason}@${row.parks_at.map((name) => `${name}:${visits[name] ?? 0}`).join(",")}`;
  if (lending.some((name) => receipts[name] === watermark)) {
    return true;
  }
  throw new GraphRefusal(
    "resume_target_not_permitted",
    lending.length === 0
      ? `${reason} declares no edge out of a step it names that reaches ${target}`
      : `${reason} reaches ${target} only through ${lending.join(", ")}, whose completion this park does not record`,
  );
}

/**
 * The veto the engine runs for every transition: may the flow make this move?
 *
 * Returns nothing and throws a {@link GraphRefusal} when the answer is no, which
 * is the shape `onTransit` is specified in — the engine rejects the transition
 * on a throw and commits it otherwise.
 *
 * `context` is `{ step, parked, parkedWith, park, visits }`: the step being
 * left (empty on enroll), whether the task is parked, the reason it parked
 * with, the park record itself, and the daemon's visit counter — the record
 * and the counter are what operation 2's completion receipts answer to.
 */
export function admit(state, context, to, evaluate) {
  const { step, parked, parkedWith, status } = context;

  // A task the operation already took out of the workflow is not moved by the graph.
  // The relocation is terminal by declaration — upstream calls the cancel status
  // abandoned, and the way back in is an enroll rather than a transit. Without this
  // the relocation LAUNDERS the park reason: `parked` is the human status alone, so a
  // relocated task reads as running, operation 2 never looks, and the reason still in
  // the record governs nothing. Measured on this document: a task parked at
  // `dispatch_panel` was refused `panel_join` by its row, and after the relocation the
  // same move was admitted as an ordinary edge.
  // The exception is the way back IN. Upstream's enrol admits a task at the cancel
  // status and always targets a step — the workflow's first step unless one is named
  // — and it keeps the old step as the one being left when the workflow does not
  // change, so an enrol and a resume of a cancelled task arrive here in the same
  // shape. The step being left cannot tell them apart; the TARGET can. An entry is
  // where a flow starts, and starting is not continuing.
  //
  // Measured rather than assumed, because admitting entries could have re-opened the
  // bypass: of the eighty-four recovery rows exactly one names an entry step among
  // its targets — one row names `implement` — and that row permits
  // it while the task is parked anyway, so nothing is reachable here that was not
  // reachable before.
  if (typeof status === "string" && state.externalOperations.has(status) && !state.entries.has(to.step)) {
    throw new GraphRefusal(
      "transition_not_declared",
      `${status} is driven by an operation outside the workflow, so the graph continues no task that stands at it`,
    );
  }

  // A parked flow moves by operation 2 and by nothing else. A status target is an
  // operator flipping a status rather than the graph moving, so it is refused —
  // EXCEPT where the document declares that the status is driven by an operation
  // outside the workflow, because then the graph does have something to say about
  // it and what it says is that this is how the outcome is performed. Three rows of
  // the resume contract end in an exit of exactly that kind; before this the
  // document could name the executor and the veto refused it before it could act,
  // which is a carrier on paper and none in the run. A status the document does not
  // declare that way is refused as it always was: `done` is driven by a step, and a
  // relocation to it is still an operator moving a task the graph is holding.
  if (parked) {
    if (!("step" in to)) {
      if (typeof to.status === "string" && state.externalOperations.has(to.status)) return;
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
    permitsResume(state, parkedWith, to.step, context.park, context.visits);
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
        // The status itself, because `parked` answers one question about it and the
        // veto has a second: a task standing at a status an operation drives is out
        // of the workflow, and reading only `parked` classified such a task as
        // running.
        status: task.status,
        parkedWith: parkReasonOf(task.metadata),
        // The whole park record and the daemon's own visit counter: operation
        // 2 reads its lent permissions off the receipts under the record, and
        // the receipts are watermarks over this counter.
        park: task.metadata?.park,
        visits: task.metadata?.step_visits,
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
  // A handled_at step's completion under the current park is the receipt
  // operation 2 asks for, and `work` is in the condition because nothing else
  // may produce one: a step with no registered handler completes nothing and
  // a handler that threw completes nothing, so neither leaves a receipt. The
  // write happens after the work resolves — never on entry — while the park
  // record still names the reason the completion answers. The receipt does not
  // depend on the reason's lifecycle: it re-scopes itself instead, carrying the
  // counts the reason's parks_at steps stood at, so a later episode of the
  // reason — same reason included — moves the watermark without any write of
  // ours needing to land.
  const park = task.metadata?.park;
  const row = state.recovery.get(park?.reason);
  if (work && row && (row.handled_at ?? []).includes(step.name)) {
    await recordReceipt(ctx, step.name, park.reason, row, task);
  }
  const decision = select(state, step.name, (predicate, guard) => evaluate(predicate, guard, task));
  if (decision.take) {
    // A declared edge into a parking step stops the task just as surely as
    // finding no candidate does, and operation 2 reads permission off the reason.
    // The first writing recorded a reason only on the second of those, so the
    // edges the shipped graph draws into a human step — 221 of them — parked
    // with whatever reason the PREVIOUS park had left behind, or with none at
    // all, and a resume the reason permits was refused because no reason was
    // there.
    if (parks(state, decision.take.to)) {
      await recordPark(ctx, parkReasonFor(state, decision.take));
    } else if (park?.reason !== undefined && !rowNames(row, decision.take.to)) {
      // A take to a step the reason's row does not name leaves the park
      // behind, and the reason that described it has to leave with it: until
      // this ran, the record kept saying why a stop that is over happened, and
      // a later engine-side park — which writes no reason of its own — found
      // one already recorded, closing the no-permission re-entry operation 2
      // keeps open for exactly that case. A take inside the row's own surface
      // keeps the reason instead: the step the flow lands on is one this
      // episode's recovery may still be running at, so an engine-side park
      // there is still this park, and a completion still owed its receipt.
      // The clearing cannot live in the veto: the transit ctx carries no exec
      // to write through. It lands here, after the receipt write above and
      // before the position moves, so a record whose write fails leaves the
      // task where it stood rather than mid-move.
      await clearParkReason(ctx);
    }
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
 * Whether `name` is a step the recovery row names — the surface the reason's
 * episode runs on, `parks_at` and `handled_at` together, the same union
 * operation 2 reads as `named`. The row may be absent: a reason with no
 * recovery row names no surface at all.
 */
function rowNames(row, name) {
  return row !== undefined && (row.parks_at.includes(name) || (row.handled_at ?? []).includes(name));
}

/**
 * The reason the document names for parking on a taken edge.
 *
 * It is the `park_reason` of the guards that admitted it. The plan writes the
 * pairing into the predicate descriptions themselves — `cond_002` ends "human с
 * park.reason=planning_ref_capability_missing" and `guard_002` carries exactly
 * that reason — and every one of the 221 edges into a human step is now guarded
 * by guards naming ONE reason, so the document answers.
 *
 * Nine of them named two or three. An edge is taken when all its guards hold,
 * so at that moment every one of those reasons was true and the document did
 * not say which to record; picking one would have given the next resume the
 * permissions of a reason nobody chose. The refusal below is what made that
 * visible, and the document was repaired rather than the rule relaxed — so the
 * refusal stays, for the next document that cannot say why it stops.
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

/**
 * Removes the reason once the flow has left the park it described.
 *
 * `metadata unset` deletes the leaf and prunes the parents it leaves empty, so
 * `park.receipts` — the sibling the receipt write lives under — is untouched:
 * the receipts carry their own watermark and re-scope themselves, which is why
 * they can outlive the reason. A failed write throws for the same reason
 * recordPark's does: a reason that could not be cleared is a stop the record
 * still describes, and moving anyway would park the next stop under a reason
 * that is not its own.
 */
async function clearParkReason(ctx) {
  const result = await ctx.exec(["autosk", "metadata", "unset", ctx.tasks.currentId, "park.reason"], {
    cwd: ctx.projectRoot,
    env: { ...process.env, AUTOSK_CWD: ctx.projectRoot, AUTOSK_SESSION_TOKEN: ctx.sessionToken },
  });
  if (result.code !== 0) {
    throw new Error(`clearing park reason failed with ${result.code}: ${result.stderr}`);
  }
}

/**
 * Records that a handled_at step's work completed under the current park.
 *
 * `park.receipts.<step>` carries the reason and a watermark — the visit counts
 * of that reason's parks_at steps as they stand at completion, in row order.
 * Producing the reason again requires entering one of those steps, which the
 * daemon's own counter records in the same write as the position, so a receipt
 * earned under an earlier episode stops matching the moment a later one is
 * attempted — nothing about the discrimination depends on a factory write
 * landing. The leaf write survives a later `park.reason` write, which is why
 * the watermark and not a clearing re-scopes it. A failed write throws for the
 * same reason recordPark's does: a completion nobody recorded is one the gate
 * must refuse.
 */
async function recordReceipt(ctx, stepName, reason, row, task) {
  const visits = task?.metadata?.step_visits ?? {};
  const watermark = `${reason}@${row.parks_at.map((name) => `${name}:${visits[name] ?? 0}`).join(",")}`;
  const result = await ctx.exec(
    ["autosk", "metadata", "set", ctx.tasks.currentId, `park.receipts.${stepName}`, watermark],
    {
      cwd: ctx.projectRoot,
      env: { ...process.env, AUTOSK_CWD: ctx.projectRoot, AUTOSK_SESSION_TOKEN: ctx.sessionToken },
    },
  );
  if (result.code !== 0) {
    throw new Error(`recording completion receipt for ${stepName} failed with ${result.code}: ${result.stderr}`);
  }
}
