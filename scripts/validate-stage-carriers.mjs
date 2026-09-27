#!/usr/bin/env node

/**
 * Design-time validator for the issue #19 stage carrier matrix.
 *
 * Without a matrix there are two equally bad modes: send all thirteen
 * governance files to every agent and drown the context, or fail to send the one
 * playbook the role needed. So the checks here are about the mapping being
 * total, the forbidden sets actually holding, and an echo the host can compare
 * rather than trust.
 *
 * The registry's `governance_files` is the one list of the bundle's members
 * (debt 10g, ADR-093): the bundle validator and the builder CLI read it, and
 * this validator holds it to the bundle tree of 02 §5 and 03 §3 and to the
 * parity registry's guide and protocol entries.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WORK_TYPES } from "../src/host/work-type-gates.mjs";
import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/stage-carriers.md";
export const SCHEMA_PATH = "resources/stage-carriers/stage-carriers.schema.json";
export const REGISTRY_PATH = "resources/stage-carriers/stage-carriers.v1.json";
export const DISPATCH_SCHEMA_PATH = "resources/stage-carriers/stage-carriers.dispatch.schema.json";
export const DISPATCH_EXAMPLE_PATH = "resources/stage-carriers/stage-carriers.dispatch.example.json";
export const ARCHITECTURE_PATH = "02-architecture.md";
export const PLAN_PATH = "03-technical-plan.md";
export const PARITY_PATH = "resources/traycer-parity/registry.v1.json";
export const MATRIX_PATH = "resources/program-capabilities/matrix.v1.json";
export const CONTRACT_MARKER = "<!-- stage-carriers-contract:v1 -->";

/**
 * The two files the bundle tree lists beside its members. The manifest records
 * the content digest and the attestation binds verdicts to it, so neither can
 * be in the digest's preimage (02 §5), and neither is a governance file.
 */
export const BUNDLE_COMPANIONS = Object.freeze(["bundle-manifest.json", "bundle-attestation.json"]);

/** The line that opens the bundle tree in 02 §5 and 03 §3. */
const BUNDLE_ROOT = "autosk-v1/";

/** The carrier key of the implementer for a v1 work type: `bug-fix` → `implementer.bug_fix`. */
export function implementerKey(workType) {
  return `implementer.${workType.replaceAll("-", "_")}`;
}

/**
 * Every consumer the issue names. A key missing here is a role nobody mapped.
 *
 * The implementer keys are not listed by hand: they come from the v1 work types
 * (`WORK_TYPES`), so a work type added there has no carrier until one is mapped.
 */
