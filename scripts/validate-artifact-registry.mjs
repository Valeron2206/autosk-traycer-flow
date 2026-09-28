#!/usr/bin/env node

/**
 * Design-time validator for the issue #14 artifact registry.
 *
 * The registry's whole claim is that adding a class is one entry rather than a
 * new value in several `switch` statements. That claim is only worth anything if
 * the registry actually governs this repository's own artifacts, so the last
 * check here is the load-bearing one: every contract under `docs/contracts/`
 * must have an entry, and adding one without registering it fails.
 *
 * Every class carries a lifecycle (debt 11g, ADR-101), as every carrier key
 * does since debt 10g: this validator holds a class v1 does not govern to the
 * program matrix, and a class a v1 workflow produces to v1, so the classifier
 * can refuse the first without hiding the second.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { V1_LIFECYCLE } from "../src/host/artifact-classifier.mjs";
import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/artifact-registry.md";
export const SCHEMA_PATH = "resources/artifact-registry/artifact-registry.schema.json";
export const REGISTRY_PATH = "resources/artifact-registry/artifact-registry.v1.json";
export const MATRIX_PATH = "resources/program-capabilities/matrix.v1.json";
export const GRAPH_PATH = "resources/workflow-graph/workflow-graph.v1.json";
export const CONTRACT_MARKER = "<!-- artifact-registry-contract:v1 -->";
export const CONTRACTS_DIR = "docs/contracts";

/**
 * The lifecycles a class may carry, closed.
 *
 * The first two are the program matrix's: a class v1 governs, and a class of
 * an issue the matrix puts after v1. The third is for an issue outside the
 * matrix's #3–#39 inventory (#47): it may not claim a lifecycle of matrix v1
 * (debt 9d), so its classes wait for a successor matrix to classify it, and
 * say so (round 6, R6-28).
 */
export const LIFECYCLES = Object.freeze([V1_LIFECYCLE, "planned_after_v1", "successor_matrix_candidate"]);

/** Closed park reasons of section 8. */
export const PARK_REASONS = Object.freeze([
  "unknown_class",
  "ambiguous_class",
  "missing_predecessor",
  "unregistered_artifact",
  "registry_drift",
  "cyclic_impact_graph",
  "validator_missing",
  "schema_missing",
]);

/** Categories the classifier may return. Anything else is `unknown_class`. */
export const CATEGORIES = Object.freeze([
  "behavior_defining",
  "governance_defining",
  "explanatory",
  "runtime_evidence",
]);

/** The class that governs the contract documents themselves. */
export const CONTRACT_CLASS = "contract_document";

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, REGISTRY_PATH, MATRIX_PATH, GRAPH_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Content, not writing order: a class list is a set. */
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
  return sha256(`${registry.classifier_version}${canonicalValue(registry.classes)}`);
}

export function artifactRegistryDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

/** Depth-first cycle search over `impacts`, returning the first cycle found. */
export function findImpactCycle(registry) {
  const edges = new Map(registry.classes.map((entry) => [entry.class, entry.impacts]));
  const state = new Map();
  const stack = [];
  let cycle = null;

  const visit = (name) => {
    if (cycle) return;
    if (state.get(name) === "done") return;
    if (state.get(name) === "open") {
      cycle = [...stack.slice(stack.indexOf(name)), name];
      return;
    }
    state.set(name, "open");
    stack.push(name);
    for (const next of edges.get(name) ?? []) visit(next);
    stack.pop();
    state.set(name, "done");
  };

  for (const entry of registry.classes) visit(entry.class);
  return cycle;
}

