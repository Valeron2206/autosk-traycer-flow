#!/usr/bin/env node

/**
 * Design-time validator for the issue #25 requirement revision path.
 *
 * A mechanical impact map can be perfectly consistent and still lock in the
 * wrong product decision. What this checks is therefore not consistency but
 * ORDER: that the change reached the product layer before the Tickets, that the
 * fate of implemented work was decided by the user, and that "unaffected" was
 * proved rather than asserted.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/requirement-revision.md";
export const SCHEMA_PATH = "resources/requirement-revision/revision-record.schema.json";
export const EXAMPLE_PATH = "resources/requirement-revision/revision-record.example.json";
export const REFUSED_EXAMPLE_PATH = "resources/requirement-revision/revision-record.refused.example.json";
export const CONTRACT_MARKER = "<!-- requirement-revision-contract:v1 -->";

/** The five kinds, closed. The first three are material. */
export const KINDS = Object.freeze([
  "product_behavior",
  "technical_constraint",
  "delivery_operations_security_data",
  "evidence_clarification",
  "non_material_correction",
]);
export const MATERIAL_KINDS = Object.freeze(KINDS.slice(0, 3));

/** The stage a side effect is allowed to appear at, and not before. */
export const SIDE_EFFECT_STAGE = Object.freeze({
  product_artifact: 3,
  technical_artifact: 5,
  tickets_manifest: 7,
  code: 12,
});

/** States whose fate only the user may decide. */
export const DECISION_REQUIRED_STATES = Object.freeze(["staged", "integrated"]);

/** The four options put to the user for already-implemented work. */
export const USER_DISPOSITIONS = Object.freeze([
  "rework_current_ticket",
  "correction_ticket",
  "new_epic",
  "intentional_defer",
]);

export const REFUSALS = Object.freeze([
  "revision_out_of_order",
  "revision_class_mismatch",
  "revision_decision_missing",
  "revision_panel_missing",
  "revision_manifest_early",
  "revision_supersession_forked",
  "revision_closed_epic",
  "revision_rebind_unproven",
  "revision_stale_reference",
  "revision_round_replay",
  "revision_instruction_rewritten",
]);

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, REFUSED_EXAMPLE_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function revisionDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

/**
 * Whether an artifact may keep its previous verdict instead of re-entering the
 * panel. Its own bytes AND every declared dependency must be unchanged: the
 * rebind is the only step in the path that saves work, so it is the one under
 * pressure.
 */
export function rebindProved(artifact) {
  if (artifact.content_digest !== artifact.content_digest_before) return false;
  return artifact.dependencies.every((entry) => entry.digest === entry.digest_before);
}

/** Every ordering violation in one pass, each named by its own refusal class. */
export function orderErrors(record) {
  const errors = [];
  let firstPending = Infinity;
  for (const [index, stage] of record.stages.entries()) {
    if (stage.stage !== index + 1) {
      errors.push(`revision_out_of_order: stage ${stage.stage} is recorded in position ${index + 1}`);
    }
    if (stage.state === "pending" || stage.state === "refused") {
      firstPending = Math.min(firstPending, stage.stage);
    }
  }
  for (const stage of record.stages) {
    const effect = stage.side_effect ?? "none";
    if (effect === "none" || stage.state !== "complete") continue;
    const earliest = SIDE_EFFECT_STAGE[effect];
    if (stage.stage < earliest) {
      const refusal = effect === "tickets_manifest" ? "revision_manifest_early" : "revision_out_of_order";
      errors.push(`${refusal}: ${effect} at stage ${stage.stage}, which is before stage ${earliest}`);
    }
    if (stage.stage > firstPending) {
      // A side effect recorded while an earlier stage has not closed is the
      // whole failure this path exists to prevent, whatever the map says.
      errors.push(
        `revision_out_of_order: ${effect} at stage ${stage.stage} while stage ${firstPending} has not closed`,
      );
    }
  }
  return errors;
}

