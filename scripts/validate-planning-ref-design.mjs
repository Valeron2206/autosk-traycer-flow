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
    "typed payload",
    "immutable bindings",
    "complete commit_recipe",
    "exact commit bytes",
    "expected commit OID",
    "reflog checkpoint",
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
    "Issue #12",
    "Issue #13",
    "canonical JSON means recursively sorted object keys",
    "autosk-flow/reflog-prefix/v1\\0",
    "autosk-flow/reflog-entry/v1\\0",
    "autosk-flow/planning-observation/v1\\0",
    "autosk-flow/planning-receipt/v1\\0",
    "autosk-flow/planning-commit-recipe/v1\\0",
    "closed v1 bootstrap delivery policy",
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
  ],
  "resources/planning-publication/publish-artifact-pass-operation.example.json": [
    "\"operation_type\": \"artifact_pass\"",
    "\"phase\": \"prepared\"",
    "\"epic_ref_key\"",
    "\"project_instruction_digest\": \"9999999999999999999999999999999999999999999999999999999999999999\"",
    "\"recovery_target_step\": null",
    "\"artifact_pathspec\"",
    "\"ref_storage_format\": \"files\"",
  ],
  "resources/planning-publication/publish-planning-invalidation-operation.example.json": [
    "\"operation_type\": \"anchor_invalidation\"",
    "\"projection_mutations\"",
    "\"recorded_target_step\": \"clarify_alignment\"",
    "\"invalidation_projection_digest\"",
  ],
  "resources/planning-publication/init-planning-ref-operation.schema.json": [
    "\"operation_type\"",
    "\"planning_ref_init\"",
    "\"selected_base_ref\"",
    "\"bootstrap_policy_digest\"",
    "\"ref_create\"",
  ],
  "resources/planning-publication/init-planning-ref-operation.example.json": [
    "\"operation_type\": \"planning_ref_init\"",
    "\"selected_base_ref\": \"refs/heads/main\"",
    "\"phase\": \"verified\"",
    "\"ref_storage_format\": \"files\"",
  ],
});

const SHA256_RE = /^[0-9a-f]{64}$/u;
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
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

