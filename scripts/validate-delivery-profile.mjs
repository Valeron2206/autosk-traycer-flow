#!/usr/bin/env node

/**
 * Design-time validator for the issue #17 project delivery profile.
 *
 * A profile is a set of claims about what the host is allowed to do with refs,
 * and every one of them has to be answerable before the first implementation
 * dispatch. This checks the claims against each other: a profile that forbids
 * direct push while permitting a local fast-forward, a required check with no
 * provenance, discovery with no expiry, or a digest that does not recompute are
 * failures here rather than at the push that cannot be undone.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/delivery-profile.md";
export const SCHEMA_PATH = "resources/delivery-profile/delivery-profile.schema.json";
export const EXAMPLE_PATH = "resources/delivery-profile/delivery-profile.example.json";
export const CONTRACT_MARKER = "<!-- delivery-profile-contract:v1 -->";

/** Closed park reasons of section 9. */
export const PARK_REASONS = Object.freeze([
  "unsupported_integration_mode",
  "unknown_binding_field",
  "discovery_unavailable",
  "discovery_expired",
  "remote_unreachable",
  "permission_denied",
  "profile_drift",
  "credential_missing",
  "completion_predicate_unmet",
]);

/** The four reasons the profile itself may record as `unresolved`. */
export const UNRESOLVED_REASONS = Object.freeze([
  "unknown_binding_field",
  "discovery_unavailable",
  "discovery_expired",
  "credential_missing",
]);

/** Modes that move the target without a pull request. */
export const DIRECT_MODES = Object.freeze(["merge", "squash", "rebase"]);

/** Modes that go through a forge review surface instead. */
export const REVIEW_MODES = Object.freeze(["pull_request", "merge_queue", "fork_pull_request"]);

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

function valueAt(profile, pointer) {
  return pointer.split("/").reduce((node, key) => (node === undefined ? undefined : node[key]), profile);
}

/**
 * The digest section 5 binds identity to.
 *
 * It covers exactly the fields the profile names as binding, so a rationale can
 * be reworded without invalidating a candidate that never depended on it, and a
 * required check cannot be added without invalidating one that did.
 */
export function profileDigest(profile) {
  const canonical = profile.binding_fields
    .slice()
    .sort()
    .map((pointer) => `${pointer}=${JSON.stringify(valueAt(profile, pointer)) ?? "undefined"}`)
    .join(";");
  return sha256(canonical);
}

/** The identity of this design as bytes, so a review verdict can be bound to it. */
export function deliveryProfileDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

function isUnknown(value) {
  return value === "unknown";
}

export function validateProfile(profile, schema) {
  const errors = validateJsonSchema(profile, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const modes = profile.integration.allowed_modes;
  const allowsDirect = modes.some((mode) => DIRECT_MODES.includes(mode));
  const allowsReview = modes.some((mode) => REVIEW_MODES.includes(mode));

  // A pull-request-only project must not also record permission to move the
  // target itself. This is the criterion the issue states in as many words, and
  // it is the one a hidden fallback would quietly break.
  if (!allowsDirect && profile.target.direct_push_allowed) {
    errors.push(
      "target.direct_push_allowed is true but no direct integration mode is allowed: " +
        "a review-only project cannot also be permitted to move the target",
    );
  }
  if (allowsReview && profile.integration.pull_request === "not_applicable") {
    errors.push("integration.pull_request cannot be not_applicable when a review mode is allowed");
  }
  if (profile.integration.merge_queue_required === true && !modes.includes("merge_queue")) {
    errors.push("integration.merge_queue_required is true but merge_queue is not an allowed mode");
  }

  // Every unresolved field must actually be unresolved, and every recorded
  // reason must be one the profile may record. An `unresolved` entry naming a
  // field that has a real value is worse than no entry: it invites a park that
  // nothing will clear.
  const unresolvedFields = new Set();
  for (const entry of profile.unresolved) {
    if (!UNRESOLVED_REASONS.includes(entry.reason)) {
      errors.push(`unresolved ${entry.field}: ${entry.reason} is not a recordable reason`);
    }
    unresolvedFields.add(entry.field);
    const value = valueAt(profile, entry.field);
    if (value !== undefined && !isUnknown(value)) {
      errors.push(`unresolved ${entry.field}: recorded as unresolved but holds ${JSON.stringify(value)}`);
    }
  }

  // The other direction: an `unknown` in a binding field must be declared, or
  // the Epic would proceed on a value nobody chose.
  for (const pointer of profile.binding_fields) {
    const value = valueAt(profile, pointer);
    if (value === undefined) {
      errors.push(`binding_fields names ${pointer}, which the profile does not contain`);
    } else if (isUnknown(value) && !unresolvedFields.has(pointer)) {
      errors.push(`${pointer} is unknown but not recorded in unresolved: it would be decided by default`);
    }
  }

  // Discovery is evidence with a shelf life.
  for (const [area, provenance] of Object.entries(profile.provenance)) {
    if (provenance.source === "remote_discovery") {
      if (!provenance.observed_at || !provenance.expires_at) {
        errors.push(`provenance.${area}: remote_discovery must record observed_at and expires_at`);
      } else if (Date.parse(provenance.expires_at) <= Date.parse(provenance.observed_at)) {
        errors.push(`provenance.${area}: expires_at must be after observed_at`);
      }
    }
    if (provenance.source === "project_config" && !provenance.blob_oid) {
      errors.push(`provenance.${area}: project_config must record the blob_oid it was read from`);
    }
    if (provenance.source === "human_decision" && (!provenance.decision_id || !provenance.decision_scope)) {
      errors.push(`provenance.${area}: human_decision must record decision_id and decision_scope`);
    }
  }

  for (const check of profile.checks.required) {
    if (!check.provenance || !check.provenance.source) {
      errors.push(`checks.required ${check.name}: every required check must name where it came from`);
    }
  }

  if (profile.release.deploy_excluded !== true) {
    errors.push("release.deploy_excluded must be true: deployment to real users is out of scope");
  }

  const expected = profileDigest(profile);
  if (profile.profile_digest !== expected) {
    errors.push(`profile_digest does not recompute: recorded ${profile.profile_digest}, computed ${expected}`);
  }
  return errors;
}

export function validateDeliveryProfileDesign(files) {
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
  // Section 8 is a claim about the schema, not a policy: there must be no field
  // that could hold a credential. Checked here so the claim cannot rot.
  const serialised = JSON.stringify(schema);
  for (const forbidden of ["token", "password", "secret", "private_key", "passphrase"]) {
    if (new RegExp(`"[a-z_]*${forbidden}[a-z_]*"\\s*:\\s*\\{`, "u").test(serialised)) {
      errors.push(`${SCHEMA_PATH}: defines a field matching ${forbidden}; the schema must not be able to hold one`);
    }
  }

  let example;
  try {
    example = JSON.parse(files[EXAMPLE_PATH]);
  } catch (error) {
    return [...errors, `${EXAMPLE_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...validateProfile(example, schema).map((message) => `${EXAMPLE_PATH}: ${message}`));
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateDeliveryProfileDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const example = JSON.parse(files[EXAMPLE_PATH]);
    console.log("Delivery profile design validation PASS");
    console.log(`design_digest=${deliveryProfileDesignDigest(files)}`);
    console.log(`profile_digest=${example.profile_digest}`);
  }
}
