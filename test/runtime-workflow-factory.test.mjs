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

const refusalOf = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof GraphRefusal, `expected a GraphRefusal, got ${error}`);
    return error;
  }
  return assert.fail("expected a refusal and got none");
};

/**
 * The watermark a completion receipt carries: the reason and the visit counts
 * of its parks_at steps, in row order. A receipt matches while none of those
 * steps has been re-entered since — re-entry is how another episode of the
 * reason begins, and the daemon's counter records it in the same write as the
 * position, so no write of the factory's has to land for the match to break.
 */
const watermarkOf = (row, visits) =>
  `${row.reason}@${row.parks_at.map((name) => `${name}:${visits[name] ?? 0}`).join(",")}`;

/**
 * A park record with every step the row's handling runs at receipted under the
 * episode `visits` describes — the state a resume out of this park is in once
 * all of the reason's handling has completed and nothing has re-entered a step
 * that could produce the reason since.
 */
const receipted = (row, visits = {}) => ({
  receipts: Object.fromEntries((row.handled_at ?? []).map((name) => [name, watermarkOf(row, visits)])),
});

// --- the declared shape is a function of the document -----------------------

test("the workflow is built from the document and carries its digest", () => {
  const graph = document();
  const workflow = buildWorkflow(graph, { evaluate: always });
  assert.equal(workflow.name, graph.workflow);
  assert.equal(workflow.firstStep, graph.first_step);
  assert.equal(Object.keys(workflow.steps).length, graph.steps.length);
  assert.equal(workflow.graphDigest, graph.canonical_digest);
  assert.equal(typeof workflow.onTransit, "function");
});

test("a status step declares its status and runs nothing", () => {
  const graph = document();
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
  const graph = document();
  const bare = buildWorkflow(graph, { evaluate: always });
  const bodied = buildWorkflow(graph, {
    evaluate: always,
    agents: Object.fromEntries(graph.steps.filter((s) => s.kind === "agent").map((s) => [s.name, async () => {}])),
  });
  assert.equal(shape(bodied), shape(bare));
  assert.equal(bodied.graphDigest, bare.graphDigest);
  assert.equal(shape(buildWorkflow(document(), { evaluate: always })), shape(bare));
});

