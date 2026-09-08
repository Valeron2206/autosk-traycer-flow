/**
 * Tests for the planning publication recipe and CAS machine (issue #5 runtime).
 *
 * Two exactnesses carry the contract: the commit bytes are built from
 * structured fields rather than regenerated from configuration, and the CAS
 * uses an exact expected-old value — no fetch-and-retry against a new parent.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTIFACT_TRAILERS,
  INVALIDATION_TRAILERS,
  PARK_REASONS,
  PHASES,
  SUBJECT,
  TRAILERS,
  actorErrors,
  commitMessage,
  lateCorrectionPlan,
  publicationDecision,
  recipeErrors,
  trailerErrors,
  trailerNamesFor,
  verifiedUpdates,
} from "../src/host/planning-publication.mjs";

const code = (name) => (error) => error.code === name;

const oid = (char) => char.repeat(40);

function trailerValues(payloadKind = "artifact") {
  return Object.fromEntries(trailerNamesFor(payloadKind).map((name, index) => [name, `value-${index}`]));
}

function recipe(overrides = {}) {
  const payload_kind = overrides.payload_kind ?? "artifact";
  return {
    payload_kind,
    author: { name: "autosk-flow host", email: "host@autosk.invalid" },
    committer: { name: "autosk-flow host", email: "host@autosk.invalid" },
    parents: [oid("a")],
    expected_planning_head: oid("a"),
    tree_oid: oid("b"),
    candidate_tree_oid: oid("b"),
    trailers: trailerNamesFor(payload_kind).map((name) => ({ name, value: "v" })),
    signing_mode: "none",
    signature_header_base64: null,
    commit_object_bytes_base64: "Y29tbWl0",
    expected_commit_oid: oid("c"),
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    phase: "prepared",
    ref: "expected_parent",
    reflog: "checkpoint",
    object: "absent",
    keepalive: "exact",
    binding: "exact",
    ...overrides,
  };
}

test("the trailer set is closed, and sorted by code point rather than by listing", () => {
  const artifact = trailerNamesFor("artifact");
  assert.deepEqual(artifact, [...artifact].sort());
  assert.equal(artifact.length, TRAILERS.length + ARTIFACT_TRAILERS.length);
  const invalidation = trailerNamesFor("anchor_invalidation");
  assert.deepEqual(invalidation, [...invalidation].sort());
  assert.ok(invalidation.includes("Autosk-Impact-Digest"));
  assert.ok(!invalidation.includes("Autosk-Artifact-Identity"));
  assert.equal(INVALIDATION_TRAILERS.length, 2);
});

test("duplicate, unknown and missing trailers are all invalid", () => {
  const names = trailerNamesFor("artifact");
  assert.deepEqual(trailerErrors("artifact", names.map((name) => ({ name }))), []);
  assert.ok(
    trailerErrors("artifact", names.slice(1).map((name) => ({ name })))
      .some((error) => /missing/u.test(error.detail)),
  );
  assert.ok(
    trailerErrors("artifact", [...names, { name: "Autosk-Extra" }].map((entry) =>
      typeof entry === "string" ? { name: entry } : entry,
    )).some((error) => /unknown/u.test(error.detail)),
  );
  assert.ok(
    trailerErrors("artifact", [...names, names[0]].map((name) => ({ name })))
      .some((error) => /twice/u.test(error.detail)),
  );
});

test("the message is the fixed subject, a blank line and the sorted trailers", () => {
  // No model-authored bytes enter it: anything explained there would be bytes
  // nobody reviewed.
  const message = commitMessage("artifact", trailerValues());
  const lines = message.split("\n");
  assert.equal(lines[0], SUBJECT);
  assert.equal(lines[1], "");
  const trailerLines = lines.slice(2).filter(Boolean);
  assert.deepEqual(trailerLines.map((line) => line.split("=")[0]), trailerNamesFor("artifact"));
  assert.ok(message.endsWith("\n"));
});

test("a trailer with no value or a line break in it is refused", () => {
  const values = trailerValues();
  const missing = { ...values, "Autosk-Epic-ID": "" };
  assert.throws(() => commitMessage("artifact", missing), code("planning_publication_corrupt"));
  const broken = { ...values, "Autosk-Epic-ID": "e1\nAutosk-Forged=yes" };
  assert.throws(() => commitMessage("artifact", broken), code("planning_publication_corrupt"));
});

test("an actor cannot forge a second header line or be two identities", () => {
  assert.deepEqual(actorErrors({ name: "host", email: "host@autosk.invalid" }), []);
  assert.ok(actorErrors({ name: "a\nb", email: "x@y" }).some((error) => /line break/u.test(error.detail)));
  assert.ok(actorErrors({ name: "a<b>", email: "x@y" }).some((error) => /ident delimiter/u.test(error.detail)));
  assert.ok(actorErrors({ name: "a", email: "x@y@z" }).some((error) => /one @/u.test(error.detail)));
  assert.ok(actorErrors({ name: "a", email: "xy" }).some((error) => /one @/u.test(error.detail)));
  assert.ok(actorErrors({ name: "", email: "x@y" }).some((error) => /name is empty/u.test(error.detail)));
});

test("the recipe is complete before prepared", () => {
  assert.deepEqual(recipeErrors(recipe()), []);
  assert.ok(
    recipeErrors(recipe({ parents: [oid("a"), oid("d")] }))
      .some((error) => /2 parents/u.test(error.detail)),
  );
  assert.ok(
    recipeErrors(recipe({ parents: [oid("z")] }))
      .some((error) => /not the expected planning head/u.test(error.detail)),
  );
  assert.ok(
    recipeErrors(recipe({ tree_oid: oid("z") }))
      .some((error) => /not the candidate tree/u.test(error.detail)),
  );
});

test("an OID without the bytes it names is not a recovery record", () => {
  const errors = recipeErrors(recipe({ commit_object_bytes_base64: undefined }));
  assert.ok(errors.some((error) => /exact commit bytes are not persisted/u.test(error.detail)));
  assert.ok(errors.some((error) => /an OID without the bytes it names/u.test(error.detail)));
});

test("signing that cannot be replayed parks before any side effect", () => {
  const errors = recipeErrors(recipe({ signing_mode: "exact", signature_header_base64: null }));
  assert.ok(errors.some((error) => error.reason === "planning_signing_unavailable"));
  assert.deepEqual(recipeErrors(recipe({ signing_mode: "exact", signature_header_base64: "aGVhZGVy" })), []);
  assert.ok(
    recipeErrors(recipe({ signing_mode: "none", signature_header_base64: "aGVhZGVy" }))
      .some((error) => /signing mode none/u.test(error.detail)),
  );
});

test("a prepared operation writes the object, or verifies the one that survived", () => {
  assert.deepEqual(publicationDecision(observation()), { action: "write_commit_object", phase: "commit_created" });
  assert.deepEqual(publicationDecision(observation({ object: "matching" })), {
    action: "verify_existing_object",
    phase: "commit_created",
  });
});

test("a pruned object is rewritten from the persisted bytes, not created anew", () => {
  // Reconstruction, not a new logical commit: the same bytes, the same OID.
  assert.deepEqual(publicationDecision(observation({ phase: "commit_created", object: "pruned" })), {
    action: "rewrite_exact_object",
    phase: "commit_created",
  });
});

test("the ref advances by CAS from the expected parent", () => {
  assert.deepEqual(publicationDecision(observation({ phase: "commit_created", object: "matching" })), {
    action: "cas_advance_ref",
    phase: "ref_advanced",
  });
});

test("a CAS that landed without a record is reconstructed, not repeated", () => {
  for (const phase of ["prepared", "commit_created"]) {
    assert.deepEqual(
      publicationDecision(observation({ phase, ref: "expected_commit", reflog: "one_new_matching", object: "matching" })),
      { action: "reconstruct_cas_receipt", phase: "ref_advanced" },
    );
  }
});

test("move-away-and-back is detected, because the ref being back is not evidence", () => {
  // ABA: the reflog prefix changed even though the ref reads as expected.
  assert.deepEqual(publicationDecision(observation({ reflog: "changed" })), {
    action: "park",
    park_reason: "planning_ref_foreign_movement",
  });
  assert.equal(publicationDecision(observation({ ref: "other" })).park_reason, "planning_ref_foreign_movement");
  assert.equal(publicationDecision(observation({ reflog: "unknown" })).park_reason, "planning_ref_foreign_movement");
});

test("a mismatched object is corrupt, and an unaccountable observation parks too", () => {
  assert.equal(publicationDecision(observation({ object: "mismatch" })).park_reason, "planning_publication_corrupt");
  // A phase and a state the table cannot account for: parked rather than
  // retried, because a retry against an unknown state doubles the uncertainty.
  assert.equal(
    publicationDecision(observation({ phase: "ref_advanced", ref: "expected_parent" })).park_reason,
    "planning_publication_corrupt",
  );
  assert.throws(() => publicationDecision(observation({ phase: "halfway" })), code("planning_publication_corrupt"));
});

test("an invalid keepalive stops everything before any side effect", () => {
  for (const phase of ["prepared", "commit_created", "ref_advanced", "verified"]) {
    assert.equal(
      publicationDecision(observation({ phase, keepalive: "invalid" })).park_reason,
      "planning_candidate_keepalive_invalid",
      phase,
    );
  }
});

test("binding drift before the ref moves voids the operation rather than undoing anything", () => {
  for (const phase of ["prepared", "commit_created"]) {
    const decision = publicationDecision(observation({ phase, binding: "drifted", object: "matching" }));
    assert.equal(decision.action, "void_before_ref");
    assert.equal(decision.terminal_reason, "binding_drift");
    assert.equal(decision.recovery_target, "prepare_anchor_impact");
  }
});

test("binding drift after the ref moved verifies against the recorded binding", () => {
  const decision = publicationDecision(
    observation({ phase: "ref_advanced", ref: "expected_commit", binding: "drifted" }),
  );
  assert.equal(decision.action, "record_verified_against_recorded_binding");
  assert.equal(decision.next_step, "prepare_anchor_impact");
  const clean = publicationDecision(observation({ phase: "ref_advanced", ref: "expected_commit" }));
  assert.equal(clean.next_step, "select_next");
});

test("the keepalive transfer is audit-first, so no window has neither copy", () => {
  assert.equal(
    publicationDecision(observation({ phase: "verified", ref: "expected_commit", keepalive: "verified" })).action,
    "transfer_keepalive_to_audit",
  );
  const finalize = publicationDecision(
    observation({ phase: "verified", ref: "expected_commit", keepalive: "released" }),
  );
  assert.equal(finalize.action, "finalize_metadata_only");
  assert.equal(finalize.next_step, "select_next");
  const drifted = publicationDecision(
    observation({ phase: "verified", ref: "expected_commit", keepalive: "released", binding: "drifted" }),
  );
  assert.equal(drifted.next_step, "prepare_anchor_impact");
});

test("a voided operation resumes its transfer and never moves the planning ref", () => {
  assert.equal(
    publicationDecision(observation({ phase: "voided_before_ref", keepalive: "verified" })).action,
    "resume_audit_transfer",
  );
  const archived = publicationDecision(
    observation({ phase: "voided_before_ref", keepalive: "audit_retained" }),
  );
  assert.equal(archived.action, "archive_terminal_records");
  assert.equal(archived.next_step, "prepare_anchor_impact");
});

test("what the host records once a publication is verified", () => {
  const updates = verifiedUpdates({
    expected_commit_oid: oid("c"),
    candidate_tree_oid: oid("b"),
    generation: 4,
    reflog_tail: "tail-9",
    operation_id: "op-1",
  });
  assert.equal(updates["planning.head_oid"], oid("c"));
  assert.equal(updates["planning.generation"], 5);
  assert.equal(updates.current_artifact, null);
  assert.equal(updates["artifact_pass.publication_status"], "verified");
});

test("a correction that arrives after the CAS is a new impact, not a rewind", () => {
  assert.equal(lateCorrectionPlan().rewinds, false);
});

test("every park reason this module declares can be produced", () => {
  const produced = new Set();
  produced.add(publicationDecision(observation({ ref: "other" })).park_reason);
  produced.add(publicationDecision(observation({ object: "mismatch" })).park_reason);
  produced.add(publicationDecision(observation({ keepalive: "invalid" })).park_reason);
  for (const error of recipeErrors(recipe({ signing_mode: "exact", signature_header_base64: null }))) {
    produced.add(error.reason);
  }
  for (const reason of PARK_REASONS) {
    assert.ok(produced.has(reason), `${reason} is declared and never produced`);
  }
  assert.equal(PHASES.length, 6);
});
