/**
 * Tests for epic staging and the final CAS (issue #9 runtime).
 *
 * The contract turns on two sentences: a PASS is about a tree, not about an
 * intention, and acceptance is of an identity, not of a plan to produce one.
 * Most of these are a way one of those could stop being true.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  PARK_REASONS,
  PHASES,
  acceptanceErrors,
  aggregateBinding,
  aggregateErrors,
  applySwap,
  casAdmission,
  integrationFixErrors,
  postCasErrors,
  receiptErrors,
  resumePlan,
} from "../src/host/epic-staging.mjs";

const code = (name) => (error) => error.code === name;

const oid = (char) => char.repeat(40);

function state(overrides = {}) {
  const base = {
    schema_version: 1,
    project_identity: "sha256:" + "0".repeat(58),
    epic_id: "epic-store-lock",
    staging_ref: "refs/autosk/epics/epic-store-lock/staging",
    target_ref: "refs/heads/main",
    recorded_target_base: oid("a"),
    planning_head: oid("b"),
    receipts: [
      { ticket_id: "T-101", delta_digest: "1".repeat(64) },
      { ticket_id: "T-102", delta_digest: "2".repeat(64) },
    ],
    phase: "aggregate_verified",
    staging_commit_oid: oid("c"),
    staging_tree_oid: oid("d"),
    post_cas: { expected_new_oid: oid("c") },
    ...overrides,
  };
  const aggregate = {
    outcome: "pass",
    environment_outcome: "ok",
    verification_config_digest: "3".repeat(64),
    instruction_lock_digest: "4".repeat(64),
    staging_commit_oid: base.staging_commit_oid,
    record_hash: "5".repeat(64),
    ...overrides.aggregate,
  };
  base.aggregate = { ...aggregate, binding: aggregateBinding({ ...base, aggregate }) };
  if (overrides.aggregate?.binding) base.aggregate.binding = overrides.aggregate.binding;
  base.acceptance = overrides.acceptance ?? {
    kind: "human",
    approver: "owner",
    staging_commit_oid: base.staging_commit_oid,
    staging_tree_oid: base.staging_tree_oid,
    aggregate_record_hash: base.aggregate.record_hash,
    tickets: ["T-101", "T-102"],
    target_ref: base.target_ref,
    recorded_target_base: base.recorded_target_base,
    delivery_profile_digest: "6".repeat(64),
  };
  return base;
}

const TICKETS = ["T-101", "T-102"];

test("a complete, accepted staging may swap", () => {
  const outcome = casAdmission(state(), { oid: oid("a") }, TICKETS);
  assert.equal(outcome.decision, "may_swap");
  assert.deepEqual(outcome.reasons, []);
});

test("the target does not move before aggregate PASS and acceptance", () => {
  const noAggregate = casAdmission(state({ aggregate: { outcome: "fail" } }), { oid: oid("a") }, TICKETS);
  assert.equal(noAggregate.decision, "refused");
  assert.ok(noAggregate.reasons.some((entry) => entry.reason === "aggregate_failed"));

  const unaccepted = state();
  delete unaccepted.acceptance;
  const outcome = casAdmission(unaccepted, { oid: oid("a") }, TICKETS);
  assert.ok(outcome.reasons.some((entry) => entry.reason === "acceptance_missing"));
});

test("a command failure and an environment failure are different outcomes", () => {
  // Collapsing them makes "the tests failed" indistinguishable from "the
  // machine could not run them", and only one of those is about the product.
  const env = aggregateErrors(state({ aggregate: { outcome: "fail", environment_outcome: "environment_failure" } }));
  assert.ok(env.some((entry) => entry.reason === "environment_failure"));
  assert.ok(!env.some((entry) => entry.reason === "aggregate_failed"));
  const failed = aggregateErrors(state({ aggregate: { outcome: "fail" } }));
  assert.ok(failed.some((entry) => entry.reason === "aggregate_failed"));
});

test("any change to staging after the PASS voids the binding", () => {
  // A PASS is about a tree, not about an intention.
  const moved = state();
  moved.staging_commit_oid = oid("e");
  const errors = aggregateErrors(moved);
  assert.ok(errors.some((entry) => entry.reason === "staging_moved_after_pass"));
  assert.ok(errors.some((entry) => entry.reason === "aggregate_binding_void"));
});

test("the binding covers the config and the instruction lock, not only the tree", () => {
  const original = state();
  for (const field of ["verification_config_digest", "instruction_lock_digest"]) {
    const changed = { ...original, aggregate: { ...original.aggregate, [field]: "9".repeat(64) } };
    assert.notEqual(aggregateBinding(changed), original.aggregate.binding);
  }
  // ...and the Ticket set, so a delta added afterwards is a different subject.
  const extra = { ...original, receipts: [...original.receipts, { ticket_id: "T-103" }] };
  assert.notEqual(aggregateBinding(extra), original.aggregate.binding);
});

test("every applied Ticket leaves a receipt", () => {
  assert.deepEqual(receiptErrors(state(), TICKETS), []);
  const missing = receiptErrors(state({ receipts: [{ ticket_id: "T-101" }] }), TICKETS);
  assert.deepEqual(missing, [{ reason: "receipt_missing", detail: "T-102" }]);
});

test("acceptance is of an identity, and a moved tree makes it stale", () => {
  const drifted = state();
  drifted.acceptance = { ...drifted.acceptance, staging_tree_oid: oid("9") };
  assert.ok(acceptanceErrors(drifted).some((entry) => entry.reason === "acceptance_stale"));

  const otherAggregate = state();
  otherAggregate.acceptance = { ...otherAggregate.acceptance, aggregate_record_hash: "9".repeat(64) };
  assert.ok(acceptanceErrors(otherAggregate).some((entry) => entry.reason === "acceptance_stale"));

  const otherTickets = state();
  otherTickets.acceptance = { ...otherTickets.acceptance, tickets: ["T-101"] };
  assert.ok(acceptanceErrors(otherTickets).some((entry) => entry.reason === "acceptance_stale"));
});

test("a pinned auto-policy is held to the same binding as a person", () => {
  const auto = state();
  auto.acceptance = { ...auto.acceptance, kind: "auto_policy", approver: undefined, policy_ref: "policy-7" };
  assert.deepEqual(acceptanceErrors(auto), []);
  const unpinned = state();
  unpinned.acceptance = { ...unpinned.acceptance, kind: "auto_policy", approver: undefined };
  assert.ok(acceptanceErrors(unpinned).some((entry) => entry.reason === "acceptance_missing"));
  const anonymous = state();
  anonymous.acceptance = { ...anonymous.acceptance, approver: undefined };
  assert.ok(acceptanceErrors(anonymous).some((entry) => entry.reason === "acceptance_missing"));
});

test("a target that moved is a foreign movement, and the ref is not touched", () => {
  // Overwriting it is the one outcome that cannot be undone by retrying.
  const outcome = casAdmission(state(), { oid: oid("f") }, TICKETS);
  assert.equal(outcome.decision, "refused");
  assert.ok(outcome.reasons.some((entry) => entry.reason === "foreign_target_movement"));
});

test("an attributable move and a foreign one are different facts", () => {
  // The operator does different things about them: one re-records the base,
  // the other means someone else acted on that branch.
  const foreign = casAdmission(state(), { oid: oid("f") }, TICKETS);
  assert.ok(foreign.reasons.some((entry) => entry.reason === "foreign_target_movement"));
  const attributable = casAdmission(state(), { oid: oid("f"), attributed_to_this_epic: true }, TICKETS);
  assert.ok(attributable.reasons.some((entry) => entry.reason === "target_moved"));
});

test("the swap can still conflict, because the world moves between read and write", () => {
  // Which is precisely why the write is a compare-and-swap and not a write.
  assert.deepEqual(
    applySwap(state(), { expected_old_oid: oid("a"), swapped: true, new_oid: oid("c") }),
    { outcome: "swapped", new_oid: oid("c") },
  );
  const conflict = applySwap(state(), { expected_old_oid: oid("a"), observed_old_oid: oid("f"), swapped: false });
  assert.equal(conflict.reason, "cas_conflict");
  assert.throws(
    () => applySwap(state(), { expected_old_oid: oid("9"), swapped: true }),
    (error) => error.code === "cas_conflict",
  );
});

test("a retry of the final CAS is idempotent", () => {
  // If the target already holds the recorded result, the operation is complete
  // rather than in conflict.
  const outcome = casAdmission(state(), { oid: oid("c") }, TICKETS);
  assert.equal(outcome.decision, "already_complete");
});

test("a CAS that reported success is not evidence that the ref holds what was intended", () => {
  const good = { oid: oid("c"), tree_oid: oid("d"), contains_recorded_result: true, reflog_entries: 1 };
  assert.deepEqual(postCasErrors(state(), good), []);
  for (const bad of [
    { ...good, oid: oid("9") },
    { ...good, tree_oid: oid("9") },
    { ...good, contains_recorded_result: false },
    { ...good, reflog_entries: 2 },
    { ...good, reflog_entries: 0 },
  ]) {
    assert.ok(postCasErrors(state(), bad).some((entry) => entry.reason === "post_cas_mismatch"));
  }
});

test("a crash after the PASS resumes without another model run", () => {
  // Re-running a model there would produce different bytes and quietly discard
  // an approval that was about the old ones.
  assert.equal(resumePlan(state({ phase: "aggregate_verified" })).requires_model_run, false);
  assert.equal(resumePlan(state({ phase: "accepted" })).requires_model_run, false);
  assert.equal(resumePlan(state({ phase: "tickets_applied" })).requires_model_run, true);
  assert.equal(resumePlan(state({ phase: "post_cas_verified" })).next_phase, "complete");
  assert.equal(resumePlan(state({ phase: "accepted" })).next_phase, "target_advanced");
  assert.throws(() => resumePlan(state({ phase: "somewhere" })), code("aggregate_binding_void"));
  assert.equal(PHASES.length, 6);
});

test("an integration fix is a Ticket, not a patch under someone else's approval", () => {
  const parent = { ticket_id: "T-102" };
  assert.deepEqual(
    integrationFixErrors(
      {
        ticket_id: "T-150",
        acceptance_criteria: ["the two Tickets no longer regress together"],
        manifest_overlay: "overlay-3",
      },
      parent,
    ),
    [],
  );
  assert.ok(integrationFixErrors({ ticket_id: "T-102", acceptance_criteria: ["x"], manifest_overlay: "o" }, parent).length > 0);
  assert.ok(integrationFixErrors({ ticket_id: "T-150", manifest_overlay: "o" }, parent).length > 0);
  assert.ok(integrationFixErrors({ ticket_id: "T-150", acceptance_criteria: ["x"] }, parent).length > 0);
  assert.ok(
    integrationFixErrors(
      { ticket_id: "T-150", acceptance_criteria: ["x"], manifest_overlay: "o", reused_approval_of: "T-102" },
      parent,
    ).some((entry) => entry.reason === "acceptance_stale"),
  );
});

test("every park reason the contract closes can be produced", () => {
  const produced = new Set();
  const collect = (errors) => {
    for (const error of errors) produced.add(error.reason);
  };
  collect(aggregateErrors(state({ aggregate: { outcome: "fail" } })));
  collect(aggregateErrors(state({ aggregate: { outcome: "fail", environment_outcome: "environment_failure" } })));
  collect(aggregateErrors({ ...state(), staging_commit_oid: oid("9") }));
  collect(receiptErrors(state({ receipts: [] }), TICKETS));
  const noAcceptance = state();
  delete noAcceptance.acceptance;
  collect(acceptanceErrors(noAcceptance));
  const stale = state();
  stale.acceptance = { ...stale.acceptance, staging_tree_oid: oid("9") };
  collect(acceptanceErrors(stale));
  collect(casAdmission(state(), { oid: oid("f") }, TICKETS).reasons);
  collect(casAdmission(state(), { oid: oid("f"), attributed_to_this_epic: true }, TICKETS).reasons);
  const conflict = applySwap(state(), {
    expected_old_oid: oid("a"),
    observed_old_oid: oid("f"),
    swapped: false,
  });
  produced.add(conflict.reason);
  collect(postCasErrors(state(), { oid: oid("9"), tree_oid: oid("d"), contains_recorded_result: true, reflog_entries: 1 }));
  for (const reason of PARK_REASONS) {
    assert.ok(produced.has(reason), `${reason} is documented and never produced`);
  }
});
