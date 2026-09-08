#!/usr/bin/env node

/**
 * Design-time validator for the issue #29 Reflect pass and cost-watch registry.
 *
 * Governance only ever grows: a plausible gap becomes a rule, the rule creates
 * a recurring false block, and nothing revisits it, because the artifact that
 * would have measured the cost is the one nobody wrote. So the checks here are
 * about what may become a rule, what a reviewer may read, and what the registry
 * has to detect rather than assert.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/reflect-cost-watch.md";
export const PASS_SCHEMA_PATH = "resources/reflect-pass/reflect-pass.schema.json";
export const REGISTRY_SCHEMA_PATH = "resources/reflect-pass/cost-watch-registry.schema.json";
export const PASS_EXAMPLE_PATH = "resources/reflect-pass/reflect-pass.example.json";
export const REGISTRY_EXAMPLE_PATH = "resources/reflect-pass/cost-watch-registry.example.json";
export const REFUSED_EXAMPLE_PATH = "resources/reflect-pass/reflect-pass.refused.example.json";
export const CONTRACT_MARKER = "<!-- reflect-cost-watch-contract:v1 -->";

/** All three, because a pass missing one cannot see the category it dropped. */
export const LENSES = Object.freeze(["judgment", "tooling_friction", "divergent_effects"]);

/** Extract kinds whose repetition is a tooling problem, not a rule-shaped one. */
export const FRICTION_KINDS = Object.freeze(["manual_friction", "tool_gap", "false_block"]);

/** Two occurrences is a repeat; the third is a habit. */
export const FRICTION_THRESHOLD = 2;

export const REFUSALS = Object.freeze([
  "reflect_pass_replay",
  "reflect_epic_outcome_changed",
  "reflect_unlisted_source",
  "reflect_extract_uncleared",
  "reflect_lens_missing",
  "reflect_rule_without_observation",
  "reflect_friction_not_tooled",
  "reflect_bundle_changed_without_panel",
  "costwatch_prefix_changed",
  "costwatch_truncated",
  "costwatch_lost_update",
  "costwatch_lock_missing",
  "costwatch_malformed",
  "governance_growth_unjustified",
]);

