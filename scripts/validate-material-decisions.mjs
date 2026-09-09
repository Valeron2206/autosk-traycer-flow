#!/usr/bin/env node

/**
 * Validator and projector for the material decision manifest.
 *
 * The projector compares; it does not interpret. Everything it reports is a
 * difference between the approved manifest and the draft, named as one of four
 * things rather than summarised as "the manifest changed" — an operator fixing
 * a dropped decision does something different from an operator fixing a
 * restated one.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/material-decisions.md";
export const SCHEMA_PATH = "resources/material-decisions/material-decision-manifest.schema.json";
export const EXAMPLE_PATH = "resources/material-decisions/material-decision-manifest.example.json";
export const REFUSED_PATH = "resources/material-decisions/material-decision-manifest.refused.example.json";
export const CONTRACT_MARKER = "<!-- material-decisions-contract:v1 -->";

/** The closed refusal set, as the contract states it. */
export const REFUSALS = Object.freeze([
  "material_manifest_missing",
  "material_manifest_duplicate",
  "material_manifest_malformed",
  "material_decision_unknown",
  "material_decision_missing",
  "material_decision_changed",
  "material_section_unmapped",
  "material_decision_id_reused",
]);

const BLOCK = /```autosk-material-decisions\n([\s\S]*?)\n```/gu;

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The one block an artifact carries.
 *
 * Two blocks are refused rather than merged: merging makes the artifact's
 * authority depend on which one a reader reached first.
 */
export function extractManifest(markdown) {
  const blocks = [...markdown.matchAll(BLOCK)].map((match) => match[1]);
  if (blocks.length === 0) return { errors: [{ reason: "material_manifest_missing", detail: "no block" }] };
  if (blocks.length > 1) {
    return { errors: [{ reason: "material_manifest_duplicate", detail: `${blocks.length} blocks` }] };
  }
  try {
    return { manifest: JSON.parse(blocks[0]), errors: [] };
  } catch (error) {
    return { errors: [{ reason: "material_manifest_malformed", detail: error.message.slice(0, 120) }] };
  }
}

/** The manifest's own consistency, before anything is compared to anything. */
export function manifestErrors(manifest) {
  const errors = [];
  const seen = new Map();
  for (const decision of manifest.decisions) {
    const previous = seen.get(decision.decision_id);
    if (previous !== undefined && previous !== decision.statement) {
      // Reusing an id for a different statement is how an approval survives the
      // decision it was about.
      errors.push({ reason: "material_decision_id_reused", detail: decision.decision_id });
    }
    seen.set(decision.decision_id, decision.statement);
  }
  const known = new Set(manifest.decisions.map((decision) => decision.decision_id));
  for (const section of manifest.normative_sections) {
    for (const id of section.decision_ids) {
      if (!known.has(id)) {
        errors.push({ reason: "material_decision_unknown", detail: `${section.section}: ${id}` });
      }
    }
  }
  for (const decision of manifest.decisions) {
    for (const section of decision.sections) {
      if (!manifest.normative_sections.some((entry) => entry.section === section)) {
        errors.push({ reason: "material_section_unmapped", detail: `${decision.decision_id}: ${section}` });
      }
    }
    // Superseding an id the manifest no longer contains is the normal case —
    // that is what superseding means. Superseding itself is the id reuse this
    // contract refuses, written as a lineage.
    if (decision.supersedes === decision.decision_id) {
      errors.push({ reason: "material_decision_id_reused", detail: `${decision.decision_id} supersedes itself` });
    }
  }
  return errors;
}

/**
 * Whether a normative section decides something and cites nothing.
 *
 * A section listed as normative with no decision ids is the authority this
 * contract removes. `normative` says which sections are behaviour-defining;
 * anything else in the artifact is explanation and is not asked.
 */
export function sectionErrors(manifest, { normative }) {
  const errors = [];
  for (const section of normative) {
    const entry = manifest.normative_sections.find((candidate) => candidate.section === section);
    if (!entry || entry.decision_ids.length === 0) {
      errors.push({ reason: "material_section_unmapped", detail: section });
    }
  }
  return errors;
}

