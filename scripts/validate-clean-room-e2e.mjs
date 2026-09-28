#!/usr/bin/env node

/**
 * Design-time validator for the issue #36 clean-room fault matrix.
 *
 * A fault that reports success has proved nothing on its own. The four proofs
 * exist because each rules out a different way of proving nothing: the fault was
 * never applied, the fault is not observable, the observation is not specific,
 * or the room was not clean for the next fault. So the checks here are that
 * every group carries all four, that the matrix covers every boundary the flow
 * crosses, and that no failure mode the gate must refuse is recorded as a pass.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COVERAGE_STATES, INJECTION_KINDS } from "./lib/clean-room-coverage.mjs";
import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/clean-room-e2e.md";
export const SCHEMA_PATH = "resources/clean-room-e2e/fault-matrix.schema.json";
export const MATRIX_PATH = "resources/clean-room-e2e/fault-matrix.v1.json";
export const CONTRACT_MARKER = "<!-- clean-room-e2e-contract:v1 -->";
export const HARNESS_PATH = "scripts/clean-room-faults.mjs";

/** Every boundary the flow crosses. A boundary with no fault group is untested. */
export const BOUNDARIES = Object.freeze([
  "task_creation",
  "session_lifecycle",
  "filesystem_write",
  "ref_movement",
  "staging_integration",
  "aggregate_verification",
  "final_cas",
]);

/** The four proofs, and what each rules out. */
export const PROOF_KINDS = Object.freeze([
  "application_proof",
  "red_killer",
  "green_control",
  "restore_proof",
]);

/** Outcomes that must fail the release gate. None of them is a product verdict. */
export const GATE_FAILING_OUTCOMES = Object.freeze([
  "mutation_not_applied",
  "green_control_failed",
  "restore_failed",
  "timeout",
  "indeterminate",
]);

/** Closed park reasons of section 8. */
export const PARK_REASONS = Object.freeze([
  "mutation_not_applied",
  "green_control_failed",
  "restore_failed",
  "timeout",
  "indeterminate",
  "harness_self_test_failed",
  "digest_changed_after_mint",
  "ephemeral_helper_left",
  "traycer_artifact_present",
  "cross_project_leakage",
]);

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, MATRIX_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function cleanRoomDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

/** Whether the gate passes for a recorded outcome. */
export function gatePasses(outcome) {
  return !GATE_FAILING_OUTCOMES.includes(outcome);
}

/**
 * The case functions the harness runs: the keys of its `CASES` object, each
 * mapped to the function it names. A function that looks like a case and is
 * not in `CASES` is never run, so it is no case.
 */
export function harnessCases(harnessSource) {
  const block = /export const CASES = Object\.freeze\(\{([\s\S]*?)\}\);/u.exec(harnessSource);
  if (!block) return new Map();
  return new Map([...block[1].matchAll(/\b(F\d{2,4}):\s*([A-Za-z_$][\w$]*)/gu)].map((match) => [match[1], match[2]]));
}

/**
 * The source of one fault-harness case, `async function <name>(root) { … }`,
 * or null when `CASES` has no entry for the group.
 *
 * Read as text rather than imported: the validator states what the harness
 * does without running the host modules it imports.
 */
export function caseSource(harnessSource, id) {
  const name = harnessCases(harnessSource).get(id);
  if (!name) return null;
  const start = harnessSource.indexOf(`async function ${name}(`);
  if (start === -1) return null;
  const end = harnessSource.indexOf("\n}\n", start);
  return harnessSource.slice(start, end === -1 ? undefined : end + 2);
}

/**
 * The text from `open` to its balanced end: to the bracket that closes the
 * one at `open`, or — for a statement, or when `open` is not a bracket — to
 * the first `;` at depth zero. Quoted strings and template literals are skipped whole.
 */
