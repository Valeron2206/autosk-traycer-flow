/**
 * Tests for the integration authorization contract (#9, #4).
 *
 * The record is the only token that may skip the human stop before the one
 * irreversible step. Every case here is a way it could end up authorizing
 * something nobody signed.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CONTRACT_PATH,
  EXAMPLE_PATH,
  REFUSALS,
  REFUSED_PATH,
  ROOT,
  SCHEMA_PATH,
  planErrors,
  recordRefusals,
  validateDesign,
} from "../scripts/validate-integration-authorization.mjs";
import { validateJsonSchema } from "../scripts/validate-planning-ref-design.mjs";

const NOW = Date.parse("2026-09-09T00:00:00Z");
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");
const files = Object.fromEntries(
  [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, REFUSED_PATH].map((relative) => [relative, read(relative)]),
);
const example = () => JSON.parse(files[EXAMPLE_PATH]);
const reasons = (record, options = {}) =>
  recordRefusals(record, { nowMs: NOW, ...options }).map((entry) => entry.reason);

test("the shipped design validates", () => {
  assert.deepEqual(validateDesign(files), []);
});

test("the worked example is admitted, and the refused one is not", () => {
  const record = example();
  assert.deepEqual(reasons(record, { scopeId: record.scope_id, targetOid: record.initial_target_oid }), []);
  const refused = JSON.parse(files[REFUSED_PATH]);
  const produced = new Set(reasons(refused, { scopeId: "another-scope" }));
  assert.ok(produced.size >= 3, [...produced].join(","));
});

test("an expired record authorizes nothing, including what it once did", () => {
  const record = { ...example(), expires_at: "2026-09-01T00:00:00Z" };
  assert.ok(reasons(record).includes("integration_authorization_expired"));
  // Checked when read, not when signed: a record that was current when the
  // acceptance relied on it and expired before the CAS authorizes nothing.
  assert.ok(reasons(record, { scopeId: record.scope_id, targetOid: record.initial_target_oid })
    .includes("integration_authorization_expired"));
});

test("a record acts only on the branch state it was signed for", () => {
  const record = example();
  // Correct: the branch is still at the recorded base the one transition starts from.
  assert.deepEqual(
    reasons(record, { scopeId: record.scope_id, targetOid: record.ref_transition.from_oid }),
    [],
  );
  // Wrong: the branch has moved on, so this record is about another branch
  // state than the one it would act on, and it does not follow the branch.
  assert.ok(
    reasons(record, { scopeId: record.scope_id, targetOid: "9".repeat(40) })
      .includes("integration_authorization_prefix_mismatch"),
  );
});

test("a policy cannot issue one, and neither can an absence", () => {
  assert.ok(reasons({ ...example(), issued_by: "project_policy" }).includes("integration_authorization_policy_issued"));
  const unsigned = { ...example() };
  delete unsigned.user_decision_record_id;
  assert.ok(reasons(unsigned).includes("integration_authorization_policy_issued"));
});

test("a revoked or replaced record still reads as a record, and authorizes nothing", () => {
  for (const disposition of ["revoked", "replaced"]) {
    assert.ok(reasons({ ...example(), terminal_disposition: disposition })
      .includes("integration_authorization_terminal"), disposition);
  }
});

test("an absent record and a mismatched chain are refusals, not silences", () => {
  // The integrate step asks for a record and there is none: that is the case
  // this refusal exists for, and it must be produced rather than inferred.
  assert.deepEqual(reasons(null), ["integration_authorization_required"]);
  const record = example();
  assert.deepEqual(reasons(record, { authorizationHead: record.previous_authorization_head_hash }), []);
  assert.ok(
    reasons(record, { authorizationHead: "f".repeat(64) }).includes("integration_authorization_head_mismatch"),
  );
});

test("a record from another scope is not found by luck", () => {
  assert.ok(reasons(example(), { scopeId: "another-epic" }).includes("integration_authorization_scope_mismatch"));
});

test("the one transition starts where the record says the branch was", () => {
  const record = example();
  assert.deepEqual(planErrors(record), []);
  const wrongStart = { ...record, ref_transition: { ...record.ref_transition, from_oid: "9".repeat(40) } };
  assert.ok(planErrors(wrongStart).some((message) => /initial_target_oid/u.test(message)));
});

test("a Quick authorization names its Quick task, and an Epic one does not", () => {
  const record = example();
  assert.ok(planErrors({ ...record, epic_id: null }).some((message) => /quick_task_id/u.test(message)));
  const quick = { ...record, epic_id: null, quick_task_id: "ask-a1b2c3", ordered_ticket_commit_oids: [record.ordered_ticket_commit_oids[0]] };
  assert.deepEqual(planErrors(quick), []);
  assert.ok(
    planErrors({ ...record, quick_task_id: "ask-a1b2c3" }).some((message) => /does not also name a Quick task/u.test(message)),
  );
});

test("every refusal class the contract closes can be produced", () => {
  const produced = new Set();
  const record = example();
  for (const entry of reasons({ ...record, expires_at: "2020-01-01T00:00:00Z" })) produced.add(entry);
  for (const entry of reasons({ ...record, terminal_disposition: "revoked" })) produced.add(entry);
  for (const entry of reasons(record, { scopeId: "elsewhere" })) produced.add(entry);
  for (const entry of reasons({ ...record, issued_by: "project_policy" })) produced.add(entry);
  for (const entry of reasons(record, { targetOid: "9".repeat(40) })) produced.add(entry);
  // Absent, and chained from a head that is not the current one.
  for (const entry of reasons(null)) produced.add(entry);
  for (const entry of reasons(record, { authorizationHead: "f".repeat(64) })) produced.add(entry);
  for (const refusal of REFUSALS) {
    assert.ok(produced.has(refusal), `${refusal} is documented and never produced`);
  }
});

// --- one transition, no prefix (debt 9c follow-up, R5-9) -------------------------
//
// The target moves by one CAS — an Epic's from the recorded base to the accepted
// staging commit after aggregate PASS and acceptance, a Quick run's from its base
// to the commit integrating its reviewed candidate — so a record names exactly one
// transition and there is no completed prefix for a later record to continue. A
// record shaped for the per-Ticket order would be a record for an integration the
// design no longer performs, so the schema refuses the shape itself.

const schemaErrors = (record) => validateJsonSchema(record, JSON.parse(files[SCHEMA_PATH]));
const OLD_PLAN = [
  { index: 0, from_oid: "b".repeat(40), to_oid: "c".repeat(40) },
  { index: 1, from_oid: "c".repeat(40), to_oid: "d".repeat(40) },
];

test("a record with two transitions is refused by the schema", () => {
  const listed = { ...example(), ordered_ref_transitions: OLD_PLAN };
  delete listed.ref_transition;
  assert.notDeepEqual(schemaErrors(listed), [], "an ordered list of two transitions is admitted");
  const doubled = { ...example(), ref_transition: OLD_PLAN };
  assert.notDeepEqual(schemaErrors(doubled), [], "two transitions under the one-transition field are admitted");
});

test("a record that starts inside a plan is refused by the schema", () => {
  assert.notDeepEqual(schemaErrors({ ...example(), remaining_start_index: 1 }), []);
});

test("a record carrying a completed-prefix receipt is refused by the schema", () => {
  assert.notDeepEqual(schemaErrors({ ...example(), completed_prefix_receipt_hash: "a".repeat(64) }), []);
});

test("the worked example is one transition from initial_target_oid", () => {
  const record = example();
  const transitions = "ref_transition" in record ? [record.ref_transition] : record.ordered_ref_transitions;
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].from_oid, record.initial_target_oid);
  for (const field of ["ordered_ref_transitions", "remaining_start_index", "completed_prefix_receipt_hash"]) {
    assert.ok(!(field in record), `the worked example carries ${field}`);
  }
  assert.deepEqual(schemaErrors(record), []);
});

test("no candidate document gives the record or the integration state a prefix", () => {
  const said = [];
  const contract = files[CONTRACT_PATH];
  for (const field of ["remaining_start_index", "completed_prefix_receipt_hash", "ordered_ref_transitions"]) {
    if (contract.includes(field)) said.push(`${CONTRACT_PATH} names ${field}`);
  }
  if (/schema still carries/iu.test(contract)) said.push(`${CONTRACT_PATH} defers the one-transition shape`);
  const architecture = read("02-architecture.md");
  for (const line of architecture.split("\n")) {
    if (/integration-state|State file/u.test(line) && /prefix/u.test(line)) said.push(`02-architecture.md: ${line.slice(0, 80)}`);
  }
  const plan = read("03-technical-plan.md");
  const record = plan.split("\n").find((line) => line.startsWith("`integration_authorization` — daemon-owned signed record")) ?? "";
  for (const field of ["remaining_start_index", "completed_prefix_receipt_hash", "ordered_ref_transitions"]) {
    if (record.includes(field)) said.push(`03-technical-plan.md record fields name ${field}`);
  }
  assert.deepEqual(said, []);
});

test("a Quick record names its one reviewed candidate, and its integration commit is fixed before signing", () => {
  // R9c-4. Quick's to_oid is the integration commit the adapter builds; the
  // record can name it only if it is built from a recipe fixed before signing.
  const record = { ...example(), epic_id: null, quick_task_id: "ask-a1b2c3" };
  assert.ok(planErrors(record).some((message) => /one reviewed candidate/u.test(message)), planErrors(record).join("; "));
  assert.deepEqual(planErrors({ ...record, ordered_ticket_commit_oids: [record.ordered_ticket_commit_oids[0]] }), []);
  assert.match(files[CONTRACT_PATH], /before the record is signed/u);
  assert.match(read("03-technical-plan.md"), /до подписи record/u);
});

// Debt 11b (R7-2, R7-15, R7-25, R7-30): the documents say how the record comes
// into being on the person's path, and no document says it is "produced" by an
// acceptance with no mechanism behind the word.
const PROSE = [
  "01-core-flows.md",
  "02-architecture.md",
  "03-technical-plan.md",
  "docs/contracts/epic-staging.md",
  CONTRACT_PATH,
  "resources/workflow-graph/workflow-graph.v1.json",
];

test("no document has the acceptance produce the record with no mechanism behind it (debt 11b, R7-2)", () => {
  const stale = [
    "acceptance человека производит",
    "acceptance decision человека производит",
    "acceptance decision произвёл",
    "произвела acceptance человека",
    "Его производит acceptance decision",
    "чьё acceptance decision производит",
    "acceptance decision produces it",
    "acceptance decision there produces the record",
    "acceptance produces the signed IntegrationAuthorizationRecord",
    "its record is produced by the acceptance itself",
    "The human's path has no host-side authorization check",
  ];
  for (const relative of PROSE) {
    const text = read(relative);
    for (const phrase of stale) assert.equal(text.includes(phrase), false, `${relative}: ${phrase}`);
  }
  // Where the mechanism is stated, it is named.
  const contract = read(CONTRACT_PATH);
  for (const name of ["composeAuthorization", "authorizationPayloadHash", "signed_payload_hash", "acceptanceFromDecision", "integration_authorization_sha256", "ADR-096"]) {
    assert.ok(contract.includes(name), `${CONTRACT_PATH}: ${name}`);
  }
  const staging = read("docs/contracts/epic-staging.md");
  for (const name of ["integration_authorization_id", "integration_authorization_sha256", "signed_payload_hash", "composeAuthorization", "ADR-096"]) {
    assert.ok(staging.includes(name), `epic-staging.md: ${name}`);
  }
  for (const relative of ["01-core-flows.md", "02-architecture.md"]) assert.ok(read(relative).includes("ADR-096"), relative);
  assert.ok(read("docs/contracts/human-decision.md").includes("signed_payload_hash"));
  const graph = JSON.parse(read("resources/workflow-graph/workflow-graph.v1.json"));
  const described = Object.fromEntries(graph.predicates.map((entry) => [entry.id, entry.description]));
  for (const id of ["cond_435", "cond_436"]) assert.match(described[id], /payload подписал UserDecisionRecord/u, id);
  assert.match(described.cond_438, /accept подписывает его payload/u);
  assert.match(described.cond_441, /integration_authorization_head/u);
  assert.match(described.cond_444, /который она называет на обоих путях/u);
});

test("signed in advance means before the acceptance step for that exact identity (debt 11b, R7-15)", () => {
  assert.match(read(CONTRACT_PATH), /"In advance" means before the acceptance step for that exact identity/u);
  assert.match(read("docs/contracts/epic-staging.md"), /"Signed in advance" means before this acceptance step, for this exact identity/u);
  assert.match(read("01-core-flows.md"), /до этого шага — для той же exact identity, то есть после aggregate verification, а не до staging/u);
});

test("an Epic stop has one name, and the contract says which class it stands for (debt 11b, R7-25)", () => {
  const contract = read(CONTRACT_PATH);
  assert.match(contract, /no host code raises an `integration_authorization_\*` class/u);
  for (const short of ["`policy_issued`", "`scope_mismatch`", "`prefix_mismatch`", "`expired`", "`terminal`", "`head_mismatch`"]) {
    assert.ok(contract.includes(short), short);
  }
  // And the disclosure stays true: no runtime file names a class.
  const runtime = readdirSync(path.join(ROOT, "src"), { recursive: true }).filter((name) => name.endsWith(".mjs"));
  for (const file of runtime) {
    const text = read(path.join("src", file));
    for (const refusal of REFUSALS) assert.equal(text.includes(refusal), false, `${file}: ${refusal}`);
  }
});

test("the staging example's acceptance names the worked authorization example (debt 11b)", async () => {
  const { integrationAuthorizationHash } = await import("../src/host/epic-staging.mjs");
  const staging = JSON.parse(read("resources/epic-staging/epic-staging.example.json"));
  const record = example();
  assert.equal(staging.acceptance.integration_authorization_id, record.record_id);
  assert.equal(staging.acceptance.integration_authorization_sha256, integrationAuthorizationHash(record));
  // And the record is that staging record's one transition.
  assert.equal(record.scope_id, `epic:${staging.epic_id}`);
  assert.equal(record.epic_id, staging.epic_id);
  assert.equal(record.project_root_sha256, staging.project_root_sha256);
  assert.equal(record.target_ref, staging.target_ref);
  assert.deepEqual(record.ref_transition, { from_oid: staging.recorded_target_base, to_oid: staging.acceptance.target_commit_oid });
  assert.equal(record.final_tree_oid, staging.staging_tree_oid);
  assert.deepEqual(record.ordered_ticket_commit_oids, staging.receipts.map((receipt) => receipt.applied_commit_oid));
});

test("#9 owns the daemon's check of the record against its head (debt 11b, R7-2)", () => {
  const matrix = JSON.parse(read("resources/program-capabilities/matrix.v1.json"));
  const owner = matrix.records.find((record) => record.issue_number === 9);
  assert.match(owner.implementation_obligation_before_mvp, /IntegrationAuthorizationRecord the acceptance names/u);
  assert.match(owner.implementation_obligation_before_mvp, /integration_authorization_head/u);
});

test("a scope is an Epic's or a Quick run's, as 02 closes it (review L3)", () => {
  const schema = JSON.parse(files[SCHEMA_PATH]);
  assert.deepEqual(validateJsonSchema({ ...example(), scope_id: "epic:epic-0001" }, schema), []);
  assert.deepEqual(validateJsonSchema({ ...example(), scope_id: "quick:ask-0a1b2c" }, schema), []);
  for (const scope of ["epic-0001", "epic:", "task:t-1"]) {
    assert.notDeepEqual(validateJsonSchema({ ...example(), scope_id: scope }, schema), [], scope);
  }
  assert.equal(JSON.parse(files[REFUSED_PATH]).scope_id, "epic:epic-0001");
});

test("the trusted client renders the record whose payload it signs (review M2)", () => {
  const contract = read(CONTRACT_PATH);
  assert.match(contract, /trusted client renders the record whose `authorizationPayloadHash` it signs/u);
});
