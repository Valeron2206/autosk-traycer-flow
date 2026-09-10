/**
 * Tests for the workflow factory: the document as the thing that runs.
 *
 * The failure being closed is that the workflow was code, so a digest had
 * nothing to cover. Slices 1 to 4 made it a document, pinned what canonical
 * means, rendered its views and checked the lock. This is where the document
 * becomes the machine, and each case below is a way the projection could stop
 * being one.
 *
 * Half of these ask what happens when something is ABSENT rather than changed —
 * an edge with no candidate, a reason with no row, a predicate the document does
 * not declare, a step nothing leaves. Eleven defects earlier in this epic were
 * checks satisfied by the absence of what they checked, every one of them found
 * by review rather than by a suite that only ever varied a value.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { DOCUMENT_PATH, graphDigest, parseStrict } from "../scripts/validate-workflow-graph.mjs";
import { ROOT, closedByContract, readContracts } from "../scripts/validate-refusal-vocabulary.mjs";
import {
  GraphRefusal,
  REFUSALS,
  admit,
  buildWorkflow,
  index,
  nameable,
  parkReasonFor,
  parkReasonOf,
  parks,
  permitsResume,
  select,
} from "../src/host/workflow-factory.mjs";

const document = () => parseStrict(readFileSync(path.join(ROOT, DOCUMENT_PATH), "utf8"));
const always = () => true;
const never = () => false;

/** A document mutated and resealed, so its digest is the one it now deserves. */
const resealed = (mutate) => {
  const graph = document();
  mutate(graph);
  const { canonical_digest, ...body } = graph;
  graph.canonical_digest = graphDigest(body);
  return graph;
};

/**
 * The shipped document with the nine parking edges the owner routed to a
 * build-time refusal repaired, so the rest of the semantics can be exercised.
 *
 * Each of those nine is guarded by two or three guards that name ONE predicate
 * and different park reasons: the condition is single and the reason is not
 * determined. Keeping the first guard therefore changes no condition — the
 * predicate is identical on all of them — and picks a reason so the document
 * becomes executable. It is a repair the document itself owes; the test below
 * asserts the shipped bytes are refused exactly as they are.
 */
const repair = (graph) => {
  const by = new Map(graph.guards.map((guard) => [guard.id, guard]));
  const status = new Map(graph.steps.map((step) => [step.name, step]));
  for (const edge of graph.transitions) {
    const to = status.get(edge.to);
    if (to?.kind !== "status" || to.status !== "human") continue;
    if (new Set(edge.guards.map((id) => by.get(id).park_reason)).size > 1) edge.guards = [edge.guards[0]];
  }
};

const executable = () => resealed(repair);

/** The repaired document, mutated further and resealed. */
const repaired = (mutate) =>
  resealed((graph) => {
    repair(graph);
    mutate(graph);
  });

const refusalOf = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof GraphRefusal, `expected a GraphRefusal, got ${error}`);
    return error;
  }
  return assert.fail("expected a refusal and got none");
};

// --- the declared shape is a function of the document -----------------------

test("the workflow is built from the document and carries its digest", () => {
  const graph = executable();
  const workflow = buildWorkflow(graph, { evaluate: always });
  assert.equal(workflow.name, graph.workflow);
  assert.equal(workflow.firstStep, graph.first_step);
  assert.equal(Object.keys(workflow.steps).length, graph.steps.length);
  assert.equal(workflow.graphDigest, graph.canonical_digest);
  assert.equal(typeof workflow.onTransit, "function");
});

test("a status step declares its status and runs nothing", () => {
  const graph = executable();
  const workflow = buildWorkflow(graph, { evaluate: always });
  for (const step of graph.steps) {
    const built = workflow.steps[step.name];
    if (step.kind === "status") {
      assert.deepEqual(built, { status: step.status }, step.name);
    } else {
      assert.equal(built.status, undefined, `${step.name} is an agent step and drives no status`);
      assert.deepEqual(Object.keys(built), ["onRun"], step.name);
    }
  }
});

test("the declared shape is a function of the document and not of the bodies", () => {
  // What the daemon digests is the structure: which steps exist, what each is,
  // which hooks it declares. Step bodies are code and belong to the distribution
  // digest, so supplying different ones must not move the shape by a byte.
  const shape = (workflow) =>
    JSON.stringify(
      Object.entries(workflow.steps)
        .map(([name, step]) => [name, step.status ?? Object.keys(step).sort().join(",")])
        .sort(),
    );
  const graph = executable();
  const bare = buildWorkflow(graph, { evaluate: always });
  const bodied = buildWorkflow(graph, {
    evaluate: always,
    agents: Object.fromEntries(graph.steps.filter((s) => s.kind === "agent").map((s) => [s.name, async () => {}])),
  });
  assert.equal(shape(bodied), shape(bare));
  assert.equal(bodied.graphDigest, bare.graphDigest);
  assert.equal(shape(buildWorkflow(executable(), { evaluate: always })), shape(bare));
});

