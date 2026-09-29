#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REQUIRED_DAEMON_CAPABILITIES, UNPINNED_DAEMON_PRIMITIVES } from "../src/host/daemon-preflight.mjs";
import { MODEL_STEP_CHECKS } from "../src/host/workflow-preflight.mjs";
import { SCHEMA_PATH as GRAPH_SCHEMA_PATH, parseStrict, validateGraph } from "./validate-workflow-graph.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MATRIX_PATH = path.join(ROOT, "resources/program-capabilities/matrix.v1.json");
export const INVENTORY_PATH = path.join(ROOT, "resources/program-capabilities/issue-inventory.v1.json");
export const PARITY_PATH = path.join(ROOT, "resources/traycer-parity/registry.v1.json");
export const GRAPH_PATH = path.join(ROOT, "resources/workflow-graph/workflow-graph.v1.json");
export const DOC_PATH = path.join(ROOT, "docs/program-capability-matrix.md");
export const README_PATH = path.join(ROOT, "README.md");
export const CONTRACTS_DIR = path.join(ROOT, "docs/contracts");

export const ISSUE_MIN = 3;
export const ISSUE_MAX = 39;
export const ISSUE_COUNT = ISSUE_MAX - ISSUE_MIN + 1;
export const POST_V1_ISSUES = Object.freeze([28, 29, 30, 31, 33, 38]);
export const INVENTORY_DOMAIN = "autosk-flow/program-issue-inventory/v1\0";
export const MATRIX_DOMAIN = "autosk-flow/program-capability-matrix/v1\0";

const RECORD_KEYS = Object.freeze([
  "issue_number",
  "issue_title",
  "priority",
  "lifecycle",
  "target_milestone",
  "gate_role",
  "rationale",
  "classification_risk",
  "owner",
  "activation_trigger",
  "design_obligation_before_issue_39",
  "implementation_obligation_before_mvp",
  "release_blocking",
  "full_program_required",
  "dependencies",
  "downstream_blockers",
  "source_parity_ids",
  "supersession_or_split",
  "decision_reference",
  "verification_expectation",
].sort());

const LIFECYCLES = new Set(["required_for_v1", "planned_after_v1", "intentionally_deferred"]);
const PRIORITIES = new Set(["P0", "P1", "P2"]);
const MILESTONES = new Set(["phase_0_complete", "design_ready", "autonomous_mvp", "full_parity_post_v1", "deferred"]);
const GATE_ROLES = new Set(["phase_0_gate", "design_and_mvp_input", "design_gate", "mvp_release_gate", "post_v1_capability"]);

