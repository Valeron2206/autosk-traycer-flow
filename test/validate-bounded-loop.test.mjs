/**
 * Tests for the issue #32 bounded iteration loop.
 *
 * Three things let a loop run forever while looking productive: progress
 * asserted rather than observed, a tool retry spending the product's attempts,
 * and a repeat with no new hypothesis.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_PATH,
  ESCALATED_EXAMPLE_PATH,
  EXAMPLE_PATH,
  NON_PRODUCT_OUTCOMES,
  REFUSALS,
  SCHEMA_PATH,
  TRIGGERS,
  loadFiles,
  loopDecision,
  loopDesignDigest,
  madeProgress,
  validateBoundedLoopDesign,
  validateIteration,
} from "../scripts/validate-bounded-loop.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

const first = () => JSON.parse(files[EXAMPLE_PATH]);
const escalated = () => JSON.parse(files[ESCALATED_EXAMPLE_PATH]);

function mutated(mutate, base = first) {
  const value = base();
  mutate(value);
  return value;
}

test("the shipped design validates", () => {
  assert.deepEqual(validateBoundedLoopDesign(files), []);
});

test("progress is observed, not asserted", () => {
  // Everything a model writes about itself can be written by a model that did
  // nothing.
  assert.equal(madeProgress(first()), true);
  assert.equal(
    madeProgress(
      mutated((value) => {
        value.changed.tree_after = value.changed.tree_before;
      }),
    ),
    false,
  );
  // The same output text is not progress.
  assert.equal(madeProgress(first(), { progress_digest: first().progress_digest }), false);
  assert.ok(files[CONTRACT_PATH].includes("The same output text is not progress"));
});

test("a repeat with the same hypothesis and no change is repeated failure", () => {
  // Trying again is not a hypothesis.
  const previous = first();
  const again = mutated((value) => {
    value.iteration_id = "iter-002";
    value.iteration_number = 2;
    value.changed.tree_after = value.changed.tree_before;
  });
  assert.equal(loopDecision(again, [previous]), "refused:loop_repeated_failure");
});

test("a repeat with a new hypothesis is no-progress, not repeated failure", () => {
  // The distinction matters: one says stop, the other says this attempt did
  // nothing and the next may still be worth trying.
  const previous = first();
  const different = mutated((value) => {
    value.iteration_id = "iter-002";
    value.iteration_number = 2;
    value.hypothesis = "the guard may be reachable only through the session meta path";
    value.changed.tree_after = value.changed.tree_before;
  });
  assert.equal(loopDecision(different, [previous]), "refused:loop_no_progress");
});

test("a tool retry between two identical attempts does not hide the repeat", () => {
  // The dangerous direction of comparing against the wrong predecessor: the
  // interleaved retry has a different hypothesis, so a real repeated failure
  // would be downgraded to a no-progress note and the loop would keep going.
  const previous = first();
  const retry = { ...escalated(), iteration_id: "tool-001", outcome: "no_progress", escalation: undefined };
  const again = mutated((value) => {
    value.iteration_id = "iter-002";
    value.iteration_number = 2;
    value.changed.tree_after = value.changed.tree_before;
  });
  assert.equal(loopDecision(again, [previous, retry]), "refused:loop_repeated_failure");
});

test("the four triggers stop the loop, each under its own name", () => {
  for (const trigger of TRIGGERS) {
    const stopped = mutated((value) => {
      value.outcome = "escalated";
      value.escalation = { trigger, detail: "a detail long enough to be a sentence" };
    });
    assert.equal(loopDecision(stopped), `refused:loop_${trigger}`);
  }
});

test("a tool retry does not spend the product's attempts", () => {
  // A harness that will not start should not consume the attempts the product
  // was given.
  const history = Array.from({ length: 5 }, (_, i) => ({
    ...escalated(), iteration_id: `tool-${i}`, kind: "tool_retry",
  }));
  const product = mutated((value) => {
    value.iteration_id = "iter-999";
    value.iteration_number = 6;
  });
  assert.equal(loopDecision(product, history.slice(0, 2)), "continue");
  // ...and its own budget is what a tool retry exhausts.
  const retry = mutated((value) => {
    value.iteration_id = "tool-new";
    value.kind = "tool_retry";
    value.verification = { batch_outcome: "tool_setup_failed" };
  });
  assert.equal(loopDecision(retry, history.slice(0, 3)), "refused:loop_tool_budget_exhausted");
});

test("the product budget is exhausted by product iterations", () => {
  const history = Array.from({ length: 5 }, (_, i) => ({ ...first(), iteration_id: `iter-${i}` }));
  const next = mutated((value) => {
    value.iteration_id = "iter-new";
  });
  assert.equal(loopDecision(next, history), "refused:loop_budget_exhausted");
});

test("budgets are pinned before dispatch, and the schema is what makes that unskippable", () => {
  // A cap chosen while iterating is a cap chosen by whoever is iterating.
  assert.equal(schema.properties.budgets.properties.pinned_before_dispatch.const, true);
  for (const field of ["product_iterations_max", "tool_retries_max"]) {
    assert.ok(schema.properties.budgets.required.includes(field), `${field} is optional`);
  }
});

test("a failed restore blocks the next iteration", () => {
  // Continuing to mutate a product that was not restored compounds a state
  // nobody can now describe.
  const blocked = mutated((value) => {
    value.kind = "tool_retry";
    value.verification = { batch_outcome: "restore_failed" };
    value.outcome = "no_progress";
  });
  assert.equal(loopDecision(blocked), "refused:loop_restore_blocked");
  const errors = validateIteration(
    mutated((value) => {
      value.kind = "tool_retry";
      value.verification = { batch_outcome: "restore_failed" };
    }),
    schema,
  );
  assert.ok(errors.some((message) => /failed restore cannot advance/u.test(message)));
});

test("indeterminate does not advance a gate", () => {
  // And is not read as "no defect found".
  const unknown = mutated((value) => {
    value.kind = "tool_retry";
    value.verification = { batch_outcome: "indeterminate" };
    value.outcome = "no_progress";
  });
  assert.equal(loopDecision(unknown), "refused:loop_indeterminate_not_advanceable");
});

test("a tool retry cannot carry a product outcome, and the reverse", () => {
  const errors = validateIteration(
    mutated((value) => {
      value.kind = "tool_retry";
    }),
    schema,
  );
  assert.ok(errors.some((message) => /cannot carry a product outcome/u.test(message)));
  for (const outcome of NON_PRODUCT_OUTCOMES) {
    const wrong = validateIteration(
      mutated((value) => {
        value.verification = { batch_outcome: outcome };
      }),
      schema,
    );
    assert.ok(wrong.some((message) => /belongs to a tool retry/u.test(message)), outcome);
  }
});

test("a replayed iteration id is recognised, not counted twice", () => {
  // The id is minted before the action, so a crash between doing and recording
  // does not double the counter or the side effect.
  const previous = first();
  assert.equal(loopDecision(previous, [previous]), "refused:loop_counter_replay");
});

test("an escalated iteration names its trigger, and nothing else does", () => {
  const errors = validateIteration(
    mutated((value) => {
      value.outcome = "escalated";
    }),
    schema,
  );
  assert.ok(errors.some((message) => /must name its trigger/u.test(message)));
  const spurious = validateIteration(
    mutated((value) => {
      value.escalation = { trigger: "permission_gap", detail: "a detail long enough" };
    }),
    schema,
  );
  assert.ok(spurious.some((message) => /only an escalated iteration/u.test(message)));
});

test("the permission trigger is about not widening scope", () => {
  assert.ok(files[CONTRACT_PATH].includes("does not widen its own tool scope"));
});

test("every refusal is documented", () => {
  const contract = files[CONTRACT_PATH];
  for (const refusal of REFUSALS) assert.ok(contract.includes(refusal), `${refusal} is not documented`);
});

test("the design digest changes when any shipped file changes", () => {
  const before = loopDesignDigest(files);
  const after = loopDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
