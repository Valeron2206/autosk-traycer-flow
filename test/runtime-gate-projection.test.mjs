/**
 * Tests for the gate store projection (issue #15 runtime).
 *
 * The design exists because both obvious comparisons are wrong, so the tests
 * are mostly about the middle: four seats finishing in different orders must
 * not invalidate each other, and a driver writing an allowed-looking field with
 * no provenance must not slip through the same gap.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTORS,
  CONCURRENT_FIELDS,
  PARK_REASONS,
  PROJECTED_FIELDS,
  canonical,
  changedFields,
  evaluateRun,
  frozenPrefixDigest,
  projectionDigest,
  provenanceErrors,
} from "../src/host/gate-projection.mjs";

const code = (name) => (error) => error.code === name;

const BINDING = "sha256:" + "a".repeat(58);

function state(overrides = {}) {
  return {
    project_binding: BINDING,
    parent_child_relation: "T-100/T-102",
    run: "run-7",
    round: 1,
    attempt: 1,
    seat: "opus",
    role: "gate",
    artifact_identity: "b".repeat(64),
    candidate_identity: "c".repeat(64),
    base_hashes: ["d".repeat(40)],
    anchor_version: 3,
    protocol_lock: "e".repeat(64),
    runtime_lock: "f".repeat(64),
    instruction_lock: "0".repeat(64),
    creation_binding: "1".repeat(64),
    provider_session_binding: "session-opus-1",
    reviewer_routing: ["opus", "astra", "grok", "muse"],
    author_family: "anthropic",
    fixer_family: "openai-codex",
    expected_blocker: "T-101",
    allowed_transitions: ["to_review", "to_fix"],
    result_schema: 1,
    accepted_findings: ["C001"],
    // outside the projection
    autoskd_status: "running",
    timestamps: { updated_at: "2026-09-08T14:00:00Z" },
    worker_lease: "lease-1",
    sibling_result: null,
    ...overrides,
  };
}

function journalRecord(overrides = {}) {
  return {
    actor: "daemon",
    operation_id: "op-1",
    permitted_fields: ["autoskd_status", "timestamps", "worker_lease", "sibling_result", "sibling_terminal_status"],
    changed_fields: ["timestamps"],
    before_digest: "a".repeat(64),
    after_digest: "b".repeat(64),
    sequence: 1,
    project_binding: BINDING,
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    before: state(),
    after: state(),
    journal: [],
    projectedFields: PROJECTED_FIELDS,
    projectionVersion: 1,
    runVersion: 1,
    ...overrides,
  };
}

test("an untouched run is accepted", () => {
  const outcome = evaluateRun(run());
  assert.equal(outcome.verdict, "accepted");
  assert.equal(outcome.projection_digest_before, outcome.projection_digest_after);
});

test("four seats finishing in different orders do not invalidate each other", () => {
  // Not an edge case: it is the normal shape of a Panel.
  const finishes = [
    { sibling_result: { astra: "pass" }, autoskd_status: "running" },
    { sibling_result: { astra: "pass", grok: "pass" }, autoskd_status: "running" },
    { sibling_result: { astra: "pass", grok: "pass", muse: "fail" }, sibling_terminal_status: "done" },
  ];
  for (const change of finishes) {
    const after = state(change);
    const outcome = evaluateRun(
      run({
        after,
        journal: [
          journalRecord({ changed_fields: changedFields(state(), after), sequence: 1 }),
        ],
      }),
    );
    assert.equal(outcome.verdict, "accepted", JSON.stringify(change));
  }
});

test("daemon timestamps, leases and counters never move the digest", () => {
  for (const field of CONCURRENT_FIELDS) {
    const before = projectionDigest(state());
    const after = projectionDigest(state({ [field]: "something entirely different" }));
    assert.equal(before, after, field);
  }
});

test("any projected field moving is a blocking non-verdict, named field by field", () => {
  // Not a pass, not a fail, and not a retry: the same question has to be asked
  // again from a known state.
  for (const field of ["candidate_identity", "anchor_version", "role", "accepted_findings", "allowed_transitions"]) {
    const outcome = evaluateRun(run({ after: state({ [field]: "moved" }) }));
    assert.equal(outcome.verdict, "blocking_non_verdict", field);
    assert.ok(outcome.reasons.some((entry) => entry.reason === "projection_changed" && entry.detail === field));
  }
});

test("the digest is over content, not over key order", () => {
  const reordered = {};
  for (const key of Object.keys(state()).reverse()) reordered[key] = state()[key];
  assert.equal(projectionDigest(state()), projectionDigest(reordered));
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
  // ...and a set-like array is compared as a set.
  assert.equal(
    projectionDigest(state({ reviewer_routing: ["muse", "grok", "astra", "opus"] })),
    projectionDigest(state()),
  );
});

test("a change with no provenance record is refused, not assumed to be the daemon's", () => {
  // The case a driver bug produces: an allowed-looking field written by nobody
  // in particular.
  const outcome = evaluateRun(run({ after: state({ worker_lease: "lease-2" }), journal: [] }));
  assert.equal(outcome.verdict, "blocking_non_verdict");
  assert.deepEqual(outcome.reasons, [{ reason: "missing_provenance", detail: "worker_lease", operation_id: null }]);
});

test("a change to a field the operation was not permitted to touch is refused", () => {
  const outcome = evaluateRun(
    run({
      after: state({ worker_lease: "lease-2" }),
      journal: [journalRecord({ permitted_fields: ["timestamps"], changed_fields: ["worker_lease"] })],
    }),
  );
  assert.ok(outcome.reasons.some((entry) => entry.reason === "field_not_permitted" && entry.detail === "worker_lease"));
});

test("an unknown writer is refused", () => {
  const outcome = evaluateRun(
    run({
      after: state({ timestamps: { updated_at: "later" } }),
      journal: [journalRecord({ actor: "someone" })],
    }),
  );
  assert.ok(outcome.reasons.some((entry) => entry.reason === "unknown_writer"));
  assert.deepEqual(ACTORS.slice(), ["daemon", "driver", "user", "model", "tool"]);
});

test("a record from another project is a violation by being visible", () => {
  const outcome = evaluateRun(
    run({
      after: state({ timestamps: { updated_at: "later" } }),
      journal: [journalRecord({ project_binding: "sha256:" + "9".repeat(58) })],
    }),
  );
  assert.ok(outcome.reasons.some((entry) => entry.reason === "cross_project_record"));
});

test("journal records out of sequence are refused", () => {
  const errors = provenanceErrors(
    [journalRecord({ sequence: 2 }), journalRecord({ operation_id: "op-2", sequence: 1 })],
    ["timestamps"],
    { projectBinding: BINDING },
  );
  assert.ok(errors.some((entry) => entry.reason === "provenance_out_of_order"));
  // The same sequence twice is also out of order: two records claiming one
  // position cannot both be next, and `<=` rather than `<` is what says so.
  assert.ok(
    provenanceErrors(
      [journalRecord({ sequence: 2 }), journalRecord({ operation_id: "op-2", sequence: 2 })],
      ["timestamps"],
      { projectBinding: BINDING },
    ).some((entry) => entry.reason === "provenance_out_of_order"),
  );
  // And a strictly increasing pair is silent, so the refusal is the ordering
  // and not the pairing.
  assert.deepEqual(
    provenanceErrors(
      [journalRecord({ sequence: 1 }), journalRecord({ operation_id: "op-2", sequence: 2 })],
      ["timestamps"],
      { projectBinding: BINDING },
    ).filter((entry) => entry.reason === "provenance_out_of_order"),
    [],
  );
});

test("comments append freely, and the frozen prefix may not change", () => {
  // An append that rewrites earlier bytes is not an append.
  const before = ["a", "b", "c"];
  const appended = ["a", "b", "c", "d"];
  const rewritten = ["a", "B", "c", "d"];
  assert.equal(frozenPrefixDigest(before, 3), frozenPrefixDigest(appended, 3));
  assert.notEqual(frozenPrefixDigest(before, 3), frozenPrefixDigest(rewritten, 3));
  // The checkpoint may sit at either end of the file — zero lines frozen, or
  // all of them — and one past the end is outside it. Only interior values were
  // tested, so both bounds could have been off by one.
  assert.doesNotThrow(() => frozenPrefixDigest(before, 0));
  assert.doesNotThrow(() => frozenPrefixDigest(before, before.length));
  assert.throws(() => frozenPrefixDigest(before, before.length + 1), (error) => error.code === "frozen_prefix_modified");
  assert.throws(() => frozenPrefixDigest(before, -1), (error) => error.code === "frozen_prefix_modified");

  assert.equal(
    evaluateRun(run({ comments: { before, after: appended, checkpoint: 3 } })).verdict,
    "accepted",
  );
  const outcome = evaluateRun(run({ comments: { before, after: rewritten, checkpoint: 3 } }));
  assert.equal(outcome.verdict, "blocking_non_verdict");
  assert.ok(outcome.reasons.some((entry) => entry.reason === "frozen_prefix_modified"));
});

test("a checkpoint outside the file is refused rather than silently clamped", () => {
  assert.throws(() => frozenPrefixDigest(["a"], 5), code("frozen_prefix_modified"));
  assert.throws(() => frozenPrefixDigest(["a"], -1), code("frozen_prefix_modified"));
});

test("a run is not evaluated under a projection version it did not start under", () => {
  // A projection that gained a field mid-run would retroactively make a
  // legitimate change into a violation.
  assert.throws(
    () => evaluateRun(run({ projectionVersion: 2 })),
    code("projection_version_mismatch"),
  );
});

test("a field outside this projection version cannot be projected", () => {
  assert.throws(
    () => projectionDigest(state(), [...PROJECTED_FIELDS, "invented_field"]),
    code("projection_version_mismatch"),
  );
});

test("a reviewer mutating the parent is caught as a projected change with provenance naming it", () => {
  const outcome = evaluateRun(
    run({
      after: state({ parent_child_relation: "T-100/T-999", timestamps: { updated_at: "later" } }),
      journal: [journalRecord({ actor: "model", changed_fields: ["timestamps"] })],
    }),
  );
  assert.equal(outcome.verdict, "blocking_non_verdict");
  assert.ok(outcome.reasons.some((entry) => entry.reason === "projection_changed"));
});

test("every park reason the contract closes can be produced", () => {
  const produced = new Set();
  const cases = [
    () => evaluateRun(run({ after: state({ role: "author" }) })),
    () => evaluateRun(run({ after: state({ worker_lease: "x" }), journal: [] })),
    () =>
      evaluateRun(
        run({
          after: state({ worker_lease: "x" }),
          journal: [journalRecord({ permitted_fields: ["timestamps"], changed_fields: ["worker_lease"] })],
        }),
      ),
    () => evaluateRun(run({ after: state({ timestamps: 1 }), journal: [journalRecord({ actor: "ghost" })] })),
    () =>
      evaluateRun(
        run({ after: state({ timestamps: 1 }), journal: [journalRecord({ project_binding: "other" })] }),
      ),
    () =>
      evaluateRun(
        run({
          after: state({ timestamps: 1 }),
          journal: [journalRecord({ sequence: 5 }), journalRecord({ operation_id: "op-2", sequence: 2 })],
        }),
      ),
    () => evaluateRun(run({ comments: { before: ["a"], after: ["b"], checkpoint: 1 } })),
  ];
  for (const attempt of cases) {
    for (const entry of attempt().reasons) produced.add(entry.reason);
  }
  try {
    evaluateRun(run({ projectionVersion: 9 }));
  } catch (error) {
    produced.add(error.code);
  }
  for (const reason of PARK_REASONS) {
    assert.ok(produced.has(reason), `${reason} is documented and never produced`);
  }
});
