/**
 * Tests for the issue #18 model-result validator.
 *
 * One invariant, defended from several directions: a model's output is evidence,
 * not an effect. Each case is a way that could stop being true — a role holding
 * a mutation tool, a result naming its own next step, a tool failure becoming a
 * product verdict, a batch claiming a pass without the proofs.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  BATCH_EXAMPLE_PATH,
  CAPABILITIES_PATH,
  CONTRACT_PATH,
  EXAMPLE_PATH,
  FORBIDDEN_TOOLS,
  KINDS,
  PARK_REASONS,
  ROOT,
  SCHEMA_PATH,
  WORK_OUTCOMES,
  loadFiles,
  modelResultDesignDigest,
  selectTransition,
  validateCapabilities,
  validateModelResultDesign,
  validateResult,
} from "../scripts/validate-model-result.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

function example(which = EXAMPLE_PATH) {
  return JSON.parse(files[which]);
}

function mutated(mutate, which = EXAMPLE_PATH) {
  const value = example(which);
  mutate(value);
  return value;
}

function assertRejects(value, pattern) {
  const errors = validateResult(value, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

test("the shipped design validates", () => {
  assert.deepEqual(validateModelResultDesign(files), []);
});

test("both examples validate", () => {
  assert.deepEqual(validateResult(example(), schema), []);
  assert.deepEqual(validateResult(example(BATCH_EXAMPLE_PATH), schema), []);
});

test("no role may hold a canonical-state mutation tool", () => {
  // Not a policy about how models should behave: the absence of the tool.
  const capabilities = JSON.parse(files[CAPABILITIES_PATH]);
  for (const [role, tools] of Object.entries(capabilities.roles)) {
    for (const forbidden of FORBIDDEN_TOOLS) {
      assert.ok(!tools.includes(forbidden), `${role} holds ${forbidden}`);
    }
  }
  const broken = JSON.parse(files[CAPABILITIES_PATH]);
  broken.roles.implementer = [...broken.roles.implementer, "autosk_task_mutate"];
  assert.ok(
    validateCapabilities(broken).some((message) => /no role may mutate canonical task state/u.test(message)),
    "a role holding a mutation tool must be refused",
  );
});

test("a role holds at most one submit tool: a step submits exactly one result", () => {
  const broken = JSON.parse(files[CAPABILITIES_PATH]);
  broken.roles.implementer = [...broken.roles.implementer, "submit_gate_result"];
  assert.ok(
    validateCapabilities(broken).some((message) => /a step submits exactly one result/u.test(message)),
    "two submit tools must be refused",
  );
});

test("a result cannot name its own transition", () => {
  // A model that could name the next step would be moving the task with extra
  // steps. The schema has no such field, and being closed it refuses one — which
  // is why the validator does not repeat the check: a second guard that the
  // schema always reaches first would never be evaluated.
  for (const forbidden of ["next_step", "transition", "transit", "target_step"]) {
    assert.ok(!Object.hasOwn(schema.properties, forbidden), `the schema defines ${forbidden}`);
    assertRejects(
      mutated((value) => {
        value[forbidden] = "review";
      }),
      /schema:/u,
    );
  }
});

test("an unknown field is refused: the schema is closed", () => {
  assertRejects(
    mutated((value) => {
      value.confidence = "high";
    }),
    /schema:/u,
  );
});

test("an out-of-enum outcome is refused", () => {
  assertRejects(
    mutated((value) => {
      value.outcome = "probably_fine";
    }),
    /schema:/u,
  );
});

test("an implementation may only report a work outcome", () => {
  assertRejects(
    mutated((value) => {
      value.outcome = "pass";
    }),
    new RegExp(`is not one of ${WORK_OUTCOMES.join(", ")}`, "u"),
  );
});

test("ready_for_verification must claim paths and cite evidence", () => {
  // The claim is what the host compares against Git. A result with nothing to
  // compare cannot be checked, and an unchecked claim is prose.
  assertRejects(
    mutated((value) => {
      delete value.claimed_changed_paths;
    }),
    /must claim the paths it changed/u,
  );
  assertRejects(
    mutated((value) => {
      value.evidence = [];
    }),
    /must reference evidence per criterion/u,
  );
});

test("a claimed path cannot escape the workspace", () => {
  assertRejects(
    mutated((value) => {
      value.claimed_changed_paths = ["../outside/file.ts"];
    }),
    /schema:/u,
  );
});

test("a passing batch needs its three proofs", () => {
  // The schema requires them only for a batch that claims a pass; a failed or
  // indeterminate run may legitimately have crashed before restoring. That is
  // what makes this check reachable rather than shadowed by the schema.
  for (const [field, pattern] of [
    ["application_proof", /needs a mutation-application proof/u],
    ["green_control", /needs a green control/u],
    ["restore_receipt", /needs a restore receipt/u],
  ]) {
    assertRejects(
      mutated((value) => {
        delete value.batch[field];
      }, BATCH_EXAMPLE_PATH),
      pattern,
    );
  }

  // ...and a failing batch without them is accepted, so the rule is conditional
  // rather than merely relocated.
  const failed = mutated((value) => {
    value.batch.product_outcome = "fail";
    delete value.batch.application_proof;
    delete value.batch.green_control;
    delete value.batch.restore_receipt;
  }, BATCH_EXAMPLE_PATH);
  assert.deepEqual(validateResult(failed, schema), []);
});

test("a tool failure is never a product disposition", () => {
  // "The harness broke" and "the product is wrong" are different facts. A
  // mapping that collapses them manufactures a verdict nobody produced.
  const broken = mutated((value) => {
    value.batch.tool_outcome = "tool_failure";
  }, BATCH_EXAMPLE_PATH);
  assertRejects(broken, /the harness broke, which says nothing about the product/u);
  assert.equal(selectTransition(broken), "park:tool_failure_not_product_disposition");

  const environment = mutated((value) => {
    value.batch.environment_outcome = "environment_failure";
    value.batch.product_outcome = "indeterminate";
  }, BATCH_EXAMPLE_PATH);
  assert.deepEqual(validateResult(environment, schema), []);
  assert.equal(selectTransition(environment), "park:tool_failure_not_product_disposition");
});

test("an indeterminate product outcome parks rather than passing or failing", () => {
  const value = mutated((draft) => {
    draft.batch.product_outcome = "indeterminate";
  }, BATCH_EXAMPLE_PATH);
  assert.equal(selectTransition(value), "park:tool_failure_not_product_disposition");
});

test("only a verification batch carries batch outcomes", () => {
  assertRejects(
    mutated((value) => {
      value.batch = example(BATCH_EXAMPLE_PATH).batch;
    }),
    /must not carry batch outcomes/u,
  );
});

test("the transition follows the outcome, deterministically", () => {
  assert.equal(selectTransition(example()), "verify");
  assert.equal(selectTransition(example(BATCH_EXAMPLE_PATH)), "verified");
  assert.equal(
    selectTransition(
      mutated((value) => {
        value.outcome = "needs_human";
      }),
    ),
    "human",
  );
  assert.equal(
    selectTransition(
      mutated((value) => {
        value.batch.product_outcome = "fail";
      }, BATCH_EXAMPLE_PATH),
    ),
    "rejected",
  );
});

test("the kinds are exactly the seven the contract names", () => {
  assert.deepEqual(schema.properties.kind.enum, [...KINDS]);
});

test("identity fields the host revalidates are required", () => {
  for (const field of ["anchor_digest", "runtime_identity_digest"]) {
    assertRejects(
      mutated((value) => {
        delete value.step_identity[field];
      }),
      /schema:/u,
    );
  }
});

test("every park reason is documented in the contract", () => {
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  for (const reason of PARK_REASONS) {
    assert.ok(contract.includes(reason), `${reason} is not documented`);
  }
});

test("the design digest changes when any shipped file changes", () => {
  const before = modelResultDesignDigest(files);
  const after = modelResultDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