function balanced(text, open, { statement = false } = {}) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'" || char === '"' || char === "`") {
      index += 1;
      while (index < text.length && text[index] !== char) index += text[index] === "\\" ? 2 : 1;
      continue;
    }
    if (pairs[char]) depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0 && pairs[text[open]] && !statement) return text.slice(open, index + 1);
      if (depth < 0) return text.slice(open, index);
    } else if (char === ";" && depth === 0) return text.slice(open, index);
  }
  return text.slice(open);
}

/**
 * What the case hands `guard` at its first call — the faulted one: the call's
 * argument text, with every `const` of the case it names expanded in place,
 * recursively. Null when the case never calls the guard.
 */
export function guardInput(source, guard) {
  const call = new RegExp(`(?<![A-Za-z0-9_$.])${guard}\\(`, "u").exec(source);
  if (!call) return null;
  const consts = new Map();
  for (const match of source.matchAll(/\bconst ([A-Za-z_$][\w$]*) = /gu)) {
    if (!consts.has(match[1])) consts.set(match[1], balanced(source, match.index + match[0].length, { statement: true }));
  }
  const seen = new Set();
  const expand = (text) => {
    let out = text;
    for (const identifier of new Set(text.match(/[A-Za-z_$][\w$]*/gu) ?? [])) {
      if (!consts.has(identifier) || seen.has(identifier)) continue;
      seen.add(identifier);
      out += `\n${expand(consts.get(identifier))}`;
    }
    return out;
  };
  return expand(balanced(source, call.index + call[0].length - 1));
}

const LITERAL_KEY = /(?<![A-Za-z0-9_$])([A-Za-z_$][\w$]*): (?:'[^']*'|"[^"]*"|-?\d+|true|false)(?![A-Za-z0-9_$])/gu;

/** The keys a guard input writes as a literal — a string, a number or a boolean. */
export function literalKeys(input) {
  return new Set([...input.matchAll(LITERAL_KEY)].map((match) => match[1]));
}

/**
 * How a group is injected, held to the harness that runs it (debt 10h, and
 * the review of 10h).
 *
 * - `real_path` — the daemon harnesses (crash, identity) make the fault against
 *   the built daemon; `CASES` has no entry for the group, and it names no guard.
 * - `measured_observation` — a fault-harness case whose guard is handed no
 *   written observation field.
 * - `written_observation` — a fault-harness case whose guard is handed the
 *   `written_fields` as literals.
 *
 * Whatever the kind, every literal the faulted guard call is handed — its
 * argument, and each `const` of the case it names — is declared, as a written
 * field or as a fixed input (held constant between the fault and its control),
 * and every declared field is such a literal. What text cannot settle is that
 * a non-literal field is read from the fixture after the fault; that is the
 * case's own reading, and `injection_note` says it.
 */
function injectionErrors(group, harnessSource) {
  const errors = [];
  const at = `${group.id} (${group.boundary})`;
  const source = caseSource(harnessSource, group.id);
  const written = group.written_fields;
  const fixed = group.fixed_inputs;
  if (group.injection === "real_path") {
    if (source !== null) errors.push(`${at}: has a case in the fault harness, so it is not a real_path`);
    if (group.guards !== undefined) errors.push(`${at}: guards belong to a fault-harness case, not to real_path`);
    if (fixed !== undefined) errors.push(`${at}: fixed_inputs belong to a fault-harness case, not to real_path`);
  } else if (source === null) {
    errors.push(`${at}: is ${group.injection}, and it has no case in the fault harness`);
  }
  if (group.injection === "written_observation") {
    if (!Array.isArray(written) || written.length === 0) errors.push(`${at}: a written_observation names no written field`);
  } else if (written !== undefined) {
    errors.push(`${at}: written_fields belong to a written_observation, not to ${group.injection}`);
  }
  if (group.injection === "real_path" || source === null) return errors;

  if (!Array.isArray(group.guards) || group.guards.length === 0) {
    errors.push(`${at}: names no guard its case asks`);
    return errors;
  }
  const literals = new Set();
  for (const guard of group.guards) {
    const input = guardInput(source, guard);
    if (input === null) {
      errors.push(`${at}: ${guard} is not called in its case in ${HARNESS_PATH}`);
      continue;
    }
    for (const key of literalKeys(input)) literals.add(key);
  }
  const declared = new Set([...(written ?? []), ...(fixed ?? [])]);
  for (const field of declared) {
    if (!literals.has(field)) errors.push(`${at}: ${field} is not written as a literal in the guard call`);
  }
  for (const key of [...literals].sort()) {
    if (!declared.has(key)) errors.push(`${at}: ${key} is written as a literal in the guard call and is not declared`);
  }
  return errors;
}

/**
 * A note that says, in words, that the run is not the fault the group designs.
 * A tripwire and not a parser: `injection_matches_design` is the field the
 * coverage rule reads, and a note that admits a departure beside a flag that
 * says there is none is a matrix that contradicts itself (debt 12e, R8-7).
 */
const DEPARTURE_WORDS = /\balthough\b|\bstands? in\b|\bnot (?:killed|a second process)\b|\bno [a-z ]{1,40}(?:runs?|is killed|is involved)\b/iu;

/**
 * Whether a group's run is the fault it designs, and what stands between a
 * group that does not count and the product path (debt 12e, R8-7, R8-12).
 *
 * `injection_matches_design` is a boolean of every group. A run that departs
 * says how in `design_departure`, and a run that does not says nothing there.
 * A group that is not the designed fault on the product path — a departing
 * run, or any injection but `real_path` — names in `product_path_owner` who
 * converts it (#36, which owns the harness) and the record that owns what must
 * exist first; a group that is the designed fault on the product path names
 * none, F001 among them (it counts once the crash harness asks a control).
 *
 * `DEPARTURE_WORDS` is left as it is: a phrase it does not know is a departure
 * the flag alone carries, and a phrase it matches beside `true` is refused —
 * it errs toward a refusal a reader can settle, not toward counting a group.
 */
function designErrors(group) {
  const errors = [];
  const at = `${group.id} (${group.boundary})`;
  const matches = group.injection_matches_design === true;
  if (!matches && group.design_departure === undefined) {
    errors.push(`${at}: the run departs from its designed fault and does not say how (design_departure)`);
  }
  if (matches && group.design_departure !== undefined) {
    errors.push(`${at}: design_departure says how the run departs, and injection_matches_design says it matches its design`);
  }
  if (matches && DEPARTURE_WORDS.test(group.injection_note)) {
    errors.push(`${at}: injection_note admits the run is not the designed fault, and injection_matches_design says it is`);
  }
  const onProductPath = matches && group.injection === "real_path";
  if (onProductPath && group.product_path_owner !== undefined) {
    errors.push(`${at}: product_path_owner names who converts it to the product path, and it is already the designed fault on it`);
  }
  if (!onProductPath) {
    if (group.product_path_owner === undefined) {
      errors.push(`${at}: is not the designed fault on the product path and names no product_path_owner`);
    } else if (!/^#36\b/u.test(group.product_path_owner)) {
      errors.push(`${at}: product_path_owner names #36, which converts the group, first`);
    }
  }
  return errors;
}

