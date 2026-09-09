#!/usr/bin/env node

/**
 * Validator for the `autosk-arena` block.
 *
 * Arena is the branch that changes a Tech Plan, and panel round 2 found it had
 * neither a contract nor a schema while Debate — the path Arena is chosen
 * *instead of* — had both.
 *
 * The three ways this arrangement becomes theatre are the three things checked
 * here: candidates that saw each other, a judge that approves rather than
 * ranks, and a "winner" that never re-entered the plan.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/arena.md";
export const SCHEMA_PATH = "resources/arena/arena-block.schema.json";
export const EXAMPLE_PATH = "resources/arena/arena-block.example.json";
export const REFUSED_PATH = "resources/arena/arena-block.refused.example.json";
export const CONTRACT_MARKER = "<!-- arena-contract:v1 -->";

/** When the refused example's candidates started, so its late freeze is visible. */
export const REFUSED_CANDIDATE_START = "2026-09-09T00:00:00Z";

/** The closed refusal set, as the contract states it. */
export const REFUSALS = Object.freeze([
  "arena_framing_changed",
  "arena_candidate_contaminated",
  "arena_fallback_required",
  "arena_judge_family_conflict",
  "arena_judgment_incomplete",
  "arena_judgment_is_not_approval",
  "arena_reexpression_missing",
  "arena_narrow_exemption_claimed",
  "arena_contract_invalid",
]);

/**
 * The framing is closed before any candidate starts.
 *
 * A criterion written once the work exists is a criterion written to fit it, so
 * `startedAt` is compared with the freeze rather than trusted.
 */
export function framingErrors(block, { candidateStartedAt } = {}) {
  const errors = [];
  const criteria = block.framing?.criteria ?? [];
  if (criteria.length < 3 || criteria.length > 6) {
    // Fewer than three is not a comparison; more than six lets the judge choose
    // which axes to weigh, which is a decision nobody delegated.
    errors.push({ reason: "arena_framing_changed", detail: `${criteria.length} criteria` });
  }
  const ids = criteria.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) {
    errors.push({ reason: "arena_framing_changed", detail: "a criterion id appears twice" });
  }
  if (candidateStartedAt && block.framing?.frozen_at
      && Date.parse(block.framing.frozen_at) > Date.parse(candidateStartedAt)) {
    errors.push({ reason: "arena_framing_changed", detail: `frozen after ${candidateStartedAt}` });
  }
  return errors;
}

/**
 * Isolation, as a refusal rather than an instruction.
 *
 * Two candidates that saw each other are one candidate with extra steps, so a
 * contaminated candidate is refused and not downgraded.
 */
export function candidateErrors(block, { contamination = [] } = {}) {
  const errors = [];
  const live = (block.candidates ?? []).filter((entry) => entry.state === "live");
  const families = new Set(live.map((entry) => entry.family));
  if (live.length < 2 || families.size < 2) {
    errors.push({
      reason: "arena_fallback_required",
      detail: `${live.length} live candidates from ${families.size} families`,
    });
  }
  for (const slot of contamination) {
    errors.push({ reason: "arena_candidate_contaminated", detail: slot });
  }
  const third = (block.candidates ?? []).find((entry) => entry.slot === "C");
  if (third && !third.reason_for_third) {
    errors.push({ reason: "arena_framing_changed", detail: "a third candidate with no written reason" });
  }
  return errors;
}

/**
 * The judge ranks; ranking is not approving.
 *
 * A role that both produced the ranking and closed the decision would be the
 * model approving its own material choice.
 */
export function judgmentErrors(block) {
  const errors = [];
  const judgment = block.judgment ?? {};
  const candidateFamilies = new Set((block.candidates ?? []).map((entry) => entry.family));
  if (candidateFamilies.has(judgment.judge_family)) {
    errors.push({ reason: "arena_judge_family_conflict", detail: judgment.judge_family });
  }
  const declared = (block.framing?.criteria ?? []).map((entry) => entry.id);
  const live = (block.candidates ?? []).filter((entry) => entry.state === "live").map((entry) => entry.slot);
  const scored = new Set((judgment.scores ?? []).map((entry) => `${entry.criterion_id}:${entry.slot}`));
  for (const criterion of declared) {
    for (const slot of live) {
      if (!scored.has(`${criterion}:${slot}`)) {
        errors.push({ reason: "arena_judgment_incomplete", detail: `${criterion} for ${slot}` });
      }
    }
  }
  if (block.decision && block.decision.decided_by !== "user_decision_record") {
    errors.push({ reason: "arena_judgment_is_not_approval", detail: String(block.decision.decided_by) });
  }
  return errors;
}

/**
 * A decision that is not re-expressed did not happen.
 *
 * The plan is the artifact under panel, and a plan nobody rewrote is a plan
 * nobody read.
 */
export function reexpressionErrors(block) {
  const errors = [];
  const value = block.reexpression ?? {};
  if (value.pre_arena_identity === value.post_arena_identity) {
    errors.push({ reason: "arena_reexpression_missing", detail: "the Tech Plan identity did not change" });
  }
  if (value.narrow !== false) {
    // The narrow path is for fixing confirmed findings without changing scope,
    // and an Arena result is a scope change by construction.
    errors.push({ reason: "arena_narrow_exemption_claimed", detail: String(value.narrow) });
  }
  return errors;
}

/** Everything, plus the block's own shape. */
export function blockErrors(block, options = {}) {
  if (!block || typeof block !== "object") {
    return [{ reason: "arena_contract_invalid", detail: "no block" }];
  }
  return [
    ...framingErrors(block, options),
    ...candidateErrors(block, options),
    ...judgmentErrors(block),
    ...reexpressionErrors(block),
  ];
}

/** The shipped design. */
export function validateDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract || !contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: the contract marker is missing`);
  for (const refusal of REFUSALS) {
    if (contract && !contract.includes(`\`${refusal}\``)) {
      errors.push(`${CONTRACT_PATH}: ${refusal} is not named in the contract`);
    }
  }
  const schema = JSON.parse(files[SCHEMA_PATH]);
  if (schema.additionalProperties !== false) errors.push(`${SCHEMA_PATH}: the schema is not closed`);

  const example = JSON.parse(files[EXAMPLE_PATH]);
  errors.push(...validateJsonSchema(example, schema).map((message) => `${EXAMPLE_PATH}: ${message}`));
  const own = blockErrors(example);
  if (own.length > 0) {
    errors.push(`${EXAMPLE_PATH}: the worked example is refused (${own.map((entry) => entry.reason).join(", ")})`);
  }

  const refused = JSON.parse(files[REFUSED_PATH]);
  // The refused example is asked the same questions a running Arena is asked,
  // including when its candidates started: a framing frozen afterwards is one
  // of the things this contract exists to refuse.
  const produced = new Set(
    blockErrors(refused, { contamination: ["B"], candidateStartedAt: REFUSED_CANDIDATE_START })
      .map((entry) => entry.reason),
  );
  if (produced.size < 5) {
    errors.push(`${REFUSED_PATH}: the refused example produces only ${produced.size} refusal classes`);
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = Object.fromEntries(
    [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, REFUSED_PATH].map((relative) => [
      relative,
      readFileSync(path.join(ROOT, relative), "utf8"),
    ]),
  );
  const errors = validateDesign(files);
  for (const error of errors) console.error(error);
  if (errors.length > 0) process.exitCode = 1;
  else {
    console.log("Arena block validation PASS");
    console.log(`refusals=${REFUSALS.length}`);
  }
}
