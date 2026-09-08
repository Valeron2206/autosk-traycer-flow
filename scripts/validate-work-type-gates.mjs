#!/usr/bin/env node

/**
 * Design-time validator for the issue #24 work-type gates and batch contract.
 *
 * Including a playbook's text in a prompt is not enough: a model can read a
 * requirement and proceed to verification anyway. The checks here turn the four
 * requirements that are easiest to skip into gates — an unknown root cause, a
 * refactor with no behaviour pin, a threshold chosen after the numbers, and a
 * batch that passed because a script exited 0.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/work-type-gates.md";
export const SCHEMA_PATH = "resources/verification-batch/verification-batch.schema.json";
export const EXAMPLE_PATH = "resources/verification-batch/verification-batch.example.json";
export const CONTRACT_MARKER = "<!-- work-type-gates-contract:v1 -->";

export const WORK_TYPES = Object.freeze(["feature", "bug-fix", "refactoring", "perf"]);

/** The closed outcome set. Four of these are not failures of the product. */
export const OUTCOMES = Object.freeze([
  "product_detected", "product_not_detected", "green_control_failed", "mutation_not_applied",
  "tool_setup_failed", "tool_execution_failed", "restore_failed", "evidence_invalid",
  "timeout", "indeterminate",
]);

/** Outcomes that can never be reported as a product pass. */
export const NON_PRODUCT_OUTCOMES = Object.freeze([
  "green_control_failed", "mutation_not_applied", "tool_setup_failed", "tool_execution_failed",
  "restore_failed", "evidence_invalid", "timeout", "indeterminate",
]);

export const REFUSALS = Object.freeze([
  "worktype_missing",
  "worktype_mixed",
  "bugfix_root_cause_unknown",
  "bugfix_investigate_and_fix_combined",
  "refactor_behavior_pin_missing",
  "perf_threshold_after_result",
  "batch_contract_missing",
  "batch_proof_contract_incomplete",
  "batch_mutation_not_applied",
  "batch_green_control_failed",
  "batch_restore_unverified",
  "batch_result_stale",
  "batch_listing_disposition_evaded",
]);

/** The per-type prerequisites, as field names a ticket must carry. */
export const PREREQUISITES = Object.freeze({
  feature: ["organizing_structure", "why_not_booleans", "rejected_alternatives", "tests", "per_criterion_verification"],
  "bug-fix": ["root_cause", "runtime_evidence_pointer", "repro_surface", "failing_regression_test"],
  refactoring: ["behavior_pin", "equivalence_harness"],
  perf: ["warm_up", "repeat_count", "spread_statistic", "noise_threshold", "command", "workload", "environment", "hypothesis"],
});

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function workTypeDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

/**
 * Whether a ticket may enter implementation.
 *
 * Every clause here is a requirement a prompt can state and a model can skip,
 * which is the difference between a playbook and a gate.
 */
export function implementationGate(ticket) {
  if (!ticket.work_type) return "refused:worktype_missing";
  if (Array.isArray(ticket.work_type)) return "refused:worktype_mixed";
  const missing = (PREREQUISITES[ticket.work_type] ?? []).filter((field) => ticket[field] === undefined);
  if (ticket.work_type === "bug-fix" && missing.includes("root_cause")) {
    return "refused:bugfix_root_cause_unknown";
  }
  // A handoff that may change the code cannot prove what the code did before it.
  if (ticket.work_type === "bug-fix" && ticket.investigate_and_fix === true) {
    return "refused:bugfix_investigate_and_fix_combined";
  }
  if (ticket.work_type === "refactoring" && missing.includes("behavior_pin")) {
    return "refused:refactor_behavior_pin_missing";
  }
  // A threshold chosen after the numbers is a description of the result.
  if (ticket.work_type === "perf" && ticket.threshold_fixed_before_baseline !== true) {
    return "refused:perf_threshold_after_result";
  }
  if (missing.length > 0) return `refused:batch_proof_contract_incomplete:${missing.sort().join(",")}`;
  return "ready";
}

/**
 * The product verdict a batch supports.
 *
 * A batch is not sufficient because a temporary script exited 0, and the four
 * outcomes that are not product failures never become a pass.
 */
