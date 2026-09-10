/**
 * Tests for the consistency check over section 2's arrow-chain blocks.
 *
 * The blocks cannot be rendered from the document — it carries no chain layout —
 * so they stay hand-drawn and are checked instead. What is checked is
 * reachability rather than adjacency, because the notation summarises paths: a
 * chain drawing `select_next -> record_alignment` means the flow gets there, not
 * that the graph declares that edge. Demanding adjacency failed on 23 pairs that
 * were the chains abbreviating.
 *
 * A divergence the graph genuinely cannot walk is tolerated only when it is
 * named, because settling one is a normative edit to the plan's prose and not
 * this checker's decision. So there are two failures here, not one: a divergence
 * that is not named, and a name that no longer diverges.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CONTRACT_PATH, DOCUMENT_PATH, parseStrict } from "../scripts/validate-workflow-graph.mjs";
import { ROOT } from "../scripts/validate-refusal-vocabulary.mjs";
import {
  KNOWN_CHAIN_DIVERGENCES,
  PLAN_PATH,
  chainBlocks,
  chainErrors,
  readChains,
  reachableFrom,
} from "../scripts/check-workflow-chains.mjs";

const document = () => parseStrict(readFileSync(path.join(ROOT, DOCUMENT_PATH), "utf8"));
const plan = () => readFileSync(path.join(ROOT, PLAN_PATH), "utf8");

/** A reader that serves the plan from memory. */
const servingPlan = (text) => (file, encoding) =>
  file === path.join(ROOT, PLAN_PATH) ? text : readFileSync(file, encoding);

test("the shipped chains are consistent with the shipped graph", () => {
  assert.deepEqual(chainErrors(document()), []);
});

test("section 2 still has its eight blocks, one per registered workflow", () => {
  const blocks = chainBlocks(plan());
  assert.equal(blocks.length, 8);
  assert.equal(new Set(blocks.map((block) => block.workflow)).size, 8, "each block names its own workflow");
  assert.ok(!blocks.some((block) => block.workflow === "unknown"), "every block sits under a workflow heading");
});

test("the chains draw the human marks and nothing else says where a person acts", () => {
  const graph = document();
  const declared = new Set(graph.steps.map((step) => step.name));
  const { marks } = readChains(plan(), declared);
  assert.ok(marks.length > 0, "section 2 marks where a person acts");
  const humanSteps = new Set(
    graph.steps.filter((step) => step.kind === "status" && step.status === "human").map((step) => step.name),
  );
  for (const mark of marks) assert.ok(humanSteps.has(mark.step), `${mark.step} is marked (human) and is not one`);
});

test("a mark that drifts off its step is caught", () => {
  const graph = document();
  const moved = {
    ...graph,
    steps: graph.steps.map((step) =>
      step.name === "await_alignment"
        ? { name: step.name, kind: "agent", no_transition_reason: "project_boundary_invalid" }
        : step,
    ),
  };
  assert.ok(
    chainErrors(moved).some((message) => message.startsWith("chain_human_mark_unmatched")),
    "a step section 2 marks (human) must be a human status step in the graph",
  );
});

test("a divergence that is not named fails", () => {
  const graph = document();
  const blocks = chainBlocks(plan());
  // Draw a path the graph cannot walk: `done` is terminal, so nothing leaves it.
  const text = plan().replace(blocks[0].text, `${blocks[0].text}\ndone -> intake`);
  assert.notEqual(text, plan());
  const errors = chainErrors(graph, { read: servingPlan(text) });
  assert.ok(
    errors.some((message) => message.includes("done -> intake")),
    `an unnamed divergence must fail, got: ${errors.join("\n") || "(nothing)"}`,
  );
});

test("nothing is tolerated today, and the shipped chains need no tolerance", () => {
  assert.deepEqual([...KNOWN_CHAIN_DIVERGENCES], [], "a divergence is settled, not tolerated indefinitely");
  assert.deepEqual(chainErrors(document()), []);
});

test("a tolerated divergence passes and an unsettled one still fails beside it", () => {
  // Exercised with a list of its own rather than the shipped one, which is empty:
  // the mechanism has to keep working for the next gap, and a vacuous loop over an
  // empty list would prove nothing about it.
  const graph = document();
  const blocks = chainBlocks(plan());
  const text = plan().replace(blocks[0].text, `${blocks[0].text}\ndone -> intake\ndone -> select_next`);
  const read = servingPlan(text);
  assert.equal(chainErrors(graph, { read, tolerated: [] }).length, 2, "both are divergences to begin with");
  const errors = chainErrors(graph, { read, tolerated: ["autosk-planned: done -> intake"] });
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.ok(errors[0].includes("done -> select_next"), "only the named one is tolerated");
});

test("a name with no divergence behind it fails, so the list cannot go stale", () => {
  const graph = document();
  const errors = chainErrors(graph, { tolerated: ["autosk-planned: intake -> done"] });
  assert.deepEqual(errors, [
    "chain_divergence_stale: autosk-planned: intake -> done is named as known and no longer diverges",
  ]);
});

test("the contract names every divergence the checker tolerates", () => {
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  for (const named of KNOWN_CHAIN_DIVERGENCES) {
    assert.ok(contract.includes(named), `${named} is tolerated and the contract does not name it`);
  }
});

test("the three the owner settled are edges now, not exceptions", () => {
  const graph = document();
  for (const [from, to] of [
    ["resume_repaired_tickets", "ticket_join"],
    ["intake", "implement"],
    ["invalidate_quick_classification", "done"],
  ]) {
    assert.ok(
      graph.transitions.some((edge) => edge.from === from && edge.to === to),
      `${from} -> ${to} was read as an omission in the tables and belongs in the graph`,
    );
  }
});

