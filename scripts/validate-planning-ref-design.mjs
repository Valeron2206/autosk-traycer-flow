#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OPERATION_SCHEMA_PATH = path.join(
  ROOT,
  "resources/planning-publication/publish-artifact-pass-operation.schema.json",
);
export const OPERATION_EXAMPLE_PATH = path.join(
  ROOT,
  "resources/planning-publication/publish-artifact-pass-operation.example.json",
);

export const CONTRACT_FILES = Object.freeze([
  "README.md",
  "01-core-flows.md",
  "02-architecture.md",
  "03-technical-plan.md",
  "04-decisions.md",
  "CONTRIBUTING.md",
  "docs/contracts/epic-planning-ref.md",
  "resources/planning-publication/publish-artifact-pass-operation.schema.json",
  "resources/planning-publication/publish-artifact-pass-operation.example.json",
]);

const REQUIRED = Object.freeze({
  "README.md": [
    "docs/contracts/epic-planning-ref.md",
    "publish_artifact_pass",
    "refs/autosk/epics/<epic_ref_key>/planning",
  ],
  "01-core-flows.md": [
    "<!-- planning-ref-contract:v1 -->",
    "record_artifact_pass",
    "publish_artifact_pass",
    "planning_ref_foreign_movement",
    "verified planning_head",
  ],
  "02-architecture.md": [
    "<!-- planning-ref-contract:v1 -->",
    "Planning publication adapter",
    "refs/autosk/epics/<epic_ref_key>/planning",
    "planning_publication_op",
  ],
  "03-technical-plan.md": [
    "<!-- planning-ref-contract:v1 -->",
    "init_planning_ref",
    "publish_artifact_pass",
    "publish_planning_invalidation",
    "planning_ref_init_op",
    "ref_created",
    "planning_publication_op",
    "commit_object_bytes_base64",
    "reflog_checkpoint",
    "voided_before_ref",
    "recorded_unpublished",
    "planning_candidate_base_stale",
    "planning_ref_capability_missing",
    "planning_ref_foreign_movement",
    "planning_publication_corrupt",
    "planning_signing_unavailable",
  ],
  "04-decisions.md": [
    "ADR-026: private Epic planning ref и commit-on-PASS",
    "refs/autosk/epics/<epic_ref_key>/planning",
    "publish_artifact_pass",
  ],
  "CONTRIBUTING.md": [
    "docs/contracts/epic-planning-ref.md",
    "npm run validate:planning-ref",
  ],
  "docs/contracts/epic-planning-ref.md": [
    "<!-- planning-ref-contract:v1 -->",
    "planning_ref_init_op",
    "ref_created",
    "prepared",
    "commit_created",
    "ref_advanced",
    "verified",
    "commit_object_bytes_base64",
    "reflog_checkpoint",
    "voided_before_ref",
    "anchor_invalidation",
    "planning_ref_foreign_movement",
    "planning_publication_corrupt",
    "epic_ref_key = SHA-256",
    "recordArtifactPassAndPreparePublication",
    "publish-artifact-pass-operation.schema.json",
    "Issue #6",
    "Issue #7",
    "Issue #8",
    "Issue #9",
  ],
  "resources/planning-publication/publish-artifact-pass-operation.schema.json": [
    "\"additionalProperties\": false",
    "\"epic_ref_key\"",
    "\"project_instruction_digest\"",
    "\"voided_before_ref\"",
    "\"commit_object_bytes_base64\"",
  ],
  "resources/planning-publication/publish-artifact-pass-operation.example.json": [
    "\"operation_type\": \"artifact_pass\"",
    "\"phase\": \"prepared\"",
    "\"epic_ref_key\"",
    "\"project_instruction_digest\": null",
  ],
});

const SHA256_RE = /^[0-9a-f]{64}$/u;
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REF_RE = /^refs\/autosk\/epics\/[0-9a-f]{64}\/planning$/u;

function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function deriveEpicRefKey(projectRootSha256, epicId) {
  return sha256(
    "autosk-flow/epic-ref-key/v1\0" +
    canonicalStringify({ project_root_sha256: projectRootSha256, epic_id: epicId }),
  );
}