test("a document declaring hooks this factory does not build is refused, not built without them", () => {
  // Hook presence is part of the shape the daemon digests. Ignoring a declared
  // hook would make the shape a function of this file rather than the document.
  // Resealed each time: the factory computes the digest and refuses a document
  // whose own digest describes different bytes, so a mutated fixture has to say
  // what it now is.
  const named = document().steps.find((entry) => entry.kind === "agent").name;
  const withHooks = (hooks) => repaired((graph) => {
    graph.steps.find((entry) => entry.name === named).hooks = hooks;
  });
  assert.throws(() => buildWorkflow(withHooks(["onRun", "onAbort"]), { evaluate: always }), TypeError);

  // One hook, and the wrong one. The mutation run found this case missing: with
  // only the pair above, the length check alone carried the refusal and the
  // name check could be inverted without a test noticing.
  assert.throws(() => buildWorkflow(withHooks(["onAbort"]), { evaluate: always }), TypeError);

  const built = buildWorkflow(withHooks(["onRun"]), { evaluate: always });
  assert.equal(Object.keys(built.steps[named]).join(), "onRun");
});

test("a factory with no evaluator refuses to build rather than assuming a predicate holds", () => {
  // Assuming true would make every guard vacuous and every first edge the winner.
  assert.throws(() => buildWorkflow(executable(), {}), TypeError);
  assert.throws(() => buildWorkflow(executable(), { evaluate: null }), TypeError);
});

// --- criterion 2's five components all reach the digest ----------------------

test("changing any of the five components moves the document digest", () => {
  const base = document().canonical_digest;
  const moves = {
    steps: resealed((graph) => {
      graph.steps.find((step) => step.kind === "agent").no_transition_reason = "review_cap";
    }),
    transitions: resealed((graph) => {
      graph.transitions[0].to = graph.transitions[1].to;
    }),
    guards: resealed((graph) => {
      graph.guards[0].park_reason = "review_cap";
    }),
    caps: resealed((graph) => {
      graph.caps[0].limit = 9;
    }),
    recovery: resealed((graph) => {
      graph.recovery[0].resume_targets = [graph.recovery[0].resume_targets[0]];
    }),
  };
  for (const [component, graph] of Object.entries(moves)) {
    assert.notEqual(graph.canonical_digest, base, `${component} changed and the digest did not`);
  }
  assert.equal(
    new Set(Object.values(moves).map((graph) => graph.canonical_digest)).size,
    5,
    "each component moves it somewhere of its own",
  );
});

test("and each of the five therefore moves the digest the workflow carries", () => {
  // One leg of the entailment: the document's digest is what `buildWorkflow`
  // puts on the definition. The others are patch 0032 putting that field in the
  // canonical shape and `validate:runtime-identity-lock` holding the line across
  // the series. The whole of it is measured against a real daemon by
  // `scripts/verify-autosk-graph-digest.mjs`; this is what localises a break.
  const base = buildWorkflow(executable(), { evaluate: always }).graphDigest;
  const changes = [
    (graph) => {
      graph.steps.find((step) => step.kind === "agent").no_transition_reason = "review_cap";
    },
    (graph) => {
      graph.transitions[0].to = graph.transitions[1].to;
    },
    (graph) => {
      graph.guards[0].park_reason = "review_cap";
    },
    (graph) => {
      graph.caps[0].limit = 9;
    },
    (graph) => {
      graph.recovery[0].resume_targets = [graph.recovery[0].resume_targets[0]];
    },
  ];
  const digests = changes.map((change) => buildWorkflow(repaired(change), { evaluate: always }).graphDigest);
  for (const digest of digests) assert.notEqual(digest, base);
  assert.equal(new Set(digests).size, 5);
});

// --- operation 1: selection --------------------------------------------------

test("a false guard disqualifies its edge and does not park the flow", () => {
  const state = index(document());
  // A step with more than one way out, so a disqualified edge leaves a candidate.
  const from = [...state.outgoing].find(([, edges]) => edges.length > 1)[0];
  const edges = state.outgoing.get(from);
  const first = edges[0];

  const all = select(state, from, always);
  assert.equal(all.take.id, first.id, "with everything true the lowest priority wins");

  const withoutFirst = select(state, from, (id) => !first.guards.some((g) => state.guards.get(g).predicate === id));
  assert.ok(withoutFirst.take, "disqualifying the winner must not park the flow");
  assert.notEqual(withoutFirst.take.id, first.id);
  assert.ok(withoutFirst.take.priority > first.priority, "the next candidate by priority takes it");
});

