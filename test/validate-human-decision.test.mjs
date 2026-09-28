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

test("a packet's park_reason is the task's park.reason, one of the graph's recovery rows", async () => {
  // R6-8: the enum named eight categories, none of them a reason the graph
  // parks with, so no real park could produce a schema-valid packet.
  const { readFileSync } = await import("node:fs");
  const graph = JSON.parse(readFileSync(new URL("../resources/workflow-graph/workflow-graph.v1.json", import.meta.url), "utf8"));
  const reasons = graph.recovery.map((row) => row.reason).sort();
  assert.deepEqual(requestSchema.properties.park_reason.enum.slice().sort(), reasons);
  assert.deepEqual([...PARK_REASONS].sort(), reasons);
  assert.ok(reasons.includes(pending().park_reason));
  assert.ok(reasons.includes("acceptance_missing"));
  // A schema that drops one, or adds a category, is refused.
  for (const edit of [
    (schema) => schema.properties.park_reason.enum.pop(),
    (schema) => schema.properties.park_reason.enum.push("panel_waiver"),
  ]) {
    const schema = JSON.parse(files[REQUEST_SCHEMA_PATH]);
    edit(schema);
    assert.ok(
      validateHumanDecisionDesign({ ...files, [REQUEST_SCHEMA_PATH]: JSON.stringify(schema) })
        .some((message) => /park reasons must be exactly the workflow graph's recovery reasons/u.test(message)),
    );
  }
});

// --- debt 11e: a packet resumes into its row's graph step (R7-7, ADR-099) ---

/** The workflow graph the shipped packets are held to, read fresh for each test. */
const shippedGraph = async () => {
  const { readFileSync } = await import("node:fs");
  return JSON.parse(readFileSync(new URL("../resources/workflow-graph/workflow-graph.v1.json", import.meta.url), "utf8"));
};

test("every shipped packet resumes into a workflow the graph registers and a step its park reason's row permits (R7-7)", async () => {
  // Round 7 of #39, R7-7: both examples resumed to {feature-dev, panel}; the
  // graph registers no feature-dev and has no step panel, and the schema
  // checked the target only by length, against ADR-089's point that a packet
  // resumes into its row's graph step.
  const graph = await shippedGraph();
  const workflows = graph.workflows.map((entry) => entry.name);
  for (const request of [pending(), answered()]) {
    const row = graph.recovery.find((entry) => entry.reason === request.park_reason);
    assert.ok(workflows.includes(request.resume_target.workflow), request.resume_target.workflow);
    assert.ok(row.resume_targets.includes(request.resume_target.step), request.resume_target.step);
  }
});

test("a packet naming a workflow the graph does not register, or a step its row does not permit, is refused (R7-7)", async () => {
  assertRejects(mutated((value) => {
    value.resume_target.workflow = "feature-dev";
  }), /resume_target/u);
  assertRejects(mutated((value) => {
    value.resume_target.step = "panel";
  }), /resume_target\.step panel is not a target the panel_waiver_required recovery row permits \(decision_packet_incomplete\)/u);
  // A real step another row permits is not this row's.
  const graph = await shippedGraph();
  assert.ok(!graph.recovery.find((entry) => entry.reason === "panel_waiver_required").resume_targets.includes("accept_staging"));
  assertRejects(mutated((value) => {
    value.resume_target.step = "accept_staging";
  }), /resume_target\.step accept_staging is not a target the panel_waiver_required recovery row permits/u);
  // And the check reads the graph it is handed: the shipped packet against a
  // graph whose row dropped the step is refused too.
  const narrowed = JSON.parse(JSON.stringify(graph));
  const row = narrowed.recovery.find((entry) => entry.reason === "panel_waiver_required");
  row.resume_targets = row.resume_targets.filter((step) => step !== pending().resume_target.step);
  assert.ok(validateRequest(pending(), requestSchema, narrowed).some((message) => /is not a target the panel_waiver_required recovery row permits/u.test(message)));
  const renamed = JSON.parse(JSON.stringify(graph));
  renamed.workflows = renamed.workflows.filter((entry) => entry.name !== pending().resume_target.workflow);
  assert.ok(validateRequest(pending(), requestSchema, renamed).some((message) => /is not a workflow the graph registers/u.test(message)));
  assert.deepEqual(validateRequest(pending(), requestSchema, graph), []);
});

test("the request schema enumerates the resume workflows from the graph, and the validator keeps them equal (R7-7)", async () => {
  const graph = await shippedGraph();
  const names = graph.workflows.map((entry) => entry.name).sort();
  assert.deepEqual([...requestSchema.properties.resume_target.properties.workflow.enum].sort(), names);
  for (const edit of [
    (schema) => schema.properties.resume_target.properties.workflow.enum.pop(),
    (schema) => schema.properties.resume_target.properties.workflow.enum.push("feature-dev"),
  ]) {
    const schema = JSON.parse(files[REQUEST_SCHEMA_PATH]);
    edit(schema);
    assert.ok(
      validateHumanDecisionDesign({ ...files, [REQUEST_SCHEMA_PATH]: JSON.stringify(schema) })
        .some((message) => /resume workflows must be exactly the workflow graph's workflows/u.test(message)),
    );
  }
  // The contract says what the validator holds a packet to.
  assert.match(files[CONTRACT_PATH], /`validate:human-decision` holds every shipped packet to it/u);
});

test("a packet's step is one its named workflow reaches: a registered workflow that cannot reach the step is refused (review L2)", async () => {
  // Review of 11e, L2: {autosk-arena-judge, panel_join} passed — the workflow
  // is registered and the step is one the row permits, but a judge seat never
  // stands where a panel joins.
  assertRejects(mutated((value) => {
    value.resume_target.workflow = "autosk-arena-judge";
  }), /resume_target\.step panel_join is not a step autosk-arena-judge reaches \(decision_packet_incomplete\)/u);
  assertRejects(mutated((value) => {
    value.resume_target.workflow = "autosk-panel-seat";
  }), /is not a step autosk-panel-seat reaches/u);
  const graph = await shippedGraph();
  assert.deepEqual(validateRequest(pending(), requestSchema, graph), []);
});

// --- debt 11e narrow re-review: a step only an out-of-band entry reaches (L-a) ---

test("a step only an out-of-band entry reaches is one every workflow reaches, for a row that names that entry's region, and nothing else is lent (review L-a)", async () => {
  // Narrow re-review of 11e, L-a: the L2 fix read reach from each workflow's
  // first step alone, so emit_blocked_anchor — entered only from
  // authority_recovery, where the daemon puts a task of any workflow out of
  // band — was refused under all eight workflows for the two rows that
  // resume into it, packets that passed before.
  const graph = await shippedGraph();
  const packet = (workflow, step, reason) => mutated((value) => {
    value.park_reason = reason;
    value.resume_target.workflow = workflow;
    value.resume_target.step = step;
  });
  for (const reason of ["project_boundary_invalid", "authority_journal_truncated"]) {
    assert.ok(graph.recovery.find((entry) => entry.reason === reason).resume_targets.includes("emit_blocked_anchor"), reason);
    for (const { name } of graph.workflows) {
      assert.deepEqual(validateRequest(packet(name, "emit_blocked_anchor", reason), requestSchema, graph), [], `${name}, ${reason}`);
    }
  }
  // Seeding every workflow's reach with the out-of-band entries would reopen
  // L2: authority_recovery leads through prepare_anchor_impact into the
  // planning steps. A judge seat still never stands where a panel joins.
  assertRejects(packet("autosk-arena-judge", "panel_join", "panel_waiver_required"),
    /resume_target\.step panel_join is not a step autosk-arena-judge reaches/u);
  // The region is lent only to a row that names a step of it: another row
  // that lists the step borrows nothing.
  const lent = JSON.parse(JSON.stringify(graph));
  lent.recovery.find((entry) => entry.reason === "cas_conflict").resume_targets.push("emit_blocked_anchor");
  assert.ok(validateRequest(packet("autosk-planned", "emit_blocked_anchor", "cas_conflict"), requestSchema, lent)
    .some((message) => /resume_target\.step emit_blocked_anchor is not a step autosk-planned reaches/u.test(message)));
  // And the entry is read from the graph, not named here: a graph that does
  // not enter authority_recovery out of band reaches the step nowhere.
  const unentered = JSON.parse(JSON.stringify(graph));
  unentered.entry_steps = unentered.entry_steps.filter((entry) => entry.step !== "authority_recovery");
  assert.ok(validateRequest(packet("autosk-planned", "emit_blocked_anchor", "authority_journal_truncated"), requestSchema, unentered)
    .some((message) => /is not a step autosk-planned reaches/u.test(message)));
});