function sorted(values) {
  return [...values].sort((a, b) => {
    if (typeof a === "number" && typeof b === "number") return a - b;
    const left = String(a);
    const right = String(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function nonEmpty(value, minimum = 1) {
  return typeof value === "string" && Array.from(value.trim()).length >= minimum;
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseJson(filePath) {
  const raw = readFileSync(filePath, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) throw new Error(`${filePath}: UTF-8 BOM is forbidden`);
  return JSON.parse(raw);
}

function issueRange() {
  return Array.from({ length: ISSUE_COUNT }, (_, index) => ISSUE_MIN + index);
}

function priorityFromTitle(title) {
  return /^\[(P[012])\]/u.exec(title)?.[1] ?? null;
}

function digestInventory(inventory) {
  const core = {
    repository: inventory.repository,
    issue_range: inventory.issue_range,
    issues: inventory.issues,
  };
  return sha256(INVENTORY_DOMAIN + canonicalStringify(core));
}

function digestMatrix(matrix) {
  const copy = structuredClone(matrix);
  delete copy.canonical_digest;
  return sha256(MATRIX_DOMAIN + canonicalStringify(copy));
}

export function validateInventory(inventory) {
  const errors = [];
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) return ["inventory must be an object"];
  const expectedTopKeys = [
    "$schema", "schema_version", "inventory_version", "repository", "captured_at_utc",
    "source_main_commit", "issue_range", "canonical_digest", "issues",
  ].sort();
  if (!exactKeys(inventory, expectedTopKeys)) errors.push("inventory top-level keys differ from the closed v1 schema");
  if (inventory.$schema !== "./issue-inventory.schema.json") errors.push("inventory.$schema must reference ./issue-inventory.schema.json");
  if (inventory.schema_version !== 1) errors.push("inventory.schema_version must be 1");
  if (inventory.inventory_version !== "program-issue-inventory.v1") errors.push("inventory.inventory_version must be program-issue-inventory.v1");
  if (inventory.repository !== "Valeron2206/autosk-traycer-flow") errors.push("inventory repository mismatch");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(inventory.captured_at_utc ?? "")) errors.push("inventory captured_at_utc must be an exact UTC timestamp");
  if (!/^[0-9a-f]{40}$/u.test(inventory.source_main_commit ?? "")) errors.push("inventory source_main_commit must be a lowercase 40-hex commit");
  if (!exactKeys(inventory.issue_range, ["from", "to"])) errors.push("inventory issue_range keys differ from the closed v1 schema");
  if (inventory.issue_range?.from !== ISSUE_MIN || inventory.issue_range?.to !== ISSUE_MAX) errors.push("inventory issue_range must be #3–#39");
  if (!Array.isArray(inventory.issues) || inventory.issues.length !== ISSUE_COUNT) {
    errors.push(`inventory must contain exactly ${ISSUE_COUNT} issue records`);
    return errors;
  }

  const numbers = [];
  for (const [index, issue] of inventory.issues.entries()) {
    const prefix = `inventory.issues[${index}]`;
    if (!exactKeys(issue, ["issue_number", "github_node_id", "entity_kind", "issue_title", "priority"].sort())) errors.push(`${prefix} must use the closed issue snapshot shape`);
    if (!Number.isInteger(issue.issue_number) || issue.issue_number < ISSUE_MIN || issue.issue_number > ISSUE_MAX) errors.push(`${prefix}.issue_number is outside #3–#39`);
    else numbers.push(issue.issue_number);
    if (!nonEmpty(issue.issue_title)) errors.push(`${prefix}.issue_title must be non-empty`);
    if (!PRIORITIES.has(issue.priority)) errors.push(`${prefix}.priority is invalid`);
    if (issue.entity_kind !== "issue") errors.push(`${prefix}.entity_kind must be issue`);
    if (!/^I_[A-Za-z0-9_-]+$/u.test(issue.github_node_id ?? "")) errors.push(`${prefix}.github_node_id must identify a GitHub issue`);
    const titlePriority = priorityFromTitle(issue.issue_title);
    if (titlePriority !== issue.priority) errors.push(`${prefix}.priority does not match title`);
  }

  const actual = sorted(new Set(numbers));
  const expected = issueRange();
  if (actual.length !== numbers.length) errors.push("inventory contains duplicate issue numbers");
  if (actual.length !== expected.length || actual.some((number, index) => number !== expected[index])) errors.push("inventory must cover exactly issues #3–#39");
  const expectedDigest = digestInventory(inventory);
  if (inventory.canonical_digest !== expectedDigest) errors.push(`inventory canonical_digest mismatch: expected ${expectedDigest}`);
  return errors;
}

export function deriveParityIdsByIssue(parityRegistry) {
  const result = new Map(issueRange().map((number) => [number, []]));
  const errors = [];
  if (!Array.isArray(parityRegistry?.sources)) return { byIssue: result, errors: ["source parity registry.sources must be an array"] };
  const sourceIds = new Set();
  for (const [index, source] of parityRegistry.sources.entries()) {
    const prefix = `parity.sources[${index}]`;
    if (!nonEmpty(source?.id)) {
      errors.push(`${prefix}.id must be non-empty`);
      continue;
    }
    if (sourceIds.has(source.id)) errors.push(`${prefix}.id duplicates ${source.id}`);
    sourceIds.add(source.id);
    const issueRefs = source?.autoskTarget?.issueRefs;
    if (!Array.isArray(issueRefs)) {
      errors.push(`${source.id}.autoskTarget.issueRefs must be an array`);
      continue;
    }
    for (const issueNumber of issueRefs) {
      if (!result.has(issueNumber)) errors.push(`${source.id} references issue #${issueNumber} outside #3–#39`);
      else result.get(issueNumber).push(source.id);
    }
  }
  for (const [issueNumber, ids] of result) result.set(issueNumber, sorted(new Set(ids)));
  return { byIssue: result, errors };
}

function validateIssueRefs(value, prefix, errors, self) {
  if (!Array.isArray(value)) {
    errors.push(`${prefix} must be an array`);
    return [];
  }
  const seen = new Set();
  for (const item of value) {
    if (!Number.isInteger(item) || item < ISSUE_MIN || item > ISSUE_MAX) errors.push(`${prefix} contains out-of-range issue ${String(item)}`);
    if (item === self) errors.push(`${prefix} cannot contain self #${self}`);
    if (seen.has(item)) errors.push(`${prefix} contains duplicate #${item}`);
    seen.add(item);
  }
  const normalized = sorted(seen);
  if (value.length === normalized.length && value.some((item, index) => item !== normalized[index])) errors.push(`${prefix} must be sorted ascending`);
  return normalized;
}

function findDependencyCycle(recordsByNumber) {
  const state = new Map();
  const stack = [];
  let found = null;

  function visit(number) {
    if (found) return;
    const current = state.get(number) ?? 0;
    if (current === 1) {
      const start = stack.indexOf(number);
      found = [...stack.slice(start), number];
      return;
    }
    if (current === 2) return;
    state.set(number, 1);
    stack.push(number);
    for (const dependency of recordsByNumber.get(number)?.dependencies ?? []) visit(dependency);
    stack.pop();
    state.set(number, 2);
  }

  for (const number of sorted(recordsByNumber.keys())) visit(number);
  return found;
}

function validateRequiredEdges(recordsByNumber, errors) {
  const requires = (issue, dependencies) => {
    const actual = new Set(recordsByNumber.get(issue)?.dependencies ?? []);
    for (const dependency of dependencies) {
      if (!actual.has(dependency)) errors.push(`issue #${issue} must depend on #${dependency} by the canonical roadmap`);
    }
  };
  requires(6, [5]);
  requires(7, [5, 6]);
  requires(8, [7]);
  requires(9, [8, 17]);
  // The preflight primitives' consumers (ADR-092): the final CAS reconciles
  // ADR-023's authority heads and admits ADR-025's gate-result receipts, and
  // the doctor's signer check passes only on #4's signer.
  requires(9, [4, 18]);
  // The dispatch gate holds each workflow #18's entry point registers to its
  // required set before its first agent step, and its call before each model
  // launch sits in #18's launch path. The edge the other way, #18 → #34, is a
  // cycle: #34's doctor checks the provider, clearance and evidence state that
  // #19, #20, #26 and #27 build on #18. So #18 carries the call, which keeps
  // any launch from shipping without the gate, and #34 comes after it
  // (ADR-102, round 8 of #39, R8-14).
  requires(34, [4, 18]);
  // The graph's guard authority evaluator lets a human or policy transition
  // through only on the authority #4's signer and verifier establish, and the
  // extension entry point calls #11's capability preflight at load and creates
  // children through its `task.create_bound` (ADR-097).
  requires(18, [4, 11]);
  // #4's daemon side ships in the pinned patch series whose identity #10 locks.
  requires(4, [10]);
  requires(19, [37]);
  requires(20, [19]);
  requires(26, [20]);
  requires(36, [39]);
  const designInputs = Array.from({ length: 16 }, (_, index) => index + 3); // #3–#18
  requires(39, designInputs);
  if (recordsByNumber.get(39)?.dependencies?.includes(36)) errors.push("issue #39 must not depend on runtime completion of #36; only its design contract is required");
}

export function validateMatrix(matrix, inventory, parityRegistry, graph = parseJson(GRAPH_PATH)) {
  const errors = [];
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) return ["matrix must be an object"];
  const expectedTopKeys = [
    "$schema", "schema_version", "matrix_version", "repository", "issue_range",
    "source_main_commit", "issue_inventory_path", "issue_inventory_digest",
    "source_parity_registry_path", "classification_policy", "summary", "records",
    "preflight_primitives", "enforcement_points", "predicate_domains", "canonical_digest",
  ].sort();
  if (!exactKeys(matrix, expectedTopKeys)) errors.push("matrix top-level keys differ from the closed v1 schema");
  if (matrix.$schema !== "./matrix.schema.json") errors.push("matrix.$schema must reference ./matrix.schema.json");
  if (matrix.schema_version !== 1) errors.push("matrix.schema_version must be 1");
  if (matrix.matrix_version !== "program-capability-matrix.v1") errors.push("matrix.matrix_version must be program-capability-matrix.v1");
  if (matrix.repository !== inventory.repository) errors.push("matrix repository must match issue inventory");
  if (!exactKeys(matrix.issue_range, ["from", "to"])) errors.push("matrix issue_range keys differ from the closed v1 schema");
  if (matrix.issue_range?.from !== ISSUE_MIN || matrix.issue_range?.to !== ISSUE_MAX) errors.push("matrix issue_range must be #3–#39");
  if (matrix.source_main_commit !== inventory.source_main_commit) errors.push("matrix source_main_commit must match issue inventory");
  if (matrix.issue_inventory_path !== "resources/program-capabilities/issue-inventory.v1.json") errors.push("matrix issue_inventory_path is not canonical");
  if (matrix.source_parity_registry_path !== "resources/traycer-parity/registry.v1.json") errors.push("matrix source_parity_registry_path is not canonical");
  if (matrix.issue_inventory_digest !== inventory.canonical_digest) errors.push("matrix issue_inventory_digest does not match inventory");
  if (!matrix.classification_policy || typeof matrix.classification_policy !== "object") errors.push("matrix classification_policy must be an object");
  else {
    if (!exactKeys(matrix.classification_policy, ["required_for_v1", "planned_after_v1", "intentionally_deferred", "full_program_rule", "evolution_rule"].sort())) {
      errors.push("matrix classification_policy keys differ from the closed v1 schema");
    }
    for (const key of ["required_for_v1", "planned_after_v1", "intentionally_deferred", "full_program_rule", "evolution_rule"]) {
      if (!nonEmpty(matrix.classification_policy[key], 20)) errors.push(`classification_policy.${key} must be explicit`);
    }
  }
  if (!Array.isArray(matrix.records) || matrix.records.length !== ISSUE_COUNT) {
    errors.push(`matrix must contain exactly ${ISSUE_COUNT} records`);
    return errors;
  }
  if (!Array.isArray(inventory?.issues)) {
    errors.push("inventory issues must be an array before matrix validation");
    return errors;
  }

  const inventoryByNumber = new Map(inventory.issues.map((issue) => [issue.issue_number, issue]));
  const parity = deriveParityIdsByIssue(parityRegistry);
  errors.push(...parity.errors);
  const recordsByNumber = new Map();
  const numbers = [];
  const validRecords = [];

  for (const [index, record] of matrix.records.entries()) {
    const prefix = `records[${index}]`;
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    validRecords.push(record);
    if (!exactKeys(record, RECORD_KEYS)) errors.push(`${prefix} keys differ from the closed v1 record shape`);
    const number = record.issue_number;
    if (!Number.isInteger(number) || number < ISSUE_MIN || number > ISSUE_MAX) errors.push(`${prefix}.issue_number is outside #3–#39`);
    else {
      numbers.push(number);
      if (recordsByNumber.has(number)) errors.push(`${prefix}.issue_number duplicates #${number}`);
      recordsByNumber.set(number, record);
    }
    const snapshot = inventoryByNumber.get(number);
    if (!snapshot) errors.push(`${prefix} has no pinned issue inventory record`);
    else {
      if (record.issue_title !== snapshot.issue_title) errors.push(`${prefix}.issue_title is stale for #${number}`);
      if (record.priority !== snapshot.priority) errors.push(`${prefix}.priority is stale for #${number}`);
    }

    if (!PRIORITIES.has(record.priority)) errors.push(`${prefix}.priority is invalid`);
    if (!LIFECYCLES.has(record.lifecycle)) errors.push(`${prefix}.lifecycle is invalid`);
    if (!MILESTONES.has(record.target_milestone)) errors.push(`${prefix}.target_milestone is invalid`);
    if (!GATE_ROLES.has(record.gate_role)) errors.push(`${prefix}.gate_role is invalid`);
    const textMinimums = {
      rationale: 30,
      classification_risk: 30,
      owner: 3,
      activation_trigger: 20,
      design_obligation_before_issue_39: 20,
      implementation_obligation_before_mvp: 20,
      verification_expectation: 20,
    };
    for (const [field, minimum] of Object.entries(textMinimums)) {
      if (!nonEmpty(record[field], minimum)) errors.push(`${prefix}.${field} must contain at least ${minimum} characters`);
    }
    if (typeof record.release_blocking !== "boolean") errors.push(`${prefix}.release_blocking must be boolean`);
    if (record.full_program_required !== true) errors.push(`${prefix}.full_program_required must be true`);
    const dependencies = validateIssueRefs(record.dependencies, `${prefix}.dependencies`, errors, number);
    const blockers = validateIssueRefs(record.downstream_blockers, `${prefix}.downstream_blockers`, errors, number);
    if (!Array.isArray(record.source_parity_ids) || record.source_parity_ids.some((id) => !nonEmpty(id))) errors.push(`${prefix}.source_parity_ids must be a string array`);
    else {
      const unique = sorted(new Set(record.source_parity_ids));
      if (unique.length !== record.source_parity_ids.length) errors.push(`${prefix}.source_parity_ids contains duplicates`);
      if (unique.some((id, itemIndex) => id !== record.source_parity_ids[itemIndex])) errors.push(`${prefix}.source_parity_ids must be sorted`);
      const expectedIds = parity.byIssue.get(number) ?? [];
      if (unique.length !== expectedIds.length || unique.some((id, itemIndex) => id !== expectedIds[itemIndex])) {
        errors.push(`${prefix}.source_parity_ids differs from registry issueRefs for #${number}`);
      }
    }
    if (record.supersession_or_split !== null && !nonEmpty(record.supersession_or_split)) errors.push(`${prefix}.supersession_or_split must be null or non-empty`);
    if (record.decision_reference !== null && !nonEmpty(record.decision_reference)) errors.push(`${prefix}.decision_reference must be null or non-empty`);

    if (record.priority === "P0" && record.lifecycle !== "required_for_v1") errors.push(`${prefix}: P0 issue #${number} cannot be moved after v1 without a new explicit reviewed policy`);
    if (record.lifecycle === "required_for_v1") {
      if (record.release_blocking !== true) errors.push(`${prefix}: required_for_v1 must be release_blocking`);
      if (!["phase_0_complete", "design_ready", "autonomous_mvp"].includes(record.target_milestone)) errors.push(`${prefix}: required_for_v1 target milestone is invalid`);
      if (!["phase_0_gate", "design_and_mvp_input", "design_gate", "mvp_release_gate"].includes(record.gate_role)) {
        errors.push(`${prefix}: required_for_v1 gate_role cannot be post_v1_capability`);
      }
    }
    if (record.lifecycle === "planned_after_v1") {
      if (record.release_blocking !== false) errors.push(`${prefix}: planned_after_v1 must not block the v1 release`);
      if (record.target_milestone !== "full_parity_post_v1") errors.push(`${prefix}: planned_after_v1 target must be full_parity_post_v1`);
      if (record.gate_role !== "post_v1_capability") errors.push(`${prefix}: planned_after_v1 gate_role must be post_v1_capability`);
      if (record.decision_reference !== null) errors.push(`${prefix}: planned_after_v1 is scheduled work, not an intentional-defer decision`);
      if (!record.activation_trigger.startsWith("Begin after issue #36 closes")) {
        errors.push(`${prefix}: planned_after_v1 activation must start only after issue #36 closes`);
      }
      if (/\b(?:earlier|before)\b/iu.test(record.activation_trigger)) {
        errors.push(`${prefix}: planned_after_v1 activation must not contain a pre-MVP escape`);
      }
    }
    if (record.lifecycle === "intentionally_deferred") {
      if (record.release_blocking !== false || record.target_milestone !== "deferred") errors.push(`${prefix}: intentionally_deferred must be non-blocking with target=deferred`);
      if (!nonEmpty(record.decision_reference)) errors.push(`${prefix}: intentionally_deferred requires an immutable user/external decision reference`);
    }

    for (const forbidden of ["state", "closed", "merged", "current_pr", "current_commit", "progress_percent"]) {
      if (forbidden in record) errors.push(`${prefix}.${forbidden} is forbidden; the matrix is classification, not live task state`);
    }
    void dependencies;
    void blockers;
  }

  const actualNumbers = sorted(new Set(numbers));
  const expectedNumbers = issueRange();
  if (actualNumbers.length !== expectedNumbers.length || actualNumbers.some((number, index) => number !== expectedNumbers[index])) {
    errors.push("matrix must cover exactly issues #3–#39; #40/#43 and pull requests are excluded");
  }

  const cycle = findDependencyCycle(recordsByNumber);
  if (cycle) errors.push(`dependency cycle: ${cycle.map((number) => `#${number}`).join(" -> ")}`);

  const derivedReverse = new Map(issueRange().map((number) => [number, []]));
  for (const [number, record] of recordsByNumber) {
    if (!Array.isArray(record.dependencies)) continue;
    for (const dependency of record.dependencies) derivedReverse.get(dependency)?.push(number);
  }
  for (const [number, record] of recordsByNumber) {
    if (!Array.isArray(record.downstream_blockers)) continue;
    const expectedBlockers = sorted(derivedReverse.get(number) ?? []);
    if (record.downstream_blockers.length !== expectedBlockers.length ||
        record.downstream_blockers.some((item, index) => item !== expectedBlockers[index])) {
      errors.push(`issue #${number} downstream_blockers is not the exact reverse dependency projection`);
    }
  }

  validateRequiredEdges(recordsByNumber, errors);

  const actualPostV1 = sorted(validRecords.filter((record) => record.lifecycle === "planned_after_v1").map((record) => record.issue_number));
  if (actualPostV1.length !== POST_V1_ISSUES.length || actualPostV1.some((number, index) => number !== POST_V1_ISSUES[index])) {
    errors.push(`planned_after_v1 set must be exactly ${POST_V1_ISSUES.map((number) => `#${number}`).join(", ")} for matrix v1`);
  }
  if (validRecords.some((record) => record.lifecycle === "intentionally_deferred")) {
    errors.push("matrix v1 intentionally defers no program issue; add a reviewed decision before using intentionally_deferred");
  }

  const gateExpectations = new Map([
    [3, ["phase_0_gate", "phase_0_complete"]],
    [36, ["mvp_release_gate", "autonomous_mvp"]],
    [39, ["design_gate", "design_ready"]],
  ]);
  for (const [number, [role, milestone]] of gateExpectations) {
    const record = recordsByNumber.get(number);
    if (record?.gate_role !== role || record?.target_milestone !== milestone || record?.lifecycle !== "required_for_v1") {
      errors.push(`issue #${number} must be required_for_v1 with gate_role=${role} and target=${milestone}`);
    }
  }

  const expectedSummary = {
    required_for_v1: validRecords.filter((record) => record.lifecycle === "required_for_v1").length,
    planned_after_v1: validRecords.filter((record) => record.lifecycle === "planned_after_v1").length,
    intentionally_deferred: validRecords.filter((record) => record.lifecycle === "intentionally_deferred").length,
    release_blocking: validRecords.filter((record) => record.release_blocking === true).length,
  };
  if (canonicalStringify(matrix.summary) !== canonicalStringify(expectedSummary)) errors.push("matrix summary does not match records");
  if (expectedSummary.required_for_v1 !== 31 || expectedSummary.planned_after_v1 !== 6 || expectedSummary.intentionally_deferred !== 0) {
    errors.push("matrix v1 totals must be 31 required_for_v1, 6 planned_after_v1, 0 intentionally_deferred");
  }

  const lifecycleByIssue = new Map(validRecords.map((record) => [record.issue_number, record.lifecycle]));
  for (const source of parityRegistry.sources ?? []) {
    const issueRefs = source?.autoskTarget?.issueRefs ?? [];
    if (source.classification === "post_v1") {
      for (const issueNumber of issueRefs) {
        if (lifecycleByIssue.get(issueNumber) !== "planned_after_v1") errors.push(`${source.id} is post_v1 but targets non-post-v1 issue #${issueNumber}`);
      }
    }
    if (source.classification === "v1") {
      for (const issueNumber of issueRefs) {
        if (lifecycleByIssue.get(issueNumber) === "planned_after_v1") errors.push(`${source.id} is v1 but targets planned_after_v1 issue #${issueNumber}`);
      }
    }
  }

  validatePreflightPrimitives(matrix.preflight_primitives, recordsByNumber, errors);
  validateEnforcementPoints(matrix.enforcement_points, recordsByNumber, errors, enforcementRequirements(graph));
  validatePredicateDomains(matrix.predicate_domains, recordsByNumber, errors, predicateDomainRequirements(graph));

  const expectedDigest = digestMatrix(matrix);
  if (matrix.canonical_digest !== expectedDigest) errors.push(`matrix canonical_digest mismatch: expected ${expectedDigest}`);
  return errors;
}

const PRIMITIVE_KEYS = Object.freeze(["capability", "decision", "delivery", "elements", "owner_issues", "requirement"]);
const PRIMITIVE_KINDS = new Set(["daemon_capability", "model_step_check"]);

/**
 * The decision behind each requirement the preflight source does not tag with
 * one: the pinned capability is ADR-014's, the model-step checks ADR-090's
 * (the signer boundary), ADR-097's (the daemon's capabilities) and ADR-102's
 * (the model account). A
 * requirement added to the preflight without an entry here has no decision,
 * and the matrix entry naming it is refused until one is recorded.
 */
const PINNED_DECISIONS = Object.freeze({
  "task.creation-binding": "ADR-014",
  "security.signer_boundary": "ADR-090",
  "daemon.capabilities_pinned": "ADR-097",
  "security.model_account": "ADR-102",
});

/**
 * What a v1 model workflow cannot start without, read from the preflight itself.
 *
 * Round 6 of #39 (R6-16, a1) found the preflight refusing every model workflow
 * without ADR-023's and ADR-025's daemon primitives while no `required_for_v1`
 * record carried their implementation: v1, as classified, could not be
 * completed. The requirement is therefore not restated here. It is the daemon
 * capabilities `requireDaemonCapabilities` demands and the checks the workflow
 * preflight adds to every workflow that runs a model step; a primitive added
 * to either is a primitive the matrix must give an owner.
 */
export function preflightRequirements() {
  const decisions = new Map([
    ...Object.entries(PINNED_DECISIONS),
    ...UNPINNED_DAEMON_PRIMITIVES.map((primitive) => [primitive.name, primitive.adr]),
  ]);
  return [
    ...REQUIRED_DAEMON_CAPABILITIES.map((want) => ({ capability: want.name, requirement: "daemon_capability", decision: decisions.get(want.name) ?? null })),
    ...MODEL_STEP_CHECKS.map((id) => ({ capability: id, requirement: "model_step_check", decision: decisions.get(id) ?? null })),
  ];
}

/**
 * Every preflight requirement is carried by some `required_for_v1` record, and
 * the matrix names nothing the preflight does not require. Each owner's
 * implementation obligation names the capability, so the prose that schedules
 * the work and the structure that is checked cannot say two things.
 */
export function validatePreflightPrimitives(primitives, recordsByNumber, errors, requirements = preflightRequirements()) {
  if (!Array.isArray(primitives)) {
    errors.push("matrix preflight_primitives must be an array naming who carries each preflight requirement");
    return;
  }
  const seen = new Map();
  const names = [];
  for (const [index, entry] of primitives.entries()) {
    const prefix = `preflight_primitives[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    if (!exactKeys(entry, PRIMITIVE_KEYS)) errors.push(`${prefix} keys differ from the closed v1 primitive shape`);
    if (typeof entry.capability !== "string" || !/^[a-z][a-z0-9_]*(?:[.-][a-z0-9_]+)*$/u.test(entry.capability)) {
      errors.push(`${prefix}.capability must be a capability or check name`);
      continue;
    }
    names.push(entry.capability);
    if (seen.has(entry.capability)) errors.push(`${prefix}: \`${entry.capability}\` is named twice`);
    else seen.set(entry.capability, entry);
    if (!PRIMITIVE_KINDS.has(entry.requirement)) errors.push(`${prefix}.requirement must be daemon_capability or model_step_check`);
    if (typeof entry.decision !== "string" || !/^ADR-\d{3}$/u.test(entry.decision)) errors.push(`${prefix}.decision must name an ADR`);
    if (!nonEmpty(entry.delivery, 20)) errors.push(`${prefix}.delivery must contain at least 20 characters`);
    validateOwnership(entry, entry.capability, prefix, recordsByNumber, errors);
  }
  const sortedNames = sorted(names);
  if (names.some((name, index) => name !== sortedNames[index])) errors.push("matrix preflight_primitives must be sorted by capability");
  const required = new Map(requirements.map((want) => [want.capability, want]));
  for (const want of requirements) {
    const entry = seen.get(want.capability);
    if (!entry) {
      errors.push(`\`${want.capability}\` is required by the v1 preflight and carried by no required_for_v1 record`);
      continue;
    }
    if (entry.requirement !== want.requirement) errors.push(`\`${want.capability}\` is a ${want.requirement} of the preflight, not a ${String(entry.requirement)}`);
    if (want.decision === null) errors.push(`\`${want.capability}\` has no recorded decision; add it to PINNED_DECISIONS`);
    else if (entry.decision !== want.decision) errors.push(`\`${want.capability}\` is the preflight's ${want.decision} primitive, not ${String(entry.decision)}`);
  }
  for (const name of seen.keys()) {
    if (!required.has(name)) errors.push(`\`${name}\` is not required by the v1 preflight; the matrix names only what it requires`);
  }
  // The reverse: a v1 record whose obligation claims a primitive is one of its
  // owners, so prose cannot schedule work the structure does not assign.
  validateReverseClaims(requirements.map((want) => want.capability), (name) => seen.get(name)?.owner_issues, recordsByNumber, errors);
}

/**
 * Who carries one entry, and which of its surfaces each carries.
 *
 * Every owner is a `required_for_v1` record whose implementation obligation
 * names the entry in backticks and owns at least one surface; every surface
 * has one owner among them, named verbatim in that owner's obligation, so the
 * line between two owners of one entry is drawn surface by surface. The
 * preflight's primitives and the graph's enforcement points answer "who
 * carries it" by this one rule.
 */
function validateOwnership(entry, name, prefix, recordsByNumber, errors) {
  const owners = validateIssueRefs(entry.owner_issues, `${prefix}.owner_issues`, errors, null);
  if (Array.isArray(entry.owner_issues) && entry.owner_issues.length === 0) errors.push(`${prefix}: \`${name}\` names no owner issue`);
  const surfaces = [];
  if (!Array.isArray(entry.elements)) errors.push(`${prefix}.elements must be a list of {surface, owner}`);
  else {
    for (const [at, element] of entry.elements.entries()) {
      if (!exactKeys(element, ["owner", "surface"]) || !nonEmpty(element.surface) || !Number.isInteger(element.owner)) {
        errors.push(`${prefix}.elements[${at}] must be a closed {surface, owner} object`);
        continue;
      }
      if (surfaces.some((seenSurface) => seenSurface.surface === element.surface)) errors.push(`${prefix}: surface "${element.surface}" is named twice`);
      surfaces.push(element);
      if (!owners.includes(element.owner)) {
        errors.push(`${prefix}: surface "${element.surface}" is owned by #${element.owner}, which is not among the owners of \`${name}\``);
        continue;
      }
      const text = recordsByNumber.get(element.owner)?.implementation_obligation_before_mvp;
      if (typeof text !== "string" || !text.includes(element.surface)) {
        errors.push(`${prefix}: surface "${element.surface}" of \`${name}\` is not named in #${element.owner}'s implementation_obligation_before_mvp`);
      }
    }
  }
  for (const issue of owners) {
    const record = recordsByNumber.get(issue);
    if (!record) continue;
    if (record.lifecycle !== "required_for_v1") {
      errors.push(`${prefix}: \`${name}\` is carried by #${issue}, which is ${record.lifecycle}, not required_for_v1`);
      continue;
    }
    if (typeof record.implementation_obligation_before_mvp !== "string" ||
        !record.implementation_obligation_before_mvp.includes(`\`${name}\``)) {
      errors.push(`#${issue} carries \`${name}\` but its implementation_obligation_before_mvp does not name it`);
    }
    if (!surfaces.some((element) => element.owner === issue)) errors.push(`#${issue} carries \`${name}\` but owns none of its surfaces`);
  }
}

/** A `required_for_v1` record whose obligation names an entry in backticks is among its owners. */
function validateReverseClaims(names, ownersOf, recordsByNumber, errors) {
  for (const name of names) {
    const owners = ownersOf(name);
    for (const [issue, record] of recordsByNumber) {
      if (record.lifecycle !== "required_for_v1" || typeof record.implementation_obligation_before_mvp !== "string") continue;
      if (!record.implementation_obligation_before_mvp.includes(`\`${name}\``)) continue;
      if (!Array.isArray(owners) || !owners.includes(issue)) {
        errors.push(`#${issue} names \`${name}\` in its implementation obligation but is not among its owners`);
      }
    }
  }
}

const ENFORCEMENT_KEYS = Object.freeze(["decision", "delivery", "elements", "owner_issues", "point", "source"]);
const ENFORCEMENT_SOURCES = new Set(["graph_guard_authority", "graph_predicates", "graph_workflows"]);
const asList = (value) => (Array.isArray(value) ? value : []);

/** The names of the workflows a graph registers, and of the Arena ones among them. */
const workflowNames = (graph) => asList(graph.workflows).map((workflow) => workflow?.name).filter((name) => typeof name === "string");
export const ARENA_WORKFLOW_PREFIX = "autosk-arena-";
export const ARENA_RUNTIME_POINT = "graph.arena-runtime";
const arenaWorkflows = (graph) => workflowNames(graph).filter((name) => name.startsWith(ARENA_WORKFLOW_PREFIX));

/**
 * What only product code can enforce in the workflow graph, the field each is
 * read from, and the decision it rests on.
 *
 * Round 7 of #39 (R7-10) found that no product code evaluates the graph's
 * predicates or its `guards[].authority`, and that no extension entry point
 * registers its workflows: every `buildWorkflow` caller is a verification
 * script, and the evaluator was left to #40, outside the #3–#39 inventory.
 * A graph that enumerates predicates needs something that decides them
 * (ADR-082); one whose guards name a human or a policy actor needs something
 * that admits that authority only as ADR-091 allows; one that registers
 * workflows needs something that builds and registers each of them (ADR-090);
 * one that registers Arena's workflows needs Arena's runtime, which its
 * contract decides (ADR-077). A point whose owner must name workflows carries
 * `workflowsOf` and says what the owner does with them.
 */
const ENFORCEMENT_POINTS = Object.freeze([
  Object.freeze({
    point: ARENA_RUNTIME_POINT,
    source: "graph_workflows",
    decision: "ADR-077",
    requiredBy: (graph) => arenaWorkflows(graph).length > 0,
    workflowsOf: arenaWorkflows,
    claim: "runs the graph's Arena workflows",
  }),
  Object.freeze({
    point: "graph.guard-authority",
    source: "graph_guard_authority",
    decision: "ADR-091",
    requiredBy: (graph) => asList(graph.guards).some((guard) => ["human", "policy"].includes(guard?.authority?.actor)),
  }),
  Object.freeze({
    point: "graph.predicate-evaluation",
    source: "graph_predicates",
    decision: "ADR-082",
    requiredBy: (graph) => asList(graph.predicates).length > 0,
  }),
  Object.freeze({
    point: "graph.workflow-registration",
    source: "graph_workflows",
    decision: "ADR-090",
    requiredBy: (graph) => workflowNames(graph).length > 0,
    workflowsOf: workflowNames,
    claim: "registers the graph's workflows",
  }),
]);

/**
 * The enforcement points a graph requires, read from the graph itself: a point
 * whose field the graph leaves empty is not required, and a point whose owner
 * must name workflows carries their names.
 */
export function enforcementRequirements(graph) {
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) return [];
  return ENFORCEMENT_POINTS.filter((entry) => entry.requiredBy(graph)).map(({ point, source, decision, workflowsOf, claim }) => (
    workflowsOf ? { point, source, decision, workflows: workflowsOf(graph), claim } : { point, source, decision }
  ));
}

/**
 * Every enforcement point the v1 graph requires is carried by some
 * `required_for_v1` record, by the rule the preflight's primitives follow, and
 * the matrix names no point the graph does not require. The owner of the
 * registration point names every workflow the graph registers, so a workflow
 * added to the graph has an owner before the matrix validates again (ADR-097).
 */
export function validateEnforcementPoints(points, recordsByNumber, errors, requirements) {
  if (!Array.isArray(points)) {
    errors.push("matrix enforcement_points must be an array naming who carries each point the v1 graph requires");
    return;
  }
  const seen = new Map();
  const names = [];
  for (const [index, entry] of points.entries()) {
    const prefix = `enforcement_points[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    if (!exactKeys(entry, ENFORCEMENT_KEYS)) errors.push(`${prefix} keys differ from the closed v1 enforcement point shape`);
    if (typeof entry.point !== "string" || !/^graph\.[a-z]+(?:-[a-z]+)*$/u.test(entry.point)) {
      errors.push(`${prefix}.point must name an enforcement point of the graph`);
      continue;
    }
    names.push(entry.point);
    if (seen.has(entry.point)) errors.push(`${prefix}: \`${entry.point}\` is named twice`);
    else seen.set(entry.point, entry);
    if (!ENFORCEMENT_SOURCES.has(entry.source)) errors.push(`${prefix}.source must be graph_guard_authority, graph_predicates or graph_workflows`);
    if (typeof entry.decision !== "string" || !/^ADR-\d{3}$/u.test(entry.decision)) errors.push(`${prefix}.decision must name an ADR`);
    if (!nonEmpty(entry.delivery, 20)) errors.push(`${prefix}.delivery must contain at least 20 characters`);
    validateOwnership(entry, entry.point, prefix, recordsByNumber, errors);
  }
  const sortedNames = sorted(names);
  if (names.some((name, index) => name !== sortedNames[index])) errors.push("matrix enforcement_points must be sorted by point");
  const required = new Map(requirements.map((want) => [want.point, want]));
  for (const want of requirements) {
    const entry = seen.get(want.point);
    if (!entry) {
      errors.push(`\`${want.point}\` is required by the v1 graph and carried by no required_for_v1 record`);
      continue;
    }
    if (entry.source !== want.source) errors.push(`\`${want.point}\` is read from ${want.source}, not ${String(entry.source)}`);
    if (entry.decision !== want.decision) errors.push(`\`${want.point}\` is the graph's ${want.decision} enforcement point, not ${String(entry.decision)}`);
    for (const issue of want.workflows ? asList(entry.owner_issues) : []) {
      const text = recordsByNumber.get(issue)?.implementation_obligation_before_mvp;
      if (typeof text !== "string") continue;
      for (const workflow of want.workflows) {
        if (!text.includes(`\`${workflow}\``)) {
          errors.push(`#${issue} ${want.claim} but its implementation_obligation_before_mvp does not name \`${workflow}\``);
        }
      }
    }
  }
  for (const name of seen.keys()) {
    if (!required.has(name)) errors.push(`\`${name}\` is not required by the v1 graph; the matrix names only what it requires`);
  }
  validateReverseClaims(requirements.map((want) => want.point), (name) => seen.get(name)?.owner_issues, recordsByNumber, errors);
}

const DOMAIN_KEYS = Object.freeze(["decision", "delivery", "domain", "elements", "owner_issues"]);
const DOMAIN_ID = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
export const PREDICATE_DOMAIN_DECISION = "ADR-107";
const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The owners a graph's predicates need, read from the graph itself.
 *
 * Round 8 of #39 (R8-8) found the meaning of the graph's 433 predicates left
 * to an unmapped "domain record": no predicate carried an owner, and the one
 * check matched three example sentences, so the evaluator's table could bind
 * `cond_001`'s "classification is valid" to a stub while `validate:capabilities`
 * stayed green. The state facts a predicate reads are not a partition
 * (`task_record` is read by 175 predicates and means something else in each),
 * so each predicate names the domain whose owner decides it, and the
 * requirement is the set of domains the graph uses. A predicate that names none
 * is unowned. `predicates` counts the readers of a domain, for the message.
 */
export function predicateDomainRequirements(graph) {
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) return { domains: [], unowned: [], collisions: [] };
  const counts = new Map();
  const unowned = [];
  const facts = graphNames(graph);
  for (const predicate of asList(graph.predicates)) {
    if (typeof predicate?.domain === "string" && DOMAIN_ID.test(predicate.domain)) counts.set(predicate.domain, (counts.get(predicate.domain) ?? 0) + 1);
    else unowned.push(String(predicate?.id));
  }
  const domains = sorted(counts.keys());
  return { domains: domains.map((domain) => ({ domain, predicates: counts.get(domain) })), unowned, collisions: domains.filter((domain) => facts.has(domain)) };
}

