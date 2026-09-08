#!/usr/bin/env node

/**
 * Design-time validator for the issue #18 structured model result.
 *
 * The invariant is one sentence — a model's output is evidence, not an effect —
 * and every check here defends a way it could stop being true: a role that can
 * mutate task state, a result that names its own next step, a tool failure
 * mapped to a product verdict, a batch that claims a pass without the proofs
 * that would make the claim checkable.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/model-result.md";
export const SCHEMA_PATH = "resources/model-result/model-result.schema.json";
export const CAPABILITIES_PATH = "resources/model-result/role-capabilities.v1.json";
export const EXAMPLE_PATH = "resources/model-result/model-result.example.json";
export const BATCH_EXAMPLE_PATH = "resources/model-result/model-result.batch.example.json";
export const CONTRACT_MARKER = "<!-- model-result-contract:v1 -->";

/** The seven closed kinds of section 4. */
export const KINDS = Object.freeze([
  "artifact_author",
  "implementation",
  "fix",
  "verification",
  "verification_batch",
  "arena_candidate",
  "requirement_analysis",
]);

/**
 * Tools no role may hold, at any time.
 *
 * This is not a policy about how models should behave. It is the absence of the
 * tool, which is the only version of the rule that a model cannot decline to
 * follow.
 */
export const FORBIDDEN_TOOLS = Object.freeze([
  "autosk_task_mutate",
  "autosk_step_mutate",
  "autosk_comment_write",
  "autosk_metadata_mutate",
]);

/** Closed park reasons of section 10. */
export const PARK_REASONS = Object.freeze([
  "no_result_submitted",
  "multiple_results_submitted",
  "schema_invalid",
  "unknown_field",
  "scope_mismatch",
  "evidence_unresolved",
  "stale_anchor",
  "stale_runtime_identity",
  "tool_failure_not_product_disposition",
  "missing_application_proof",
  "missing_green_control",
  "missing_restore_receipt",
  "stale_harness_digest",
]);

/** Outcomes a work-producing step may report. */
export const WORK_OUTCOMES = Object.freeze(["ready_for_verification", "blocked", "needs_human"]);

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, CAPABILITIES_PATH, EXAMPLE_PATH, BATCH_EXAMPLE_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function modelResultDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

/**
 * The transition the host would select. Deterministic, and derived from the
 * outcome rather than from anything the model wrote.
 *
 * The `verification_batch` case is the one worth spelling out: a tool or
 * environment failure never becomes a product disposition. "The harness broke"
 * and "the product is wrong" are different facts, and a mapping that collapses
 * them manufactures verdicts nobody produced.
 */
export function selectTransition(result) {
  if (result.kind === "verification_batch") {
    const batch = result.batch;
    if (!batch) return "park:schema_invalid";
    if (batch.tool_outcome !== "ok") return "park:tool_failure_not_product_disposition";
    if (batch.environment_outcome !== "ok") return "park:tool_failure_not_product_disposition";
    if (batch.product_outcome === "indeterminate") return "park:tool_failure_not_product_disposition";
    return batch.product_outcome === "pass" ? "verified" : "rejected";
  }
  switch (result.outcome) {
    case "ready_for_verification":
      return "verify";
    case "blocked":
      return "park:scope_mismatch";
    case "needs_human":
      return "human";
    case "pass":
      return "verified";
    case "fail":
      return "rejected";
    default:
      return "park:schema_invalid";
  }
}

