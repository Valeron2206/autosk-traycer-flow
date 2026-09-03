import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OPERATION_EXAMPLE_PATH,
  OPERATION_SCHEMA_PATH,
  INIT_OPERATION_EXAMPLE_PATH,
  INIT_OPERATION_SCHEMA_PATH,
  INVALIDATION_EXAMPLE_PATH,
  isCanonicalGpgsigHeader,
  artifactPathspecDigest,
  candidateKeepaliveAuditObservationDigest,
  candidateKeepaliveAuditReceiptHash,
  candidateKeepaliveReleaseReceiptHash,
  candidateKeepaliveReleaseTransactionDigest,
  canonicalStringify,
  loadPlanningRefFiles,
  planningObservationDigest,
  planningReflogEntryDigest,
  planningReceiptHash,
  planningRefDesignDigest,
  planningReleaseTailObservationDigest,
  reflogPrefixDigest,
  validateCandidateKeepaliveOperation,
  validateCandidateSupersessionOperation,
  validateAuditHousekeepingOperation,
  validateRefCustodyHelperContract,
  validateRefCustodyHelperWireExamples,
  validatePlanningPublicationOperation,
  validatePlanningPublicationOperationExample,
  validatePlanningRefInitOperation,
  validatePlanningRefInitOperationExample,
  validatePlanningRefDesign,
  validateJsonSchema,
} from "../scripts/validate-planning-ref-design.mjs";

