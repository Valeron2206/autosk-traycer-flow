/**
 * Tests for where the work-type gates are asked (issue #24).
 *
 * A playbook that is not consulted at a decision point is a document. There are
 * two points where these gates change what happens, and both are fail-closed.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  GATE_POINTS,
  completionAdmission,
  dispatchAdmission,
  gate,
} from "../src/host/work-type-dispatcher.mjs";

const code = (name) => (error) => error.code === name;

const feature = (overrides = {}) => ({
  ticket_id: "T-1",
  work_type: "feature",
  data_shape: "one row per creation key",
  why_not_booleans: "three states, not two",
  rejected_alternatives: "a nullable flag",
  tests_in_same_ticket: true,
  ...overrides,
});

const bugfix = (overrides = {}) => ({
  ticket_id: "T-2",
  work_type: "bug-fix",
  root_cause: "the index is written before the record",
  runtime_evidence_pointer: "evidence/T-2/crash.log",
  repro_confirmed_on_surface: true,
  failing_regression_test_before_fix: "test/creation.test.mjs",
  ...overrides,
});

const batch = (overrides = {}) => ({
  batch_id: "b-1",
  purpose: "prove the guard is load-bearing",
  candidate_identity: { tree: "a".repeat(40) },
  acceptance_rule: "every mutation killed",
  failure_taxonomy: "closed",
  mutations: [{ id: "m-1", expected_killer: "T", observed_red_signature: "r", application_proof: "p" }],
  green_control: "passed",
  harness_self_test: "self-test",
  repository_tests_final_run: "run",
  restore_verified: true,
  candidate_tree_oid: "a".repeat(40),
  environment_digest: "b".repeat(64),
  tool_digest: "c".repeat(64),
  harness_digest: "d".repeat(64),
  mutation_set_digest: "e".repeat(64),
  attempt: 1,
  policy_digest: "f".repeat(64),
  ...overrides,
});

test("a Ticket without its playbook's prerequisites is not dispatched", () => {
  assert.equal(dispatchAdmission(feature()).decision, "dispatch");
  const missing = dispatchAdmission(feature({ tests_in_same_ticket: false, data_shape: undefined }));
  assert.equal(missing.decision, "park");
  assert.equal(missing.work_type, "feature");
  // Every reason, not the first: fixing them one round at a time is how a
  // Ticket spends four dispatches learning what its own playbook wanted.
  assert.equal(missing.errors.length, 2);
});

test("a bug fix needs the test that watched the code fail", () => {
  assert.equal(dispatchAdmission(bugfix()).decision, "dispatch");
  const claimed = dispatchAdmission(bugfix({ failing_regression_test_before_fix: undefined }));
  assert.equal(claimed.decision, "park");
  assert.equal(claimed.reason, "bugfix_root_cause_unknown");
  // The point of checking at dispatch: this one cannot be produced afterwards.
  assert.ok(claimed.errors.some((error) => /before the fix/u.test(error.detail)));
});

test("a Ticket with no work type at all is parked, not defaulted", () => {
  const none = dispatchAdmission({ ticket_id: "T-9" });
  assert.equal(none.decision, "park");
  assert.equal(none.reason, "worktype_missing");
  assert.equal(none.work_type, null);
});

test("completion reads the evidence the Ticket actually produced", () => {
  const ticket = feature();
  const current = batch();
  assert.equal(completionAdmission(ticket, { batch: batch(), current }).decision, "complete");
  // A batch whose own controls were red says nothing about the mutants it
  // reports killing.
  const red = completionAdmission(ticket, { batch: batch({ green_control: "failed" }), current });
  assert.equal(red.decision, "park");
  assert.ok(red.errors.some((error) => error.reason === "batch_green_control_failed"));
});

test("a result bound to a tree that has since moved is stale", () => {
  const result = batch();
  const moved = { ...batch(), candidate_tree_oid: "9".repeat(40) };
  const admission = completionAdmission(feature(), { batch: result, current: moved });
  assert.equal(admission.decision, "park");
  assert.ok(admission.errors.some((error) => error.reason === "batch_result_stale"));
});

test("a perf Ticket completes on a measurement, not on an intention", () => {
  const ticket = { ticket_id: "T-4", work_type: "perf" };
  const improved = completionAdmission(ticket, { measurement: { deltaRatio: -0.4, noiseThreshold: 0.05 } });
  assert.equal(improved.decision, "complete");
  assert.equal(improved.perf_verdict, "improved");
  // Inside the noise it declared before measuring: not an improvement, and not
  // a regression either.
  const noise = completionAdmission(ticket, { measurement: { deltaRatio: -0.01, noiseThreshold: 0.05 } });
  assert.equal(noise.decision, "park");
  assert.equal(noise.perf_verdict, "inconclusive");
  assert.throws(() => completionAdmission(ticket, {}), code("batch_proof_contract_incomplete"));
});

test("an exact listing is owed unless something else already proves it", () => {
  const owed = completionAdmission(feature(), {
    artifact: { exact_listing_present: false, proof_contract_complete: false },
  });
  assert.equal(owed.decision, "park");
  assert.ok(owed.errors.some((error) => /an exact listing is owed/u.test(error.detail)));
  assert.equal(
    completionAdmission(feature(), {
      artifact: { exact_listing_present: false, proof_contract_complete: true, proof_contract_executable: true },
    }).decision,
    "complete",
  );
});

test("a disposition that quietly drops a finding is an evasion", () => {
  const before = [{ id: "F-1", severity: "high" }];
  const after = [];
  const admission = completionAdmission(feature(), { dispositions: { before, after } });
  assert.equal(admission.decision, "park");
  assert.ok(admission.errors.some((error) => error.reason === "batch_listing_disposition_evaded"));
});

test("the gate for a point cannot be the gate for the other one", () => {
  // A completion check run at dispatch passes on a Ticket that has produced no
  // evidence yet, which is the most comfortable way to have a gate and not be
  // gated.
  assert.deepEqual([...GATE_POINTS], ["dispatch", "completion"]);
  assert.equal(gate("dispatch", feature()).decision, "dispatch");
  assert.equal(gate("completion", feature(), { batch: batch(), current: batch() }).decision, "complete");
  assert.equal(gate("dispatch", feature({ data_shape: undefined })).decision, "park");
  assert.throws(() => gate("sometime", feature()), code("worktype_missing"));
});
