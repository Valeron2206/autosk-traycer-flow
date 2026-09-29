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
  aggregateErrors,
  aggregateRecordHash,
  applySwap,
  casAdmission,
  integrationAuthorizationHash,
  integrationFixErrors,
  postCasErrors,
  receiptErrors,
  resumePlan,
} from "../src/host/epic-staging.mjs";
import * as stagingModule from "../src/host/epic-staging.mjs";

const code = (name) => (error) => error.code === name;

const oid = (char) => char.repeat(40);

/**
 * The IntegrationAuthorizationRecord the fixture's acceptance stands on
 * (debt 11b): the one transition from the recorded base to the staging commit,
 * the accepted tree, active until after NOW.
 */
const AUTHORIZATION = Object.freeze({
  schema_version: 1,
  record_id: "iar-1",
  scope_id: "epic:epic-store-lock",
  project_root_sha256: "0".repeat(64),
  epic_id: "epic-store-lock",
  run_id: "run-1",
  target_ref: "refs/heads/main",
  initial_target_oid: oid("a"),
  ordered_ticket_commit_oids: [oid("1"), oid("2")],
  ref_transition: { from_oid: oid("a"), to_oid: oid("c") },
  final_tree_oid: oid("d"),
  integration_plan_hash: "7".repeat(64),
  controlling_anchor_digest: "8".repeat(64),
  classifier_proof_hash: "9".repeat(64),
  relevant_authority_projection_hash: "a".repeat(64),
  dependency_head_hash: "b".repeat(64),
  intent_head_hash: "c".repeat(64),
  previous_authorization_head_hash: null,
  expires_at: "2026-09-10T00:00:00Z",
  terminal_disposition: "active",
  issued_by: "user_decision_record",
  user_decision_record_id: "udr-1",
  user_decision_record_hash: "e".repeat(64),
});
const NOW = Date.parse("2026-09-09T00:00:00Z");

/**
 * An accepted staging state that may swap: two receipted Tickets, the
 * schema's aggregate record named by its digest, and a human acceptance of
 * this identity standing on AUTHORIZATION. `overrides` replaces fields of the
 * state, and of the aggregate record before it is hashed.
 */
function state(overrides = {}) {
  const base = {
    schema_version: 1,
    project_identity: "sha256:" + "0".repeat(64),
    epic_id: "epic-store-lock",
    staging_ref: "refs/autosk/epics/99c55ae33e0e1f6a1c0edc3c39ba418dc23542a2b8a32e635ddb5e394539e6bd/staging", // epicRefKey("0".repeat(64), "epic-store-lock")
    target_ref: "refs/heads/main",
    recorded_target_base: oid("a"),
    planning_head: oid("b"),
    receipts: [
      { ticket_id: "T-101", delta_digest: "1".repeat(64), applied_commit_oid: oid("1") },
      { ticket_id: "T-102", delta_digest: "2".repeat(64), applied_commit_oid: oid("2") },
    ],
    phase: "aggregate_verified",
    staging_commit_oid: oid("c"),
    staging_tree_oid: oid("d"),
    post_cas: { expected_new_oid: oid("c") },
    ...overrides,
  };
  // The record the staging schema closes, named by the digest of its fields
  // and this Epic (debt 11e, ADR-099).
  const aggregate = {
    outcome: "pass",
    environment_outcome: "ok",
    verification_config_digest: "3".repeat(64),
    instruction_lock_digest: "4".repeat(64),
    staging_commit_oid: base.staging_commit_oid,
    staging_tree_oid: base.staging_tree_oid,
    included_tickets: [...new Set(base.receipts.map((receipt) => receipt.ticket_id))].sort(),
    ...overrides.aggregate,
  };
  base.aggregate = { ...aggregate, record_hash: aggregateRecordHash(base, aggregate) };
  if (overrides.aggregate?.record_hash) base.aggregate.record_hash = overrides.aggregate.record_hash;
  base.acceptance = overrides.acceptance ?? {
    kind: "human",
    decision_id: "dec-1",
    staging_commit_oid: base.staging_commit_oid,
    staging_tree_oid: base.staging_tree_oid,
    aggregate_record_hash: base.aggregate.record_hash,
    included_tickets: ["T-101", "T-102"],
    target_ref: base.target_ref,
    recorded_target_base: base.recorded_target_base,
    delivery_profile_digest: "6".repeat(64),
    delivery_mode: "merge",
    integration_authorization_id: AUTHORIZATION.record_id,
    integration_authorization_sha256: integrationAuthorizationHash(AUTHORIZATION),
  };
  return base;
}

