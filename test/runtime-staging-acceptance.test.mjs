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
import { acceptanceErrors, aggregateRecordHash, casAdmission, integrationAuthorizationHash } from "../src/host/epic-staging.mjs";
import {
  REQUIRED_FACTS,
  acceptanceFacts,
  authorizationPayloadHash,
  acceptanceFromDecision,
  acceptancePacket,
  autoPolicyAcceptance,
  composeAuthorization,
  openAcceptance,
  stagingIdentity,
} from "../src/host/staging-acceptance.mjs";
import { decisionPayloadHash, userDecisionRecordHash } from "../src/host/user-decision.mjs";
import { testSigner } from "./support/user-decision-signer.mjs";

const code = (name) => (error) => error.code === name;
const read = (relative) => JSON.parse(readFileSync(new URL(`../${relative}`, import.meta.url), "utf8"));
const STAGING_SCHEMA = read("resources/epic-staging/epic-staging.schema.json");
const GRAPH = read("resources/workflow-graph/workflow-graph.v1.json");
const AUTHORIZATION_SCHEMA = read("resources/integration-authorization/integration-authorization.schema.json");
const acceptanceSchemaErrors = (acceptance) =>
  validateJsonSchema(JSON.parse(JSON.stringify(acceptance)), STAGING_SCHEMA.properties.acceptance, STAGING_SCHEMA);
const NOW = Date.parse("2026-09-09T10:00:00Z");
const oid = (char) => char.repeat(40);

/** A staging state with two receipted Tickets and the schema's aggregate PASS named by its digest; `overrides` replaces its fields. */
function state(overrides = {}) {
  const base = {
    project_identity: `sha256:${"0".repeat(64)}`,
    epic_id: "e-1",
    staging_ref: "refs/autosk/epics/a916c907fd14e54bfb1f3591a573675ccb1fdfeb49a8875c3c10c6bc00c5fb37/staging", // epicRefKey("0".repeat(64), "e-1")
    target_ref: "refs/heads/main",
    recorded_target_base: oid("a"),
    planning_head: oid("a"),
    receipts: [{ ticket_id: "T01", applied_commit_oid: oid("d") }, { ticket_id: "T02", applied_commit_oid: oid("e") }],
    phase: "accepted",
    staging_commit_oid: oid("b"),
    staging_tree_oid: oid("c"),
    post_cas: { expected_new_oid: oid("b") },
    ...overrides,
  };
  // The record the staging schema closes, named by its digest (ADR-099).
  const aggregate = {
    outcome: "pass",
    environment_outcome: "ok",
    verification_config_digest: "c".repeat(64),
    instruction_lock_digest: "d".repeat(64),
    staging_commit_oid: base.staging_commit_oid,
    staging_tree_oid: base.staging_tree_oid,
    included_tickets: [...new Set(base.receipts.map((receipt) => receipt.ticket_id))].sort(),
  };
  base.aggregate = { ...aggregate, record_hash: aggregateRecordHash(base, aggregate) };
  return base;
}

const hex = (char) => char.repeat(64);

// The controlling anchor digest and the three heads the acceptance is asked
// under (debt 11b, R7-30): the identity binds them, and so does the record.
const HEADS = Object.freeze({
  controlling_anchor_digest: hex("2"),
  relevant_authority_projection_hash: hex("4"),
  dependency_head_hash: hex("5"),
  intent_head_hash: hex("6"),
});

// The facts that are not in the staging state: which profile delivers the
// tree, how, what debt is still open, and the heads in force. They are part
// of what is accepted.
const delivery = {
  deliveryProfileDigest: "f".repeat(64),
  deliveryMode: "merge",
  heads: HEADS,
  // The anchor version in force when the answer is recorded (review L5).
  anchorVersion: 3,
};

// What the record names that the state and the facts do not: the run, the
// plan, the classifier proof, the chain and the expiry (IA §3).
const PLAN = Object.freeze({
  recordId: "iar-0001",
  runId: "run-0001",
  integrationPlanHash: hex("1"),
  classifierProofHash: hex("3"),
  previousAuthorizationHeadHash: null,
  expiresAt: "2026-09-10T10:00:00Z",
});

/** The IntegrationAuthorizationRecord composed before the question (debt 11b). */
const draft = (current, facts = delivery, plan = {}) => composeAuthorization(current, { ...PLAN, ...plan, ...facts });

const options = {
  requestId: "req-1",
  approver: "owner",
  expiresAt: "2026-09-10T10:00:00Z",
  anchorVersion: 3,
  operationId: "op-accept-1",
  ...delivery,
};

/** The packet's options for this state: the record composed for it goes with the question. */
const ask = (current, facts = delivery, extra = {}) => ({ ...options, ...facts, authorization: draft(current, facts), ...extra });

// Every answer is a daemon UserDecisionRecord, signed by a test key that the
// injected verifier knows; the product has neither (ADR-023). The record
// answers the request `options` opens, about the identity of `current`; an
// `accept` signs the IntegrationAuthorizationRecord composed for it (debt 11b),
// any other option the answer object.
const signer = testSigner();
const { verifySignature } = signer;
const answer = (current, overrides = {}, facts = delivery, by = signer) => {
  const option = overrides.option_id ?? "accept";
  return by.respond(
    {
      request_id: options.requestId,
      project_identity: current.project_identity,
      identities: { anchor_version: 3, candidate: stagingIdentity(current, facts) },
      options: [{ option_id: option }],
    },
    { option_id: option, ...overrides },
    // The daemon's record of an Epic decision names the Epic.
    { epic_id: current.epic_id, ...(option === "accept" ? { payload_hash: authorizationPayloadHash(draft(current, facts)) } : {}) },
  );
};

/**
 * The IntegrationAuthorizationRecord a pinned auto-policy was signed with, and
 * the UserDecisionRecord that signed it (ADR-088, debt 10e). `auth` overrides
 * fields before signing; `after` overrides them after, so the signature no
 * longer covers them; `record` overrides the UserDecisionRecord's issue.
 */