export function loadFiles() {
  const files = {};
  for (const relative of [
    CONTRACT_PATH,
    PASS_SCHEMA_PATH,
    REGISTRY_SCHEMA_PATH,
    PASS_EXAMPLE_PATH,
    REGISTRY_EXAMPLE_PATH,
    REFUSED_EXAMPLE_PATH,
  ]) {
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

export function reflectDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

/** The bytes a clearance is granted over: the sources and the items, exactly. */
export function extractDigest(extract) {
  return sha256(canonical({ items: extract.items, sources: extract.sources }));
}

/** Whether a read source is covered by an enumerated one. `**` is a prefix. */
export function coveredBy(sources, read) {
  return sources.some((source) =>
    source.endsWith("**") ? read.startsWith(source.slice(0, -2)) : read === source,
  );
}

export function validatePass(record, schema) {
  const errors = validateJsonSchema(record, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const digest = extractDigest(record.extract);
  if (record.extract.clearance_digest !== digest) {
    // A reference alone would be a promise: an extract edited after the scan is
    // a different set of bytes with an older reference attached.
    errors.push(`reflect_extract_uncleared: the clearance covers ${record.extract.clearance_digest}, the extract is ${digest}`);
  }

  const lenses = record.lenses.map((entry) => entry.lens);
  for (const lens of LENSES) {
    if (!lenses.includes(lens)) errors.push(`reflect_lens_missing: ${lens}`);
  }
  for (const lens of record.lenses) {
    for (const read of lens.sources_read) {
      if (!coveredBy(record.extract.sources, read)) {
        errors.push(`reflect_unlisted_source: the ${lens.lens} lens read ${read}`);
      }
    }
  }

  if (record.epic.outcome_digest_after && record.epic.outcome_digest_after !== record.epic.outcome_digest) {
    // A proposal about the rules is not a re-judgement of finished work.
    errors.push("reflect_epic_outcome_changed: a Reflect pass does not change the outcome of a closed Epic");
  }

  const byLocator = new Map(record.extract.items.map((item) => [item.locator, item]));
  for (const finding of record.findings) {
    if (finding.disposition !== "accepted") {
      if (finding.activation?.bundle_changed) {
        errors.push(`reflect_bundle_changed_without_panel: ${finding.finding_id} is ${finding.disposition}`);
      }
      continue;
    }
    if (finding.proposal === "new_rule" && !finding.observed_failure && !finding.import) {
      // Not refused as wrong — refused as unproven. Without this, every
      // plausible critique becomes a permanent obligation.
      errors.push(`reflect_rule_without_observation: ${finding.finding_id}`);
    }
    const item = finding.observed_failure ? byLocator.get(finding.observed_failure.locator) : undefined;
    if (
      finding.proposal === "new_rule" &&
      item &&
      FRICTION_KINDS.includes(item.kind) &&
      (finding.recurrence ?? 1) >= FRICTION_THRESHOLD
    ) {
      // A recurring manual step written down as a rule is the same manual step
      // with an obligation attached to it.
      errors.push(`reflect_friction_not_tooled: ${finding.finding_id} repeats ${item.kind} ${finding.recurrence} times`);
    }
    if (finding.activation?.bundle_changed && !finding.activation.panel_ref) {
      errors.push(`reflect_bundle_changed_without_panel: ${finding.finding_id}`);
    }
  }

  for (const entry of record.governance_budget) {
    const computed = entry.lines - entry.previous_approved_lines;
    if (entry.net_delta_lines !== computed) {
      errors.push(`governance_growth_unjustified: ${entry.path} records ${entry.net_delta_lines}, computed ${computed}`);
    }
    if (entry.net_delta_lines > 0 && entry.form === "prose" && !entry.growth_rationale) {
      errors.push(`governance_growth_unjustified: ${entry.path} grows with no rationale`);
    }
    if (entry.net_delta_lines > 0 && (entry.replacement_candidates ?? []).length === 0) {
      // Growth without a candidate for removal is how a guide becomes unread.
      errors.push(`governance_growth_unjustified: ${entry.path} grows with nothing considered for replacement`);
    }
  }
  return errors;
}

/** What the orchestrator does with a pass, given the passes already recorded. */
export function passDecision(record, history = []) {
  const previous = history.find((entry) => entry.reflect_pass_id === record.reflect_pass_id);
  if (previous) {
    // A retry is idempotent under the same id; the same id over different
    // inputs is two passes wearing one name.
    return previous.extract.clearance_digest === record.extract.clearance_digest
      ? "retry"
      : "refused:reflect_pass_replay";
  }
  const sameEpic = history.filter((entry) => entry.epic.epic_id === record.epic.epic_id);
  if (sameEpic.length > 0 && !record.follows_pass) {
    return "refused:reflect_pass_replay";
  }
  if (record.follows_pass && !history.some((entry) => entry.reflect_pass_id === record.follows_pass)) {
    return "refused:reflect_pass_replay";
  }
  return "dispatch";
}

/** The registry's append-only guarantee, checked rather than asserted. */
export function validateRegistry(registry, schema) {
  const errors = validateJsonSchema(registry, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const seenCheckpoints = new Map();
  const seenOperations = new Set();
  for (const [index, entry] of registry.entries.entries()) {
    if (entry.seq !== index + 1) {
      errors.push(`costwatch_prefix_changed: entry ${entry.seq} is in position ${index + 1}`);
    }
    const prefix = registry.entries.slice(0, index);
    if (entry.checkpoint.length !== prefix.length) {
      // A removed tail is a length that no longer matches.
      errors.push(`costwatch_truncated: entry ${entry.seq} was appended onto ${entry.checkpoint.length} entries, ${prefix.length} are here`);
    } else if (entry.checkpoint.sha256 !== sha256(canonical(prefix))) {
      // A rewritten earlier entry changes the prefix digest of every entry
      // after it.
      errors.push(`costwatch_prefix_changed: entry ${entry.seq} was appended onto a different prefix`);
    }
    const key = `${entry.checkpoint.length}:${entry.checkpoint.sha256}`;
    if (seenCheckpoints.has(key)) {
      errors.push(`costwatch_lost_update: entries ${seenCheckpoints.get(key)} and ${entry.seq} were both appended onto the same prefix`);
    }
    seenCheckpoints.set(key, entry.seq);
    if (!entry.writer?.lock_id || !entry.writer?.operation_id) {
      errors.push(`costwatch_lock_missing: entry ${entry.seq}`);
    } else if (seenOperations.has(entry.writer.operation_id)) {
      errors.push(`costwatch_lost_update: operation ${entry.writer.operation_id} appended twice`);
    } else {
      seenOperations.add(entry.writer.operation_id);
    }
  }
  return errors;
}

export function validateReflectDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  for (const relative of [PASS_SCHEMA_PATH, REGISTRY_SCHEMA_PATH]) {
    if (!contract.includes(relative)) errors.push(`${CONTRACT_PATH}: does not point at ${relative}`);
  }
  for (const refusal of REFUSALS) {
    if (!contract.includes(refusal)) errors.push(`${CONTRACT_PATH}: refusal ${refusal} is not documented`);
  }
  if (!contract.includes("refused as unproven")) {
    errors.push(`${CONTRACT_PATH}: does not state what happens to a theoretical gap`);
  }
  if (!contract.includes("not prose")) {
    errors.push(`${CONTRACT_PATH}: does not state what repeated friction becomes`);
  }
  if (!contract.includes("Accepted does not mean active")) {
    errors.push(`${CONTRACT_PATH}: does not state that an accepted change still takes the panel`);
  }
  if (!contract.includes("bytes nobody scanned")) {
    errors.push(`${CONTRACT_PATH}: does not state why a clearance reference is required`);
  }

  let passSchema;
  let registrySchema;
  try {
    passSchema = JSON.parse(files[PASS_SCHEMA_PATH]);
    registrySchema = JSON.parse(files[REGISTRY_SCHEMA_PATH]);
  } catch (error) {
    return [...errors, `costwatch_malformed: a schema is not valid JSON: ${error.message}`];
  }
  for (const [relative, schema] of [
    [PASS_SCHEMA_PATH, passSchema],
    [REGISTRY_SCHEMA_PATH, registrySchema],
  ]) {
    if (schema.additionalProperties !== false) {
      errors.push(`${relative}: root must be closed (additionalProperties:false)`);
    }
  }
  const lenses = passSchema.properties?.lenses ?? {};
  if (lenses.minItems !== 3 || lenses.maxItems !== 3) {
    errors.push(`${PASS_SCHEMA_PATH}: all three lenses must run, and only those three`);
  }
  if (passSchema.properties?.lenses?.items?.properties?.read_only?.const !== true) {
    errors.push(`${PASS_SCHEMA_PATH}: the lenses must be read-only by construction`);
  }
  if (!(passSchema.properties?.extract?.required ?? []).includes("clearance_digest")) {
    errors.push(`${PASS_SCHEMA_PATH}: the clearance must name the bytes it covered`);
  }
  const entryRequired = registrySchema.properties?.entries?.items?.required ?? [];
  for (const field of ["checkpoint", "writer", "evidence_locators"]) {
    if (!entryRequired.includes(field)) {
      errors.push(`${REGISTRY_SCHEMA_PATH}: ${field} must be required on every entry`);
    }
  }

  let registry;
  try {
    registry = JSON.parse(files[REGISTRY_EXAMPLE_PATH]);
  } catch (error) {
    return [...errors, `${REGISTRY_EXAMPLE_PATH}: costwatch_malformed: ${error.message}`];
  }
  errors.push(...validateRegistry(registry, registrySchema).map((message) => `${REGISTRY_EXAMPLE_PATH}: ${message}`));

  for (const relative of [PASS_EXAMPLE_PATH, REFUSED_EXAMPLE_PATH]) {
    let record;
    try {
      record = JSON.parse(files[relative]);
    } catch (error) {
      errors.push(`${relative}: not valid JSON: ${error.message}`);
      continue;
    }
    const found = validatePass(record, passSchema);
    if (relative === PASS_EXAMPLE_PATH) {
      errors.push(...found.map((message) => `${relative}: ${message}`));
    } else if (found.length === 0) {
      errors.push(`${relative}: the refused example is accepted`);
    }
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateReflectDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const passSchema = JSON.parse(files[PASS_SCHEMA_PATH]);
    const refused = validatePass(JSON.parse(files[REFUSED_EXAMPLE_PATH]), passSchema);
    const registry = JSON.parse(files[REGISTRY_EXAMPLE_PATH]);
    console.log("Reflect and cost-watch design validation PASS");
    console.log(`design_digest=${reflectDesignDigest(files)}`);
    console.log(`lenses=${LENSES.length} refusals=${REFUSALS.length} registry_entries=${registry.entries.length} refused_example_findings=${refused.length}`);
  }
}
