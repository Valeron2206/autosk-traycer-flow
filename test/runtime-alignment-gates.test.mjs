/**
 * Tests for the human alignment gates (issue #4).
 *
 * The panel checks the quality of a decision; these gates establish that the
 * decision was the model's to make. Every case below is one way that could stop
 * being true: an approval that was never given, one given for another version
 * of the question, a resume treated as consent, an ambiguity filed as an
 * assumption, or a policy stretched past what it named.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { digest } from "../src/runtime/contracts.mjs";
import {
  IDENTITY_FIELDS,
  KINDS,
  REQUIRED_FRAMING,
  alignmentIdentity,
  alignmentPacket,
  alignmentQuestion,
  correctionEffect,
  gateAdmission,
  materialAmbiguityErrors,
  policyAlignment,
  quickFlowGates,
  recordAlignment,
  resumeAdmission,
  scopeDigest,
} from "../src/host/alignment-gates.mjs";
import { testSigner } from "./support/user-decision-signer.mjs";

const code = (name) => (error) => error.code === name;
const NOW = Date.parse("2026-09-09T10:00:00Z");
const PROJECT_ROOT = "0".repeat(64);
const hex = (char) => char.repeat(64);

// What the user is asked about besides the kind and the scope: 02 §7's
// preimage without the decision, which only exists once they answer.
const FACTS = Object.freeze({
  project_root_sha256: PROJECT_ROOT,
  epic_id: "e-1",
  anchor_version: 3,
  subject_hash: hex("1"),
  material_manifest_hash: hex("2"),
  projector: { version: 1, hash: hex("3"), inputs_hash: hex("4") },
  classifier: { version: 1, hash: hex("5") },
  policy: null,
  protocol_hash: hex("6"),
});

// The answers are daemon UserDecisionRecords, signed by a test key the
// injected verifier knows; the product has neither (ADR-023).
const signer = testSigner();
const at = { nowMs: NOW, verifySignature: signer.verifySignature };

const framing = {
  brief: {
    goal: "creation is idempotent under a crash",
    affected: "operators running fan-out",
    why_now: "a retry currently duplicates children",
    scope: ["daemon creation path"],
    non_goals: ["the scheduler"],
    success_criteria: "one child per creation key",
    open_questions: [],
  },
  core_flow: {
    user_actions: ["retry a failed fan-out"],
    visible_states: ["pending", "created"],
    unhappy_paths: ["the daemon dies mid-write"],
    actor_rights: ["only the parent may create"],
    decisions: [],
  },
  tech_plan: {
    unknowns: [],
    multi_implementation_answers: [],
    silent_inferences: [],
    closed_decisions: ["the creation key is content-addressed"],
  },
  tickets: {
    ticket_set: ["T-1", "T-2"],
    dependency_graph: [["T-1", "T-2"]],
    per_ticket_scope: { "T-1": ["src/store"], "T-2": ["src/api"] },
    verifiable_outcome: { "T-1": "the key survives a kill", "T-2": "the API rejects a duplicate" },
    exclusions: ["no changes to the scheduler"],
  },
};

const packetFor = (kind, overrides = {}) => alignmentPacket({
  kind,
  framing: framing[kind],
  facts: FACTS,
  requestId: `req-${kind}`,
  approver: "owner",
  expiresAt: "2026-09-10T10:00:00Z",
  ...overrides,
});

const confirm = (packet, overrides = {}) => signer.respond(packet, { option_id: "confirm", ...overrides });

// The facts in force now, for one kind: what the gate recomputes the
// identity from.
function facts(kind, overrides = {}) {
  return { ...FACTS, kind, scope_hash: scopeDigest(kind, framing[kind]), ...overrides };
}
const context = (kind, anchorVersion = 3) => ({ facts: facts(kind, { anchor_version: anchorVersion }) });

test("an unconfirmed framing produces no normative artifact", () => {
  // The gate is fail-closed: no record is not an approval.
  for (const kind of KINDS) {
    const admission = gateAdmission({ ...context(kind), records: [] });
    assert.equal(admission.decision, "park", kind);
    assert.equal(admission.reason, "alignment_missing", kind);
    assert.equal(admission.resume_target, `await_${kind}_alignment`);
  }
});

test("a confirmed framing admits the artifact it was about", () => {
  const packet = packetFor("brief");
  const result = recordAlignment(packet, confirm(packet), at);
  assert.equal(result.outcome, "confirmed");
  assert.equal(result.record.authority, "user");
  assert.equal(result.record.approved_by, "owner");
  const admission = gateAdmission({ ...context("brief"), records: [result.record] });
  assert.equal(admission.decision, "proceed");
  assert.equal(admission.authority, "user");
  // And it admits that artifact only: a Brief approval is not a Tickets one.
  assert.equal(gateAdmission({ ...context("tickets"), records: [result.record] }).decision, "park");
});

test("a revision is a recorded answer, not a missing one", () => {
  const packet = packetFor("core_flow");
  const result = recordAlignment(packet, confirm(packet, { option_id: "revise" }), at);
  assert.equal(result.outcome, "revise");
  assert.equal(result.record, undefined);
  assert.equal(gateAdmission({ ...context("core_flow"), records: [] }).decision, "park");
});

test("an unresolved product decision is not an assumption", () => {
  // Filing it as one is how a decision that was the user's gets made by
  // whoever drafts next.
  const ambiguous = {
    ...framing.core_flow,
    assumptions: [{ id: "a-1", material: true, text: "we assume cancel discards partial work" }],
  };
  assert.ok(materialAmbiguityErrors(ambiguous).some((error) => error.reason === "material_ambiguity_unresolved"));
  assert.throws(
    () => packetFor("core_flow", { framing: ambiguous }),
    code("material_ambiguity_unresolved"),
  );
  // Two materially different answers is the same thing said another way.
  assert.ok(
    materialAmbiguityErrors({ assumptions: [{ id: "a-2", alternatives: ["queue", "reject"] }] }).length === 1,
  );
  // One alternative is not a choice, and no alternatives is not either: the
  // bound is "more than one", and only two of the three counts were asked.
  assert.deepEqual(materialAmbiguityErrors({ assumptions: [{ id: "a-3", alternatives: ["queue"] }] }), []);
  assert.deepEqual(materialAmbiguityErrors({ assumptions: [{ id: "a-4", alternatives: [] }] }), []);
  assert.deepEqual(materialAmbiguityErrors({ assumptions: [{ id: "a-5" }] }), []);
});

test("a silent inference the user never saw blocks the Tech Plan", () => {
  const hidden = {
    ...framing.tech_plan,
    silent_inferences: [{ id: "i-1", text: "the store is single-writer", shown_to_user: false }],
  };
  assert.ok(materialAmbiguityErrors(hidden).some((error) => /never shown to the user/u.test(error.detail)));
  const shown = {
    ...framing.tech_plan,
    silent_inferences: [{ id: "i-1", text: "the store is single-writer", shown_to_user: true }],
  };
  assert.deepEqual(materialAmbiguityErrors(shown), []);
});

test("an incomplete framing cannot be put in front of the user as complete", () => {
  for (const kind of KINDS) {
    for (const field of REQUIRED_FRAMING[kind]) {
      const partial = { ...framing[kind] };
      delete partial[field];
      assert.throws(() => scopeDigest(kind, partial), code("alignment_missing"), `${kind}/${field}`);
    }
  }
});

test("Tickets changed after the approval make the approval stale", () => {
  const packet = packetFor("tickets");
  const { record } = recordAlignment(packet, confirm(packet), at);
  assert.equal(gateAdmission({ ...context("tickets"), records: [record] }).decision, "proceed");

  const changed = { ...framing.tickets, ticket_set: ["T-1", "T-2", "T-3"] };
  const admission = gateAdmission({
    facts: facts("tickets", { scope_hash: scopeDigest("tickets", changed) }),
    records: [record],
  });
  assert.equal(admission.decision, "park");
  assert.equal(admission.reason, "alignment_stale");
});

test("a panel PASS does not stand in for the breakdown approval", () => {
  // The gate reads alignment records; a verdict about quality is not one of
  // them, whatever it says.
  const admission = gateAdmission({
    ...context("tickets"),
    records: [{ kind: "panel", identity: "whatever", anchor_version: 3, authority: "panel" }],
  });
  assert.equal(admission.decision, "park");
  assert.equal(admission.reason, "alignment_missing");
});

test("an answer that is neither a confirmation nor a revision records nothing", () => {
  // This module builds two-option packets and does not only ever read its own,
  // so a third option from somewhere else is not treated as a confirmation.
  const packet = packetFor("brief");
  const wider = {
    ...packet,
    options: [...packet.options, { option_id: "defer", consequence: "The framing waits another week." }],
  };
  assert.throws(
    () => recordAlignment(wider, confirm(packet, { option_id: "defer" }), at),
    code("alignment_missing"),
  );
});

test("an unknown artifact kind is refused wherever it is asked", () => {
  assert.throws(
    () => gateAdmission({ facts: facts("brief", { kind: "panel" }), records: [] }),
    code("alignment_missing"),
  );
});

test("a bare resume does not pass a gate", () => {
  // A crash is not a decision.
  const state = { facts: facts("brief"), records: [] };
  assert.equal(resumeAdmission(state).decision, "park");
  const packet = packetFor("brief");
  const { record } = recordAlignment(packet, confirm(packet), at);
  assert.equal(resumeAdmission({ ...state, records: [record] }).decision, "proceed");
});

test("an autonomous policy continues only within the scope it recorded", () => {
  // A policy alignment is bound to the current policy's issuance and
  // disposition (02 §7), so the facts in force name one.
  const current = (kind) => facts(kind, { policy: { issuance_hash: hex("7"), disposition_hash: hex("8") } });
  const policy = { policy_ref: "policy-9", kinds: ["brief"], anchor_version: 3 };
  const record = policyAlignment(policy, current("brief"));
  assert.equal(record.authority, "policy");
  assert.equal(record.user_decision, null);
  assert.equal(gateAdmission({ facts: current("brief"), records: [record] }).decision, "proceed");
  // A policy that has since been revoked or replaced is another disposition.
  const revoked = facts("brief", { policy: { issuance_hash: hex("7"), disposition_hash: hex("9") } });
  assert.equal(gateAdmission({ facts: revoked, records: [record] }).reason, "alignment_stale");
  // With no current policy there is nothing for it to be bound to.
  assert.throws(() => policyAlignment(policy, facts("brief")), code("alignment_missing"));

  // Not the absence of a question: it covers what it names and nothing else.
  assert.throws(() => policyAlignment(policy, current("tickets")), code("policy_scope_exceeded"));
  assert.throws(() => policyAlignment({ ...policy, anchor_version: 2 }, current("brief")), code("alignment_stale"));
  assert.throws(() => policyAlignment({ kinds: ["brief"], anchor_version: 3 }, current("brief")), code("alignment_missing"));
  // An empty policy reference is as absent as none: a policy that names itself
  // with the empty string has named nothing, and `> 0` is what says so.
  assert.throws(() => policyAlignment({ ...policy, policy_ref: "" }, current("brief")), code("alignment_missing"));
  assert.doesNotThrow(() => policyAlignment({ ...policy, policy_ref: "p" }, current("brief")));
});

test("no record and a stale record are told apart in the reason and in the detail", () => {
  // `forKind.length === 0` decides both the refusal class and the sentence an
  // operator reads. With a `!==` there the two would swap: a missing alignment
  // would be reported as one given for another anchor version, sending someone
  // to re-approve something that was never approved.
  const missing = gateAdmission({ ...context("brief"), records: [] });
  assert.equal(missing.reason, "alignment_missing");
  assert.match(missing.detail, /no alignment record for brief/u);

  const packet = packetFor("brief");
  const stale = recordAlignment(packet, confirm(packet), at).record;
  const drifted = gateAdmission({ ...context("brief", 99), records: [stale] });
  assert.equal(drifted.reason, "alignment_stale");
  assert.match(drifted.detail, /another anchor version or scope/u);
});

test("a correction while waiting raises the anchor version and restarts the cycle", () => {
  const packet = packetFor("brief");
  const { record } = recordAlignment(packet, confirm(packet), at);
  const effect = correctionEffect({ anchorVersion: 3, records: [record], waitingFor: "core_flow" });
  assert.equal(effect.anchor_version, 4);
  assert.deepEqual([...effect.invalidated], ["brief"]);
  assert.equal(effect.restart, "clarify_core_flow");
  // A record already at the new anchor version is not invalidated by reaching
  // it: the boundary is "older than the next version", and a record exactly at
  // it survives while one exactly below does not.
  const atNext = { ...record, kind: "tech_plan", anchor_version: 4 };
  const atCurrent = { ...record, kind: "tickets", anchor_version: 3 };
  const mixed = correctionEffect({ anchorVersion: 3, records: [atNext, atCurrent], waitingFor: "core_flow" });
  assert.deepEqual([...mixed.invalidated], ["tickets"]);
  // And the approval given under the old anchor no longer admits anything.
  assert.equal(gateAdmission({ ...context("brief", 4), records: [record] }).reason, "alignment_stale");
});

test("Quick flow is not blocked by these states until it stops being quick", () => {
  assert.deepEqual({ ...quickFlowGates({ classification: "quick", scopeGrowth: "none" }) }, {
    flow: "quick",
    gates: [],
  });
  const grown = quickFlowGates({ classification: "quick", scopeGrowth: "material" });
  assert.equal(grown.flow, "planned");
  assert.equal(grown.reclassified, true);
  assert.deepEqual([...grown.gates], [...KINDS]);
  assert.deepEqual([...quickFlowGates({ classification: "planned" }).gates], [...KINDS]);
});

test("the approval identity is 02 §7's twelve fields under its domain, and each one moves it (R6-15)", () => {
  const decision = { record_id: "udr-0001", record_hash: hex("a"), provenance_hash: hex("b") };
  const base = { ...facts("brief"), user_decision: decision };
  assert.deepEqual([...IDENTITY_FIELDS], [
    "project_root_sha256", "epic_id", "kind", "anchor_version", "scope_hash", "subject_hash",
    "material_manifest_hash", "projector", "user_decision", "classifier", "policy", "protocol_hash",
  ]);
  assert.deepEqual(Object.keys(base).sort(), [...IDENTITY_FIELDS].sort());
  const original = alignmentIdentity(base);
  assert.equal(original, digest("autosk-flow/alignment-approval/v1", base));
  for (const [field, value] of [
    ["project_root_sha256", hex("9")],
    ["epic_id", "e-2"],
    ["kind", "tickets"],
    ["anchor_version", 4],
    ["scope_hash", hex("9")],
    ["subject_hash", hex("9")],
    ["material_manifest_hash", hex("9")],
    ["projector", { ...FACTS.projector, inputs_hash: hex("9") }],
    ["user_decision", { ...decision, record_hash: hex("9") }],
    ["classifier", { ...FACTS.classifier, version: 2 }],
    ["policy", { issuance_hash: hex("7"), disposition_hash: hex("8") }],
    ["protocol_hash", hex("9")],
  ]) {
    assert.notEqual(alignmentIdentity({ ...base, [field]: value }), original, field);
  }
  // The question is the same preimage without the decision, under its own
  // domain: an approval identity can never be read as a question's.
  const { user_decision: _omitted, ...question } = base;
  assert.equal(alignmentQuestion(question), digest("autosk-flow/alignment-question/v1", question));
  assert.notEqual(alignmentQuestion(question), original);
});

test("an identity is refused for a fact that is missing, malformed or extra (R6-15)", () => {
  const decision = { record_id: "udr-0001", record_hash: hex("a"), provenance_hash: hex("b") };
  const base = { ...facts("brief"), user_decision: decision };
  assert.throws(() => alignmentIdentity({ ...base, kind: "panel" }), code("alignment_missing"));
  assert.throws(() => alignmentIdentity({ ...base, anchor_version: "3" }), code("alignment_stale"));
  assert.throws(() => alignmentIdentity(undefined), code("alignment_missing"));
  for (const field of IDENTITY_FIELDS.filter((name) => !["kind", "anchor_version"].includes(name))) {
    const missing = { ...base };
    delete missing[field];
    assert.throws(() => alignmentIdentity(missing), code("alignment_missing"), `missing ${field}`);
  }
  for (const [field, value] of [
    ["project_root_sha256", "0"],
    ["epic_id", ""],
    ["epic_id", 7],
    ["scope_hash", "s"],
    ["subject_hash", hex("A")],
    ["material_manifest_hash", null],
    ["protocol_hash", undefined],
    ["projector", null],
    ["projector", { version: "1", hash: hex("3"), inputs_hash: hex("4") }],
    ["projector", { version: 1, hash: "3", inputs_hash: hex("4") }],
    ["projector", { version: 1, hash: hex("3"), inputs_hash: "4" }],
    ["projector", { version: 1, hash: hex("3"), inputs_hash: hex("4"), extra: 1 }],
    ["classifier", null],
    ["classifier", { version: 1.5, hash: hex("5") }],
    ["classifier", { version: 1, hash: "5" }],
    ["classifier", { version: 1, hash: hex("5"), extra: 1 }],
    ["policy", { issuance_hash: "7", disposition_hash: hex("8") }],
    ["policy", { issuance_hash: hex("7"), disposition_hash: "8" }],
    ["policy", { issuance_hash: hex("7") }],
    ["policy", "none"],
    ["user_decision", { ...decision, record_id: "" }],
    ["user_decision", { ...decision, record_id: 7 }],
    ["user_decision", { ...decision, record_hash: "a" }],
    ["user_decision", { ...decision, provenance_hash: "b" }],
    ["user_decision", { record_id: "udr-0001", record_hash: hex("a") }],
    ["user_decision", "udr-0001"],
  ]) {
    assert.throws(() => alignmentIdentity({ ...base, [field]: value }), code("alignment_missing"), `${field}=${JSON.stringify(value)}`);
  }
  assert.throws(() => alignmentIdentity({ ...base, extra: "x" }), code("alignment_missing"));
  // An approval has a source: a user decision, or a current policy.
  assert.throws(() => alignmentIdentity({ ...base, user_decision: null }), code("alignment_missing"));
  const policy = { issuance_hash: hex("7"), disposition_hash: hex("8") };
  assert.match(alignmentIdentity({ ...base, user_decision: null, policy }), /^[a-f0-9]{64}$/u);
  // A question carries no decision.
  assert.throws(() => alignmentQuestion(base), code("alignment_missing"));
});

test("the packet asks about the question, and the record binds the answer to it (R6-15)", () => {
  const packet = packetFor("brief");
  assert.equal(packet.project_identity, `sha256:${PROJECT_ROOT}`);
  assert.equal(packet.identities.anchor_version, 3);
  assert.equal(packet.identities.candidate, alignmentQuestion(facts("brief")));
  const answer = confirm(packet);
  const { record, decision } = recordAlignment(packet, answer, at);
  assert.deepEqual(record.user_decision, {
    record_id: decision.user_decision_record_id,
    record_hash: decision.user_decision_record_hash,
    provenance_hash: decision.user_decision_provenance_hash,
  });
  assert.equal(record.identity, alignmentIdentity({ ...facts("brief"), user_decision: record.user_decision }));
  assert.equal(record.source, "user_decision");
  // A record whose decision is not the one it names is stale against the facts
  // in force. This is staleness, not authenticity: the gate recomputes the
  // identity and cannot tell a forged record whose identity was recomputed too —
  // authenticity belongs to the daemon-resolved record (ADR-091, left open).
  const forged = { ...record, user_decision: { ...record.user_decision, record_hash: hex("9") } };
  assert.equal(gateAdmission({ ...context("brief"), records: [forged] }).reason, "alignment_stale");
  // Nor does one whose decision is not a decision at all.
  const broken = { ...record, user_decision: "udr-0001" };
  assert.equal(gateAdmission({ ...context("brief"), records: [broken] }).reason, "alignment_stale");
  // Each fact of the question moves what the gate asks for.
  for (const [field, value] of [
    ["subject_hash", hex("9")],
    ["material_manifest_hash", hex("9")],
    ["projector", { ...FACTS.projector, version: 2 }],
    ["classifier", { ...FACTS.classifier, hash: hex("9") }],
    ["policy", { issuance_hash: hex("7"), disposition_hash: hex("8") }],
    ["protocol_hash", hex("9")],
  ]) {
    assert.equal(gateAdmission({ facts: facts("brief", { [field]: value }), records: [record] }).reason, "alignment_stale", field);
  }
});

test("an alignment is not recorded from a name, or without a signer (R6-14)", () => {
  const packet = packetFor("brief");
  const bare = { option_id: "confirm", answered_by: "owner", answered_at: "2026-09-09T10:05:00Z", identities: { ...packet.identities } };
  assert.throws(() => recordAlignment(packet, bare, at), code("decision_approver_mismatch"));
  assert.throws(() => recordAlignment(packet, confirm(packet), { nowMs: NOW }), code("decision_approver_mismatch"));
});

test("the facts a record binds are the question the user signed (review M1)", () => {
  const packet = packetFor("brief");
  const answer = confirm(packet);
  // The signed question stays; the facts the record would bind are other facts.
  const altered = { ...packet, alignment_facts: { ...packet.alignment_facts, subject_hash: hex("9") } };
  assert.throws(() => recordAlignment(altered, answer, at), code("alignment_stale"));
  // The kind and the scope the packet names are the ones inside the question.
  assert.throws(() => recordAlignment({ ...packet, kind: "tickets" }, answer, at), code("alignment_stale"));
  assert.throws(() => recordAlignment({ ...packet, scope_digest: hex("9") }, answer, at), code("alignment_stale"));
  // A revision of such a packet is refused too: it answers a question nobody asked.
  const revise = confirm(packet, { option_id: "revise" });
  assert.throws(() => recordAlignment(altered, revise, at), code("alignment_stale"));
  assert.equal(recordAlignment(packet, answer, at).outcome, "confirmed");
});

test("a user decision under a current policy binds both (review L5)", () => {
  const decision = { record_id: "udr-0001", record_hash: hex("a"), provenance_hash: hex("b") };
  const policy = { issuance_hash: hex("7"), disposition_hash: hex("8") };
  const both = alignmentIdentity({ ...facts("brief", { policy }), user_decision: decision });
  assert.notEqual(both, alignmentIdentity({ ...facts("brief"), user_decision: decision }));
  assert.notEqual(both, alignmentIdentity({ ...facts("brief", { policy }), user_decision: null }));
});