export const REQUIRED_KEYS = Object.freeze([
  "author.brief", "author.core_flow", "author.tech_plan", "author.tickets",
  "panel.opus", "panel.astra", "panel.grok", "panel.muse",
  "contest.reviewer", "narrow.reviewer",
  ...WORK_TYPES.map(implementerKey),
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

/** The Arena Judge's brief: it reaches the Judge, and never a candidate. */
export const JUDGE_BRIEF = "protocol/arena/judge-brief.md";

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
  for (const relative of [
    CONTRACT_PATH, SCHEMA_PATH, REGISTRY_PATH, DISPATCH_SCHEMA_PATH, DISPATCH_EXAMPLE_PATH,
    ARCHITECTURE_PATH, PLAN_PATH, PARITY_PATH, MATRIX_PATH,
  ]) {
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
  const inactivePaths = new Set(inactive.map((file) => file.path));
  const used = new Set();
  for (const [key, carrier] of Object.entries(registry.carriers)) {
    // The schema reader does not apply an `additionalProperties` schema, so the
    // entry's lifecycle and its issue are checked here, not left to the schema.
    if (!["required_for_v1", "planned_after_v1"].includes(carrier.lifecycle)) {
      errors.push(`${key}: lifecycle must be required_for_v1 or planned_after_v1`);
    }
    if (carrier.decided_by !== undefined && !/^#[1-9][0-9]*$/u.test(String(carrier.decided_by))) {
      errors.push(`${key}: decided_by must name an issue as #N`);
    }
    const inV1 = carrier.lifecycle === "required_for_v1";
    // A post-v1 key is registered so the mapping is explicit, and marked so the
    // dispatcher refuses it; the marker names the issue that put it after v1.
    if (carrier.lifecycle === "planned_after_v1" && !carrier.decided_by) errors.push(`${key}: planned_after_v1 must name the issue that decided it`);
    if (inV1 && carrier.decided_by !== undefined) errors.push(`${key}: a v1 carrier names no deciding issue`);
    for (const file of carrier.required) {
      if (!declared.has(file)) errors.push(`${key} requires ${file}, which is not a governance file`);
      if (inV1 && inactivePaths.has(file)) {
        errors.push(`${key} is dispatched in v1 but carries ${file}, which is inactive_in_v1`);
      }
      // Only a v1 key consumes a file in v1: a file only post-v1 keys read is shipped for nobody.
      if (inV1) used.add(file);
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
    if (!used.has(file)) errors.push(`${file} has no v1 consumer (carrier_coverage_incomplete)`);
  }

  // Every v1 work type has an implementer, and it is handed that work type's playbook.
  for (const type of WORK_TYPES) {
    const key = implementerKey(type);
    const playbook = `protocol/playbooks/${type}.md`;
    if (registry.carriers[key] && !registry.carriers[key].required.includes(playbook)) {
      errors.push(`${key} must carry ${playbook}`);
    }
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
  // The Judge brief reaching an Arena candidate is the failure `forbidden` exists
  // for; it reaches the Judge and is forbidden to every other key.
  for (const [key, carrier] of Object.entries(registry.carriers)) {
    if (key !== "arena.judge" && !carrier.forbidden.includes(JUDGE_BRIEF)) {
      errors.push(`${key} must forbid ${JUDGE_BRIEF} (carrier_forbidden_fragment)`);
    }
  }
  if (!registry.carriers["arena.judge"]?.required.includes(JUDGE_BRIEF)) {
    errors.push(`arena.judge must carry ${JUDGE_BRIEF}`);
  }
  return errors;
}

/**
 * The files of the bundle tree a design document draws, in the order drawn.
 *
 * The tree opens at the line ending in `autosk-v1/` and runs while lines are
 * indented deeper than it; a name ending in `/` opens a directory, and a
 * `dir/file` name on one line is a file in that directory. A document with no
 * such tree lists nothing, which the caller reads as a divergence.
 */
export function bundleTreeFiles(markdown) {
  const lines = String(markdown).split("\n");
  const start = lines.findIndex((line) => line.trim().endsWith(BUNDLE_ROOT));
  if (start === -1) return [];
  const depthOf = (line) => line.length - line.trimStart().length;
  const rootDepth = depthOf(lines[start]);
  const stack = [];
  const found = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || depthOf(line) <= rootDepth) break;
    const depth = depthOf(line);
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
    const name = line.trim();
    const prefix = stack.map((entry) => entry.name).join("");
    if (name.endsWith("/")) stack.push({ depth, name });
    else found.push(`${prefix}${name}`);
  }
  return found;
}

/** The bundle path a parity-registry guide or protocol entry targets, or null for any other entry. */
function parityPath(source) {
  const locator = String(source?.sanitizedLocator ?? "");
  if (source?.kind === "guide" && locator.startsWith("traycer-guide://")) {
    return `${locator.slice("traycer-guide://".length)}.md`;
  }
  if (source?.kind === "protocol_file" && locator.startsWith("traycer-protocol://")) {
    return `protocol/${locator.slice("traycer-protocol://".length)}`;
  }
  return null;
}

function listDifference(label, listed, paths) {
  const errors = [];
  for (const file of paths) if (!listed.includes(file)) errors.push(`${label} does not list ${file}, a governance file`);
  for (const file of listed) if (!paths.includes(file)) errors.push(`${label} lists ${file}, which is not a governance file`);
  if (errors.length === 0 && listed.join("\n") !== paths.join("\n")) {
    errors.push(`${label} lists the governance files in another order`);
  }
  return errors;
}

/**
 * One member list (debt 10g, R6-17): the registry's governance files are the
 * files the bundle tree of 02 §5 and of 03 §3 draws (without the manifest and
 * attestation), and the targets of the parity registry's guide and protocol
 * entries, with `inactive_in_v1` exactly where the parity entry is `post_v1`.
 */
export function memberListErrors(registry, { architecture, plan, parity }) {
  const errors = [];
  const paths = (registry?.governance_files ?? []).map((file) => file.path);
  for (const [label, markdown] of [[`${ARCHITECTURE_PATH} §5`, architecture], [`${PLAN_PATH} §3`, plan]]) {
    const tree = bundleTreeFiles(markdown);
    if (tree.length === 0) {
      errors.push(`${label}: no bundle tree (a line ending in ${BUNDLE_ROOT})`);
      continue;
    }
    for (const companion of BUNDLE_COMPANIONS) {
      if (!tree.includes(companion)) errors.push(`${label}: the bundle tree does not list ${companion}`);
    }
    errors.push(...listDifference(`${label}'s bundle tree`, tree.filter((file) => !BUNDLE_COMPANIONS.includes(file)), paths));
  }
  const entries = (Array.isArray(parity?.sources) ? parity.sources : [])
    .map((source) => ({ path: parityPath(source), post_v1: source?.classification === "post_v1" }))
    .filter((entry) => entry.path !== null);
  const targets = entries.map((entry) => entry.path);
  for (const file of paths) if (!targets.includes(file)) errors.push(`${PARITY_PATH} has no guide or protocol entry for ${file}`);
  for (const file of targets) if (!paths.includes(file)) errors.push(`${PARITY_PATH} targets ${file}, which is not a governance file`);
  for (const file of registry?.governance_files ?? []) {
    const entry = entries.find((candidate) => candidate.path === file.path);
    if (entry && entry.post_v1 !== (file.status === "inactive_in_v1")) {
      errors.push(`${file.path} is ${file.status}, but its parity entry is ${entry.post_v1 ? "post_v1" : "v1"}`);
    }
  }
  return errors;
}

/**
 * The issue a post-v1 key names must be one the program matrix puts after v1:
 * a key marked inactive by an issue v1 must deliver would hide a v1 role.
 */
export function lifecycleErrors(registry, matrix) {
  const errors = [];
  const records = Array.isArray(matrix?.records) ? matrix.records : [];
  // An inactive governance file is held to the same rule as a post-v1 key: the
  // issue that decided it must be one the matrix puts after v1.
  for (const file of registry?.governance_files ?? []) {
    if (file?.status !== "inactive_in_v1") continue;
    const issue = String(file.decided_by ?? "");
    if (!/^#[1-9][0-9]*$/u.test(issue)) {
      errors.push(`${file.path}: ${issue || "(none)"} is not an issue as #N`);
      continue;
    }
    const record = records.find((entry) => entry?.issue_number === Number(issue.slice(1)));
    if (!record) errors.push(`${file.path}: ${issue} is not an issue of ${MATRIX_PATH}`);
    else if (record.lifecycle !== "planned_after_v1") {
      errors.push(`${file.path}: ${issue} is ${record.lifecycle} in ${MATRIX_PATH}, not planned_after_v1`);
    }
  }
  for (const [key, carrier] of Object.entries(registry?.carriers ?? {})) {
    if (carrier?.lifecycle !== "planned_after_v1" || typeof carrier.decided_by !== "string") continue;
    const number = Number(carrier.decided_by.slice(1));
    const record = records.find((entry) => entry?.issue_number === number);
    if (!record) errors.push(`${key}: ${carrier.decided_by} is not an issue of ${MATRIX_PATH}`);
    else if (record.lifecycle !== "planned_after_v1") {
      errors.push(`${key}: ${carrier.decided_by} is ${record.lifecycle} in ${MATRIX_PATH}, not planned_after_v1`);
    }
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
  if (!contract.includes("carrier_registry_digest")) {
    errors.push(`${CONTRACT_PATH}: does not state that the Epic's protocol lock pins the registry (carrier_registry_digest)`);
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
  let parity;
  let matrix;
  try {
    parity = JSON.parse(files[PARITY_PATH]);
    matrix = JSON.parse(files[MATRIX_PATH]);
  } catch (error) {
    return [...errors, `parity registry or matrix: not valid JSON: ${error.message}`];
  }
  errors.push(
    ...memberListErrors(registry, { architecture: files[ARCHITECTURE_PATH], plan: files[PLAN_PATH], parity })
      .map((message) => `${REGISTRY_PATH}: ${message}`),
  );
  errors.push(...lifecycleErrors(registry, matrix).map((message) => `${REGISTRY_PATH}: ${message}`));

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
