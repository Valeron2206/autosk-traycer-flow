#!/usr/bin/env node

/**
 * Design-time validator for the issue #31 Debate workflow.
 *
 * A Debate is cheaper to start than a prototype and produces something that
 * reads like an answer, so the checks here are about the ways it becomes the
 * wrong instrument: an empirical question sent to it, positions that saw each
 * other before writing, a synthesis that cleaned up a real disagreement, and a
 * recommendation recorded as a decision nobody made.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/debate.md";
export const SCHEMA_PATH = "resources/debate/debate-manifest.schema.json";
export const EXAMPLE_PATH = "resources/debate/debate-manifest.example.json";
export const REFUSED_EXAMPLE_PATH = "resources/debate/debate-manifest.refused.example.json";
export const CONTRACT_MARKER = "<!-- debate-contract:v1 -->";

/** What each gate must cover, in order. The second cannot precede the first. */
export const GATE_COVERAGE = Object.freeze([
  ["question", "roster"],
  ["routes", "roles", "round_cap", "budget"],
]);

export const REFUSALS = Object.freeze([
  "debate_started_without_request",
  "debate_empirical_question",
  "debate_gate_missing",
  "debate_roster_not_diverse",
  "debate_round_one_contaminated",
  "debate_no_cross_examination",
  "debate_false_consensus",
  "debate_minority_dropped",
  "debate_cap_not_host_enforced",
  "debate_cap_exceeded",
  "debate_used_as_review_bypass",
  "debate_accepted_without_user",
  "debate_impact_not_revised",
  "debate_restart_identity_changed",
  "debate_unavailability_undisclosed",
  "debate_input_uncleared",
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

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function debateDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

export function rosterDigest(roster) {
  return sha256(canonical(roster));
}

/** Whether a synthesis is entitled to say the positions agree. */
export function consensusHeld(round) {
  const positions = round.positions.flatMap((entry) => entry.claims);
  return !positions.some((claim) => claim.position === "disagree") && round.synthesis.disputed.length === 0;
}

export function validateDebate(manifest, schema) {
  const errors = validateJsonSchema(manifest, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  if (manifest.classifier.empirical_artifact_test_exists) {
    // The temptation runs one way: a Debate is cheaper to start than a
    // prototype and produces something that reads like an answer.
    errors.push("debate_empirical_question: an artifact whose construction would answer this exists, so it is an Arena question");
  }
  if (manifest.start.kind !== "explicit_user_request") {
    errors.push(`debate_started_without_request: started as ${manifest.start.kind}`);
  }

  const gates = manifest.gates.slice().sort((a, b) => a.gate - b.gate);
  for (const [index, expected] of GATE_COVERAGE.entries()) {
    const gate = gates[index];
    for (const field of expected) {
      if (!gate.covers.includes(field)) {
        errors.push(`debate_gate_missing: gate ${index + 1} does not cover ${field}`);
      }
    }
  }
  if (Date.parse(gates[1].approved_at) < Date.parse(gates[0].approved_at)) {
    // Answering both at once means answering the second without having settled
    // the first.
    errors.push("debate_gate_missing: the second gate was approved before the first");
  }

  const stances = new Set();
  const sessions = new Set();
  for (const seat of manifest.roster) {
    if (stances.has(seat.stance)) {
      errors.push(`debate_roster_not_diverse: ${seat.role} restates another seat's stance`);
    }
    stances.add(seat.stance);
    if (sessions.has(seat.session_id)) {
      errors.push(`debate_roster_not_diverse: ${seat.role} shares a session with another seat`);
    }
    sessions.add(seat.session_id);
    if (!manifest.caps.approved_routes.includes(seat.route)) {
      // A substituted route is a different participant.
      errors.push(`debate_roster_not_diverse: ${seat.role} runs ${seat.route}, which the second gate did not approve`);
    }
    if (seat.availability !== "available" && !seat.disposition_ref) {
      // A debate that quietly continued with three of five seats answered a
      // question nobody asked.
      errors.push(`debate_unavailability_undisclosed: ${seat.role} is ${seat.availability}`);
    }
  }

  const seenClaims = new Set();
  for (const round of manifest.rounds) {
    for (const position of round.positions) {
      if (round.round === 1 && position.read_other_positions) {
        // The first thing a model does with a visible position is agree with it.
        errors.push(`debate_round_one_contaminated: ${position.role}`);
      }
      if (round.round > 1 && (position.examines ?? []).length === 0) {
        // Without this, round two is round one repeated more confidently.
        errors.push(`debate_no_cross_examination: ${position.role} in round ${round.round}`);
      }
      for (const claim of position.examines ?? []) {
        if (!seenClaims.has(claim)) {
          errors.push(`debate_no_cross_examination: ${position.role} examines ${claim}, which no earlier round raised`);
        }
      }
    }
    for (const position of round.positions) {
      for (const claim of position.claims) seenClaims.add(claim.claim_id);
    }
    if (round.synthesis.state === "consensus" && !consensusHeld(round)) {
      // Summarising is easier when the summary is clean, and a clean summary of
      // a real disagreement is a false one.
      errors.push(`debate_false_consensus: round ${round.round} claims consensus over a live disagreement`);
    }
    if (round.synthesis.disputed.length > 0 && round.synthesis.minority_views.length === 0) {
      errors.push(`debate_minority_dropped: round ${round.round} disputes something and records no minority view`);
    }
  }

  if (manifest.enforcement.caps_enforced_by !== "host") {
    errors.push("debate_cap_not_host_enforced: a cap the participants are asked to respect is a suggestion");
  }
  if (manifest.spent) {
    if (manifest.spent.rounds > manifest.caps.max_rounds) {
      errors.push(`debate_cap_exceeded: ${manifest.spent.rounds} rounds over ${manifest.caps.max_rounds}`);
    }
    if (manifest.spent.cost_units > manifest.caps.cost_units) {
      errors.push(`debate_cap_exceeded: ${manifest.spent.cost_units} cost units over ${manifest.caps.cost_units}`);
    }
  }

  if ((manifest.final.substitutes_for ?? []).length > 0) {
    errors.push(`debate_used_as_review_bypass: recorded as substituting for ${manifest.final.substitutes_for.join(", ")}`);
  }
  if (manifest.final.disposition === "accepted") {
    if (!manifest.final.decision_ref) {
      errors.push("debate_accepted_without_user: accepted with no user decision recorded");
    }
    if (manifest.final.impact === "material" && !manifest.final.revision_ref) {
      // A material decision enters the revision path rather than being applied.
      errors.push("debate_impact_not_revised: a material accepted decision names no revision");
    }
  }
  if (manifest.restart && manifest.restart.roster_digest !== rosterDigest(manifest.roster)) {
    // A debate resumed with a different roster is a new debate that would
    // inherit the earlier rounds' authority.
    errors.push("debate_restart_identity_changed: the resumed roster is not the one that ran");
  }
  return errors;
}

export function validateDebateDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const refusal of REFUSALS) {
    if (!contract.includes(refusal)) errors.push(`${CONTRACT_PATH}: refusal ${refusal} is not documented`);
  }
  if (!contract.includes("Is there an artifact whose construction would answer this?")) {
    errors.push(`${CONTRACT_PATH}: does not state the Arena/Debate classifier`);
  }
  if (!contract.includes("are not substitutes")) {
    errors.push(`${CONTRACT_PATH}: does not state why Panel and contest do not replace a Debate`);
  }
  if (!contract.includes("agree with it")) {
    errors.push(`${CONTRACT_PATH}: does not state why round 1 is independent`);
  }
  if (!contract.includes("a clean summary of a real disagreement is a false one")) {
    errors.push(`${CONTRACT_PATH}: does not state the mediator's failure mode`);
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
  const roster = schema.properties?.roster ?? {};
  if (roster.minItems !== 3 || roster.maxItems !== 5) {
    errors.push(`${SCHEMA_PATH}: a roster is three to five positions`);
  }
  const gates = schema.properties?.gates ?? {};
  if (gates.minItems !== 2 || gates.maxItems !== 2) {
    errors.push(`${SCHEMA_PATH}: both gates are required, and there are only two`);
  }
  if (schema.properties?.enforcement?.properties?.caps_enforced_by?.const !== "host") {
    errors.push(`${SCHEMA_PATH}: host-side enforcement must be a const, not a preference`);
  }
  if (schema.properties?.final?.properties?.produces_code_pass?.const !== false) {
    errors.push(`${SCHEMA_PATH}: a Debate must not be able to record a code PASS`);
  }
  if (!(schema.required ?? []).includes("clearance_ref")) {
    errors.push(`${SCHEMA_PATH}: inputs and outputs must carry a clearance (debate_input_uncleared)`);
  }
  const synthesis = schema.properties?.rounds?.items?.properties?.synthesis?.required ?? [];
  for (const field of ["minority_views", "unresolved_assumptions"]) {
    if (!synthesis.includes(field)) {
      errors.push(`${SCHEMA_PATH}: a synthesis must record ${field}`);
    }
  }

  for (const relative of [EXAMPLE_PATH, REFUSED_EXAMPLE_PATH]) {
    let manifest;
    try {
      manifest = JSON.parse(files[relative]);
    } catch (error) {
      errors.push(`${relative}: not valid JSON: ${error.message}`);
      continue;
    }
    const found = validateDebate(manifest, schema);
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
  const errors = validateDebateDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const schema = JSON.parse(files[SCHEMA_PATH]);
    const manifest = JSON.parse(files[EXAMPLE_PATH]);
    const refused = validateDebate(JSON.parse(files[REFUSED_EXAMPLE_PATH]), schema);
    console.log("Debate design validation PASS");
    console.log(`design_digest=${debateDesignDigest(files)}`);
    console.log(`roster=${manifest.roster.length} rounds=${manifest.rounds.length} refusals=${REFUSALS.length} refused_example_findings=${refused.length}`);
  }
}