export function validatePlanningPublicationOperationExample(example, schema) {
  const errors = [];
  if (!example || typeof example !== "object" || Array.isArray(example)) return ["operation example must be an object"];
  const required = Array.isArray(schema?.required) ? schema.required : [];
  if (!exactKeys(example, required)) errors.push("operation example keys differ from closed Schema");
  for (const key of required) {
    if (!(key in example)) errors.push(`operation example missing required field ${key}`);
  }
  if (!UUID_RE.test(example.operation_id ?? "")) errors.push("operation_id is invalid");
  if (!UUID_RE.test(example.epic_id ?? "")) errors.push("epic_id is invalid");
  for (const key of [
    "project_root_sha256",
    "epic_ref_key",
    "protocol_digest",
    "runtime_lock_digest",
    "governance_mapping_set_digest",
    "commit_recipe_digest",
  ]) {
    if (!SHA256_RE.test(example[key] ?? "")) errors.push(`${key} is invalid`);
  }
  if (example.project_instruction_digest !== null && !SHA256_RE.test(example.project_instruction_digest ?? "")) {
    errors.push("project_instruction_digest is invalid");
  }
  const expectedRefKey = deriveEpicRefKey(example.project_root_sha256, example.epic_id);
  if (example.epic_ref_key !== expectedRefKey) errors.push("epic_ref_key does not match canonical project/Epic identity");
  if (!REF_RE.test(example.planning_ref ?? "") ||
      example.planning_ref !== `refs/autosk/epics/${example.epic_ref_key}/planning`) {
    errors.push("planning_ref is invalid or does not match epic_ref_key");
  }
  const phases = schema?.properties?.phase?.enum ?? [];
  if (!phases.includes(example.phase)) errors.push("phase is outside the closed enum");
  for (const key of ["expected_parent_oid", "expected_parent_tree_oid", "candidate_tree_oid", "expected_commit_oid"]) {
    if (!OID_RE.test(example[key] ?? "")) errors.push(`${key} is invalid`);
  }
  const recipe = example.commit_recipe;
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) {
    errors.push("commit_recipe must be an object");
    return errors;
  }
  const oidLength = recipe.object_format === "sha1" ? 40 : recipe.object_format === "sha256" ? 64 : 0;
  const oidMatchesFormat = (value) => typeof value === "string" && value.length === oidLength && /^[0-9a-f]+$/u.test(value);
  if (!oidLength) errors.push("commit_recipe.object_format is invalid");
  if (!oidMatchesFormat(recipe.tree_oid)) errors.push("commit_recipe.tree_oid does not match object format");
  if (!Array.isArray(recipe.parent_oids) || recipe.parent_oids.length !== 1 || !oidMatchesFormat(recipe.parent_oids[0])) {
    errors.push("commit_recipe.parent_oids must contain one OID matching object format");
  }
  if (recipe.tree_oid !== example.candidate_tree_oid) errors.push("commit_recipe tree differs from candidate_tree_oid");
  if (recipe.parent_oids?.[0] !== example.expected_parent_oid) errors.push("commit_recipe parent differs from expected_parent_oid");
  const recipeDigest = sha256(
    "autosk-flow/planning-commit-recipe/v1\0" + canonicalStringify(recipe),
  );
  if (example.commit_recipe_digest !== recipeDigest) errors.push("commit_recipe_digest mismatch");
  try {
    const commitBytes = Buffer.from(recipe.commit_object_bytes_base64, "base64");
    if (sha256(commitBytes) !== recipe.commit_object_bytes_sha256) {
      errors.push("commit_object_bytes_sha256 mismatch");
    }
    const objectHash = createHash(recipe.object_format)
      .update(Buffer.concat([Buffer.from(`commit ${commitBytes.length}\0`), commitBytes]))
      .digest("hex");
    if (objectHash !== example.expected_commit_oid) errors.push("expected_commit_oid mismatch");
  } catch {
    errors.push("commit object bytes or object format are invalid");
  }
  if (example.reflog_checkpoint?.expected_old_oid !== example.expected_parent_oid ||
      example.reflog_checkpoint?.expected_new_oid !== example.expected_commit_oid) {
    errors.push("reflog checkpoint old/new OIDs do not match operation");
  }
  if (example.operation_type !== example.payload?.kind) errors.push("operation_type and payload.kind mismatch");
  if (schema?.additionalProperties !== false) errors.push("operation Schema must be closed");
  return errors;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function loadPlanningRefFiles(root = ROOT) {
  return Object.fromEntries(
    CONTRACT_FILES.map((relative) => [
      relative,
      readFileSync(path.join(root, relative), "utf8"),
    ]),
  );
}

