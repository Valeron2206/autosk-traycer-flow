import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DOC_PATH,
  INVENTORY_PATH,
  MATRIX_PATH,
  PARITY_PATH,
  POST_V1_ISSUES,
  README_PATH,
  canonicalStringify,
  deriveParityIdsByIssue,
  parseJson,
  renderDocumentation,
  sha256,
  validateAll,
  validateDocumentation,
  validateInventory,
  validateMatrix,
  validateReadme,
} from "../scripts/validate-program-capability-matrix.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture() {
  return {
    matrix: parseJson(MATRIX_PATH),
    inventory: parseJson(INVENTORY_PATH),
    parityRegistry: parseJson(PARITY_PATH),
    documentation: readFileSync(DOC_PATH, "utf8"),
    readme: readFileSync(README_PATH, "utf8"),
  };
}

function messages(errors) {
  return errors.join("\n");
}

test("committed capability matrix, issue inventory, source parity links and docs validate", () => {
  assert.deepEqual(validateAll(fixture()), []);
});

test("matrix covers exactly issues #3–#39", () => {
  const data = fixture();
  data.matrix.records.pop();
  assert.match(messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry)), /exactly 37 records/);
});

test("duplicate issue number is rejected", () => {
  const data = fixture();
  data.matrix.records[1].issue_number = data.matrix.records[0].issue_number;
  assert.match(messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry)), /duplicates #3/);
});

test("issue #40 or a PR-shaped entry cannot enter the program matrix", () => {
  const data = fixture();
  const record = data.matrix.records.at(-1);
  record.issue_number = 40;
  record.issue_title = "docs: fake pull request";
  assert.match(messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry)), /outside #3–#39|exactly issues #3–#39/);
});

test("stale issue title and priority are rejected against the pinned inventory", () => {
  const data = fixture();
  data.matrix.records[4].issue_title += " stale";
  data.matrix.records[4].priority = "P2";
  const result = messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry));
  assert.match(result, /issue_title is stale/);
  assert.match(result, /priority is stale/);
});

test("inventory title priority must agree", () => {
  const data = fixture();
  data.inventory.issues[0].priority = "P2";
  assert.match(messages(validateInventory(data.inventory)), /priority does not match title/);
});

test("inventory canonical digest detects mutation", () => {
  const data = fixture();
  data.inventory.issues[0].issue_title += " changed";
  assert.match(messages(validateInventory(data.inventory)), /canonical_digest mismatch/);
});

test("invalid lifecycle is rejected", () => {
  const data = fixture();
  data.matrix.records[20].lifecycle = "maybe";
  assert.match(messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry)), /lifecycle is invalid/);
});

test("every P0 remains required_for_v1 in matrix v1", () => {
  const data = fixture();
  const record = data.matrix.records.find((item) => item.issue_number === 13);
  record.lifecycle = "planned_after_v1";
  record.release_blocking = false;
  record.target_milestone = "full_parity_post_v1";
  record.gate_role = "post_v1_capability";
  const result = messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry));
  assert.match(result, /P0 issue #13 cannot be moved after v1/);
});

test("planned_after_v1 requires the post-v1 milestone, trigger and non-blocking role", () => {
  const data = fixture();
  const record = data.matrix.records.find((item) => item.issue_number === 28);
  record.release_blocking = true;
  record.target_milestone = "autonomous_mvp";
  record.gate_role = "design_and_mvp_input";
  record.activation_trigger = "";
  const result = messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry));
  assert.match(result, /activation_trigger must contain at least 20 characters/);
  assert.match(result, /planned_after_v1 must not block/);
  assert.match(result, /target must be full_parity_post_v1/);
  assert.match(result, /gate_role must be post_v1_capability/);
});

test("intentionally_deferred requires an immutable decision reference and reviewed policy change", () => {
  const data = fixture();
  const record = data.matrix.records.find((item) => item.issue_number === 28);
  record.lifecycle = "intentionally_deferred";
  record.target_milestone = "deferred";
  record.gate_role = "post_v1_capability";
  record.decision_reference = null;
  const result = messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry));
  assert.match(result, /requires an immutable user\/external decision reference/);
  assert.match(result, /matrix v1 intentionally defers no program issue/);
});

