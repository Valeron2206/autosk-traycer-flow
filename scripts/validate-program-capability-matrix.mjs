#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MATRIX_PATH = path.join(ROOT, "resources/program-capabilities/matrix.v1.json");
export const INVENTORY_PATH = path.join(ROOT, "resources/program-capabilities/issue-inventory.v1.json");
export const PARITY_PATH = path.join(ROOT, "resources/traycer-parity/registry.v1.json");
export const DOC_PATH = path.join(ROOT, "docs/program-capability-matrix.md");

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
  return typeof value === "string" && value.trim().length >= minimum;
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
  requires(19, [37]);
  requires(20, [19]);
  requires(26, [20]);
  requires(36, [39]);
  const designInputs = Array.from({ length: 16 }, (_, index) => index + 3); // #3–#18
  requires(39, designInputs);
  if (recordsByNumber.get(39)?.dependencies?.includes(36)) errors.push("issue #39 must not depend on runtime completion of #36; only its design contract is required");
}

export function validateMatrix(matrix, inventory, parityRegistry) {
  const errors = [];
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) return ["matrix must be an object"];
  const expectedTopKeys = [
    "$schema", "schema_version", "matrix_version", "repository", "issue_range",
    "source_main_commit", "issue_inventory_path", "issue_inventory_digest",
    "source_parity_registry_path", "classification_policy", "summary", "records",
    "canonical_digest",
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

  const expectedDigest = digestMatrix(matrix);
  if (matrix.canonical_digest !== expectedDigest) errors.push(`matrix canonical_digest mismatch: expected ${expectedDigest}`);
  return errors;
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
    "Поле `dependencies` задаёт implementation/execution ordering. Обязанности design gate до #39 задаются отдельно в `design_obligation_before_issue_39` каждой записи.",
    "",
    "| Issue | Priority | Lifecycle | Target | Gate role | Depends on | Release blocker | Full program |",
    "| ---: | :---: | --- | --- | --- | --- | :---: | :---: |",
  ];
  for (const record of matrix.records) {
    lines.push(`| #${record.issue_number} ${mdEscape(record.issue_title.replace(/^\[P[012]\](?:\[DESIGN GATE\])?\s*/u, ""))} | ${record.priority} | ${record.lifecycle} | ${record.target_milestone} | ${record.gate_role} | ${record.dependencies.length ? record.dependencies.map((number) => `#${number}`).join(", ") : "—"} | ${record.release_blocking ? "yes" : "no"} | ${record.full_program_required ? "yes" : "no"} |`);
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

export function validateAll({ matrix, inventory, parityRegistry, documentation }) {
  const inventoryErrors = validateInventory(inventory);
  const matrixErrors = validateMatrix(matrix, inventory, parityRegistry);
  const errors = [...inventoryErrors, ...matrixErrors];
  const canRender = Array.isArray(matrix?.records) &&
    matrix.records.every((record) => record && typeof record === "object" && !Array.isArray(record));
  if (typeof documentation === "string" && canRender) errors.push(...validateDocumentation(matrix, documentation));
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
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write-docs") result.writeDocs = true;
    else if (["--matrix", "--inventory", "--parity", "--docs"].includes(arg)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      index += 1;
      if (arg === "--matrix") result.matrixPath = path.resolve(value);
      if (arg === "--inventory") result.inventoryPath = path.resolve(value);
      if (arg === "--parity") result.parityPath = path.resolve(value);
      if (arg === "--docs") result.docPath = path.resolve(value);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}

function run(argv) {
  const args = parseArgs(argv);
  for (const requiredPath of [args.matrixPath, args.inventoryPath, args.parityPath]) {
    if (!existsSync(requiredPath)) return fail([`missing required file: ${requiredPath}`]);
  }
  const matrix = parseJson(args.matrixPath);
  const inventory = parseJson(args.inventoryPath);
  const parityRegistry = parseJson(args.parityPath);
  if (args.writeDocs) writeFileSync(args.docPath, renderDocumentation(matrix), "utf8");
  const documentation = existsSync(args.docPath) ? readFileSync(args.docPath, "utf8") : null;
  const errors = validateAll({ matrix, inventory, parityRegistry, documentation });
  if (documentation === null) errors.push(`missing documentation: ${args.docPath}`);
  if (errors.length) return fail(errors);
  console.log(`OK: ${matrix.records.length} program issues; ${matrix.summary.required_for_v1} required_for_v1; ${matrix.summary.planned_after_v1} planned_after_v1; digest ${matrix.canonical_digest}`);
  return 0;
}

if (isMainEntry(process.argv[1])) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    process.exitCode = fail([error.stack ?? error.message]);
  }
}
