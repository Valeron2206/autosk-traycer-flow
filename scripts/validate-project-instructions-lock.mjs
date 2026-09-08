#!/usr/bin/env node

/**
 * Design-time validator for the issue #12 project instruction lock.
 *
 * It checks the contract, the closed schema and the worked example against each
 * other, and it recomputes every digest the contract says binds identity. The
 * point is that a lock cannot claim a property the bytes do not have: a
 * `combined_digest` that does not recompute, an ordinal that does not follow
 * precedence order, a governed directory that is not the file's own parent, or
 * a path admitted and excluded at once are all failures here rather than
 * surprises at dispatch.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/project-instructions-lock.md";
export const SCHEMA_PATH = "resources/project-instructions/project-instructions-lock.schema.json";
export const EXAMPLE_PATH = "resources/project-instructions/project-instructions-lock.example.json";
export const CONTRACT_MARKER = "<!-- project-instructions-lock-contract:v1 -->";
export const DISCOVERY_ALGORITHM = "autosk-flow/instruction-discovery/v1";

/** The five ranks of section 6, highest first. Order is the contract, not a preference. */
export const PRECEDENCE = Object.freeze([
  "user_corrections",
  "approved_epic_artifacts",
  "pinned_project_instructions",
  "governance_protocol",
  "role_stage_contract",
]);

/** Closed park reasons of section 9. A reason outside this set is not a reason. */
export const PARK_REASONS = Object.freeze([
  "unsupported_filename",
  "same_depth_conflict",
  "material_conflict",
  "limit_exceeded",
  "not_a_regular_blob",
  "clearance_required",
  "outside_root",
  "identity_mismatch",
  "drift_detected",
  "discovery_failed",
]);

/** Exclusion reasons the lock itself may record (a subset of {@link PARK_REASONS}). */
export const EXCLUSION_REASONS = Object.freeze([
  "unsupported_filename",
  "not_a_regular_blob",
  "clearance_required",
  "limit_exceeded",
  "outside_root",
]);

const HEX64 = /^[a-f0-9]{64}$/u;

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

/**
 * The digest section 5 binds identity to.
 *
 * It covers the admitted list in precedence order plus the two things that
 * decide what "admitted" means at all — the discovery algorithm and the closed
 * filename list. Leaving those out would let a lock keep its digest while the
 * rule that produced it changed underneath.
 */
export function combinedDigest(lock) {
  const canonical = [
    lock.discovery_algorithm,
    lock.supported_filenames.join(","),
    ...lock.admitted.map((entry) =>
      [entry.ordinal, entry.path, entry.mode, entry.size_bytes, entry.sha256].join(" "),
    ),
  ].join("");
  return sha256(canonical);
}

/** The identity of this design as bytes, so a review verdict can be bound to it. */
export function instructionLockDesignDigest(files) {
  const canonical = Object.keys(files)
    .sort()
    .map((relative) => `${relative} ${sha256(files[relative])}`)
    .join("");
  return sha256(canonical);
}

function parentDirectoryOf(filePath) {
  const index = filePath.lastIndexOf("/");
  return index < 0 ? "" : filePath.slice(0, index);
}