const TICKETS = ["T-101", "T-102"];

// The delivery profile in force now. An acceptance of another profile is an
// acceptance of another delivery.
// The CAS names the record it runs under and the instant it is asked at (debt 11b).
const CURRENT = Object.freeze({ deliveryProfileDigest: "6".repeat(64), authorization: AUTHORIZATION, nowMs: NOW });

test("a complete, accepted staging may swap", () => {
  const outcome = casAdmission(state(), { oid: oid("a") }, TICKETS, CURRENT);
  assert.equal(outcome.decision, "may_swap");
  assert.deepEqual(outcome.reasons, []);
});

test("the target does not move before aggregate PASS and acceptance", () => {
  const noAggregate = casAdmission(state({ aggregate: { outcome: "fail" } }), { oid: oid("a") }, TICKETS, CURRENT);
  assert.equal(noAggregate.decision, "refused");
  assert.ok(noAggregate.reasons.some((entry) => entry.reason === "aggregate_failed"));

  const unaccepted = state();
  delete unaccepted.acceptance;
  const outcome = casAdmission(unaccepted, { oid: oid("a") }, TICKETS, CURRENT);
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
  // The binding is the record's hash (debt 11e, ADR-099): a record whose
  // configuration or lock is not the one it was hashed with is void.
  const original = state();
  assert.deepEqual(aggregateErrors(original), []);
  for (const field of ["verification_config_digest", "instruction_lock_digest"]) {
    const changed = { ...original, aggregate: { ...original.aggregate, [field]: "9".repeat(64) } };
    assert.notEqual(aggregateRecordHash(changed, changed.aggregate), original.aggregate.record_hash);
    assert.ok(aggregateErrors(changed).some((entry) => entry.reason === "aggregate_binding_void"), field);
  }
  // ...and the Ticket set, so a delta added afterwards is a different subject.
  const extra = { ...original, receipts: [...original.receipts, { ticket_id: "T-103" }] };
  assert.ok(aggregateErrors(extra).some((entry) => entry.reason === "aggregate_binding_void"));
  // ...and the tree, which a moved staging commit need not change.
  const retreed = { ...original, staging_tree_oid: oid("9") };
  assert.deepEqual(aggregateErrors(retreed).map((entry) => entry.reason), ["aggregate_binding_void"]);
});

test("every applied Ticket leaves a receipt", () => {
  assert.deepEqual(receiptErrors(state(), TICKETS), []);
  const missing = receiptErrors(state({ receipts: [{ ticket_id: "T-101" }] }), TICKETS);
  assert.deepEqual(missing, [{ reason: "receipt_missing", detail: "T-102" }]);
});

test("acceptance is of an identity, and a moved tree makes it stale", () => {
  const drifted = state();
  drifted.acceptance = { ...drifted.acceptance, staging_tree_oid: oid("9") };
  assert.ok(acceptanceErrors(drifted, CURRENT).some((entry) => entry.reason === "acceptance_stale"));

  const otherAggregate = state();
  otherAggregate.acceptance = { ...otherAggregate.acceptance, aggregate_record_hash: "9".repeat(64) };
  assert.ok(acceptanceErrors(otherAggregate, CURRENT).some((entry) => entry.reason === "acceptance_stale"));

  const otherTickets = state();
  otherTickets.acceptance = { ...otherTickets.acceptance, included_tickets: ["T-101"] };
  assert.ok(acceptanceErrors(otherTickets, CURRENT).some((entry) => entry.reason === "acceptance_stale"));
});

test("a pinned auto-policy is held to the same binding as a person", () => {
  const auto = state();
  auto.acceptance = { ...auto.acceptance, kind: "pinned_auto_policy", decision_id: undefined, policy_ref: "policy-7" };
  assert.deepEqual(acceptanceErrors(auto, CURRENT), []);
  const unpinned = state();
  unpinned.acceptance = { ...unpinned.acceptance, kind: "pinned_auto_policy", decision_id: undefined };
  assert.ok(acceptanceErrors(unpinned, CURRENT).some((entry) => entry.reason === "acceptance_missing"));
  const anonymous = state();
  anonymous.acceptance = { ...anonymous.acceptance, decision_id: undefined };
  assert.ok(acceptanceErrors(anonymous, CURRENT).some((entry) => entry.reason === "acceptance_missing"));
});

