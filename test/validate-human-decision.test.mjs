/**
 * Tests for the issue #35 decision queue and status projection.
 *
 * Two things must be impossible: a packet that does not say why the automation
 * may not decide or what each option costs, and an answer applied to an identity
 * it was not asked about.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ANSWERED_EXAMPLE_PATH,
  CONTRACT_PATH,
  PARK_REASONS,
  REFUSALS,
  REQUEST_EXAMPLE_PATH,
  REQUEST_SCHEMA_PATH,
  STATUS_EXAMPLE_PATH,
  STATUS_SCHEMA_PATH,
  answerDecision,
  crossProjectLeak,
  decisionDesignDigest,
  loadFiles,
  validateHumanDecisionDesign,
  validateRequest,
  validateStatus,
} from "../scripts/validate-human-decision.mjs";

const files = loadFiles();
const requestSchema = JSON.parse(files[REQUEST_SCHEMA_PATH]);
const statusSchema = JSON.parse(files[STATUS_SCHEMA_PATH]);

const pending = () => JSON.parse(files[REQUEST_EXAMPLE_PATH]);
const answered = () => JSON.parse(files[ANSWERED_EXAMPLE_PATH]);
const status = () => JSON.parse(files[STATUS_EXAMPLE_PATH]);

function mutated(mutate, base = pending) {
  const value = base();
  mutate(value);
  return value;
}

function assertRejects(value, pattern) {
  const errors = validateRequest(value, requestSchema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

const goodAnswer = () => ({
  option_id: "wait",
  identities: { anchor_version: 3, candidate: "1".repeat(64) },
});

test("the shipped design validates", () => {
  assert.deepEqual(validateHumanDecisionDesign(files), []);
});

test("a packet says why the automation may not decide", () => {
  // A packet without it reads as a request for permission to do something
  // obvious, and if the reason cannot be written the park is probably a bug.
  assert.ok(requestSchema.required.includes("why_automation_may_not_decide"));
  assert.ok(pending().why_automation_may_not_decide.length > 20);
});

test("every option states its consequence, and two is the minimum", () => {
  // A list of options without consequences asks the user to choose between words.
  assert.ok(requestSchema.properties.options.items.required.includes("consequence"));
  assert.equal(requestSchema.properties.options.minItems, 2);
  for (const option of pending().options) assert.ok(option.consequence.length >= 10);
});

test("an irreversible option is visible on the option, not only in a preamble", () => {
  assertRejects(
    mutated((value) => {
      value.flags.irreversible = false;
    }),
    /disagrees with the options/u,
  );
});

test("a recommendation must be one of the options", () => {
  assertRejects(
    mutated((value) => {
      value.recommendation = "do_something_else";
    }),
    /not one of the options/u,
  );
});

test("an answer to a changed candidate is an answer to a different question", () => {
  const request = pending();
  assert.equal(answerDecision(request, goodAnswer()), "accepted");
  assert.equal(
    answerDecision(request, { ...goodAnswer(), identities: { anchor_version: 3, candidate: "9".repeat(64) } }),
    "refused:decision_identity_stale",
  );
  assert.equal(
    answerDecision(request, { ...goodAnswer(), identities: { anchor_version: 4, candidate: "1".repeat(64) } }),
    "refused:decision_identity_stale",
  );
  assert.ok(files[CONTRACT_PATH].includes("it is an answer to a different one"));
});

test("a duplicate answer is idempotent, and a different one is not", () => {
  const request = answered();
  assert.equal(answerDecision(request, goodAnswer()), "idempotent");
  assert.equal(
    answerDecision(request, { ...goodAnswer(), option_id: "waive_seat" }),
    "refused:decision_identity_stale",
  );
});

test("a voided or expired request takes no answer", () => {
  assert.equal(
    answerDecision(
      mutated((value) => {
        value.state = "voided";
      }),
      goodAnswer(),
    ),
    "refused:decision_request_voided",
  );
  const request = pending();
  assert.equal(
    answerDecision(request, goodAnswer(), { nowMs: Date.parse(request.expires_at) + 1 }),
    "refused:decision_expired",
  );
});

test("an unknown option and the wrong approver are both refused", () => {
  assert.equal(answerDecision(pending(), { ...goodAnswer(), option_id: "invent" }), "refused:decision_option_unknown");
  assert.equal(
    answerDecision(pending(), goodAnswer(), { approver: "any_maintainer" }),
    "refused:decision_approver_mismatch",
  );
});

test("a normalised free-text answer says whether it changed material scope", () => {
  // Silently interpreting free text is how "sure, but only for the docs" becomes
  // an approval for everything.
  const record = answered();
  assert.equal(record.answer.normalized_from, "let's wait for grok");
  assert.equal(record.answer.confirmed_material_scope, false);
  assertRejects(
    mutated((value) => {
      delete value.answer.confirmed_material_scope;
    }, answered),
    /whether it changed material scope/u,
  );
});

test("a packet carries no transcript, credential or absolute path", () => {
  // A decision packet is read in a terminal, pasted into chat and kept.
  for (const planted of [
    '{"type":"assistant","text":"..."}',
    "ghp_0123456789abcdefghijklmnopqrstuvwx",
    "/Users/someone/project/file.md",
  ]) {
    assertRejects(
      mutated((value) => {
        value.observed_facts.push(planted);
      }),
      /decision_packet_contains_transcript|carries a/u,
    );
  }
});

test("a status shows only what a record can back", () => {
  // A status listing a decision nobody filed is a second source of truth in its
  // first sentence.
  const errors = validateStatus(status(), statusSchema, { requests: [] });
  assert.ok(errors.some((message) => /has no request record/u.test(message)));
  assert.deepEqual(validateStatus(status(), statusSchema, { requests: [pending()] }), []);
});

test("a status cannot count more done and blocked than it has tickets", () => {
  const broken = status();
  broken.epics[0].tickets.done = 20;
  const errors = validateStatus(broken, statusSchema, { requests: [pending()] });
  assert.ok(errors.some((message) => /exceed the total/u.test(message)));
});

test("a status for one project never names another", () => {
  const own = status();
  assert.equal(crossProjectLeak(own, own.project_identity), false);
  const leaked = status();
  leaked.debt.push(`blocked on sha256:${"9".repeat(64)}`);
  assert.equal(crossProjectLeak(leaked, leaked.project_identity), true);
});

test("waivers, debt and open findings are fields, not comment history", () => {
  // A waiver nobody can see is a waiver nobody weighed.
  for (const field of ["waivers", "debt", "open_findings"]) {
    assert.ok(statusSchema.required.includes(field), `${field} is optional`);
  }
});

test("the park reasons and refusals are closed and documented", () => {
  const contract = files[CONTRACT_PATH];
  assert.deepEqual(requestSchema.properties.park_reason.enum.slice().sort(), [...PARK_REASONS].sort());
  for (const refusal of REFUSALS) assert.ok(contract.includes(refusal), `${refusal} is not documented`);
});

test("the design digest changes when any shipped file changes", () => {
  const before = decisionDesignDigest(files);
  const after = decisionDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
