#!/usr/bin/env node

/**
 * Validator for the integration authorization record.
 *
 * The record is the only token that may skip the human stop before the one
 * irreversible step, so the checks here are about the ways it could authorize
 * something nobody signed: an expired record still being honoured, a plan whose
 * transitions do not chain, a prefix claimed without a receipt, a record issued
 * by a policy, and a terminal record that still reads as permission.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/integration-authorization.md";
export const SCHEMA_PATH = "resources/integration-authorization/integration-authorization.schema.json";
export const EXAMPLE_PATH = "resources/integration-authorization/integration-authorization.example.json";
export const REFUSED_PATH = "resources/integration-authorization/integration-authorization.refused.example.json";
export const CONTRACT_MARKER = "<!-- integration-authorization-contract:v1 -->";

/** The closed refusal set, as the contract states it. */
export const REFUSALS = Object.freeze([
  "integration_authorization_required",
  "integration_authorization_expired",
  "integration_authorization_scope_mismatch",
  "integration_authorization_prefix_mismatch",
  "integration_authorization_head_mismatch",
  "integration_authorization_policy_issued",
  "integration_authorization_terminal",
]);

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * What refuses this record, given when it is being read.
 *
 * Every reason, not the first: a record can be both expired and revoked, and an
 * operator fixing them one round at a time learns the second only after fixing
 * the first.
 */
export function recordRefusals(record, { nowMs, scopeId, targetOid, completedPrefixReceipt, authorizationHead }) {
  // Absent is its own refusal, and the one the workflow meets most often: the
  // integrate step asks for a record and there is none.
  if (!record) return [{ reason: "integration_authorization_required", detail: "no record" }];
  const refusals = [];
  if (authorizationHead !== undefined && record.previous_authorization_head_hash !== authorizationHead) {
    // The chain: a record whose predecessor is not the current head was
    // written against a different history than the one on disk.
    refusals.push({
      reason: "integration_authorization_head_mismatch",
      detail: `chains from ${record.previous_authorization_head_hash}, head is ${authorizationHead}`,
    });
  }
  if (Date.parse(record.expires_at) <= nowMs) {
    // Including mid-plan: an expired record does not still authorize the
    // transitions it once did.
    refusals.push({ reason: "integration_authorization_expired", detail: record.expires_at });
  }
  if (record.terminal_disposition !== "active") {
    refusals.push({ reason: "integration_authorization_terminal", detail: record.terminal_disposition });
  }
  if (scopeId !== undefined && record.scope_id !== scopeId) {
    refusals.push({ reason: "integration_authorization_scope_mismatch", detail: record.scope_id });
  }
  if (record.issued_by !== undefined && record.issued_by !== "user_decision_record") {
    refusals.push({ reason: "integration_authorization_policy_issued", detail: String(record.issued_by) });
  }
  if (!record.user_decision_record_id || !record.user_decision_record_hash) {
    // A policy cannot issue one, and neither can an absence.
    refusals.push({ reason: "integration_authorization_policy_issued", detail: "no signed decision record" });
  }
  if (record.remaining_start_index > 0 && !record.completed_prefix_receipt_hash) {
    refusals.push({
      reason: "integration_authorization_prefix_mismatch",
      detail: `starts at ${record.remaining_start_index} with no completed-prefix receipt`,
    });
  }
  if (record.completed_prefix_receipt_hash && completedPrefixReceipt !== undefined
    && sha256(completedPrefixReceipt) !== record.completed_prefix_receipt_hash) {
    refusals.push({ reason: "integration_authorization_prefix_mismatch", detail: "the receipt does not hash to the recorded prefix" });
  }
  if (record.remaining_start_index >= record.ordered_ref_transitions.length) {
    refusals.push({
      reason: "integration_authorization_prefix_mismatch",
      detail: "the record authorizes no remaining transition",
    });
  }
  const start = record.ordered_ref_transitions[record.remaining_start_index];
  if (targetOid !== undefined && start && start.from_oid !== targetOid) {
    // A new record after a partial CAS starts from where the branch IS.
    refusals.push({ reason: "integration_authorization_prefix_mismatch", detail: `starts from ${start.from_oid}, branch is at ${targetOid}` });
  }
  return refusals;
}