test("a target that moved is a foreign movement, and the ref is not touched", () => {
  // Overwriting it is the one outcome that cannot be undone by retrying.
  const outcome = casAdmission(state(), { oid: oid("f") }, TICKETS, CURRENT);
  assert.equal(outcome.decision, "refused");
  assert.ok(outcome.reasons.some((entry) => entry.reason === "foreign_target_movement"));
});

test("every movement of the target off its recorded base is foreign, and no caller's flag makes one this Epic's (R7-16)", () => {
  // Round 7 of #39, R7-16: under the one CAS (ADR-088) this Epic moves the
  // target once, and its own result reads already_complete before anything
  // else; target_moved was chosen by a flag the caller handed in, for the
  // per-Ticket movements ADR-088 removed. Another Epic's landing, a rewind
  // and someone else's commit are all movements this Epic did not make.
  assert.ok(!PARK_REASONS.includes("target_moved"));
  for (const observed of [{ oid: oid("f") }, { oid: oid("f"), attributed_to_this_epic: true }, { oid: oid("9"), attributed_to_this_epic: false }]) {
    const outcome = casAdmission(state(), observed, TICKETS, CURRENT);
    assert.equal(outcome.decision, "refused");
    assert.deepEqual(
      outcome.reasons.filter((entry) => entry.reason.includes("target")).map((entry) => entry.reason),
      ["foreign_target_movement"],
      JSON.stringify(observed),
    );
  }
  // This Epic's own result is the completed CAS, whatever the flag says.
  assert.equal(casAdmission(state(), { oid: oid("c"), attributed_to_this_epic: false }, TICKETS, CURRENT).decision, "already_complete");
});

test("the swap can still conflict, because the world moves between read and write", () => {
  // Which is precisely why the write is a compare-and-swap and not a write.
  assert.deepEqual(
    applySwap(state(), { expected_old_oid: oid("a"), swapped: true, new_oid: oid("c") }),
    { outcome: "swapped", new_oid: oid("c") },
  );
  const conflict = applySwap(state(), { expected_old_oid: oid("a"), observed_old_oid: oid("f"), swapped: false });
  assert.equal(conflict.reason, "cas_conflict");
  // A CAS that already ran from a base the record does not name is not a request the host formed wrongly: it is a result, and a
  // moved target nobody has investigated (review M2, ADR-109). It is reported as the conflict the graph's row for cas_conflict
  // carries, never thrown past the step, and the two cases are told apart: a swap that landed overwrote the target and names the
  // commit to restore; one git refused moved nothing and names what the ref held (review N5).
  const landed = applySwap(state(), { expected_old_oid: oid("9"), swapped: true, new_oid: oid("c") });
  assert.deepEqual({ ...landed }, {
    outcome: "conflict",
    reason: "cas_conflict",
    cause: "swapped_from_unrecorded_base",
    landed: true,
    restore_to: oid("9"),
    detail: `the swap landed from ${oid("9")}, and the record names ${oid("a")}: the target was overwritten and ${oid("9")} is to be restored`,
  });
  const refused = applySwap(state(), { expected_old_oid: oid("9"), swapped: false, new_oid: oid("c"), observed_old_oid: oid("f") });
  assert.deepEqual({ ...refused }, {
    outcome: "conflict",
    reason: "cas_conflict",
    cause: "refused_from_unrecorded_base",
    landed: false,
    observed_old_oid: oid("f"),
    detail: `git refused a swap made from ${oid("9")}, and the record names ${oid("a")}; the ref held ${oid("f")}`,
  });
  // The success flag of the swap's own record is a boolean, and the input is checked rather than read as it happens to be.
  assert.throws(() => applySwap(state(), { expected_old_oid: oid("9"), swapped: 1 }), (error) => error.code === "custody_request_invalid");
  assert.throws(() => applySwap({}, { expected_old_oid: oid("a"), swapped: true }), (error) => error.code === "custody_request_invalid");
  assert.throws(() => applySwap(state(), {}), (error) => error.code === "custody_request_invalid");
});

test("a swap is requested only from the base the record names: any other expected-old is a request the host cannot form, before git is asked (review M2)", () => {
  assert.doesNotThrow(() => stagingModule.assertSwapRequest(state(), { expectedOld: oid("a") }));
  for (const expectedOld of [oid("9"), null, undefined, ""]) {
    assert.throws(() => stagingModule.assertSwapRequest(state(), { expectedOld }), (error) => error.code === "custody_request_invalid", String(expectedOld));
  }
});

