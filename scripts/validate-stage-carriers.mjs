#!/usr/bin/env node

/**
 * Design-time validator for the issue #19 stage carrier matrix.
 *
 * Without a matrix there are two equally bad modes: send all thirteen
 * governance files to every agent and drown the context, or fail to send the one
 * rubric the role needed. So the checks here are about the mapping being total,
 * the forbidden sets actually holding, and an echo the host can compare rather
 * than trust.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/stage-carriers.md";
export const SCHEMA_PATH = "resources/stage-carriers/stage-carriers.schema.json";
export const REGISTRY_PATH = "resources/stage-carriers/stage-carriers.v1.json";
export const DISPATCH_SCHEMA_PATH = "resources/stage-carriers/stage-carriers.dispatch.schema.json";
export const DISPATCH_EXAMPLE_PATH = "resources/stage-carriers/stage-carriers.dispatch.example.json";
export const CONTRACT_MARKER = "<!-- stage-carriers-contract:v1 -->";

/** Every consumer the issue names. A key missing here is a role nobody mapped. */
export const REQUIRED_KEYS = Object.freeze([
  "author.brief", "author.core_flow", "author.tech_plan", "author.tickets",
  "panel.opus", "panel.astra", "panel.grok", "panel.muse",
  "contest.reviewer", "narrow.reviewer",
  "implementer.feature", "implementer.bugfix", "implementer.refactor",
  "verifier.deterministic", "verifier.model_assisted",
  "reviewer.code",
  "arena.candidate", "arena.judge", "arena.final_implementer",
  "autobuild.generator", "autobuild.evaluator",
  "reflect.reviewer",
  "debate.participant", "debate.mediator",
  "revision.analysis",
  "walkthrough.author", "walkthrough.fact_validator",
]);

/** The four panel seats, whose common bytes must be identical. */
export const PANEL_KEYS = Object.freeze(["panel.opus", "panel.astra", "panel.grok", "panel.muse"]);

export const REFUSALS = Object.freeze([
  "carrier_mapping_unknown",
  "carrier_file_missing",
  "carrier_forbidden_fragment",
  "carrier_bundle_unpinned",
  "carrier_budget_exceeded",
  "carrier_echo_missing",
  "carrier_echo_mismatch",
  "carrier_echo_wrong_scope",
  "carrier_echo_duplicate",
  "carrier_coverage_incomplete",
]);

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, REGISTRY_PATH, DISPATCH_SCHEMA_PATH, DISPATCH_EXAMPLE_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function carrierDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

