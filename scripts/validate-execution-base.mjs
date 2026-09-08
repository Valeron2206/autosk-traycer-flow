#!/usr/bin/env node

/**
 * Design-time validator for the issue #7 Ticket execution base.
 *
 * The defect this contract closes is that a dependency edge schedules work
 * without carrying the predecessor's code into the dependent Ticket's base. So
 * the checks here are about whether a recorded base could have been built the
 * way it claims: the composition order must cover exactly the predecessors, the
 * digest must depend on that order, a Ticket with no dependencies must be at
 * `planning_head` rather than at some other tree, and every predecessor must
 * carry the PASS and delta binding that made it approved.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/execution-base.md";
export const SCHEMA_PATH = "resources/execution-base/execution-base.schema.json";
export const EXAMPLE_PATH = "resources/execution-base/execution-base.example.json";
export const ROOT_EXAMPLE_PATH = "resources/execution-base/execution-base.root.example.json";
export const CONTRACT_MARKER = "<!-- execution-base-contract:v1 -->";

/** Closed park reasons of section 9. */
export const PARK_REASONS = Object.freeze([
  "missing_predecessor_binding",
  "stale_predecessor_pass",
  "incompatible_overlapping_deltas",
  "composition_failed",
  "base_mismatch",
  "dag_changed",
  "anchor_changed",
  "foreign_ref_movement",
  "unreachable_composition_object",
]);

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, ROOT_EXAMPLE_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The digest section 5 binds identity to.
 *
 * Order is preserved rather than sorted away — unlike the set-valued fields in
 * this repository's other contracts. Two bases built from the same predecessors
 * in different orders are different trees, and a digest that hid that would
 * claim a determinism the composition does not have.
 */
export function baseDigest(base) {
  const byTicket = new Map(base.predecessors.map((entry) => [entry.ticket_id, entry]));
  const ordered = base.composition_order.map((ticketId) => {
    const entry = byTicket.get(ticketId);
    return entry ? `${entry.ticket_id}:${entry.commit_oid}:${entry.delta_digest}` : `${ticketId}:missing`;
  });
  return sha256([base.planning_head, ...ordered, base.tree_oid].join("\0"));
}

export function executionBaseDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

export function validateBase(base, schema) {
  const errors = validateJsonSchema(base, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const declared = base.predecessors.map((entry) => entry.ticket_id);
  const seen = new Set();
  for (const ticketId of declared) {
    if (seen.has(ticketId)) errors.push(`${ticketId}: declared as a predecessor twice`);
    seen.add(ticketId);
  }
  if (declared.includes(base.ticket_id)) {
    errors.push(`${base.ticket_id}: is its own predecessor`);
  }

  // The order is what makes a diamond reproducible, so it must cover exactly the
  // predecessors — no more, no fewer. An order naming a Ticket with no binding
  // would compose something nobody approved; a predecessor missing from the
  // order would be silently left out of the tree.
  const ordered = new Set(base.composition_order);
  for (const ticketId of declared) {
    if (!ordered.has(ticketId)) {
      errors.push(`${ticketId}: has a binding but is not in composition_order`);
    }
  }
  for (const ticketId of base.composition_order) {
    if (!seen.has(ticketId)) {
      errors.push(`${ticketId}: is in composition_order but has no predecessor binding`);
    }
  }
  if (base.composition_order.length !== new Set(base.composition_order).size) {
    errors.push("composition_order repeats a Ticket");
  }

  // A Ticket with no dependencies is at planning_head. Anything else means it
  // was built on top of work the manifest does not say it depends on.
  if (declared.length === 0) {
    if (base.tree_oid !== base.planning_head) {
      errors.push("a Ticket with no predecessors must be based on planning_head itself");
    }
    if (base.composition_commit_oid !== undefined) {
      errors.push("a Ticket with no predecessors has nothing to compose");
    }
  } else if (declared.length > 1 && base.composition_commit_oid === undefined) {
    errors.push("several predecessors require a composition commit, recorded so it can be found again");
  }

  const expected = baseDigest(base);
  if (base.digest !== expected) {
    errors.push(`digest does not recompute: recorded ${base.digest}, computed ${expected}`);
  }
  return errors;
}

export function validateExecutionBaseDesign(files) {
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

  for (const relative of [EXAMPLE_PATH, ROOT_EXAMPLE_PATH]) {
    let example;
    try {
      example = JSON.parse(files[relative]);
    } catch (error) {
      errors.push(`${relative}: not valid JSON: ${error.message}`);
      continue;
    }
    errors.push(...validateBase(example, schema).map((message) => `${relative}: ${message}`));
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateExecutionBaseDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const example = JSON.parse(files[EXAMPLE_PATH]);
    console.log("Execution base design validation PASS");
    console.log(`design_digest=${executionBaseDesignDigest(files)}`);
    console.log(`base_digest=${example.digest}`);
  }
}
