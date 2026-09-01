import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  OPERATION_EXAMPLE_PATH,
  OPERATION_SCHEMA_PATH,
  loadPlanningRefFiles,
  planningObservationDigest,
  planningReceiptHash,
  planningRefDesignDigest,
  validatePlanningPublicationOperation,
  validatePlanningPublicationOperationExample,
  validatePlanningRefDesign,
} from "../scripts/validate-planning-ref-design.mjs";

function fixture() {
  return structuredClone(loadPlanningRefFiles());
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
    "create immutable planning_publication_op phase=prepared with exact recipe/OID; publish_artifact_pass",
    "create immutable planning_publication_op phase=prepared with exact recipe/OID; dispatch_ticket_dag",
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
  const objectWrite = plan.indexOf("phase=prepared and ref=expected parent and reflog prefix=checkpoint");
  const cas = plan.indexOf("phase=commit_created and ref=expected parent and reflog prefix=checkpoint");
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
    .replaceAll("matching planning_publication_op phase=verified", "matching planning_publication_op phase=prepared");
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
    object_oid: "220f8a42d7897c5c45fd8a773966e8c2cde33994",
    object_bytes_sha256: "fffa1a2b18a241c35f468507bf3dca39cd010bc825dcc1b4e479ec68267803a7",
  };
  const observationDigest = planningObservationDigest("commit_object", observation);
  assert.equal(observationDigest, "863bbbe1ea26dbbc3f6d1eb7e837151b3a47c3248f5b9566bb42fe62f79ef319");
  assert.equal(
    planningReceiptHash(
      "11111111-1111-4111-8111-111111111111",
      "commit_object",
      observationDigest,
    ),
    "0900511622fb2ffb35b35f985dae50ef3ca12362d44ef152f72cfaedcd68147e",
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