export function validateRegistry(registry, schema) {
  const errors = validateJsonSchema(registry, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const keys = Object.keys(registry.carriers);
  for (const required of REQUIRED_KEYS) {
    if (!keys.includes(required)) errors.push(`${required} has no mapping (carrier_mapping_unknown)`);
  }
  for (const key of keys) {
    if (!REQUIRED_KEYS.includes(key)) errors.push(`${key} is not a registered role/stage`);
  }

  const active = registry.governance_files.filter((file) => file.status === "active").map((f) => f.path);
  const inactive = registry.governance_files.filter((file) => file.status === "inactive_in_v1");
  for (const file of inactive) {
    // "We are not using it yet" is a decision; it has to name who decided.
    if (!file.decided_by) errors.push(`${file.path}: inactive_in_v1 must name the issue or ADR that decided it`);
  }
  const declared = new Set(registry.governance_files.map((f) => f.path));
  const used = new Set();
  for (const [key, carrier] of Object.entries(registry.carriers)) {
    for (const file of carrier.required) {
      if (!declared.has(file)) errors.push(`${key} requires ${file}, which is not a governance file`);
      used.add(file);
    }
    for (const file of carrier.forbidden) {
      if (!declared.has(file)) errors.push(`${key} forbids ${file}, which is not a governance file`);
      // A file that is both required and forbidden for one key cannot be served.
      if (carrier.required.includes(file)) errors.push(`${key} both requires and forbids ${file}`);
    }
    if (carrier.required.length === 0) errors.push(`${key} carries nothing`);
  }
  // Every governance file has a consumer, or says why it has none. A file with
  // neither is a file nobody can say why we ship.
  for (const file of active) {
    if (!used.has(file)) errors.push(`${file} has no consumer (carrier_coverage_incomplete)`);
  }

  // The four seats must be shown the same bytes; only the lens differs.
  const panelSets = PANEL_KEYS.map((key) => JSON.stringify(registry.carriers[key]?.required ?? null));
  if (new Set(panelSets).size !== 1) {
    errors.push("the four panel seats are not carried the same bytes");
  }
  const anchorSets = PANEL_KEYS.map((key) => JSON.stringify(registry.carriers[key]?.anchors ?? null));
  if (new Set(anchorSets).size !== 1) {
    errors.push("the four panel seats are not carried the same anchors");
  }
  // The judge rubric reaching an Arena candidate is the failure `forbidden` exists for.
  const judge = "protocol/rubrics/judge.md";
  if (!registry.carriers["arena.candidate"]?.forbidden.includes(judge)) {
    errors.push(`arena.candidate must forbid ${judge} (carrier_forbidden_fragment)`);
  }
  if (!registry.carriers["arena.judge"]?.required.includes(judge)) {
    errors.push(`arena.judge must carry ${judge}`);
  }
  return errors;
}

/**
 * Compares what the child echoed with what the host inserted.
 *
 * Field by field, and every field: an echo that matched on the path alone would
 * accept the right file from the wrong bundle, the wrong round, or a previous
 * attempt.
 */
export function compareEcho(sent, echoed) {
  if (!Array.isArray(echoed)) return "carrier_echo_missing";
  if (echoed.length !== sent.length) return "carrier_echo_missing";
  const seen = new Set();
  for (const item of echoed) {
    const key = `${item?.logical_id}@${item?.source_sha256}`;
    if (seen.has(key)) return "carrier_echo_duplicate";
    seen.add(key);
  }
  for (const original of sent) {
    const match = echoed.find((item) => item?.logical_id === original.logical_id);
    if (!match) return "carrier_echo_missing";
    for (const field of ["source_sha256", "section_sha256", "bundle_digest", "serialization_version"]) {
      if (match[field] !== original[field]) return "carrier_echo_mismatch";
    }
    for (const field of ["project_identity", "epic_id", "task_id", "role", "stage", "dispatch_id", "round", "attempt"]) {
      if (match[field] !== original[field]) return "carrier_echo_wrong_scope";
    }
  }
  return "matched";
}

export function validateStageCarriersDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const refusal of REFUSALS) {
    if (!contract.includes(refusal)) errors.push(`${CONTRACT_PATH}: refusal ${refusal} is not documented`);
  }
  if (!contract.includes("A reference is not a delivery")) {
    errors.push(`${CONTRACT_PATH}: does not state that a reference is not a delivery`);
  }
  if (!contract.includes("blocking non-verdict")) {
    errors.push(`${CONTRACT_PATH}: does not state what a missing echo produces`);
  }
  if (!contract.includes("byte-identical")) {
    errors.push(`${CONTRACT_PATH}: does not state that the seats see the same bytes`);
  }

  let schema;
  let registry;
  try {
    schema = JSON.parse(files[SCHEMA_PATH]);
    registry = JSON.parse(files[REGISTRY_PATH]);
  } catch (error) {
    return [...errors, `stage carriers: not valid JSON: ${error.message}`];
  }
  if (schema.additionalProperties !== false) {
    errors.push(`${SCHEMA_PATH}: root must be closed (additionalProperties:false)`);
  }
  errors.push(...validateRegistry(registry, schema).map((message) => `${REGISTRY_PATH}: ${message}`));

  let dispatchSchema;
  let dispatch;
  try {
    dispatchSchema = JSON.parse(files[DISPATCH_SCHEMA_PATH]);
    dispatch = JSON.parse(files[DISPATCH_EXAMPLE_PATH]);
  } catch (error) {
    return [...errors, `dispatch attributions: not valid JSON: ${error.message}`];
  }
  errors.push(
    ...validateJsonSchema(dispatch, dispatchSchema).map((message) => `${DISPATCH_EXAMPLE_PATH}: schema: ${message}`),
  );
  // The example must echo itself, or the pair proves nothing about the check.
  const decision = compareEcho(dispatch.attributions, dispatch.attributions);
  if (decision !== "matched") {
    errors.push(`${DISPATCH_EXAMPLE_PATH}: does not match its own echo (${decision})`);
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateStageCarriersDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const registry = JSON.parse(files[REGISTRY_PATH]);
    console.log("Stage carrier matrix design validation PASS");
    console.log(`design_digest=${carrierDesignDigest(files)}`);
    console.log(`carriers=${Object.keys(registry.carriers).length} governance=${registry.governance_files.length}`);
  }
}
