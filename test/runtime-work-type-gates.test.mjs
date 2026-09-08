/**
 * Tests for the work-type gates and batch sufficiency (issue #24 runtime).
 *
 * Including a playbook in a prompt is not enough: a model can read a
 * requirement and still proceed. These are the deterministic gates, and the
 * sentence the second half exists for — a batch is not sufficient because a
 * temporary script exited 0.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  BINDING_FIELDS,
  NON_PRODUCT_OUTCOMES,
  REFUSALS,
  WORK_TYPES,
  batchSufficiencyErrors,
  dispositionEvasions,
  listingObligation,
  perfVerdict,
  prerequisiteErrors,
  scaffoldingErrors,
  stalenessErrors,
} from "../src/host/work-type-gates.mjs";

const code = (name) => (error) => error.code === name;

function feature(overrides = {}) {
  return {
    ticket_id: "T-1",
    work_type: "feature",
    data_shape: "a typed state machine",
    why_not_booleans: "three booleans would encode four states, one of them impossible",
    rejected_alternatives: ["a flag pair kept in sync"],
    tests_in_same_ticket: true,
    ...overrides,
  };
}

function bugfix(overrides = {}) {
  return {
    ticket_id: "T-2",
    work_type: "bug-fix",
    root_cause: "the offset was compared before normalisation",
    runtime_evidence_pointer: "evidence/T-2/trace.log",
    repro_confirmed_on_surface: true,
    failing_regression_test_before_fix: true,
    ...overrides,
  };
}

function refactoring(overrides = {}) {
  return {
    ticket_id: "T-3",
    work_type: "refactoring",
    behaviour_pin: { kind: "characterization_test", ref: "test/characterize.test.mjs" },
    equivalence_proof_target: "the storelock surface",
    ...overrides,
  };
}

function perf(overrides = {}) {
  return {
    ticket_id: "T-4",
    work_type: "perf",
    measurement_method: {
      warm_up: 3,
      min_repeats: 20,
      spread_statistic: "p95",
      noise_threshold: 0.05,
      command: "bun bench store",
      workload: "10k transcript reads",
      environment: "darwin-arm64 pinned",
      hypothesis: "chunking removes the whole-file read",
      ...overrides.measurement_method,
    },
    ...overrides,
  };
}

function batch(overrides = {}) {
  return {
    batch_id: "b-1",
    purpose: "prove the chunk guard is reachable",
    candidate_identity: { tree: "a".repeat(40) },
    acceptance_rule: "every mutation killed",
    failure_taxonomy: "closed",
    mutations: [
      { id: "m-1", application_proof: "evidence/applied.json", expected_killer: "TestChunk", observed_red_signature: "TestChunk failed" },
    ],
    green_control: "passed",
    harness_self_test: "planted mutation was killed",
    repository_tests_final_run: "go test ./...",
    restore_verified: true,
    ...overrides,
  };
}

test("a work type is required, and mixing them is refused", () => {
  assert.deepEqual(prerequisiteErrors(feature()), []);
  assert.ok(prerequisiteErrors({ ticket_id: "T-0" }).some((error) => error.reason === "worktype_missing"));
  assert.ok(
    prerequisiteErrors({ ticket_id: "T-0", work_type: "cleanup" })
      .some((error) => /unknown work type/u.test(error.detail)),
  );
  assert.ok(
    prerequisiteErrors(feature({ additional_work_types: ["refactoring"] }))
      .some((error) => error.reason === "worktype_mixed"),
  );
  assert.deepEqual(WORK_TYPES.slice(), ["feature", "bug-fix", "refactoring", "perf"]);
});

test("a feature states its shape and why it is not a set of booleans", () => {
  for (const field of ["data_shape", "why_not_booleans", "rejected_alternatives", "tests_in_same_ticket"]) {
    const missing = feature();
    delete missing[field];
    assert.ok(prerequisiteErrors(missing).length > 0, field);
  }
});

test("a bug-fix does not start with an unknown cause", () => {
  assert.deepEqual(prerequisiteErrors(bugfix()), []);
  for (const field of ["root_cause", "runtime_evidence_pointer", "repro_confirmed_on_surface"]) {
    const missing = bugfix();
    delete missing[field];
    assert.ok(
      prerequisiteErrors(missing).some((error) => error.reason === "bugfix_root_cause_unknown"),
      field,
    );
  }
  // Without a failing test first, "fixed" is a claim about code nobody watched
  // fail.
  const noTest = bugfix({ failing_regression_test_before_fix: false });
  assert.ok(prerequisiteErrors(noTest).some((error) => /failing regression test/u.test(error.detail)));
});

test("investigate-and-fix in one handoff is refused", () => {
  // A handoff that may change the code has no way to prove what the code did
  // before it.
  assert.ok(
    prerequisiteErrors(bugfix({ includes_investigation: true }))
      .some((error) => error.reason === "bugfix_investigate_and_fix_combined"),
  );
});

test("typecheck and lint are not a behaviour pin", () => {
  // They constrain shape, not behaviour.
  assert.deepEqual(prerequisiteErrors(refactoring()), []);
  for (const kind of ["typecheck", "lint", "format"]) {
    assert.ok(
      prerequisiteErrors(refactoring({ behaviour_pin: { kind } }))
        .some((error) => error.reason === "refactor_behavior_pin_missing"),
      kind,
    );
  }
  const noPin = refactoring();
  delete noPin.behaviour_pin;
  assert.ok(prerequisiteErrors(noPin).some((error) => error.reason === "refactor_behavior_pin_missing"));
  const noTarget = refactoring();
  delete noTarget.equivalence_proof_target;
  assert.ok(prerequisiteErrors(noTarget).some((error) => /prove equivalence on/u.test(error.detail)));
});

test("a perf ticket fixes its method before the numbers exist", () => {
  assert.deepEqual(prerequisiteErrors(perf()), []);
  for (const field of ["warm_up", "min_repeats", "spread_statistic", "noise_threshold", "command", "workload", "environment", "hypothesis"]) {
    const missing = perf();
    delete missing.measurement_method[field];
    assert.ok(prerequisiteErrors(missing).some((error) => error.detail === `perf: ${field}`), field);
  }
  // A threshold chosen afterwards is a description of the result.
  assert.ok(
    prerequisiteErrors(perf({ measurement_method: { threshold_fixed_after_results: true } }))
      .some((error) => error.reason === "perf_threshold_after_result"),
  );
});

test("a delta inside the threshold is inconclusive, never a pass", () => {
  assert.equal(perfVerdict({ deltaRatio: 0.02, noiseThreshold: 0.05 }), "inconclusive");
  assert.equal(perfVerdict({ deltaRatio: -0.02, noiseThreshold: 0.05 }), "inconclusive");
  assert.equal(perfVerdict({ deltaRatio: -0.2, noiseThreshold: 0.05 }), "improved");
  assert.equal(perfVerdict({ deltaRatio: 0.2, noiseThreshold: 0.05 }), "regressed");
  assert.throws(() => perfVerdict({ deltaRatio: 0.2 }), code("perf_threshold_after_result"));
});

test("a missing listing is not a finding when the proof contract carries it", () => {
  assert.equal(listingObligation({ exact_listing_present: true }).owed, false);
  assert.equal(
    listingObligation({ proof_contract_complete: true, proof_contract_executable: true }).owed,
    false,
  );
  // Missing both is a finding.
  assert.equal(listingObligation({ proof_contract_complete: true }).owed, true);
  assert.equal(listingObligation({}).reason, "batch_proof_contract_incomplete");
});

test("removing a listing means removing it", () => {
  // Rewriting, moving, hiding, translating or leaving equivalent pseudocode all
  // keep the thing the disposition asked to remove.
  const before = { artifact_identity: "a" };
  assert.deepEqual(dispositionEvasions(before, { artifact_identity: "b" }), []);
  for (const field of ["exact_listing_present", "appendix_listing", "collapsed_listing", "translated_listing", "equivalent_pseudocode"]) {
    const evaded = dispositionEvasions(before, { artifact_identity: "b", [field]: true });
    assert.ok(evaded.some((error) => error.reason === "batch_listing_disposition_evaded"), field);
  }
  // The removal creates a new planning-artifact identity.
  assert.ok(
    dispositionEvasions(before, { artifact_identity: "a" })
      .some((error) => /new artifact identity/u.test(error.detail)),
  );
});

test("a batch is not sufficient because a temporary script exited 0", () => {
  assert.deepEqual(batchSufficiencyErrors(batch()), []);
  assert.ok(batchSufficiencyErrors(undefined).some((error) => error.reason === "batch_contract_missing"));
  for (const field of ["batch_id", "purpose", "candidate_identity", "acceptance_rule", "failure_taxonomy"]) {
    const missing = batch();
    delete missing[field];
    assert.ok(batchSufficiencyErrors(missing).some((error) => error.reason === "batch_contract_missing"), field);
  }
});

test("every mutation proves it was applied and names its killer", () => {
  const unapplied = batch({ mutations: [{ id: "m-1", expected_killer: "T", observed_red_signature: "r" }] });
  assert.ok(batchSufficiencyErrors(unapplied).some((error) => error.reason === "batch_mutation_not_applied"));
  const unnamed = batch({ mutations: [{ id: "m-1", application_proof: "p" }] });
  assert.ok(batchSufficiencyErrors(unnamed).some((error) => /killer and red signature/u.test(error.detail)));
});

test("a failed green control voids the batch, and a self-test is required", () => {
  // If the unmutated candidate fails its own controls, a red result says
  // nothing.
  assert.ok(
    batchSufficiencyErrors(batch({ green_control: "failed" }))
      .some((error) => error.reason === "batch_green_control_failed"),
  );
  const noSelfTest = batch();
  delete noSelfTest.harness_self_test;
  assert.ok(batchSufficiencyErrors(noSelfTest).some((error) => /self-test or known killed mutation/u.test(error.detail)));
  const noFinalRun = batch();
  delete noFinalRun.repository_tests_final_run;
  assert.ok(batchSufficiencyErrors(noFinalRun).some((error) => /repository tests were not re-run/u.test(error.detail)));
  assert.ok(
    batchSufficiencyErrors(batch({ restore_verified: false }))
      .some((error) => error.reason === "batch_restore_unverified"),
  );
});

test("a result binds to everything that could change what it means", () => {
  const current = Object.fromEntries(BINDING_FIELDS.map((field) => [field, `${field}-value`]));
  assert.deepEqual(stalenessErrors({ ...current }, current), []);
  for (const field of BINDING_FIELDS) {
    const drifted = { ...current, [field]: "moved" };
    assert.deepEqual(stalenessErrors(drifted, current), [
      { reason: "batch_result_stale", detail: `${field}: moved -> ${field}-value` },
    ]);
  }
});

test("ephemeral and committed scaffolding are held to different rules", () => {
  assert.deepEqual(
    scaffoldingErrors({
      lifecycle: "ephemeral",
      source_digest: "a",
      binary_digest: "b",
      config_digest: "c",
      restore_verified: true,
    }),
    [],
  );
  assert.ok(
    scaffoldingErrors({ lifecycle: "ephemeral", inside_product_source_tree: true, source_digest: "a", binary_digest: "b", config_digest: "c" })
      .some((error) => /inside the product tree/u.test(error.detail)),
  );
  assert.ok(
    scaffoldingErrors({ lifecycle: "ephemeral" }).some((error) => /without recorded digests/u.test(error.detail)),
  );
  assert.ok(
    scaffoldingErrors({ lifecycle: "ephemeral", source_digest: "a", binary_digest: "b", config_digest: "c", deleted: true })
      .some((error) => error.reason === "batch_restore_unverified"),
  );
  assert.ok(
    scaffoldingErrors({ lifecycle: "ephemeral", source_digest: "a", binary_digest: "b", config_digest: "c", is_deliverable: true })
      .some((error) => /never a deliverable/u.test(error.detail)),
  );
  // Kept scaffolding stops being exempt.
  assert.ok(
    scaffoldingErrors({ lifecycle: "committed_reusable" })
      .some((error) => /own tests and review/u.test(error.detail)),
  );
  assert.deepEqual(
    scaffoldingErrors({ lifecycle: "committed_reusable", has_own_tests: true, cross_family_review: true }),
    [],
  );
});

test("four outcomes are not failures of the product", () => {
  assert.deepEqual(NON_PRODUCT_OUTCOMES.slice(), [
    "green_control_failed",
    "mutation_not_applied",
    "tool_execution_failed",
    "indeterminate",
  ]);
});

test("every refusal class the contract closes can be produced", () => {
  const produced = new Set();
  const collect = (errors) => {
    for (const error of errors) produced.add(error.reason);
  };
  collect(prerequisiteErrors({ ticket_id: "T" }));
  collect(prerequisiteErrors(feature({ additional_work_types: ["perf"] })));
  collect(prerequisiteErrors(bugfix({ root_cause: undefined })));
  collect(prerequisiteErrors(bugfix({ includes_investigation: true })));
  collect(prerequisiteErrors(refactoring({ behaviour_pin: { kind: "lint" } })));
  collect(prerequisiteErrors(perf({ measurement_method: { threshold_fixed_after_results: true } })));
  collect(batchSufficiencyErrors(undefined));
  collect(batchSufficiencyErrors(batch({ mutations: [{ id: "m" }] })));
  collect(batchSufficiencyErrors(batch({ green_control: "failed" })));
  collect(batchSufficiencyErrors(batch({ restore_verified: false })));
  collect(stalenessErrors({ attempt: 1 }, { attempt: 2 }));
  collect(dispositionEvasions({ artifact_identity: "a" }, { artifact_identity: "a" }));
  for (const refusal of REFUSALS) {
    assert.ok(produced.has(refusal), `${refusal} is documented and never produced`);
  }
});
