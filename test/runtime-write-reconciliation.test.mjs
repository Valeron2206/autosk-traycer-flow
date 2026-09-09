/**
 * Tests for quarantine and four-source reconciliation (issue #22 runtime).
 *
 * The rule the contract exists for: when four sources disagree, choosing the
 * most recent one is choosing whichever process happened to finish last — which
 * is the failure being diagnosed, not a way to resolve it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DISPOSITIONS,
  QUARANTINE_REASONS,
  RECONCILIATION_STATES,
  SOURCES,
  applyDisposition,
  isVerified,
  quarantineDecision,
  reconcile,
  stalePendingErrors,
  taskStatusLeakErrors,
  workflowEffect,
} from "../src/host/write-reconciliation.mjs";

const code = (name) => (error) => error.code === name;

const policy = { max_bytes: 1024 };

function candidate(overrides = {}) {
  return {
    path: "docs/autosk/epics/e1/brief.md",
    quarantine_path: ".autosk/quarantine/e1/brief.md",
    size_bytes: 100,
    regular_single_linked: true,
    class_valid: true,
    policy_known: true,
    ...overrides,
  };
}

const digest = (char) => char.repeat(64);

function observations(overrides = {}) {
  return {
    canonical_bytes: digest("a"),
    task_metadata: digest("a"),
    receipt: digest("a"),
    model_output: digest("a"),
    ...overrides,
  };
}

test("an ordinary artifact is not held", () => {
  assert.deepEqual(quarantineDecision(candidate(), policy), { state: "none" });
  // Exactly the policy maximum is not oversized: the bound is "over", and only
  // values far past it were asked, so `>` could have been `>=` and every file
  // at the limit would have been quarantined.
  assert.deepEqual(quarantineDecision(candidate({ size_bytes: policy.max_bytes }), policy), { state: "none" });
  assert.equal(quarantineDecision(candidate({ size_bytes: policy.max_bytes + 1 }), policy).state, "held");
});

test("oversized, special, malformed and undetermined are each held", () => {
  const cases = [
    [{ size_bytes: 2048 }, "oversized"],
    [{ regular_single_linked: false }, "not_regular_file"],
    [{ class_valid: false }, "malformed_for_class"],
    [{ policy_known: false }, "policy_undetermined"],
  ];
  for (const [overrides, reason] of cases) {
    const held = quarantineDecision(candidate(overrides), policy);
    assert.equal(held.state, "held", reason);
    assert.ok(held.reasons.includes(reason), reason);
    // Pending until a human records one.
    assert.equal(held.disposition, "pending");
  }
  assert.deepEqual(QUARANTINE_REASONS.slice(), [
    "oversized",
    "not_regular_file",
    "malformed_for_class",
    "policy_undetermined",
  ]);
});

test("the quarantine path is never the canonical artifact path", () => {
  // Nothing downstream can mistake a held artifact for the artifact.
  assert.throws(
    () => quarantineDecision(candidate({ size_bytes: 2048, quarantine_path: candidate().path }), policy),
    code("write_destination_invalid"),
  );
  assert.throws(
    () => quarantineDecision(candidate({ size_bytes: 2048, quarantine_path: "" }), policy),
    code("write_destination_invalid"),
  );
});

test("the source is not destroyed, and there is no automatic release", () => {
  // A quarantine that deletes what it could not classify is a data-loss path
  // wearing a safety name.
  const held = quarantineDecision(candidate({ class_valid: false }), policy);
  assert.equal(held.path, ".autosk/quarantine/e1/brief.md");
  assert.throws(() => applyDisposition(held, "pending", { by: "owner" }), code("write_destination_invalid"));
  assert.throws(() => applyDisposition(held, "release", { by: "owner" }), code("write_destination_invalid"));
  assert.throws(() => applyDisposition(held, "restore", { by: "" }), code("write_destination_invalid"));
  const disposed = applyDisposition(held, "restore", { by: "owner" });
  assert.equal(disposed.disposition, "restore");
  assert.equal(disposed.disposed_by, "owner");
  assert.throws(
    () => applyDisposition({ state: "none" }, "inspect", { by: "owner" }),
    code("write_destination_invalid"),
  );
  assert.deepEqual(DISPOSITIONS.slice(), ["pending", "inspect", "transform", "reject", "restore"]);
});

test("four agreeing sources agree, and the report still names all four", () => {
  // A report that lists only the odd one out cannot be checked by a reader who
  // does not already know the answer.
  const outcome = reconcile(observations());
  assert.equal(outcome.state, "agreed");
  assert.deepEqual(outcome.report.map((entry) => entry.source), [...SOURCES]);
  assert.equal(outcome.report.every((entry) => entry.state === "observed"), true);
});

test("a divergence names every source and what it said", () => {
  const outcome = reconcile(observations({ task_metadata: digest("b") }));
  assert.equal(outcome.state, "diverged");
  assert.equal(outcome.report.length, 4);
  const effect = workflowEffect(outcome);
  assert.equal(effect.effect, "park");
  for (const source of SOURCES) {
    assert.ok(effect.detail.includes(source), source);
  }
});

test("a source nobody observed is unknown, not agreement", () => {
  // The comparison has not been made for it, which is a different fact from
  // having been made and matched.
  const partial = observations();
  delete partial.model_output;
  const outcome = reconcile(partial);
  assert.equal(outcome.state, "unreconciled");
  assert.equal(outcome.report.find((entry) => entry.source === "model_output").state, "unknown");
  assert.equal(workflowEffect(outcome).effect, "compare_before_verifying");
});

test("unreconciled is not a formality, and never counts as verified", () => {
  // A write that landed and was read back established what is on disk and
  // nothing about the other three sources.
  assert.equal(isVerified({ phase: "verified", reconciliation: { state: "unreconciled" } }), false);
  assert.equal(isVerified({ phase: "verified", reconciliation: { state: "diverged" } }), false);
  assert.equal(isVerified({ phase: "read_back", reconciliation: { state: "agreed" } }), false);
  assert.equal(isVerified({ phase: "verified", reconciliation: { state: "agreed" } }), true);
  assert.deepEqual(RECONCILIATION_STATES.slice(), ["unreconciled", "agreed", "diverged"]);
});

test("last writer wins is not available, because no state selects a winner", () => {
  // Every path out of a divergence is a park; nothing here returns a chosen
  // source, and that is the whole point of the three-state shape.
  const diverged = reconcile(observations({ receipt: digest("c"), model_output: digest("d") }));
  const effect = workflowEffect(diverged);
  assert.equal(effect.effect, "park");
  assert.ok(!Object.hasOwn(effect, "winner"));
  assert.throws(() => workflowEffect({ state: "resolved_by_recency" }), code("write_readback_mismatch"));
});

test("a pending receipt from a previous run is not evidence that its write completed", () => {
  const receipts = [
    { receipt_id: "r-1", phase: "pending", run_id: "run-1" },
    { receipt_id: "r-2", phase: "pending", run_id: "run-2" },
    { receipt_id: "r-3", phase: "verified", run_id: "run-1" },
  ];
  assert.deepEqual(stalePendingErrors(receipts, { runId: "run-2" }), [
    { reason: "receipt_stale_pending", detail: "r-1" },
  ]);
  assert.deepEqual(stalePendingErrors(receipts, { runId: "run-1" }), [
    { reason: "receipt_stale_pending", detail: "r-2" },
  ]);
});

test("a receipt carries no task status, step or workflow position", () => {
  // Stronger than a convention not to write them: the check is on the record.
  assert.deepEqual(taskStatusLeakErrors({ receipt_id: "r-1", phase: "verified" }), []);
  for (const field of ["task_status", "step", "workflow_position", "task_state"]) {
    const errors = taskStatusLeakErrors({ receipt_id: "r-1", [field]: "review" });
    assert.ok(errors.some((error) => error.detail.includes(field)), field);
  }
});
