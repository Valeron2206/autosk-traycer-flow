#!/usr/bin/env node

/**
 * Design-time validator for the issue #39 design candidate and its attestation.
 *
 * Two things have to be impossible here, and they are the two the issue's own
 * negative checks name first: a candidate that changed between seats, and an
 * attestation that says PASS without four real verdicts on the exact routes and
 * efforts the owner specified. So this validator reads the design-pack bytes off
 * disk and recomputes them, and it computes the attestation state rather than
 * accepting the one written down.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA_PATH = "resources/design-candidate/design-candidate.schema.json";
export const CANDIDATE_PATH = "resources/design-candidate/design-candidate.v1.json";

/**
 * The panel the owner specified, exactly. A route or an effort that differs is
 * not a smaller panel — it is a different one, and a PASS from it is a PASS
 * about a question nobody asked.
 */
export const REQUIRED_PANEL = Object.freeze([
  { seat: "opus", route: "anthropic/claude-opus-5", effort: "max" },
  { seat: "astra", route: "openai-codex/gpt-6-astra", effort: "high" },
  { seat: "grok", route: "cursor/cursor-grok-4.6", effort: "xhigh" },
  { seat: "muse", route: "meta/muse-spark-1.3-contributor", effort: "max" },
]);

/** Group A of #39: every one needs a closed design disposition. */
export const GROUP_A = Object.freeze([3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 15, 16, 17, 18]);

/** Group B: an exact design contract, with runtime allowed to remain open. */
export const GROUP_B = Object.freeze([11, 13, 36]);

export function loadFiles() {
  const files = {};
  for (const relative of [SCHEMA_PATH, CANDIDATE_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The candidate's identity: its file list and their exact bytes. */
export function candidateDigest(candidate) {
  return sha256(
    candidate.files
      .map((file) => `${file.path} ${file.sha256}`)
      .sort()
      .join("\n"),
  );
}

/**
 * The attestation state, computed.
 *
 * `pass` requires one verdict per required seat, each on the exact route and
 * effort, each `pass`, and each bound to THIS candidate digest. Anything else is
 * `pending_final_panel` — including three passes and a silence, which is the
 * case most likely to be rounded up.
 */
export function computeAttestationState(candidate) {
  const digest = candidateDigest(candidate);
  const verdicts = candidate.attestation.verdicts ?? [];
  for (const required of REQUIRED_PANEL) {
    const seat = verdicts.find((entry) => entry.seat === required.seat);
    if (!seat) return "pending_final_panel";
    if (seat.route !== required.route || seat.effort !== required.effort) return "pending_final_panel";
    if (seat.candidate_digest !== digest) return "pending_final_panel";
    if (seat.verdict === "fail") return "blocked";
    if (seat.verdict !== "pass") return "pending_final_panel";
  }
  return "pass";
}

export function validateCandidate(candidate, schema, { readFile } = {}) {
  const errors = validateJsonSchema(candidate, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const read =
    readFile ?? ((relative) => readFileSync(path.join(ROOT, relative), "utf8"));

  const seenPaths = new Set();
  for (const file of candidate.files) {
    if (seenPaths.has(file.path)) errors.push(`${file.path}: listed twice`);
    seenPaths.add(file.path);
    // The candidate is bytes, not a list of names. A digest that does not match
    // what is on disk is exactly "candidate changed between seats", caught here
    // rather than by a reviewer noticing.
    let actual;
    try {
      actual = sha256(read(file.path));
    } catch (error) {
      errors.push(`${file.path}: listed in the candidate but cannot be read (${error.code ?? error.message})`);
      continue;
    }
    if (actual !== file.sha256) {
      errors.push(`${file.path}: recorded ${file.sha256}, on disk ${actual} — the candidate has drifted`);
    }
  }

  const expected = candidateDigest(candidate);
  if (candidate.candidate_digest !== expected) {
    errors.push(`candidate_digest does not recompute: recorded ${candidate.candidate_digest}, computed ${expected}`);
  }

  // Every Group A issue needs a disposition that is closed in one of the three
  // ways #39 allows. "Later" without a current safe semantics is not one.
  const byIssue = new Map(candidate.dispositions.map((entry) => [entry.issue, entry]));
  for (const issue of [...GROUP_A, ...GROUP_B]) {
    const entry = byIssue.get(issue);
    if (!entry) {
      errors.push(`#${issue}: has no design disposition`);
      continue;
    }
    if (entry.disposition !== "accepted" && !entry.rationale) {
      errors.push(`#${issue}: ${entry.disposition} requires a citable rationale`);
    }
    if (entry.disposition === "deferred_after_v1" && !entry.follow_up) {
      errors.push(`#${issue}: deferred after v1 requires a follow-up issue`);
    }
  }
  for (const entry of candidate.dispositions) {
    if (!GROUP_A.includes(entry.issue) && !GROUP_B.includes(entry.issue)) {
      errors.push(`#${entry.issue}: is not in group A or B of #39`);
    }
  }

  // The panel is the owner's, exactly. A downgraded effort or a substituted
  // route would make a PASS answer a different question.
  const declared = candidate.required_panel;
  for (const required of REQUIRED_PANEL) {
    const seat = declared.find((entry) => entry.seat === required.seat);
    if (!seat) {
      errors.push(`required_panel omits ${required.seat}`);
    } else if (seat.route !== required.route || seat.effort !== required.effort) {
      errors.push(
        `required_panel ${required.seat}: ${seat.route}/${seat.effort} is not ${required.route}/${required.effort}`,
      );
    }
  }

  const computed = computeAttestationState(candidate);
  if (candidate.attestation.state !== computed) {
    errors.push(`attestation state is ${candidate.attestation.state}, computed ${computed}`);
  }
  if (computed === "blocked" && !candidate.attestation.blocked_reason) {
    errors.push("a blocked attestation must record why");
  }
  return errors;
}

export function validateDesignCandidate(files) {
  const errors = [];
  let schema;
  try {
    schema = JSON.parse(files[SCHEMA_PATH]);
  } catch (error) {
    return [`${SCHEMA_PATH}: not valid JSON: ${error.message}`];
  }
  if (schema.additionalProperties !== false) {
    errors.push(`${SCHEMA_PATH}: root must be closed (additionalProperties:false)`);
  }
  // `pass` must not be a value a candidate can simply carry: it is computed, and
  // the schema keeping the state enumerated is what makes the comparison possible.
  const states = schema.properties?.attestation?.properties?.state?.enum ?? [];
  if (states.join(",") !== "pending_final_panel,pass,blocked") {
    errors.push(`${SCHEMA_PATH}: attestation states must be exactly pending_final_panel, pass, blocked`);
  }

  let candidate;
  try {
    candidate = JSON.parse(files[CANDIDATE_PATH]);
  } catch (error) {
    return [...errors, `${CANDIDATE_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...validateCandidate(candidate, schema).map((message) => `${CANDIDATE_PATH}: ${message}`));
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateDesignCandidate(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const candidate = JSON.parse(files[CANDIDATE_PATH]);
    console.log("Design candidate validation PASS");
    console.log(`candidate_digest=${candidate.candidate_digest}`);
    console.log(`files=${candidate.files.length} dispositions=${candidate.dispositions.length}`);
    console.log(`attestation=${computeAttestationState(candidate)}`);
  }
}