test("zero candidates parks with the step's own reason, not with any other", () => {
  const graph = document();
  const state = index(graph);
  for (const step of graph.steps.filter((entry) => entry.kind === "agent").slice(0, 12)) {
    const parked = select(state, step.name, never);
    assert.equal(parked.take, undefined, `${step.name} took an edge with every guard false`);
    assert.equal(parked.park, step.no_transition_reason, step.name);
  }
});

test("a step nothing leaves parks rather than throwing", () => {
  // Absence, not change: an agent step with no outgoing edge at all still has to
  // answer, and its answer is the reason it carries. The shipped graph strands
  // nobody — which is the property slice 3 fixed — so the case is made rather
  // than looked for, because a test that only runs when the data happens to
  // contain something is a test that usually does not run.
  const graph = document();
  const stranded = graph.steps.find((step) => step.kind === "agent");
  graph.transitions = graph.transitions.filter((edge) => edge.from !== stranded.name);
  assert.equal(select(index(graph), stranded.name, always).park, stranded.no_transition_reason);

  // And what the shipped graph actually does, named rather than assumed. One
  // agent step has nowhere to go: `ticket_done`, whose only reason is the
  // daemon's generic boundary check, so a flow that reaches the end of a ticket
  // parks with a code that says nothing about tickets. That is a gap in the
  // document, not in this projection, and it is written down here so that the
  // next step added with no way out fails this line instead of joining it.
  const shipped = index(document());
  const orphans = document()
    .steps.filter((step) => step.kind === "agent" && (shipped.outgoing.get(step.name) ?? []).length === 0)
    .map((step) => step.name);
  assert.deepEqual(orphans, ["ticket_done"]);
  assert.equal(select(shipped, "ticket_done", always).park, "project_boundary_invalid");
});

test("a step that cannot leave and names no reason parks with the code for that", () => {
  // The schema makes this unreachable from a valid document. It is here because
  // a code closed for a case nobody produces is a set that reads as closed and
  // is not, and because `undefined` is not a park reason anything can resume.
  const graph = document();
  const step = graph.steps.find((entry) => entry.kind === "agent");
  delete step.no_transition_reason;
  graph.transitions = graph.transitions.filter((edge) => edge.from !== step.name);
  assert.equal(select(index(graph), step.name, always).park, "no_transition_reason");
});

test("a status step is answered by its status and asked for no reason", () => {
  const state = index(document());
  assert.deepEqual(select(state, "done", always), { park: null, status: "done" });
  assert.deepEqual(select(state, "human", never), { park: null, status: "human" });
});

test("a step the document never declares is refused, not treated as terminal", () => {
  const state = index(document());
  assert.equal(refusalOf(() => select(state, "no_such_step", always)).reason, "step_unknown");
});

// --- operation 2: resume -----------------------------------------------------

test("a target outside the reason's resume targets is refused", () => {
  const graph = document();
  const state = index(graph);
  const row = graph.recovery.find((entry) => entry.resume_targets.length < graph.steps.length - 1);
  const forbidden = graph.steps.map((step) => step.name).find((name) => !row.resume_targets.includes(name));
  assert.equal(refusalOf(() => permitsResume(state, row.reason, forbidden)).reason, "resume_target_not_permitted");
  assert.equal(permitsResume(state, row.reason, row.resume_targets[0]), true);
});

test("permission is read off the reason and not off the step it parked at", () => {
  // The counterexample the ticket asks for, taken from the shipped document
  // rather than from a fixture: two reasons parking at one step, each permitting
  // something the other forbids. Reading permission off the step would let a
  // resume one reason forbids be laundered through the other.
  const graph = document();
  const state = index(graph);
  const byStep = new Map();
  for (const row of graph.recovery) {
    for (const step of row.parks_at) byStep.set(step, [...(byStep.get(step) ?? []), row]);
  }

  const pairs = [];
  for (const [step, rows] of byStep) {
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const a = new Set(rows[i].resume_targets);
        const b = new Set(rows[j].resume_targets);
        const onlyA = [...a].filter((target) => !b.has(target));
        const onlyB = [...b].filter((target) => !a.has(target));
        if (onlyA.length > 0 && onlyB.length > 0) pairs.push({ step, a: rows[i], b: rows[j], onlyA, onlyB });
      }
    }
  }
  assert.ok(pairs.length > 0, "the shipped graph has such a pair, and this test is about it");

  for (const pair of pairs.slice(0, 6)) {
    assert.equal(permitsResume(state, pair.a.reason, pair.onlyA[0]), true);
    assert.equal(refusalOf(() => permitsResume(state, pair.b.reason, pair.onlyA[0])).reason, "resume_target_not_permitted");
    assert.equal(permitsResume(state, pair.b.reason, pair.onlyB[0]), true);
    assert.equal(refusalOf(() => permitsResume(state, pair.a.reason, pair.onlyB[0])).reason, "resume_target_not_permitted");
  }
});

