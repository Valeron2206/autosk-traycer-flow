#!/usr/bin/env node

/**
 * Design-time validator for the issue #37 governance bundle.
 *
 * Copying the Guide and the protocol files is not the capability; the lifecycle
 * is. The checks here are about the three ways that lifecycle quietly stops
 * working: a digest that cannot be recomputed, an attestation that confirms only
 * itself, and a release that edits history instead of adding to it.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/governance-bundle.md";
export const SCHEMA_PATH = "resources/governance-bundle/governance-bundle.schema.json";
export const EXAMPLE_PATH = "resources/governance-bundle/governance-bundle.example.json";
export const CANDIDATE_EXAMPLE_PATH = "resources/governance-bundle/governance-bundle.candidate.example.json";
export const CONTRACT_MARKER = "<!-- governance-bundle-contract:v1 -->";

/** The twelve protocol files, named individually. A glob would let one go missing. */
export const PROTOCOL_FILES = Object.freeze([
  "protocol/00-index.md", "protocol/01-roles.md", "protocol/02-stages.md", "protocol/03-carriers.md",
  "protocol/04-verdicts.md", "protocol/05-findings.md", "protocol/06-contest.md", "protocol/07-evidence.md",
  "protocol/08-retention.md", "protocol/09-identity.md", "protocol/10-recovery.md", "protocol/11-release.md",
]);

export const REQUIRED_MEMBERS = Object.freeze([
  "agent-selection-guide.md",
  ...PROTOCOL_FILES,
  "role/author.md", "role/reviewer.md", "role/fixer.md",
  "stage/plan.md", "stage/build.md", "stage/verify.md",
  "stage-carriers.json", "bundle-manifest.json", "bundle-attestation.json",
]);

/** The panel this program's owner specified. A release cites it exactly. */
export const REQUIRED_PANEL = Object.freeze([
  { seat: "opus", route: "anthropic/claude-opus-5", effort: "max" },
  { seat: "astra", route: "openai-codex/gpt-6-astra", effort: "high" },
  { seat: "grok", route: "cursor/cursor-grok-4.6", effort: "xhigh" },
  { seat: "muse", route: "meta/muse-spark-1.3-contributor", effort: "max" },
]);

export const REFUSALS = Object.freeze([
  "bundle_inventory_missing",
  "bundle_inventory_extra",
  "bundle_not_canonical",
  "bundle_traycer_reference",
  "bundle_private_path",
  "bundle_scan_unreadable",
  "bundle_attestation_mismatch",
  "bundle_panel_incomplete",
  "bundle_release_conflict",
  "bundle_stage_mixed",
]);

/** Patterns a published member may not contain (section 5). */
export const FORBIDDEN_PATTERNS = Object.freeze([
  { name: "traycer identifier", pattern: /traycer_[a-z0-9_]+/iu },
  { name: "traycer directory", pattern: /\.traycer\b/iu },
  { name: "absolute home path", pattern: /(^|[^A-Za-z0-9_])\/(Users|home)\/[A-Za-z0-9._-]+/u },
  { name: "windows absolute path", pattern: /\b[A-Za-z]:\\\\/u },
]);

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, CANDIDATE_EXAMPLE_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function governanceDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

/**
 * The bundle digest, recomputed.
 *
 * Over `path\0sha256\n` in raw-byte path order, and over nothing else. No
 * timestamp is in it, because a build that embedded the moment it ran could
 * never be reproduced, and a digest nobody can recompute is a name.
 */
export function bundleDigest(members) {
  const ordered = [...members].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return sha256(ordered.map((member) => `${member.path}\0${member.sha256}\n`).join(""));
}

/**
 * The attestation state, computed.
 *
 * `attested` needs one verdict per required seat, on the exact route and effort,
 * each `pass`, and each bound to THIS candidate digest. A panel fix changes the
 * digest, so verdicts collected before it are about a candidate that no longer
 * exists — which is the case most likely to be rounded up.
 */
export function attestationState(bundle) {
  const verdicts = bundle.attestation.panel ?? [];
  for (const required of REQUIRED_PANEL) {
    const seat = verdicts.find((entry) => entry.seat === required.seat);
    if (!seat) return "pending_panel";
    if (seat.route !== required.route || seat.effort !== required.effort) return "pending_panel";
    if (seat.candidate_digest !== bundle.bundle_digest) return "pending_panel";
    if (seat.verdict === "fail") return "blocked";
  }
  return "attested";
}

