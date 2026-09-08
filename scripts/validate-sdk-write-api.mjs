#!/usr/bin/env node

/**
 * Design-time validator for the issue #38 typed SDK write API.
 *
 * The defect this closes is not that the CLI is slow. It is that a crash after
 * the daemon committed but before the CLI answered leaves an outcome nobody can
 * name, so the checks here are about the two things that remove that ambiguity:
 * a revision the caller expected, and an idempotency key the daemon recognises.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/sdk-write-api.md";
export const TOKEN_SCHEMA_PATH = "resources/sdk-write-api/capability-token.schema.json";
export const OPERATION_SCHEMA_PATH = "resources/sdk-write-api/write-operation.schema.json";
export const TOKEN_EXAMPLE_PATH = "resources/sdk-write-api/capability-token.example.json";
export const OPERATION_EXAMPLE_PATH = "resources/sdk-write-api/write-operation.example.json";
export const REFUSED_EXAMPLE_PATH = "resources/sdk-write-api/write-operation.refused.example.json";
export const CONTRACT_MARKER = "<!-- sdk-write-api-contract:v1 -->";

/** The primitive set. There is no generic mutation verb, deliberately. */
export const VERBS = Object.freeze([
  "create_task",
  "update_metadata",
  "add_blocker",
  "remove_blocker",
  "enroll_child",
  "park_child",
  "resume_child",
  "cancel_child",
  "append_event",
  "transition",
]);

/** Outcomes a caller must be able to tell apart without matching on prose. */
export const ERROR_CODES = Object.freeze([
  "revision_conflict",
  "idempotency_replay",
  "scope_denied",
  "capability_expired",
  "capability_revoked",
  "schema_invalid",
  "transaction_aborted",
  "not_found",
  "precondition_failed",
  "unavailable",
]);

export const REFUSALS = Object.freeze([
  "sdk_generic_mutation",
  "sdk_metadata_schema_invalid",
  "sdk_revision_conflict",
  "sdk_idempotency_violated",
  "sdk_transaction_partial",
  "sdk_scope_violation",
  "sdk_cross_project",
  "sdk_capability_expired",
  "sdk_capability_revoked",
  "sdk_model_capability",
  "sdk_error_code_missing",
  "sdk_cli_diverged",
]);

