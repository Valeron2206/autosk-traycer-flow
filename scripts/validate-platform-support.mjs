#!/usr/bin/env node

/**
 * Design-time validator for the issue #13 platform support matrix.
 *
 * The adapter's guarantees are not portable facts — they are what specific
 * syscalls do on specific filesystems. So the checks here are about whether a
 * row's claim could be true: a guarantee cannot be claimed without the syscall
 * family it rests on, a `supported` row cannot rest on unverified evidence, and
 * a row cannot both hold and miss the same guarantee. An unverified claim is not
 * a weaker claim, it is an unchecked one, and a table makes those look alike.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/platform-support.md";
export const SCHEMA_PATH = "resources/platform-support/platform-support.schema.json";
export const MATRIX_PATH = "resources/platform-support/platform-support.v1.json";
export const CONTRACT_MARKER = "<!-- platform-support-contract:v1 -->";

/** The adapter's guarantees, as ADR-028 states them. */
export const GUARANTEES = Object.freeze([
  "no_follow_per_component",
  "type_check",
  "owner_check",
  "mode_check",
  "device_check",
  "no_replace_rename",
]);

/** What each guarantee rests on. A claim without its syscall family is a wish. */
export const REQUIRED_SYSCALLS = Object.freeze({
  no_follow_per_component: ["at_plus_o_nofollow", "openat2"],
  no_replace_rename: ["rename_noreplace", "renameatx_np"],
});

/** Closed park reasons of section 7. */
export const PARK_REASONS = Object.freeze([
  "unsupported_platform",
  "unsupported_filesystem",
  "missing_guarantee",
  "world_writable_install",
  "helper_digest_mismatch",
  "helper_not_executable",
  "setuid_helper",
  "unverified_claim",
]);

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, MATRIX_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function platformSupportDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

export function validateMatrix(matrix, schema) {
  const errors = validateJsonSchema(matrix, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const seen = new Set();
  for (const row of matrix.rows) {
    const at = `${row.os}/${row.arch} on ${row.filesystems.join(",")}`;
    const key = `${row.os}/${row.arch}/${[...row.filesystems].sort().join(",")}`;
    if (seen.has(key)) errors.push(`${at}: declared twice`);
    seen.add(key);

    const held = new Set(row.guarantees);
    const missing = new Set(row.missing_guarantees ?? []);
    for (const guarantee of held) {
      if (missing.has(guarantee)) {
        errors.push(`${at}: ${guarantee} is listed as both held and missing`);
      }
    }
    // Every guarantee is accounted for. A guarantee that is neither held nor
    // missing is one the table quietly declines to answer about.
    for (const guarantee of GUARANTEES) {
      if (!held.has(guarantee) && !missing.has(guarantee)) {
        errors.push(`${at}: says nothing about ${guarantee}`);
      }
    }

    // A guarantee cannot be claimed without a syscall family that provides it.
    for (const [guarantee, families] of Object.entries(REQUIRED_SYSCALLS)) {
      if (held.has(guarantee) && !families.some((family) => row.syscall_family.includes(family))) {
        errors.push(`${at}: claims ${guarantee} without any of ${families.join(" or ")}`);
      }
    }

    // `supported` means verified on every change. Anything else is a claim about
    // a platform nobody is currently checking.
    if (row.level === "supported" && row.evidence !== "ci") {
      errors.push(`${at}: level supported requires CI evidence, not ${row.evidence} (unverified_claim)`);
    }
    if (row.evidence === "not_verified" && held.size > 0) {
      errors.push(`${at}: claims guarantees with no verification at all (unverified_claim)`);
    }
    // A level and its guarantees must agree in both directions.
    if (row.level !== "unsupported" && missing.size > 0) {
      errors.push(`${at}: is ${row.level} but is missing ${[...missing].join(", ")}`);
    }
    if (row.level === "unsupported" && missing.size === 0) {
      errors.push(`${at}: is unsupported but names no missing guarantee`);
    }
    if (row.level === "unsupported" && !row.note) {
      errors.push(`${at}: an unsupported row must say why, not only that`);
    }
  }

  // At least one row must actually be supported, or the matrix describes a
  // product that runs nowhere.
  if (!matrix.rows.some((row) => row.level === "supported")) {
    errors.push("no row is supported, so the adapter is claimed nowhere");
  }
  // macOS is named in the issue as a target that must really be supported.
  if (!matrix.rows.some((row) => row.os === "darwin" && row.level === "supported")) {
    errors.push("no supported darwin row, which #13 requires by name");
  }

  const install = matrix.install;
  if (install.setuid_allowed || install.setgid_allowed) {
    errors.push("the helper is never setuid or setgid");
  }
  if (install.world_writable_install_allowed) {
    errors.push("a world-writable install directory is a park reason, not a configuration");
  }
  if (!install.digest_bound_to_runtime_identity) {
    errors.push("the helper digest must be bound into runtime identity (#10)");
  }
  return errors;
}

export function validatePlatformSupportDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const reason of PARK_REASONS) {
    if (!contract.includes(reason)) errors.push(`${CONTRACT_PATH}: park reason ${reason} is not documented`);
  }
  // The three support levels have different meanings and the contract must give
  // them, or "best_effort" becomes a synonym for "supported" in practice.
  for (const level of ["supported", "best_effort", "unsupported"]) {
    if (!contract.includes(level)) errors.push(`${CONTRACT_PATH}: does not define the level ${level}`);
  }
  // The window the digest check cannot close is stated rather than claimed away.
  if (!contract.includes("does not close the replacement window")) {
    errors.push(`${CONTRACT_PATH}: does not state the limit of a pre-launch digest check`);
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
  // The three install prohibitions are constants in the schema, not booleans a
  // matrix could set either way.
  for (const [field, expected] of [
    ["setuid_allowed", false],
    ["setgid_allowed", false],
    ["world_writable_install_allowed", false],
    ["digest_bound_to_runtime_identity", true],
  ]) {
    const node = schema.properties?.install?.properties?.[field];
    if (!node || node.const !== expected) {
      errors.push(`${SCHEMA_PATH}: install.${field} must be fixed to ${expected}`);
    }
  }

  let matrix;
  try {
    matrix = JSON.parse(files[MATRIX_PATH]);
  } catch (error) {
    return [...errors, `${MATRIX_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...validateMatrix(matrix, schema).map((message) => `${MATRIX_PATH}: ${message}`));
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validatePlatformSupportDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const matrix = JSON.parse(files[MATRIX_PATH]);
    const byLevel = (level) => matrix.rows.filter((row) => row.level === level).length;
    console.log("Platform support design validation PASS");
    console.log(`design_digest=${platformSupportDesignDigest(files)}`);
    console.log(
      `rows=${matrix.rows.length} supported=${byLevel("supported")} ` +
        `best_effort=${byLevel("best_effort")} unsupported=${byLevel("unsupported")}`,
    );
  }
}