/**
 * Every name the graph declares: steps and their no-transition reasons,
 * workflows, entry steps, the facts predicates read, park and recovery reasons,
 * caps and their reasons, decision options and the graph-level codes. A domain
 * is named by a token none of them carries, so a backticked mention of a step,
 * a fact or a reason in an obligation is never read as a claim on a domain
 * (narrow re-review of 12f, L2).
 */
function graphNames(graph) {
  const names = new Set();
  const add = (value) => { if (typeof value === "string") names.add(value); };
  for (const step of asList(graph.steps)) { add(step?.name); add(step?.no_transition_reason); }
  for (const workflow of asList(graph.workflows)) { add(workflow?.name); add(workflow?.first_step); }
  for (const entry of asList(graph.entry_steps)) add(entry?.step);
  for (const predicate of asList(graph.predicates)) for (const fact of asList(predicate?.reads)) add(fact);
  for (const guard of asList(graph.guards)) add(guard?.park_reason);
  for (const row of asList(graph.recovery)) add(row?.reason);
  for (const cap of asList(graph.caps)) { add(cap?.cycle); add(cap?.park_reason); }
  for (const option of asList(graph.decision_options)) add(option);
  if (graph.graph_reasons && typeof graph.graph_reasons === "object") for (const value of Object.values(graph.graph_reasons)) add(value);
  return names;
}

