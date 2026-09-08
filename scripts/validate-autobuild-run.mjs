#!/usr/bin/env node

/**
 * Design-time validator for the issue #28 Autobuild run.
 *
 * Autobuild is a loop that writes code, evaluates its own output and decides
 * whether to keep going. The checks here are about the four ways that ends
 * badly: a run nobody approved, a rubric that moved after the result was seen,
 * a budget the model was asked to respect rather than one the host enforced,
 * and a pair of parties that is really one party with two names.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/autobuild-run.md";
export const CONTRACT_SCHEMA_PATH = "resources/autobuild-run/run-contract.schema.json";
export const RECORD_SCHEMA_PATH = "resources/autobuild-run/run-record.schema.json";
export const CONTRACT_EXAMPLE_PATH = "resources/autobuild-run/run-contract.example.json";
export const RECORD_EXAMPLE_PATH = "resources/autobuild-run/run-record.example.json";
export const REFUSED_EXAMPLE_PATH = "resources/autobuild-run/run-record.refused.example.json";
export const CONTRACT_MARKER = "<!-- autobuild-run-contract:v1 -->";

/** The twelve things approval covers, named in the issue. */
export const APPROVAL_COVERS = Object.freeze([
  "spec",
  "finish_predicate",
  "permissions",
  "evaluation",
  "rubric",
  "max_sprints",
  "wall_clock_ms",
  "cost_units",
  "max_consecutive_non_improving",
  "max_negotiation_rounds",
  "escape_hatch",
  "acceptance",
]);

/**
 * Leading characters a spreadsheet reads as a formula. The trail is exported
 * and opened, and its strings are written by the two parties the run exists to
 * supervise.
 */
export const FORMULA_PREFIXES = Object.freeze(["=", "+", "-", "@", "\t", "\r"]);

export const REFUSALS = Object.freeze([
  "autobuild_no_approved_contract",
  "autobuild_rubric_mutated",
  "autobuild_predicate_weakened",
  "autobuild_budget_not_host_enforced",
  "autobuild_budget_exceeded",
  "autobuild_no_progress_cap",
  "autobuild_negotiation_cap",
  "autobuild_pair_not_independent",
  "autobuild_evaluator_wrote",
  "autobuild_gate_bypassed",
  "autobuild_major_discovery",
  "autobuild_sprint_replay",
  "autobuild_trail_rewritten",
  "autobuild_trail_injection",
  "autobuild_run_continued_after_stop",
]);

/** The budget each spend counter is measured against, and the stop it forces. */
const BUDGETS = Object.freeze([
  { spent: "sprints", limit: "max_sprints", reason: "max_sprints" },
  { spent: "wall_clock_ms", limit: "wall_clock_ms", reason: "wall_clock" },
  { spent: "cost_units", limit: "cost_units", reason: "cost" },
  { spent: "tokens", limit: "tokens", reason: "tokens" },
  { spent: "restarts", limit: "max_restarts", reason: "escape_hatch" },
]);