export function validateBundle(bundle, schema) {
  const errors = validateJsonSchema(bundle, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const paths = bundle.members.map((member) => member.path);
  for (const required of REQUIRED_MEMBERS) {
    if (!paths.includes(required)) errors.push(`${required} is missing (bundle_inventory_missing)`);
  }
  for (const declared of paths) {
    if (!REQUIRED_MEMBERS.includes(declared)) {
      // An extra member matters as much as a missing one: a bundle carrying a
      // file nobody declared is a bundle nobody can vouch for.
      errors.push(`${declared} is not part of the inventory (bundle_inventory_extra)`);
    }
  }
  if (new Set(paths).size !== paths.length) errors.push("a member path appears twice");

  const recomputed = bundleDigest(bundle.members);
  if (bundle.bundle_digest !== recomputed) {
    errors.push(`bundle digest does not recompute: recorded ${bundle.bundle_digest}, computed ${recomputed}`);
  }
  // The attestation is about THIS bundle or it is about another one.
  if (bundle.attestation.candidate_digest !== bundle.bundle_digest) {
    errors.push("the attestation names a different candidate (bundle_attestation_mismatch)");
  }
  const computed = attestationState(bundle);
  if (bundle.attestation.state !== computed) {
    errors.push(`attestation state is ${bundle.attestation.state}, computed ${computed}`);
  }
  if (bundle.stage === "release") {
    if (computed !== "attested") errors.push("a release requires a complete panel (bundle_panel_incomplete)");
    if (!bundle.attestation.release_actor || !bundle.attestation.released_at) {
      errors.push("a release must name its actor and when it happened");
    }
  } else if (bundle.attestation.release_actor || bundle.attestation.released_at) {
    // Only a release is released. A candidate carrying a release actor is a
    // candidate presenting itself as one.
    errors.push(`a ${bundle.stage} bundle must not carry release fields (bundle_stage_mixed)`);
  }
  if (bundle.rollback_of !== undefined && bundle.rollback_of === bundle.bundle_digest) {
    errors.push("a bundle cannot be a rollback of itself");
  }
  return errors;
}

/** Scans text for what a published member may never contain. Fail-closed. */
export function scanMember(text) {
  if (typeof text !== "string") return ["bundle_scan_unreadable"];
  const hits = [];
  for (const { name, pattern } of FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) hits.push(name);
  }
  return hits;
}

export function validateGovernanceBundleDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const refusal of REFUSALS) {
    if (!contract.includes(refusal)) errors.push(`${CONTRACT_PATH}: refusal ${refusal} is not documented`);
  }
  if (!contract.includes("Timestamps are not in the digest")) {
    errors.push(`${CONTRACT_PATH}: does not state that timestamps stay out of the digest`);
  }
  if (!contract.includes("rollback creates a new current-pointer decision")) {
    errors.push(`${CONTRACT_PATH}: does not state that rollback adds to history`);
  }
  if (!contract.includes("a panel fix changes the digest")) {
    errors.push(`${CONTRACT_PATH}: does not state that a fix invalidates the verdicts`);
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
  const stages = schema.properties?.stage?.enum ?? [];
  if (stages.join(",") !== "baseline,adaptation,release") {
    errors.push(`${SCHEMA_PATH}: stages must be exactly baseline, adaptation, release`);
  }
  // The canonical form is pinned by the schema, not chosen per build: two builds
  // that disagree about line endings produce two digests for one input.
  const canonical = schema.properties?.canonical_form?.properties ?? {};
  for (const [field, value] of [["encoding", "utf-8"], ["line_ending", "lf"], ["path_order", "raw_bytes"]]) {
    if (canonical[field]?.const !== value) {
      errors.push(`${SCHEMA_PATH}: canonical ${field} must be pinned to ${value}`);
    }
  }
  if (schema.properties?.attestation?.properties?.panel?.maxItems !== 4) {
    errors.push(`${SCHEMA_PATH}: the panel has exactly four seats`);
  }

  for (const relative of [EXAMPLE_PATH, CANDIDATE_EXAMPLE_PATH]) {
    let bundle;
    try {
      bundle = JSON.parse(files[relative]);
    } catch (error) {
      errors.push(`${relative}: not valid JSON: ${error.message}`);
      continue;
    }
    errors.push(...validateBundle(bundle, schema).map((message) => `${relative}: ${message}`));
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateGovernanceBundleDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Governance bundle design validation PASS");
    console.log(`design_digest=${governanceDesignDigest(files)}`);
    console.log(`members=${REQUIRED_MEMBERS.length} refusals=${REFUSALS.length}`);
  }
}