test("reachability follows declared edges and stops where the flow stops", () => {
  const graph = document();
  assert.ok(reachableFrom(graph, "intake").has("done"), "the flow reaches its end");
  assert.equal(reachableFrom(graph, "done").size, 0, "nothing leaves a terminal step");
});

test("a misspelled step is a failure, not a placeholder the chain draws through", () => {
  const graph = document();
  // The chains draw through prose placeholders, so undeclared text cannot simply
  // fail. But dropping everything undeclared treated a typo as prose, and the
  // gate that exists to catch a rename missing one drawing passed it silently.
  const typo = plan().replace(
    "build_candidate -> verify_candidate -> freeze_candidate -> done",
    "build_candidate -> verfy_candidate -> freeze_candidate -> done",
  );
  assert.notEqual(typo, plan(), "the line the test edits still exists");
  const errors = chainErrors(graph, { read: servingPlan(typo) });
  assert.ok(
    errors.some((message) => message.includes("chain_step_unknown") && message.includes("verfy_candidate")),
    `a typo must fail, got: ${errors.join("\n") || "(nothing)"}`,
  );
});

test("prose the chain draws through is still not a failure", () => {
  // The counterpart to the test above: section 2 bridges chains across free text,
  // and a rule that failed on undeclared tokens outright would fail on those.
  assert.deepEqual(chainErrors(document()), []);
  const graph = document();
  const declared = new Set(graph.steps.map((step) => step.name));
  const { edges } = readChains(plan(), declared);
  assert.ok(
    edges.some((edge) => edge.from === "invalidate_quick_classification"),
    "a chain still crosses the placeholder that follows invalidate_quick_classification",
  );
});

test("a step standing alone on a line is the source of the line below it", () => {
  const graph = document();
  const declared = new Set(graph.steps.map((step) => step.name));
  const { edges } = readChains(plan(), declared);
  // Every block opens with a bare step and continues on the next line. Keeping a
  // source only for a line ending in a colon lost the Planned flow's very first
  // transition, so the gate claimed eight blocks and checked seven and a bit.
  assert.ok(
    edges.some((edge) => edge.workflow === "autosk-planned" && edge.from === "intake" && edge.to === "init_planning_ref"),
    "autosk-planned draws intake -> init_planning_ref and the reader must see it",
  );
  for (const workflow of new Set(edges.map((edge) => edge.workflow))) {
    assert.ok(edges.some((edge) => edge.workflow === workflow), `${workflow} contributes edges`);
  }
});

test("a typo in the one label that names sources is caught too", () => {
  const graph = document();
  // The same absence-blindness as the arrow branch, in the branch beside it: the
  // label's sources were filtered to declared names, so a misspelling silently
  // removed a source and the edge it carried, and nothing failed.
  const typo = plan().replace(
    "reclassification from intake/implement/verify/fix/",
    "reclassification from intake/implement/verfy/fix/",
  );
  assert.notEqual(typo, plan(), "the label the test edits still exists");
  const errors = chainErrors(graph, { read: servingPlan(typo) });
  assert.ok(
    errors.some((message) => message.includes("chain_step_unknown") && message.includes("verfy")),
    `a typo in the label must fail, got: ${errors.join("\n") || "(nothing)"}`,
  );

  // And the edge it carried is what would otherwise have gone missing quietly.
  const declared = new Set(graph.steps.map((step) => step.name));
  const before = readChains(plan(), declared).edges;
  assert.ok(
    before.some((edge) => edge.from === "verify" && edge.to === "invalidate_quick_classification"),
    "the label carries verify as a source",
  );
});

test("a prose label names no sources, however many step names it contains", () => {
  const graph = document();
  const declared = new Set(graph.steps.map((step) => step.name));
  const { edges } = readChains(plan(), declared);
  // `human alignment before normative planning:` is a heading, and `human` is a
  // step. Filtering the label for declared words made it a source of whatever
  // followed. What separates a source list from a heading is the slash run.
  assert.deepEqual(
    edges.filter((edge) => edge.from === "human"),
    [],
    "a heading that happens to contain a step name is not a source",
  );
  assert.equal(
    edges.filter((edge) => edge.to === "invalidate_quick_classification").length,
    8,
    "the one label that does carry sources still carries all eight",
  );
});

test("no branch of the reader drops a name-shaped token without saying so", () => {
  const graph = document();
  // Four defects in this file were the same shape: a filter that silently kept
  // only what it recognised. Each branch that reads a name is exercised here with
  // a token that looks like a step and is not one.
  const cases = [
    ["an arrow chain", "build_candidate -> verify_candidate", "build_candidate -> verfy_candidate", "verfy_candidate"],
    [
      "a source label",
      "reclassification from intake/implement/verify/fix/",
      "reclassification from intake/implement/verfy/fix/",
      "verfy",
    ],
    ["a lone opening step", "\n~~~text\nintake\n", "\n~~~text\nintaek\n", "intaek"],
  ];
  for (const [where, from, to, name] of cases) {
    const text = plan().replace(from, to);
    assert.notEqual(text, plan(), `${where}: the text the test edits still exists`);
    const errors = chainErrors(graph, { read: servingPlan(text) });
    assert.ok(
      errors.some((message) => message.startsWith("chain_step_unknown") && message.includes(name)),
      `${where}: ${name} must be reported, got: ${errors.join("\n") || "(nothing)"}`,
    );
  }
});