test("a reason with no recovery row refuses the resume rather than allowing it", () => {
  const state = index(document());
  assert.equal(
    refusalOf(() => permitsResume(state, "never_declared_reason", "intake")).reason,
    "resume_target_not_permitted",
  );
});

test("a parked flow with no recorded reason resumes nowhere", () => {
  // Absence again: nothing permits a target when nothing said why the flow
  // stopped, and permitting anything would be the whole of operation 2 undone.
  const state = index(document());
  assert.equal(refusalOf(() => permitsResume(state, undefined, "intake")).reason, "resume_target_not_permitted");
  assert.equal(parkReasonOf({}), undefined);
  assert.equal(parkReasonOf({ park: { reason: "review_cap" } }), "review_cap");
  assert.equal(parkReasonOf({ park: { reason: 7 } }), undefined);
});

test("a guard that declares no park reason refuses by name rather than by undefined", () => {
  // The schema requires the field. A document that arrives without it would
  // otherwise refuse an explicitly requested target with `undefined` as the
  // code, which is the same hole `no_transition_reason` closes on the other side.
  const graph = document();
  delete graph.guards.find((guard) => guard.id === graph.transitions[0].guards[0]).park_reason;
  assert.equal(refusalOf(() => index(graph)).reason, "guard_unknown");
});

test("a resume to a step the document never declares is refused", () => {
  const graph = document();
  const state = index(graph);
  assert.equal(
    refusalOf(() => permitsResume(state, graph.recovery[0].reason, "no_such_step")).reason,
    "step_unknown",
  );
});

// --- the veto: what the engine actually calls --------------------------------

test("enroll enters the first step and nothing else", () => {
  const graph = document();
  const state = index(graph);
  const context = { step: "", parked: false };
  assert.equal(admit(state, context, { step: graph.first_step }, always), undefined);
  const refusal = refusalOf(() => admit(state, context, { step: "human" }, always));
  assert.equal(refusal.reason, "transition_not_declared");
  assert.equal(refusalOf(() => admit(state, context, { status: "done" }, always)).reason, "transition_not_declared");
});

test("a declared edge whose guards hold is admitted, and an undeclared pair is not", () => {
  const graph = document();
  const state = index(graph);
  const edge = graph.transitions[0];
  const context = { step: edge.from, parked: false };
  assert.equal(admit(state, context, { step: edge.to }, always), undefined);

  const unreachable = graph.steps
    .map((step) => step.name)
    .find((name) => !(state.outgoing.get(edge.from) ?? []).some((entry) => entry.to === name));
  assert.ok(unreachable, `${edge.from} has an edge to every step, so this case has nothing to test`);
  assert.equal(refusalOf(() => admit(state, context, { step: unreachable }, always)).reason, "transition_not_declared");
});

test("a guard refusing a requested target names the reason the guard carries", () => {
  // The one reader of `guards[].park_reason`, and the moment the schema wrote it
  // for: the target was asked for by name, so the flow is owed the reason the
  // guard that refused it names — not the step's reason for going nowhere.
  const graph = document();
  const state = index(graph);
  const edge = graph.transitions[0];
  const reasons = new Set(edge.guards.map((id) => state.guards.get(id).park_reason));
  const refusal = refusalOf(() => admit(state, { step: edge.from, parked: false }, { step: edge.to }, never));
  assert.ok(reasons.has(refusal.reason), `${refusal.reason} is not a reason any guard on ${edge.id} carries`);
  assert.ok(
    graph.recovery.some((row) => row.reason === refusal.reason),
    "and it is a reason the document declares a recovery row for",
  );
});

test("a status target is admitted exactly when selection parks", () => {
  const graph = document();
  const state = index(graph);
  const step = graph.steps.find((entry) => entry.kind === "agent" && (state.outgoing.get(entry.name) ?? []).length > 0);
  const context = { step: step.name, parked: false };
  assert.equal(admit(state, context, { status: "human" }, never), undefined, "no candidate, so it parks");
  assert.equal(
    refusalOf(() => admit(state, context, { status: "human" }, always)).reason,
    "transition_not_declared",
    "a step with a candidate edge does not park",
  );
  assert.equal(refusalOf(() => admit(state, context, { status: "done" }, never)).reason, "transition_not_declared");
});

test("a parked flow moves by its reason and by no other route", () => {
  const graph = document();
  const state = index(graph);
  const row = graph.recovery.find((entry) => entry.resume_targets.length < graph.steps.length - 1);
  const forbidden = graph.steps.map((step) => step.name).find((name) => !row.resume_targets.includes(name));
  const context = { step: row.parks_at[0], parked: true, parkedWith: row.reason };

  assert.equal(admit(state, context, { step: row.resume_targets[0] }, never), undefined);
  // A target the reason forbids stays forbidden however the guards would vote,
  // and a status move is not a resume at all.
  assert.equal(refusalOf(() => admit(state, context, { step: forbidden }, always)).reason, "resume_target_not_permitted");
  assert.equal(refusalOf(() => admit(state, context, { status: "done" }, always)).reason, "transition_not_declared");
});

