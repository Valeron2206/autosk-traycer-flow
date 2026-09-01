import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  OPERATION_EXAMPLE_PATH,
  OPERATION_SCHEMA_PATH,
  loadPlanningRefFiles,
  planningRefDesignDigest,
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
