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

import { CANDIDATE_PATH as CANDIDATE, MEASURED_PATH, measuredDigest } from "./lib/measured-inputs.mjs";
import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA_PATH = "resources/design-candidate/design-candidate.schema.json";
export const CANDIDATE_PATH = CANDIDATE;

/**
 * Measured design inputs excused from `files[]` membership, path → the owner's
 * reason. Listing is the rule; an entry here is the only alternative, so a
 * measured path that is neither listed nor excused is the defect the
 * measurement exists to catch. Empty while every measured input is listed.
 */
export const MEMBERSHIP_EXCEPTIONS = new Map();

/**
 * The panel the owner specified, exactly. A route or an effort that differs is
 * not a smaller panel — it is a different one, and a PASS from it is a PASS
 * about a question nobody asked.
 */
export const REQUIRED_PANEL = Object.freeze([
  { seat: "astra", route: "openai-codex/gpt-6-astra", effort: "low" },
  { seat: "grok", route: "cursor/cursor-grok-4.6", effort: "xhigh" },
  { seat: "muse", route: "meta/muse-spark-1.3-contributor", effort: "xhigh" },
  { seat: "deepseek", route: "deepseek/deepseek-flash", effort: "max" },
]);

export const PANEL_DIR = "resources/design-candidate/panel";

/**
 * The roster each recorded round actually ran under.
 *
 * A round file is a record of what happened, so it is checked against the panel
 * required when it ran and never against the panel required now. Rounds 1 to 3
 * ran on the roster the owner named before the pinned guide's critique routes
 * replaced it; checking them against `REQUIRED_PANEL` made a record of the past
 * fail the moment a requirement about the next panel changed. These entries are
 * history and do not move. A round is added here when it is recorded, with the
 * roster it sat — copying `REQUIRED_PANEL` in would restore exactly the coupling
 * this replaced.
 */
const OWNER_PANEL = Object.freeze([
  { seat: "opus", route: "anthropic/claude-opus-5", effort: "max" },
  { seat: "astra", route: "openai-codex/gpt-6-astra", effort: "high" },
  { seat: "grok", route: "cursor/cursor-grok-4.6", effort: "xhigh" },
  { seat: "muse", route: "meta/muse-spark-1.3-contributor", effort: "max" },
]);

/**
 * Round 4 ran on the pinned guide's artifact-critique roster, which replaced the
 * owner's original one between round 3 and round 4. Spelled out rather than
 * pointing at `REQUIRED_PANEL`: the moment this points at the live requirement,
 * a later amendment breaks the record of a round that already ran.
 */
const GUIDE_PANEL = Object.freeze([
  { seat: "astra", route: "openai-codex/gpt-6-astra", effort: "low" },
  { seat: "grok", route: "cursor/cursor-grok-4.6", effort: "xhigh" },
  { seat: "muse", route: "meta/muse-spark-1.3-contributor", effort: "xhigh" },
  { seat: "deepseek", route: "deepseek/deepseek-flash", effort: "max" },
]);

export const PANEL_BY_ROUND = Object.freeze({
  1: OWNER_PANEL,
  2: OWNER_PANEL,
  3: OWNER_PANEL,
  4: GUIDE_PANEL,
});

/**
 * The verdicts a seat may record, read from the schema rather than respelled.
 *
 * A round's verdict and an attestation's verdict are the same thing, so a second
 * list of the allowed values would be a second thing to keep in sync — and the
 * one that drifted would be the one nothing validates.
 */
export function panelVerdicts(schema = JSON.parse(loadFiles()[SCHEMA_PATH])) {
  return schema.properties.attestation.properties.verdicts.items.properties.verdict.enum;
}

/**
 * A recorded round, against the roster pinned for it.
 *
 * The attestation check reads the candidate's own verdicts, so it says nothing
 * about the archive. Without this, an archived round could name any four seats —
 * including a roster nobody ever required — and no shipped check would notice.
 */
export function validatePanelRound(round, required = PANEL_BY_ROUND[round.round], verdicts = panelVerdicts()) {
  if (!required) return [`round ${round.round}: no roster is pinned for it, so what it ran under is unknown`];
  const errors = [];
  const seen = new Set();
  for (const seat of round.seats) {
    if (seen.has(seat.seat)) errors.push(`round ${round.round}: seat ${seat.seat} is recorded twice`);
    seen.add(seat.seat);
  }
  if (round.seats.length !== required.length) {
    errors.push(`round ${round.round}: ${round.seats.length} seats recorded, ${required.length} required`);
  }
  for (const wanted of required) {
    const seat = round.seats.find((entry) => entry.seat === wanted.seat);
    if (!seat) {
      errors.push(`round ${round.round}: omits ${wanted.seat}`);
      continue;
    }
    if (seat.route !== wanted.route || seat.effort !== wanted.effort) {
      errors.push(
        `round ${round.round} ${wanted.seat}: ${seat.route}/${seat.effort} is not ${wanted.route}/${wanted.effort}`,
      );
    }
    // A record with no session is a claim that a seat sat. The verdict is what
    // the record exists to preserve, so it is checked before anything is derived
    // from it — an absent one left the archive holding a seat with no decision,
    // and a misspelled one was read as a refusal.
    if (!seat.session_id) errors.push(`round ${round.round} ${wanted.seat}: records no session id`);
    if (seat.verdict === undefined) {
      errors.push(`round ${round.round} ${wanted.seat}: records no verdict`);
    } else if (!verdicts.includes(seat.verdict)) {
      errors.push(`round ${round.round} ${wanted.seat}: records ${seat.verdict}, which is not a verdict`);
    }
    // Findings have to be recorded as a list, but an empty one is the whole point
    // of a panel: a seat that found nothing says so, and demanding otherwise
    // would make the result this panel exists to reach the one result it cannot
    // archive. A refusal is the case that owes a reason.
    if (!Array.isArray(seat.findings)) {
      errors.push(`round ${round.round} ${wanted.seat}: records no findings array`);
    } else if (seat.verdict !== "pass" && seat.findings.length === 0) {
      errors.push(`round ${round.round} ${wanted.seat}: records a ${seat.verdict} with no findings`);
    }
  }
  return errors;
}

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
    if (file.path === CANDIDATE_PATH) {
      errors.push(`${file.path}: the candidate cannot list itself`);
      continue;
    }
    if (/[*?[\]{}]/u.test(file.path)) {
      errors.push(`${file.path}: a member is a concrete path, not a glob`);
      continue;
    }
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

  // The membership floor: the measurement runs the validators under a read
  // instrument and pins the inputs they were observed to open. Each recorded
  // input must be listed, or excused by name in MEMBERSHIP_EXCEPTIONS — a
  // member list silent about one leaves a file the panel never reviewed free
  // to change a verdict. The artifact's digest must recompute, or the list is
  // not the measurement it claims to be.
  let artifact;
  try {
    artifact = JSON.parse(read(MEASURED_PATH));
  } catch (error) {
    errors.push(`${MEASURED_PATH}: the measured inputs cannot be read (${error.code ?? error.message})`);
  }
  if (artifact) {
    const { schema_version, readers, inputs, digest } = artifact;
    if (digest !== measuredDigest({ schema_version, readers, inputs })) {
      errors.push(`${MEASURED_PATH}: digest does not recompute over the recorded readers and inputs`);
    }
    const listed = new Set(candidate.files.map((file) => file.path));
    for (const relative of inputs ?? []) {
      if (!listed.has(relative) && !MEMBERSHIP_EXCEPTIONS.has(relative)) {
        errors.push(`${relative}: a measured design input the candidate neither lists nor excuses`);
      }
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