test("re-entering the step it stands at needs no permission, and only that step", () => {
  // The default `autosk resume` target, and the only way back for a task the
  // daemon parked itself: no park reason was recorded, because the graph did not
  // park it. Anything other than the current step still goes through the reason.
  const graph = document();
  const state = index(graph);
  const step = graph.steps.find((entry) => entry.kind === "agent").name;
  const context = { step, parked: true, parkedWith: undefined };
  assert.equal(admit(state, context, { step }, never), undefined);
  const elsewhere = graph.steps.find((entry) => entry.kind === "agent" && entry.name !== step).name;
  assert.equal(
    refusalOf(() => admit(state, context, { step: elsewhere }, always)).reason,
    "resume_target_not_permitted",
  );
});

// --- an unknown predicate fails closed in both operations --------------------

test("a guard naming a predicate the document does not declare refuses the document", () => {
  // Absence again, and the important half: answering "not a candidate" would look
  // exactly like the edge correctly losing, so the edge would vanish from
  // selection with nothing said.
  //
  // The check moved from the evaluation of a guard to the reading of the
  // document, because operation 2 evaluates no guards: a resume answers from the
  // park reason alone, so an undeclared predicate was refused by every operation
  // except the one that never looks. Closure is a property of the document, and
  // it is now decided once, where the document is read.
  const graph = document();
  graph.guards[0].predicate = "never_declared_predicate";
  assert.equal(refusalOf(() => index(graph)).reason, "predicate_unknown");
});

test("so operation 2 cannot admit a resume under a document naming one", () => {
  // The counterexample the review built: an undeclared predicate on the route
  // out of the parking step, with the document's digest correctly recomputed so
  // the stale-digest refusal is not what answers. Before closure moved, the
  // parked branch admitted the target because it never evaluated a guard.
  const graph = repaired((entry) => {
    const route = entry.transitions.find((edge) => edge.from === "clarify_alignment" && edge.to === "await_alignment");
    entry.guards.find((guard) => guard.id === route.guards[0]).predicate = "never_declared_predicate";
  });
  const refusal = refusalOf(() => buildWorkflow(graph, { evaluate: always }));
  assert.equal(refusal.reason, "predicate_unknown");
  // And the route really is the one a parked flow would resume along, so the
  // case is the review's and not a neighbouring one.
  assert.ok(
    document().recovery.some(
      (row) => row.parks_at.includes("clarify_alignment") && row.resume_targets.includes("await_alignment"),
    ),
  );
});

test("an edge naming a guard the document does not declare refuses the document", () => {
  const graph = document();
  graph.transitions[0].guards = ["never_declared_guard"];
  assert.equal(refusalOf(() => index(graph)).reason, "guard_unknown");
});

// --- the refusal set is closed, and closed in both directions ----------------

test("every refusal this factory declares is one it produces", () => {
  // The earlier writing of this test built the set it checked membership in out
  // of the very strings it then looked for, so three of the six were true by
  // construction. Each code below is now produced by running the factory.
  const produced = new Set();
  const graph = document();
  const state = index(graph);
  const edge = graph.transitions[0];
  const row = graph.recovery.find((entry) => entry.resume_targets.length < graph.steps.length - 1);
  const forbidden = graph.steps.map((step) => step.name).find((name) => !row.resume_targets.includes(name));

  const reasonless = document();
  const orphan = reasonless.steps.find((entry) => entry.kind === "agent");
  delete orphan.no_transition_reason;
  reasonless.transitions = reasonless.transitions.filter((entry) => entry.from !== orphan.name);

  // The edge the shipped document guards with several reasons at once, which is
  // the case where it parks the task and says nothing about which reason applies.
  const ambiguous = [...state.outgoing.values()]
    .flat()
    .find((entry) => new Set(entry.guards.map((id) => state.guards.get(id).park_reason)).size > 1);

  for (const attempt of [
    () => select(state, "no_such_step", always),
    () => index({ ...graph, transitions: [{ ...edge, guards: ["never_declared_guard"] }] }),
    () => index({
      ...graph,
      guards: graph.guards.map((entry) => (entry.id === edge.guards[0] ? { ...entry, predicate: "nope" } : entry)),
    }),
    () => admit(state, { step: "", parked: false }, { status: "done" }, always),
    () => permitsResume(state, row.reason, forbidden),
    () => parkReasonFor(state, ambiguous),
    () => buildWorkflow({ ...graph, canonical_digest: "0".repeat(64) }, { evaluate: always }),
  ]) {
    produced.add(refusalOf(attempt).reason);
  }
  // The last is parked with rather than thrown, which is why it needs its own line.
  produced.add(select(index(reasonless), orphan.name, always).park);

  assert.deepEqual([...produced].sort(), [...REFUSALS].sort());
});