export function loadFiles() {
  const files = {};
  for (const relative of [
    CONTRACT_PATH,
    CONTRACT_SCHEMA_PATH,
    RECORD_SCHEMA_PATH,
    CONTRACT_EXAMPLE_PATH,
    RECORD_EXAMPLE_PATH,
    REFUSED_EXAMPLE_PATH,
  ]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonical(value) {
  // Sorted keys and no whitespace: the digest is over the values, not over the
  // formatting of the file they arrived in.
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function autobuildDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

/** The contract's identity: everything except the approval that points at it. */
export function contractDigest(contract) {
  const { approval, ...body } = contract;
  return sha256(canonical(body));
}

export function rubricDigest(contract) {
  return sha256(canonical(contract.rubric.criteria));
}

export function predicateDigest(contract) {
  return sha256(
    canonical({
      check_command: contract.finish_predicate.check_command,
      statement: contract.finish_predicate.statement,
    }),
  );
}

/** The weighted rubric score of a sprint. Non-improvement is computed from it. */
export function rubricScore(contract, sprint) {
  const weights = new Map(contract.rubric.criteria.map((entry) => [entry.id, entry.weight ?? 1]));
  return sprint.rubric_scores.reduce((total, entry) => total + entry.score * (weights.get(entry.criterion_id) ?? 1), 0);
}

/** Whether a sprint improved on its predecessor. Computed, so "it is getting closer" is not an input. */
export function improved(contract, sprint, previous) {
  if (!previous) return true;
  return rubricScore(contract, sprint) > rubricScore(contract, previous);
}

export function validateContract(contract, schema) {
  const errors = validateJsonSchema(contract, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const digest = contractDigest(contract);
  if (contract.approval.approved_digest !== digest) {
    // Approval is of a digest: one that does not name the bytes it approved
    // cannot be checked against the bytes that ran.
    errors.push(`autobuild_no_approved_contract: approval names ${contract.approval.approved_digest}, contract is ${digest}`);
  }
  if (contract.rubric.digest !== rubricDigest(contract)) {
    errors.push("autobuild_rubric_mutated: the rubric digest does not recompute from its criteria");
  }
  if (contract.finish_predicate.digest !== predicateDigest(contract)) {
    errors.push("autobuild_predicate_weakened: the finish predicate digest does not recompute");
  }
  if (!contract.rubric.criteria.some((entry) => entry.non_negotiable)) {
    errors.push("autobuild_rubric_mutated: a rubric with no non-negotiable criterion cannot fail a run");
  }
  return errors;
}

export function validateRun(record, contract, schema) {
  const errors = validateJsonSchema(record, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const digest = contractDigest(contract);
  if (record.contract_digest !== digest) {
    errors.push(`autobuild_no_approved_contract: the run cites ${record.contract_digest}, approved is ${digest}`);
  }
  if (record.contract_version !== contract.contract_version) {
    errors.push("autobuild_rubric_mutated: the run's contract version is not the approved one");
  }
  if (contract.enforcement.budgets_enforced_by !== "host") {
    errors.push("autobuild_budget_not_host_enforced: a budget the model is asked to respect is a request");
  }
  if (record.stop && record.stop.enforced_by === "model") {
    errors.push("autobuild_budget_not_host_enforced: the run was stopped by the model, not by the host");
  }

  const { generator, evaluator } = record.parties;
  if (generator.session_id === evaluator.session_id || generator.family === evaluator.family) {
    // A pair that shares a family or a session is one party with two names.
    errors.push(`autobuild_pair_not_independent: ${generator.family}/${evaluator.family}`);
  }

  const seen = new Set();
  let previous;
  let nonImproving = 0;
  for (const sprint of record.sprints) {
    if (seen.has(sprint.sprint_id)) {
      errors.push(`autobuild_sprint_replay: ${sprint.sprint_id} was dispatched twice`);
    }
    seen.add(sprint.sprint_id);
    if (sprint.contract_digest !== digest) {
      // The rubric moving mid-run is indistinguishable, in the artifact, from
      // having chosen a better rubric.
      errors.push(`autobuild_rubric_mutated: ${sprint.sprint_id} ran under ${sprint.contract_digest}`);
    }
    if (sprint.evaluator_wrote) {
      errors.push(`autobuild_evaluator_wrote: ${sprint.sprint_id}`);
    }
    for (const [gate, verdict] of Object.entries(sprint.gates)) {
      if (gate === "integration_receipt") continue;
      if (verdict !== "pass") {
        errors.push(`autobuild_gate_bypassed: ${sprint.sprint_id} ${gate} is ${verdict}`);
      }
    }
    if (sprint.gates.integration_receipt === null && sprint.outcome !== "stopped") {
      errors.push(`autobuild_gate_bypassed: ${sprint.sprint_id} integrated without a receipt`);
    }
    const known = new Set(contract.rubric.criteria.map((entry) => entry.id));
    for (const score of sprint.rubric_scores) {
      if (!known.has(score.criterion_id)) {
        errors.push(`autobuild_rubric_mutated: ${sprint.sprint_id} scores unknown criterion ${score.criterion_id}`);
      }
    }
    if (sprint.rubric_scores.length !== contract.rubric.criteria.length) {
      errors.push(`autobuild_rubric_mutated: ${sprint.sprint_id} does not score every criterion`);
    }
    if (sprint.outcome === "finished") {
      const unmet = contract.rubric.criteria.filter(
        (criterion) =>
          criterion.non_negotiable &&
          !sprint.rubric_scores.find((score) => score.criterion_id === criterion.id)?.met,
      );
      if (unmet.length > 0) {
        errors.push(`autobuild_predicate_weakened: ${sprint.sprint_id} finished with ${unmet[0].id} unmet`);
      }
      if (sprint.finish_predicate_digest !== contract.finish_predicate.digest) {
        errors.push(`autobuild_predicate_weakened: ${sprint.sprint_id} cites another finish predicate`);
      }
    }
    if (sprint.discovery === "major" && !sprint.revision_ref) {
      // A loop that absorbs a product decision as an implementation detail
      // decides it without anyone noticing that it was decided.
      errors.push(`autobuild_major_discovery: ${sprint.sprint_id} continued without a revision`);
    }
    const advanced = improved(contract, sprint, previous);
    if (advanced !== (sprint.outcome === "improved") && sprint.outcome !== "finished" && sprint.outcome !== "stopped") {
      errors.push(`autobuild_no_progress_cap: ${sprint.sprint_id} records ${sprint.outcome}, computed ${advanced ? "improved" : "no_improvement"}`);
    }
    nonImproving = advanced ? 0 : nonImproving + 1;
    previous = sprint;
  }

  if (record.spent.consecutive_non_improving !== nonImproving) {
    errors.push(`autobuild_no_progress_cap: recorded ${record.spent.consecutive_non_improving}, computed ${nonImproving}`);
  }
  if (nonImproving >= contract.limits.max_consecutive_non_improving && record.stop?.reason !== "no_progress") {
    errors.push(`autobuild_no_progress_cap: ${nonImproving} non-improving sprints without a stop`);
  }
  if (record.spent.negotiation_rounds > contract.limits.max_negotiation_rounds) {
    errors.push(`autobuild_negotiation_cap: ${record.spent.negotiation_rounds} rounds over ${contract.limits.max_negotiation_rounds}`);
  }
  for (const budget of BUDGETS) {
    if (record.spent[budget.spent] > contract.limits[budget.limit] && record.stop?.reason !== budget.reason) {
      errors.push(`autobuild_budget_exceeded: ${budget.spent} ${record.spent[budget.spent]} over ${contract.limits[budget.limit]}`);
    }
  }

  // A stopped run is stopped, including when the party that stopped it was the
  // one that could no longer answer: the surviving party does not take over
  // both jobs, and a restart continues this run rather than a similar one.
  const stoppedAt = record.sprints.findIndex((sprint) => sprint.outcome === "stopped");
  if (stoppedAt !== -1 && stoppedAt !== record.sprints.length - 1) {
    errors.push(`autobuild_run_continued_after_stop: ${record.sprints[stoppedAt + 1].sprint_id} follows a stopped sprint`);
  }
  const last = record.sprints[record.sprints.length - 1];
  if (record.stop && last && last.outcome !== "finished" && last.outcome !== "stopped") {
    errors.push(`autobuild_run_continued_after_stop: the run stopped with ${last.sprint_id} recorded as ${last.outcome}`);
  }
  if (!record.stop && last && (last.outcome === "finished" || last.outcome === "stopped")) {
    errors.push(`autobuild_run_continued_after_stop: ${last.sprint_id} is ${last.outcome} with no stop recorded`);
  }

  errors.push(...trailErrors(record.trail));
  return errors;
}

/** Append-only in one direction, inert in the other. */
export function trailErrors(trail) {
  const errors = [];
  let prev = "0".repeat(64);
  for (const [index, entry] of trail.entries()) {
    if (entry.seq !== index + 1) {
      errors.push(`autobuild_trail_rewritten: entry ${entry.seq} is in position ${index + 1}`);
    }
    if (entry.prev_digest !== prev) {
      // The chain is what makes "append-only" checkable after the fact: an
      // edited entry breaks every digest after it.
      errors.push(`autobuild_trail_rewritten: entry ${entry.seq} does not chain to its predecessor`);
    }
    prev = sha256(
      canonical({
        actor: entry.actor,
        at: entry.at,
        kind: entry.kind,
        prev_digest: entry.prev_digest,
        seq: entry.seq,
        text: entry.text,
      }),
    );
    if (FORMULA_PREFIXES.some((prefix) => entry.text.startsWith(prefix))) {
      errors.push(`autobuild_trail_injection: entry ${entry.seq} begins with ${JSON.stringify(entry.text[0])}`);
    }
  }
  return errors;
}

export function validateAutobuildDesign(files) {
  const errors = [];
  const contractDoc = files[CONTRACT_PATH];
  if (!contractDoc.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  for (const relative of [CONTRACT_SCHEMA_PATH, RECORD_SCHEMA_PATH]) {
    if (!contractDoc.includes(relative)) errors.push(`${CONTRACT_PATH}: does not point at ${relative}`);
  }
  for (const refusal of REFUSALS) {
    if (!contractDoc.includes(refusal)) errors.push(`${CONTRACT_PATH}: refusal ${refusal} is not documented`);
  }
  if (!contractDoc.includes("opt-in")) {
    errors.push(`${CONTRACT_PATH}: does not state that there is no default that starts a run`);
  }
  if (!contractDoc.includes("Approval is of a **digest**")) {
    errors.push(`${CONTRACT_PATH}: does not state what approval is of`);
  }
  if (!contractDoc.includes("A budget the model is asked to respect is a request")) {
    errors.push(`${CONTRACT_PATH}: does not state why budgets are host-side`);
  }
  if (!contractDoc.includes("one party with two names")) {
    errors.push(`${CONTRACT_PATH}: does not state why the pair may not disposition each other`);
  }

  let contractSchema;
  let recordSchema;
  try {
    contractSchema = JSON.parse(files[CONTRACT_SCHEMA_PATH]);
    recordSchema = JSON.parse(files[RECORD_SCHEMA_PATH]);
  } catch (error) {
    return [...errors, `schemas: not valid JSON: ${error.message}`];
  }
  for (const [relative, schema] of [
    [CONTRACT_SCHEMA_PATH, contractSchema],
    [RECORD_SCHEMA_PATH, recordSchema],
  ]) {
    if (schema.additionalProperties !== false) {
      errors.push(`${relative}: root must be closed (additionalProperties:false)`);
    }
  }
  if (contractSchema.properties?.enforcement?.properties?.budgets_enforced_by?.const !== "host") {
    errors.push(`${CONTRACT_SCHEMA_PATH}: host-side enforcement must be a const, not a preference`);
  }
  if (recordSchema.properties?.parties?.properties?.evaluator?.properties?.read_only?.const !== true) {
    errors.push(`${RECORD_SCHEMA_PATH}: the evaluator must be read-only by construction`);
  }
  if (!(recordSchema.required ?? []).includes("opt_in")) {
    errors.push(`${RECORD_SCHEMA_PATH}: a run must record what opted it in`);
  }
  // Approval covers twelve things, and the schema is where that is enforced: a
  // contract missing one of them is shape-valid otherwise, and the missing one
  // is the one nobody agreed to.
  const required = new Set([
    ...(contractSchema.required ?? []),
    ...(contractSchema.properties?.limits?.required ?? []),
  ]);
  for (const field of APPROVAL_COVERS) {
    if (!required.has(field)) {
      errors.push(`${CONTRACT_SCHEMA_PATH}: approval does not cover ${field}`);
    }
  }

  let contract;
  try {
    contract = JSON.parse(files[CONTRACT_EXAMPLE_PATH]);
  } catch (error) {
    return [...errors, `${CONTRACT_EXAMPLE_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...validateContract(contract, contractSchema).map((message) => `${CONTRACT_EXAMPLE_PATH}: ${message}`));

  for (const relative of [RECORD_EXAMPLE_PATH, REFUSED_EXAMPLE_PATH]) {
    let record;
    try {
      record = JSON.parse(files[relative]);
    } catch (error) {
      errors.push(`${relative}: not valid JSON: ${error.message}`);
      continue;
    }
    const found = validateRun(record, contract, recordSchema);
    if (relative === RECORD_EXAMPLE_PATH) {
      errors.push(...found.map((message) => `${relative}: ${message}`));
    } else if (found.length === 0) {
      errors.push(`${relative}: the refused example is accepted`);
    }
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateAutobuildDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const contract = JSON.parse(files[CONTRACT_EXAMPLE_PATH]);
    const recordSchema = JSON.parse(files[RECORD_SCHEMA_PATH]);
    const refused = validateRun(JSON.parse(files[REFUSED_EXAMPLE_PATH]), contract, recordSchema);
    console.log("Autobuild run design validation PASS");
    console.log(`design_digest=${autobuildDesignDigest(files)}`);
    console.log(`contract_digest=${contractDigest(contract)} refusals=${REFUSALS.length} refused_example_findings=${refused.length}`);
  }
}