/**
 * The one sentence an owner's obligation carries for the domains it owns: each
 * domain's name and its `delivery`, sorted by domain. The obligation is held to
 * this text, so a negated or unrelated mention of a domain cannot stand for the
 * claim, and a delivery that changes without the obligation is drift (review of
 * 12f, L4).
 */
export function ownershipSentence(entries) {
  const clauses = [...entries].sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0))
    .map((entry) => `meaning of the \`${entry.domain}\` predicates: ${entry.delivery}`);
  return `Owns predicate meaning (ADR-107): ${clauses.join("; ")}.`;
}

/** The phrases that claim a domain: "the `x` predicates", "every `x` predicate", "the predicates of `x`" and "the domain `x`". */
const DOMAIN_CLAIMS = /`([a-z][a-z0-9_]*)` predicates?|predicates of `([a-z][a-z0-9_]*)`|domain `([a-z][a-z0-9_]*)`/gu;
const OWNERSHIP_LEAD = "Owns predicate meaning (ADR-107)";

/**
 * Every predicate of the v1 graph has an owner: the domain it names is carried
 * by one `required_for_v1` record whose implementation obligation names the
 * domain, by the rule the preflight's primitives and the enforcement points
 * follow, and the matrix names no domain the graph does not use.
 *
 * The graph registers only v1 workflows (ADR-090), so every predicate of it is
 * a v1 predicate and a post-v1 owner is refused; a graph that carried a
 * post-v1 workflow's predicates would need a rule for them, and this one does
 * not invent it. An owner outside #3–#39 is refused by the issue range, and a
 * domain has exactly one owner: two would leave the predicate's decision with
 * neither. #18 keeps the mechanism (`graph.predicate-evaluation`, the table
 * from each predicate id to its implementation), never the meaning of the
 * predicates of a domain another record owns (ADR-097, ADR-107).
 */
