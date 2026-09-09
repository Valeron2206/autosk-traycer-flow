/**
 * Tests for the integration authorization contract (#9, #4).
 *
 * The record is the only token that may skip the human stop before the one
 * irreversible step. Every case here is a way it could end up authorizing
 * something nobody signed.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
  // Mid-plan is the case it is written for: a partial CAS does not keep the
  // rest of an expired plan alive.
  const midPlan = { ...record, remaining_start_index: 1, completed_prefix_receipt_hash: "a".repeat(64) };
  assert.ok(reasons(midPlan).includes("integration_authorization_expired"));
});

test("a new record after a partial CAS starts from where the branch is", () => {
  const record = example();
  const resumed = {
    ...record,
    remaining_start_index: 1,
    completed_prefix_receipt_hash: createHash("sha256").update("prefix", "utf8").digest("hex"),
  };
  // Correct: it starts at the transition whose from_oid is the current branch.
  assert.deepEqual(
    reasons(resumed, {
      scopeId: record.scope_id,
      targetOid: record.ordered_ref_transitions[1].from_oid,
      completedPrefixReceipt: "prefix",
    }),
    [],
  );
  // Wrong: the branch has moved on, so this record is about another branch
  // state than the one it would act on.
  assert.ok(
    reasons(resumed, { scopeId: record.scope_id, targetOid: "9".repeat(40) })
      .includes("integration_authorization_prefix_mismatch"),
  );
  // And a claimed prefix with no receipt is a claim about work nobody proved.
  const unproven = { ...record, remaining_start_index: 1 };
  assert.ok(reasons(unproven).includes("integration_authorization_prefix_mismatch"));
});

test("a receipt that does not hash to the recorded prefix is a mismatch", () => {
  const record = {
    ...example(),
    remaining_start_index: 1,
    completed_prefix_receipt_hash: createHash("sha256").update("prefix", "utf8").digest("hex"),
  };
  assert.ok(
    reasons(record, { completedPrefixReceipt: "a different prefix" })
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

test("the plan is a chain, not a set of hops that happen to exist", () => {
  const record = example();
  assert.deepEqual(planErrors(record), []);
  const broken = {
    ...record,
    ordered_ref_transitions: [
      { index: 0, from_oid: record.initial_target_oid, to_oid: "c".repeat(40) },
      { index: 1, from_oid: "9".repeat(40), to_oid: "d".repeat(40) },
    ],
  };
  assert.ok(planErrors(broken).some((message) => /does not continue/u.test(message)));
  const wrongStart = {
    ...record,
    ordered_ref_transitions: [{ ...record.ordered_ref_transitions[0], from_oid: "9".repeat(40) }, record.ordered_ref_transitions[1]],
  };
  assert.ok(planErrors(wrongStart).some((message) => /initial_target_oid/u.test(message)));
  const reordered = {
    ...record,
    ordered_ref_transitions: [{ ...record.ordered_ref_transitions[0], index: 5 }, record.ordered_ref_transitions[1]],
  };
  assert.ok(planErrors(reordered).some((message) => /out of order/u.test(message)));
});

test("the transitions and the ticket commits are one plan", () => {
  const record = example();
  const mismatched = { ...record, ordered_ticket_commit_oids: [record.ordered_ticket_commit_oids[0]] };
  assert.ok(planErrors(mismatched).some((message) => /the same plan/u.test(message)));
  const elsewhere = { ...record, ordered_ticket_commit_oids: ["9".repeat(40), "8".repeat(40)] };
  assert.ok(planErrors(elsewhere).some((message) => /does not land on the ticket commit/u.test(message)));
});

test("a Quick authorization names its Quick task, and an Epic one does not", () => {
  const record = example();
  assert.ok(planErrors({ ...record, epic_id: null }).some((message) => /quick_task_id/u.test(message)));
  assert.deepEqual(planErrors({ ...record, epic_id: null, quick_task_id: "ask-a1b2c3" }), []);
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
  for (const entry of reasons({ ...record, remaining_start_index: 1 })) produced.add(entry);
  // Absent, and chained from a head that is not the current one.
  for (const entry of reasons(null)) produced.add(entry);
  for (const entry of reasons(record, { authorizationHead: "f".repeat(64) })) produced.add(entry);
  for (const refusal of REFUSALS) {
    assert.ok(produced.has(refusal), `${refusal} is documented and never produced`);
  }
});
