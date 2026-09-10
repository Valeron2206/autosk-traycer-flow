/**
 * Validates that the pinned patch series still carries the runtime identity lock.
 *
 * The lock itself is not built here. Patches `0003` and `0005` already pin a
 * task to the distribution it was admitted under and to the shape its workflow
 * declared, refuse a mismatch with `extension_version_mismatch`, and re-check the
 * identity between two steps and not only at enroll and resume. The gap this
 * closes is on the design side: nothing in this repository noticed if a later
 * patch quietly dropped any of that, so the guarantee lived only in code nobody
 * here checked.
 *
 * The check is anchored rather than parsed. Reading TypeScript with regular
 * expressions is the same mistake as reading a plan's prose with them, and this
 * repository has paid for that twice. Instead each requirement names one line the
 * series must add, the patch that adds it, and how many times — so a requirement
 * is either met by bytes the manifest already pins, or it fails.
 *
 * What it therefore does NOT claim: that the code is correct, that the tests
 * pass, or that the lock covers what criterion 2 asks a graph digest to cover.
 * The shape digest covers steps and hook names and says so; the document slice 2
 * shipped is not read at runtime until the factory of slice 5. This file checks
 * that what exists keeps existing.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/runtime-identity-lock.md";
export const SCHEMA_PATH = "resources/runtime-identity-lock/runtime-identity-lock.schema.json";
export const LOCK_PATH = "resources/runtime-identity-lock/runtime-identity-lock.v1.json";
export const REFUSED_PATH = "resources/runtime-identity-lock/runtime-identity-lock.refused.example.json";
export const MANIFEST_PATH = "compat/autosk/manifest.v1.json";
export const PATCH_ROOT = "compat/autosk";
export const CONTRACT_MARKER = "<!-- runtime-identity-lock-contract:v1 -->";

/**
 * Every way this validator refuses.
 *
 * Closed, and closed by the contract: a refusal the contract does not name is a
 * refusal nobody agreed to.
 */
export const REFUSALS = Object.freeze([
  "lock_digest_stale",
  "lock_duplicate_id",
  "lock_not_json",
  "lock_patch_digest_stale",
  "lock_patch_unknown",
  "lock_requirement_count",
  "lock_requirement_unmet",
  "lock_schema",
]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The digest the requirement set is bound to. */
export function lockDigest(lock) {
  const { lock_digest, ...body } = lock;
  return sha256(Buffer.from(JSON.stringify(body), "utf8"));
}

/**
 * The lines a patch adds.
 *
 * A unified diff marks them with a single `+`, and `+++` is the file header
 * rather than content — counting it as an added line would let a requirement be
 * met by a filename.
 */
export function addedLines(patch) {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
}

/** How many times a patch adds exactly this line. */
export function countAdded(patch, line) {
  return addedLines(patch).filter((added) => added === line).length;
}

export function validateLock(lock, schema, { manifest, readPatch }) {
  const errors = validateShape(lock, schema).map((message) => `lock_schema: ${message}`);
  if (errors.length > 0) return errors;

  if (lock.lock_digest !== lockDigest(lock)) {
    errors.push("lock_digest_stale: the recorded digest does not recompute");
  }

  const seen = new Set();
  for (const requirement of lock.requirements) {
    if (seen.has(requirement.id)) errors.push(`lock_duplicate_id: ${requirement.id} is declared twice`);
    seen.add(requirement.id);
  }

  const pinned = new Map((manifest.patches ?? []).map((entry) => [entry.file, entry.sha256]));
  for (const requirement of lock.requirements) {
    const digest = pinned.get(requirement.patch);
    if (digest === undefined) {
      errors.push(`lock_patch_unknown: ${requirement.id} names ${requirement.patch}, which the manifest does not carry`);
      continue;
    }
    let bytes;
    try {
      bytes = readPatch(requirement.patch);
    } catch (error) {
      errors.push(`lock_patch_unknown: ${requirement.id} names ${requirement.patch}, which is not on disk (${error.message})`);
      continue;
    }
    // The manifest already pins these bytes, so a changed patch is caught there
    // too — but a requirement anchored to bytes nobody verified would be an
    // assertion about a file this check never read.
    if (sha256(bytes) !== digest) {
      errors.push(`lock_patch_digest_stale: ${requirement.patch} is not the bytes the manifest pins`);
      continue;
    }
    const found = countAdded(bytes.toString("utf8"), requirement.added_line);
    if (found === 0) {
      errors.push(`lock_requirement_unmet: ${requirement.id} is not met; ${requirement.patch} no longer adds its line`);
    } else if (found !== requirement.occurrences) {
      errors.push(
        `lock_requirement_count: ${requirement.id} expects ${requirement.occurrences} and ${requirement.patch} adds ${found}`,
      );
    }
  }
  return errors.sort();
}

/**
 * The schema check.
 *
 * Written here rather than borrowed: the shared engine implements the positive
 * keywords only, and this document needs nothing more than those.
 */
export function validateShape(value, schema, at = "$") {
  const errors = [];
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [`${at} is not an object`];
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${at}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) errors.push(`${at}.${key} is not a declared field`);
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) errors.push(...validateShape(value[key], child, `${at}.${key}`));
    }
    return errors;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${at} is not an array`];
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at} has too many items`);
    value.forEach((item, index) => errors.push(...validateShape(item, schema.items ?? {}, `${at}[${index}]`)));
    return errors;
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${at} is not ${JSON.stringify(schema.const)}`);
  if (schema.type === "integer" && !Number.isInteger(value)) errors.push(`${at} is not an integer`);
  if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at} is below the minimum`);
  if (schema.type === "string") {
    if (typeof value !== "string") return [`${at} is not a string`];
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at} is too long`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${at} does not match`);
  }
  return errors;
}