export function validatePredicateDomains(entries, recordsByNumber, errors, requirements) {
  if (!Array.isArray(entries)) {
    errors.push("matrix predicate_domains must be an array naming who owns the meaning of each domain the v1 graph's predicates use");
    return;
  }
  const seen = new Map();
  const names = [];
  for (const [index, entry] of entries.entries()) {
    const prefix = `predicate_domains[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    if (!exactKeys(entry, DOMAIN_KEYS)) errors.push(`${prefix} keys differ from the closed v1 predicate domain shape`);
    if (typeof entry.domain !== "string" || !DOMAIN_ID.test(entry.domain)) {
      errors.push(`${prefix}.domain must name a domain of the graph's predicates`);
      continue;
    }
    names.push(entry.domain);
    if (seen.has(entry.domain)) errors.push(`${prefix}: \`${entry.domain}\` is named twice`);
    else seen.set(entry.domain, entry);
    if (entry.decision !== PREDICATE_DOMAIN_DECISION) errors.push(`${prefix}.decision must be ${PREDICATE_DOMAIN_DECISION}`);
    if (!nonEmpty(entry.delivery, 20)) errors.push(`${prefix}.delivery must contain at least 20 characters`);
    validateOwnership(entry, entry.domain, prefix, recordsByNumber, errors);
    if (asList(entry.owner_issues).length > 1) {
      errors.push(`${prefix}: \`${entry.domain}\` has ${asList(entry.owner_issues).length} owners; a predicate's meaning is one record's`);
    }
  }
  const sortedNames = sorted(names);
  if (names.some((name, index) => name !== sortedNames[index])) errors.push("matrix predicate_domains must be sorted by domain");
  // A delivery describes its domain: it is embedded in the owner's sentence, which
  // the claim scans skip, so it names no domain and claims none (narrow re-review
  // of 12f, L1).
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== "object" || typeof entry.delivery !== "string") continue;
    for (const name of sorted(seen.keys())) {
      if (entry.delivery.includes(`\`${name}\``)) errors.push(`predicate_domains[${index}].delivery names domain \`${name}\`; a delivery describes its domain and claims no domain`);
    }
    for (const match of entry.delivery.matchAll(DOMAIN_CLAIMS)) {
      const name = match[1] ?? match[2] ?? match[3];
      if (!seen.has(name)) errors.push(`predicate_domains[${index}].delivery claims the \`${name}\` predicates, and the matrix has no such domain`);
    }
  }
  const required = new Map(requirements.domains.map((want) => [want.domain, want]));
  for (const id of requirements.unowned) errors.push(`predicate \`${id}\` names no domain, so no record owns what it decides`);
  for (const want of requirements.domains) {
    if (!seen.has(want.domain)) {
      errors.push(`\`${want.domain}\` is read by ${plural(want.predicates, "predicate")} of the v1 graph and carried by no required_for_v1 record`);
    }
  }
  for (const name of seen.keys()) {
    if (!required.has(name)) errors.push(`\`${name}\` is not read by any predicate of the v1 graph; the matrix names only what it reads`);
  }
  for (const name of asList(requirements.collisions)) {
    errors.push(`domain \`${name}\` is also a name the graph declares; a domain is named by a token no graph name carries`);
  }
  validateDomainClaims(seen, recordsByNumber, errors);
}

