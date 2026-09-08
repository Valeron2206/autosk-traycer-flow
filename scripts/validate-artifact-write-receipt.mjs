#!/usr/bin/env node

/**
 * Design-time validator for the issue #22 artifact write receipt.
 *
 * Writing a file and then reading `git status` establishes that SOME bytes are
 * there now. A receipt is what turns "we wrote it" into a claim a later reader
 * can check without having been present. So the checks here are about the two
 * ways a receipt could quietly stop being that: a phase asserted rather than
 * earned, and a receipt drifting into being a second task-status ledger.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/artifact-write-receipt.md";
export const SCHEMA_PATH = "resources/artifact-write-receipt/artifact-write-receipt.schema.json";
export const EXAMPLE_PATH = "resources/artifact-write-receipt/artifact-write-receipt.example.json";
export const QUARANTINED_EXAMPLE_PATH =
  "resources/artifact-write-receipt/artifact-write-receipt.quarantined.example.json";
export const CONTRACT_MARKER = "<!-- artifact-write-receipt-contract:v1 -->";

/** Closed refusal set of section 8. */
export const REFUSALS = Object.freeze([
  "write_destination_invalid",
  "write_previous_mismatch",
  "write_not_regular",
  "write_too_large",
  "write_readback_mismatch",
  "write_mode_mismatch",
  "write_helper_unavailable",
  "write_out_of_scope",
  "receipt_stale_pending",
]);

/** The four sources a divergence report must name (section 7). */
export const RECONCILIATION_SOURCES = Object.freeze([
  "canonical_bytes",
  "task_metadata",
  "receipt",
  "model_output",
]);

/**
 * Words a receipt must never carry.
 *
 * Criterion 6 of #22: a receipt is not a second task-status ledger. The schema
 * having no field for a task's status is stronger than a convention not to write
 * one, and this checks the schema rather than the examples — an example without
 * a field proves nothing about the next receipt.
 */
export const FORBIDDEN_FIELDS = Object.freeze(["status", "task_status", "step", "workflow_position", "task_id"]);

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, QUARANTINED_EXAMPLE_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function receiptDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

/**
 * The phase this receipt's own evidence supports.
 *
 * Computed, never read from the record. A receipt that asserted `verified` while
 * carrying a read-back digest that differs from the intended one would be the
 * exact failure the receipt exists to catch, reported as a success.
 */
export function computePhase(receipt) {
  if (receipt.quarantine?.state === "held") return "quarantined";
  if (receipt.observed_sha256 === undefined || receipt.observed_size === undefined) return "pending";
  if (receipt.observed_sha256 !== receipt.intended_sha256) return "pending";
  if (receipt.observed_size !== receipt.intended_size) return "pending";
  if (receipt.reconciliation?.state !== "agreed") return "pending";
  return "verified";
}

export function validateReceipt(receipt, schema) {
  const errors = validateJsonSchema(receipt, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const computed = computePhase(receipt);
  if (receipt.phase !== computed) {
    errors.push(`phase is ${receipt.phase}, computed ${computed}`);
  }
  // Size policy is part of the receipt so two builds' receipts stay comparable,
  // which only means anything if the receipt respects it.
  if (receipt.intended_size > receipt.policy.max_bytes && receipt.quarantine.state !== "held") {
    errors.push("intended size exceeds the pinned policy but the receipt is not quarantined");
  }
  if (receipt.observed_mode !== undefined && !receipt.policy.allowed_modes.includes(receipt.observed_mode)) {
    errors.push(`observed mode ${receipt.observed_mode} is not in the pinned policy`);
  }
  if (receipt.expected_previous.state === "file" && receipt.expected_previous.sha256 === receipt.intended_sha256) {
    // Not a hard error in the world, but a receipt claiming to have written the
    // bytes that were already there is describing a write that did nothing, and
    // recording it as a change is the misreading this catches.
    errors.push("expected previous digest equals the intended one: this write changes nothing");
  }
  return errors;
}

export function validateArtifactWriteReceiptDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const refusal of REFUSALS) {
    if (!contract.includes(refusal)) errors.push(`${CONTRACT_PATH}: refusal ${refusal} is not documented`);
  }
  // The two decisions this contract exists to make.
  if (!contract.includes("computed from the evidence")) {
    errors.push(`${CONTRACT_PATH}: does not state that the phase is computed rather than asserted`);
  }
  if (!contract.includes("not a second task-status ledger")) {
    errors.push(`${CONTRACT_PATH}: does not state what a receipt is not`);
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
  for (const field of FORBIDDEN_FIELDS) {
    if (field in (schema.properties ?? {})) {
      errors.push(`${SCHEMA_PATH}: a receipt must not carry ${field} — it is not a task-status ledger`);
    }
  }
  const phases = schema.properties?.phase?.enum ?? [];
  if (phases.join(",") !== "pending,verified,quarantined") {
    errors.push(`${SCHEMA_PATH}: phases must be exactly pending, verified, quarantined`);
  }
  const declaredRefusals = schema.properties?.refusal?.enum ?? [];
  if (declaredRefusals.join(",") !== REFUSALS.join(",")) {
    errors.push(`${SCHEMA_PATH}: the refusal set must match the contract exactly`);
  }
  const reportFields = Object.keys(
    schema.properties?.reconciliation?.oneOf?.[1]?.properties?.report?.properties ?? {},
  );
  if (reportFields.sort().join(",") !== [...RECONCILIATION_SOURCES].sort().join(",")) {
    errors.push(`${SCHEMA_PATH}: a divergence report must name all four sources`);
  }
  // Required, not optional: a report that lists only the odd source out cannot be
  // checked by a reader who does not already know the answer.
  const requiredReport = schema.properties?.reconciliation?.oneOf?.[1]?.properties?.report?.required ?? [];
  if (requiredReport.slice().sort().join(",") !== [...RECONCILIATION_SOURCES].sort().join(",")) {
    errors.push(`${SCHEMA_PATH}: every source in a divergence report must be required`);
  }

  for (const relative of [EXAMPLE_PATH, QUARANTINED_EXAMPLE_PATH]) {
    let example;
    try {
      example = JSON.parse(files[relative]);
    } catch (error) {
      errors.push(`${relative}: not valid JSON: ${error.message}`);
      continue;
    }
    errors.push(...validateReceipt(example, schema).map((message) => `${relative}: ${message}`));
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateArtifactWriteReceiptDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Artifact write receipt design validation PASS");
    console.log(`design_digest=${receiptDesignDigest(files)}`);
    console.log(`refusals=${REFUSALS.length} sources=${RECONCILIATION_SOURCES.length}`);
  }
}
