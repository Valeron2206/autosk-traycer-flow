#!/usr/bin/env node

/**
 * Design-time validator for the issue #11 signed creation grant.
 *
 * The gap this closes is not that the daemon fails to validate a grant — it
 * validates every field. It is that a caller inside the session knows every one
 * of those fields, because they describe the session it is running in, so a
 * hand-written grant with correct values passes. What the daemon cannot tell is
 * WHO produced it.
 *
 * So this validator does not check the shape of a signature. It verifies one,
 * with real Ed25519, against the shipped public key — and the tests tamper with
 * the grant to show verification fails. A design that is only described could
 * be described wrongly; this one is demonstrated.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/creation-grant.md";
export const SCHEMA_PATH = "resources/creation-grant/creation-grant.schema.json";
export const EXAMPLE_PATH = "resources/creation-grant/creation-grant.example.json";
export const PUBLIC_KEY_PATH = "resources/creation-grant/creation-grant.verifying-key.pem";
export const CONTRACT_MARKER = "<!-- creation-grant-contract:v1 -->";

/** Closed park reasons of section 7. */
export const PARK_REASONS = Object.freeze([
  "grant_unsigned",
  "grant_signature_invalid",
  "grant_expired",
  "grant_operation_mismatch",
  "grant_slot_tampered",
  "grant_binding_mismatch",
  "daemon_capability_missing",
  "daemon_capability_version_mismatch",
  "daemon_capability_method_mismatch",
]);

/** The binding fields, in the order the signed message serialises them. */
export const BINDING_FIELDS = Object.freeze([
  "schema_version",
  "grant_id",
  "project_sha256",
  "parent_task_id",
  "session_id",
  "workflow",
  "step",
  "step_visit",
  "operation_id",
  "context_digest",
  "expires_at_ms",
]);

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, PUBLIC_KEY_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function creationGrantDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

/**
 * The bytes the host signs: the binding AND the slots.
 *
 * Signing the binding alone would leave the slot list malleable, and the slot
 * list is what the grant permits — appending a slot would create a child the
 * host never authorised while presenting a valid signature.
 */
export function signedMessage(grant) {
  const binding = BINDING_FIELDS.map((field) => `${field}=${String(grant.binding[field])}`).join("\n");
  const slots = grant.slots
    .map((slot) => [slot.slot_id, slot.creation_key, slot.creation_binding_hash].join(" "))
    .join("\n");
  return Buffer.from(`autosk-scoped-task-creation/v1\n${binding}\n--\n${slots}\n`, "utf8");
}

/** Verifies a grant's signature against a PEM public key. */
export function verifyGrant(grant, publicKeyPem) {
  if (!grant.signature) return false;
  const key = createPublicKey(publicKeyPem);
  return cryptoVerify(null, signedMessage(grant), key, Buffer.from(grant.signature.value, "hex"));
}

export function validateGrant(grant, schema, publicKeyPem, { nowMs } = {}) {
  const errors = validateJsonSchema(grant, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  if (!verifyGrant(grant, publicKeyPem)) {
    errors.push("signature does not verify over the binding and slots (grant_signature_invalid)");
  }

  const slotIds = grant.slots.map((slot) => slot.slot_id);
  if (new Set(slotIds).size !== slotIds.length) errors.push("a slot id appears twice");
  const keys = grant.slots.map((slot) => slot.creation_key);
  if (new Set(keys).size !== keys.length) {
    errors.push("two slots share a creation key, so one grant could create the same child twice");
  }

  if (nowMs !== undefined && grant.binding.expires_at_ms <= nowMs) {
    errors.push("grant has expired (grant_expired)");
  }
  return errors;
}

export function validateCreationGrantDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const reason of PARK_REASONS) {
    if (!contract.includes(reason)) errors.push(`${CONTRACT_PATH}: park reason ${reason} is not documented`);
  }
  // The two decisions this contract exists to make must both be stated.
  if (!contract.includes("binding **and** the slots")) {
    errors.push(`${CONTRACT_PATH}: does not state that the slots are signed as well as the binding`);
  }
  if (!contract.includes("extension load")) {
    errors.push(`${CONTRACT_PATH}: does not state where the preflight runs`);
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
  // A grant without a signature must not be shape-valid: an unsigned grant is
  // the exact thing the caller can write, so it cannot be a legal document.
  if (!(schema.required ?? []).includes("signature")) {
    errors.push(`${SCHEMA_PATH}: signature must be required, or an unsigned grant is shape-valid`);
  }

  const publicKeyPem = files[PUBLIC_KEY_PATH];
  if (!publicKeyPem.includes("BEGIN PUBLIC KEY")) {
    errors.push(`${PUBLIC_KEY_PATH}: is not a PEM public key`);
  }
  if (publicKeyPem.includes("PRIVATE KEY")) {
    // The verifying key is published; the signing key never leaves the daemon.
    errors.push(`${PUBLIC_KEY_PATH}: contains a private key, which must never be in the repository`);
  }

  let example;
  try {
    example = JSON.parse(files[EXAMPLE_PATH]);
  } catch (error) {
    return [...errors, `${EXAMPLE_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...validateGrant(example, schema, publicKeyPem).map((message) => `${EXAMPLE_PATH}: ${message}`));
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateCreationGrantDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const example = JSON.parse(files[EXAMPLE_PATH]);
    console.log("Creation grant design validation PASS");
    console.log(`design_digest=${creationGrantDesignDigest(files)}`);
    console.log(`signature_verified=true slots=${example.slots.length}`);
  }
}