/**
 * Where an owner's sentence stands: at the start of the obligation or after a
 * full stop, outside a quotation. -1 when no occurrence does, so a sentence
 * wrapped in a negation or quoted and disowned is not the owner's claim. A text
 * check cannot read intent: prose that disowns a domain without naming it ("none
 * of the above is this issue's") is beyond it, and the panel reads what a check
 * cannot.
 */
function sentenceStart(text, sentence) {
  for (let at = text.indexOf(sentence); at >= 0; at = text.indexOf(sentence, at + 1)) {
    const before = text.slice(0, at);
    const boundary = before === "" || /(?:\.|\n) $|\n$/u.test(before);
    const quotes = [...before.matchAll(/["\u201c\u201d]/gu)].length;
    if (boundary && quotes % 2 === 0) return at;
  }
  return -1;
}

/**
 * What every obligation says about the domains, held to one closed form.
 *
 * An owner carries the sentence `ownershipSentence` derives from its entries,
 * at a sentence boundary outside a quotation, once, and no obligation names a
 * domain anywhere else: a mention outside the sentence is a non-owner's claim,
 * or the owner's disowning or restating it, a record that owns no domain carries
 * no ownership sentence, and a claim phrase naming a domain the matrix does not
 * have is a stale claim
 * that a rename would otherwise leave standing. Every record is read, post-v1
 * ones included: only a `required_for_v1` record may own a domain, and none
 * may claim one it does not.
 */
function validateDomainClaims(seen, recordsByNumber, errors) {
  const names = new Set(seen.keys());
  const byOwner = new Map();
  for (const entry of seen.values()) {
    for (const issue of asList(entry.owner_issues)) byOwner.set(issue, [...(byOwner.get(issue) ?? []), entry]);
  }
  for (const [issue, record] of recordsByNumber) {
    if (typeof record.implementation_obligation_before_mvp !== "string") continue;
    let text = record.implementation_obligation_before_mvp;
    const owned = byOwner.get(issue);
    if (!owned && text.includes(OWNERSHIP_LEAD)) errors.push(`#${issue} carries an ownership sentence but owns no domain`);
    if (owned) {
      const sentence = ownershipSentence(owned);
      const at = sentenceStart(text, sentence);
      if (at >= 0) text = text.slice(0, at) + text.slice(at + sentence.length);
      else errors.push(`#${issue}'s implementation_obligation_before_mvp does not carry its ownership sentence for ${owned.map((entry) => `\`${entry.domain}\``).join(", ")}`);
    }
    for (const name of sorted(names)) {
      if (!text.includes(`\`${name}\``)) continue;
      errors.push(owned?.some((entry) => entry.domain === name)
        ? `#${issue} names \`${name}\` in its implementation obligation outside the ownership sentence that carries it`
        : `#${issue} names \`${name}\` in its implementation obligation but is not among its owners`);
    }
    for (const match of text.matchAll(DOMAIN_CLAIMS)) {
      const name = match[1] ?? match[2] ?? match[3];
      if (!names.has(name)) errors.push(`#${issue} claims the \`${name}\` predicates, and the matrix has no such domain`);
    }
  }
}