export function loadFiles() {
  const files = {};
  for (const relative of [
    CONTRACT_PATH,
    TOKEN_SCHEMA_PATH,
    OPERATION_SCHEMA_PATH,
    TOKEN_EXAMPLE_PATH,
    OPERATION_EXAMPLE_PATH,
    REFUSED_EXAMPLE_PATH,
  ]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sdkDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

export function validateToken(token, schema, { nowMs } = {}) {
  const errors = validateJsonSchema(token, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  if (token.holder.kind === "model_process") {
    // A model process that could mint writes could mint them for anything the
    // token allows, so it does not hold one. Absent, not forbidden.
    errors.push("sdk_model_capability: a model process holds a write capability");
  }
  if (token.state === "revoked") errors.push("sdk_capability_revoked");
  if (token.state === "expired") errors.push("sdk_capability_expired");
  if (nowMs !== undefined && token.expires_at_ms <= nowMs && token.state === "active") {
    errors.push("sdk_capability_expired: the token is past its expiry and still recorded active");
  }
  for (const field of token.fields) {
    if (field.includes("*")) {
      errors.push(`sdk_generic_mutation: the field set contains the wildcard ${field}`);
    }
  }
  for (const verb of token.verbs) {
    if (!VERBS.includes(verb)) errors.push(`sdk_generic_mutation: ${verb} is not a primitive`);
  }
  return errors;
}

export function validateOperation(operation, token, schema, { nowMs } = {}) {
  const errors = validateJsonSchema(operation, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  if (operation.token_id !== token.token_id) {
    errors.push(`sdk_scope_violation: the operation cites ${operation.token_id}`);
  }
  if (operation.project_identity !== token.project_identity) {
    // Cross-project access is impossible by construction, and this is where the
    // construction is checked.
    errors.push("sdk_cross_project: the operation names another project");
  }
  if (operation.task_id !== token.task_id) {
    errors.push(`sdk_scope_violation: ${operation.task_id} is outside the token's task`);
  }
  if (token.state !== "active") {
    errors.push(`sdk_capability_${token.state}: the token is ${token.state}`);
  }
  if (nowMs !== undefined && token.expires_at_ms <= nowMs) {
    errors.push("sdk_capability_expired: the token had expired when the write was attempted");
  }

  for (const write of operation.writes) {
    if (!token.verbs.includes(write.verb)) {
      errors.push(`sdk_scope_violation: ${write.verb} is not among the token's verbs`);
    }
    for (const field of write.fields) {
      if (!token.fields.includes(field)) {
        errors.push(`sdk_scope_violation: ${field} is outside the token's field set`);
      }
    }
    if (write.verb === "update_metadata") {
      if (write.expected_revision === undefined) {
        errors.push("sdk_revision_conflict: a metadata update carries the revision it expected");
      } else if (
        write.observed_revision !== undefined &&
        write.expected_revision !== write.observed_revision &&
        write.applied
      ) {
        // Never a silent overwrite.
        errors.push(`sdk_revision_conflict: expected ${write.expected_revision}, observed ${write.observed_revision}`);
      }
      if (write.metadata_valid === false && write.applied) {
        errors.push("sdk_metadata_schema_invalid: metadata that failed daemon-side validation was applied");
      }
    }
    if (write.verb === "create_task" && (!write.creation_key || !write.creation_binding_hash)) {
      errors.push("sdk_scope_violation: a create carries its creation key and binding hash");
    }
  }

  if (operation.atomic) {
    const applied = operation.writes.filter((write) => write.applied).length;
    if (applied !== 0 && applied !== operation.writes.length) {
      // A partial batch is worse than a failed one: the caller's next decision
      // is based on a state that matches neither branch.
      errors.push(`sdk_transaction_partial: ${applied} of ${operation.writes.length} writes applied`);
    }
  }

  if (operation.outcome.state === "replayed") {
    if (!operation.replay_of) {
      errors.push("sdk_idempotency_violated: a replay names the operation it repeats");
    }
    if (operation.writes.some((write) => write.applied)) {
      // A retry under the same key returns the same outcome and performs no
      // second effect.
      errors.push("sdk_idempotency_violated: a replay applied a second effect");
    }
  }
  if (operation.outcome.state !== "applied" && operation.outcome.state !== "replayed") {
    if (!operation.outcome.error_code) {
      // A caller that has to match on message text breaks when the message
      // improves.
      errors.push(`sdk_error_code_missing: ${operation.outcome.state} carries no machine code`);
    }
    if (operation.outcome.error_code === "revision_conflict" && !operation.outcome.conflicting_identity) {
      errors.push("sdk_error_code_missing: a conflict names what it conflicts with");
    }
  }
  return errors;
}

export function validateSdkDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  for (const relative of [TOKEN_SCHEMA_PATH, OPERATION_SCHEMA_PATH]) {
    if (!contract.includes(relative)) errors.push(`${CONTRACT_PATH}: does not point at ${relative}`);
  }
  for (const refusal of REFUSALS) {
    if (!contract.includes(refusal)) errors.push(`${CONTRACT_PATH}: refusal ${refusal} is not documented`);
  }
  for (const code of ERROR_CODES) {
    if (!contract.includes(code)) errors.push(`${CONTRACT_PATH}: error code ${code} is not documented`);
  }
  if (!contract.includes("leaves an outcome nobody can name")) {
    errors.push(`${CONTRACT_PATH}: does not state the defect the typed API closes`);
  }
  if (!contract.includes("No generic JSON mutation is offered")) {
    errors.push(`${CONTRACT_PATH}: does not state that there is no arbitrary patch endpoint`);
  }
  if (!contract.includes("never to model tools")) {
    errors.push(`${CONTRACT_PATH}: does not state who may hold a capability`);
  }
  if (!contract.includes("over the same API")) {
    errors.push(`${CONTRACT_PATH}: does not state what happens to the CLI`);
  }

  let tokenSchema;
  let operationSchema;
  try {
    tokenSchema = JSON.parse(files[TOKEN_SCHEMA_PATH]);
    operationSchema = JSON.parse(files[OPERATION_SCHEMA_PATH]);
  } catch (error) {
    return [...errors, `schemas: not valid JSON: ${error.message}`];
  }
  for (const [relative, schema] of [
    [TOKEN_SCHEMA_PATH, tokenSchema],
    [OPERATION_SCHEMA_PATH, operationSchema],
  ]) {
    if (schema.additionalProperties !== false) {
      errors.push(`${relative}: root must be closed (additionalProperties:false)`);
    }
  }
  const tokenVerbs = tokenSchema.properties?.verbs?.items?.enum ?? [];
  const writeVerbs = operationSchema.properties?.writes?.items?.properties?.verb?.enum ?? [];
  for (const [relative, verbs] of [
    [TOKEN_SCHEMA_PATH, tokenVerbs],
    [OPERATION_SCHEMA_PATH, writeVerbs],
  ]) {
    if (verbs.slice().sort().join(",") !== [...VERBS].sort().join(",")) {
      errors.push(`${relative}: the verb set must be exactly the primitives, with no generic mutation`);
    }
  }
  const codes = operationSchema.properties?.outcome?.properties?.error_code?.enum ?? [];
  if (codes.slice().sort().join(",") !== [...ERROR_CODES].sort().join(",")) {
    errors.push(`${OPERATION_SCHEMA_PATH}: the machine error codes must match the contract exactly`);
  }
  for (const field of ["idempotency_key", "provenance", "token_id"]) {
    if (!(operationSchema.required ?? []).includes(field)) {
      errors.push(`${OPERATION_SCHEMA_PATH}: ${field} must be required on every write`);
    }
  }
  const fields = tokenSchema.properties?.fields ?? {};
  if (fields.minItems !== 1) {
    errors.push(`${TOKEN_SCHEMA_PATH}: a token names at least one field, never an empty or open set`);
  }

  let token;
  try {
    token = JSON.parse(files[TOKEN_EXAMPLE_PATH]);
  } catch (error) {
    return [...errors, `${TOKEN_EXAMPLE_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...validateToken(token, tokenSchema).map((message) => `${TOKEN_EXAMPLE_PATH}: ${message}`));

  for (const relative of [OPERATION_EXAMPLE_PATH, REFUSED_EXAMPLE_PATH]) {
    let operation;
    try {
      operation = JSON.parse(files[relative]);
    } catch (error) {
      errors.push(`${relative}: not valid JSON: ${error.message}`);
      continue;
    }
    const found = validateOperation(operation, token, operationSchema);
    if (relative === OPERATION_EXAMPLE_PATH) {
      errors.push(...found.map((message) => `${relative}: ${message}`));
    } else if (found.length === 0) {
      errors.push(`${relative}: the refused example is accepted`);
    }
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateSdkDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const token = JSON.parse(files[TOKEN_EXAMPLE_PATH]);
    const operationSchema = JSON.parse(files[OPERATION_SCHEMA_PATH]);
    const refused = validateOperation(JSON.parse(files[REFUSED_EXAMPLE_PATH]), token, operationSchema);
    console.log("SDK write API design validation PASS");
    console.log(`design_digest=${sdkDesignDigest(files)}`);
    console.log(`verbs=${VERBS.length} error_codes=${ERROR_CODES.length} refusals=${REFUSALS.length} refused_example_findings=${refused.length}`);
  }
}
