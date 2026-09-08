#!/usr/bin/env node

/**
 * Design-time validator for the issue #27 evidence manifest.
 *
 * The plan gave evidence a path and stopped, and a path is not a lifecycle. The
 * checks here are about the three ways a record stops being evidence: a
 * durability a producer asserted rather than inherited from its class, a
 * truncated diagnostic that reads as complete, and a harness outcome that was
 * not a product pass being recorded as one.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/evidence-manifest.md";
export const SCHEMA_PATH = "resources/evidence-manifest/evidence-manifest.schema.json";
export const EXAMPLE_PATH = "resources/evidence-manifest/evidence-manifest.example.json";
export const TOMBSTONED_EXAMPLE_PATH = "resources/evidence-manifest/evidence-manifest.tombstoned.example.json";
export const CONTRACT_MARKER = "<!-- evidence-manifest-contract:v1 -->";

/**
 * Durability is a property of the CLASS, not of the record.
 *
 * Otherwise "this one is durable" becomes something a producer can assert about
 * a class the policy calls transient, and the policy stops being one.
 */
export const CLASS_DURABILITY = Object.freeze({
  verdict: "durable",
  verification: "durable",
  verification_harness_run: "durable",
  restoration_receipt: "durable",
  integration_receipt: "durable",
  protocol_runtime_instruction_lock: "durable",
  human_approval_waiver: "durable",
  mutation_fixture: "transient",
  temporary_harness_source: "transient",
  temporary_harness_binary: "transient",
  provider_raw_output: "restricted",
  temporary_log: "expirable",
  screenshot: "expirable",
  profile: "expirable",
  worktree_trace: "expirable",
  quarantined_sensitive: "never_stored",
});

/** Outcomes that are not a product PASS, however the run is summarised. */
export const NON_PRODUCT_OUTCOMES = Object.freeze([
  "mutation_not_applied",
  "green_control_failed",
  "tool_error",
  "tool_timeout",
  "restore_failed",
  "timeout",
  "indeterminate",
]);

/** Closed refusal set of section 8. */
export const REFUSALS = Object.freeze([
  "evidence_class_durability_conflict",
  "evidence_referenced_deletion",
  "evidence_missing_durable",
  "evidence_corrupt",
  "evidence_truncated_as_complete",
  "evidence_cross_project_path",
  "evidence_retention_retroactive",
  "evidence_unredactable",
  "evidence_restore_unverified",
  "evidence_tool_outcome_as_product",
]);

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, TOMBSTONED_EXAMPLE_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function evidenceDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

