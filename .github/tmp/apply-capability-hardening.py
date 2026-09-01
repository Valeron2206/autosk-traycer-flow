from __future__ import annotations

import json
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"expected {label} fragment was not found")
    return text.replace(old, new, 1)


script_path = Path("scripts/validate-program-capability-matrix.mjs")
script = script_path.read_text(encoding="utf-8")

script = replace_once(
    script,
    'function sorted(values) {\n  return [...values].sort((a, b) => typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)));\n}',
    'function sorted(values) {\n  return [...values].sort((a, b) => {\n    if (typeof a === "number" && typeof b === "number") return a - b;\n    const left = String(a);\n    const right = String(b);\n    return left < right ? -1 : left > right ? 1 : 0;\n  });\n}',
    "locale-invariant comparator",
)
script = replace_once(
    script,
    '  for (const [index, record] of matrix.records.entries()) {\n    const prefix = `records[${index}]`;\n    if (!exactKeys(record, RECORD_KEYS)) errors.push(`${prefix} keys differ from the closed v1 record shape`);\n    const number = record.issue_number;',
    '  for (const [index, record] of matrix.records.entries()) {\n    const prefix = `records[${index}]`;\n    if (!record || typeof record !== "object" || Array.isArray(record)) {\n      errors.push(`${prefix} must be an object`);\n      continue;\n    }\n    if (!exactKeys(record, RECORD_KEYS)) errors.push(`${prefix} keys differ from the closed v1 record shape`);\n    const number = record.issue_number;',
    "malformed record guard",
)
script = replace_once(
    script,
    '    if (record.lifecycle === "required_for_v1") {\n      if (record.release_blocking !== true) errors.push(`${prefix}: required_for_v1 must be release_blocking`);\n      if (!["phase_0_complete", "design_ready", "autonomous_mvp"].includes(record.target_milestone)) errors.push(`${prefix}: required_for_v1 target milestone is invalid`);\n    }',
    '    if (record.lifecycle === "required_for_v1") {\n      if (record.release_blocking !== true) errors.push(`${prefix}: required_for_v1 must be release_blocking`);\n      if (!["phase_0_complete", "design_ready", "autonomous_mvp"].includes(record.target_milestone)) errors.push(`${prefix}: required_for_v1 target milestone is invalid`);\n      if (!["phase_0_gate", "design_and_mvp_input", "design_gate", "mvp_release_gate"].includes(record.gate_role)) {\n        errors.push(`${prefix}: required_for_v1 gate_role cannot be post_v1_capability`);\n      }\n    }',
    "required-v1 gate role",
)
script = replace_once(
    script,
    '  validateRequiredEdges(recordsByNumber, errors);\n\n  const actualPostV1 = sorted(matrix.records.filter((record) => record.lifecycle === "planned_after_v1").map((record) => record.issue_number));',
    '  validateRequiredEdges(recordsByNumber, errors);\n\n  const validRecords = matrix.records.filter((record) => record && typeof record === "object" && !Array.isArray(record));\n  const actualPostV1 = sorted(validRecords.filter((record) => record.lifecycle === "planned_after_v1").map((record) => record.issue_number));',
    "valid-record projection",
)
script = replace_once(
    script,
    '  if (matrix.records.some((record) => record.lifecycle === "intentionally_deferred")) {',
    '  if (validRecords.some((record) => record.lifecycle === "intentionally_deferred")) {',
    "deferred projection",
)
script = replace_once(
    script,
    '    required_for_v1: matrix.records.filter((record) => record.lifecycle === "required_for_v1").length,\n    planned_after_v1: matrix.records.filter((record) => record.lifecycle === "planned_after_v1").length,\n    intentionally_deferred: matrix.records.filter((record) => record.lifecycle === "intentionally_deferred").length,\n    release_blocking: matrix.records.filter((record) => record.release_blocking === true).length,',
    '    required_for_v1: validRecords.filter((record) => record.lifecycle === "required_for_v1").length,\n    planned_after_v1: validRecords.filter((record) => record.lifecycle === "planned_after_v1").length,\n    intentionally_deferred: validRecords.filter((record) => record.lifecycle === "intentionally_deferred").length,\n    release_blocking: validRecords.filter((record) => record.release_blocking === true).length,',
    "summary projection",
)
script = replace_once(
    script,
    '  const lifecycleByIssue = new Map(matrix.records.map((record) => [record.issue_number, record.lifecycle]));',
    '  const lifecycleByIssue = new Map(validRecords.map((record) => [record.issue_number, record.lifecycle]));',
    "lifecycle projection",
)
script = replace_once(
    script,
    'export function renderDocumentation(matrix) {\n  const required = matrix.records.filter((record) => record.lifecycle === "required_for_v1");\n  const postV1 = matrix.records.filter((record) => record.lifecycle === "planned_after_v1");\n  const deferred = matrix.records.filter((record) => record.lifecycle === "intentionally_deferred");',
    'export function renderDocumentation(matrix) {\n  const validRecords = matrix.records.filter((record) => record && typeof record === "object" && !Array.isArray(record));\n  const required = validRecords.filter((record) => record.lifecycle === "required_for_v1");\n  const postV1 = validRecords.filter((record) => record.lifecycle === "planned_after_v1");\n  const deferred = validRecords.filter((record) => record.lifecycle === "intentionally_deferred");',
    "documentation projection",
)
script = replace_once(
    script,
    '  for (const record of matrix.records) {\n    lines.push(`| #${record.issue_number}',
    '  for (const record of validRecords) {\n    lines.push(`| #${record.issue_number}',
    "documentation record iteration",
)
script_path.write_text(script, encoding="utf-8")

