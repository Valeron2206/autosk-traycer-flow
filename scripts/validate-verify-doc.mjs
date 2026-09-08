#!/usr/bin/env node

/**
 * Design-time validator for the issue #23 project verification document.
 *
 * Without one, different tickets verify the same behaviour by different routes
 * and a command can be green while proving nothing a user would see. The checks
 * here are about the three things that make a recipe worth having: exact
 * commands, an infrastructure failure that is distinguishable from a product
 * one, and a document nobody may call a deliverable before running it.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/verify-doc.md";
export const SCHEMA_PATH = "resources/verify-doc/feature-map.schema.json";
export const EXAMPLE_PATH = "resources/verify-doc/feature-map.example.json";
export const CONTRACT_MARKER = "<!-- verify-doc-contract:v1 -->";

export const REFUSALS = Object.freeze([
  "verify_recipe_missing",
  "verify_recipe_incomplete",
  "verify_command_not_exact",
  "verify_never_executed",
  "verify_self_proof_stale",
  "verify_surface_not_permitted",
  "verify_coverage_gap",
  "verify_doc_drift",
  "verify_infrastructure_failure_mislabeled",
]);

/**
 * Phrases that stand in for an exact invocation.
 *
 * "The implementer will write a script" does not replace the exact command of a
 * tool that already exists, and a recipe carrying one of these has deferred the
 * only part that makes it repeatable.
 */
export const VAGUE_PHRASES = Object.freeze([
  /\bwill write\b/iu,
  /\bwrite a script\b/iu,
  /\bsomehow\b/iu,
  /\bas needed\b/iu,
  /\betc\.?$/iu,
  /\bor similar\b/iu,
  /\bTBD\b/u,
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

export function verifyDocDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

/**
 * Whether a recipe may be cited as proving an acceptance criterion.
 *
 * A recipe nobody has run is a plan for verifying. This is the class of artefact
 * where that difference matters most: it is what everything else is verified
 * against.
 */
export function recipeUsable(recipe, map) {
  if (recipe.state !== "self_proved") return "refused:verify_never_executed";
  const proof = recipe.self_proof;
  if (proof.doc_commit !== map.doc_commit || proof.doc_tree !== map.doc_tree) {
    return "refused:verify_self_proof_stale";
  }
  if (proof.recipe_id !== recipe.recipe_id) return "refused:verify_self_proof_stale";
  if (recipe.surface === "shared" && recipe.surface_permission === undefined) {
    return "refused:verify_surface_not_permitted";
  }
  return "usable";
}

/** Whether a ticket's acceptance criteria are all covered by usable recipes. */
export function coverage(map, criteria) {
  const proven = new Set();
  for (const recipe of map.recipes) {
    if (recipeUsable(recipe, map) !== "usable") continue;
    for (const criterion of recipe.acceptance_criteria) proven.add(criterion);
  }
  const gaps = criteria.filter((criterion) => !proven.has(criterion));
  return gaps.length === 0 ? "covered" : `refused:verify_coverage_gap:${gaps.sort().join(",")}`;
}

export function validateMap(map, schema) {
  const errors = validateJsonSchema(map, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const ids = map.recipes.map((recipe) => recipe.recipe_id);
  if (new Set(ids).size !== ids.length) errors.push("a recipe id appears twice");

  for (const recipe of map.recipes) {
    // Every command is a command, not a description of one.
    const commands = [...recipe.launch, ...recipe.drive, ...recipe.cleanup];
    for (const command of commands) {
      for (const phrase of VAGUE_PHRASES) {
        if (phrase.test(command)) {
          errors.push(`${recipe.recipe_id}: "${command}" is not an exact invocation (verify_command_not_exact)`);
        }
      }
    }
    // An infrastructure failure and a product failure must be distinguishable,
    // because the difference decides whether the ticket is wrong or the machine.
    for (const check of recipe.doctor) {
      if (check.infrastructure_failure_signal.trim().length === 0) {
        errors.push(`${recipe.recipe_id}: a doctor check must say how its failure is recognised`);
      }
    }
    if (recipe.surface === "shared" && recipe.surface_permission === undefined) {
      errors.push(`${recipe.recipe_id}: a shared surface needs recorded permission (verify_surface_not_permitted)`);
    }
    if (recipe.surface !== "shared" && recipe.surface_permission !== undefined) {
      errors.push(`${recipe.recipe_id}: only a shared surface carries a permission`);
    }
    if (recipe.state === "self_proved" && recipe.self_proof === undefined) {
      errors.push(`${recipe.recipe_id}: self-proved without evidence (verify_never_executed)`);
    }
    if (recipe.state === "draft" && recipe.self_proof !== undefined) {
      errors.push(`${recipe.recipe_id}: a draft cannot carry self-proof evidence`);
    }
    // Disposable scaffolding is cited by contract identity; committed scaffolding
    // must additionally name the exact command it became.
    if (recipe.scaffolding?.lifecycle === "committed") {
      if (!recipe.scaffolding.canonical_command || !recipe.scaffolding.version) {
        errors.push(`${recipe.recipe_id}: committed scaffolding needs its canonical command and version`);
      }
    }
  }
  return errors;
}

export function validateVerifyDocDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const refusal of REFUSALS) {
    if (!contract.includes(refusal)) errors.push(`${CONTRACT_PATH}: refusal ${refusal} is not documented`);
  }
  if (!contract.includes("a recipe nobody has run is a draft")) {
    errors.push(`${CONTRACT_PATH}: does not state what makes a document a deliverable`);
  }
  if (!contract.includes("does not replace the exact invocation")) {
    errors.push(`${CONTRACT_PATH}: does not state that commands are exact`);
  }
  if (!contract.includes("an infrastructure failure and a product failure look the same")) {
    errors.push(`${CONTRACT_PATH}: does not state why Doctor exists`);
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
  // All five parts of a recipe are required. A recipe missing one is not a
  // shorter recipe, it is a recipe with a question nobody answered.
  const required = schema.properties?.recipes?.items?.required ?? [];
  for (const part of ["launch", "doctor", "drive", "evidence", "cleanup"]) {
    if (!required.includes(part)) errors.push(`${SCHEMA_PATH}: ${part} must be required (verify_recipe_incomplete)`);
  }
  const states = schema.properties?.recipes?.items?.properties?.state?.enum ?? [];
  if (states.slice().sort().join(",") !== "draft,self_proved") {
    errors.push(`${SCHEMA_PATH}: a recipe is either a draft or self-proved`);
  }

  let map;
  try {
    map = JSON.parse(files[EXAMPLE_PATH]);
  } catch (error) {
    return [...errors, `${EXAMPLE_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...validateMap(map, schema).map((message) => `${EXAMPLE_PATH}: ${message}`));
  // The example must show both sides, or it proves nothing about the rule.
  if (!map.recipes.some((recipe) => recipeUsable(recipe, map) === "usable")) {
    errors.push(`${EXAMPLE_PATH}: no recipe is usable`);
  }
  if (!map.recipes.some((recipe) => recipeUsable(recipe, map) === "refused:verify_never_executed")) {
    errors.push(`${EXAMPLE_PATH}: no recipe is still a draft`);
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateVerifyDocDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const map = JSON.parse(files[EXAMPLE_PATH]);
    console.log("Verification document design validation PASS");
    console.log(`design_digest=${verifyDocDesignDigest(files)}`);
    console.log(`recipes=${map.recipes.length} refusals=${REFUSALS.length}`);
  }
}
