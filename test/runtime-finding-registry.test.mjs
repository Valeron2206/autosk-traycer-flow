/**
 * Tests for the canonical finding pipeline (issue #16 runtime).
 *
 * The contract lists the implementation tests it requires, and these are them.
 * The theme running through: a finding may be argued with, and may not be made
 * to disappear — not by averaging severities, not by a rejection with nothing
 * cited, not by a seat going quiet, and not by the candidate moving.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEST_OUTCOMES,
  PARK_REASONS,
  SEVERITIES,
  applyTriage,
  canonicalMerge,
  computeGate,
  contestComplete,
  effectiveSeverity,
  escalates,
  isOpen,
  lateFindingRoute,
  originatorId,
  registryDigest,
  rootCauseKey,
  supersede,
} from "../src/host/finding-registry.mjs";

const code = (name) => (error) => error.code === name;

function raw(seat, id, severity, { anchor = "AC-4", scope = ["daemon/core/src/store/creation.ts"] } = {}) {
  return {
    seat,
    raw_id: id,
    severity,
    claim: `${seat} says the guard is unreachable`,
    evidence_locator: `evidence/${seat}/${id}`,
    violated_anchor: anchor,
    affected_scope: scope,
    attempt: 1,
  };
}

function registryOf(canonicalFindings) {
  return {
    schema_version: 1,
    merge_algorithm: "root-cause-v1",
    candidate_identity: "a".repeat(64),
    seats: ["gpt", "grok", "muse", "opus"],
    raw_findings: [],
    canonical_findings: canonicalFindings,
  };
}

test("duplicates from two, three and four seats merge to one, keeping every originator", () => {
  for (const seats of [["gpt", "grok"], ["gpt", "grok", "muse"], ["gpt", "grok", "muse", "opus"]]) {
    const merged = canonicalMerge(seats.map((seat) => raw(seat, "F1", "high")));
    assert.equal(merged.length, 1, seats.join("+"));
    assert.deepEqual(merged[0].originators, seats.map((seat) => `${seat}:F1`).sort());
  }
});

test("raw ids are namespaced, so two seats numbering from 1 do not collide", () => {
  assert.equal(originatorId(raw("gpt", "F1", "high")), "gpt:F1");
  const merged = canonicalMerge([raw("gpt", "F1", "high"), raw("grok", "F1", "high", { anchor: "AC-9" })]);
  assert.equal(merged.length, 2);
});

test("two seats disagreeing on severity produce the highest before triage", () => {
  // A merge that averaged could quietly downgrade a critical by majority.
  const merged = canonicalMerge([
    raw("gpt", "F1", "medium"),
    raw("grok", "F2", "critical"),
    raw("muse", "F3", "low"),
  ]);
  assert.equal(merged[0].reported_severity, "critical");
});

test("the merge is a function of the findings, not of the order they arrived in", () => {
  const findings = [raw("gpt", "F1", "high"), raw("grok", "F2", "medium", { anchor: "AC-9" }), raw("muse", "F3", "low", { anchor: "AC-1" })];
  const forward = canonicalMerge(findings);
  const backward = canonicalMerge([...findings].reverse());
  assert.deepEqual(forward, backward);
});

test("a severity outside the shared scale is malformed, not a new severity", () => {
  assert.throws(() => canonicalMerge([raw("gpt", "F1", "catastrophic")]), code("unknown_severity"));
  assert.ok(PARK_REASONS.includes("unknown_severity"));
});

test("the root cause is what is violated and where, not how it was phrased", () => {
  // Four seats describe one defect in four sentences; merging on prose would
  // keep them apart.
  const a = raw("gpt", "F1", "high");
  const b = { ...raw("grok", "F9", "high"), claim: "an entirely different sentence about the same thing" };
  assert.equal(rootCauseKey(a), rootCauseKey(b));
  assert.equal(canonicalMerge([a, b]).length, 1);
});

test("a rejection without a citable basis is refused, and the finding stays confirmed", () => {
  // Disagreeing is allowed; disagreeing without citing anything is not.
  const [canonical] = canonicalMerge([raw("gpt", "F1", "high")]);
  assert.throws(
    () => applyTriage(canonical, { decision: "rejected", rejection_reason: "out_of_scope" }),
    code("missing_citable_basis"),
  );
  assert.throws(
    () => applyTriage(canonical, { decision: "rejected", basis: { kind: "anchor", reference: "AC-4" } }),
    code("missing_citable_basis"),
  );
  const rejected = applyTriage(canonical, {
    decision: "rejected",
    rejection_reason: "intended_behavior",
    basis: { kind: "anchor", reference: "AC-4#3" },
  });
  assert.equal(isOpen(rejected), false);
});

test("a downgrade needs a basis and must actually lower the severity", () => {
  const [canonical] = canonicalMerge([raw("gpt", "F1", "high")]);
  assert.throws(
    () => applyTriage(canonical, { decision: "confirmed_lower_severity", severity: "medium" }),
    code("missing_citable_basis"),
  );
  assert.throws(
    () =>
      applyTriage(canonical, {
        decision: "confirmed_lower_severity",
        severity: "critical",
        basis: { kind: "factual_proof", reference: "the path is unreachable" },
      }),
    code("missing_citable_basis"),
  );
  const downgraded = applyTriage(canonical, {
    decision: "confirmed_lower_severity",
    severity: "medium",
    basis: { kind: "factual_proof", reference: "the path is unreachable from any caller" },
  });
  assert.equal(effectiveSeverity(downgraded), "medium");
});

test("a raise needs a reason rather than a basis, and must raise", () => {
  // Raising a severity does not make a finding go away, so it is held to a
  // lower bar than removing one.
  const [canonical] = canonicalMerge([raw("gpt", "F1", "low")]);
  assert.throws(
    () => applyTriage(canonical, { decision: "confirmed_higher_severity", severity: "high" }),
    code("missing_citable_basis"),
  );
  assert.throws(
    () => applyTriage(canonical, { decision: "confirmed_higher_severity", severity: "low", reason: "it is worse" }),
    code("missing_citable_basis"),
  );
  const raised = applyTriage(canonical, {
    decision: "confirmed_higher_severity",
    severity: "high",
    reason: "the same input reaches the unguarded write path",
  });
  assert.equal(effectiveSeverity(raised), "high");
  assert.equal(computeGate(registryOf([raised])).verdict, "blocked");
});

test("an unknown triage decision is refused", () => {
  const [canonical] = canonicalMerge([raw("gpt", "F1", "high")]);
  assert.throws(() => applyTriage(canonical, { decision: "waived" }), code("unmergeable_finding"));
});

test("the contest goes to every originator, and a forfeit does not close the finding", () => {
  // Absence is not agreement.
  const [canonical] = canonicalMerge([raw("gpt", "F1", "high"), raw("grok", "F2", "high")]);
  assert.equal(contestComplete({ ...canonical, contest: [{ seat: "gpt", outcome: "upheld" }] }), false);
  const forfeited = {
    ...canonical,
    contest: [
      { seat: "gpt", outcome: "upheld" },
      { seat: "grok", outcome: "forfeited" },
    ],
  };
  assert.equal(contestComplete(forfeited), true);
  assert.equal(isOpen(forfeited), true);
  assert.equal(computeGate(registryOf([forfeited])).verdict, "blocked");
  assert.deepEqual(CONTEST_OUTCOMES.slice(), ["upheld", "withdrawn", "forfeited", "disagreed"]);
});

test("an unknown contest outcome is refused rather than counted as an answer", () => {
  // Otherwise a typo in an outcome would complete the contest by being present.
  const [canonical] = canonicalMerge([raw("gpt", "F1", "high")]);
  assert.throws(
    () => contestComplete({ ...canonical, contest: [{ seat: "gpt", outcome: "acknowledged" }] }),
    code("contest_incomplete"),
  );
});

test("a seat that did not originate the finding cannot contest it", () => {
  const [canonical] = canonicalMerge([raw("gpt", "F1", "high")]);
  assert.throws(
    () => contestComplete({ ...canonical, contest: [{ seat: "muse", outcome: "upheld" }] }),
    code("originator_unknown"),
  );
});

test("disagreement that survives the contest escalates rather than being resolved here", () => {
  const [canonical] = canonicalMerge([raw("gpt", "F1", "medium")]);
  const disagreed = { ...canonical, contest: [{ seat: "gpt", outcome: "disagreed" }], disposition: "fixed" };
  assert.equal(escalates(disagreed), true);
  const gate = computeGate(registryOf([disagreed]));
  assert.equal(gate.verdict, "blocked");
  assert.ok(gate.reasons.some((reason) => reason.startsWith("contest_disagreement")));
});

test("an incomplete contest blocks the gate on its own", () => {
  const [canonical] = canonicalMerge([raw("gpt", "F1", "medium"), raw("grok", "F2", "medium")]);
  const partial = { ...canonical, contest: [{ seat: "gpt", outcome: "upheld" }], disposition: "fixed" };
  const gate = computeGate(registryOf([partial]));
  assert.ok(gate.reasons.some((reason) => reason.startsWith("contest_incomplete")));
});

test("the gate is computed: criticals and highs block while open", () => {
  for (const severity of ["critical", "high"]) {
    const [canonical] = canonicalMerge([raw("gpt", "F1", severity)]);
    const contested = { ...canonical, contest: [{ seat: "gpt", outcome: "upheld" }] };
    const gate = computeGate(registryOf([contested]));
    assert.equal(gate.verdict, "blocked");
    assert.equal(gate.blocking_open, 1);
    // ...and closing it needs a re-review disposition, not an edit.
    const resolved = { ...contested, state: "resolved" };
    assert.equal(computeGate(registryOf([resolved])).verdict, "pass");
  }
});

test("a medium must be dispositioned, and a deferred one needs its debt Ticket", () => {
  const [canonical] = canonicalMerge([raw("gpt", "F1", "medium")]);
  const contested = { ...canonical, contest: [{ seat: "gpt", outcome: "upheld" }] };
  const undispositioned = computeGate(registryOf([contested]));
  assert.equal(undispositioned.verdict, "blocked");
  assert.equal(undispositioned.undispositioned_medium, 1);

  assert.equal(computeGate(registryOf([{ ...contested, disposition: "fixed" }])).verdict, "pass");
  assert.throws(
    () => computeGate(registryOf([{ ...contested, disposition: "deferred" }])),
    code("missing_debt_ticket"),
  );
  assert.equal(
    computeGate(registryOf([{ ...contested, disposition: "deferred", debt_ticket: "T-450" }])).verdict,
    "pass",
  );
});

test("low does not block", () => {
  const [canonical] = canonicalMerge([raw("gpt", "F1", "low")]);
  const contested = { ...canonical, contest: [{ seat: "gpt", outcome: "upheld" }] };
  assert.equal(computeGate(registryOf([contested])).verdict, "pass");
});

test("a stale finding is recorded and does not block the current candidate", () => {
  const [canonical] = canonicalMerge([raw("gpt", "F1", "critical")]);
  const stale = { ...canonical, state: "stale" };
  assert.equal(isOpen(stale), false);
  assert.equal(computeGate(registryOf([stale])).verdict, "pass");
});

test("supersession carries open findings forward and clears the contest", () => {
  // A finding does not disappear because the candidate moved, and a contest
  // answered about a superseded candidate does not apply to the current one.
  const merged = canonicalMerge([raw("gpt", "F1", "high"), raw("grok", "F2", "medium", { anchor: "AC-9" })]);
  const before = registryOf([
    { ...merged[0], contest: [{ seat: "gpt", outcome: "upheld" }] },
    { ...merged[1], state: "resolved" },
  ]);
  const after = supersede(before, "b".repeat(64));
  assert.equal(after.canonical_findings.length, 1);
  assert.equal(after.canonical_findings[0].canonical_id, "C001");
  assert.equal(after.canonical_findings[0].contest, undefined);
  assert.throws(() => supersede(before, before.candidate_identity), code("stale_candidate_binding"));
});

test("a late finding is routed forward, never by rewriting history", () => {
  assert.equal(lateFindingRoute("critical", "unintegrated"), "reopen_pass");
  assert.equal(lateFindingRoute("high", "integrated"), "correction_ticket");
  assert.equal(lateFindingRoute("critical", "released"), "change_issue");
  assert.equal(lateFindingRoute("medium", "integrated"), "ordinary_disposition");
  assert.equal(lateFindingRoute("medium", "unintegrated"), "ordinary_disposition");
  assert.equal(lateFindingRoute("critical", "superseded"), "recorded_stale");
  assert.throws(() => lateFindingRoute("critical", "somewhere"), code("registry_drift"));
  assert.throws(() => lateFindingRoute("urgent", "integrated"), code("unknown_severity"));
});

test("the registry digest is over content, not over the digest field", () => {
  const registry = registryOf(canonicalMerge([raw("gpt", "F1", "high")]));
  const digest = registryDigest(registry);
  assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.equal(registryDigest({ ...registry, registry_digest: digest }), digest);
  assert.notEqual(registryDigest({ ...registry, candidate_identity: "c".repeat(64) }), digest);
});

test("the severity scale is the one the contract closes", () => {
  assert.deepEqual(SEVERITIES.slice(), ["critical", "high", "medium", "low"]);
});