export function validateEvidenceRecord(record, schema) {
  const errors = validateJsonSchema(record, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const expected = CLASS_DURABILITY[record.evidence_class];
  if (record.durability !== expected) {
    errors.push(
      `${record.evidence_class} is ${expected}, not ${record.durability} (evidence_class_durability_conflict)`,
    );
  }
  if (expected === "never_stored" && record.deletion.state !== "tombstoned") {
    errors.push("quarantined_sensitive must not be stored (evidence_unredactable)");
  }
  // A record the storage does not belong to is a path into another project.
  if (record.storage.owner_project_identity !== record.project_identity) {
    errors.push("storage owner is not this project (evidence_cross_project_path)");
  }
  // Durable evidence with an expiry is a contradiction that cleanup would resolve
  // in the only direction that loses something.
  if (expected === "durable" && record.expires_at !== undefined) {
    errors.push("durable evidence must not carry an expiry");
  }
  if ((expected === "expirable" || expected === "transient") && record.expires_at === undefined) {
    errors.push(`${expected} evidence must say when it expires`);
  }
  if (record.deletion.state === "tombstoned") {
    if (record.deletion.sha256 !== record.sha256) {
      errors.push("the tombstone names a different digest than the record it stands for");
    }
    if (record.dependents.length > 0) {
      errors.push("evidence with dependents was deleted (evidence_referenced_deletion)");
    }
  }
  if (record.truncation.state === "truncated") {
    if (record.truncation.original_size <= record.truncation.policy_limit) {
      errors.push("a truncated record must have been larger than the limit that cut it");
    }
    if (record.size > record.truncation.policy_limit) {
      errors.push("a truncated record must not exceed the limit it was cut to");
    }
  }
  if (record.batch !== undefined) errors.push(...validateBatch(record));
  else if (record.evidence_class === "verification_harness_run") {
    // Storing only the summary is the refusal, not an omission: a PASS with no
    // proof is indistinguishable from a run that did nothing.
    errors.push("a harness run must carry its batch proof, not only its outcome");
  }
  return errors;
}

function validateBatch(record) {
  const errors = [];
  const batch = record.batch;
  if (NON_PRODUCT_OUTCOMES.includes(batch.outcome)) {
    // Nothing else to check: the run did not produce a product outcome, and the
    // fields below are about a run that did.
    if (batch.restore.state === "failed" && record.deletion.state === "tombstoned") {
      errors.push("a failed restore forbids ordinary cleanup (evidence_restore_unverified)");
    }
    return errors;
  }
  if (batch.outcome === "product_pass") {
    // Each of these is a way a PASS can be claimed without the run supporting it.
    if (batch.applied_proof.length === 0) {
      errors.push("a product pass needs proof that each mutation was applied (evidence_tool_outcome_as_product)");
    }
    if (batch.green_controls.some((control) => control.outcome !== "green")) {
      errors.push("a product pass requires every green control to be green (green_control_failed)");
    }
    if (batch.observed_red.length === 0) {
      errors.push("a product pass requires the killer to have fired");
    }
    if (batch.restore.state === "failed") {
      errors.push("a product pass cannot stand on a failed restore (evidence_restore_unverified)");
    }
    // Mutating the product and leaving it mutated is not a pass either.
    if (batch.restore.state !== "not_required" && batch.before_tree !== batch.after_tree) {
      errors.push("the product tree was not restored to what it was before the batch");
    }
  }
  if (batch.restore.state === "not_required" && batch.before_tree !== batch.after_tree) {
    errors.push("a batch that changed the tree cannot say a restore was not required");
  }
  if (record.deletion.state === "tombstoned" && batch.restore.state !== "verified") {
    errors.push("ephemeral state was cleaned up before the restore was verified (evidence_restore_unverified)");
  }
  return errors;
}

export function validateEvidenceManifestDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const refusal of REFUSALS) {
    if (!contract.includes(refusal)) errors.push(`${CONTRACT_PATH}: refusal ${refusal} is not documented`);
  }
  for (const outcome of NON_PRODUCT_OUTCOMES) {
    if (!contract.includes(outcome)) errors.push(`${CONTRACT_PATH}: outcome ${outcome} is not documented`);
  }
  for (const klass of Object.keys(CLASS_DURABILITY)) {
    if (!contract.includes(klass)) errors.push(`${CONTRACT_PATH}: class ${klass} is not documented`);
  }
  if (!contract.includes("derived from the class")) {
    errors.push(`${CONTRACT_PATH}: does not state that durability comes from the class`);
  }
  if (!contract.includes("an inventory of references is built **first**")) {
    errors.push(`${CONTRACT_PATH}: does not state that cleanup inventories references first`);
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
  const declared = schema.properties?.evidence_class?.enum ?? [];
  if (declared.slice().sort().join(",") !== Object.keys(CLASS_DURABILITY).sort().join(",")) {
    errors.push(`${SCHEMA_PATH}: the class set must match the contract exactly`);
  }
  const outcomes = schema.properties?.batch?.properties?.outcome?.enum ?? [];
  for (const outcome of NON_PRODUCT_OUTCOMES) {
    if (!outcomes.includes(outcome)) {
      errors.push(`${SCHEMA_PATH}: outcome ${outcome} must be expressible, or it gets reported as a pass`);
    }
  }

  for (const relative of [EXAMPLE_PATH, TOMBSTONED_EXAMPLE_PATH]) {
    let record;
    try {
      record = JSON.parse(files[relative]);
    } catch (error) {
      errors.push(`${relative}: not valid JSON: ${error.message}`);
      continue;
    }
    errors.push(...validateEvidenceRecord(record, schema).map((message) => `${relative}: ${message}`));
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateEvidenceManifestDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Evidence manifest design validation PASS");
    console.log(`design_digest=${evidenceDesignDigest(files)}`);
    console.log(`classes=${Object.keys(CLASS_DURABILITY).length} refusals=${REFUSALS.length}`);
  }
}
