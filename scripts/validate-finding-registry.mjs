#!/usr/bin/env node

/**
 * Design-time validator for the issue #16 canonical finding registry.
 *
 * Four reviewers produce four answers; what turns them into one decision has to
 * be computed, not summarised. So the checks here are the ones that make a
 * synthesis step impossible to fake: no raw finding may be dropped by the merge,
 * the pre-triage severity must be the highest any seat reported, a rejection or
 * downgrade must cite something, the contest must reach every originator, and
 * the gate verdict must follow from the findings rather than accompany them.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/finding-registry.md";
export const SCHEMA_PATH = "resources/finding-registry/finding-registry.schema.json";
export const EXAMPLE_PATH = "resources/finding-registry/finding-registry.example.json";
export const CONTRACT_MARKER = "<!-- finding-registry-contract:v1 -->";

/** The shared scale, most severe first. A seat reporting outside it is malformed. */
export const SEVERITY = Object.freeze(["critical", "high", "medium", "low"]);

/** Closed park reasons of section 9. */
export const PARK_REASONS = Object.freeze([
  "unknown_severity",
  "unmergeable_finding",
  "missing_citable_basis",
  "contest_incomplete",
  "undispositioned_medium",
  "missing_debt_ticket",
  "stale_candidate_binding",
  "originator_unknown",
  "finding_registry_drift",
]);

