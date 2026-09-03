#!/usr/bin/env node

import { createHash, createPublicKey, verify } from "node:crypto";
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
export const INVALIDATION_EXAMPLE_PATH = path.join(
  ROOT,
  "resources/planning-publication/publish-planning-invalidation-operation.example.json",
);
export const INIT_OPERATION_SCHEMA_PATH = path.join(
  ROOT,
  "resources/planning-publication/init-planning-ref-operation.schema.json",
);
export const INIT_OPERATION_EXAMPLE_PATH = path.join(
  ROOT,
  "resources/planning-publication/init-planning-ref-operation.example.json",
);
export const CANDIDATE_KEEPALIVE_SCHEMA_PATH = path.join(
  ROOT,
  "resources/planning-publication/candidate-keepalive-operation.schema.json",
);
export const CANDIDATE_KEEPALIVE_EXAMPLE_PATH = path.join(
  ROOT,
  "resources/planning-publication/candidate-keepalive-operation.example.json",
);
export const RELEASED_OPERATION_EXAMPLE_PATH = path.join(
  ROOT,
  "resources/planning-publication/publish-artifact-pass-operation.released.example.json",
);
export const RELEASED_KEEPALIVE_EXAMPLE_PATH = path.join(
  ROOT,
  "resources/planning-publication/candidate-keepalive-operation.released.example.json",
);
export const REF_CUSTODY_CONTRACT_SCHEMA_PATH = path.join(
  ROOT,
  "resources/planning-publication/ref-custody-helper-contract.schema.json",
);
export const REF_CUSTODY_CONTRACT_EXAMPLE_PATH = path.join(
  ROOT,
  "resources/planning-publication/ref-custody-helper-contract.example.json",
);
export const REF_CUSTODY_WIRE_SCHEMA_PATH = path.join(
  ROOT,
  "resources/planning-publication/ref-custody-helper-wire.schema.json",
);
export const REF_CUSTODY_WIRE_EXAMPLE_PATH = path.join(
  ROOT,
  "resources/planning-publication/ref-custody-helper-wire.example.json",
);
export const CANDIDATE_SUPERSESSION_SCHEMA_PATH = path.join(
  ROOT,
  "resources/planning-publication/candidate-supersession-operation.schema.json",
);
export const CANDIDATE_SUPERSESSION_EXAMPLE_PATH = path.join(
  ROOT,
  "resources/planning-publication/candidate-supersession-operation.example.json",
);
export const AUDIT_HOUSEKEEPING_SCHEMA_PATH = path.join(
  ROOT,
  "resources/planning-publication/audit-candidate-housekeeping-operation.schema.json",
);
export const AUDIT_HOUSEKEEPING_EXAMPLE_PATH = path.join(
  ROOT,
  "resources/planning-publication/audit-candidate-housekeeping-operation.example.json",
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
  "resources/planning-publication/publish-planning-invalidation-operation.example.json",
  "resources/planning-publication/init-planning-ref-operation.schema.json",
  "resources/planning-publication/init-planning-ref-operation.example.json",
  "resources/planning-publication/candidate-keepalive-operation.schema.json",
  "resources/planning-publication/candidate-keepalive-operation.example.json",
  "resources/planning-publication/candidate-keepalive-operation.audit-retained.example.json",
  "resources/planning-publication/candidate-keepalive-operation.released.example.json",
  "resources/planning-publication/publish-artifact-pass-operation.released.example.json",
  "resources/planning-publication/publish-artifact-pass-operation.voided.example.json",
  "resources/planning-publication/ref-custody-helper-contract.schema.json",
  "resources/planning-publication/ref-custody-helper-contract.example.json",
  "resources/planning-publication/ref-custody-helper-wire.schema.json",
  "resources/planning-publication/ref-custody-helper-wire.example.json",
  "resources/planning-publication/ref-custody-helper-wire.not-applied.example.json",
  "resources/planning-publication/ref-custody-helper-wire.invalidation.example.json",
  "resources/planning-publication/ref-custody-helper-wire.existing-audit.example.json",
  "resources/planning-publication/ref-custody-helper-journal-prefixes.example.json",
  "resources/planning-publication/ref-custody-helper-journal-crash.example.json",
  "resources/planning-publication/candidate-keepalive-operation.prepared.example.json",
  "resources/planning-publication/candidate-keepalive-operation.ref-created.example.json",
  "resources/planning-publication/candidate-supersession-operation.schema.json",
  "resources/planning-publication/candidate-supersession-operation.example.json",
  "resources/planning-publication/audit-candidate-housekeeping-operation.schema.json",
  "resources/planning-publication/audit-candidate-housekeeping-operation.example.json",
  "resources/planning-publication/candidate-audit-transfer-operation.schema.json",
  "resources/planning-publication/candidate-audit-transfer-operation.example.json",
  "resources/planning-publication/candidate-closure-pack-operation.schema.json",
  "resources/planning-publication/candidate-closure-pack-operation.example.json",
  "resources/planning-publication/candidate-closure-pack-operation.invalidation.example.json",
  "resources/planning-publication/record-pass-prepare-publication.schema.json",
  "resources/planning-publication/record-pass-prepare-publication.example.json",
  "resources/planning-publication/planning-publication-rebinding.schema.json",
  "resources/planning-publication/planning-publication-rebinding.example.json",
  "resources/planning-publication/ref-custody-helper-intents.schema.json",
  "resources/planning-publication/ref-custody-helper-intents.example.json",
  "resources/planning-publication/ref-custody-policy.schema.json",
  "resources/planning-publication/ref-custody-policy.example.json",
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
    "candidate_keepalive",
    "verified planning_head",
  ],
  "02-architecture.md": [
    "<!-- planning-ref-contract:v1 -->",
    "Planning publication adapter",
    "refs/autosk/epics/<epic_ref_key>/planning",
    "planning_publication_op",
    "typed payload",
    "immutable bindings",
    "complete commit_recipe",
    "exact commit bytes",
    "expected commit OID",
    "reflog checkpoint",
    "candidate keepalive",
    "planning.candidate_history",
    "separate-account ref-custody helper",
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
    "candidate_keepalive_op",
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
    "Issue #12",
    "Issue #13",
    "canonical JSON means recursively sorted object keys",
    "autosk-flow/reflog-prefix/v1\\0",
    "autosk-flow/reflog-entry/v1\\0",
    "autosk-flow/planning-observation/v1\\0",
    "autosk-flow/planning-receipt/v1\\0",
    "autosk-flow/planning-commit-recipe/v1\\0",
    "closed v1 bootstrap delivery policy",
    "refs/autosk/epics/<epic_ref_key>/candidates/<candidate_identity>",
  ],
  "resources/planning-publication/publish-artifact-pass-operation.schema.json": [
    "\"additionalProperties\": false",
    "\"epic_ref_key\"",
    "\"project_instruction_digest\"",
    "\"voided_before_ref\"",
    "\"commit_object_bytes_base64\"",
    "\"ref_storage_format\"",
    "\"reflog_producer\"",
    "\"effective_target_step\"",
    "\"candidate_keepalive\"",
    "\"ref_custody_policy_digest\"",
  ],
  "resources/planning-publication/publish-artifact-pass-operation.example.json": [
    "\"operation_type\": \"artifact_pass\"",
    "\"phase\": \"prepared\"",
    "\"epic_ref_key\"",
    "\"project_instruction_digest\": \"9999999999999999999999999999999999999999999999999999999999999999\"",
    "\"recovery_target_step\": null",
    "\"artifact_pathspec\"",
    "\"ref_storage_format\": \"files\"",
    "\"candidate_keepalive\"",
  ],
  "resources/planning-publication/publish-planning-invalidation-operation.example.json": [
    "\"operation_type\": \"anchor_invalidation\"",
    "\"projection_mutations\"",
    "\"recorded_target_step\": \"clarify_alignment\"",
    "\"invalidation_projection_digest\"",
    "\"candidate_keepalive\"",
  ],
  "resources/planning-publication/init-planning-ref-operation.schema.json": [
    "\"operation_type\"",
    "\"planning_ref_init\"",
    "\"selected_base_ref\"",
    "\"bootstrap_policy_digest\"",
    "\"ref_create\"",
    "\"ref_custody_policy_digest\"",
  ],
  "resources/planning-publication/init-planning-ref-operation.example.json": [
    "\"operation_type\": \"planning_ref_init\"",
    "\"selected_base_ref\": \"refs/heads/main\"",
    "\"phase\": \"verified\"",
    "\"ref_storage_format\": \"files\"",
    "\"ref_custody_policy_digest\"",
  ],
  "resources/planning-publication/candidate-keepalive-operation.schema.json": [
    "\"prepared\"",
    "\"object_written\"",
    "\"ref_created\"",
    "\"verified\"",
    "\"audit_retained\"",
    "\"released\"",
    "\"snapshot_commit_recipe\"",
  ],
  "resources/planning-publication/candidate-keepalive-operation.example.json": [
    "\"operation_id\"",
    "\"phase\": \"verified\"",
    "\"create_receipt\"",
    "\"snapshot_commit_recipe\"",
  ],
  "resources/planning-publication/candidate-keepalive-operation.audit-retained.example.json": [
    "\"phase\": \"audit_retained\"",
    "\"terminal_disposition\": \"audit_retained\"",
    "\"audit_receipt\"",
  ],
  "resources/planning-publication/candidate-keepalive-operation.released.example.json": [
    "\"phase\": \"released\"",
    "\"terminal_disposition\": \"published_released\"",
    "\"release_receipt\"",
    "\"audit_receipt\"",
  ],
  "resources/planning-publication/publish-artifact-pass-operation.released.example.json": [
    "\"phase\": \"verified\"",
    "\"candidate_keepalive\"",
    "\"release_receipt\"",
  ],
  "resources/planning-publication/publish-artifact-pass-operation.voided.example.json": [
    "\"phase\": \"voided_before_ref\"",
    "\"phase\": \"audit_retained\"",
    "\"reason\": \"voided_before_ref\"",
  ],
  "resources/planning-publication/ref-custody-helper-contract.schema.json": [
    "\"action_contract\"",
    "\"request_required\"",
    "\"response_required\"",
    "\"golden\"",
  ],
  "resources/planning-publication/ref-custody-helper-contract.example.json": [
    "\"action\": \"init\"",
    "\"action\": \"create_keepalive\"",
    "\"action\": \"advance_planning\"",
    "\"action\": \"ensure_audit_ref\"",
    "\"action\": \"delete_live_ref\"",
    "\"action\": \"delete_expired_audit\"",
  ],
  "resources/planning-publication/ref-custody-helper-wire.schema.json": [
    "\"authorization\"",
    "\"ref_observations\"",
    "\"transaction_value_observation_sha256\"",
    "\"journal\"",
  ],
  "resources/planning-publication/ref-custody-helper-wire.example.json": [
    "\"scheme\": \"ed25519\"",
    "\"phase\": \"receipt_committed\"",
    "\"fsync_order\"",
    "\"transaction_value_observation_sha256\"",
  ],
  "resources/planning-publication/ref-custody-helper-wire.not-applied.example.json": [
    "\"status\": \"not_applied\"",
    "\"not_applied_reason\": \"expected_old_mismatch\"",
    "\"phase\": \"not_applied\"",
  ],
  "resources/planning-publication/ref-custody-helper-wire.invalidation.example.json": [
    "\"action\": \"create_keepalive\"",
    "\"operation_id\": \"88888888-8888-4888-8888-888888888888\"",
    "\"candidate_identity\": \"b750e173c96621f0762b800c9c87c0bb71bb6a820f978486dbab3221860e66f0\"",
  ],
  "resources/planning-publication/ref-custody-helper-wire.existing-audit.example.json": [
    "\"action\": \"ensure_audit_ref\"",
    "\"action\": \"delete_live_ref\"",
    "\"operation\": \"verify\"",
  ],
  "resources/planning-publication/ref-custody-helper-journal-prefixes.example.json": [
    "\"phase\": \"request_committed\"",
    "\"phase\": \"refs_committed\"",
    "\"fsync_order\"",
  ],
  "resources/planning-publication/ref-custody-helper-journal-crash.example.json": [
    "\"scenario\": \"git_committed_before_refs_journal\"",
    "\"recovery_decision\": \"persist_refs_committed_without_git_write\"",
    "\"git_ref_transactions_during_recovery\": 0",
  ],
  "resources/planning-publication/candidate-keepalive-operation.prepared.example.json": [
    "\"phase\": \"prepared\"",
    "\"snapshot_object_receipt\": null",
    "\"create_receipt\": null",
  ],
  "resources/planning-publication/candidate-keepalive-operation.ref-created.example.json": [
    "\"phase\": \"ref_created\"",
    "\"snapshot_object_receipt\"",
    "\"create_receipt\"",
  ],
  "resources/planning-publication/candidate-supersession-operation.schema.json": [
    "\"prepared\"",
    "\"audit_transferred\"",
    "\"archived\"",
  ],
  "resources/planning-publication/candidate-supersession-operation.example.json": [
    "\"phase\": \"archived\"",
    "\"reason\": \"superseded\"",
    "\"audit_receipt\"",
  ],
  "resources/planning-publication/audit-candidate-housekeeping-operation.schema.json": [
    "\"prepared\"",
    "\"ref_deleted\"",
    "\"tombstone_verified\"",
  ],
  "resources/planning-publication/audit-candidate-housekeeping-operation.example.json": [
    "\"phase\": \"tombstone_verified\"",
    "\"operator_approval\"",
    "\"tombstone_receipt\"",
  ],
  "resources/planning-publication/candidate-audit-transfer-operation.schema.json": ["\"audit_ref_verified\"", "\"live_ref_deleted\"", "\"verified\""],
  "resources/planning-publication/candidate-audit-transfer-operation.example.json": ["\"phase\": \"verified\"", "\"live_ref_still_present\": true"],
  "resources/planning-publication/candidate-closure-pack-operation.schema.json": ["\"pack_written\"", "\"protected_store_identity\""],
  "resources/planning-publication/candidate-closure-pack-operation.example.json": ["\"phase\": \"verified\"", "\"object_count\": 3"],
  "resources/planning-publication/candidate-closure-pack-operation.invalidation.example.json": ["\"phase\": \"verified\"", "\"candidate_identity\": \"b750e173"],
  "resources/planning-publication/record-pass-prepare-publication.schema.json": ["autosk.record-pass-prepare-publication", "Valeron2206/autosk-traycer-flow#5"],
  "resources/planning-publication/record-pass-prepare-publication.example.json": ["\"status\": \"committed\"", "\"helper_intent_keys\""],
  "resources/planning-publication/planning-publication-rebinding.schema.json": ["\"old_anchor_version\"", "\"new_anchor_version\""],
  "resources/planning-publication/planning-publication-rebinding.example.json": ["\"artifact_kind\": \"brief\"", "\"new_anchor_version\": 2"],
  "resources/planning-publication/ref-custody-helper-intents.schema.json": ["\"precondition_committed\"", "\"pre_execution_observation\""],
  "resources/planning-publication/ref-custody-helper-intents.example.json": ["\"records\"", "\"persist_receipt_hash\""],
  "resources/planning-publication/ref-custody-policy.schema.json": ["\"supported_platforms\"", "\"SO_PEERCRED\"", "\"getpeereid\"", "\"rollback_requires_no_open_operation\""],
  "resources/planning-publication/ref-custody-policy.example.json": ["\"service_manager\": \"systemd\"", "\"service_manager\": \"launchd\"", "\"path_role\": \"project-common-git-dir\"", "\"policy_digest\""],
});

const SHA256_RE = /^[0-9a-f]{64}$/u;
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REF_RE = /^refs\/autosk\/epics\/[0-9a-f]{64}\/planning$/u;

export function codePointCompare(left, right) {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const difference = leftPoints[index].codePointAt(0) - rightPoints[index].codePointAt(0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

export function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(codePointCompare).map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(codePointCompare);
  const wanted = [...expected].sort(codePointCompare);
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function splitMarkdownRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  const cells = [];
  let cell = "";
  let escaped = false;
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const character = trimmed[index];
    if (escaped) {
      cell += `\\${character}`;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  if (escaped) cell += "\\";
  cells.push(cell.trim());
  return cells;
}

function schemaTypeMatches(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function resolveSchemaRef(rootSchema, reference) {
  if (!reference.startsWith("#/")) throw new Error(`unsupported Schema reference ${reference}`);
  return reference
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, key) => value?.[key], rootSchema);
}

export function validateJsonSchema(value, schema, rootSchema = schema, instancePath = "$") {
  const errors = [];
  if (!schema || typeof schema !== "object") return [`${instancePath}: invalid Schema node`];
  if (schema.$ref) {
    try {
      return validateJsonSchema(value, resolveSchemaRef(rootSchema, schema.$ref), rootSchema, instancePath);
    } catch (error) {
      return [`${instancePath}: ${error.message}`];
    }
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => schemaTypeMatches(value, type))) {
      return [`${instancePath} must have type ${types.join("|")}`];
    }
  }
  if (schema.const !== undefined && canonicalStringify(value) !== canonicalStringify(schema.const)) {
    errors.push(`${instancePath} must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) &&
      !schema.enum.some((item) => canonicalStringify(item) === canonicalStringify(value))) {
    errors.push(`${instancePath} is outside enum`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && Array.from(value).length < schema.minLength) {
      errors.push(`${instancePath} must contain at least ${schema.minLength} characters`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${instancePath} does not match pattern`);
    }
    if (schema.format !== undefined) {
      if (schema.format !== "date-time") {
        errors.push(`${instancePath} uses unsupported Schema format ${schema.format}`);
      } else {
        const parsed = new Date(value);
        const canonical = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value) &&
          !Number.isNaN(parsed.valueOf()) &&
          parsed.toISOString() === value.replace(/Z$/u, ".000Z");
        if (!canonical) errors.push(`${instancePath} must be a valid date-time`);
      }
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${instancePath} is below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${instancePath} is above maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${instancePath} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${instancePath} has too many items`);
    if (schema.uniqueItems) {
      const encoded = value.map(canonicalStringify);
      if (new Set(encoded).size !== encoded.length) errors.push(`${instancePath} items must be unique`);
    }
    if (schema.items) {
      value.forEach((item, index) => errors.push(
        ...validateJsonSchema(item, schema.items, rootSchema, `${instancePath}[${index}]`),
      ));
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${instancePath}.${key} is required`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) {
        errors.push(...validateJsonSchema(item, schema.properties[key], rootSchema, `${instancePath}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${instancePath}.${key} is not allowed`);
      }
    }
  }
  for (const branch of schema.allOf ?? []) {
    errors.push(...validateJsonSchema(value, branch, rootSchema, instancePath));
  }
  if (Array.isArray(schema.oneOf)) {
    const branchErrors = schema.oneOf.map((branch) => validateJsonSchema(value, branch, rootSchema, instancePath));
    if (branchErrors.filter((items) => items.length === 0).length !== 1) {
      errors.push(`${instancePath} must match exactly one Schema branch`);
      errors.push(...branchErrors.flat());
    }
  }
  if (schema.if) {
    const conditionMatches = validateJsonSchema(value, schema.if, rootSchema, instancePath).length === 0;
    if (conditionMatches && schema.then) {
      errors.push(...validateJsonSchema(value, schema.then, rootSchema, instancePath));
    } else if (!conditionMatches && schema.else) {
      errors.push(...validateJsonSchema(value, schema.else, rootSchema, instancePath));
    }
  }
  return errors;
}