/** Whether the plan is a chain rather than a set of hops that happen to exist. */
export function planErrors(record) {
  const errors = [];
  const transitions = record.ordered_ref_transitions;
  transitions.forEach((transition, position) => {
    if (transition.index !== position) {
      errors.push(`ordered_ref_transitions[${position}]: index ${transition.index} is out of order`);
    }
    if (position === 0) {
      if (transition.from_oid !== record.initial_target_oid) {
        errors.push("ordered_ref_transitions[0] does not start at initial_target_oid");
      }
      return;
    }
    if (transition.from_oid !== transitions[position - 1].to_oid) {
      errors.push(`ordered_ref_transitions[${position}] does not continue the previous transition`);
    }
  });
  if (transitions.length !== record.ordered_ticket_commit_oids.length) {
    errors.push("the transitions and the ticket commits are not the same plan");
  }
  transitions.forEach((transition, position) => {
    if (record.ordered_ticket_commit_oids[position] !== transition.to_oid) {
      errors.push(`ordered_ref_transitions[${position}] does not land on the ticket commit at that position`);
    }
  });
  if (record.epic_id === null && !record.quick_task_id) {
    errors.push("a Quick authorization names its quick_task_id");
  }
  if (record.epic_id !== null && record.quick_task_id) {
    errors.push("an Epic authorization does not also name a Quick task");
  }
  return errors;
}

/** The shipped design: contract, schema, and the two examples doing their jobs. */
export function validateDesign(files, { nowMs = Date.parse("2026-09-09T00:00:00Z") } = {}) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract || !contract.includes(CONTRACT_MARKER)) {
    errors.push(`${CONTRACT_PATH}: the contract marker is missing`);
  }
  for (const refusal of REFUSALS) {
    if (contract && !contract.includes(`\`${refusal}\``)) {
      errors.push(`${CONTRACT_PATH}: ${refusal} is not named in the contract`);
    }
  }
  const schema = JSON.parse(files[SCHEMA_PATH]);
  if (schema.additionalProperties !== false) errors.push(`${SCHEMA_PATH}: the schema is not closed`);

  const example = JSON.parse(files[EXAMPLE_PATH]);
  errors.push(...validateJsonSchema(example, schema).map((message) => `${EXAMPLE_PATH}: ${message}`));
  errors.push(...planErrors(example).map((message) => `${EXAMPLE_PATH}: ${message}`));
  const admitted = recordRefusals(example, { nowMs, scopeId: example.scope_id, targetOid: example.initial_target_oid });
  if (admitted.length > 0) {
    errors.push(`${EXAMPLE_PATH}: the worked example is refused (${admitted.map((entry) => entry.reason).join(", ")})`);
  }

  const refused = JSON.parse(files[REFUSED_PATH]);
  errors.push(...validateJsonSchema(refused, schema).map((message) => `${REFUSED_PATH}: ${message}`));
  const produced = new Set(recordRefusals(refused, { nowMs, scopeId: "another-scope" }).map((entry) => entry.reason));
  // The refused example earns its name by producing more than one class: a
  // record refused for a single reason teaches one rule.
  if (produced.size < 3) {
    errors.push(`${REFUSED_PATH}: the refused example produces only ${produced.size} refusal classes`);
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = Object.fromEntries(
    [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, REFUSED_PATH].map((relative) => [
      relative,
      readFileSync(path.join(ROOT, relative), "utf8"),
    ]),
  );
  const errors = validateDesign(files);
  for (const error of errors) console.error(error);
  if (errors.length > 0) process.exitCode = 1;
  else {
    console.log("Integration authorization contract validation PASS");
    console.log(`refusals=${REFUSALS.length}`);
  }
}
