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

import {
  KINDS,
  REQUIRED_FRAMING,
  alignmentIdentity,
  alignmentPacket,
  correctionEffect,
  gateAdmission,
  materialAmbiguityErrors,
  policyAlignment,
  quickFlowGates,
  recordAlignment,
  resumeAdmission,
  scopeDigest,
} from "../src/host/alignment-gates.mjs";

const code = (name) => (error) => error.code === name;
const NOW = Date.parse("2026-09-09T10:00:00Z");
const PROJECT = `sha256:${"0".repeat(58)}`;

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
  projectIdentity: PROJECT,
  epicId: "e-1",
  anchorVersion: 3,
  requestId: `req-${kind}`,
  approver: "owner",
  expiresAt: "2026-09-10T10:00:00Z",
  ...overrides,
});

const confirm = (packet, overrides = {}) => ({
  option_id: "confirm",
  answered_by: "owner",
  answered_at: "2026-09-09T10:05:00Z",
  identities: { ...packet.identities },
  ...overrides,
});

function context(kind, anchorVersion = 3) {
  return {
    kind,
    projectIdentity: PROJECT,
    epicId: "e-1",
    anchorVersion,
    scopeDigest: scopeDigest(kind, framing[kind]),
  };
}

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
  const result = recordAlignment(packet, confirm(packet), { nowMs: NOW });
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
  const result = recordAlignment(packet, confirm(packet, { option_id: "revise" }), { nowMs: NOW });
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
    () => alignmentPacket({ ...context("core_flow"), framing: ambiguous, requestId: "r", approver: "owner", expiresAt: "2026-09-10T10:00:00Z" }),
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
  const { record } = recordAlignment(packet, confirm(packet), { nowMs: NOW });
  assert.equal(gateAdmission({ ...context("tickets"), records: [record] }).decision, "proceed");

  const changed = { ...framing.tickets, ticket_set: ["T-1", "T-2", "T-3"] };
  const admission = gateAdmission({
    ...context("tickets"),
    scopeDigest: scopeDigest("tickets", changed),
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
    () => recordAlignment(wider, confirm(packet, { option_id: "defer" }), { nowMs: NOW }),
    code("alignment_missing"),
  );
});

test("an unknown artifact kind is refused wherever it is asked", () => {
  assert.throws(
    () => gateAdmission({ ...context("brief"), kind: "panel", records: [] }),
    code("alignment_missing"),
  );
});

test("a bare resume does not pass a gate", () => {
  // A crash is not a decision.
  const state = {
    kind: "brief",
    project_identity: PROJECT,
    epic_id: "e-1",
    anchor_version: 3,
    scope_digest: scopeDigest("brief", framing.brief),
    records: [],
  };
  assert.equal(resumeAdmission(state).decision, "park");
  const packet = packetFor("brief");
  const { record } = recordAlignment(packet, confirm(packet), { nowMs: NOW });
  assert.equal(resumeAdmission({ ...state, records: [record] }).decision, "proceed");
});

test("an autonomous policy continues only within the scope it recorded", () => {
  const scope = scopeDigest("brief", framing.brief);
  const policy = { policy_ref: "policy-9", kinds: ["brief"], anchor_version: 3 };
  const record = policyAlignment(policy, { ...context("brief"), scopeDigest: scope });
  assert.equal(record.authority, "policy");
  assert.equal(gateAdmission({ ...context("brief"), records: [record] }).decision, "proceed");

  // Not the absence of a question: it covers what it names and nothing else.
  assert.throws(() => policyAlignment(policy, { ...context("tickets"), scopeDigest: scope }), code("policy_scope_exceeded"));
  assert.throws(
    () => policyAlignment({ ...policy, anchor_version: 2 }, { ...context("brief"), scopeDigest: scope }),
    code("alignment_stale"),
  );
  assert.throws(() => policyAlignment({ kinds: ["brief"], anchor_version: 3 }, { ...context("brief"), scopeDigest: scope }), code("alignment_missing"));
  // An empty policy reference is as absent as none: a policy that names itself
  // with the empty string has named nothing, and `> 0` is what says so.
  assert.throws(
    () => policyAlignment({ ...policy, policy_ref: "" }, { ...context("brief"), scopeDigest: scope }),
    code("alignment_missing"),
  );
  assert.doesNotThrow(() => policyAlignment({ ...policy, policy_ref: "p" }, { ...context("brief"), scopeDigest: scope }));
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
  const stale = recordAlignment(packet, confirm(packet), { nowMs: NOW }).record;
  const drifted = gateAdmission({ ...context("brief", 99), records: [stale] });
  assert.equal(drifted.reason, "alignment_stale");
  assert.match(drifted.detail, /another anchor version or scope/u);
});

test("a correction while waiting raises the anchor version and restarts the cycle", () => {
  const packet = packetFor("brief");
  const { record } = recordAlignment(packet, confirm(packet), { nowMs: NOW });
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

test("an identity names the kind, the version and the scope it was given for", () => {
  const base = { projectIdentity: PROJECT, epicId: "e-1", kind: "brief", anchorVersion: 3, scopeDigest: "s" };
  const original = alignmentIdentity(base);
  assert.notEqual(alignmentIdentity({ ...base, kind: "tickets" }), original);
  assert.notEqual(alignmentIdentity({ ...base, anchorVersion: 4 }), original);
  assert.notEqual(alignmentIdentity({ ...base, scopeDigest: "t" }), original);
  assert.notEqual(alignmentIdentity({ ...base, epicId: "e-2" }), original);
  assert.throws(() => alignmentIdentity({ ...base, kind: "panel" }), code("alignment_missing"));
  assert.throws(() => alignmentIdentity({ ...base, anchorVersion: "3" }), code("alignment_stale"));
});
