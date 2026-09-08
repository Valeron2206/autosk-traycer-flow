#!/usr/bin/env node

/**
 * Design-time validator for the issue #32 bounded iteration loop.
 *
 * Iterating is how work gets done; unbounded iterating is how a budget
 * disappears. The checks here are about the three things that let a loop run
 * forever while looking productive: progress asserted rather than observed, a
 * tool retry spending the product's attempts, and a repeat with no new
 * hypothesis.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/bounded-loop.md";
export const SCHEMA_PATH = "resources/iteration-result/iteration-result.schema.json";
export const EXAMPLE_PATH = "resources/iteration-result/iteration-result.example.json";
export const ESCALATED_EXAMPLE_PATH = "resources/iteration-result/iteration-result.escalated.example.json";
export const CONTRACT_MARKER = "<!-- bounded-loop-contract:v1 -->";

export const TRIGGERS = Object.freeze([
  "repeated_failure", "decision_beyond_scope", "premise_invalidated", "permission_gap",
]);

/** Outcomes that say nothing about product behaviour. Owned by #24. */
export const NON_PRODUCT_OUTCOMES = Object.freeze([
  "green_control_failed", "mutation_not_applied", "tool_setup_failed", "tool_execution_failed",
  "restore_failed", "evidence_invalid", "timeout", "indeterminate",
]);

export const REFUSALS = Object.freeze([
  "loop_repeated_failure",
  "loop_decision_beyond_scope",
  "loop_premise_invalidated",
  "loop_permission_gap",
  "loop_no_progress",
  "loop_budget_exhausted",
  "loop_tool_budget_exhausted",
  "loop_restore_blocked",
  "loop_indeterminate_not_advanceable",
  "loop_counter_replay",
]);

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, ESCALATED_EXAMPLE_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function loopDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

/**
 * Whether an iteration made progress.
 *
 * Observed, not asserted: the same output text is not progress, and neither is a
 * formatting change that moved no criterion. Everything a model writes about
 * itself can be written by a model that did nothing.
 */
export function madeProgress(iteration, previous) {
  if (iteration.changed.tree_before === iteration.changed.tree_after) return false;
  if (previous && previous.progress_digest === iteration.progress_digest) return false;
  return true;
}

/**
 * What the loop does next.
 *
 * `history` is the iterations already recorded, oldest first.
 */
export function loopDecision(iteration, history = []) {
  if (history.some((entry) => entry.iteration_id === iteration.iteration_id)) {
    // The id is minted before the action, so a replay is recognised rather than
    // counted twice.
    return "refused:loop_counter_replay";
  }
  if (iteration.outcome === "escalated") {
    return `refused:loop_${iteration.escalation.trigger}`;
  }
  const outcome = iteration.verification.batch_outcome;
  if (outcome === "restore_failed") return "refused:loop_restore_blocked";
  if (outcome === "indeterminate") return "refused:loop_indeterminate_not_advanceable";

  const productDone = history.filter((entry) => entry.kind === "product").length;
  const toolDone = history.filter((entry) => entry.kind === "tool_retry").length;
  if (iteration.kind === "product") {
    // A tool retry never spends these: a harness that will not start should not
    // consume the attempts the product was given.
    if (productDone >= iteration.budgets.product_iterations_max) return "refused:loop_budget_exhausted";
  } else if (toolDone >= iteration.budgets.tool_retries_max) {
    return "refused:loop_tool_budget_exhausted";
  }

  // The iteration to compare against is the previous one OF THE SAME KIND. A
  // tool retry carries no product progress, so letting one stand as the
  // predecessor does two wrong things: it judges a product iteration against a
  // tree the product never touched, and — the direction that matters — it hides
  // a repeat, because one retry interleaved between two identical product
  // attempts makes the hypotheses differ and downgrades the stop to
  // `loop_no_progress`. Two budgets, and two histories.
  const previous = history.findLast((entry) => entry.kind === iteration.kind);
  if (!madeProgress(iteration, previous)) {
    // A repeat is allowed only with a new hypothesis or new evidence.
    const sameHypothesis = previous && previous.hypothesis === iteration.hypothesis;
    if (sameHypothesis) return "refused:loop_repeated_failure";
    return "refused:loop_no_progress";
  }
  return "continue";
}