test("and every refusal it produces is one some contract closes", () => {
  // A reachable code no contract closes is a vocabulary that reads as closed and
  // is not. Three of these are the graph contract's, which owns the reasons the
  // graph issues about itself; three are this factory's own.
  const owners = closedByContract(readContracts());
  const closing = new Map();
  for (const code of REFUSALS) {
    const declaring = owners.get(code) ?? [];
    assert.equal(declaring.length, 1, `${code} is closed by ${declaring.length} contracts: ${declaring.join(", ")}`);
    closing.set(code, declaring[0]);
  }
  assert.deepEqual(
    [...new Set(closing.values())].sort(),
    ["docs/contracts/workflow-factory.md", "docs/contracts/workflow-graph.md"],
  );
});

test("a relayed park reason is the document's and not this factory's", () => {
  // The reasons a flow parks with come from the park vocabulary through the
  // document. Keeping them out of REFUSALS is what stops this factory from
  // looking like the owner of eighty-four codes it merely passes on.
  const graph = document();
  const state = index(graph);
  const declared = new Set(graph.recovery.map((row) => row.reason));
  for (const step of graph.steps.filter((entry) => entry.kind === "agent").slice(0, 20)) {
    const reason = select(state, step.name, never).park;
    assert.ok(declared.has(reason), `${step.name} parks with ${reason}, which no recovery row declares`);
    assert.ok(!REFUSALS.includes(reason), `${reason} is a document reason and must not be in the factory's set`);
  }
});

// --- the wiring itself, which the parts above do not reach ------------------

/**
 * The engine's context, reduced to what this factory touches.
 *
 * The mutation run is what asked for these: every test above exercises `select`,
 * `permitsResume` or `admit` directly, so `buildWorkflow`'s own wiring — the
 * task read that decides whether a flow is parked, and the park that has to
 * record its reason before it parks — had no test at all and three mutants
 * survived in it.
 */
const context = (task, { code = 0 } = {}) => {
  const calls = { transits: [], execs: [] };
  return {
    calls,
    ctx: {
      step: task.step ?? "",
      projectRoot: "/nowhere",
      sessionToken: "token",
      tasks: { currentId: task.id ?? "task-1", current: async () => task },
      transit: async (to) => calls.transits.push(to),
      exec: async (argv) => {
        calls.execs.push(argv);
        return { code, stdout: "", stderr: code === 0 ? "" : "refused" };
      },
    },
  };
};

test("the built onTransit reads whether the flow is parked, and answers accordingly", async () => {
  const graph = executable();
  const workflow = buildWorkflow(graph, { evaluate: always });
  const row = graph.recovery.find((entry) => entry.resume_targets.length < graph.steps.length - 1);
  const forbidden = graph.steps.map((step) => step.name).find((name) => !row.resume_targets.includes(name));
  const parked = {
    id: "t-1",
    step: row.parks_at[0],
    status: "human",
    metadata: { park: { reason: row.reason } },
  };

  // Parked: operation 2 decides, so a target the reason forbids is refused even
  // though every guard would have admitted it.
  await assert.rejects(() => workflow.onTransit(context(parked).ctx, { step: forbidden }), (error) => {
    assert.equal(error.reason, "resume_target_not_permitted");
    return true;
  });
  assert.equal(await workflow.onTransit(context(parked).ctx, { step: row.resume_targets[0] }), undefined);

  // Working: the same target is judged as ordinary progress instead, so it is
  // refused for a different reason — there is no edge from that step to it.
  const working = { ...parked, status: "work" };
  const refusal = await workflow
    .onTransit(context(working).ctx, { step: forbidden })
    .then(() => null, (error) => error);
  assert.ok(refusal, "a status the factory reads as parked and one it does not must not answer alike");
  assert.notEqual(refusal.reason, "resume_target_not_permitted");
});

