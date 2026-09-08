/**
 * Tests for evidence durability, harness proof and retention (issue #27 runtime).
 *
 * Two rules carry it: durability is derived from the class rather than
 * asserted, and a record cut to fit that does not say so is a diagnostic
 * reading as complete — worse than a missing one, because the reader has no
 * reason to doubt it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLASS_DURABILITY,
  HARNESS_PROOFS,
  NON_PRODUCT_OUTCOMES,
  REFUSALS,
  cleanupPlan,
  dependentGateErrors,
  durabilityErrors,
  harnessRunErrors,
  pathErrors,
  restoreFailureHold,
  retentionChangeErrors,
  storageDecision,
  tombstoneFor,
  truncationErrors,
} from "../src/host/evidence-retention.mjs";

const code = (name) => (error) => error.code === name;

const NOW = Date.parse("2026-09-09T09:00:00.000Z");

function record(overrides = {}) {
  return {
    evidence_id: "ev-1",
    class: "temporary_log",
    durability: "expirable",
    path: ".autosk-evidence/e1/T-102/run.log",
    size_bytes: 400,
    hash: "a".repeat(64),
    truncated: false,
    expires_at: new Date(NOW - 1000).toISOString(),
    ...overrides,
  };
}

function harnessRun(overrides = {}) {
  return {
    batch_contract_digest: "b".repeat(64),
    harness_source_digest: "c".repeat(64),
    mutation_set_digest: "d".repeat(64),
    mutation_application_proof: "evidence/applied.json",
    expected_killer: "TestChunkBoundary",
    observed_red_signature: "TestChunkBoundary failed",
    green_controls: ["storelock suite green on the unmutated candidate"],
    before_identity: "tree:aaaa",
    after_identity: "tree:aaaa",
    restore_receipt: "evidence/restore.json",
    batch_outcome: "product_detected",
    product_outcome: "fail",
    ...overrides,
  };
}

test("durability is derived from the class, not asserted by the producer", () => {
  // Otherwise "this one is durable" becomes something a producer can say about
  // a class the policy calls transient.
  assert.deepEqual(durabilityErrors(record()), []);
  assert.deepEqual(durabilityErrors(record({ class: "verdict", durability: "durable" })), []);
  const lying = durabilityErrors(record({ class: "temporary_log", durability: "durable" }));
  assert.ok(lying.some((error) => error.reason === "evidence_class_durability_conflict"));
  const unknown = durabilityErrors(record({ class: "something_new", durability: "durable" }));
  assert.ok(unknown.some((error) => /unknown class/u.test(error.detail)));
  // Every class the table names has a durability, and nothing else does.
  assert.equal(Object.keys(CLASS_DURABILITY).length, 16);
});

test("a truncated record says so, and says how big it was", () => {
  assert.deepEqual(truncationErrors(record()), []);
  const silent = truncationErrors(record({ truncated: true }));
  assert.ok(silent.some((error) => error.reason === "evidence_truncated_as_complete"));
  const inconsistent = truncationErrors(
    record({ truncated: true, original_size_bytes: 100, size_bytes: 400, truncation_policy: "tail" }),
  );
  assert.ok(inconsistent.some((error) => /not larger than stored/u.test(error.detail)));
  assert.deepEqual(
    truncationErrors(record({ truncated: true, original_size_bytes: 9000, truncation_policy: "tail" })),
    [],
  );
});

test("a path that leaves the project is not evidence about this project", () => {
  assert.deepEqual(pathErrors(record(), "evidence"), []);
  assert.ok(
    pathErrors(record({ path: "/tmp/other/run.log" }), "evidence")
      .some((error) => error.reason === "evidence_cross_project_path"),
  );
});

test("a harness run proves it ran, or its outcome means nothing", () => {
  // A PASS with no proof that the mutation was applied, the killer fired, the
  // controls passed and the state was restored is a claim about a run nobody
  // can distinguish from a run that did nothing.
  assert.deepEqual(harnessRunErrors(harnessRun()), []);
  for (const proof of HARNESS_PROOFS) {
    const missing = harnessRun();
    delete missing[proof];
    assert.ok(
      harnessRunErrors(missing).some((error) => error.detail === `missing ${proof}`),
      proof,
    );
  }
  for (const field of ["batch_contract_digest", "harness_source_digest", "mutation_set_digest"]) {
    const missing = harnessRun();
    delete missing[field];
    assert.ok(harnessRunErrors(missing).some((error) => error.detail === `missing ${field}`), field);
  }
});

test("a tool outcome is never recorded alongside a product pass", () => {
  // The rule most likely to be violated with good intentions: a harness that
  // could not run is not a product that passed.
  for (const outcome of NON_PRODUCT_OUTCOMES) {
    const errors = harnessRunErrors(harnessRun({ batch_outcome: outcome, product_outcome: "pass" }));
    assert.ok(errors.some((error) => error.reason === "evidence_tool_outcome_as_product"), outcome);
  }
  // Reported as what it is, the same run is fine.
  assert.deepEqual(
    harnessRunErrors(harnessRun({ batch_outcome: "tool_error", product_outcome: "not_run" })),
    [],
  );
});

test("the reference inventory is built before anything is deleted", () => {
  // Deleting before knowing what points at what is how a PASS loses its
  // evidence.
  assert.throws(
    () => cleanupPlan([record()], { references: ["ev-1"], nowMs: NOW }),
    code("evidence_referenced_deletion"),
  );
  const plan = cleanupPlan([record()], { references: new Set(), nowMs: NOW });
  assert.deepEqual(plan.delete.slice(), ["ev-1"]);
  assert.equal(plan.adapter, "safe_project_fs");
});

test("referenced and durable evidence is never deleted, whatever the class says", () => {
  const referenced = cleanupPlan([record()], { references: new Set(["ev-1"]), nowMs: NOW });
  assert.deepEqual(referenced.delete.slice(), []);
  assert.equal(referenced.keep[0].reason, "referenced");

  const durable = cleanupPlan([record({ class: "verdict", durability: "durable" })], {
    references: new Set(),
    nowMs: NOW,
  });
  assert.deepEqual(durable.delete.slice(), []);
  assert.equal(durable.keep[0].reason, "durable_class");

  const unexpired = cleanupPlan([record({ expires_at: new Date(NOW + 1000).toISOString() })], {
    references: new Set(),
    nowMs: NOW,
  });
  assert.equal(unexpired.keep[0].reason, "not_expired");
});

test("an ephemeral harness survives until the restore is verified", () => {
  const unverified = cleanupPlan(
    [record({ class: "temporary_harness_binary", durability: "transient" })],
    { references: new Set(), nowMs: NOW },
  );
  assert.deepEqual(unverified.delete.slice(), []);
  assert.equal(unverified.keep[0].reason, "restore_unverified");

  const verified = cleanupPlan(
    [
      record({
        class: "temporary_harness_binary",
        durability: "transient",
        restore_verified: true,
        restore_receipt_id: "rr-1",
      }),
    ],
    { references: new Set(), nowMs: NOW },
  );
  assert.deepEqual(verified.delete.slice(), ["ev-1"]);
});

test("evidence may go away; it may not go away silently", () => {
  const tombstone = tombstoneFor(record(), {
    reason: "expired transient log",
    nowMs: NOW,
    actor: "housekeeping",
    operationId: "op-9",
  });
  assert.equal(tombstone.hash, record().hash);
  assert.equal(tombstone.actor, "housekeeping");
  assert.throws(
    () => tombstoneFor(record(), { reason: "", nowMs: NOW, actor: "x", operationId: "y" }),
    code("evidence_referenced_deletion"),
  );
  assert.throws(
    () => tombstoneFor(record(), { reason: "r", nowMs: NOW, actor: "x" }),
    code("evidence_referenced_deletion"),
  );
});

test("a shorter retention does not reach evidence produced under a longer one", () => {
  const previous = { horizon_ms: 90 * 86_400_000 };
  assert.deepEqual(
    retentionChangeErrors(previous, {
      horizon_ms: 30 * 86_400_000,
      decision_ref: "decision-77",
      applies_to: "evidence_produced_after_change",
    }),
    [],
  );
  const retroactive = retentionChangeErrors(previous, {
    horizon_ms: 30 * 86_400_000,
    decision_ref: "decision-77",
    applies_to: "all_evidence",
  });
  assert.ok(retroactive.some((error) => error.reason === "evidence_retention_retroactive"));
  const undecided = retentionChangeErrors(previous, { horizon_ms: 120 * 86_400_000 });
  assert.ok(undecided.some((error) => /recorded decision/u.test(error.detail)));
});

test("an artifact that cannot be redacted is not stored at all", () => {
  // The escalation is a decision, not a quiet write.
  assert.deepEqual(storageDecision({ class: "temporary_log", redactable: true }), { store: true });
  const unredactable = storageDecision({ class: "provider_raw_output", redactable: false });
  assert.equal(unredactable.store, false);
  assert.equal(unredactable.escalate, true);
  const sensitive = storageDecision({ class: "quarantined_sensitive", redactable: true });
  assert.equal(sensitive.store, false);
  assert.equal(
    storageDecision({ class: "quarantined_sensitive", redactable: true, decision_ref: "decision-8" }).store,
    true,
  );
});

test("missing durable evidence invalidates the gate that depended on it", () => {
  const gate = { gate_id: "g-1", evidence_ids: ["ev-1", "ev-2"] };
  assert.deepEqual(dependentGateErrors(gate, new Set(["ev-1", "ev-2"])), []);
  assert.deepEqual(dependentGateErrors(gate, new Set(["ev-1"])), [
    { reason: "evidence_missing_durable", detail: "ev-2" },
  ]);
});

test("a failed restore forbids ordinary cleanup until a recovery decision", () => {
  assert.deepEqual(restoreFailureHold([{ batch_outcome: "product_detected" }]), { hold: false });
  const held = restoreFailureHold([{ batch_outcome: "restore_failed" }]);
  assert.equal(held.hold, true);
  assert.equal(held.reason, "evidence_restore_unverified");
});

test("every refusal class the contract closes can be produced", () => {
  const produced = new Set();
  const collect = (errors) => {
    for (const error of errors) produced.add(error.reason);
  };
  collect(durabilityErrors(record({ durability: "durable" })));
  collect(truncationErrors(record({ truncated: true })));
  collect(pathErrors(record({ path: "/tmp/x" }), "evidence"));
  collect(harnessRunErrors({ batch_outcome: "pass", product_outcome: "pass" }));
  collect(harnessRunErrors(harnessRun({ batch_outcome: "tool_error", product_outcome: "pass" })));
  collect(retentionChangeErrors({ horizon_ms: 10 }, { horizon_ms: 5, decision_ref: "d", applies_to: "all" }));
  collect(dependentGateErrors({ evidence_ids: ["missing"] }, new Set()));
  produced.add(storageDecision({ class: "provider_raw_output", redactable: false }).reason);
  produced.add(restoreFailureHold([{ batch_outcome: "restore_failed" }]).reason);
  try {
    cleanupPlan([record()], { references: ["not a set"], nowMs: NOW });
  } catch (error) {
    produced.add(error.code);
  }
  for (const refusal of REFUSALS) {
    assert.ok(produced.has(refusal), `${refusal} is documented and never produced`);
  }
});