test("a document declaring hooks this factory does not build is refused, not built without them", () => {
  // Hook presence is part of the shape the daemon digests. Ignoring a declared
  // hook would make the shape a function of this file rather than the document.
  // Resealed each time: the factory computes the digest and refuses a document
  // whose own digest describes different bytes, so a mutated fixture has to say
  // what it now is.
  const named = document().steps.find((entry) => entry.kind === "agent").name;
  const withHooks = (hooks) => resealed((graph) => {
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
  assert.throws(() => buildWorkflow(document(), {}), TypeError);
  assert.throws(() => buildWorkflow(document(), { evaluate: null }), TypeError);
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
  const base = buildWorkflow(document(), { evaluate: always }).graphDigest;
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
  const digests = changes.map((change) => buildWorkflow(resealed(change), { evaluate: always }).graphDigest);
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

  // And what the shipped graph actually does, named rather than assumed. Every
  // agent step has a way out — the one that did not, `ticket_done`, now leaves
  // to `done`, which is the stop the plan describes at the end of a ticket. The
  // empty list is what keeps it so: a step added with no way out fails this
  // line instead of joining it.
  const shipped = index(document());
  const orphans = document()
    .steps.filter((step) => step.kind === "agent" && (shipped.outgoing.get(step.name) ?? []).length === 0)
    .map((step) => step.name);
  assert.deepEqual(orphans, []);
  const taken = select(shipped, "ticket_done", always);
  assert.equal(taken.park, undefined, "a completed ticket does not park");
  assert.equal(taken.take.to, "done");
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
  // await_alignment is the status step the graph draws five guarded edges out
  // of: selection never runs on a status step, so even with every one of their
  // predicates refuted the answer is the status and not the fallback literal —
  // which is why no state can park such a step with `no_transition_reason`.
  assert.deepEqual(select(state, "await_alignment", never), { park: null, status: "human" });
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
  assert.equal(permitsResume(state, row.reason, row.resume_targets[0], receipted(row)), true);
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
    // The park records say every step the reason's handling runs at completed
    // under the current park, so a target lent through a handled_at edge is
    // measured as permitted — the pair is about which REASON permits, not
    // about the receipt condition that operation 2 adds on top.
    assert.equal(permitsResume(state, pair.a.reason, pair.onlyA[0], receipted(pair.a)), true);
    assert.equal(refusalOf(() => permitsResume(state, pair.b.reason, pair.onlyA[0], receipted(pair.b))).reason, "resume_target_not_permitted");
    assert.equal(permitsResume(state, pair.b.reason, pair.onlyB[0], receipted(pair.b)), true);
    assert.equal(refusalOf(() => permitsResume(state, pair.a.reason, pair.onlyB[0], receipted(pair.a))).reason, "resume_target_not_permitted");
  }
});

test("a resume along a handled_at step's edges needs a completion receipted under this park episode", () => {
  // The shipped defect, in the three rows it was measured on. A target outside
  // the row's own steps is permitted through an edge out of one of them, and an
  // edge out of a handled_at step lends the permission only once the step's
  // handling has completed under THIS episode of the reason — a visit cannot
  // be the evidence, because step_visits is bumped on entry and a handler that
  // threw still counts as entered, and a stored park identity cannot be the
  // evidence either, because the write that would move it can fail. The
  // receipt instead carries the visit counts of the reason's parks_at steps as
  // they stood at completion, and the gate recomputes that watermark off the
  // daemon's counter: a new episode of the reason cannot begin without
  // re-entering a step that produces it, so the watermark moves by itself.
  const graph = document();
  const state = index(graph);

  // aggregate_verify_failed parks at aggregate_verify alone, and five of its
  // six targets are edges out of record_aggregate_remediation — the step that
  // writes the remediation record. Four states, one row: the step never
  // entered, entered but never completed, completed under an earlier episode
  // of the same reason, completed under this one.
  const avf = "aggregate_verify_failed";
  assert.equal(
    refusalOf(() => permitsResume(state, avf, "draft_artifact", {}, { aggregate_verify: 1 })).reason,
    "resume_target_not_permitted",
  );
  assert.equal(
    refusalOf(() =>
      permitsResume(state, avf, "draft_artifact", {}, { aggregate_verify: 1, record_aggregate_remediation: 1 }),
    ).reason,
    "resume_target_not_permitted",
    "entry is counted and proves nothing — a handler that threw leaves no receipt",
  );
  assert.equal(
    refusalOf(() =>
      permitsResume(state, avf, "draft_artifact", {
        receipts: { record_aggregate_remediation: `${avf}@aggregate_verify:1` },
      }, { aggregate_verify: 2 }),
    ).reason,
    "resume_target_not_permitted",
    "a receipt from an earlier episode satisfies no later one — the producing step was re-entered, same reason included",
  );
  assert.equal(
    permitsResume(state, avf, "draft_artifact", {
      receipts: { record_aggregate_remediation: `${avf}@aggregate_verify:1` },
    }, { aggregate_verify: 1 }),
    true,
    "the receipt matches while every step that could produce the reason stands unmoved",
  );
  // The union is untouched: the row's own steps stay reachable — resuming INTO
  // record_aggregate_remediation is how the remediation happens at all — and
  // human, an edge out of the parks_at step itself, needs no receipt.
  assert.equal(permitsResume(state, avf, "record_aggregate_remediation", {}, {}), true);
  assert.equal(permitsResume(state, avf, "human", {}, {}), true);
  // The control the document already carries: the sibling reason permits the
  // same six targets but parks at the record step, so each is lent by an edge
  // out of a parks_at step and all are legitimate there.
  assert.equal(permitsResume(state, "aggregate_remediation_required", "draft_artifact", {}, {}), true);

  // blocked_anchor parks at sixteen steps, and verify is reachable only from
  // implement, fix and rebuild_code_anchor — of which the row names only the
  // last, in handled_at. Resuming into verify with no rebuild receipted
  // verifies on an anchor that was never rebuilt.
  const anchorRow = graph.recovery.find((entry) => entry.reason === "blocked_anchor");
  const anchorVisits = { record_code_verdict: 4 };
  assert.equal(
    refusalOf(() => permitsResume(state, "blocked_anchor", "verify", {}, anchorVisits)).reason,
    "resume_target_not_permitted",
  );
  assert.equal(
    refusalOf(() =>
      permitsResume(state, "blocked_anchor", "verify", receipted(anchorRow, { record_code_verdict: 3 }), anchorVisits),
    ).reason,
    "resume_target_not_permitted",
    "the receipt names an earlier episode — a parks_at step was entered since",
  );
  assert.equal(
    permitsResume(state, "blocked_anchor", "verify", receipted(anchorRow, anchorVisits), anchorVisits),
    true,
    "once the rebuild's completion is receipted under this episode, verification may resume",
  );
  // Resuming INTO the rebuild step stays permitted — that is how the anchor
  // gets rebuilt.
  assert.equal(permitsResume(state, "blocked_anchor", "rebuild_code_anchor", {}, {}), true);

  // child_creation_key_invalid parks only at dispatch_arena, whose one outgoing
  // edge reaches arena_join — a lawful direct target. contest_join hangs on
  // dispatch_contest, a handled_at step: without the repaired dispatch's
  // completion receipted, resuming there would join a contest for children it
  // never enrolled.
  const contestRow = graph.recovery.find((entry) => entry.reason === "child_creation_key_invalid");
  assert.equal(permitsResume(state, "child_creation_key_invalid", "arena_join", {}, {}), true);
  assert.equal(
    refusalOf(() => permitsResume(state, "child_creation_key_invalid", "contest_join", {}, { dispatch_arena: 1 }))
      .reason,
    "resume_target_not_permitted",
  );
  assert.equal(
    permitsResume(
      state,
      "child_creation_key_invalid",
      "contest_join",
      receipted(contestRow, { dispatch_arena: 1 }),
      { dispatch_arena: 1 },
    ),
    true,
    "once the contest dispatch's completion is receipted under this episode, joining it is permitted",
  );

  // And the veto carries the record: admit reads the park bag and the visit
  // counter the same way onTransit hands them off the task record.
  const parked = { step: "aggregate_verify", parked: true, parkedWith: "aggregate_verify_failed" };
  assert.equal(
    refusalOf(() => admit(state, parked, { step: "draft_artifact" }, always)).reason,
    "resume_target_not_permitted",
  );
  assert.equal(
    admit(state, {
      ...parked,
      park: { receipts: { record_aggregate_remediation: "aggregate_verify_failed@aggregate_verify:1" } },
      visits: { aggregate_verify: 1 },
    }, { step: "draft_artifact" }, always),
    undefined,
  );
});

test("a refused resume's message names the unrecorded lending step or says no named step reaches the target", () => {
  // The reason is resume_target_not_permitted either way; the DETAIL is the
  // diagnosis an operator acts on, and it is one of two. A permitted target
  // that no step the row names reaches is refused as unreachable outright. A
  // target reachable only through a handled_at step whose completion this park
  // never recorded is refused with that step named. The mutation run showed
  // the choice between the two unasserted: every test pinned the reason and
  // none read the detail, so neutering the condition changed only which
  // sentence was thrown.
  const graph = document();
  const state = index(graph);

  // On the shipped row: draft_artifact hangs on record_aggregate_remediation
  // alone, so with nothing receipted the refusal names the lending step whose
  // completion is missing.
  const lent = refusalOf(() =>
    permitsResume(state, "aggregate_verify_failed", "draft_artifact", {}, { aggregate_verify: 1 }),
  );
  assert.equal(lent.reason, "resume_target_not_permitted");
  assert.match(lent.detail, /record_aggregate_remediation/u);
  assert.match(lent.detail, /does not record/u);

  // The other diagnosis needs a permitted target no named step reaches, which
  // no shipped row carries: intake has no incoming edge anywhere, so adding it
  // to a row's targets makes the refusal deterministic.
  const mutated = index(resealed((graph) => {
    graph.recovery.find((row) => row.reason === "anchor_handoff_incomplete").resume_targets.push("intake");
  }));
  const orphan = refusalOf(() => permitsResume(mutated, "anchor_handoff_incomplete", "intake"));
  assert.equal(orphan.reason, "resume_target_not_permitted");
  assert.match(orphan.detail, /no edge/u);
  assert.match(orphan.detail, /intake/u);
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
  const context = { step: row.parks_at[0], parked: true, parkedWith: row.reason, park: receipted(row) };

  assert.equal(admit(state, context, { step: row.resume_targets[0] }, never), undefined);
  // A target the reason forbids stays forbidden however the guards would vote,
  // and a status move is not a resume at all.
  assert.equal(refusalOf(() => admit(state, context, { step: forbidden }, always)).reason, "resume_target_not_permitted");
  assert.equal(refusalOf(() => admit(state, context, { status: "done" }, always)).reason, "transition_not_declared");
});

test("a task parked at a registered `human` is still the graph's to move", () => {
  // `parked` IS the human status — the graph's own park state — so a register
  // naming `human` must not read the task standing at it as already relocated
  // out of the workflow. Without the exemption every ordinarily-parked task
  // was out of the graph the moment the document declared the exit: its own
  // `--to human` refused, `cancel` refused, every step re-entry refused.
  const graph = resealed((entry) => {
    entry.external_operations = [
      ...entry.external_operations,
      { status: "human", executor: "autosk resume <id> --to human" },
    ];
  });
  const state = index(graph);
  const row = graph.recovery.find((entry) => entry.resume_targets.length < graph.steps.length - 1);
  const forbidden = graph.steps.map((step) => step.name).find((name) => !row.resume_targets.includes(name));
  const context = {
    step: row.parks_at[0],
    parked: true,
    parkedWith: row.reason,
    status: "human",
    park: receipted(row),
  };

  // Everything the parked rules permit still lands: the register's `human` (a
  // no-op relocation), the register's `cancel`, and the step the row permits.
  assert.equal(admit(state, context, { status: "human" }, always), undefined);
  assert.equal(admit(state, context, { status: "cancel" }, always), undefined);
  assert.equal(admit(state, context, { step: row.resume_targets[0] }, never), undefined);
  assert.equal(
    refusalOf(() => admit(state, context, { step: forbidden }, always)).reason,
    "resume_target_not_permitted",
  );

  // The guard's other half is unchanged: a task NOT parked but standing at a
  // registered status is the operation's own completion, still out of the graph.
  const relocated = { step: row.parks_at[0], parked: false, status: "cancel" };
  assert.equal(
    refusalOf(() => admit(state, relocated, { step: row.resume_targets[0] }, always)).reason,
    "transition_not_declared",
  );
});

test("a flow parked on a step with no way out cannot resume into one", () => {
  // The shipped defect, reproduced where it bit: a ticket that finished stood
  // at ticket_done parked with its no_transition_reason, and the row used to
  // permit resume into done, human and ticket_done itself. Every arrival
  // replays the step's body, so the reason now permits none of them while
  // still permitting the rest. ticket_done has an exit now — to done — and the
  // narrowing holds under the ordinary rule, which this keeps pinned.
  const graph = document();
  const state = index(graph);
  const context = { step: "ticket_done", parked: true, parkedWith: "project_boundary_invalid" };
  for (const target of ["done", "human", "ticket_done"]) {
    assert.equal(
      refusalOf(() => admit(state, context, { step: target }, always)).reason,
      "resume_target_not_permitted",
      `resuming a ticket_done park into ${target} must be refused`,
    );
  }
  assert.equal(
    permitsResume(state, "project_boundary_invalid", "implement"),
    true,
    "the reason still permits a target with a way out",
  );
  // The other two rows carried the same intersection at human: a task standing
  // there with the reason resumed into it. That arrival is refused too.
  for (const reason of ["no_external_panel_lead", "no_external_reviewer"]) {
    assert.equal(
      refusalOf(() =>
        admit(state, { step: "human", parked: true, parkedWith: reason }, { step: "human" }, always),
      ).reason,
      "resume_target_not_permitted",
      `resuming a ${reason} park into human must be refused`,
    );
  }
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
  const graph = resealed((entry) => {
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

  // An edge guarded by two reasons at once, which is the case where it parks
  // the task and says nothing about which reason applies. The shipped document
  // no longer has one — that is what the repair did — so the case is built, and
  // built out of the document's own guards rather than invented.
  const ambiguous = (() => {
    const edges = [...state.outgoing.values()].flat();
    const parking = edges.find((entry) => parks(state, entry.to));
    const carried = state.guards.get(parking.guards[0]).park_reason;
    const other = [...state.guards.values()].find((guard) => guard.park_reason !== carried);
    return { ...parking, guards: [...parking.guards, other.id] };
  })();

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
    () => index({ ...graph, external_operations: [{ status: "limbo", executor: "x" }] }),
    // t_231 is a cap's counted edge: stripping its guards leaves the cap with
    // nothing to bind the below-limit term to.
    () => index({
      ...graph,
      transitions: graph.transitions.map((entry) =>
        entry.id === "t_231" ? { ...entry, guards: [] } : entry),
    }),
    // `guard_238` is bound below the limit on t_231; putting it on t_230 — the
    // edge carrying the cap's park_reason — reaches it in the second role too.
    () => index({
      ...graph,
      transitions: graph.transitions.map((entry) =>
        entry.id === "t_230" ? { ...entry, guards: [...entry.guards, "guard_238"] } : entry),
    }),
  ]) {
    produced.add(refusalOf(attempt).reason);
  }
  // The last is parked with rather than thrown, which is why it needs its own line.
  produced.add(select(index(reasonless), orphan.name, always).park);

  assert.deepEqual([...produced].sort(), [...REFUSALS].sort());
});

test("the register the document declares is the exits the definition carries", () => {
  // `external_operations` is the document's answer to "which statuses an
  // operation outside the workflow drives", and the definition carries it as
  // `exits` so the daemon — and through it the CLI — answers to the register
  // instead of restating the status union.
  assert.deepEqual(buildWorkflow(document(), { evaluate: always }).exits, ["cancel"]);

  // A document with no register declares none — an empty list, not an absent
  // field, because a declared-nothing and a never-asked are different answers
  // to the daemon.
  const bare = resealed((entry) => {
    delete entry.external_operations;
  });
  assert.deepEqual(buildWorkflow(bare, { evaluate: always }).exits, []);
});

test("a register entry outside the status union is refused at build", () => {
  // `status_unknown`, and it is refused when the document is read rather than
  // when a task needs it: an entry the wire cannot express would register as
  // an operation nothing performs — the CLI would neither name it nor accept
  // it nor refuse it, which is the silent drift this closes.
  const drifted = document();
  drifted.external_operations = [
    ...drifted.external_operations,
    { status: "limbo", executor: "autosk resume <id> --to limbo" },
  ];
  const refusal = refusalOf(() => index(drifted));
  assert.equal(refusal.reason, "status_unknown");
  assert.match(refusal.detail, /limbo/u);
});

test("and every refusal it produces is one some contract closes", () => {
  // A reachable code no contract closes is a vocabulary that reads as closed and
  // is not. Four of these are the graph contract's, which owns the reasons the
  // graph issues about itself and the document's digest; the rest are this
  // factory's own.
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
  // looking like the owner of eighty-five codes it merely passes on.
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
const context = (task, { code = 0, failLeaf, crashLeaf } = {}) => {
  const calls = { transits: [], execs: [] };
  // What the daemon does with the two effects a run can emit: `metadata set`
  // lands the leaf in the task's bag, and a transit moves the position and
  // bumps that step's own counter in the same write (section 8). A step move
  // into the human status step is where a graph park lands, and a status move
  // parks the task standing where it is.
  const setLeaf = (dotPath, value) => {
    const keys = dotPath.split(".");
    let bag = (task.metadata ??= {});
    while (keys.length > 1) bag = bag[keys.shift()] ??= {};
    bag[keys[0]] = value;
  };
  // `metadata unset` removes the leaf and prunes the parents it leaves empty.
  const unsetLeaf = (dotPath) => {
    const keys = dotPath.split(".");
    const parents = [];
    let bag = task.metadata ?? {};
    for (const key of keys.slice(0, -1)) {
      parents.push([bag, key]);
      if (typeof bag[key] !== "object" || bag[key] === null) return;
      bag = bag[key];
    }
    delete bag[keys.at(-1)];
    for (const [bag_, key] of parents.reverse()) if (Object.keys(bag_[key]).length === 0) delete bag_[key];
  };
  return {
    calls,
    ctx: {
      step: task.step ?? "",
      projectRoot: "/nowhere",
      sessionToken: "token",
      tasks: { currentId: task.id ?? "task-1", current: async () => task },
      transit: async (to) => {
        calls.transits.push(to);
        if ("status" in to) {
          task.status = to.status;
          return;
        }
        task.step = to.step;
        task.status = to.step === "human" ? "human" : "work";
        const visits = ((task.metadata ??= {}).step_visits ??= {});
        visits[to.step] = (visits[to.step] ?? 0) + 1;
      },
      exec: async (argv) => {
        calls.execs.push(argv);
        // `code` refuses every write; `failLeaf` refuses only the write of the
        // leaf it names and `crashLeaf` never returns from it — the two shapes
        // a lost record write can take, which "fail all" cannot express.
        if (argv[4] === crashLeaf) throw new Error("daemon died mid-write");
        const refused = code !== 0 || argv[4] === failLeaf;
        if (!refused && argv[0] === "autosk" && argv[1] === "metadata" && argv[2] === "set") {
          setLeaf(argv[4], argv[5]);
        }
        if (!refused && argv[0] === "autosk" && argv[1] === "metadata" && argv[2] === "unset") {
          for (const leaf of argv.slice(4)) unsetLeaf(leaf);
        }
        return { code: refused ? 1 : 0, stdout: "", stderr: refused ? "refused" : "" };
      },
    },
  };
};

test("the built onTransit reads whether the flow is parked, and answers accordingly", async () => {
  const graph = document();
  const workflow = buildWorkflow(graph, { evaluate: always });
  const row = graph.recovery.find((entry) => entry.resume_targets.length < graph.steps.length - 1);
  const forbidden = graph.steps.map((step) => step.name).find((name) => !row.resume_targets.includes(name));
  const parked = {
    id: "t-1",
    step: row.parks_at[0],
    status: "human",
    metadata: {
      // What the park record holds once every step the row's handling runs at
      // has completed under the episode the visit counter still describes.
      step_visits: Object.fromEntries(row.parks_at.map((name) => [name, 1])),
      park: { reason: row.reason, ...receipted(row, Object.fromEntries(row.parks_at.map((name) => [name, 1]))) },
    },
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

test("the completion receipt is written by the run and answers to the episode the counter still describes", async () => {
  // F164-T02-01, driven end to end so the receipt is the code's own write and
  // not an injected fixture: the resume into record_aggregate_remediation
  // bumps step_visits on ENTRY, the handler then throws, and the counter reads
  // as though the record had been written when nothing was. What the gate asks
  // for instead is the receipt the run leaves behind only when the body
  // succeeds — the visit counts of the reason's parks_at steps at completion,
  // so a later episode of the reason, same reason included, moves the
  // watermark with no write of ours needing to land.
  const graph = document();
  let failHandler = true;
  let routeBack = false;
  const workflow = buildWorkflow(graph, {
    // cond_276 is t_371's guard — the edge out of aggregate_verify that parks
    // with aggregate_verify_failed — and cond_278 is t_373's, the
    // record_aggregate_remediation edge that returns the flow to the step that
    // produced the reason.
    evaluate: (predicate) => predicate === "cond_276" || (routeBack && predicate === "cond_278"),
    agents: {
      record_aggregate_remediation: async () => {
        if (failHandler) throw new Error("remediation write failed");
      },
    },
  });
  const task = {
    id: "t-1",
    step: "aggregate_verify",
    status: "work",
    metadata: { step_visits: { aggregate_verify: 1 } },
  };

  // The veto only answers; the engine commits the move, and the commit is what
  // moves the position and bumps the counter.
  const resume = async (step) => {
    const ctx = context(task).ctx;
    await workflow.onTransit(ctx, { step });
    await ctx.transit({ step });
  };

  // The graph park records its reason — one write, because the identity that
  // scopes the receipts is derived, never written.
  await workflow.steps.aggregate_verify.onRun(context(task).ctx);
  assert.equal(task.step, "human");
  assert.equal(task.status, "human");
  assert.equal(task.metadata.park.reason, "aggregate_verify_failed");

  // Entered but not completed: the resume lands, the counter rises, the body
  // throws — and the lent target stays refused.
  await resume("record_aggregate_remediation");
  await assert.rejects(() => workflow.steps.record_aggregate_remediation.onRun(context(task).ctx));
  task.status = "human"; // the engine parks a failed run and writes nothing
  assert.equal(task.metadata.step_visits.record_aggregate_remediation, 1, "entry is counted and proves nothing");
  assert.equal(task.metadata.park.receipts?.record_aggregate_remediation, undefined);
  await assert.rejects(
    () => workflow.onTransit(context(task).ctx, { step: "draft_artifact" }),
    (error) => error.reason === "resume_target_not_permitted",
  );

  // Completed: the receipt lands carrying the producing step's count — the
  // run's own exec, applied to the record by the fixture the way the daemon
  // applies it. The take that follows re-enters the producing step — a move
  // inside the reason's own surface, so the record still carries it — and the
  // daemon's counter moved on the entry, which is what a new episode of the
  // reason is.
  failHandler = false;
  routeBack = true;
  await resume("record_aggregate_remediation");
  await workflow.steps.record_aggregate_remediation.onRun(context(task).ctx);
  assert.equal(
    task.metadata.park.receipts.record_aggregate_remediation,
    "aggregate_verify_failed@aggregate_verify:1",
  );
  assert.equal(task.step, "aggregate_verify", "t_373 returned the flow to the producing step");
  assert.equal(task.metadata.step_visits.aggregate_verify, 2);
  assert.equal(task.metadata.park.reason, "aggregate_verify_failed");

  // An engine-side park now reads that record against the moved counter: the
  // receipt names the visit the earlier episode completed under, so the target
  // it used to lend is refused — while the row's own parks_at step still
  // admits re-entry on no receipt at all.
  task.status = "human"; // an engine-side park writes nothing into park.*
  await assert.rejects(
    () => workflow.onTransit(context(task).ctx, { step: "draft_artifact" }),
    (error) => error.reason === "resume_target_not_permitted",
  );
  await resume("aggregate_verify");
});

test("a handled_at step with no registered handler completes nothing and leaves no receipt", async () => {
  // F164-T02-03: `agents` defaults to {}, so `work` is undefined for a step
  // with no handler and its body is skipped — a receipt written anyway would
  // be a completion receipt for a completion that never happened. The drive
  // is the reviewer's: park at aggregate_verify, resume into
  // record_aggregate_remediation, run it with nothing registered.
  const graph = document();
  const workflow = buildWorkflow(graph, {
    evaluate: (predicate) => predicate === "cond_276" || predicate === "cond_278",
  });
  const task = {
    id: "t-1",
    step: "aggregate_verify",
    status: "work",
    metadata: { step_visits: { aggregate_verify: 1 } },
  };
  const resume = async (step) => {
    const ctx = context(task).ctx;
    await workflow.onTransit(ctx, { step });
    await ctx.transit({ step });
  };

  await workflow.steps.aggregate_verify.onRun(context(task).ctx);
  assert.equal(task.metadata.park.reason, "aggregate_verify_failed");
  await resume("record_aggregate_remediation");

  // The run succeeds as a run — no handler means nothing to fail — and the
  // graph's own edge sends the flow back to aggregate_verify, but no receipt
  // may have been written: there was no work to complete.
  const ran = context(task);
  await workflow.steps.record_aggregate_remediation.onRun(ran.ctx);
  assert.equal(task.step, "aggregate_verify");
  assert.equal(
    ran.calls.execs.some((argv) => argv[4] === "park.receipts.record_aggregate_remediation"),
    false,
    "no handler ran, so no receipt may be written",
  );
  assert.equal(task.metadata.park.receipts?.record_aggregate_remediation, undefined);

  task.status = "human";
  await assert.rejects(
    () => workflow.onTransit(context(task).ctx, { step: "draft_artifact" }),
    (error) => error.reason === "resume_target_not_permitted",
  );
});

test("a repeated park invalidates the earlier episode's receipts without any write landing", async () => {
  // F164-T02-02, the surviving half of it: when reason and step both repeat,
  // every written identity is indistinguishable from the old one — the reason
  // write stores the same value and any other leaf can fail — so the
  // discriminator cannot be written. It is the daemon's own counter instead:
  // the second failure could only be produced by re-entering
  // aggregate_verify, which bumped step_visits.aggregate_verify from 1 to 2,
  // and the receipt the first episode earned watermarks 1. The drive earns
  // the receipt under the first park, returns to aggregate_verify, and lets
  // the second failure's reason write go all three ways — succeeding,
  // refused, never returning. The record it leaves is the same either way,
  // and the gate refuses all three.
  const driveToSecondFailure = async (execOptions) => {
    const graph = document();
    const workflow = buildWorkflow(graph, {
      evaluate: (predicate) => predicate === "cond_276" || predicate === "cond_278",
      agents: { record_aggregate_remediation: async () => {} },
    });
    const task = {
      id: "t-1",
      step: "aggregate_verify",
      status: "work",
      metadata: { step_visits: { aggregate_verify: 1 } },
    };
    const resume = async (step) => {
      const ctx = context(task).ctx;
      await workflow.onTransit(ctx, { step });
      await ctx.transit({ step });
    };
    // First park: the reason lands, the receipt is earned, t_373 returns the
    // flow to the producing step — the counter now reads 2 there.
    await workflow.steps.aggregate_verify.onRun(context(task).ctx);
    await resume("record_aggregate_remediation");
    await workflow.steps.record_aggregate_remediation.onRun(context(task).ctx);
    assert.equal(
      task.metadata.park.receipts.record_aggregate_remediation,
      "aggregate_verify_failed@aggregate_verify:1",
    );
    assert.equal(task.step, "aggregate_verify", "t_373 returned the flow to the producing step");
    assert.equal(task.metadata.step_visits.aggregate_verify, 2);
    // The second failure of the same reason: the run decides to park, the
    // record's reason write gets whichever outcome the caller chose.
    const run = context(task, execOptions);
    return { workflow, task, run };
  };

  // The write is refused: the record keeps the first park whole — same
  // reason, same receipts — and it still cannot satisfy the gate, because the
  // producing step's count moved when the second failure re-entered it.
  {
    const { workflow, task, run } = await driveToSecondFailure({ failLeaf: "park.reason" });
    await assert.rejects(() => workflow.steps.aggregate_verify.onRun(run.ctx), /park reason/u);
    assert.equal(task.metadata.park.reason, "aggregate_verify_failed");
    assert.equal(
      task.metadata.park.receipts.record_aggregate_remediation,
      "aggregate_verify_failed@aggregate_verify:1",
      "the record is the first park's, unchanged",
    );
    task.status = "human"; // the engine infra-parks a run whose write threw
    await assert.rejects(
      () => workflow.onTransit(context(task).ctx, { step: "draft_artifact" }),
      (error) => error.reason === "resume_target_not_permitted",
    );
  }

  // The write never returns — a death mid-command leaves the same record,
  // and the refusal is the same.
  {
    const { workflow, task, run } = await driveToSecondFailure({ crashLeaf: "park.reason" });
    await assert.rejects(() => workflow.steps.aggregate_verify.onRun(run.ctx), /mid-write/u);
    task.status = "human";
    await assert.rejects(
      () => workflow.onTransit(context(task).ctx, { step: "draft_artifact" }),
      (error) => error.reason === "resume_target_not_permitted",
    );
  }

  // And the write succeeding changes nothing either: the same reason value
  // over the same leaf is the same record — the counter is what says the
  // episode moved.
  {
    const { workflow, task, run } = await driveToSecondFailure();
    await workflow.steps.aggregate_verify.onRun(run.ctx);
    assert.equal(task.step, "human");
    await assert.rejects(
      () => workflow.onTransit(context(task).ctx, { step: "draft_artifact" }),
      (error) => error.reason === "resume_target_not_permitted",
    );
  }
});

test("a transition out of the park clears the reason it recorded, so an engine-side park re-enters freely", async () => {
  // Ticket 3, half B — the scenario as it was reproduced. The flow parks at
  // clarify_alignment with `alignment_policy_out_of_scope`, resumes into a
  // target the reason's row permits (draft_artifact, via a parks_at edge), and
  // draft_artifact moves the flow on to freeze_artifact — a step the reason's
  // row does not permit. The daemon then parks the task itself: it writes the
  // status and no reason, because it has none of its own. Resuming at the step
  // the flow stands at is the one move operation 2 defines to need no
  // permission — provided the record does not still describe the earlier stop.
  const graph = document();
  const row = graph.recovery.find((entry) => entry.reason === "alignment_policy_out_of_scope");
  const edge = graph.transitions.find((entry) => entry.from === "draft_artifact" && entry.to === "freeze_artifact");
  assert.ok(!row.resume_targets.includes("freeze_artifact"), "the scenario needs a step outside the row");
  // t_155's guard is the only predicate that holds, so no edge but that one is a
  // candidate — and at clarify_alignment none is, which is what parks the flow.
  const workflow = buildWorkflow(graph, {
    evaluate: (predicate) => predicate === graph.guards.find((guard) => guard.id === edge.guards[0]).predicate,
  });
  const task = {
    id: "t-1",
    step: "clarify_alignment",
    status: "work",
    metadata: { park: { receipts: { earlier_step: "alignment_policy_out_of_scope@clarify_alignment:0" } } },
  };
  await workflow.steps.clarify_alignment.onRun(context(task).ctx);
  assert.equal(task.metadata.park.reason, "alignment_policy_out_of_scope");
  await workflow.onTransit(context(task).ctx, { step: "draft_artifact" });
  await context(task).ctx.transit({ step: "draft_artifact" }); // the engine's commit

  // A clear that cannot land must not move the task: the reason the record
  // still claims is the reason a later engine-side park would find.
  const refused = context(task, { failLeaf: "park.reason" });
  await assert.rejects(() => workflow.steps.draft_artifact.onRun(refused.ctx), /clearing park reason/u);
  assert.deepEqual(refused.calls.transits, [], "a failed clear leaves the position where it stood");
  assert.equal(task.step, "draft_artifact");
  assert.equal(task.metadata.park.reason, "alignment_policy_out_of_scope");

  const move = context(task);
  await workflow.steps.draft_artifact.onRun(move.ctx);
  assert.equal(task.step, "freeze_artifact");
  assert.equal(task.metadata.park?.reason, undefined, "the reason described a stop that is over");
  assert.deepEqual(move.calls.execs, [["autosk", "metadata", "unset", "t-1", "park.reason"]]);
  // The delete is leaf-level: the sibling receipts the same record carries are
  // untouched, and re-scope themselves by watermark from there on.
  assert.equal(
    task.metadata.park.receipts.earlier_step,
    "alignment_policy_out_of_scope@clarify_alignment:0",
  );

  // The daemon's own park writes no reason; with none recorded, operation 2's
  // no-permission move — re-entering the step the flow stands at — is open.
  task.status = "human";
  await workflow.onTransit(context(task).ctx, { step: "freeze_artifact" });
});

test("the built onRun goes where the graph says, and records why when it parks", async () => {
  const graph = document();
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
    resealed((entry) => {
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
  // so the write failing has to stop the park rather than be swallowed. It is
  // the park record's only write — the record it leaves is no record at all,
  // and that is fail-closed: `parkedWith` reads undefined and operation 2
  // refuses every target.
  const stranded = document().steps.find((step) => step.kind === "agent");
  const graph = resealed((entry) => {
    entry.transitions = entry.transitions.filter((edge) => edge.from !== stranded.name);
  });
  const workflow = buildWorkflow(graph, { evaluate: always });
  const task = { id: "t-9", step: stranded.name, status: "work", metadata: {} };
  const failing = context(task, { failLeaf: "park.reason" });
  await assert.rejects(() => workflow.steps[stranded.name].onRun(failing.ctx), /park reason/u);
  assert.deepEqual(failing.calls.transits, [], "and the flow must not have parked");

  // The unwritten record fails closed: the engine infra-parks the task, and
  // operation 2 refuses every target but the step the flow stands at, because
  // parkedWith reads undefined.
  assert.equal(task.metadata.park?.reason, undefined);
  task.status = "human";
  await assert.rejects(
    () => workflow.onTransit(context(task).ctx, { step: "done" }),
    (error) => error.reason === "resume_target_not_permitted",
  );
});

// --- what round 1 of the review found, each with the case it was found by ----

test("a declared edge into a parking step records the reason the document names", async () => {
  // S5-R1-F1. The shipped graph draws 221 edges into a human step and they are
  // how a flow ordinarily stops; only the no-candidate path recorded a reason,
  // so an ordinary park left `park.reason` at whatever the PREVIOUS park had
  // written, or absent — and operation 2 then refused a resume the reason allows.
  const graph = document();
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
  // An edge is taken when all its guards hold, so if they name different
  // reasons every one of them is true at once and the document does not say
  // which to record. Picking one would hand the next resume the permissions of
  // a reason nobody chose.
  //
  // The shipped document had nine such edges and now has none, so the property
  // is asserted against an edge made ambiguous here. That both states are
  // exercised is the point: the repair removed the instances, not the rule.
  const state = index(document());
  const parking = [...state.outgoing.values()].flat().find((edge) => parks(state, edge.to));
  const carried = state.guards.get(parking.guards[0]).park_reason;
  const other = [...state.guards.values()].find((guard) => guard.park_reason !== carried);
  const ambiguous = { ...parking, guards: [...parking.guards, other.id] };

  assert.equal(refusalOf(() => parkReasonFor(state, ambiguous)).reason, "park_reason_ambiguous");
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
  const graph = document();
  const stale = resealed((entry) => {
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
  const graph = document();
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
  const parking = [...state.outgoing.values()].flat().find((edge) => parks(state, edge.to));
  const carried = state.guards.get(parking.guards[0]).park_reason;
  const other = [...state.guards.values()].find((guard) => guard.park_reason !== carried);
  const several = { ...parking, guards: [...parking.guards, other.id] };
  assert.match(refusalOf(() => parkReasonFor(state, several)).detail, /guards name \d+ reasons/u);
  assert.match(refusalOf(() => parkReasonFor(state, { id: "t_none", guards: [] })).detail, /no guard names a reason/u);
});

test("the shipped document builds, and every park in it says why", () => {
  // This test used to assert the opposite. Slice 5 refused the shipped bytes
  // because nine of their parking edges named two or three reasons for one
  // condition, and the owner routed that to a build-time refusal rather than
  // let a runtime pick. The refusal was right and is still here for a document
  // that earns it; what changed is the document, which now says which.
  //
  // Nine were refused. Five more were not, because a single wrong reason is not
  // ambiguous — four parked with `alignment_policy_out_of_scope` where the plan
  // offers only a kind-specific reason, and one picked one of the two its row
  // offers. Those the build could never have caught, which is why the design
  // validator now carries the check too.
  const graph = document();
  const state = index(graph);
  const ambiguous = [...state.outgoing.values()]
    .flat()
    .filter((edge) => parks(state, edge.to) && !nameable(state, edge));
  assert.deepEqual(ambiguous.map((edge) => edge.id), [], "every parking edge names exactly one reason");

  const workflow = buildWorkflow(graph, { evaluate: always });
  assert.equal(workflow.name, graph.workflow);
  assert.equal(workflow.firstStep, graph.first_step);

  // The refusal still fires for a document that cannot say why: keeping two
  // guards with different reasons on one edge is the shipped state restored.
  const restored = resealed((entry) => {
    const edge = entry.transitions.find((candidate) => candidate.id === "t_121");
    const other = entry.guards.find((guard) => guard.park_reason === "core_flow_decision_required");
    edge.guards = [...edge.guards, other.id];
  });
  assert.equal(refusalOf(() => buildWorkflow(restored, { evaluate: always })).reason, "park_reason_ambiguous");
});

test("a status the document declares an operation outside the workflow is the exit it promised", () => {
  // Three rows of the resume contract end in an exit the graph does not draw, and
  // the document names what performs it: `external_operations` says `cancel` is
  // driven by a status operation and not by a step. The veto refused every status
  // target of a parked task unconditionally, so the executor the document named
  // was refused before it could act — a carrier on paper and none in the run. The
  // review found that by driving this consumer, not by reading the document.
  const state = index(document());
  for (const [reason, step, forbidden] of [
    ["planning_ref_foreign_movement", "cleanup", "verify"],
    ["commit_foreign_movement", "commit_on_pass", "draft_artifact"],
    ["foreign_movement", "integration_recovery", "draft_artifact"],
  ]) {
    assert.ok(
      !state.recovery.get(reason).resume_targets.includes(forbidden),
      `${forbidden} must really be outside ${reason}, or the control proves nothing`,
    );
    const parked = { step, parked: true, parkedWith: reason };
    assert.equal(
      admit(state, parked, { status: "cancel" }, always),
      undefined,
      `${reason} must be able to reach the exit its row promises`,
    );
    // A status the document does NOT declare that way stays what it was: an
    // operator moving a task the graph is holding. This is what keeps the
    // declaration from being a word anyone can write — `done` is driven by a step.
    for (const status of ["done", "human"]) {
      assert.equal(
        refusalOf(() => admit(state, parked, { status }, always)).reason,
        "transition_not_declared",
        `${status} is carried by a step, so a relocation to it is not an operation the graph declared`,
      );
    }
    // And the ordinary resume is untouched: operation 2 still decides step targets.
    assert.equal(
      refusalOf(() => admit(state, parked, { step: forbidden }, always)).reason,
      "resume_target_not_permitted",
    );
  }

  // Withdraw the declaration and the exit is refused again, which is the state the
  // base document was in.
  const undeclared = document();
  delete undeclared.external_operations;
  assert.equal(
    refusalOf(() =>
      admit(index(undeclared), { step: "cleanup", parked: true, parkedWith: "planning_ref_foreign_movement" },
        { status: "cancel" }, always)).reason,
    "transition_not_declared",
  );
});

test("a relocation to a declared operation does not launder the reason it left behind", async () => {
  // The review's second finding, and it is a two-step path: `parked` is the human
  // status alone, so a task the operation relocated read as RUNNING, operation 2
  // never looked, and the reason still sitting in the record governed nothing. The
  // classification changes between the steps, so the test has to go through
  // onTransit with a real task status — admit with parked: true cannot see it.
  const workflow = buildWorkflow(document(), { evaluate: (predicate) => predicate === "cond_098" });
  const at = (status) => {
    const task = { id: "t-1", step: "dispatch_panel", status, metadata: { park: { reason: "alignment_record_stale" } } };
    return { task, ctx: { step: task.step, tasks: { current: async () => task } } };
  };

  // The row does not permit this target, and the park refuses it.
  await assert.rejects(
    () => workflow.onTransit(at("human").ctx, { step: "panel_join" }),
    (error) => error.reason === "resume_target_not_permitted",
  );
  // The exit the document declares is permitted.
  assert.equal(await workflow.onTransit(at("human").ctx, { status: "cancel" }), undefined);
  // And the same refused move stays refused after it. Before this it was admitted
  // as an ordinary edge, which made the relocation a way around the reason.
  await assert.rejects(
    () => workflow.onTransit(at("cancel").ctx, { step: "panel_join" }),
    (error) => error.reason === "transition_not_declared",
  );
  // Nor does a target the row DOES permit become available: the graph moves no task
  // standing at a status an operation drives, whatever the row says.
  const row = index(document()).recovery.get("alignment_record_stale");
  await assert.rejects(
    () => workflow.onTransit(at("cancel").ctx, { step: row.resume_targets[0] }),
    (error) => error.reason === "transition_not_declared",
  );
});

test("the way back in is not the way on: an entry is admitted where a continuation is not", async () => {
  // The review's third finding. Upstream's enrol admits a task at the cancel status
  // and always targets a step — the workflow's first step unless one is named — and
  // it keeps the old step as the one being left when the workflow does not change:
  //   const leavingStep = view.workflow === workflowName ? (view.step ?? "") : "";
  // So an enrol and a resume of a cancelled task reach the veto in the same shape and
  // the step being left cannot tell them apart. The target can: an entry is where a
  // flow starts, and starting is not continuing.
  const graph = document();
  const workflow = buildWorkflow(graph, { evaluate: (predicate) => predicate === "cond_098" });
  const move = (task, step, to) =>
    workflow.onTransit({ step, tasks: { current: async () => task } }, to);
  const cancelled = () => ({
    id: "t-1",
    step: "dispatch_panel",
    status: "cancel",
    metadata: { park: { reason: "alignment_record_stale" } },
  });

  // Entering counts as starting, and the entry the engine defaults to is the first step.
  assert.equal(
    await move({ id: "t-2", step: "old_step", status: "cancel", workflow: "other", metadata: {} }, "", {
      step: graph.first_step,
    }),
    undefined,
    "a task the operation closed may be enrolled again",
  );

  // Continuing is still refused, whatever the recovery row says about the target.
  for (const target of ["panel_join", ...index(graph).recovery.get("alignment_record_stale").resume_targets.slice(0, 1)]) {
    await assert.rejects(
      () => move(cancelled(), "dispatch_panel", { step: target }),
      (error) => error.reason === "transition_not_declared",
      `${target} is a continuation of a closed task, not an entry`,
    );
  }

  // And the entry set is the document's, not a literal: every step the other
  // registered workflows enter at counts, which is what keeps this from being a
  // rule about one name.
  const entries = new Set([graph.first_step, ...(graph.entry_steps ?? []).map((entry) => entry.step)]);
  assert.ok(entries.size > 1, "the document declares entries beyond its first step");
  assert.ok(
    !entries.has("panel_join"),
    "the bypass target must not be an entry, or the control proves nothing",
  );
});

// --- the caps' term -----------------------------------------------------------

test("a cap binds exactly the counted edge's guards and its carrying siblings'", () => {
  // Derived from the document, not listed beside it: the counted edge admits
  // below the limit, and the sibling edges carrying the cap's park_reason are
  // how the flow stops at it. The shipped document's two caps must therefore
  // bind exactly these four guards — a fifth means a guard the cap does not
  // own is gated by it, and a missing one means the cap still has no evaluator.
  const state = index(document());
  assert.deepEqual(
    [...state.capTerms.keys()].sort(),
    ["guard_237", "guard_238", "guard_449", "guard_450"],
  );
  assert.deepEqual(state.capTerms.get("guard_237"), [
    { from: "narrow_review_join", to: "fix_artifact", limit: 10, below: false },
  ]);
  assert.deepEqual(state.capTerms.get("guard_238"), [
    { from: "narrow_review_join", to: "fix_artifact", limit: 10, below: true },
  ]);
  assert.deepEqual(state.capTerms.get("guard_449"), [
    { from: "record_code_verdict", to: "fix", limit: 10, below: false },
  ]);
  assert.deepEqual(state.capTerms.get("guard_450"), [
    { from: "record_code_verdict", to: "fix", limit: 10, below: true },
  ]);
});

test("the counted edge admits the tenth taking and refuses the eleventh", async () => {
  // Both halves of the boundary, on both caps the shipped document declares.
  for (const [from, to, predicates] of [
    ["narrow_review_join", "fix_artifact", ["cond_135", "cond_136"]],
    ["record_code_verdict", "fix", ["cond_332", "cond_333"]],
  ]) {
    const workflow = buildWorkflow(document(), {
      evaluate: (predicate) => predicates.includes(predicate),
    });
    const takings = (count) => ({ transition_takings: { [from]: { [to]: count } } });

    const continuing = { id: "task-1", step: from, status: "work", metadata: takings(9) };
    await workflow.steps[from].onRun(context(continuing).ctx);
    assert.equal(continuing.step, to, `${from}: nine takings is below the cap, so the round continues`);
    assert.equal(continuing.metadata.park?.reason, undefined);

    const capped = { id: "task-1", step: from, status: "work", metadata: takings(10) };
    const { ctx, calls } = context(capped);
    await workflow.steps[from].onRun(ctx);
    assert.equal(capped.step, "human", `${from}: the eleventh taking is refused, so the flow parks`);
    assert.equal(capped.status, "human");
    assert.equal(capped.metadata.park.reason, "review_cap");
    assert.ok(
      calls.execs.some((argv) => argv[4] === "park.reason" && argv[5] === "review_cap"),
      `${from}: the cap's reason was recorded before the task parked`,
    );
  }
});

test("the cap term narrows the caller's answer and never widens it", async () => {
  // A caller refusing every predicate parks with the step's own reason at any
  // count: if the term could turn a false into a candidate, this would park
  // review_cap or move to fix_artifact instead.
  const refusing = buildWorkflow(document(), { evaluate: never });
  const refused = {
    id: "task-1",
    step: "narrow_review_join",
    status: "work",
    metadata: { transition_takings: { narrow_review_join: { fix_artifact: 10 } } },
  };
  await refusing.steps.narrow_review_join.onRun(context(refused).ctx);
  assert.equal(refused.step, "narrow_review_join", "a status move parks in place");
  assert.equal(refused.status, "human");
  assert.equal(
    refused.metadata.park.reason,
    "planning_candidate_keepalive_invalid",
    "a refused counted edge is the step's own park, not the cap's",
  );

  // And a caller wrongly admitting the counted predicate still loses the edge
  // at the limit: the term is a conjunction, not a second opinion.
  const wrong = buildWorkflow(document(), { evaluate: (predicate) => predicate === "cond_136" });
  const lost = {
    id: "task-1",
    step: "narrow_review_join",
    status: "work",
    metadata: { transition_takings: { narrow_review_join: { fix_artifact: 10 } } },
  };
  await wrong.steps.narrow_review_join.onRun(context(lost).ctx);
  assert.notEqual(lost.step, "fix_artifact", "a caller's true does not take the eleventh taking");
  assert.equal(lost.status, "human");
  assert.equal(lost.metadata.park.reason, "planning_candidate_keepalive_invalid");
});

test("the veto refuses a transit onto the counted pair at the limit", async () => {
  // Selection and the veto cannot disagree about a cap any more than they can
  // about a guard. The explicit path is `ctx.transit({step})` inside a running
  // session, which `SessionRuntime.transit` hands to this veto; an operator's
  // resume is refused by `Engine.resume` before any hook runs and is not this
  // path. A counted target refused at the limit carries its own guard's
  // `park_reason` — `planning_candidate_keepalive_invalid` here — and not
  // `review_cap`, which is recorded only when selection takes the carrying
  // sibling.
  const workflow = buildWorkflow(document(), { evaluate: always });
  const task = {
    id: "task-1",
    step: "narrow_review_join",
    status: "work",
    metadata: { transition_takings: { narrow_review_join: { fix_artifact: 10 } } },
  };
  await assert.rejects(
    () => workflow.onTransit(context(task).ctx, { step: "fix_artifact" }),
    (error) => error.reason === "planning_candidate_keepalive_invalid",
  );
  task.metadata.transition_takings.narrow_review_join.fix_artifact = 9;
  assert.equal(await workflow.onTransit(context(task).ctx, { step: "fix_artifact" }), undefined);

  const code = {
    id: "task-2",
    step: "record_code_verdict",
    status: "work",
    metadata: { transition_takings: { record_code_verdict: { fix: 10 } } },
  };
  await assert.rejects(
    () => workflow.onTransit(context(code).ctx, { step: "fix" }),
    (error) => error.reason === "project_boundary_invalid",
  );
});

test("a missing or unreadable count reads as zero takings", async () => {
  // The counter is a parsed record: anything that is not an own numeric entry
  // under the pair is no taking, and no taking means the round continues.
  const workflow = buildWorkflow(document(), { evaluate: (predicate) => predicate === "cond_136" });
  for (const metadata of [
    undefined,
    {},
    { transition_takings: null },
    { transition_takings: "garbage" },
    { transition_takings: {} },
    { transition_takings: { narrow_review_join: "garbage" } },
    { transition_takings: { narrow_review_join: null } },
    { transition_takings: { narrow_review_join: {} } },
    { transition_takings: { narrow_review_join: { fix_artifact: "10" } } },
    { transition_takings: { narrow_review_join: { fix_artifact: Number.NaN } } },
    { transition_takings: { narrow_review_join: { fix_artifact: {} } } },
  ]) {
    const task = { id: "task-1", step: "narrow_review_join", status: "work", metadata };
    await workflow.steps.narrow_review_join.onRun(context(task).ctx);
    assert.equal(
      task.step,
      "fix_artifact",
      `metadata ${JSON.stringify(metadata) ?? "absent"} must read as zero takings`,
    );
  }
});

test("the count is read by own key at both levels, so prototype names inherit nothing", async () => {
  // `metadata` is a parsed record, and a step named `constructor` or `__proto__`
  // still has to mean its own entries and nothing else. The poisoned cases
  // below are the ones a member read cannot see through — a literal
  // `{__proto__: x}` writes no key at all; it rewires the object's prototype —
  // which is exactly the defect the counter's writer had to fix twice.
  const protoDocument = (from, to, limit) => ({
    workflow: "cap_prototype_names",
    first_step: from,
    predicates: [{ id: "holds", reads: [], description: "the answer" }],
    steps: [
      { name: from, kind: "agent", no_transition_reason: "fixture_no_exit" },
      { name: to, kind: "agent", no_transition_reason: "fixture_no_exit" },
      { name: "human", kind: "status", status: "human" },
    ],
    guards: [
      { id: "g_round", predicate: "holds", authority: { actor: "agent" }, park_reason: "fixture_no_exit" },
      { id: "g_cap", predicate: "holds", authority: { actor: "agent" }, park_reason: "review_cap" },
    ],
    transitions: [
      { id: "t_cap", from, to: "human", priority: 0, guards: ["g_cap"] },
      { id: "t_round", from, to, priority: 1, guards: ["g_round"] },
    ],
    caps: [{ cycle: "round", counted_transition: "t_round", limit, park_reason: "review_cap" }],
    recovery: [
      { reason: "fixture_no_exit", parks_at: [from, to], resume_targets: [from, to], required_state: "n/a" },
      { reason: "review_cap", parks_at: [from], resume_targets: [from, to], required_state: "n/a" },
    ],
  });
  const drive = async (from, to, limit, metadata) => {
    const workflow = buildWorkflow(protoDocument(from, to, limit), {
      evaluate: always,
      agents: { [from]: async () => {} },
    });
    const task = { id: "task-1", step: from, status: "work", metadata };
    await workflow.steps[from].onRun(context(task).ctx);
    return task;
  };

  // `constructor` as the source: a member read finds the map an inherited
  // `constructor` key carries and calls its `fix` a count of five.
  assert.equal(
    (await drive("constructor", "fix", 5, {
      transition_takings: { __proto__: { constructor: { fix: 5 } } },
    })).step,
    "fix",
  );
  // `__proto__` as the source: the literal wrote no key; it made the count map
  // the record's prototype.
  assert.equal(
    (await drive("__proto__", "fix", 5, {
      transition_takings: { __proto__: { fix: 5 } },
    })).step,
    "fix",
  );
  // `constructor` as the target: the inner map's prototype carries it.
  assert.equal(
    (await drive("review", "constructor", 5, {
      transition_takings: { review: { __proto__: { constructor: 5 } } },
    })).step,
    "constructor",
  );
  // And an own `__proto__` key IS a count: parsed JSON carries it as data, so
  // reading it is as required as not inheriting it.
  const parsed = await drive(
    "review",
    "__proto__",
    2,
    JSON.parse('{"transition_takings":{"review":{"__proto__":2}}}'),
  );
  assert.equal(parsed.step, "human");
  assert.equal(parsed.metadata.park.reason, "review_cap");
});

test("a cap whose counted edge declares no guards is refused at build", () => {
  // The below-limit term binds to the counted edge's guards, and an empty
  // conjunction holds at every count: with `guards: []` nothing carries the
  // term, so selection and the veto alike take the edge past its limit — the
  // bypass the review measured. The document is refused where it is read.
  const graph = document();
  graph.transitions = graph.transitions.map((edge) =>
    edge.id === "t_231" ? { ...edge, guards: [] } : edge,
  );
  const refusal = refusalOf(() => index(graph));
  assert.equal(refusal.reason, "cap_binding_incomplete");
  assert.match(refusal.detail, /artifact_review_round/);
  assert.match(refusal.detail, /t_231/);
});

test("a cap with no sibling carrying its park_reason is refused at build", () => {
  // t_230 is the edge the flow parks on when the limit is reached. Without it
  // the counted edge still stops, but the task stands still with the step's
  // own reason and `review_cap` is never recorded.
  const graph = document();
  graph.transitions = graph.transitions.filter((edge) => edge.id !== "t_230");
  const refusal = refusalOf(() => index(graph));
  assert.equal(refusal.reason, "cap_binding_incomplete");
  assert.match(refusal.detail, /artifact_review_round/);
  assert.match(refusal.detail, /review_cap/);
});

test("a guard the cap binding reaches that another edge also references is refused at build", () => {
  // `guard_238` carries the artifact cap's below-limit term on t_231. Putting
  // it on t_443 — an edge out of a different step — would constrain that edge
  // by a cap that never named it; the cap that would count t_443 is removed so
  // the edge stands outside every binding.
  const graph = document();
  graph.caps = graph.caps.filter((cap) => cap.counted_transition !== "t_443");
  graph.transitions = graph.transitions.map((edge) =>
    edge.id === "t_443" ? { ...edge, guards: ["guard_238"] } : edge,
  );
  const refusal = refusalOf(() => index(graph));
  assert.equal(refusal.reason, "cap_binding_ambiguous");
  assert.match(refusal.detail, /guard_238/);
  assert.match(refusal.detail, /t_443/);
});

test("a guard bound to a cap as counted-edge and carrying-sibling at once is refused at build", () => {
  // `guard_238` asks below the limit on the counted edge t_231; putting it on
  // t_230 — the edge carrying review_cap — binds it to the same cap in the
  // second role. One guard cannot carry a cap's answer on two edges.
  const graph = document();
  graph.transitions = graph.transitions.map((edge) =>
    edge.id === "t_230" ? { ...edge, guards: [...edge.guards, "guard_238"] } : edge,
  );
  const refusal = refusalOf(() => index(graph));
  assert.equal(refusal.reason, "cap_binding_ambiguous");
  assert.match(refusal.detail, /guard_238/);
});

test("an edge the binding reaches from two caps is refused at build", () => {
  // A second cap counting t_232 — which shares neither pair nor guards with
  // t_231 — still parks through the same review_cap edge, so t_230's guard
  // would owe two limits.
  const graph = document();
  graph.caps = [...graph.caps, { cycle: "second_local", counted_transition: "t_232", limit: 10, park_reason: "review_cap" }];
  const refusal = refusalOf(() => index(graph));
  assert.equal(refusal.reason, "cap_binding_ambiguous");
  assert.match(refusal.detail, /t_230/);
});

test("a cap counting a transition the document never declared is refused at build", () => {
  // The refusal is the factory's own `transition_not_declared` — the code an
  // undeclared edge already produces — because a counted transition that does
  // not exist is an edge the document does not declare.
  const graph = document();
  graph.caps = graph.caps.map((cap) => ({ ...cap, counted_transition: "never_declared" }));
  const refusal = refusalOf(() => index(graph));
  assert.equal(refusal.reason, "transition_not_declared");
  assert.match(refusal.detail, /never_declared/);
});

test("an array in the count record is no count, even for a step named `length`", async () => {
  // The daemon's reader (`getTransitionTakings`, patch 0034) excludes arrays
  // at both levels of the record. Without the exclusion an inner array's own
  // `length` reads as the count of a target step named `length` — a count the
  // durable record does not carry, and one the flow must not stop on.
  const graph = JSON.parse(JSON.stringify(document()).replaceAll("fix_artifact", "length"));
  graph.canonical_digest = graphDigest(graph);
  const workflow = buildWorkflow(graph, { evaluate: (predicate) => predicate === "cond_136" });
  const metadata = { transition_takings: { narrow_review_join: Array(10).fill(0) } };
  const task = { id: "task-1", step: "narrow_review_join", status: "work", metadata };
  await workflow.steps.narrow_review_join.onRun(context(task).ctx);
  assert.equal(task.step, "length");
  const vetoed = { id: "task-2", step: "narrow_review_join", status: "work", metadata };
  assert.equal(
    await workflow.onTransit(context(vetoed).ctx, { step: "length" }),
    undefined,
  );
});
