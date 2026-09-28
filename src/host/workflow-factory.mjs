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
 * the reason for this park. A target the row declares the user's decision
 * (`decision_targets`) is admitted only on the decision recorded under that
 * park — a verified daemon UserDecisionRecord of this task's resume from this
 * park into that target, which the admitter the caller hands in looks up and
 * verifies: a round past a cap is the user's, one per decision, and so is a
 * re-stage onto a moved target. With no admitter, or no signer, none is
 * admitted.
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

// The one module this imports: the extensions the autosk verifiers build ship
// this file and the canonical form beside it and nothing else, so anything
// more is handed in (CI on #270).
import { graphDigest } from "./workflow-graph-canonical.mjs";

/**
 * Every way this factory refuses, which is not every reason a flow stops.
 *
 * These seven are the factory's own: it issues them when the document cannot
 * answer. The reasons a flow parks with — a step's `no_transition_reason`, a
 * guard's `park_reason` — are the document's, drawn from the park vocabulary,
 * and are relayed rather than invented here.
 */
export const REFUSALS = Object.freeze([
  "cap_binding_ambiguous",
  "cap_binding_incomplete",
  "graph_digest_stale",
  "guard_unknown",
  "no_transition_reason",
  "park_reason_ambiguous",
  "predicate_unknown",
  "resume_target_not_permitted",
  "status_unknown",
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
  // And the register selects from the union a relocation can carry: a status
  // outside `done|cancel|human` names an operation the wire cannot express, so
  // nothing downstream could ever perform it — the CLI would neither name it
  // nor accept it nor refuse it, which is the silent drift this refuses. The
  // schema's enum already says it at design time; this is the same check at
  // build, where the document becomes the boundary the daemon sees.
  const unperformable = [...externalOperations.keys()].filter(
    (status) => status !== "done" && status !== "cancel" && status !== "human",
  );
  if (unperformable.length > 0) {
    throw new GraphRefusal(
      "status_unknown",
      `external_operations declares ${unperformable.join(", ")}, which no status relocation can carry (done|cancel|human)`,
    );
  }
  // Where a flow may start: the first step and the steps the other registered
  // workflows enter at. The veto needs it to tell an entry from a continuation.
  const entries = new Set([
    document.first_step,
    ...(document.entry_steps ?? []).map((entry) => entry.step),
  ]);
  // The cap terms, bound per guard once: a cap counts the takings of every
  // transition it names as ONE count against its limit, so each counted edge
  // admits below the limit, and the sibling edges out of a counted edge's
  // step that carry its park_reason are how the flow stops at it, so their
  // guards ask the same count the other way. One count is what lets "ten
  // rounds" mean ten of either kind: a narrow review's and a full panel's
  // NOT_PASS spend the same budget (R8-4). The counter is keyed by the pair
  // traversed — `graph_cap_transition_shared` keeps a counted pair to one
  // edge for exactly this — so a term reads the pairs the cap's
  // `counted_transitions` traverse, each pair once, never an edge's id.
  // A cap that declares a `cycle_boundary` counts per cycle: the pair whose
  // taking closes one cycle and opens the next, which the daemon counts as it
  // counts every pair, so the count is the takings since the cycle's last
  // recorded crossing (review of 12c, M1). Each term carries the cap's own
  // reason, which a refusal at the limit names (review of 12c, L4).
  const capTerms = new Map();
  const capBindings = new Map();
  const boundEdges = new Map();
  const boundaries = [];
  const bindCap = (id, edge, cap, pairs, below, boundary) => {
    const term = { pairs, limit: cap.limit, below, reason: cap.park_reason, ...(boundary ? { boundary } : {}) };
    capTerms.set(id, [...(capTerms.get(id) ?? []), term]);
    capBindings.set(id, [...(capBindings.get(id) ?? []), { edge, cap }]);
    const entry = boundEdges.get(edge.id) ?? { edge, caps: new Set() };
    entry.caps.add(cap);
    boundEdges.set(edge.id, entry);
  };
  const guardRefs = new Map();
  for (const edge of document.transitions) {
    for (const id of new Set(edge.guards)) {
      guardRefs.set(id, [...(guardRefs.get(id) ?? []), edge]);
    }
  }
  for (const cap of document.caps ?? []) {
    // A cap that names nothing to count has nothing to bind below its limit,
    // and one still written with a single `counted_transition` is refused by
    // name rather than read as counting nothing.
    if (!Array.isArray(cap.counted_transitions) || cap.counted_transitions.length === 0) {
      throw new GraphRefusal(
        "cap_binding_incomplete",
        `cap ${cap.cycle} names no counted transition, so nothing it bounds is ever counted`,
      );
    }
    const counted = cap.counted_transitions.map((id) => {
      const edge = document.transitions.find((candidate) => candidate.id === id);
      if (edge === undefined) throw new GraphRefusal("transition_not_declared", `cap ${cap.cycle} counts ${id}`);
      if (edge.guards.length === 0) {
        throw new GraphRefusal(
          "cap_binding_incomplete",
          `cap ${cap.cycle} counts ${edge.id}, which declares no guards to bind below its limit`,
        );
      }
      return edge;
    });
    const pairs = [
      ...new Map(counted.map((edge) => [JSON.stringify([edge.from, edge.to]), { from: edge.from, to: edge.to }])).values(),
    ];
    // The boundary is crossed only on what its edges' guards verify — for
    // the shipped artifact cap, the published PASS — so a pair no edge joins,
    // a pair the cap counts (a taking that would both spend a round and close
    // the cycle) and an unguarded edge on it are refused rather than counted.
    let boundary;
    if (cap.cycle_boundary !== undefined) {
      const { from, to } = cap.cycle_boundary ?? {};
      const crossing = document.transitions.filter((edge) => edge.from === from && edge.to === to);
      if (crossing.length === 0) {
        throw new GraphRefusal(
          "transition_not_declared",
          `cap ${cap.cycle}'s cycle boundary ${from} -> ${to} joins no declared transition`,
        );
      }
      if (pairs.some((pair) => pair.from === from && pair.to === to)) {
        throw new GraphRefusal("cap_binding_ambiguous", `cap ${cap.cycle} counts ${from} -> ${to} and closes its cycle on it`);
      }
      const unguarded = crossing.filter((edge) => edge.guards.length === 0);
      if (unguarded.length > 0) {
        throw new GraphRefusal(
          "cap_binding_incomplete",
          `cap ${cap.cycle}'s cycle closes on ${unguarded.map((edge) => edge.id).join(", ")}, ` +
            "which declares no guards, so nothing verifies the boundary it crosses",
        );
      }
      boundary = { cycle: cap.cycle, from, to };
      boundaries.push({ ...boundary, pairs });
    }
    const countedIds = new Set(counted.map((edge) => edge.id));
    for (const edge of counted) {
      for (const id of edge.guards) bindCap(id, edge, cap, pairs, true, boundary);
    }
    for (const from of new Set(counted.map((edge) => edge.from))) {
      const carrying = (outgoing.get(from) ?? []).filter(
        (edge) => !countedIds.has(edge.id) && edge.guards.some((id) => guards.get(id).park_reason === cap.park_reason),
      );
      if (carrying.length === 0) {
        throw new GraphRefusal(
          "cap_binding_incomplete",
          `cap ${cap.cycle} has no edge out of ${from} carrying ${cap.park_reason} to park on at the limit`,
        );
      }
      for (const edge of carrying) {
        for (const id of edge.guards) bindCap(id, edge, cap, pairs, false, boundary);
      }
    }
  }
  // The binding is per guard, and it can only be read one way: a guard a
  // second edge also references would carry the cap's constraint onto a move
  // the cap never named, and an edge two caps bind would owe both limits —
  // shapes the document is refused for rather than answered wrong on every
  // decision.
  for (const [id, bindings] of capBindings) {
    const caps = [...new Set(bindings.map(({ cap }) => cap.cycle))].join(" and ");
    const boundSet = new Set(bindings.map(({ edge }) => edge.id));
    const outside = (guardRefs.get(id) ?? []).filter((edge) => !boundSet.has(edge.id));
    if (outside.length > 0) {
      throw new GraphRefusal(
        "cap_binding_ambiguous",
        `guard ${id} carries ${caps}'s term on ${[...boundSet].join(", ")} ` +
          `and is also referenced by ${outside.map((edge) => edge.id).join(", ")}`,
      );
    }
    if (boundSet.size > 1) {
      throw new GraphRefusal(
        "cap_binding_ambiguous",
        `guard ${id} carries ${caps}'s term on ${[...boundSet].join(" and ")}`,
      );
    }
  }
  for (const { edge, caps } of boundEdges.values()) {
    if (caps.size > 1) {
      throw new GraphRefusal(
        "cap_binding_ambiguous",
        `edge ${edge.id}, guarded by ${edge.guards.join(", ")}, is bound by ` +
          `${[...caps].map((cap) => cap.cycle).join(" and ")}`,
      );
    }
  }
  return { steps, guards, predicates, outgoing, recovery, externalOperations, entries, capTerms, boundaries, document };
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
 * Whether a guard's cap terms hold on the task's record.
 *
 * An unbound guard owes nothing and holds vacuously. A bound one asks the
 * durable counter for the pairs its cap counts and sums them, each pair once
 * — below the limit for a counted edge's own guards, at it for the carrying
 * siblings' — and every one of its terms must hold, because each is a cap the
 * document declared.
 */
function capHolds(terms, task) {
  if (terms === undefined) return true;
  for (const term of terms) {
    if (!termHolds(term, task)) return false;
  }
  return true;
}

/** One cap term on the task's record: its cycle's count below the limit, or at it. */
function termHolds(term, task) {
  const count = cycleCount(term, task);
  return term.below ? count < term.limit : count >= term.limit;
}

/**
 * The count a cap term compares with its limit: the durable takings of the
 * pairs its cap counts, each pair once — all of them for a cap with no cycle
 * boundary, and for one with a boundary those since its cycle's baseline
 * (review of 12c, M1).
 */
function cycleCount(term, task) {
  let spent = 0;
  for (const { from, to } of term.pairs) spent += takingsOf(task, from, to);
  return term.boundary === undefined ? spent : spent - baselineOf(task, term.boundary, spent);
}

/** Where the factory records each cycle's baseline in the task's metadata. */
export const BASELINES_KEY = "cap_baselines";

/**
 * Where the current cycle's count began.
 *
 * Which cycle a task is in is the daemon's durable count of the boundary
 * pair's takings, `crossed`. Where the count stood at a crossing the daemon
 * does not keep, and the factory has no write that lands with the position,
 * so the factory records it before it takes the boundary —
 * `cap_baselines.<cycle>.<n>`, keyed by the crossing `n` that transit makes
 * — and this reads the entry keyed by the daemon's count. The watermark is
 * ADR-099's pattern: a leaf of the factory's, scoped by a counter of the
 * daemon's.
 *
 * What that holds is a floor, not an exact cycle: the count never falls
 * below the rounds since the last verified publication of a PASS, since the
 * factory writes a baseline only as it takes a boundary edge whose guards
 * verified the publication. The daemon counts other takings of the pair as
 * crossings too — a resume out of a park recorded as a status move keeps
 * the step and counts `<step> -> <target>`, so resuming a park at the
 * boundary's step into its target is one — and such a crossing opens a cycle
 * only on a baseline written for a verified publication whose transit did
 * not land; with none, the next artifact goes on counting the last one's
 * rounds (narrow re-review of 12c, Low 1).
 *
 * A baseline never exceeds the count at its crossing, since the count only
 * grows, so every fallback here counts more, never less: an entry keyed
 * ahead of the daemon's count — written for a transit that did not land — is
 * not read, nor one that is not a count or stands above the current count,
 * and a crossing with no entry — a running session's own transit, which
 * writes none — reads the nearest earlier one, and none at all reads zero.
 * A negative entry is read and counts more still. The keys are the
 * crossings' numbers in canonical decimal, and own integer keys enumerate in
 * ascending order, so the last entry read before a key passes the daemon's
 * count is the nearest one.
 */
function baselineOf(task, boundary, spent) {
  const crossed = takingsOf(task, boundary.from, boundary.to);
  const recorded = ownRecord(ownRecord(task.metadata, BASELINES_KEY), boundary.cycle);
  let baseline = 0;
  if (recorded === undefined) return baseline;
  for (const key of Object.keys(recorded)) {
    if (!/^[1-9][0-9]{0,8}$/u.test(key)) continue;
    if (Number(key) > crossed) break;
    const value = recorded[key];
    if (Number.isSafeInteger(value) && value <= spent) baseline = value;
  }
  return baseline;
}

/** Whether a parsed value is a record: an object, and neither null nor an array. */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An own record-valued entry of a parsed record, or nothing: inherited names and arrays are not records. */
function ownRecord(bag, key) {
  const value = isRecord(bag) && Object.hasOwn(bag, key) ? bag[key] : undefined;
  return isRecord(value) ? value : undefined;
}

/**
 * The durable count of one pair's takings, read by own key at both levels.
 *
 * The record is parsed JSON, and a step named `constructor` or `__proto__`
 * still answers an inherited property to a member read — none of which is a
 * taking count. An array is no count either, at either level, however its own
 * keys name a step — the daemon's reader excludes it the same way. What is not
 * an own numeric entry is no taking at all.
 */
function takingsOf(task, from, to) {
  const bySource = task.metadata?.transition_takings;
  if (bySource === null || typeof bySource !== "object" || Array.isArray(bySource) || !Object.hasOwn(bySource, from)) return 0;
  const byTarget = bySource[from];
  if (byTarget === null || typeof byTarget !== "object" || Array.isArray(byTarget) || !Object.hasOwn(byTarget, to)) return 0;
  const count = byTarget[to];
  return Number.isFinite(count) ? count : 0;
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
 * The watermark of one park of `reason`: the reason and the visit counts of
 * its row's parks_at steps, in row order. A completion receipt and a decision
 * leaf carry it, and each matches only while none of those steps has been
 * re-entered — re-entry is how another park of the reason begins, and the
 * daemon's counter records it in the same write as the position.
 */
function watermarkOf(reason, row, visits) {
  return `${reason}@${row.parks_at.map((name) => `${name}:${visits[name] ?? 0}`).join(",")}`;
}

/** A decision leaf: the watermark it was recorded under, `#`, and the decision record's digest. */
const DECISION = /^(.+)#([a-f0-9]{64})$/u;

/**
 * The admitter a factory has when its caller hands in none: it admits no
 * decision, so a decision-gated resume is refused (fail closed).
 */
function noAdmitter() {
  throw new Error("no decision admitter is handed in, so no UserDecisionRecord admits the resume");
}

/**
 * Operation 2: whether a parked flow may resume at `target`.
 *
 * Permission is read off the reason the flow parked with, never off the step it
 * parked at. `park` is the task's park record — `park.receipts` names the
 * handling steps completed under it, and `park.decision` the user's decision
 * recorded under it — and `visits` is the daemon's `step_visits` counter,
 * which the receipts and the decision are checked against. `decisions` is
 * what a decision-gated resume is checked with: `task`, the id of the task
 * resuming, and `admitDecision`, the caller's admitter — asked about
 * `{ digest, task, reason, watermark, target }` once the leaf's shape and
 * watermark hold, it admits by returning `true` (`resumeDecisionAdmitter` in
 * `user-decision.mjs` checks the record the digest names). Without one,
 * nothing is admitted.
 */
export function permitsResume(state, reason, target, park = {}, visits = {}, decisions = {}) {
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
  // A scoped row lends none of its targets across its steps. Under `origin`
  // the one it permits is the step the park recorded as its origin, which the
  // park record carries because recordPark writes it before the reason; under
  // `origin_edges` also a step an edge out of that origin reaches. A park with
  // no origin recorded has none, and no edge to go by, so it permits nothing.
  if (
    row.resume_scope !== undefined &&
    park.origin !== target &&
    !(row.resume_scope === "origin_edges" && (state.outgoing.get(park.origin) ?? []).some((edge) => edge.to === target))
  ) {
    throw new GraphRefusal(
      "resume_target_not_permitted",
      `${reason} resumes only from the step its park stood at (${park.origin ?? "none recorded"}), not into ${target}`,
    );
  }
  // A target the row declares the user's decision (`decision_targets`, which
  // the validator holds to the graph) owes the decision recorded under THIS
  // park (ADR-099): for a row a cap parks with, the targets that run another
  // round — the cap bounds the rounds that run on their own, its limit is the
  // document's and its count the durable takings, and no decision resets the
  // one or raises the other, so a round past it is the user's, one per
  // decision; for any other row, the targets a person's edge enters, such as
  // a re-stage onto a moved target. A target the row does not declare owes
  // nothing. The park record must carry `park.decision`: this park's watermark, the
  // same one a completion receipt carries, `#`, and the digest of the daemon
  // UserDecisionRecord that decided it. A decision recorded under an earlier
  // park of the reason stops matching when whatever parked it again re-enters
  // a step the row parks at, so it buys no second resume. The leaf is what the
  // resume path writes from a verified decision (#35).
  //
  // The leaf's shape and park are not the decision (CodeRabbit on #270): a
  // leaf is metadata any holder of the CLI can write, so one copied from
  // another task parked with the same watermark would open this one. The
  // record it names is the decision, and the caller's admitter checks it as
  // the decision queue checks an answer (ADR-091): the record the leaf's
  // digest names, verified under the caller's verifier — which by default
  // knows no signer (ADR-090, #4), so on a real host today every
  // decision-gated resume is refused — and about this project's task, this
  // park and this target (the admitter is one project's, R8-15), answering
  // exactly that resume. The admitter is handed in rather than imported (CI
  // on #270), and only its plain `true` admits: a refusal it throws, or any
  // other answer, refuses.
  if ((row.decision_targets ?? []).includes(target)) {
    const decided = typeof park.decision === "string" ? DECISION.exec(park.decision) : null;
    const watermark = watermarkOf(reason, row, visits);
    if (decided === null || decided[1] !== watermark) {
      throw new GraphRefusal(
        "resume_target_not_permitted",
        `${reason} resumes into ${target} only on the user's decision recorded under this park ` +
          `(park.decision ${watermark}#<UserDecisionRecord digest>), and ` +
          (decided === null ? "none is recorded" : `the one recorded is ${decided[1]}'s`),
      );
    }
    const { task, admitDecision = noAdmitter } = decisions ?? {};
    let admitted = false;
    let why = "the admitter did not admit it";
    try {
      admitted = admitDecision({ digest: decided[2], task, reason, watermark, target }) === true;
    } catch (error) {
      why = error.message;
    }
    if (!admitted) {
      throw new GraphRefusal(
        "resume_target_not_permitted",
        `${reason} resumes into ${target} only on a verified UserDecisionRecord of task ${task}'s resume from this park ` +
          `into ${target}, and the one ${decided[2]} names is not admitted: ${why}`,
      );
    }
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
  const watermark = watermarkOf(reason, row, visits);
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
 * `context` is `{ step, parked, parkedWith, park, visits, decisions }`: the
 * step being left (empty on enroll), whether the task is parked, the reason it
 * parked with, the park record itself, the daemon's visit counter — the record
 * and the counter are what operation 2's completion receipts answer to — and
 * what a decision-gated resume is checked with (`permitsResume`). `explain`
 * says what a refusing guard names: its own `park_reason` unless the caller
 * says otherwise — the built veto names the cap's reason when the guard's own
 * predicate held and its cap term did not (review of 12c, L4).
 */
export function admit(state, context, to, evaluate, explain = ownReason) {
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
  // bypass: of the ninety-eight recovery rows exactly one names an entry step among
  // its targets — one row names `implement` — and that row permits
  // it while the task is parked anyway, so nothing is reachable here that was not
  // reachable before.
  // A parked task is exempt: `parked` IS the human status, which is the graph's own
  // park state, so a task standing at it is governed by the recovery rows below even
  // when the register also names `human` — otherwise declaring that exit would mark
  // every ordinarily-parked task out of the graph and refuse its resume entirely.
  if (!parked && typeof status === "string" && state.externalOperations.has(status) && !state.entries.has(to.step)) {
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
    permitsResume(state, parkedWith, to.step, context.park, context.visits, context.decisions);
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
  const { reason, why } = explain(refused);
  throw new GraphRefusal(reason, `${step} -> ${to.step} is guarded by ${refused.id}${why}`);
}

/** What a refusing guard names by default: its own park reason. */
function ownReason(guard) {
  return { reason: guard.park_reason, why: "" };
}

/**
 * What a guard the veto found refusing names on the task's record. A guard
 * whose caller answered yes and whose cap term did not was refused by the
 * cap, so the refusal names the cap's reason — the condition that refused
 * the move — rather than the guard's own, which names a condition that held
 * (review of 12c, L4). A guard its caller refused names its own, whatever the
 * count.
 */
function capExplained(state, guard, task, evaluate) {
  const terms = state.capTerms.get(guard.id);
  if (terms !== undefined && evaluate(guard.predicate, guard, task)) {
    const spent = terms.find((term) => !termHolds(term, task));
    if (spent !== undefined) {
      const limit = spent.below ? "at its limit" : "below its limit";
      return { reason: spent.reason, why: `, whose cap stands ${limit} (${cycleCount(spent, task)} of ${spent.limit})` };
    }
  }
  return ownReason(guard);
}

/**
 * The reason a parked flow carries, read from the task's metadata bag.
 *
 * `park.reason` is the plan's own notation for it — every recovery row's
 * `required_state` is written as `human с park.reason=<code>` — and the daemon
 * has no park reason of its own: `metadata` is free-form and opaque to it apart
 * from the `step_visits` and `transition_takings` counters it maintains.
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
 * reachable through the document this was built from. `exits` carries the
 * `external_operations` register — the statuses an operator may relocate a
 * parked task to — which the shape digest now covers the same way.
 *
 * `agents` supplies the body of each step's work, keyed by step name. Bodies are
 * code and belong to the distribution digest; which steps exist and which hooks
 * they declare is structure and belongs to this document.
 *
 * `admitDecision` is what a decision-gated resume is checked with, handed in as
 * the evaluator is: `resumeDecisionAdmitter({ projectRootSha256, record,
 * verifySignature })` from `user-decision.mjs`, built for this project, over
 * its store and the ADR-023 verifier.
 * Without one no decision-gated resume is admitted (CodeRabbit on #270); it is
 * handed in rather than imported, so this module needs nothing but the
 * canonical form beside it (CI on #270).
 */
export function buildWorkflow(document, { evaluate, agents = {}, admitDecision } = {}) {
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
  // The evaluator every decision runs through: the caller's answer, and for
  // the guards a cap binds, the cap's own term over the durable count. The
  // layer can only narrow — a refused predicate stays refused however the
  // count stands, and one wrongly admitted still loses the counted edge at
  // the limit — and both decision sites run through it, because selection and
  // the veto cannot disagree about a cap for the same reason they cannot
  // disagree about a guard.
  const deciding = (task) => (predicate, guard) =>
    evaluate(predicate, guard, task) && capHolds(state.capTerms.get(guard.id), task);
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
    steps[step.name] = { onRun: (ctx) => run(state, step, agents[step.name], deciding, ctx) };
  }

  return {
    name: document.workflow,
    firstStep: document.first_step,
    steps,
    graphDigest: digest,
    // The register crosses the daemon boundary here: `external_operations` is
    // the only thing in the document the CLI may act on, and until now the
    // shape carried only a digest of it, so `resume --to` restated the status
    // union instead of reading the register. `exits` carries the declared
    // statuses — in the document's own order — and the daemon's shape digest
    // covers it, so a register that changes re-pins the tasks built under it.
    exits: [...state.externalOperations.keys()],
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
        // What a decision-gated resume is checked with: the task that resumes,
        // named by the record the veto just read, and the caller's admitter.
        decisions: { task: task.id, admitDecision },
      };
      admit(state, context, to, deciding(task), (guard) => capExplained(state, guard, task, evaluate));
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
async function run(state, step, work, deciding, ctx) {
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
  const decision = select(state, step.name, deciding(task));
  if (decision.take) {
    // A declared edge into a parking step stops the task just as surely as
    // finding no candidate does, and operation 2 reads permission off the reason.
    // The first writing recorded a reason only on the second of those, so
    // every edge the shipped graph draws into a human step parked with
    // whatever reason the PREVIOUS park had left behind, or with none at all,
    // and a resume the reason permits was refused because no reason was
    // there.
    if (parks(state, decision.take.to)) {
      await recordPark(ctx, parkReasonFor(state, decision.take), step.name);
    } else if (park?.reason !== undefined && !onSurface(row, park, decision.take.to)) {
      // A take off the reason's surface leaves the park behind, and the
      // reason that described it has to leave with it — the origin too: until
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
    // A boundary of a cap's cycle: where the count stood is recorded before
    // the move, keyed by the crossing it makes, so the next cycle counts from
    // there (review of 12c, M1). A write that fails leaves the task where it
    // stood, as a park's record does.
    await recordBaselines(ctx, state, decision.take, task);
    await ctx.transit({ step: decision.take.to });
    return;
  }
  await recordPark(ctx, decision.park, step.name);
  await ctx.transit({ status: "human" });
}

/** Whether arriving at this step stops the task where a resume must find it. */
export function parks(state, name) {
  const step = state.steps.get(name);
  return step.kind === "status" && step.status === "human";
}

/**
 * Whether `name` is on the surface the reason's episode runs on. For a union
 * row that is every step the row names — `parks_at` and `handled_at` together,
 * the same union operation 2 reads as `named`. A scoped row permits nothing
 * lent across its steps, so its surface is the park's origin alone: a take
 * anywhere else leaves the park, and a reason and origin kept past it would
 * later refuse re-entry where an engine park stopped the task and admit only
 * the old origin behind it. The row may be absent: a reason with no recovery
 * row names no surface at all.
 */
function onSurface(row, park, name) {
  if (row === undefined) return false;
  if (row.resume_scope !== undefined) return name === park.origin;
  return row.parks_at.includes(name) || (row.handled_at ?? []).includes(name);
}

/**
 * The reason the document names for parking on a taken edge.
 *
 * It is the `park_reason` of the guards that admitted it. The plan writes the
 * pairing into the predicate descriptions themselves — `cond_002` ends by naming
 * the planning-ref capability park reason, and `guard_002` carries exactly that
 * reason — and every edge into a human step is now guarded by guards naming
 * ONE reason, so the document answers; the validator refuses a document where
 * one does not (`graph_park_reason_ambiguous`).
 *
 * Some once named two or three. An edge is taken when all its guards hold,
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
 * Records where the flow parked and why, before it parks.
 *
 * A park whose reason is not recorded cannot be resumed: operation 2 reads
 * permission off the reason, so losing it would leave the task parked with
 * nothing able to say where it may go. That is why a failed write throws instead
 * of parking anyway. The origin — the step the flow stood at — is what an
 * origin-scoped reason resumes into, and it is written first: a reason written
 * over an origin that did not land would pair with an earlier park's origin.
 */
async function recordPark(ctx, reason, origin) {
  for (const [leaf, value] of [["park.origin", origin], ["park.reason", reason]]) {
    const result = await ctx.exec(["autosk", "metadata", "set", ctx.tasks.currentId, leaf, value], {
      cwd: ctx.projectRoot,
      env: { ...process.env, AUTOSK_CWD: ctx.projectRoot, AUTOSK_SESSION_TOKEN: ctx.sessionToken },
    });
    if (result.code !== 0) {
      throw new Error(`recording ${leaf.replace(".", " ")} ${value} failed with ${result.code}: ${result.stderr}`);
    }
  }
}

/**
 * Records where each cap's count stands as the flow crosses that cap's cycle
 * boundary, before it crosses.
 *
 * The leaf is `cap_baselines.<cycle>.<n>`, `n` the crossing this transit
 * makes in the daemon's count of the boundary pair, and its value the sum of
 * the cap's counted takings — which no counted edge can move between this
 * write and the transit, since the flow stands at the boundary. A write that
 * lands without its transit is keyed ahead of the daemon's count and is not
 * read; the next attempt writes it again. A counter that is not a count keys
 * nothing the reader reads, so the cycle is counted from an earlier
 * baseline. A failed write throws for the reason recordPark's does: a
 * crossing without its baseline is a cycle the cap would count from an
 * earlier one.
 */
async function recordBaselines(ctx, state, edge, task) {
  for (const boundary of state.boundaries) {
    if (boundary.from !== edge.from || boundary.to !== edge.to) continue;
    let spent = 0;
    for (const { from, to } of boundary.pairs) spent += takingsOf(task, from, to);
    const leaf = `${BASELINES_KEY}.${boundary.cycle}.${takingsOf(task, boundary.from, boundary.to) + 1}`;
    const result = await ctx.exec(["autosk", "metadata", "set", ctx.tasks.currentId, leaf, String(spent)], {
      cwd: ctx.projectRoot,
      env: { ...process.env, AUTOSK_CWD: ctx.projectRoot, AUTOSK_SESSION_TOKEN: ctx.sessionToken },
    });
    if (result.code !== 0) {
      throw new Error(`recording ${leaf} ${spent} failed with ${result.code}: ${result.stderr}`);
    }
  }
}

/**
 * Removes the reason and its origin once the flow has left the park they described.
 *
 * `metadata unset` deletes the leaves it is given in one write and prunes the
 * parents they leave empty, so `park.receipts` — the sibling the receipt write
 * lives under — is untouched: the receipts carry their own watermark and
 * re-scope themselves, which is why they can outlive the reason. The origin
 * goes with the reason: left behind, it would be the origin a later reason
 * pairs with. A failed write throws for the same reason recordPark's does: a
 * reason that could not be cleared is a stop the record still describes, and
 * moving anyway would park the next stop under a reason that is not its own.
 */
async function clearParkReason(ctx) {
  const result = await ctx.exec(["autosk", "metadata", "unset", ctx.tasks.currentId, "park.reason", "park.origin"], {
    cwd: ctx.projectRoot,
    env: { ...process.env, AUTOSK_CWD: ctx.projectRoot, AUTOSK_SESSION_TOKEN: ctx.sessionToken },
  });
  if (result.code !== 0) {
    throw new Error(`clearing park reason and origin failed with ${result.code}: ${result.stderr}`);
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
  const watermark = watermarkOf(reason, row, task?.metadata?.step_visits ?? {});
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