function deriveEpicRefKey(projectRootSha256, epicId) {
  return sha256(
    "autosk-flow/epic-ref-key/v1\0" +
    canonicalStringify({ project_root_sha256: projectRootSha256, epic_id: epicId }),
  );
}

export function reflogPrefixDigest(entryCount, prefixBytes) {
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(entryCount));
  return sha256(Buffer.concat([
    Buffer.from("autosk-flow/reflog-prefix/v1\0", "utf8"),
    count,
    prefixBytes,
  ]));
}

export function planningReflogEntryDigest(operation) {
  const producer = operation.reflog_producer;
  if (!producer || typeof producer.git_committer_date !== "string" || !operation.reflog_checkpoint) return "";
  const [timestampSeconds, timezone] = producer.git_committer_date.slice(1).split(" ");
  const checkpoint = operation.reflog_checkpoint;
  const entry = Buffer.from(
    `${checkpoint.expected_old_oid} ${checkpoint.expected_new_oid} ` +
    `${producer.git_committer_name} <${producer.git_committer_email}> ${timestampSeconds} ${timezone}\t` +
    `${checkpoint.expected_update_message}\n`,
    "utf8",
  );
  return sha256(Buffer.concat([
    Buffer.from("autosk-flow/reflog-entry/v1\0", "utf8"),
    entry,
  ]));
}

export function planningObservationDigest(receiptKind, observation) {
  return sha256(
    `autosk-flow/planning-observation/v1\0${receiptKind}\0${canonicalStringify(observation)}`,
  );
}

export function planningReceiptHash(operationId, receiptKind, observationSha256, helperEvidence = null) {
  const preimage = {
    schema: 1,
    operation_id: operationId,
    receipt_kind: receiptKind,
    observation_sha256: observationSha256,
  };
  if (helperEvidence !== null) preimage.helper_evidence = helperEvidence;
  return sha256(
    "autosk-flow/planning-receipt/v1\0" + canonicalStringify(preimage),
  );
}

export function artifactPathspecDigest(artifactKind, pathspec) {
  return sha256(
    "autosk-flow/artifact-pathspec/v1\0" + canonicalStringify({
      artifact_kind: artifactKind,
      pathspec,
    }),
  );
}

export function invalidationProjectionDigest(affectedArtifactKinds, projectionMutations) {
  return sha256(
    "autosk-flow/invalidation-projection/v1\0" + canonicalStringify({
      affected_artifact_kinds: affectedArtifactKinds,
      projection_mutations: projectionMutations,
    }),
  );
}

export function previousProjectionDigest(expectedParentTreeOid, mutation) {
  return sha256(
    "autosk-flow/previous-projection/v1\0" + canonicalStringify({
      artifact_kind: mutation.artifact_kind,
      expected_parent_tree_oid: expectedParentTreeOid,
      pathspec: mutation.pathspec,
      pathspec_digest: mutation.pathspec_digest,
    }),
  );
}

export function verdictOrWaiverDigest(payload) {
  const binding = payload.verdict_or_waiver_binding ?? {};
  return sha256(
    "autosk-flow/verdict-or-waiver/v1\0" + canonicalStringify({
      artifact_identity: payload.artifact_identity,
      artifact_kind: payload.artifact_kind,
      disposition: binding.disposition,
      record: binding.record,
    }),
  );
}

export function planningCandidateIdentity(operation) {
  const payloadDigest = operation.payload?.kind === "anchor_invalidation"
    ? operation.payload.invalidation_projection_digest
    : operation.payload?.artifact_pathspec_digest;
  return sha256(
    "autosk-flow/planning-candidate/v1\0" + canonicalStringify({
      anchor_version: operation.anchor_version,
      candidate_tree_oid: operation.candidate_tree_oid,
      epic_id: operation.epic_id,
      kind: operation.payload?.kind,
      pathspec_or_projection_digest: payloadDigest,
      project_root_sha256: operation.project_root_sha256,
      snapshot_commit_oid: operation.candidate_keepalive?.snapshot_commit_oid,
    }),
  );
}

export function candidateKeepaliveReflogEntryDigest(operation) {
  const keepalive = operation.candidate_keepalive;
  const producer = keepalive?.reflog_producer;
  if (!producer || typeof producer.git_committer_date !== "string") return "";
  const [timestampSeconds, timezone] = producer.git_committer_date.slice(1).split(" ");
  const zeroOid = "0".repeat(keepalive.object_format === "sha256" ? 64 : 40);
  const entry = Buffer.from(
    `${zeroOid} ${keepalive.snapshot_commit_oid} ` +
    `${producer.git_committer_name} <${producer.git_committer_email}> ${timestampSeconds} ${timezone}\t` +
    `${keepalive.expected_update_message}\n`,
    "utf8",
  );
  return sha256(Buffer.concat([
    Buffer.from("autosk-flow/reflog-entry/v1\0", "utf8"),
    entry,
  ]));
}

export function candidateKeepaliveCreateReceiptHash(candidateIdentity, operationId, observationSha256) {
  return sha256(
    "autosk-flow/candidate-keepalive-receipt/v1\0" + canonicalStringify({
      candidate_identity: candidateIdentity,
      operation_id: operationId,
      observation_sha256: observationSha256,
    }),
  );
}

export function candidateSnapshotObjectReceiptHash(receipt) {
  const { receipt_hash: ignored, ...preimage } = receipt;
  return sha256(
    "autosk-flow/candidate-snapshot-object/v1\0" + canonicalStringify(preimage),
  );
}

export function planningReleaseTailObservationDigest(operation) {
  return sha256(
    "autosk-flow/candidate-keepalive-release-tail/v1\0" + canonicalStringify({
      after_entry_count: (operation.reflog_checkpoint?.before_entry_count ?? -1) + 1,
      appended_entry_sha256: planningReflogEntryDigest(operation),
      before_prefix_sha256: operation.reflog_checkpoint?.before_prefix_sha256,
      planning_reflog_after_receipt_hash: operation.receipts?.reflog_after?.receipt_hash,
    }),
  );
}

export function candidateKeepaliveReleaseTransactionDigest(operation, tailObservationSha256) {
  const auditCandidateRef =
    `refs/autosk/epics/${operation.epic_ref_key}/audit/candidates/` +
    operation.candidate_keepalive?.candidate_identity;
  return sha256(
    "autosk-flow/candidate-keepalive-release-transaction/v1\0" + canonicalStringify({
      audit_candidate_oid: operation.candidate_keepalive?.snapshot_commit_oid,
      audit_candidate_ref: auditCandidateRef,
      candidate_keepalive_oid: operation.candidate_keepalive?.snapshot_commit_oid,
      candidate_keepalive_ref: operation.candidate_keepalive?.ref,
      planning_ref: operation.planning_ref,
      planning_ref_expected_oid: operation.expected_commit_oid,
      planning_reflog_tail_observation_sha256: tailObservationSha256,
      ref_custody_generation: operation.ref_custody_generation,
      ref_custody_policy_digest: operation.ref_custody_policy_digest,
    }),
  );
}

export function candidateKeepaliveReleaseReceiptHash(receipt) {
  const { receipt_hash: ignored, ...preimage } = receipt;
  return sha256(
    "autosk-flow/candidate-keepalive-release/v1\0" + canonicalStringify(preimage),
  );
}

export function candidateKeepaliveAuditReceiptHash(receipt) {
  const { receipt_hash: ignored, ...preimage } = receipt;
  return sha256(
    "autosk-flow/candidate-keepalive-audit/v1\0" + canonicalStringify(preimage),
  );
}

export function candidateKeepaliveAuditObservationDigest(receipt) {
  return sha256(
    "autosk-flow/candidate-keepalive-audit-observation/v1\0" + canonicalStringify({
      audit_ref: receipt.audit_ref,
      candidate_identity: receipt.candidate_identity,
      live_ref: receipt.live_ref,
      operation_id: receipt.operation_id,
      reason: receipt.reason,
      ref_custody_generation: receipt.ref_custody_generation,
      ref_custody_policy_digest: receipt.ref_custody_policy_digest,
      snapshot_commit_oid: receipt.snapshot_commit_oid,
    }),
  );
}

function decodeBase64Exact(value, label, errors) {
  if (typeof value !== "string") {
    errors.push(`${label} must be base64 text`);
    return Buffer.alloc(0);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) errors.push(`${label} is not canonical base64`);
  return decoded;
}

export function isCanonicalGpgsigHeader(signatureBytes) {
  if (!Buffer.isBuffer(signatureBytes)) return false;
  const text = signatureBytes.toString("utf8");
  if (!text.endsWith("\n") || text.includes("\r") || text.includes("\n\n")) return false;
  const lines = text.slice(0, -1).split("\n");
  if (lines.length < 1 || !/^gpgsig [^\n]+$/u.test(lines[0])) return false;
  return lines.slice(1).every((line) => /^ [^\n]*$/u.test(line));
}

function expectedPublicationMessage(example) {
  const payload = example.payload ?? {};
  const identityName = payload.kind === "anchor_invalidation"
    ? "Autosk-Impact-Identity"
    : "Autosk-Artifact-Identity";
  const identityValue = payload.kind === "anchor_invalidation"
    ? payload.invalidation_projection_digest
    : payload.artifact_identity;
  const dispositionName = payload.kind === "anchor_invalidation"
    ? "Autosk-Impact-Digest"
    : "Autosk-Verdict-Or-Waiver-Digest";
  const dispositionValue = payload.kind === "anchor_invalidation"
    ? payload.approved_impact_record_hash
    : payload.verdict_or_waiver_digest;
  const trailers = [
    ["Autosk-Anchor-Version", String(example.anchor_version)],
    [identityName, identityValue],
    ["Autosk-Epic-ID", example.epic_id],
    ["Autosk-Operation-ID", example.operation_id],
    ["Autosk-Payload-Kind", payload.kind],
    ["Autosk-Project-Instruction-Digest", example.project_instruction_digest],
    ["Autosk-Project-Root-SHA256", example.project_root_sha256],
    ["Autosk-Protocol-Digest", example.protocol_digest],
    ["Autosk-Runtime-Lock-Digest", example.runtime_lock_digest],
    [dispositionName, dispositionValue],
  ].sort(([left], [right]) => codePointCompare(left, right));
  return `autosk-flow planning publication\n\n${trailers.map(([key, value]) => `${key}: ${value}`).join("\n")}\n`;
}

