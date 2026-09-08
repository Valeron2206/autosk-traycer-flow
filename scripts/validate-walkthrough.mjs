#!/usr/bin/env node

/**
 * Design-time validator for the issue #33 changeset walkthrough.
 *
 * A walkthrough is the one artifact whose whole value is that a person believes
 * it without re-deriving it. That is also why it is the one where a confident
 * sentence with a wrong commit id does the most damage — so the checks here are
 * about consent, staleness, fact validation and what may never be counted as
 * done.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/walkthrough.md";
export const SCHEMA_PATH = "resources/walkthrough/walkthrough.schema.json";
export const EXAMPLE_PATH = "resources/walkthrough/walkthrough.example.json";
export const REFUSED_EXAMPLE_PATH = "resources/walkthrough/walkthrough.refused.example.json";
export const CONTRACT_MARKER = "<!-- walkthrough-contract:v1 -->";

/** Read in this order. Mechanical detail is last because it is last. */
export const RISK_ORDER = Object.freeze(["product", "correctness", "security", "architecture", "mechanical"]);

/** Prefixes that make a path someone's machine rather than a location. */
export const ABSOLUTE_PATH_PREFIXES = Object.freeze(["/Users/", "/home/", "/root/", "C:\\", "\\\\"]);

export const REFUSALS = Object.freeze([
  "walkthrough_without_consent",
  "walkthrough_not_bound_to_staging",
  "walkthrough_stale",
  "walkthrough_claims_changed_by_binding",
  "walkthrough_fact_mismatch",
  "walkthrough_published_with_mismatch",
  "walkthrough_order_not_risk_based",
  "walkthrough_checks_not_separated",
  "walkthrough_creates_pass",
  "walkthrough_absolute_path",
  "walkthrough_uncleared_content",
  "walkthrough_decline_blocked",
]);

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, REFUSED_EXAMPLE_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function walkthroughDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

/** What the walkthrough says about the change: areas, checks and links. */
export function semanticDigest(walkthrough) {
  return sha256(
    canonical({ areas: walkthrough.areas, checks: walkthrough.checks, links: walkthrough.links }),
  );
}

/** Every string a reader would see, for the content checks. */
export function readableStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(readableStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(readableStrings);
  return [];
}