test("the built onRun goes where the graph says, and records why when it parks", async () => {
  const graph = executable();
  const edge = graph.transitions[0];
  const workflow = buildWorkflow(graph, { evaluate: always });
  const moving = context({ id: "t-1", step: edge.from, status: "work", metadata: {} });
  await workflow.steps[edge.from].onRun(moving.ctx);
  assert.deepEqual(moving.calls.transits, [{ step: edge.to }]);
  assert.deepEqual(moving.calls.execs, [], "an ordinary move records no park reason");

  // A step with nowhere to go parks, and the reason reaches the task record
  // before the park does: operation 2 reads it from there and from nowhere else.
  const stranded = graph.steps.find((step) => step.kind === "agent");
  const cornered = buildWorkflow(
    repaired((entry) => {
      entry.transitions = entry.transitions.filter((edge) => edge.from !== stranded.name);
    }),
    { evaluate: always },
  );
  const parking = context({ id: "t-9", step: stranded.name, status: "work", metadata: {} });
  await cornered.steps[stranded.name].onRun(parking.ctx);
  assert.deepEqual(parking.calls.execs, [
    ["autosk", "metadata", "set", "t-9", "park.reason", stranded.no_transition_reason],
  ]);
  assert.deepEqual(parking.calls.transits, [{ status: "human" }]);
});

test("a park whose reason could not be recorded refuses rather than parking anyway", async () => {
  // A parked task whose reason was lost is a task operation 2 can never move,
  // so the write failing has to stop the park rather than be swallowed.
  const stranded = document().steps.find((step) => step.kind === "agent");
  const workflow = buildWorkflow(
    repaired((entry) => {
      entry.transitions = entry.transitions.filter((edge) => edge.from !== stranded.name);
    }),
    { evaluate: always },
  );
  const failing = context({ id: "t-9", step: stranded.name, status: "work", metadata: {} }, { code: 1 });
  await assert.rejects(() => workflow.steps[stranded.name].onRun(failing.ctx), /park reason/u);
  assert.deepEqual(failing.calls.transits, [], "and the flow must not have parked");
});

// --- what round 1 of the review found, each with the case it was found by ----

test("a declared edge into a parking step records the reason the document names", async () => {
  // S5-R1-F1. The shipped graph draws 202 edges into a human step and they are
  // how a flow ordinarily stops; only the no-candidate path recorded a reason,
  // so an ordinary park left `park.reason` at whatever the PREVIOUS park had
  // written, or absent — and operation 2 then refused a resume the reason allows.
  const graph = executable();
  const state = index(graph);
  const edge = state.outgoing.get("init_planning_ref").find((entry) => entry.to === "human");
  const guard = state.guards.get(edge.guards[0]);
  assert.equal(guard.park_reason, "planning_ref_capability_missing", "the case the review reproduced on the daemon");

  const workflow = buildWorkflow(graph, { evaluate: (predicate) => predicate === guard.predicate });
  const parking = context({
    id: "t-2",
    step: "init_planning_ref",
    status: "work",
    metadata: { park: { reason: "stale_from_before" } },
  });
  await workflow.steps.init_planning_ref.onRun(parking.ctx);
  assert.deepEqual(parking.calls.execs, [
    ["autosk", "metadata", "set", "t-2", "park.reason", guard.park_reason],
  ]);
  assert.deepEqual(parking.calls.transits, [{ step: "human" }]);

  // And the reason it recorded is one the document lets the flow resume with,
  // which is what the review measured going wrong end to end.
  const row = graph.recovery.find((entry) => entry.reason === guard.park_reason);
  assert.ok(row.parks_at.includes("init_planning_ref"));
  assert.equal(permitsResume(state, guard.park_reason, "init_planning_ref"), true);
});

test("an edge that parks with more than one reason refuses rather than choosing", () => {
  // Nine of the 202 are guarded by guards naming different reasons. An edge is
  // taken when all its guards hold, so every one of those reasons is true at
  // once and the document does not say which to record. Picking one would hand
  // the next resume the permissions of a reason nobody chose.
  const state = index(document());
  const ambiguous = [...state.outgoing.values()]
    .flat()
    .filter((edge) => new Set(edge.guards.map((id) => state.guards.get(id).park_reason)).size > 1);
  assert.ok(ambiguous.length > 0, "the shipped graph has such edges and this test is about them");
  assert.equal(refusalOf(() => parkReasonFor(state, ambiguous[0])).reason, "park_reason_ambiguous");
  assert.equal(refusalOf(() => parkReasonFor(state, { id: "t_none", guards: [] })).reason, "park_reason_ambiguous");
});

test("a recorded reason governs the current step too", () => {
  // S5-R1-F2. `alignment_policy_out_of_scope` permits five targets and not
  // `clarify_alignment`, where a task can park. The re-entry exception was
  // unconditional, so an ordinary `autosk resume` re-ran that step anyway.
  const graph = document();
  const state = index(graph);
  const row = graph.recovery.find((entry) => entry.reason === "alignment_policy_out_of_scope");
  assert.ok(row.parks_at.includes("clarify_alignment"), "the step the review parked at");
  assert.ok(!row.resume_targets.includes("clarify_alignment"), "and the target that reason forbids");

  const forbidden = { step: "clarify_alignment", parked: true, parkedWith: row.reason };
  assert.equal(
    refusalOf(() => admit(state, forbidden, { step: "clarify_alignment" }, always)).reason,
    "resume_target_not_permitted",
  );
  // What the exception was for is untouched: a park the graph did not make
  // carries no reason, and re-entering where the flow stands is how it continues.
  assert.equal(admit(state, { step: "clarify_alignment", parked: true }, { step: "clarify_alignment" }, never), undefined);
});