export function loadFiles(root = ROOT) {
  const read = (relative) => readFileSync(path.join(root, relative), "utf8");
  return {
    [CONTRACT_PATH]: read(CONTRACT_PATH),
    [SCHEMA_PATH]: read(SCHEMA_PATH),
    [LOCK_PATH]: read(LOCK_PATH),
    [REFUSED_PATH]: read(REFUSED_PATH),
    [MANIFEST_PATH]: read(MANIFEST_PATH),
  };
}

export function patchReader(root = ROOT) {
  return (relative) => readFileSync(path.join(root, PATCH_ROOT, relative));
}

export function validateDesign(files, { readPatch = patchReader() } = {}) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  for (const refusal of REFUSALS) {
    if (!contract.includes(`\`${refusal}\``)) errors.push(`${CONTRACT_PATH}: does not close ${refusal}`);
  }

  let schema;
  let manifest;
  try {
    schema = JSON.parse(files[SCHEMA_PATH]);
    manifest = JSON.parse(files[MANIFEST_PATH]);
  } catch (error) {
    return [...errors, `lock_not_json: ${error.message}`];
  }

  for (const relative of [LOCK_PATH, REFUSED_PATH]) {
    let document;
    try {
      document = JSON.parse(files[relative]);
    } catch (error) {
      errors.push(`${relative}: lock_not_json: ${error.message}`);
      continue;
    }
    const found = validateLock(document, schema, { manifest, readPatch });
    if (relative === LOCK_PATH) {
      errors.push(...found.map((message) => `${relative}: ${message}`));
    } else if (found.length === 0) {
      errors.push(`${relative}: accepted, and it exists to be refused`);
    }
  }

  // Every requirement must name a line the contract also explains, so the
  // requirement set cannot grow past what a reader was told it guarantees.
  try {
    const lock = JSON.parse(files[LOCK_PATH]);
    for (const requirement of lock.requirements) {
      if (!contract.includes(requirement.id)) {
        errors.push(`${CONTRACT_PATH}: does not name the requirement ${requirement.id}`);
      }
    }
  } catch {
    // already reported above
  }
  return errors.sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateDesign(files);
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    const lock = JSON.parse(files[LOCK_PATH]);
    const patches = new Set(lock.requirements.map((entry) => entry.patch));
    console.log("Runtime identity lock validation PASS");
    console.log(`requirements=${lock.requirements.length} patches=${patches.size}`);
    console.log(`lock_digest=${lock.lock_digest}`);
  }
}