test("release-blocking contradiction is rejected", () => {
  const data = fixture();
  data.matrix.records.find((item) => item.issue_number === 19).release_blocking = false;
  assert.match(messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry)), /required_for_v1 must be release_blocking/);
});

test("dependency outside the program range is rejected", () => {
  const data = fixture();
  data.matrix.records.find((item) => item.issue_number === 7).dependencies.push(43);
  assert.match(messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry)), /out-of-range issue 43/);
});

test("dependency self-cycle is rejected", () => {
  const data = fixture();
  data.matrix.records.find((item) => item.issue_number === 7).dependencies.push(7);
  assert.match(messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry)), /cannot contain self #7/);
});

test("multi-node dependency cycle is rejected", () => {
  const data = fixture();
  data.matrix.records.find((item) => item.issue_number === 3).dependencies.push(39);
  const result = messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry));
  assert.match(result, /dependency cycle/);
});

test("reverse downstream projection must match dependencies exactly", () => {
  const data = fixture();
  data.matrix.records.find((item) => item.issue_number === 5).downstream_blockers = [];
  assert.match(messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry)), /downstream_blockers is not the exact reverse dependency projection/);
});

test("canonical roadmap edges are enforced", () => {
  const data = fixture();
  data.matrix.records.find((item) => item.issue_number === 9).dependencies =
    data.matrix.records.find((item) => item.issue_number === 9).dependencies.filter((number) => number !== 17);
  assert.match(messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry)), /issue #9 must depend on #17/);
});

test("design gate does not depend on runtime completion of the E2E release gate", () => {
  const data = fixture();
  data.matrix.records.find((item) => item.issue_number === 39).dependencies.push(36);
  assert.match(messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry)), /must not depend on runtime completion of #36/);
});

test("#36 and #39 preserve their release/design gate roles", () => {
  const data = fixture();
  data.matrix.records.find((item) => item.issue_number === 36).gate_role = "design_and_mvp_input";
  data.matrix.records.find((item) => item.issue_number === 39).target_milestone = "autonomous_mvp";
  const result = messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry));
  assert.match(result, /issue #36 must be required_for_v1/);
  assert.match(result, /issue #39 must be required_for_v1/);
});

test("planned_after_v1 set is exact for matrix v1", () => {
  const data = fixture();
  const record = data.matrix.records.find((item) => item.issue_number === 32);
  record.lifecycle = "planned_after_v1";
  record.release_blocking = false;
  record.target_milestone = "full_parity_post_v1";
  record.gate_role = "post_v1_capability";
  assert.match(messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry)), /planned_after_v1 set must be exactly/);
  assert.deepEqual(POST_V1_ISSUES, [28, 29, 30, 31, 33, 38]);
});

test("source parity logical IDs are derived exactly from registry issueRefs", () => {
  const data = fixture();
  data.matrix.records.find((item) => item.issue_number === 24).source_parity_ids.pop();
  assert.match(messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry)), /source_parity_ids differs from registry issueRefs for #24/);
});

test("source registry v1/post_v1 classification must agree with issue lifecycle", () => {
  const data = fixture();
  const source = data.parityRegistry.sources.find((item) => item.id === "skill.autobuild");
  source.classification = "v1";
  assert.match(messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry)), /skill\.autobuild is v1 but targets planned_after_v1 issue #28/);
});

test("matrix canonical digest detects any classification mutation", () => {
  const data = fixture();
  data.matrix.records.find((item) => item.issue_number === 33).classification_risk += " changed";
  assert.match(messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry)), /matrix canonical_digest mismatch/);
});

test("canonical serialization is key-order independent and array-order sensitive", () => {
  assert.equal(canonicalStringify({ b: 2, a: 1 }), canonicalStringify({ a: 1, b: 2 }));
  assert.notEqual(canonicalStringify([1, 2]), canonicalStringify([2, 1]));
  assert.equal(sha256("same"), sha256("same"));
});

test("canonical parity identifier ordering is locale-invariant code-unit order", () => {
  const registry = {
    sources: [
      { id: "ä", autoskTarget: { issueRefs: [3] } },
      { id: "z", autoskTarget: { issueRefs: [3] } },
      { id: "A", autoskTarget: { issueRefs: [3] } },
    ],
  };
  const { byIssue, errors } = deriveParityIdsByIssue(registry);
  assert.deepEqual(errors, []);
  assert.deepEqual(byIssue.get(3), ["A", "z", "ä"]);
});