export function validatePlanningRefDesign(files) {
  const errors = [];
  for (const relative of CONTRACT_FILES) {
    const text = files[relative];
    if (typeof text !== "string") {
      errors.push(`${relative}: missing`);
      continue;
    }
    for (const fragment of REQUIRED[relative]) {
      if (!text.includes(fragment)) errors.push(`${relative}: missing required fragment ${JSON.stringify(fragment)}`);
    }
  }

  const plan = files["03-technical-plan.md"] ?? "";
  for (const line of plan.split("\n")) {
    if (/^\|\s*record_artifact_pass\s*\|/u.test(line.trim()) && /\bselect_next\b/u.test(line)) {
      errors.push("03-technical-plan.md: direct record_artifact_pass → select_next transition remains");
    }
  }

  const core = files["01-core-flows.md"] ?? "";
  const normalizedCore = core.replace(/\s+/gu, " ");
  const normalizedPlan = plan.replace(/\s+/gu, " ");
  if (!normalizedCore.includes("new full panel -> record PASS -> publish planning commit") ||
      !normalizedPlan.includes("freeze_artifact -> dispatch_panel -> panel_join -> synthesize_panel -> record_artifact_pass -> publish_artifact_pass")) {
    errors.push("Arena path must pass through record_artifact_pass and publish_artifact_pass");
  }
  if (!core.includes("recorded PASS не является завершённым артефактом")) {
    errors.push("01-core-flows.md: recorded-vs-published PASS distinction missing");
  }
  for (const [relative, text] of Object.entries(files)) {
    if (/refs\/autosk\/epics\/<(?:epic-uuid|uuid)>\/planning/u.test(text)) {
      errors.push(`${relative}: planning ref still uses display/UUID placeholder instead of epic_ref_key`);
    }
  }

  const contract = files["docs/contracts/epic-planning-ref.md"] ?? "";
  const initPhaseSequence = "prepared\n→ ref_created\n→ verified";
  if (!contract.includes(initPhaseSequence)) {
    errors.push("planning-ref initialization phases are missing or not documented in monotonic order");
  }
  const canonicalPhaseSequence = "prepared\n→ commit_created\n→ ref_advanced\n→ verified";
  if (!contract.includes(canonicalPhaseSequence)) {
    errors.push("planning publication phases are missing or not documented in monotonic order");
  }
  if (!contract.includes("complete canonical `commit_recipe`") || !contract.includes("exact commit object bytes")) {
    errors.push("planning publication recovery must persist the complete exact commit recipe, not only a digest");
  }
  if (!contract.includes("`voided_before_ref` is the only unsuccessful terminal phase")) {
    errors.push("planning publication pre-CAS drift must have a terminal void phase");
  }
  const casSection = contract.split("## 9. CAS and verification")[1]?.split("## 10.")[0] ?? "";
  for (const line of casSection.split("\n").filter((item) => item.trim().startsWith("|"))) {
    let pipes = 0;
    let escaped = false;
    for (const character of line) {
      if (character === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (character === "|" && !escaped) pipes += 1;
      escaped = false;
    }
    if (pipes !== 3) {
      errors.push("CAS recovery table must keep exactly two columns");
      break;
    }
  }

  try {
    const schema = JSON.parse(
      files["resources/planning-publication/publish-artifact-pass-operation.schema.json"],
    );
    const example = JSON.parse(
      files["resources/planning-publication/publish-artifact-pass-operation.example.json"],
    );
    for (const error of validatePlanningPublicationOperationExample(example, schema)) {
      errors.push(`planning publication Schema/example: ${error}`);
    }
  } catch (error) {
    errors.push(`planning publication Schema/example is not valid JSON: ${error.message}`);
  }

  return errors;
}

export function planningRefDesignDigest(files) {
  const payload = CONTRACT_FILES.map((relative) => `${relative}\0${sha256(files[relative] ?? "")}`).join("\0");
  return sha256(`autosk-flow/planning-ref-design/v1\0${payload}`);
}

function run() {
  const files = loadPlanningRefFiles();
  const errors = validatePlanningRefDesign(files);
  if (errors.length) {
    for (const error of errors) console.error(`ERROR: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`OK: planning-ref design contract v1; digest ${planningRefDesignDigest(files)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
