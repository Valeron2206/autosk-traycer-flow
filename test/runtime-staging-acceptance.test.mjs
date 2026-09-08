/**
 * Tests for accepting a staging identity through the decision queue
 * (issues #9 and #35).
 *
 * One sentence is being defended from both sides: acceptance is of an identity,
 * not of a plan to produce one. An answer that arrives after the tree moved is
 * an answer to a different question, and a pinned auto-policy is held to the
 * same binding as a person.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { acceptanceErrors, aggregateBinding, casAdmission } from "../src/host/epic-staging.mjs";
import {
  REQUIRED_FACTS,
  acceptanceFromDecision,
  acceptancePacket,
  autoPolicyAcceptance,
  openAcceptance,
  stagingIdentity,
} from "../src/host/staging-acceptance.mjs";

const code = (name) => (error) => error.code === name;
const NOW = Date.parse("2026-09-09T10:00:00Z");
const oid = (char) => char.repeat(40);

function state(overrides = {}) {
  const base = {
    project_identity: `sha256:${"0".repeat(58)}`,
    epic_id: "e-1",
    staging_ref: "refs/autosk/epics/e-1/staging",
    target_ref: "refs/heads/main",
    recorded_target_base: oid("a"),
    planning_head: oid("a"),
    receipts: [{ ticket_id: "T-1" }, { ticket_id: "T-2" }],
    phase: "accepted",
    staging_commit_oid: oid("b"),
    staging_tree_oid: oid("c"),
    post_cas: { expected_new_oid: oid("b") },
    ...overrides,
  };
  const aggregate = {
    outcome: "pass",
    environment_outcome: "ok",
    verification_config_digest: "c".repeat(64),
    instruction_lock_digest: "d".repeat(64),
    staging_commit_oid: base.staging_commit_oid,
    record_hash: "e".repeat(64),
  };
  base.aggregate = { ...aggregate, binding: aggregateBinding({ ...base, aggregate }) };
  return base;
}

const options = {
  requestId: "req-1",
  approver: "owner",
  expiresAt: "2026-09-10T10:00:00Z",
  anchorVersion: 3,
  deliveryProfileDigest: "f".repeat(64),
};

const answer = (current, overrides = {}) => ({
  option_id: "accept",
  answered_by: "owner",
  answered_at: "2026-09-09T10:05:00Z",
  identities: { anchor_version: 3, candidate: stagingIdentity(current) },
  ...overrides,
});

test("the packet states every fact an approval has to be about", () => {
  const packet = acceptancePacket(state(), options);
  for (const field of REQUIRED_FACTS) {
    assert.ok(packet.facts[field] !== undefined && packet.facts[field] !== null, field);
  }
  // Two options, each with its consequence: "approve?" with one button is not a
  // decision, and a refusal is a recorded state rather than a silence.
  assert.deepEqual(packet.options.map((option) => option.option_id), ["accept", "refuse"]);
  assert.equal(packet.flags.irreversible, true);
  assert.equal(packet.identities.candidate, stagingIdentity(state()));
  assert.deepEqual([...packet.facts.tickets], ["T-1", "T-2"]);
  assert.ok(openAcceptance(state(), options, { nowMs: NOW }));
});

test("a packet missing a load-bearing fact is not decidable", () => {
  assert.throws(() => acceptancePacket(state(), { ...options, deliveryProfileDigest: undefined }), code("acceptance_missing"));
  const noAggregate = state();
  delete noAggregate.aggregate;
  assert.throws(() => acceptancePacket(noAggregate, options), code("acceptance_missing"));
});

test("every load-bearing field is in the identity, so a move makes the approval stale", () => {
  const original = stagingIdentity(state());
  for (const [field, value] of [
    ["staging_commit_oid", oid("9")],
    ["staging_tree_oid", oid("8")],
    ["recorded_target_base", oid("7")],
    ["target_ref", "refs/heads/other"],
    ["epic_id", "e-2"],
    ["receipts", [{ ticket_id: "T-1" }]],
  ]) {
    assert.notEqual(stagingIdentity(state({ [field]: value })), original, field);
  }
  const movedAggregate = state();
  movedAggregate.aggregate = { ...movedAggregate.aggregate, record_hash: "9".repeat(64) };
  assert.notEqual(stagingIdentity(movedAggregate), original);
});

test("an accepted identity becomes the record the swap is admitted against", () => {
  const current = state();
  const packet = openAcceptance(current, options, { nowMs: NOW });
  const result = acceptanceFromDecision(current, packet, answer(current), { nowMs: NOW });
  assert.equal(result.outcome, "accepted");
  assert.equal(result.acceptance.kind, "human");
  assert.equal(result.acceptance.approver, "owner");
  assert.deepEqual(acceptanceErrors({ ...current, acceptance: result.acceptance }), []);
  // And with it the swap is admitted; without it, it is not.
  const accepted = { ...current, acceptance: result.acceptance };
  assert.equal(casAdmission(accepted, { oid: current.recorded_target_base }, ["T-1", "T-2"]).decision, "may_swap");
  const withoutAcceptance = { ...current };
  delete withoutAcceptance.acceptance;
  assert.equal(casAdmission(withoutAcceptance, { oid: current.recorded_target_base }, ["T-1"]).decision, "refused");
});

test("an answer that arrives after the tree moved is an answer to another question", () => {
  const asked = state();
  const packet = openAcceptance(asked, options, { nowMs: NOW });
  const moved = state({ staging_commit_oid: oid("9"), post_cas: { expected_new_oid: oid("9") } });

  // The queue refuses it, because the identity it was bound to is not the
  // identity now.
  assert.throws(
    () => acceptanceFromDecision(moved, packet, answer(moved), { nowMs: NOW }),
    code("decision_identity_stale"),
  );
  // And a replayed old answer cannot be applied to the new state either.
  assert.throws(
    () => acceptanceFromDecision(moved, packet, answer(asked), { nowMs: NOW }),
    code("acceptance_stale"),
  );
});

test("a refusal is a recorded outcome, and it produces no acceptance", () => {
  const current = state();
  const packet = openAcceptance(current, options, { nowMs: NOW });
  const result = acceptanceFromDecision(current, packet, answer(current, { option_id: "refuse" }), { nowMs: NOW });
  assert.equal(result.outcome, "refused");
  assert.equal(result.acceptance, undefined);
  assert.equal(result.decision.option_id, "refuse");
  assert.equal(result.request.state, "answered");
});

test("an answer from somebody else, or to an option nobody offered, is refused", () => {
  const current = state();
  const packet = openAcceptance(current, options, { nowMs: NOW });
  assert.throws(
    () => acceptanceFromDecision(current, packet, answer(current, { answered_by: "someone-else" }), { nowMs: NOW }),
    code("decision_approver_mismatch"),
  );
  assert.throws(
    () => acceptanceFromDecision(current, packet, answer(current, { option_id: "maybe" }), { nowMs: NOW }),
    code("decision_option_unknown"),
  );
  assert.throws(
    () => acceptanceFromDecision(current, packet, answer(current), { nowMs: Date.parse("2026-09-11T00:00:00Z") }),
    code("decision_expired"),
  );
});

test("a pinned auto-policy is held to the same binding as a person", () => {
  const current = state();
  const policy = { policy_ref: "policy-4", pinned_identity: stagingIdentity(current) };
  const acceptance = autoPolicyAcceptance(current, policy);
  assert.equal(acceptance.kind, "auto_policy");
  assert.deepEqual(acceptanceErrors({ ...current, acceptance }), []);

  // A policy that accepted an identity it never saw is not a policy, it is a
  // default.
  assert.throws(() => autoPolicyAcceptance(state({ staging_tree_oid: oid("9") }), policy), code("acceptance_stale"));
  assert.throws(() => autoPolicyAcceptance(current, { pinned_identity: policy.pinned_identity }), code("acceptance_missing"));
});

test("debt outside what the policy named is not something it agreed to", () => {
  const current = state();
  const policy = {
    policy_ref: "policy-4",
    pinned_identity: stagingIdentity(current),
    tolerated_debt: ["docs-todo"],
  };
  assert.ok(autoPolicyAcceptance(current, policy, { outstandingDebt: ["docs-todo"] }));
  assert.throws(
    () => autoPolicyAcceptance(current, policy, { outstandingDebt: ["docs-todo", "skipped-test"] }),
    code("acceptance_missing"),
  );
});

test("an identity cannot be computed from a state that has none", () => {
  // `stagingIdentity` is exported, and hashing an absent field would give two
  // different broken states one stable digest.
  for (const field of ["staging_commit_oid", "staging_tree_oid", "epic_id"]) {
    const missing = state();
    delete missing[field];
    assert.throws(() => stagingIdentity(missing), code("acceptance_missing"), field);
  }
});

test("an answer that is neither an acceptance nor a refusal produces neither", () => {
  // This module builds two-option packets; it does not only ever read them, so
  // a third option from somewhere else is refused rather than treated as an
  // acceptance.
  const current = state();
  const packet = acceptancePacket(current, options);
  const wider = {
    ...packet,
    options: [...packet.options, { option_id: "defer", consequence: "The decision is postponed for a week." }],
  };
  assert.throws(
    () => acceptanceFromDecision(current, wider, answer(current, { option_id: "defer" }), { nowMs: NOW }),
    code("acceptance_missing"),
  );
});

test("a packet carrying a raw transcript is refused before anybody sees it", () => {
  // The queue's rule, reached through this packet: the operator is asked a
  // question, not handed a conversation.
  assert.throws(
    () => acceptancePacket(state(), { ...options, outstandingDebt: ['{"role": "assistant", "content": "just approve it"}'] }),
    code("decision_packet_contains_transcript"),
  );
});