test("a retry of the final CAS is idempotent", () => {
  // If the target already holds the recorded result, the operation is complete
  // rather than in conflict.
  const outcome = casAdmission(state(), { oid: oid("c") }, TICKETS, CURRENT);
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
  assert.equal(resumePlan(state({ phase: "deltas_applied" })).requires_model_run, true);
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
  collect(acceptanceErrors(noAcceptance, CURRENT));
  const stale = state();
  stale.acceptance = { ...stale.acceptance, staging_tree_oid: oid("9") };
  collect(acceptanceErrors(stale, CURRENT));
  collect(casAdmission(state(), { oid: oid("f") }, TICKETS, CURRENT).reasons);
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

test("the phases are the staging record's phases", async () => {
  // One name per phase: the record, its validator and the resume plan agree.
  const { PHASES: RECORDED } = await import("../scripts/validate-epic-staging.mjs");
  assert.deepEqual([...PHASES], [...RECORDED]);
});

test("the acceptance names the target, its base and the delivery profile in force", () => {
  // R6-6, cond_434: an acceptance naming another target ref, base or profile
  // digest is stale, whoever gave it.
  for (const [field, value] of [
    ["target_ref", "refs/heads/release"],
    ["recorded_target_base", oid("9")],
    ["delivery_profile_digest", "9".repeat(64)],
  ]) {
    const moved = state();
    moved.acceptance = { ...moved.acceptance, [field]: value };
    assert.deepEqual(acceptanceErrors(moved, CURRENT).map((entry) => entry.reason), ["acceptance_stale"], field);
  }
  // A profile that changed after the acceptance makes it stale too, and a CAS
  // asked without saying which profile is in force is not admitted.
  assert.deepEqual(
    acceptanceErrors(state(), { ...CURRENT, deliveryProfileDigest: "9".repeat(64) }).map((entry) => entry.reason),
    ["acceptance_stale"],
  );
  assert.equal(casAdmission(state(), { oid: oid("a") }, TICKETS).decision, "refused");
  assert.equal(casAdmission(state(), { oid: oid("a") }, TICKETS, CURRENT).decision, "may_swap");
});

test("an acceptance is by a person or by a pinned auto-policy, and says which", () => {
  for (const kind of ["auto_policy", "someone", undefined]) {
    const other = state();
    other.acceptance = { ...other.acceptance, kind, policy_ref: "policy-7" };
    assert.deepEqual(acceptanceErrors(other, CURRENT).map((entry) => entry.reason), ["acceptance_missing"], String(kind));
  }
  const emptyDecision = state();
  emptyDecision.acceptance = { ...emptyDecision.acceptance, decision_id: "" };
  assert.deepEqual(acceptanceErrors(emptyDecision, CURRENT).map((entry) => entry.reason), ["acceptance_missing"]);
  const emptyPolicy = state();
  emptyPolicy.acceptance = { ...emptyPolicy.acceptance, kind: "pinned_auto_policy", decision_id: undefined, policy_ref: "" };
  assert.deepEqual(acceptanceErrors(emptyPolicy, CURRENT).map((entry) => entry.reason), ["acceptance_missing"]);
});

test("under squash the acceptance names the commit that lands, and only then", () => {
  // Under squash the record's one transition ends at the squash commit (debt 11b).
  const squashRecord = { ...AUTHORIZATION, ref_transition: { from_oid: oid("a"), to_oid: oid("7") } };
  const squash = (extra) => {
    const value = state();
    value.acceptance = {
      ...value.acceptance,
      delivery_mode: "squash",
      integration_authorization_sha256: integrationAuthorizationHash(squashRecord),
      ...extra,
    };
    return value;
  };
  const SQUASH = { ...CURRENT, authorization: squashRecord };
  const commit = { target_commit_oid: oid("7"), target_commit_recipe_sha256: "8".repeat(64) };
  assert.deepEqual(acceptanceErrors(squash(commit), SQUASH), []);
  for (const extra of [
    {},
    { target_commit_oid: oid("7") },
    { target_commit_recipe_sha256: "8".repeat(64) },
    { ...commit, target_commit_oid: "7" },
    { ...commit, target_commit_recipe_sha256: "8" },
  ]) {
    // `target_commit_oid` is the record's end too, so a missing or malformed
    // one is also a record for another transition.
    const expected = extra.target_commit_oid === oid("7") ? ["acceptance_missing"] : ["acceptance_missing", "acceptance_stale"];
    assert.deepEqual(acceptanceErrors(squash(extra), SQUASH).map((entry) => entry.reason), expected, JSON.stringify(extra));
  }
  for (const extra of [commit, { target_commit_oid: oid("7") }, { target_commit_recipe_sha256: "8".repeat(64) }]) {
    const merge = state();
    merge.acceptance = { ...merge.acceptance, ...extra };
    assert.deepEqual(acceptanceErrors(merge, CURRENT).map((entry) => entry.reason), ["acceptance_missing"], JSON.stringify(extra));
  }
  for (const mode of ["force_push", undefined]) {
    const unknown = state();
    unknown.acceptance = { ...unknown.acceptance, delivery_mode: mode };
    assert.deepEqual(acceptanceErrors(unknown, CURRENT).map((entry) => entry.reason), ["acceptance_missing"], String(mode));
  }
});

test("a profile digest missing on either side is a missing acceptance, not a match (review M1)", () => {
  // undefined === undefined would admit a record with no profile when the
  // caller named none either.
  const noProfile = state();
  noProfile.acceptance = { ...noProfile.acceptance, delivery_profile_digest: undefined };
  for (const current of [{}, CURRENT, { deliveryProfileDigest: "6" }]) {
    assert.ok(acceptanceErrors(noProfile, current).some((entry) => entry.reason === "acceptance_missing"), JSON.stringify(current));
  }
  assert.equal(casAdmission(noProfile, { oid: oid("a") }, TICKETS).decision, "refused");
  assert.ok(casAdmission(noProfile, { oid: oid("a") }, TICKETS).reasons.some((entry) => entry.reason === "acceptance_missing"));
  const shortProfile = state();
  shortProfile.acceptance = { ...shortProfile.acceptance, delivery_profile_digest: "6" };
  assert.deepEqual(acceptanceErrors(shortProfile, { ...CURRENT, deliveryProfileDigest: "6" }).map((entry) => entry.reason), ["acceptance_missing"]);
  // The profile in force missing, or not a digest, is missing too.
  for (const current of [{ ...CURRENT, deliveryProfileDigest: undefined }, { ...CURRENT, deliveryProfileDigest: "6".repeat(63) }, { ...CURRENT, deliveryProfileDigest: 6 }]) {
    assert.deepEqual(acceptanceErrors(state(), current).map((entry) => entry.reason), ["acceptance_missing"], JSON.stringify(current));
  }
});

test("an acceptance names its target ref and base, not only fails to differ (review L3)", () => {
  for (const field of ["target_ref", "recorded_target_base"]) {
    const missing = state();
    missing.acceptance = { ...missing.acceptance, [field]: undefined };
    assert.deepEqual(acceptanceErrors(missing, CURRENT).map((entry) => entry.reason), ["acceptance_missing"], field);
    const bare = state({ [field]: undefined });
    bare.acceptance = { ...bare.acceptance, [field]: undefined };
    // The record still names the target and base, so it is for another
    // transition than the (absent) one (debt 11b).
    assert.deepEqual(acceptanceErrors(bare, CURRENT).map((entry) => entry.reason), ["acceptance_missing", "acceptance_stale"], `${field} absent on both sides`);
  }
});

test("an acceptance names the IntegrationAuthorizationRecord it stands on, and the CAS runs only under that record (debt 11b, R7-2)", () => {
  const reasons = (acceptanceChange = {}, current = CURRENT) => {
    const accepted = state();
    accepted.acceptance = { ...accepted.acceptance, ...acceptanceChange };
    for (const [field, value] of Object.entries(acceptanceChange)) if (value === undefined) delete accepted.acceptance[field];
    return acceptanceErrors(accepted, current).map((entry) => entry.reason);
  };
  assert.deepEqual(reasons(), []);
  // Before debt 11b a human acceptance was admitted on any non-empty decision_id.
  assert.deepEqual(reasons({ decision_id: "anything", integration_authorization_id: undefined, integration_authorization_sha256: undefined }), ["acceptance_missing"]);
  assert.deepEqual(reasons({ integration_authorization_id: "" }), ["acceptance_missing"]);
  assert.deepEqual(reasons({ integration_authorization_sha256: "e".repeat(63) }), ["acceptance_missing"]);
  // The pinned auto-policy is held to the same reference.
  assert.deepEqual(reasons({ kind: "pinned_auto_policy", decision_id: undefined, policy_ref: "p-1" }), []);
  assert.deepEqual(reasons({ kind: "pinned_auto_policy", decision_id: undefined, policy_ref: "p-1", integration_authorization_sha256: undefined }), ["acceptance_missing"]);
  // No record presented, or another record than the one named.
  assert.deepEqual(reasons({}, { ...CURRENT, authorization: undefined }), ["acceptance_missing"]);
  assert.deepEqual(reasons({}, { ...CURRENT, authorization: "iar-1" }), ["acceptance_missing"]);
  // The same record, rewritten since the acceptance named it — revoked,
  // replaced, or any other byte — is stale, not missing (review M1).
  assert.deepEqual(reasons({}, { ...CURRENT, authorization: { ...AUTHORIZATION, run_id: "run-2" } }), ["acceptance_stale"]);
  assert.deepEqual(reasons({}, { ...CURRENT, authorization: { ...AUTHORIZATION, terminal_disposition: "revoked" } }), ["acceptance_stale"]);
  assert.deepEqual(reasons({}, { ...CURRENT, authorization: { ...AUTHORIZATION, terminal_disposition: "replaced" } }), ["acceptance_stale"]);
  assert.deepEqual(reasons({ integration_authorization_id: "iar-2" }), ["acceptance_missing"]);
  // An empty id names no record, even beside a record whose id is empty too.
  const unnamed = { ...AUTHORIZATION, record_id: "" };
  assert.deepEqual(reasons({ integration_authorization_id: "", integration_authorization_sha256: integrationAuthorizationHash(unnamed) }, { ...CURRENT, authorization: unnamed }), ["acceptance_missing"]);
  assert.deepEqual(reasons({ integration_authorization_sha256: "E".repeat(64) }, { ...CURRENT, authorization: AUTHORIZATION }), ["acceptance_missing"]);
  // The record named, but about another transition, tree, target or Epic.
  const other = (change) => {
    const record = { ...AUTHORIZATION, ...change };
    return reasons({ integration_authorization_id: record.record_id, integration_authorization_sha256: integrationAuthorizationHash(record) }, { ...CURRENT, authorization: record });
  };
  assert.deepEqual(other({}), []);
  for (const change of [
    { ref_transition: { from_oid: oid("9"), to_oid: oid("c") } },
    { ref_transition: { from_oid: oid("a"), to_oid: oid("9") } },
    { ref_transition: null },
    { final_tree_oid: oid("9") },
    { target_ref: "refs/heads/other" },
    { epic_id: "epic-other" },
    // Re-checked against the state at the CAS, not only when the acceptance was made (review L2).
    { initial_target_oid: oid("9") },
    { ordered_ticket_commit_oids: [oid("2"), oid("1")] },
    { ordered_ticket_commit_oids: [oid("1")] },
    { project_root_sha256: "9".repeat(64) },
    { scope_id: "epic:epic-other" },
    // Terminal, or expired by the instant the CAS is asked at.
    { terminal_disposition: "revoked" },
    { terminal_disposition: "replaced" },
    { expires_at: "2026-09-09T00:00:00Z" },
  ]) {
    assert.deepEqual(other(change), ["acceptance_stale"], JSON.stringify(change));
  }
  assert.deepEqual(other({ expires_at: "2026-09-09T00:00:00.001Z" }), []);
  // Asked with no instant, the CAS has not said when it is asked (review L1).
  for (const nowMs of [undefined, Number.NaN, Number.POSITIVE_INFINITY, "2026-09-09"]) {
    assert.deepEqual(reasons({}, { ...CURRENT, nowMs }), ["acceptance_missing"], String(nowMs));
  }
  // Under squash the transition ends at the squash commit the acceptance names.
  const squashRecord = { ...AUTHORIZATION, ref_transition: { from_oid: oid("a"), to_oid: oid("7") } };
  const squash = {
    delivery_mode: "squash",
    target_commit_oid: oid("7"),
    target_commit_recipe_sha256: "6".repeat(64),
    integration_authorization_sha256: integrationAuthorizationHash(squashRecord),
  };
  assert.deepEqual(reasons(squash, { ...CURRENT, authorization: squashRecord }), []);
  assert.deepEqual(reasons({ ...squash, integration_authorization_sha256: integrationAuthorizationHash(AUTHORIZATION) }), ["acceptance_stale"]);
  // And through the CAS admission.
  const forged = state();
  forged.acceptance = { ...forged.acceptance, decision_id: "anything" };
  delete forged.acceptance.integration_authorization_id;
  assert.equal(casAdmission(forged, { oid: oid("a") }, TICKETS, CURRENT).decision, "refused");
});

test("the record's digest is domain-separated over every field (debt 11b)", async () => {
  const { digest } = await import("../src/runtime/contracts.mjs");
  assert.equal(integrationAuthorizationHash(AUTHORIZATION), digest("autosk-flow/integration-authorization-record/v1", AUTHORIZATION));
  assert.notEqual(integrationAuthorizationHash({ ...AUTHORIZATION, user_decision_record_hash: "f".repeat(64) }), integrationAuthorizationHash(AUTHORIZATION));
});

// --- debt 11d: one object format ----------------------------------------------

test("at the CAS a SHA-256 Epic may swap, and a squash commit of another object format is not the commit that lands (debt 11d)", () => {
  // ADR-098: an OID is 40 hex (sha1) or 64 (sha256), and a repository has one
  // format. The CAS compares the acceptance's staging commit, tree and base
  // with the staging state; its squash commit it compares only with the
  // record, so that one is held to the base's format here, as the delivered
  // commit is in deliveryCompleted.
  const wide = (char) => char.repeat(64);
  const record = {
    ...AUTHORIZATION,
    initial_target_oid: wide("a"),
    ordered_ticket_commit_oids: [wide("1"), wide("2")],
    ref_transition: { from_oid: wide("a"), to_oid: wide("c") },
    final_tree_oid: wide("d"),
  };
  const sha256 = state({
    recorded_target_base: wide("a"),
    planning_head: wide("b"),
    receipts: [
      { ticket_id: "T-101", delta_digest: "1".repeat(64), applied_commit_oid: wide("1") },
      { ticket_id: "T-102", delta_digest: "2".repeat(64), applied_commit_oid: wide("2") },
    ],
    staging_commit_oid: wide("c"),
    staging_tree_oid: wide("d"),
    post_cas: { expected_new_oid: wide("c") },
  });
  sha256.acceptance = { ...sha256.acceptance, integration_authorization_sha256: integrationAuthorizationHash(record) };
  const outcome = casAdmission(sha256, { oid: wide("a") }, TICKETS, { ...CURRENT, authorization: record });
  assert.deepEqual({ decision: outcome.decision, reasons: [...outcome.reasons] }, { decision: "may_swap", reasons: [] });

  // Under squash: the record ends at the squash commit the acceptance names.
  const squash = (current, commit, authorization) => {
    const value = structuredClone(current);
    const landing = { ...authorization, ref_transition: { ...authorization.ref_transition, to_oid: commit } };
    value.acceptance = {
      ...value.acceptance,
      delivery_mode: "squash",
      target_commit_oid: commit,
      target_commit_recipe_sha256: "8".repeat(64),
      integration_authorization_sha256: integrationAuthorizationHash(landing),
    };
    return [value, { ...CURRENT, authorization: landing }];
  };
  assert.deepEqual(acceptanceErrors(...squash(sha256, wide("7"), record)), []);
  assert.deepEqual(acceptanceErrors(...squash(state(), oid("7"), AUTHORIZATION)), []);
  for (const [current, commit, authorization] of [[state(), wide("7"), AUTHORIZATION], [sha256, oid("7"), record]]) {
    assert.deepEqual(acceptanceErrors(...squash(current, commit, authorization)).map((entry) => entry.reason), ["acceptance_missing"], commit);
  }
});

test("at the CAS an accepted staging state whose OIDs are of two object formats is refused, whatever the mode (review L1)", () => {
  // ADR-098: the acceptance identity refuses a state whose base, staging
  // commit and tree and applied commits are of two formats; the CAS admission
  // held only the squash commit to the base's format, so a mixed state under
  // merge, with an acceptance and a record that agree with it, was admitted.
  const wide = (char) => char.repeat(64);
  const mixed = (overrides) => {
    const value = state(overrides);
    const record = {
      ...AUTHORIZATION,
      initial_target_oid: value.recorded_target_base,
      ordered_ticket_commit_oids: value.receipts.map((receipt) => receipt.applied_commit_oid),
      ref_transition: { from_oid: value.recorded_target_base, to_oid: value.staging_commit_oid },
      final_tree_oid: value.staging_tree_oid,
    };
    value.acceptance = { ...value.acceptance, integration_authorization_sha256: integrationAuthorizationHash(record) };
    return [value, { ...CURRENT, authorization: record }];
  };
  const receipts = (first, second) => [
    { ticket_id: "T-101", delta_digest: "1".repeat(64), applied_commit_oid: first },
    { ticket_id: "T-102", delta_digest: "2".repeat(64), applied_commit_oid: second },
  ];
  // The probe agrees with itself in one format: admitted.
  const [one, oneCurrent] = mixed({});
  assert.equal(casAdmission(one, { oid: one.recorded_target_base }, TICKETS, oneCurrent).decision, "may_swap");
  for (const [label, overrides] of [
    ["staging commit", { staging_commit_oid: wide("c"), post_cas: { expected_new_oid: wide("c") } }],
    ["staging tree", { staging_tree_oid: wide("d") }],
    ["applied commit", { receipts: receipts(oid("1"), wide("2")) }],
    ["base of a SHA-256 Epic", {
      recorded_target_base: oid("a"),
      staging_commit_oid: wide("c"),
      staging_tree_oid: wide("d"),
      receipts: receipts(wide("1"), wide("2")),
      post_cas: { expected_new_oid: wide("c") },
    }],
  ]) {
    const [value, current] = mixed(overrides);
    assert.deepEqual(acceptanceErrors(value, current).map((entry) => entry.reason), ["acceptance_missing"], label);
    const outcome = casAdmission(value, { oid: value.recorded_target_base }, TICKETS, current);
    assert.equal(outcome.decision, "refused", label);
    assert.deepEqual(outcome.reasons.map((entry) => entry.reason), ["acceptance_missing"], label);
  }
  // A receipt that names no commit adds no format, as in the identity; the
  // record, which binds the commits, is compared with the receipts as before.
  const unapplied = state({ receipts: [receipts(oid("1"))[0], { ticket_id: "T-102", delta_digest: "2".repeat(64) }] });
  assert.deepEqual(acceptanceErrors(unapplied, CURRENT).map((entry) => entry.reason), ["acceptance_stale"]);
});

test("the Ticket set is a set everywhere: a repeated receipt makes no fresh acceptance stale, and the receipts refuse it by name (review L3)", () => {
  // Review of 11e, L3: the aggregate compared sets, acceptanceErrors
  // multisets and acceptanceFacts wrote a set, so a Ticket with two receipts
  // passed the aggregate check and made an acceptance given for the set stale
  // from the start. A repeat is not a second fact (ADR-089), and a Ticket
  // with two receipts is refused where the receipts are checked.
  const doubled = state({
    receipts: [
      { ticket_id: "T-101", delta_digest: "1".repeat(64), applied_commit_oid: oid("1") },
      { ticket_id: "T-102", delta_digest: "2".repeat(64), applied_commit_oid: oid("2") },
      { ticket_id: "T-102", delta_digest: "2".repeat(64), applied_commit_oid: oid("2") },
    ],
  });
  const ticketSet = (errors) => errors.filter((entry) => entry.detail === "the accepted Ticket set is not the included one");
  assert.deepEqual(ticketSet(acceptanceErrors(doubled, CURRENT)), []);
  assert.ok(!aggregateErrors(doubled).some((entry) => entry.reason === "aggregate_binding_void"));
  const repeated = receiptErrors(doubled, TICKETS);
  assert.deepEqual(repeated, [{ reason: "receipt_missing", detail: "T-102 has more than one integration receipt" }]);
  // And the CAS is refused on it.
  const admission = casAdmission(doubled, { oid: oid("a") }, TICKETS, CURRENT);
  assert.equal(admission.decision, "refused");
  assert.ok(admission.reasons.some((entry) => entry.detail === "T-102 has more than one integration receipt"));
  // A missing Ticket is still refused, beside a repeated one.
  assert.deepEqual(receiptErrors(state({ receipts: [{ ticket_id: "T-101" }, { ticket_id: "T-101" }] }), TICKETS), [
    { reason: "receipt_missing", detail: "T-102" },
    { reason: "receipt_missing", detail: "T-101 has more than one integration receipt" },
  ]);
});

test("a swap request from another base says which base the record names and which was attempted, and an empty base is no base (debt 13a review M2)", () => {
  const error = (() => { try { stagingModule.assertSwapRequest(state(), { expectedOld: oid("9") }); } catch (thrown) { return thrown; } return null; })();
  assert.equal(error?.code, "custody_request_invalid");
  assert.equal(error.message, "The swap would be attempted against another base");
  assert.deepEqual(error.details, { expected: oid("a"), attempted: oid("9") });
  // Equal to the record's base is not enough when the record names none: an empty string is not an OID.
  assert.throws(() => stagingModule.assertSwapRequest(state({ recorded_target_base: "" }), { expectedOld: "" }), (thrown) => thrown.code === "custody_request_invalid");
  assert.throws(() => stagingModule.assertSwapRequest(state(), { expectedOld: 7 }), (thrown) => thrown.code === "custody_request_invalid");
});