function authorize(current, facts = delivery, { auth = {}, after = {}, record = {} } = {}) {
  // The same composition as the person's path: one record, one mechanism.
  const base = { ...draft(current, facts) };
  // An override of `undefined` removes the field, as the schema's optional ones may be.
  for (const [field, value] of Object.entries(auth)) {
    if (value === undefined) delete base[field];
    else base[field] = value;
  }
  const udr = signer.issue({
    request_id: "authorize-policy-4",
    project_root_sha256: base.project_root_sha256,
    epic_id: current.epic_id,
    anchor_version: 3,
    subject_hash: stagingIdentity(current, facts),
    payload_hash: authorizationPayloadHash(base),
    ...record,
  });
  return {
    authorization: {
      ...base,
      user_decision_record_id: udr.record_id,
      user_decision_record_hash: userDecisionRecordHash(udr),
      ...after,
    },
    user_decision_record: udr,
  };
}

const pinned = (current, facts = delivery, extra = {}) => ({
  policy_ref: "policy-4",
  pinned_identity: stagingIdentity(current, facts),
  ...authorize(current, facts),
  ...extra,
});
const signed = { nowMs: NOW, verifySignature, anchorVersion: 3, ...delivery };

test("the packet states every fact an approval has to be about", () => {
  const packet = acceptancePacket(state(), ask(state()));
  for (const field of REQUIRED_FACTS) {
    assert.ok(packet.facts[field] !== undefined && packet.facts[field] !== null, field);
  }
  // Two options, each with its consequence: "approve?" with one button is not a
  // decision, and a refusal is a recorded state rather than a silence.
  assert.deepEqual(packet.options.map((option) => option.option_id), ["accept", "refuse"]);
  assert.equal(packet.flags.irreversible, true);
  assert.equal(packet.identities.candidate, stagingIdentity(state(), delivery));
  assert.deepEqual([...packet.facts.included_tickets], ["T01", "T02"]);
  assert.ok(openAcceptance(state(), ask(state()), { nowMs: NOW }));
});

test("a packet missing a load-bearing fact is not decidable", () => {
  assert.throws(() => acceptancePacket(state(), { ...ask(state()), deliveryProfileDigest: undefined }), code("acceptance_missing"));
  const noAggregate = state();
  delete noAggregate.aggregate;
  assert.throws(() => acceptancePacket(noAggregate, ask(state())), code("acceptance_missing"));
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
  const packet = openAcceptance(current, ask(current), { nowMs: NOW });
  const result = acceptanceFromDecision(current, packet, answer(current), { nowMs: NOW, verifySignature, ...delivery });
  assert.equal(result.outcome, "accepted");
  assert.equal(result.acceptance.kind, "human");
  // The record names the decision it came from; the decision names who answered.
  assert.equal(result.acceptance.decision_id, result.decision.decision_digest);
  assert.equal(result.decision.answered_by, "owner");
  const cas = { ...delivery, authorization: result.authorization, nowMs: NOW };
  assert.deepEqual(acceptanceErrors({ ...current, acceptance: result.acceptance }, cas), []);
  // And with it the swap is admitted; without it, it is not.
  const accepted = { ...current, acceptance: result.acceptance };
  assert.equal(casAdmission(accepted, { oid: current.recorded_target_base }, ["T01", "T02"], cas).decision, "may_swap");
  const withoutAcceptance = { ...current };
  delete withoutAcceptance.acceptance;
  assert.equal(casAdmission(withoutAcceptance, { oid: current.recorded_target_base }, ["T01"], cas).decision, "refused");
});

test("an answer that arrives after the tree moved is an answer to another question", () => {
  const asked = state();
  const packet = openAcceptance(asked, ask(asked), { nowMs: NOW });
  const moved = state({ staging_commit_oid: oid("9"), post_cas: { expected_new_oid: oid("9") } });

  // The queue refuses it, because the identity it was bound to is not the
  // identity now.
  assert.throws(
    () => acceptanceFromDecision(moved, packet, answer(moved), { nowMs: NOW, verifySignature, ...delivery }),
    code("decision_identity_stale"),
  );
  // And a replayed old answer cannot be applied to the new state either.
  assert.throws(
    () => acceptanceFromDecision(moved, packet, answer(asked), { nowMs: NOW, verifySignature, ...delivery }),
    code("acceptance_stale"),
  );
});

test("a refusal is a recorded outcome, and it produces no acceptance", () => {
  const current = state();
  const packet = openAcceptance(current, ask(current), { nowMs: NOW });
  const result = acceptanceFromDecision(current, packet, answer(current, { option_id: "refuse" }), { nowMs: NOW, verifySignature, ...delivery });
  assert.equal(result.outcome, "refused");
  assert.equal(result.acceptance, undefined);
  assert.equal(result.decision.option_id, "refuse");
  assert.equal(result.request.state, "answered");
});

test("an answer from somebody else, or to an option nobody offered, is refused", () => {
  const current = state();
  const packet = openAcceptance(current, ask(current), { nowMs: NOW });
  assert.throws(
    () => acceptanceFromDecision(current, packet, answer(current, { answered_by: "owner" }), { nowMs: NOW, verifySignature, ...delivery }),
    code("decision_approver_mismatch"),
  );
  // Somebody else is a key the verifier gives another role, not another name.
  const maintainer = testSigner({ keyId: "test-key-2", role: "any_maintainer" });
  assert.throws(
    () => acceptanceFromDecision(current, packet, answer(current, {}, delivery, maintainer), { nowMs: NOW, verifySignature: maintainer.verifySignature, ...delivery }),
    code("decision_approver_mismatch"),
  );
  assert.throws(
    () => acceptanceFromDecision(current, packet, answer(current, { option_id: "maybe" }), { nowMs: NOW, verifySignature, ...delivery }),
    code("decision_option_unknown"),
  );
  assert.throws(
    () => acceptanceFromDecision(current, packet, answer(current), { nowMs: Date.parse("2026-09-11T00:00:00Z"), verifySignature, ...delivery }),
    code("decision_expired"),
  );
});

