#!/usr/bin/env node

/**
 * Design-time validator for the issue #21 external source snapshot.
 *
 * A Git tree OID says nothing about an upload, an API export or a screenshot,
 * and a seat that reads the live file gets an answer that can differ from the
 * next seat's. So the checks here are about the two ways a snapshot stops being
 * one: living somewhere it can be deleted or moved, and a record that cannot
 * prove the bytes it names were ever read back.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/external-source-snapshot.md";
export const SCHEMA_PATH = "resources/external-source-snapshot/external-source-snapshot.schema.json";
export const EXAMPLE_PATH = "resources/external-source-snapshot/external-source-snapshot.example.json";
export const SUPERSEDED_EXAMPLE_PATH =
  "resources/external-source-snapshot/external-source-snapshot.superseded.example.json";
export const CONTRACT_MARKER = "<!-- external-source-snapshot-contract:v1 -->";

/** Closed refusal set of section 7. */
export const REFUSALS = Object.freeze([
  "snapshot_source_unavailable",
  "snapshot_source_not_regular",
  "snapshot_identity_uncertain",
  "snapshot_out_of_project",
  "snapshot_read_back_mismatch",
  "snapshot_retention_conflict",
  "snapshot_worktree_dirty",
  "snapshot_clearance_missing",
]);

/** The five live-source outcomes of section 5. */
export const DRIFT_OUTCOMES = Object.freeze([
  "continue",
  "new anchor version",
  "human",
  "approved disposition",
  "deterministic proof",
]);

/**
 * Roots a snapshot may not live under.
 *
 * The transient evidence root is the one most likely to be chosen by accident —
 * it is exactly where a snapshot looks like it belongs — and #27's retention
 * would then delete the only copy of a normative input.
 */
export const FORBIDDEN_ROOTS = Object.freeze([".autosk/evidence/", "build/evidence/", "tmp/"]);

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, SUPERSEDED_EXAMPLE_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function snapshotDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

export function validateSnapshot(snapshot, schema) {
  const errors = validateJsonSchema(snapshot, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  // Two digests, not one. A snapshot whose read-back differs from what was
  // written is not a snapshot of anything — it is a file that happens to be
  // there, and the whole point is that a verdict can be replayed against it.
  if (snapshot.read_back_sha256 !== snapshot.snapshot_sha256) {
    errors.push("read-back digest differs from the snapshot digest (snapshot_read_back_mismatch)");
  }
  // The snapshot is a copy of the source, so at mint time they are the same
  // bytes. A record where they differ describes a copy of something else.
  if (snapshot.snapshot_sha256 !== snapshot.source_sha256) {
    errors.push("snapshot digest differs from the source digest: this is a copy of something else");
  }
  for (const root of FORBIDDEN_ROOTS) {
    if (snapshot.snapshot_path.startsWith(root)) {
      errors.push(`snapshot lives under ${root}, which is transient (snapshot_retention_conflict)`);
    }
  }
  if (snapshot.provenance.arrival === "imported") {
    // Reading someone else's file and calling it yours is the failure the import
    // operation exists to prevent, so a record cannot claim one without naming it.
    if (!snapshot.provenance.imported_from || !snapshot.provenance.import_operation_id) {
      errors.push("an imported source must name where it came from and the operation that imported it");
    }
  } else if (snapshot.provenance.imported_from || snapshot.provenance.import_operation_id) {
    errors.push("a source that was already in the project cannot carry import provenance");
  }
  if (snapshot.lifecycle === "superseded") {
    if (!snapshot.superseded_by) errors.push("a superseded snapshot must name what superseded it");
  } else if (snapshot.superseded_by) {
    errors.push(`a ${snapshot.lifecycle} snapshot must not name a successor`);
  }
  if (snapshot.superseded_by === snapshot.snapshot_sha256) {
    errors.push("a snapshot cannot supersede itself");
  }
  return errors;
}

export function validateExternalSourceSnapshotDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const refusal of REFUSALS) {
    if (!contract.includes(refusal)) errors.push(`${CONTRACT_PATH}: refusal ${refusal} is not documented`);
  }
  for (const outcome of DRIFT_OUTCOMES) {
    if (!contract.includes(outcome)) errors.push(`${CONTRACT_PATH}: drift outcome "${outcome}" is not documented`);
  }
  // The three decisions this contract exists to make.
  if (!contract.includes("never re-minted from whatever the live source says now")) {
    errors.push(`${CONTRACT_PATH}: does not state that repair uses the recorded identity`);
  }
  if (!contract.includes("without text normalization")) {
    errors.push(`${CONTRACT_PATH}: does not state that binary bytes are hashed as bytes`);
  }
  if (!contract.includes("provenance records stay separate")) {
    errors.push(`${CONTRACT_PATH}: does not state that dedup keeps provenance apart`);
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
  // Both digests are required: a record that could omit the read-back would let
  // "the write returned" stand in for "the bytes are there".
  for (const field of ["source_sha256", "snapshot_sha256", "read_back_sha256"]) {
    if (!(schema.required ?? []).includes(field)) {
      errors.push(`${SCHEMA_PATH}: ${field} must be required`);
    }
  }
  const lifecycles = schema.properties?.lifecycle?.enum ?? [];
  if (lifecycles.join(",") !== "present,missing,deleted,superseded") {
    errors.push(`${SCHEMA_PATH}: lifecycle must be exactly present, missing, deleted, superseded`);
  }
  const clearances = schema.properties?.clearance?.enum ?? [];
  if (clearances.join(",") !== "cleared,redacted,restricted") {
    errors.push(`${SCHEMA_PATH}: clearance must be exactly cleared, redacted, restricted`);
  }

  for (const relative of [EXAMPLE_PATH, SUPERSEDED_EXAMPLE_PATH]) {
    let snapshot;
    try {
      snapshot = JSON.parse(files[relative]);
    } catch (error) {
      errors.push(`${relative}: not valid JSON: ${error.message}`);
      continue;
    }
    errors.push(...validateSnapshot(snapshot, schema).map((message) => `${relative}: ${message}`));
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateExternalSourceSnapshotDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    console.log("External source snapshot design validation PASS");
    console.log(`design_digest=${snapshotDesignDigest(files)}`);
    console.log(`refusals=${REFUSALS.length} forbidden_roots=${FORBIDDEN_ROOTS.length}`);
  }
}