function mdEscape(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderDocumentation(matrix) {
  const required = matrix.records.filter((record) => record.lifecycle === "required_for_v1");
  const postV1 = matrix.records.filter((record) => record.lifecycle === "planned_after_v1");
  const deferred = matrix.records.filter((record) => record.lifecycle === "intentionally_deferred");
  const lines = [
    "# Матрица программных возможностей autosk-flow",
    "",
    "> Канонический источник — `resources/program-capabilities/matrix.v1.json`. Этот документ генерируется детерминированно и не является вторым roadmap или runtime-ledger.",
    "",
    "## Назначение",
    "",
    "Матрица классифицирует ровно GitHub issues #3–#39 по сроку обязательной реализации. Она отличается от Traycer parity registry: source registry отвечает, **что переносится**, а эта матрица — **к какой вехе обязан быть готов соответствующий program issue**.",
    "",
    "Состояние issue/PR здесь намеренно не хранится. Текущий progress остаётся в GitHub и roadmap #40.",
    "",
    "## Зафиксированная политика",
    "",
    `- **required_for_v1:** ${matrix.classification_policy.required_for_v1}`,
    `- **planned_after_v1:** ${matrix.classification_policy.planned_after_v1}`,
    `- **intentionally_deferred:** ${matrix.classification_policy.intentionally_deferred}`,
    `- **Полная программа:** ${matrix.classification_policy.full_program_rule}`,
    `- **Эволюция матрицы:** ${matrix.classification_policy.evolution_rule}`,
    "",
    "В source-parity registry диспозиция `intentionally_deferred` означает, что исходная возможность не активна в v1; её program-lifecycle эквивалент здесь — `planned_after_v1`. Только program capability matrix может освободить delivery obligation через собственный более строгий `intentionally_deferred`.",
    "",
    "## Итог",
    "",
    "| Класс | Количество | Значение |",
    "| --- | ---: | --- |",
    `| required_for_v1 | ${required.length} | Design disposition входит в #39; implementation/release obligation блокирует autonomous MVP. |`,
    `| planned_after_v1 | ${postV1.length} | Явно не входит в v1, но обязательно выполняется после #36 для полной программы. |`,
    `| intentionally_deferred | ${deferred.length} | В v1 отсутствует; такой статус потребует отдельного immutable решения. |`,
    `| release_blocking | ${matrix.summary.release_blocking} | Невыполненная обязанность запрещает autonomous MVP release. |`,
    "",
    "## Все program issues",
    "",
    "Поле `dependencies` задаёт implementation/execution ordering. Для design gate #39 predecessor edge означает наличие frozen design contract, а не завершённой implementation; обязанности до #39 задаются в `design_obligation_before_issue_39` каждой записи.",
    "",
    "| Issue | Priority | Lifecycle | Target | Gate role | Depends on | Release blocker | Full program |",
    "| ---: | :---: | --- | --- | --- | --- | :---: | :---: |",
  ];
  for (const record of matrix.records) {
    lines.push(`| #${record.issue_number} ${mdEscape(record.issue_title.replace(/^\[P[012]\](?:\[DESIGN GATE\])?\s*/u, ""))} | ${record.priority} | ${record.lifecycle} | ${record.target_milestone} | ${record.gate_role} | ${record.dependencies.length ? record.dependencies.map((number) => `#${number}`).join(", ") : "—"} | ${record.release_blocking ? "yes" : "no"} | ${record.full_program_required ? "yes" : "no"} |`);
  }

  lines.push(
    "",
    "## Примитивы, которых требует preflight",
    "",
    "Preflight отказывает любому model workflow без каждой из этих capabilities (`REQUIRED_DAEMON_CAPABILITIES` в `src/host/daemon-preflight.mjs`, `MODEL_STEP_CHECKS` в `src/host/workflow-preflight.mjs`). Поэтому каждую несёт хотя бы одна запись `required_for_v1`, и `implementation_obligation_before_mvp` каждой такой записи называет её; validator сверяет список с этими двумя наборами в обе стороны, а каждая поверхность принадлежит одному владельцу и названа в его обязательстве. Проверки фаз (`PHASE_CHECKS`) — проверки хоста, которые doctor реализует сам (#34), и этой таблицей не покрываются (ADR-092).",
    "",
    "| Capability | Kind | ADR | Carried by | Surfaces | Delivery |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  const list = (value) => (Array.isArray(value) ? value : []);
  const surface = (element) => (element && typeof element === "object" ? `${element.surface} (#${element.owner})` : String(element));
  const carriers = (entry) => list(entry.owner_issues).map((number) => `#${number}`).join(", ");
  for (const entry of list(matrix.preflight_primitives)) {
    if (!entry || typeof entry !== "object") continue;
    lines.push(`| \`${entry.capability}\` | ${entry.requirement} | ${entry.decision} | ${carriers(entry)} | ${mdEscape(list(entry.elements).map(surface).join("; "))} | ${mdEscape(entry.delivery)} |`);
  }

  lines.push(
    "",
    "## Точки исполнения, на которых стоит граф",
    "",
    "Граф workflow (`resources/workflow-graph/workflow-graph.v1.json`) объявляет то, что исполняет только продуктовый код: предикаты, которые кто-то должен вычислить, guards, чей `authority` называет человека или policy, workflows, которые кто-то должен собрать и зарегистрировать, и workflows Arena, чей runtime решает её контракт. `validate:capabilities` выводит эти точки из самого графа (`enforcementRequirements`) и держит их к матрице по тому же правилу, что примитивы preflight: каждую несёт запись `required_for_v1`, чьё `implementation_obligation_before_mvp` называет её и свои поверхности, запись, которая её называет, — среди владельцев, а владелец точки с workflows называет каждый из них; владелец runtime Arena — один и тот же в матрице, в строке статуса контракта Arena и в реестре parity (ADR-097). Смысл каждого предиката решает владелец его домена (раздел «Предикаты графа и их владельцы», ADR-107), а не владелец таблицы.",
    "",
    "| Point | Read from | ADR | Carried by | Surfaces | Delivery |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const entry of list(matrix.enforcement_points)) {
    if (!entry || typeof entry !== "object") continue;
    lines.push(`| \`${entry.point}\` | ${entry.source} | ${entry.decision} | ${carriers(entry)} | ${mdEscape(list(entry.elements).map(surface).join("; "))} | ${mdEscape(entry.delivery)} |`);
  }

  lines.push(
    "",
    "## Предикаты графа и их владельцы",
    "",
    "Каждый предикат графа называет `domain` (`resources/workflow-graph/workflow-graph.v1.json`); у домена один владелец — запись `required_for_v1`, чьё `implementation_obligation_before_mvp` называет домен и то, что он решает. `validate:capabilities` выводит домены из графа (`predicateDomainRequirements`): предикат без домена, домен без записи, запись без предиката и домен, чей владелец не `required_for_v1`, — ошибки. Таблицу от id предиката к реализации и места решения держит #18 (`graph.predicate-evaluation`); смысл предиката решает модуль владельца его домена (ADR-107).",
    "",
    "| Domain | Owner | ADR | Meaning |",
    "| --- | --- | --- | --- |",
  );
  for (const entry of list(matrix.predicate_domains)) {
    if (!entry || typeof entry !== "object") continue;
    lines.push(`| \`${entry.domain}\` | ${carriers(entry)} | ${entry.decision} | ${mdEscape(entry.delivery)} |`);
  }

  lines.push("", "## Planned after v1", "");
  for (const record of postV1) {
    lines.push(
      `### #${record.issue_number} — ${record.issue_title}`,
      "",
      `**Почему после v1:** ${record.rationale}`,
      "",
      `**Риск:** ${record.classification_risk}`,
      "",
      `**Условие активации:** ${record.activation_trigger}`,
      "",
      `**Обязанность до #39:** ${record.design_obligation_before_issue_39}`,
      "",
      `**Работа после MVP:** ${record.implementation_obligation_before_mvp}`,
      "",
    );
  }

  lines.push("## Намеренно отложенные", "");
  if (!deferred.length) {
    lines.push("В версии matrix.v1 нет `intentionally_deferred`: пользователь требует полную программу, поэтому расширенные capabilities запланированы после v1, а не сняты с обязательств.", "");
  } else {
    for (const record of deferred) lines.push(`- #${record.issue_number}: ${record.issue_title} — ${record.decision_reference}`);
    lines.push("");
  }

  lines.push(
    "## Ключевые gates",
    "",
    "- **#3 — Phase 0 gate:** source-level migration/parity inventory должен оставаться полным и проверяемым.",
    "- **#39 — Design gate:** implementation backlog создаётся только после нового four-model PASS одного exact candidate.",
    "- **#36 — MVP release gate:** clean-room E2E без Traycer должен пройти после всех `required_for_v1` implementation obligations.",
    "- После #36 программа продолжается по `planned_after_v1`; MVP и полный parity — разные вехи.",
    "",
    "## Проверка",
    "",
    "```bash",
    "npm test",
    "npm run validate:capabilities",
    "```",
    "",
    `Inventory digest: \`${matrix.issue_inventory_digest}\``,
    "",
    `Matrix digest: \`${matrix.canonical_digest}\``,
    "",
  );
  return `${lines.join("\n")}\n`;
}

export function validateDocumentation(matrix, documentation) {
  const expected = renderDocumentation(matrix);
  return documentation === expected ? [] : ["docs/program-capability-matrix.md is stale; regenerate with npm run generate:capabilities"];
}

export function validateReadme(matrix, readme) {
  if (typeof readme !== "string") return ["README.md is missing"];
  const errors = [];
  for (const [key, value] of [
    ["required_for_v1", matrix.summary.required_for_v1],
    ["planned_after_v1", matrix.summary.planned_after_v1],
    ["intentionally_deferred", matrix.summary.intentionally_deferred],
  ]) {
    if (!readme.includes(`\`${key}\`: ${value}`)) errors.push(`README ${key} total is stale`);
  }
  if (POST_V1_ISSUES.some((number) => !readme.includes(`(#${number})`))) {
    errors.push("README post-v1 issue set is stale");
  }
  return errors;
}

/** The README section that lists what the design package is made of. */
export const README_PACKAGE_HEADING = "## Состав пакета";

/**
 * README's package list points to every design contract, and to nothing that
 * is not one.
 *
 * Round 7 of #39 (R7-28) found the list naming 2 of the 42 contracts. The
 * list is read from its own section — a contract linked elsewhere in README is
 * not listed there — and held to the contracts this validator already reads
 * from `docs/contracts/`, both ways, so a contract added or removed there
 * changes what README must say (debt 11f, ADR-100).
 */
export function readmeContractErrors(readme, contracts) {
  if (typeof readme !== "string") return ["README.md is missing"];
  const start = readme.indexOf(`${README_PACKAGE_HEADING}\n`);
  if (start === -1) return [`README has no package list (${README_PACKAGE_HEADING})`];
  const end = readme.indexOf("\n## ", start + README_PACKAGE_HEADING.length);
  const section = readme.slice(start, end === -1 ? undefined : end);
  const listed = new Set([...section.matchAll(/\]\((docs\/contracts\/[^)\s]+\.md)\)/gu)].map((match) => match[1]));
  const present = new Set(asList(contracts).map((contract) => contract?.path).filter((entry) => typeof entry === "string"));
  const errors = [];
  for (const contractPath of [...present].sort()) {
    if (!listed.has(contractPath)) errors.push(`README package list omits ${contractPath}`);
  }
  for (const contractPath of [...listed].sort()) {
    if (!present.has(contractPath)) errors.push(`README package list names ${contractPath}, which is not a contract in docs/contracts/`);
  }
  return errors;
}

/** The lifecycle tokens a contract may state about its own runtime. */
const LIFECYCLE_TOKEN = /`(required_for_v1|planned_after_v1|intentionally_deferred)`/gu;

/** Every design contract, as repository-relative path and text. */
export function readContracts(directory = CONTRACTS_DIR) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({
      path: path.relative(ROOT, path.join(directory, name)).split(path.sep).join("/"),
      text: readFileSync(path.join(directory, name), "utf8"),
    }));
}

/**
 * A contract's own claim about when its runtime is required must be the matrix's.
 *
 * Round 5 of #39 (R5-10, R5-11) found five post-v1 contracts saying their runtime
 * "remains `required_for_v1`" while the matrix classifies them `planned_after_v1`,
 * and #47, outside the #3–#39 inventory, claiming `required_for_v1` with no
 * successor matrix: the one question the classification exists to settle, answered
 * two ways. The claim is read where a contract makes it — its `Status:` line and
 * its `Deferred and named:` lines — against the issue its status line names first.
 * An issue the matrix does not classify may not claim a lifecycle of this matrix.
 * Every issue the status line names is held to the claim, so a status naming two
 * issues of different lifecycles cannot state one of them; and a status naming no
 * issue at all may not state a lifecycle, rather than being skipped.
 */
