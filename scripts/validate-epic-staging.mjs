#!/usr/bin/env node

/**
 * Design-time validator for the issue #9 Epic staging and final target CAS.
 *
 * Two Tickets that are individually green can regress together, so aggregate
 * verification is about a set rather than about its members — and the whole
 * point is lost if the aggregate, the acceptance and the swap can each be about
 * a slightly different tree. Almost every check here is the same question asked
 * at a different link in that chain: is this still the identity that was
 * verified?
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/epic-staging.md";
export const SCHEMA_PATH = "resources/epic-staging/epic-staging.schema.json";
export const EXAMPLE_PATH = "resources/epic-staging/epic-staging.example.json";
export const CONTRACT_MARKER = "<!-- epic-staging-contract:v1 -->";

/** The ordered phases. A crash resumes from one of these rather than restarting. */
export const PHASES = Object.freeze([
  "staging_created",
  "deltas_applied",
  "aggregate_verified",
  "accepted",
  "target_advanced",
  "post_cas_verified",
]);

/** Closed park reasons of section 8. */
export const PARK_REASONS = Object.freeze([
  "aggregate_failed",
  "aggregate_binding_void",
  "staging_moved_after_pass",
  "target_moved",
  "foreign_target_movement",
  "acceptance_missing",
  "acceptance_stale",
  "cas_conflict",
  "post_cas_mismatch",
  "environment_failure",
  "receipt_missing",
]);

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

export function epicStagingDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

const phaseIndex = (phase) => PHASES.indexOf(phase);

export function validateStaging(state, schema) {
  const errors = validateJsonSchema(state, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const at = phaseIndex(state.phase);
  const reached = (phase) => at >= phaseIndex(phase);

  if (!state.staging_ref.includes(`/${state.epic_id}/`)) {
    errors.push(`staging_ref is not this Epic's: ${state.staging_ref} does not name ${state.epic_id}`);
  }

  const ticketIds = state.receipts.map((receipt) => receipt.ticket_id);
  if (new Set(ticketIds).size !== ticketIds.length) {
    errors.push("a Ticket has more than one integration receipt");
  }

  // Aggregate: bound to the tree it ran on, and to the exact Ticket set. A PASS
  // that names a different tree than the state it accompanies is a PASS about
  // something else.
  if (reached("aggregate_verified")) {
    const aggregate = state.aggregate;
    if (!aggregate) {
      errors.push(`phase ${state.phase} requires an aggregate verification record`);
    } else {
      if (
        aggregate.staging_commit_oid !== state.staging_commit_oid ||
        aggregate.staging_tree_oid !== state.staging_tree_oid
      ) {
        errors.push("aggregate is bound to a different staging identity (aggregate_binding_void)");
      }
      const included = [...aggregate.included_tickets].sort().join(",");
      if (included !== [...ticketIds].sort().join(",")) {
        errors.push("aggregate covers a different Ticket set than the receipts record");
      }
      // A command failure and an environment failure are different facts, and
      // only one of them says anything about the product. Neither advances.
      if (aggregate.outcome !== "pass" && reached("accepted")) {
        errors.push(`aggregate outcome ${aggregate.outcome} cannot be accepted (aggregate_failed)`);
      }
    }
  } else if (state.aggregate) {
    errors.push(`phase ${state.phase} records an aggregate that has not run`);
  }

  // Acceptance is of an identity, not of a plan to produce one.
  if (reached("accepted")) {
    const acceptance = state.acceptance;
    if (!acceptance) {
      errors.push(`phase ${state.phase} requires an acceptance record (acceptance_missing)`);
    } else {
      if (
        acceptance.staging_commit_oid !== state.staging_commit_oid ||
        acceptance.staging_tree_oid !== state.staging_tree_oid
      ) {
        errors.push("acceptance names a staging identity that is no longer current (acceptance_stale)");
      }
      if (state.aggregate && acceptance.aggregate_record_hash !== state.aggregate.record_hash) {
        errors.push("acceptance cites a different aggregate record than the one that ran");
      }
      if (acceptance.target_ref !== state.target_ref) {
        errors.push("acceptance names a different target ref");
      }
      if (acceptance.recorded_target_base !== state.recorded_target_base) {
        errors.push("acceptance was given against a different target base");
      }
      const included = [...acceptance.included_tickets].sort().join(",");
      if (included !== [...ticketIds].sort().join(",")) {
        errors.push("acceptance covers a different Ticket set than the receipts record");
      }
      // A pinned auto-policy is held to the same binding as a human: the point
      // is the binding, not who supplied it.
      if (acceptance.kind === "human" && !acceptance.decision_id) {
        errors.push("a human acceptance must record the decision it came from");
      }
    }
  } else if (state.acceptance) {
    errors.push(`phase ${state.phase} records an acceptance that has not been given`);
  }

  // The swap happens after acceptance and is verified afterwards. A CAS that
  // reported success is not evidence that the ref holds what was intended.
  if (reached("post_cas_verified")) {
    const post = state.post_cas;
    if (!post) {
      errors.push(`phase ${state.phase} requires post-CAS verification`);
    } else {
      if (post.target_tree_oid !== state.staging_tree_oid) {
        errors.push("the target does not hold the staging tree that was accepted (post_cas_mismatch)");
      }
      if (!post.containment_verified || !post.reflog_verified) {
        errors.push("post-CAS verification must confirm containment and the reflog entry");
      }
    }
  } else if (state.post_cas) {
    errors.push(`phase ${state.phase} records a post-CAS check for a swap that has not happened`);
  }

  if (reached("deltas_applied") && state.receipts.length === 0) {
    errors.push(`phase ${state.phase} has no integration receipts (receipt_missing)`);
  }
  return errors;
}

export function validateEpicStagingDesign(files) {
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
  const phases = schema.properties?.phase?.enum ?? [];
  if (phases.join(",") !== PHASES.join(",")) {
    errors.push(`${SCHEMA_PATH}: phases must be exactly ${PHASES.join(", ")}`);
  }
  // A command failure and an environment failure must be representable
  // separately, or the taxonomy cannot record the distinction the contract makes.
  const outcomes = schema.properties?.aggregate?.properties?.outcome?.enum ?? [];
  for (const required of ["command_failure", "environment_failure"]) {
    if (!outcomes.includes(required)) {
      errors.push(`${SCHEMA_PATH}: aggregate outcome ${required} is not representable`);
    }
  }

  let example;
  try {
    example = JSON.parse(files[EXAMPLE_PATH]);
  } catch (error) {
    return [...errors, `${EXAMPLE_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...validateStaging(example, schema).map((message) => `${EXAMPLE_PATH}: ${message}`));
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateEpicStagingDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const example = JSON.parse(files[EXAMPLE_PATH]);
    console.log("Epic staging design validation PASS");
    console.log(`design_digest=${epicStagingDesignDigest(files)}`);
    console.log(`phase=${example.phase}`);
    console.log(`receipts=${example.receipts.length}`);
  }
}