export function validatePlanningPublicationOperation(example, schema) {
  const errors = [];
  if (!example || typeof example !== "object" || Array.isArray(example)) return ["operation example must be an object"];
  for (const error of validateJsonSchema(example, schema, schema, "operation")) {
    errors.push(`Schema: ${error}`);
  }
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
    "ref_custody_policy_digest",
    "commit_recipe_digest",
  ]) {
    if (!SHA256_RE.test(example[key] ?? "")) errors.push(`${key} is invalid`);
  }
  if (!SHA256_RE.test(example.project_instruction_digest ?? "")) {
    errors.push("project_instruction_digest is invalid");
  }
  if (!Number.isInteger(example.ref_custody_generation) || example.ref_custody_generation < 1) {
    errors.push("ref_custody_generation is invalid");
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
  for (const key of ["expected_parent_oid", "expected_parent_tree_oid", "candidate_tree_oid", "expected_commit_oid"]) {
    if (!oidMatchesFormat(example[key])) errors.push(`${key} does not match object format`);
  }
  if (!oidMatchesFormat(recipe.tree_oid)) errors.push("commit_recipe.tree_oid does not match object format");
  if (!Array.isArray(recipe.parent_oids) || recipe.parent_oids.length !== 1 || !oidMatchesFormat(recipe.parent_oids[0])) {
    errors.push("commit_recipe.parent_oids must contain one OID matching object format");
  }
  if (recipe.tree_oid !== example.candidate_tree_oid) errors.push("commit_recipe tree differs from candidate_tree_oid");
  if (recipe.parent_oids?.[0] !== example.expected_parent_oid) errors.push("commit_recipe parent differs from expected_parent_oid");
  if (example.ref_storage_format !== "files") errors.push("ref_storage_format must be files for raw reflog v1");
  const keepalive = example.candidate_keepalive ?? {};
  const expectedCandidateIdentity = planningCandidateIdentity(example);
  const expectedCandidatePreimage = {
    anchor_version: example.anchor_version,
    candidate_tree_oid: example.candidate_tree_oid,
    epic_id: example.epic_id,
    kind: example.payload?.kind,
    pathspec_or_projection_digest: example.payload?.kind === "anchor_invalidation"
      ? example.payload.invalidation_projection_digest
      : example.payload?.artifact_pathspec_digest,
    project_root_sha256: example.project_root_sha256,
    snapshot_commit_oid: keepalive.snapshot_commit_oid,
  };
  const expectedKeepaliveRef = `refs/autosk/epics/${example.epic_ref_key}/candidates/${expectedCandidateIdentity}`;
  const expectedKeepaliveAuditRef =
    `refs/autosk/epics/${example.epic_ref_key}/audit/candidates/${expectedCandidateIdentity}`;
  if (keepalive.candidate_identity !== expectedCandidateIdentity || keepalive.ref !== expectedKeepaliveRef) {
    errors.push("candidate_keepalive identity/ref mismatch");
  }
  if (canonicalStringify(keepalive.candidate_identity_preimage) !== canonicalStringify(expectedCandidatePreimage)) {
    errors.push("candidate_keepalive candidate_identity preimage mismatch");
  }
  if (keepalive.project_root_sha256 !== example.project_root_sha256 ||
      keepalive.epic_id !== example.epic_id || keepalive.epic_ref_key !== example.epic_ref_key ||
      keepalive.audit_ref !== expectedKeepaliveAuditRef) {
    errors.push("candidate_keepalive authoritative record binding mismatch");
  }
  if (Date.parse(keepalive.created_at_utc) > Date.parse(example.created_at_utc)) {
    errors.push("candidate_keepalive created_at_utc must not be later than publication created_at_utc");
  }
  errors.push(...validateSnapshotCommitRecipe(keepalive));
  const snapshotObject = keepalive.snapshot_object_receipt;
  if (!snapshotObject || snapshotObject.operation_id !== keepalive.operation_id ||
      snapshotObject.object_format !== keepalive.object_format ||
      snapshotObject.object_oid !== keepalive.snapshot_commit_oid ||
      snapshotObject.object_bytes_sha256 !== keepalive.snapshot_commit_recipe?.commit_object_bytes_sha256 ||
      snapshotObject.tree_oid !== keepalive.snapshot_tree_oid ||
      snapshotObject.parent_oid !== keepalive.snapshot_commit_recipe?.parent_oids?.[0] ||
      snapshotObject.receipt_hash !== candidateSnapshotObjectReceiptHash(snapshotObject)) {
    errors.push("candidate_keepalive snapshot object receipt mismatch");
  }
  if (keepalive.object_format !== recipe.object_format ||
      keepalive.snapshot_tree_oid !== example.candidate_tree_oid ||
      keepalive.snapshot_commit_recipe?.parent_oids?.[0] !== example.expected_parent_oid) {
    errors.push("candidate_keepalive object format or tree mismatch");
  }
  if (keepalive.ref_custody_generation !== example.ref_custody_generation ||
      keepalive.ref_custody_policy_digest !== example.ref_custody_policy_digest) {
    errors.push("candidate_keepalive ref custody binding mismatch");
  }
  if (keepalive.expected_update_message !== `autosk-flow keepalive ${keepalive.operation_id}`) {
    errors.push("candidate_keepalive expected_update_message mismatch");
  }
  if (keepalive.reflog_producer?.git_committer_name !== "autosk-flow" ||
      keepalive.reflog_producer?.git_committer_email !== "autosk@example.invalid" ||
      !/^@[0-9]+ \+0000$/u.test(keepalive.reflog_producer?.git_committer_date ?? "")) {
    errors.push("candidate_keepalive reflog producer differs from locked host identity");
  }
  const createReceipt = keepalive.create_receipt ?? {};
  const zeroOid = "0".repeat(recipe.object_format === "sha256" ? 64 : 40);
  const createObservation = {
    after_entry_count: 1,
    appended_entry_sha256: candidateKeepaliveReflogEntryDigest(example),
    before_entry_count: 0,
    before_prefix_sha256: reflogPrefixDigest(0, Buffer.alloc(0)),
    candidate_identity: expectedCandidateIdentity,
    expected_update_message: keepalive.expected_update_message,
    observed_new_oid: keepalive.snapshot_commit_oid,
    observed_old_oid: null,
    operation_id: keepalive.operation_id,
    ref: expectedKeepaliveRef,
    snapshot_tree_oid: example.candidate_tree_oid,
  };
  const createObservationSha256 = sha256(
    "autosk-flow/candidate-keepalive-create/v1\0" + canonicalStringify(createObservation),
  );
  for (const [key, value] of Object.entries(createObservation)) {
    if (canonicalStringify(createReceipt[key]) !== canonicalStringify(value)) {
      errors.push(`candidate_keepalive create_receipt.${key} mismatch`);
    }
  }
  if (createReceipt.observation_sha256 !== createObservationSha256 ||
      createReceipt.receipt_hash !==
        candidateKeepaliveCreateReceiptHash(
          expectedCandidateIdentity,
          keepalive.operation_id,
          createObservationSha256,
        )) {
    errors.push("candidate_keepalive create receipt digest mismatch");
  }
  if (keepalive.phase === "verified" && keepalive.release_receipt !== null) {
    errors.push("candidate_keepalive verified phase cannot have a release receipt");
  }
  if (keepalive.phase === "verified" &&
      (keepalive.terminal_disposition !== null || keepalive.audit_receipt !== null)) {
    errors.push("candidate_keepalive verified phase cannot have terminal audit state");
  }
  if (keepalive.phase === "released") {
    const release = keepalive.release_receipt;
    const audit = keepalive.audit_receipt;
    const expectedAuditRef =
      `refs/autosk/epics/${example.epic_ref_key}/audit/candidates/${expectedCandidateIdentity}`;
    const tailObservationSha256 = planningReleaseTailObservationDigest(example);
    const transactionObservationSha256 = candidateKeepaliveReleaseTransactionDigest(
      example,
      tailObservationSha256,
    );
    if (example.phase !== "verified" || !release ||
        release.operation_id !== keepalive.operation_id ||
        release.candidate_identity !== expectedCandidateIdentity ||
        release.ref !== expectedKeepaliveRef ||
        release.expected_old_oid !== keepalive.snapshot_commit_oid ||
        release.planning_ref !== example.planning_ref ||
        release.verified_commit_oid !== example.expected_commit_oid ||
        release.planning_reflog_after_receipt_hash !== example.receipts?.reflog_after?.receipt_hash ||
        release.planning_reflog_tail_observation_sha256 !== tailObservationSha256 ||
        release.transaction_observation_sha256 !== transactionObservationSha256 ||
        release.audit_candidate_ref !== expectedAuditRef ||
        release.audit_candidate_oid !== keepalive.snapshot_commit_oid ||
        release.ref_custody_generation !== example.ref_custody_generation ||
        release.ref_custody_policy_digest !== example.ref_custody_policy_digest ||
        release.closure_verified !== true ||
        release.receipt_hash !== candidateKeepaliveReleaseReceiptHash(release)) {
      errors.push("candidate_keepalive release receipt mismatch");
    }
    if (keepalive.terminal_disposition !== "published_released" || !audit ||
        audit.operation_id !== keepalive.operation_id ||
        audit.candidate_identity !== expectedCandidateIdentity ||
        audit.live_ref !== expectedKeepaliveRef || audit.audit_ref !== expectedAuditRef ||
        audit.snapshot_commit_oid !== keepalive.snapshot_commit_oid ||
        audit.reason !== "publication_verified" ||
        audit.ref_custody_generation !== example.ref_custody_generation ||
        audit.ref_custody_policy_digest !== example.ref_custody_policy_digest ||
        audit.observation_sha256 !== candidateKeepaliveAuditObservationDigest(audit) ||
        audit.receipt_hash !== candidateKeepaliveAuditReceiptHash(audit)) {
      errors.push("candidate_keepalive released audit receipt mismatch");
    }
  } else if (keepalive.phase === "audit_retained") {
    if (example.phase !== "voided_before_ref" || keepalive.terminal_disposition !== "audit_retained" ||
        !keepalive.audit_receipt || keepalive.audit_receipt.reason !== "voided_before_ref" ||
        keepalive.release_receipt !== null) {
      errors.push("candidate_keepalive voided audit-retained state mismatch");
    }
  } else if (example.phase !== "verified" && keepalive.phase !== "verified") {
    errors.push("candidate_keepalive must remain verified before publication verification");
  }
  const expectedProducer = {
    git_committer_name: recipe.committer?.name_utf8,
    git_committer_email: recipe.committer?.email_ascii,
    git_committer_date: `@${recipe.committer?.timestamp_seconds} ${recipe.committer?.timezone}`,
  };
  for (const [key, value] of Object.entries(expectedProducer)) {
    if (example.reflog_producer?.[key] !== value) {
      errors.push(`reflog_producer.${key} does not match persisted committer`);
    }
  }
  const recipeDigest = sha256(
    "autosk-flow/planning-commit-recipe/v1\0" + canonicalStringify(recipe),
  );
  if (example.commit_recipe_digest !== recipeDigest) errors.push("commit_recipe_digest mismatch");
  try {
    const messageBytes = decodeBase64Exact(recipe.message_utf8_base64, "message_utf8_base64", errors);
    const expectedMessage = Buffer.from(expectedPublicationMessage(example), "utf8");
    if (!messageBytes.equals(expectedMessage)) errors.push("commit message differs from closed structured trailers");
    let signatureBytes = Buffer.alloc(0);
    if (recipe.signing?.mode === "exact") {
      signatureBytes = decodeBase64Exact(
        recipe.signing.signature_header_base64,
        "signature_header_base64",
        errors,
      );
      if (!isCanonicalGpgsigHeader(signatureBytes)) {
        errors.push("signature_header_base64 must encode one canonical gpgsig header with only space-prefixed continuations");
      }
    }
    const headerBytes = Buffer.from(
      `tree ${recipe.tree_oid}\n` +
      `parent ${recipe.parent_oids[0]}\n` +
      `author ${recipe.author.name_utf8} <${recipe.author.email_ascii}> ${recipe.author.timestamp_seconds} ${recipe.author.timezone}\n` +
      `committer ${recipe.committer.name_utf8} <${recipe.committer.email_ascii}> ${recipe.committer.timestamp_seconds} ${recipe.committer.timezone}\n`,
      "utf8",
    );
    const expectedCommitBytes = Buffer.concat([headerBytes, signatureBytes, Buffer.from("\n"), messageBytes]);
    const commitBytes = decodeBase64Exact(recipe.commit_object_bytes_base64, "commit_object_bytes_base64", errors);
    if (!commitBytes.equals(expectedCommitBytes)) {
      errors.push("commit object bytes differ from structured recipe");
    }
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
  if (example.reflog_checkpoint?.expected_update_message !==
      `autosk-flow publish ${example.operation_id}`) {
    errors.push("expected_update_message does not match containing operation_id");
  }
  const receiptSlots = ["commit_object", "ref_cas", "reflog_after", "verification"];
  const observationKeys = {
    commit_object: ["object_format", "object_oid", "object_bytes_sha256"],
    ref_cas: ["planning_ref", "expected_old_oid", "observed_new_oid", "expected_update_message", "candidate_keepalive_ref", "candidate_keepalive_oid"],
    reflog_after: ["before_entry_count", "after_entry_count", "before_prefix_sha256", "appended_entry_sha256"],
    verification: ["planning_ref", "commit_oid", "tree_oid", "reflog_after_receipt_hash"],
  };
  for (const slot of receiptSlots) {
    const receipt = example.receipts?.[slot];
    if (receipt !== null && receipt !== undefined &&
        (receipt.receipt_kind !== slot || receipt.operation_id !== example.operation_id)) {
      errors.push(`${slot} receipt must match its slot and containing operation_id`);
    }
    if (receipt !== null && receipt !== undefined) {
      if (!exactKeys(receipt.observation, observationKeys[slot])) {
        errors.push(`${slot} receipt observation fields are not closed for receipt_kind`);
      }
      const observationDigest = planningObservationDigest(slot, receipt.observation);
      if (receipt.observation_sha256 !== observationDigest) {
        errors.push(`${slot} receipt observation_sha256 mismatch`);
      }
      if (receipt.receipt_hash !== planningReceiptHash(
        example.operation_id,
        slot,
        observationDigest,
        receipt.helper_evidence,
      )) {
        errors.push(`${slot} receipt_hash mismatch`);
      }
      if (slot === "ref_cas" && !receipt.helper_evidence) {
        errors.push("ref_cas receipt requires journaled helper_evidence");
      }
      const expectedObservation = {
        commit_object: {
          object_format: example.commit_recipe?.object_format,
          object_oid: example.expected_commit_oid,
          object_bytes_sha256: example.commit_recipe?.commit_object_bytes_sha256,
        },
        ref_cas: {
          planning_ref: example.planning_ref,
          expected_old_oid: example.reflog_checkpoint?.expected_old_oid,
          observed_new_oid: example.reflog_checkpoint?.expected_new_oid,
          expected_update_message: example.reflog_checkpoint?.expected_update_message,
          candidate_keepalive_ref: example.candidate_keepalive?.ref,
          candidate_keepalive_oid: example.candidate_keepalive?.snapshot_commit_oid,
        },
        reflog_after: {
          before_entry_count: example.reflog_checkpoint?.before_entry_count,
          after_entry_count: (example.reflog_checkpoint?.before_entry_count ?? -1) + 1,
          before_prefix_sha256: example.reflog_checkpoint?.before_prefix_sha256,
          appended_entry_sha256: planningReflogEntryDigest(example),
        },
        verification: {
          planning_ref: example.planning_ref,
          commit_oid: example.expected_commit_oid,
          tree_oid: example.candidate_tree_oid,
          reflog_after_receipt_hash: example.receipts?.reflog_after?.receipt_hash,
        },
      }[slot];
      for (const key of observationKeys[slot]) {
        if (canonicalStringify(receipt.observation?.[key]) !== canonicalStringify(expectedObservation[key])) {
          errors.push(`${slot} observation.${key} does not match containing operation`);
        }
      }
    }
  }
  const presentReceipts = receiptSlots.filter((slot) => example.receipts?.[slot] !== null);
  const allowedReceiptPrefix = {
    prepared: [],
    commit_created: ["commit_object"],
    ref_advanced: ["commit_object", "ref_cas", "reflog_after"],
    verified: receiptSlots,
  };
  if (example.phase !== "voided_before_ref" &&
      canonicalStringify(presentReceipts) !== canonicalStringify(allowedReceiptPrefix[example.phase] ?? [])) {
    errors.push(`${example.phase} phase receipts do not match the closed prefix`);
  }
  if (example.phase === "voided_before_ref" &&
      presentReceipts.some((slot) => slot !== "commit_object")) {
    errors.push("voided_before_ref phase receipts may contain only commit_object");
  }
  if (["prepared", "commit_created", "ref_advanced"].includes(example.phase) &&
      example.effective_target_step !== null) {
    errors.push("effective_target_step must remain null before terminal publication");
  }
  if (example.phase === "voided_before_ref" && example.effective_target_step !== "prepare_anchor_impact") {
    errors.push("voided_before_ref effective_target_step must be prepare_anchor_impact");
  }
  if (example.payload?.kind === "artifact_pass") {
    const pathspec = example.payload.artifact_pathspec;
    if (!Array.isArray(pathspec) || canonicalStringify(pathspec) !==
        canonicalStringify([...pathspec].sort(codePointCompare))) {
      errors.push("artifact_pathspec must use canonical code-point order");
    } else if (example.payload.artifact_pathspec_digest !==
        artifactPathspecDigest(example.payload.artifact_kind, pathspec)) {
      errors.push("artifact_pathspec_digest mismatch");
    }
    if (example.payload.verdict_or_waiver_digest !== verdictOrWaiverDigest(example.payload)) {
      errors.push("verdict_or_waiver_digest mismatch");
    }
    const binding = example.payload.verdict_or_waiver_binding;
    if ((binding?.disposition === "pass" && binding.record?.kind !== "verdict") ||
        (binding?.disposition === "waived" && binding.record?.kind !== "waiver")) {
      errors.push("verdict_or_waiver_binding disposition does not match record kind");
    }
    if (example.phase === "verified" &&
        !["select_next", "prepare_anchor_impact"].includes(example.effective_target_step)) {
      errors.push("verified artifact_pass effective_target_step is invalid");
    }
  }
  if (example.payload?.kind === "anchor_invalidation") {
    const order = ["brief", "core_flow", "tech_plan", "tickets"];
    const kinds = example.payload.affected_artifact_kinds ?? [];
    const sorted = [...kinds].sort((left, right) => order.indexOf(left) - order.indexOf(right));
    if (canonicalStringify(kinds) !== canonicalStringify(sorted)) {
      errors.push("affected_artifact_kinds must use canonical ArtifactKind order");
    }
    const mutations = example.payload.projection_mutations ?? [];
    const mutationKinds = [...new Set(mutations.map((item) => item.artifact_kind))];
    if (mutations.length === 0 || canonicalStringify(mutationKinds) !== canonicalStringify(kinds)) {
      errors.push("projection_mutations must cover every affected_artifact_kind exactly in canonical order");
    }
    for (const mutation of mutations) {
      if (!Array.isArray(mutation.pathspec) || canonicalStringify(mutation.pathspec) !==
          canonicalStringify([...mutation.pathspec].sort(codePointCompare)) ||
          mutation.pathspec_digest !== artifactPathspecDigest(mutation.artifact_kind, mutation.pathspec)) {
        errors.push(`projection_mutations ${mutation.artifact_kind} pathspec/digest mismatch`);
      }
      if (mutation.previous_projection_digest !==
          previousProjectionDigest(example.expected_parent_tree_oid, mutation)) {
        errors.push(`projection_mutations ${mutation.artifact_kind} previous_projection_digest mismatch`);
      }
    }
    if (example.payload.invalidation_projection_digest !== invalidationProjectionDigest(kinds, mutations)) {
      errors.push("invalidation_projection_digest mismatch");
    }
    if (example.candidate_tree_oid === example.expected_parent_tree_oid) {
      errors.push("anchor_invalidation candidate_tree_oid must differ from expected_parent_tree_oid");
    }
    if (example.phase === "verified" &&
        ![example.payload.recorded_target_step, "prepare_anchor_impact"].includes(example.effective_target_step)) {
      errors.push("verified anchor_invalidation effective_target_step is invalid");
    }
  }
  if (example.operation_type !== example.payload?.kind) errors.push("operation_type and payload.kind mismatch");
  if (schema?.additionalProperties !== false) errors.push("operation Schema must be closed");
  return errors;
}


function validateSnapshotCommitRecipe(operation) {
  const errors = [];
  const snapshotRecipe = operation.snapshot_commit_recipe;
  try {
    const oidLength = snapshotRecipe?.object_format === "sha256" ? 64 : 40;
    const oidMatchesFormat = (value) =>
      typeof value === "string" && value.length === oidLength && /^[0-9a-f]+$/u.test(value);
    const messageBytes = decodeBase64Exact(
      snapshotRecipe?.message_utf8_base64,
      "snapshot_commit_recipe.message_utf8_base64",
      errors,
    );
    const commitBytes = decodeBase64Exact(
      snapshotRecipe?.commit_object_bytes_base64,
      "snapshot_commit_recipe.commit_object_bytes_base64",
      errors,
    );
    const expectedBytes = Buffer.from(
      `tree ${snapshotRecipe?.tree_oid}\n` +
      `parent ${snapshotRecipe?.parent_oids?.[0]}\n` +
      `author ${snapshotRecipe?.author?.name_utf8} <${snapshotRecipe?.author?.email_ascii}> ` +
      `${snapshotRecipe?.author?.timestamp_seconds} ${snapshotRecipe?.author?.timezone}\n` +
      `committer ${snapshotRecipe?.committer?.name_utf8} <${snapshotRecipe?.committer?.email_ascii}> ` +
      `${snapshotRecipe?.committer?.timestamp_seconds} ${snapshotRecipe?.committer?.timezone}\n\n` +
      messageBytes.toString("utf8"),
      "utf8",
    );
    const objectHash = createHash(snapshotRecipe?.object_format)
      .update(Buffer.concat([Buffer.from(`commit ${commitBytes.length}\0`), commitBytes]))
      .digest("hex");
    if (!snapshotRecipe || snapshotRecipe.object_format !== operation.object_format ||
        snapshotRecipe.tree_oid !== operation.snapshot_tree_oid ||
        !Array.isArray(snapshotRecipe.parent_oids) || snapshotRecipe.parent_oids.length !== 1 ||
        !oidMatchesFormat(snapshotRecipe.tree_oid) || !oidMatchesFormat(snapshotRecipe.parent_oids[0]) ||
        snapshotRecipe.signing?.mode !== "none" ||
        snapshotRecipe.signing?.signature_header_base64 !== null ||
        !commitBytes.equals(expectedBytes) ||
        sha256(commitBytes) !== snapshotRecipe.commit_object_bytes_sha256 ||
        objectHash !== snapshotRecipe.expected_commit_oid ||
        snapshotRecipe.expected_commit_oid !== operation.snapshot_commit_oid ||
        snapshotRecipe.committer?.name_utf8 !== operation.reflog_producer?.git_committer_name ||
        snapshotRecipe.committer?.email_ascii !== operation.reflog_producer?.git_committer_email ||
        `@${snapshotRecipe.committer?.timestamp_seconds} ${snapshotRecipe.committer?.timezone}` !==
          operation.reflog_producer?.git_committer_date) {
      errors.push("candidate keepalive snapshot commit recipe mismatch");
    }
  } catch {
    errors.push("candidate keepalive snapshot commit recipe is invalid");
  }
  return errors;
}

export function validateCandidateKeepaliveOperation(operation, schema) {
  const errors = validateJsonSchema(operation, schema, schema, "candidate_keepalive_operation")
    .map((error) => "Schema: " + error);
  const required = Array.isArray(schema?.required) ? schema.required : [];
  if (!exactKeys(operation, required)) errors.push("candidate keepalive operation keys differ from closed Schema");
  const expectedRefKey = deriveEpicRefKey(operation.project_root_sha256, operation.epic_id);
  const identityPreimage = operation.candidate_identity_preimage;
  const expectedIdentity = identityPreimage && sha256(
    "autosk-flow/planning-candidate/v1\0" + canonicalStringify(identityPreimage),
  );
  if (!identityPreimage || identityPreimage.project_root_sha256 !== operation.project_root_sha256 ||
      identityPreimage.epic_id !== operation.epic_id ||
      identityPreimage.snapshot_commit_oid !== operation.snapshot_commit_oid ||
      identityPreimage.candidate_tree_oid !== operation.snapshot_tree_oid ||
      operation.candidate_identity !== expectedIdentity) {
    errors.push("candidate keepalive candidate_identity preimage mismatch");
  }
  if (operation.epic_ref_key !== expectedRefKey) {
    errors.push("candidate keepalive epic_ref_key derivation mismatch");
  }
  const expectedRef = "refs/autosk/epics/" + operation.epic_ref_key +
    "/candidates/" + operation.candidate_identity;
  const expectedAuditRef = "refs/autosk/epics/" + operation.epic_ref_key +
    "/audit/candidates/" + operation.candidate_identity;
  if (operation.ref !== expectedRef || operation.audit_ref !== expectedAuditRef) {
    errors.push("candidate keepalive operation ref identity mismatch");
  }
  if (operation.expected_update_message !== "autosk-flow keepalive " + operation.operation_id) {
    errors.push("candidate keepalive operation message mismatch");
  }
  errors.push(...validateSnapshotCommitRecipe(operation));
  const snapshotObject = operation.snapshot_object_receipt;
  if (snapshotObject && (snapshotObject.operation_id !== operation.operation_id ||
      snapshotObject.object_format !== operation.object_format ||
      snapshotObject.object_oid !== operation.snapshot_commit_oid ||
      snapshotObject.object_bytes_sha256 !== operation.snapshot_commit_recipe?.commit_object_bytes_sha256 ||
      snapshotObject.tree_oid !== operation.snapshot_tree_oid ||
      snapshotObject.parent_oid !== operation.snapshot_commit_recipe?.parent_oids?.[0] ||
      snapshotObject.receipt_hash !== candidateSnapshotObjectReceiptHash(snapshotObject))) {
    errors.push("candidate keepalive snapshot object receipt mismatch");
  }
  const create = operation.create_receipt;
  if (create) {
    const expectedEntrySha256 = candidateKeepaliveReflogEntryDigest({ candidate_keepalive: operation });
    const expectedPrefixSha256 = reflogPrefixDigest(0, Buffer.alloc(0));
    const observation = {
      after_entry_count: create.after_entry_count,
      appended_entry_sha256: create.appended_entry_sha256,
      before_entry_count: create.before_entry_count,
      before_prefix_sha256: create.before_prefix_sha256,
      candidate_identity: create.candidate_identity,
      expected_update_message: create.expected_update_message,
      observed_new_oid: create.observed_new_oid,
      observed_old_oid: create.observed_old_oid,
      operation_id: create.operation_id,
      ref: create.ref,
      snapshot_tree_oid: create.snapshot_tree_oid,
    };
    const observationSha256 = sha256(
      "autosk-flow/candidate-keepalive-create/v1\0" + canonicalStringify(observation),
    );
    if (create.operation_id !== operation.operation_id ||
        create.candidate_identity !== operation.candidate_identity ||
        create.ref !== operation.ref || create.observed_old_oid !== null ||
        create.observed_new_oid !== operation.snapshot_commit_oid ||
        create.snapshot_tree_oid !== operation.snapshot_tree_oid ||
        create.expected_update_message !== operation.expected_update_message ||
        create.before_entry_count !== 0 || create.after_entry_count !== 1 ||
        create.before_prefix_sha256 !== expectedPrefixSha256 ||
        create.appended_entry_sha256 !== expectedEntrySha256 ||
        create.observation_sha256 !== observationSha256 ||
        create.receipt_hash !== candidateKeepaliveCreateReceiptHash(
          operation.candidate_identity,
          operation.operation_id,
          observationSha256,
        )) {
      errors.push("candidate keepalive create receipt or reflog entry mismatch");
    }
  }
  const expectedOidLength = operation.object_format === "sha256" ? 64 : 40;
  for (const [key, value] of [
    ["snapshot_commit_oid", operation.snapshot_commit_oid],
    ["snapshot_tree_oid", operation.snapshot_tree_oid],
    ["create_receipt.observed_new_oid", create?.observed_new_oid],
  ]) {
    if (typeof value === "string" && value.length !== expectedOidLength) {
      errors.push(`candidate keepalive ${key} does not match object_format`);
    }
  }
  const verification = operation.verification_receipt;
  if (verification) {
    const preimage = { operation_id: operation.operation_id, ref: verification.ref, observed_oid: verification.observed_oid, reflog_tail_observation_sha256: verification.reflog_tail_observation_sha256, helper_evidence: verification.helper_evidence };
    const expectedHash = sha256("autosk-flow/candidate-keepalive-verification/v1\0" + canonicalStringify(preimage));
    if (verification.ref !== operation.ref || verification.observed_oid !== operation.snapshot_commit_oid || verification.reflog_tail_observation_sha256 !== create?.observation_sha256 || canonicalStringify(verification.helper_evidence) !== canonicalStringify(create?.helper_evidence) || verification.receipt_hash !== expectedHash) errors.push("candidate keepalive verification receipt mismatch");
  }
  const release = operation.release_receipt;
  if (release && (release.operation_id !== operation.operation_id ||
      release.candidate_identity !== operation.candidate_identity ||
      release.ref !== operation.ref || release.expected_old_oid !== operation.snapshot_commit_oid ||
      release.audit_candidate_ref !== operation.audit_ref ||
      release.audit_candidate_oid !== operation.snapshot_commit_oid ||
      release.ref_custody_generation !== operation.ref_custody_generation ||
      release.ref_custody_policy_digest !== operation.ref_custody_policy_digest ||
      release.closure_verified !== true ||
      release.receipt_hash !== candidateKeepaliveReleaseReceiptHash(release))) {
    errors.push("candidate keepalive release receipt mismatch");
  }
  const audit = operation.audit_receipt;
  if (audit && (audit.operation_id !== operation.operation_id ||
      audit.candidate_identity !== operation.candidate_identity ||
      audit.live_ref !== operation.ref || audit.audit_ref !== operation.audit_ref ||
      audit.snapshot_commit_oid !== operation.snapshot_commit_oid ||
      audit.ref_custody_generation !== operation.ref_custody_generation ||
      audit.ref_custody_policy_digest !== operation.ref_custody_policy_digest ||
      audit.observation_sha256 !== candidateKeepaliveAuditObservationDigest(audit) ||
      audit.receipt_hash !== candidateKeepaliveAuditReceiptHash(audit))) {
    errors.push("candidate keepalive audit receipt mismatch");
  }
  const phaseRules = {
    prepared: snapshotObject === null && create === null && verification === null && release === null && audit === null &&
      operation.terminal_disposition === null,
    object_written: snapshotObject !== null && create === null && verification === null && release === null && audit === null &&
      operation.terminal_disposition === null,
    ref_created: snapshotObject !== null && create !== null && verification === null && release === null && audit === null &&
      operation.terminal_disposition === null,
    verified: snapshotObject !== null && create !== null && verification !== null && release === null && audit === null &&
      operation.terminal_disposition === null,
    audit_retained: snapshotObject !== null && create !== null && verification !== null && release === null && audit !== null &&
      ["panel_not_pass", "narrow_not_pass", "voided_before_ref", "superseded"].includes(audit.reason) &&
      operation.terminal_disposition === "audit_retained",
    released: snapshotObject !== null && create !== null && verification !== null && release !== null && audit !== null &&
      audit.reason === "publication_verified" && release.audit_candidate_ref === audit.audit_ref &&
      release.audit_candidate_oid === audit.snapshot_commit_oid &&
      operation.terminal_disposition === "published_released",
  };
  if (phaseRules[operation.phase] !== true) {
    errors.push("candidate keepalive phase receipt prefix mismatch");
  }
  return errors;
}

export function validateCandidateSupersessionOperation(operation, schema) {
  const errors = validateJsonSchema(operation, schema, schema, "candidate_supersession_operation")
    .map((error) => "Schema: " + error);
  const candidateSuffix = `/${operation.source_candidate_identity}`;
  if (!operation.live_ref?.endsWith(candidateSuffix) || !operation.audit_ref?.endsWith(candidateSuffix)) {
    errors.push("candidate supersession ref identity mismatch");
  }
  const receipt = operation.audit_receipt;
  const requestBinding = operation.helper_request_binding;
  if (requestBinding) {
    const { binding_hash: ignored, ...preimage } = requestBinding;
    const expectedHash = sha256(
      "autosk-flow/candidate-supersession-request/v1\0" + canonicalStringify(preimage),
    );
    if (requestBinding.supersession_operation_id !== operation.operation_id ||
        requestBinding.replacement_intent_digest !== operation.replacement_intent_digest ||
        requestBinding.keepalive_operation_id !== operation.keepalive_operation_id ||
        requestBinding.binding_hash !== expectedHash) {
      errors.push("candidate supersession helper request binding mismatch");
    }
  }
  if (receipt && (receipt.operation_id !== operation.keepalive_operation_id ||
      receipt.candidate_identity !== operation.source_candidate_identity ||
      receipt.live_ref !== operation.live_ref || receipt.audit_ref !== operation.audit_ref ||
      receipt.snapshot_commit_oid !== operation.snapshot_commit_oid || receipt.reason !== "superseded" ||
      receipt.observation_sha256 !== candidateKeepaliveAuditObservationDigest(receipt) ||
      receipt.receipt_hash !== candidateKeepaliveAuditReceiptHash(receipt))) {
    errors.push("candidate supersession audit receipt mismatch");
  }
  const helperReceipt = operation.helper_transaction_receipt;
  if (helperReceipt) {
    const { receipt_hash: ignored, ...preimage } = helperReceipt;
    const expectedHash = sha256(
      "autosk-flow/candidate-supersession-helper/v1\0" + canonicalStringify(preimage),
    );
    if (helperReceipt.supersession_operation_id !== operation.operation_id ||
        helperReceipt.replacement_intent_digest !== operation.replacement_intent_digest ||
        helperReceipt.live_ref !== operation.live_ref || helperReceipt.audit_ref !== operation.audit_ref ||
        helperReceipt.snapshot_commit_oid !== operation.snapshot_commit_oid ||
        helperReceipt.audit_receipt_hash !== receipt?.receipt_hash || helperReceipt.receipt_hash !== expectedHash) {
      errors.push("candidate supersession helper transaction receipt mismatch");
    }
    const evidence = receipt?.helper_evidence;
    if (!evidence || helperReceipt.helper_request_id !== evidence.request_id ||
        helperReceipt.helper_nonce !== evidence.nonce ||
        helperReceipt.helper_transaction_value_observation_sha256 !== evidence.transaction_value_observation_sha256 ||
        helperReceipt.helper_receipt_hash !== evidence.helper_receipt_hash) {
      errors.push("candidate supersession helper receipt is not bound to journal evidence");
    }
    if (!requestBinding || helperReceipt.helper_request_id !== requestBinding.helper_request_id ||
        helperReceipt.helper_nonce !== requestBinding.helper_nonce ||
        evidence?.helper_receipt_hash !== helperReceipt.helper_receipt_hash) {
      errors.push("candidate supersession helper receipt is not bound to prepared request");
    }
  }
  const phaseValid = operation.phase === "prepared"
    ? receipt === null && helperReceipt === null && operation.archived_at_utc === null
    : operation.phase === "audit_transferred"
      ? receipt !== null && helperReceipt !== null && operation.archived_at_utc === null
      : operation.phase === "archived"
        ? receipt !== null && helperReceipt !== null && typeof operation.archived_at_utc === "string"
        : false;
  if (!phaseValid) errors.push("candidate supersession phase prefix mismatch");
  return errors;
}

export function validateAuditHousekeepingOperation(operation, schema) {
  const errors = validateJsonSchema(operation, schema, schema, "audit_housekeeping_operation")
    .map((error) => "Schema: " + error);
  const approval = operation.operator_approval;
  if (approval) {
    const approvalPreimage = {
      operation_id: operation.operation_id,
      audit_ref: operation.audit_ref,
      expected_oid: operation.expected_oid,
      retention_policy_digest: operation.retention_policy_digest,
      inventory_digest: operation.inventory_digest,
      expires_at_utc: operation.expires_at_utc,
      operator_approval: {
        record_id: approval.record_id,
        approved_by: approval.approved_by,
        approved_at_utc: approval.approved_at_utc,
      },
    };
    if (approval.digest !== sha256(
      "autosk-flow/audit-housekeeping-approval/v1\0" + canonicalStringify(approvalPreimage),
    ) || Date.parse(approval.approved_at_utc) < Date.parse(operation.expires_at_utc)) {
      errors.push("audit housekeeping operator approval mismatch");
    }
  }
  const tombstone = operation.tombstone_receipt;
  if (tombstone) {
    const { receipt_hash: ignored, ...preimage } = tombstone;
    if (tombstone.operation_id !== operation.operation_id ||
        tombstone.deleted_audit_ref !== operation.audit_ref ||
        tombstone.deleted_oid !== operation.expected_oid ||
        tombstone.helper_receipt_hash !== operation.helper_evidence?.helper_receipt_hash ||
        tombstone.inventory_digest !== operation.inventory_digest ||
        tombstone.retention_policy_digest !== operation.retention_policy_digest ||
        Date.parse(tombstone.deleted_at_utc) < Date.parse(operation.expires_at_utc) ||
        Date.parse(tombstone.deleted_at_utc) < Date.parse(operation.operator_approval?.approved_at_utc) ||
        tombstone.receipt_hash !== sha256(
          "autosk-flow/audit-housekeeping-tombstone/v1\0" + canonicalStringify(preimage),
        )) {
      errors.push("audit housekeeping tombstone receipt mismatch");
    }
  }
  return errors;
}

export function validateRefCustodyHelperContract(contract, schema) {
  const errors = validateJsonSchema(contract, schema, schema, "ref_custody_helper_contract")
    .map((error) => "Schema: " + error);
  const commonRequest = [
    "action", "authorization", "body_sha256", "candidate_identity", "custody_generation",
    "epic_id", "epic_ref_key", "expected_update_message", "nonce", "object_format",
    "operation_id", "packed_refs_sha256", "policy_digest", "project_root_sha256",
    "ref_updates", "reflog_checkpoints", "reflog_producer", "request_id", "schema",
    "transfer_mode",
  ].sort(codePointCompare);
  const commonResponse = [
    "action", "custody_generation", "nonce", "not_applied_reason", "policy_digest", "receipt_hash",
    "ref_observations", "reflog_observations", "request_body_sha256", "request_id",
    "schema", "status", "transaction_value_observation_sha256",
  ].sort(codePointCompare);
  const actionExtras = {
    init: [],
    create_keepalive: [],
    advance_planning: [],
    ensure_audit_ref: [],
    delete_live_ref: [],
    delete_expired_audit: [],
  };
  const actions = Array.isArray(contract?.actions) ? contract.actions : [];
  if (canonicalStringify(actions.map((item) => item.action)) !==
      canonicalStringify(Object.keys(actionExtras))) {
    errors.push("ref-custody actions must contain the exact canonical six-action roster");
  }
  for (const action of actions) {
    const requestRequired = [...new Set([
      ...commonRequest,
      ...(actionExtras[action.action] ?? []),
    ])].sort(codePointCompare);
    if (canonicalStringify(action.request_required) !== canonicalStringify(requestRequired) ||
        canonicalStringify(action.response_required) !== canonicalStringify(commonResponse)) {
      errors.push(`ref-custody ${action.action} request/response field contract mismatch`);
      continue;
    }
    const requestDomain = `autosk-flow/ref-custody/${action.action}/request-shape/v1\0`;
    const observationDomain = `autosk-flow/ref-custody/${action.action}/response-shape/v1\0`;
    const receiptDomain = `autosk-flow/ref-custody/${action.action}/receipt-shape/v1\0`;
    const requestShapeSha256 = sha256(
      requestDomain + canonicalStringify({ action: action.action, request_required: requestRequired }),
    );
    const responseShapeSha256 = sha256(
      observationDomain + canonicalStringify({ action: action.action, response_required: commonResponse }),
    );
    const receiptShapeSha256 = sha256(
      receiptDomain + canonicalStringify({
        action: action.action,
        request_shape_sha256: requestShapeSha256,
        response_shape_sha256: responseShapeSha256,
      }),
    );
    if (action.request_domain !== requestDomain || action.observation_domain !== observationDomain ||
        action.receipt_domain !== receiptDomain ||
        action.golden?.request_shape_sha256 !== requestShapeSha256 ||
        action.golden?.response_shape_sha256 !== responseShapeSha256 ||
        action.golden?.receipt_shape_sha256 !== receiptShapeSha256) {
      errors.push(`ref-custody ${action.action} domain or literal golden vector mismatch`);
    }
  }
  return errors;
}

export function validateRefCustodyHelperWireExamples(wire, schema) {
  const errors = validateJsonSchema(wire, schema, schema, "ref_custody_helper_wire")
    .map((error) => "Schema: " + error);
  const expectedActions = [
    "init", "create_keepalive", "advance_planning", "ensure_audit_ref",
    "delete_live_ref", "ensure_audit_ref", "delete_live_ref", "delete_expired_audit",
  ];
  const expectedOperations = {
    init: [["update"]],
    create_keepalive: [["update"]],
    advance_planning: [["verify", "update"]],
    ensure_audit_ref: [["verify", "update"], ["verify", "verify"], ["verify", "verify", "update"], ["verify", "verify", "verify"]],
    delete_live_ref: [["verify", "delete"], ["verify", "verify", "delete"]],
    delete_expired_audit: [["delete"]],
  };
  const actions = Array.isArray(wire?.actions) ? wire.actions : [];
  const isolatedNotApplied = actions.length === 1 && actions[0]?.response?.status === "not_applied";
  const isolatedCreateVariant = actions.length === 1 && actions[0]?.action === "create_keepalive" &&
    actions[0]?.response?.status === "committed";
  const isolatedExistingAuditVariant = actions.length >= 1 && actions.length <= 4 &&
    actions.every((item) => ["ensure_audit_ref", "delete_live_ref"].includes(item?.action) &&
      item?.request?.ref_updates?.some((update) => update.operation === "verify" &&
        update.ref.includes("/audit/candidates/")));
  if (!isolatedNotApplied && !isolatedCreateVariant && !isolatedExistingAuditVariant &&
      canonicalStringify(actions.map((item) => item.action)) !== canonicalStringify(expectedActions)) {
    errors.push("ref-custody wire must contain the exact canonical six-action roster");
  }
  if (isolatedNotApplied && actions[0].action !== "advance_planning") {
    errors.push("isolated not-applied golden must use advance_planning");
  }
  let publicKey;
  let publicKeySha256 = "";
  try {
    const publicDer = Buffer.from(wire.public_key_spki_base64, "base64");
    publicKey = createPublicKey({ key: publicDer, format: "der", type: "spki" });
    publicKeySha256 = sha256(publicDer);
  } catch {
    errors.push("ref-custody wire public key is invalid");
  }
  const nonces = new Set();
  const requestIds = new Set();
  for (const exchange of actions) {
    const { request, response, journal, action } = exchange;
    const { body_sha256: ignoredBodyHash, authorization, ...body } = request ?? {};
    const bodySha256 = sha256(
      "autosk-flow/ref-custody/request-body/v1\0" + canonicalStringify(body),
    );
    const signedBytes = Buffer.from(
      `autosk-flow/ref-custody-authorization/v1\0${bodySha256}\0${request?.nonce}`,
      "utf8",
    );
    let signatureValid = false;
    try {
      signatureValid = verify(
        null,
        signedBytes,
        publicKey,
        Buffer.from(authorization?.signature_base64 ?? "", "base64"),
      );
    } catch {
      signatureValid = false;
    }
    if (request?.action !== action || response?.action !== action || journal?.action !== action ||
        request?.body_sha256 !== bodySha256 || authorization?.scheme !== "ed25519" ||
        authorization?.request_body_sha256 !== bodySha256 || authorization?.nonce !== request?.nonce ||
        authorization?.public_key_sha256 !== publicKeySha256 ||
        authorization?.key_id !== publicKeySha256 || !signatureValid) {
      errors.push(`ref-custody ${action} request body or authorization mismatch`);
    }
    if (nonces.has(request?.nonce)) errors.push(`ref-custody ${action} nonce is reused`);
    nonces.add(request?.nonce);
    if (requestIds.has(request?.request_id)) errors.push(`ref-custody ${action} request_id is reused`);
    requestIds.add(request?.request_id);
    const actualOperations = request?.ref_updates?.map((item) => item.operation);
    if (!(expectedOperations[action] ?? []).some((expected) =>
      canonicalStringify(actualOperations) === canonicalStringify(expected))) {
      errors.push(`ref-custody ${action} action-specific ref update set mismatch`);
    }
    const expectedEpicKey = deriveEpicRefKey(request?.project_root_sha256, request?.epic_id);
    const expectedRoot = `refs/autosk/epics/${expectedEpicKey}/`;
    const expectedPlanningRef = `${expectedRoot}planning`;
    const expectedLiveRef = `${expectedRoot}candidates/${request?.candidate_identity}`;
    const expectedAuditRef = `${expectedRoot}audit/candidates/${request?.candidate_identity}`;
    const transferMode = request?.transfer_mode;
    const expectedRefTopologies = {
      init: [[['update', expectedPlanningRef]]],
      create_keepalive: [[['update', expectedLiveRef]]],
      advance_planning: [[['verify', expectedLiveRef], ['update', expectedPlanningRef]]],
      ensure_audit_ref: transferMode === "release_to_audit"
        ? [
            [["verify", expectedPlanningRef], ["verify", expectedLiveRef], ["update", expectedAuditRef]],
            [["verify", expectedPlanningRef], ["verify", expectedLiveRef], ["verify", expectedAuditRef]],
          ]
        : [
            [["verify", expectedLiveRef], ["update", expectedAuditRef]],
            [["verify", expectedLiveRef], ["verify", expectedAuditRef]],
          ],
      delete_live_ref: transferMode === "release_to_audit"
        ? [[["verify", expectedPlanningRef], ["verify", expectedAuditRef], ["delete", expectedLiveRef]]]
        : [[["verify", expectedAuditRef], ["delete", expectedLiveRef]]],
      delete_expired_audit: [[['delete', expectedAuditRef]]],
    };
    const actualTopology = request?.ref_updates?.map((item) => [item.operation, item.ref]);
    const topologyValid = (expectedRefTopologies[action] ?? []).some((expected) =>
      canonicalStringify(actualTopology) === canonicalStringify(expected));
    const expectedMessagePrefix = action === "init" ? "autosk-flow init "
      : action === "advance_planning" ? "autosk-flow publish "
        : action === "delete_expired_audit" ? "autosk-flow housekeeping "
          : "autosk-flow keepalive ";
    if (request?.epic_ref_key !== expectedEpicKey ||
        request?.expected_update_message !== expectedMessagePrefix + request?.operation_id ||
        request?.ref_updates?.some((item) => !item.ref.startsWith(expectedRoot)) ||
        (action === "init" ? request?.candidate_identity !== null : !request?.candidate_identity) ||
        !topologyValid ||
        request?.ref_updates?.some((item) => {
          const lengths = [item.expected_old_oid, item.new_oid].filter(Boolean).map((oid) => oid.length);
          return lengths.some((length) => length !== lengths[0]);
        })) {
      errors.push(`ref-custody ${action} Epic/action/message topology mismatch`);
    }
    const oidLengths = new Set();
    const collectOid = (oid) => {
      if (typeof oid === "string") oidLengths.add(oid.length);
    };
    for (const update of request?.ref_updates ?? []) {
      collectOid(update.expected_old_oid);
      collectOid(update.new_oid);
    }
    for (const observation of response?.ref_observations ?? []) {
      collectOid(observation.expected_old_oid);
      collectOid(observation.requested_new_oid);
      collectOid(observation.observed_old_oid);
      collectOid(observation.observed_new_oid);
    }
    if (oidLengths.size !== 1 || ![40, 64].includes([...oidLengths][0])) {
      errors.push(`ref-custody ${action} object format mismatch`);
    }
    const updateRefs = [...new Set(request?.ref_updates?.map((item) => item.ref) ?? [])].sort(codePointCompare);
    const checkpointRefs = [...new Set(request?.reflog_checkpoints?.map((item) => item.ref) ?? [])].sort(codePointCompare);
    const observationRefs = [...new Set(response?.reflog_observations?.map((item) => item.ref) ?? [])].sort(codePointCompare);
    const orderedUpdateRefs = request?.ref_updates?.map((item) => item.ref) ?? [];
    const orderedResponseRefs = response?.ref_observations?.map((item) => item.ref) ?? [];
    const orderedCheckpointRefs = request?.reflog_checkpoints?.map((item) => item.ref) ?? [];
    const orderedReflogRefs = response?.reflog_observations?.map((item) => item.ref) ?? [];
    if (canonicalStringify(updateRefs) !== canonicalStringify(checkpointRefs) ||
        canonicalStringify(updateRefs) !== canonicalStringify(observationRefs) ||
        canonicalStringify(orderedUpdateRefs) !== canonicalStringify(orderedResponseRefs) ||
        canonicalStringify(orderedUpdateRefs) !== canonicalStringify(orderedCheckpointRefs) ||
        canonicalStringify(orderedUpdateRefs) !== canonicalStringify(orderedReflogRefs) ||
        new Set(orderedResponseRefs).size !== orderedResponseRefs.length ||
        new Set(orderedCheckpointRefs).size !== orderedCheckpointRefs.length ||
        new Set(orderedReflogRefs).size !== orderedReflogRefs.length) {
      errors.push(`ref-custody ${action} reflog refs do not exactly match ref_updates`);
    }
    const expectedRefObservations = (request?.ref_updates ?? []).map((update) => ({
      operation: update.operation,
      ref: update.ref,
      expected_old_oid: update.expected_old_oid,
      requested_new_oid: update.new_oid,
      observed_old_oid: update.expected_old_oid,
      observed_new_oid: update.operation === "delete" ? null : update.new_oid,
    }));
    if (response?.status === "committed" &&
        canonicalStringify(response?.ref_observations) !== canonicalStringify(expectedRefObservations)) {
      errors.push(`ref-custody ${action} ref observations mismatch request values`);
    }
    if (response?.status === "not_applied") {
      const zeroWriteObservations = (request?.ref_updates ?? []).map((update, index) => {
        const observed = response?.ref_observations?.[index];
        return observed && observed.operation === update.operation &&
          observed.expected_old_oid === update.expected_old_oid &&
          observed.requested_new_oid === update.new_oid &&
          observed.observed_new_oid === observed.observed_old_oid;
      });
      const unchangedReflogs = (request?.reflog_checkpoints ?? []).map((checkpoint) => {
        const observed = response?.reflog_observations?.find((item) => item.ref === checkpoint.ref);
        return observed && observed.outcome === "unchanged" &&
          observed.before_entry_count === checkpoint.before_entry_count &&
          observed.after_entry_count === checkpoint.before_entry_count &&
          observed.before_prefix_base64 === checkpoint.before_prefix_base64 &&
          observed.before_prefix_sha256 === checkpoint.before_prefix_sha256 &&
          observed.raw_appended_entries_base64.length === 0 &&
          observed.appended_entry_sha256.length === 0;
      });
      if (!response.not_applied_reason || zeroWriteObservations.some((value) => !value) ||
          unchangedReflogs.some((value) => !value)) {
        errors.push(`ref-custody ${action} not_applied must prove zero ref and reflog side effects`);
      }
    }
    for (const observation of response?.reflog_observations ?? []) {
      const prefixBytes = Buffer.from(observation.before_prefix_base64 ?? "", "base64");
      const prefixLines = prefixBytes.toString("utf8").split("\n").filter(Boolean).length;
      if (prefixLines !== observation.before_entry_count ||
          reflogPrefixDigest(observation.before_entry_count, prefixBytes) !== observation.before_prefix_sha256) {
        errors.push(`ref-custody ${action} reflog prefix/count mismatch`);
      }
      if (observation.raw_appended_entries_base64.length !== observation.appended_entry_sha256.length ||
          observation.raw_appended_entries_base64.some((raw, index) =>
            sha256(Buffer.from(raw, "base64")) !== observation.appended_entry_sha256[index])) {
        errors.push(`ref-custody ${action} raw reflog observation mismatch`);
      }
      const update = request?.ref_updates?.find((item) => item.ref === observation.ref);
      if (response?.status === "committed" && ((update?.operation === "delete" && (observation.outcome !== "log_removed" ||
          observation.after_entry_count !== null || observation.raw_appended_entries_base64.length !== 0)) ||
          (update?.operation === "verify" && (observation.outcome !== "unchanged" ||
            observation.after_entry_count !== observation.before_entry_count)) ||
          (update?.operation === "update" && (observation.outcome !== "appended" ||
            observation.after_entry_count !== observation.before_entry_count + 1)))) {
        errors.push(`ref-custody ${action} reflog outcome mismatch ref operation`);
      }
      for (const raw of observation.raw_appended_entries_base64) {
        const text = Buffer.from(raw, "base64").toString("utf8");
        const match = /^([0-9a-f]+) ([0-9a-f]+) ([^\n<>]+) <([^\n<>]+)> ([0-9]+) (\+0000)\t([^\n]+)\n$/u.exec(text);
        const oidLength = (update?.expected_old_oid ?? update?.new_oid ?? "").length;
        const zeroOid = "0".repeat(oidLength);
        const expectedOld = update?.expected_old_oid ?? zeroOid;
        const expectedNew = update?.operation === "delete" ? zeroOid : update?.new_oid;
        const [timestamp, timezone] = request.reflog_producer.git_committer_date.slice(1).split(" ");
        if (!match || match[1] !== expectedOld || match[2] !== expectedNew ||
            match[3] !== request.reflog_producer.git_committer_name ||
            match[4] !== request.reflog_producer.git_committer_email ||
            match[5] !== timestamp || match[6] !== timezone ||
            match[7] !== request.expected_update_message) {
          errors.push(`ref-custody ${action} raw reflog fields mismatch request values`);
        }
      }
    }
    const observationPreimage = {
      action,
      request_id: request?.request_id,
      status: response?.status,
      not_applied_reason: response?.not_applied_reason,
      request_body_sha256: bodySha256,
      custody_generation: request?.custody_generation,
      policy_digest: request?.policy_digest,
      nonce: request?.nonce,
      ref_observations: response?.ref_observations,
      reflog_observations: response?.reflog_observations,
    };
    const observationSha256 = sha256(
      `autosk-flow/ref-custody/${action}/value-observation/v1\0` +
      canonicalStringify(observationPreimage),
    );
    const receiptHash = sha256(
      `autosk-flow/ref-custody/${action}/value-receipt/v1\0` + canonicalStringify({
        action,
        request_id: request?.request_id,
        request_body_sha256: bodySha256,
        status: response?.status,
        not_applied_reason: response?.not_applied_reason,
        transaction_value_observation_sha256: observationSha256,
      }),
    );
    if (response?.request_id !== request?.request_id ||
        response?.request_body_sha256 !== bodySha256 ||
        response?.custody_generation !== request?.custody_generation ||
        response?.policy_digest !== request?.policy_digest || response?.nonce !== request?.nonce ||
        response?.transaction_value_observation_sha256 !== observationSha256 ||
        response?.receipt_hash !== receiptHash) {
      errors.push(`ref-custody ${action} value-bound response digest mismatch`);
    }
    const requestFsync = sha256(
      "autosk-flow/ref-custody/journal-request/v1\0" + canonicalStringify(request),
    );
    const refsCommit = sha256(
      "autosk-flow/ref-custody/journal-refs/v1\0" + canonicalStringify({
        ref_observations: response?.ref_observations,
        reflog_observations: response?.reflog_observations,
      }),
    );
    const receiptFsync = sha256(
      "autosk-flow/ref-custody/journal-receipt/v1\0" + canonicalStringify(response),
    );
    const { journal_hash: ignoredJournalHash, ...journalBase } = journal ?? {};
    const journalHash = sha256(
      "autosk-flow/ref-custody/journal/v1\0" + canonicalStringify(journalBase),
    );
    const notApplied = response?.status === "not_applied";
    const expectedJournalPhase = notApplied ? "not_applied" : "receipt_committed";
    const expectedFsyncOrder = notApplied ? ["request", "receipt"] : ["request", "refs", "receipt"];
    if (journal?.phase !== expectedJournalPhase ||
        canonicalStringify(journal?.fsync_order) !== canonicalStringify(expectedFsyncOrder) ||
        journal?.request_body_sha256 !== bodySha256 ||
        canonicalStringify(journal?.request) !== canonicalStringify(request) ||
        canonicalStringify(journal?.response) !== canonicalStringify(response) ||
        journal?.request_fsync_sha256 !== requestFsync ||
        journal?.refs_commit_sha256 !== (notApplied ? null : refsCommit) ||
        journal?.receipt_fsync_sha256 !== receiptFsync || journal?.journal_hash !== journalHash) {
      errors.push(`ref-custody ${action} durable journal mismatch`);
    }
  }
  return errors;
}

export function validateRefCustodyJournalPrefixes(prefixes, wire, schema) {
  const errors = [];
  const records = prefixes?.records ?? [];
  const exchange = wire?.actions?.find(({ action }) => action === "init");
  if (records.length !== 2 || records[0]?.phase !== "request_committed" ||
      records[1]?.phase !== "refs_committed" || !exchange) {
    return ["ref-custody journal prefixes must contain init request_committed and refs_committed"];
  }
  for (const record of records) {
    errors.push(...validateJsonSchema(record, schema.$defs.journal, schema)
      .map((error) => `ref-custody ${record.phase} Schema: ${error}`));
    const requestFsync = sha256(
      "autosk-flow/ref-custody/journal-request/v1\0" + canonicalStringify(record.request),
    );
    const response = record.response;
    const refsCommit = response ? sha256(
      "autosk-flow/ref-custody/journal-refs/v1\0" + canonicalStringify({
        ref_observations: response.ref_observations,
        reflog_observations: response.reflog_observations,
      }),
    ) : null;
    const { journal_hash: ignoredJournalHash, ...preimage } = record;
    const journalHash = sha256(
      "autosk-flow/ref-custody/journal/v1\0" + canonicalStringify(preimage),
    );
    if (canonicalStringify(record.request) !== canonicalStringify(exchange.request) ||
        record.request_fsync_sha256 !== requestFsync || record.journal_hash !== journalHash ||
        (record.phase === "request_committed" && (response !== null || record.refs_commit_sha256 !== null)) ||
        (record.phase === "refs_committed" &&
          (canonicalStringify(response) !== canonicalStringify(exchange.response) ||
            record.refs_commit_sha256 !== refsCommit))) {
      errors.push(`ref-custody ${record.phase} prefix is not bound to exact request/observations`);
    }
  }
  return errors;
}

export function validateRefCustodyJournalCrashExample(example, prefixes, wire) {
  const buildJournal = (exchange, phase) => {
    const response = phase === "request_committed" ? null : exchange.response;
    const record = {
      ...exchange.journal,
      phase,
      response,
      fsync_order: phase === "request_committed" ? ["request"] : ["request", "refs"],
      refs_commit_sha256: phase === "request_committed" ? null : exchange.journal.refs_commit_sha256,
      receipt_fsync_sha256: null,
    };
    const { journal_hash: ignored, ...preimage } = record;
    record.journal_hash = sha256(
      "autosk-flow/ref-custody/journal/v1\0" + canonicalStringify(preimage),
    );
    return record;
  };
  const actions = ["init", "delete_expired_audit"];
  const expectedRecords = actions.map((action) => {
    const exchange = wire?.actions?.find((item) => item.action === action);
    if (!exchange) return null;
    const requestRecord = buildJournal(exchange, "request_committed");
    const refsRecord = buildJournal(exchange, "refs_committed");
    const record = {
      action,
      scenario: action === "delete_expired_audit"
        ? "delete_committed_before_refs_journal"
        : "git_committed_before_refs_journal",
      request_id: exchange.request.request_id,
      request_body_sha256: exchange.request.body_sha256,
      request_committed_journal_hash: requestRecord.journal_hash,
      observed_post_state_sha256: refsRecord.refs_commit_sha256,
      committed_response_receipt_hash: exchange.response.receipt_hash,
      recovery_decision: "persist_refs_committed_without_git_write",
      git_ref_transactions_during_recovery: 0,
      refs_committed_journal_hash: refsRecord.journal_hash,
    };
    if (action === "delete_expired_audit") {
      const preExecutionObservation = exchange.request.ref_updates.map((update) => {
        const checkpoint = exchange.request.reflog_checkpoints.find((item) => item.ref === update.ref);
        return { ref: update.ref, present: true, oid: update.expected_old_oid, packed_entry_absent: true, reflog_checkpoint_sha256: sha256("autosk-flow/ref-custody-intent-checkpoint/v1\0" + canonicalStringify(checkpoint)) };
      });
      record.delete_post_state_proof = {
        request_body_sha256: exchange.request.body_sha256,
        nonce: exchange.request.nonce,
        audit_ref_absent: true,
        reflog_path_absent: true,
        packed_refs_entry_absent: true,
        pre_execution_observation_sha256: sha256("autosk-flow/ref-custody-intent-precondition/v1\0" + canonicalStringify(preExecutionObservation)),
      };
    }
    return record;
  });
  const expected = expectedRecords.every(Boolean) ? { schema: 1, records: expectedRecords } : null;
  return expected && canonicalStringify(example) === canonicalStringify(expected)
    ? []
    : ["ref-custody journal crash vector does not bind the exact committed observations"];
}

export function validatePlanningPublicationOperationExample(example, schema) {
  const errors = validatePlanningPublicationOperation(example, schema);
  const reflogGoldenPrefix = Buffer.from(
    "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCAzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzIGF1dG9zay1mbG93IDxhdXRvc2tAZXhhbXBsZS5pbnZhbGlkPiAwICswMDAwCWF1dG9zay1mbG93IGluaXQgMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAwCg==",
    "base64",
  );
  if (example.reflog_checkpoint?.before_entry_count !== 1 ||
      example.reflog_checkpoint?.before_prefix_sha256 !== reflogPrefixDigest(1, reflogGoldenPrefix)) {
    errors.push("canonical reflog checkpoint golden vector mismatch");
  }
  return errors;
}

export function planningRefInitPolicyDigest(operation) {
  return sha256(
    "autosk-flow/planning-ref-init-policy/v1\0" + canonicalStringify({
      base_selection_authority: operation.base_selection_authority,
      base_selection_policy: operation.base_selection_policy,
      planning_base_oid: operation.planning_base_oid,
      planning_base_tree_oid: operation.planning_base_tree_oid,
      selected_base_ref: operation.selected_base_ref,
    }),
  );
}

export function planningInitReflogEntryDigest(operation) {
  const producer = operation.reflog_producer;
  if (!producer || typeof producer.git_committer_date !== "string" || !operation.reflog_checkpoint) return "";
  const [timestampSeconds, timezone] = producer.git_committer_date.slice(1).split(" ");
  const zeroOid = "0".repeat(operation.object_format === "sha256" ? 64 : 40);
  const entry = Buffer.from(
    `${zeroOid} ${operation.planning_base_oid} ` +
    `${producer.git_committer_name} <${producer.git_committer_email}> ${timestampSeconds} ${timezone}\t` +
    `${operation.expected_update_message}\n`,
    "utf8",
  );
  return sha256(Buffer.concat([
    Buffer.from("autosk-flow/reflog-entry/v1\0", "utf8"),
    entry,
  ]));
}

export function validatePlanningRefInitOperation(operation, schema) {
  const errors = validateJsonSchema(operation, schema, schema, "init_operation")
    .map((error) => `Schema: ${error}`);
  const required = Array.isArray(schema?.required) ? schema.required : [];
  if (!exactKeys(operation, required)) errors.push("init operation keys differ from closed Schema");
  const expectedRefKey = deriveEpicRefKey(operation.project_root_sha256, operation.epic_id);
  if (operation.epic_ref_key !== expectedRefKey ||
      operation.planning_ref !== `refs/autosk/epics/${expectedRefKey}/planning`) {
    errors.push("init operation project/Epic/ref identity mismatch");
  }
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(operation.selected_base_ref ?? "") ||
      /\.\.|\/\/|@\{|\.lock$|\/$/u.test(operation.selected_base_ref ?? "")) {
    errors.push("selected_base_ref is not a safe explicit local branch ref");
  }
  if (operation.base_selection_policy?.selected_base_ref !== operation.selected_base_ref ||
      operation.base_selection_policy?.expected_commit_oid !== operation.planning_base_oid ||
      operation.base_selection_policy?.expected_tree_oid !== operation.planning_base_tree_oid) {
    errors.push("base_selection_policy does not match containing init operation");
  }
  if (operation.bootstrap_policy_digest !== planningRefInitPolicyDigest(operation)) {
    errors.push("bootstrap_policy_digest mismatch");
  }
  if (operation.ref_storage_format !== "files") errors.push("init ref_storage_format must be files");
  if (!Number.isInteger(operation.ref_custody_generation) || operation.ref_custody_generation < 1 ||
      !SHA256_RE.test(operation.ref_custody_policy_digest ?? "")) {
    errors.push("init ref custody binding is invalid");
  }
  if (operation.expected_update_message !== `autosk-flow init ${operation.operation_id}` ||
      operation.reflog_checkpoint?.expected_update_message !== operation.expected_update_message ||
      operation.reflog_checkpoint?.expected_new_oid !== operation.planning_base_oid ||
      operation.reflog_checkpoint?.expected_old_oid !== null) {
    errors.push("init reflog checkpoint does not match containing operation");
  }
  const producer = operation.reflog_producer ?? {};
  if (producer.git_committer_name !== "autosk-flow" ||
      producer.git_committer_email !== "autosk@example.invalid" ||
      !/^@[0-9]+ \+0000$/u.test(producer.git_committer_date ?? "")) {
    errors.push("init reflog_producer differs from locked bootstrap identity");
  }
  const slots = ["ref_create", "verification"];
  const expectedKeys = {
    ref_create: ["planning_ref", "observed_old_oid", "observed_new_oid", "expected_update_message", "before_entry_count", "after_entry_count", "before_prefix_sha256", "appended_entry_sha256"],
    verification: ["planning_ref", "commit_oid", "tree_oid", "ref_create_receipt_hash"],
  };
  const expectedObservations = {
    ref_create: {
      planning_ref: operation.planning_ref,
      observed_old_oid: null,
      observed_new_oid: operation.planning_base_oid,
      expected_update_message: operation.expected_update_message,
      before_entry_count: 0,
      after_entry_count: 1,
      before_prefix_sha256: operation.reflog_checkpoint?.before_prefix_sha256,
      appended_entry_sha256: planningInitReflogEntryDigest(operation),
    },
    verification: {
      planning_ref: operation.planning_ref,
      commit_oid: operation.planning_base_oid,
      tree_oid: operation.planning_base_tree_oid,
      ref_create_receipt_hash: operation.receipts?.ref_create?.receipt_hash,
    },
  };
  for (const slot of slots) {
    const receipt = operation.receipts?.[slot];
    if (receipt !== null && receipt !== undefined) {
      if (receipt.operation_id !== operation.operation_id || receipt.receipt_kind !== slot ||
          !exactKeys(receipt.observation, expectedKeys[slot])) {
        errors.push(`${slot} init receipt binding or observation shape mismatch`);
        continue;
      }
      const digest = planningObservationDigest(slot, receipt.observation);
      if (receipt.observation_sha256 !== digest) errors.push(`${slot} init observation_sha256 mismatch`);
      if (receipt.receipt_hash !== planningReceiptHash(
        operation.operation_id,
        slot,
        digest,
        receipt.helper_evidence,
      )) {
        errors.push(`${slot} init receipt_hash mismatch`);
      }
      if (slot === "ref_create" && !receipt.helper_evidence) {
        errors.push("ref_create init receipt requires journaled helper_evidence");
      }
      for (const key of expectedKeys[slot]) {
        if (canonicalStringify(receipt.observation[key]) !== canonicalStringify(expectedObservations[slot][key])) {
          errors.push(`${slot} init observation.${key} does not match containing operation`);
        }
      }
    }
  }
  const present = slots.filter((slot) => operation.receipts?.[slot] !== null);
  const allowed = { prepared: [], ref_created: ["ref_create"], verified: slots };
  if (canonicalStringify(present) !== canonicalStringify(allowed[operation.phase] ?? [])) {
    errors.push(`${operation.phase} init receipt prefix mismatch`);
  }
  return errors;
}

export function validatePlanningRefInitOperationExample(operation, schema) {
  const errors = validatePlanningRefInitOperation(operation, schema);
  if (operation.reflog_producer?.git_committer_date !== "@0 +0000") {
    errors.push("init golden vector must use epoch-zero producer timestamp");
  }
  if (operation.reflog_checkpoint?.before_prefix_sha256 !== reflogPrefixDigest(0, Buffer.alloc(0))) {
    errors.push("init empty reflog prefix golden vector mismatch");
  }
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
    if (!line.trim().startsWith("|") &&
        /\brecord_artifact_pass\b.*(?:переходит|->|→).*\bselect_next\b/u.test(line)) {
      errors.push("03-technical-plan.md: prose directly transitions record_artifact_pass to select_next");
    }
  }
  const recordPassProse = plan
    .split("### Record artifact PASS и Arena markers")[1]
    ?.split("record_code_verdict")[0] ?? "";
  if (/переходит в select_next/u.test(recordPassProse)) {
    errors.push("03-technical-plan.md: prose directly transitions record_artifact_pass to select_next");
  }
  const planLines = plan.split("\n");
  const transitionHeader = planLines.findIndex(
    (line) => line.trim() === "| Текущий шаг | Условие | Следующий шаг |",
  );
  const transitionRows = [];
  if (transitionHeader < 0) {
    errors.push("03-technical-plan.md: canonical transition table header is missing");
  } else {
    for (const line of planLines.slice(transitionHeader + 1)) {
      const cells = splitMarkdownRow(line);
      if (!cells) break;
      if (cells.every((cell) => /^-+$/u.test(cell))) continue;
      if (cells.length === 3) transitionRows.push(cells);
    }
  }
  const recordPassSuccess = transitionRows.filter(
    ([step, , action]) => step === "record_artifact_pass" && !action.startsWith("human "),
  );
  if (recordPassSuccess.length < 3 ||
      recordPassSuccess.some(([, , action]) => !/;\s*publish_artifact_pass$/u.test(action))) {
    errors.push("03-technical-plan.md: every successful record_artifact_pass row must target publish_artifact_pass");
  }
  if (!recordPassSuccess.some(([, condition]) =>
    condition.includes("matching recorded_unpublished PASS and open prepared planning_publication_op"))) {
    errors.push("03-technical-plan.md: record_artifact_pass idempotent prepared-operation re-entry is missing");
  }
  const transitionIndex = (step, conditionFragment) => transitionRows.findIndex(
    ([rowStep, condition]) => rowStep === step && condition.includes(conditionFragment),
  );
  const preCasDriftIndex = transitionIndex("publish_artifact_pass", "current binding drift before ref movement");
  const preparedWriteIndex = transitionIndex("publish_artifact_pass", "phase=prepared and expected object absent");
  const commitCasIndex = transitionIndex("publish_artifact_pass", "phase=commit_created and ref=expected parent");
  if (preCasDriftIndex < 0 || preCasDriftIndex > preparedWriteIndex || preCasDriftIndex > commitCasIndex) {
    errors.push("03-technical-plan.md: pre-CAS drift guard must precede object/ref side effects");
  }
  const postCasDriftIndex = transitionIndex("publish_artifact_pass", "current binding drift after expected ref transition");
  const exactVerificationIndex = transitionIndex("publish_artifact_pass", "phase=ref_advanced and ref/commit/exact bytes");
  if (postCasDriftIndex < 0 || exactVerificationIndex < 0 || postCasDriftIndex > exactVerificationIndex) {
    errors.push("03-technical-plan.md: post-CAS drift guard must precede exact-binding verification");
  }
  const publicationRecoveryIndex = transitionIndex("select_next", "publication_status=recorded_unpublished");
  const remediationIndex = transitionIndex("select_next", "aggregate_remediation.phase != closed");
  if (publicationRecoveryIndex < 0 || remediationIndex < 0 || publicationRecoveryIndex > remediationIndex) {
    errors.push("03-technical-plan.md: select_next publication recovery must precede aggregate remediation");
  }
  for (const [conditionFragment, actionFragment] of [
    ["phase=voided_before_ref, candidate_keepalive_op phase=audit_retained and recovery_target_step=prepare_anchor_impact", "prepare_anchor_impact"],
    ["current binding drift after expected ref transition", "publish_artifact_pass"],
    ["phase=commit_created and expected object absent", "rewrite persisted exact commit_object_bytes"],
  ]) {
    const row = transitionRows.find(
      ([step, condition]) => step === "publish_artifact_pass" && condition.includes(conditionFragment),
    );
    if (!row || !row[2].includes(actionFragment)) {
      errors.push(`03-technical-plan.md: publish_artifact_pass recovery row missing ${conditionFragment}`);
    }
  }
  if (transitionIndex("rebuild_anchor", "matching anchor_invalidation planning_publication_op") < 0) {
    errors.push("03-technical-plan.md: rebuild_anchor publication-operation re-entry is missing");
  }
  for (const [step, condition, action] of [
    ["init_planning_ref", "phase=verified", "zero Git writes; select_next"],
    ["init_planning_ref", "init_status=verified", "zero Git writes; select_next"],
    ["publish_artifact_pass", "phase=prepared and expected object exists with exact bytes", "phase=commit_created"],
  ]) {
    const row = transitionRows.find(
      ([rowStep, rowCondition]) => rowStep === step && rowCondition.includes(condition),
    );
    if (!row || !row[2].includes(action)) {
      errors.push(`03-technical-plan.md: recovery row missing ${step} ${condition}`);
    }
  }
  const invalidationFragments = [
    "phase=prepared and expected object absent",
    "phase=commit_created and expected object absent",
    "phase=commit_created and ref=expected parent",
    "phase=prepared or phase=commit_created and ref=expected commit",
    "phase=ref_advanced and current bindings drifted",
    "phase=ref_advanced and current bindings exact",
    "phase=verified, candidate_keepalive phase=released, anchor_rebuild_op phase=release_pending",
    "phase=voided_before_ref",
    "unknown/ABA transition",
    "claimed durable recipe/object/ref/reflog/receipt missing",
  ];
  for (const fragment of invalidationFragments) {
    if (transitionIndex("publish_planning_invalidation", fragment) < 0) {
      errors.push(`03-technical-plan.md: invalidation phase row missing ${fragment}`);
    }
  }
  const invalidationPreDrift = transitionIndex("publish_planning_invalidation", "pre-CAS impact/anchor/projection drift");
  const invalidationWrite = transitionIndex("publish_planning_invalidation", "phase=prepared and expected object absent");
  const invalidationPostDrift = transitionIndex("publish_planning_invalidation", "phase=ref_advanced and current bindings drifted");
  const invalidationExact = transitionIndex("publish_planning_invalidation", "phase=ref_advanced and current bindings exact");
  if (invalidationPreDrift < 0 || invalidationPreDrift > invalidationWrite ||
      invalidationPostDrift < 0 || invalidationPostDrift > invalidationExact) {
    errors.push("03-technical-plan.md: invalidation drift guards must precede normal phase side effects");
  }
  if (!plan.includes("publish_planning_invalidation according to recorded operation_type")) {
    errors.push("03-technical-plan.md: invalidation foreign-movement resume target missing");
  }
  const publishSelectRows = transitionRows.filter(
    ([step, , action]) => step === "publish_artifact_pass" && /[,;]\s*select_next$/u.test(action),
  );
  const verifiedPublishTransition = ([, condition, action]) => {
    const selectIndex = action.lastIndexOf("select_next");
    if (!/[,;]\s*select_next$/u.test(action)) return false;
    if (condition.includes("phase=verified")) {
      return action.includes("read-back") && selectIndex > action.indexOf("read-back");
    }
    return condition.includes("phase=ref_advanced") &&
      action.includes("atomically phase=verified") &&
      action.includes("publication_status=verified") &&
      selectIndex > action.indexOf("atomically phase=verified") &&
      selectIndex > action.indexOf("publication_status=verified");
  };
  if (publishSelectRows.length !== 1 || publishSelectRows.some((row) => !verifiedPublishTransition(row)) ||
      !publishSelectRows[0][1].includes("candidate_keepalive phase=released")) {
    errors.push("03-technical-plan.md: publish_artifact_pass requires verified publication before select_next");
  }
  let expectedPipes = null;
  for (const line of plan.split("\n")) {
    if (!line.trim().startsWith("|")) {
      expectedPipes = null;
      continue;
    }
    let pipes = 0;
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] === "\\") {
        index += 1;
        continue;
      }
      if (line[index] === "|") pipes += 1;
    }
    if (expectedPipes === null) expectedPipes = pipes;
    if (pipes !== expectedPipes) {
      errors.push("03-technical-plan.md transition table must keep exactly three columns");
      break;
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
  const planningParkReasons = [
    "planning_ref_init_invalid",
    "planning_ref_capability_missing",
    "planning_ref_foreign_movement",
    "planning_candidate_keepalive_invalid",
    "planning_candidate_base_stale",
    "planning_publication_invalid",
    "planning_publication_corrupt",
    "planning_signing_unavailable",
  ];
  const technicalResume = plan.split("Resume contract:")[1] ?? "";
  const coreResume = core.split("## 8. Возобновление из human")[1] ?? "";
  for (const reason of planningParkReasons) {
    if (!technicalResume.includes(`| ${reason} |`) || !coreResume.includes(`| ${reason} |`)) {
      errors.push(`planning resume catalogs missing ${reason}`);
    }
  }
  for (const reason of [
    "planning_ref_capability_missing",
    "planning_ref_foreign_movement",
    "planning_candidate_keepalive_invalid",
  ]) {
    const technicalRow = technicalResume.split("\n").find((line) => line.startsWith(`| ${reason} |`));
    const coreRow = coreResume.split("\n").find((line) => line.startsWith(`| ${reason} |`));
    const technicalTarget = technicalRow?.split("|")[2]?.trim();
    const coreTarget = coreRow?.split("|")[2]?.trim();
    if (technicalTarget !== coreTarget) {
      errors.push(`planning resume catalogs disagree on targets for ${reason}`);
    }
  }
  if (/"epic_id":\s*"epic-001"/u.test(plan)) {
    errors.push("03-technical-plan.md: Epic metadata must use UUID epic_id, not display slug");
  }
  const unsupportedArtifactVoid = /artifact(?:_pass| PASS)\s*(?:(?:\.\s*[a-z_]+)|(?:\[[^\]\r\n]+\]))?\s*=\s*`?void`?/iu;
  if (unsupportedArtifactVoid.test(plan) || unsupportedArtifactVoid.test(files["docs/contracts/epic-planning-ref.md"] ?? "")) {
    errors.push("unsupported ArtifactPassRecord void state; use publication_status=voided_before_ref");
  }
  const publishedPassFragments = [
    "publication_status=verified",
    "matching immutable `planning.publication_history` record phase=verified",
    "published_commit_oid",
    "published tree",
    "live private planning ref",
    "first-parent chain",
    "recorded candidate tree",
    "current publication/rebinding chain",
  ];
  const plannedGuard = plan.split("\n").find((line) => line.startsWith("- Planned implementation запрещён")) ?? "";
  const ticketsGuard = plan.split("\n").find((line) => line.startsWith("- Tickets не исполняются")) ?? "";
  if (!publishedPassFragments.every((fragment) => plannedGuard.includes(fragment))) {
    errors.push("03-technical-plan.md: Planned implementation guard must require Published PASS");
  }
  if (!publishedPassFragments.every((fragment) => ticketsGuard.includes(fragment))) {
    errors.push("03-technical-plan.md: Tickets guard must require Published PASS");
  }
  if (plan.includes("published commit/tree совпадают с live private planning ref/head") ||
      (files["docs/contracts/epic-planning-ref.md"] ?? "")
        .includes("live planning ref still equals its published commit")) {
    errors.push("planning kind completion must use first-parent reachability, not live-head equality");
  }
  for (const fragment of [
    "last_verified_reflog_tail",
    "same-OID ABA between closed operations",
    "planning.init_history",
    "planning.publication_history",
    "planning.rebuild_history",
    "records immediate target=`publish_planning_invalidation`",
    "candidate_keepalive_op phase=prepared",
    "complete commit/tree/blob closure",
    "candidate_keepalive phase=released",
    "candidate_audit_transfer_op phase=prepared",
    "phase=audit_ref_verified",
    "ref custody ownership/mode/generation drift",
    "anchor_rebuild_op phase=release_pending",
    "phase=audit_retained",
    "packed-refs contains refs/autosk",
    "src/git/ref-custody-helper.ts",
  ]) {
    if (!plan.includes(fragment)) errors.push(`03-technical-plan.md: missing closed planning invariant ${fragment}`);
  }
  for (const [relative, text] of Object.entries(files)) {
    if (/refs\/autosk\/epics\/<(?:epic-uuid|uuid)>\/planning/u.test(text)) {
      errors.push(`${relative}: planning ref still uses display/UUID placeholder instead of epic_ref_key`);
    }
  }

  const contract = files["docs/contracts/epic-planning-ref.md"] ?? "";
  for (const fragment of [
    "reachable on the live planning ref first-parent chain",
    "before every planning gate and before minting a new operation",
    "autosk-flow/verdict-or-waiver/v1\\0",
    "autosk-flow/previous-projection/v1\\0",
    "No model-authored bytes enter the v1 commit object",
    "intentionally operation-only",
    "Git GC cannot prune the complete candidate object closure",
    "candidate-keepalive-receipt/v1\\0",
    "verify <candidate_keepalive_ref> <snapshot_commit_oid>",
    "candidate-audit-transfer-operation.schema.json",
    "prepared -> audit_ref_verified -> live_ref_deleted -> verified",
    "planning_reflog_tail_observation_sha256",
    "autosk-flow/ref-custody-policy/v1\\0",
    "permission denied",
    "candidate-keepalive-operation.schema.json",
    "gc.packRefs=false",
    "publish-artifact-pass-operation.released.example.json",
    "candidate-keepalive-operation.released.example.json",
    "ref-custody-helper-contract.schema.json",
    "ref-custody-helper-wire.schema.json",
  ]) {
    if (!contract.includes(fragment)) errors.push(`planning-ref contract missing ${fragment}`);
  }
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

  const parseResource = (relative) => {
    try {
      return JSON.parse(files[relative]);
    } catch (error) {
      throw new Error(`${relative}: ${error.message}`);
    }
  };
  try {
    const schema = parseResource(
      "resources/planning-publication/publish-artifact-pass-operation.schema.json",
    );
    const example = parseResource(
      "resources/planning-publication/publish-artifact-pass-operation.example.json",
    );
    const invalidationExample = parseResource(
      "resources/planning-publication/publish-planning-invalidation-operation.example.json",
    );
    const initSchema = parseResource(
      "resources/planning-publication/init-planning-ref-operation.schema.json",
    );
    const initExample = parseResource(
      "resources/planning-publication/init-planning-ref-operation.example.json",
    );
    const keepaliveSchema = parseResource(
      "resources/planning-publication/candidate-keepalive-operation.schema.json",
    );
    const keepaliveExample = parseResource(
      "resources/planning-publication/candidate-keepalive-operation.example.json",
    );
    const keepaliveAuditExample = parseResource(
      "resources/planning-publication/candidate-keepalive-operation.audit-retained.example.json",
    );
    const keepaliveReleasedExample = parseResource(
      "resources/planning-publication/candidate-keepalive-operation.released.example.json",
    );
    const keepalivePreparedExample = parseResource(
      "resources/planning-publication/candidate-keepalive-operation.prepared.example.json",
    );
    const keepaliveRefCreatedExample = parseResource(
      "resources/planning-publication/candidate-keepalive-operation.ref-created.example.json",
    );
    const releasedExample = parseResource(
      "resources/planning-publication/publish-artifact-pass-operation.released.example.json",
    );
    const voidedExample = parseResource(
      "resources/planning-publication/publish-artifact-pass-operation.voided.example.json",
    );
    const custodyContractSchema = parseResource(
      "resources/planning-publication/ref-custody-helper-contract.schema.json",
    );
    const custodyContractExample = parseResource(
      "resources/planning-publication/ref-custody-helper-contract.example.json",
    );
    const custodyWireSchema = parseResource(
      "resources/planning-publication/ref-custody-helper-wire.schema.json",
    );
    const custodyWireExample = parseResource(
      "resources/planning-publication/ref-custody-helper-wire.example.json",
    );
    const custodyWireNotAppliedExample = parseResource(
      "resources/planning-publication/ref-custody-helper-wire.not-applied.example.json",
    );
    const custodyWireInvalidationExample = parseResource(
      "resources/planning-publication/ref-custody-helper-wire.invalidation.example.json",
    );
    const custodyWireExistingAuditExample = parseResource(
      "resources/planning-publication/ref-custody-helper-wire.existing-audit.example.json",
    );
    const custodyJournalPrefixes = parseResource(
      "resources/planning-publication/ref-custody-helper-journal-prefixes.example.json",
    );
    const custodyJournalCrashExample = parseResource(
      "resources/planning-publication/ref-custody-helper-journal-crash.example.json",
    );
    const supersessionSchema = parseResource(
      "resources/planning-publication/candidate-supersession-operation.schema.json",
    );
    const supersessionExample = parseResource(
      "resources/planning-publication/candidate-supersession-operation.example.json",
    );
    const housekeepingSchema = parseResource(
      "resources/planning-publication/audit-candidate-housekeeping-operation.schema.json",
    );
    const housekeepingExample = parseResource(
      "resources/planning-publication/audit-candidate-housekeeping-operation.example.json",
    );
    const supplementalContracts = [
      ["candidate audit transfer", "candidate-audit-transfer-operation.schema.json", "candidate-audit-transfer-operation.example.json"],
      ["candidate closure pack", "candidate-closure-pack-operation.schema.json", "candidate-closure-pack-operation.example.json"],
      ["invalidation closure pack", "candidate-closure-pack-operation.schema.json", "candidate-closure-pack-operation.invalidation.example.json"],
      ["atomic PASS API", "record-pass-prepare-publication.schema.json", "record-pass-prepare-publication.example.json"],
      ["publication rebinding", "planning-publication-rebinding.schema.json", "planning-publication-rebinding.example.json"],
      ["helper intents", "ref-custody-helper-intents.schema.json", "ref-custody-helper-intents.example.json"],
      ["ref custody policy", "ref-custody-policy.schema.json", "ref-custody-policy.example.json"],
    ].map(([label, schemaName, exampleName]) => [label, parseResource(`resources/planning-publication/${schemaName}`), parseResource(`resources/planning-publication/${exampleName}`)]);
    for (const [label, supplementalSchema, supplementalExample] of supplementalContracts) {
      for (const error of validateJsonSchema(supplementalExample, supplementalSchema, supplementalSchema)) {
        errors.push(`${label} Schema/example: ${error}`);
      }
    }
    const custodyPolicy = supplementalContracts.find(([label]) => label === "ref custody policy")?.[2];
    const topologyHash = sha256("autosk-flow/ref-custody-policy-parent-topology/v1\0" + canonicalStringify(custodyPolicy.parent_topology));
    const probeHash = sha256("autosk-flow/ref-custody-policy-permission-probes/v1\0" + canonicalStringify(custodyPolicy.permission_probes));
    const packedPolicyHash = sha256("autosk-flow/ref-custody-policy-packed-refs/v1\0" + canonicalStringify(custodyPolicy.packed_refs_policy));
    const { policy_digest: ignoredPolicyDigest, ...policyPreimage } = custodyPolicy;
    const policyDigest = sha256("autosk-flow/ref-custody-policy/v1\0" + canonicalStringify(policyPreimage));
    if (custodyPolicy.parent_topology_hash !== topologyHash ||
        custodyPolicy.permission_probe_hash !== probeHash ||
        custodyPolicy.packed_refs_policy_hash !== packedPolicyHash ||
        custodyPolicy.policy_digest !== policyDigest) {
      errors.push("ref custody policy digest mismatch");
    }
    const platformNames = custodyPolicy.supported_platforms.map((profile) => profile.platform);
    const probeOperations = custodyPolicy.permission_probes.map((probe) => probe.operation);
    const topologyRoles = custodyPolicy.parent_topology.map((entry) => entry.path_role);
    if (canonicalStringify(platformNames) !== canonicalStringify(["linux", "macos"]) ||
        new Set(probeOperations).size !== 3 || new Set(topologyRoles).size !== 2 ||
        !custodyPolicy.supported_platforms.some((profile) =>
          profile.platform === custodyPolicy.platform &&
          profile.peer_credential_api === custodyPolicy.socket.peer_credential_api)) {
      errors.push("ref custody policy platform, probe or topology matrix mismatch");
    }
    const transferExample = supplementalContracts.find(([label]) => label === "candidate audit transfer")?.[2];
    for (const [field, domain, keyName] of [
      ["audit_ref_receipt", "autosk-flow/audit-transfer/audit-ref/v1\0", "ensure_audit_ref"],
      ["live_delete_receipt", "autosk-flow/audit-transfer/live-delete/v1\0", "delete_live_ref"],
      ["verification_receipt", "autosk-flow/audit-transfer/verification/v1\0", null],
    ]) {
      const { receipt_hash: ignored, ...receipt } = transferExample[field];
      const preimage = { operation_id: transferExample.operation_id, object_format: transferExample.object_format, ensure_audit_intent_key: transferExample.ensure_audit_intent_key, delete_live_intent_key: transferExample.delete_live_intent_key, ...receipt };
      if (keyName === "ensure_audit_ref") preimage.helper_intent_key = transferExample.ensure_audit_intent_key;
      if (keyName === "delete_live_ref") preimage.helper_intent_key = transferExample.delete_live_intent_key;
      if (transferExample[field].receipt_hash !== sha256(domain + canonicalStringify(preimage))) errors.push(`candidate audit transfer ${field} digest mismatch`);
    }
    const validateClosurePackDigest = (record, label) => {
      const sortedOids = [...record.object_oids].sort(codePointCompare);
      const manifestObjects = record.object_manifest?.objects ?? [];
      const sortedManifestObjects = [...manifestObjects].sort((left, right) => codePointCompare(left.oid, right.oid));
      const objectSetHash = sha256("autosk-flow/candidate-closure-pack/object-set/v1\0" + canonicalStringify(sortedOids));
      const objectManifestHash = sha256("autosk-flow/candidate-closure-pack/manifest/v1\0" + canonicalStringify(record.object_manifest));
      const writeReceiptHash = sha256("autosk-flow/candidate-closure-pack/write/v1\0" + canonicalStringify({ operation_id: record.operation_id, candidate_identity: record.candidate_identity, object_manifest_sha256: record.object_manifest_sha256, pack_bytes_sha256: record.pack_bytes_sha256, index_bytes_sha256: record.index_bytes_sha256, content_addressed_locator: record.content_addressed_locator, git_producer: record.git_producer, write_order: record.write_receipt?.write_order }));
      const verificationReceiptHash = sha256("autosk-flow/candidate-closure-pack/verify/v1\0" + canonicalStringify({ operation_id: record.operation_id, candidate_identity: record.candidate_identity, object_manifest_sha256: record.object_manifest_sha256, pack_bytes_sha256: record.pack_bytes_sha256, index_bytes_sha256: record.index_bytes_sha256, write_receipt_hash: record.write_receipt?.receipt_hash, git_verify_pack: record.verification_receipt?.git_verify_pack, recovery_phases: record.recovery_phases }));
      const oidWidth = record.object_format === "sha256" ? 64 : 40;
      if (canonicalStringify(record.object_oids) !== canonicalStringify(sortedOids) ||
          canonicalStringify(manifestObjects) !== canonicalStringify(sortedManifestObjects) ||
          canonicalStringify(manifestObjects.map((item) => item.oid)) !== canonicalStringify(sortedOids) ||
          record.object_count !== record.object_oids.length ||
          !record.object_oids.includes(record.snapshot_commit_oid) || !record.object_oids.includes(record.candidate_tree_oid) ||
          record.object_oids.some((oid) => oid.length !== oidWidth) ||
          manifestObjects.some((entry) => entry.oid.length !== oidWidth) ||
          record.object_manifest_sha256 !== objectManifestHash ||
          record.object_oid_set_sha256 !== objectSetHash ||
          sha256(Buffer.from(record.pack_bytes_base64, "base64")) !== record.pack_bytes_sha256 ||
          sha256(Buffer.from(record.index_bytes_base64, "base64")) !== record.index_bytes_sha256 ||
          record.content_addressed_locator.pack_content_address !== record.pack_bytes_sha256 ||
          record.content_addressed_locator.pack_relative_path !== `objects/pack/autosk-candidates/${record.candidate_identity}/pack-${record.pack_bytes_sha256}.pack` ||
          record.content_addressed_locator.index_relative_path !== `objects/pack/autosk-candidates/${record.candidate_identity}/pack-${record.pack_bytes_sha256}.idx` ||
          record.git_producer.object_format !== record.object_format ||
          record.write_receipt?.receipt_hash !== writeReceiptHash || record.verification_receipt?.receipt_hash !== verificationReceiptHash) errors.push(`${label} exact manifest, bytes, durable write or digest mismatch`);
    };
    validateClosurePackDigest(supplementalContracts.find(([label]) => label === "candidate closure pack")?.[2], "candidate closure pack");
    validateClosurePackDigest(supplementalContracts.find(([label]) => label === "invalidation closure pack")?.[2], "invalidation closure pack");
    const atomicApi = supplementalContracts.find(([label]) => label === "atomic PASS API")?.[2];
    { const { receipt_hash: ignored, ...response } = atomicApi.response; if (atomicApi.response.receipt_hash !== sha256("autosk-flow/record-pass-prepare-publication/v1\0" + canonicalStringify({ capability: atomicApi.capability, request: atomicApi.request, response }))) errors.push("atomic PASS API receipt digest mismatch"); }
    if (atomicApi.request.artifact_kind !== example.payload.artifact_kind || atomicApi.request.candidate_identity !== example.candidate_keepalive.candidate_identity || atomicApi.request.publication_operation_id !== example.operation_id) errors.push("atomic PASS API does not match the referenced publication operation");
    const decodeCanonicalJson = (base64, label) => {
      try {
        const bytes = Buffer.from(base64, "base64");
        const parsed = JSON.parse(bytes.toString("utf8"));
        if (bytes.toString("utf8") !== canonicalStringify(parsed)) errors.push(`atomic PASS ${label} bytes are not canonical JSON`);
        return { bytes, parsed };
      } catch {
        errors.push(`atomic PASS ${label} exact bytes are invalid`);
        return { bytes: Buffer.alloc(0), parsed: null };
      }
    };
    const passBytes = decodeCanonicalJson(atomicApi.request.pass_record_bytes_base64, "ArtifactPassRecord");
    const publicationBytes = decodeCanonicalJson(atomicApi.request.publication_operation_bytes_base64, "publication operation");
    const intentBytes = decodeCanonicalJson(atomicApi.request.prepared_helper_intents_bytes_base64, "prepared helper intents");
    const casBytes = decodeCanonicalJson(atomicApi.request.metadata_cas_payload_base64, "metadata CAS payload");
    const idempotencyKey = sha256("autosk-flow/record-pass-idempotency/v1\0" + canonicalStringify({ request_id: atomicApi.request.request_id, expected_metadata_head: atomicApi.request.expected_metadata_head, metadata_cas_payload_sha256: atomicApi.request.metadata_cas_payload_sha256 }));
    const outcomeStatuses = atomicApi.outcome_contracts.map((item) => item.status);
    if (canonicalStringify(outcomeStatuses) !== canonicalStringify(["committed", "conflict", "unsupported", "replay", "indeterminate"]) ||
        sha256(passBytes.bytes) !== atomicApi.request.pass_record_bytes_sha256 || atomicApi.request.pass_record_digest !== atomicApi.request.pass_record_bytes_sha256 ||
        sha256(publicationBytes.bytes) !== atomicApi.request.publication_operation_bytes_sha256 || atomicApi.request.publication_preimage_digest !== atomicApi.request.publication_operation_bytes_sha256 ||
        sha256(intentBytes.bytes) !== atomicApi.request.prepared_helper_intents_bytes_sha256 ||
        sha256(casBytes.bytes) !== atomicApi.request.metadata_cas_payload_sha256 || atomicApi.request.idempotency_key !== idempotencyKey ||
        canonicalStringify(publicationBytes.parsed) !== canonicalStringify(example) ||
        passBytes.parsed?.candidate_identity !== atomicApi.request.candidate_identity || passBytes.parsed?.artifact_kind !== atomicApi.request.artifact_kind || passBytes.parsed?.disposition !== "pass" ||
        !Array.isArray(intentBytes.parsed) || canonicalStringify(intentBytes.parsed.map((record) => record.intent_key)) !== canonicalStringify(atomicApi.request.helper_intent_keys) ||
        canonicalStringify(casBytes.parsed?.pass_record) !== canonicalStringify(passBytes.parsed) ||
        canonicalStringify(casBytes.parsed?.planning_publication_operation) !== canonicalStringify(publicationBytes.parsed) ||
        canonicalStringify(casBytes.parsed?.helper_intent_records) !== canonicalStringify(intentBytes.parsed) ||
        sha256(Buffer.from(casBytes.parsed?.candidate_projection_bytes_base64 ?? "", "base64")) !== casBytes.parsed?.candidate_projection_sha256 ||
        atomicApi.response.outcome_contract !== atomicApi.outcome_contracts.find((item) => item.status === atomicApi.response.status)?.retry_contract) {
      errors.push("atomic PASS exact CAS bundle, outcomes or idempotency binding mismatch");
    }
    const rebind = supplementalContracts.find(([label]) => label === "publication rebinding")?.[2];
    {
      const { receipt_hash: ignored, ...preimage } = rebind;
      const impactDigest = sha256("autosk-flow/planning-publication-rebinding/impact/v1\0" + canonicalStringify(rebind.approved_impact));
      const projectionBytes = Buffer.from(rebind.projection_bytes_base64, "base64");
      if (rebind.new_anchor_version <= rebind.old_anchor_version) errors.push("publication rebinding anchor versions must increase");
      if (rebind.receipt_hash !== sha256("autosk-flow/planning-publication-rebinding/v1\0" + canonicalStringify(preimage)) ||
          rebind.epic_ref_key !== deriveEpicRefKey(rebind.project_root_sha256, rebind.epic_id) ||
          rebind.project_root_sha256 !== example.project_root_sha256 || rebind.epic_id !== example.epic_id ||
          rebind.publication_operation_id !== example.operation_id || rebind.prior_publication_receipt_hash !== releasedExample.receipts.verification.receipt_hash ||
          rebind.old_published_commit_oid !== example.expected_parent_oid || rebind.old_published_tree_oid !== example.expected_parent_tree_oid ||
          rebind.current_planning_head_oid !== example.expected_commit_oid || rebind.expected_prior_head_oid !== rebind.old_published_commit_oid ||
          rebind.unchanged_tree_oid !== example.candidate_tree_oid || rebind.unchanged_pathspec_digest !== example.payload.artifact_pathspec_digest ||
          sha256(projectionBytes) !== rebind.projection_blob_sha256 || rebind.projection_blob_mode !== "100644" ||
          rebind.approved_impact_digest !== impactDigest || rebind.approved_impact?.impact !== "unaffected" ||
          rebind.previous_rebinding_hash !== null) {
        errors.push("publication rebinding identity, projection, impact or continuous chain mismatch");
      }
    }
    const closurePack = supplementalContracts.find(([label]) => label === "candidate closure pack")?.[2];
    for (const candidateRecord of [keepaliveExample, keepaliveAuditExample, keepaliveReleasedExample, keepalivePreparedExample, keepaliveRefCreatedExample, example.candidate_keepalive, releasedExample.candidate_keepalive, voidedExample.candidate_keepalive]) {
      if (candidateRecord.closure_pack_operation_id !== closurePack?.operation_id || candidateRecord.closure_pack_receipt_hash !== closurePack?.verification_receipt?.receipt_hash || candidateRecord.candidate_identity !== closurePack?.candidate_identity || candidateRecord.snapshot_commit_oid !== closurePack?.snapshot_commit_oid || candidateRecord.snapshot_tree_oid !== closurePack?.candidate_tree_oid) errors.push("candidate keepalive is not bound to the verified closure pack");
    }
    const invalidationClosurePack = supplementalContracts.find(([label]) => label === "invalidation closure pack")?.[2];
    if (invalidationExample.candidate_keepalive.closure_pack_operation_id !== invalidationClosurePack?.operation_id || invalidationExample.candidate_keepalive.closure_pack_receipt_hash !== invalidationClosurePack?.verification_receipt?.receipt_hash || invalidationExample.candidate_keepalive.candidate_identity !== invalidationClosurePack?.candidate_identity || invalidationExample.candidate_keepalive.snapshot_commit_oid !== invalidationClosurePack?.snapshot_commit_oid || invalidationExample.candidate_keepalive.snapshot_tree_oid !== invalidationClosurePack?.candidate_tree_oid) errors.push("invalidation keepalive is not bound to the verified closure pack");
    const seenCustodyIdentifiers = new Map();
    for (const wire of [
      custodyWireExample,
      custodyWireNotAppliedExample,
      custodyWireInvalidationExample,
      custodyWireExistingAuditExample,
    ]) {
      for (const exchange of wire.actions) {
        for (const [kind, value] of [
          ["request_id", exchange.request.request_id],
          ["nonce", exchange.request.nonce],
        ]) {
          const key = `${kind}:${value}`;
          const previousBody = seenCustodyIdentifiers.get(key);
          if (previousBody && previousBody !== exchange.request.body_sha256) {
            errors.push(`ref-custody ${kind} is reused for a different request body`);
          }
          seenCustodyIdentifiers.set(key, exchange.request.body_sha256);
        }
      }
    }
    const helperIntents = supplementalContracts.find(([label]) => label === "helper intents")?.[2];
    const intentByBody = new Map((helperIntents?.records ?? []).map((record) => [record.request_body_sha256, record]));
    const intentRecords = helperIntents?.records ?? [];
    const intentWireSets = [custodyWireExample, custodyWireInvalidationExample, custodyWireExistingAuditExample];
    const intentExchanges = intentWireSets.flatMap((wire) => wire.actions.map((exchange) => ({ wire, exchange })));
    if (intentRecords.length !== intentExchanges.length || intentByBody.size !== intentRecords.length || new Set(intentRecords.map((record) => record.intent_key)).size !== intentRecords.length || new Set(intentRecords.map((record) => record.request_id)).size !== intentRecords.length || new Set(intentRecords.map((record) => record.nonce)).size !== intentRecords.length) errors.push("helper intent catalog must exactly cover the semantically unique persisted request intents");
    for (const intent of helperIntents?.records ?? []) {
      const observationRefs = intent.pre_execution_observation.map((observation) => observation.ref);
      if (new Set(observationRefs).size !== observationRefs.length) errors.push(`helper intent ${intent.action} contains duplicate observation refs`);
      if (intent.pre_execution_observation.some((observation) => observation.present !== (observation.oid !== null))) errors.push(`helper intent ${intent.action} present/oid mismatch`);
      const match = intentExchanges.find(({ exchange }) => exchange.request.body_sha256 === intent.request_body_sha256);
      const bodyBytes = Buffer.from(intent.request_body_canonical_json_base64 ?? "", "base64");
      const authorizationJsonBytes = Buffer.from(intent.authorization_canonical_json_base64 ?? "", "base64");
      const authorizationSignedBytes = Buffer.from(intent.authorization_signed_bytes_base64 ?? "", "base64");
      const wireRequestBytes = Buffer.from(intent.wire_request_canonical_json_base64 ?? "", "base64");
      let body;
      let authorization;
      let wireRequest;
      try {
        body = JSON.parse(bodyBytes.toString("utf8"));
        authorization = JSON.parse(authorizationJsonBytes.toString("utf8"));
        wireRequest = JSON.parse(wireRequestBytes.toString("utf8"));
      } catch {
        errors.push(`helper intent ${intent.action} exact bytes are not canonical JSON`);
      }
      const intentKey = sha256("autosk-flow/ref-custody-intent-key/v1\0" + canonicalStringify({ action: intent.action, transfer_mode: intent.transfer_mode, owner_operation_id: intent.owner_operation_id, request_body_sha256: intent.request_body_sha256, wire_request_sha256: intent.wire_request_sha256, authorization_sha256: intent.authorization_sha256 }));
      const preconditionHash = sha256("autosk-flow/ref-custody-intent-precondition/v1\0" + canonicalStringify(intent.pre_execution_observation));
      const { persist_receipt_hash: ignored, ...preimage } = intent;
      const persistHash = sha256("autosk-flow/ref-custody-intent-persist/v1\0" + canonicalStringify(preimage));
      let signatureValid = false;
      if (match && body && authorization) {
        try {
          const publicDer = Buffer.from(match.wire.public_key_spki_base64, "base64");
          const publicKey = createPublicKey({ key: publicDer, format: "der", type: "spki" });
          signatureValid = verify(null, authorizationSignedBytes, publicKey, Buffer.from(authorization.signature_base64, "base64"));
        } catch {
          signatureValid = false;
        }
      }
      const expectedBody = match && (() => { const { body_sha256: ignoredHash, authorization: ignoredAuthorization, ...value } = match.exchange.request; return value; })();
      if (!match || canonicalStringify(body) !== canonicalStringify(expectedBody) ||
          canonicalStringify(authorization) !== canonicalStringify(match.exchange.request.authorization) ||
          canonicalStringify(wireRequest) !== canonicalStringify(match.exchange.request) ||
          bodyBytes.toString("utf8") !== canonicalStringify(body) || authorizationJsonBytes.toString("utf8") !== canonicalStringify(authorization) || wireRequestBytes.toString("utf8") !== canonicalStringify(wireRequest) ||
          authorizationSignedBytes.toString("utf8") !== `autosk-flow/ref-custody-authorization/v1\0${intent.request_body_sha256}\0${intent.nonce}` ||
          sha256("autosk-flow/ref-custody/request-body/v1\0" + bodyBytes.toString("utf8")) !== intent.request_body_sha256 ||
          sha256(authorizationJsonBytes.toString("utf8")) !== intent.authorization_sha256 || sha256(wireRequestBytes.toString("utf8")) !== intent.wire_request_sha256 || !signatureValid ||
          intent.intent_key !== intentKey ||
          intent.pre_execution_observation_sha256 !== preconditionHash ||
          intent.helper_journal_hash !== match?.exchange.journal.journal_hash ||
          canonicalStringify(intent.lifecycle) !== canonicalStringify(["prepared", "precondition_committed", "delivered", "receipt_committed"]) ||
          intent.request_persisted_before_socket !== true || intent.helper_precondition_under_lock !== true ||
          intent.persist_receipt_hash !== persistHash) errors.push(`helper intent ${intent.action} exact bytes, authorization, lifecycle or digest mismatch`);
    }
    const ensureTransferIntent = (helperIntents?.records ?? []).find((record) => record.intent_key === transferExample.ensure_audit_intent_key);
    const deleteTransferIntent = (helperIntents?.records ?? []).find((record) => record.intent_key === transferExample.delete_live_intent_key);
    if (!ensureTransferIntent || ensureTransferIntent.action !== "ensure_audit_ref" || ensureTransferIntent.transfer_mode !== "release_to_audit" || ensureTransferIntent.owner_operation_id !== "77777777-7777-4777-8777-777777777777" ||
        !deleteTransferIntent || deleteTransferIntent.action !== "delete_live_ref" || deleteTransferIntent.transfer_mode !== "release_to_audit" || deleteTransferIntent.owner_operation_id !== "77777777-7777-4777-8777-777777777777") errors.push("candidate audit transfer is not bound to its persisted helper intents");
    if (atomicApi.request.helper_intent_keys.some((key) => !(helperIntents?.records ?? []).some((record) => record.intent_key === key))) errors.push("atomic PASS API references an unknown helper intent");
    for (const wire of [custodyWireExample, custodyWireInvalidationExample, custodyWireExistingAuditExample]) {
      for (const exchange of wire.actions) {
        const intent = intentByBody.get(exchange.request.body_sha256);
        const topologyDigest = sha256("autosk-flow/ref-custody-intent-topology/v1\0" + canonicalStringify({ ref_updates: exchange.request.ref_updates, reflog_checkpoints: exchange.request.reflog_checkpoints }));
        if (!intent || intent.action !== exchange.action || intent.owner_operation_id !== exchange.request.operation_id || intent.request_id !== exchange.request.request_id || intent.nonce !== exchange.request.nonce || intent.topology_digest !== topologyDigest || intent.phase !== "receipt_committed") errors.push(`helper intent does not bind ${exchange.action} request lifecycle`);
      }
    }
    for (const error of validatePlanningPublicationOperationExample(example, schema)) {
      errors.push(`planning publication Schema/example: ${error}`);
    }
    for (const error of validatePlanningPublicationOperationExample(invalidationExample, schema)) {
      errors.push(`planning invalidation Schema/example: ${error}`);
    }
    for (const error of validatePlanningRefInitOperationExample(initExample, initSchema)) {
      errors.push(`planning init Schema/example: ${error}`);
    }
    for (const error of validateCandidateKeepaliveOperation(keepaliveExample, keepaliveSchema)) {
      errors.push(`candidate keepalive Schema/example: ${error}`);
    }
    for (const error of validateCandidateKeepaliveOperation(keepaliveAuditExample, keepaliveSchema)) {
      errors.push(`candidate keepalive audit Schema/example: ${error}`);
    }
    for (const error of validateCandidateKeepaliveOperation(keepaliveReleasedExample, keepaliveSchema)) {
      errors.push(`candidate keepalive released Schema/example: ${error}`);
    }
    for (const error of validateCandidateKeepaliveOperation(keepalivePreparedExample, keepaliveSchema)) {
      errors.push(`candidate keepalive prepared Schema/example: ${error}`);
    }
    for (const error of validateCandidateKeepaliveOperation(keepaliveRefCreatedExample, keepaliveSchema)) {
      errors.push(`candidate keepalive ref-created Schema/example: ${error}`);
    }
    for (const error of validatePlanningPublicationOperation(releasedExample, schema)) {
      errors.push(`released publication Schema/example: ${error}`);
    }
    for (const error of validatePlanningPublicationOperation(voidedExample, schema)) {
      errors.push(`voided publication Schema/example: ${error}`);
    }
    for (const error of validateRefCustodyHelperContract(
      custodyContractExample,
      custodyContractSchema,
    )) {
      errors.push(`ref-custody helper Schema/example: ${error}`);
    }
    for (const error of validateRefCustodyHelperWireExamples(custodyWireExample, custodyWireSchema)) {
      errors.push(`ref-custody helper wire Schema/example: ${error}`);
    }
    for (const error of validateRefCustodyHelperWireExamples(custodyWireNotAppliedExample, custodyWireSchema)) {
      errors.push(`ref-custody helper not-applied Schema/example: ${error}`);
    }
    for (const error of validateRefCustodyHelperWireExamples(custodyWireInvalidationExample, custodyWireSchema)) {
      errors.push(`ref-custody helper invalidation Schema/example: ${error}`);
    }
    for (const error of validateRefCustodyHelperWireExamples(custodyWireExistingAuditExample, custodyWireSchema)) {
      errors.push(`ref-custody helper existing-audit Schema/example: ${error}`);
    }
    for (const error of validateRefCustodyJournalPrefixes(custodyJournalPrefixes, custodyWireExample, custodyWireSchema)) {
      errors.push(`ref-custody helper journal prefixes: ${error}`);
    }
    for (const error of validateRefCustodyJournalCrashExample(custodyJournalCrashExample, custodyJournalPrefixes, custodyWireExample)) {
      errors.push(`ref-custody helper journal crash: ${error}`);
    }
    const helperExchanges = [
      ...custodyWireExample.actions,
      ...custodyWireInvalidationExample.actions,
      ...custodyWireExistingAuditExample.actions,
    ];
    const helperExchangeByRequest = new Map(helperExchanges.map((item) => [item.request.request_id, item]));
    const wireByAction = Object.fromEntries(custodyWireExample.actions.map((item) => [item.action, item]));
    const invalidationCreateExchange = custodyWireInvalidationExample.actions[0];
    const helperEvidenceFor = (exchange) => exchange && {
      request_id: exchange.request.request_id,
      nonce: exchange.request.nonce,
      request_body_sha256: exchange.request.body_sha256,
      transaction_value_observation_sha256: exchange.response.transaction_value_observation_sha256,
      helper_receipt_hash: exchange.response.receipt_hash,
      helper_journal_hash: exchange.journal.journal_hash,
    };
    const checkHelperEvidence = (receipt, action, label, requestId = null) => {
      if (!receipt) return;
      const exchange = requestId ? helperExchangeByRequest.get(requestId) : wireByAction[action];
      const expected = helperEvidenceFor(exchange);
      if (canonicalStringify(receipt.helper_evidence) !== canonicalStringify(expected)) {
        errors.push(`${label} helper evidence does not match journaled ${action} receipt`);
      }
    };
    checkHelperEvidence(initExample.receipts.ref_create, "init", "planning init ref_create");
    const panelRetainExchange = custodyWireExistingAuditExample.actions.find((item) =>
      item.action === "ensure_audit_ref" && item.request.transfer_mode === "retain_audit");
    const panelAuditEvidence = keepaliveAuditExample.audit_receipt.helper_evidence;
    if (canonicalStringify(panelAuditEvidence) !== canonicalStringify(helperEvidenceFor(panelRetainExchange))) errors.push("panel_not_pass audit receipt does not use its distinct helper transaction");
    for (const [label, operation] of [
      ["prepared publication", example],
      ["released publication", releasedExample],
      ["voided publication", voidedExample],
      ["planning invalidation", invalidationExample],
    ]) {
      if (operation === invalidationExample) {
        const expected = helperEvidenceFor(invalidationCreateExchange);
        if (canonicalStringify(operation.candidate_keepalive.create_receipt.helper_evidence) !== canonicalStringify(expected)) {
          errors.push(`${label} keepalive create helper evidence does not match invalidation helper receipt`);
        }
      } else {
        checkHelperEvidence(operation.candidate_keepalive.create_receipt, "create_keepalive", `${label} keepalive create`);
      }
      checkHelperEvidence(operation.receipts.ref_cas, "advance_planning", `${label} ref_cas`);
      checkHelperEvidence(operation.candidate_keepalive.release_receipt, "delete_live_ref", `${label} release`);
      if (operation.candidate_keepalive.audit_receipt) {
        checkHelperEvidence(
          operation.candidate_keepalive.audit_receipt,
          operation.candidate_keepalive.audit_receipt.reason === "publication_verified"
            ? "ensure_audit_ref" : "ensure_audit_ref",
          `${label} audit`,
          operation.candidate_keepalive.audit_receipt.helper_evidence?.request_id,
        );
      }
    }
    for (const error of validateCandidateSupersessionOperation(supersessionExample, supersessionSchema)) {
      errors.push(`candidate supersession Schema/example: ${error}`);
    }
    const retainRequest = panelRetainExchange?.request;
    const supersessionBinding = supersessionExample.helper_request_binding;
    if (!retainRequest || supersessionBinding.helper_request_id !== retainRequest.request_id ||
        supersessionBinding.helper_nonce !== retainRequest.nonce ||
        supersessionBinding.helper_request_body_sha256 !== retainRequest.body_sha256 ||
        supersessionBinding.keepalive_operation_id !== retainRequest.operation_id) {
      errors.push("candidate supersession prepared request binding does not match ensure_audit_ref journal request");
    }
    for (const error of validateAuditHousekeepingOperation(housekeepingExample, housekeepingSchema)) {
      errors.push(`audit housekeeping Schema/example: ${error}`);
    }
    const deleteExchange = wireByAction.delete_expired_audit;
    const housekeepingEvidence = housekeepingExample.helper_evidence;
    if (!deleteExchange || housekeepingExample.operation_id !== deleteExchange.request.operation_id ||
        housekeepingExample.audit_ref !== deleteExchange.request.ref_updates[0].ref ||
        housekeepingExample.expected_oid !== deleteExchange.request.ref_updates[0].expected_old_oid ||
        housekeepingEvidence.request_id !== deleteExchange.request.request_id ||
        housekeepingEvidence.nonce !== deleteExchange.request.nonce ||
        housekeepingEvidence.request_body_sha256 !== deleteExchange.request.body_sha256 ||
        housekeepingEvidence.transaction_value_observation_sha256 !==
          deleteExchange.response.transaction_value_observation_sha256 ||
        housekeepingEvidence.helper_receipt_hash !== deleteExchange.response.receipt_hash) {
      errors.push("audit housekeeping operation is not bound to delete_expired_audit journal receipt");
    }
  } catch (error) {
    errors.push(`planning publication resource is not valid JSON: ${error.message}`);
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
