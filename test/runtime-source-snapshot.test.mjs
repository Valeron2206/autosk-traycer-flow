/**
 * Tests for external source snapshots (issue #21 runtime).
 *
 * A verdict is about bytes. Two rules here look like details and are not: a
 * snapshot in a transient evidence root gets deleted by retention, and a
 * corrupt snapshot re-minted from the live source substitutes today's bytes for
 * the ones the verdict was about.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLEARANCE_STATES,
  LIFECYCLE_STATES,
  REFUSALS,
  SOURCE_KINDS,
  dedupePlan,
  driftOutcome,
  hashingMode,
  lifecycleErrors,
  locationErrors,
  mintErrors,
  repairPlan,
} from "../src/host/source-snapshot.mjs";

const code = (name) => (error) => error.code === name;

const digest = (char) => char.repeat(64);

const location = {
  projectRoot: ".autosk/snapshots",
  transientRoots: [".autosk-evidence/transient"],
  worktreeRoots: ["worktrees/T-102", "docs/autosk/epics"],
  projectIdentity: "project-a",
};

function record(overrides = {}) {
  return {
    locator: "https://example.invalid/spec.pdf",
    source_kind: "api_export",
    media_type: "application/pdf",
    source_size: 4096,
    source_mode: "100644",
    provenance: { owner_project: "project-a", origin: "in_project" },
    source_sha256: digest("a"),
    snapshot_path: ".autosk/snapshots/e1/spec.pdf",
    snapshot_sha256: digest("b"),
    read_back_sha256: digest("b"),
    operation_id: "wop-1",
    receipt_sequence: 3,
    clearance: "cleared",
    epic_id: "e1",
    anchor_version: 3,
    lifecycle: "present",
    ...overrides,
  };
}

const source = { available: true, regular_file: true };
const worktree = { dirty_after_mint: false };

const mint = (overrides = {}, context = {}) =>
  mintErrors(record(overrides), { source, worktree, location, ...context });

test("a well-formed snapshot mints", () => {
  assert.deepEqual(mint(), []);
  assert.equal(SOURCE_KINDS.length, 5);
  assert.deepEqual(CLEARANCE_STATES.slice(), ["cleared", "redacted", "restricted"]);
});

test("a snapshot may not live in a transient evidence root", () => {
  // The rule most likely to be broken by accident: retention would then delete
  // the only copy of a normative input.
  const errors = locationErrors(".autosk-evidence/transient/e1/spec.pdf", location);
  assert.ok(errors.some((error) => error.reason === "snapshot_retention_conflict"));
  assert.ok(
    mint({ snapshot_path: ".autosk-evidence/transient/e1/spec.pdf" })
      .some((error) => error.reason === "snapshot_retention_conflict"),
  );
});

test("a snapshot may not live in the mutable worktree either", () => {
  // A snapshot that moves with the work is not a snapshot of anything.
  const errors = locationErrors("worktrees/T-102/spec.pdf", location);
  assert.ok(errors.some((error) => /mutable worktree/u.test(error.detail)));
});

test("a snapshot outside the project root is refused", () => {
  assert.ok(
    locationErrors("/tmp/spec.pdf", location).some((error) => error.reason === "snapshot_out_of_project"),
  );
});

test("the read-back is a second field for a reason", () => {
  // A snapshot that was never read back proves the write returned, not that the
  // bytes are there.
  const notRead = record();
  delete notRead.read_back_sha256;
  assert.ok(
    mintErrors(notRead, { source, worktree, location })
      .some((error) => /was not read back/u.test(error.detail)),
  );
  assert.ok(
    mint({ read_back_sha256: digest("z") }).some((error) => error.reason === "snapshot_read_back_mismatch"),
  );
});

test("an unavailable or non-regular source is refused, and they are different reasons", () => {
  assert.ok(
    mint({}, { source: { available: false, regular_file: true } })
      .some((error) => error.reason === "snapshot_source_unavailable"),
  );
  assert.ok(
    mint({}, { source: { available: true, regular_file: false } })
      .some((error) => error.reason === "snapshot_source_not_regular"),
  );
});

test("someone else's file needs an import that records the ownership change", () => {
  // Reading it and calling it yours is the failure this prevents.
  assert.ok(
    mint({ provenance: { owner_project: "project-b", origin: "in_project" } })
      .some((error) => error.reason === "snapshot_out_of_project"),
  );
  assert.ok(
    mint({ provenance: { owner_project: "project-b", origin: "imported" } })
      .some((error) => /import records the ownership change/u.test(error.detail)),
  );
  assert.deepEqual(
    mint({ provenance: { owner_project: "project-b", origin: "imported", import_operation_id: "imp-1" } }),
    [],
  );
});

test("a mint that dirties the worktree under review is refused", () => {
  // It has changed the thing it was supposed to describe.
  assert.ok(
    mint({}, { worktree: { dirty_after_mint: true } })
      .some((error) => error.reason === "snapshot_worktree_dirty"),
  );
});

test("a snapshot nobody may publish is not published by accident", () => {
  assert.ok(mint({ clearance: undefined }).some((error) => error.reason === "snapshot_clearance_missing"));
  for (const state of CLEARANCE_STATES) {
    assert.deepEqual(mint({ clearance: state }), []);
  }
});

test("deduplication shares bytes and keeps provenance apart", () => {
  // Two sources that happen to have the same bytes are still two sources.
  const plan = dedupePlan([
    record({ locator: "a", snapshot_sha256: digest("1") }),
    record({ locator: "b", snapshot_sha256: digest("1") }),
    record({ locator: "c", snapshot_sha256: digest("2") }),
  ]);
  assert.equal(plan.stored_blobs.length, 2);
  assert.deepEqual(plan.provenance_records.slice(), ["a", "b", "c"]);
  assert.deepEqual(plan.shared[0].locators.slice(), ["a", "b"]);
});

test("binary bytes are hashed without text normalization", () => {
  // A digest that depends on line endings is not an identity for a PNG.
  assert.equal(hashingMode("image/png"), "binary_exact");
  assert.equal(hashingMode("application/pdf"), "binary_exact");
  assert.equal(hashingMode("text/markdown"), "utf8_exact");
  assert.equal(hashingMode("application/json"), "utf8_exact");
});

test("the drift table is applied at acceptance, row by row", () => {
  assert.equal(driftOutcome({ state: "unchanged" }).outcome, "continue");
  assert.equal(driftOutcome({ state: "changed", normative: true }).outcome, "new_anchor_and_full_review");
  assert.equal(driftOutcome({ state: "unavailable" }).reason, "snapshot_source_unavailable");
  assert.equal(driftOutcome({ state: "identity_uncertain" }).reason, "snapshot_identity_uncertain");
  assert.equal(driftOutcome({ state: "superseded" }).outcome, "approved_disposition_and_new_snapshot");
  assert.throws(() => driftOutcome({ state: "probably_fine" }), code("snapshot_identity_uncertain"));
});

test("a non-normative change needs a deterministic proof, not a judgement", () => {
  // "It is only a comment change" is a judgement; a proof is a rule that
  // produces the same answer for everyone.
  const unproven = driftOutcome({ state: "changed", normative: false });
  assert.equal(unproven.outcome, "new_anchor_and_full_review");
  assert.equal(unproven.reason, "unproven_non_normative");
  const proven = driftOutcome({
    state: "changed",
    normative: false,
    non_normative_proof: "the normative section digest is unchanged",
  });
  assert.equal(proven.outcome, "continue");
});

test("repair restores the recorded identity and never re-mints from the live source", () => {
  // Re-minting would substitute today's bytes for the ones a verdict was about.
  const plan = repairPlan(record(), {
    availableCopies: [
      { location: "cas/aa/bb", sha256: digest("b") },
      { location: "live", sha256: digest("live") },
    ],
  });
  assert.equal(plan.action, "restore_from_recorded_identity");
  assert.equal(plan.from, "cas/aa/bb");
  assert.equal(plan.sha256, digest("b"));

  const parked = repairPlan(record(), { availableCopies: [{ location: "live", sha256: digest("live") }] });
  assert.equal(parked.action, "park");
  assert.match(parked.detail, /the live source is not a substitute/u);
});

test("a superseded snapshot names its successor", () => {
  assert.deepEqual(lifecycleErrors(record()), []);
  assert.ok(lifecycleErrors(record({ lifecycle: "superseded" })).length === 1);
  assert.deepEqual(lifecycleErrors(record({ lifecycle: "superseded", superseded_by: "snap-2" })), []);
  assert.ok(lifecycleErrors(record({ lifecycle: "archived" })).length === 1);
  assert.deepEqual(LIFECYCLE_STATES.slice(), ["present", "missing", "deleted", "superseded"]);
});

test("every refusal class the contract closes can be produced", () => {
  const produced = new Set();
  const collect = (errors) => {
    for (const error of errors) produced.add(error.reason);
  };
  collect(mint({}, { source: { available: false, regular_file: true } }));
  collect(mint({}, { source: { available: true, regular_file: false } }));
  collect(mint({ lifecycle: "present", source_kind: "guess" }));
  collect(mint({ provenance: { owner_project: "project-b", origin: "in_project" } }));
  collect(mint({ read_back_sha256: digest("z") }));
  collect(mint({ snapshot_path: ".autosk-evidence/transient/x" }));
  collect(mint({}, { worktree: { dirty_after_mint: true } }));
  collect(mint({ clearance: "unknown" }));
  for (const refusal of REFUSALS) {
    assert.ok(produced.has(refusal), `${refusal} is documented and never produced`);
  }
});