export function batchVerdict(batch) {
  if (batch.batch_outcome && NON_PRODUCT_OUTCOMES.includes(batch.batch_outcome)) {
    return `blocked:${batch.batch_outcome}`;
  }
  if (batch.self_test === undefined || batch.self_test.observed !== "killed") {
    return "blocked:batch_proof_contract_incomplete";
  }
  for (const mutation of batch.matrix) {
    if (mutation.outcome === undefined) return "blocked:batch_proof_contract_incomplete";
    if (NON_PRODUCT_OUTCOMES.includes(mutation.outcome)) return `blocked:${mutation.outcome}`;
    if (mutation.outcome === "product_not_detected") return "blocked:product_not_detected";
  }
  if (batch.recovery.post_restore_identity !== batch.candidate.base_tree) {
    return "blocked:batch_restore_unverified";
  }
  return "product_pass";
}

/** A result is stale when anything it was bound to has moved. */
export function isStale(batch, current) {
  for (const [field, value] of Object.entries(current)) {
    const recorded = field in batch.candidate ? batch.candidate[field] : batch.evidence[field];
    if (recorded !== undefined && recorded !== value) return true;
  }
  return false;
}

export function validateBatch(batch, schema) {
  const errors = validateJsonSchema(batch, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const ids = batch.matrix.map((mutation) => mutation.mutation_id);
  if (new Set(ids).size !== ids.length) errors.push("a mutation id appears twice");
  for (const mutation of batch.matrix) {
    if (mutation.green_controls.length === 0) errors.push(`${mutation.mutation_id}: no green control`);
  }
  // Restoring to something other than the base tree is not a restore.
  if (batch.recovery.post_restore_identity !== batch.candidate.base_tree) {
    errors.push("the post-restore identity is not the base tree (batch_restore_unverified)");
  }
  // The blocking set must contain every outcome that is not a product result, or
  // the acceptance rule admits one of them.
  // Every one of them, with no exception: an outcome left out of the blocking
  // set is an outcome the acceptance rule quietly admits.
  for (const outcome of NON_PRODUCT_OUTCOMES) {
    if (!batch.acceptance_rule.blocking_outcomes.includes(outcome)) {
      errors.push(`${outcome} is not blocking, so it could be reported as a pass`);
    }
  }
  if (batch.owner.lifecycle === "ephemeral" && !batch.owner.location.includes("evidence")) {
    errors.push("ephemeral scaffolding lives in a project-owned evidence root");
  }
  return errors;
}

export function validateWorkTypeGatesDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const refusal of REFUSALS) {
    if (!contract.includes(refusal)) errors.push(`${CONTRACT_PATH}: refusal ${refusal} is not documented`);
  }
  for (const outcome of OUTCOMES) {
    if (!contract.includes(outcome)) errors.push(`${CONTRACT_PATH}: outcome ${outcome} is not documented`);
  }
  if (!contract.includes("A batch is not sufficient because a temporary script exited 0")) {
    errors.push(`${CONTRACT_PATH}: does not state what sufficiency is not`);
  }
  if (!contract.includes("Typecheck and lint are not a pin")) {
    errors.push(`${CONTRACT_PATH}: does not state that a typecheck is not a behaviour pin`);
  }
  if (!contract.includes("canonical owner")) {
    errors.push(`${CONTRACT_PATH}: does not claim ownership of the scaffolding rule`);
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
  const declared = schema.properties?.batch_outcome?.enum ?? [];
  if (declared.slice().sort().join(",") !== [...OUTCOMES].sort().join(",")) {
    errors.push(`${SCHEMA_PATH}: the outcome set must match the contract exactly`);
  }
  const types = schema.properties?.work_type?.enum ?? [];
  if (types.slice().sort().join(",") !== [...WORK_TYPES].sort().join(",")) {
    errors.push(`${SCHEMA_PATH}: the work types must match the contract exactly`);
  }
  const mutation = schema.properties?.matrix?.items?.required ?? [];
  for (const field of ["application_proof", "expected_killer", "expected_red", "green_controls"]) {
    if (!mutation.includes(field)) {
      errors.push(`${SCHEMA_PATH}: every mutation must carry ${field} (batch_proof_contract_incomplete)`);
    }
  }

  let batch;
  try {
    batch = JSON.parse(files[EXAMPLE_PATH]);
  } catch (error) {
    return [...errors, `${EXAMPLE_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...validateBatch(batch, schema).map((message) => `${EXAMPLE_PATH}: ${message}`));
  if (batchVerdict(batch) !== "product_pass") {
    errors.push(`${EXAMPLE_PATH}: the worked example does not reach a product pass (${batchVerdict(batch)})`);
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateWorkTypeGatesDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Work-type gates design validation PASS");
    console.log(`design_digest=${workTypeDesignDigest(files)}`);
    console.log(`work_types=${WORK_TYPES.length} outcomes=${OUTCOMES.length} refusals=${REFUSALS.length}`);
  }
}