export function validateWalkthrough(walkthrough, schema) {
  const errors = validateJsonSchema(walkthrough, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  if (walkthrough.consent.state !== "approved") {
    // An explanatory artifact nobody asked for is not free: it is one more
    // document that can drift, and drift in an explanation is worse than
    // absence, because a reader trusts it.
    errors.push(`walkthrough_without_consent: consent is ${walkthrough.consent.state}`);
  }
  if (walkthrough.blocks_epic_when_declined) {
    errors.push("walkthrough_decline_blocked: declining a walkthrough has no effect on a correctness gate");
  }
  if (walkthrough.creates_pass) {
    errors.push("walkthrough_creates_pass: a walkthrough is explanatory and creates no PASS");
  }

  if (walkthrough.walkthrough_id !== `wt-${walkthrough.staging.commit_oid}`) {
    errors.push(`walkthrough_not_bound_to_staging: ${walkthrough.walkthrough_id} does not name the staging commit`);
  }
  if (walkthrough.staging.current_tree_oid !== walkthrough.staging.tree_oid) {
    // An explanation of a tree that no longer exists reads exactly like an
    // explanation of the tree that does.
    errors.push(`walkthrough_stale: staged ${walkthrough.staging.tree_oid}, current ${walkthrough.staging.current_tree_oid}`);
  }

  const digest = semanticDigest(walkthrough);
  if (walkthrough.semantic_digest !== digest) {
    errors.push(`walkthrough_fact_mismatch: the semantic digest does not recompute (${digest})`);
  }
  if (
    walkthrough.staging.target_oid &&
    walkthrough.staging.semantic_digest_before_binding !== digest
  ) {
    // Adding the target identity is bookkeeping; changing what the document
    // says about the change is not.
    errors.push("walkthrough_claims_changed_by_binding: the semantic claims moved when the target was bound");
  }

  // Risk-bearing areas first, mechanical detail last. The four risk kinds are
  // not ranked against each other: which of correctness or security to read
  // first depends on the change, and pretending otherwise would be a rule about
  // nothing. What is fixed is that mechanical detail does not come first — a
  // file-order walkthrough is a directory listing with prose attached, and it
  // spends the reader's attention in the order the filesystem happened to pick.
  let seenMechanical = false;
  for (const area of walkthrough.areas) {
    if (area.risk === "mechanical") {
      seenMechanical = true;
    } else if (seenMechanical) {
      errors.push(`walkthrough_order_not_risk_based: ${area.area_id} (${area.risk}) is read after mechanical detail`);
    }
  }

  for (const check of walkthrough.checks.performed) {
    if (check.at_tree_oid !== walkthrough.staging.tree_oid) {
      errors.push(`walkthrough_fact_mismatch: a performed check cites tree ${check.at_tree_oid}, not the staged one`);
    }
  }
  for (const check of walkthrough.checks.remaining) {
    if (check.evidence_ref) {
      // The two lists answer different questions, and merging them loses the
      // second: what someone still has to do.
      errors.push(`walkthrough_checks_not_separated: a remaining check carries evidence as if it had run`);
    }
  }

  for (const fact of walkthrough.facts) {
    if (!fact.matches || fact.canonical === null || fact.claimed !== fact.canonical) {
      errors.push(`walkthrough_fact_mismatch: ${fact.kind} ${fact.claimed}`);
    }
  }
  const mismatched = walkthrough.facts.some((fact) => !fact.matches);
  if (mismatched && walkthrough.publication === "current") {
    errors.push("walkthrough_published_with_mismatch: published as current with a failed fact check");
  }

  for (const text of readableStrings(walkthrough)) {
    for (const prefix of ABSOLUTE_PATH_PREFIXES) {
      if (text.includes(prefix)) {
        // The leak that survives review: it looks like context rather than like
        // data, and it carries a username.
        errors.push(`walkthrough_absolute_path: ${prefix}`);
      }
    }
  }
  return errors;
}

export function validateWalkthroughDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const refusal of REFUSALS) {
    if (!contract.includes(refusal)) errors.push(`${CONTRACT_PATH}: refusal ${refusal} is not documented`);
  }
  if (!contract.includes("explanatory and never behavior-defining")) {
    errors.push(`${CONTRACT_PATH}: does not state what a walkthrough is not`);
  }
  if (!contract.includes("drift in an explanation is worse than absence")) {
    errors.push(`${CONTRACT_PATH}: does not state why it is offered rather than produced`);
  }
  if (!contract.includes("risk-based, not alphabetical")) {
    errors.push(`${CONTRACT_PATH}: does not state how the review order is chosen`);
  }
  if (!contract.includes("believes it without re-deriving it")) {
    errors.push(`${CONTRACT_PATH}: does not state why facts are validated deterministically`);
  }
  if (!contract.includes("walkthroughs/<final-staging-oid>.md")) {
    errors.push(`${CONTRACT_PATH}: does not state where the artifact lives`);
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
  if (schema.properties?.creates_pass?.const !== false) {
    errors.push(`${SCHEMA_PATH}: a walkthrough must not be able to record a PASS`);
  }
  const risks = schema.properties?.areas?.items?.properties?.risk?.enum ?? [];
  if (risks.join(",") !== RISK_ORDER.join(",")) {
    errors.push(`${SCHEMA_PATH}: the risk ranks must match the contract order exactly`);
  }
  const checks = schema.properties?.checks?.required ?? [];
  for (const field of ["performed", "remaining"]) {
    if (!checks.includes(field)) {
      errors.push(`${SCHEMA_PATH}: ${field} checks must be their own list`);
    }
  }
  const performed = schema.properties?.checks?.properties?.performed?.items?.required ?? [];
  for (const field of ["evidence_ref", "at_tree_oid"]) {
    if (!performed.includes(field)) {
      errors.push(`${SCHEMA_PATH}: a performed check must name ${field}`);
    }
  }
  if (!(schema.required ?? []).includes("consent")) {
    errors.push(`${SCHEMA_PATH}: consent must be recorded, or a walkthrough can exist without one`);
  }

  for (const relative of [EXAMPLE_PATH, REFUSED_EXAMPLE_PATH]) {
    let walkthrough;
    try {
      walkthrough = JSON.parse(files[relative]);
    } catch (error) {
      errors.push(`${relative}: not valid JSON: ${error.message}`);
      continue;
    }
    const found = validateWalkthrough(walkthrough, schema);
    if (relative === EXAMPLE_PATH) {
      errors.push(...found.map((message) => `${relative}: ${message}`));
    } else if (found.length === 0) {
      errors.push(`${relative}: the refused example is accepted`);
    }
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateWalkthroughDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const schema = JSON.parse(files[SCHEMA_PATH]);
    const walkthrough = JSON.parse(files[EXAMPLE_PATH]);
    const refused = validateWalkthrough(JSON.parse(files[REFUSED_EXAMPLE_PATH]), schema);
    console.log("Changeset walkthrough design validation PASS");
    console.log(`design_digest=${walkthroughDesignDigest(files)}`);
    console.log(`areas=${walkthrough.areas.length} facts=${walkthrough.facts.length} refusals=${REFUSALS.length} refused_example_findings=${refused.length}`);
  }
}