test("a document whose digest does not describe it is refused", () => {
  // S5-R1-F4. Six documents differing in a component were accepted with one
  // stale digest and the daemon pinned one identity for all six, because the
  // factory carried the field over instead of computing it.
  const graph = executable();
  const stale = repaired((entry) => {
    entry.caps[0].limit = 9;
  });
  stale.canonical_digest = graph.canonical_digest;
  const refusal = refusalOf(() => buildWorkflow(stale, { evaluate: always }));
  assert.equal(refusal.reason, "graph_digest_stale");

  // A document that carries none is computed rather than refused: what the
  // factory must never do is believe a digest, not require one.
  const { canonical_digest, ...bare } = graph;
  assert.equal(buildWorkflow(bare, { evaluate: always }).graphDigest, graph.canonical_digest);
});

test("a step is asked for a park reason only when arriving there stops the task", async () => {
  // The mutation run asked for this one: `kind === "status" && status === "human"`
  // could be widened to `||` and nothing noticed, because no test took an edge
  // into a terminal step. `done` is a status step and is not a park: a closed
  // task is not waiting for a reason, and demanding one would refuse the move.
  const graph = executable();
  const state = index(graph);
  const closing = [...state.outgoing].flatMap(([, edges]) => edges).find((edge) => edge.to === "done");
  assert.ok(closing, "the shipped graph closes flows through a done step");
  const wanted = new Set(closing.guards.map((id) => state.guards.get(id).predicate));
  const workflow = buildWorkflow(graph, { evaluate: (predicate) => wanted.has(predicate) });

  const closingRun = context({ id: "t-3", step: closing.from, status: "work", metadata: {} });
  await workflow.steps[closing.from].onRun(closingRun.ctx);
  assert.deepEqual(closingRun.calls.transits, [{ step: "done" }]);
  assert.deepEqual(closingRun.calls.execs, [], "closing a task records no park reason");
});

test("an edge with no reason and an edge with several are refused for different reasons", () => {
  // Same code, different detail: a document that names none and a document that
  // names too many are distinguishable, and a caller reading the message is told
  // which of the two it is looking at.
  const state = index(document());
  const several = [...state.outgoing.values()]
    .flat()
    .find((edge) => new Set(edge.guards.map((id) => state.guards.get(id).park_reason)).size > 1);
  assert.match(refusalOf(() => parkReasonFor(state, several)).detail, /guards name \d+ reasons/u);
  assert.match(refusalOf(() => parkReasonFor(state, { id: "t_none", guards: [] })).detail, /no guard names a reason/u);
});

test("the shipped document is refused because nine of its parks cannot say why", () => {
  // Round 1 attempt 3, and the route the owner chose. A runtime refusal could
  // not close this: it fails the session, the engine then parks the task, and
  // the reason an earlier park recorded is still there — the review resumed a
  // task to a step only that stale reason allows. Clearing it first moved the
  // hole onto the clearing's own error path, which the review measured too.
  // Nothing inside a running step closes it, because the engine parks the task
  // after the step gives up and the factory has no write that lands with the
  // position. So the document is refused before anything runs.
  const graph = document();
  const state = index(graph);
  const ambiguous = [...state.outgoing.values()]
    .flat()
    .filter((edge) => parks(state, edge.to) && !nameable(state, edge));
  assert.equal(ambiguous.length, 9, "measured rather than remembered");

  const refusal = refusalOf(() => buildWorkflow(graph, { evaluate: always }));
  assert.equal(refusal.reason, "park_reason_ambiguous");
  for (const edge of ambiguous) assert.match(refusal.detail, new RegExp(edge.id, "u"));

  // Each of the nine is ONE condition with several candidate reasons: every
  // guard on it names the same predicate. So these are not several conditions a
  // rule could tell apart — the document carries no discriminator, and nothing
  // here could invent one.
  for (const edge of ambiguous) {
    const predicates = new Set(edge.guards.map((id) => state.guards.get(id).predicate));
    assert.equal(predicates.size, 1, `${edge.id} names ${predicates.size} predicates`);
    assert.ok(new Set(edge.guards.map((id) => state.guards.get(id).park_reason)).size > 1);
  }

  // And that is why the repair this suite uses changes no condition: it keeps
  // one guard of the several that share the predicate. What the other tests
  // exercise is the shipped graph minus an ambiguity the document owes, not a
  // fixture invented here.
  assert.equal(buildWorkflow(executable(), { evaluate: always }).name, graph.workflow);
});
