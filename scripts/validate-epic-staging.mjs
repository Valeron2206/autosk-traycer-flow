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

import { aggregateRecordHash } from "../src/host/epic-staging.mjs";
import { epicRefKey } from "../src/host/staging-driver.mjs";
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

/** The modes whose delivery is the one target CAS; the others hand it to a PR or queue. */
export const DIRECT_MODES = Object.freeze(["merge", "squash", "rebase"]);

/** Closed park reasons of section 8. */
export const PARK_REASONS = Object.freeze([
  "aggregate_failed",
  "aggregate_binding_void",
  "staging_moved_after_pass",
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

/**
 * What is wrong with one staging record: its schema, its staging ref named by
 * the Epic ref key, its recorded base and replay receipt, one receipt per
 * Ticket, and — for each phase it has reached — the aggregate, acceptance and
 * post-CAS records that phase requires, bound to the tree and Ticket set they
 * are about. Empty when the record holds.
 */
export function validateStaging(state, schema) {
  const errors = validateJsonSchema(state, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const at = phaseIndex(state.phase);
  /** Whether the record's phase is `phase` or later, so the records `phase` produces must be there. */
  const reached = (phase) => at >= phaseIndex(phase);

  // Named by the Epic ref key, never by the display id (ADR-087): the key binds
  // the project too, so two projects' Epics called alike never share a ref.
  if (state.staging_ref !== `refs/autosk/epics/${epicRefKey(state.project_root_sha256, state.epic_id)}/staging`) {
    errors.push(`staging_ref is not this Epic's: ${state.staging_ref} is not named by the key of ${state.epic_id} in this project`);
  }

  // The recorded base starts as the planning base; a re-stage re-records it,
  // and its first commit is then the one planning replay commit a durable
  // receipt binds (ADR-088). The receipt's own schema is #9 work; the record
  // names it by digest.
  if (state.recorded_target_base === state.planning_base_oid) {
    if (state.planning_replay_receipt_sha256 !== undefined) {
      errors.push("a first stage has no planning replay receipt: recorded_target_base is still the planning base");
    }
  } else if (state.planning_replay_receipt_sha256 === undefined) {
    errors.push("a re-staged record names the planning replay receipt that binds its first commit");
  }

  // A re-stage creates the staging ref again, and a create that re-sent the pair of the one before it would create
  // nothing (the daemon answers a repeated request from its journal): a re-staged record is in a later generation.
  if (state.planning_replay_receipt_sha256 !== undefined && !(state.generation >= 1)) {
    errors.push("a re-staged record is in generation 1 or later: its staging asks under a pair of its own");
  }

  const ticketIds = state.receipts.map((receipt) => receipt.ticket_id);
  if (new Set(ticketIds).size !== ticketIds.length) {
    errors.push("a Ticket has more than one integration receipt");
  }
  // The Ticket set is a set everywhere (ADR-089): a repeated receipt is
  // refused above, once, and does not make the aggregate's or the
  // acceptance's set a different one (review of 11e, L3).
  const ticketSet = (list) => [...new Set(list)].sort().join(",");

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
      if (ticketSet(aggregate.included_tickets) !== ticketSet(ticketIds)) {
        errors.push("aggregate covers a different Ticket set than the receipts record");
      }
      // The hash the acceptance binds is the digest of the whole record and of
      // this project and Epic (ADR-099), so a record rewritten after it was
      // hashed — another configuration, lock, tree, Ticket set or outcome —
      // binds nothing.
      const owner = { project_identity: `sha256:${state.project_root_sha256}`, epic_id: state.epic_id };
      if (aggregate.record_hash !== aggregateRecordHash(owner, aggregate)) {
        errors.push("aggregate record_hash is not the digest of its record (aggregate_binding_void)");
      }
      // A command failure and an environment failure are different facts, and
      // only one of them says anything about the product. Neither advances.
      if (aggregate.outcome !== "pass" && reached("accepted")) {
        errors.push(`aggregate outcome ${aggregate.outcome} cannot be accepted (aggregate_failed)`);
      }
      // `indeterminate` is the outcome of a run the machine could not finish,
      // and only that: a failed check is `fail`, a verdict about the product.
      if ((aggregate.outcome === "indeterminate") !== (aggregate.environment_outcome === "environment_failure")) {
        errors.push("outcome indeterminate is exactly an environment failure (environment_failure)");
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
      if (ticketSet(acceptance.included_tickets) !== ticketSet(ticketIds)) {
        errors.push("acceptance covers a different Ticket set than the receipts record");
      }
      // A pinned auto-policy is held to the same binding as a human: the point
      // is the binding, not who supplied it.
      if (acceptance.kind === "human" && !acceptance.decision_id) {
        errors.push("a human acceptance must record the decision it came from");
      }
      if (acceptance.kind === "pinned_auto_policy" && !acceptance.policy_ref) {
        errors.push("a pinned auto-policy acceptance must name the policy that pinned it");
      }
      // Under squash the person accepts the commit that lands (ADR-088); the
      // schema requires it there, and no other mode names a second commit.
      if (
        acceptance.delivery_mode !== "squash" &&
        (acceptance.target_commit_oid !== undefined || acceptance.target_commit_recipe_sha256 !== undefined)
      ) {
        errors.push(`a ${acceptance.delivery_mode} delivery names no target commit`);
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
      const mode = state.acceptance?.delivery_mode;
      if (mode === "squash" && post.target_oid !== state.acceptance.target_commit_oid) {
        errors.push("the target does not hold the commit the squash acceptance named (post_cas_mismatch)");
      } else if ((mode === "merge" || mode === "rebase") && post.target_oid !== state.staging_commit_oid) {
        errors.push("the target does not hold the accepted staging commit (post_cas_mismatch)");
      } else if (mode !== undefined && !DIRECT_MODES.includes(mode)) {
        errors.push(`a ${mode} delivery never runs the target CAS: it completes by the delivery predicate`);
      }
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
  // separately, or the taxonomy cannot record the distinction the contract makes:
  // `fail` and `indeterminate`, the names section 4 and the driver write, and
  // no second name for either.
  const outcomes = schema.properties?.aggregate?.properties?.outcome?.enum ?? [];
  if ([...outcomes].sort().join(",") !== ["fail", "indeterminate", "pass"].join(",")) {
    errors.push(`${SCHEMA_PATH}: aggregate outcome must be exactly pass, fail, indeterminate`);
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
