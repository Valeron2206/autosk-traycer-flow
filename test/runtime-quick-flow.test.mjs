/**
 * Tests for Quick classification and promotion to Planned.
 *
 * Quick is a claim that the work needs no framing. It is cheap to make at
 * intake and expensive to be wrong about later, so what is tested here is what
 * happens when it stops being true halfway through — which is the only
 * interesting case.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  PLANNED_TRIGGERS,
  RECHECK_POINTS,
  assertNoQuickSideEffect,
  classifyIntake,
  expandScope,
  promote,
  recheck,
  worktreeHandover,
} from "../src/host/quick-flow.mjs";

const code = (name) => (error) => error.code === name;
const NOW = "2026-09-09T10:00:00Z";

const quickIntake = {
  outcome_unambiguous: true,
  new_behavior: false,
  needs_planning_artifacts: false,
  surfaces: { api_contract: false, data_schema: false, security: false, concurrency: false, migration: false },
};

const quickTask = {
  task_id: "ask-a1b2c3",
  project_identity: `sha256:${"0".repeat(58)}`,
  base_oid: "a".repeat(40),
  // Where the Quick work actually reached. The replacement must not start here.
  head_oid: "9".repeat(40),
  outcome: null,
};

const clean = { new_material_questions: [], planned_triggers: [] };

test("Quick needs all four conditions, and names the one that failed", () => {
  assert.deepEqual({ ...classifyIntake(quickIntake) }, { classification: "quick", triggers: [] });
  for (const [field, value, expected] of [
    ["outcome_unambiguous", false, "unclear_boundary"],
    ["new_behavior", true, "new_behavior"],
    ["needs_planning_artifacts", true, "new_behavior"],
  ]) {
    const result = classifyIntake({ ...quickIntake, [field]: value });
    assert.equal(result.classification, "planned", field);
    assert.ok(result.triggers.includes(expected), field);
  }
  for (const surface of ["api_contract", "data_schema", "security", "concurrency", "migration"]) {
    const result = classifyIntake({ ...quickIntake, surfaces: { ...quickIntake.surfaces, [surface]: true } });
    assert.deepEqual([...result.triggers], [surface]);
  }
});

test("the classification is re-checked at every transition, not settled at intake", () => {
  assert.deepEqual([...RECHECK_POINTS], [
    "implementation",
    "verification",
    "fix",
    "freeze",
    "review_result",
    "accept",
    "integrate_prologue",
  ]);
  for (const point of RECHECK_POINTS) {
    assert.equal(recheck({ point, classification: "quick", record: clean }).decision, "proceed", point);
  }
  assert.throws(() => recheck({ point: "cleanup", classification: "quick", record: clean }), code("quick_classification_invalid"));
});

test("a Planned task is not held to the Quick record's fields", () => {
  // These lists exist because a Quick claim has to be re-earned. Planned work
  // never made the claim.
  assert.deepEqual(
    { ...recheck({ point: "freeze", classification: "planned", record: {} }) },
    { decision: "proceed", classification: "planned" },
  );
});

test("a record that lists nothing has not been asked", () => {
  // "Nothing came up" and "nobody looked" are indistinguishable in an empty
  // field, so the record states both lists even when they are empty.
  assert.throws(
    () => recheck({ point: "freeze", classification: "quick", record: { planned_triggers: [] } }),
    code("quick_evidence_incomplete"),
  );
  assert.throws(
    () => recheck({ point: "freeze", classification: "quick", record: { new_material_questions: [] } }),
    code("quick_evidence_incomplete"),
  );
  assert.throws(
    () => recheck({ point: "freeze", classification: "quick", record: { ...clean, planned_triggers: ["vibes"] } }),
    code("quick_classification_invalid"),
  );
});

test("a material question found mid-flight is an unclear boundary", () => {
  const result = recheck({
    point: "verification",
    classification: "quick",
    record: { new_material_questions: ["does cancel discard partial work?"], planned_triggers: [] },
  });
  assert.equal(result.decision, "invalidate");
  assert.deepEqual([...result.triggers], ["unclear_boundary"]);
  assert.equal(result.point, "verification");
});

test("a Planned trigger found in the integrate prologue stops it before the first Git side effect", () => {
  const result = recheck({
    point: "integrate_prologue",
    classification: "quick",
    record: { new_material_questions: [], planned_triggers: ["data_schema"] },
  });
  assert.equal(result.decision, "invalidate");
  assert.deepEqual([...result.triggers], ["data_schema"]);
  assert.ok(PLANNED_TRIGGERS.includes("material_scope_growth"));
});

test("scope may widen while the work stays Quick, and not past that", () => {
  const expanded = expandScope({
    current: { pathspec: ["src/a"] },
    requested: { pathspec: ["src/b"], intake: {} },
    intake: quickIntake,
  });
  assert.equal(expanded.decision, "expand");
  assert.equal(expanded.reason, "implementation_scope_invalid");
  assert.deepEqual([...expanded.pathspec], ["src/a", "src/b"]);

  const tooFar = expandScope({
    current: { pathspec: ["src/a"] },
    requested: { pathspec: ["src/schema"], intake: { surfaces: { ...quickIntake.surfaces, data_schema: true } } },
    intake: quickIntake,
  });
  assert.equal(tooFar.decision, "invalidate");
  assert.deepEqual([...tooFar.triggers], ["data_schema"]);
});

test("promotion supersedes the Quick task rather than repairing it", () => {
  const { effect, replacement, quick } = promote({
    quick: quickTask,
    triggers: ["data_schema"],
    nowIso: NOW,
  });
  assert.equal(effect, "created");
  // From the original base: the Planned flow plans the work, it does not
  // inherit an unreviewed head.
  assert.equal(replacement.base_oid, quickTask.base_oid);
  assert.notEqual(replacement.base_oid, quickTask.head_oid);
  assert.equal(replacement.supersedes, quickTask.task_id);
  assert.equal(quick.outcome, "reclassified");
  assert.equal(quick.superseded_by, replacement.replacement_key);
  assert.equal(quick.may_commit, false);
  assert.equal(quick.may_integrate, false);
  assert.throws(() => promote({ quick: quickTask, triggers: [], nowIso: NOW }), code("quick_classification_invalid"));
});

test("promotion is idempotent, so a crash does not create a second Planned Epic", () => {
  const first = promote({ quick: quickTask, triggers: ["security"], nowIso: NOW });
  const replay = promote({
    quick: quickTask,
    triggers: ["security"],
    existingReplacement: first.replacement,
    nowIso: NOW,
  });
  assert.equal(replay.effect, "replayed");
  assert.equal(replay.replacement.replacement_key, first.replacement.replacement_key);
  assert.equal(replay.quick.outcome, "reclassified");
  // A replacement belonging to another Quick task is not this one's.
  assert.throws(
    () => promote({
      quick: quickTask,
      triggers: ["security"],
      existingReplacement: { ...first.replacement, replacement_key: "someone:else:planned" },
      nowIso: NOW,
    }),
    code("quick_classification_invalid"),
  );
});

test("the worktree is handed over as unverified work, and never deleted", () => {
  const { replacement } = promote({ quick: quickTask, triggers: ["migration"], nowIso: NOW });
  const handover = worktreeHandover({
    quick: quickTask,
    replacement,
    worktree: { path: "/tmp/wt", head_oid: "b".repeat(40), dirty: true },
  });
  assert.equal(handover.receipt.state, "unverified_work");
  assert.equal(handover.receipt.dirty, true);
  // Nothing in it was reviewed under the classification it was produced under.
  assert.equal(handover.is_code_candidate, false);
  // Deleting somebody's unreviewed work to tidy a transition is the one
  // outcome that cannot be undone.
  assert.equal(handover.delete_worktree, false);
});

test("after invalidation the Quick task does nothing else", () => {
  const { quick } = promote({ quick: quickTask, triggers: ["api_contract"], nowIso: NOW });
  assert.equal(assertNoQuickSideEffect(quickTask, "commit"), "commit");
  assert.throws(() => assertNoQuickSideEffect(quick, "commit"), code("quick_side_effect_after_invalidation"));
  assert.throws(() => assertNoQuickSideEffect(quick, "integrate"), code("quick_side_effect_after_invalidation"));
});