test("required_for_v1 cannot use the post-v1 gate role", () => {
  const data = fixture();
  const record = data.matrix.records.find((item) => item.issue_number === 19);
  record.gate_role = "post_v1_capability";
  assert.match(
    messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry)),
    /required_for_v1 gate_role cannot be post_v1_capability/,
  );
});

test("malformed records return validation errors instead of throwing", () => {
  const malformedInventory = fixture();
  malformedInventory.inventory.issues = null;
  assert.doesNotThrow(() => validateAll(malformedInventory));
  assert.match(messages(validateAll(malformedInventory)), /inventory issues must be an array/);

  const nullRecord = fixture();
  nullRecord.matrix.records[0] = null;
  assert.doesNotThrow(() => validateMatrix(nullRecord.matrix, nullRecord.inventory, nullRecord.parityRegistry));
  assert.doesNotThrow(() => validateAll(nullRecord));
  assert.match(
    messages(validateMatrix(nullRecord.matrix, nullRecord.inventory, nullRecord.parityRegistry)),
    /records\[0\] must be an object/,
  );

  for (const malformed of [undefined, null, "not-an-array"]) {
    const data = fixture();
    if (malformed === undefined) delete data.matrix.records[0].downstream_blockers;
    else data.matrix.records[0].downstream_blockers = malformed;
    assert.doesNotThrow(() => validateMatrix(data.matrix, data.inventory, data.parityRegistry));
    assert.doesNotThrow(() => validateAll(data));
    assert.match(
      messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry)),
      /records\[0\]\.downstream_blockers must be an array/,
    );
  }
});

test("JSON schemas pin exact UTC timestamps and required lifecycle roles", () => {
  const inventorySchema = JSON.parse(
    readFileSync(path.join(ROOT, "resources/program-capabilities/issue-inventory.schema.json"), "utf8"),
  );
  const matrixSchema = JSON.parse(
    readFileSync(path.join(ROOT, "resources/program-capabilities/matrix.schema.json"), "utf8"),
  );
  const timestampPattern = inventorySchema.properties.captured_at_utc.pattern;
  assert.equal(timestampPattern, "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$");
  const timestamp = new RegExp(timestampPattern, "u");
  assert.equal(timestamp.test("2026-09-01T02:12:40Z"), true);
  assert.equal(timestamp.test("2026-09-01T02:12:40.5Z"), false);
  assert.equal(timestamp.test("2026-09-01T02:12:40+03:00"), false);
  assert.deepEqual(
    inventorySchema.properties.issues.items.required,
    ["issue_number", "github_node_id", "entity_kind", "issue_title", "priority"],
  );
  assert.equal(inventorySchema.properties.issues.items.properties.entity_kind.const, "issue");
  assert.equal(inventorySchema.properties.issues.items.properties.github_node_id.pattern, "^I_[A-Za-z0-9_-]+$");

  const requiredBranch = matrixSchema.$defs.record.allOf.find(
    (entry) => entry.if?.properties?.lifecycle?.const === "required_for_v1",
  );
  assert.deepEqual(requiredBranch.then.properties.gate_role.enum, [
    "phase_0_gate",
    "design_and_mvp_input",
    "design_gate",
    "mvp_release_gate",
  ]);
  assert.equal(matrixSchema.$defs.record.properties.full_program_required.const, true);
  assert.equal(matrixSchema.$defs.record.required.includes("full_program_required"), true);
});

test("runtime validation matches closed nested schema constraints", () => {
  const data = fixture();
  data.inventory.issue_range.extra = true;
  data.matrix.issue_range.extra = true;
  data.matrix.classification_policy.extra = "schema drift";
  const record = data.matrix.records.find((item) => item.issue_number === 19);
  record.rationale = "r".repeat(25);
  record.classification_risk = "c".repeat(25);
  const result = messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry));
  assert.match(
    messages(validateInventory(data.inventory)),
    /inventory issue_range keys differ from the closed v1 schema/,
  );
  assert.match(result, /matrix issue_range keys differ from the closed v1 schema/);
  assert.match(result, /matrix classification_policy keys differ from the closed v1 schema/);
  assert.match(result, /rationale must contain at least 30 characters/);
  assert.match(result, /classification_risk must contain at least 30 characters/);

  const unicodeData = fixture();
  unicodeData.matrix.records.find((item) => item.issue_number === 19).rationale = "𐐷".repeat(15);
  assert.match(
    messages(validateMatrix(unicodeData.matrix, unicodeData.inventory, unicodeData.parityRegistry)),
    /rationale must contain at least 30 characters/,
  );
});

