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
  requestState,
  statusProjection,
  voidRequest,
} from "../src/host/decision-queue.mjs";
import { ROOT } from "../scripts/validate-planning-ref-design.mjs";
import { validateJsonSchema } from "../scripts/validate-planning-ref-design.mjs";

const REQUEST_PATH = "resources/human-decision/human-decision-request.example.json";
const SCHEMA_PATH = "resources/human-decision/human-decision-request.schema.json";

const shipped = JSON.parse(await readFile(path.join(ROOT, REQUEST_PATH), "utf8"));
const schema = JSON.parse(await readFile(path.join(ROOT, SCHEMA_PATH), "utf8"));

const NOW = Date.parse("2026-09-08T13:00:00.000Z");

const request = () => JSON.parse(JSON.stringify(shipped));

const code = (name) => (error) => error.code === name;

function response(overrides = {}) {
  return {
    option_id: "wait",
    answered_by: "owner",
    answered_at: new Date(NOW).toISOString(),
    identities: { anchor_version: shipped.identities.anchor_version, candidate: shipped.identities.candidate },
    ...overrides,
  };
}

test("the shipped packet is decidable and opens", () => {
  assert.doesNotThrow(() => assertPacketDecidable(request()));
  const opened = openRequest(request(), { nowMs: NOW });
  assert.equal(requestState(opened, NOW), "pending");
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
    assert.throws(() => answerRequest(request(), moved, { nowMs: NOW }), code("decision_identity_stale"));
  }
  const missing = response();
  delete missing.identities;
  assert.throws(() => answerRequest(request(), missing, { nowMs: NOW }), code("decision_identity_stale"));
});

test("an answer from another approver, or naming an option nobody offered, is refused", () => {
  assert.throws(
    () => answerRequest(request(), response({ answered_by: "someone_else" }), { nowMs: NOW }),
    code("decision_approver_mismatch"),
  );
  assert.throws(
    () => answerRequest(request(), response({ option_id: "invented" }), { nowMs: NOW }),
    code("decision_option_unknown"),
  );
});

test("an expired or voided request cannot be answered", () => {
  const late = Date.parse(shipped.expires_at) + 1;
  assert.throws(() => answerRequest(request(), response(), { nowMs: late }), code("decision_expired"));
  const voided = voidRequest(request(), "the candidate was rebuilt", { nowMs: NOW });
  assert.equal(requestState(voided, NOW), "voided");
  assert.throws(() => answerRequest(voided, response(), { nowMs: NOW }), code("decision_request_voided"));
  assert.throws(() => voidRequest(voided, "again", { nowMs: NOW }), code("decision_request_voided"));
  assert.throws(() => voidRequest(request(), "", { nowMs: NOW }), code("decision_packet_incomplete"));
});

test("a duplicate answer is idempotent, and a different one is refused", () => {
  const first = answerRequest(request(), response(), { nowMs: NOW });
  assert.equal(first.effect, "applied");
  assert.equal(requestState(first.request, NOW), "answered");
  const again = answerRequest(first.request, response(), { nowMs: NOW });
  assert.equal(again.effect, "replayed");
  // The same answer produces the same record and no second side effect.
  assert.deepEqual(again.decision, first.decision);
  assert.throws(
    () => answerRequest(first.request, response({ option_id: "waive_seat" }), { nowMs: NOW }),
    code("decision_option_unknown"),
  );
});

test("the decision record names the resume target and its own digest", () => {
  const { decision } = answerRequest(request(), response(), { nowMs: NOW });
  assert.deepEqual(decision.resume_target, shipped.resume_target);
  assert.match(decision.decision_digest, /^[0-9a-f]{64}$/u);
  assert.equal(decisionRecord(request(), response()).option_id, "wait");
});

test("a normalised free-text answer to an irreversible option needs confirmation", () => {
  // "Sure, but only for the docs" becoming an approval for everything is what
  // silent interpretation looks like.
  const free = response({ option_id: "waive_seat", normalized_from: "fine, skip grok this once" });
  assert.throws(() => answerRequest(request(), free, { nowMs: NOW }), code("decision_packet_incomplete"));
  const confirmed = { ...free, confirmed_material_scope: true };
  assert.equal(answerRequest(request(), confirmed, { nowMs: NOW }).effect, "applied");
  // A reversible option does not need the extra confirmation.
  const reversible = response({ normalized_from: "let's wait" });
  assert.equal(answerRequest(request(), reversible, { nowMs: NOW }).effect, "applied");
});

test("an answered request still validates against the shipped schema", () => {
  // The queue writes what the contract describes, checked against the contract
  // rather than against a second copy of it.
  const { request: answered } = answerRequest(request(), response(), { nowMs: NOW });
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
  const { request: answered } = answerRequest(
    { ...request(), request_id: "decision-answered" },
    response(),
    { nowMs: NOW },
  );
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