function reflogPrefixDigest(entryCount, prefixBytes) {
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

export function planningReceiptHash(operationId, receiptKind, observationSha256) {
  return sha256(
    "autosk-flow/planning-receipt/v1\0" + canonicalStringify({
      schema: 1,
      operation_id: operationId,
      receipt_kind: receiptKind,
      observation_sha256: observationSha256,
    }),
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

function decodeBase64Exact(value, label, errors) {
  if (typeof value !== "string") {
    errors.push(`${label} must be base64 text`);
    return Buffer.alloc(0);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) errors.push(`${label} is not canonical base64`);
  return decoded;
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
    "commit_recipe_digest",
  ]) {
    if (!SHA256_RE.test(example[key] ?? "")) errors.push(`${key} is invalid`);
  }
  if (!SHA256_RE.test(example.project_instruction_digest ?? "")) {
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
  if (example.ref_storage_format !== "files") errors.push("ref_storage_format must be files for raw reflog v1");
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
      if (!signatureBytes.toString("utf8").startsWith("gpgsig ") ||
          !signatureBytes.toString("utf8").endsWith("\n")) {
        errors.push("signature_header_base64 must encode one LF-terminated gpgsig header");
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
  const receiptSlots = ["commit_object", "ref_cas", "reflog_after", "verification"];
  const observationKeys = {
    commit_object: ["object_format", "object_oid", "object_bytes_sha256"],
    ref_cas: ["planning_ref", "expected_old_oid", "observed_new_oid", "expected_update_message"],
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
      if (receipt.receipt_hash !== planningReceiptHash(example.operation_id, slot, observationDigest)) {
        errors.push(`${slot} receipt_hash mismatch`);
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
  if (operation.expected_update_message !== `autosk-flow init ${operation.operation_id}` ||
      operation.reflog_checkpoint?.expected_update_message !== operation.expected_update_message ||
      operation.reflog_checkpoint?.expected_new_oid !== operation.planning_base_oid ||
      operation.reflog_checkpoint?.expected_old_oid !== null) {
    errors.push("init reflog checkpoint does not match containing operation");
  }
  const producer = operation.reflog_producer ?? {};
  if (producer.git_committer_name !== "autosk-flow" ||
      producer.git_committer_email !== "autosk@example.invalid" ||
      producer.git_committer_date !== "@0 +0000") {
    errors.push("init reflog_producer differs from locked bootstrap identity");
  }
  const slots = ["ref_create", "verification"];
  const expectedKeys = {
    ref_create: ["planning_ref", "observed_old_oid", "observed_new_oid", "expected_update_message", "before_entry_count", "after_entry_count", "before_prefix_sha256", "appended_entry_sha256"],
    verification: ["planning_ref", "commit_oid", "tree_oid", "ref_create_receipt_hash"],
  };
  const zeroOid = "0".repeat(operation.object_format === "sha256" ? 64 : 40);
  const expectedObservations = {
    ref_create: {
      planning_ref: operation.planning_ref,
      observed_old_oid: zeroOid,
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
      if (receipt.receipt_hash !== planningReceiptHash(operation.operation_id, slot, digest)) {
        errors.push(`${slot} init receipt_hash mismatch`);
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
  const preparedWriteIndex = transitionIndex("publish_artifact_pass", "phase=prepared and ref=expected parent");
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
    ["phase=voided_before_ref and recovery_target_step=prepare_anchor_impact", "prepare_anchor_impact"],
    ["current binding drift after expected ref transition", "atomically phase=verified"],
    ["phase=commit_created and expected object absent", "rewrite persisted exact commit_object_bytes"],
  ]) {
    const row = transitionRows.find(
      ([step, condition]) => step === "publish_artifact_pass" && condition.includes(conditionFragment),
    );
    if (!row || !row[2].includes(actionFragment) || !row[2].endsWith("prepare_anchor_impact") &&
        conditionFragment.includes("drift after")) {
      errors.push(`03-technical-plan.md: publish_artifact_pass recovery row missing ${conditionFragment}`);
    }
  }
  if (transitionIndex("rebuild_anchor", "matching anchor_invalidation planning_publication_op") < 0) {
    errors.push("03-technical-plan.md: rebuild_anchor publication-operation re-entry is missing");
  }
  const invalidationFragments = [
    "phase=prepared and expected object absent",
    "phase=commit_created and expected object absent",
    "phase=commit_created and ref=expected parent",
    "phase=prepared or phase=commit_created and ref=expected commit",
    "phase=ref_advanced and current bindings drifted",
    "phase=ref_advanced and current bindings exact",
    "phase=verified and effective_target_step",
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
    ([step, , action]) => step === "publish_artifact_pass" && /\bselect_next\b/u.test(action),
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
  if (publishSelectRows.length !== 2 || publishSelectRows.some((row) => !verifiedPublishTransition(row))) {
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
  if (/"epic_id":\s*"epic-001"/u.test(plan)) {
    errors.push("03-technical-plan.md: Epic metadata must use UUID epic_id, not display slug");
  }
  const unsupportedArtifactVoid = /artifact(?:_pass| PASS)(?:(?:\.[a-z_]+)|(?:\[[^\]\r\n]+\]))?\s*=\s*`?void`?/iu;
  if (unsupportedArtifactVoid.test(plan) || unsupportedArtifactVoid.test(files["docs/contracts/epic-planning-ref.md"] ?? "")) {
    errors.push("unsupported ArtifactPassRecord void state; use publication_status=voided_before_ref");
  }
  const publishedPassFragments = [
    "publication_status=verified",
    "matching planning_publication_op phase=verified",
    "published_commit_oid",
    "published tree",
    "live private planning ref",
    "current publication bindings",
  ];
  const plannedGuard = plan.split("\n").find((line) => line.startsWith("- Planned implementation запрещён")) ?? "";
  const ticketsGuard = plan.split("\n").find((line) => line.startsWith("- Tickets не исполняются")) ?? "";
  if (!publishedPassFragments.every((fragment) => plannedGuard.includes(fragment))) {
    errors.push("03-technical-plan.md: Planned implementation guard must require Published PASS");
  }
  if (!publishedPassFragments.every((fragment) => ticketsGuard.includes(fragment))) {
    errors.push("03-technical-plan.md: Tickets guard must require Published PASS");
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
    const invalidationExample = JSON.parse(
      files["resources/planning-publication/publish-planning-invalidation-operation.example.json"],
    );
    const initSchema = JSON.parse(
      files["resources/planning-publication/init-planning-ref-operation.schema.json"],
    );
    const initExample = JSON.parse(
      files["resources/planning-publication/init-planning-ref-operation.example.json"],
    );
    for (const error of validatePlanningPublicationOperationExample(example, schema)) {
      errors.push(`planning publication Schema/example: ${error}`);
    }
    for (const error of validatePlanningPublicationOperationExample(invalidationExample, schema)) {
      errors.push(`planning invalidation Schema/example: ${error}`);
    }
    for (const error of validatePlanningRefInitOperationExample(initExample, initSchema)) {
      errors.push(`planning init Schema/example: ${error}`);
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
