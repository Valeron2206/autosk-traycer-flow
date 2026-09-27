/**
 * Tests for the human decision queue runtime (issue #35).
 *
 * The contract's hard parts are the ones a queue gets wrong quietly: an answer
 * applied to a candidate that moved, a duplicate answer applied twice, and a
 * status that grew into a ledger. Most of these are one of those three.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  BOUND_IDENTITIES,
  answerRequest,
  assertPacketDecidable,
  decisionRecord,
  openRequest,
  packetStrings,
  requestState,
  statusProjection,
  voidRequest,
} from "../src/host/decision-queue.mjs";
import { ROOT } from "../scripts/validate-planning-ref-design.mjs";
import { userDecisionProvenance, userDecisionRecordHash } from "../src/host/user-decision.mjs";
import { testSigner } from "./support/user-decision-signer.mjs";
import { validateJsonSchema } from "../scripts/validate-planning-ref-design.mjs";

const REQUEST_PATH = "resources/human-decision/human-decision-request.example.json";
const SCHEMA_PATH = "resources/human-decision/human-decision-request.schema.json";

const shipped = JSON.parse(await readFile(path.join(ROOT, REQUEST_PATH), "utf8"));
const schema = JSON.parse(await readFile(path.join(ROOT, SCHEMA_PATH), "utf8"));

const NOW = Date.parse("2026-09-08T13:00:00.000Z");

const request = () => JSON.parse(JSON.stringify(shipped));

const code = (name) => (error) => error.code === name;

// Every answer is a daemon UserDecisionRecord, signed here by a test key and
// verified by the verifier that knows it; the product has neither (ADR-023).
const signer = testSigner();
const { verifySignature } = signer;

function response(overrides = {}, asked = request(), options = {}) {
  return signer.respond(asked, { option_id: "wait", ...overrides }, options);
}

test("the shipped packet is decidable and opens", () => {
  assert.doesNotThrow(() => assertPacketDecidable(request()));
  const opened = openRequest(request(), { nowMs: NOW });
  assert.equal(requestState(opened, NOW), "pending");
});

test("the transcript scan reaches every string and survives what is not one", () => {
  // `value && typeof value === 'object'` — with an `||` there, `null` would be
  // handed to `Object.values` and the scan would throw on the packet it exists
  // to check. The guard against a leak must not be the thing that crashes.
  assert.deepEqual(packetStrings(null), []);
  assert.deepEqual(packetStrings(undefined), []);
  assert.deepEqual(packetStrings(7), []);
  assert.deepEqual(packetStrings(false), []);
  assert.deepEqual(packetStrings("one"), ["one"]);
  assert.deepEqual(packetStrings(["a", ["b"], null]), ["a", "b"]);
  assert.deepEqual(packetStrings({ a: "x", b: { c: "y" }, d: null }), ["x", "y"]);
});

test("every bound is asked at the bound, and expiry is asked at the instant", () => {
  // Predicate mutation found each of these tested only far from its boundary,
  // so `>= 16` could have been `> 16`, `> nowMs` could have been `>= nowMs`,
  // and the answers would have differed by exactly one case nobody wrote.
  const reason = (n) => "x".repeat(n);
  assert.doesNotThrow(() => assertPacketDecidable({ ...request(), why_automation_may_not_decide: reason(16) }));
  assert.throws(
    () => assertPacketDecidable({ ...request(), why_automation_may_not_decide: reason(15) }),
    code("decision_packet_incomplete"),
  );
  // Whitespace does not count towards it: sixteen spaces are not a reason.
  assert.throws(
    () => assertPacketDecidable({ ...request(), why_automation_may_not_decide: " ".repeat(20) }),
    code("decision_packet_incomplete"),
  );

  const withConsequence = (n) => {
    const value = request();
    value.options = value.options.map((option) => ({ ...option, consequence: "y".repeat(n) }));
    return value;
  };
  assert.doesNotThrow(() => assertPacketDecidable(withConsequence(10)));
  assert.throws(() => assertPacketDecidable(withConsequence(9)), code("decision_packet_incomplete"));

  // An expiry exactly now is not in the future, and the two functions must
  // agree about that instant: one may not open what the other calls expired.
  const at = (ms) => ({ ...request(), expires_at: new Date(ms).toISOString() });
  assert.throws(() => openRequest(at(NOW), { nowMs: NOW }), code("decision_expired"));
  assert.doesNotThrow(() => openRequest(at(NOW + 1), { nowMs: NOW }));
  assert.equal(requestState(at(NOW), NOW), "expired");
  assert.equal(requestState(at(NOW + 1), NOW), "pending");
});

test("a packet without why the automation may not decide is refused", () => {
  // Without it the packet reads as a request for permission to do something
  // obvious, and the park is probably a bug rather than a decision.
  assert.throws(
    () =>
      assertPacketDecidable({ ...request(), why_automation_may_not_decide: "because" }),
    code("decision_packet_incomplete"),
  );
});

test("an option without a consequence asks the user to choose between words", () => {
  assert.throws(
    () => {
      const value = request();
      value.options[1].consequence = "does it";
      assertPacketDecidable(value);
    },
    code("decision_packet_incomplete"),
  );
  assert.throws(
    () => {
      const value = request();
      value.options = [value.options[0]];
      assertPacketDecidable(value);
    },
    code("decision_packet_incomplete"),
  );
});

test("a packet carrying a raw transcript is refused", () => {
  // A packet is read in a terminal, pasted into chat and kept.
  for (const leak of [
    '{"role": "assistant", "content": "..."}',
    '\\"type\\":\\"tool_result\\"',
    "Human: what happened here?",
  ]) {
    assert.throws(
      () => {
        const value = request();
        value.observed_facts = [...value.observed_facts, leak];
        assertPacketDecidable(value);
      },
      code("decision_packet_contains_transcript"),
      leak,
    );
  }
});

test("an answer is bound to the identity it was asked about", () => {
  // Not a stale answer to the same question — an answer to a different one.
  for (const field of BOUND_IDENTITIES) {
    const moved = response();
    moved.identities[field] = field === "anchor_version" ? 4 : "9".repeat(64);
    assert.throws(() => answerRequest(request(), moved, { nowMs: NOW, verifySignature }), code("decision_identity_stale"));
  }
  const missing = response();
  delete missing.identities;
  assert.throws(() => answerRequest(request(), missing, { nowMs: NOW, verifySignature }), code("decision_identity_stale"));
});

test("an answer from another approver, or naming an option nobody offered, is refused", () => {
  // The approver is the role the verifier gives the signing key, not a name
  // the answer carries: a maintainer's record does not answer an owner's request.
  const maintainer = testSigner({ keyId: "test-key-2", role: "any_maintainer" });
  assert.throws(
    () => answerRequest(request(), maintainer.respond(request(), { option_id: "wait" }), { nowMs: NOW, verifySignature: maintainer.verifySignature }),
    code("decision_approver_mismatch"),
  );
  assert.throws(
    () => answerRequest(request(), response({ option_id: "invented" }), { nowMs: NOW, verifySignature }),
    code("decision_option_unknown"),
  );
});

test("an expired or voided request cannot be answered", () => {
  const late = Date.parse(shipped.expires_at) + 1;
  assert.throws(() => answerRequest(request(), response(), { nowMs: late, verifySignature }), code("decision_expired"));
  const voided = voidRequest(request(), "the candidate was rebuilt", { nowMs: NOW });
  assert.equal(requestState(voided, NOW), "voided");
  assert.throws(() => answerRequest(voided, response(), { nowMs: NOW, verifySignature }), code("decision_request_voided"));
  assert.throws(() => voidRequest(voided, "again", { nowMs: NOW }), code("decision_request_voided"));
  assert.throws(() => voidRequest(request(), "", { nowMs: NOW }), code("decision_packet_incomplete"));
});

test("a duplicate answer is idempotent, and a different one is refused", () => {
  const first = answerRequest(request(), response(), { nowMs: NOW, verifySignature });
  assert.equal(first.effect, "applied");
  assert.equal(requestState(first.request, NOW), "answered");
  const again = answerRequest(first.request, response(), { nowMs: NOW, verifySignature });
  assert.equal(again.effect, "replayed");
  // The same answer produces the same record and no second side effect.
  assert.deepEqual(again.decision, first.decision);
  assert.throws(
    () => answerRequest(first.request, response({ option_id: "waive_seat" }), { nowMs: NOW, verifySignature }),
    code("decision_option_unknown"),
  );
});

test("the decision record names the resume target and its own digest", () => {
  const { decision } = answerRequest(request(), response(), { nowMs: NOW, verifySignature });
  assert.deepEqual(decision.resume_target, shipped.resume_target);
  assert.match(decision.decision_digest, /^[0-9a-f]{64}$/u);
  assert.equal(decisionRecord(request(), response()).option_id, "wait");
});

test("a normalised free-text answer to an irreversible option needs confirmation", () => {
  // "Sure, but only for the docs" becoming an approval for everything is what
  // silent interpretation looks like.
  const free = response({ option_id: "waive_seat", normalized_from: "fine, skip grok this once" });
  assert.throws(() => answerRequest(request(), free, { nowMs: NOW, verifySignature }), code("decision_packet_incomplete"));
  const confirmed = response({ option_id: "waive_seat", normalized_from: "fine, skip grok this once", confirmed_material_scope: true });
  assert.equal(answerRequest(request(), confirmed, { nowMs: NOW, verifySignature }).effect, "applied");
  // A reversible option does not need the extra confirmation.
  const reversible = response({ normalized_from: "let's wait" });
  assert.equal(answerRequest(request(), reversible, { nowMs: NOW, verifySignature }).effect, "applied");
});

test("an answered request still validates against the shipped schema", () => {
  // The queue writes what the contract describes, checked against the contract
  // rather than against a second copy of it.
  const { request: answered } = answerRequest(request(), response(), { nowMs: NOW, verifySignature });
  assert.deepEqual(validateJsonSchema(answered, schema), []);
});

test("a request cannot open already expired or already answered", () => {
  assert.throws(
    () => openRequest(request(), { nowMs: Date.parse(shipped.expires_at) + 1 }),
    code("decision_expired"),
  );
  assert.throws(
    () => openRequest({ ...request(), state: "answered" }, { nowMs: NOW }),
    code("decision_packet_incomplete"),
  );
});

test("the status is a projection of records, and never another project's", () => {
  const mine = request();
  const theirs = { ...request(), request_id: "decision-other", project_identity: "sha256:" + "b".repeat(64) };
  const status = statusProjection([mine, theirs], { projectIdentity: mine.project_identity, nowMs: NOW });
  assert.equal(status.counts.pending, 1);
  assert.equal(status.pending_decisions.length, 1);
  // Not as a count, not as a name: the other project appears nowhere.
  assert.ok(!JSON.stringify(status).includes("decision-other"));
  assert.ok(!JSON.stringify(status).includes("b".repeat(64)));
});

test("a field that copied another project's identity across is refused", () => {
  // The filter decides which records are read, so the leak that can still
  // happen is a field added later that carries something across.
  const theirs = { ...request(), request_id: "decision-other", project_identity: "sha256:" + "c".repeat(64) };
  const mine = { ...request(), park_reason: `see ${theirs.project_identity}` };
  assert.throws(
    () => statusProjection([mine, theirs], { projectIdentity: mine.project_identity, nowMs: NOW }),
    code("status_cross_project_leak"),
  );
});

test("the projection counts states it computes, not states it stored", () => {
  const pending = request();
  const other = { ...request(), request_id: "decision-answered" };
  const { request: answered } = answerRequest(other, response({}, other), { nowMs: NOW, verifySignature });
  const voided = voidRequest({ ...request(), request_id: "decision-voided" }, "rebuilt", { nowMs: NOW });
  const expired = { ...request(), request_id: "decision-expired" };
  const late = Date.parse(shipped.expires_at) + 1;
  const status = statusProjection([pending, answered, voided, expired], {
    projectIdentity: pending.project_identity,
    nowMs: NOW,
  });
  assert.deepEqual(status.counts, { pending: 2, answered: 1, expired: 0, voided: 1 });
  assert.equal(status.next_safe_action, `answer ${pending.request_id}`);

  const later = statusProjection([pending, answered, voided, expired], {
    projectIdentity: pending.project_identity,
    nowMs: late,
  });
  // Nothing moved in storage; the same records now read as expired.
  assert.deepEqual(later.counts, { pending: 0, answered: 1, expired: 2, voided: 1 });
  assert.equal(later.next_safe_action, "no decision is pending");
});

test("a free-text answered_by is not a user decision, with or without a record (R6-14)", () => {
  // Before debt 10e the queue minted a decision from `answered_by ===
  // required_approver`; any process knowing the string could answer.
  const bare = {
    option_id: "wait",
    answered_by: "owner",
    answered_at: new Date(NOW).toISOString(),
    identities: { anchor_version: shipped.identities.anchor_version, candidate: shipped.identities.candidate },
  };
  assert.throws(() => answerRequest(request(), bare, { nowMs: NOW, verifySignature }), code("decision_approver_mismatch"));
  // A name beside a signed record is still a name the answer gives itself.
  assert.throws(
    () => answerRequest(request(), response({ answered_by: "owner" }), { nowMs: NOW, verifySignature }),
    code("decision_approver_mismatch"),
  );
});

test("with no signer on the host, a signed record is refused rather than trusted (R6-14)", () => {
  // The product path: no verifier is injected, the pinned daemon reports no
  // signer, and no answer becomes a decision (ADR-023, #40).
  assert.throws(() => answerRequest(request(), response(), { nowMs: NOW }), code("decision_approver_mismatch"));
});

test("the record answers this request, about this candidate, in this project (R6-14)", () => {
  for (const [field, value] of [
    ["request_id", "decision-other"],
    ["project_root_sha256", "9".repeat(64)],
    ["anchor_version", 4],
    ["subject_hash", "9".repeat(64)],
  ]) {
    const answer = response({}, request(), { [field]: value });
    assert.throws(() => answerRequest(request(), answer, { nowMs: NOW, verifySignature }), code("decision_identity_stale"), field);
  }
});

test("the record signed this answer, and no other (R6-14)", () => {
  // The response names one option; the user signed another.
  const swapped = response({ option_id: "wait" }, request(), { signedAnswer: { option_id: "waive_seat", identities: response().identities } });
  assert.throws(() => answerRequest(request(), swapped, { nowMs: NOW, verifySignature }), code("decision_approver_mismatch"));
  // And a normalisation the user did not sign is not theirs either.
  const added = { ...response(), normalized_from: "let's wait" };
  assert.throws(() => answerRequest(request(), added, { nowMs: NOW, verifySignature }), code("decision_approver_mismatch"));
});

test("who answered and when come from the verified record, and the answer names it (R6-14)", () => {
  const answer = response();
  const { decision, request: answered } = answerRequest(request(), answer, { nowMs: NOW, verifySignature });
  const record = answer.user_decision_record;
  assert.equal(decision.answered_by, "owner");
  assert.equal(decision.answered_at, record.issued_at);
  assert.equal(decision.user_decision_record_id, record.record_id);
  assert.equal(decision.user_decision_record_hash, userDecisionRecordHash(record));
  assert.equal(decision.user_decision_provenance_hash, userDecisionProvenance(record));
  assert.equal(answered.answer.user_decision_record_id, record.record_id);
  assert.equal(answered.answer.answered_by, "owner");
  // The decision digest binds the record: another record is another decision.
  const again = response({}, request(), { record_id: "udr-0002" });
  assert.notEqual(answerRequest(request(), again, { nowMs: NOW, verifySignature }).decision.decision_digest, decision.decision_digest);
});

test("the record was issued while the question stood (review L1)", () => {
  // Not after now: a record from the future is not one the daemon has written.
  const future = response({}, request(), { issued_at: new Date(NOW + 1).toISOString() });
  assert.throws(() => answerRequest(request(), future, { nowMs: NOW, verifySignature }), code("decision_identity_stale"));
  assert.equal(answerRequest(request(), response({}, request(), { issued_at: new Date(NOW).toISOString() }),
    { nowMs: NOW, verifySignature }).effect, "applied");
  // Not before the question was asked.
  const early = response({}, request(), { issued_at: "2026-09-08T11:59:59.999Z" });
  assert.throws(() => answerRequest(request(), early, { nowMs: NOW, verifySignature }), code("decision_identity_stale"));
  assert.equal(answerRequest(request(), response({}, request(), { issued_at: shipped.created_at }),
    { nowMs: NOW, verifySignature }).effect, "applied");
  // A packet that states no creation time is bounded by now and its expiry only.
  const { created_at: _c, ...undated } = request();
  assert.equal(answerRequest(undated, response({}, undated, { issued_at: "2026-09-08T11:00:00.000Z" }),
    { nowMs: NOW, verifySignature }).effect, "applied");
});

test("a second record for an answered request is not a different option (review L3)", () => {
  const first = answerRequest(request(), response(), { nowMs: NOW, verifySignature });
  const other = response({}, request(), { record_id: "udr-0002" });
  assert.throws(() => answerRequest(first.request, other, { nowMs: NOW, verifySignature }), code("decision_identity_stale"));
});

// Debt 11b (R7-2): an option may say what choosing it signs. The Epic
// acceptance's `accept` signs the IntegrationAuthorizationRecord composed
// before the question, not the answer object, so the one irreversible step
// rests on the record's own fields under the user's signature.
const BOUND = "9".repeat(64);
const bound = () => {
  const asked = request();
  asked.options = asked.options.map((option) => (option.option_id === "waive_seat" ? { ...option, signed_payload_hash: BOUND } : option));
  return asked;
};

test("an option that names what it signs is answered by a record that signed exactly that (debt 11b)", () => {
  const asked = bound();
  const signedBound = response({ option_id: "waive_seat" }, asked, { payload_hash: BOUND });
  const { decision, request: answered } = answerRequest(asked, signedBound, { nowMs: NOW, verifySignature });
  assert.equal(decision.option_id, "waive_seat");
  assert.deepEqual(validateJsonSchema(answered, schema), []);
  // The answer object signed instead of the bound payload is another signature.
  const signedAnswer = response({ option_id: "waive_seat" }, asked);
  assert.throws(() => answerRequest(asked, signedAnswer, { nowMs: NOW, verifySignature }), code("decision_approver_mismatch"));
  // A record that signed the bound payload does not answer another option with it.
  const misplaced = response({ option_id: "wait" }, asked, { payload_hash: BOUND });
  assert.throws(() => answerRequest(asked, misplaced, { nowMs: NOW, verifySignature }), code("decision_approver_mismatch"));
  // An option with no bound payload keeps the answer-object rule.
  assert.equal(answerRequest(asked, response({ option_id: "wait" }, asked), { nowMs: NOW, verifySignature }).effect, "applied");
});

test("a bound option is not answered by free text, and its binding is a digest (debt 11b)", () => {
  const asked = bound();
  const free = response({ option_id: "waive_seat", normalized_from: "fine", confirmed_material_scope: true }, asked, { payload_hash: BOUND });
  assert.throws(() => answerRequest(asked, free, { nowMs: NOW, verifySignature }), code("decision_packet_incomplete"));
  const scoped = response({ option_id: "waive_seat", confirmed_material_scope: true }, asked, { payload_hash: BOUND });
  assert.throws(() => answerRequest(asked, scoped, { nowMs: NOW, verifySignature }), code("decision_packet_incomplete"));
  for (const value of ["9".repeat(63), "G".repeat(64), 7, null]) {
    const malformed = request();
    malformed.options[1] = { ...malformed.options[1], signed_payload_hash: value };
    assert.throws(() => assertPacketDecidable(malformed), code("decision_packet_incomplete"), String(value));
  }
  assert.doesNotThrow(() => assertPacketDecidable(bound()));
});