function fixture() {
  return structuredClone(loadPlanningRefFiles());
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("current planning-ref design contract is internally connected", () => {
  const files = fixture();
  assert.deepEqual(validatePlanningRefDesign(files), []);
  assert.match(planningRefDesignDigest(files), /^[0-9a-f]{64}$/u);
});

test("missing cross-document contract markers fail closed", () => {
  const files = fixture();
  files["03-technical-plan.md"] = files["03-technical-plan.md"].replaceAll("planning_publication_op", "removed_operation");
  assert.match(validatePlanningRefDesign(files).join("\n"), /planning_publication_op/u);
});

test("direct record-artifact-pass to select-next regression is rejected", () => {
  const files = fixture();
  files["03-technical-plan.md"] += "\n| record_artifact_pass | disposition=pass, verdict binding текущей identity валиден; для tech_plan Arena block валиден | atomically artifact_pass[kind]={disposition:pass,identity,verdict_hash}, arena fields обновлены; if kind=tickets and remediation phase=proposal_ready, verify new set digest and set phase=closed; select_next |\n";
  assert.match(validatePlanningRefDesign(files).join("\n"), /direct record_artifact_pass/u);
});

test("direct transition is rejected even when predicate and action wording change", () => {
  const files = fixture();
  files["03-technical-plan.md"] +=
    "\n| record_artifact_pass | any newly worded successful outcome | write arbitrary metadata and then select_next |\n";
  assert.match(validatePlanningRefDesign(files).join("\n"), /direct record_artifact_pass/u);
});

test("direct prose transition from record-artifact-pass to select-next is rejected", () => {
  const files = fixture();
  files["03-technical-plan.md"] +=
    "\nrecord_artifact_pass после успешной атомарной записи переходит в select_next.\n";
  assert.match(validatePlanningRefDesign(files).join("\n"), /prose.*record_artifact_pass.*select_next/u);
});

test("successful record-artifact-pass rows must target publication", () => {
  const files = fixture();
  files["03-technical-plan.md"] = files["03-technical-plan.md"].replace(
    "create immutable planning_publication_op phase=prepared binding exact verified candidate_keepalive and recipe/OID; publish_artifact_pass",
    "create immutable planning_publication_op phase=prepared binding exact verified candidate_keepalive and recipe/OID; dispatch_ticket_dag",
  );
  assert.match(validatePlanningRefDesign(files).join("\n"), /successful record_artifact_pass.*publish_artifact_pass/u);
});

test("publish-artifact-pass cannot select-next before verified publication", () => {
  const files = fixture();
  files["03-technical-plan.md"] = files["03-technical-plan.md"].replace(
    "write persisted exact commit_object_bytes; verify Git returns expected OID; atomically phase=commit_created; publish_artifact_pass",
    "write persisted exact commit_object_bytes; verify Git returns expected OID; atomically phase=commit_created; select_next",
  );
  assert.match(validatePlanningRefDesign(files).join("\n"), /publish_artifact_pass.*verified.*select_next/u);
});

test("pre-CAS drift guard precedes publication side effects", () => {
  const files = fixture();
  const plan = files["03-technical-plan.md"];
  const drift = plan.indexOf("current binding drift before ref movement");
  const objectWrite = plan.indexOf("phase=prepared and expected object absent, ref=expected parent and reflog prefix=checkpoint");
  const cas = plan.indexOf("phase=commit_created and ref=expected parent, candidate_keepalive ref=snapshot commit and reflog prefix=checkpoint");
  assert.equal(drift >= 0 && drift < objectWrite && drift < cas, true);
});

test("post-CAS drift guard precedes exact-binding verification", () => {
  const plan = fixture()["03-technical-plan.md"];
  assert.equal(
    plan.indexOf("current binding drift after expected ref transition") <
      plan.indexOf("phase=ref_advanced and ref/commit/exact bytes"),
    true,
  );
});

test("select-next restores publication before aggregate remediation", () => {
  const plan = fixture()["03-technical-plan.md"];
  assert.equal(
    plan.indexOf("publication_status=recorded_unpublished") <
      plan.indexOf("aggregate_remediation.phase != closed"),
    true,
  );
});

test("planning publication drift and retry rows name exact executable targets", () => {
  const plan = fixture()["03-technical-plan.md"];
  assert.match(plan, /matching recorded_unpublished PASS and open prepared planning_publication_op.*publish_artifact_pass/u);
  assert.match(plan, /matching anchor_invalidation planning_publication_op.*publish_planning_invalidation/u);
  assert.match(plan, /phase=voided_before_ref.*recovery_target_step=prepare_anchor_impact.*prepare_anchor_impact/u);
  assert.match(plan, /current binding drift after expected ref transition.*atomically phase=verified.*prepare_anchor_impact/u);
});

test("pre-CAS missing commit object is recoverable from persisted exact bytes", () => {
  const plan = fixture()["03-technical-plan.md"];
  assert.match(plan, /phase=commit_created and expected object absent.*rewrite persisted exact commit_object_bytes.*publish_artifact_pass/u);
});

test("Arena re-expression returns through recorded and published PASS", () => {
  const files = fixture();
  files["01-core-flows.md"] = files["01-core-flows.md"].replace(
    "new full panel -> record PASS -> publish planning commit",
    "new full panel -> publish planning commit",
  );
  files["03-technical-plan.md"] = files["03-technical-plan.md"].replace(
    "freeze_artifact -> dispatch_panel -> panel_join -> synthesize_panel\n  -> record_artifact_pass -> publish_artifact_pass",
    "freeze_artifact -> dispatch_panel",
  );
  const result = validatePlanningRefDesign(files).join("\n");
  assert.match(result, /Arena.*record_artifact_pass.*publish_artifact_pass/u);
});

test("CAS recovery table keeps exactly two Markdown columns", () => {
  const files = fixture();
  files["docs/contracts/epic-planning-ref.md"] = files["docs/contracts/epic-planning-ref.md"].replace(
    "phase=`prepared` or phase=`commit_created`",
    "phase=`prepared|commit_created`",
  );
  assert.match(validatePlanningRefDesign(files).join("\n"), /CAS recovery table.*two columns/u);
});

test("canonical transition table keeps exactly three Markdown columns", () => {
  const files = fixture();
  files["03-technical-plan.md"] = files["03-technical-plan.md"].replace(
    "phase=prepared or phase=ref_created",
    "phase=prepared|ref_created",
  );
  assert.match(validatePlanningRefDesign(files).join("\n"), /transition table.*three columns/u);
});

test("initialization and publication phase documentation is monotonic", () => {
  const files = fixture();
  files["docs/contracts/epic-planning-ref.md"] = files["docs/contracts/epic-planning-ref.md"]
    .replace("prepared\n→ ref_created\n→ verified", "verified\n→ ref_created\n→ prepared")
    .replace("prepared\n→ commit_created\n→ ref_advanced\n→ verified", "verified\n→ ref_advanced\n→ commit_created\n→ prepared");
  const result = validatePlanningRefDesign(files).join("\n");
  assert.match(result, /initialization phases/u);
  assert.match(result, /publication phases/u);
});

test("digest-only recipe and missing terminal void are rejected", () => {
  const files = fixture();
  files["docs/contracts/epic-planning-ref.md"] = files["docs/contracts/epic-planning-ref.md"]
    .replace("complete canonical `commit_recipe`", "recipe digest")
    .replace("exact commit object bytes", "recomputed commit")
    .replace("`voided_before_ref` is the only unsuccessful terminal phase", "pre-CAS drift is retried");
  const result = validatePlanningRefDesign(files).join("\n");
  assert.match(result, /complete exact commit recipe/u);
  assert.match(result, /terminal void phase/u);
});

test("recorded and published PASS distinction is required", () => {
  const files = fixture();
  files["01-core-flows.md"] = files["01-core-flows.md"].replace(
    "recorded PASS не является завершённым артефактом",
    "PASS distinction removed",
  );
  assert.match(validatePlanningRefDesign(files).join("\n"), /recorded-vs-published/u);
});

test("planning ref uses a project-bound epic_ref_key rather than display identity", () => {
  const files = fixture();
  const result = validatePlanningRefDesign(files).join("\n");
  assert.doesNotMatch(result, /epic_ref_key/u);
  assert.match(files["docs/contracts/epic-planning-ref.md"], /epic_ref_key = SHA-256/u);
  assert.match(files["docs/contracts/epic-planning-ref.md"], /refs\/autosk\/epics\/<epic_ref_key>\/planning/u);
  for (const text of Object.values(files)) assert.doesNotMatch(text, /refs\/autosk\/epics\/<(?:epic-uuid|uuid)>\/planning/u);
});

test("PASS record and prepared publication operation require one atomic daemon write", () => {
  const files = fixture();
  assert.match(files["docs/contracts/epic-planning-ref.md"], /recordArtifactPassAndPreparePublication/u);
  assert.match(files["docs/contracts/epic-planning-ref.md"], /two ordinary CLI calls are not equivalent/iu);
  assert.match(files["03-technical-plan.md"], /atomic pass-and-operation capability unavailable/u);
});

test("implementation and Tickets guards require a verified published PASS", () => {
  const files = fixture();
  files["03-technical-plan.md"] = files["03-technical-plan.md"]
    .replaceAll("publication_status=verified", "publication_status=recorded_unpublished")
    .replaceAll("matching immutable `planning.publication_history` record phase=verified", "matching immutable `planning.publication_history` record phase=prepared");
  const result = validatePlanningRefDesign(files).join("\n");
  assert.match(result, /Planned implementation.*Published PASS/u);
  assert.match(result, /Tickets.*Published PASS/u);
});

test("architecture operation summary retains every recovery-critical field", () => {
  const files = fixture();
  files["02-architecture.md"] = files["02-architecture.md"].replace(
    "complete commit_recipe",
    "recipe digest",
  );
  assert.match(validatePlanningRefDesign(files).join("\n"), /complete commit_recipe/u);
});

test("every planning-ref park reason has an explicit resume contract", () => {
  const files = fixture();
  const technicalResume = files["03-technical-plan.md"].split("Resume contract:")[1] ?? "";
  const coreResume = files["01-core-flows.md"].split("## 8. Возобновление из human")[1] ?? "";
  for (const reason of [
    "planning_ref_init_invalid",
    "planning_ref_capability_missing",
    "planning_ref_foreign_movement",
    "planning_candidate_base_stale",
    "planning_publication_invalid",
    "planning_publication_corrupt",
    "planning_signing_unavailable",
  ]) {
    assert.match(technicalResume, new RegExp(`\\| ${reason} \\|`, "u"));
    assert.match(coreResume, new RegExp(`\\| ${reason} \\|`, "u"));
  }
});

test("normative digest preimages and v1 downstream boundaries are closed", () => {
  const contract = fixture()["docs/contracts/epic-planning-ref.md"];
  for (const marker of [
    "canonical JSON means recursively sorted object keys",
    "autosk-flow/reflog-prefix/v1\\0",
    "autosk-flow/planning-observation/v1\\0",
    "autosk-flow/planning-receipt/v1\\0",
    "autosk-flow/planning-commit-recipe/v1\\0",
    "Issue #12",
    "Issue #13",
    "closed v1 bootstrap delivery policy",
  ]) assert.match(contract, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("receipt digest golden vector is reproducible", () => {
  const observation = {
    object_format: "sha1",
    object_oid: "cc745247722ff2fe151303f31113281e0fcd9c70",
    object_bytes_sha256: "bc6c070b2858aa1ae8f8b3650b8633620a82e0644cc76af9c3e0506df734508f",
  };
  const observationDigest = planningObservationDigest("commit_object", observation);
  assert.equal(observationDigest, "9167690cbff40fecf1eede9e31f6b06583b61cb9da78032b23fa36bf710946c1");
  assert.equal(
    planningReceiptHash(
      "11111111-1111-4111-8111-111111111111",
      "commit_object",
      observationDigest,
    ),
    "cf2af4b4d98e8d4c228a8058e1013d5181d66248238fe67da4f36f8b660ee29e",
  );
});

test("Epic metadata uses the same UUID identity as publication operations", () => {
  const plan = fixture()["03-technical-plan.md"];
  assert.doesNotMatch(plan, /"epic_id": "epic-001"/u);
  assert.match(plan, /"epic_id": "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}"/u);
});

test("closed publication-operation schema and example match the prose contract", () => {
  const schema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  const example = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
  assert.deepEqual(validatePlanningPublicationOperationExample(example, schema), []);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.phase.enum.includes("voided_before_ref"), true);
  assert.equal(schema.required.includes("epic_ref_key"), true);
  assert.equal(schema.required.includes("project_instruction_digest"), true);
});

test("operation schema validator rejects unsafe ref, phase, OID and digest shapes", () => {
  const schema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  const example = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
  example.planning_ref = "refs/autosk/epics/../../main/planning";
  example.phase = "unknown";
  example.expected_parent_oid = "not-an-oid";
  example.project_instruction_digest = "short";
  const result = validatePlanningPublicationOperationExample(example, schema).join("\n");
  assert.match(result, /planning_ref/u);
  assert.match(result, /phase/u);
  assert.match(result, /expected_parent_oid/u);
  assert.match(result, /project_instruction_digest/u);
});

test("operation Schema enforces signing-mode replayability", () => {
  const schema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  const exactWithoutSignature = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
  exactWithoutSignature.commit_recipe.signing.mode = "exact";
  assert.match(
    validatePlanningPublicationOperationExample(exactWithoutSignature, schema).join("\n"),
    /signature_header_base64/u,
  );

  const noneWithSignature = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
  noneWithSignature.commit_recipe.signing.signature_header_base64 = "c2lnbmF0dXJl";
  assert.match(
    validatePlanningPublicationOperationExample(noneWithSignature, schema).join("\n"),
    /signature_header_base64/u,
  );
});

test("complete Schema validation rejects a changed artifact target step", () => {
  const schema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  const example = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
  example.payload.recorded_target_step = "dispatch_ticket_dag";
  assert.match(
    validatePlanningPublicationOperationExample(example, schema).join("\n"),
    /payload\.recorded_target_step/u,
  );
});

test("operation Schema closes receipt slots and phase prefixes", () => {
  const schema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  const wrongSlot = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
  wrongSlot.receipts.commit_object = {
    schema: 1,
    operation_id: wrongSlot.operation_id,
    receipt_kind: "ref_cas",
    observation_sha256: "a".repeat(64),
    receipt_hash: "b".repeat(64),
  };
  assert.match(
    validatePlanningPublicationOperationExample(wrongSlot, schema).join("\n"),
    /receipt_kind|commit_object receipt/u,
  );

  const verifiedWithoutReceipts = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
  verifiedWithoutReceipts.phase = "verified";
  assert.match(
    validatePlanningPublicationOperationExample(verifiedWithoutReceipts, schema).join("\n"),
    /verified.*receipts|receipts.*verified/u,
  );
});

test("generic recovered-operation validation binds receipt observation and hashes", () => {
  const schema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  const operation = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
  const observation = {
    object_format: "sha1",
    object_oid: operation.expected_commit_oid,
    object_bytes_sha256: operation.commit_recipe.commit_object_bytes_sha256,
  };
  const observationSha256 = planningObservationDigest("commit_object", observation);
  operation.phase = "commit_created";
  operation.receipts.commit_object = {
    schema: 1,
    operation_id: operation.operation_id,
    receipt_kind: "commit_object",
    observation,
    observation_sha256: observationSha256,
    helper_evidence: null,
    receipt_hash: planningReceiptHash(operation.operation_id, "commit_object", observationSha256),
  };
  assert.deepEqual(validatePlanningPublicationOperation(operation, schema), []);

  const badHash = structuredClone(operation);
  badHash.receipts.commit_object.receipt_hash = "0".repeat(64);
  assert.match(validatePlanningPublicationOperation(badHash, schema).join("\n"), /receipt_hash/u);

  const foreign = structuredClone(operation);
  foreign.receipts.commit_object.operation_id = "33333333-3333-4333-8333-333333333333";
  assert.match(validatePlanningPublicationOperation(foreign, schema).join("\n"), /containing operation_id/u);

  const changedObservation = structuredClone(operation);
  changedObservation.receipts.commit_object.observation.object_oid = "4".repeat(40);
  assert.match(validatePlanningPublicationOperation(changedObservation, schema).join("\n"), /observation_sha256/u);
});

test("recovered receipts are bound to their containing operation values", () => {
  const schema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  const operation = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
  const helperWire = JSON.parse(readFileSync(
    path.join(path.dirname(OPERATION_SCHEMA_PATH), "ref-custody-helper-wire.example.json"),
    "utf8",
  ));
  const advance = helperWire.actions.find(({ action }) => action === "advance_planning");
  const refCasHelperEvidence = {
    request_id: advance.request.request_id,
    nonce: advance.request.nonce,
    request_body_sha256: advance.request.body_sha256,
    transaction_value_observation_sha256: advance.response.transaction_value_observation_sha256,
    helper_receipt_hash: advance.response.receipt_hash,
    helper_journal_hash: advance.journal.journal_hash,
  };
  const receipt = (kind, observation) => {
    const observationSha256 = planningObservationDigest(kind, observation);
    const helperEvidence = kind === "ref_cas" ? refCasHelperEvidence : null;
    return {
      schema: 1,
      operation_id: operation.operation_id,
      receipt_kind: kind,
      observation,
      observation_sha256: observationSha256,
      helper_evidence: helperEvidence,
      receipt_hash: planningReceiptHash(operation.operation_id, kind, observationSha256, helperEvidence),
    };
  };
  operation.phase = "ref_advanced";
  operation.receipts.commit_object = receipt("commit_object", {
    object_format: operation.commit_recipe.object_format,
    object_oid: operation.expected_commit_oid,
    object_bytes_sha256: operation.commit_recipe.commit_object_bytes_sha256,
  });
  operation.receipts.ref_cas = receipt("ref_cas", {
    planning_ref: operation.planning_ref,
    expected_old_oid: operation.reflog_checkpoint.expected_old_oid,
    observed_new_oid: operation.reflog_checkpoint.expected_new_oid,
    expected_update_message: operation.reflog_checkpoint.expected_update_message,
    candidate_keepalive_ref: operation.candidate_keepalive.ref,
    candidate_keepalive_oid: operation.candidate_keepalive.snapshot_commit_oid,
  });
  operation.receipts.reflog_after = receipt("reflog_after", {
    before_entry_count: operation.reflog_checkpoint.before_entry_count,
    after_entry_count: operation.reflog_checkpoint.before_entry_count + 1,
    before_prefix_sha256: operation.reflog_checkpoint.before_prefix_sha256,
    appended_entry_sha256: planningReflogEntryDigest(operation),
  });
  assert.deepEqual(validatePlanningPublicationOperation(operation, schema), []);

  for (const [slot, key, value] of [
    ["commit_object", "object_format", "sha256"],
    ["commit_object", "object_oid", "4".repeat(40)],
    ["commit_object", "object_bytes_sha256", "4".repeat(64)],
    ["ref_cas", "planning_ref", `refs/autosk/epics/${"4".repeat(64)}/planning`],
    ["ref_cas", "expected_old_oid", "4".repeat(40)],
    ["ref_cas", "observed_new_oid", "4".repeat(40)],
    ["ref_cas", "expected_update_message", "different update"],
    ["ref_cas", "candidate_keepalive_ref", `refs/autosk/epics/${"4".repeat(64)}/candidates/${"4".repeat(64)}`],
    ["ref_cas", "candidate_keepalive_oid", "4".repeat(40)],
    ["reflog_after", "before_entry_count", 2],
    ["reflog_after", "after_entry_count", 3],
    ["reflog_after", "before_prefix_sha256", "4".repeat(64)],
    ["reflog_after", "appended_entry_sha256", "4".repeat(64)],
  ]) {
    const changed = structuredClone(operation);
    changed.receipts[slot].observation[key] = value;
    const observationSha256 = planningObservationDigest(slot, changed.receipts[slot].observation);
    changed.receipts[slot].observation_sha256 = observationSha256;
    changed.receipts[slot].receipt_hash = planningReceiptHash(changed.operation_id, slot, observationSha256);
    assert.match(validatePlanningPublicationOperation(changed, schema).join("\n"), new RegExp(key, "u"));
  }

  operation.phase = "verified";
  operation.effective_target_step = "select_next";
  operation.receipts.verification = receipt("verification", {
    planning_ref: operation.planning_ref,
    commit_oid: operation.expected_commit_oid,
    tree_oid: operation.candidate_tree_oid,
    reflog_after_receipt_hash: operation.receipts.reflog_after.receipt_hash,
  });
  assert.deepEqual(validatePlanningPublicationOperation(operation, schema), []);
  for (const [key, value] of [
    ["planning_ref", `refs/autosk/epics/${"5".repeat(64)}/planning`],
    ["commit_oid", "5".repeat(40)],
    ["tree_oid", "5".repeat(40)],
    ["reflog_after_receipt_hash", "5".repeat(64)],
  ]) {
    const changed = structuredClone(operation);
    changed.receipts.verification.observation[key] = value;
    const observationSha256 = planningObservationDigest("verification", changed.receipts.verification.observation);
    changed.receipts.verification.observation_sha256 = observationSha256;
    changed.receipts.verification.receipt_hash = planningReceiptHash(
      changed.operation_id,
      "verification",
      observationSha256,
    );
    assert.match(validatePlanningPublicationOperation(changed, schema).join("\n"), new RegExp(key, "u"));
  }

  const released = structuredClone(operation);
  const releaseExchange = helperWire.actions.find(({ action, request }) =>
    action === "delete_live_ref" && request.transfer_mode === "release_to_audit");
  const releaseHelperEvidence = {
    request_id: releaseExchange.request.request_id,
    nonce: releaseExchange.request.nonce,
    request_body_sha256: releaseExchange.request.body_sha256,
    transaction_value_observation_sha256: releaseExchange.response.transaction_value_observation_sha256,
    helper_receipt_hash: releaseExchange.response.receipt_hash,
    helper_journal_hash: releaseExchange.journal.journal_hash,
  };
  const tailObservationSha256 = planningReleaseTailObservationDigest(released);
  const releaseReceipt = {
    schema: 1,
    operation_id: released.candidate_keepalive.operation_id,
    candidate_identity: released.candidate_keepalive.candidate_identity,
    ref: released.candidate_keepalive.ref,
    expected_old_oid: released.candidate_keepalive.snapshot_commit_oid,
    planning_ref: released.planning_ref,
    verified_commit_oid: released.expected_commit_oid,
    planning_reflog_after_receipt_hash: released.receipts.reflog_after.receipt_hash,
    planning_reflog_tail_observation_sha256: tailObservationSha256,
    transaction_observation_sha256: candidateKeepaliveReleaseTransactionDigest(
      released,
      tailObservationSha256,
    ),
    audit_candidate_ref:
      `refs/autosk/epics/${released.epic_ref_key}/audit/candidates/` +
      released.candidate_keepalive.candidate_identity,
    audit_candidate_oid: released.candidate_keepalive.snapshot_commit_oid,
    ref_custody_generation: released.ref_custody_generation,
    ref_custody_policy_digest: released.ref_custody_policy_digest,
    closure_verified: true,
    helper_evidence: releaseHelperEvidence,
    receipt_hash: "",
  };
  releaseReceipt.receipt_hash = candidateKeepaliveReleaseReceiptHash(releaseReceipt);
  const auditReceipt = {
    schema: 1,
    operation_id: released.candidate_keepalive.operation_id,
    candidate_identity: released.candidate_keepalive.candidate_identity,
    live_ref: released.candidate_keepalive.ref,
    audit_ref: released.candidate_keepalive.audit_ref,
    snapshot_commit_oid: released.candidate_keepalive.snapshot_commit_oid,
    reason: "publication_verified",
    ref_custody_generation: released.ref_custody_generation,
    ref_custody_policy_digest: released.ref_custody_policy_digest,
    observation_sha256: "",
    helper_evidence: releaseHelperEvidence,
    receipt_hash: "",
  };
  auditReceipt.observation_sha256 = candidateKeepaliveAuditObservationDigest(auditReceipt);
  auditReceipt.receipt_hash = candidateKeepaliveAuditReceiptHash(auditReceipt);
  released.candidate_keepalive.phase = "released";
  released.candidate_keepalive.terminal_disposition = "published_released";
  released.candidate_keepalive.release_receipt = releaseReceipt;
  released.candidate_keepalive.audit_receipt = auditReceipt;
  assert.deepEqual(validatePlanningPublicationOperation(released, schema), []);

  const movedBeforeRelease = structuredClone(released);
  movedBeforeRelease.candidate_keepalive.release_receipt.verified_commit_oid = "6".repeat(40);
  movedBeforeRelease.candidate_keepalive.release_receipt.receipt_hash =
    candidateKeepaliveReleaseReceiptHash(movedBeforeRelease.candidate_keepalive.release_receipt);
  assert.match(
    validatePlanningPublicationOperation(movedBeforeRelease, schema).join("\n"),
    /candidate_keepalive release receipt/u,
  );
});

test("raw commit bytes must equal the structured commit recipe", () => {
  const schema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  const example = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
  example.commit_recipe.message_utf8_base64 = Buffer.from("different message\n", "utf8").toString("base64");
  assert.match(
    validatePlanningPublicationOperationExample(example, schema).join("\n"),
    /commit object bytes.*structured recipe/u,
  );
});

test("v1 publication requires a current project-instruction digest", () => {
  const schema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  const example = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
  assert.match(example.project_instruction_digest, /^[0-9a-f]{64}$/u);
  example.project_instruction_digest = null;
  assert.match(
    validatePlanningPublicationOperationExample(example, schema).join("\n"),
    /project_instruction_digest/u,
  );
});

test("prepared publication example starts after verified init reflog", () => {
  const example = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
  assert.equal(example.reflog_checkpoint.before_entry_count >= 1, true);
});

test("operation Schema date-time validation rejects impossible calendar dates", () => {
  const schema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  for (const invalid of ["2026-99-99T99:99:99Z", "2025-02-29T00:00:00Z"]) {
    const example = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
    example.created_at_utc = invalid;
    assert.match(
      validatePlanningPublicationOperationExample(example, schema).join("\n"),
      /created_at_utc.*date-time/u,
    );
  }
});

test("planning-ref init operation has closed Schema, example and design binding", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const schema = JSON.parse(readFileSync(path.join(directory, "init-planning-ref-operation.schema.json"), "utf8"));
  const example = JSON.parse(readFileSync(path.join(directory, "init-planning-ref-operation.example.json"), "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(example.operation_type, "planning_ref_init");
  assert.equal(example.selected_base_ref, "refs/heads/main");
  assert.match(example.bootstrap_policy_digest, /^[0-9a-f]{64}$/u);
  assert.equal(example.ref_storage_format, "files");
  assert.equal(example.phase, "verified");
  assert.notEqual(example.receipts.ref_create, null);
  assert.notEqual(example.receipts.verification, null);
  assert.deepEqual(validatePlanningRefInitOperationExample(example, schema), []);
});

test("init operation rejects substituted base authority, receipts and phase prefixes", () => {
  const schema = JSON.parse(readFileSync(INIT_OPERATION_SCHEMA_PATH, "utf8"));
  const original = JSON.parse(readFileSync(INIT_OPERATION_EXAMPLE_PATH, "utf8"));
  for (const mutate of [
    (value) => { value.selected_base_ref = "refs/heads/../main"; },
    (value) => { value.bootstrap_policy_digest = "0".repeat(64); },
    (value) => { value.receipts.ref_create.operation_id = "99999999-9999-4999-8999-999999999999"; },
    (value) => { value.receipts.ref_create.observation.observed_new_oid = "5".repeat(40); },
    (value) => { value.phase = "ref_created"; },
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.notDeepEqual(validatePlanningRefInitOperation(changed, schema), []);
  }
  const mixedWidth = structuredClone(original);
  mixedWidth.reflog_checkpoint.expected_new_oid = "a".repeat(64);
  assert.notDeepEqual(validateJsonSchema(mixedWidth, schema), []);
});

test("publication examples bind ref backend, producer and normalized pathspec identities", () => {
  const example = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
  assert.equal(example.ref_storage_format, "files");
  assert.equal(example.reflog_producer.git_committer_name, example.commit_recipe.committer.name_utf8);
  assert.equal(example.reflog_producer.git_committer_email, example.commit_recipe.committer.email_ascii);
  assert.match(example.reflog_producer.git_committer_date, /^@[0-9]+ [+-][0-9]{4}$/u);
  assert.deepEqual(example.payload.artifact_pathspec, [...example.payload.artifact_pathspec].sort());
  assert.equal(example.payload.artifact_pathspec.length > 0, true);
});

test("invalidation operation has a deterministic non-empty golden vector", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const schema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  const example = JSON.parse(readFileSync(
    path.join(directory, "publish-planning-invalidation-operation.example.json"),
    "utf8",
  ));
  assert.deepEqual(validatePlanningPublicationOperation(example, schema), []);
  assert.equal(example.operation_type, "anchor_invalidation");
  assert.notEqual(example.candidate_tree_oid, example.expected_parent_tree_oid);
  assert.equal(example.payload.projection_mutations.length > 0, true);
  assert.deepEqual(example.payload.affected_artifact_kinds, ["core_flow", "tech_plan"]);
  assert.match(Buffer.from(example.commit_recipe.message_utf8_base64, "base64").toString("utf8"), /Autosk-Impact-Digest/u);
});

test("invalidation ordering, pathspec digests and stored targets are semantic", () => {
  const schema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  const original = JSON.parse(readFileSync(INVALIDATION_EXAMPLE_PATH, "utf8"));
  assert.equal(
    original.payload.projection_mutations[0].pathspec_digest,
    artifactPathspecDigest(
      original.payload.projection_mutations[0].artifact_kind,
      original.payload.projection_mutations[0].pathspec,
    ),
  );
  for (const mutate of [
    (value) => { value.payload.affected_artifact_kinds.reverse(); },
    (value) => { value.payload.projection_mutations[0].pathspec_digest = "0".repeat(64); },
    (value) => { value.payload.projection_mutations[0].pathspec = ["../escape.md"]; },
    (value) => { value.payload.invalidation_projection_digest = "0".repeat(64); },
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.notDeepEqual(validatePlanningPublicationOperation(changed, schema), []);
  }
});

test("invalidation transition rows close every publication phase and recovery target", () => {
  const plan = fixture()["03-technical-plan.md"];
  for (const marker of [
    "publish_planning_invalidation | phase=prepared and expected object absent",
    "publish_planning_invalidation | phase=commit_created and expected object absent",
    "publish_planning_invalidation | phase=commit_created and ref=expected parent",
    "publish_planning_invalidation | phase=ref_advanced and current bindings drifted",
    "publish_planning_invalidation | phase=ref_advanced and current bindings exact",
    "publish_planning_invalidation | phase=verified, candidate_keepalive phase=released, anchor_rebuild_op phase=release_pending",
    "publish_planning_invalidation | phase=voided_before_ref",
  ]) assert.match(plan, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(plan, /planning_ref_foreign_movement \| init_planning_ref or publish_artifact_pass or publish_planning_invalidation/u);
});

test("design validator rejects a collapsed invalidation recovery machine", () => {
  const files = fixture();
  files["03-technical-plan.md"] = files["03-technical-plan.md"].replace(
    /^\| publish_planning_invalidation \| phase=commit_created and expected object absent[^\n]+\n/mu,
    "",
  );
  assert.match(validatePlanningRefDesign(files).join("\n"), /invalidation phase row missing/u);
});

test("pre-CAS void and invalidation drift close rebuild state and preserve history", () => {
  const plan = fixture()["03-technical-plan.md"];
  assert.match(plan, /publication_status=voided_before_ref.*terminal_reason.*publication_operation_id/u);
  assert.match(plan, /publication_history/u);
  assert.match(plan, /planning_publication_op phase=voided_before_ref\/effective_target_step=prepare_anchor_impact.*anchor_rebuild_op phase=voided_before_ref/u);
  assert.match(plan, /phase=voided_before_ref, candidate_keepalive_op phase=audit_retained.*prepare_anchor_impact/u);
  assert.match(plan, /effective_target_step=prepare_anchor_impact.*anchor_rebuild_op phase=release_pending/u);
  assert.match(plan, /candidate_keepalive phase=released.*close anchor_rebuild_op.*archive operations/u);
});

test("ArtifactPassRecord voiding preserves disposition and uses publication status", () => {
  const files = fixture();
  for (const text of [files["03-technical-plan.md"], files["docs/contracts/epic-planning-ref.md"]]) {
    assert.doesNotMatch(text, /artifact(?:_pass| PASS)\s*(?:(?:\.\s*[a-z_]+)|(?:\[[^\]\r\n]+\]))?\s*=\s*`?void`?/iu);
  }
  for (const assignment of [
    "artifact PASS=`void`",
    "artifact_pass[kind]=void",
    "artifact_pass[tickets] = `void`",
    "artifact_pass [kind] = void",
    "artifact_pass .tickets = `void`",
  ]) {
    const changed = structuredClone(files);
    changed["docs/contracts/epic-planning-ref.md"] += `\n${assignment}\n`;
    assert.match(validatePlanningRefDesign(changed).join("\n"), /unsupported ArtifactPassRecord void state/u);
  }
});

test("reflog producer, expiry and ref backend rules are normative", () => {
  const contract = fixture()["docs/contracts/epic-planning-ref.md"];
  assert.match(contract, /GIT_COMMITTER_NAME.*GIT_COMMITTER_EMAIL.*GIT_COMMITTER_DATE/u);
  assert.match(contract, /gc\..*reflogExpire=never.*reflogExpireUnreachable=never/u);
  assert.match(contract, /ref storage.*files.*reftable.*planning_ref_capability_missing/isu);
  assert.match(contract, /autosk-flow\/artifact-pathspec\/v1\\0/u);
  assert.match(contract, /canonical ArtifactKind order.*brief.*core_flow.*tech_plan.*tickets/isu);
});

test("actor email ident delimiters are rejected by the complete Schema", () => {
  const schema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  const example = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
  example.commit_recipe.author.email_ascii = "bad>ident@example.invalid";
  assert.match(validatePlanningPublicationOperation(example, schema).join("\n"), /email_ascii/u);
});

test("canonical JSON comparison follows Unicode code-point order", () => {
  const files = fixture();
  files["docs/contracts/epic-planning-ref.md"] += "\ncanonical-json-probe: \\uE000 before \\u{10000}\n";
  assert.doesNotMatch(validatePlanningRefDesign(files).join("\n"), /canonical JSON comparator/u);
  const validator = readFileSync(
    path.resolve(path.dirname(OPERATION_SCHEMA_PATH), "../../scripts/validate-planning-ref-design.mjs"),
    "utf8",
  );
  assert.match(validator, /codePointCompare/u);
  assert.equal(canonicalStringify({ "\u{10000}": 2, "\uE000": 1 }), "{\"\":1,\"𐀀\":2}");
});

test("empty invalidation projections and mutable effective targets are rejected", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const schema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  const example = JSON.parse(readFileSync(
    path.join(directory, "publish-planning-invalidation-operation.example.json"),
    "utf8",
  ));
  example.payload.projection_mutations = [];
  example.candidate_tree_oid = example.expected_parent_tree_oid;
  const result = validatePlanningPublicationOperation(example, schema).join("\n");
  assert.match(result, /projection_mutations/u);
  assert.match(result, /candidate_tree_oid/u);
});

test("published kinds remain complete after later descendant publications", () => {
  const plan = fixture()["03-technical-plan.md"];
  const contract = fixture()["docs/contracts/epic-planning-ref.md"];
  assert.match(plan, /published_commit_oid.*first-parent chain.*published tree.*recorded candidate tree/isu);
  assert.match(contract, /reachable on the live planning ref first-parent chain/iu);
  assert.doesNotMatch(plan, /published commit\/tree совпадают с live private planning ref\/head/iu);
});

test("verified planning state guards reflog continuity between operations", () => {
  const files = fixture();
  const plan = files["03-technical-plan.md"];
  const contract = files["docs/contracts/epic-planning-ref.md"];
  assert.match(plan, /last_verified_reflog_tail/iu);
  assert.match(plan, /same-OID ABA.*planning_ref_foreign_movement/isu);
  assert.match(contract, /before every planning gate and before minting a new operation/iu);
});

test("init verified re-entry reaches select-next without another Git write", () => {
  const plan = fixture()["03-technical-plan.md"];
  assert.match(plan, /init_planning_ref \| phase=verified.*zero Git writes.*select_next/iu);
  assert.match(plan, /init_planning_ref \| init_status=verified.*archived.*select_next/iu);
  assert.equal(plan.indexOf("init_status=verified") < plan.indexOf("closed init Schema/example validation fails"), true);
});

test("generic init validation accepts a persisted non-golden producer timestamp", () => {
  const schema = JSON.parse(readFileSync(INIT_OPERATION_SCHEMA_PATH, "utf8"));
  const operation = JSON.parse(readFileSync(INIT_OPERATION_EXAMPLE_PATH, "utf8"));
  operation.phase = "prepared";
  operation.receipts.ref_create = null;
  operation.receipts.verification = null;
  operation.reflog_producer.git_committer_date = "@123 +0000";
  assert.deepEqual(validatePlanningRefInitOperation(operation, schema), []);
});

test("publication update message is bound to the operation id", () => {
  const schema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  const operation = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
  operation.reflog_checkpoint.expected_update_message = "autosk-flow publish 99999999-9999-4999-8999-999999999999";
  assert.match(validatePlanningPublicationOperation(operation, schema).join("\n"), /expected_update_message/u);
});

test("rebuild-anchor cannot bypass descendant invalidation publication", () => {
  const plan = fixture()["03-technical-plan.md"];
  assert.match(plan, /rebuild_anchor.*records immediate target=publish_planning_invalidation/isu);
  assert.match(plan, /post_publication_target_step.*clarify_alignment.*present_tickets_breakdown/isu);
  assert.doesNotMatch(plan, /rebuild_anchor[\s\S]*records target=clarify_alignment/iu);
});

test("publication binding digests have recomputable preimages", () => {
  const schema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  const artifact = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
  const binding = artifact.payload.verdict_or_waiver_binding;
  assert.ok(binding);
  assert.equal(
    artifact.payload.verdict_or_waiver_digest,
    sha256("autosk-flow/verdict-or-waiver/v1\0" + canonicalStringify({
      artifact_identity: artifact.payload.artifact_identity,
      artifact_kind: artifact.payload.artifact_kind,
      disposition: binding.disposition,
      record: binding.record,
    })),
  );
  assert.deepEqual(validatePlanningPublicationOperation(artifact, schema), []);
  const mismatchedBinding = structuredClone(artifact);
  mismatchedBinding.payload.verdict_or_waiver_binding.disposition = "waived";
  mismatchedBinding.payload.verdict_or_waiver_digest = sha256(
    "autosk-flow/verdict-or-waiver/v1\0" + canonicalStringify({
      artifact_identity: mismatchedBinding.payload.artifact_identity,
      artifact_kind: mismatchedBinding.payload.artifact_kind,
      disposition: mismatchedBinding.payload.verdict_or_waiver_binding.disposition,
      record: mismatchedBinding.payload.verdict_or_waiver_binding.record,
    }),
  );
  assert.match(
    validatePlanningPublicationOperation(mismatchedBinding, schema).join("\n"),
    /disposition.*record kind/u,
  );

  const invalidation = JSON.parse(readFileSync(INVALIDATION_EXAMPLE_PATH, "utf8"));
  const mutation = invalidation.payload.projection_mutations[0];
  const expectedPrevious = sha256(
    "autosk-flow/previous-projection/v1\0" + canonicalStringify({
      artifact_kind: mutation.artifact_kind,
      expected_parent_tree_oid: invalidation.expected_parent_tree_oid,
      pathspec: mutation.pathspec,
      pathspec_digest: mutation.pathspec_digest,
    }),
  );
  assert.equal(mutation.previous_projection_digest, expectedPrevious);
  mutation.previous_projection_digest = "0".repeat(64);
  invalidation.payload.invalidation_projection_digest = sha256(
    "autosk-flow/invalidation-projection/v1\0" + canonicalStringify({
      affected_artifact_kinds: invalidation.payload.affected_artifact_kinds,
      projection_mutations: invalidation.payload.projection_mutations,
    }),
  );
  assert.match(validatePlanningPublicationOperation(invalidation, schema).join("\n"), /previous_projection_digest/u);
});

test("v1 commit recipe excludes model-authored message bytes", () => {
  const contract = fixture()["docs/contracts/epic-planning-ref.md"];
  assert.match(contract, /No model-authored bytes enter the v1 commit object/u);
  assert.doesNotMatch(contract, /Model output may propose a human summary/u);
});

test("voided first publication returns to deterministic redraft", () => {
  const plan = fixture()["03-technical-plan.md"];
  assert.match(plan, /recorded_unpublished\\?\|voided_before_ref.*unpublished affected binding.*clarify_alignment/isu);
  assert.match(plan, /first-ever publication.*without.*anchor_impact_invalid/isu);
});

test("artifact publication distinguishes absent and existing prepared objects", () => {
  const plan = fixture()["03-technical-plan.md"];
  assert.match(plan, /publish_artifact_pass \| phase=prepared and expected object absent/iu);
  assert.match(plan, /publish_artifact_pass \| phase=prepared and expected object exists with exact bytes/iu);
});

test("publication drift rows are phase-qualified", () => {
  const plan = fixture()["03-technical-plan.md"];
  assert.match(plan, /publish_artifact_pass \| phase=prepared or phase=commit_created and current binding drift before ref movement/iu);
  assert.match(plan, /publish_artifact_pass \| phase=ref_advanced and current binding drift after expected ref transition/iu);
});

test("closed safe paths reject degenerate and trailing-slash values", () => {
  const schema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  for (const unsafe of [".", "docs/"]) {
    const operation = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
    operation.payload.artifact_pathspec = [unsafe];
    operation.payload.artifact_pathspec_digest = sha256(
      "autosk-flow/artifact-pathspec/v1\0" + canonicalStringify({
        artifact_kind: operation.payload.artifact_kind,
        pathspec: operation.payload.artifact_pathspec,
      }),
    );
    assert.match(validatePlanningPublicationOperation(operation, schema).join("\n"), /artifact_pathspec|safe_relative_path|Schema/u);
  }
});

test("init and publication share one reflog producer identity rule", () => {
  const initSchema = JSON.parse(readFileSync(INIT_OPERATION_SCHEMA_PATH, "utf8"));
  const publicationSchema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  assert.equal(
    initSchema.$defs.reflog_producer.properties.git_committer_email.pattern,
    publicationSchema.$defs.reflog_producer.properties.git_committer_email.pattern,
  );
});

test("terminal planning operations have typed history containers", () => {
  const plan = fixture()["03-technical-plan.md"];
  assert.match(plan, /"init_history": \[\]/u);
  assert.match(plan, /"publication_history": \[\]/u);
  assert.match(plan, /"rebuild_history": \[\]/u);
});

test("governance mapping attestation placement is explicit", () => {
  const contract = fixture()["docs/contracts/epic-planning-ref.md"];
  assert.match(contract, /governance_mapping_set_digest.*operation-only.*retained operation history/isu);
});

test("frozen candidate object closure stays reachable until publication verification", () => {
  const files = fixture();
  const plan = files["03-technical-plan.md"];
  const contract = files["docs/contracts/epic-planning-ref.md"];
  assert.match(plan, /candidate_keepalive.*complete commit\/tree\/blob closure/isu);
  assert.match(plan, /candidate_keepalive phase=released.*planning ref.*verified/isu);
  assert.match(plan, /atomic update-ref transaction verifies.*keepalive.*CAS-advances planning ref/isu);
  assert.match(plan, /candidate_audit_transfer_op phase=prepared.*audit_ref_verified.*live_ref_deleted/isu);
  assert.match(contract, /refs\/autosk\/epics\/<epic_ref_key>\/candidates\/<candidate_identity>/u);
  assert.match(contract, /complete commit\/tree\/blob quarantine pack.*outside project GC/isu);
  assert.match(contract, /verify <candidate_keepalive_ref> <snapshot_commit_oid>.*update <planning_ref>/isu);
  assert.match(contract, /prepared -> audit_ref_verified -> live_ref_deleted -> verified/isu);
});

test("publication operation binds a verified candidate keepalive", () => {
  const schema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  for (const pathName of [OPERATION_EXAMPLE_PATH, INVALIDATION_EXAMPLE_PATH]) {
    const operation = JSON.parse(readFileSync(pathName, "utf8"));
    assert.equal(operation.candidate_keepalive.phase, "verified");
    assert.equal(operation.candidate_keepalive.snapshot_tree_oid, operation.candidate_tree_oid);
    assert.deepEqual(
      schema.$defs.candidate_keepalive_release_receipt.required.includes("planning_reflog_tail_observation_sha256"),
      true,
    );
    assert.match(operation.candidate_keepalive.ref, /^refs\/autosk\/epics\/[0-9a-f]{64}\/candidates\/[0-9a-f]{64}$/u);
    assert.deepEqual(validatePlanningPublicationOperation(operation, schema), []);

    const changed = structuredClone(operation);
    changed.candidate_keepalive.snapshot_tree_oid = changed.expected_parent_tree_oid;
    assert.match(
      validatePlanningPublicationOperation(changed, schema).join("\n"),
      /candidate_keepalive.*tree/u,
    );
    const releasedWithoutReceipt = structuredClone(operation);
    releasedWithoutReceipt.candidate_keepalive.phase = "released";
    assert.match(
      validatePlanningPublicationOperation(releasedWithoutReceipt, schema).join("\n"),
      /candidate_keepalive release receipt/u,
    );
  }
});

test("operation IDs, update messages and Git timestamps use one closed grammar", () => {
  const publication = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  const init = JSON.parse(readFileSync(INIT_OPERATION_SCHEMA_PATH, "utf8"));
  assert.equal(publication.$defs.uuid.pattern, init.$defs.uuid.pattern);
  assert.match(publication.$defs.uuid.pattern, /-4\[0-9a-f\]/u);
  assert.match(init.properties.expected_update_message.pattern, /autosk-flow init/u);
  assert.match(init.$defs.reflog_checkpoint.properties.expected_update_message.pattern, /autosk-flow init/u);
  assert.equal(publication.$defs.actor.properties.timezone.const, "+0000");
  assert.match(publication.$defs.reflog_producer.properties.git_committer_date.pattern, /\\\+0000/u);
  assert.match(init.$defs.reflog_producer.properties.git_committer_date.pattern, /\\\+0000/u);

  const initOperation = JSON.parse(readFileSync(INIT_OPERATION_EXAMPLE_PATH, "utf8"));
  initOperation.phase = "prepared";
  initOperation.receipts.ref_create = null;
  initOperation.receipts.verification = null;
  initOperation.expected_update_message = "autosk-flow init 99999999-9999-4999-8999-999999999999";
  initOperation.reflog_checkpoint.expected_update_message = initOperation.expected_update_message;
  assert.match(
    validatePlanningRefInitOperation(initOperation, init).join("\n"),
    /expected_update_message|reflog checkpoint|Schema/u,
  );

  const nonUtc = JSON.parse(readFileSync(INIT_OPERATION_EXAMPLE_PATH, "utf8"));
  nonUtc.reflog_producer.git_committer_date = "@123 +0530";
  assert.match(validatePlanningRefInitOperation(nonUtc, init).join("\n"), /git_committer_date|reflog_producer/u);
});

test("init deletion and idle foreign movement have explicit recovery targets", () => {
  const plan = fixture()["03-technical-plan.md"];
  assert.match(plan, /init_planning_ref \| phase=ref_created, ref absent.*planning_ref_foreign_movement/iu);
  assert.match(plan, /planning_ref_foreign_movement.*no open operation.*recorded detecting gate/isu);
});

test("invalidation object-exists recovery keeps ref and reflog guards", () => {
  const plan = fixture()["03-technical-plan.md"];
  assert.match(
    plan,
    /publish_planning_invalidation \| phase=prepared and expected object exists with exact bytes, ref=expected parent and reflog prefix=checkpoint/iu,
  );
});

test("protected ref namespace has one enforceable OS-level writer", () => {
  const files = fixture();
  const architecture = files["02-architecture.md"];
  const plan = files["03-technical-plan.md"];
  const contract = files["docs/contracts/epic-planning-ref.md"];
  const schema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  const example = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
  assert.match(architecture, /single object\/ref database.*separate-account ref-custody helper.*sole writer.*refs\/autosk/isu);
  assert.match(plan, /ref custody ownership\/mode\/generation drift.*retain.*candidate_keepalive.*planning_ref_capability_missing/isu);
  assert.match(contract, /one service-owned canonical project common Git directory.*only `autosk-flow-ref-custody` writes `refs\/autosk/isu);
  assert.equal(schema.required.includes("ref_custody_policy_digest"), true);
  assert.match(example.ref_custody_policy_digest, /^[0-9a-f]{64}$/u);
  assert.equal(
    schema.$defs.candidate_keepalive_release_receipt.required.includes("ref_custody_generation"),
    true,
  );
  assert.equal(
    schema.$defs.candidate_keepalive_release_receipt.required.includes("ref_custody_policy_digest"),
    true,
  );
});

test("invalidation archives only after keepalive release", () => {
  const plan = fixture()["03-technical-plan.md"];
  const verified = plan.match(/^\| publish_planning_invalidation \| phase=ref_advanced and current bindings exact[^\n]+$/mu)?.[0] ?? "";
  const released = plan.match(/^\| publish_planning_invalidation \| phase=verified, candidate_keepalive phase=released[^\n]+$/mu)?.[0] ?? "";
  assert.doesNotMatch(verified, /archive operations/u);
  assert.match(verified, /release_pending/u);
  assert.match(released, /archive operations/u);
});

test("rejected candidates have a typed audit-retention lifecycle", () => {
  const plan = fixture()["03-technical-plan.md"];
  const contract = fixture()["docs/contracts/epic-planning-ref.md"];
  assert.match(plan, /candidate_keepalive.*panel NOT_PASS.*audit_retained/isu);
  assert.match(plan, /cleanup.*unresolved current keepalive.*planning_candidate_keepalive_invalid/isu);
  assert.match(plan, /cleanup.*audit_retained.*done/isu);
  assert.match(contract, /audit\/candidates\/<candidate_identity>.*snapshot commit/isu);
});

test("ref-custody helper is an owned packaged runtime component", () => {
  const files = fixture();
  assert.match(files["02-architecture.md"], /autosk-flow-ref-custody.*Unix socket.*daemon capability/isu);
  assert.match(files["03-technical-plan.md"], /src\/git\/ref-custody-helper\.ts/iu);
  assert.match(files["03-technical-plan.md"], /Slice 1.*ref-custody helper.*stale-lock recovery/isu);
  assert.match(files["docs/contracts/epic-planning-ref.md"], /issue #5 owns.*ref-custody helper/isu);
});

test("packed refs cannot contain the protected namespace", () => {
  const files = fixture();
  const contract = files["docs/contracts/epic-planning-ref.md"];
  assert.match(contract, /gc\.packRefs=false.*packed-refs.*refs\/autosk/isu);
  assert.match(contract, /loose ref absent.*packed entry present.*planning_ref_capability_missing/isu);
  assert.match(files["03-technical-plan.md"], /packed-refs contains refs\/autosk.*retain.*keepalive/isu);
});

test("snapshot commit remains reachable through an audit ref", () => {
  const contract = fixture()["docs/contracts/epic-planning-ref.md"];
  assert.match(contract, /audit_ref_verified.*live remains/isu);
  assert.match(contract, /audit custody remains until approved retention expiry/isu);
});

test("release digests have literal golden vectors", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const releasedPath = path.join(directory, "publish-artifact-pass-operation.released.example.json");
  const released = JSON.parse(readFileSync(releasedPath, "utf8"));
  assert.equal(released.candidate_keepalive.phase, "released");
  assert.equal(
    released.candidate_keepalive.release_receipt.planning_reflog_tail_observation_sha256,
    "2a62fc213614230da0e98be3d06e32f4a57373dbbbd30468d88a7db9d4ae2e04",
  );
  assert.equal(
    released.candidate_keepalive.release_receipt.transaction_observation_sha256,
    "ec6b5cd265114f48d5504596fd2244d842b9d8bb5e9d73469be1035cf7bf8a75",
  );
});

test("candidate keepalive operation has a closed standalone machine", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const schema = JSON.parse(readFileSync(path.join(directory, "candidate-keepalive-operation.schema.json"), "utf8"));
  const example = JSON.parse(readFileSync(path.join(directory, "candidate-keepalive-operation.example.json"), "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.phase.enum, ["prepared", "object_written", "ref_created", "verified", "audit_retained", "released"]);
  assert.equal(example.phase, "verified");
  assert.notEqual(example.create_receipt, null);
  assert.notEqual(example.verification_receipt, null);
  const missingVerification = structuredClone(example);
  missingVerification.verification_receipt = null;
  assert.notDeepEqual(validateJsonSchema(missingVerification, schema), []);
  const refCreated = JSON.parse(readFileSync(
    path.join(directory, "candidate-keepalive-operation.ref-created.example.json"),
    "utf8",
  ));
  assert.equal(refCreated.verification_receipt, null);
  const audit = JSON.parse(readFileSync(
    path.join(directory, "candidate-keepalive-operation.audit-retained.example.json"),
    "utf8",
  ));
  assert.equal(audit.audit_receipt.observation_sha256, "8bfa2dd24f3ae68a9a25165548b47604986f7aae40496ba47647e62e5c44e208");
  assert.equal(audit.audit_receipt.receipt_hash, "8162a7c325bec638bf81936173919aa087faccab047cd3fec634aeff4e7abbfe");
  const invalidPrepared = structuredClone(audit);
  invalidPrepared.phase = "prepared";
  invalidPrepared.terminal_disposition = "published_released";
  assert.notDeepEqual(validateJsonSchema(invalidPrepared, schema), []);
  const invalidReleased = structuredClone(example);
  invalidReleased.phase = "released";
  invalidReleased.terminal_disposition = null;
  invalidReleased.create_receipt = null;
  invalidReleased.audit_receipt = null;
  assert.notDeepEqual(validateJsonSchema(invalidReleased, schema), []);
});

test("keepalive create proof is operation-scoped and uses null missing-old", () => {
  const publication = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
  const init = JSON.parse(readFileSync(INIT_OPERATION_EXAMPLE_PATH, "utf8"));
  assert.match(publication.candidate_keepalive.expected_update_message, new RegExp(publication.candidate_keepalive.operation_id, "u"));
  assert.equal(publication.candidate_keepalive.create_receipt.operation_id, publication.candidate_keepalive.operation_id);
  assert.equal(publication.candidate_keepalive.create_receipt.observed_old_oid, null);
  assert.equal(init.receipts.ref_create.observation.observed_old_oid, null);
});

test("terminal keepalive recovery precedes the active live-ref guard", () => {
  const plan = fixture()["03-technical-plan.md"];
  const liveGuard = plan.indexOf("publish_artifact_pass | candidate_keepalive phase=prepared\\|object_written\\|ref_created\\|verified and live ref is absent/moved");
  const released = plan.indexOf("publish_artifact_pass | phase=verified, candidate_keepalive phase=released");
  const auditRetained = plan.indexOf("publish_artifact_pass | phase=voided_before_ref, candidate_keepalive_op phase=audit_retained");
  assert.ok(released >= 0 && auditRetained >= 0 && liveGuard > released && liveGuard > auditRetained);
  assert.match(plan, /phase=verified, candidate_keepalive phase=released.*live candidate ref absent.*audit candidate ref/isu);
});

test("standalone keepalive validator rejects a self-consistent substituted reflog entry", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const schema = JSON.parse(readFileSync(path.join(directory, "candidate-keepalive-operation.schema.json"), "utf8"));
  const forged = JSON.parse(readFileSync(path.join(directory, "candidate-keepalive-operation.example.json"), "utf8"));
  forged.create_receipt.appended_entry_sha256 = "f".repeat(64);
  const observation = {
    after_entry_count: forged.create_receipt.after_entry_count,
    appended_entry_sha256: forged.create_receipt.appended_entry_sha256,
    before_entry_count: forged.create_receipt.before_entry_count,
    before_prefix_sha256: forged.create_receipt.before_prefix_sha256,
    candidate_identity: forged.create_receipt.candidate_identity,
    expected_update_message: forged.create_receipt.expected_update_message,
    observed_new_oid: forged.create_receipt.observed_new_oid,
    observed_old_oid: forged.create_receipt.observed_old_oid,
    operation_id: forged.create_receipt.operation_id,
    ref: forged.create_receipt.ref,
    snapshot_tree_oid: forged.create_receipt.snapshot_tree_oid,
  };
  forged.create_receipt.observation_sha256 = sha256(
    "autosk-flow/candidate-keepalive-create/v1\0" + canonicalStringify(observation),
  );
  forged.create_receipt.receipt_hash = sha256(
    "autosk-flow/candidate-keepalive-receipt/v1\0" + canonicalStringify({
      candidate_identity: forged.candidate_identity,
      operation_id: forged.operation_id,
      observation_sha256: forged.create_receipt.observation_sha256,
    }),
  );
  assert.match(validateCandidateKeepaliveOperation(forged, schema).join("\n"), /reflog entry/u);
});

test("keepalive terminal history and released golden state are closed", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const releasedPath = path.join(directory, "candidate-keepalive-operation.released.example.json");
  const released = JSON.parse(readFileSync(releasedPath, "utf8"));
  const schema = JSON.parse(readFileSync(path.join(directory, "candidate-keepalive-operation.schema.json"), "utf8"));
  assert.deepEqual(validateCandidateKeepaliveOperation(released, schema), []);
  assert.equal(released.phase, "released");
  assert.equal(released.terminal_disposition, "published_released");
  assert.notEqual(released.release_receipt, null);
  assert.notEqual(released.audit_receipt, null);
  assert.match(fixture()["03-technical-plan.md"], /planning\.candidate_history.*append-only/isu);
});

test("publication embeds the authoritative standalone keepalive record verbatim", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const standalone = JSON.parse(readFileSync(
    path.join(directory, "candidate-keepalive-operation.schema.json"),
    "utf8",
  ));
  const publicationSchema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  assert.deepEqual(publicationSchema.$defs.candidate_keepalive.required, standalone.required);
  for (const name of [
    "publish-artifact-pass-operation.example.json",
    "publish-planning-invalidation-operation.example.json",
    "publish-artifact-pass-operation.released.example.json",
    "publish-artifact-pass-operation.voided.example.json",
  ]) {
    const publication = JSON.parse(readFileSync(path.join(directory, name), "utf8"));
    assert.deepEqual(validateCandidateKeepaliveOperation(publication.candidate_keepalive, standalone), []);
  }
});

test("snapshot commit recipe is complete, reproducible and required before keepalive creation", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const standalone = JSON.parse(readFileSync(
    path.join(directory, "candidate-keepalive-operation.schema.json"),
    "utf8",
  ));
  const publicationSchema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  assert.equal(standalone.required.includes("snapshot_commit_recipe"), true);
  assert.equal(
    publicationSchema.$defs.candidate_keepalive.required.includes("snapshot_commit_recipe"),
    true,
  );
  const operation = JSON.parse(readFileSync(
    path.join(directory, "candidate-keepalive-operation.example.json"),
    "utf8",
  ));
  assert.deepEqual(validateCandidateKeepaliveOperation(operation, standalone), []);
  const changed = structuredClone(operation);
  changed.snapshot_commit_recipe.commit_object_bytes_base64 = Buffer.from("forged", "utf8").toString("base64");
  assert.match(validateCandidateKeepaliveOperation(changed, standalone).join("\n"), /snapshot commit recipe/u);
});

test("malformed planning resources report the exact filename", () => {
  const files = fixture();
  files["resources/planning-publication/ref-custody-helper-contract.example.json"] = "{";
  assert.match(
    validatePlanningRefDesign(files).join("\n"),
    /resource is not valid JSON: resources\/planning-publication\/ref-custody-helper-contract\.example\.json/u,
  );
});

test("all abandoned candidates transfer to audit and helper callers have resume targets", () => {
  const plan = fixture()["03-technical-plan.md"];
  assert.match(plan, /superseded.*rebuild_anchor.*record_artifact_pass.*new candidate/isu);
  assert.match(plan, /candidate_supersession_op phase=prepared.*reason=superseded.*phase=audit_transferred/isu);
  assert.match(plan, /candidate_supersession_op phase=audit_transferred.*planning\.candidate_history.*phase=archived/isu);
  assert.match(plan, /cleanup.*audit namespace.*supersession operation/isu);
  assert.match(plan, /synthesize_panel.*planning_candidate_keepalive_invalid/isu);
  assert.match(plan, /narrow_review_join.*planning_candidate_keepalive_invalid/isu);
  assert.match(plan, /cleanup.*planning_candidate_keepalive_invalid/isu);
  assert.match(plan, /synthesize_panel \/ narrow_review_join.*cleanup.*planning_ref_capability_missing/isu);
  assert.match(plan, /cleanup.*enumerate.*refs\/autosk\/epics\/<epic_ref_key>\/candidates/isu);
});

test("snapshot commit and ref-custody protocol are deterministic and action-closed", () => {
  const contract = fixture()["docs/contracts/epic-planning-ref.md"];
  assert.match(contract, /snapshot commit recipe.*persisted before.*Git write.*single parent.*expected OID/isu);
  assert.match(contract, /action-discriminated.*reflog_producer.*reflog_checkpoint.*raw appended entry/isu);
  assert.match(contract, /init.*create_keepalive.*advance_planning.*ensure_audit_ref.*delete_live_ref.*delete_expired_audit.*golden vector/isu);
  assert.match(contract, /lost response.*journal.*fsync.*nonce/isu);
});

test("ref-custody helper has six machine-validated action contracts and literal vectors", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const schema = JSON.parse(readFileSync(
    path.join(directory, "ref-custody-helper-contract.schema.json"),
    "utf8",
  ));
  const example = JSON.parse(readFileSync(
    path.join(directory, "ref-custody-helper-contract.example.json"),
    "utf8",
  ));
  assert.deepEqual(validateRefCustodyHelperContract(example, schema), []);
  assert.deepEqual(example.actions.map(({ action }) => action), [
    "init",
    "create_keepalive",
    "advance_planning",
    "ensure_audit_ref",
    "delete_live_ref",
    "delete_expired_audit",
  ]);
  const forged = structuredClone(example);
  forged.actions[4].golden.receipt_shape_sha256 = "0".repeat(64);
  assert.match(validateRefCustodyHelperContract(forged, schema).join("\n"), /golden vector/u);
  const swapped = structuredClone(example);
  swapped.actions[0].request_domain = swapped.actions[2].request_domain;
  assert.notDeepEqual(validateJsonSchema(swapped, schema), []);
});

test("invalidation and retention prose follow release-before-archive", () => {
  const contract = fixture()["docs/contracts/epic-planning-ref.md"];
  assert.doesNotMatch(contract, /Pre-CAS drift[^.]*archives both records/isu);
  assert.match(contract, /Pre-CAS drift.*audit_retained.*only then.*archive/isu);
  assert.match(contract, /gc\."refs\/autosk\/epics\/\*\/audit\/candidates\/\*"\.reflogExpire=never/isu);
  assert.match(contract, /phase=`verified`, keepalive still verified.*create.*audit.*delete.*live/isu);
});

test("successful publication archives its operation and literal release receipt is pinned", () => {
  const plan = fixture()["03-technical-plan.md"];
  assert.match(plan, /publish_artifact_pass \| phase=verified, candidate_keepalive phase=released.*archive.*publication_history/iu);
  const released = JSON.parse(readFileSync(
    path.join(path.dirname(OPERATION_SCHEMA_PATH), "publish-artifact-pass-operation.released.example.json"),
    "utf8",
  ));
  assert.equal(
    released.candidate_keepalive.release_receipt.receipt_hash,
    "a471b2fae744852dc18a4636ae3e94ce29359a7a93810434ffd58e8385ed8862",
  );
});

test("archived terminal publications re-enter before the absent-operation guard", () => {
  const plan = fixture()["03-technical-plan.md"];
  for (const step of ["publish_artifact_pass", "publish_planning_invalidation"]) {
    const archived = plan.indexOf(`${step} | archived verified publication operation`);
    const absent = plan.indexOf(`${step} | open operation absent`);
    assert.ok(archived >= 0 && absent >= 0 && archived < absent, `${step} archived recovery order`);
  }
  assert.match(plan, /archived verified publication operation.*zero Git writes.*stored effective target/isu);
});

test("active keepalive guard precedes publication object and CAS side effects", () => {
  const plan = fixture()["03-technical-plan.md"];
  for (const step of ["publish_artifact_pass", "publish_planning_invalidation"]) {
    const guard = plan.indexOf(`${step} | candidate_keepalive phase=prepared\\|object_written\\|ref_created\\|verified`);
    const objectWrite = plan.indexOf(`${step} | phase=prepared and expected object absent`);
    const cas = plan.indexOf(`${step} | phase=commit_created and ref=expected parent`);
    assert.ok(guard >= 0 && guard < objectWrite && guard < cas, `${step} active keepalive guard order`);
  }
});

test("snapshot object write is a durable keepalive phase before ref creation", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const schema = JSON.parse(readFileSync(
    path.join(directory, "candidate-keepalive-operation.schema.json"),
    "utf8",
  ));
  assert.deepEqual(schema.properties.phase.enum, [
    "prepared", "object_written", "ref_created", "verified", "audit_retained", "released",
  ]);
  assert.equal(schema.required.includes("snapshot_object_receipt"), true);
  const plan = fixture()["03-technical-plan.md"];
  assert.match(plan, /freeze_artifact \| candidate_keepalive_op phase=prepared and snapshot object absent.*phase=object_written/iu);
  assert.match(plan, /freeze_artifact \| candidate_keepalive_op phase=object_written and snapshot object exact.*phase=ref_created/isu);
});

test("publication accepts earlier keepalive timestamp and represents audit-retained terminal state", () => {
  const schema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  const operation = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
  operation.created_at_utc = "2026-09-01T00:01:00Z";
  assert.deepEqual(validatePlanningPublicationOperation(operation, schema), []);
  operation.created_at_utc = "2026-08-31T23:59:59Z";
  assert.match(validatePlanningPublicationOperation(operation, schema).join("\n"), /created_at_utc/u);
  assert.equal(schema.$defs.candidate_keepalive.properties.phase.enum.includes("audit_retained"), true);
  assert.equal(
    schema.$defs.candidate_keepalive_audit_receipt.properties.reason.enum.includes("voided_before_ref"),
    true,
  );
});

test("planning resume catalogs carry identical helper recovery targets", () => {
  const files = fixture();
  for (const reason of ["planning_ref_capability_missing", "planning_candidate_keepalive_invalid"]) {
    const core = files["01-core-flows.md"].split("\n").find((line) => line.startsWith(`| ${reason} |`));
    const plan = files["03-technical-plan.md"].split("\n").find((line) => line.startsWith(`| ${reason} |`));
    assert.equal(core?.split("|")[2].trim(), plan?.split("|")[2].trim());
  }
  assert.match(files["02-architecture.md"], /planning\.candidate_history/iu);
});

test("standalone keepalive derives epic key and ships prepared/ref-created vectors", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const schema = JSON.parse(readFileSync(
    path.join(directory, "candidate-keepalive-operation.schema.json"),
    "utf8",
  ));
  for (const name of [
    "candidate-keepalive-operation.prepared.example.json",
    "candidate-keepalive-operation.ref-created.example.json",
  ]) {
    const operation = JSON.parse(readFileSync(path.join(directory, name), "utf8"));
    assert.deepEqual(validateCandidateKeepaliveOperation(operation, schema), []);
  }
  const foreign = JSON.parse(readFileSync(
    path.join(directory, "candidate-keepalive-operation.example.json"),
    "utf8",
  ));
  foreign.epic_ref_key = "f".repeat(64);
  foreign.ref = `refs/autosk/epics/${foreign.epic_ref_key}/candidates/${foreign.candidate_identity}`;
  foreign.audit_ref = `refs/autosk/epics/${foreign.epic_ref_key}/audit/candidates/${foreign.candidate_identity}`;
  assert.match(validateCandidateKeepaliveOperation(foreign, schema).join("\n"), /epic_ref_key/u);
  const changedPreimage = JSON.parse(readFileSync(
    path.join(directory, "candidate-keepalive-operation.example.json"),
    "utf8",
  ));
  changedPreimage.candidate_identity_preimage.anchor_version += 1;
  assert.match(validateCandidateKeepaliveOperation(changedPreimage, schema).join("\n"), /candidate_identity preimage/u);
});

test("ref-custody wire examples bind actual values, authorization and durable journal", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const wire = JSON.parse(readFileSync(
    path.join(directory, "ref-custody-helper-wire.example.json"),
    "utf8",
  ));
  const schema = JSON.parse(readFileSync(
    path.join(directory, "ref-custody-helper-wire.schema.json"),
    "utf8",
  ));
  assert.deepEqual(validateRefCustodyHelperWireExamples(wire, schema), []);
  assert.equal(wire.actions.length, 8);
  for (const action of wire.actions) {
    assert.equal(action.request.authorization.scheme, "ed25519");
    assert.match(action.request.body_sha256, /^[0-9a-f]{64}$/u);
    assert.equal(action.request.authorization.request_body_sha256, action.request.body_sha256);
    assert.ok(action.response.ref_observations.length >= 1);
    assert.match(action.response.transaction_value_observation_sha256, /^[0-9a-f]{64}$/u);
    assert.equal(action.journal.phase, "receipt_committed");
    assert.deepEqual(action.journal.fsync_order, ["request", "refs", "receipt"]);
  }
  const forged = structuredClone(wire);
  forged.actions[4].response.ref_observations[1].observed_new_oid = "f".repeat(40);
  assert.match(
    validateRefCustodyHelperWireExamples(forged, schema).join("\n"),
    /ref observations|value-bound response|journal/u,
  );
  const foreignCheckpoint = structuredClone(wire);
  foreignCheckpoint.actions[0].request.reflog_checkpoints[0].ref = "refs/heads/main";
  assert.notDeepEqual(validateJsonSchema(foreignCheckpoint, schema), []);
  assert.match(validateRefCustodyHelperWireExamples(foreignCheckpoint, schema).join("\n"), /reflog refs|topology/u);
});

test("ref-custody helper rejects mixed object formats in one signed request", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const wire = JSON.parse(readFileSync(path.join(directory, "ref-custody-helper-wire.example.json"), "utf8"));
  const schema = JSON.parse(readFileSync(path.join(directory, "ref-custody-helper-wire.schema.json"), "utf8"));
  const mixed = structuredClone(wire);
  mixed.actions[4].request.ref_updates[1].new_oid = "a".repeat(64);
  mixed.actions[4].response.ref_observations[1].requested_new_oid = "a".repeat(64);
  mixed.actions[4].response.ref_observations[1].observed_new_oid = "a".repeat(64);
  assert.match(validateRefCustodyHelperWireExamples(mixed, schema).join("\n"), /object format/u);
  const publicationSchema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  const publication = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
  publication.expected_parent_tree_oid = "a".repeat(64);
  assert.notDeepEqual(validateJsonSchema(publication, publicationSchema), []);
  assert.match(validatePlanningPublicationOperation(publication, publicationSchema).join("\n"), /object format/u);
  const nestedFormat = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
  nestedFormat.candidate_keepalive.snapshot_commit_recipe.object_format = "sha256";
  nestedFormat.candidate_keepalive.snapshot_object_receipt.object_format = "sha256";
  assert.notDeepEqual(validateJsonSchema(nestedFormat, publicationSchema), []);
  const nestedVerification = JSON.parse(readFileSync(OPERATION_EXAMPLE_PATH, "utf8"));
  nestedVerification.candidate_keepalive.verification_receipt.observed_oid = "a".repeat(64);
  assert.notDeepEqual(validateJsonSchema(nestedVerification, publicationSchema), []);
  const keepaliveSchema = JSON.parse(readFileSync(
    path.join(directory, "candidate-keepalive-operation.schema.json"),
    "utf8",
  ));
  const keepalive = JSON.parse(readFileSync(
    path.join(directory, "candidate-keepalive-operation.released.example.json"),
    "utf8",
  ));
  keepalive.release_receipt.verified_commit_oid = "a".repeat(64);
  assert.notDeepEqual(validateJsonSchema(keepalive, keepaliveSchema), []);
  const keepaliveVerification = JSON.parse(readFileSync(
    path.join(directory, "candidate-keepalive-operation.example.json"),
    "utf8",
  ));
  keepaliveVerification.verification_receipt.observed_oid = "a".repeat(64);
  assert.notDeepEqual(validateJsonSchema(keepaliveVerification, keepaliveSchema), []);
});

test("pre-existing exact audit topology is a valid release variant", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const wire = JSON.parse(readFileSync(path.join(directory, "ref-custody-helper-wire.example.json"), "utf8"));
  const schema = JSON.parse(readFileSync(path.join(directory, "ref-custody-helper-wire.schema.json"), "utf8"));
  const existing = structuredClone(wire);
  const release = existing.actions.find(({ action, request }) =>
    action === "ensure_audit_ref" && request.transfer_mode === "release_to_audit");
  release.request.ref_updates[2].operation = "verify";
  release.request.ref_updates[2].expected_old_oid = release.request.ref_updates[2].new_oid;
  const errors = validateRefCustodyHelperWireExamples(existing, schema).join("\n");
  assert.doesNotMatch(errors, /action-specific ref update set mismatch/u);
  const golden = JSON.parse(readFileSync(path.join(
    directory,
    "ref-custody-helper-wire.existing-audit.example.json",
  ), "utf8"));
  assert.deepEqual(validateRefCustodyHelperWireExamples(golden, schema), []);
  for (const exchange of golden.actions) {
    assert.ok(exchange.request.ref_updates.some((update) =>
      update.operation === "verify" && update.ref.includes("/audit/candidates/")));
  }
});

test("exact signing accepts only one canonical gpgsig header", () => {
  assert.equal(isCanonicalGpgsigHeader(Buffer.from("gpgsig signed-payload\n continuation\n", "utf8")), true);
  assert.equal(isCanonicalGpgsigHeader(Buffer.from("gpgsig signed-payload\nparent injected\n", "utf8")), false);
  assert.equal(isCanonicalGpgsigHeader(Buffer.from("gpgsig signed-payload\n\nauthor injected\n", "utf8")), false);
});

test("candidate supersession has a closed durable operation and receipt", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const schema = JSON.parse(readFileSync(
    path.join(directory, "candidate-supersession-operation.schema.json"),
    "utf8",
  ));
  const operation = JSON.parse(readFileSync(
    path.join(directory, "candidate-supersession-operation.example.json"),
    "utf8",
  ));
  assert.deepEqual(validateCandidateSupersessionOperation(operation, schema), []);
  assert.match(operation.helper_request_binding.binding_hash, /^[0-9a-f]{64}$/u);
  const changed = structuredClone(operation);
  changed.audit_receipt.snapshot_commit_oid = "f".repeat(40);
  assert.match(validateCandidateSupersessionOperation(changed, schema).join("\n"), /audit receipt/u);
  const reused = structuredClone(operation);
  reused.replacement_intent_digest = "b".repeat(64);
  assert.match(validateCandidateSupersessionOperation(reused, schema).join("\n"), /helper transaction receipt/u);
  const foreignRef = structuredClone(operation);
  foreignRef.helper_transaction_receipt.live_ref = "refs/heads/main";
  assert.notDeepEqual(validateJsonSchema(foreignRef, schema), []);
});

test("audit-retained keepalive rejects publication-verified reason", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const schema = JSON.parse(readFileSync(path.join(directory, "candidate-keepalive-operation.schema.json"), "utf8"));
  const operation = JSON.parse(readFileSync(path.join(directory, "candidate-keepalive-operation.audit-retained.example.json"), "utf8"));
  operation.audit_receipt.reason = "publication_verified";
  assert.notDeepEqual(validateJsonSchema(operation, schema), []);
  assert.match(validateCandidateKeepaliveOperation(operation, schema).join("\n"), /phase receipt prefix/u);
});

test("released keepalive Schema requires publication-verified audit reason", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const schema = JSON.parse(readFileSync(path.join(directory, "candidate-keepalive-operation.schema.json"), "utf8"));
  const operation = JSON.parse(readFileSync(path.join(directory, "candidate-keepalive-operation.released.example.json"), "utf8"));
  operation.audit_receipt.reason = "superseded";
  assert.notDeepEqual(validateJsonSchema(operation, schema), []);
});

test("helper reflog observations are realizable files-backend states", () => {
  const wire = JSON.parse(readFileSync(
    path.join(path.dirname(OPERATION_SCHEMA_PATH), "ref-custody-helper-wire.example.json"),
    "utf8",
  ));
  for (const exchange of wire.actions) {
    for (const observation of exchange.response.reflog_observations) {
      const prefix = Buffer.from(observation.before_prefix_base64, "base64");
      assert.equal(prefix.toString("utf8").split("\n").filter(Boolean).length, observation.before_entry_count);
      assert.equal(reflogPrefixDigest(observation.before_entry_count, prefix), observation.before_prefix_sha256);
      if (observation.outcome === "log_removed") {
        assert.equal(observation.after_entry_count, null);
        assert.deepEqual(observation.raw_appended_entries_base64, []);
      } else if (observation.outcome === "unchanged") {
        assert.equal(observation.after_entry_count, observation.before_entry_count);
        assert.deepEqual(observation.raw_appended_entries_base64, []);
      } else {
        assert.equal(observation.outcome, "appended");
        assert.equal(observation.after_entry_count, observation.before_entry_count + 1);
      }
    }
  }
});

test("real Git files backend matches helper reflog and deletion semantics", () => {
  const formats = ["sha1"];
  const gitLocationEnvironment = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
  };
  const probe = mkdtempSync(path.join(tmpdir(), "autosk-ref-custody-probe-"));
  try {
    try {
      execFileSync("git", ["init", "--quiet", "--object-format=sha256", probe], {
        env: gitLocationEnvironment,
      });
      formats.push("sha256");
    } catch {
      // SHA-256 is capability-gated; SHA-1 remains mandatory on older Git.
    }
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }

  for (const format of formats) {
    const repository = mkdtempSync(path.join(tmpdir(), `autosk-ref-custody-${format}-`));
    const environment = {
      ...gitLocationEnvironment,
      GIT_AUTHOR_NAME: "autosk-flow",
      GIT_AUTHOR_EMAIL: "autosk@example.invalid",
      GIT_AUTHOR_DATE: "@1 +0000",
      GIT_COMMITTER_NAME: "autosk-flow",
      GIT_COMMITTER_EMAIL: "autosk@example.invalid",
      GIT_COMMITTER_DATE: "@1 +0000",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      LC_ALL: "C",
      TZ: "UTC",
    };
    const run = (args, options = {}) => execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
      env: environment,
      ...options,
    }).trim();
    try {
      execFileSync("git", ["init", "--quiet", `--object-format=${format}`, repository], { env: environment });
      run(["config", "core.logAllRefUpdates", "always"]);
      run(["config", "gc.packRefs", "false"]);
      const tree = run(["hash-object", "-w", "-t", "tree", "--stdin"], { input: "" });
      const first = run(["commit-tree", tree], { input: "first\n" });
      const second = run(["commit-tree", tree, "-p", first], {
        input: "second\n",
        env: { ...environment, GIT_AUTHOR_DATE: "@2 +0000", GIT_COMMITTER_DATE: "@2 +0000" },
      });
      const ref = `refs/autosk/epics/${"e".repeat(64)}/planning`;
      const message = "autosk-flow init 00000000-0000-4000-8000-000000000000";
      run(["update-ref", "--create-reflog", "-m", message, "--stdin"], {
        input: `create ${ref} ${first}\n`,
      });
      assert.throws(() => run(["update-ref", "--create-reflog", "--stdin"], {
        input: `create ${ref} ${first}\n`,
        stdio: "pipe",
      }));
      const logPath = path.join(repository, ".git", "logs", ref);
      const created = readFileSync(logPath, "utf8");
      assert.match(created, new RegExp(`^${"0".repeat(first.length)} ${first} autosk-flow <autosk@example\\.invalid> 1 \\+0000\\t${message}\\n$`, "u"));
      run(["update-ref", "--stdin"], { input: `verify ${ref} ${first}\n` });
      assert.equal(readFileSync(logPath, "utf8"), created);
      const root = `refs/autosk/epics/${"e".repeat(64)}`;
      const liveOne = `${root}/candidates/${"1".repeat(64)}`;
      const auditOne = `${root}/audit/candidates/${"1".repeat(64)}`;
      const liveTwo = `${root}/candidates/${"2".repeat(64)}`;
      const auditTwo = `${root}/audit/candidates/${"2".repeat(64)}`;
      run(["update-ref", "--create-reflog", "-m", "autosk-flow keepalive 77777777-7777-4777-8777-777777777777", liveOne, first]);
      run(["update-ref", "-m", "autosk-flow publish 11111111-1111-4111-8111-111111111111", "--stdin"], {
        input: `start\nverify ${liveOne} ${first}\nupdate ${ref} ${second} ${first}\nprepare\ncommit\n`,
      });
      assert.equal(readFileSync(logPath, "utf8").split("\n").filter(Boolean).length, 2);
      run(["update-ref", "--create-reflog", "-m", "autosk-flow keepalive 77777777-7777-4777-8777-777777777777", "--stdin"], {
        input: `create ${auditOne} ${first}\n`,
      });
      assert.equal(run(["rev-parse", liveOne]), first);
      run(["update-ref", "-d", liveOne, first]);
      assert.equal(existsSync(path.join(repository, ".git", "logs", liveOne)), false);
      assert.equal(existsSync(path.join(repository, ".git", "logs", auditOne)), true);
      run(["update-ref", "--create-reflog", "-m", "autosk-flow keepalive 88888888-8888-4888-8888-888888888888", liveTwo, first]);
      run(["update-ref", "--stdin"], { input: `verify ${ref} ${second}\n` });
      run(["update-ref", "--create-reflog", "-m", "autosk-flow keepalive 88888888-8888-4888-8888-888888888888", "--stdin"], {
        input: `create ${auditTwo} ${first}\n`,
      });
      assert.equal(run(["rev-parse", liveTwo]), first);
      run(["update-ref", "-d", liveTwo, first]);
      assert.equal(existsSync(path.join(repository, ".git", "logs", liveTwo)), false);
      assert.equal(existsSync(path.join(repository, ".git", "logs", auditTwo)), true);
      run(["update-ref", "-d", auditOne, first]);
      run(["update-ref", "-d", auditTwo, first]);
      assert.equal(existsSync(path.join(repository, ".git", "logs", auditOne)), false);
      assert.equal(existsSync(path.join(repository, ".git", "logs", auditTwo)), false);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  }
});

test("helper actions use workflow operation identity and exact update messages", () => {
  const wire = JSON.parse(readFileSync(
    path.join(path.dirname(OPERATION_SCHEMA_PATH), "ref-custody-helper-wire.example.json"),
    "utf8",
  ));
  const byAction = Object.fromEntries(wire.actions.map((item) => [item.action, item.request]));
  assert.equal(byAction.init.operation_id, "00000000-0000-4000-8000-000000000000");
  assert.equal(byAction.init.expected_update_message, `autosk-flow init ${byAction.init.operation_id}`);
  assert.equal(byAction.create_keepalive.operation_id, "77777777-7777-4777-8777-777777777777");
  assert.equal(byAction.create_keepalive.expected_update_message, `autosk-flow keepalive ${byAction.create_keepalive.operation_id}`);
  assert.equal(byAction.advance_planning.operation_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(byAction.advance_planning.expected_update_message, `autosk-flow publish ${byAction.advance_planning.operation_id}`);
});

test("lost helper transfer reconstructs before the active missing-live guard", () => {
  const plan = fixture()["03-technical-plan.md"];
  for (const step of ["publish_artifact_pass", "publish_planning_invalidation"] ) {
    const recovery = plan.indexOf(`${step} | phase=verified, candidate_keepalive phase=verified, live candidate ref absent, exact audit ref present`);
    const guard = plan.indexOf(`${step} | candidate_keepalive phase=prepared\\|object_written\\|ref_created\\|verified and live ref is absent/moved`);
    assert.ok(recovery >= 0 && recovery < guard, `${step} lost helper response recovery order`);
  }
});

test("object-written keepalive rewrites a GC-pruned snapshot before ref CAS", () => {
  const plan = fixture()["03-technical-plan.md"];
  assert.match(plan, /freeze_artifact \| candidate_keepalive_op phase=object_written and snapshot object absent and keepalive ref absent.*rewrite persisted exact snapshot bytes.*same expected OID.*retain phase=object_written/iu);
});

test("helper journal has valid durable prefix examples", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const schema = JSON.parse(readFileSync(path.join(directory, "ref-custody-helper-wire.schema.json"), "utf8"));
  const prefixes = JSON.parse(readFileSync(path.join(directory, "ref-custody-helper-journal-prefixes.example.json"), "utf8"));
  for (const prefix of prefixes.records) {
    assert.deepEqual(validateJsonSchema(prefix, schema.$defs.journal, schema), []);
    assert.deepEqual(prefix.fsync_order, prefix.phase === "request_committed" ? ["request"] : ["request", "refs"]);
    if (prefix.phase === "refs_committed") assert.notEqual(prefix.response, null);
  }
  const reordered = structuredClone(prefixes.records[1]);
  reordered.fsync_order = ["refs", "request"];
  assert.notDeepEqual(validateJsonSchema(reordered, schema.$defs.journal, schema), []);
  const files = fixture();
  prefixes.records[1].response.ref_observations[0].observed_new_oid = "f".repeat(40);
  files["resources/planning-publication/ref-custody-helper-journal-prefixes.example.json"] =
    JSON.stringify(prefixes, null, 2) + "\n";
  assert.match(validatePlanningRefDesign(files).join("\n"), /journal prefixes/u);
  const crashRelative = "resources/planning-publication/ref-custody-helper-journal-crash.example.json";
  const crash = JSON.parse(fixture()[crashRelative]);
  crash.git_ref_transactions_during_recovery = 1;
  const crashFiles = fixture();
  crashFiles[crashRelative] = JSON.stringify(crash, null, 2) + "\n";
  assert.match(validatePlanningRefDesign(crashFiles).join("\n"), /journal crash/u);
});

test("helper not-applied response is value-bound and maps to recovery parks", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const schema = JSON.parse(readFileSync(path.join(directory, "ref-custody-helper-wire.schema.json"), "utf8"));
  const wire = JSON.parse(readFileSync(path.join(directory, "ref-custody-helper-wire.not-applied.example.json"), "utf8"));
  assert.deepEqual(validateRefCustodyHelperWireExamples(wire, schema), []);
  const failed = wire.actions.find(({ response }) => response.status === "not_applied");
  assert.equal(failed.response.not_applied_reason, "expected_old_mismatch");
  assert.equal(failed.journal.phase, "not_applied");
  assert.deepEqual(failed.journal.fsync_order, ["request", "receipt"]);
  for (const observation of failed.response.ref_observations) {
    assert.equal(observation.observed_new_oid, observation.observed_old_oid);
  }
  for (const observation of failed.response.reflog_observations) {
    assert.equal(observation.outcome, "unchanged");
    assert.equal(observation.after_entry_count, observation.before_entry_count);
    assert.deepEqual(observation.raw_appended_entries_base64, []);
  }
  const sideEffect = structuredClone(wire);
  sideEffect.actions[0].response.ref_observations[0].observed_new_oid = "f".repeat(40);
  assert.match(
    validateRefCustodyHelperWireExamples(sideEffect, schema).join("\n"),
    /not_applied must prove zero/u,
  );
  const schemaSideEffect = structuredClone(wire.actions[0]);
  schemaSideEffect.response.reflog_observations[0].outcome = "appended";
  schemaSideEffect.response.reflog_observations[0].raw_appended_entries_base64 = ["YQo="];
  schemaSideEffect.response.reflog_observations[0].appended_entry_sha256 = [sha256(Buffer.from("a\n"))];
  assert.notDeepEqual(validateJsonSchema(schemaSideEffect, schema.$defs.action_exchange, schema), []);
  const duplicateObservation = structuredClone(wire);
  duplicateObservation.actions[0].response.ref_observations.push({
    ...duplicateObservation.actions[0].response.ref_observations[0],
    observed_old_oid: "e".repeat(40),
    observed_new_oid: "e".repeat(40),
  });
  assert.match(
    validateRefCustodyHelperWireExamples(duplicateObservation, schema).join("\n"),
    /exactly match ref_updates/u,
  );
  const duplicateReflog = structuredClone(wire);
  duplicateReflog.actions[0].response.reflog_observations.push(structuredClone(
    duplicateReflog.actions[0].response.reflog_observations[0],
  ));
  assert.match(validateRefCustodyHelperWireExamples(duplicateReflog, schema).join("\n"), /exactly match ref_updates/u);
  const plan = fixture()["03-technical-plan.md"];
  assert.match(plan, /status=not_applied and reason=expected_old_mismatch.*planning_ref_foreign_movement/isu);
  assert.match(plan, /status=not_applied and reason=packed_refs_drift\\\|authorization_invalid.*planning_ref_capability_missing/isu);
});

test("normative helper receipt preimage includes not-applied reason", () => {
  const contract = fixture()["docs/contracts/epic-planning-ref.md"];
  assert.match(contract, /receipt_hash.*not_applied_reason/isu);
});

test("shape domains use a real NUL separator and wire catalogs are explicitly independent", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const contract = JSON.parse(readFileSync(path.join(directory, "ref-custody-helper-contract.example.json"), "utf8"));
  for (const action of contract.actions) {
    assert.equal(action.request_domain.endsWith("\0"), true);
    assert.equal(action.observation_domain.endsWith("\0"), true);
    assert.equal(action.receipt_domain.endsWith("\0"), true);
  }
  for (const name of [
    "ref-custody-helper-wire.example.json",
    "ref-custody-helper-wire.existing-audit.example.json",
  ]) {
    const wire = JSON.parse(readFileSync(path.join(directory, name), "utf8"));
    assert.equal(wire.composition, "independent_golden_exchanges");
  }
});

test("delete recovery and housekeeping tombstone are closed in prose and Schema", () => {
  const contract = fixture()["docs/contracts/epic-planning-ref.md"];
  assert.match(contract, /delete_expired_audit.*absent audit ref.*absent reflog path.*absent packed-refs/isu);
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const schema = JSON.parse(readFileSync(path.join(directory, "audit-candidate-housekeeping-operation.schema.json"), "utf8"));
  const operation = JSON.parse(readFileSync(path.join(directory, "audit-candidate-housekeeping-operation.example.json"), "utf8"));
  operation.tombstone_receipt.deleted_audit_ref = "refs/heads/main";
  assert.notDeepEqual(validateJsonSchema(operation, schema), []);
});

test("audit expiry has a durable approval and tombstone operation", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const schema = JSON.parse(readFileSync(path.join(directory, "audit-candidate-housekeeping-operation.schema.json"), "utf8"));
  const operation = JSON.parse(readFileSync(path.join(directory, "audit-candidate-housekeeping-operation.example.json"), "utf8"));
  assert.deepEqual(validateAuditHousekeepingOperation(operation, schema), []);
  assert.equal(operation.phase, "tombstone_verified");
  assert.match(operation.operator_approval.digest, /^[0-9a-f]{64}$/u);
  assert.equal(operation.helper_evidence.helper_receipt_hash.length, 64);
  assert.equal(operation.tombstone_receipt.deleted_audit_ref, operation.audit_ref);
  const unapproved = structuredClone(operation);
  unapproved.operator_approval = null;
  assert.notDeepEqual(validateJsonSchema(unapproved, schema), []);
  const forged = structuredClone(operation);
  forged.inventory_digest = "d".repeat(64);
  assert.match(validateAuditHousekeepingOperation(forged, schema).join("\n"), /approval|tombstone/u);
  for (const deletedAt of ["2026-08-31T23:59:59Z", "2026-09-01T00:00:00Z"]) {
    const early = structuredClone(operation);
    early.tombstone_receipt.deleted_at_utc = deletedAt;
    assert.match(validateAuditHousekeepingOperation(early, schema).join("\n"), /tombstone/u);
  }
});

test("custody transfer, closure pack, atomic PASS and rebind contracts are machine closed", () => {
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  for (const stem of ["candidate-audit-transfer-operation", "candidate-closure-pack-operation", "record-pass-prepare-publication", "planning-publication-rebinding", "ref-custody-helper-intents"]) {
    const schema = JSON.parse(readFileSync(path.join(directory, `${stem}.schema.json`), "utf8"));
    const example = JSON.parse(readFileSync(path.join(directory, `${stem}.example.json`), "utf8"));
    assert.deepEqual(validateJsonSchema(example, schema), [], stem);
  }
  const transferSchema = JSON.parse(readFileSync(path.join(directory, "candidate-audit-transfer-operation.schema.json"), "utf8"));
  const transfer = JSON.parse(readFileSync(path.join(directory, "candidate-audit-transfer-operation.example.json"), "utf8"));
  transfer.audit_ref_receipt.planning_verified = false;
  assert.notDeepEqual(validateJsonSchema(transfer, transferSchema), []);
  const mixedTransfer = JSON.parse(readFileSync(path.join(directory, "candidate-audit-transfer-operation.example.json"), "utf8"));
  mixedTransfer.live_delete_receipt.expected_old_oid = "a".repeat(64);
  assert.notDeepEqual(validateJsonSchema(mixedTransfer, transferSchema), []);
  const rebindPath = "resources/planning-publication/planning-publication-rebinding.example.json";
  for (const newVersion of [1, 0]) {
    const files = fixture();
    const rebind = JSON.parse(files[rebindPath]);
    rebind.old_anchor_version = 1;
    rebind.new_anchor_version = newVersion;
    files[rebindPath] = JSON.stringify(rebind, null, 2) + "\n";
    assert.match(validatePlanningRefDesign(files).join("\n"), /anchor versions must increase/u);
  }
  const files = fixture();
  const intentPath = "resources/planning-publication/ref-custody-helper-intents.example.json";
  const intents = JSON.parse(files[intentPath]);
  intents.records[0].request_body_sha256 = "f".repeat(64);
  files[intentPath] = JSON.stringify(intents, null, 2) + "\n";
  assert.match(validatePlanningRefDesign(files).join("\n"), /helper intent/u);
  const duplicateIdentityFiles = fixture();
  const duplicateIdentity = JSON.parse(duplicateIdentityFiles[intentPath]);
  duplicateIdentity.records[1].request_id = duplicateIdentity.records[0].request_id;
  duplicateIdentityFiles[intentPath] = JSON.stringify(duplicateIdentity, null, 2) + "\n";
  assert.match(validatePlanningRefDesign(duplicateIdentityFiles).join("\n"), /semantically unique/u);
  const duplicateRefFiles = fixture();
  const duplicateRef = JSON.parse(duplicateRefFiles[intentPath]);
  duplicateRef.records[2].pre_execution_observation.push({
    ...duplicateRef.records[2].pre_execution_observation[0],
    oid: duplicateRef.records[2].pre_execution_observation[0].oid,
  });
  duplicateRefFiles[intentPath] = JSON.stringify(duplicateRef, null, 2) + "\n";
  assert.match(validatePlanningRefDesign(duplicateRefFiles).join("\n"), /duplicate observation refs/u);
  const intentExample = JSON.parse(readFileSync(path.join(directory, "ref-custody-helper-intents.example.json"), "utf8"));
  const absentWithOid = structuredClone(intentExample);
  const absentRecord = absentWithOid.records.find((record) => record.pre_execution_observation.some((observation) => observation.present));
  absentRecord.pre_execution_observation.find((observation) => observation.present).present = false;
  const absentFiles = fixture();
  absentFiles[intentPath] = JSON.stringify(absentWithOid, null, 2) + "\n";
  assert.match(validatePlanningRefDesign(absentFiles).join("\n"), /present\/oid mismatch/u);
  const presentWithoutOid = structuredClone(intentExample);
  const presentRecord = presentWithoutOid.records.find((record) => record.pre_execution_observation.some((observation) => observation.present));
  const presentObservation = presentRecord.pre_execution_observation.find((observation) => observation.present);
  presentObservation.oid = null;
  const presentFiles = fixture();
  presentFiles[intentPath] = JSON.stringify(presentWithoutOid, null, 2) + "\n";
  assert.match(validatePlanningRefDesign(presentFiles).join("\n"), /present\/oid mismatch/u);
  const apiFiles = fixture();
  const apiPath = "resources/planning-publication/record-pass-prepare-publication.example.json";
  const api = JSON.parse(apiFiles[apiPath]);
  api.request.artifact_kind = "tech_plan";
  apiFiles[apiPath] = JSON.stringify(api, null, 2) + "\n";
  assert.match(validatePlanningRefDesign(apiFiles).join("\n"), /does not match the referenced publication/u);
});

test("transfer recovery, active projection and housekeeping serialization stay connected", () => {
  const files = fixture();
  assert.match(files["02-architecture.md"], /candidate_audit_transfer_op.*audit_transfer_history/isu);
  assert.match(files["03-technical-plan.md"], /candidate_keepalive_operation[\s\S]*operation_id[\s\S]*phase.*verified/isu);
  assert.match(files["03-technical-plan.md"], /under the same helper custody lock.*re-enumerate.*concurrent freeze\/supersession/isu);
});

test("planning receipts bind the exact journaled helper evidence", () => {
  const files = fixture();
  const relative = "resources/planning-publication/publish-artifact-pass-operation.released.example.json";
  const operation = JSON.parse(files[relative]);
  operation.candidate_keepalive.release_receipt.helper_evidence.helper_receipt_hash = "f".repeat(64);
  files[relative] = JSON.stringify(operation, null, 2) + "\n";
  assert.match(validatePlanningRefDesign(files).join("\n"), /helper evidence.*delete_live_ref/u);
  const directory = path.dirname(OPERATION_SCHEMA_PATH);
  const publicationSchema = JSON.parse(readFileSync(OPERATION_SCHEMA_PATH, "utf8"));
  const released = JSON.parse(readFileSync(
    path.join(directory, "publish-artifact-pass-operation.released.example.json"),
    "utf8",
  ));
  released.receipts.ref_cas.helper_evidence = null;
  assert.notDeepEqual(validateJsonSchema(released, publicationSchema), []);
  assert.match(validatePlanningPublicationOperation(released, publicationSchema).join("\n"), /helper_evidence/u);
  const initSchema = JSON.parse(readFileSync(INIT_OPERATION_SCHEMA_PATH, "utf8"));
  const init = JSON.parse(readFileSync(INIT_OPERATION_EXAMPLE_PATH, "utf8"));
  init.receipts.ref_create.helper_evidence = null;
  assert.notDeepEqual(validateJsonSchema(init, initSchema), []);
  assert.match(validatePlanningRefInitOperation(init, initSchema).join("\n"), /helper_evidence/u);
});

test("custody request IDs and nonces cannot be reused for different bodies", () => {
  const files = fixture();
  const main = JSON.parse(files["resources/planning-publication/ref-custody-helper-wire.example.json"]);
  const invalidationPath = "resources/planning-publication/ref-custody-helper-wire.invalidation.example.json";
  const invalidation = JSON.parse(files[invalidationPath]);
  const original = main.actions.find(({ action }) => action === "create_keepalive").request;
  invalidation.actions[0].request.request_id = original.request_id;
  invalidation.actions[0].request.nonce = original.nonce;
  files[invalidationPath] = JSON.stringify(invalidation, null, 2) + "\n";
  assert.match(validatePlanningRefDesign(files).join("\n"), /request_id is reused|nonce is reused/u);
});