/**
 * Every error the fault matrix has, as messages; empty when it holds.
 *
 * The matrix must satisfy the closed schema (a schema failure returns at once,
 * since nothing after it can be read), and then each group must carry its four
 * proofs exactly once with a locator, hold its `injection` to the harness
 * (`injectionErrors`) and say whether its run is its designed fault and who
 * converts it (`designErrors`); every boundary must have a group, every outcome
 * the gate must refuse must be demonstrated, and at least one group must be
 * expected to pass. `harnessSource` is the fault harness's text, read from disk
 * when omitted, so a test can hand in an edited one.
 */
export function validateMatrix(matrix, schema, { harnessSource } = {}) {
  const errors = validateJsonSchema(matrix, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;
  const harness = harnessSource ?? readFileSync(path.join(ROOT, HARNESS_PATH), "utf8");

  const ids = new Set();
  const covered = new Set();
  for (const group of matrix.groups) {
    const at = `${group.id} (${group.boundary})`;
    if (ids.has(group.id)) errors.push(`${at}: id declared twice`);
    ids.add(group.id);
    covered.add(group.boundary);

    // All four, each exactly once. Three of four is a group that proves
    // something, and the missing one is the thing it fails to prove.
    const kinds = group.proofs.map((proof) => proof.kind);
    for (const kind of PROOF_KINDS) {
      const count = kinds.filter((entry) => entry === kind).length;
      if (count === 0) errors.push(`${at}: has no ${kind}`);
      if (count > 1) errors.push(`${at}: has ${count} ${kind} entries`);
    }
    for (const proof of group.proofs) {
      if (!proof.locator || proof.locator.trim() === "") {
        errors.push(`${at}: ${proof.kind} has no locator, so nothing can be checked against it`);
      }
    }
    errors.push(...injectionErrors(group, harness));
    errors.push(...designErrors(group));
  }

  // A boundary with no fault group is a boundary nobody attacked.
  for (const boundary of BOUNDARIES) {
    if (!covered.has(boundary)) {
      errors.push(`${boundary}: no fault group crosses this boundary`);
    }
  }

  // Every outcome the gate must refuse has to be exercised by at least one
  // group, or the refusal is a rule with nothing behind it.
  const outcomes = new Set(matrix.groups.map((group) => group.expected_gate_outcome));
  for (const outcome of GATE_FAILING_OUTCOMES) {
    if (!outcomes.has(outcome)) {
      errors.push(`${outcome}: the gate must refuse it, and no group demonstrates it`);
    }
  }
  if (!outcomes.has("pass")) {
    errors.push("no group is expected to pass, so a passing run is undemonstrated");
  }

  const declared = new Set(matrix.gate_failing_outcomes);
  for (const outcome of GATE_FAILING_OUTCOMES) {
    if (!declared.has(outcome)) errors.push(`gate_failing_outcomes omits ${outcome}`);
  }
  return errors;
}

/**
 * The whole clean-room design, from its three files' text: the contract, the
 * fault-matrix schema and the matrix.
 *
 * The contract must name the room's absences, each proof kind, every coverage
 * state and the one that counts toward #36's gate; the schema must be closed,
 * carry exactly four proofs per group and only injection kinds the coverage
 * rule knows; the matrix must hold to both. Returns every error found, or
 * stops at the first file that is not JSON.
 */
export function validateCleanRoomDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const reason of PARK_REASONS) {
    if (!contract.includes(reason)) errors.push(`${CONTRACT_PATH}: park reason ${reason} is not documented`);
  }
  // The room is defined by what is absent as much as by what is present.
  for (const absence of [".traycer", "no network", "temporary HOME"]) {
    if (!contract.includes(absence)) {
      errors.push(`${CONTRACT_PATH}: does not state the room requirement "${absence}"`);
    }
  }
  for (const kind of PROOF_KINDS) {
    if (!contract.includes(kind)) errors.push(`${CONTRACT_PATH}: does not name the proof ${kind}`);
  }
  // Debt 11f (R7-6): the run gives every group one of these states, and the
  // contract that will define #36's gate names each of them and the one that
  // counts, so neither can drift from what the run reports.
  for (const state of COVERAGE_STATES) {
    if (!contract.includes(`\`${state}\``)) errors.push(`${CONTRACT_PATH}: coverage state ${state} is not named`);
  }
  if (!contract.includes("Only `covered_by_real_fault` counts toward the release gate (#36)")) {
    errors.push(`${CONTRACT_PATH}: does not say which coverage state counts toward the release gate`);
  }
  // Debt 12e (R8-7, R8-12): and that the count requires the designed fault
  // met on the product path, not a fault the run made in its place or a host
  // function's answer to a fixture.
  if (!contract.includes("the designed fault, met on the product path")) {
    errors.push(`${CONTRACT_PATH}: does not say the count requires the designed fault, met on the product path`);
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
  // Exactly four proofs per group, enforced by the schema rather than only by
  // the validator: a group with five would otherwise be shape-valid.
  const proofs = schema.properties?.groups?.items?.properties?.proofs ?? {};
  if (proofs.minItems !== 4 || proofs.maxItems !== 4) {
    errors.push(`${SCHEMA_PATH}: a fault group carries exactly four proofs`);
  }
  // A kind the coverage rule does not know would give its groups no state but
  // `not_covered` whatever the run observed, so a new kind is decided first.
  for (const kind of schema.properties?.groups?.items?.properties?.injection?.enum ?? []) {
    if (!INJECTION_KINDS.includes(kind)) {
      errors.push(`${SCHEMA_PATH}: injection kind ${kind} has no coverage state in scripts/lib/clean-room-coverage.mjs`);
    }
  }

  let matrix;
  try {
    matrix = JSON.parse(files[MATRIX_PATH]);
  } catch (error) {
    return [...errors, `${MATRIX_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...validateMatrix(matrix, schema).map((message) => `${MATRIX_PATH}: ${message}`));
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateCleanRoomDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const matrix = JSON.parse(files[MATRIX_PATH]);
    console.log("Clean-room fault matrix design validation PASS");
    console.log(`design_digest=${cleanRoomDesignDigest(files)}`);
    console.log(`groups=${matrix.groups.length}`);
    console.log(`boundaries=${new Set(matrix.groups.map((group) => group.boundary)).size}`);
  }
}
