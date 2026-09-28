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
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { DOCUMENT_PATH, graphDigest, parseStrict } from "../scripts/validate-workflow-graph.mjs";
import { ROOT, closedByContract, readContracts } from "../scripts/validate-refusal-vocabulary.mjs";
import { digest } from "../src/runtime/contracts.mjs";
import { decisionPayloadHash, resumeDecisionAdmitter, userDecisionRecordHash } from "../src/host/user-decision.mjs";
import { testSigner } from "./support/user-decision-signer.mjs";
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

test("a foreign target movement resumes into apply_staging on a recorded decision, and a bare resume into the CAS is still refused", () => {
  // Debt 10b, R6-4 (ADR-088). An ordinary commit to the target during an Epic
  // is not attributable under the one CAS; resuming only to human made a live
  // target branch block every Epic. A recorded decision to re-stage onto the
  // moved target resumes into apply_staging; the CAS itself is never retried.
  // Review of 11e, M2: the row says "only on a recorded user decision", and
  // the resume was admitted with none; apply_staging is now a decision
  // target of the row, so the park must carry the decision leaf. CodeRabbit
  // on #270: and the leaf must name a verified record of this task's
  // re-stage from this park, handed in by the caller.
  const state = index(document());
  const row = state.recovery.get("foreign_target_movement");
  assert.equal(refusalOf(() => permitsResume(state, "foreign_target_movement", "apply_staging")).reason, "resume_target_not_permitted");
  assert.equal(refusalOf(() => permitsResume(state, "foreign_target_movement", "apply_staging", { decision: decisionLeaf(row, {}) })).reason,
    "resume_target_not_permitted");
  const record = resumeRecord(row, {}, "apply_staging");
  const decided = { decision: leafFor(row, {}, record) };
  assert.equal(permitsResume(state, "foreign_target_movement", "apply_staging", decided, {}, decidedBy([record])), true);
  assert.equal(
    refusalOf(() => permitsResume(state, "foreign_target_movement", "integrate_staging", decided, {}, decidedBy([record]))).reason,
    "resume_target_not_permitted",
  );
});

test("an origin-scoped reason resumes only into the step its park recorded as its origin", () => {
  // R9c-10. A union row lends every target to every step it names, so a stop
  // before the aggregate PASS could resume into acceptance on the same reason.
  // An origin-scoped row permits one target: the step the park stood at.
  const graph = resealed((entry) => {
    for (const row of entry.recovery) {
      if (row.reason === "epic_boundary_invalid" || row.reason === "project_boundary_invalid") row.resume_scope = "origin";
    }
  });
  const state = index(graph);
  const reason = "epic_boundary_invalid";
  const origin = { origin: "ticket_join" };
  assert.equal(permitsResume(state, reason, "ticket_join", origin), true);
  assert.equal(refusalOf(() => permitsResume(state, reason, "select_next", origin)).reason, "resume_target_not_permitted");
  // With no origin recorded, nothing is the origin, so nothing is permitted.
  assert.equal(refusalOf(() => permitsResume(state, reason, "ticket_join", {})).reason, "resume_target_not_permitted");
  // The scope narrows and never widens: the origin must still be a target.
  assert.equal(
    refusalOf(() => permitsResume(state, reason, "intake", { origin: "intake" })).reason,
    "resume_target_not_permitted",
  );
  // And a union row is untouched by an origin in the record: it still lends
  // a target that is not where the park stood.
  assert.equal(permitsResume(state, "aggregate_binding_void", "aggregate_verify", { origin: "accept_staging" }), true);

  // Through the veto: a task parked at human carries the origin of the park
  // that took it there, and resumes only into it.
  const workflow = buildWorkflow(graph, { evaluate: always });
  const task = { id: "t-o", step: "human", status: "human", metadata: { park: { reason, origin: "aggregate_verify" } } };
  return (async () => {
    await workflow.onTransit(context(task).ctx, { step: "aggregate_verify" });
    await assert.rejects(
      () => workflow.onTransit(context(task).ctx, { step: "accept_staging" }),
      (error) => error.reason === "resume_target_not_permitted",
    );
  })();
});

test("a row scoped to its origin's edges admits the origin and what an edge out of it reaches, and nothing another step lends", () => {
  // R9c-15. review_cap parks the Planned cap at narrow_review_join and the
  // Quick and Ticket one at record_code_verdict. Under the union each stop was
  // lent the other's targets — the Planned stop Quick's
  // invalidate_quick_classification, one unguarded edge before done. Scoped to
  // the origin's edges, a stop resumes into its origin or along an edge out of
  // it, and the row's list still bounds both.
  const graph = document();
  const state = index(graph);
  const reason = "review_cap";
  assert.equal(state.recovery.get(reason).resume_scope, "origin_edges");
  // review_cap declares the targets that run another round the user's
  // decision, so each case hands in a verified record of that resume
  // (ADR-099, CodeRabbit on #270); the scope is what this case is about, and
  // it is decided before the decision is read.
  const row = state.recovery.get(reason);
  const resume = (target, park, at = state) => {
    const record = resumeRecord(row, {}, target);
    return () => permitsResume(at, reason, target, { ...park, decision: leafFor(row, {}, record) }, {}, decidedBy([record]));
  };
  const planned = { origin: "narrow_review_join" };
  assert.equal(resume("fix_artifact", planned)(), true);
  for (const target of ["fix", "invalidate_quick_classification", "rebuild_code_anchor"]) {
    assert.equal(refusalOf(resume(target, planned)).reason, "resume_target_not_permitted", target);
  }
  const code = { origin: "record_code_verdict" };
  for (const target of ["fix", "invalidate_quick_classification", "rebuild_code_anchor", "human"]) {
    assert.equal(resume(target, code)(), true, target);
  }
  assert.equal(refusalOf(resume("fix_artifact", code)).reason, "resume_target_not_permitted");
  // The list still bounds it: record_code_verdict has an edge into Quick's
  // accept, and the row does not list accept.
  assert.ok(state.outgoing.get("record_code_verdict").some((edge) => edge.to === "accept"));
  assert.equal(refusalOf(resume("accept", code)).reason, "resume_target_not_permitted");
  // With no origin recorded there is no edge to go by, so nothing is admitted.
  assert.equal(refusalOf(resume("fix_artifact", {})).reason, "resume_target_not_permitted");
  // And origin scope proper admits the origin alone, not its edges.
  const strict = index(resealed((entry) => {
    entry.recovery.find((candidate) => candidate.reason === reason).resume_scope = "origin";
  }));
  assert.equal(refusalOf(resume("fix_artifact", planned, strict)).reason, "resume_target_not_permitted");
});

test("a Quick or Ticket stop under review_cap or artifact_mapping_required still resumes where its own workflow recovers", async () => {
  // R9c-15's other half: narrowing what a Planned stop is lent must not take
  // away what a Quick or Ticket stop was admitted into. Both workflows stop at
  // the same two steps, freeze and record_code_verdict.
  const graph = document();
  const state = index(graph);
  // review_cap at record_code_verdict: a new fix round — the step the table
  // names for Quick and Ticket, which the union could not list without lending
  // it to the Planned stop — the anchor rebuild and, for Quick, the hand-off
  // out of the Quick classification. The Planned fixer is not theirs.
  // With a verified record of each resume that runs a round, as the targets
  // that run one owe (ADR-099, CodeRabbit on #270): what this case is about is
  // where the Quick and Ticket stop is admitted.
  const cap = state.recovery.get("review_cap");
  const records = new Map(["fix", "rebuild_code_anchor", "fix_artifact"].map((target) => [target, resumeRecord(cap, {}, target, { task: "t-q" })]));
  const workflow = buildWorkflow(graph, { evaluate: always, ...deciding([...records.values()]) });
  const capped = (target) => ({
    id: "t-q",
    step: "human",
    status: "human",
    metadata: {
      park: {
        reason: "review_cap",
        origin: "record_code_verdict",
        ...(records.has(target) ? { decision: leafFor(cap, {}, records.get(target)) } : {}),
      },
    },
  });
  for (const target of ["fix", "rebuild_code_anchor", "invalidate_quick_classification"]) {
    await workflow.onTransit(context(capped(target)).ctx, { step: target });
  }
  await assert.rejects(
    () => workflow.onTransit(context(capped("fix_artifact")).ctx, { step: "fix_artifact" }),
    (error) => error.reason === "resume_target_not_permitted",
  );

  // artifact_mapping_required at freeze: dropping done took nothing a Quick
  // or Ticket stop could reach. done was lent only by
  // invalidate_quick_classification's completion receipt, and nothing the
  // reason admits from freeze runs there while the reason is recorded: it is
  // not a target, and no step the flow can stand on under the reason has an
  // edge into it. What such a stop is admitted into is what it was admitted
  // into before.
  const row = state.recovery.get("artifact_mapping_required");
  const named = new Set([...row.parks_at, ...(row.handled_at ?? [])]);
  const admitted = row.resume_targets.filter((target) => {
    try {
      return permitsResume(state, row.reason, target, { origin: "freeze" });
    } catch {
      return false;
    }
  });
  assert.deepEqual(admitted, ["draft_artifact", "human"]);
  const running = new Set();
  const queue = admitted.filter((name) => !parks(state, name));
  while (queue.length > 0) {
    const name = queue.shift();
    if (running.has(name)) continue;
    running.add(name);
    for (const edge of state.outgoing.get(name) ?? []) {
      if (named.has(edge.to) && !parks(state, edge.to) && !row.parks_at.includes(edge.to)) queue.push(edge.to);
    }
  }
  assert.ok(!row.resume_targets.includes("invalidate_quick_classification"));
  assert.ok(!running.has("invalidate_quick_classification"), [...running].join(", "));
});