inventory_schema_path = Path("resources/program-capabilities/issue-inventory.schema.json")
inventory_schema = json.loads(inventory_schema_path.read_text(encoding="utf-8"))
inventory_schema["properties"]["captured_at_utc"]["pattern"] = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$"
inventory_schema_path.write_text(json.dumps(inventory_schema, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

matrix_schema_path = Path("resources/program-capabilities/matrix.schema.json")
matrix_schema = json.loads(matrix_schema_path.read_text(encoding="utf-8"))
required_branch = next(
    item
    for item in matrix_schema["$defs"]["record"]["allOf"]
    if item.get("if", {}).get("properties", {}).get("lifecycle", {}).get("const") == "required_for_v1"
)
required_branch["then"]["properties"]["gate_role"] = {
    "enum": ["phase_0_gate", "design_and_mvp_input", "design_gate", "mvp_release_gate"]
}
matrix_schema_path.write_text(json.dumps(matrix_schema, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

test_path = Path("test/validate-program-capability-matrix.test.mjs")
tests = test_path.read_text(encoding="utf-8")
if "deriveParityIdsByIssue," not in tests:
    tests = tests.replace(
        "  canonicalStringify,\n  parseJson,",
        "  canonicalStringify,\n  deriveParityIdsByIssue,\n  parseJson,",
        1,
    )

marker = 'test("canonical parity identifier ordering is locale-invariant code-unit order"'
if marker not in tests:
    tests += r'''

test("canonical parity identifier ordering is locale-invariant code-unit order", () => {
  const data = fixture();
  const synthetic = {
    sources: [
      { id: "ä", classification: "v1", autoskTarget: { issueRefs: [3] } },
      { id: "z", classification: "v1", autoskTarget: { issueRefs: [3] } },
      { id: "A", classification: "v1", autoskTarget: { issueRefs: [3] } },
    ],
  };
  const { byIssue, errors } = deriveParityIdsByIssue(synthetic);
  assert.deepEqual(errors, []);
  assert.deepEqual(byIssue.get(3), ["A", "z", "ä"]);
  assert.notDeepEqual(byIssue.get(3), ["A", "ä", "z"]);
  assert.equal(data.matrix.records.length, 37);
});

test("required_for_v1 cannot use the post-v1 gate role", () => {
  const data = fixture();
  const record = data.matrix.records.find((item) => item.issue_number === 19);
  record.gate_role = "post_v1_capability";
  assert.match(messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry)), /required_for_v1 gate_role cannot be post_v1_capability/);
});

test("malformed records return validation errors instead of throwing", () => {
  const nullRecord = fixture();
  nullRecord.matrix.records[0] = null;
  assert.doesNotThrow(() => validateMatrix(nullRecord.matrix, nullRecord.inventory, nullRecord.parityRegistry));
  assert.match(messages(validateMatrix(nullRecord.matrix, nullRecord.inventory, nullRecord.parityRegistry)), /records\[0\] must be an object/);

  const missingBlockers = fixture();
  delete missingBlockers.matrix.records[0].downstream_blockers;
  assert.doesNotThrow(() => validateMatrix(missingBlockers.matrix, missingBlockers.inventory, missingBlockers.parityRegistry));
  assert.match(messages(validateMatrix(missingBlockers.matrix, missingBlockers.inventory, missingBlockers.parityRegistry)), /downstream_blockers must be an array/);
});

test("JSON schemas pin the same timestamp and lifecycle-role restrictions as runtime validation", () => {
  const inventorySchema = JSON.parse(readFileSync(path.join(ROOT, "resources/program-capabilities/issue-inventory.schema.json"), "utf8"));
  const matrixSchema = JSON.parse(readFileSync(path.join(ROOT, "resources/program-capabilities/matrix.schema.json"), "utf8"));
  assert.equal(inventorySchema.properties.captured_at_utc.pattern, "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$");
  const requiredBranch = matrixSchema.$defs.record.allOf.find((entry) => entry.if?.properties?.lifecycle?.const === "required_for_v1");
  assert.deepEqual(requiredBranch.then.properties.gate_role.enum, ["phase_0_gate", "design_and_mvp_input", "design_gate", "mvp_release_gate"]);
});
'''

test_path.write_text(tests, encoding="utf-8")