export function validateRegistry(registry, schema) {
  const errors = validateJsonSchema(registry, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const names = new Set();
  for (const entry of registry.classes) {
    if (names.has(entry.class)) errors.push(`${entry.class}: declared twice`);
    names.add(entry.class);
  }

  // Written in canonical order, so two registries with the same content are the
  // same bytes and a diff shows a real change rather than a reshuffle.
  const written = registry.classes.map((entry) => entry.class);
  if (written.join(",") !== [...written].sort().join(",")) {
    errors.push("classes must be written sorted by class name");
  }

  // A path claimed by two classes has no defined lifecycle: the two entries can
  // disagree on review mode and on impact closure, and nothing decides which
  // applies. This is `ambiguous_class` in the contract, refused here.
  const claimants = new Map();
  for (const entry of registry.classes) {
    for (const pattern of entry.paths) {
      claimants.set(pattern, [...(claimants.get(pattern) ?? []), entry.class]);
    }
  }
  for (const [pattern, classes] of claimants) {
    if (classes.length > 1) {
      errors.push(`${pattern}: claimed by ${classes.sort().join(" and ")}; a path has one lifecycle`);
    }
  }

  const lifecycleOf = new Map(registry.classes.map((entry) => [entry.class, entry.lifecycle]));
  for (const entry of registry.classes) {
    for (const predecessor of entry.requires) {
      if (!names.has(predecessor)) errors.push(`${entry.class}: requires unknown class ${predecessor}`);
    }
    // Debt 11g: the schema requires every class v1 does not govern to name the
    // issue that owns it; its reader does not apply `not`, so the other half —
    // a v1 class names none — is checked here.
    if (entry.lifecycle === V1_LIFECYCLE) {
      if (entry.decided_by !== undefined) errors.push(`${entry.class}: a required_for_v1 class names no deciding issue`);
      // A v1 artifact whose predecessor v1 never approves would park on
      // `missing_predecessor` for ever: v1 classes stand on v1 classes only.
      for (const predecessor of entry.requires) {
        const lifecycle = lifecycleOf.get(predecessor);
        if (lifecycle !== undefined && lifecycle !== V1_LIFECYCLE) {
          errors.push(`${entry.class}: a required_for_v1 class requires ${predecessor}, which is ${lifecycle}`);
        }
      }
    }
    for (const impacted of entry.impacts) {
      if (!names.has(impacted)) errors.push(`${entry.class}: impacts unknown class ${impacted}`);
    }
    if (entry.impacts.includes(entry.class)) errors.push(`${entry.class}: impacts itself`);

    // A behaviour- or governance-defining artifact that no one reviews is the
    // gap this issue exists to close.
    if (
      (entry.category === "behavior_defining" || entry.category === "governance_defining") &&
      entry.review.mode === "none"
    ) {
      errors.push(`${entry.class}: ${entry.category} cannot have review mode none`);
    }
    if (entry.review.mode === "narrow_review" && !entry.review.condition) {
      errors.push(`${entry.class}: narrow_review must state the condition it is narrow under`);
    }
    // An explanatory artifact that impacts a behaviour class is not explanatory.
    if (entry.category === "explanatory" && entry.impacts.length > 0) {
      errors.push(`${entry.class}: explanatory artifacts cannot impact other classes`);
    }
  }

  const cycle = findImpactCycle(registry);
  if (cycle) {
    errors.push(`impact graph has a cycle: ${cycle.join(" -> ")}; the affected closure would be arbitrary`);
  }

  const expected = registryDigest(registry);
  if (registry.registry_digest !== expected) {
    errors.push(`registry_digest does not recompute: recorded ${registry.registry_digest}, computed ${expected}`);
  }
  return errors;
}

/**
 * A class v1 does not govern is held to the program matrix (debt 11g), as a
 * post-v1 carrier key is (ADR-093).
 *
 * `planned_after_v1` names an issue the matrix puts after v1: a class marked
 * so by an issue v1 must deliver would hide a v1 class. A
 * `successor_matrix_candidate` names an issue the matrix does not classify at
 * all — #47's contract says that of #47, and a lifecycle of matrix v1 claimed
 * for such an issue is what debt 9d refused in the contracts.
 */
export function lifecycleErrors(registry, matrix) {
  const errors = [];
  const records = Array.isArray(matrix?.records) ? matrix.records : [];
  for (const entry of Array.isArray(registry?.classes) ? registry.classes : []) {
    if (entry?.lifecycle === V1_LIFECYCLE || typeof entry?.decided_by !== "string") continue;
    const record = records.find((candidate) => candidate?.issue_number === Number(entry.decided_by.slice(1)));
    if (entry.lifecycle === "planned_after_v1") {
      if (!record) {
        errors.push(`${entry.class}: ${entry.decided_by} is not an issue of ${MATRIX_PATH}, so the matrix does not put it after v1`);
      } else if (record.lifecycle !== "planned_after_v1") {
        errors.push(`${entry.class}: ${entry.decided_by} is ${record.lifecycle} in ${MATRIX_PATH}, not planned_after_v1`);
      }
    } else if (entry.lifecycle === "successor_matrix_candidate" && record) {
      errors.push(`${entry.class}: ${entry.decided_by} is ${record.lifecycle} in ${MATRIX_PATH}; a successor_matrix_candidate names an issue the matrix does not classify`);
    }
  }
  return errors;
}

/**
 * The registry classes the workflow graph names, each with the predicates
 * that read it, in name order.
 *
 * Every workflow the graph registers is v1's (the matrix's
 * `graph.workflow-registration`, #18). The graph records no producer per
 * class; what it names are the facts its predicates read, and a fact that is
 * a registry class — a planning kind, the Tickets, the integration
 * authorization — is an artifact a v1 workflow produces and decides on.
 */
export function graphClasses(registry, graph) {
  const names = new Set((Array.isArray(registry?.classes) ? registry.classes : []).map((entry) => entry?.class));
  const read = new Map();
  for (const predicate of Array.isArray(graph?.predicates) ? graph.predicates : []) {
    for (const fact of Array.isArray(predicate?.reads) ? predicate.reads : []) {
      if (names.has(fact)) read.set(fact, [...(read.get(fact) ?? []), predicate.id]);
    }
  }
  return new Map([...read.keys()].sort().map((name) => [name, [...new Set(read.get(name))].sort()]));
}

/**
 * A class a v1 workflow produces is `required_for_v1`.
 *
 * The matrix alone would admit such a class marked `planned_after_v1` by an
 * issue the matrix does put after v1, and the classifier would then refuse an
 * artifact v1 cannot run without. A graph whose predicates read no class
 * holds nothing, and is refused rather than passing silently. The classes the
 * graph does not name are held through `requires` (`validateRegistry`): a v1
 * class stands on v1 classes only.
 */
export function graphClassErrors(registry, graph) {
  const read = graphClasses(registry, graph);
  if (read.size === 0) {
    return [`no class is read by the predicates of ${GRAPH_PATH}, so nothing holds a class its workflows produce to v1`];
  }
  const lifecycleOf = new Map(registry.classes.map((entry) => [entry?.class, entry?.lifecycle]));
  const errors = [];
  for (const [name, predicates] of read) {
    const lifecycle = lifecycleOf.get(name);
    if (lifecycle !== V1_LIFECYCLE) {
      errors.push(`${name}: the workflow graph reads it (${predicates.join(", ")}), so a v1 workflow produces it; it must be required_for_v1, not ${lifecycle}`);
    }
  }
  return errors;
}

/**
 * How many classes carry each lifecycle, in the order of `LIFECYCLES`, zero
 * included. #14's obligation covers the `required_for_v1` classes; the others
 * are counted apart rather than inside one total.
 */
export function lifecycleCounts(registry) {
  return Object.fromEntries(LIFECYCLES.map((lifecycle) => [
    lifecycle,
    registry.classes.filter((entry) => entry.lifecycle === lifecycle).length,
  ]));
}

export function validateArtifactRegistryDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const reason of PARK_REASONS) {
    if (!contract.includes(reason)) errors.push(`${CONTRACT_PATH}: park reason ${reason} is not documented`);
  }
  for (const lifecycle of LIFECYCLES) {
    if (!contract.includes(lifecycle)) errors.push(`${CONTRACT_PATH}: lifecycle ${lifecycle} is not documented`);
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
  const categories = schema.properties?.classes?.items?.properties?.category?.enum ?? [];
  if (categories.join(",") !== CATEGORIES.join(",")) {
    errors.push(`${SCHEMA_PATH}: categories must be exactly ${CATEGORIES.join(", ")}`);
  }
  const lifecycles = schema.properties?.classes?.items?.properties?.lifecycle?.enum ?? [];
  if (lifecycles.join(",") !== LIFECYCLES.join(",")) {
    errors.push(`${SCHEMA_PATH}: lifecycles must be exactly ${LIFECYCLES.join(", ")}`);
  }

  let registry;
  try {
    registry = JSON.parse(files[REGISTRY_PATH]);
  } catch (error) {
    return [...errors, `${REGISTRY_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...validateRegistry(registry, schema).map((message) => `${REGISTRY_PATH}: ${message}`));
  let matrix;
  let graph;
  try {
    matrix = JSON.parse(files[MATRIX_PATH]);
    graph = JSON.parse(files[GRAPH_PATH]);
  } catch (error) {
    return [...errors, `program matrix or workflow graph: not valid JSON: ${error.message}`];
  }
  errors.push(
    ...[...lifecycleErrors(registry, matrix), ...graphClassErrors(registry, graph)]
      .map((message) => `${REGISTRY_PATH}: ${message}`),
  );

  // The load-bearing check: this repository governs itself. A contract added
  // without a registry entry is exactly the drift the issue describes, and it
  // fails here rather than being noticed later.
  const governing = registry.classes.find((entry) => entry.class === CONTRACT_CLASS);
  if (!governing) {
    errors.push(`${REGISTRY_PATH}: no ${CONTRACT_CLASS} class, so no contract is governed`);
  } else {
    // Listed one by one, never by glob. A glob would match a new contract
    // automatically, and then "registered" would stop meaning anything: adding a
    // contract has to BE a registry change, which is the mechanism criterion 4
    // asks for.
    const listed = new Set(governing.paths);
    for (const name of readdirSync(path.join(ROOT, CONTRACTS_DIR)).sort()) {
      if (!name.endsWith(".md")) continue;
      const relative = `${CONTRACTS_DIR}/${name}`;
      if (!listed.has(relative)) {
        errors.push(`${relative}: not listed by ${CONTRACT_CLASS} (unregistered_artifact)`);
      }
    }
    for (const listedPath of governing.paths) {
      if (listedPath.includes("*")) {
        errors.push(`${CONTRACT_CLASS}: ${listedPath} is a pattern; contracts must be listed one by one`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateArtifactRegistryDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const registry = JSON.parse(files[REGISTRY_PATH]);
    console.log("Artifact registry design validation PASS");
    console.log(`design_digest=${artifactRegistryDesignDigest(files)}`);
    console.log(`registry_digest=${registry.registry_digest}`);
    const counts = Object.entries(lifecycleCounts(registry)).map(([lifecycle, count]) => `${lifecycle}=${count}`);
    console.log(`classes=${registry.classes.length} ${counts.join(" ")}`);
  }
}