test("a pinned auto-policy is held to the same binding as a person", () => {
  const current = state();
  const policy = pinned(current);
  const acceptance = autoPolicyAcceptance(current, policy, signed);
  assert.equal(acceptance.kind, "pinned_auto_policy");
  assert.equal(acceptance.policy_ref, "policy-4");
  assert.deepEqual(acceptanceErrors({ ...current, acceptance }, { ...delivery, authorization: policy.authorization, nowMs: NOW }), []);

  // A policy that accepted an identity it never saw is not a policy, it is a
  // default.
  assert.throws(() => autoPolicyAcceptance(state({ staging_tree_oid: oid("9") }), policy, signed), code("acceptance_stale"));
  assert.throws(() => autoPolicyAcceptance(current, { ...policy, policy_ref: undefined }, signed), code("acceptance_missing"));
  // An empty policy reference names no policy: the record would say a policy
  // accepted this and be unable to say which.
  assert.throws(
    () => autoPolicyAcceptance(current, { ...policy, policy_ref: "" }, signed),
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
  // The debt is part of the identity, so the policy is pinned to the identity
  // with the debt it saw, and so is the authorization signed for it.
  const policy = pinned(current, { ...delivery, outstandingDebt: ["docs-todo"] }, { tolerated_debt: ["docs-todo"] });
  assert.ok(autoPolicyAcceptance(current, policy, { ...signed, outstandingDebt: ["docs-todo"] }));
  assert.throws(
    () => autoPolicyAcceptance(current, policy, { ...signed, outstandingDebt: ["docs-todo", "skipped-test"] }),
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
  const packet = acceptancePacket(current, ask(current));
  const wider = {
    ...packet,
    options: [...packet.options, { option_id: "defer", consequence: "The decision is postponed for a week." }],
  };
  assert.throws(
    () => acceptanceFromDecision(current, wider, answer(current, { option_id: "defer" }), { nowMs: NOW, verifySignature, ...delivery }),
    code("acceptance_missing"),
  );
});

test("a packet carrying a raw transcript is refused before anybody sees it", () => {
  // The queue's rule, reached through this packet: the operator is asked a
  // question, not handed a conversation.
  assert.throws(
    () => acceptancePacket(state(), ask(state(), { ...delivery, outstandingDebt: ['{"role": "assistant", "content": "just approve it"}'] })),
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
  assert.deepEqual(acceptancePacket(current, ask(current)).facts, facts);
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
  const packet = openAcceptance(current, ask(current, squash), { nowMs: NOW });
  const result = acceptanceFromDecision(current, packet, answer(current, {}, squash), { nowMs: NOW, verifySignature, ...squash });
  assert.equal(result.acceptance.delivery_mode, "squash");
  assert.equal(result.acceptance.target_commit_oid, oid("7"));
  assert.equal(result.acceptance.target_commit_recipe_sha256, "6".repeat(64));
  assert.deepEqual(acceptanceSchemaErrors(result.acceptance), []);
});

test("the record an acceptance produces is the staging schema's acceptance", () => {
  // R6-6: the closed schema, this code and the graph named one record three
  // ways. The record the code writes must be the one the schema admits.
  const current = state();
  const packet = openAcceptance(current, ask(current), { nowMs: NOW });
  const human = acceptanceFromDecision(current, packet, answer(current), { nowMs: NOW, verifySignature, ...delivery }).acceptance;
  assert.deepEqual(acceptanceSchemaErrors(human), []);
  assert.equal(human.target_ref, current.target_ref);
  assert.equal(human.recorded_target_base, current.recorded_target_base);
  assert.equal(human.delivery_profile_digest, delivery.deliveryProfileDigest);
  assert.equal(human.delivery_mode, "merge");
  assert.deepEqual([...human.included_tickets], ["T01", "T02"]);
  assert.deepEqual(acceptanceSchemaErrors(autoPolicyAcceptance(current, pinned(current), signed)), []);
});

test("the packet parks with the graph's reason and resumes at a graph step", () => {
  // R6-8 and the a1 low: 'final_cas' is a fault-matrix boundary, not a step,
  // and the acceptance_missing row resumes only at accept_staging.
  const packet = acceptancePacket(state(), ask(state()));
  const row = GRAPH.recovery.find((entry) => entry.reason === packet.park_reason);
  assert.ok(row, packet.park_reason);
  assert.deepEqual(packet.resume_target, { workflow: "autosk-planned", step: "accept_staging", operation_id: "op-accept-1" });
  assert.ok(row.resume_targets.includes(packet.resume_target.step));
  assert.ok(GRAPH.steps.some((step) => step.name === packet.resume_target.step));
  assert.throws(() => acceptancePacket(state(), { ...ask(state()), operationId: "" }), code("acceptance_missing"));
  assert.throws(() => acceptancePacket(state(), { ...ask(state()), operationId: undefined }), code("acceptance_missing"));
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
  const packet = openAcceptance(current, ask(current), { nowMs: NOW });
  const first = acceptanceFromDecision(current, packet, answer(current), { nowMs: NOW, verifySignature, ...delivery });
  const replay = acceptanceFromDecision(current, first.request, answer(current), { nowMs: NOW, verifySignature, ...delivery });
  assert.equal(replay.effect, "replayed");
  assert.equal(replay.acceptance.decision_id, first.acceptance.decision_id);
  assert.match(first.acceptance.decision_id, /^[a-f0-9]{64}$/u);
  assert.deepEqual(validateJsonSchema(first.acceptance.decision_id, STAGING_SCHEMA.properties.acceptance.properties.decision_id), []);
});

test("a pinned auto-policy needs the signed IntegrationAuthorizationRecord (ADR-088, debt 10e)", () => {
  // Before debt 10e the policy was checked against its own pinned identity
  // only; IA §1 says the record is always required for the Epic CAS.
  const current = state();
  const policy = pinned(current);
  assert.deepEqual(validateJsonSchema(JSON.parse(JSON.stringify(policy.authorization)), AUTHORIZATION_SCHEMA), []);
  assert.equal(autoPolicyAcceptance(current, policy, signed).kind, "pinned_auto_policy");
  const { authorization: _a, ...unsigned } = policy;
  assert.throws(() => autoPolicyAcceptance(current, unsigned, signed), code("acceptance_missing"));
  assert.throws(() => autoPolicyAcceptance(current, { ...policy, authorization: "iar-0001" }, signed), code("acceptance_missing"));
  const { user_decision_record: _u, ...recordless } = policy;
  assert.throws(() => autoPolicyAcceptance(current, recordless, signed), code("acceptance_missing"));
});

test("with no signer on the host, the authorization is refused rather than trusted (debt 10e)", () => {
  const current = state();
  const { verifySignature: _v, ...unverified } = signed;
  assert.throws(() => autoPolicyAcceptance(current, pinned(current), unverified), code("acceptance_missing"));
});

test("the authorization is signed by the decision it names, over its own fields (debt 10e)", () => {
  const current = state();
  const policy = (options) => ({ ...pinned(current), ...authorize(current, delivery, options) });
  // Issued by anything but a user decision, or naming none.
  for (const after of [
    { issued_by: "project_policy" },
    { user_decision_record_id: undefined },
    { user_decision_record_id: "" },
    { user_decision_record_hash: undefined },
    // Another record than the one presented.
    { user_decision_record_id: "udr-9999" },
    { user_decision_record_hash: hex("9") },
    // A field changed after the user signed.
    { run_id: "run-0002" },
    { expires_at: "2026-09-12T10:00:00Z" },
  ]) {
    assert.throws(() => autoPolicyAcceptance(current, policy({ after }), signed), code("acceptance_missing"), JSON.stringify(after));
  }
  // Issued by a policy and signed as such: the signature is real, the issuer is not a user decision.
  assert.throws(() => autoPolicyAcceptance(current, policy({ auth: { issued_by: "project_policy" } }), signed), code("acceptance_missing"));
  // A record that does not say it was issued by a user decision is not taken
  // for one (review L4; the schema leaves the field optional, the host does not).
  const bare = policy({ auth: { issued_by: undefined } });
  assert.equal(Object.hasOwn(bare.authorization, "issued_by"), false);
  assert.throws(() => autoPolicyAcceptance(current, bare, signed), code("acceptance_missing"));
  // Revoked after it was signed: the copy the host holds no longer carries the
  // signature's bytes, so it is refused as unsigned. A revocation the host never
  // sees is `integrateApproved`'s to enforce, by its scope's chain under
  // `integration_authorization_head` (review M3; R8-16).
  assert.throws(() => autoPolicyAcceptance(current, policy({ after: { terminal_disposition: "revoked" } }), signed), code("acceptance_missing"));
});

test("the authorization is for this identity, this project, this Epic and this one transition (debt 10e)", () => {
  const current = state();
  const policy = (options) => ({ ...pinned(current), ...authorize(current, delivery, options) });
  // The policy's own pin is still asked, beside the identity the user signed.
  assert.throws(() => autoPolicyAcceptance(current, { ...pinned(current), pinned_identity: hex("9") }, signed), code("acceptance_stale"));
  // The user signed another identity.
  assert.throws(() => autoPolicyAcceptance(current, policy({ record: { subject_hash: hex("9") } }), signed), code("acceptance_stale"));
  for (const auth of [
    { project_root_sha256: hex("9") },
    { epic_id: "e-2" },
    { target_ref: "refs/heads/other" },
    { initial_target_oid: oid("9") },
    { ref_transition: { from_oid: oid("9"), to_oid: oid("b") } },
    { ref_transition: { from_oid: oid("a"), to_oid: oid("9") } },
    { ref_transition: null },
    { final_tree_oid: oid("9") },
    // The heads and the anchor the identity binds, and the record's own scope
    // and commits (debt 11b, R7-30).
    { controlling_anchor_digest: hex("9") },
    { relevant_authority_projection_hash: hex("9") },
    { dependency_head_hash: hex("9") },
    { intent_head_hash: hex("9") },
    { scope_id: "epic:e-2" },
    { ordered_ticket_commit_oids: [oid("e"), oid("d")] },
    { ordered_ticket_commit_oids: [oid("d")] },
    { terminal_disposition: "revoked" },
    { expires_at: "2026-09-09T10:00:00Z" },
  ]) {
    assert.throws(() => autoPolicyAcceptance(current, policy({ auth }), signed), code("acceptance_stale"), JSON.stringify(auth));
  }
  // The decision is of this Epic, under the anchor version the acceptance is asked at (review L4).
  assert.throws(() => autoPolicyAcceptance(current, policy({ record: { epic_id: "e-2" } }), signed), code("acceptance_stale"));
  assert.throws(() => autoPolicyAcceptance(current, policy({ record: { epic_id: null } }), signed), code("acceptance_stale"));
  assert.throws(() => autoPolicyAcceptance(current, policy({ record: { anchor_version: 4 } }), signed), code("acceptance_stale"));
  assert.throws(() => autoPolicyAcceptance(current, pinned(current), { ...signed, anchorVersion: undefined }), code("acceptance_stale"));
  // Signed as terminal: the user signed a record that authorizes nothing (review M3).
  assert.throws(() => autoPolicyAcceptance(current, policy({ auth: { terminal_disposition: "replaced" } }), signed), code("acceptance_stale"));
  // The decision is of this project too.
  assert.throws(() => autoPolicyAcceptance(current, policy({ record: { project_root_sha256: hex("9") } }), signed), code("acceptance_stale"));
  // Expiry is asked at the instant: a record valid until now is not valid now.
  assert.doesNotThrow(() => autoPolicyAcceptance(current, policy({ auth: { expires_at: "2026-09-09T10:00:00.001Z" } }), signed));
  assert.throws(() => autoPolicyAcceptance(current, pinned(current), { ...signed, nowMs: undefined }), code("acceptance_stale"));
});

test("under squash the authorized transition ends at the squash commit (debt 10e)", () => {
  const current = state();
  const squash = { ...delivery, deliveryMode: "squash", targetCommit: { oid: oid("7"), recipe_sha256: "6".repeat(64) } };
  const policy = pinned(current, squash);
  assert.equal(policy.authorization.ref_transition.to_oid, oid("7"));
  assert.equal(autoPolicyAcceptance(current, policy, { ...signed, ...squash }).target_commit_oid, oid("7"));
  const toStaging = { ...policy, ...authorize(current, squash, { auth: { ref_transition: { from_oid: oid("a"), to_oid: oid("b") } } }) };
  assert.throws(() => autoPolicyAcceptance(current, toStaging, { ...signed, ...squash }), code("acceptance_stale"));
});

// Debt 11b (R7-2, R7-15, R7-30): one mechanism for both paths. The
// IntegrationAuthorizationRecord is composed before the question, the user's
// UserDecisionRecord signs its payload, and the verified decision completes it.

test("the record is composed from the staging state, the facts and the plan before the question (debt 11b)", () => {
  const current = state();
  const composed = draft(current);
  assert.deepEqual(validateJsonSchema(JSON.parse(JSON.stringify({ ...composed, user_decision_record_id: "udr-x", user_decision_record_hash: hex("0") })), AUTHORIZATION_SCHEMA), []);
  // Nothing names a decision yet: the decision has not been asked.
  assert.equal(Object.hasOwn(composed, "user_decision_record_id"), false);
  assert.equal(Object.hasOwn(composed, "user_decision_record_hash"), false);
  assert.equal(composed.issued_by, "user_decision_record");
  assert.equal(composed.terminal_disposition, "active");
  // The scope is the Epic's (02: `epic:<epic-id>`), the project the state's.
  assert.equal(composed.scope_id, "epic:e-1");
  assert.equal(composed.project_root_sha256, "0".repeat(64));
  // One transition from the recorded base to the commit that lands, and the tree.
  assert.deepEqual(composed.ref_transition, { from_oid: oid("a"), to_oid: oid("b") });
  assert.equal(composed.initial_target_oid, oid("a"));
  assert.equal(composed.final_tree_oid, oid("c"));
  // The reviewed commits in the order the receipts applied them.
  assert.deepEqual([...composed.ordered_ticket_commit_oids], [oid("d"), oid("e")]);
  // The heads and the anchor digest are the ones the identity binds.
  for (const [field, value] of Object.entries(HEADS)) assert.equal(composed[field], value, field);
  assert.equal(composed.integration_plan_hash, hex("1"));
  assert.equal(composed.classifier_proof_hash, hex("3"));
  assert.equal(composed.previous_authorization_head_hash, null);
  assert.equal(composed.run_id, "run-0001");
  assert.equal(composed.record_id, "iar-0001");
  assert.equal(composed.expires_at, "2026-09-10T10:00:00Z");
  // Under squash the transition ends at the squash commit.
  const squash = { ...delivery, deliveryMode: "squash", targetCommit: { oid: oid("7"), recipe_sha256: "6".repeat(64) } };
  assert.equal(draft(current, squash).ref_transition.to_oid, oid("7"));
  assert.equal(draft(current, delivery, { previousAuthorizationHeadHash: hex("8") }).previous_authorization_head_hash, hex("8"));
});

test("a record cannot be composed from a plan or a state that does not say what it binds (debt 11b)", () => {
  const current = state();
  for (const plan of [
    { recordId: "" },
    { recordId: undefined },
    { runId: "" },
    { integrationPlanHash: "1" },
    { classifierProofHash: undefined },
    { previousAuthorizationHeadHash: "8" },
    { previousAuthorizationHeadHash: undefined },
    { expiresAt: "tomorrow" },
    { expiresAt: undefined },
  ]) {
    assert.throws(() => draft(current, delivery, plan), code("acceptance_missing"), JSON.stringify(plan));
  }
  // Every applied Ticket names the commit it was applied as.
  assert.throws(() => draft(state({ receipts: [{ ticket_id: "T01" }] })), code("acceptance_missing"));
  assert.throws(() => draft(state({ receipts: [{ ticket_id: "T01", applied_commit_oid: "d" }] })), code("acceptance_missing"));
  assert.throws(() => draft(state({ receipts: [] })), code("acceptance_missing"));
  // A project that is not a sha256 identity names no project root.
  assert.throws(() => draft(state({ project_identity: "0".repeat(64) })), code("acceptance_missing"));
});

test("the identity binds the controlling anchor digest and the three heads (debt 11b, R7-30)", () => {
  const original = stagingIdentity(state(), delivery);
  for (const field of Object.keys(HEADS)) {
    assert.notEqual(stagingIdentity(state(), { ...delivery, heads: { ...HEADS, [field]: hex("9") } }), original, field);
    const { [field]: _gone, ...without } = HEADS;
    assert.throws(() => stagingIdentity(state(), { ...delivery, heads: without }), code("acceptance_missing"), field);
    assert.throws(() => stagingIdentity(state(), { ...delivery, heads: { ...HEADS, [field]: "9" } }), code("acceptance_missing"), field);
    assert.equal(acceptanceFacts(state(), delivery)[field], HEADS[field]);
  }
  assert.throws(() => stagingIdentity(state(), { ...delivery, heads: undefined }), code("acceptance_missing"));
  // Only those four: another head is not a fact the packet shows.
  assert.throws(() => stagingIdentity(state(), { ...delivery, heads: { ...HEADS, metadata_head_hash: hex("9") } }), code("acceptance_missing"));
});

test("the packet presents the record the accept option signs (debt 11b, R7-2)", () => {
  const current = state();
  const packet = acceptancePacket(current, ask(current));
  const composed = draft(current);
  assert.deepEqual(packet.integration_authorization, composed);
  const accept = packet.options.find((option) => option.option_id === "accept");
  const refuse = packet.options.find((option) => option.option_id === "refuse");
  assert.equal(accept.signed_payload_hash, authorizationPayloadHash(composed));
  assert.equal(Object.hasOwn(refuse, "signed_payload_hash"), false);
  // No record, or one that already names a decision, is not a question yet.
  const { authorization: _a, ...unasked } = ask(current);
  assert.throws(() => acceptancePacket(current, unasked), code("acceptance_missing"));
  assert.throws(() => acceptancePacket(current, { ...ask(current), authorization: "iar-0001" }), code("acceptance_missing"));
  assert.throws(() => acceptancePacket(current, ask(current, delivery, { authorization: { ...composed, user_decision_record_id: "udr-1" } })), code("acceptance_missing"));
  assert.throws(() => acceptancePacket(current, ask(current, delivery, { authorization: { ...composed, user_decision_record_hash: hex("0") } })), code("acceptance_missing"));
  assert.throws(() => acceptancePacket(current, ask(current, delivery, { authorization: { ...composed, issued_by: "project_policy" } })), code("acceptance_missing"));
  // A record composed for something else is not this question's record.
  for (const field of [
    ["scope_id", "epic:e-2"],
    ["epic_id", "e-2"],
    ["target_ref", "refs/heads/other"],
    ["initial_target_oid", oid("9")],
    ["ref_transition", { from_oid: oid("a"), to_oid: oid("9") }],
    ["final_tree_oid", oid("9")],
    ["ordered_ticket_commit_oids", [oid("d")]],
    ["dependency_head_hash", hex("9")],
    ["controlling_anchor_digest", hex("9")],
    ["terminal_disposition", "revoked"],
  ]) {
    const other = { ...composed, [field[0]]: field[1] };
    assert.throws(() => acceptancePacket(current, ask(current, delivery, { authorization: other })), code("acceptance_stale"), field[0]);
  }
});

test("the person's acceptance produces the IntegrationAuthorizationRecord their UserDecisionRecord signed (debt 11b, R7-2)", () => {
  const current = state();
  const packet = openAcceptance(current, ask(current), { nowMs: NOW });
  const response = answer(current);
  const result = acceptanceFromDecision(current, packet, response, { nowMs: NOW, verifySignature, ...delivery });
  const record = response.user_decision_record;
  // The record is the composed one, completed with the verified decision.
  assert.deepEqual(result.authorization, {
    ...draft(current),
    user_decision_record_id: record.record_id,
    user_decision_record_hash: userDecisionRecordHash(record),
  });
  assert.deepEqual(validateJsonSchema(JSON.parse(JSON.stringify(result.authorization)), AUTHORIZATION_SCHEMA), []);
  // Exactly what the auto-policy path verifies: the decision signed the record's
  // payload, about this identity.
  assert.equal(record.payload_hash, authorizationPayloadHash(result.authorization));
  assert.equal(record.subject_hash, stagingIdentity(current, delivery));
  // And the acceptance names it.
  assert.equal(result.acceptance.integration_authorization_id, "iar-0001");
  assert.equal(result.acceptance.integration_authorization_sha256, integrationAuthorizationHash(result.authorization));
  assert.deepEqual(acceptanceSchemaErrors(result.acceptance), []);
  // The same record stands for a pinned auto-policy, verified by the same rule.
  const policy = { policy_ref: "policy-4", pinned_identity: stagingIdentity(current, delivery), authorization: result.authorization, user_decision_record: record };
  assert.equal(autoPolicyAcceptance(current, policy, signed).integration_authorization_sha256, result.acceptance.integration_authorization_sha256);
});

test("an acceptance signed over the answer object, not the record, authorizes nothing (debt 11b, R7-2)", () => {
  const current = state();
  const packet = openAcceptance(current, ask(current), { nowMs: NOW });
  const identities = { anchor_version: 3, candidate: stagingIdentity(current, delivery) };
  const overAnswer = signer.respond(
    { request_id: options.requestId, project_identity: current.project_identity, identities, options: [{ option_id: "accept" }] },
    { option_id: "accept" },
    { payload_hash: decisionPayloadHash({ option_id: "accept", identities }) },
  );
  assert.throws(() => acceptanceFromDecision(current, packet, overAnswer, { nowMs: NOW, verifySignature, ...delivery }), code("decision_approver_mismatch"));
  // A record composed for another run is another record: the one signed is not the one asked.
  const otherRun = signer.respond(
    { request_id: options.requestId, project_identity: current.project_identity, identities, options: [{ option_id: "accept" }] },
    { option_id: "accept" },
    { payload_hash: authorizationPayloadHash(draft(current, delivery, { runId: "run-0002" })) },
  );
  assert.throws(() => acceptanceFromDecision(current, packet, otherRun, { nowMs: NOW, verifySignature, ...delivery }), code("decision_approver_mismatch"));
  // A refusal signs no record and produces none.
  const refused = acceptanceFromDecision(current, packet, answer(current, { option_id: "refuse" }), { nowMs: NOW, verifySignature, ...delivery });
  assert.equal(refused.authorization, undefined);
});

test("the completed record is held to the same rule as an auto-policy's (debt 11b)", () => {
  const current = state();
  // A record that expires before the answer backs nothing; since review L4 it
  // is refused when the packet is built, before anybody is asked.
  const lapsed = { ...ask(current), authorization: draft(current, delivery, { expiresAt: "2026-09-09T09:00:00Z" }) };
  assert.throws(() => openAcceptance(current, lapsed, { nowMs: NOW }), code("acceptance_stale"));
  // The heads in force when the answer is recorded are the heads the question
  // was asked under: others make it another identity.
  const asked = openAcceptance(current, ask(current), { nowMs: NOW });
  const moved = { ...delivery, heads: { ...HEADS, intent_head_hash: hex("9") } };
  assert.throws(() => acceptanceFromDecision(current, asked, answer(current), { nowMs: NOW, verifySignature, ...moved }), code("acceptance_stale"));
  // A packet whose record was swapped after it was opened is not the one signed.
  const swapped = { ...asked, integration_authorization: draft(current, delivery, { runId: "run-0002" }) };
  assert.throws(() => acceptanceFromDecision(current, swapped, answer(current), { nowMs: NOW, verifySignature, ...delivery }), code("acceptance_missing"));
  // A replayed answer names the same record.
  const first = acceptanceFromDecision(current, asked, answer(current), { nowMs: NOW, verifySignature, ...delivery });
  const replay = acceptanceFromDecision(current, first.request, answer(current), { nowMs: NOW, verifySignature, ...delivery });
  assert.deepEqual(replay.authorization, first.authorization);
  assert.deepEqual(replay.acceptance, first.acceptance);
});

test("an auto-policy's acceptance names its record too (debt 11b)", () => {
  const current = state();
  const policy = pinned(current);
  const acceptance = autoPolicyAcceptance(current, policy, signed);
  assert.equal(acceptance.integration_authorization_id, policy.authorization.record_id);
  assert.equal(acceptance.integration_authorization_sha256, integrationAuthorizationHash(policy.authorization));
});

test("#9's criterion under v1: every acceptance, a policy's included, carries the user's signature over the exact staging identity, so what an unattended policy would carry is refused (review of 99fd30b, M1)", () => {
  // ADR-103 after the review of 99fd30b (M1): `autoPolicyAcceptance` gives a
  // policy no autonomy — it admits one only with the record the person signed
  // over this exact identity, which exists only after aggregate verification.
  // What an unattended policy could carry instead is refused here; the binding
  // it would need is #28's own design after v1, not this function's to admit.
  const current = state();
  // What is admitted, of either kind, names a record the user's decision
  // signed, over this exact identity and this record's payload.
  const packet = openAcceptance(current, ask(current), { nowMs: NOW });
  const response = answer(current);
  const person = acceptanceFromDecision(current, packet, response, { nowMs: NOW, verifySignature, ...delivery });
  const policy = pinned(current);
  const byPolicy = autoPolicyAcceptance(current, policy, signed);
  for (const [acceptance, authorization, record] of [
    [person.acceptance, person.authorization, response.user_decision_record],
    [byPolicy, policy.authorization, policy.user_decision_record],
  ]) {
    assert.equal(acceptance.integration_authorization_sha256, integrationAuthorizationHash(authorization));
    assert.equal(authorization.issued_by, "user_decision_record");
    assert.equal(authorization.user_decision_record_id, record.record_id);
    assert.equal(record.subject_hash, stagingIdentity(current, delivery));
    assert.equal(record.payload_hash, authorizationPayloadHash(authorization));
  }
  // A signature made before this identity existed is over something else: an
  // earlier staging of the same Epic, or the policy rather than any identity.
  const earlier = state({ staging_commit_oid: oid("8"), staging_tree_oid: oid("9"), post_cas: { expected_new_oid: oid("8") } });
  assert.throws(() => autoPolicyAcceptance(current, { ...policy, ...authorize(earlier) }, signed), code("acceptance_stale"));
  assert.throws(() => autoPolicyAcceptance(current, { ...policy, ...authorize(current, delivery, { record: { subject_hash: hex("7") } }) }, signed), code("acceptance_stale"));
  // A record the policy issued — the exception an unattended path would need
  // (IA §1) — is refused, signed as such or relabelled after.
  assert.throws(() => autoPolicyAcceptance(current, { ...policy, ...authorize(current, delivery, { auth: { issued_by: "project_policy" } }) }, signed), code("acceptance_missing"));
  assert.throws(() => autoPolicyAcceptance(current, { ...policy, ...authorize(current, delivery, { after: { issued_by: "project_policy" } }) }, signed), code("acceptance_missing"));
  // And a policy with no record the person signed is refused, whatever it pinned.
  const { authorization: _a, user_decision_record: _u, ...unsigned } = policy;
  assert.throws(() => autoPolicyAcceptance(current, unsigned, signed), code("acceptance_missing"));
});

test("every guard on the person's path refuses on its own (debt 11b, mutation)", () => {
  const current = state();
  // An expiry that looks like a time but is none, or is not a string at all.
  assert.throws(() => draft(current, delivery, { expiresAt: "2026-13-45T00:00:00Z" }), code("acceptance_missing"));
  assert.throws(() => draft(current, delivery, { expiresAt: { toString: () => "2026-09-10T10:00:00Z" } }), code("acceptance_missing"));
  // A refusal given about the old identity is not a refusal of the new one.
  const asked = state();
  const packet = openAcceptance(asked, ask(asked), { nowMs: NOW });
  const moved = state({ staging_commit_oid: oid("9"), post_cas: { expected_new_oid: oid("9") } });
  assert.throws(
    () => acceptanceFromDecision(moved, packet, answer(asked, { option_id: "refuse" }), { nowMs: NOW, verifySignature, ...delivery }),
    code("acceptance_stale"),
  );
  // A third option that signs the record is still not an acceptance.
  const wider = {
    ...packet,
    options: [...packet.options, { option_id: "defer", consequence: "The decision is postponed for a week.", signed_payload_hash: authorizationPayloadHash(draft(current)) }],
  };
  const identities = { anchor_version: 3, candidate: stagingIdentity(current, delivery) };
  const deferred = signer.respond(
    { request_id: options.requestId, project_identity: current.project_identity, identities, options: [{ option_id: "defer" }] },
    { option_id: "defer" },
    { epic_id: current.epic_id, payload_hash: authorizationPayloadHash(draft(current)) },
  );
  assert.throws(() => acceptanceFromDecision(current, wider, deferred, { nowMs: NOW, verifySignature, ...delivery }), code("acceptance_missing"));
  // A packet that presented no record produces none.
  const { integration_authorization: _gone, ...bare } = packet;
  assert.throws(() => acceptanceFromDecision(current, bare, answer(current), { nowMs: NOW, verifySignature, ...delivery }), code("acceptance_missing"));
});

test("the record outlives the question it is asked in (review L4)", () => {
  const current = state();
  // The request expires at 2026-09-10T10:00:00Z; a record that lapses earlier
  // would be signed for a CAS that could never run under it.
  const early = { ...ask(current), authorization: draft(current, delivery, { expiresAt: "2026-09-10T09:59:59Z" }) };
  assert.throws(() => acceptancePacket(current, early), code("acceptance_stale"));
  const same = { ...ask(current), authorization: draft(current, delivery, { expiresAt: "2026-09-10T10:00:00Z" }) };
  assert.doesNotThrow(() => acceptancePacket(current, same));
});

test("the anchor version is the one in force when the answer is recorded, not the packet's own (review L5)", () => {
  const current = state();
  const packet = openAcceptance(current, ask(current), { nowMs: NOW });
  assert.throws(() => acceptanceFromDecision(current, packet, answer(current), { nowMs: NOW, verifySignature, ...delivery, anchorVersion: 4 }), code("acceptance_stale"));
  assert.throws(() => acceptanceFromDecision(current, packet, answer(current), { nowMs: NOW, verifySignature, ...delivery, anchorVersion: undefined }), code("acceptance_stale"));
  assert.equal(acceptanceFromDecision(current, packet, answer(current), { nowMs: NOW, verifySignature, ...delivery }).outcome, "accepted");
});

test("the request schema carries the record the user signs (review M2)", () => {
  const request = read("resources/human-decision/human-decision-request.schema.json");
  const shape = request.properties.integration_authorization;
  assert.ok(shape, "the request schema names integration_authorization");
  const packet = acceptancePacket(state(), ask(state()));
  assert.deepEqual(validateJsonSchema(JSON.parse(JSON.stringify(packet.integration_authorization)), shape, request), []);
  // A record that already names a decision, or carries a field the IA schema does not, is refused.
  const decided = { ...packet.integration_authorization, user_decision_record_id: "udr-1" };
  assert.notDeepEqual(validateJsonSchema(decided, shape, request), []);
  // The shape is the IA schema's, less the two fields that name the decision.
  const draftShape = shape.$ref ? request.$defs[shape.$ref.split("/").pop()] : shape;
  const { user_decision_record_id: _i, user_decision_record_hash: _h, ...properties } = AUTHORIZATION_SCHEMA.properties;
  assert.deepEqual(draftShape.properties, properties);
  assert.deepEqual([...draftShape.required].sort(), AUTHORIZATION_SCHEMA.required.filter((field) => !field.startsWith("user_decision_record_")).sort());
  assert.equal(draftShape.additionalProperties, false);
});

// --- debt 11d: one object format ----------------------------------------------

/** The same Epic in a SHA-256 repository: every OID the staging state names is 64 hex. */
const sha256State = (overrides = {}) => state({
  recorded_target_base: hex("a"),
  planning_head: hex("a"),
  receipts: [{ ticket_id: "T01", applied_commit_oid: hex("d") }, { ticket_id: "T02", applied_commit_oid: hex("e") }],
  staging_commit_oid: hex("b"),
  staging_tree_oid: hex("c"),
  post_cas: { expected_new_oid: hex("b") },
  ...overrides,
});

test("a SHA-256 repository's Epic reaches a schema-valid authorization, acceptance and CAS (R7-8)", () => {
  // Round 7 of #39, R7-8: the IA schema admitted only 40-hex OIDs while the
  // staging record, this module and deliveryCompleted took 64 as well, so a
  // SHA-256 repository could never reach a schema-valid authorization (ADR-098).
  const current = sha256State();
  const record = draft(current);
  assert.equal(record.initial_target_oid.length, 64);
  const request = read("resources/human-decision/human-decision-request.schema.json");
  // The presented draft carries the record's one-format rule, as it carries its fields.
  assert.deepEqual(request.$defs.integrationAuthorizationDraft.allOf, AUTHORIZATION_SCHEMA.allOf);
  const packet = openAcceptance(current, ask(current), { nowMs: NOW });
  assert.deepEqual(validateJsonSchema(JSON.parse(JSON.stringify(packet.integration_authorization)),
    request.properties.integration_authorization, request), []);
  const result = acceptanceFromDecision(current, packet, answer(current), { nowMs: NOW, verifySignature, ...delivery });
  assert.equal(result.outcome, "accepted");
  assert.deepEqual(validateJsonSchema(JSON.parse(JSON.stringify(result.authorization)), AUTHORIZATION_SCHEMA), []);
  assert.deepEqual(acceptanceSchemaErrors(result.acceptance), []);
  const cas = { ...delivery, authorization: result.authorization, nowMs: NOW };
  const accepted = { ...current, acceptance: result.acceptance };
  assert.deepEqual(acceptanceErrors(accepted, cas), []);
  assert.equal(casAdmission(accepted, { oid: current.recorded_target_base }, ["T01", "T02"], cas).decision, "may_swap");
  // The pinned auto-policy's record is the same record, in the same format.
  const policy = pinned(current);
  assert.deepEqual(validateJsonSchema(JSON.parse(JSON.stringify(policy.authorization)), AUTHORIZATION_SCHEMA), []);
  assert.deepEqual(acceptanceSchemaErrors(autoPolicyAcceptance(current, policy, signed)), []);
  // Under squash the commit that lands is a SHA-256 commit too.
  const squash = { ...delivery, deliveryMode: "squash", targetCommit: { oid: hex("7"), recipe_sha256: hex("8") } };
  assert.equal(draft(current, squash).ref_transition.to_oid, hex("7"));
});

test("a staging state whose OIDs are of two object formats is no identity, and nothing is composed for it (debt 11d)", () => {
  // ADR-098: a repository has one object format. A base, staging commit or
  // tree, applied commit or squash commit of the other format names objects no
  // one repository holds together, so there is no identity to present, sign or
  // accept — on the person's path or a pinned auto-policy's.
  const squash = (commit) => ({ ...delivery, deliveryMode: "squash", targetCommit: { oid: commit, recipe_sha256: hex("8") } });
  for (const [label, current, facts] of [
    ["recorded base", state({ recorded_target_base: hex("a") }), delivery],
    ["staging commit", state({ staging_commit_oid: hex("b") }), delivery],
    ["staging tree", state({ staging_tree_oid: hex("c") }), delivery],
    ["applied commit", state({ receipts: [{ ticket_id: "T01", applied_commit_oid: oid("d") }, { ticket_id: "T02", applied_commit_oid: hex("e") }] }), delivery],
    ["squash commit", state(), squash(hex("7"))],
    ["squash commit of a SHA-256 Epic", sha256State(), squash(oid("7"))],
    ["applied commit of a SHA-256 Epic", sha256State({ receipts: [{ ticket_id: "T01", applied_commit_oid: hex("d") }, { ticket_id: "T02", applied_commit_oid: oid("e") }] }), delivery],
    ["staging tree of a SHA-256 Epic", sha256State({ staging_tree_oid: oid("c") }), delivery],
  ]) {
    assert.throws(() => acceptanceFacts(current, facts), code("acceptance_missing"), label);
    assert.throws(() => stagingIdentity(current, facts), code("acceptance_missing"), label);
    assert.throws(() => draft(current, facts), code("acceptance_missing"), label);
  }
  // A receipt that names no applied commit is not a second format: the
  // identity binds Tickets, and the record, which binds commits, refuses it.
  const unapplied = state({ receipts: [{ ticket_id: "T01" }, { ticket_id: "T02", applied_commit_oid: oid("e") }] });
  assert.equal(stagingIdentity(unapplied, delivery), stagingIdentity(state(), delivery));
  assert.throws(() => draft(unapplied), code("acceptance_missing"));
  // A pinned auto-policy is refused before its record is read.
  const mixed = state({ staging_tree_oid: hex("c") });
  assert.throws(() => autoPolicyAcceptance(mixed, pinned(state()), signed), code("acceptance_missing"));
});
