#!/usr/bin/env node

/**
 * Design-time validator for the issue #34 doctor report.
 *
 * Discovering a broken capability through a runtime failure teaches the operator
 * one thing at a time, in whatever order the workflow touched them. The checks
 * here are about the three ways one report stops being better than that: a
 * `warn` counted as ready, a `fail` with nothing to do about it, and a check
 * that could not run reported as one that passed.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/doctor-report.md";
export const SCHEMA_PATH = "resources/doctor-report/doctor-report.schema.json";
export const EXAMPLE_PATH = "resources/doctor-report/doctor-report.example.json";
export const FAILING_EXAMPLE_PATH = "resources/doctor-report/doctor-report.failing.example.json";
export const CONTRACT_MARKER = "<!-- doctor-report-contract:v1 -->";

export const CATEGORIES = Object.freeze([
  "project_identity", "daemon", "governance", "providers", "git_delivery", "security", "scheduler",
]);

export const REFUSALS = Object.freeze([
  "doctor_check_unverifiable",
  "doctor_check_expired",
  "doctor_remediation_missing",
  "doctor_category_unknown",
  "doctor_evidence_unredacted",
  "doctor_required_set_unsatisfied",
  "doctor_traycer_dependency",
]);

/** Shapes that must never appear in evidence. Same list the clearance contract uses. */
export const SECRET_SHAPES = Object.freeze([
  /\bgh[pousr]_[A-Za-z0-9]{16,}/u,
  /\bsk-[A-Za-z0-9]{20,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/u,
  /(^|[^A-Za-z0-9_])\/(Users|home)\/[A-Za-z0-9._-]+/u,
]);

/**
 * The report status, computed from the checks that RAN.
 *
 * Any `fail` fails, any `warn` warns. `unverifiable` does neither, and that is a
 * deliberate line rather than a loophole. Some properties cannot be established
 * read-only at all — killing a real provider process tree is the example — so a
 * status that degraded on them would be permanently yellow on a healthy project,
 * and a permanently yellow status is one operators learn to ignore.
 *
 * The strictness lives where it bites instead: an unverifiable check must say
 * why, it is counted separately, and `readiness` refuses any workflow that
 * REQUIRES it. "We could not test it" never becomes "it passed" for anyone who
 * depends on it.
 */
export function reportStatus(report) {
  if (report.checks.some((check) => check.status === "fail")) return "fail";
  if (report.checks.some((check) => check.status === "warn")) return "warn";
  return "pass";
}

/** How many checks could not be run. Reported beside the status, never folded into it. */
export function unverifiableCount(report) {
  return report.checks.filter((check) => check.status === "unverifiable").length;
}

/**
 * Whether a workflow may start, given the checks it declared as required.
 *
 * The report never decides this. A report that decided who may proceed would be
 * answering a question it was not asked, and every workflow's answer differs.
 */
export function readiness(report, requiredIds) {
  const missing = requiredIds.filter((id) => !report.checks.some((check) => check.id === id));
  if (missing.length > 0) return `refused:doctor_required_set_unsatisfied:${missing.sort().join(",")}`;
  for (const id of requiredIds) {
    const check = report.checks.find((entry) => entry.id === id);
    // `warn` is not readiness. Nor is `unverifiable`.
    if (check.status !== "pass") return `refused:doctor_required_set_unsatisfied:${id}`;
  }
  return "ready";
}

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, FAILING_EXAMPLE_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function doctorDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

export function validateReport(report, schema) {
  const errors = validateJsonSchema(report, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const computed = reportStatus(report);
  if (report.status !== computed) {
    errors.push(`status is ${report.status}, computed ${computed}`);
  }
  const ids = report.checks.map((check) => check.id);
  if (new Set(ids).size !== ids.length) errors.push("a check id appears twice");

  for (const check of report.checks) {
    // A failure with neither a remediation nor a park reason tells the operator
    // something is wrong and leaves them where they were.
    if (check.status === "fail" && !check.remediation && !check.park_reason) {
      errors.push(`${check.id}: a fail must carry a remediation or a park reason (doctor_remediation_missing)`);
    }
    if (check.status === "warn" && !check.remediation) {
      errors.push(`${check.id}: a warn must say what would clear it`);
    }
    // "We could not test it" must never read as "it is fine".
    if (check.status === "unverifiable" && !check.unverifiable_reason) {
      errors.push(`${check.id}: an unverifiable check must say why (doctor_check_unverifiable)`);
    }
    if (check.status !== "unverifiable" && check.unverifiable_reason) {
      errors.push(`${check.id}: only an unverifiable check explains why it could not run`);
    }
    if (Date.parse(check.provenance.expires_at) <= Date.parse(check.provenance.checked_at)) {
      errors.push(`${check.id}: a result that expires before it was taken is not a result`);
    }
    const evidence = JSON.stringify(check.evidence);
    if (SECRET_SHAPES.some((shape) => shape.test(evidence))) {
      errors.push(`${check.id}: evidence carries something that must be redacted (doctor_evidence_unredacted)`);
    }
  }
  return errors;
}

export function validateDoctorReportDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const refusal of REFUSALS) {
    if (!contract.includes(refusal)) errors.push(`${CONTRACT_PATH}: refusal ${refusal} is not documented`);
  }
  if (!contract.includes("`warn` never counts as ready")) {
    errors.push(`${CONTRACT_PATH}: does not state that a warn is not readiness`);
  }
  if (!contract.includes("A check that cannot be run has not passed")) {
    errors.push(`${CONTRACT_PATH}: does not state what unverifiable means`);
  }
  if (!contract.includes("run the **same** check implementations")) {
    errors.push(`${CONTRACT_PATH}: does not state that preflight and doctor share one implementation`);
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
  const categories = schema.properties?.checks?.items?.properties?.category?.enum ?? [];
  if (categories.slice().sort().join(",") !== [...CATEGORIES].sort().join(",")) {
    errors.push(`${SCHEMA_PATH}: the category set must match the contract exactly`);
  }
  const statuses = schema.properties?.checks?.items?.properties?.status?.enum ?? [];
  if (!statuses.includes("unverifiable")) {
    errors.push(`${SCHEMA_PATH}: a check that could not run must be expressible`);
  }

  for (const relative of [EXAMPLE_PATH, FAILING_EXAMPLE_PATH]) {
    let report;
    try {
      report = JSON.parse(files[relative]);
    } catch (error) {
      errors.push(`${relative}: not valid JSON: ${error.message}`);
      continue;
    }
    errors.push(...validateReport(report, schema).map((message) => `${relative}: ${message}`));
  }
  // Every category must appear in the clean example, or the report describes a
  // narrower system than the contract claims.
  const clean = JSON.parse(files[EXAMPLE_PATH]);
  for (const category of CATEGORIES) {
    if (!clean.checks.some((check) => check.category === category)) {
      errors.push(`${EXAMPLE_PATH}: no check in category ${category}`);
    }
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateDoctorReportDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Doctor report design validation PASS");
    console.log(`design_digest=${doctorDesignDigest(files)}`);
    const clean = JSON.parse(files[EXAMPLE_PATH]);
    console.log(`categories=${CATEGORIES.length} refusals=${REFUSALS.length}`);
    console.log(`checks=${clean.checks.length} unverifiable=${unverifiableCount(clean)}`);
  }
}