export function validateRevision(record, schema) {
  const errors = validateJsonSchema(record, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const { kind, material } = record.classification;
  if (material !== MATERIAL_KINDS.includes(kind)) {
    errors.push(`revision_class_mismatch: ${kind} is${material ? " not" : ""} material`);
  }
  // The verbatim instruction is bound to its digest, so an edited text is
  // visible rather than a matter of trust.
  if (record.original_instruction.digest !== sha256(record.original_instruction.text)) {
    errors.push("revision_instruction_rewritten: the recorded instruction does not match its digest");
  }

  const touched = new Set(record.artifacts.map((artifact) => artifact.layer));
  if (!material && (touched.has("product") || touched.has("technical"))) {
    // Calling a product change a clarification removes every panel from it in
    // one word, which is why this is a refusal and not a lighter review.
    errors.push(`revision_class_mismatch: ${kind} touches the product or technical layer`);
  }
  if (record.epic.state === "released") {
    // Refused when it is proposed, not when it is written: a material change to
    // a released epic becomes change work, and any completed side effect on one
    // is already a rewrite of what was released.
    if (material) {
      errors.push("revision_closed_epic: a released epic is not rewritten, it takes change work");
    }
    const written = record.stages.find((stage) => stage.state === "complete" && (stage.side_effect ?? "none") !== "none");
    if (written) {
      errors.push(`revision_closed_epic: ${written.side_effect} was written at stage ${written.stage} of a released epic`);
    }
  }

  errors.push(...orderErrors(record));

  for (const artifact of record.artifacts) {
    if (artifact.review === "rebound_unaffected") {
      if (!rebindProved(artifact)) {
        errors.push(`revision_rebind_unproven: ${artifact.path} was rebound without identity or dependency proof`);
      }
    } else if (artifact.verdict !== "pass") {
      errors.push(`revision_panel_missing: ${artifact.path} carries no passing ${artifact.review} verdict`);
    }
    if (artifact.layer === "tickets" && artifact.review === "full_panel") {
      errors.push(`revision_panel_missing: ${artifact.path} is a Ticket artifact and takes the Ticket panel`);
    }
  }

  for (const entry of record.ticket_dispositions) {
    const needsDecision = DECISION_REQUIRED_STATES.includes(entry.state);
    if (needsDecision && !USER_DISPOSITIONS.includes(entry.disposition)) {
      errors.push(`revision_decision_missing: ${entry.ticket_id} is ${entry.state} and takes one of the user options`);
    }
    if (needsDecision && !entry.decision_ref) {
      // Including `intentional_defer`, which is the one most likely to be
      // recorded as an observation rather than as a choice.
      errors.push(`revision_decision_missing: ${entry.ticket_id} (${entry.disposition}) names no decision record`);
    }
    if (!needsDecision && USER_DISPOSITIONS.includes(entry.disposition)) {
      errors.push(`revision_decision_missing: ${entry.ticket_id} is ${entry.state}, not implemented work`);
    }
    if (entry.state === "work" && entry.disposition !== "paused") {
      errors.push(`revision_out_of_order: ${entry.ticket_id} is live and is paused before its entry is superseded`);
    }
  }

  const superseded = new Set(record.sweep.superseded_references);
  for (const entry of record.ticket_dispositions) {
    for (const reference of entry.references ?? []) {
      if (superseded.has(reference)) {
        errors.push(`revision_stale_reference: ${entry.ticket_id} still references superseded ${reference}`);
      }
    }
  }
  if (record.sweep.stale_references.length > 0) {
    errors.push(`revision_stale_reference: ${record.sweep.stale_references.join(", ")}`);
  }
  if (record.artifacts.length > 0 && record.sweep.searched_references === 0) {
    // "No stale references" from a sweep that resolved nothing is
    // indistinguishable from a clean result, and reads better.
    errors.push("revision_stale_reference: the sweep resolved nothing and cannot report a clean result");
  }

  if (record.impact_plan.approved) {
    const open = record.stages.filter((stage) => stage.state !== "complete" && stage.state !== "skipped");
    if (open.length > 0) {
      errors.push(`revision_out_of_order: the impact plan is approved with stage ${open[0].stage} still open`);
    }
    if (!record.impact_plan.decision_ref) {
      errors.push("revision_decision_missing: an approved impact plan names the decision that approved it");
    }
  }
  if (record.anchor.after !== record.anchor.before && record.anchor.bumped_by_round !== record.round_id) {
    errors.push(`revision_round_replay: the anchor was bumped by ${record.anchor.bumped_by_round}, not this round`);
  }
  return errors;
}

/** What the revision path does with a round, given the rounds already recorded. */
export function revisionDecision(record, history = [], schema) {
  if (history.some((entry) => entry.round_id === record.round_id)) {
    return "refused:revision_round_replay";
  }
  if (record.supersedes !== null && history.some((entry) => entry.supersedes === record.supersedes)) {
    // Two corrections claiming the same predecessor: the second quietly reverts
    // the first, and both look applied.
    return "refused:revision_supersession_forked";
  }
  const errors = schema ? validateRevision(record, schema) : [];
  if (errors.length > 0) return `refused:${errors[0].split(":")[0]}`;
  return "proceed";
}

export function validateRequirementRevisionDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const refusal of REFUSALS) {
    if (!contract.includes(refusal)) errors.push(`${CONTRACT_PATH}: refusal ${refusal} is not documented`);
  }
  for (const kind of KINDS) {
    if (!contract.includes(kind)) errors.push(`${CONTRACT_PATH}: kind ${kind} is not documented`);
  }
  for (const disposition of USER_DISPOSITIONS) {
    if (!contract.includes(disposition)) errors.push(`${CONTRACT_PATH}: option ${disposition} is not documented`);
  }
  if (!contract.includes("A product change is not applied to code or Tickets first")) {
    errors.push(`${CONTRACT_PATH}: does not state the invariant the order exists for`);
  }
  if (!contract.includes("The order is the content")) {
    errors.push(`${CONTRACT_PATH}: does not state that the sequence is the decision`);
  }
  if (!contract.includes("does not choose among them")) {
    errors.push(`${CONTRACT_PATH}: does not state who decides the fate of implemented work`);
  }
  if (!contract.includes("a proof, not an impression")) {
    errors.push(`${CONTRACT_PATH}: does not state what an unaffected rebind needs`);
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
  const kinds = schema.properties?.classification?.properties?.kind?.enum ?? [];
  if (kinds.join(",") !== KINDS.join(",")) {
    errors.push(`${SCHEMA_PATH}: the five kinds must match the contract exactly`);
  }
  const stages = schema.properties?.stages ?? {};
  if (stages.minItems !== 12 || stages.maxItems !== 12) {
    errors.push(`${SCHEMA_PATH}: all twelve stages must be present, including the ones that were skipped`);
  }
  if (!(schema.required ?? []).includes("original_instruction")) {
    errors.push(`${SCHEMA_PATH}: the original instruction must be required, or history can be replaced by its summary`);
  }

  for (const relative of [EXAMPLE_PATH, REFUSED_EXAMPLE_PATH]) {
    let record;
    try {
      record = JSON.parse(files[relative]);
    } catch (error) {
      errors.push(`${relative}: not valid JSON: ${error.message}`);
      continue;
    }
    const found = validateRevision(record, schema);
    if (relative === EXAMPLE_PATH) {
      errors.push(...found.map((message) => `${relative}: ${message}`));
    } else if (found.length === 0) {
      errors.push(`${relative}: the refused example is accepted`);
    }
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateRequirementRevisionDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const schema = JSON.parse(files[SCHEMA_PATH]);
    const refused = validateRevision(JSON.parse(files[REFUSED_EXAMPLE_PATH]), schema);
    console.log("Requirement revision design validation PASS");
    console.log(`design_digest=${revisionDesignDigest(files)}`);
    console.log(`kinds=${KINDS.length} stages=12 refusals=${REFUSALS.length} refused_example_findings=${refused.length}`);
  }
}
