/**
 * Tests for the integration authorization contract (#9, #4).
 *
 * The record is the only token that authorizes the one irreversible step, and
 * in v1 it is signed by the person at the stop. Every case here is a way it
 * could end up authorizing something nobody signed.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  AUTO_POLICY_OWNER,
  CONTRACT_PATH,
  EXAMPLE_PATH,
  GRAPH_PATH,
  MATRIX_PATH,
  REFUSALS,
  REFUSED_PATH,
  ROOT,
  SCHEMA_PATH,
  UNATTENDED_ACCEPTANCE,
  acceptanceAuthority,
  acceptanceAuthorityErrors,
  acceptanceSummary,
  planErrors,
  recordRefusals,
  validateDesign,
} from "../scripts/validate-integration-authorization.mjs";
import { validateJsonSchema } from "../scripts/validate-planning-ref-design.mjs";
import { filesUsing } from "../scripts/lib/code-references.mjs";

const NOW = Date.parse("2026-09-09T00:00:00Z");
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");
const files = Object.fromEntries(
  [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, REFUSED_PATH, GRAPH_PATH, MATRIX_PATH].map((relative) => [relative, read(relative)]),
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
  // The chain is the record's scope's (R8-16), and the model is autoskd's
  // store-time check (review of 99fd30b, L4): the head compared is the one
  // its scope had just before the record is stored.
  assert.deepEqual(reasons(record, { headsBeforeStore: { [record.scope_id]: record.previous_authorization_head_hash } }), []);
  assert.ok(
    reasons(record, { headsBeforeStore: { [record.scope_id]: "f".repeat(64) } }).includes("integration_authorization_head_mismatch"),
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
  // Absent, and chained from a head its scope did not have when it was stored.
  for (const entry of reasons(null)) produced.add(entry);
  for (const entry of reasons(record, { headsBeforeStore: { [record.scope_id]: "f".repeat(64) } })) produced.add(entry);
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
  // Review of 99fd30b (L5): the record the acceptance names, without the two-path wording.
  assert.match(described.cond_444, /IntegrationAuthorizationRecord, который она называет, expired\/revoked\/replaced или не сходится с head своего scope/u);
});

test("the record is signed for the exact identity, which exists only after aggregate verification, so nothing signs it before the stop (debt 11b, R7-15; R8-3)", () => {
  // Debt 11b defined "in advance" as "before the acceptance step for that
  // exact identity". Round 8 (R8-3) measured that nothing sits between
  // aggregate_verify and the stop to sign it at, so the documents no longer
  // offer an "in advance" that could skip the stop; what R7-15 fixed stays:
  // the identity binds the aggregate record, and a record signed before the
  // staging it names names no identity at all.
  const contract = read(CONTRACT_PATH);
  assert.match(contract, /the identity binds the aggregate record, so it exists only after aggregate verification, and nothing can be signed for an Epic before its staging does/u);
  assert.match(read("docs/contracts/epic-staging.md"), /the identity the record must bind exists only after aggregate verification \(R7-15\)/u);
  assert.match(read("01-core-flows.md"), /существует только после aggregate verification, так что подписать её раньше этого шага нельзя/u);
  for (const [relative, stale] of [
    [CONTRACT_PATH, /"In advance" means before the acceptance step/u],
    ["docs/contracts/epic-staging.md", /"Signed in advance" means before this acceptance step/u],
    ["01-core-flows.md", /до этого шага — для той же exact identity, то есть после aggregate verification, а не до staging/u],
  ]) {
    assert.doesNotMatch(read(relative), stale, relative);
  }
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

// --- Round 8 of #39 (debt 12b, ADR-103) -----------------------------------------

const section = (text, from, to) => {
  const start = text.indexOf(from);
  assert.ok(start >= 0, from);
  const end = to === undefined ? -1 : text.indexOf(to, start + from.length);
  return text.slice(start, end === -1 ? undefined : end);
};
const graph = () => JSON.parse(files[GRAPH_PATH]);
const matrix = () => JSON.parse(files[MATRIX_PATH]);
const obligation = (issue) => matrix().records.find((record) => record.issue_number === issue).implementation_obligation_before_mvp;
const described = () => Object.fromEntries(graph().predicates.map((entry) => [entry.id, entry.description]));
const adr103 = () => section(read("04-decisions.md"), "## ADR-103:", "\n## ");

test("an acceptance does not move what it accepts: the heads a record names exclude the scope's own acceptance, stated as a class, and only that (R8-2; review L3)", () => {
  // Round 8 of #39, R8-2 (architecture high, lead medium): the record and the
  // staging identity bind the three heads as they stand before the question,
  // `integrateApproved` compares them with the ones in force, and the daemon
  // commits the answer — an Epic-scoped UserDecisionRecord — before it returns
  // it. Nothing kept that answer out of the Epic's own heads, so read
  // literally every acceptance went stale on the one irreversible path. The
  // rule is stated once, in IA §3, and every other place points at it.
  // Review of 99fd30b (L3): the excluded class is stated as a class — every
  // answer to any acceptance packet of the scope, accept or refuse, re-asks
  // included, and every record of the scope — with the key autoskd uses when
  // it commits a decision whose record is not completed yet (the answered
  // request's kind, not the payload), and every other decision counts, a
  // later revocation or replacement of an acceptance included.
  const binds = section(read(CONTRACT_PATH), "## 3.", "## 4.");
  assert.match(binds, /\*\*An acceptance does not move what it accepts\*\* \(ADR-103\)/u);
  assert.match(binds, /every answer to any acceptance packet of the scope — `accept` or `refuse`, to any question, re-asks included — and every `IntegrationAuthorizationRecord` of the scope/u);
  assert.match(binds, /by the kind of request the decision answers — a packet parked with `acceptance_missing` at `accept_staging` for this scope/u);
  assert.match(binds, /never by its payload/u);
  assert.match(binds, /never enters the scope's relevant authority projection, its dependency head or its intent head/u);
  assert.match(binds, /committing it moves the global authority and nonce heads/u);
  assert.match(binds, /`integrateApproved` therefore compares the named heads with the heads in force under that exclusion/u);
  // The exclusion is exact: every other decision counts, a later revocation or
  // replacement of an acceptance included, and the chain enforces that too.
  assert.match(binds, /Every other decision is outside the class and counts[^.]*a later decision revoking or replacing an acceptance decision or record[^.]*still makes the acceptance stale/u);
  assert.match(binds, /revoking or replacing the record is additionally enforced by the scope's chain/u);
  assert.doesNotMatch(binds, /Revoking or replacing this record is no such entry/u);
  // Every other place says the same, and points at the rule.
  const flows = read("01-core-flows.md");
  const two = section(flows, "### Согласование решений человеком", "## 3. ");
  assert.match(two, /приёмка не двигает то, что принимает[^\n]*ADR-103/u);
  assert.match(two, /каждый ответ на любой пакет приёмки scope — accept или refuse, на любой вопрос, повторные включительно — и каждая `IntegrationAuthorizationRecord` этого scope/u);
  assert.match(two, /по виду запроса, на который решение отвечает/u);
  assert.match(two, /а не по payload/u);
  assert.match(two, /глобальные authority и nonce heads/u);
  assert.match(two, /любое другое решение — в том числе позднее решение, отзывающее или заменяющее решение приёмки или record, — вне класса и учитывается/u);
  assert.match(two, /отзыв или замену record дополнительно держит цепочка scope/u);
  const five = section(flows, "## 5. ", "## 6. ");
  assert.match(five, /приёмка не двигает то, что принимает[^\n]*ADR-103/u);
  assert.match(five, /каждый ответ на любой пакет приёмки Epic \(accept или refuse, повторные включительно\) и каждая её `IntegrationAuthorizationRecord`/u);
  assert.match(five, /любое другое решение, включая отзыв или замену приёмки, входит/u);
  const architecture = read("02-architecture.md").split("\n");
  const guard = architecture.find((line) => line.startsWith("Authority/dependency/user-instruction/correction appends")) ?? "";
  assert.match(guard, /в эту projection и в dependency\/intent heads Epic не входит[^\n]*ADR-103/u);
  assert.match(guard, /каждый ответ на любой пакет приёмки Epic — accept или refuse, повторные включительно — и каждая `IntegrationAuthorizationRecord` её scope/u);
  assert.match(guard, /по виду запроса, на который решение отвечает/u);
  // Review of 99fd30b (L5): committing the class moves the nonce head too.
  assert.match(guard, /глобальные authority и nonce heads/u);
  assert.match(guard, /любое другое решение, включая отзыв или замену приёмки, учитывается/u);
  const record = architecture.find((line) => line.startsWith("`IntegrationAuthorizationRecord` authoritative source")) ?? "";
  assert.match(record, /which the Epic's own acceptance does not move/u);
  const plan = read("03-technical-plan.md").split("\n");
  const integrate = plan.find((line) => line.startsWith("| integrate_staging | daemon `integrateApproved(")) ?? "";
  assert.match(integrate, /собственная приёмка Epic не двигает[^|]*ADR-103/u);
  const authorityGuard = plan.find((line) => line.startsWith("`authorityGuard(expected_relevant_authority_projection_hash")) ?? "";
  assert.match(authorityGuard, /An Epic's own integration acceptance[^.]*never enters its relevant projection or its dependency or intent head/u);
  assert.match(authorityGuard, /every answer to any acceptance packet of the Epic, accept or refuse, re-asks included, and every IntegrationAuthorizationRecord of its scope/u);
  assert.match(authorityGuard, /keyed at commit by the kind of request answered/u);
  assert.match(authorityGuard, /the global authority and nonce heads/u);
  assert.match(authorityGuard, /any other decision, a later one revoking or replacing an acceptance decision or record included, counts/u);
  assert.match(authorityGuard, /additionally enforced by the scope's chain/u);
  assert.match(authorityGuard, /Unrelated project authority append therefore does not stale an Epic after re-resolution, and neither does the Epic's own acceptance/u);
  // The graph's CAS predicate says it too.
  assert.match(described().cond_441, /heads в силе без своей приёмки Epic \(ADR-103\)/u);
  // No host code computes a head: where one appears under src/, it is taken
  // from the caller's heads or the facts that bind them.
  const runtime = readdirSync(path.join(ROOT, "src"), { recursive: true }).filter((name) => name.endsWith(".mjs"));
  let taken = 0;
  for (const file of runtime) {
    const text = read(path.join("src", file));
    for (const match of text.matchAll(/\b(relevant_authority_projection_hash|dependency_head_hash|intent_head_hash)\s*:\s*([^,\n]+)/gu)) {
      assert.ok([`heads.${match[1]}`, `facts.${match[1]}`].includes(match[2].trim()), `${file}: ${match[0]}`);
      taken += 1;
    }
  }
  assert.ok(taken > 0, "the host names the heads it binds");
  // So the rule is the daemon's, given to the owners inside matrix v1
  // (ADR-097's rule): #4 for the heads, #9 for the comparison in
  // integrateApproved — and both say the class as the contract does.
  assert.match(obligation(4), /An Epic's own integration acceptance[^.]*never enters the Epic's relevant authority projection or its dependency or intent head/u);
  assert.match(obligation(4), /every answer to any acceptance packet of the Epic, accept or refuse, re-asks included, and every IntegrationAuthorizationRecord of its scope/u);
  assert.match(obligation(4), /by the kind of request each decision answers/u);
  assert.match(obligation(4), /any other decision — a later one revoking or replacing an acceptance decision or record included — enters them as before/u);
  assert.match(obligation(4), /global authority and nonce heads/u);
  assert.match(obligation(4), /so an acceptance does not move what it accepts \(docs\/contracts\/integration-authorization\.md §3, ADR-103\)/u);
  assert.match(obligation(9), /heads and controlling anchor digest it names against the ones in force, which an Epic's own acceptance does not move \(docs\/contracts\/integration-authorization\.md §3, ADR-103\)/u);
  assert.match(obligation(9), /every answer to the Epic's acceptance packets and every IntegrationAuthorizationRecord of its scope stay out of them/u);
  assert.match(obligation(9), /any other decision, a later one revoking or replacing an acceptance included, counts/u);
  // The alternative the ADR weighed and rejected.
  assert.match(adr103(), /previous_secure_head_hash/u);
});

test("v1 has one acceptance authority, the person's signature at the stop: a policy held to it adds no autonomy, and an unattended acceptance needs another binding, #28's to design after v1 (R8-3; review M1, L1, L5)", async () => {
  // Round 8 of #39, R8-3 (lead, architecture; feasibility's low as wording):
  // the documents offered a pinned auto-policy that skips the stop, while the
  // graph's only edges into the CAS and delivery leave the stop under a
  // person's guard and nothing between aggregate_verify and the stop presents
  // the post-aggregate identity for signature. The graph is right, and the
  // documents say so.
  // Review of 99fd30b (M1): the first fix gave #28 that binding to pass, and
  // no unattended policy can pass it — it needs the person's signature over an
  // identity that exists only after aggregate verification, and no policy may
  // issue the record. Under it an auto-policy adds no autonomy; an unattended
  // acceptance needs another binding, #28's own design after v1, and #9's
  // criterion reads under v1 as every acceptance carrying the user's signature
  // over the exact staging identity.
  const one = section(read(CONTRACT_PATH), "## 1.", "## 2.");
  assert.match(one, /\*\*v1 has one acceptance authority\*\* \(ADR-103\): the user's signature at `accept_staging`/u);
  // Review of 99fd30b (L1): every way into the CAS and delivery, not only the edges out of the stop.
  assert.match(one, /every edge into `integrate_staging` or `deliver_staging` leaves `accept_staging` under a person's guard \(`t_556`, `t_557`\) or is that step's own retry \(`t_563`, `t_573`\)/u);
  assert.match(one, /under v1 an auto-policy adds no autonomy: it can only remove the wait after the person has signed that exact identity/u);
  assert.match(one, /no v1 graph edge reaches it/u);
  assert.match(one, /#9's criterion[^.]*reads under v1 as: every acceptance, a policy's included, carries the user's signature over the exact staging identity/u);
  assert.match(one, /An unattended acceptance — a policy that accepts without the person at the stop — needs a different binding: something the person can sign before the identity exists, and a narrow exception, for that path alone, to this section's rule that no policy issues the record/u);
  assert.match(one, /Designing it is #28's own post-v1 design work \(Autobuild, `planned_after_v1`; its run contract's `approved_auto_policy`\), which a successor panel reviews; `autoPolicyAcceptance` cannot admit it/u);
  const stagingContract = read("docs/contracts/epic-staging.md");
  const staging = section(stagingContract, "## 5.", "## 6.");
  assert.match(staging, /v1 has one acceptance authority \(ADR-103\)/u);
  assert.match(staging, /so under this binding it adds no autonomy: it can only remove the wait after the person has signed that exact identity/u);
  assert.match(staging, /every edge into `integrate_staging` or `deliver_staging` leaves `accept_staging` under a person's guard or is that step's own retry/u);
  assert.match(staging, /reads under v1 as: every acceptance, a policy's included, carries the user's signature over the exact staging identity/u);
  assert.match(staging, /An unattended acceptance — a policy that accepts without the person at the stop — needs a different binding: something the person can sign before the identity exists, and a narrow exception, for that path alone, to the rule that no policy issues the record/u);
  assert.match(staging, /Designing it is #28's own post-v1 design work \(Autobuild, `planned_after_v1`\), which a successor panel reviews; `autoPolicyAcceptance` cannot admit it/u);
  assert.match(section(stagingContract, "## 10."), /under v1 every acceptance, a policy's included, carries the user's signature over it \| §5/u);
  const seven = section(read("01-core-flows.md"), "## 7. ", "## 8. ");
  assert.match(seven, /В v1 у приёмки один источник полномочия — подпись пользователя на этой остановке/u);
  assert.match(seven, /каждое ребро в `integrate_staging` или `deliver_staging` выходит из `accept_staging` под guard человека \(`t_556`, `t_557`\) либо это повтор самого шага \(`t_563`, `t_573`\)/u);
  assert.match(seven, /поэтому автономии она не добавляет: она лишь снимает ожидание после того, как человек подписал эту самую identity/u);
  assert.match(seven, /каждая приёмка, в том числе приёмка policy, несёт подпись пользователя над exact staging identity/u);
  assert.match(seven, /Приёмке без человека на остановке нужна другая привязка — то, что человек может подписать до появления identity, и узкое исключение/u);
  assert.match(seven, /собственная post-v1 работа #28 \(Autobuild, `planned_after_v1`\), которую рассматривает следующая панель, а `autoPolicyAcceptance` такую приёмку допустить не может/u);
  assert.match(seven, /а не принимает новую, поэтому автономии не даёт; приёмка без человека требует другой привязки — работа #28 после v1/u);
  // No document offers a record signed before the stop that skips it, none
  // gives the unattended path a binding it cannot pass (review M1), and none
  // keeps the two-path wording (review L5).
  const stale = [
    "that record is the one thing that may skip the stop",
    "Or the user signed the same record for a pinned auto-policy before that step",
    "Nothing else may skip the stop",
    "may skip the human stop",
    "Пропустить саму остановку может только такой же record",
    "либо оно уже принято им раньше, до этого шага для той же identity",
    "at the acceptance stop or, for a pinned auto-policy, before that step",
    "либо, для auto-policy, до этого шага",
    "либо, для закреплённой auto-policy, сверившей identity, — до этого шага",
    "либо auto-policy сверила её с record, подписанным до этого шага",
    "либо auto-policy сверяет её с record, подписанным до этого шага",
    "либо закреплённая auto-policy, сверяющая её с record, подписанным до этого шага",
    "auto-policy без signed record не принимает",
    "auto-policy без signed `IntegrationAuthorizationRecord` не принимает",
    "by the time the policy runs the decision has been made",
    // Review of 99fd30b (M1).
    "the binding any auto-integration policy must pass",
    "The unattended path that would call it",
    "the unattended path that would is #28's",
    "это привязка, которую должна пройти любая auto-integration policy",
    "путь без человека на остановке — работа #28",
    "passes `autoPolicyAcceptance`",
    // Review of 99fd30b (L5).
    "acceptance record человека или закреплённой auto-policy",
    "который она называет на обоих путях",
    "check of the authorization head before the CAS",
    "against the authorization head",
    "the authorization head it chains from",
    "on either path",
  ];
  for (const relative of [...PROSE, "src/host/staging-acceptance.mjs", "resources/epic-staging/epic-staging.schema.json", MATRIX_PATH, "docs/program-capability-matrix.md"]) {
    const text = read(relative);
    for (const phrase of stale) assert.equal(text.includes(phrase), false, `${relative}: ${phrase}`);
  }
  // The graph was right: every way into the CAS and delivery leaves the stop
  // under a person's guard or is the step's own retry, and the validator holds it.
  assert.deepEqual(acceptanceAuthorityErrors(graph(), matrix()), []);
  assert.deepEqual(acceptanceAuthority(graph()), { exits: ["t_556", "t_557"], actors: ["human"], retries: ["t_563", "t_573"], bypasses: [], entries: [] });
  const shipped = graph();
  const guards = new Map(shipped.guards.map((guard) => [guard.id, guard]));
  const into = shipped.transitions.filter((edge) => ["integrate_staging", "deliver_staging"].includes(edge.to));
  assert.deepEqual(into.map((edge) => `${edge.id} ${edge.from}->${edge.to}`).sort(), [
    "t_556 accept_staging->integrate_staging",
    "t_557 accept_staging->deliver_staging",
    "t_563 integrate_staging->integrate_staging",
    "t_573 deliver_staging->deliver_staging",
  ]);
  for (const edge of into.filter((entry) => entry.from === "accept_staging")) {
    assert.deepEqual(edge.guards.map((id) => guards.get(id).authority.actor), ["human"], edge.id);
  }
  // Only the aggregate PASS and the stop's own re-entry lead into
  // accept_staging: no step presents the identity for signature before it.
  assert.deepEqual(shipped.transitions.filter((edge) => edge.to === "accept_staging").map((edge) => edge.from).sort(), ["accept_staging", "aggregate_verify"]);
  // The binding is kept, and nothing in v1 calls it.
  assert.deepEqual(await filesUsing({ root: ROOT, dirs: ["src", "scripts"], identifier: "autoPolicyAcceptance", exclude: ["src/host/staging-acceptance.mjs"] }), []);
  const code = read("src/host/staging-acceptance.mjs");
  const at = code.indexOf("export function autoPolicyAcceptance");
  // The comment read as prose: its line breaks and leading stars folded away.
  const comment = code.slice(code.lastIndexOf("/**", at), at).replace(/\s*\n\s*\*\s*/gu, " ");
  assert.match(comment, /no v1 graph edge reaches it/u);
  assert.match(comment, /adds no autonomy/u);
  assert.match(comment, /#28's own post-v1 design work, which a successor panel reviews, and this function cannot admit it/u);
  // The matrix says what the unattended path needs and whose design it is,
  // in the clauses the validator holds (review L2), and how #9's criterion reads under v1.
  const owner = matrix().records.find((entry) => entry.issue_number === AUTO_POLICY_OWNER);
  assert.equal(AUTO_POLICY_OWNER, 28);
  assert.equal(owner.lifecycle, "planned_after_v1");
  for (const clause of UNATTENDED_ACCEPTANCE.clauses) assert.ok(owner.implementation_obligation_before_mvp.includes(clause), clause);
  for (const claim of UNATTENDED_ACCEPTANCE.refused) assert.equal(owner.implementation_obligation_before_mvp.includes(claim), false, claim);
  assert.match(obligation(9), /v1 has one acceptance authority at accept_staging, the user's signature at the stop/u);
  assert.match(obligation(9), /this issue's criterion that an auto-integration policy is bound to the exact staging identity reads under v1: every acceptance, a policy's included, carries the user's signature over the exact staging identity/u);
  assert.match(obligation(9), /which adds no autonomy/u);
  assert.match(obligation(9), /an unattended acceptance needs a different binding, #28's post-v1 design work/u);
  // The graph's predicates say the same, and the ADR records the decision and the path not taken.
  const predicates = described();
  for (const id of ["cond_435", "cond_436"]) assert.match(predicates[id], /одно полномочие приёмки v1 \(ADR-103\)/u, id);
  assert.match(predicates.cond_438, /ADR-103/u);
  const adr = adr103();
  assert.match(adr, /`t_556`/u);
  assert.match(adr, /при привязке v1 auto-policy автономии не добавляет/u);
  assert.match(adr, /узкое исключение/u);
  assert.match(adr, /следующая панель/u);
  assert.match(adr, /`autoPolicyAcceptance` такую приёмку допустить не может/u);
  assert.match(adr, /каждая приёмка, в том числе приёмка policy, несёт подпись пользователя над exact staging identity/u);
  for (const phrase of ["это привязка, которую должна пройти любая auto-integration policy", "Путь без человека на остановке — работа #28 (Autobuild"]) {
    assert.equal(adr.includes(phrase), false, phrase);
  }
});

test("the validator holds the one acceptance authority to every way into the CAS and delivery, and #28's obligation to what an unattended acceptance needs (R8-3; review L1, L2)", () => {
  const refused = (label, mutate, pattern) => {
    const shipped = graph();
    const programs = matrix();
    mutate(shipped, programs);
    const errors = acceptanceAuthorityErrors(shipped, programs);
    assert.ok(errors.some((message) => pattern.test(message)), `${label}: ${errors.join("\n")}`);
    return shipped;
  };
  const policy = { actor: "policy", policy_rules: ["derived_rules"], policy_scope: "A policy that stands in for the person at the stop." };
  refused("a policy could take the CAS edge", (shipped) => {
    shipped.guards.find((guard) => guard.id === "guard_560").authority = policy;
  }, /t_556[^\n]*guard_560[^\n]*policy/u);
  refused("an agent could take the delivery edge", (shipped) => {
    shipped.guards.find((guard) => guard.id === "guard_561").authority = { actor: "agent" };
  }, /t_557[^\n]*guard_561[^\n]*agent/u);
  refused("anyone could take an unguarded edge", (shipped) => {
    shipped.transitions.find((edge) => edge.id === "t_556").guards = [];
  }, /t_556[^\n]*no guard/u);
  refused("a second way from the stop to the CAS", (shipped) => {
    shipped.transitions.push({ id: "t_999", from: "accept_staging", to: "integrate_staging", priority: 99, guards: ["guard_562"] });
  }, /t_999[^\n]*guard_562[^\n]*agent/u);
  refused("no way from the stop to the CAS is no authority at all", (shipped) => {
    shipped.transitions = shipped.transitions.filter((edge) => !(edge.from === "accept_staging" && ["integrate_staging", "deliver_staging"].includes(edge.to)));
  }, /no edge leaves accept_staging/u);
  // Review of 99fd30b (L1), the reviewer's probe: a policy-guarded edge from
  // aggregate_verify straight to the CAS passed both validators, and the CLI
  // still printed acceptance_authority=human. Every way into the CAS and
  // delivery that does not leave the stop skips it, whoever its guard names.
  const probe = { id: "t_990", from: "aggregate_verify", to: "integrate_staging", priority: 0, guards: ["guard_120"] };
  const bypassed = refused("a policy edge from aggregate_verify to the CAS", (shipped) => {
    shipped.transitions.push(probe);
  }, /t_990 \(aggregate_verify -> integrate_staging\)[^\n]*without leaving accept_staging/u);
  assert.deepEqual(acceptanceAuthority(bypassed).bypasses, ["t_990"]);
  assert.match(acceptanceSummary(bypassed), /bypasses=1/u);
  refused("a person's edge from another step to delivery", (shipped) => {
    shipped.transitions.push({ id: "t_991", from: "aggregate_verify", to: "deliver_staging", priority: 0, guards: ["guard_581"] });
  }, /t_991 \(aggregate_verify -> deliver_staging\)[^\n]*without leaving accept_staging/u);
  refused("an unguarded edge from another step to the CAS", (shipped) => {
    shipped.transitions.push({ id: "t_992", from: "apply_staging", to: "integrate_staging", priority: 0, guards: [] });
  }, /t_992 \(apply_staging -> integrate_staging\)[^\n]*without leaving accept_staging/u);
  refused("a workflow that starts at the CAS", (shipped) => {
    shipped.workflows.push({ name: "autosk-probe", first_step: "integrate_staging" });
  }, /integrate_staging is an entry step/u);
  refused("the daemon entering delivery out of band", (shipped) => {
    shipped.entry_steps.push({ step: "deliver_staging", reason: "Entered by the daemon out of band." });
  }, /deliver_staging is an entry step/u);
  // A step's own retry is not a way in: it is taken only from inside the step.
  const retried = graph();
  retried.transitions.push({ id: "t_993", from: "deliver_staging", to: "deliver_staging", priority: 99, guards: ["guard_577"] });
  assert.deepEqual(acceptanceAuthorityErrors(retried, matrix()), []);
  // The summary the CLI prints is read from the graph, not written.
  assert.equal(acceptanceSummary(graph()), "refusals=7 acceptance_authority=human acceptance_edges=t_556,t_557 retries=t_563,t_573 bypasses=0 auto_policy_owner=#28");
  const policed = graph();
  policed.guards.find((guard) => guard.id === "guard_560").authority = policy;
  assert.match(acceptanceSummary(policed), /acceptance_authority=human\+policy/u);
  assert.doesNotMatch(read("scripts/validate-integration-authorization.mjs"), /acceptance_authority=human /u);
  refused("the unattended path's owner moved into v1", (shipped, programs) => {
    programs.records.find((entry) => entry.issue_number === 28).lifecycle = "required_for_v1";
  }, /#28[^\n]*required_for_v1/u);
  // Review of 99fd30b (L2): the owner check was a substring match, so an
  // obligation naming the binding only to negate it passed. It now holds what
  // the obligation must say (M1), and refuses the claim the review found
  // unmeetable.
  const obligationOf28 = (programs) => programs.records.find((entry) => entry.issue_number === 28);
  refused("an obligation with no word on the unattended path", (shipped, programs) => {
    obligationOf28(programs).implementation_obligation_before_mvp = "None before MVP; after #36 implement the approved run contract.";
  }, /#28[^\n]*does not say/u);
  refused("an obligation naming the binding only to negate it", (shipped, programs) => {
    obligationOf28(programs).implementation_obligation_before_mvp = "None before MVP; after #36 implement the approved run contract. Do not implement `autoPolicyAcceptance`; the unattended acceptance is out of scope.";
  }, /#28[^\n]*does not say/u);
  refused("the obligation the first fix gave #28", (shipped, programs) => {
    obligationOf28(programs).implementation_obligation_before_mvp = "None before MVP; after #36 implement the approved run contract, budgets, sprint Tickets, evaluation and recovery, and the unattended acceptance the run contract's approved_auto_policy names: a pinned auto-policy that accepts at accept_staging without the person at the stop passes `autoPolicyAcceptance` — the binding #9 keeps: the exact post-aggregate staging identity and the user's IntegrationAuthorizationRecord signed for it — and brings the graph edge that reaches it, which v1 does not have (ADR-103).";
  }, /#28[^\n]*does not say/u);
  for (const clause of UNATTENDED_ACCEPTANCE.clauses) {
    refused(`an obligation without "${clause}"`, (shipped, programs) => {
      const owner = obligationOf28(programs);
      owner.implementation_obligation_before_mvp = owner.implementation_obligation_before_mvp.replace(clause, "");
    }, new RegExp(`#28[^\\n]*does not say[^\\n]*${clause.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
  }
  for (const claim of UNATTENDED_ACCEPTANCE.refused) {
    refused(`an obligation that still says "${claim}"`, (shipped, programs) => {
      obligationOf28(programs).implementation_obligation_before_mvp += ` It ${claim}.`;
    }, new RegExp(`#28[^\\n]*says[^\\n]*${claim.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
  }
  // And the design validator reports it.
  assert.ok(validateDesign({ ...files, [GRAPH_PATH]: JSON.stringify(policed) }).some((message) => /guard_560/u.test(message)));
  assert.ok(validateDesign({ ...files, [GRAPH_PATH]: JSON.stringify(bypassed) }).some((message) => /t_990/u.test(message)));
});

test("the authorization chain is per scope under one head kept for integrity, so another scope's record does not stale this one (R8-16; review L4)", () => {
  // Round 8 of #39, R8-16 (architecture low): nothing said whether
  // integration_authorization_head was per scope or per project. Per project,
  // any other Epic's or Quick run's record stored between the question and
  // the CAS made this one's chain stale and asked the person again — a
  // coupling between Epics the one CAS (ADR-099) does not need.
  const contract = read(CONTRACT_PATH);
  assert.match(section(contract, "## 3.", "## 4."), /`previous_authorization_head_hash` — the chain of the record's scope: the previous record of the same `scope_id`/u);
  const five = section(contract, "## 5.", "## 6.");
  assert.match(five, /\*\*One head for integrity, one chain per scope\*\* \(ADR-103\)/u);
  assert.match(five, /does not stale this acceptance/u);
  assert.match(five, /anti-rollback/u);
  const architecture = read("02-architecture.md").split("\n");
  const store = architecture.find((line) => line.startsWith("Единственное integrity-исключение к project root")) ?? "";
  assert.match(store, /`integration_authorization_head` — один на проект/u);
  assert.match(store, /цепочка `IntegrationAuthorizationRecord` — по scope/u);
  const record = architecture.find((line) => line.startsWith("`IntegrationAuthorizationRecord` authoritative source")) ?? "";
  assert.match(record, /chains it within its scope/u);
  const plan = read("03-technical-plan.md").split("\n").find((line) => line.startsWith("`integration_authorization` — daemon-owned signed record")) ?? "";
  assert.match(plan, /chained within its scope/u);
  assert.match(plan, /one protected `integration_authorization_head` per project/u);
  assert.match(obligation(9), /previous_authorization_head_hash names the previous record of the same scope_id/u);
  assert.match(obligation(9), /one integration_authorization_head per project kept for integrity/u);
  assert.match(described().cond_444, /head своего scope/u);
  // The model is autoskd's store-time check (review of 99fd30b, L4): when a
  // record is stored, its `previous_authorization_head_hash` is the head its
  // own scope had just before, and only that scope's head is compared. The
  // CAS-time check — the scope's head is the named record's own digest — is
  // `integrateApproved`'s against the store the host cannot read (IA §5).
  const ours = example();
  const theirs = "epic:epic-0002";
  const mismatched = (record, headsBeforeStore) => reasons(record, { headsBeforeStore }).includes("integration_authorization_head_mismatch");
  // Another Epic's record, stored before this one is, moved its own scope's head, not this one's.
  assert.equal(mismatched(ours, { [ours.scope_id]: ours.previous_authorization_head_hash, [theirs]: "a".repeat(64) }), false);
  // A scope that has no record yet has no head: its first record chains from null.
  assert.equal(mismatched(ours, { [theirs]: "a".repeat(64), "quick:ask-0a1b2c": "b".repeat(64) }), false);
  // A record stored in this scope after this one was composed is another history.
  assert.equal(mismatched(ours, { [ours.scope_id]: "c".repeat(64), [theirs]: ours.previous_authorization_head_hash }), true);
  // A record naming a predecessor its scope does not have.
  assert.equal(mismatched({ ...ours, previous_authorization_head_hash: "d".repeat(64) }, {}), true);
  assert.equal(mismatched({ ...ours, previous_authorization_head_hash: "d".repeat(64) }, { [theirs]: "d".repeat(64) }), true);
  // The model says which check it is, and the contract names the other one.
  assert.match(read("scripts/validate-integration-authorization.mjs"), /autoskd's store-time check/u);
  assert.match(five, /At the CAS, `integrateApproved` requires its scope's head to be the named record's own digest/u);
});
