/**
 * Tests for the structured result submission path (issue #18 runtime).
 *
 * One invariant runs through all of them: a model's output is evidence, not an
 * effect. Everything here is a way that could stop being true — a claim taken
 * for a fact, a second submission overwriting the first, an exit code standing
 * in for a result, or a broken harness reported as a defect in the product.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  FORBIDDEN_TOOLS,
  OUTCOMES,
  PARK_REASONS,
  RESULT_KINDS,
  SUBMISSION_CLOSE,
  SUBMISSION_OPEN,
  applySubmission,
  parseSubmission,
  permits,
  selectTransition,
  toolsFor,
  validateBatch,
  validateSubmission,
} from "../src/host/model-result.mjs";
import { ROOT } from "../scripts/validate-planning-ref-design.mjs";

const capabilityModel = JSON.parse(
  await readFile(path.join(ROOT, "resources/model-result/role-capabilities.v1.json"), "utf8"),
);

const code = (name) => (error) => error.code === name;

const NOW = Date.parse("2026-09-08T14:00:00.000Z");

const dispatch = {
  task_id: "T-102",
  attempt: 1,
  anchor_digest: "a".repeat(64),
  runtime_identity_digest: "b".repeat(64),
  attribution: "autosk-flow/stage-carrier/v1#panel",
  harness_digest: "c".repeat(64),
  mutation_set_digest: "d".repeat(64),
};

function env(overrides = {}) {
  return {
    nowMs: () => NOW,
    actualChangedPaths: () => ["daemon/core/src/store/creation.ts"],
    resolveEvidence: () => true,
    readBack: () => true,
    ...overrides,
  };
}

function result(overrides = {}) {
  return {
    result_schema_version: 1,
    kind: "implementation",
    role: "implementer",
    step_identity: {
      task_id: dispatch.task_id,
      session_id: "s-1",
      attempt: dispatch.attempt,
      anchor_digest: dispatch.anchor_digest,
      runtime_identity_digest: dispatch.runtime_identity_digest,
    },
    outcome: "ready_for_verification",
    summary: "the chunked read refuses a mid-rune offset",
    claimed_changed_paths: ["daemon/core/src/store/creation.ts"],
    evidence: [{ criterion: "AC-4", locator: "evidence/T-102/storelock.json" }],
    attribution_echo: dispatch.attribution,
    ...overrides,
  };
}

function submitted(value) {
  return `some prose from the provider\n${SUBMISSION_OPEN}${JSON.stringify(value)}${SUBMISSION_CLOSE}\nmore prose`;
}

function batchResult(overrides = {}) {
  return result({
    kind: "verification_batch",
    outcome: "pass",
    batch: {
      product_outcome: "pass",
      tool_outcome: "ok",
      environment_outcome: "ok",
      application_proof: "evidence/T-102/mutation-applied.json",
      green_control: "evidence/T-102/green-control.json",
      restore_receipt: "evidence/T-102/restore.json",
      harness_digest: dispatch.harness_digest,
      mutation_set_digest: dispatch.mutation_set_digest,
      ...overrides.batch,
    },
    ...overrides.result,
  });
}

test("a valid submission is parsed, checked and transitions once", () => {
  const { record, transition } = applySubmission(submitted(result()), { dispatch, env: env() });
  assert.equal(transition, "to_verification");
  assert.match(record.record_digest, /^[0-9a-f]{64}$/u);
  assert.equal(record.recorded_at, new Date(NOW).toISOString());
});

test("free-form JSON in prose is not a result", () => {
  // It is prose that happens to contain braces.
  assert.throws(() => parseSubmission('here is my answer: {"outcome": "pass"}'), code("no_result_submitted"));
  assert.throws(() => parseSubmission("everything went fine"), code("no_result_submitted"));
});

test("exit 0 with no structured result has not submitted", () => {
  // The exit code is not the result, in either direction.
  assert.throws(() => applySubmission("all tests passed\n", { dispatch, env: env() }), code("no_result_submitted"));
  // ...and a provider that exits non-zero after a valid submission has still
  // submitted, which is why nothing here reads an exit code at all.
  const { transition } = applySubmission(`${submitted(result())}\nfatal: connection reset`, {
    dispatch,
    env: env(),
  });
  assert.equal(transition, "to_verification");
});

test("two submissions are refused, and the first stands", () => {
  const output = `${submitted(result())}${submitted(result({ outcome: "pass" }))}`;
  assert.throws(() => parseSubmission(output), code("multiple_results_submitted"));
  assert.throws(
    () => applySubmission(submitted(result()), { dispatch, env: env(), previousRecord: { record_digest: "x" } }),
    code("multiple_results_submitted"),
  );
});

test("an unclosed submission is not a submission", () => {
  assert.throws(
    () => parseSubmission(`${SUBMISSION_OPEN}{"kind":"implementation"`),
    code("no_result_submitted"),
  );
});

test("a submission that is not JSON is a schema failure, not a parse crash", () => {
  assert.throws(() => parseSubmission(`${SUBMISSION_OPEN}not json${SUBMISSION_CLOSE}`), code("schema_invalid"));
});

test("an unknown kind or outcome is refused", () => {
  for (const [field, value] of [["kind", "freeform"], ["outcome", "probably_fine"]]) {
    assert.throws(
      () => validateSubmission(result({ [field]: value }), { dispatch, env: env() }),
      code("schema_invalid"),
    );
  }
  assert.equal(RESULT_KINDS.length, 7);
  assert.equal(OUTCOMES.length, 7);
});

test("a result may not name its own next step", () => {
  // A model that could name it would be moving the task with extra steps.
  for (const field of ["next_step", "transition"]) {
    assert.throws(
      () => validateSubmission(result({ [field]: "to_review" }), { dispatch, env: env() }),
      code("unknown_field"),
    );
  }
});

test("claimed paths are compared against what actually changed", () => {
  // A claim is not evidence of itself, in both directions.
  // A path claimed that did not change...
  assert.throws(
    () =>
      validateSubmission(
        result({ claimed_changed_paths: ["daemon/core/src/store/creation.ts", "daemon/core/src/store/other.ts"] }),
        { dispatch, env: env() },
      ),
    code("scope_mismatch"),
  );
  // ...and a claim that names something else entirely.
  assert.throws(
    () => validateSubmission(result({ claimed_changed_paths: ["daemon/core/src/store/other.ts"] }), {
      dispatch,
      env: env(),
    }),
    code("scope_mismatch"),
  );
  assert.throws(
    () =>
      validateSubmission(result(), {
        dispatch,
        env: env({ actualChangedPaths: () => ["daemon/core/src/store/creation.ts", "secrets.env"] }),
      }),
    code("scope_mismatch"),
  );
});

test("evidence that does not resolve is not evidence", () => {
  assert.throws(
    () => validateSubmission(result(), { dispatch, env: env({ resolveEvidence: () => false }) }),
    code("evidence_unresolved"),
  );
});

test("a stale anchor or runtime identity stops the result", () => {
  assert.throws(
    () =>
      validateSubmission(result({ step_identity: { ...result().step_identity, anchor_digest: "9".repeat(64) } }), {
        dispatch,
        env: env(),
      }),
    code("stale_anchor"),
  );
  assert.throws(
    () =>
      validateSubmission(
        result({ step_identity: { ...result().step_identity, runtime_identity_digest: "9".repeat(64) } }),
        { dispatch, env: env() },
      ),
    code("stale_runtime_identity"),
  );
});

test("a result for another step is refused", () => {
  assert.throws(
    () =>
      validateSubmission(result({ step_identity: { ...result().step_identity, attempt: 2 } }), {
        dispatch,
        env: env(),
      }),
    code("scope_mismatch"),
  );
});

test("the attribution echo must be the one that was dispatched", () => {
  assert.throws(
    () => validateSubmission(result({ attribution_echo: "something else" }), { dispatch, env: env() }),
    code("schema_invalid"),
  );
});

test("a record that cannot be read back does not transition", () => {
  assert.throws(
    () => applySubmission(submitted(result()), { dispatch, env: env({ readBack: () => false }) }),
    code("schema_invalid"),
  );
});

test("a tool failure is never a product disposition", () => {
  // "The harness broke" and "the product is wrong" are different facts.
  assert.throws(
    () =>
      validateBatch(batchResult({ batch: { tool_outcome: "tool_failure" } }), dispatch),
    code("tool_failure_not_product_disposition"),
  );
  assert.throws(
    () => validateBatch(batchResult({ batch: { environment_outcome: "environment_failure" } }), dispatch),
    code("tool_failure_not_product_disposition"),
  );
  assert.throws(
    () => validateBatch(batchResult({ batch: { product_outcome: "indeterminate" } }), dispatch),
    code("tool_failure_not_product_disposition"),
  );
  // Reported as what it is, the same batch is accepted.
  assert.doesNotThrow(() =>
    validateBatch(
      batchResult({ batch: { tool_outcome: "tool_failure" }, result: { outcome: "tool_failure" } }),
      dispatch,
    ),
  );
});

test("a batch without its three proofs did not demonstrate what it claims", () => {
  for (const [field, park] of [
    ["application_proof", "missing_application_proof"],
    ["green_control", "missing_green_control"],
    ["restore_receipt", "missing_restore_receipt"],
  ]) {
    const value = batchResult();
    delete value.batch[field];
    assert.throws(() => validateBatch(value, dispatch), code(park));
  }
  // The three are owed by a pass *and* by a fail, and by nothing else: an
  // indeterminate or tool_failure batch demonstrated nothing to prove. Only the
  // pass side was asked, so `outcome === 'pass' || outcome === 'fail'` could
  // have dropped either half.
  for (const outcome of ["pass", "fail"]) {
    const value = batchResult({ result: { outcome }, batch: { product_outcome: outcome } });
    delete value.batch.application_proof;
    assert.throws(() => validateBatch(value, dispatch), code("missing_application_proof"), outcome);
  }
  // And an outcome that demonstrated nothing owes nothing: an indeterminate
  // batch with no proofs is not a missing proof, it is a batch that reached no
  // conclusion. Only a pass or a fail is a claim that needs demonstrating.
  const indeterminate = batchResult({
    result: { outcome: "indeterminate" },
    batch: { product_outcome: "indeterminate" },
  });
  delete indeterminate.batch.application_proof;
  assert.doesNotThrow(() => validateBatch(indeterminate, dispatch));
});

test("a stale harness or mutation-set digest invalidates the batch", () => {
  assert.throws(
    () => validateBatch(batchResult({ batch: { harness_digest: "9".repeat(64) } }), dispatch),
    code("stale_harness_digest"),
  );
  assert.throws(
    () => validateBatch(batchResult({ batch: { mutation_set_digest: "9".repeat(64) } }), dispatch),
    code("stale_harness_digest"),
  );
});

test("a verification_batch result without its batch is refused", () => {
  const value = result({ kind: "verification_batch", outcome: "pass" });
  assert.throws(() => validateSubmission(value, { dispatch, env: env() }), code("schema_invalid"));
});

test("the host selects the transition, and each outcome has exactly one", () => {
  const seen = new Set();
  for (const outcome of OUTCOMES) {
    const transition = selectTransition({ outcome });
    assert.ok(transition, outcome);
    seen.add(transition);
  }
  // A tool failure and an indeterminate outcome route to their own transitions:
  // collapsing them into `to_fix` would report a broken harness as a defect.
  assert.equal(selectTransition({ outcome: "tool_failure" }), "to_tool_recovery");
  assert.equal(selectTransition({ outcome: "indeterminate" }), "to_reverify");
  assert.notEqual(selectTransition({ outcome: "tool_failure" }), selectTransition({ outcome: "fail" }));
  assert.equal(seen.size, OUTCOMES.length);
  assert.throws(() => selectTransition({ outcome: "invented" }), code("schema_invalid"));
});

test("no role holds a mutation tool", () => {
  // Not a policy about how models should behave: the absence of the tool.
  for (const role of Object.keys(capabilityModel.roles)) {
    const tools = toolsFor(capabilityModel, role);
    for (const forbidden of FORBIDDEN_TOOLS) {
      assert.ok(!tools.includes(forbidden), `${role} holds ${forbidden}`);
      assert.equal(permits(capabilityModel, role, forbidden), false);
    }
  }
  assert.throws(() => toolsFor(capabilityModel, "superuser"), code("scope_mismatch"));
});

test("a capability model that granted a forbidden tool is refused where it is read", () => {
  // The check is against the model, so a role added later cannot inherit
  // whatever this file happened to allow.
  const broken = {
    ...capabilityModel,
    roles: { ...capabilityModel.roles, implementer: [...capabilityModel.roles.implementer, "autosk_task_mutate"] },
  };
  assert.throws(() => toolsFor(broken, "implementer"), code("scope_mismatch"));
});

test("gate and verifier roles cannot edit the workspace", () => {
  assert.equal(permits(capabilityModel, "gate", "workspace_edit"), false);
  assert.equal(permits(capabilityModel, "verifier", "workspace_edit"), false);
  assert.equal(permits(capabilityModel, "implementer", "workspace_edit"), true);
});

test("every park reason the contract closes is one this module can raise", () => {
  const raised = new Set();
  const attempts = [
    () => parseSubmission("no result here"),
    () => parseSubmission(`${submitted(result())}${submitted(result())}`),
    () => validateSubmission(result({ kind: "nope" }), { dispatch, env: env() }),
    () => validateSubmission(result({ next_step: "x" }), { dispatch, env: env() }),
    () => validateSubmission(result({ claimed_changed_paths: ["nope.ts"] }), { dispatch, env: env() }),
    () => validateSubmission(result(), { dispatch, env: env({ resolveEvidence: () => false }) }),
    () =>
      validateSubmission(result({ step_identity: { ...result().step_identity, anchor_digest: "9".repeat(64) } }), {
        dispatch,
        env: env(),
      }),
    () =>
      validateSubmission(
        result({ step_identity: { ...result().step_identity, runtime_identity_digest: "9".repeat(64) } }),
        { dispatch, env: env() },
      ),
    () => validateBatch(batchResult({ batch: { tool_outcome: "tool_failure" } }), dispatch),
    () => validateBatch({ ...batchResult(), batch: { ...batchResult().batch, application_proof: undefined } }, dispatch),
    () => validateBatch({ ...batchResult(), batch: { ...batchResult().batch, green_control: undefined } }, dispatch),
    () => validateBatch({ ...batchResult(), batch: { ...batchResult().batch, restore_receipt: undefined } }, dispatch),
    () => validateBatch(batchResult({ batch: { harness_digest: "9".repeat(64) } }), dispatch),
  ];
  for (const attempt of attempts) {
    try {
      attempt();
    } catch (error) {
      raised.add(error.code);
    }
  }
  for (const reason of PARK_REASONS) {
    assert.ok(raised.has(reason), `${reason} is documented and never raised`);
  }
});