export function validateIteration(iteration, schema) {
  const errors = validateJsonSchema(iteration, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  if (iteration.outcome === "escalated" && iteration.escalation === undefined) {
    errors.push("an escalated iteration must name its trigger");
  }
  if (iteration.outcome !== "escalated" && iteration.escalation !== undefined) {
    errors.push("only an escalated iteration carries a trigger");
  }
  // A product outcome is about the product. A tool retry claiming one is
  // reporting the harness as evidence about the code.
  if (iteration.kind === "tool_retry" && !NON_PRODUCT_OUTCOMES.includes(iteration.verification.batch_outcome)) {
    errors.push("a tool retry cannot carry a product outcome");
  }
  if (iteration.kind === "product" && NON_PRODUCT_OUTCOMES.includes(iteration.verification.batch_outcome)) {
    errors.push("a non-product outcome belongs to a tool retry, not a product iteration");
  }
  if (iteration.outcome === "advanced" && iteration.changed.tree_before === iteration.changed.tree_after) {
    errors.push("an iteration that changed no tree did not advance (loop_no_progress)");
  }
  // `restore_failed` blocks the next product mutation, so an iteration carrying
  // it cannot also claim to have advanced.
  if (iteration.verification.batch_outcome === "restore_failed" && iteration.outcome === "advanced") {
    errors.push("a failed restore cannot advance (loop_restore_blocked)");
  }
  return errors;
}

export function validateBoundedLoopDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const refusal of REFUSALS) {
    if (!contract.includes(refusal)) errors.push(`${CONTRACT_PATH}: refusal ${refusal} is not documented`);
  }
  if (!contract.includes("Trying again is not a hypothesis")) {
    errors.push(`${CONTRACT_PATH}: does not state what a repeat needs`);
  }
  if (!contract.includes("The same output text is not progress")) {
    errors.push(`${CONTRACT_PATH}: does not state how progress is decided`);
  }
  if (!contract.includes("does not widen its own tool scope")) {
    errors.push(`${CONTRACT_PATH}: does not state what the permission trigger prevents`);
  }
  if (!contract.includes("Two budgets")) {
    errors.push(`${CONTRACT_PATH}: does not state why the budgets are separate`);
  }

  let schema;
  try {
    schema = JSON.parse(files[SCHEMA_PATH]);
  } catch (error) {
    return [...errors, `${SCHEMA_PATH}: not valid JSON: ${error.message}`];
  }
  if (schema.additionalProperties !== false) {
    errors.push(`${SCHEMA_PATH}: root must be closed (additionalProperties:false)`);
  }
  const triggers = schema.properties?.escalation?.properties?.trigger?.enum ?? [];
  if (triggers.slice().sort().join(",") !== [...TRIGGERS].sort().join(",")) {
    errors.push(`${SCHEMA_PATH}: the four triggers must match the contract exactly`);
  }
  // The caps are pinned before dispatch, and the schema is what makes that
  // unskippable: a cap chosen while iterating is chosen by whoever is iterating.
  if (schema.properties?.budgets?.properties?.pinned_before_dispatch?.const !== true) {
    errors.push(`${SCHEMA_PATH}: budgets must be pinned before dispatch`);
  }
  for (const field of ["product_iterations_max", "tool_retries_max"]) {
    if (!(schema.properties?.budgets?.required ?? []).includes(field)) {
      errors.push(`${SCHEMA_PATH}: ${field} must be required, or the two budgets are one`);
    }
  }
  if (!(schema.required ?? []).includes("progress_digest")) {
    errors.push(`${SCHEMA_PATH}: progress must be recorded as a digest, not asserted`);
  }

  for (const relative of [EXAMPLE_PATH, ESCALATED_EXAMPLE_PATH]) {
    let iteration;
    try {
      iteration = JSON.parse(files[relative]);
    } catch (error) {
      errors.push(`${relative}: not valid JSON: ${error.message}`);
      continue;
    }
    errors.push(...validateIteration(iteration, schema).map((message) => `${relative}: ${message}`));
  }
  const first = JSON.parse(files[EXAMPLE_PATH]);
  const escalated = JSON.parse(files[ESCALATED_EXAMPLE_PATH]);
  if (loopDecision(first) !== "continue") {
    errors.push(`${EXAMPLE_PATH}: an advancing iteration does not continue (${loopDecision(first)})`);
  }
  if (loopDecision(escalated) !== "refused:loop_repeated_failure") {
    errors.push(`${ESCALATED_EXAMPLE_PATH}: the escalated example does not stop the loop`);
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateBoundedLoopDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Bounded loop design validation PASS");
    console.log(`design_digest=${loopDesignDigest(files)}`);
    console.log(`triggers=${TRIGGERS.length} refusals=${REFUSALS.length}`);
  }
}
