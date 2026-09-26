#!/usr/bin/env node

/**
 * Validator for the integration authorization record.
 *
 * The record is the only token that may skip the human stop before the one
 * irreversible step, so the checks here are about the ways it could authorize
 * something nobody signed: an expired record still being honoured, a transition
 * that does not start where the record says the branch was or where the branch
 * is, a record issued by a policy, and a terminal record that still reads as
 * permission.
 *
 * The target moves by one CAS, so a record names exactly one transition. The
 * per-Ticket order this validator was first written for — an ordered plan, a
 * start index into it and a receipt for the completed prefix — is gone with that
 * order, and the schema refuses a record shaped for it.
 */

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

/**
 * What refuses this record, given when it is being read.
 *
 * Every reason, not the first: a record can be both expired and revoked, and an
 * operator fixing them one round at a time learns the second only after fixing
 * the first.
 */
export function recordRefusals(record, { nowMs, scopeId, targetOid, authorizationHead }) {
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
    // Including before the CAS it was signed for: an expired record does not
    // authorize the movement it once did.
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
  if (targetOid !== undefined && record.ref_transition.from_oid !== targetOid) {
    // The one transition starts where the record says the branch was. A branch
    // that is somewhere else is a different branch state from the one signed
    // for, and the record does not follow it there.
    refusals.push({
      reason: "integration_authorization_prefix_mismatch",
      detail: `starts from ${record.ref_transition.from_oid}, branch is at ${targetOid}`,
    });
  }
  return refusals;
}

/**
 * Whether the record's one transition is the one it says it is.
 *
 * It starts at `initial_target_oid`, the branch state the signature was made
 * against — the recorded base the one CAS expects to find.
 */
export function planErrors(record) {
  const errors = [];
  const transition = record.ref_transition;
  if (transition.from_oid !== record.initial_target_oid) {
    errors.push("ref_transition does not start at initial_target_oid");
  }
  if (record.epic_id === null && !record.quick_task_id) {
    errors.push("a Quick authorization names its quick_task_id");
  }
  if (record.epic_id === null && record.ordered_ticket_commit_oids.length !== 1) {
    // A Quick run integrates one reviewed candidate; a record naming several is
    // about some other integration.
    errors.push("a Quick authorization names its one reviewed candidate");
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