/** Rejections must name one of these, and cite a basis as well. */
export const REJECTION_REASONS = Object.freeze([
  "out_of_scope",
  "intended_behavior",
  "duplicate",
  "reviewer_error",
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

export function canonicalValue(value) {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalValue).sort().join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function registryDigest(registry) {
  return sha256(
    [
      registry.merge_algorithm,
      registry.candidate_identity,
      canonicalValue(registry.seats),
      canonicalValue(registry.raw_findings),
      canonicalValue(registry.canonical_findings),
    ].join(""),
  );
}

export function findingRegistryDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

const rank = (severity) => SEVERITY.indexOf(severity);

/** The severity a finding carries after triage, which is what the gate reads. */
export function effectiveSeverity(finding) {
  return finding.triage.severity ?? finding.reported_severity;
}

/** The gate of section 7, computed from the findings rather than asserted. */
export function computeGate(registry) {
  let blockingOpen = 0;
  let undispositionedMedium = 0;
  for (const finding of registry.canonical_findings) {
    if (finding.state !== "open") continue;
    if (finding.triage.decision === "rejected") continue;
    const severity = effectiveSeverity(finding);
    if (severity === "critical" || severity === "high") blockingOpen += 1;
    if (severity === "medium" && finding.disposition === undefined) undispositionedMedium += 1;
  }
  return {
    blocking_open: blockingOpen,
    undispositioned_medium: undispositionedMedium,
    verdict: blockingOpen === 0 && undispositionedMedium === 0 ? "pass" : "blocked",
  };
}

export function validateRegistry(registry, schema) {
  const errors = validateJsonSchema(registry, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const seats = new Set(registry.seats);
  const rawByKey = new Map();
  for (const raw of registry.raw_findings) {
    const key = `${raw.seat}:${raw.raw_id}`;
    if (rawByKey.has(key)) errors.push(`${key}: raw finding declared twice`);
    rawByKey.set(key, raw);
    if (!seats.has(raw.seat)) errors.push(`${key}: seat is not one of the declared seats`);
  }

  const claimed = new Set();
  const canonicalIds = new Set();
  for (const finding of registry.canonical_findings) {
    const at = finding.canonical_id;
    if (canonicalIds.has(at)) errors.push(`${at}: canonical id declared twice`);
    canonicalIds.add(at);

    let highest = "low";
    for (const originator of finding.originators) {
      const raw = rawByKey.get(originator);
      if (!raw) {
        errors.push(`${at}: originator ${originator} names no raw finding (originator_unknown)`);
        continue;
      }
      if (claimed.has(originator)) {
        errors.push(`${at}: raw finding ${originator} is already merged into another canonical finding`);
      }
      claimed.add(originator);
      if (rank(raw.severity) < rank(highest)) highest = raw.severity;
    }

    // A merge that could lower severity by averaging would let four reviewers
    // disagree their way to a milder finding than any of them reported.
    if (finding.originators.every((originator) => rawByKey.has(originator))) {
      if (finding.reported_severity !== highest) {
        errors.push(
          `${at}: reported_severity is ${finding.reported_severity} but the highest any seat reported is ${highest}`,
        );
      }
    }

    const triage = finding.triage;
    if (triage.decision === "rejected") {
      if (!triage.rejection_reason) {
        errors.push(`${at}: a rejection must name one of ${REJECTION_REASONS.join(", ")}`);
      }
      if (!triage.basis) {
        errors.push(`${at}: a rejection needs a citable basis (missing_citable_basis)`);
      }
    }
    if (triage.decision === "confirmed_lower_severity") {
      if (!triage.basis) errors.push(`${at}: a downgrade needs a citable basis (missing_citable_basis)`);
      if (!triage.severity) errors.push(`${at}: a downgrade must state the severity it lowers to`);
      else if (rank(triage.severity) <= rank(finding.reported_severity)) {
        errors.push(`${at}: confirmed_lower_severity does not lower ${finding.reported_severity}`);
      }
    }
    if (triage.decision === "confirmed_higher_severity") {
      if (!triage.reason) errors.push(`${at}: raising severity must state a reason`);
      if (!triage.severity) errors.push(`${at}: a raise must state the severity it raises to`);
      else if (rank(triage.severity) >= rank(finding.reported_severity)) {
        errors.push(`${at}: confirmed_higher_severity does not raise ${finding.reported_severity}`);
      }
    }
    if (triage.decision === "confirmed" && triage.severity && triage.severity !== finding.reported_severity) {
      errors.push(`${at}: a plain confirmation cannot change the severity`);
    }

    // The contest goes to every originating seat, not only the loudest one, and
    // a seat that forfeits does not close a confirmed finding.
    const contested = new Set();
    for (const entry of finding.contest ?? []) {
      if (contested.has(entry.seat)) errors.push(`${at}: ${entry.seat} contested twice; each originator has one attempt`);
      contested.add(entry.seat);
      if (!finding.originators.some((originator) => originator.startsWith(`${entry.seat}:`))) {
        errors.push(`${at}: ${entry.seat} did not originate this finding, so it has no contest window`);
      }
    }
    if (finding.contest !== undefined) {
      const originatingSeats = new Set(finding.originators.map((originator) => originator.split(":")[0]));
      for (const seat of originatingSeats) {
        if (!contested.has(seat)) {
          errors.push(`${at}: contest is incomplete — ${seat} originated it and has no outcome (contest_incomplete)`);
        }
      }
    }

    if (finding.disposition === "deferred" && !finding.debt_ticket) {
      errors.push(`${at}: a deferred finding must create a tracked debt Ticket (missing_debt_ticket)`);
    }
    if (finding.state === "resolved" && finding.disposition === undefined) {
      errors.push(`${at}: a finding closes on a re-review disposition, not on an edit having been made`);
    }
    if (finding.state === "stale" && !finding.candidate_identity) {
      errors.push(`${at}: a stale finding must name the superseded identity it belongs to`);
    }
    if (
      finding.state !== "stale" &&
      finding.candidate_identity !== undefined &&
      finding.candidate_identity !== registry.candidate_identity
    ) {
      errors.push(`${at}: bound to another candidate but not marked stale (stale_candidate_binding)`);
    }
  }

  // Nothing is lost by merging: every raw finding belongs to exactly one
  // canonical finding, or the registry has quietly dropped a reviewer's answer.
  for (const key of rawByKey.keys()) {
    if (!claimed.has(key)) errors.push(`${key}: raw finding is in no canonical finding (unmergeable_finding)`);
  }

  const gate = computeGate(registry);
  for (const field of ["blocking_open", "undispositioned_medium", "verdict"]) {
    if (registry.gate[field] !== gate[field]) {
      errors.push(`gate.${field} is ${registry.gate[field]}, computed ${gate[field]}`);
    }
  }

  const expected = registryDigest(registry);
  if (registry.registry_digest !== expected) {
    errors.push(`registry_digest does not recompute: recorded ${registry.registry_digest}, computed ${expected}`);
  }
  return errors;
}

export function validateFindingRegistryDesign(files) {
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
  const severities = schema.properties?.raw_findings?.items?.properties?.severity?.enum ?? [];
  if (severities.join(",") !== SEVERITY.join(",")) {
    errors.push(`${SCHEMA_PATH}: severity scale must be exactly ${SEVERITY.join(", ")}`);
  }

  let example;
  try {
    example = JSON.parse(files[EXAMPLE_PATH]);
  } catch (error) {
    return [...errors, `${EXAMPLE_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...validateRegistry(example, schema).map((message) => `${EXAMPLE_PATH}: ${message}`));
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateFindingRegistryDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const example = JSON.parse(files[EXAMPLE_PATH]);
    console.log("Finding registry design validation PASS");
    console.log(`design_digest=${findingRegistryDesignDigest(files)}`);
    console.log(`registry_digest=${example.registry_digest}`);
    console.log(`verdict=${example.gate.verdict}`);
  }
}
