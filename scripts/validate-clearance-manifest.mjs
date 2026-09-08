#!/usr/bin/env node

/**
 * Design-time validator for the issue #20 clearance manifest.
 *
 * Scanning the source files before the prompt is compiled does not establish
 * that the prompt is safe: dangerous fragments appear when fragments are joined,
 * when a template substitutes, and in diagnostics no source file contains. So
 * the checks here are about the three ways a clearance stops meaning anything:
 * a scan of something other than what will be sent, a scanner whose silence was
 * read as a pass, and a manifest that quotes what it found.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/clearance-manifest.md";
export const SCHEMA_PATH = "resources/clearance-manifest/clearance-manifest.schema.json";
export const EXAMPLE_PATH = "resources/clearance-manifest/clearance-manifest.example.json";
export const BLOCKED_EXAMPLE_PATH = "resources/clearance-manifest/clearance-manifest.blocked.example.json";
export const CONTRACT_MARKER = "<!-- clearance-manifest-contract:v1 -->";

export const REFUSALS = Object.freeze([
  "clearance_scanner_missing",
  "clearance_scanner_selftest_failed",
  "clearance_scanner_unknown_result",
  "clearance_secret_found",
  "clearance_personal_data_unreviewed",
  "clearance_digest_mismatch",
  "clearance_manifest_contains_secret",
  "clearance_exception_stale",
  "clearance_binary_unclassified",
  "clearance_keyword_grep_as_evidence",
]);

/**
 * Whether this manifest clears a dispatch.
 *
 * Computed, and every clause is a way a dispatch could otherwise go out on a
 * result nobody understood.
 */
export function dispatchDecision(manifest) {
  const scanner = manifest.scanner;
  if (scanner.self_test.state !== "passed") return "refused:clearance_scanner_selftest_failed";
  if (!scanner.self_test.planted_token_detected) return "refused:clearance_scanner_selftest_failed";
  if (scanner.self_test.clean_fixture_exit !== 0) return "refused:clearance_scanner_selftest_failed";
  if (scanner.keyword_grep_only === true) return "refused:clearance_keyword_grep_as_evidence";
  if (scanner.result === "unknown") return "refused:clearance_scanner_unknown_result";
  if (scanner.result === "findings") return "refused:clearance_secret_found";
  // The bytes that were scanned must be the bytes that will be sent.
  if (scanner.scanned_sha256 !== manifest.sanitized_body_sha256) return "refused:clearance_digest_mismatch";
  if (manifest.personal_data_review.state === "unreviewed") return "refused:clearance_personal_data_unreviewed";
  if (manifest.personal_data_review.state === "blocked") return "refused:clearance_personal_data_unreviewed";
  for (const source of manifest.included_sources) {
    if (source.classification === undefined) return "refused:clearance_binary_unclassified";
  }
  if (manifest.exception !== undefined) {
    if (
      manifest.exception.scope_dispatch_id !== manifest.dispatch_id ||
      manifest.exception.scope_candidate_identity !== manifest.candidate_identity
    ) {
      return "refused:clearance_exception_stale";
    }
  }
  return "cleared";
}

/**
 * Anything in the manifest that looks like a credential.
 *
 * A record of what was found that quotes what was found has moved the secret
 * rather than removed it — into a file kept longer and read more widely than
 * the prompt ever was. Deliberately crude and deliberately not a keyword grep:
 * it looks for high-entropy runs and for the shapes real tokens have.
 */
export const SECRET_SHAPES = Object.freeze([
  /\bgh[pousr]_[A-Za-z0-9]{16,}/u,
  /\bsk-[A-Za-z0-9]{20,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/u,
]);

export function manifestQuotesASecret(manifest) {
  const text = JSON.stringify(manifest);
  return SECRET_SHAPES.some((shape) => shape.test(text));
}

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, BLOCKED_EXAMPLE_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function clearanceDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

export function validateManifest(manifest, schema) {
  const errors = validateJsonSchema(manifest, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  if (manifestQuotesASecret(manifest)) {
    errors.push("the manifest quotes something shaped like a credential (clearance_manifest_contains_secret)");
  }
  // `findings` without a count, or a count without findings, is a record that
  // cannot be read back: the two say the same thing and must not disagree.
  const count = manifest.scanner.finding_count;
  if (manifest.scanner.result === "findings" && (count === undefined || count < 1)) {
    errors.push("a findings result must say how many");
  }
  if (manifest.scanner.result === "clean" && count !== undefined && count > 0) {
    errors.push("a clean result cannot carry findings");
  }
  // Deliberately NOT checked here: a manifest that redacted and then could not
  // scan is a legal record of a refused dispatch, and `dispatchDecision` refuses
  // it. Reporting it as a malformed record would confuse "this dispatch may not
  // go out" with "this record is wrong", and only one of those is fixable by
  // editing the file.
  return errors;
}

export function validateClearanceManifestDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const refusal of REFUSALS) {
    if (!contract.includes(refusal)) errors.push(`${CONTRACT_PATH}: refusal ${refusal} is not documented`);
  }
  if (!contract.includes("**never** `clean`")) {
    errors.push(`${CONTRACT_PATH}: does not state that an unknown scanner result is not clean`);
  }
  if (!contract.includes("No secret value appears in the manifest")) {
    errors.push(`${CONTRACT_PATH}: does not state that the manifest quotes nothing it found`);
  }
  if (!contract.includes("`.gitignore` is not a protection boundary")) {
    errors.push(`${CONTRACT_PATH}: does not state that an ignored tracked file is tracked content`);
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
  const results = schema.properties?.scanner?.properties?.result?.enum ?? [];
  if (results.slice().sort().join(",") !== "clean,findings,unknown") {
    errors.push(`${SCHEMA_PATH}: a scanner result must be exactly clean, findings or unknown`);
  }
  // The schema has no field for a found value, which is stronger than a rule
  // against writing one.
  const redactionProps = Object.keys(schema.properties?.redactions?.items?.properties ?? {});
  if (redactionProps.includes("value") || redactionProps.includes("matched_text")) {
    errors.push(`${SCHEMA_PATH}: a redaction record must not have a field for what it redacted`);
  }
  const selfTest = schema.properties?.scanner?.properties?.self_test?.required ?? [];
  if (!selfTest.includes("planted_token_detected") || !selfTest.includes("clean_fixture_exit")) {
    errors.push(`${SCHEMA_PATH}: the self-test must record both halves`);
  }

  for (const relative of [EXAMPLE_PATH, BLOCKED_EXAMPLE_PATH]) {
    let manifest;
    try {
      manifest = JSON.parse(files[relative]);
    } catch (error) {
      errors.push(`${relative}: not valid JSON: ${error.message}`);
      continue;
    }
    errors.push(...validateManifest(manifest, schema).map((message) => `${relative}: ${message}`));
  }
  // The two examples must land on opposite sides, or the pair proves nothing.
  const cleared = JSON.parse(files[EXAMPLE_PATH]);
  const blocked = JSON.parse(files[BLOCKED_EXAMPLE_PATH]);
  if (dispatchDecision(cleared) !== "cleared") {
    errors.push(`${EXAMPLE_PATH}: the cleared example does not clear (${dispatchDecision(cleared)})`);
  }
  if (dispatchDecision(blocked) === "cleared") {
    errors.push(`${BLOCKED_EXAMPLE_PATH}: the blocked example clears`);
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateClearanceManifestDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Clearance manifest design validation PASS");
    console.log(`design_digest=${clearanceDesignDigest(files)}`);
    console.log(`refusals=${REFUSALS.length} shapes=${SECRET_SHAPES.length}`);
  }
}