test("permission is read off the reason and not off the step it parked at", () => {
  // The counterexample the ticket asks for, taken from the shipped document
  // rather than from a fixture: two reasons parking at one step, each permitting
  // something the other forbids. Reading permission off the step would let a
  // resume one reason forbids be laundered through the other.
  const graph = document();
  const state = index(graph);
  const byStep = new Map();
  // Union rows only: an origin-scoped row permits the step its park stood at
  // and nothing else, which is a narrower question the next test asks.
  for (const row of graph.recovery.filter((entry) => entry.resume_scope === undefined)) {
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
    permitsResume(state, "project_boundary_invalid", "implement", { origin: "implement" }),
    true,
    "the reason still permits a target with a way out, from a park that stood there",
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
  // looking like the owner of ninety-eight codes it merely passes on.
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
const context = (task, { code = 0, failLeaf, crashLeaf, failTransit = false } = {}) => {
  const calls = { transits: [], execs: [] };
  // What the daemon does with the two effects a run can emit: `metadata set`
  // lands the leaf in the task's bag, and a transit moves the position and
  // bumps that step's own counter in the same write (section 8). A step move
  // into the human status step is where a graph park lands, and a status move
  // parks the task standing where it is.
  // `autosk metadata set` parses its value as a JSON literal and keeps the
  // argument as a plain string only when it is not one (`cmd/autosk/
  // metadata.go`), so a count written as `27` lands as the number 27 and a
  // reason or a watermark lands as the string it was.
  const literal = (raw) => {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  };
  const setLeaf = (dotPath, value) => {
    const keys = dotPath.split(".");
    let bag = (task.metadata ??= {});
    while (keys.length > 1) bag = bag[keys.shift()] ??= {};
    bag[keys[0]] = literal(value);
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
        // `failTransit` is a transit the daemon refuses after the step's own
        // writes landed: the position does not move.
        if (failTransit) throw new Error("cannot transit: the daemon refused the move");
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
  assert.deepEqual(move.calls.execs, [["autosk", "metadata", "unset", "t-1", "park.reason", "park.origin"]]);
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

test("a take out of an origin-scoped park's origin clears the reason and the origin, so an engine park after it re-enters freely", async () => {
  // R9c-13. A boundary park at aggregate_verify, resumed there; aggregate_verify
  // takes t_369 into accept_staging, a step the Epic's boundary row names.
  // Under the union's surface the reason stayed, and so did the origin, so a
  // later engine park at accept_staging could not re-enter it and could only
  // rewind to aggregate_verify, before the PASS.
  const graph = document();
  const pass = graph.transitions.find((edge) => edge.id === "t_369");
  assert.deepEqual([pass.from, pass.to], ["aggregate_verify", "accept_staging"]);
  const row = graph.recovery.find((entry) => entry.reason === "epic_boundary_invalid");
  const named = [...row.parks_at, ...(row.handled_at ?? [])];
  assert.ok(named.includes("aggregate_verify") && named.includes("accept_staging"), "the take stays inside the row");
  const predicate = graph.guards.find((guard) => guard.id === pass.guards[0]).predicate;
  const workflow = buildWorkflow(graph, { evaluate: (id) => id === predicate });
  const task = {
    id: "t-b",
    step: "aggregate_verify",
    status: "human",
    metadata: { park: { reason: "epic_boundary_invalid", origin: "aggregate_verify" } },
  };
  await workflow.onTransit(context(task).ctx, { step: "aggregate_verify" });
  await context(task).ctx.transit({ step: "aggregate_verify" });

  const move = context(task);
  await workflow.steps.aggregate_verify.onRun(move.ctx);
  assert.equal(task.step, "accept_staging");
  assert.deepEqual(move.calls.execs, [["autosk", "metadata", "unset", "t-b", "park.reason", "park.origin"]]);
  assert.equal(task.metadata.park?.reason, undefined);
  assert.equal(task.metadata.park?.origin, undefined);

  task.status = "human"; // the engine's own park: no reason, no origin
  await workflow.onTransit(context(task).ctx, { step: "accept_staging" });
  await assert.rejects(
    () => workflow.onTransit(context(task).ctx, { step: "aggregate_verify" }),
    (error) => error.reason === "resume_target_not_permitted",
  );
});

test("the contract says what an engine park leaves behind and what a daemon-side writer owes", () => {
  // R9c-13. An engine park writes neither leaf, so "the origin of the park
  // that took it there" was not true of it, and a writer that left an origin
  // in place could pair a new reason with an unrelated park's origin.
  const contract = readFileSync(path.join(ROOT, "docs/contracts/workflow-factory.md"), "utf8");
  const section = contract.slice(contract.indexOf("## 4."), contract.indexOf("## 5."));
  assert.doesNotMatch(section, /leaves an origin already recorded/u);
  assert.match(section, /engine-side park writes neither/u);
  assert.match(section, /writes the step the task stands at as `park\.origin`/u);
});

test("an origin-scoped park keeps its reason on a take back into its origin, and a union park on a take inside its row", async () => {
  // The other side of R9c-13: the surface of an origin-scoped row is its
  // origin, so a self-loop at the origin is still the park's own step; a
  // union row's surface is still every step it names.
  const graph = document();
  const loop = graph.transitions.find((edge) => edge.id === "t_012");
  assert.deepEqual([loop.from, loop.to], ["freeze_artifact", "freeze_artifact"]);
  const loopPredicate = graph.guards.find((guard) => guard.id === loop.guards[0]).predicate;
  const looping = buildWorkflow(graph, { evaluate: (id) => id === loopPredicate });
  const scoped = {
    id: "t-l",
    step: "freeze_artifact",
    status: "work",
    metadata: { park: { reason: "epic_boundary_invalid", origin: "freeze_artifact" } },
  };
  const stay = context(scoped);
  await looping.steps.freeze_artifact.onRun(stay.ctx);
  assert.deepEqual(stay.calls.transits, [{ step: "freeze_artifact" }]);
  assert.deepEqual(stay.calls.execs, []);
  assert.equal(scoped.metadata.park.reason, "epic_boundary_invalid");

  const inside = graph.transitions.find((edge) => edge.id === "t_507");
  assert.deepEqual([inside.from, inside.to], ["verify_candidate", "freeze_candidate"]);
  const union = graph.recovery.find((entry) => entry.reason === "arena_candidate_failed");
  assert.equal(union.resume_scope, undefined);
  assert.ok(union.parks_at.includes("build_candidate") && union.parks_at.includes("freeze_candidate"));
  const insidePredicate = graph.guards.find((guard) => guard.id === inside.guards[0]).predicate;
  const moving = buildWorkflow(graph, { evaluate: (id) => id === insidePredicate });
  const task = {
    id: "t-u",
    step: "verify_candidate",
    status: "work",
    metadata: { park: { reason: "arena_candidate_failed", origin: "build_candidate" } },
  };
  const run = context(task);
  await moving.steps.verify_candidate.onRun(run.ctx);
  assert.equal(task.step, "freeze_candidate");
  assert.deepEqual(run.calls.execs, [], "a take inside a union row's surface clears nothing, origin or not");
  assert.equal(task.metadata.park.reason, "arena_candidate_failed");
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
    ["autosk", "metadata", "set", "t-9", "park.origin", stranded.name],
    ["autosk", "metadata", "set", "t-9", "park.reason", stranded.no_transition_reason],
  ]);
  assert.deepEqual(parking.calls.transits, [{ status: "human" }]);
});

test("a park records where it stood before why, and an origin that could not be recorded refuses the park", async () => {
  // The origin an origin-scoped reason resumes into is the step the park
  // stood at, written before the reason: a reason recorded over an origin
  // that failed to land would pair with an earlier park's origin.
  const stranded = document().steps.find((step) => step.kind === "agent");
  const graph = resealed((entry) => {
    entry.transitions = entry.transitions.filter((edge) => edge.from !== stranded.name);
  });
  const workflow = buildWorkflow(graph, { evaluate: always });
  const task = { id: "t-7", step: stranded.name, status: "work", metadata: { park: { origin: "stale" } } };
  const failing = context(task, { failLeaf: "park.origin" });
  await assert.rejects(() => workflow.steps[stranded.name].onRun(failing.ctx), /park origin/u);
  assert.deepEqual(failing.calls.transits, [], "the flow must not have parked");
  assert.equal(task.metadata.park.reason, undefined, "no reason was recorded over an origin that did not land");
  const landing = context(task);
  await workflow.steps[stranded.name].onRun(landing.ctx);
  assert.equal(task.metadata.park.origin, stranded.name);
  assert.equal(task.metadata.park.reason, stranded.no_transition_reason);
});

test("a park whose reason could not be recorded refuses rather than parking anyway", async () => {
  // A parked task whose reason was lost is a task operation 2 can never move,
  // so the write failing has to stop the park rather than be swallowed. It is
  // the last of the park record's two writes — the origin lands first — and the
  // record it leaves has no reason at all,
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
    ["autosk", "metadata", "set", "t-2", "park.origin", "init_planning_ref"],
    ["autosk", "metadata", "set", "t-2", "park.reason", guard.park_reason],
  ]);
  assert.deepEqual(parking.calls.transits, [{ step: "human" }]);

  // And the reason it recorded is one the document lets the flow resume with,
  // which is what the review measured going wrong end to end.
  const row = graph.recovery.find((entry) => entry.reason === guard.park_reason);
  assert.ok(row.parks_at.includes("init_planning_ref"));
  // Origin-scoped (R9c-14): the one target is the helper-calling step the
  // park recorded, and cleanup — a step the row also names — is not it.
  assert.equal(permitsResume(state, guard.park_reason, "init_planning_ref", { origin: "init_planning_ref" }), true);
  assert.equal(
    refusalOf(() => permitsResume(state, guard.park_reason, "cleanup", { origin: "init_planning_ref" })).reason,
    "resume_target_not_permitted",
  );
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

test("a cap binds exactly the counted edges' guards and their carrying siblings'", () => {
  // Derived from the document, not listed beside it: each counted edge admits
  // below the limit, and the sibling edges out of a counted edge's step that
  // carry the cap's park_reason are how the flow stops at it. Every term of
  // one cap reads one count — the takings of every pair the cap counts — so
  // an artifact's narrow and full-panel rounds spend one budget (R8-4), and
  // the repair cycle after the checks is a cap of its own (R8-5). The shipped
  // document's three caps must therefore bind exactly these eight guards — a
  // ninth means a guard the cap does not own is gated by it, and a missing
  // one means a round nothing counts.
  const state = index(document());
  assert.deepEqual(
    [...state.capTerms.keys()].sort(),
    ["guard_212", "guard_237", "guard_238", "guard_423", "guard_424", "guard_449", "guard_450", "guard_585"],
  );
  // Each term carries the cap's own reason, which a refusal at the limit
  // names (review of 12c, L4). The artifact's cap also carries its cycle's
  // boundary — the verified PASS publication, `publish_artifact_pass ->
  // select_next` — so its count is the takings since the artifact's cycle
  // began (review of 12c, M1); the code review and the repair cycle count per
  // task: one artifact, one candidate.
  const artifact = [
    { from: "synthesize_panel", to: "fix_artifact" },
    { from: "narrow_review_join", to: "fix_artifact" },
  ];
  const boundary = { cycle: "artifact_review_round", from: "publish_artifact_pass", to: "select_next" };
  for (const [id, below] of [["guard_212", true], ["guard_238", true], ["guard_237", false], ["guard_585", false]]) {
    assert.deepEqual(state.capTerms.get(id), [{ pairs: artifact, limit: 10, below, reason: "review_cap", boundary }], id);
  }
  const code = [{ from: "record_code_verdict", to: "fix" }];
  assert.deepEqual(state.capTerms.get("guard_449"), [{ pairs: code, limit: 10, below: false, reason: "review_cap" }]);
  assert.deepEqual(state.capTerms.get("guard_450"), [{ pairs: code, limit: 10, below: true, reason: "review_cap" }]);
  const repair = [{ from: "verify", to: "fix" }];
  assert.deepEqual(state.capTerms.get("guard_423"), [{ pairs: repair, limit: 10, below: true, reason: "verification_cap" }]);
  assert.deepEqual(state.capTerms.get("guard_424"), [{ pairs: repair, limit: 10, below: false, reason: "verification_cap" }]);
});

test("the counted edge admits the tenth taking and refuses the eleventh", async () => {
  // Both halves of the boundary, on every edge the shipped document's caps
  // count: an artifact's narrow and full-panel NOT_PASS (R8-4), the code
  // verdict's, and the repair after the checks (R8-5).
  for (const [from, to, predicates, reason] of [
    ["narrow_review_join", "fix_artifact", ["cond_135", "cond_136"], "review_cap"],
    ["synthesize_panel", "fix_artifact", ["cond_110", "cond_460"], "review_cap"],
    ["record_code_verdict", "fix", ["cond_332", "cond_333"], "review_cap"],
    ["verify", "fix", ["cond_308", "cond_309"], "verification_cap"],
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
    assert.equal(capped.metadata.park.reason, reason);
    assert.equal(capped.metadata.park.origin, from);
    assert.ok(
      calls.execs.some((argv) => argv[4] === "park.reason" && argv[5] === reason),
      `${from}: the cap's reason was recorded before the task parked`,
    );
  }
});

// --- Round 8 of #39, R8-4: an artifact's rounds of either kind spend one count ---

/**
 * One autonomous review round at `join` as the daemon runs it: the join
 * decides, and a taking of an edge bumps `transition_takings[from][to]` in
 * the same write as the position (patch `0034`) — which the suite's context
 * does not do — so the round's fix and its way back to a join are the
 * caller's. Returns where the join sent the flow.
 */
const reviewRound = async (workflow, task, join) => {
  task.step = join;
  task.status = "work";
  await workflow.steps[join].onRun(context(task).ctx);
  if (task.status === "human") return "human";
  const byTarget = ((task.metadata.transition_takings ??= {})[join] ??= {});
  byTarget[task.step] = (byTarget[task.step] ?? 0) + 1;
  return task.step;
};

test("an artifact's full-panel NOT_PASS rounds reach review_cap at the limit, and its narrow and full rounds share one count (R8-4)", async () => {
  // Round 8 of #39, R8-4: the cap counted `narrow_review_join -> fix_artifact`
  // alone, so a full panel's NOT_PASS (`synthesize_panel -> fix_artifact`,
  // t_205) took the fixer at any count, and a change of scope sends the next
  // round to a full panel again (cond_093): full-panel rounds never reached
  // review_cap. Every NOT_PASS round of one artifact now counts, whichever
  // panel returned it, against the one limit 01 §6 and §9 state.
  const graph = document();
  const workflow = buildWorkflow(graph, {
    evaluate: (predicate) => ["cond_110", "cond_460", "cond_135", "cond_136"].includes(predicate),
  });

  // Full-panel rounds alone: ten fixes, and the eleventh NOT_PASS parks.
  const full = { id: "t-full", metadata: {} };
  const fullRounds = [];
  for (let round = 1; round <= 12; round += 1) {
    const went = await reviewRound(workflow, full, "synthesize_panel");
    fullRounds.push(went);
    if (went === "human") break;
  }
  assert.deepEqual(fullRounds, [...Array(10).fill("fix_artifact"), "human"]);
  assert.equal(full.metadata.park.reason, "review_cap");
  assert.equal(full.metadata.park.origin, "synthesize_panel");
  assert.deepEqual(full.metadata.transition_takings, { synthesize_panel: { fix_artifact: 10 } });
  // The stop at the full panel resumes as the narrow one does: into the
  // fixer along its own edge, and only on the user's decision recorded under
  // this park; staying parked owes none; the Quick and Ticket targets are
  // not its to take.
  const state = index(graph);
  const row = state.recovery.get("review_cap");
  assert.ok(row.parks_at.includes("synthesize_panel"));
  const visits = full.metadata.step_visits;
  const origin = { origin: "synthesize_panel" };
  assert.equal(refusalOf(() => permitsResume(state, "review_cap", "fix_artifact", origin, visits)).reason, "resume_target_not_permitted");
  const record = resumeRecord(row, visits, "fix_artifact");
  assert.equal(permitsResume(state, "review_cap", "fix_artifact", { ...origin, decision: leafFor(row, visits, record) }, visits, decidedBy([record])), true);
  assert.equal(permitsResume(state, "review_cap", "human", origin, visits), true);
  for (const target of ["fix", "rebuild_code_anchor", "invalidate_quick_classification"]) {
    const other = resumeRecord(row, visits, target);
    assert.equal(refusalOf(() => permitsResume(state, "review_cap", target, { ...origin, decision: leafFor(row, visits, other) }, visits, decidedBy([other]))).reason,
      "resume_target_not_permitted", target);
  }

  // Mixed rounds: one count, whichever panel returned the NOT_PASS.
  const mixed = { id: "t-mixed", metadata: {} };
  const joins = [];
  for (let round = 0; round < 10; round += 1) {
    const join = round % 3 === 0 ? "synthesize_panel" : "narrow_review_join";
    joins.push(join);
    assert.equal(await reviewRound(workflow, mixed, join), "fix_artifact", `round ${round + 1} at ${join} is below the cap`);
  }
  assert.deepEqual(mixed.metadata.transition_takings, {
    synthesize_panel: { fix_artifact: 4 },
    narrow_review_join: { fix_artifact: 6 },
  });
  for (const join of ["narrow_review_join", "synthesize_panel"]) {
    const next = structuredClone(mixed);
    assert.equal(await reviewRound(workflow, next, join), "human", `the eleventh round at ${join} parks`);
    assert.equal(next.metadata.park.reason, "review_cap");
    assert.equal(next.metadata.park.origin, join);
  }

  // Nine in all, split between the two joins: either join still takes the fixer.
  for (const [counts, join] of [
    [{ synthesize_panel: { fix_artifact: 4 }, narrow_review_join: { fix_artifact: 5 } }, "synthesize_panel"],
    [{ synthesize_panel: { fix_artifact: 4 }, narrow_review_join: { fix_artifact: 5 } }, "narrow_review_join"],
  ]) {
    const task = { id: "t-nine", metadata: { transition_takings: structuredClone(counts) } };
    assert.equal(await reviewRound(workflow, task, join), "fix_artifact", `nine rounds in all, at ${join}`);
  }

  // The veto holds the sum too: a running session asking for the full
  // panel's fixer at the combined limit is refused, as the narrow edge's is,
  // with the cap's own reason (review of 12c, L4).
  const asking = {
    id: "t-ask",
    step: "synthesize_panel",
    status: "work",
    metadata: { transition_takings: { synthesize_panel: { fix_artifact: 3 }, narrow_review_join: { fix_artifact: 7 } } },
  };
  await assert.rejects(
    () => workflow.onTransit(context(asking).ctx, { step: "fix_artifact" }),
    (error) => error.reason === "review_cap",
  );
  asking.metadata.transition_takings.narrow_review_join.fix_artifact = 6;
  assert.equal(await workflow.onTransit(context(asking).ctx, { step: "fix_artifact" }), undefined);

  // The caps are per cycle: an artifact's rounds spend nothing of the code
  // review's count, nor of the repair cycle's.
  const code = buildWorkflow(graph, { evaluate: (predicate) => ["cond_332", "cond_333", "cond_308", "cond_309"].includes(predicate) });
  const spent = { synthesize_panel: { fix_artifact: 10 }, narrow_review_join: { fix_artifact: 10 } };
  for (const join of ["record_code_verdict", "verify"]) {
    const task = { id: "t-code", metadata: { transition_takings: structuredClone(spent) } };
    assert.equal(await reviewRound(code, task, join), "fix", `${join} does not spend the artifact's count`);
  }
});

// --- Review of 12c, M1: the review cap bounds each artifact's review cycle ---

/** The answers an Epic's planning runs on here: a NOT_PASS at both joins, and each PASS published and verified. */
const PLANNING = ["cond_110", "cond_460", "cond_135", "cond_136", "cond_152"];

/**
 * An artifact's PASS published as the daemon runs it: `publish_artifact_pass`
 * takes the boundary to `select_next` (t_247, the verified publication), and
 * the daemon bumps that pair's counter in the same write as the position —
 * which the suite's context leaves to the caller, as `reviewRound` does.
 */
const publishPass = async (workflow, task) => {
  task.step = "publish_artifact_pass";
  task.status = "work";
  const run = context(task);
  await workflow.steps.publish_artifact_pass.onRun(run.ctx);
  assert.equal(task.step, "select_next", "the verified publication closes the artifact's cycle");
  const byTarget = ((task.metadata.transition_takings ??= {}).publish_artifact_pass ??= {});
  byTarget.select_next = (byTarget.select_next ?? 0) + 1;
  return run.calls;
};

test("each artifact's review cycle has its own count: four artifacts of nine NOT_PASS rounds do not park, and one artifact's cycle parks at its own limit (review of 12c, M1)", async () => {
  // Review of 12c, M1: ADR-104 made the count the task's, so once every
  // full-panel NOT_PASS was counted an Epic whose four artifacts average three
  // NOT_PASS rounds reached review_cap on its fourth artifact — and with no
  // cap decision admitted on today's hosts, autonomous planning ended there.
  // 03 gives each artifact its own cycle (§4, §5, §8). The cap's count is now
  // the takings since the cycle's verified boundary — a PASS published,
  // `publish_artifact_pass -> select_next` — against the same limit.
  const graph = document();
  const cap = graph.caps.find((entry) => entry.cycle === "artifact_review_round");
  assert.deepEqual(cap.cycle_boundary, { from: "publish_artifact_pass", to: "select_next" });
  for (const entry of graph.caps.filter((other) => other !== cap)) {
    assert.equal(entry.cycle_boundary, undefined, `${entry.cycle} counts per task: one artifact, one candidate`);
  }
  const workflow = buildWorkflow(graph, { evaluate: (predicate) => PLANNING.includes(predicate) });
  const epic = { id: "t-epic", metadata: {} };
  for (let artifact = 1; artifact <= 4; artifact += 1) {
    for (let round = 1; round <= 9; round += 1) {
      const join = round % 2 === 0 ? "narrow_review_join" : "synthesize_panel";
      assert.equal(await reviewRound(workflow, epic, join), "fix_artifact", `artifact ${artifact}, round ${round} at ${join}`);
    }
    if (artifact < 4) await publishPass(workflow, epic);
  }
  assert.equal(epic.metadata.park, undefined, "thirty-six rounds over four artifacts park nothing");
  // Each crossing recorded the count its cycle began at, keyed by the
  // crossing the daemon's counter would then read.
  assert.deepEqual(epic.metadata.cap_baselines, { artifact_review_round: { 1: 9, 2: 18, 3: 27 } });
  // The fourth artifact's cycle: its tenth round still takes the fixer, and
  // with ten spent its next NOT_PASS parks review_cap — at either join,
  // the narrow and the full rounds sharing one limit inside the cycle.
  assert.equal(await reviewRound(workflow, epic, "synthesize_panel"), "fix_artifact", "the fourth artifact's tenth round");
  for (const join of ["narrow_review_join", "synthesize_panel"]) {
    const next = structuredClone(epic);
    assert.equal(await reviewRound(workflow, next, join), "human", `the fourth artifact's eleventh NOT_PASS at ${join} parks`);
    assert.equal(next.metadata.park.reason, "review_cap");
    assert.equal(next.metadata.park.origin, join);
  }
  // Counted per task, the same thirty-seven takings would have parked at the
  // eleventh — in the second artifact.
  const perTask = { id: "t-task", metadata: { transition_takings: structuredClone(epic.metadata.transition_takings) } };
  assert.equal(await reviewRound(workflow, perTask, "synthesize_panel"), "human", "without the cycles' baselines the task's count is spent");
  // An artifact that spent all ten before its PASS leaves the next its own
  // ten: the new cycle's first round counts none of the last cycle's.
  const spentAll = { id: "t-spent", metadata: {} };
  for (let round = 0; round < 10; round += 1) await reviewRound(workflow, spentAll, "synthesize_panel");
  assert.equal(await reviewRound(workflow, structuredClone(spentAll), "synthesize_panel"), "human", "the first artifact's cycle is spent");
  await publishPass(workflow, spentAll);
  assert.deepEqual(spentAll.metadata.cap_baselines, { artifact_review_round: { 1: 10 } });
  assert.equal(await reviewRound(workflow, spentAll, "narrow_review_join"), "fix_artifact", "the next artifact's first round");
});

test("only a verified artifact boundary starts a cycle: a decision resume, a move that crosses no boundary, a crossing the factory did not record and a baseline ahead of the daemon's count start none (review of 12c, M1)", async () => {
  const graph = document();
  const row = graph.recovery.find((entry) => entry.reason === "review_cap");
  const signed = [];
  const workflow = buildWorkflow(graph, { evaluate: (predicate) => [...PLANNING, "cond_225"].includes(predicate), ...deciding(signed) });
  // The first artifact passes after four rounds; the second spends its ten
  // and parks.
  const task = { id: "t-round", metadata: {} };
  for (let round = 0; round < 4; round += 1) await reviewRound(workflow, task, "synthesize_panel");
  await publishPass(workflow, task);
  for (let round = 0; round < 10; round += 1) {
    assert.equal(await reviewRound(workflow, task, "narrow_review_join"), "fix_artifact", `the second artifact's round ${round + 1}`);
  }
  assert.equal(await reviewRound(workflow, task, "synthesize_panel"), "human");
  assert.equal(task.metadata.park.reason, "review_cap");
  const parkedAgain = async (label) => {
    const next = structuredClone(task);
    delete next.metadata.park;
    assert.equal(await reviewRound(workflow, next, "synthesize_panel"), "human", label);
    assert.equal(next.metadata.park.reason, "review_cap", label);
  };

  // A decision buys one round and starts no cycle: the resume is taken
  // `human -> fix_artifact`, which the cap does not count and which is no
  // boundary, so the bought round's NOT_PASS parks again at once.
  const decided = resumeRecord(row, task.metadata.step_visits, "fix_artifact", { task: "t-round" });
  signed.push(decided);
  task.metadata.park.decision = leafFor(row, task.metadata.step_visits, decided);
  assert.equal(await workflow.onTransit(context(task).ctx, { step: "fix_artifact" }), undefined);
  await parkedAgain("the round a decision bought parks at its NOT_PASS");

  // A move that crosses no boundary: the anchor's rebuild lands at
  // select_next (t_320), and a resume lands there `human -> select_next`.
  // Neither is the verified publication, so neither records a baseline, and
  // the daemon's counter of the boundary does not move.
  const rebuilt = structuredClone(task);
  delete rebuilt.metadata.park;
  rebuilt.step = "rebuild_anchor";
  rebuilt.status = "work";
  const rebuild = context(rebuilt);
  await workflow.steps.rebuild_anchor.onRun(rebuild.ctx);
  assert.equal(rebuilt.step, "select_next");
  assert.ok(!rebuild.calls.execs.some((argv) => String(argv[4]).startsWith("cap_baselines")), "no baseline on a move that crosses no boundary");
  const bump = (from, to) => {
    const byTarget = ((task.metadata.transition_takings ??= {})[from] ??= {});
    byTarget[to] = (byTarget[to] ?? 0) + 1;
  };
  bump("rebuild_anchor", "select_next");
  bump("human", "select_next");
  await parkedAgain("a move that crosses no boundary starts no cycle");

  // A crossing the factory did not record — a running session asking for
  // `select_next` by name, which the veto admits on the verified
  // publication — reads the last recorded baseline, so it starts none either.
  const asking = { id: "t-round", step: "publish_artifact_pass", status: "work", metadata: structuredClone(task.metadata) };
  delete asking.metadata.park;
  assert.equal(await workflow.onTransit(context(asking).ctx, { step: "select_next" }), undefined);
  bump("publish_artifact_pass", "select_next");
  await parkedAgain("a crossing the factory did not record starts no cycle");

  // A baseline keyed ahead of the daemon's count — written for a crossing
  // that never landed — or above the count it would lower is not read.
  const crossed = task.metadata.transition_takings.publish_artifact_pass.select_next;
  const spent = task.metadata.transition_takings.synthesize_panel.fix_artifact + task.metadata.transition_takings.narrow_review_join.fix_artifact;
  task.metadata.cap_baselines.artifact_review_round[crossed + 1] = spent;
  await parkedAgain("a baseline ahead of the daemon's count starts no cycle");
  task.metadata.cap_baselines.artifact_review_round[crossed] = spent + 1;
  await parkedAgain("a baseline above the count it would lower is not read");
  for (const malformed of ["15", -1, 1.5, null, { value: 15 }]) {
    task.metadata.cap_baselines.artifact_review_round[crossed] = malformed;
    await parkedAgain(`a baseline of ${JSON.stringify(malformed)} frees no round`);
  }
  // A record that is an array is no record of baselines, at either level.
  const baselines = task.metadata.cap_baselines;
  task.metadata.cap_baselines = { artifact_review_round: [0, spent, spent] };
  await parkedAgain("an array of baselines is not read");
  task.metadata.cap_baselines = [{ artifact_review_round: { [crossed]: spent } }];
  await parkedAgain("an array in place of the baselines record is not read");
  task.metadata.cap_baselines = baselines;
});

test("the factory records a cycle's baseline, keyed by the crossing it opens, before it takes the boundary, and a baseline it could not record leaves the task where it stood (review of 12c, M1)", async () => {
  const workflow = buildWorkflow(document(), { evaluate: (predicate) => predicate === "cond_152" });
  const takings = () => ({
    synthesize_panel: { fix_artifact: 5 },
    narrow_review_join: { fix_artifact: 7 },
    record_code_verdict: { fix: 3 },
    publish_artifact_pass: { select_next: 2 },
  });
  const task = { id: "t-b", step: "publish_artifact_pass", status: "work", metadata: { transition_takings: takings() } };
  const { ctx, calls } = context(task);
  await workflow.steps.publish_artifact_pass.onRun(ctx);
  assert.equal(task.step, "select_next");
  // The artifact's pairs only — the code review's takings are another cap's —
  // under the third crossing, the one this transit makes.
  assert.deepEqual(
    calls.execs.filter((argv) => String(argv[4]).startsWith("cap_baselines")),
    [["autosk", "metadata", "set", "t-b", "cap_baselines.artifact_review_round.3", "12"]],
  );
  assert.deepEqual(task.metadata.cap_baselines, { artifact_review_round: { 3: 12 } });

  // Written before the move: a write that fails stops the move, so no
  // crossing ever lands without the baseline the factory meant for it.
  for (const options of [{ failLeaf: "cap_baselines.artifact_review_round.3" }, { crashLeaf: "cap_baselines.artifact_review_round.3" }]) {
    const stuck = { id: "t-b", step: "publish_artifact_pass", status: "work", metadata: { transition_takings: takings() } };
    const run = context(stuck, options);
    await assert.rejects(() => workflow.steps.publish_artifact_pass.onRun(run.ctx));
    assert.deepEqual(run.calls.transits, [], JSON.stringify(options));
    assert.equal(stuck.step, "publish_artifact_pass");
  }

  // Only the boundary writes one: the rounds, their stop and every other
  // move write none — out of the publication itself too, when it goes on to
  // the anchor's impact rather than to the next artifact.
  const impact = buildWorkflow(document(), { evaluate: (predicate) => predicate === "cond_151" });
  const toImpact = { id: "t-b", step: "publish_artifact_pass", status: "work", metadata: { transition_takings: takings() } };
  const impactRun = context(toImpact);
  await impact.steps.publish_artifact_pass.onRun(impactRun.ctx);
  assert.equal(toImpact.step, "prepare_anchor_impact");
  assert.ok(!impactRun.calls.execs.some((argv) => String(argv[4]).startsWith("cap_baselines")), "no baseline on the way to the anchor's impact");
  const rounds = buildWorkflow(document(), { evaluate: (predicate) => ["cond_110", "cond_460"].includes(predicate) });
  for (const count of [3, 10]) {
    const round = { id: "t-b", step: "synthesize_panel", status: "work", metadata: { transition_takings: { synthesize_panel: { fix_artifact: count } } } };
    const run = context(round);
    await rounds.steps.synthesize_panel.onRun(run.ctx);
    assert.ok(!run.calls.execs.some((argv) => String(argv[4]).startsWith("cap_baselines")), `no baseline at ${count}`);
  }
});

test("a cap's cycle boundary is refused at build when no declared edge joins it, when the cap counts it, or when an edge crossing it declares no guards (review of 12c, M1)", () => {
  // The boundary is the pair the daemon counts, so a pair no edge joins
  // would never be crossed, a counted pair would both spend the cycle and
  // close it, and an unguarded edge on it would close a cycle on nothing —
  // not on a PASS recorded.
  const artifact = (graph) => graph.caps.find((entry) => entry.cycle === "artifact_review_round");
  for (const [mutate, reason, detail] of [
    [(graph) => { artifact(graph).cycle_boundary = { from: "publish_artifact_pass", to: "draft_artifact" }; }, "transition_not_declared", /publish_artifact_pass -> draft_artifact/u],
    [(graph) => { artifact(graph).cycle_boundary = { from: "select_next" }; }, "transition_not_declared", /boundary/u],
    [(graph) => { artifact(graph).cycle_boundary = { from: "synthesize_panel", to: "fix_artifact" }; }, "cap_binding_ambiguous", /synthesize_panel -> fix_artifact/u],
    [(graph) => { graph.transitions.find((edge) => edge.id === "t_264").guards = []; }, "cap_binding_incomplete", /t_264/u],
  ]) {
    const refusal = refusalOf(() => index(resealed(mutate)));
    assert.equal(refusal.reason, reason, refusal.message);
    assert.match(refusal.detail, detail);
  }
  // A boundary that shares only a step with a pair the cap counts is not
  // that pair: the fixer's own loop, and the full panel's stop.
  for (const shared of [{ from: "fix_artifact", to: "fix_artifact" }, { from: "synthesize_panel", to: "human" }]) {
    const state = index(resealed((graph) => { artifact(graph).cycle_boundary = shared; }));
    assert.deepEqual(state.boundaries.map(({ from, to }) => ({ from, to })), [shared], JSON.stringify(shared));
  }
});

// --- Narrow re-review of 12c: what the per-cycle count holds, and where it is conservative ---

/**
 * A resume as the daemon runs it: the veto admits the target, and
 * `Engine.resume` counts the taking out of the step the park kept — a status
 * park keeps the step (`transition.ts` `positionFor`), and the resume counts
 * `<step> -> <target>` (`engine.ts`), in the same write as the position.
 */
const resumeInto = async (workflow, task, target) => {
  await workflow.onTransit(context(task).ctx, { step: target });
  const byTarget = ((task.metadata.transition_takings ??= {})[task.step] ??= {});
  byTarget[target] = (byTarget[target] ?? 0) + 1;
  task.step = target;
  task.status = "work";
};

test("a resume out of a status park at the boundary step is counted as a crossing: with no baseline written for it the next artifact goes on counting, and it opens a cycle only on a baseline the factory wrote at a verified PASS publication (narrow re-review of 12c, Low 1)", async () => {
  // Narrow re-review of 12c, Low 1: the documents said a resume opens no
  // cycle, counted `human -> <target>`. A park the factory records as a
  // status move — no candidate edge — keeps the step, and a resume counts
  // the taking out of it: parked at `publish_artifact_pass` with
  // `planning_publication_corrupt`, whose row resumes into `select_next`
  // without a decision, the resume is a taking of the boundary pair. What
  // holds is that the count never falls below the rounds since the last
  // verified PASS publication: every baseline is one the factory wrote as it
  // took a boundary edge whose guards verified the publication.
  const graph = document();
  let answers = new Set(PLANNING);
  const workflow = buildWorkflow(graph, { evaluate: (predicate) => answers.has(predicate) });
  const crossed = (task) => task.metadata.transition_takings.publish_artifact_pass?.select_next ?? 0;

  // P1: no baseline for the crossing — the next artifact inherits the count.
  const inherits = { id: "t-p1", metadata: {} };
  for (let round = 0; round < 4; round += 1) await reviewRound(workflow, inherits, "synthesize_panel");
  await publishPass(workflow, inherits);
  for (let round = 0; round < 9; round += 1) await reviewRound(workflow, inherits, "narrow_review_join");
  answers = new Set(PLANNING.filter((predicate) => predicate !== "cond_152"));
  inherits.step = "publish_artifact_pass";
  inherits.status = "work";
  await workflow.steps.publish_artifact_pass.onRun(context(inherits).ctx);
  assert.equal(inherits.step, "publish_artifact_pass", "a status park keeps the step");
  assert.equal(inherits.status, "human");
  assert.equal(inherits.metadata.park.reason, "planning_publication_corrupt");
  await resumeInto(workflow, inherits, "select_next");
  assert.equal(crossed(inherits), 2, "the resume is counted as a crossing of the boundary pair");
  assert.deepEqual(inherits.metadata.cap_baselines, { artifact_review_round: { 1: 4 } }, "and no baseline was written for it");
  answers = new Set(PLANNING);
  delete inherits.metadata.park;
  assert.equal(await reviewRound(workflow, structuredClone(inherits), "synthesize_panel"), "fix_artifact");
  const next = structuredClone(inherits);
  await reviewRound(workflow, next, "synthesize_panel");
  assert.equal(await reviewRound(workflow, next, "synthesize_panel"), "human", "the next artifact goes on counting the last one's nine");

  // P2: a baseline the factory wrote at a verified publication whose transit
  // did not land is read once a resume makes that crossing — the cycle opens
  // at the rounds that publication closed, never at fewer.
  answers = new Set(PLANNING);
  const stale = { id: "t-p2", metadata: {} };
  for (let round = 0; round < 6; round += 1) await reviewRound(workflow, stale, "synthesize_panel");
  stale.step = "publish_artifact_pass";
  stale.status = "work";
  await assert.rejects(() => workflow.steps.publish_artifact_pass.onRun(context(stale, { failTransit: true }).ctx));
  assert.deepEqual(stale.metadata.cap_baselines, { artifact_review_round: { 1: 6 } }, "written before the move that failed");
  assert.equal(crossed(stale), 0);
  stale.status = "human"; // the engine's own park after a failed run: the step kept, no reason
  await resumeInto(workflow, stale, "publish_artifact_pass");
  answers = new Set(PLANNING.filter((predicate) => predicate !== "cond_152"));
  await workflow.steps.publish_artifact_pass.onRun(context(stale).ctx);
  assert.equal(stale.metadata.park.reason, "planning_publication_corrupt");
  await resumeInto(workflow, stale, "select_next");
  assert.equal(crossed(stale), 1);
  answers = new Set(PLANNING);
  delete stale.metadata.park;
  const rounds = [];
  for (let round = 0; round < 12; round += 1) {
    const went = await reviewRound(workflow, stale, "synthesize_panel");
    rounds.push(went);
    if (went === "human") break;
  }
  assert.deepEqual(rounds, [...Array(10).fill("fix_artifact"), "human"], "a cycle opened on the baseline of the verified publication");
});

test("a PASS published under binding drift closes no cycle: the anchor's impact leads to select_next without the boundary, and the next artifact goes on counting (narrow re-review of 12c, Low 2)", async () => {
  // Narrow re-review of 12c, Low 2: a publication that verifies with binding
  // drift goes to the anchor's impact (`t_246`, `cond_151`; `t_260`,
  // `cond_165`) rather than to `select_next`, and the anchor's rebuild
  // reaches `select_next` by `t_320`: no crossing, so the next artifact
  // starts on the published one's count. That is conservative, and the drift
  // exits are not boundaries: an anchor rebuild resets no affected
  // artifact's cycle (03 §5).
  const graph = document();
  let answers = new Set(PLANNING.filter((predicate) => predicate !== "cond_152"));
  const workflow = buildWorkflow(graph, { evaluate: (predicate) => answers.has(predicate) });
  const task = { id: "t-p3", metadata: {} };
  for (let round = 0; round < 8; round += 1) await reviewRound(workflow, task, "synthesize_panel");
  answers = new Set(["cond_151"]);
  task.step = "publish_artifact_pass";
  task.status = "work";
  await workflow.steps.publish_artifact_pass.onRun(context(task).ctx);
  assert.equal(task.step, "prepare_anchor_impact");
  answers = new Set(["cond_225"]);
  task.step = "rebuild_anchor";
  await workflow.steps.rebuild_anchor.onRun(context(task).ctx);
  assert.equal(task.step, "select_next");
  assert.equal(task.metadata.cap_baselines, undefined, "no baseline on the drift path");
  assert.equal(task.metadata.transition_takings.publish_artifact_pass?.select_next, undefined);
  answers = new Set(PLANNING);
  const rounds = [];
  for (let round = 0; round < 12; round += 1) {
    const went = await reviewRound(workflow, task, "synthesize_panel");
    rounds.push(went);
    if (went === "human") break;
  }
  assert.deepEqual(rounds, ["fix_artifact", "fix_artifact", "human"], "the next artifact inherits the published one's eight");
});

test("a cap counts each pair it counts once, however many of its transitions traverse it", async () => {
  // The daemon keeps one counter per pair (patch `0034`), so two counted
  // transitions on one pair — which the design validator refuses as
  // `graph_cap_transition_shared` — read one count, not the same count twice.
  const shared = {
    workflow: "cap_shared_pair",
    first_step: "review",
    predicates: [
      { id: "findings", reads: ["transition_takings"], description: "findings and transition_takings < cap" },
      { id: "spent", reads: ["transition_takings"], description: "findings and transition_takings >= cap" },
    ],
    steps: [
      { name: "review", kind: "agent", no_transition_reason: "fixture_no_exit" },
      { name: "fix", kind: "agent", no_transition_reason: "fixture_no_exit" },
      { name: "human", kind: "status", status: "human" },
    ],
    guards: [
      { id: "g_one", predicate: "findings", authority: { actor: "agent" }, park_reason: "fixture_no_exit" },
      { id: "g_two", predicate: "findings", authority: { actor: "agent" }, park_reason: "fixture_no_exit" },
      { id: "g_cap", predicate: "spent", authority: { actor: "agent" }, park_reason: "review_cap" },
    ],
    transitions: [
      { id: "t_one", from: "review", to: "fix", priority: 0, guards: ["g_one"] },
      { id: "t_two", from: "review", to: "fix", priority: 1, guards: ["g_two"] },
      { id: "t_cap", from: "review", to: "human", priority: 2, guards: ["g_cap"] },
    ],
    caps: [{ cycle: "round", counted_transitions: ["t_one", "t_two"], limit: 4, park_reason: "review_cap" }],
    recovery: [
      { reason: "fixture_no_exit", parks_at: ["review", "fix"], resume_targets: ["review", "fix"], required_state: "n/a" },
      { reason: "review_cap", parks_at: ["review"], resume_targets: ["review", "fix"], required_state: "n/a" },
    ],
  };
  const state = index(shared);
  assert.deepEqual(state.capTerms.get("g_one"), [{ pairs: [{ from: "review", to: "fix" }], limit: 4, below: true, reason: "review_cap" }]);
  const workflow = buildWorkflow(shared, { evaluate: always });
  for (const [count, step] of [[3, "fix"], [4, "human"]]) {
    const task = { id: "t", step: "review", status: "work", metadata: { transition_takings: { review: { fix: count } } } };
    await workflow.steps.review.onRun(context(task).ctx);
    assert.equal(task.step, step, `${count} takings of review -> fix`);
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

test("the veto refuses a transit onto the counted pair at the limit with the cap's own reason, and a guard that refuses on its own with the guard's (review of 12c, L4)", async () => {
  // Selection and the veto cannot disagree about a cap any more than they can
  // about a guard. The explicit path is `ctx.transit({step})` inside a running
  // session, which `SessionRuntime.transit` hands to this veto; an operator's
  // resume is refused by `Engine.resume` before any hook runs and is not this
  // path. Review of 12c, L4: a counted target refused at the limit answered
  // with the counted guard's own `park_reason` — `planning_candidate_
  // keepalive_invalid` on both artifact edges, `project_boundary_invalid` on
  // the code verdict's, `verification_environment_failed` on the repair —
  // conditions that did not refuse it. The cap refused it, so the refusal
  // names the cap's reason; a guard whose own predicate refuses names its
  // own, whatever the count.
  for (const [from, to, predicate, reason, own] of [
    ["narrow_review_join", "fix_artifact", "cond_136", "review_cap", "planning_candidate_keepalive_invalid"],
    ["synthesize_panel", "fix_artifact", "cond_110", "review_cap", "planning_candidate_keepalive_invalid"],
    ["record_code_verdict", "fix", "cond_333", "review_cap", "project_boundary_invalid"],
    ["verify", "fix", "cond_308", "verification_cap", "verification_environment_failed"],
  ]) {
    const admitting = buildWorkflow(document(), { evaluate: (name) => name === predicate });
    const task = (count) => ({ id: "task-1", step: from, status: "work", metadata: { transition_takings: { [from]: { [to]: count } } } });
    await assert.rejects(
      () => admitting.onTransit(context(task(10)).ctx, { step: to }),
      (error) => error.reason === reason && error.detail.includes(from) && error.detail.includes(to),
      `${from} -> ${to} at the limit`,
    );
    assert.equal(await admitting.onTransit(context(task(9)).ctx, { step: to }), undefined, `${from} -> ${to} below the limit`);
    const refusing = buildWorkflow(document(), { evaluate: never });
    for (const count of [0, 10]) {
      await assert.rejects(
        () => refusing.onTransit(context(task(count)).ctx, { step: to }),
        (error) => error.reason === own,
        `${from} -> ${to} refused by its own guard at ${count}`,
      );
    }
  }
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
    caps: [{ cycle: "round", counted_transitions: ["t_round"], limit, park_reason: "review_cap" }],
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
  // bypass the review measured. The document is refused where it is read,
  // whichever of a cap's counted edges it is (R8-4: the full panel's too).
  for (const id of ["t_231", "t_205", "t_416"]) {
    const graph = document();
    graph.transitions = graph.transitions.map((edge) =>
      edge.id === id ? { ...edge, guards: [] } : edge,
    );
    const refusal = refusalOf(() => index(graph));
    assert.equal(refusal.reason, "cap_binding_incomplete", id);
    assert.match(refusal.detail, new RegExp(`${id}\\b`, "u"), id);
    assert.match(refusal.detail, id === "t_416" ? /verification_repair_round/u : /artifact_review_round/u, id);
  }
});

test("a cap with no sibling carrying its park_reason is refused at build", () => {
  // t_230 is the edge the flow parks on when the limit is reached at the
  // narrow join, and t_581 at the full panel's (R8-4). Without one of them
  // that counted edge still stops, but the task stands still with the step's
  // own reason and `review_cap` is never recorded.
  for (const [id, step] of [["t_230", "narrow_review_join"], ["t_581", "synthesize_panel"]]) {
    const graph = document();
    graph.transitions = graph.transitions.filter((edge) => edge.id !== id);
    const refusal = refusalOf(() => index(graph));
    assert.equal(refusal.reason, "cap_binding_incomplete", id);
    assert.match(refusal.detail, /artifact_review_round/, id);
    assert.match(refusal.detail, new RegExp(`out of ${step} carrying review_cap`, "u"), id);
  }
  // And the repair cycle's stop at verify (R8-5).
  const graph = document();
  graph.transitions = graph.transitions.filter((edge) => edge.id !== "t_417");
  const refusal = refusalOf(() => index(graph));
  assert.equal(refusal.reason, "cap_binding_incomplete");
  assert.match(refusal.detail, /verification_repair_round has no edge out of verify carrying verification_cap/u);
});

test("a cap that names no counted transition — an empty list, or the retired singular field — is refused at build", () => {
  // A cap counts the takings of the transitions it names (R8-4). One naming
  // none has nothing to bind below its limit, so no round would ever spend
  // it; and a cap still written with the single `counted_transition` a
  // document carried before is refused by name rather than read as counting
  // nothing.
  for (const [label, rewrite] of [
    ["an empty list", (cap) => ({ ...cap, counted_transitions: [] })],
    ["the retired singular field", ({ counted_transitions, ...cap }) => ({ ...cap, counted_transition: counted_transitions[0] })],
    ["no field at all", ({ counted_transitions, ...cap }) => cap],
  ]) {
    const graph = document();
    graph.caps = graph.caps.map((cap) => (cap.cycle === "code_review_round" ? rewrite(cap) : cap));
    const refusal = refusalOf(() => index(graph));
    assert.equal(refusal.reason, "cap_binding_incomplete", label);
    assert.match(refusal.detail, /code_review_round names no counted transition/u, label);
  }
});

test("a guard the cap binding reaches that another edge also references is refused at build", () => {
  // `guard_238` carries the artifact cap's below-limit term on t_231. Putting
  // it on t_443 — an edge out of a different step — would constrain that edge
  // by a cap that never named it; the cap that would count t_443 is removed so
  // the edge stands outside every binding.
  const graph = document();
  graph.caps = graph.caps.filter((cap) => !cap.counted_transitions.includes("t_443"));
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
  graph.caps = [...graph.caps, { cycle: "second_local", counted_transitions: ["t_232"], limit: 10, park_reason: "review_cap" }];
  const refusal = refusalOf(() => index(graph));
  assert.equal(refusal.reason, "cap_binding_ambiguous");
  assert.match(refusal.detail, /t_230/);
});

test("a cap counting a transition the document never declared is refused at build", () => {
  // The refusal is the factory's own `transition_not_declared` — the code an
  // undeclared edge already produces — because a counted transition that does
  // not exist is an edge the document does not declare; one undeclared among
  // declared ones is refused all the same.
  for (const counted of [["never_declared"], ["t_205", "never_declared"]]) {
    const graph = document();
    graph.caps = graph.caps.map((cap) => (cap.cycle === "artifact_review_round" ? { ...cap, counted_transitions: counted } : cap));
    const refusal = refusalOf(() => index(graph));
    assert.equal(refusal.reason, "transition_not_declared", counted.join(", "));
    assert.match(refusal.detail, /artifact_review_round counts never_declared/u);
  }
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

// --- debt 11e: a resume the graph declares the user's decision owes one, recorded under its park (R7-4; review M1, M2; ADR-099) ---

/**
 * The decision a park record carries for a resume its row declares the
 * user's: the watermark of the park it was recorded under — the reason and
 * the visit counts of its parks_at steps, as a completion receipt carries
 * them — and the digest of the daemon UserDecisionRecord that decided it.
 */
const decisionLeaf = (row, visits, record = "a".repeat(64)) => `${watermarkOf(row, visits)}#${record}`;

/**
 * The daemon's signer, as the user-decision and decision-queue tests stand
 * it in: the product has none, and with none every decision-gated resume is
 * refused (CodeRabbit on #270).
 */
const signer = testSigner();

/** The task every decided case below resumes, unless it says otherwise. */
const TASK = "t-decided";

/** The project it resumes in: the `project_root_sha256` its records and its admitter name (R8-15). */
const PROJECT = "0".repeat(64);

/**
 * A UserDecisionRecord the user signed to resume a park into `target`: about
 * this project, this task, this park — its reason and watermark — and this
 * target, and answering exactly that. The options let a case sign something
 * else: another project (the record's field or its subject's), another task,
 * another park or target in the subject, another answer, or another record id.
 */
const resumeRecord = (row, visits, target, {
  project = PROJECT,
  subjectProject = project,
  task = TASK,
  subjectTask = task,
  watermark = watermarkOf(row, visits),
  subjectTarget = target,
  answer = target,
  ...issued
} = {}) => signer.issue({
  request_id: `resume-${row.reason}`,
  project_root_sha256: project,
  anchor_version: 1,
  task_id: task,
  subject_hash: digest("autosk-flow/resume-decision/v1", { project_root_sha256: subjectProject, task_id: subjectTask, reason: row.reason, watermark, target: subjectTarget }),
  payload_hash: decisionPayloadHash({ resume_target: answer }),
  ...issued,
});

/** The leaf a park carries for `record`: this park's watermark and the record's digest. */
const leafFor = (row, visits, record) => `${watermarkOf(row, visits)}#${userDecisionRecordHash(record)}`;

/** A lookup of records by digest, as a project's store would answer it. */
const lookupOf = (records) => (hash) => records.find((entry) => userDecisionRecordHash(entry) === hash);

/**
 * What a caller hands operation 2: the task, and the admitter that checks the
 * record a leaf names — `resumeDecisionAdmitter`, for this project, over the
 * lookup and the test signer's verifier (CI on #270: injected, so the factory
 * imports none of it).
 */
const decidedBy = (records, { task = TASK, verifySignature = signer.verifySignature, project = PROJECT } = {}) => ({
  task,
  admitDecision: resumeDecisionAdmitter({ projectRootSha256: project, record: lookupOf(records), verifySignature }),
});

/** The factory's option that hands the veto the same admitter. */
const deciding = (records, verifySignature = signer.verifySignature) => ({
  admitDecision: resumeDecisionAdmitter({ projectRootSha256: PROJECT, record: lookupOf(records), verifySignature }),
});

test("a resume into a target its row declares the user's decision is refused without the decision recorded under its park, and admitted with it (R7-4; review M1, M2)", async () => {
  // Round 7 of #39, R7-4: 01 §8, 03 §7 and the graph's view require a new
  // daemon-attributed cap decision for a round past the review cap, and
  // operation 2 admitted it on the reason and the origin alone. Review of
  // 11e: the first fix gated every review_cap target, the exits that run no
  // round included (M1), and left foreign_target_movement's re-stage — which
  // its row says happens only on a recorded decision — ungated (M2). The
  // graph now declares, per row, which targets are the user's decision.
  const graph = document();
  const state = index(graph);
  const declared = Object.fromEntries(graph.recovery.filter((entry) => entry.decision_targets).map((entry) => [entry.reason, [...entry.decision_targets].sort()]));
  assert.deepEqual(declared, {
    completion_predicate_unmet: ["apply_staging"],
    foreign_target_movement: ["apply_staging"],
    review_cap: ["fix", "fix_artifact", "rebuild_code_anchor"],
    verification_cap: ["fix", "rebuild_code_anchor", "verify"],
  });
  const reason = "review_cap";
  const row = state.recovery.get(reason);
  const visits = { narrow_review_join: 11, record_code_verdict: 0 };
  const origin = { origin: "narrow_review_join" };

  const bare = refusalOf(() => permitsResume(state, reason, "fix_artifact", origin, visits));
  assert.equal(bare.reason, "resume_target_not_permitted");
  assert.match(bare.detail, /decision/u);
  // Admitted on a verified record of this resume (CodeRabbit on #270).
  const planned = resumeRecord(row, visits, "fix_artifact");
  assert.equal(permitsResume(state, reason, "fix_artifact", { ...origin, decision: leafFor(row, visits, planned) }, visits, decidedBy([planned])), true);
  // The Quick and Ticket cap: a new round owes the decision, and the exits
  // that run none — the hand-off out of the Quick classification, staying
  // parked — owe nothing.
  const code = { origin: "record_code_verdict" };
  const coded = { narrow_review_join: 0, record_code_verdict: 4 };
  for (const target of ["fix", "rebuild_code_anchor"]) {
    assert.equal(refusalOf(() => permitsResume(state, reason, target, code, coded)).reason, "resume_target_not_permitted", target);
    const record = resumeRecord(row, coded, target);
    assert.equal(permitsResume(state, reason, target, { ...code, decision: leafFor(row, coded, record) }, coded, decidedBy([record])), true, target);
  }
  for (const target of ["invalidate_quick_classification", "human"]) {
    assert.equal(permitsResume(state, reason, target, code, coded), true, target);
  }
  // A decision recorded under an earlier park of the reason is not new: the
  // NOT_PASS that parked it again re-entered narrow_review_join, so the
  // watermark moved with no write of ours needing to land.
  const earlier = decisionLeaf(row, { narrow_review_join: 10, record_code_verdict: 0 });
  assert.equal(refusalOf(() => permitsResume(state, reason, "fix_artifact", { ...origin, decision: earlier }, visits)).reason, "resume_target_not_permitted");
  // A leaf that names no decision record, or another reason's park, decides nothing.
  for (const malformed of [
    watermarkOf(row, visits),
    `${watermarkOf(row, visits)}#`,
    `${watermarkOf(row, visits)}#${"A".repeat(64)}`,
    `${watermarkOf(row, visits)}#${"a".repeat(63)}`,
    `${watermarkOf(row, visits)}#${"a".repeat(64)}0`,
    `${watermarkOf({ ...row, reason: "verification_cap" }, visits)}#${"a".repeat(64)}`,
    { watermark: watermarkOf(row, visits), record: "a".repeat(64) },
  ]) {
    assert.equal(
      refusalOf(() => permitsResume(state, reason, "fix_artifact", { ...origin, decision: malformed }, visits)).reason,
      "resume_target_not_permitted",
      JSON.stringify(malformed),
    );
  }
  // The decision widens nothing: a target the row or its scope refuses stays
  // refused, with a verified record of that very resume in hand.
  for (const target of ["fix", "invalidate_quick_classification", "done"]) {
    const record = resumeRecord(row, visits, target);
    assert.equal(refusalOf(() => permitsResume(state, reason, target, { ...origin, decision: leafFor(row, visits, record) }, visits, decidedBy([record]))).reason,
      "resume_target_not_permitted", target);
  }
  // A re-stage onto a moved target is the user's decision too (M2), and what
  // runs nothing — staying parked, re-reading the delivery — owes none.
  const staged = { integrate_staging: 3, deliver_staging: 2 };
  for (const [moved, parkedAt, other] of [["foreign_target_movement", "integrate_staging", "human"], ["completion_predicate_unmet", "deliver_staging", "deliver_staging"]]) {
    const movedRow = state.recovery.get(moved);
    assert.equal(refusalOf(() => permitsResume(state, moved, "apply_staging", { origin: parkedAt }, staged)).reason, "resume_target_not_permitted", moved);
    const record = resumeRecord(movedRow, staged, "apply_staging");
    assert.equal(permitsResume(state, moved, "apply_staging", { origin: parkedAt, decision: leafFor(movedRow, staged, record) }, staged, decidedBy([record])), true, moved);
    assert.equal(permitsResume(state, moved, other, { origin: parkedAt }, staged), true, `${moved} -> ${other}`);
  }
  // A row that declares no decision target owes no decision.
  assert.equal(permitsResume(state, "staging_moved_after_pass", "apply_staging"), true);

  // Through the veto the engine runs for every resume: the task is the one it
  // reads, and the lookup and verifier are the workflow's options.
  const workflow = buildWorkflow(graph, { evaluate: always, ...deciding([resumeRecord(row, visits, "fix_artifact", { task: "t-cap" })]) });
  const parked = (park) => ({ id: "t-cap", step: "human", status: "human", metadata: { step_visits: visits, park } });
  await assert.rejects(
    () => workflow.onTransit(context(parked({ reason, ...origin })).ctx, { step: "fix_artifact" }),
    (error) => error.reason === "resume_target_not_permitted" && /decision/u.test(error.detail),
  );
  const vetoed = { ...origin, decision: leafFor(row, visits, resumeRecord(row, visits, "fix_artifact", { task: "t-cap" })) };
  assert.equal(await workflow.onTransit(context(parked({ reason, ...vetoed })).ctx, { step: "fix_artifact" }), undefined);
  const quick = { id: "t-quick", step: "human", status: "human", metadata: { step_visits: coded, park: { reason, ...code } } };
  assert.equal(await workflow.onTransit(context(quick).ctx, { step: "invalidate_quick_classification" }), undefined);
});

test("a round past the cap leaves the count and the limit where they were, so the next NOT_PASS parks again and needs its own decision (R7-4)", async () => {
  // One round per recorded cap decision: the decision is not a count reset
  // and not a new limit. The resume is taken human -> fix_artifact, so the
  // counted pair stays at its limit, and a NOT_PASS at narrow_review_join
  // after the extra round parks review_cap at once.
  const graph = document();
  const row = graph.recovery.find((entry) => entry.reason === "review_cap");
  // The records the user signs as the rounds go, which the caller's lookup
  // reads (CodeRabbit on #270).
  const signed = [];
  const workflow = buildWorkflow(graph, { evaluate: (predicate) => ["cond_135", "cond_136"].includes(predicate), ...deciding(signed) });
  const task = {
    id: "t-round",
    step: "narrow_review_join",
    status: "work",
    metadata: {
      transition_takings: { narrow_review_join: { fix_artifact: 10 } },
      step_visits: { narrow_review_join: 11 },
    },
  };
  const first = context(task);
  await workflow.steps.narrow_review_join.onRun(first.ctx);
  assert.equal(task.status, "human");
  assert.equal(task.metadata.park.reason, "review_cap");
  assert.equal(task.metadata.park.origin, "narrow_review_join");

  // The user decides one more round: the decision is recorded under this park.
  const eleventh = resumeRecord(row, task.metadata.step_visits, "fix_artifact", { task: "t-round" });
  signed.push(eleventh);
  task.metadata.park.decision = leafFor(row, task.metadata.step_visits, eleventh);
  await workflow.onTransit(context(task).ctx, { step: "fix_artifact" });

  // The round runs and comes back to the join with another NOT_PASS: the
  // daemon's counter records the re-entry, and the durable count is what the
  // resume left it.
  task.step = "narrow_review_join";
  task.status = "work";
  task.metadata.step_visits.narrow_review_join += 1;
  const second = context(task);
  await workflow.steps.narrow_review_join.onRun(second.ctx);
  assert.equal(task.status, "human", "the eleventh round's NOT_PASS parks at once");
  assert.equal(task.metadata.park.reason, "review_cap");
  assert.deepEqual(task.metadata.transition_takings, { narrow_review_join: { fix_artifact: 10 } });
  for (const argv of [...first.calls.execs, ...second.calls.execs]) {
    assert.ok(!argv.some((part) => String(part).includes("transition_takings")), `the factory wrote the count: ${argv.join(" ")}`);
  }
  // The decision that bought the eleventh round does not buy a twelfth.
  await assert.rejects(
    () => workflow.onTransit(context(task).ctx, { step: "fix_artifact" }),
    (error) => error.reason === "resume_target_not_permitted",
  );
  const twelfth = resumeRecord(row, task.metadata.step_visits, "fix_artifact", { task: "t-round", record_id: "udr-0002" });
  signed.push(twelfth);
  task.metadata.park.decision = leafFor(row, task.metadata.step_visits, twelfth);
  assert.equal(await workflow.onTransit(context(task).ctx, { step: "fix_artifact" }), undefined);
});

// --- Round 8 of #39, R8-5: the repair cycle after the checks is a declared cap, and a round past it is the user's ---

test("the verification repair cycle is a declared cap: the eleventh repair parks verification_cap, and a resume into another repair round owes the user's decision (R8-5)", async () => {
  // Round 8 of #39, R8-5: `verification_cap` had no limit anywhere, no caps
  // entry and no decision targets — `cond_309` read the task record alone —
  // so the caller's evaluator decided when the cycle ended, and a resume
  // into `verify`, which starts another repair round, was admitted with no
  // decision: the defect R7-4 closed for review_cap (ADR-099), left open to
  // #32. The cycle is now the cap `verification_repair_round`: it counts
  // `verify -> fix` (t_416) against the document's limit, and the rule the
  // factory applies to every cap's park applies to this one.
  const graph = document();
  const cap = graph.caps.find((entry) => entry.park_reason === "verification_cap");
  assert.deepEqual(cap, { cycle: "verification_repair_round", counted_transitions: ["t_416"], limit: 10, park_reason: "verification_cap" });

  // A caller answering "a defect, below the cap" at every count still loses
  // the repair at the limit: the count is the durable takings, not its word.
  const eager = buildWorkflow(graph, { evaluate: (predicate) => predicate === "cond_308" });
  const repairing = { id: "t-v", step: "verify", status: "work", metadata: { transition_takings: { verify: { fix: 10 } } } };
  await eager.steps.verify.onRun(context(repairing).ctx);
  assert.notEqual(repairing.step, "fix", "no eleventh repair on the caller's word");
  assert.equal(repairing.status, "human");

  // Resumes out of the park: a target that runs another repair round —
  // `fix`, which repairs and runs verify (review of 12c, M2), `verify`, or
  // `rebuild_code_anchor`, which runs verify again — owes the decision
  // recorded under this park; staying parked and handing a Quick task to
  // Planned run none and owe none.
  const state = index(graph);
  const reason = "verification_cap";
  const row = state.recovery.get(reason);
  assert.deepEqual(row.parks_at, ["verify"]);
  assert.deepEqual(row.handled_at, ["fix"]);
  const visits = { verify: 11 };
  for (const target of ["fix", "verify", "rebuild_code_anchor"]) {
    const bare = refusalOf(() => permitsResume(state, reason, target, {}, visits));
    assert.equal(bare.reason, "resume_target_not_permitted", target);
    assert.match(bare.detail, /decision/u, target);
    const record = resumeRecord(row, visits, target);
    assert.equal(permitsResume(state, reason, target, { decision: leafFor(row, visits, record) }, visits, decidedBy([record])), true, target);
  }
  for (const target of ["human", "invalidate_quick_classification"]) {
    assert.equal(permitsResume(state, reason, target, {}, visits), true, target);
  }
  // A decision recorded under an earlier park of the reason buys nothing:
  // the next park re-entered verify and moved the watermark.
  const earlier = resumeRecord(row, { verify: 10 }, "verify");
  assert.equal(refusalOf(() => permitsResume(state, reason, "verify", { decision: leafFor(row, { verify: 10 }, earlier) }, visits, decidedBy([earlier]))).reason,
    "resume_target_not_permitted");
  // And the round a decision buys is one: the count stays at the limit, so
  // the next defect verify finds parks the cap again at once.
  const repaired = buildWorkflow(graph, { evaluate: (predicate) => ["cond_308", "cond_309"].includes(predicate), ...deciding([resumeRecord(row, visits, "verify", { task: "t-round" })]) });
  const task = { id: "t-round", step: "human", status: "human", metadata: { step_visits: { ...visits }, transition_takings: { verify: { fix: 10 } }, park: { reason, origin: "verify" } } };
  await assert.rejects(
    () => repaired.onTransit(context(task).ctx, { step: "verify" }),
    (error) => error.reason === "resume_target_not_permitted" && /decision/u.test(error.detail),
  );
  task.metadata.park.decision = leafFor(row, visits, resumeRecord(row, visits, "verify", { task: "t-round" }));
  assert.equal(await repaired.onTransit(context(task).ctx, { step: "verify" }), undefined);
  task.step = "verify";
  task.status = "work";
  task.metadata.step_visits.verify += 1;
  await repaired.steps.verify.onRun(context(task).ctx);
  assert.equal(task.status, "human");
  assert.equal(task.metadata.park.reason, "verification_cap", "the defect found after the bought round parks the cap again");
  assert.deepEqual(task.metadata.transition_takings, { verify: { fix: 10 } });
  await assert.rejects(
    () => repaired.onTransit(context(task).ctx, { step: "verify" }),
    (error) => error.reason === "resume_target_not_permitted",
  );
});

// --- Review of 12c, M2: a decision past the repair cap buys a repair round ---

test("a decision past verification_cap buys one repair round: a resume into fix repairs and runs the checks, and their next defect parks verification_cap again (review of 12c, M2)", async () => {
  // Review of 12c, M2: after the repair cap a recorded decision could resume
  // only into `verify` or `rebuild_code_anchor`, which run the checks again
  // on an unchanged candidate and re-park at once, while 01, 03, the graph's
  // row and #32's obligation said it buys another repair round. The only
  // edges into `fix` are `t_416`, which the cap refuses at the limit, and
  // `t_443`, so no repair could run. Base 03 §7 named `fix, verify` for this
  // row; `fix` is a resume target again, and — since it leads to `verify` —
  // one the user decides.
  const graph = document();
  const state = index(graph);
  const reason = "verification_cap";
  const row = state.recovery.get(reason);
  assert.ok(row.resume_targets.includes("fix"));
  assert.deepEqual([...row.decision_targets].sort(), ["fix", "rebuild_code_anchor", "verify"]);
  const visits = { verify: 11 };
  const parked = { origin: "verify" };
  assert.equal(refusalOf(() => permitsResume(state, reason, "fix", parked, visits)).reason, "resume_target_not_permitted");

  const record = resumeRecord(row, visits, "fix", { task: "t-repair" });
  const workflow = buildWorkflow(graph, {
    evaluate: (predicate) => ["cond_308", "cond_309", "cond_340"].includes(predicate),
    ...deciding([record]),
  });
  const task = {
    id: "t-repair",
    step: "human",
    status: "human",
    metadata: {
      step_visits: { ...visits },
      transition_takings: { verify: { fix: 10 } },
      park: { reason, ...parked, decision: leafFor(row, visits, record) },
    },
  };
  assert.equal(await workflow.onTransit(context(task).ctx, { step: "fix" }), undefined);
  // The engine takes the resume `human -> fix`, so the counted pair stays at
  // its limit; the repair runs, and `fix -> verify` runs the checks.
  task.step = "fix";
  task.status = "work";
  task.metadata.step_visits.fix = 1;
  await workflow.steps.fix.onRun(context(task).ctx);
  assert.equal(task.step, "verify", "the bought round repairs and runs the checks");
  await workflow.steps.verify.onRun(context(task).ctx);
  assert.equal(task.status, "human", "the checks' next defect parks at once");
  assert.equal(task.metadata.park.reason, "verification_cap");
  assert.deepEqual(task.metadata.transition_takings, { verify: { fix: 10 } });
  // The decision that bought the round buys no second: the park re-entered
  // `verify`, so its watermark moved.
  await assert.rejects(
    () => workflow.onTransit(context(task).ctx, { step: "fix" }),
    (error) => error.reason === "resume_target_not_permitted",
  );
});

// --- CodeRabbit on #270: a decision-gated resume is admitted only on a verified UserDecisionRecord of this task, this park and this target ---

test("a decision-gated resume is admitted only on a verified UserDecisionRecord that decided this task's resume from this park into this target (CodeRabbit on #270)", async () => {
  // CodeRabbit on PR #270 (CWE-345): operation 2 checked the leaf's shape and
  // watermark and nothing else, so a leaf copied from another task parked
  // with the same watermark opened this one. The leaf now names a record the
  // caller looks up by digest, and the record must verify under the caller's
  // verifier, name this task, and have decided this park's resume into this
  // target. With no signer — every real host today — nothing is admitted.
  const graph = document();
  const state = index(graph);
  const reason = "review_cap";
  const row = state.recovery.get(reason);
  const visits = { narrow_review_join: 11, record_code_verdict: 0 };
  const origin = { origin: "narrow_review_join" };
  const record = resumeRecord(row, visits, "fix_artifact");
  const park = { ...origin, decision: leafFor(row, visits, record) };
  const refused = (label, parked, decisions, target = "fix_artifact", at = visits) => {
    const error = refusalOf(() => permitsResume(state, reason, target, parked, at, decisions));
    assert.equal(error.reason, "resume_target_not_permitted", label);
    assert.match(error.detail, /UserDecisionRecord/u, label);
  };
  // Signed for this task, this park and this target, and verified: admitted.
  assert.equal(permitsResume(state, reason, "fix_artifact", park, visits, decidedBy([record])), true);
  // Nothing handed in, or the default verifier: no signer, so no decision
  // (ADR-090, #4) — a well-formed leaf decides nothing on its own.
  refused("nothing handed in", park, undefined);
  refused("the default verifier", park, { task: TASK, admitDecision: resumeDecisionAdmitter({ projectRootSha256: PROJECT, record: lookupOf([record]) }) });
  // A well-formed leaf whose digest no record answers to.
  refused("a digest with no record", { ...origin, decision: decisionLeaf(row, visits) }, decidedBy([record]));
  // The lookup hands back another record than the one the leaf names.
  const another = resumeRecord(row, visits, "fix_artifact", { record_id: "udr-0002" });
  refused("another record than the leaf names", park,
    { task: TASK, admitDecision: resumeDecisionAdmitter({ projectRootSha256: PROJECT, record: () => another, verifySignature: signer.verifySignature }) });
  // Another task's record, its leaf copied onto this park.
  const theirs = resumeRecord(row, visits, "fix_artifact", { task: "t-other" });
  refused("another task's record", { ...origin, decision: leafFor(row, visits, theirs) }, decidedBy([theirs]));
  // A record that names another task over this task's subject.
  const misnamed = resumeRecord(row, visits, "fix_artifact", { task: "t-other", subjectTask: TASK });
  refused("a record naming another task", { ...origin, decision: leafFor(row, visits, misnamed) }, decidedBy([misnamed]));
  // A record of an earlier park of the reason, its leaf rewritten to this park's watermark.
  const earlier = resumeRecord(row, visits, "fix_artifact", { watermark: watermarkOf(row, { narrow_review_join: 10, record_code_verdict: 0 }) });
  refused("another park's record", { ...origin, decision: leafFor(row, visits, earlier) }, decidedBy([earlier]));
  // The Quick cap: a record of the resume into rebuild_code_anchor does not
  // decide fix, and a record of this subject that answered something else —
  // staying parked — decides nothing.
  const code = { origin: "record_code_verdict" };
  const coded = { narrow_review_join: 0, record_code_verdict: 4 };
  const rebuild = resumeRecord(row, coded, "rebuild_code_anchor");
  refused("another target's record", { ...code, decision: leafFor(row, coded, rebuild) }, decidedBy([rebuild]), "fix", coded);
  assert.equal(permitsResume(state, reason, "rebuild_code_anchor", { ...code, decision: leafFor(row, coded, rebuild) }, coded, decidedBy([rebuild])), true);
  const stay = resumeRecord(row, coded, "fix", { answer: "human" });
  refused("this subject, another answer", { ...code, decision: leafFor(row, coded, stay) }, decidedBy([stay]), "fix", coded);

  // Through the veto: the task is the one the veto reads, and the admitter is
  // the workflow's option, as the evaluator is.
  const parked = (id) => ({ id, step: "human", status: "human", metadata: { step_visits: visits, park: { reason, ...park } } });
  const workflow = buildWorkflow(graph, { evaluate: always, ...deciding([record]) });
  assert.equal(await workflow.onTransit(context(parked(TASK)).ctx, { step: "fix_artifact" }), undefined);
  await assert.rejects(
    () => workflow.onTransit(context(parked("t-other")).ctx, { step: "fix_artifact" }),
    (error) => error.reason === "resume_target_not_permitted",
  );
  for (const options of [{}, { admitDecision: resumeDecisionAdmitter({ projectRootSha256: PROJECT, record: lookupOf([record]) }) }]) {
    const unsigned = buildWorkflow(graph, { evaluate: always, ...options });
    await assert.rejects(
      () => unsigned.onTransit(context(parked(TASK)).ctx, { step: "fix_artifact" }),
      (error) => error.reason === "resume_target_not_permitted",
      JSON.stringify(Object.keys(options)),
    );
  }
});

// --- Round 8 of #39, R8-15: a decision-gated resume is admitted only on a record of this project ---

test("a decision-gated resume on a record of another project is refused, whatever else it matches, directly and through the veto (R8-15)", async () => {
  // R8-15: the subject bound the task, the park and the target and not the
  // project, and the admitter never compared the record's project with the
  // resuming one, so a record decided in another project for a task of the
  // same id resumed this one wherever the caller's lookup found it. The
  // admitter is now one project's, the subject binds the project, and the
  // factory, which imports none of it, is unchanged: it asks the same question.
  const graph = document();
  const state = index(graph);
  const reason = "review_cap";
  const row = state.recovery.get(reason);
  const visits = { narrow_review_join: 11, record_code_verdict: 0 };
  const origin = { origin: "narrow_review_join" };
  const leafOf = (record) => ({ ...origin, decision: leafFor(row, visits, record) });
  const ours = resumeRecord(row, visits, "fix_artifact");
  assert.equal(permitsResume(state, reason, "fix_artifact", leafOf(ours), visits, decidedBy([ours])), true);
  const elsewhere = "b".repeat(64);
  for (const [label, record] of [
    ["decided in another project", resumeRecord(row, visits, "fix_artifact", { project: elsewhere, record_id: "udr-0101" })],
    ["another project's record over this project's subject", resumeRecord(row, visits, "fix_artifact", { project: elsewhere, subjectProject: PROJECT, record_id: "udr-0102" })],
    ["this project's record over another project's subject", resumeRecord(row, visits, "fix_artifact", { subjectProject: elsewhere, record_id: "udr-0103" })],
  ]) {
    const error = refusalOf(() => permitsResume(state, reason, "fix_artifact", leafOf(record), visits, decidedBy([record])));
    assert.equal(error.reason, "resume_target_not_permitted", label);
    assert.match(error.detail, /another project/u, label);
  }
  // Another project's admitter does not admit this project's record.
  const theirs = refusalOf(() => permitsResume(state, reason, "fix_artifact", leafOf(ours), visits, decidedBy([ours], { project: elsewhere })));
  assert.equal(theirs.reason, "resume_target_not_permitted");
  // Through the veto: the workflow's admitter is this project's, and a task
  // of the same id whose leaf names another project's record stays parked.
  const foreign = resumeRecord(row, visits, "fix_artifact", { project: elsewhere, record_id: "udr-0104" });
  const parked = (record) => ({ id: TASK, step: "human", status: "human", metadata: { step_visits: visits, park: { reason, ...leafOf(record) } } });
  const workflow = buildWorkflow(graph, { evaluate: always, ...deciding([ours, foreign]) });
  assert.equal(await workflow.onTransit(context(parked(ours)).ctx, { step: "fix_artifact" }), undefined);
  await assert.rejects(
    () => workflow.onTransit(context(parked(foreign)).ctx, { step: "fix_artifact" }),
    (error) => error.reason === "resume_target_not_permitted" && /another project/u.test(error.detail),
  );
});

// --- CI on #270: the factory asks an injected admitter, and admits only its plain yes ---

test("a decision-gated resume asks the injected admitter about exactly this leaf, task, park and target, and only its plain yes admits it (CI on #270)", async () => {
  // CI on #270: the first CodeRabbit fix imported the record's verification
  // into the factory, and the extension the autosk verifiers build could not
  // load it. The check is the caller's now: the factory reads the leaf's
  // shape and watermark, then asks the admitter it is handed, and anything
  // but a returned `true` — a refusal thrown, false, nothing — refuses.
  const graph = document();
  const state = index(graph);
  const reason = "review_cap";
  const row = state.recovery.get(reason);
  const visits = { narrow_review_join: 11, record_code_verdict: 0 };
  const hash = "c".repeat(64);
  const park = { origin: "narrow_review_join", decision: `${watermarkOf(row, visits)}#${hash}` };
  const asked = [];
  const answering = (answer) => (query) => { asked.push(query); return answer; };
  assert.equal(permitsResume(state, reason, "fix_artifact", park, visits, { task: TASK, admitDecision: answering(true) }), true);
  assert.deepEqual(asked, [{ digest: hash, task: TASK, reason, watermark: watermarkOf(row, visits), target: "fix_artifact" }]);
  for (const answer of [false, undefined, "yes", 1]) {
    const error = refusalOf(() => permitsResume(state, reason, "fix_artifact", park, visits, { task: TASK, admitDecision: answering(answer) }));
    assert.equal(error.reason, "resume_target_not_permitted", String(answer));
  }
  const thrown = refusalOf(() => permitsResume(state, reason, "fix_artifact", park, visits, {
    task: TASK,
    admitDecision: () => { throw new Error("the record decided another resume"); },
  }));
  assert.equal(thrown.reason, "resume_target_not_permitted");
  assert.match(thrown.detail, /the record decided another resume/u);
  // A leaf of another park is refused before the admitter is asked.
  asked.length = 0;
  refusalOf(() => permitsResume(state, reason, "fix_artifact", { ...park, decision: `${watermarkOf(row, { narrow_review_join: 10 })}#${hash}` }, visits,
    { task: TASK, admitDecision: answering(true) }));
  assert.deepEqual(asked, []);
  // Through the veto, the task asked about is the one the veto reads.
  const workflow = buildWorkflow(graph, { evaluate: always, admitDecision: answering(true) });
  await workflow.onTransit(context({ id: "t-veto", step: "human", status: "human", metadata: { step_visits: visits, park: { reason, ...park } } }).ctx, { step: "fix_artifact" });
  assert.equal(asked.at(-1).task, "t-veto");
});

// --- CI on #270: the extension the autosk verifiers build loads ---

/**
 * The relative modules a source file imports statically: `import … from` and
 * `export … from` at the start of a line, and bare `import "…"`.
 */
const relativeImports = (source) =>
  [...source.matchAll(/^\s*(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/gmu)].map((match) => match[1]);

test("every module the factory imports, and every module those import, is one the autosk verifiers ship into the extension (CI on #270)", () => {
  // The autosk verify scripts build a test extension by copying the factory
  // and the files beside it into `.autosk/extensions/<name>/`. The first
  // CodeRabbit fix made the factory import ./user-decision.mjs, which imports
  // ../runtime/contracts.mjs; no verifier shipped either, the extension did
  // not load, and the daemon answered "unknown workflow" — caught only by the
  // autosk job. This reads both lists, so the drift fails here first.
  const host = path.join(ROOT, "src/host");
  const needed = new Set();
  const queue = ["workflow-factory.mjs"];
  while (queue.length > 0) {
    const name = queue.shift();
    for (const specifier of relativeImports(readFileSync(path.join(host, name), "utf8"))) {
      // A copy lands flat in the extension directory, so only a sibling can resolve there.
      assert.match(specifier, /^\.\/[^/]+$/u, `${name} imports ${specifier}, which no flat extension copy can resolve`);
      const imported = specifier.slice(2);
      if (needed.has(imported)) continue;
      needed.add(imported);
      queue.push(imported);
    }
  }
  assert.ok(needed.has("workflow-graph-canonical.mjs"), "the factory imports the canonical form");
  // What a verifier ships is what it reads out of src/host to write beside the
  // factory — by `copyFile`, or by `readFile` and `writeFile` — and each names
  // those files as `path.join(ROOT, "src/host/…")` and nothing else of src/host.
  const shipping = /path\.join\(ROOT,\s*"src\/host\/([^"]+)"\)/gu;
  const verifiers = readdirSync(path.join(ROOT, "scripts"))
    .filter((name) => /^verify-autosk-.*\.mjs$/u.test(name))
    .map((name) => [name, readFileSync(path.join(ROOT, "scripts", name), "utf8")])
    .filter(([, text]) => text.includes('path.join(ROOT, "src/host/workflow-factory.mjs")'));
  assert.ok(verifiers.length >= 4, `the verifiers that ship the factory: ${verifiers.map(([name]) => name).join(", ")}`);
  for (const [name, text] of verifiers) {
    const shipped = new Set([...text.matchAll(shipping)].map((match) => match[1]));
    assert.ok(shipped.has("workflow-factory.mjs"), name);
    for (const imported of needed) {
      assert.ok(shipped.has(imported), `${name} does not ship ${imported}, which the factory needs to load`);
    }
  }
});
