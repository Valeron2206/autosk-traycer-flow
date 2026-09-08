#!/usr/bin/env node

/**
 * Design-time validator for the issue #36 clean-room fault matrix.
 *
 * A fault that reports success has proved nothing on its own. The four proofs
 * exist because each rules out a different way of proving nothing: the fault was
 * never applied, the fault is not observable, the observation is not specific,
 * or the room was not clean for the next fault. So the checks here are that
 * every group carries all four, that the matrix covers every boundary the flow
 * crosses, and that no failure mode the gate must refuse is recorded as a pass.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/clean-room-e2e.md";
export const SCHEMA_PATH = "resources/clean-room-e2e/fault-matrix.schema.json";
export const MATRIX_PATH = "resources/clean-room-e2e/fault-matrix.v1.json";
export const CONTRACT_MARKER = "<!-- clean-room-e2e-contract:v1 -->";

/** Every boundary the flow crosses. A boundary with no fault group is untested. */
export const BOUNDARIES = Object.freeze([
  "task_creation",
  "session_lifecycle",
  "filesystem_write",
  "ref_movement",
  "staging_integration",
  "aggregate_verification",
  "final_cas",
]);

/** The four proofs, and what each rules out. */
export const PROOF_KINDS = Object.freeze([
  "application_proof",
  "red_killer",
  "green_control",
  "restore_proof",
]);

/** Outcomes that must fail the release gate. None of them is a product verdict. */
export const GATE_FAILING_OUTCOMES = Object.freeze([
  "mutation_not_applied",
  "green_control_failed",
  "restore_failed",
  "timeout",
  "indeterminate",
]);

/** Closed park reasons of section 8. */
export const PARK_REASONS = Object.freeze([
  "mutation_not_applied",
  "green_control_failed",
  "restore_failed",
  "timeout",
  "indeterminate",
  "harness_self_test_failed",
  "digest_changed_after_mint",
  "ephemeral_helper_left",
  "traycer_artifact_present",
  "cross_project_leakage",
]);

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, MATRIX_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function cleanRoomDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

/** Whether the gate passes for a recorded outcome. */
export function gatePasses(outcome) {
  return !GATE_FAILING_OUTCOMES.includes(outcome);
}

export function validateMatrix(matrix, schema) {
  const errors = validateJsonSchema(matrix, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const ids = new Set();
  const covered = new Set();
  for (const group of matrix.groups) {
    const at = `${group.id} (${group.boundary})`;
    if (ids.has(group.id)) errors.push(`${at}: id declared twice`);
    ids.add(group.id);
    covered.add(group.boundary);

    // All four, each exactly once. Three of four is a group that proves
    // something, and the missing one is the thing it fails to prove.
    const kinds = group.proofs.map((proof) => proof.kind);
    for (const kind of PROOF_KINDS) {
      const count = kinds.filter((entry) => entry === kind).length;
      if (count === 0) errors.push(`${at}: has no ${kind}`);
      if (count > 1) errors.push(`${at}: has ${count} ${kind} entries`);
    }
    for (const proof of group.proofs) {
      if (!proof.locator || proof.locator.trim() === "") {
        errors.push(`${at}: ${proof.kind} has no locator, so nothing can be checked against it`);
      }
    }
  }

  // A boundary with no fault group is a boundary nobody attacked.
  for (const boundary of BOUNDARIES) {
    if (!covered.has(boundary)) {
      errors.push(`${boundary}: no fault group crosses this boundary`);
    }
  }

  // Every outcome the gate must refuse has to be exercised by at least one
  // group, or the refusal is a rule with nothing behind it.
  const outcomes = new Set(matrix.groups.map((group) => group.expected_gate_outcome));
  for (const outcome of GATE_FAILING_OUTCOMES) {
    if (!outcomes.has(outcome)) {
      errors.push(`${outcome}: the gate must refuse it, and no group demonstrates it`);
    }
  }
  if (!outcomes.has("pass")) {
    errors.push("no group is expected to pass, so a passing run is undemonstrated");
  }

  const declared = new Set(matrix.gate_failing_outcomes);
  for (const outcome of GATE_FAILING_OUTCOMES) {
    if (!declared.has(outcome)) errors.push(`gate_failing_outcomes omits ${outcome}`);
  }
  return errors;
}

export function validateCleanRoomDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const reason of PARK_REASONS) {
    if (!contract.includes(reason)) errors.push(`${CONTRACT_PATH}: park reason ${reason} is not documented`);
  }
  // The room is defined by what is absent as much as by what is present.
  for (const absence of [".traycer", "no network", "temporary HOME"]) {
    if (!contract.includes(absence)) {
      errors.push(`${CONTRACT_PATH}: does not state the room requirement "${absence}"`);
    }
  }
  for (const kind of PROOF_KINDS) {
    if (!contract.includes(kind)) errors.push(`${CONTRACT_PATH}: does not name the proof ${kind}`);
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
  // Exactly four proofs per group, enforced by the schema rather than only by
  // the validator: a group with five would otherwise be shape-valid.
  const proofs = schema.properties?.groups?.items?.properties?.proofs ?? {};
  if (proofs.minItems !== 4 || proofs.maxItems !== 4) {
    errors.push(`${SCHEMA_PATH}: a fault group carries exactly four proofs`);
  }

  let matrix;
  try {
    matrix = JSON.parse(files[MATRIX_PATH]);
  } catch (error) {
    return [...errors, `${MATRIX_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...validateMatrix(matrix, schema).map((message) => `${MATRIX_PATH}: ${message}`));
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateCleanRoomDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const matrix = JSON.parse(files[MATRIX_PATH]);
    console.log("Clean-room fault matrix design validation PASS");
    console.log(`design_digest=${cleanRoomDesignDigest(files)}`);
    console.log(`groups=${matrix.groups.length}`);
    console.log(`boundaries=${new Set(matrix.groups.map((group) => group.boundary)).size}`);
  }
}