test("inventory binds every record to an issue entity and GitHub node identity", () => {
  const data = fixture();
  const record = data.inventory.issues[0];
  record.entity_kind = "pull_request";
  record.github_node_id = "PR_kwDOExample";
  const result = messages(validateInventory(data.inventory));
  assert.match(result, /entity_kind must be issue/);
  assert.match(result, /github_node_id must identify a GitHub issue/);
});

test("post-v1 activation cannot bypass the MVP release gate", () => {
  const data = fixture();
  const record = data.matrix.records.find((item) => item.issue_number === 28);
  record.activation_trigger = "Begin before issue #36 closes when requested.";
  assert.match(
    messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry)),
    /planned_after_v1 activation must start only after issue #36 closes/,
  );
  assert.doesNotMatch(
    data.matrix.records.find((item) => item.issue_number === 31).activation_trigger,
    /or earlier/u,
  );
  record.activation_trigger = "Begin after issue #36 closes; allow an exact subset earlier.";
  assert.match(
    messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry)),
    /planned_after_v1 activation must not contain a pre-MVP escape/,
  );
});

test("full program obligation is explicit and cannot be disabled", () => {
  const data = fixture();
  data.matrix.records.find((item) => item.issue_number === 28).full_program_required = false;
  assert.match(
    messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry)),
    /full_program_required must be true/,
  );
});

test("matrix evolution and #38 promotion require a reviewed successor candidate", () => {
  const data = fixture();
  assert.match(data.matrix.classification_policy.evolution_rule, /successor matrix version/u);
  assert.match(data.matrix.classification_policy.evolution_rule, /new or split issue/u);
  const sdk = data.matrix.records.find((item) => item.issue_number === 38);
  assert.doesNotMatch(sdk.activation_trigger, /earlier|before/u);
  assert.match(sdk.implementation_obligation_before_mvp, /explicit user decision/u);
  assert.match(sdk.implementation_obligation_before_mvp, /successor matrix/u);
  assert.match(sdk.implementation_obligation_before_mvp, /full panel/u);
  assert.match(data.documentation, /source-parity.*intentionally_deferred.*planned_after_v1/u);
  assert.match(data.documentation, /implementation\/execution ordering/u);
});

test("human-readable summary is deterministic and drift is rejected", () => {
  const data = fixture();
  assert.equal(renderDocumentation(data.matrix), data.documentation);
  assert.deepEqual(validateDocumentation(data.matrix, `${data.documentation}\nmanual drift\n`), [
    "docs/program-capability-matrix.md is stale; regenerate with npm run generate:capabilities",
  ]);
});

test("README capability totals and post-v1 set cannot drift", () => {
  const data = fixture();
  assert.deepEqual(validateReadme(data.matrix, data.readme), []);
  assert.match(
    messages(validateReadme(data.matrix, data.readme.replace("`required_for_v1`: 31", "`required_for_v1`: 30"))),
    /README required_for_v1 total is stale/,
  );
  assert.match(
    messages(validateReadme(data.matrix, data.readme.replace("typed SDK write API (#38)", "typed SDK write API"))),
    /README post-v1 issue set is stale/,
  );
});

test("matrix does not become a live task-state ledger", () => {
  const data = fixture();
  data.matrix.records[0].state = "closed";
  assert.match(messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry)), /keys differ from the closed v1 record shape|state is forbidden/);
});

test("schema and data files are present under the dedicated program-capabilities namespace", () => {
  for (const relative of [
    "resources/program-capabilities/issue-inventory.schema.json",
    "resources/program-capabilities/issue-inventory.v1.json",
    "resources/program-capabilities/matrix.schema.json",
    "resources/program-capabilities/matrix.v1.json",
    "docs/program-capability-matrix.md",
  ]) {
    assert.equal(readFileSync(path.join(ROOT, relative), "utf8").length > 0, true, relative);
  }
});
