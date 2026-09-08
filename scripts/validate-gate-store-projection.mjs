#!/usr/bin/env node

/**
 * Design-time validator for the issue #15 gate store projection.
 *
 * Both obvious ways to protect a read-only reviewer are wrong: hash everything
 * and a Panel's own concurrency invalidates its seats; hash too little and a
 * driver can change the controlling identity unnoticed. So the checks here are
 * about the boundary between those two — that the projected set and the
 * concurrent set are disjoint, that nothing outside the projection changed
 * without a provenance record, and that a change nobody claims is refused
 * rather than assumed to be the daemon's.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/gate-store-projection.md";
export const SCHEMA_PATH = "resources/gate-store-projection/gate-store-projection.schema.json";
export const EXAMPLE_PATH = "resources/gate-store-projection/gate-store-projection.example.json";
export const VIOLATION_EXAMPLE_PATH =
  "resources/gate-store-projection/gate-store-projection.violation.example.json";
export const CONTRACT_MARKER = "<!-- gate-store-projection-contract:v1 -->";

/** Fields that must not change during a gate run (section 3). */
export const PROJECTED_FIELDS = Object.freeze([
  "project_binding",
  "parent_child_relation",
  "run",
  "round",
  "attempt",
  "seat",
  "role",
  "artifact_identity",
  "candidate_identity",
  "base_hashes",
  "anchor_version",
  "protocol_lock",
  "runtime_lock",
  "instruction_lock",
  "creation_binding",
  "provider_session_binding",
  "reviewer_routing",
  "author_family",
  "fixer_family",
  "expected_blocker",
  "allowed_transitions",
  "result_schema",
  "accepted_findings",
]);

/** Fields that may change during a run and never invalidate a verdict alone (section 4). */
export const CONCURRENT_FIELDS = Object.freeze([
  "status",
  "step",
  "timestamps",
  "worker_lease",
  "worker_activity",
  "engine_counters",
  "session_append_progress",
  "sibling_result",
  "sibling_terminal_status",
  "retry_fields",
  "heartbeat",
]);

export const ACTORS = Object.freeze(["daemon", "driver", "user", "model", "tool"]);

/** Closed park reasons of section 9. */
export const PARK_REASONS = Object.freeze([
  "projection_changed",
  "unknown_writer",
  "missing_provenance",
  "field_not_permitted",
  "frozen_prefix_modified",
  "projection_version_mismatch",
  "cross_project_record",
  "provenance_out_of_order",
]);

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, VIOLATION_EXAMPLE_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function gateProjectionDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

/**
 * The verdict the host would reach, computed rather than asserted.
 *
 * The order matters: a projection change is decided before provenance is even
 * consulted, because no journal entry can make a change to the controlling
 * identity acceptable.
 */
export function computeVerdict(record) {
  if (record.projection_digest_before !== record.projection_digest_after) return "blocking_non_verdict";
  if (record.comments_frozen_prefix_digest_before !== record.comments_frozen_prefix_digest_after) {
    return "blocking_non_verdict";
  }
  for (const entry of record.journal) {
    if (entry.project_binding !== record.project_binding) return "blocking_non_verdict";
    if (entry.actor !== "daemon" && entry.actor !== "user") return "blocking_non_verdict";
    const permitted = new Set(entry.permitted_fields);
    if (entry.changed_fields.some((field) => !permitted.has(field))) return "blocking_non_verdict";
    if (entry.changed_fields.some((field) => PROJECTED_FIELDS.includes(field))) {
      return "blocking_non_verdict";
    }
  }
  return "accepted";
}

export function validateRecord(record, schema) {
  const errors = validateJsonSchema(record, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  // The two sets are disjoint by construction: the schema's enums are the two
  // contract lists, and `validateGateProjectionDesign` asserts they do not
  // overlap. Repeating that check per record would be a guard the schema always
  // reaches first — one that reads like a guarantee and is never evaluated.
  const projected = new Set(record.projected_fields);

  // Every field the contract declares immutable must actually be in the
  // projection. A record that projects a subset silently drops protection.
  for (const field of PROJECTED_FIELDS) {
    if (!projected.has(field)) {
      errors.push(`${field}: declared immutable by the contract but not in projected_fields`);
    }
  }

  let previous = 0;
  for (const entry of record.journal) {
    const at = `journal ${entry.operation_id}`;
    if (entry.sequence <= previous) {
      errors.push(`${at}: sequence ${entry.sequence} does not follow ${previous} (provenance_out_of_order)`);
    }
    previous = entry.sequence;

    if (entry.project_binding !== record.project_binding) {
      errors.push(`${at}: belongs to another project (cross_project_record)`);
    }
    const permitted = new Set(entry.permitted_fields);
    for (const field of entry.changed_fields) {
      if (!permitted.has(field)) {
        errors.push(`${at}: changed ${field}, which the operation was not permitted to touch (field_not_permitted)`);
      }
      if (PROJECTED_FIELDS.includes(field)) {
        errors.push(`${at}: changed projected field ${field} (projection_changed)`);
      }
    }
  }

  if (record.verdict !== undefined) {
    const computed = computeVerdict(record);
    if (record.verdict !== computed) {
      errors.push(`verdict is ${record.verdict}, computed ${computed}`);
    }
  }
  return errors;
}

export function validateGateProjectionDesign(files) {
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
  const schemaProjected = schema.properties?.projected_fields?.items?.enum ?? [];
  if (schemaProjected.join(",") !== PROJECTED_FIELDS.join(",")) {
    errors.push(`${SCHEMA_PATH}: projected fields must be exactly the contract's list`);
  }
  const schemaConcurrent = schema.properties?.concurrent_fields?.items?.enum ?? [];
  if (schemaConcurrent.join(",") !== CONCURRENT_FIELDS.join(",")) {
    errors.push(`${SCHEMA_PATH}: concurrent fields must be exactly the contract's list`);
  }
  // The two lists are disjoint at the schema level too, or a record could be
  // valid while asking one field to be both.
  for (const field of CONCURRENT_FIELDS) {
    if (PROJECTED_FIELDS.includes(field)) {
      errors.push(`${field}: appears in both the projected and the concurrent list`);
    }
  }

  for (const relative of [EXAMPLE_PATH, VIOLATION_EXAMPLE_PATH]) {
    let example;
    try {
      example = JSON.parse(files[relative]);
    } catch (error) {
      errors.push(`${relative}: not valid JSON: ${error.message}`);
      continue;
    }
    if (relative === EXAMPLE_PATH) {
      errors.push(...validateRecord(example, schema).map((message) => `${relative}: ${message}`));
      if (computeVerdict(example) !== "accepted") {
        errors.push(`${relative}: the accepted example does not compute as accepted`);
      }
    } else {
      // The violation example is the one that proves the checks fire at all. It
      // must be schema-valid and still refused, or "fails closed" is untested.
      const schemaErrors = validateJsonSchema(example, schema);
      if (schemaErrors.length > 0) {
        errors.push(`${relative}: must be schema-valid so the refusal is about the rule, not the shape`);
      }
      if (computeVerdict(example) !== "blocking_non_verdict") {
        errors.push(`${relative}: the violation example computes as accepted`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateGateProjectionDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Gate store projection design validation PASS");
    console.log(`design_digest=${gateProjectionDesignDigest(files)}`);
    console.log(`accepted=${computeVerdict(JSON.parse(files[EXAMPLE_PATH]))}`);
    console.log(`violation=${computeVerdict(JSON.parse(files[VIOLATION_EXAMPLE_PATH]))}`);
  }
}
