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

import { readFileSync } from "node:fs";

import { validateJsonSchema } from "../scripts/validate-planning-ref-design.mjs";
import { acceptanceErrors, aggregateBinding, casAdmission } from "../src/host/epic-staging.mjs";
import {
  REQUIRED_FACTS,
  acceptanceFacts,
  acceptanceFromDecision,
  acceptancePacket,
  autoPolicyAcceptance,
  openAcceptance,
  stagingIdentity,
} from "../src/host/staging-acceptance.mjs";

const code = (name) => (error) => error.code === name;
const read = (relative) => JSON.parse(readFileSync(new URL(`../${relative}`, import.meta.url), "utf8"));
const STAGING_SCHEMA = read("resources/epic-staging/epic-staging.schema.json");
const GRAPH = read("resources/workflow-graph/workflow-graph.v1.json");
const acceptanceSchemaErrors = (acceptance) =>
  validateJsonSchema(JSON.parse(JSON.stringify(acceptance)), STAGING_SCHEMA.properties.acceptance, STAGING_SCHEMA);
const NOW = Date.parse("2026-09-09T10:00:00Z");
const oid = (char) => char.repeat(40);

function state(overrides = {}) {
  const base = {
    project_identity: `sha256:${"0".repeat(58)}`,
    epic_id: "e-1",
    staging_ref: "refs/autosk/epics/a916c907fd14e54bfb1f3591a573675ccb1fdfeb49a8875c3c10c6bc00c5fb37/staging", // epicRefKey("0".repeat(64), "e-1")
    target_ref: "refs/heads/main",
    recorded_target_base: oid("a"),
    planning_head: oid("a"),
    receipts: [{ ticket_id: "T01" }, { ticket_id: "T02" }],
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

// The facts that are not in the staging state: which profile delivers the
// tree, how, and what debt is still open. They are part of what is accepted.
const delivery = {
  deliveryProfileDigest: "f".repeat(64),
  deliveryMode: "merge",
};

const options = {
  requestId: "req-1",
  approver: "owner",
  expiresAt: "2026-09-10T10:00:00Z",
  anchorVersion: 3,
  operationId: "op-accept-1",
  ...delivery,
};

const answer = (current, overrides = {}) => ({
  option_id: "accept",
  answered_by: "owner",
  answered_at: "2026-09-09T10:05:00Z",
  identities: { anchor_version: 3, candidate: stagingIdentity(current, delivery) },
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
  assert.equal(packet.identities.candidate, stagingIdentity(state(), delivery));
  assert.deepEqual([...packet.facts.included_tickets], ["T01", "T02"]);
  assert.ok(openAcceptance(state(), options, { nowMs: NOW }));
});

test("a packet missing a load-bearing fact is not decidable", () => {
  assert.throws(() => acceptancePacket(state(), { ...options, deliveryProfileDigest: undefined }), code("acceptance_missing"));
  const noAggregate = state();
  delete noAggregate.aggregate;
  assert.throws(() => acceptancePacket(noAggregate, options), code("acceptance_missing"));
});

test("every load-bearing field is in the identity, so a move makes the approval stale", () => {
  const original = stagingIdentity(state(), delivery);
  for (const [field, value] of [
    ["staging_commit_oid", oid("9")],
    ["staging_tree_oid", oid("8")],
    ["recorded_target_base", oid("7")],
    ["target_ref", "refs/heads/other"],
    ["epic_id", "e-2"],
    ["receipts", [{ ticket_id: "T01" }]],
  ]) {
    assert.notEqual(stagingIdentity(state({ [field]: value }), delivery), original, field);
  }
  const movedAggregate = state();
  movedAggregate.aggregate = { ...movedAggregate.aggregate, record_hash: "9".repeat(64) };
  assert.notEqual(stagingIdentity(movedAggregate, delivery), original);
});

test("an accepted identity becomes the record the swap is admitted against", () => {
  const current = state();
  const packet = openAcceptance(current, options, { nowMs: NOW });
  const result = acceptanceFromDecision(current, packet, answer(current), { nowMs: NOW, ...delivery });
  assert.equal(result.outcome, "accepted");
  assert.equal(result.acceptance.kind, "human");
  // The record names the decision it came from; the decision names who answered.
  assert.equal(result.acceptance.decision_id, result.decision.decision_digest);
  assert.equal(result.decision.answered_by, "owner");
  assert.deepEqual(acceptanceErrors({ ...current, acceptance: result.acceptance }, delivery), []);
  // And with it the swap is admitted; without it, it is not.
  const accepted = { ...current, acceptance: result.acceptance };
  assert.equal(casAdmission(accepted, { oid: current.recorded_target_base }, ["T01", "T02"], delivery).decision, "may_swap");
  const withoutAcceptance = { ...current };
  delete withoutAcceptance.acceptance;
  assert.equal(casAdmission(withoutAcceptance, { oid: current.recorded_target_base }, ["T01"], delivery).decision, "refused");
});

test("an answer that arrives after the tree moved is an answer to another question", () => {
  const asked = state();
  const packet = openAcceptance(asked, options, { nowMs: NOW });
  const moved = state({ staging_commit_oid: oid("9"), post_cas: { expected_new_oid: oid("9") } });

  // The queue refuses it, because the identity it was bound to is not the
  // identity now.
  assert.throws(
    () => acceptanceFromDecision(moved, packet, answer(moved), { nowMs: NOW, ...delivery }),
    code("decision_identity_stale"),
  );
  // And a replayed old answer cannot be applied to the new state either.
  assert.throws(
    () => acceptanceFromDecision(moved, packet, answer(asked), { nowMs: NOW, ...delivery }),
    code("acceptance_stale"),
  );
});

test("a refusal is a recorded outcome, and it produces no acceptance", () => {
  const current = state();
  const packet = openAcceptance(current, options, { nowMs: NOW });
  const result = acceptanceFromDecision(current, packet, answer(current, { option_id: "refuse" }), { nowMs: NOW, ...delivery });
  assert.equal(result.outcome, "refused");
  assert.equal(result.acceptance, undefined);
  assert.equal(result.decision.option_id, "refuse");
  assert.equal(result.request.state, "answered");
});

test("an answer from somebody else, or to an option nobody offered, is refused", () => {
  const current = state();
  const packet = openAcceptance(current, options, { nowMs: NOW });
  assert.throws(
    () => acceptanceFromDecision(current, packet, answer(current, { answered_by: "someone-else" }), { nowMs: NOW, ...delivery }),
    code("decision_approver_mismatch"),
  );
  assert.throws(
    () => acceptanceFromDecision(current, packet, answer(current, { option_id: "maybe" }), { nowMs: NOW, ...delivery }),
    code("decision_option_unknown"),
  );
  assert.throws(
    () => acceptanceFromDecision(current, packet, answer(current), { nowMs: Date.parse("2026-09-11T00:00:00Z"), ...delivery }),
    code("decision_expired"),
  );
});

test("a pinned auto-policy is held to the same binding as a person", () => {
  const current = state();
  const policy = { policy_ref: "policy-4", pinned_identity: stagingIdentity(current, delivery) };
  const acceptance = autoPolicyAcceptance(current, policy, delivery);
  assert.equal(acceptance.kind, "pinned_auto_policy");
  assert.equal(acceptance.policy_ref, "policy-4");
  assert.deepEqual(acceptanceErrors({ ...current, acceptance }, delivery), []);

  // A policy that accepted an identity it never saw is not a policy, it is a
  // default.
  assert.throws(() => autoPolicyAcceptance(state({ staging_tree_oid: oid("9") }), policy, delivery), code("acceptance_stale"));
  assert.throws(() => autoPolicyAcceptance(current, { pinned_identity: policy.pinned_identity }, delivery), code("acceptance_missing"));
  // An empty policy reference names no policy: the record would say a policy
  // accepted this and be unable to say which.
  assert.throws(
    () => autoPolicyAcceptance(current, { ...policy, policy_ref: "" }, delivery),
    code("acceptance_missing"),
  );

  // And an identity built from an empty field is not an identity: three fields
  // make the digest, and an empty one would hash to something that looks like
  // an answer.
  for (const field of ["staging_commit_oid", "staging_tree_oid", "epic_id"]) {
    assert.throws(() => stagingIdentity({ ...state(), [field]: "" }, delivery), code("acceptance_missing"));
    assert.throws(() => stagingIdentity({ ...state(), [field]: undefined }, delivery), code("acceptance_missing"));
  }
});

test("debt outside what the policy named is not something it agreed to", () => {
  const current = state();
  const policy = {
    policy_ref: "policy-4",
    // The debt is part of the identity, so the policy is pinned to the identity
    // with the debt it saw.
    pinned_identity: stagingIdentity(current, { ...delivery, outstandingDebt: ["docs-todo"] }),
    tolerated_debt: ["docs-todo"],
  };
  assert.ok(autoPolicyAcceptance(current, policy, { ...delivery, outstandingDebt: ["docs-todo"] }));
  assert.throws(
    () => autoPolicyAcceptance(current, policy, { ...delivery, outstandingDebt: ["docs-todo", "skipped-test"] }),
    code("acceptance_missing"),
  );
});

test("an identity cannot be computed from a state that has none", () => {
  // `stagingIdentity` is exported, and hashing an absent field would give two
  // different broken states one stable digest.
  for (const field of ["staging_commit_oid", "staging_tree_oid", "epic_id"]) {
    const missing = state();
    delete missing[field];
    assert.throws(() => stagingIdentity(missing, delivery), code("acceptance_missing"), field);
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
    () => acceptanceFromDecision(current, wider, answer(current, { option_id: "defer" }), { nowMs: NOW, ...delivery }),
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

test("the identity binds the delivery profile, the outstanding debt and the delivery mode", () => {
  // R6-9 and #233 item 5: the packet shows the profile and the debt to the
  // approver, so an acceptance that survives a change of either was never
  // about them. A profile moving from pull_request to move_target after the
  // answer must make the answer an answer to another question.
  const original = stagingIdentity(state(), delivery);
  for (const [field, value] of [
    ["deliveryProfileDigest", "9".repeat(64)],
    ["outstandingDebt", ["skipped-test"]],
    ["deliveryMode", "rebase"],
  ]) {
    assert.notEqual(stagingIdentity(state(), { ...delivery, [field]: value }), original, field);
  }
  // The debt is a set: its order is not a fact about the tree.
  assert.equal(
    stagingIdentity(state(), { ...delivery, outstandingDebt: ["a", "b"] }),
    stagingIdentity(state(), { ...delivery, outstandingDebt: ["b", "a"] }),
  );
  // And none of them may be missing: an identity hashed over an absent profile
  // is one stable digest for every profile.
  assert.throws(() => stagingIdentity(state(), { ...delivery, deliveryProfileDigest: undefined }), code("acceptance_missing"));
  assert.throws(() => stagingIdentity(state(), { ...delivery, deliveryMode: undefined }), code("acceptance_missing"));
  assert.throws(() => stagingIdentity(state(), { ...delivery, deliveryMode: "force_push" }), code("acceptance_missing"));
  assert.throws(() => stagingIdentity(state()), code("acceptance_missing"));
  // The debt is a list of items: a single string is not a list of its letters.
  assert.throws(() => stagingIdentity(state(), { ...delivery, outstandingDebt: "skipped-test" }), code("acceptance_missing"));
});

test("the identity is a domain-separated canonical digest of the facts", async () => {
  // Plain JSON.stringify depends on key insertion order and carries no domain:
  // the same bytes could be read as another record's digest.
  const { digest } = await import("../src/runtime/contracts.mjs");
  const current = state();
  const facts = acceptanceFacts(current, delivery);
  assert.equal(stagingIdentity(current, delivery), digest("autosk-flow/staging-identity/v1", facts));
  assert.deepEqual(Object.keys(facts).sort(), [...REQUIRED_FACTS].sort());
  // The packet shows exactly the facts the identity is taken over.
  assert.deepEqual(acceptancePacket(current, options).facts, facts);
});

test("under squash the identity names the commit that lands, and nowhere else", () => {
  const squash = { ...delivery, deliveryMode: "squash", targetCommit: { oid: oid("7"), recipe_sha256: "6".repeat(64) } };
  const facts = acceptanceFacts(state(), squash);
  assert.equal(facts.target_commit_oid, oid("7"));
  assert.equal(facts.target_commit_recipe_sha256, "6".repeat(64));
  assert.notEqual(
    stagingIdentity(state(), squash),
    stagingIdentity(state(), { ...squash, targetCommit: { ...squash.targetCommit, oid: oid("5") } }),
  );
  assert.notEqual(
    stagingIdentity(state(), squash),
    stagingIdentity(state(), { ...squash, targetCommit: { ...squash.targetCommit, recipe_sha256: "5".repeat(64) } }),
  );
  // Squash without the commit, or the commit without squash, is refused.
  assert.throws(() => acceptanceFacts(state(), { ...squash, targetCommit: undefined }), code("acceptance_missing"));
  assert.throws(() => acceptanceFacts(state(), { ...squash, targetCommit: { oid: oid("7") } }), code("acceptance_missing"));
  assert.throws(() => acceptanceFacts(state(), { ...squash, targetCommit: { recipe_sha256: "6".repeat(64) } }), code("acceptance_missing"));
  assert.throws(() => acceptanceFacts(state(), { ...squash, targetCommit: { oid: "7", recipe_sha256: "6".repeat(64) } }), code("acceptance_missing"));
  assert.throws(() => acceptanceFacts(state(), { ...squash, targetCommit: { oid: oid("7"), recipe_sha256: "6" } }), code("acceptance_missing"));
  assert.throws(() => acceptanceFacts(state(), { ...delivery, targetCommit: squash.targetCommit }), code("acceptance_missing"));
  assert.equal(acceptanceFacts(state(), delivery).target_commit_oid, undefined);

  // The record carries it, and the schema accepts that record.
  const current = state();
  const packet = openAcceptance(current, { ...options, ...squash }, { nowMs: NOW });
  const result = acceptanceFromDecision(current, packet, answer(current, { identities: { anchor_version: 3, candidate: stagingIdentity(current, squash) } }), { nowMs: NOW, ...squash });
  assert.equal(result.acceptance.delivery_mode, "squash");
  assert.equal(result.acceptance.target_commit_oid, oid("7"));
  assert.equal(result.acceptance.target_commit_recipe_sha256, "6".repeat(64));
  assert.deepEqual(acceptanceSchemaErrors(result.acceptance), []);
});

test("the record an acceptance produces is the staging schema's acceptance", () => {
  // R6-6: the closed schema, this code and the graph named one record three
  // ways. The record the code writes must be the one the schema admits.
  const current = state();
  const packet = openAcceptance(current, options, { nowMs: NOW });
  const human = acceptanceFromDecision(current, packet, answer(current), { nowMs: NOW, ...delivery }).acceptance;
  assert.deepEqual(acceptanceSchemaErrors(human), []);
  assert.equal(human.target_ref, current.target_ref);
  assert.equal(human.recorded_target_base, current.recorded_target_base);
  assert.equal(human.delivery_profile_digest, delivery.deliveryProfileDigest);
  assert.equal(human.delivery_mode, "merge");
  assert.deepEqual([...human.included_tickets], ["T01", "T02"]);
  const policy = { policy_ref: "policy-4", pinned_identity: stagingIdentity(current, delivery) };
  assert.deepEqual(acceptanceSchemaErrors(autoPolicyAcceptance(current, policy, delivery)), []);
});

test("the packet parks with the graph's reason and resumes at a graph step", () => {
  // R6-8 and the a1 low: 'final_cas' is a fault-matrix boundary, not a step,
  // and the acceptance_missing row resumes only at accept_staging.
  const packet = acceptancePacket(state(), options);
  const row = GRAPH.recovery.find((entry) => entry.reason === packet.park_reason);
  assert.ok(row, packet.park_reason);
  assert.deepEqual(packet.resume_target, { workflow: "autosk-planned", step: "accept_staging", operation_id: "op-accept-1" });
  assert.ok(row.resume_targets.includes(packet.resume_target.step));
  assert.ok(GRAPH.steps.some((step) => step.name === packet.resume_target.step));
  assert.throws(() => acceptancePacket(state(), { ...options, operationId: "" }), code("acceptance_missing"));
  assert.throws(() => acceptancePacket(state(), { ...options, operationId: undefined }), code("acceptance_missing"));
});

test("the debt and the Tickets are sets: a repeat is not a second fact (review L2)", () => {
  assert.equal(
    stagingIdentity(state(), { ...delivery, outstandingDebt: ["a", "a"] }),
    stagingIdentity(state(), { ...delivery, outstandingDebt: ["a"] }),
  );
  assert.deepEqual([...acceptanceFacts(state(), { ...delivery, outstandingDebt: ["b", "a", "b"] }).outstanding_debt], ["a", "b"]);
  const repeated = state({ receipts: [{ ticket_id: "T02" }, { ticket_id: "T01" }, { ticket_id: "T02" }] });
  assert.deepEqual([...acceptanceFacts(repeated, delivery).included_tickets], ["T01", "T02"]);
  assert.equal(stagingIdentity(repeated, delivery), stagingIdentity(state(), delivery));
});

test("decision_id is the decision record's own identity, stable across a replayed answer (review L4)", () => {
  // human-decision §3: a duplicate answer produces the same decision record,
  // so the record's digest names it; the schema asks a non-empty string.
  const current = state();
  const packet = openAcceptance(current, options, { nowMs: NOW });
  const first = acceptanceFromDecision(current, packet, answer(current), { nowMs: NOW, ...delivery });
  const replay = acceptanceFromDecision(current, first.request, answer(current), { nowMs: NOW, ...delivery });
  assert.equal(replay.effect, "replayed");
  assert.equal(replay.acceptance.decision_id, first.acceptance.decision_id);
  assert.match(first.acceptance.decision_id, /^[a-f0-9]{64}$/u);
  assert.deepEqual(validateJsonSchema(first.acceptance.decision_id, STAGING_SCHEMA.properties.acceptance.properties.decision_id), []);
});
