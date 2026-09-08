/**
 * Tests for requirement revision as a front end to the crash-safe rebuild (#25).
 *
 * The machinery already knows how to rebuild. What it cannot know is whether a
 * change was entitled to reach code before it reached the product layer, so
 * every case here is about the order, the classification, or a decision that
 * has to be somebody's rather than the model's.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLASSES,
  DISPOSITIONS,
  MATERIAL,
  STAGES,
  classificationErrors,
  closedEpicErrors,
  dispositionErrors,
  invalidationTarget,
  isMaterial,
  panelErrors,
  rebindErrors,
  rebuildRequest,
  roundAdmission,
  stageAdmission,
  supersessionErrors,
  sweepReport,
} from "../src/host/requirement-revision.mjs";

const code = (name) => (error) => error.code === name;

const revision = (overrides = {}) => ({
  round_id: "rev-1",
  kind: "product_behavior",
  classification_rationale: "the user changed what cancel does to partial work",
  stage: "hand_to_rebuild",
  touches: [{ layer: "product", path: "01-core-flows.md" }],
  panels: {
    product: { verdict: "pass" },
    technical: { verdict: "pass" },
    tickets: { verdict: "pass" },
  },
  ...overrides,
});

test("a clarification that edits the product layer is refused, not reviewed leniently", () => {
  // Calling a product change a clarification removes every panel from it in one
  // word, which is why the edit itself is the evidence.
  const errors = classificationErrors(revision({
    kind: "evidence_clarification",
    touches: [{ layer: "product", path: "01-core-flows.md" }],
  }));
  assert.ok(errors.some((error) => error.reason === "revision_class_mismatch"));
  assert.deepEqual(
    classificationErrors(revision({
      kind: "evidence_clarification",
      touches: [{ layer: "evidence", path: "evidence/T-1/notes.md" }],
    })),
    [],
  );
  assert.deepEqual([...MATERIAL], CLASSES.slice(0, 3));
  assert.equal(isMaterial("non_material_correction"), false);
  assert.throws(() => isMaterial("whatever"), code("revision_class_mismatch"));
});

test("a classification with no rationale is not a classification", () => {
  assert.ok(
    classificationErrors(revision({ classification_rationale: "because" }))
      .some((error) => /no rationale/u.test(error.detail)),
  );
});

test("no Ticket or code side effect precedes the approved impact plan", () => {
  assert.deepEqual([...STAGES].length, 12);
  for (const stage of STAGES.slice(0, 11)) {
    for (const sideEffect of ["ticket", "code"]) {
      const admission = stageAdmission({ stage, sideEffect });
      assert.equal(admission.decision, "refuse", `${stage}/${sideEffect}`);
      assert.equal(admission.reason, "revision_out_of_order");
      // The refusal names the stage that was running.
      assert.equal(admission.stage, stage);
    }
  }
  assert.equal(stageAdmission({ stage: "hand_to_rebuild", sideEffect: "ticket" }).decision, "allow");
  assert.throws(() => stageAdmission({ stage: "whenever", sideEffect: "code" }), code("revision_out_of_order"));
});

test("the manifest is regenerated last, and early is its own refusal", () => {
  // A manifest regenerated before the technical layer settled does not look
  // stale, it looks current.
  for (const stage of STAGES.slice(0, 6)) {
    const admission = stageAdmission({ stage, sideEffect: "regenerate_manifest" });
    assert.equal(admission.reason, "revision_manifest_early", stage);
  }
  assert.equal(stageAdmission({ stage: "regenerate_manifest", sideEffect: "regenerate_manifest" }).decision, "allow");
});

test("a material revision runs all three panels", () => {
  assert.deepEqual(panelErrors(revision()), []);
  for (const panel of ["product", "technical", "tickets"]) {
    const without = revision();
    delete without.panels[panel];
    assert.ok(panelErrors(without).some((error) => error.reason === "revision_panel_missing"), panel);
    const failed = revision({ panels: { ...revision().panels, [panel]: { verdict: "findings" } } });
    assert.ok(panelErrors(failed).some((error) => /findings/u.test(error.detail)), panel);
  }
  // A non-material correction has no panels to miss — and the fixture carries
  // none, or this would pass without the rule being read at all.
  const correction = revision({ kind: "non_material_correction", touches: [] });
  delete correction.panels;
  assert.deepEqual(panelErrors(correction), []);
});

test("implemented work needs a decision, and defer is not the exception", () => {
  const map = {
    tickets: [
      { ticket_id: "T-1", status: "staged", disposition: "correction_ticket", decision_ref: "dec-3" },
      { ticket_id: "T-2", status: "integrated", disposition: "intentional_defer", decision_ref: "dec-4" },
    ],
  };
  assert.deepEqual(dispositionErrors(map), []);
  // The one most likely to be recorded as an observation rather than a choice.
  const undecided = { tickets: [{ ticket_id: "T-2", status: "integrated", disposition: "intentional_defer" }] };
  assert.ok(dispositionErrors(undecided).some((error) => error.reason === "revision_decision_missing"));
  const unknown = { tickets: [{ ticket_id: "T-3", status: "staged", disposition: "just_leave_it", decision_ref: "d" }] };
  assert.ok(dispositionErrors(unknown).some((error) => error.reason === "revision_decision_missing"));
  assert.deepEqual([...DISPOSITIONS].length, 4);
});

test("a running Ticket is paused before its entry is superseded", () => {
  // Otherwise a model keeps working from a plan that no longer exists, and its
  // output is reviewed against acceptance criteria it never saw.
  const running = { tickets: [{ ticket_id: "T-9", status: "work" }] };
  assert.ok(dispositionErrors(running).some((error) => error.reason === "revision_out_of_order"));
  assert.deepEqual(dispositionErrors({ tickets: [{ ticket_id: "T-9", status: "work", paused: true }] }), []);
});

test("two rounds claiming one predecessor are a fork, not a merge", () => {
  const rounds = [
    { round_id: "rev-1", original_instruction: "make cancel discard" },
    { round_id: "rev-2", supersedes: "rev-1" },
    { round_id: "rev-3", supersedes: "rev-1" },
  ];
  const errors = supersessionErrors(rounds);
  assert.ok(errors.some((error) => error.reason === "revision_supersession_forked"));
  assert.deepEqual(supersessionErrors(rounds.slice(0, 2)), []);
});

test("a round may not rewrite the instruction it supersedes", () => {
  const rounds = [
    { round_id: "rev-1", original_instruction: "make cancel discard" },
    {
      round_id: "rev-2",
      supersedes: "rev-1",
      original_instruction_of: { "rev-1": "make cancel keep partial work" },
    },
  ];
  assert.ok(supersessionErrors(rounds).some((error) => error.reason === "revision_instruction_rewritten"));
});

test("a closed or released Epic is change work, not a rewrite", () => {
  assert.deepEqual(closedEpicErrors({ epic_id: "e-1", state: "open" }), []);
  for (const state of ["closed", "released"]) {
    assert.ok(closedEpicErrors({ epic_id: "e-1", state }).some((error) => error.reason === "revision_closed_epic"));
  }
});

test("an unaffected rebind is proven by digests, its own and its dependencies'", () => {
  const artifact = { id: "tech_plan", depends_on: ["core_flow"] };
  const unchanged = { before: { tech_plan: "a", core_flow: "b" }, after: { tech_plan: "a", core_flow: "b" } };
  assert.deepEqual(rebindErrors(artifact, unchanged), []);
  // "It looks unrelated" is a description of a reading, not evidence about a
  // dependency graph.
  const dependencyMoved = { before: { tech_plan: "a", core_flow: "b" }, after: { tech_plan: "a", core_flow: "c" } };
  assert.ok(rebindErrors(artifact, dependencyMoved).some((error) => /core_flow changed/u.test(error.detail)));
  const selfMoved = { before: { tech_plan: "a", core_flow: "b" }, after: { tech_plan: "z", core_flow: "b" } };
  assert.ok(rebindErrors(artifact, selfMoved).some((error) => /its own content changed/u.test(error.detail)));
});

test("the sweep reports what it searched, so an empty result is not a clean one", () => {
  const clean = sweepReport({
    surviving: ["T-1"],
    references: { "T-1": ["ac-1", "adr-4"] },
    resolvable: ["ac-1", "adr-4"],
  });
  assert.equal(clean.clean, true);
  assert.equal(clean.searched_count, 2);
  const stale = sweepReport({
    surviving: ["T-1"],
    references: { "T-1": ["ac-1", "adr-9"] },
    resolvable: ["ac-1"],
  });
  assert.ok(stale.stale.some((error) => error.reason === "revision_stale_reference"));
  // A sweep that resolved nothing is not clean; it is a sweep that found
  // nothing to look at.
  const empty = sweepReport({ surviving: [], references: {}, resolvable: [] });
  assert.equal(empty.clean, false);
  assert.equal(empty.searched_count, 0);
});

test("a retried round is a replay, and the anchor is bumped once", () => {
  assert.deepEqual({ ...roundAdmission({ roundId: "rev-1", recorded: [] }) }, {
    decision: "start",
    round_id: "rev-1",
    anchor_bump: true,
  });
  const replay = roundAdmission({ roundId: "rev-1", recorded: [{ round_id: "rev-1", stage: "product_panel" }] });
  assert.equal(replay.decision, "replay");
  assert.equal(replay.anchor_bump, false);
  assert.equal(replay.resume_stage, "product_panel");
});

test("the invalidation target is computed once, from the earliest affected kind", () => {
  assert.equal(invalidationTarget(["brief", "tickets"]), "clarify_alignment");
  assert.equal(invalidationTarget(["tech_plan"]), "clarify_alignment");
  assert.equal(invalidationTarget(["tickets"]), "present_tickets_breakdown");
  assert.throws(() => invalidationTarget([]), code("revision_out_of_order"));
});

test("the hand-off names the operations that already know how", () => {
  const request = rebuildRequest(revision(), {
    affectedKinds: ["core_flow", "tickets"],
    dispositions: [{ ticket_id: "T-1", status: "staged", disposition: "correction_ticket", decision_ref: "dec-3" }],
  });
  assert.equal(request.anchor_rebuild_op.source, "planning");
  assert.equal(request.anchor_rebuild_op.recorded_target_step, "clarify_alignment");
  assert.equal(request.ticket_repair_op.source, "planning");
  assert.deepEqual({ ...request.anchor_rebuild_op.dispositions[0] }, {
    ticket_id: "T-1",
    status: "staged",
    disposition: "correction_ticket",
    decision_ref: "dec-3",
  });
  // Code-only when no planning kind was affected, and no repair when the
  // Ticket set was not.
  const codeOnly = rebuildRequest(revision(), { affectedKinds: ["tickets"] });
  assert.equal(codeOnly.anchor_rebuild_op.source, "code_only");
  assert.equal(codeOnly.anchor_rebuild_op.recorded_target_step, "present_tickets_breakdown");
  assert.notEqual(codeOnly.ticket_repair_op, null);
});

test("the hand-off happens at the last stage, and not on an unready revision", () => {
  assert.throws(
    () => rebuildRequest(revision({ stage: "product_panel" }), { affectedKinds: ["tickets"] }),
    code("revision_out_of_order"),
  );
  const noPanel = revision();
  delete noPanel.panels.technical;
  assert.throws(() => rebuildRequest(noPanel, { affectedKinds: ["tickets"] }), code("revision_panel_missing"));
  assert.throws(
    () => rebuildRequest(revision(), {
      affectedKinds: ["tickets"],
      dispositions: [{ ticket_id: "T-1", status: "integrated", disposition: "intentional_defer" }],
    }),
    code("revision_decision_missing"),
  );
});
