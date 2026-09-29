import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
  readContracts,
  validateAll,
  validateContractStatuses,
  validateDocumentation,
  validateInventory,
  validateMatrix,
  validateReadme,
  preflightRequirements,
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

test("every contract states the lifecycle the matrix gives its issue", () => {
  // Round 5 of #39 (R5-10, R5-11): five post-v1 contracts said their runtime
  // "remains `required_for_v1`" while the matrix classifies #28–#33 as
  // `planned_after_v1`, and #47, outside the #3–#39 inventory, claimed
  // `required_for_v1` with no successor matrix.
  const contracts = readContracts();
  assert.ok(contracts.length >= 40, `read ${contracts.length} contracts`);
  assert.deepEqual(validateContractStatuses(parseJson(MATRIX_PATH), contracts), []);
});

test("a contract claiming another lifecycle than the matrix, or claiming one outside it, is refused", () => {
  const matrix = parseJson(MATRIX_PATH);
  const contract = (status, deferred = "") => ({
    path: "docs/contracts/x.md",
    text: `# X\n\n${status}\n\n## 1. Body\n\n${deferred}\n`,
  });
  // A post-v1 issue claiming v1.
  assert.match(messages(validateContractStatuses(matrix, [
    contract("Status: issue #28 design contract. The runtime remains `required_for_v1`."),
  ])), /claims `required_for_v1` for issue #28, which matrix v1 classifies `planned_after_v1`/u);
  // The claim is read on the deferral line too, not only on the status line.
  assert.match(messages(validateContractStatuses(matrix, [
    contract("Status: issue #29 design contract.", "Deferred and named: the runtime. Those are `required_for_v1` and are not claimed here."),
  ])), /claims `required_for_v1` for issue #29/u);
  // A v1 issue claiming post-v1.
  assert.match(messages(validateContractStatuses(matrix, [
    contract("Status: issue #9 design contract. Runtime implementation remains `planned_after_v1`."),
  ])), /claims `planned_after_v1` for issue #9, which matrix v1 classifies `required_for_v1`/u);
  // An issue outside the inventory may claim no lifecycle of matrix v1 at all.
  assert.match(messages(validateContractStatuses(matrix, [
    contract("Status: issue #47 design contract. The adapter remains `required_for_v1`."),
  ])), /issue #47 is outside matrix v1, so its contract may not claim `required_for_v1`/u);
  // A status naming no issue may not state a lifecycle; it is refused, not skipped.
  assert.match(messages(validateContractStatuses(matrix, [
    contract("Status: ticket 15 design contract. This is `required_for_v1`."),
  ])), /its status names no issue, so it may not claim `required_for_v1`/u);
  // Every issue a status names is held to the claim, whichever comes first, and
  // the word is matched case-insensitively.
  assert.match(messages(validateContractStatuses(matrix, [
    contract("Status: issue #9 and Issue #31 design contract. The runtime remains `required_for_v1`."),
  ])), /claims `required_for_v1` for issue #31, which matrix v1 classifies `planned_after_v1`/u);
  // What agrees with the matrix passes, including a status naming several issues
  // of one lifecycle, and a status naming no issue and stating nothing.
  assert.deepEqual(validateContractStatuses(matrix, [
    contract("Status: issue #28 design contract. The runtime is `planned_after_v1`."),
    contract("Status: issue #9 design contract. Runtime implementation remains `required_for_v1` after design gate #39."),
    contract("Status: issue #9 and issue #4 runtime contract. Both remain `required_for_v1`."),
    contract("Status: ticket 15 design contract. It states no lifecycle."),
  ]), []);
});

test("the contracts read are every contract in the directory", () => {
  const onDisk = readdirSync(path.join(ROOT, "docs/contracts")).filter((name) => name.endsWith(".md")).sort();
  assert.deepEqual(readContracts().map((entry) => path.basename(entry.path)).sort(), onDisk);
});

test("the whole validation reads the contracts it is given", () => {
  // The CLI passes every contract to `validateAll`; a status check that only a
  // direct call could reach would leave the command green on a stale contract.
  const stale = { path: "docs/contracts/x.md", text: "Status: issue #30 design contract. The runtime remains `required_for_v1`.\n" };
  assert.match(messages(validateAll({ ...fixture(), contracts: [stale] })), /claims `required_for_v1` for issue #30/u);
  assert.deepEqual(validateAll({ ...fixture(), contracts: readContracts() }), []);
});

// Debt 10f (round 6 of #39, R6-16 and a1): the preflight refuses every model
// workflow without ADR-023's `authority.user-decision` and ADR-025's
// `workflow.custody`, while no `required_for_v1` record carried their
// implementation and #38 is `planned_after_v1`, so v1 as classified could not
// be completed. The matrix now names who carries each capability the preflight
// requires, and the requirement is read from the preflight, not restated.
import { REQUIRED_DAEMON_CAPABILITIES, UNPINNED_DAEMON_PRIMITIVES } from "../src/host/daemon-preflight.mjs";
import { MODEL_STEP_CHECKS } from "../src/host/workflow-preflight.mjs";

const PREFLIGHT_REQUIRED = [
  ...REQUIRED_DAEMON_CAPABILITIES.map((want) => want.name),
  ...MODEL_STEP_CHECKS,
].sort();

function primitiveErrors(data) {
  return messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry));
}

test("every capability a v1 workflow's preflight requires is carried by a required_for_v1 record", () => {
  const data = fixture();
  assert.ok(Array.isArray(data.matrix.preflight_primitives), "the matrix names the preflight's primitives");
  assert.deepEqual(data.matrix.preflight_primitives.map((entry) => entry.capability).sort(), PREFLIGHT_REQUIRED);
  assert.ok(PREFLIGHT_REQUIRED.includes("authority.user-decision"));
  assert.ok(PREFLIGHT_REQUIRED.includes("workflow.custody"));
  assert.ok(PREFLIGHT_REQUIRED.includes("security.signer_boundary"));
  const lifecycle = new Map(data.matrix.records.map((record) => [record.issue_number, record.lifecycle]));
  for (const entry of data.matrix.preflight_primitives) {
    assert.ok(entry.owner_issues.length > 0, entry.capability);
    for (const issue of entry.owner_issues) assert.equal(lifecycle.get(issue), "required_for_v1", `${entry.capability} → #${issue}`);
  }
  const byName = new Map(data.matrix.preflight_primitives.map((entry) => [entry.capability, entry]));
  for (const { name, adr } of UNPINNED_DAEMON_PRIMITIVES) assert.equal(byName.get(name).decision, adr);
  // The line with #38: its typed SDK stays after v1, and it carries none of them.
  assert.ok(data.matrix.preflight_primitives.every((entry) => !entry.owner_issues.includes(38)));
  assert.equal(data.matrix.records.find((record) => record.issue_number === 38).lifecycle, "planned_after_v1");
  // The daemon side is upstream work, as #11's is.
  for (const issue of [4, 18]) {
    assert.match(data.matrix.records.find((record) => record.issue_number === issue).owner, /autosk upstream maintainer/u);
  }
});

test("a capability the preflight requires and no record carries is refused", () => {
  const data = fixture();
  data.matrix.preflight_primitives = data.matrix.preflight_primitives.filter((entry) => entry.capability !== "workflow.custody");
  assert.match(primitiveErrors(data), /`workflow\.custody` is required by the v1 preflight and carried by no required_for_v1 record/u);
});

test("a preflight primitive carried only after v1 is refused", () => {
  const data = fixture();
  data.matrix.preflight_primitives.find((entry) => entry.capability === "authority.user-decision").owner_issues = [38];
  assert.match(primitiveErrors(data), /`authority\.user-decision` is carried by #38, which is planned_after_v1, not required_for_v1/u);
  const empty = fixture();
  empty.matrix.preflight_primitives.find((entry) => entry.capability === "workflow.custody").owner_issues = [];
  assert.match(primitiveErrors(empty), /`workflow\.custody` names no owner issue/u);
});

test("a primitive the preflight does not require, or of the wrong kind or decision, is refused", () => {
  const data = fixture();
  data.matrix.preflight_primitives.push({ ...data.matrix.preflight_primitives[0], capability: "workflow.imaginary" });
  assert.match(primitiveErrors(data), /`workflow\.imaginary` is not required by the v1 preflight/u);
  const kind = fixture();
  kind.matrix.preflight_primitives.find((entry) => entry.capability === "security.signer_boundary").requirement = "daemon_capability";
  assert.match(primitiveErrors(kind), /`security\.signer_boundary` is a model_step_check of the preflight/u);
  const decision = fixture();
  decision.matrix.preflight_primitives.find((entry) => entry.capability === "workflow.custody").decision = "ADR-023";
  assert.match(primitiveErrors(decision), /`workflow\.custody` is the preflight's ADR-025 primitive/u);
  const twice = fixture();
  twice.matrix.preflight_primitives.push(structuredClone(twice.matrix.preflight_primitives[1]));
  assert.match(primitiveErrors(twice), /is named twice/u);
});

test("the owning record's implementation obligation names the primitive it carries", () => {
  const data = fixture();
  const custody = data.matrix.preflight_primitives.find((entry) => entry.capability === "workflow.custody");
  const owner = data.matrix.records.find((record) => record.issue_number === custody.owner_issues[0]);
  owner.implementation_obligation_before_mvp = owner.implementation_obligation_before_mvp.replaceAll("`workflow.custody`", "custody");
  assert.match(primitiveErrors(data), new RegExp(`#${owner.issue_number} carries \`workflow\\.custody\` but its implementation_obligation_before_mvp does not name it`, "u"));
});

test("malformed preflight primitives return errors instead of throwing", () => {
  for (const malformed of [undefined, null, "x", [null], [{ capability: "workflow.custody" }]]) {
    const data = fixture();
    if (malformed === undefined) delete data.matrix.preflight_primitives;
    else data.matrix.preflight_primitives = malformed;
    assert.doesNotThrow(() => validateMatrix(data.matrix, data.inventory, data.parityRegistry));
    assert.doesNotThrow(() => validateAll(data));
    assert.notDeepEqual(validateMatrix(data.matrix, data.inventory, data.parityRegistry), []);
  }
});

test("the matrix schema requires the preflight primitives in a closed shape", () => {
  const schema = JSON.parse(readFileSync(path.join(ROOT, "resources/program-capabilities/matrix.schema.json"), "utf8"));
  assert.ok(schema.required.includes("preflight_primitives"));
  const entry = schema.$defs.preflightPrimitive;
  assert.equal(entry.additionalProperties, false);
  assert.deepEqual([...entry.required].sort(), ["capability", "decision", "delivery", "elements", "owner_issues", "requirement"]);
  assert.deepEqual(entry.properties.requirement.enum, ["daemon_capability", "model_step_check"]);
});

test("the generated summary lists who carries each preflight primitive", () => {
  const data = fixture();
  for (const entry of data.matrix.preflight_primitives) {
    assert.match(data.documentation, new RegExp(`\\| \`${entry.capability.replaceAll(".", "\\.")}\` \\|`, "u"));
  }
});

test("the records that consume the preflight primitives depend on the records that carry them", () => {
  // #9's final CAS runs `integrateApproved` over ADR-023's authority heads and
  // admits only gate-result receipts of ADR-025; the doctor's signer check
  // passes only on #4's signer.
  // #4's daemon side ships in the pinned patch series whose identity #10 locks.
  for (const [issue, dependency] of [[9, 4], [9, 18], [34, 4], [4, 10]]) {
    const data = fixture();
    const record = data.matrix.records.find((item) => item.issue_number === issue);
    assert.ok(record.dependencies.includes(dependency), `#${issue} depends on #${dependency}`);
    record.dependencies = record.dependencies.filter((item) => item !== dependency);
    assert.match(primitiveErrors(data), new RegExp(`issue #${issue} must depend on #${dependency} by the canonical roadmap`, "u"));
  }
});

test("a required_for_v1 record whose obligation claims a primitive is among its owners", () => {
  const data = fixture();
  const entry = data.matrix.preflight_primitives.find((item) => item.capability === "authority.user-decision");
  entry.owner_issues = [4];
  entry.elements = entry.elements.filter((element) => element.owner !== 9);
  assert.match(primitiveErrors(data), /#9 names `authority\.user-decision` in its implementation obligation but is not among its owners/u);
});

test("every owner owns a surface of its primitive, named in its own obligation", () => {
  const none = fixture();
  const custody = none.matrix.preflight_primitives.find((item) => item.capability === "workflow.custody");
  custody.elements = [];
  assert.match(primitiveErrors(none), /#18 carries `workflow\.custody` but owns none of its surfaces/u);
  const unnamed = fixture();
  unnamed.matrix.preflight_primitives.find((item) => item.capability === "workflow.custody").elements[0].surface = "imaginary surface";
  assert.match(primitiveErrors(unnamed), /surface "imaginary surface" of `workflow\.custody` is not named in #18's implementation_obligation_before_mvp/u);
  const stranger = fixture();
  stranger.matrix.preflight_primitives.find((item) => item.capability === "workflow.custody").elements[0].owner = 34;
  assert.match(primitiveErrors(stranger), /is owned by #34, which is not among the owners of `workflow\.custody`/u);
  const shape = fixture();
  shape.matrix.preflight_primitives.find((item) => item.capability === "workflow.custody").elements[0] = "orchestrateChildBatch";
  assert.doesNotThrow(() => primitiveErrors(shape));
  assert.match(primitiveErrors(shape), /elements\[0\] must be a closed \{surface, owner\} object/u);
});

test("every preflight primitive's decision is pinned, not only the unpinned daemon ones", () => {
  const binding = fixture();
  binding.matrix.preflight_primitives.find((item) => item.capability === "task.creation-binding").decision = "ADR-023";
  assert.match(primitiveErrors(binding), /`task\.creation-binding` is the preflight's ADR-014 primitive/u);
  const signer = fixture();
  signer.matrix.preflight_primitives.find((item) => item.capability === "security.signer_boundary").decision = "ADR-023";
  assert.match(primitiveErrors(signer), /`security\.signer_boundary` is the preflight's ADR-090 primitive/u);
  for (const want of preflightRequirements()) assert.match(want.decision, /^ADR-\d{3}$/u, want.capability);
});

test("the requirement read is the daemon capabilities and the model-step checks, not the implemented host checks", async () => {
  // Phase checks are host checks the doctor implements itself (#34); the
  // matrix is held to what rests on a daemon primitive or a model step.
  const { PHASE_CHECKS } = await import("../src/host/workflow-preflight.mjs");
  const names = preflightRequirements().map((want) => want.capability).sort();
  assert.deepEqual(names, PREFLIGHT_REQUIRED);
  for (const id of Object.values(PHASE_CHECKS).flat()) assert.ok(!names.includes(id), id);
});

// Debt 11c (round 7 of #39, R7-9, R7-10, R7-11, R7-13, R7-20, R7-27): v1 owns
// every enforcement point the design rests on, not only the preflight's
// primitives. An owner outside #3–#39 (#40, #231) cannot be a matrix edge, so
// each point is given to an existing `required_for_v1` record and, where the
// requirement can be read from the repository, the validator reads it.
import { enforcementRequirements } from "../scripts/validate-program-capability-matrix.mjs";

const GRAPH_DOCUMENT = JSON.parse(readFileSync(path.join(ROOT, "resources/workflow-graph/workflow-graph.v1.json"), "utf8"));
const record = (data, issue) => data.matrix.records.find((item) => item.issue_number === issue);

test("the load-time call site is #18's entry point, and the function and what it checks stay #11's", () => {
  // R7-11: `requireDaemonCapabilities` had no caller and no check compared the
  // daemon's `meta.capabilities`; its call at extension load was #40's. Review
  // of 11c (M2): the matrix forbids cycles, so the call and the function it
  // calls cannot each sit on the side that depends on the other. #18 owns the
  // extension entry point and makes the call at load, consuming #11's function
  // and `task.create_bound` (edge #18 → #11); #11 keeps the function and what
  // it checks (creation-grant.md §5, #11 criterion 6); #34 keeps the doctor
  // check and the dispatch gate before a model launch (doctor-report.md §7).
  assert.ok(MODEL_STEP_CHECKS.includes("daemon.capabilities_pinned"));
  const data = fixture();
  const entry = data.matrix.preflight_primitives.find((item) => item.capability === "daemon.capabilities_pinned");
  assert.ok(entry, "the matrix names who carries the daemon capability check");
  assert.equal(entry.requirement, "model_step_check");
  assert.equal(entry.decision, "ADR-097");
  assert.deepEqual(entry.owner_issues, [11, 18, 34]);
  const surfaces = entry.elements.map((element) => `${element.owner}:${element.surface}`);
  for (const surface of [
    "11:`requireDaemonCapabilities` and what it checks",
    "18:`requireDaemonCapabilities` at extension load",
    "34:daemon capability check",
    "34:dispatch gate before any model launch",
  ]) {
    assert.ok(surfaces.includes(surface), `${surface} in ${surfaces.join("; ")}`);
  }
  const grant = readFileSync(path.join(ROOT, "docs/contracts/creation-grant.md"), "utf8");
  assert.match(grant, /^Status: issue #11 /mu);
  assert.match(grant, /`requireDaemonCapabilities` runs at \*\*extension load\*\*/u);
  assert.match(grant, /the call site is the extension entry point, which matrix v1 gives to #18/u);
  // The dispatch gate holds a workflow to every model-step check, so the
  // signer boundary names it too.
  const signer = data.matrix.preflight_primitives.find((item) => item.capability === "security.signer_boundary");
  assert.ok(signer.elements.some((element) => element.owner === 34 && element.surface === "dispatch gate before any model launch"));
  assert.ok(record(data, 18).dependencies.includes(11));
  record(data, 18).dependencies = record(data, 18).dependencies.filter((item) => item !== 11);
  assert.match(primitiveErrors(data), /issue #18 must depend on #11 by the canonical roadmap/u);
  const wrong = fixture();
  wrong.matrix.preflight_primitives.find((item) => item.capability === "daemon.capabilities_pinned").decision = "ADR-090";
  assert.match(primitiveErrors(wrong), /`daemon\.capabilities_pinned` is the preflight's ADR-097 primitive/u);
});

test("the session token and the resume leaves have v1 owners inside the inventory", () => {
  // R7-9: `AUTOSK_SESSION_TOKEN` in the model's environment and the resume
  // leaves written by plain `autosk metadata set` were carried to #231, which
  // is outside #3–#39.
  const data = fixture();
  const surfaces = (capability) => data.matrix.preflight_primitives
    .find((item) => item.capability === capability).elements.map((element) => `${element.owner}:${element.surface}`);
  assert.ok(surfaces("task.creation-binding").includes("11:session token kept out of the model environment"));
  assert.ok(surfaces("workflow.custody").includes("18:resume leaves under metadata CAS"));
  assert.match(record(data, 11).implementation_obligation_before_mvp, /`AUTOSK_SESSION_TOKEN`/u);
  assert.match(record(data, 18).implementation_obligation_before_mvp, /`park\.receipts\.<step>`/u);
  for (const issue of [11, 18]) assert.match(record(data, issue).implementation_obligation_before_mvp, /#231/u, `#${issue}`);
  // 02 §2 says a model session holds no CLI or decision capability; it now
  // says the pinned series does not do that yet, and who carries the change.
  const architecture = readFileSync(path.join(ROOT, "02-architecture.md"), "utf8");
  const pi = architecture.slice(architecture.indexOf("### Pi-провайдеры"), architecture.indexOf("### Git"));
  assert.match(pi, /`AUTOSK_SESSION_TOKEN`/u);
  assert.match(pi, /`autosk metadata set`/u);
  assert.match(pi, /#11[^\n]*#18[^\n]*ADR-097/u);
});

test("the enforcement points are read from the graph, not restated", () => {
  const names = enforcementRequirements(GRAPH_DOCUMENT).map((want) => want.point);
  assert.deepEqual(names, ["graph.arena-runtime", "graph.guard-authority", "graph.predicate-evaluation", "graph.workflow-registration"]);
  const byName = new Map(enforcementRequirements(GRAPH_DOCUMENT).map((want) => [want.point, want]));
  assert.deepEqual(byName.get("graph.workflow-registration").workflows, GRAPH_DOCUMENT.workflows.map((entry) => entry.name));
  // Review of 11c (L2): Arena's runtime is a point of its own, read from the
  // Arena workflows the graph registers; a graph without them needs none.
  assert.deepEqual(byName.get("graph.arena-runtime").workflows, ["autosk-arena-candidate", "autosk-arena-judge"]);
  const noArena = structuredClone(GRAPH_DOCUMENT);
  noArena.workflows = noArena.workflows.filter((entry) => !entry.name.startsWith("autosk-arena-"));
  assert.ok(!enforcementRequirements(noArena).some((want) => want.point === "graph.arena-runtime"));
  // A graph whose guards are all the agent's needs no authority evaluator; one
  // with no predicates needs no predicate evaluator; one with no workflows
  // registers nothing.
  const agentOnly = structuredClone(GRAPH_DOCUMENT);
  for (const guard of agentOnly.guards) guard.authority = { actor: "agent" };
  assert.ok(!enforcementRequirements(agentOnly).some((want) => want.point === "graph.guard-authority"));
  const bare = { ...structuredClone(GRAPH_DOCUMENT), predicates: [], workflows: [] };
  assert.deepEqual(enforcementRequirements(bare).map((want) => want.point).filter((point) => point !== "graph.guard-authority"), []);
  assert.doesNotThrow(() => enforcementRequirements(null));
  assert.deepEqual(enforcementRequirements(null), []);
});

test("every enforcement point the graph requires is carried by a required_for_v1 record", () => {
  // R7-10: no product code evaluates the graph's predicates or
  // `guards[].authority`, and no record owned the evaluator or the extension
  // entry point that registers the workflows.
  const data = fixture();
  assert.ok(Array.isArray(data.matrix.enforcement_points), "the matrix names the enforcement points");
  assert.deepEqual(data.matrix.enforcement_points.map((entry) => entry.point),
    enforcementRequirements(GRAPH_DOCUMENT).map((want) => want.point));
  for (const entry of data.matrix.enforcement_points) {
    assert.deepEqual(entry.owner_issues, [18], entry.point);
    assert.match(record(data, 18).implementation_obligation_before_mvp, new RegExp(`\`${entry.point.replaceAll(".", "\\.")}\``, "u"));
  }
  const removed = fixture();
  removed.matrix.enforcement_points = removed.matrix.enforcement_points.filter((entry) => entry.point !== "graph.guard-authority");
  assert.match(primitiveErrors(removed), /`graph\.guard-authority` is required by the v1 graph and carried by no required_for_v1 record/u);
  const later = fixture();
  later.matrix.enforcement_points.find((entry) => entry.point === "graph.predicate-evaluation").owner_issues = [38];
  assert.match(primitiveErrors(later), /`graph\.predicate-evaluation` is carried by #38, which is planned_after_v1/u);
  const extra = fixture();
  extra.matrix.enforcement_points.push({ ...structuredClone(extra.matrix.enforcement_points[0]), point: "graph.imaginary" });
  assert.match(primitiveErrors(extra), /`graph\.imaginary` is not required by the v1 graph/u);
  const decision = fixture();
  decision.matrix.enforcement_points.find((entry) => entry.point === "graph.guard-authority").decision = "ADR-082";
  assert.match(primitiveErrors(decision), /`graph\.guard-authority` is the graph's ADR-091 enforcement point/u);
  const source = fixture();
  source.matrix.enforcement_points.find((entry) => entry.point === "graph.guard-authority").source = "graph_predicates";
  assert.match(primitiveErrors(source), /`graph\.guard-authority` is read from graph_guard_authority/u);
  const unnamed = fixture();
  const owner = record(unnamed, 18);
  owner.implementation_obligation_before_mvp = owner.implementation_obligation_before_mvp.replaceAll("`graph.predicate-evaluation`", "predicates");
  assert.match(primitiveErrors(unnamed), /#18 carries `graph\.predicate-evaluation` but its implementation_obligation_before_mvp does not name it/u);
  const surface = fixture();
  surface.matrix.enforcement_points.find((entry) => entry.point === "graph.guard-authority").elements[0].surface = "imaginary surface";
  assert.match(primitiveErrors(surface), /surface "imaginary surface" of `graph\.guard-authority` is not named in #18's implementation_obligation_before_mvp/u);
  const order = fixture();
  order.matrix.enforcement_points.reverse();
  assert.match(primitiveErrors(order), /enforcement_points must be sorted by point/u);
});

test("a required_for_v1 record whose obligation claims an enforcement point is among its owners, and owns a surface of it", () => {
  const claiming = fixture();
  record(claiming, 34).implementation_obligation_before_mvp += " It also claims `graph.guard-authority`.";
  assert.match(primitiveErrors(claiming), /#34 names `graph\.guard-authority` in its implementation obligation but is not among its owners/u);
  const none = fixture();
  none.matrix.enforcement_points.find((entry) => entry.point === "graph.predicate-evaluation").elements = [];
  assert.match(primitiveErrors(none), /#18 carries `graph\.predicate-evaluation` but owns none of its surfaces/u);
  const stranger = fixture();
  stranger.matrix.enforcement_points.find((entry) => entry.point === "graph.workflow-registration").elements[0].owner = 34;
  assert.match(primitiveErrors(stranger), /is owned by #34, which is not among the owners of `graph\.workflow-registration`/u);
});

test("the enforcement requirement is read from the graph the validation is given", () => {
  // Not restated: a workflow the graph registers later is one the registration
  // owner must name before the matrix validates again.
  const data = fixture();
  const graph = structuredClone(GRAPH_DOCUMENT);
  graph.workflows.push({ name: "autosk-imaginary", first_step: "intake" });
  const expected = /#18 registers the graph's workflows but its implementation_obligation_before_mvp does not name `autosk-imaginary`/u;
  assert.match(messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry, graph)), expected);
  assert.match(messages(validateAll({ ...data, graph })), expected);
  assert.deepEqual(validateMatrix(data.matrix, data.inventory, data.parityRegistry, GRAPH_DOCUMENT), []);
  // A graph whose guards all name the agent needs no authority evaluator, and
  // the matrix naming one anyway names what the graph does not require.
  const agentOnly = structuredClone(GRAPH_DOCUMENT);
  for (const guard of agentOnly.guards) guard.authority = { actor: "agent" };
  assert.match(messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry, agentOnly)), /`graph\.guard-authority` is not required by the v1 graph/u);
});

test("the registration point's owner names every workflow the graph registers", () => {
  // R7-13: the graph registers `autosk-arena-candidate` and
  // `autosk-arena-judge`, and no v1 obligation named Arena.
  const data = fixture();
  const owner = record(data, 18);
  for (const { name } of GRAPH_DOCUMENT.workflows) assert.ok(owner.implementation_obligation_before_mvp.includes(`\`${name}\``), name);
  owner.implementation_obligation_before_mvp = owner.implementation_obligation_before_mvp.replace("`autosk-arena-judge`", "the judge");
  assert.match(primitiveErrors(data), /#18 registers the graph's workflows but its implementation_obligation_before_mvp does not name `autosk-arena-judge`/u);
});

test("malformed enforcement points return errors instead of throwing", () => {
  for (const malformed of [undefined, null, "x", [null], [{ point: "graph.guard-authority" }], [{ point: 7 }]]) {
    const data = fixture();
    if (malformed === undefined) delete data.matrix.enforcement_points;
    else data.matrix.enforcement_points = malformed;
    assert.doesNotThrow(() => validateMatrix(data.matrix, data.inventory, data.parityRegistry));
    assert.doesNotThrow(() => validateAll(data));
    assert.notDeepEqual(validateMatrix(data.matrix, data.inventory, data.parityRegistry), []);
  }
});

test("the matrix schema requires the enforcement points in a closed shape, and the summary lists them", () => {
  const schema = JSON.parse(readFileSync(path.join(ROOT, "resources/program-capabilities/matrix.schema.json"), "utf8"));
  assert.ok(schema.required.includes("enforcement_points"));
  const entry = schema.$defs.enforcementPoint;
  assert.equal(entry.additionalProperties, false);
  assert.deepEqual([...entry.required].sort(), ["decision", "delivery", "elements", "owner_issues", "point", "source"]);
  assert.deepEqual(entry.properties.source.enum, ["graph_guard_authority", "graph_predicates", "graph_workflows"]);
  const data = fixture();
  for (const point of data.matrix.enforcement_points) {
    assert.match(data.documentation, new RegExp(`\\| \`${point.point.replaceAll(".", "\\.")}\` \\|`, "u"));
  }
});

test("the guard-authority evaluator's owner depends on the record that verifies the authority it reads", () => {
  const data = fixture();
  assert.ok(record(data, 18).dependencies.includes(4));
  record(data, 18).dependencies = record(data, 18).dependencies.filter((item) => item !== 4);
  assert.match(primitiveErrors(data), /issue #18 must depend on #4 by the canonical roadmap/u);
});

test("Arena has one owner: its contract, the parity registry and the matrix name the same required_for_v1 record", () => {
  const data = fixture();
  const contracts = readContracts();
  assert.deepEqual(validateAll({ ...data, contracts }), []);
  const arena = contracts.find((entry) => entry.path === "docs/contracts/arena.md");
  assert.match(arena.text, /^Status: issue #18 runtime contract\./mu);
  for (const source of data.parityRegistry.sources.filter((item) => item.id.startsWith("protocol.arena."))) {
    assert.deepEqual(source.autoskTarget.issueRefs, [18], source.id);
  }
  // Review of 11c (L2): the matrix's owner is the structured entry's, held by
  // the shared ownership rule, not whichever obligation mentions Arena.
  const runtime = data.matrix.enforcement_points.find((item) => item.point === "graph.arena-runtime");
  assert.deepEqual(runtime.owner_issues, [18]);
  const otherContract = contracts.map((entry) => entry.path === "docs/contracts/arena.md"
    ? { ...entry, text: entry.text.replace("Status: issue #18", "Status: issue #4") } : entry);
  assert.match(messages(validateAll({ ...data, contracts: otherContract })), /Arena: docs\/contracts\/arena\.md names #4, the parity registry #18, the matrix #18/u);
  const parity = fixture();
  parity.parityRegistry.sources.find((item) => item.id === "protocol.arena.judge-brief").autoskTarget.issueRefs = [14, 18];
  assert.match(messages(validateAll({ ...parity, contracts })), /Arena: .*the parity registry #14, #18/u);
  const two = fixture();
  two.matrix.enforcement_points.find((item) => item.point === "graph.arena-runtime").owner_issues = [14, 18];
  assert.match(messages(validateAll({ ...two, contracts })), /Arena: .*the matrix #14, #18/u);
  // v1, as the README's goal and the graph's two Arena workflows say: the
  // README's matrix section names the owner and the reason.
  assert.match(data.readme, /^- Arena\/Judge для отмеченных конкурирующих решений;$/mu);
  for (const name of ["autosk-arena-candidate", "autosk-arena-judge"]) {
    assert.ok(GRAPH_DOCUMENT.workflows.some((entry) => entry.name === name), name);
    assert.ok(data.readme.includes(`\`${name}\``), name);
  }
  assert.match(data.readme, /Arena\/Judge входит в v1 и её runtime тоже несёт #18/u);
});

test("the design gate's record names no seat outside the gate roster", () => {
  // R7-27: #39's verification_expectation still named a Kimi seat.
  const data = fixture();
  const text = record(data, 39).verification_expectation;
  // The roster is `required_panel` of the design candidate; the record points
  // at it rather than restating a family list that can go stale.
  assert.doesNotMatch(text, /Kimi|GPT|Grok|Opus/u);
  assert.match(text, /`required_panel`/u);
});

test("ADR-023's daemon side is named where its v1 owners are, not as #40 work only", () => {
  // R7-20: 01 §2 and human-decision.md named ADR-023 as #40's.
  const core = readFileSync(path.join(ROOT, "01-core-flows.md"), "utf8");
  assert.doesNotMatch(core, /обязательство ADR-023 \(#40\)/u);
  assert.doesNotMatch(core, /обязательство реализации \(#40\)/u);
  const decision = readFileSync(path.join(ROOT, "docs/contracts/human-decision.md"), "utf8");
  assert.doesNotMatch(decision, /ADR-023, #40 phase 2\/3/u);
  const code = readFileSync(path.join(ROOT, "src/host/user-decision.mjs"), "utf8");
  assert.doesNotMatch(code, /ADR-023 implementation work \(#40/u);
  for (const text of [decision, code]) assert.match(text, /#4\b/u);
});

test("the calls before a model launch are stated with their v1 owners, not as #40's", () => {
  // R7-11: 01 §2, 02 §3 and §5, doctor-report.md and creation-grant.md gave the
  // call at extension load and the call before a model launch to #40, or said
  // `requireDaemonCapabilities` had no caller.
  const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");
  const core = read("01-core-flows.md");
  const architecture = read("02-architecture.md");
  const doctor = read("docs/contracts/doctor-report.md");
  const grant = read("docs/contracts/creation-grant.md");
  assert.doesNotMatch(architecture, /the call at extension load, before any model launch, is implementation work \(#40\)/u);
  assert.doesNotMatch(architecture, /тоже обязательство реализации: сегодня его не вызывает ни один путь запуска/u);
  assert.doesNotMatch(doctor, /\(#40\)/u);
  assert.doesNotMatch(grant, /It has \*\*no caller\*\* outside its own test/u);
  // Review of 11c (M2): the call at extension load is the entry point's (#18);
  // the function and what it checks stay #11's.
  assert.match(core, /Gate перед model launch, который держит workflow к его набору, в матрице v1 несёт #34, вызов `requireDaemonCapabilities` при загрузке расширения — точка входа #18, а саму функцию и то, что она проверяет, — #11 \(ADR-097\)/u);
  assert.match(architecture, /— в матрице v1 место этого вызова — точка входа расширения #18, а функцию и то, что она проверяет, несёт #11 \(ADR-097\)/u);
  assert.match(architecture, /is #34's in matrix v1, the `requireDaemonCapabilities` call at extension load is the extension entry point's \(#18\), and the function and what it checks are #11's \(ADR-097\)/u);
  assert.match(doctor, /The second caller, the dispatch gate that holds a workflow to its set before any model launch, is this issue's in matrix v1 \(ADR-097\)/u);
  assert.match(doctor, /The call at extension load is the extension entry point's \(#18\), and what it checks is #11's/u);
  assert.match(grant, /Outside tests, its one caller is the doctor's `daemon\.capabilities_pinned` check \(ADR-097\)/u);
  for (const text of [core, architecture, doctor]) assert.match(text, /`daemon\.capabilities_pinned`/u);
});

// Review of 11c (three Medium, seven Low): #18 owns the evaluator mechanism
// and not each predicate's meaning (M1); the load-time call is #18's and #4's
// end-to-end proof closes under #36 (M2); Arena is verified and exercised (M3);
// Arena's owner is structured and its check fails closed (L2); the matrix
// states obligations, not progress (L4); ADR-091 names who carries it (L5).
import { arenaOwnerErrors } from "../scripts/validate-program-capability-matrix.mjs";

test("#18 owns the evaluator mechanism, and each predicate's meaning is its domain owner's, derived from the graph (R8-8)", () => {
  const data = fixture();
  const text = record(data, 18).implementation_obligation_before_mvp;
  assert.match(text, /never a constant evaluator/u);
  // The three sentences this test used to match (ref custody with #5, foreign
  // target movement with #9, review and finding with #16) are now the graph's
  // own predicates, each with the domain that names its owner (R8-8, ADR-107):
  // the prose examples are gone and the derived check covers them.
  assert.doesNotMatch(text, /the ref-custody predicates with #5/u);
  assert.match(text, /`predicate_domains`/u);
  const ownerOf = (id) => {
    const domain = GRAPH_DOCUMENT.predicates.find((entry) => entry.id === id).domain;
    return data.matrix.predicate_domains.find((entry) => entry.domain === domain).owner_issues;
  };
  assert.deepEqual(ownerOf("cond_002"), [5], "ref custody drift is #5's");
  assert.deepEqual(ownerOf("cond_446"), [9], "foreign target movement at integrate_staging is #9's");
  assert.deepEqual(ownerOf("cond_457"), [9], "the resume after foreign target movement is #9's");
  assert.deepEqual(ownerOf("cond_106"), [16], "a contest is #16's");
  assert.deepEqual(ownerOf("cond_001"), [4], "`classification is valid` is #4's");
  const point = data.matrix.enforcement_points.find((item) => item.point === "graph.predicate-evaluation");
  assert.deepEqual(point.elements, [{ surface: "table from each predicate id to its implementation", owner: 18 }]);
  assert.match(point.delivery, /`predicate_domains`/u);
  const decisions = readFileSync(path.join(ROOT, "04-decisions.md"), "utf8");
  const adr = decisions.slice(decisions.indexOf("## ADR-097"), decisions.indexOf("## ADR-098"));
  assert.match(adr, /смысл каждого предиката остаётся за модулем записи его домена/u);
  // The justification is not circular: expanded in place, the coordinator's
  // decision under the owner's delegation, reviewed by round 8's full panel.
  assert.doesNotMatch(adr, /Альтернатива 1: новая задача для точки входа расширения/u);
  assert.match(adr, /«рекомендуемый вариант выбираешь сам»/u);
  assert.match(adr, /полная панель раунда 8/u);
});

test("#4's end-to-end proof closes under #36 after #18's guard authority evaluator, and the gate refusal stays #4's", () => {
  const data = fixture();
  const text = record(data, 4).verification_expectation;
  assert.match(text, /^Unit tests prove each alignment gate refuses/u);
  assert.match(text, /under #36, after #18's guard authority evaluator/u);
  assert.doesNotMatch(text, /^E2E proves/u);
});

test("Arena is verified by #18's tests and exercised by #36's end-to-end flows", () => {
  const data = fixture();
  const own = record(data, 18).verification_expectation;
  assert.match(own, /an Arena run/u);
  for (const name of ["autosk-arena-candidate", "autosk-arena-judge"]) assert.ok(own.includes(`\`${name}\``), name);
  assert.match(record(data, 36).implementation_obligation_before_mvp, /Planned\/Quick\/Arena\/multi-project\/fault matrix/u);
  const cleanRoom = readFileSync(path.join(ROOT, "docs/contracts/clean-room-e2e.md"), "utf8");
  const mustRun = cleanRoom.slice(cleanRoom.indexOf("## 3. What must run"), cleanRoom.indexOf("## 4. "));
  assert.match(mustRun, /Arena/u);
  assert.match(mustRun, /`autosk-arena-candidate`/u);
});

test("Arena's owner is a structured entry, and every leg of the check fails closed", () => {
  const contracts = readContracts();
  const data = fixture();
  const entry = data.matrix.enforcement_points.find((item) => item.point === "graph.arena-runtime");
  assert.ok(entry, "Arena's runtime is an enforcement point");
  assert.deepEqual(entry.owner_issues, [18]);
  assert.equal(entry.source, "graph_workflows");
  assert.equal(entry.decision, "ADR-077");
  assert.match(record(data, 18).implementation_obligation_before_mvp, /`graph\.arena-runtime`/u);
  assert.deepEqual(arenaOwnerErrors({ ...data, contracts }), []);
  // Free text is not ownership: another record naming Arena in prose owns nothing.
  const prose = fixture();
  record(prose, 14).implementation_obligation_before_mvp += " Arena too.";
  assert.deepEqual(arenaOwnerErrors({ ...prose, contracts }), []);
  // One owner: a second owner of the structured entry is refused.
  const two = fixture();
  two.matrix.enforcement_points.find((item) => item.point === "graph.arena-runtime").owner_issues = [14, 18];
  assert.match(messages(arenaOwnerErrors({ ...two, contracts })), /Arena: docs\/contracts\/arena\.md names #18, the parity registry #18, the matrix #14, #18/u);
  // A contract set in which no contract carries the Arena marker is refused, not skipped.
  const unmarked = contracts.map((item) => (item.path === "docs/contracts/arena.md"
    ? { ...item, text: item.text.replace("<!-- arena-contract:v1 -->", "") } : item));
  assert.match(messages(arenaOwnerErrors({ ...data, contracts: unmarked })), /Arena: no contract carries <!-- arena-contract:v1 -->/u);
  assert.match(messages(validateAll({ ...fixture(), contracts: unmarked })), /Arena: no contract carries/u);
  // Every #N on the status line counts, not only "issue #N".
  const extra = contracts.map((item) => (item.path === "docs/contracts/arena.md"
    ? { ...item, text: item.text.replace("Status: issue #18 runtime contract.", "Status: issue #18 runtime contract, with #14.") } : item));
  assert.match(messages(arenaOwnerErrors({ ...data, contracts: extra })), /Arena: docs\/contracts\/arena\.md names #14, #18, the parity registry #18, the matrix #18/u);
  // A parity registry without Arena sources, or a matrix without the entry, names no owner.
  const noParity = fixture();
  noParity.parityRegistry.sources = noParity.parityRegistry.sources.filter((source) => !source.id.startsWith("protocol.arena."));
  assert.match(messages(arenaOwnerErrors({ ...noParity, contracts })), /the parity registry none/u);
  const noEntry = fixture();
  noEntry.matrix.enforcement_points = noEntry.matrix.enforcement_points.filter((item) => item.point !== "graph.arena-runtime");
  assert.match(messages(arenaOwnerErrors({ ...noEntry, contracts })), /the matrix none/u);
});

test("the matrix and its summary state obligations, not current progress", () => {
  // README: the matrix stores no live state. What exists today is measured
  // where it is measured (the panel package, §5), not written into an
  // obligation or a delivery.
  const data = fixture();
  const progress = /\btoday\b|not yet written|no entry point exists|every caller today|сегодня|пока нет/iu;
  const texts = [
    ...data.matrix.records.flatMap((item) => [item.implementation_obligation_before_mvp, item.verification_expectation, item.design_obligation_before_issue_39]),
    ...data.matrix.preflight_primitives.map((item) => item.delivery),
    ...data.matrix.enforcement_points.map((item) => item.delivery),
  ];
  for (const text of texts) assert.doesNotMatch(text, progress, text);
  assert.doesNotMatch(data.documentation, progress);
  const factory = readFileSync(path.join(ROOT, "docs/contracts/workflow-factory.md"), "utf8");
  const authority = factory.slice(factory.indexOf("## 1. Authority"), factory.indexOf("## 2. "));
  assert.doesNotMatch(authority, /neither exists yet|every caller of `buildWorkflow`/u);
});

test("ADR-091 names who now carries its signer, key pin and verifier, and gateAdmission's caller", () => {
  const decisions = readFileSync(path.join(ROOT, "04-decisions.md"), "utf8");
  const adr = decisions.slice(decisions.indexOf("## ADR-091"), decisions.indexOf("## ADR-092"));
  assert.match(adr, /^- Изменено ADR-092 и ADR-097: /mu);
  const note = adr.split("\n").find((line) => line.startsWith("- Изменено ADR-092 и ADR-097: "));
  assert.match(note, /#4/u);
  assert.match(note, /`gateAdmission`/u);
  assert.match(note, /#18/u);
});

test("the CLI reads the graph it is given and names a missing one (CodeRabbit on #268)", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const script = fileURLToPath(new URL("../scripts/validate-program-capability-matrix.mjs", import.meta.url));
  const missing = "/nonexistent/workflow-graph.v1.json";
  const refused = spawnSync(process.execPath, [script, "--graph", missing], { encoding: "utf8" });
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, new RegExp(`missing required file: ${missing}`, "u"));
  const graph = fileURLToPath(new URL("../resources/workflow-graph/workflow-graph.v1.json", import.meta.url));
  const accepted = spawnSync(process.execPath, [script, "--graph", graph], { encoding: "utf8" });
  assert.equal(accepted.status, 0, accepted.stderr);
});

// Debt 11f (R7-28, round 7 of #39): README's package list named 2 of the 42
// contracts. It now points to every contract in docs/contracts/, and this
// validator, which already reads README and every contract, holds the list to
// the directory both ways.

test("README's package list points to every contract in docs/contracts/, and to nothing else", async () => {
  const capabilities = await import("../scripts/validate-program-capability-matrix.mjs");
  const contracts = readContracts();
  const readme = readFileSync(README_PATH, "utf8");
  assert.deepEqual(capabilities.readmeContractErrors(readme, contracts), []);
  const listed = readme.slice(readme.indexOf("## Состав пакета"), readme.indexOf("\n## ", readme.indexOf("## Состав пакета") + 1));
  for (const contract of contracts) assert.ok(listed.includes(`](${contract.path})`), contract.path);
  // A contract the list leaves out is refused, even when README links it in another section.
  const dropped = readme.replace("](docs/contracts/arena.md)", "](docs/arena.md)");
  assert.match(messages(capabilities.readmeContractErrors(dropped, contracts)), /README package list omits docs\/contracts\/arena\.md/u);
  const elsewhere = dropped.replace("## Граница текущей работы\n", "## Граница текущей работы\n\nСм. [arena](docs/contracts/arena.md).\n");
  assert.notEqual(elsewhere, dropped);
  assert.match(messages(capabilities.readmeContractErrors(elsewhere, contracts)), /README package list omits docs\/contracts\/arena\.md/u);
  // A link to a contract that is not in the directory is refused.
  const extra = readme.replace("## Состав пакета\n", "## Состав пакета\n\n- [gone](docs/contracts/no-such-contract.md)\n");
  assert.match(messages(capabilities.readmeContractErrors(extra, contracts)), /README package list names docs\/contracts\/no-such-contract\.md, which is not a contract in docs\/contracts\//u);
  // No list at all is refused rather than read as empty.
  assert.match(messages(capabilities.readmeContractErrors(readme.replace("## Состав пакета", "## Пакет"), contracts)), /README has no package list/u);
  // The CLI's validation runs it whenever it is given the contracts.
  assert.match(messages(validateAll({ ...fixture(), contracts, readme: dropped })), /README package list omits docs\/contracts\/arena\.md/u);
  assert.deepEqual(validateAll({ ...fixture(), contracts }), []);
});

// Debt 12a (round 8 of #39, R8-1, R8-13, R8-14): model processes run under the
// model account the privileged install creates (ADR-102). Every model workflow
// requires the check that proves it, so the matrix names who carries it, as
// it does every model-step check. R8-14: #34 owns the dispatch gate before any
// model launch and #18 owns model launch, and no edge joined them. #18 → #34
// is a cycle — #34's doctor checks the provider, clearance and evidence state
// that #19, #20, #26 and #27 build on #18 — so the gate's call before each
// launch is #18's own surface, and the edge is #34 → #18.

test("the model account check is carried by #11, #13, #18 and #34 (R8-1)", () => {
  assert.ok(MODEL_STEP_CHECKS.includes("security.model_account"));
  assert.equal(preflightRequirements().find((want) => want.capability === "security.model_account")?.decision, "ADR-102");
  const data = fixture();
  const entry = data.matrix.preflight_primitives.find((item) => item.capability === "security.model_account");
  assert.ok(entry, "the matrix names who carries the model account check");
  assert.equal(entry.requirement, "model_step_check");
  assert.equal(entry.decision, "ADR-102");
  assert.deepEqual(entry.owner_issues, [11, 13, 18, 34]);
  assert.deepEqual(entry.elements.map((element) => `${element.owner}:${element.surface}`), [
    "11:model process environment",
    "13:model account and its launch mechanism",
    "13:model account probe",
    "18:model launch under the model account",
    "18:model launch only through the dispatch gate",
    "34:dispatch gate before any model launch",
  ]);
  assert.equal(primitiveErrors(data), "");
  const wrong = fixture();
  wrong.matrix.preflight_primitives.find((item) => item.capability === "security.model_account").decision = "ADR-095";
  assert.match(primitiveErrors(wrong), /`security\.model_account` is the preflight's ADR-102 primitive/u);
  const dropped = fixture();
  dropped.matrix.preflight_primitives = dropped.matrix.preflight_primitives.filter((item) => item.capability !== "security.model_account");
  assert.match(primitiveErrors(dropped), /`security\.model_account` is required by the v1 preflight and carried by no required_for_v1 record/u);
  for (const issue of [11, 13, 18, 34]) {
    assert.match(record(data, issue).implementation_obligation_before_mvp, /`security\.model_account`/u, `#${issue}`);
  }
  assert.match(record(data, 11).implementation_obligation_before_mvp, /`AUTOSK_SESSION_TOKEN`/u);
});

test("#13's obligation names the model account, its launch and both checks, and no longer denies the user's account every Git write (R8-1, R8-13)", () => {
  const data = fixture();
  const text = record(data, 13).implementation_obligation_before_mvp;
  assert.doesNotMatch(text, /no direct write to the project's \.git/u);
  // Fix round 2 (ADR-102): the helper runs as the installing user and the Git
  // directory stays the user's, so #13 owns no service account and no
  // mixed-ownership topology; its privileged install creates the model account
  // alone (was: "no direct write to a protected ref", a 3770 topology and
  // custody-owned paths).
  for (const withdrawn of [/dedicated service account/u, /no direct write to a protected ref/u, /3770/u, /custody-owned/u, /custody owner/u]) {
    assert.doesNotMatch(text, withdrawn);
  }
  for (const phrase of [
    /`autosk-model`/u,
    /never a setuid binary of this project/u,
    /`security\.ref_custody`/u,
    /`ref_custody_unavailable`/u,
    /`autosk-flow-ref-custody` as a process of the installing user/u,
    /closes the project's Git directory to every other account/u,
    /The privileged install, an administrator step, creates only the model account and its launch mechanism/u,
  ]) {
    assert.match(text, phrase);
  }
  // #5's helper finds what the installing user's own tools do to a protected ref.
  const own5 = record(data, 5).implementation_obligation_before_mvp;
  assert.match(own5, /runs as the installing user/u);
  assert.match(own5, /never overwrite or adopt it/u);
  assert.match(own5, /`--no-replace-objects`/u);
  assert.match(record(data, 5).verification_expectation, /moved or packed by the installing user's own tool/u);
  assert.match(record(data, 34).implementation_obligation_before_mvp, /the probe of #13 with #5 decides it/u);
});

test("the dispatch gate precedes model launch inside #18's launch path, and the matrix orders #34 after #18 (R8-14)", () => {
  const data = fixture();
  assert.ok(record(data, 34).dependencies.includes(18), "#34 depends on #18");
  assert.ok(record(data, 18).downstream_blockers.includes(34));
  assert.ok(!record(data, 18).dependencies.includes(34));
  const without = fixture();
  record(without, 34).dependencies = record(without, 34).dependencies.filter((item) => item !== 18);
  record(without, 18).downstream_blockers = record(without, 18).downstream_blockers.filter((item) => item !== 34);
  assert.match(primitiveErrors(without), /issue #34 must depend on #18 by the canonical roadmap/u);
  // The other direction is not open: #34 reaches #18 through #19 even without
  // the direct edge, so an edge #18 → #34 is a cycle the matrix refuses.
  const forward = fixture();
  record(forward, 34).dependencies = record(forward, 34).dependencies.filter((item) => item !== 18);
  record(forward, 18).downstream_blockers = record(forward, 18).downstream_blockers.filter((item) => item !== 34);
  record(forward, 18).dependencies = [...record(forward, 18).dependencies, 34].sort((a, b) => a - b);
  record(forward, 34).downstream_blockers = [...record(forward, 34).downstream_blockers, 18].sort((a, b) => a - b);
  assert.match(primitiveErrors(forward), /dependency cycle: #18 -> #34 -> #19 -> #18/u);
  // So the gate's call before each launch is #18's, on every model-step check,
  // beside #34's gate: no launch ships without it.
  for (const capability of MODEL_STEP_CHECKS) {
    const entry = data.matrix.preflight_primitives.find((item) => item.capability === capability);
    const surfaces = entry.elements.map((element) => `${element.owner}:${element.surface}`);
    assert.ok(surfaces.includes("18:model launch only through the dispatch gate"), `${capability}: ${surfaces.join("; ")}`);
    assert.ok(surfaces.includes("34:dispatch gate before any model launch"), capability);
    assert.ok(entry.owner_issues.includes(18), capability);
  }
  const own18 = record(data, 18).implementation_obligation_before_mvp;
  assert.match(own18, /model launch only through the dispatch gate/u);
  assert.match(own18, /`security\.signer_boundary`/u);
  assert.match(record(data, 34).implementation_obligation_before_mvp, /the call before each launch sits in #18's launch path/u);
});

test("the documents name the model account check and where the gate is called (R8-1, R8-14)", () => {
  const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");
  const core = read("01-core-flows.md");
  const architecture = read("02-architecture.md");
  const doctor = read("docs/contracts/doctor-report.md");
  const readme = read("README.md");
  for (const text of [core, architecture, doctor, readme]) assert.match(text, /`security\.model_account`/u);
  assert.match(core, /вызов gate'а перед каждым model launch — путь запуска #18 \(ADR-102\)/u);
  assert.match(architecture, /the gate's call before each model launch is the launch path's, #18's \(ADR-102\)/u);
  assert.match(doctor, /Its call before each model launch sits in the launch path, #18's, and the matrix orders #34 after #18 \(ADR-102\)/u);
  // Three model-step checks, not two, wherever the documents list them; and
  // the doctor contract names the custody check every workflow requires that
  // reaches a step asking the helper, as the graph derives it — not only the
  // planned Epic's phases (review of 9b65ad3, M1).
  assert.doesNotMatch(doctor, /the model-step checks — `daemon\.capabilities_pinned` and `security\.signer_boundary` —/u);
  assert.match(doctor, /the model-step checks — `daemon\.capabilities_pinned`, `security\.signer_boundary` and `security\.model_account` —/u);
  assert.doesNotMatch(doctor, /which the planning and delivery phases require/u);
  assert.match(doctor, /`security\.ref_custody`, which every workflow that reaches a step asking the ref-custody helper requires — `autosk-planned`, `autosk-quick` and `autosk-ticket`, as the graph derives them \(`CUSTODY_STEP_CHECKS`\) —/u);
  assert.match(core, /Третья такая проверка — `security\.model_account`/u);
  assert.match(readme, /`security\.model_account` — #11, #13, #18 и #34 \(ADR-102\)/u);
  assert.match(readme, /`security\.signer_boundary` — #4, #18 и #34/u);
  const decisions = read("04-decisions.md");
  for (const [adr, next] of [["## ADR-090:", "## ADR-091:"], ["## ADR-097:", "## ADR-098:"]]) {
    const text = decisions.slice(decisions.indexOf(adr), decisions.indexOf(next));
    assert.match(text, /^- Изменено ADR-102: /mu, adr);
  }
});

// Debt 12f (R8-8, ADR-107): every predicate of the graph has an owner, read from
// the graph and held to `required_for_v1` records. Facts are not a partition
// (`task_record` is read by 175 of 433 predicates and means something else in
// each), so the graph's predicate carries a closed `domain` and the matrix
// names one owner per domain, whose obligation names it.
import * as domainCheck from "../scripts/validate-program-capability-matrix.mjs";

const domainsOf = (graph) => new Map([...new Set(graph.predicates.map((entry) => entry.domain))].map((domain) => [domain, graph.predicates.filter((entry) => entry.domain === domain).length]));
const domainErrors = (data, graph = GRAPH_DOCUMENT) => messages(validateMatrix(data.matrix, data.inventory, data.parityRegistry, graph));
const entryOf = (data, domain) => data.matrix.predicate_domains.find((entry) => entry.domain === domain);

test("R8-8: the domains a graph's predicates name are its requirement, read from the graph", () => {
  assert.equal(typeof domainCheck.predicateDomainRequirements, "function");
  const wanted = domainCheck.predicateDomainRequirements(GRAPH_DOCUMENT);
  assert.deepEqual(wanted.domains.map((want) => want.domain), [...domainsOf(GRAPH_DOCUMENT).keys()].sort());
  assert.equal(wanted.domains.reduce((sum, want) => sum + want.predicates, 0), GRAPH_DOCUMENT.predicates.length);
  assert.deepEqual(wanted.unowned, []);
  const bare = structuredClone(GRAPH_DOCUMENT);
  delete bare.predicates[0].domain;
  bare.predicates[1].domain = "";
  assert.deepEqual(domainCheck.predicateDomainRequirements(bare).unowned, [bare.predicates[0].id, bare.predicates[1].id]);
  // A string that is not an id names no domain either (review of 12f, L5): the
  // requirement side holds the same pattern as the matrix side.
  for (const malformed of ["Quick-Classification", "quick classification", "_quick", "quick__classification", "7up"]) {
    const spelled = structuredClone(GRAPH_DOCUMENT);
    spelled.predicates[2].domain = malformed;
    assert.deepEqual(domainCheck.predicateDomainRequirements(spelled).unowned, [spelled.predicates[2].id], malformed);
    assert.ok(!domainCheck.predicateDomainRequirements(spelled).domains.some((want) => want.domain === malformed), malformed);
  }
  assert.doesNotThrow(() => domainCheck.predicateDomainRequirements(null));
  assert.deepEqual(domainCheck.predicateDomainRequirements(null), { domains: [], unowned: [], collisions: [] });
});

test("R8-8: a predicate that names no domain is unowned and fails the capability check", () => {
  const data = fixture();
  const graph = structuredClone(GRAPH_DOCUMENT);
  delete graph.predicates.find((entry) => entry.id === "cond_001").domain;
  assert.match(domainErrors(data, graph), /predicate `cond_001` names no domain, so no record owns what it decides/u);
  const blank = structuredClone(GRAPH_DOCUMENT);
  blank.predicates.find((entry) => entry.id === "cond_001").domain = 7;
  assert.match(domainErrors(data, blank), /predicate `cond_001` names no domain/u);
  assert.match(messages(validateAll({ ...data, graph })), /predicate `cond_001` names no domain/u);
});

test("R8-8: a domain the graph uses is carried by a required_for_v1 record, and the matrix names only the domains it uses", () => {
  const data = fixture();
  const graph = structuredClone(GRAPH_DOCUMENT);
  graph.predicates.find((entry) => entry.id === "cond_001").domain = "imaginary_domain";
  assert.match(domainErrors(data, graph), /`imaginary_domain` is read by 1 predicate of the v1 graph and carried by no required_for_v1 record/u);
  const extra = fixture();
  extra.matrix.predicate_domains.push({ ...structuredClone(extra.matrix.predicate_domains[0]), domain: "zz_imaginary" });
  assert.match(domainErrors(extra), /`zz_imaginary` is not read by any predicate of the v1 graph; the matrix names only what it reads/u);
  const twice = fixture();
  twice.matrix.predicate_domains.push(structuredClone(twice.matrix.predicate_domains.at(-1)));
  assert.match(domainErrors(twice), new RegExp(`\`${twice.matrix.predicate_domains.at(-1).domain}\` is named twice`, "u"));
  const unsorted = fixture();
  unsorted.matrix.predicate_domains.reverse();
  assert.match(domainErrors(unsorted), /matrix predicate_domains must be sorted by domain/u);
});

test("R8-8: a domain has one owner, a required_for_v1 record inside the matrix, and its obligation names the domain", () => {
  const data = fixture();
  assert.deepEqual(domainErrors(data), "");
  for (const entry of data.matrix.predicate_domains) assert.equal(entry.owner_issues.length, 1, entry.domain);
  const post = fixture();
  entryOf(post, "alignment_gates").owner_issues = [38];
  entryOf(post, "alignment_gates").elements[0].owner = 38;
  assert.match(domainErrors(post), /`alignment_gates` is carried by #38, which is planned_after_v1, not required_for_v1/u);
  const outside = fixture();
  entryOf(outside, "alignment_gates").owner_issues = [40];
  assert.match(domainErrors(outside), /predicate_domains\[\d+\]\.owner_issues contains out-of-range issue 40/u);
  const two = fixture();
  entryOf(two, "alignment_gates").owner_issues = [4, 5];
  assert.match(domainErrors(two), /`alignment_gates` has 2 owners; a predicate's meaning is one record's/u);
  const none = fixture();
  entryOf(none, "alignment_gates").owner_issues = [];
  assert.match(domainErrors(none), /`alignment_gates` names no owner issue/u);
  const unnamed = fixture();
  record(unnamed, 4).implementation_obligation_before_mvp = record(unnamed, 4).implementation_obligation_before_mvp.replaceAll("`alignment_gates`", "the alignment predicates");
  assert.match(domainErrors(unnamed), /#4 carries `alignment_gates` but its implementation_obligation_before_mvp does not name it/u);
  const claiming = fixture();
  record(claiming, 34).implementation_obligation_before_mvp += " It also decides the `alignment_gates` predicates.";
  assert.match(domainErrors(claiming), /#34 names `alignment_gates` in its implementation obligation but is not among its owners/u);
  const surface = fixture();
  entryOf(surface, "alignment_gates").elements[0].surface = "imaginary surface";
  assert.match(domainErrors(surface), /surface "imaginary surface" of `alignment_gates` is not named in #4's implementation_obligation_before_mvp/u);
  const decision = fixture();
  entryOf(decision, "alignment_gates").decision = "ADR-097";
  assert.match(domainErrors(decision), /predicate_domains\[\d+\]\.decision must be ADR-107/u);
});

test("R8-8: a post-v1 owner is refused for the predicates of the v1 graph, whose eight workflows are all v1", () => {
  // The graph registers `autosk-planned` … `autosk-arena-judge` and no other
  // workflow, so no predicate of it is a post-v1 workflow's (ADR-090, ADR-097):
  // a post-v1 owner would leave a required_for_v1 predicate owned by a record
  // v1 does not have to build.
  const data = fixture();
  for (const entry of data.matrix.predicate_domains) {
    assert.equal(record(data, entry.owner_issues[0]).lifecycle, "required_for_v1", entry.domain);
  }
  const post = fixture();
  entryOf(post, "arena_runtime").owner_issues = [33];
  entryOf(post, "arena_runtime").elements[0].owner = 33;
  assert.match(domainErrors(post), /`arena_runtime` is carried by #33, which is planned_after_v1, not required_for_v1/u);
});

test("R8-8: generic facts do not collapse onto the record that owns the evaluator", () => {
  const data = fixture();
  const owners = new Map();
  for (const entry of GRAPH_DOCUMENT.predicates) {
    const [issue] = entryOf(data, entry.domain).owner_issues;
    owners.set(issue, (owners.get(issue) ?? 0) + 1);
  }
  // #18 owns the mechanism and four domains' meaning (the chain's unconditional
  // draws, model-step results, child joins, Arena), a minority of the graph.
  const shareOf18 = (owners.get(18) ?? 0) / GRAPH_DOCUMENT.predicates.length;
  assert.ok(shareOf18 < 0.2, `#18 owns ${owners.get(18)} of ${GRAPH_DOCUMENT.predicates.length}`);
  assert.ok(owners.size >= 15, `${owners.size} owners`);
  // `task_record` is read by 175 predicates and is nobody's meaning: the
  // predicates that read it are spread over the owners of what they decide.
  const readers = new Set(GRAPH_DOCUMENT.predicates.filter((entry) => entry.reads.includes("task_record")).map((entry) => entryOf(data, entry.domain).owner_issues[0]));
  assert.ok(readers.size >= 12, `${readers.size} owners read task_record`);
});

test("R8-8: classifier_verdict belongs to the registry classifier's owner, and #18's table meets it there", () => {
  // Debt 12d added the fact for cond_024; CodeRabbit on #277 asked that the
  // production evaluator derive it from the current artifact path. It is read
  // by one predicate, in the domain #14's registry classifier owns, and #14's
  // obligation names the derivation while #18's names the hand-over.
  const data = fixture();
  const readers = GRAPH_DOCUMENT.predicates.filter((entry) => entry.reads.includes("classifier_verdict"));
  assert.deepEqual(readers.map((entry) => [entry.id, entry.domain]), [["cond_024", "artifact_classification"]]);
  const entry = entryOf(data, "artifact_classification");
  assert.deepEqual(entry.owner_issues, [14]);
  assert.ok(entry.elements.some((element) => element.owner === 14 && element.surface.includes("`classifier_verdict`")));
  const owner = record(data, 14).implementation_obligation_before_mvp;
  assert.match(owner, /`classifier_verdict` is derived by the registry classifier from the current artifact path/u);
  assert.match(record(data, 18).implementation_obligation_before_mvp, /never a value the caller supplies/u);
  const stripped = fixture();
  record(stripped, 14).implementation_obligation_before_mvp = record(stripped, 14).implementation_obligation_before_mvp.replaceAll("`classifier_verdict`", "the verdict");
  assert.match(domainErrors(stripped), /surface "[^"]*`classifier_verdict`[^"]*" of `artifact_classification` is not named in #14's implementation_obligation_before_mvp/u);
});

test("R8-8 review L5: the closed shape, the delivery's length and the object check are each refused by name", () => {
  const extra = fixture();
  entryOf(extra, "alignment_gates").owner = 4;
  assert.match(domainErrors(extra), /predicate_domains\[\d+\] keys differ from the closed v1 predicate domain shape/u);
  const short = fixture();
  entryOf(short, "alignment_gates").delivery = "too short";
  assert.match(domainErrors(short), /predicate_domains\[\d+\]\.delivery must contain at least 20 characters/u);
  const notObject = fixture();
  notObject.matrix.predicate_domains.push(null);
  assert.match(domainErrors(notObject), new RegExp(`predicate_domains\\[${notObject.matrix.predicate_domains.length - 1}\\] must be an object`, "u"));
  const notDomain = fixture();
  entryOf(notDomain, "alignment_gates").domain = "Alignment-Gates";
  assert.match(domainErrors(notDomain), /predicate_domains\[\d+\]\.domain must name a domain of the graph's predicates/u);
});

test("R8-8: malformed predicate domains return errors instead of throwing", () => {
  for (const malformed of [undefined, null, "x", [null], [{ domain: "arena" }], [{ domain: 7 }]]) {
    const data = fixture();
    if (malformed === undefined) delete data.matrix.predicate_domains;
    else data.matrix.predicate_domains = malformed;
    assert.doesNotThrow(() => validateMatrix(data.matrix, data.inventory, data.parityRegistry));
    assert.doesNotThrow(() => validateAll(data));
    assert.notDeepEqual(validateMatrix(data.matrix, data.inventory, data.parityRegistry), []);
  }
});

test("R8-8: the matrix schema requires the predicate domains in a closed shape, and the summary lists each with its owner", () => {
  const schema = JSON.parse(readFileSync(path.join(ROOT, "resources/program-capabilities/matrix.schema.json"), "utf8"));
  assert.ok(schema.required.includes("predicate_domains"));
  const entry = schema.$defs.predicateDomain;
  assert.equal(entry.additionalProperties, false);
  assert.deepEqual([...entry.required].sort(), ["decision", "delivery", "domain", "elements", "owner_issues"]);
  const data = fixture();
  for (const item of data.matrix.predicate_domains) {
    assert.match(data.documentation, new RegExp(`\\| \`${item.domain}\` \\| #${item.owner_issues[0]} \\|`, "u"));
  }
});

// Review of 12f (M1, M2, M3, L4): the assignment is held to the contracts that
// name each predicate's owner, and an obligation is held to a closed sentence.
const ownerOfPredicate = (data, id) => entryOf(data, GRAPH_DOCUMENT.predicates.find((entry) => entry.id === id).domain).owner_issues[0];
const domainOfPredicate = (id) => GRAPH_DOCUMENT.predicates.find((entry) => entry.id === id).domain;
const entriesOf = (data, issue) => data.matrix.predicate_domains.filter((entry) => entry.owner_issues.includes(issue));

test("review of 12f M1: no Ticket-set domain names #7, whose contract is execution bases; the join is #18's and the dispatch is #6's", () => {
  const data = fixture();
  assert.ok(!data.matrix.predicate_domains.some((entry) => entry.domain === "ticket_execution"));
  assert.ok(!entriesOf(data, 7).length, "#7 owns no predicate: none reads execution-base state");
  assert.doesNotMatch(record(data, 7).implementation_obligation_before_mvp, /predicate meaning/u);
  // The join-wait pattern is one domain for every join (`child_join`), and the
  // Ticket join and the Ticket's completion are joins and completions.
  for (const id of ["cond_100", "cond_101", "cond_115", "cond_116", "cond_130", "cond_131", "cond_176", "cond_177", "cond_321", "cond_322",
    "cond_255", "cond_256", "cond_257", "cond_259", "cond_260", "cond_422"]) assert.equal(domainOfPredicate(id), "child_join", id);
  assert.equal(domainOfPredicate("cond_246"), "tickets_manifest_validation", "a fresh dispatch reads the validated manifest (tickets-manifest.md §1, §14)");
  assert.equal(ownerOfPredicate(data, "cond_246"), 6);
  assert.equal(ownerOfPredicate(data, "cond_259"), 18);
});

test("review of 12f M2: #25 claims the rebuild operations' predicates in its own contract and obligation, and the invalidation publication is #5's", () => {
  const data = fixture();
  const text = record(data, 25).implementation_obligation_before_mvp;
  // Every step whose edge an `anchor_revision` predicate guards is named by
  // #25's obligation, derived from the graph: a claim the generated sentence
  // alone made was the pattern R8-8 flagged.
  const guards = new Map(GRAPH_DOCUMENT.guards.map((guard) => [guard.id, guard.predicate]));
  const steps = new Set();
  for (const edge of GRAPH_DOCUMENT.transitions) {
    if (edge.guards.some((id) => domainOfPredicate(guards.get(id)) === "anchor_revision")) steps.add(edge.from);
  }
  assert.ok(steps.size >= 8, [...steps].join(", "));
  for (const step of steps) assert.ok(text.includes(`\`${step}\``), `#25's obligation names \`${step}\``);
  for (const operation of ["anchor_rebuild_op", "ticket_repair_op", "rebuild_code_anchor"]) assert.ok(text.includes(`\`${operation}\``), operation);
  // The contract distinguishes "not implemented" from "not owned".
  const contract = readFileSync(path.join(ROOT, "docs/contracts/requirement-revision.md"), "utf8");
  assert.doesNotMatch(contract, /are not claimed here/u);
  assert.match(contract, /their runtime is issue #25's in matrix v1 \(ADR-107\), not implemented yet and not unowned/u);
  assert.match(contract, /Deferred and named: the runtime that executes the stages, the panel dispatcher, and the mechanical rebuild that consumes the impact plan\. Those are `required_for_v1` and owned: the first and the last by #25 \(ADR-107\), the dispatcher by #14/u);
  // The invalidation operation `rebuild_anchor` creates is `epic-planning-ref.md` §10's.
  for (const id of ["cond_189", "cond_196", "cond_197", "cond_198", "cond_199", "cond_200", "cond_201"]) assert.equal(domainOfPredicate(id), "planning_ref_lifecycle", id);
  assert.equal(ownerOfPredicate(data, "cond_189"), 5);
});

test("review of 12f M3: a predicate whose contract names its owner is that owner's", () => {
  const data = fixture();
  const expected = {
    cond_056: ["planning_ref_lifecycle", 5], cond_078: ["planning_ref_lifecycle", 5], // epic-planning-ref.md §5: mismatch before mint
    cond_143: ["planning_ref_lifecycle", 5], // §8: the signer is asked before the atomic PASS; #17 supplies the policy
    cond_438: ["target_integration", 9], cond_439: ["target_integration", 9], // epic-staging.md §5 and §8: acceptance_missing
    cond_316: ["artifact_classification", 14], cond_342: ["artifact_classification", 14], // 01 §1: the classifier is the registry
    cond_405: ["quick_classification", 4],
  };
  for (const [id, [domain, issue]] of Object.entries(expected)) {
    assert.equal(domainOfPredicate(id), domain, id);
    assert.equal(ownerOfPredicate(data, id), issue, id);
  }
  // Nothing belongs to #35's queue as a predicate, so no domain names it.
  assert.ok(!data.matrix.predicate_domains.some((entry) => entry.domain === "acceptance_decision"));
  assert.doesNotMatch(record(data, 35).implementation_obligation_before_mvp, /predicate meaning/u);
  // Routing after a recorded exemption stays with the verdict's owner.
  for (const id of ["cond_343", "cond_344", "cond_335", "cond_336"]) assert.equal(domainOfPredicate(id), "review_findings", id);
});

test("narrow re-review L3: the Ticket workflow's implement → verify edge is decided by #18's result check, not by a Quick trigger", () => {
  const data = fixture();
  const guards = new Map(GRAPH_DOCUMENT.guards.map((guard) => [guard.id, guard.predicate]));
  const edges = GRAPH_DOCUMENT.transitions.filter((edge) => edge.from === "implement" && edge.to === "verify");
  assert.equal(edges.length, 1, "t_413 is the only implement → verify edge, shared by autosk-ticket and autosk-quick");
  for (const id of edges.flatMap((edge) => edge.guards.map((guard) => guards.get(guard)))) {
    assert.equal(domainOfPredicate(id), "model_step_result", id);
    assert.equal(ownerOfPredicate(data, id), 18, id);
  }
  assert.equal(domainOfPredicate("cond_305"), "model_step_result");
  // The Quick trigger is its own predicate, on the edge into the reclassification.
  assert.equal(domainOfPredicate("cond_299"), "quick_classification");
  assert.doesNotMatch(entryOf(data, "quick_classification").delivery, /completion record/u);
});

test("narrow re-review L4: no delivery claims what none of its predicates decides", () => {
  const data = fixture();
  const entry = entryOf(data, "delivery_integration");
  assert.doesNotMatch(entry.delivery, /sign/u, "cond_143 (planning_signing_unavailable) is #5's; none of the seven decides signing");
  const predicates = GRAPH_DOCUMENT.predicates.filter((item) => item.domain === "delivery_integration");
  assert.deepEqual(predicates.map((item) => item.id).sort(), ["cond_435", "cond_436", "cond_437", "cond_451", "cond_452", "cond_453", "cond_458"]);
  for (const item of predicates) assert.doesNotMatch(item.description, /signing|signature/u, item.id);
  // The join's exit that names a Ticket's binding is named where it lives.
  assert.match(entryOf(data, "child_join").delivery, /ticket_join_invalid/u);
});

test("review of 12f L4: an obligation carries the owner's closed sentence, and nothing else claims or disowns a domain", () => {
  assert.equal(typeof domainCheck.ownershipSentence, "function");
  // P8: a negated sentence in place of the owner's is refused.
  const negated = fixture();
  const sentence = domainCheck.ownershipSentence(entriesOf(negated, 4));
  assert.ok(record(negated, 4).implementation_obligation_before_mvp.includes(sentence));
  record(negated, 4).implementation_obligation_before_mvp = record(negated, 4).implementation_obligation_before_mvp.replace(sentence,
    "This issue does NOT own `alignment_gates`; the meaning of the `alignment_gates` predicates are someone else's.");
  assert.match(domainErrors(negated), /#4's implementation_obligation_before_mvp does not carry its ownership sentence/u);
  // The sentence and a disowning line together: the second mention is stray.
  const both = fixture();
  record(both, 4).implementation_obligation_before_mvp += " This issue does NOT own `alignment_gates`.";
  assert.match(domainErrors(both), /#4 names `alignment_gates` in its implementation obligation outside the ownership sentence/u);
  // P9: a claim of a domain neither the graph nor the matrix has.
  for (const claim of [" It also owns the `ghost_domain` predicates.", " It carries predicate domain `ghost_domain`."]) {
    const ghost = fixture();
    record(ghost, 16).implementation_obligation_before_mvp += claim;
    assert.match(domainErrors(ghost), /#16 claims the `ghost_domain` predicates, and the matrix has no such domain/u, claim);
  }
  // A stale claim survives no rename: the domain it names is gone from the matrix.
  const renamed = fixture();
  renamed.matrix.predicate_domains.find((entry) => entry.domain === "loop_caps").domain = "bounded_loops";
  const graph = structuredClone(GRAPH_DOCUMENT);
  for (const predicate of graph.predicates) if (predicate.domain === "loop_caps") predicate.domain = "bounded_loops";
  renamed.matrix.predicate_domains.sort((a, b) => (a.domain < b.domain ? -1 : 1));
  assert.match(domainErrors(renamed, graph), /#32 claims the `loop_caps` predicates, and the matrix has no such domain/u);
  // The sentence is the entry: a delivery that changes without the obligation is drift.
  const drift = fixture();
  entryOf(drift, "alignment_gates").delivery += " and something the owner never wrote";
  assert.match(domainErrors(drift), /#4's implementation_obligation_before_mvp does not carry its ownership sentence/u);
  // A post-v1 record claiming a real domain is a non-owner's claim too.
  const post = fixture();
  record(post, 33).implementation_obligation_before_mvp += " It also decides the `arena_runtime` predicates.";
  assert.match(domainErrors(post), /#33 names `arena_runtime` in its implementation obligation but is not among its owners/u);
});

test("review of 12f L4: a domain is not named like a state fact, so a backticked fact is never a claim", () => {
  // `arena` was both the Arena domain and the fact `cond_031` reads: an
  // obligation that backticked the fact would have been read as a claim.
  const data = fixture();
  const facts = new Set(GRAPH_DOCUMENT.predicates.flatMap((entry) => entry.reads));
  assert.deepEqual(data.matrix.predicate_domains.map((entry) => entry.domain).filter((domain) => facts.has(domain)), []);
  assert.deepEqual(domainCheck.predicateDomainRequirements(GRAPH_DOCUMENT).collisions, []);
  const reads = fixture();
  record(reads, 34).implementation_obligation_before_mvp += " It reads the `arena` fact and the `phase` fact.";
  // Only the digest, which any edit to a record moves, differs: no claim, no stray mention.
  assert.equal(domainErrors(reads).replace(/matrix canonical_digest mismatch: expected [0-9a-f]+/u, ""), "");
  const collide = structuredClone(GRAPH_DOCUMENT);
  for (const predicate of collide.predicates) if (predicate.domain === "arena_runtime") predicate.domain = "arena";
  const renamed = fixture();
  renamed.matrix.predicate_domains.find((entry) => entry.domain === "arena_runtime").domain = "arena";
  renamed.matrix.predicate_domains.sort((a, b) => (a.domain < b.domain ? -1 : 1));
  assert.deepEqual(domainCheck.predicateDomainRequirements(collide).collisions, ["arena"]);
  assert.match(domainErrors(renamed, collide), /domain `arena` is also a name the graph declares; a domain is named by a token no graph name carries/u);
});

test("review of 12f: workflow-graph.md's count of task_record readers is the graph's", () => {
  const readers = GRAPH_DOCUMENT.predicates.filter((entry) => entry.reads.includes("task_record")).length;
  const contract = readFileSync(path.join(ROOT, "docs/contracts/workflow-graph.md"), "utf8");
  assert.ok(contract.includes(`\`task_record\` is read by ${readers} of the shipped graph's ${GRAPH_DOCUMENT.predicates.length} predicates`), `${readers} of ${GRAPH_DOCUMENT.predicates.length}`);
});

// Narrow re-review of 12f (L1, L2, nits): a delivery claims nothing, the collision
// rule reads every name the graph declares, and the sentence has a place.
test("narrow re-review L1: a delivery describes its domain and names no domain, so it cannot carry another owner's claim", () => {
  const other = fixture();
  const before = domainCheck.ownershipSentence(entriesOf(other, 25));
  entryOf(other, "anchor_revision").delivery += ", and the meaning of the `tickets_manifest_validation` predicates";
  record(other, 25).implementation_obligation_before_mvp = record(other, 25).implementation_obligation_before_mvp.replace(before, domainCheck.ownershipSentence(entriesOf(other, 25)));
  assert.match(domainErrors(other), /predicate_domains\[\d+\]\.delivery names domain `tickets_manifest_validation`/u);
  const ghost = fixture();
  const sentence = domainCheck.ownershipSentence(entriesOf(ghost, 25));
  entryOf(ghost, "anchor_revision").delivery += ", and the `ghost_domain` predicates";
  record(ghost, 25).implementation_obligation_before_mvp = record(ghost, 25).implementation_obligation_before_mvp.replace(sentence, domainCheck.ownershipSentence(entriesOf(ghost, 25)));
  assert.match(domainErrors(ghost), /predicate_domains\[\d+\]\.delivery claims the `ghost_domain` predicates, and the matrix has no such domain/u);
  const own = fixture();
  const own25 = domainCheck.ownershipSentence(entriesOf(own, 25));
  entryOf(own, "anchor_revision").delivery += " (the `anchor_revision` predicates)";
  record(own, 25).implementation_obligation_before_mvp = record(own, 25).implementation_obligation_before_mvp.replace(own25, domainCheck.ownershipSentence(entriesOf(own, 25)));
  assert.match(domainErrors(own), /delivery names domain `anchor_revision`/u);
});

test("narrow re-review L2: a domain is not named like anything the graph declares, and not like a name of the repository's vocabulary", () => {
  const data = fixture();
  const spelled = (mutate) => {
    const graph = structuredClone(GRAPH_DOCUMENT);
    mutate(graph);
    return domainCheck.predicateDomainRequirements(graph).collisions;
  };
  assert.deepEqual(domainCheck.predicateDomainRequirements(GRAPH_DOCUMENT).collisions, []);
  const domain = "loop_caps";
  assert.deepEqual(spelled((graph) => graph.steps.push({ name: domain, kind: "agent", no_transition_reason: "x" })), [domain], "a step");
  assert.deepEqual(spelled((graph) => graph.workflows.push({ name: domain, first_step: "intake" })), [domain], "a workflow");
  assert.deepEqual(spelled((graph) => graph.entry_steps.push({ step: domain, reason: "x" })), [domain], "an entry step");
  assert.deepEqual(spelled((graph) => graph.guards[0].park_reason = domain), [domain], "a park reason");
  assert.deepEqual(spelled((graph) => graph.recovery.push({ reason: domain })), [domain], "a recovery reason");
  assert.deepEqual(spelled((graph) => graph.caps[0].cycle = domain), [domain], "a cap");
  assert.deepEqual(spelled((graph) => graph.decision_options.push(domain)), [domain], "a decision option");
  assert.deepEqual(spelled((graph) => graph.predicates[0].reads.push(domain)), [domain], "a fact");
  const graph = structuredClone(GRAPH_DOCUMENT);
  graph.steps.push({ name: domain, kind: "agent", no_transition_reason: "x" });
  assert.match(domainErrors(data, graph), /domain `loop_caps` is also a name the graph declares; a domain is named by a token no graph name carries/u);
  // Prose that uses the vocabulary of contracts and of the graph is not a claim.
  const reads = fixture();
  record(reads, 9).implementation_obligation_before_mvp += " Apply each Ticket's `approved_delta` (docs/contracts/approved-delta.md) to staging.";
  record(reads, 14).implementation_obligation_before_mvp += " A class whose `publication` is `planning_ref` is published on the Epic planning ref.";
  record(reads, 34).implementation_obligation_before_mvp += " The doctor reports a project parked at `authority_recovery`.";
  assert.equal(domainErrors(reads).replace(/matrix canonical_digest mismatch: expected [0-9a-f]+/u, ""), "");
  // The names are checked against the repository's own vocabulary: a backticked
  // token of a document, and a string of a resource, that equals a domain is a
  // collision. Discussion of the domains (the ADR, the log, the generated
  // summary, the matrix and the graph themselves, the panel's history) is exempt.
  const domains = new Set(GRAPH_DOCUMENT.predicates.map((entry) => entry.domain));
  const exempt = new Set(["04-decisions.md", "docs/cloud-agent-priming.md", "docs/program-capability-matrix.md",
    "resources/program-capabilities/matrix.v1.json", "resources/workflow-graph/workflow-graph.v1.json", "resources/program-capabilities/matrix.schema.json"]);
  const found = [];
  const scan = (file) => {
    const relative = path.relative(ROOT, file).split(path.sep).join("/");
    if (exempt.has(relative) || relative.startsWith("resources/design-candidate/")) return;
    const text = readFileSync(file, "utf8");
    const pattern = file.endsWith(".md") ? /`([a-z][a-z0-9_]*)`/gu : /"([a-z][a-z0-9_]*)"/gu;
    for (const match of text.matchAll(pattern)) if (domains.has(match[1])) found.push(`${relative}: ${match[1]}`);
  };
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(md|json)$/u.test(entry.name)) scan(full);
    }
  };
  for (const dir of ["docs", "resources"]) walk(path.join(ROOT, dir));
  for (const file of ["01-core-flows.md", "02-architecture.md", "03-technical-plan.md", "README.md", "CONTRIBUTING.md"]) scan(path.join(ROOT, file));
  assert.deepEqual(found, []);
});

test("narrow re-review nits: the sentence stands at a sentence boundary outside a quotation, once, and claims are read in every form", () => {
  const withSentence = (issue, wrap) => {
    const data = fixture();
    const text = record(data, issue).implementation_obligation_before_mvp;
    const sentence = domainCheck.ownershipSentence(entriesOf(data, issue));
    record(data, issue).implementation_obligation_before_mvp = text.replace(sentence, wrap(sentence));
    return data;
  };
  const carry = /does not carry its ownership sentence/u;
  assert.match(domainErrors(withSentence(6, (sentence) => `It is false that this issue ${sentence} None of it is this issue's.`)), carry, "a negation before it");
  assert.match(domainErrors(withSentence(6, (sentence) => `An earlier draft said "${sentence}" and that draft was withdrawn; #18 decides these.`)), carry, "inside a quotation");
  // After a full stop but still inside an open quotation, straight or curly.
  assert.match(domainErrors(withSentence(6, (sentence) => `The draft read: "Scope. ${sentence}" and it was withdrawn.`)), carry, "inside a quotation after a full stop");
  assert.match(domainErrors(withSentence(6, (sentence) => `The draft read: \u201cScope. ${sentence}\u201d and it was withdrawn.`)), carry, "inside curly quotes");
  assert.equal(domainErrors(withSentence(6, (sentence) => sentence)).replace(/matrix canonical_digest mismatch: expected [0-9a-f]+/u, ""), "", "the shipped position is accepted");
  // Twice: the second is a stray mention.
  const twice = fixture();
  record(twice, 6).implementation_obligation_before_mvp += " " + domainCheck.ownershipSentence(entriesOf(twice, 6));
  assert.match(domainErrors(twice), /#6 names `tickets_manifest_validation` in its implementation obligation outside the ownership sentence/u);
  // Claim phrases in every form the prose uses.
  for (const claim of [" It also owns the predicates of `ghost_domain`.", " It also owns every `ghost_domain` predicate.", " It also owns the domain `ghost_domain`."]) {
    const ghost = fixture();
    record(ghost, 16).implementation_obligation_before_mvp += claim;
    assert.match(domainErrors(ghost), /#16 claims the `ghost_domain` predicates, and the matrix has no such domain/u, claim);
  }
  // A record that owns nothing carries no ownership sentence, backticked or not.
  const stranger = fixture();
  record(stranger, 7).implementation_obligation_before_mvp += " Owns predicate meaning (ADR-107): meaning of the execution base predicates.";
  assert.match(domainErrors(stranger), /#7 carries an ownership sentence but owns no domain/u);
});

test("narrow re-review L5: the §8 entry lists the owners the matrix has", () => {
  const data = fixture();
  const owners = new Set(data.matrix.predicate_domains.flatMap((entry) => entry.owner_issues));
  const log = readFileSync(path.join(ROOT, "docs/cloud-agent-priming.md"), "utf8");
  const start = log.indexOf("- 2026-09-28: debt 12f");
  const entry = log.slice(start, log.indexOf("\n- 20", start + 10) === -1 ? undefined : log.indexOf("\n- 20", start + 10));
  const listed = (marker) => {
    const at = entry.indexOf(marker);
    assert.ok(at >= 0, marker);
    const list = entry.slice(at, at + 300).split(/ —|\)/u)[0];
    return new Set([...list.matchAll(/#(\d+)/gu)].map((match) => Number(match[1])));
  };
  for (const marker of ["(owners #", "GitHub issues (#"]) {
    const found = listed(marker);
    assert.deepEqual([...found].sort((a, b) => a - b), [...owners].sort((a, b) => a - b), marker);
  }
});

test("narrow re-review nits: requirement-revision.md points at the specification of the rebuild and says it once", () => {
  const contract = readFileSync(path.join(ROOT, "docs/contracts/requirement-revision.md"), "utf8");
  assert.doesNotMatch(contract, /not unowned[^\n]*not unowned/u);
  assert.doesNotMatch(contract, /matrix v1 \(ADR-107\):/u, "no double colon");
  assert.match(contract, /The mechanical rebuild is not specified by this contract: `rebuild_anchor` and the operations it drives are specified in `03-technical-plan\.md` §5 \("Contest и anchor changes"\) and by the graph, and their runtime is issue #25's in matrix v1 \(ADR-107\), not implemented yet and not unowned\./u);
});