/**
 * The projection: the draft against the approved manifest.
 *
 * Four differences, four classes. "The manifest changed" would tell an operator
 * that something is wrong and leave them to find out what.
 */
export function project(approved, draft) {
  const errors = [];
  const approvedById = new Map(approved.decisions.map((decision) => [decision.decision_id, decision]));
  const draftById = new Map(draft.decisions.map((decision) => [decision.decision_id, decision]));
  for (const [id, decision] of draftById) {
    const known = approvedById.get(id);
    if (!known) {
      errors.push({ reason: "material_decision_unknown", detail: id });
      continue;
    }
    if (known.statement !== decision.statement) {
      errors.push({ reason: "material_decision_changed", detail: id });
    }
  }
  for (const id of approvedById.keys()) {
    if (!draftById.has(id)) errors.push({ reason: "material_decision_missing", detail: id });
  }
  for (const section of draft.normative_sections) {
    if (section.decision_ids.length > 0) continue;
    const wasEmpty = approved.normative_sections
      .find((entry) => entry.section === section.section)?.decision_ids.length === 0;
    // A section that was explanation and stayed explanation is not a finding;
    // one that decides something and cites nothing is.
    if (!wasEmpty) errors.push({ reason: "material_section_unmapped", detail: section.section });
  }
  return errors;
}

/** Whether the draft may freeze: byte-equivalent, or a proven local addition. */
export function freezeDecision(approved, draft, { classifierProof } = {}) {
  const differences = project(approved, draft);
  if (differences.length === 0) {
    return Object.freeze({ decision: "freeze", basis: "byte_equivalent_projection" });
  }
  if (classifierProof?.local_non_material === true && classifierProof.registry_digest) {
    return Object.freeze({
      decision: "freeze",
      basis: "classifier_proven_local_addition",
      registry_digest: classifierProof.registry_digest,
    });
  }
  return Object.freeze({
    decision: "clarify",
    reasons: differences,
  });
}

/** The digest an approval is bound to. */
export function manifestHash(manifest) {
  return sha256(JSON.stringify({
    artifact_kind: manifest.artifact_kind,
    artifact_id: manifest.artifact_id,
    decisions: [...manifest.decisions]
      .map((decision) => ({ id: decision.decision_id, kind: decision.kind, statement: decision.statement }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  }));
}

/** The shipped design. */
export function validateDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract || !contract.includes(CONTRACT_MARKER)) {
    errors.push(`${CONTRACT_PATH}: the contract marker is missing`);
  }
  for (const refusal of REFUSALS) {
    if (contract && !contract.includes(`\`${refusal}\``)) {
      errors.push(`${CONTRACT_PATH}: ${refusal} is not named in the contract`);
    }
  }
  const schema = JSON.parse(files[SCHEMA_PATH]);
  if (schema.additionalProperties !== false) errors.push(`${SCHEMA_PATH}: the schema is not closed`);

  const example = JSON.parse(files[EXAMPLE_PATH]);
  errors.push(...validateJsonSchema(example, schema).map((message) => `${EXAMPLE_PATH}: ${message}`));
  const own = manifestErrors(example);
  if (own.length > 0) {
    errors.push(`${EXAMPLE_PATH}: the worked example is refused (${own.map((entry) => entry.reason).join(", ")})`);
  }

  const refused = JSON.parse(files[REFUSED_PATH]);
  errors.push(...validateJsonSchema(refused, schema).map((message) => `${REFUSED_PATH}: ${message}`));
  const produced = new Set([
    ...project(example, refused).map((entry) => entry.reason),
    ...sectionErrors(refused, { normative: ["4. Fan-out"] }).map((entry) => entry.reason),
  ]);
  if (produced.size < 3) {
    errors.push(`${REFUSED_PATH}: the refused example produces only ${produced.size} refusal classes`);
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = Object.fromEntries(
    [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, REFUSED_PATH].map((relative) => [
      relative,
      readFileSync(path.join(ROOT, relative), "utf8"),
    ]),
  );
  const errors = validateDesign(files);
  for (const error of errors) console.error(error);
  if (errors.length > 0) process.exitCode = 1;
  else {
    console.log("Material decision manifest validation PASS");
    console.log(`refusals=${REFUSALS.length}`);
  }
}