function hasTraversal(candidate) {
  if (candidate === "") return false;
  if (candidate.startsWith("/")) return true;
  return candidate.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function depthOf(directory) {
  return directory === "" ? 0 : directory.split("/").length;
}

/**
 * Validates one lock against the contract's own rules.
 *
 * The schema already rejects shape; this rejects locks that are well-shaped and
 * still untrue.
 */
export function validateLock(lock, schema) {
  const errors = validateJsonSchema(lock, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  if (lock.discovery_algorithm !== DISCOVERY_ALGORITHM) {
    errors.push(`discovery_algorithm must be ${DISCOVERY_ALGORITHM}`);
  }
  if (lock.precedence.join(",") !== PRECEDENCE.join(",")) {
    errors.push(`precedence must be exactly ${PRECEDENCE.join(" > ")}`);
  }

  const supported = new Set(lock.supported_filenames);
  const seenPaths = new Set();
  let previousOrdinal = 0;
  let totalBytes = 0;

  for (const entry of lock.admitted) {
    const at = `admitted[${entry.ordinal}] ${entry.path}`;
    if (entry.ordinal !== previousOrdinal + 1) {
      errors.push(`${at}: ordinals must start at 1 and be contiguous in precedence order`);
    }
    previousOrdinal = entry.ordinal;

    if (seenPaths.has(entry.path)) errors.push(`${at}: admitted twice`);
    seenPaths.add(entry.path);

    if (hasTraversal(entry.path)) errors.push(`${at}: path leaves the tree or is not normalised`);
    const basename = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    if (!supported.has(basename)) {
      errors.push(`${at}: ${basename} is not in supported_filenames, so it cannot be admitted`);
    }
    if (entry.governed_directory !== parentDirectoryOf(entry.path)) {
      errors.push(
        `${at}: governed_directory must be the file's own parent (${JSON.stringify(parentDirectoryOf(entry.path))})`,
      );
    }
    if (entry.size_bytes > lock.limits.max_file_bytes) {
      errors.push(`${at}: size_bytes exceeds limits.max_file_bytes`);
    }
    totalBytes += entry.size_bytes;
  }

  // Root-to-leaf: a deeper file is appended after a shallower one, so the more
  // specific instruction is read last (section 4). An ordinal that puts a deeper
  // file first would silently invert precedence.
  for (let i = 1; i < lock.admitted.length; i++) {
    const previous = lock.admitted[i - 1];
    const current = lock.admitted[i];
    if (depthOf(current.governed_directory) < depthOf(previous.governed_directory)) {
      errors.push(`admitted[${current.ordinal}] ${current.path}: shallower scope must not follow a deeper one`);
    }
    if (current.governed_directory === previous.governed_directory) {
      errors.push(
        `admitted[${current.ordinal}] ${current.path}: two files govern ` +
          `${JSON.stringify(current.governed_directory)}; same-depth overlap has no defined order ` +
          "and must park as same_depth_conflict",
      );
    }
  }

  if (lock.admitted.length > lock.limits.max_discovered_files) {
    errors.push("admitted exceeds limits.max_discovered_files");
  }
  if (totalBytes > lock.limits.max_total_instruction_bytes) {
    errors.push("admitted bytes exceed limits.max_total_instruction_bytes");
  }

  for (const entry of lock.excluded) {
    if (!EXCLUSION_REASONS.includes(entry.reason)) {
      errors.push(`excluded ${entry.path}: ${entry.reason} is not a recordable exclusion reason`);
    }
    if (seenPaths.has(entry.path)) {
      errors.push(`excluded ${entry.path}: also admitted; a path is one or the other`);
    }
    if (entry.reason === "not_a_regular_blob" && entry.mode === undefined) {
      errors.push(`excluded ${entry.path}: not_a_regular_blob must record the mode it refused`);
    }
  }

  const expected = combinedDigest(lock);
  if (lock.combined_digest !== expected) {
    errors.push(`combined_digest does not recompute: recorded ${lock.combined_digest}, computed ${expected}`);
  }
  if (!HEX64.test(lock.project.project_identity)) {
    errors.push("project.project_identity must be a sha256 of the canonical root");
  }
  return errors;
}

/** Checks the contract prose and the schema agree with the code above. */
export function validateInstructionLockDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) {
    errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  }
  if (!contract.includes(SCHEMA_PATH)) {
    errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  }
  for (const reason of PARK_REASONS) {
    if (!contract.includes(reason)) {
      errors.push(`${CONTRACT_PATH}: park reason ${reason} is not documented`);
    }
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
  const schemaReasons = schema.properties?.excluded?.items?.properties?.reason?.enum ?? [];
  if (schemaReasons.join(",") !== EXCLUSION_REASONS.join(",")) {
    errors.push(`${SCHEMA_PATH}: excluded reasons must be exactly ${EXCLUSION_REASONS.join(", ")}`);
  }

  let example;
  try {
    example = JSON.parse(files[EXAMPLE_PATH]);
  } catch (error) {
    return [...errors, `${EXAMPLE_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...validateLock(example, schema).map((message) => `${EXAMPLE_PATH}: ${message}`));
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateInstructionLockDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const example = JSON.parse(files[EXAMPLE_PATH]);
    console.log("Project instruction lock design validation PASS");
    console.log(`design_digest=${instructionLockDesignDigest(files)}`);
    console.log(`combined_digest=${example.combined_digest}`);
  }
}
