/**
 * Tests for the issue #24 work-type gates and verification batch contract.
 *
 * Four requirements are the easiest to state and the easiest to skip: an unknown
 * root cause, a refactor with no behaviour pin, a threshold chosen after the
 * numbers, and a batch that "passed" because a script exited 0.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_PATH,
  EXAMPLE_PATH,
  NON_PRODUCT_OUTCOMES,
  OUTCOMES,
  PREREQUISITES,
  REFUSALS,
  SCHEMA_PATH,
  WORK_TYPES,
  batchVerdict,
  implementationGate,
  isStale,
  loadFiles,
  validateBatch,
  validateWorkTypeGatesDesign,
  workTypeDesignDigest,
} from "../scripts/validate-work-type-gates.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);
const batch = () => JSON.parse(files[EXAMPLE_PATH]);

function mutated(mutate) {
  const value = batch();
  mutate(value);
  return value;
}

function ticket(work_type, extra = {}) {
  const filled = Object.fromEntries((PREREQUISITES[work_type] ?? []).map((field) => [field, "recorded"]));
  return { work_type, ...filled, ...extra };
}

function assertRejects(value, pattern) {
  const errors = validateBatch(value, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

test("the shipped design validates", () => {
  assert.deepEqual(validateWorkTypeGatesDesign(files), []);
});

test("a bug-fix cannot start with an unknown root cause", () => {
  assert.equal(implementationGate(ticket("bug-fix")), "ready");
  const unknown = ticket("bug-fix");
  delete unknown.root_cause;
  assert.equal(implementationGate(unknown), "refused:bugfix_root_cause_unknown");
});

test("investigate-and-fix in one handoff is refused", () => {
  // A handoff that may change the code has no way to prove what the code did
  // before it.
  assert.equal(
    implementationGate(ticket("bug-fix", { investigate_and_fix: true })),
    "refused:bugfix_investigate_and_fix_combined",
  );
});

test("a refactor cannot start without a behaviour pin", () => {
  const unpinned = ticket("refactoring");
  delete unpinned.behavior_pin;
  assert.equal(implementationGate(unpinned), "refused:refactor_behavior_pin_missing");
  // And a typecheck is not a pin: the contract says so, because it constrains
  // shape rather than behaviour.
  assert.ok(files[CONTRACT_PATH].includes("Typecheck and lint are not a pin"));
});

test("a perf threshold chosen after the numbers is a description of the result", () => {
  assert.equal(
    implementationGate(ticket("perf", { threshold_fixed_before_baseline: false })),
    "refused:perf_threshold_after_result",
  );
  assert.equal(implementationGate(ticket("perf", { threshold_fixed_before_baseline: true })), "ready");
});

test("a feature records its organizing structure and why it is not booleans", () => {
  const thin = ticket("feature");
  delete thin.why_not_booleans;
  assert.match(implementationGate(thin), /batch_proof_contract_incomplete/u);
});

test("a missing or mixed work type is refused", () => {
  assert.equal(implementationGate({}), "refused:worktype_missing");
  assert.equal(implementationGate({ work_type: ["feature", "bug-fix"] }), "refused:worktype_mixed");
});

test("a batch is not sufficient because a script exited 0", () => {
  // The sentence this whole section exists for.
  assert.equal(batchVerdict(batch()), "product_pass");
  for (const outcome of NON_PRODUCT_OUTCOMES) {
    assert.equal(
      batchVerdict(
        mutated((value) => {
          value.batch_outcome = outcome;
        }),
      ),
      `blocked:${outcome}`,
    );
  }
  assert.ok(files[CONTRACT_PATH].includes("A batch is not sufficient because a temporary script exited 0"));
});

test("a mutation that was not applied is not a product pass", () => {
  assert.equal(
    batchVerdict(
      mutated((value) => {
        value.matrix[0].outcome = "mutation_not_applied";
      }),
    ),
    "blocked:mutation_not_applied",
  );
});

test("a failed green control voids the evidence", () => {
  // If the unmutated candidate fails its own controls, the red result means
  // nothing.
  assert.equal(
    batchVerdict(
      mutated((value) => {
        value.matrix[0].outcome = "green_control_failed";
      }),
    ),
    "blocked:green_control_failed",
  );
});

test("a harness that never killed a known mutation has not self-tested", () => {
  assert.equal(
    batchVerdict(
      mutated((value) => {
        value.self_test.observed = "survived";
      }),
    ),
    "blocked:batch_proof_contract_incomplete",
  );
  assert.equal(
    batchVerdict(
      mutated((value) => {
        delete value.self_test;
      }),
    ),
    "blocked:batch_proof_contract_incomplete",
  );
});

test("restoring to something other than the base tree is not a restore", () => {
  assertRejects(
    mutated((value) => {
      value.recovery.post_restore_identity = "9".repeat(40);
    }),
    /not the base tree/u,
  );
});

test("every outcome that is not a product result blocks", () => {
  // An outcome left out of the blocking set is one the acceptance rule quietly
  // admits.
  for (const outcome of NON_PRODUCT_OUTCOMES) {
    assertRejects(
      mutated((value) => {
        value.acceptance_rule.blocking_outcomes = value.acceptance_rule.blocking_outcomes.filter(
          (entry) => entry !== outcome,
        );
      }),
      new RegExp(`${outcome} is not blocking`, "u"),
    );
  }
});

test("every mutation carries its application proof, killer and controls", () => {
  const required = schema.properties.matrix.items.required;
  for (const field of ["application_proof", "expected_killer", "expected_red", "green_controls"]) {
    assert.ok(required.includes(field), `${field} is optional`);
  }
});

test("a result is stale when anything it was bound to has moved", () => {
  const value = batch();
  assert.equal(isStale(value, { candidate_tree: value.candidate.candidate_tree }), false);
  assert.equal(isStale(value, { candidate_tree: "9".repeat(40) }), true);
  assert.equal(isStale(value, { harness_digest: "9".repeat(64) }), true);
  assert.equal(isStale(value, { mutation_set_digest: "9".repeat(64) }), true);
});

test("ephemeral scaffolding lives in a project-owned evidence root", () => {
  assertRejects(
    mutated((value) => {
      value.owner.location = "src/tools/mutant.mjs";
    }),
    /project-owned evidence root/u,
  );
});

test("the work types, outcomes and refusals are closed and documented", () => {
  assert.deepEqual(schema.properties.work_type.enum.slice().sort(), [...WORK_TYPES].sort());
  assert.deepEqual(schema.properties.batch_outcome.enum.slice().sort(), [...OUTCOMES].sort());
  const contract = files[CONTRACT_PATH];
  for (const refusal of REFUSALS) assert.ok(contract.includes(refusal), `${refusal} is not documented`);
});

test("removing a listing means removing it, not relocating it", () => {
  // Rewriting, moving to an appendix, hiding under details, translating or
  // leaving equivalent pseudocode all keep the thing the disposition removed.
  const contract = files[CONTRACT_PATH];
  for (const evasion of ["Rewriting it", "appendix", "<details>", "another language", "equivalent pseudocode"]) {
    assert.ok(contract.includes(evasion), `${evasion} is not named as an evasion`);
  }
});

test("the design digest changes when any shipped file changes", () => {
  const before = workTypeDesignDigest(files);
  const after = workTypeDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