export function validateContractStatuses(matrix, contracts) {
  const errors = [];
  const lifecycleOf = new Map((matrix?.records ?? []).map((record) => [record.issue_number, record.lifecycle]));
  for (const { path: contractPath, text } of contracts) {
    const lines = text.split("\n");
    const status = lines.find((line) => line.startsWith("Status:"));
    if (status === undefined) continue;
    const numbers = [...new Set([...status.matchAll(/issue #(\d+)/giu)].map((match) => Number(match[1])))];
    const claims = [status, ...lines.filter((line) => line.startsWith("Deferred and named:"))]
      .flatMap((line) => [...line.matchAll(LIFECYCLE_TOKEN)].map((match) => match[1]));
    for (const claim of new Set(claims)) {
      if (numbers.length === 0) {
        errors.push(`${contractPath}: its status names no issue, so it may not claim \`${claim}\``);
      }
      for (const number of numbers) {
        const lifecycle = lifecycleOf.get(number);
        if (lifecycle === undefined) {
          errors.push(`${contractPath}: issue #${number} is outside matrix v1, so its contract may not claim \`${claim}\``);
        } else if (claim !== lifecycle) {
          errors.push(`${contractPath}: claims \`${claim}\` for issue #${number}, which matrix v1 classifies \`${lifecycle}\``);
        }
      }
    }
  }
  return errors;
}

/**
 * The marker of the contract whose status line names Arena's owner. The
 * contract is found by its marker rather than by a path written here: a script
 * that names a contract's path is measured as reading it (the panel package's
 * `measureContracts`), and this validator reads only its status line.
 */
export const ARENA_CONTRACT_MARKER = "<!-- arena-contract:v1 -->";

/**
 * Arena's one owner, named the same in the three places that name it.
 *
 * Round 7 of #39 (R7-13) found Arena a README goal with two workflows in the
 * graph, while its contract named #4, the parity registry #14, #16 and #18,
 * and no `required_for_v1` obligation named Arena at all: three owners, and
 * none of them holding the work. The matrix's owner is the structured entry's
 * — the record that carries `graph.arena-runtime`, held to its obligation by
 * the shared ownership rule — and not whichever obligation mentions Arena in
 * prose. The contract's owner is every `#N` on its status line; the parity
 * registry's, every issue its Arena sources name. All three must be the same
 * single record (ADR-097). Each leg fails closed (review of 11c, L2): a set of
 * contracts none of which carries the marker, a registry without Arena
 * sources and a matrix without the entry name no owner and are refused. A
 * validation given no contracts at all does not read that leg.
 */
export function arenaOwnerErrors({ matrix, parityRegistry, contracts = [] }) {
  const errors = [];
  const legs = [];
  const given = asList(contracts);
  if (given.length > 0) {
    const contract = given.find((entry) => typeof entry?.text === "string" && entry.text.includes(ARENA_CONTRACT_MARKER));
    if (!contract) errors.push(`Arena: no contract carries ${ARENA_CONTRACT_MARKER}, so no status line names its owner`);
    else {
      const status = contract.text.split("\n").find((line) => line.startsWith("Status:")) ?? "";
      legs.push([String(contract.path), sorted(new Set([...status.matchAll(/#(\d+)/gu)].map((match) => Number(match[1]))))]);
    }
  }
  legs.push(["the parity registry", sorted(new Set(asList(parityRegistry?.sources)
    .filter((source) => typeof source?.id === "string" && source.id.startsWith("protocol.arena."))
    .flatMap((source) => asList(source?.autoskTarget?.issueRefs))))]);
  const runtime = asList(matrix?.enforcement_points).find((entry) => entry?.point === ARENA_RUNTIME_POINT);
  legs.push(["the matrix", sorted(new Set(asList(runtime?.owner_issues)))]);
  const owners = new Set(legs.flatMap(([, issues]) => issues));
  if (owners.size !== 1 || legs.some(([, issues]) => issues.length !== 1)) {
    const named = (issues) => (issues.length > 0 ? issues.map((issue) => `#${issue}`).join(", ") : "none");
    errors.push(`Arena: ${legs.map(([where, issues], index) => `${where}${index === 0 ? " names" : ""} ${named(issues)}`).join(", ")}; its runtime has one owner, the required_for_v1 record that carries \`${ARENA_RUNTIME_POINT}\`, and the contract's status line and the parity registry name it alone`);
  }
  return errors;
}

/**
 * Every check of the program matrix, over the inputs a caller hands it.
 *
 * The inventory and the matrix are always checked, the matrix against the
 * parity registry and the workflow graph. The documents rendered from the
 * matrix — its summary, README, each contract's status line and Arena's
 * owner — are checked only when the records can be rendered at all, and
 * README's package list only when the contracts are given. Returns every
 * error found.
 */
export function validateAll({ matrix, inventory, parityRegistry, documentation, readme, contracts = [], graph }) {
  const inventoryErrors = validateInventory(inventory);
  const matrixErrors = validateMatrix(matrix, inventory, parityRegistry, graph);
  const errors = [...inventoryErrors, ...matrixErrors];
  const canRender = Array.isArray(matrix?.records) &&
    matrix.records.every((record) => record && typeof record === "object" && !Array.isArray(record));
  if (typeof documentation === "string" && canRender) errors.push(...validateDocumentation(matrix, documentation));
  if (canRender) errors.push(...validateReadme(matrix, readme));
  if (canRender) errors.push(...validateContractStatuses(matrix, contracts));
  if (canRender) errors.push(...arenaOwnerErrors({ matrix, parityRegistry, contracts }));
  // Given the contracts, README's package list is held to them (R7-28); a
  // validation given none does not read that list, as the Arena leg does not.
  if (asList(contracts).length > 0) errors.push(...readmeContractErrors(readme, contracts));
  return errors;
}

function fail(errors) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  return 1;
}

function isMainEntry(argvPath) {
  if (!argvPath) return false;
  try {
    return realpathSync(path.resolve(argvPath)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const result = {
    writeDocs: false,
    matrixPath: MATRIX_PATH,
    inventoryPath: INVENTORY_PATH,
    parityPath: PARITY_PATH,
    docPath: DOC_PATH,
    graphPath: GRAPH_PATH,
    graphOverridden: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write-docs") result.writeDocs = true;
    else if (["--matrix", "--inventory", "--parity", "--docs", "--graph"].includes(arg)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      index += 1;
      if (arg === "--matrix") result.matrixPath = path.resolve(value);
      if (arg === "--inventory") result.inventoryPath = path.resolve(value);
      if (arg === "--parity") result.parityPath = path.resolve(value);
      if (arg === "--docs") result.docPath = path.resolve(value);
      if (arg === "--graph") {
        result.graphPath = path.resolve(value);
        result.graphOverridden = true;
      }
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}

/**
 * A graph given with `--graph`, checked before any ownership is derived from it.
 *
 * The matrix's ownership requirements are read from the graph it is given: a
 * predicate, a guard or a workflow that input leaves out adds no requirement, so
 * an input that is not the graph that was shipped would let the matrix pass
 * without owning all of the shipped predicates (CodeRabbit on #279). The
 * override therefore has to be a graph — the repository's own graph validator
 * (`validateGraph`: the schema, the closed sets, its references and its
 * recorded `canonical_digest`, recomputed) — and the result names the graph it
 * attests. The shipped graph's own validation is `validate:workflow-graph`'s.
 */
export function overriddenGraphErrors(text) {
  let document;
  let schema;
  try {
    document = parseStrict(text);
  } catch (error) {
    return [`not a graph: ${error.message}`];
  }
  try {
    schema = parseStrict(readFileSync(path.join(ROOT, GRAPH_SCHEMA_PATH), "utf8"));
  } catch (error) {
    return [`${GRAPH_SCHEMA_PATH}: ${error.message}`];
  }
  return validateGraph(document, schema);
}

function run(argv) {
  const args = parseArgs(argv);
  for (const requiredPath of [args.matrixPath, args.inventoryPath, args.parityPath, args.graphPath]) {
    if (!existsSync(requiredPath)) return fail([`missing required file: ${requiredPath}`]);
  }
  const matrix = parseJson(args.matrixPath);
  const inventory = parseJson(args.inventoryPath);
  const parityRegistry = parseJson(args.parityPath);
  if (args.writeDocs) writeFileSync(args.docPath, renderDocumentation(matrix), "utf8");
  const documentation = existsSync(args.docPath) ? readFileSync(args.docPath, "utf8") : null;
  const readme = existsSync(README_PATH) ? readFileSync(README_PATH, "utf8") : null;
  const contracts = existsSync(CONTRACTS_DIR) ? readContracts() : [];
  if (args.graphOverridden) {
    const found = overriddenGraphErrors(readFileSync(args.graphPath, "utf8"));
    if (found.length) return fail(found.map((message) => `--graph ${args.graphPath} is not a valid v1 workflow graph, so no ownership is derived from it: ${message}`));
  }
  const graph = parseJson(args.graphPath);
  const errors = validateAll({ matrix, inventory, parityRegistry, documentation, readme, contracts, graph });
  if (documentation === null) errors.push(`missing documentation: ${args.docPath}`);
  if (errors.length) return fail(errors);
  // A result that rests on an override says which graph it attests; the shipped graph's result is what it always was.
  const attested = args.graphOverridden ? `; graph ${args.graphPath} canonical_digest ${graph.canonical_digest}` : "";
  console.log(`OK: ${matrix.records.length} program issues; ${matrix.summary.required_for_v1} required_for_v1; ${matrix.summary.planned_after_v1} planned_after_v1; digest ${matrix.canonical_digest}${attested}`);
  return 0;
}

if (isMainEntry(process.argv[1])) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    process.exitCode = fail([error.stack ?? error.message]);
  }
}