export function validateResult(result, schema) {
  const errors = validateJsonSchema(result, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  if (result.kind === "implementation" || result.kind === "fix") {
    if (!WORK_OUTCOMES.includes(result.outcome)) {
      errors.push(`outcome ${result.outcome} is not one of ${WORK_OUTCOMES.join(", ")} for kind ${result.kind}`);
    }
    if (result.outcome === "ready_for_verification") {
      if (!result.claimed_changed_paths || result.claimed_changed_paths.length === 0) {
        errors.push("ready_for_verification must claim the paths it changed, so the host can compare them to Git");
      }
      if (!result.evidence || result.evidence.length === 0) {
        errors.push("ready_for_verification must reference evidence per criterion");
      }
    }
  }

  if (result.kind === "verification_batch") {
    const batch = result.batch;
    if (!batch) {
      errors.push("a verification_batch result must carry its batch outcomes");
    } else {
      // Required for a PASS, not for every batch: a failed or indeterminate run
      // may legitimately lack a restore receipt because it crashed. Requiring
      // them in the schema instead would make this check unreachable — a guard
      // that reads like a guarantee and is never once evaluated.
      if (batch.product_outcome === "pass") {
        // Each of these is a proof that the batch demonstrated what it claims.
        if (!batch.application_proof) errors.push("a passing batch needs a mutation-application proof");
        if (!batch.green_control) errors.push("a passing batch needs a green control");
        if (!batch.restore_receipt) errors.push("a passing batch needs a restore receipt");
      }
      if (batch.tool_outcome !== "ok" && batch.product_outcome !== "indeterminate") {
        errors.push(
          "a tool failure cannot report a product outcome: the harness broke, which says nothing about the product",
        );
      }
    }
  } else if (result.batch !== undefined) {
    errors.push(`kind ${result.kind} must not carry batch outcomes`);
  }

  return errors;
}

export function validateCapabilities(capabilities) {
  const errors = [];
  for (const [role, tools] of Object.entries(capabilities.roles)) {
    for (const forbidden of FORBIDDEN_TOOLS) {
      if (tools.includes(forbidden)) {
        errors.push(`${role}: holds ${forbidden}; no role may mutate canonical task state`);
      }
    }
    const submits = tools.filter((tool) => tool.startsWith("submit_"));
    if (submits.length > 1) {
      errors.push(`${role}: holds ${submits.length} submit tools; a step submits exactly one result`);
    }
  }
  for (const forbidden of FORBIDDEN_TOOLS) {
    if (!capabilities.forbidden_for_every_role.includes(forbidden)) {
      errors.push(`forbidden_for_every_role omits ${forbidden}`);
    }
  }
  return errors;
}

export function validateModelResultDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const reason of PARK_REASONS) {
    if (!contract.includes(reason)) errors.push(`${CONTRACT_PATH}: park reason ${reason} is not documented`);
  }

  let schema;
  try {
    schema = JSON.parse(files[SCHEMA_PATH]);
  } catch (error) {
    return [...errors, `${SCHEMA_PATH}: not valid JSON: ${error.message}`];
  }
  if (schema.additionalProperties !== false) {
    errors.push(`${SCHEMA_PATH}: root must be closed (additionalProperties:false)`);
  }
  const kinds = schema.properties?.kind?.enum ?? [];
  if (kinds.join(",") !== KINDS.join(",")) {
    errors.push(`${SCHEMA_PATH}: kinds must be exactly ${KINDS.join(", ")}`);
  }
  for (const forbidden of ["next_step", "transition", "transit", "target_step"]) {
    if (Object.hasOwn(schema.properties ?? {}, forbidden)) {
      errors.push(`${SCHEMA_PATH}: defines ${forbidden}; a result must not be able to name its transition`);
    }
  }

  let capabilities;
  try {
    capabilities = JSON.parse(files[CAPABILITIES_PATH]);
  } catch (error) {
    return [...errors, `${CAPABILITIES_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...validateCapabilities(capabilities).map((message) => `${CAPABILITIES_PATH}: ${message}`));

  for (const relative of [EXAMPLE_PATH, BATCH_EXAMPLE_PATH]) {
    let example;
    try {
      example = JSON.parse(files[relative]);
    } catch (error) {
      errors.push(`${relative}: not valid JSON: ${error.message}`);
      continue;
    }
    errors.push(...validateResult(example, schema).map((message) => `${relative}: ${message}`));
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateModelResultDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Model result design validation PASS");
    console.log(`design_digest=${modelResultDesignDigest(files)}`);
    console.log(`implementation_transition=${selectTransition(JSON.parse(files[EXAMPLE_PATH]))}`);
    console.log(`batch_transition=${selectTransition(JSON.parse(files[BATCH_EXAMPLE_PATH]))}`);
  }
}
