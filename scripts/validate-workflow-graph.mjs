#!/usr/bin/env node

/**
 * Design-time validator for the issue #10 declarative workflow graph.
 *
 * The defect this contract closes is that the workflow is code: its steps,
 * transitions, guards, caps and recovery targets live in TypeScript and in
 * prose, so `workflow_graph_digest` has nothing to cover and a global update
 * can change the flow an Epic runs without changing anything the Epic pinned.
 *
 * So the checks here ask whether a document could be the graph it claims to
 * be: every edge lands on a declared step, every guard names a declared
 * predicate, no step offers two candidate edges the data cannot order, every
 * reason the graph can park with has a recovery row, every resume target is an
 * edge the graph actually declares, and the digest is over the canonical
 * serialization rather than over file bytes an editor may reflow.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/workflow-graph.md";
export const SCHEMA_PATH = "resources/workflow-graph/workflow-graph.schema.json";
export const EXAMPLE_PATH = "resources/workflow-graph/workflow-graph.example.json";
export const REFUSED_PATH = "resources/workflow-graph/workflow-graph.refused.example.json";
export const REFERENCE_PATH = "resources/workflow-graph/canonical-reference.json";
export const CONTRACT_MARKER = "<!-- workflow-graph-contract:v1 -->";

/**
 * The closed refusal set of section 9.
 *
 * Two kinds sit in one set because one contract owns both. The `graph_` codes
 * are design-time: this validator refuses a document. The three without the
 * prefix are runtime park reasons the graph itself issues, which no edge and
 * no step can carry — an undeclared pair has no edge, and therefore no guard
 * to hang a reason on.
 */
export const REFUSALS = Object.freeze([
  "graph_cap_transition_unknown",
  "graph_digest_stale",
  "graph_duplicate_key",
  "graph_duplicate_name",
  "graph_first_step_unknown",
  "graph_guard_unknown",
  "graph_lone_surrogate",
  "graph_number_not_canonical",
  "graph_predicate_unknown",
  "graph_priority_ambiguous",
  "graph_recovery_missing",
  "graph_recovery_reason_unknown",
  "graph_step_unknown",
  "graph_step_unreachable",
  "graph_terminal_step_leaves",
  "no_transition_reason",
  "resume_target_not_permitted",
  "transition_not_declared",
]);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * JSON, with duplicate keys refused.
 *
 * `JSON.parse` collapses `{"a":1,"a":2}` into one entry before any schema can
 * look at it: by the time a schema runs, the fact that the document said two
 * different things is gone. So the refusal has to happen where that
 * information still exists, which is the parse and nowhere later.
 *
 * Numbers and string escapes are parsed by the JSON grammar and normalized on
 * the way out rather than refused here, because two spellings of one value are
 * one value. Only the duplicate key loses information, and only it is refused.
 */
export function parseStrict(text) {
  let at = 0;

  const fail = (message) => {
    throw new SyntaxError(`${message} at offset ${at}`);
  };

  const skipWhitespace = () => {
    while (at < text.length && (text[at] === " " || text[at] === "\t" || text[at] === "\n" || text[at] === "\r")) {
      at += 1;
    }
  };

  const expect = (character) => {
    if (text[at] !== character) fail(`expected ${character}`);
    at += 1;
  };

  const parseStringValue = () => {
    expect('"');
    let value = "";
    for (;;) {
      if (at >= text.length) fail("unterminated string");
      const character = text[at];
      if (character === '"') {
        at += 1;
        return value;
      }
      if (character === "\\") {
        at += 1;
        const escape = text[at];
        at += 1;
        if (escape === "u") {
          const digits = text.slice(at, at + 4);
          if (!/^[0-9a-fA-F]{4}$/u.test(digits)) fail("malformed \\u escape");
          value += String.fromCharCode(Number.parseInt(digits, 16));
          at += 4;
        } else if (escape === '"' || escape === "\\" || escape === "/") {
          value += escape;
        } else if (escape === "b") value += "\b";
        else if (escape === "f") value += "\f";
        else if (escape === "n") value += "\n";
        else if (escape === "r") value += "\r";
        else if (escape === "t") value += "\t";
        else fail(`unknown escape \\${escape}`);
        continue;
      }
      if (character.charCodeAt(0) < 0x20) fail("raw control character in string");
      value += character;
      at += 1;
    }
  };

  const parseNumberValue = () => {
    const start = at;
    if (text[at] === "-") at += 1;
    if (text[at] === "0") at += 1;
    else if (/[1-9]/u.test(text[at] ?? "")) {
      while (/[0-9]/u.test(text[at] ?? "")) at += 1;
    } else fail("malformed number");
    if (text[at] === ".") {
      at += 1;
      if (!/[0-9]/u.test(text[at] ?? "")) fail("malformed fraction");
      while (/[0-9]/u.test(text[at] ?? "")) at += 1;
    }
    if (text[at] === "e" || text[at] === "E") {
      at += 1;
      if (text[at] === "+" || text[at] === "-") at += 1;
      if (!/[0-9]/u.test(text[at] ?? "")) fail("malformed exponent");
      while (/[0-9]/u.test(text[at] ?? "")) at += 1;
    }
    return Number(text.slice(start, at));
  };

  const parseValue = () => {
    skipWhitespace();
    const character = text[at];
    if (character === "{") {
      at += 1;
      const value = {};
      const seen = new Set();
      skipWhitespace();
      if (text[at] === "}") {
        at += 1;
        return value;
      }
      for (;;) {
        skipWhitespace();
        const keyAt = at;
        const key = parseStringValue();
        if (seen.has(key)) {
          at = keyAt;
          fail(`graph_duplicate_key: ${JSON.stringify(key)} is written twice in one object`);
        }
        seen.add(key);
        skipWhitespace();
        expect(":");
        value[key] = parseValue();
        skipWhitespace();
        if (text[at] === ",") {
          at += 1;
          continue;
        }
        expect("}");
        return value;
      }
    }
    if (character === "[") {
      at += 1;
      const value = [];
      skipWhitespace();
      if (text[at] === "]") {
        at += 1;
        return value;
      }
      for (;;) {
        value.push(parseValue());
        skipWhitespace();
        if (text[at] === ",") {
          at += 1;
          continue;
        }
        expect("]");
        return value;
      }
    }
    if (character === '"') return parseStringValue();
    if (text.startsWith("true", at)) {
      at += 4;
      return true;
    }
    if (text.startsWith("false", at)) {
      at += 5;
      return false;
    }
    if (text.startsWith("null", at)) {
      at += 4;
      return null;
    }
    return parseNumberValue();
  };

  const parsed = parseValue();
  skipWhitespace();
  if (at !== text.length) fail("trailing content after the document");
  return parsed;
}

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * A name as the daemon compares it: base64 of UTF-16LE.
 *
 * This is the rule that keeps an unpaired surrogate and U+FFFD two different
 * names. Encoding through UTF-8 would fold them together, and a step named by
 * one would silently answer for the other.
 */
export function encodeName(name) {
  return Buffer.from(name, "utf16le").toString("base64");
}

function canonicalNumber(value) {
  if (!Number.isInteger(value)) {
    throw new SyntaxError(`graph_number_not_canonical: ${value} is not an integer`);
  }
  if (Object.is(value, -0)) {
    throw new SyntaxError("graph_number_not_canonical: -0 is a second spelling of 0");
  }
  if (!Number.isSafeInteger(value)) {
    throw new SyntaxError(`graph_number_not_canonical: ${value} is outside the exactly representable range`);
  }
  return String(value);
}

const SHORT_ESCAPES = new Map([
  ['"', '\\"'],
  ["\\", "\\\\"],
  ["\b", "\\b"],
  ["\f", "\\f"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
]);

/**
 * Only what JSON requires is escaped.
 *
 * A character that does not require escaping has a literal spelling and a
 * `\uXXXX` spelling describing one value; the literal one is canonical, so the
 * two converge here rather than producing two digests for one graph.
 */
function canonicalString(value) {
  let out = '"';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const short = SHORT_ESCAPES.get(character);
    if (short !== undefined) {
      out += short;
      continue;
    }
    const unit = value.charCodeAt(index);
    if (unit < 0x20) {
      out += `\\u${unit.toString(16).padStart(4, "0")}`;
      continue;
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new SyntaxError("graph_lone_surrogate: an unpaired surrogate has no UTF-8 spelling");
      }
      out += character + value[index + 1];
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new SyntaxError("graph_lone_surrogate: an unpaired surrogate has no UTF-8 spelling");
    }
    out += character;
  }
  return `${out}"`;
}

/**
 * The arrays whose order the document decides, put in their one order.
 *
 * `transitions` and `resume_targets` are declared order-carrying by the plan
 * and are left exactly as written. Everything else is a set that happened to
 * be typed in some order, and a reshuffle of a set must not move the digest.
 */
export function normalizeGraph(document) {
  const byKey = (items, key) =>
    [...items].sort((left, right) => (left[key] < right[key] ? -1 : left[key] > right[key] ? 1 : 0));
  const normalized = { ...document };
  if (Array.isArray(document.predicates)) {
    normalized.predicates = byKey(document.predicates, "id").map((entry) => ({
      ...entry,
      reads: [...entry.reads].sort(),
    }));
  }
  if (Array.isArray(document.steps)) {
    normalized.steps = byKey(document.steps, "name").map((entry) =>
      entry.hooks ? { ...entry, hooks: [...entry.hooks].sort() } : entry,
    );
  }
  if (Array.isArray(document.guards)) {
    normalized.guards = byKey(document.guards, "id").map((entry) =>
      entry.authority?.policy_rules
        ? { ...entry, authority: { ...entry.authority, policy_rules: [...entry.authority.policy_rules].sort() } }
        : entry,
    );
  }
  if (Array.isArray(document.transitions)) {
    normalized.transitions = document.transitions.map((entry) => ({ ...entry, guards: [...entry.guards].sort() }));
  }
  if (Array.isArray(document.caps)) normalized.caps = byKey(document.caps, "cycle");
  if (Array.isArray(document.recovery)) {
    normalized.recovery = byKey(document.recovery, "reason").map((entry) => ({
      ...entry,
      parks_at: [...entry.parks_at].sort(),
    }));
  }
  return normalized;
}

/** Object keys in UTF-16LE code-unit order, which is what `sort` compares. */
export function canonicalText(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return canonicalNumber(value);
  if (typeof value === "string") return canonicalString(value);
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${canonicalString(key)}:${canonicalText(value[key])}`)
      .join(",")}}`;
  }
  throw new SyntaxError(`graph_number_not_canonical: ${typeof value} has no canonical spelling`);
}

/** The bytes the digest is taken over: the document without its own digest. */
export function canonicalBytes(document) {
  const { canonical_digest, ...body } = document;
  return Buffer.from(canonicalText(normalizeGraph(body)), "utf8");
}

export function graphDigest(document) {
  return createHash("sha256").update(canonicalBytes(document)).digest("hex");
}

// ---------------------------------------------------------------------------
// The graph itself
// ---------------------------------------------------------------------------

/**
 * Whether a document could be the graph it claims to be.
 *
 * The schema decides shape; everything below decides whether the shape refers
 * to anything. A schema-valid document whose edges point at steps that do not
 * exist is exactly the failure prose graphs have today.
 */
export function validateGraph(document, schema) {
  const schemaErrors = validateJsonSchema(document, schema).map((message) => `graph_schema: ${message}`);
  if (schemaErrors.length > 0) return schemaErrors;

  const errors = [];
  const duplicates = (items, key, what) => {
    const seen = new Set();
    for (const item of items) {
      if (seen.has(item[key])) errors.push(`graph_duplicate_name: two ${what} are named ${item[key]}`);
      seen.add(item[key]);
    }
  };
  duplicates(document.steps, "name", "steps");
  duplicates(document.predicates, "id", "predicates");
  duplicates(document.guards, "id", "guards");
  duplicates(document.transitions, "id", "transitions");
  duplicates(document.caps, "cycle", "caps");
  duplicates(document.recovery, "reason", "recovery rows");

  const steps = new Map(document.steps.map((step) => [step.name, step]));
  const predicates = new Set(document.predicates.map((entry) => entry.id));
  const guards = new Map(document.guards.map((guard) => [guard.id, guard]));
  const transitions = new Set(document.transitions.map((edge) => edge.id));

  if (!steps.has(document.first_step)) {
    errors.push(`graph_first_step_unknown: ${document.first_step} is not a declared step`);
  }

  for (const guard of document.guards) {
    if (!predicates.has(guard.predicate)) {
      errors.push(`graph_predicate_unknown: guard ${guard.id} names predicate ${guard.predicate}`);
    }
  }

  const outgoing = new Map();
  for (const edge of document.transitions) {
    if (!steps.has(edge.from)) errors.push(`graph_step_unknown: transition ${edge.id} leaves ${edge.from}`);
    if (!steps.has(edge.to)) errors.push(`graph_step_unknown: transition ${edge.id} arrives at ${edge.to}`);
    for (const guard of edge.guards) {
      if (!guards.has(guard)) errors.push(`graph_guard_unknown: transition ${edge.id} names guard ${guard}`);
    }
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  }

  // Two candidate edges at one priority is a choice the data cannot make, so it
  // would be decided by enumeration order — which is not a decision the
  // document records, and therefore not one two implementations would agree on.
  for (const [from, edges] of outgoing) {
    const byPriority = new Map();
    for (const edge of edges) {
      byPriority.set(edge.priority, [...(byPriority.get(edge.priority) ?? []), edge.id]);
    }
    for (const [priority, ids] of byPriority) {
      if (ids.length > 1) {
        errors.push(`graph_priority_ambiguous: ${from} leaves at priority ${priority} by ${ids.sort().join(" and ")}`);
      }
    }
  }

  // A terminal status step that still has edges is claiming to end the flow and
  // continuing it, and has no field in which to say why it did not leave.
  for (const step of document.steps) {
    if (step.kind === "status" && step.status !== "human" && (outgoing.get(step.name) ?? []).length > 0) {
      errors.push(`graph_terminal_step_leaves: ${step.name} is ${step.status} and still declares outgoing edges`);
    }
  }

  for (const cap of document.caps) {
    if (!transitions.has(cap.counted_transition)) {
      errors.push(`graph_cap_transition_unknown: cap ${cap.cycle} counts ${cap.counted_transition}`);
    }
  }

  const reached = new Set();
  const queue = steps.has(document.first_step) ? [document.first_step] : [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (reached.has(current)) continue;
    reached.add(current);
    for (const edge of outgoing.get(current) ?? []) if (steps.has(edge.to)) queue.push(edge.to);
  }
  for (const name of steps.keys()) {
    if (!reached.has(name)) errors.push(`graph_step_unreachable: ${name} is not reachable from ${document.first_step}`);
  }

  // Every reason the graph can park with, except the two the graph issues about
  // itself: those park wherever the flow already stands, so no single row could
  // describe where they resume from.
  const produced = new Set();
  for (const step of document.steps) if (step.no_transition_reason) produced.add(step.no_transition_reason);
  for (const guard of document.guards) produced.add(guard.park_reason);
  for (const cap of document.caps) produced.add(cap.park_reason);

  const rows = new Map(document.recovery.map((row) => [row.reason, row]));
  for (const reason of [...produced].sort()) {
    if (!rows.has(reason)) errors.push(`graph_recovery_missing: nothing says how to resume from ${reason}`);
  }
  for (const row of document.recovery) {
    if (!produced.has(row.reason)) {
      errors.push(`graph_recovery_reason_unknown: no step, guard or cap produces ${row.reason}`);
    }
    const permitted = new Set();
    for (const name of row.parks_at) {
      if (!steps.has(name)) errors.push(`graph_step_unknown: recovery row ${row.reason} parks at ${name}`);
      for (const edge of outgoing.get(name) ?? []) permitted.add(edge.to);
    }
    for (const target of row.resume_targets) {
      if (!permitted.has(target)) {
        errors.push(
          `resume_target_not_permitted: ${row.reason} resumes at ${target}, ` +
            `which is not a declared edge from ${row.parks_at.join(" or ")}`,
        );
      }
    }
  }

  const expected = graphDigest(document);
  if (document.canonical_digest !== expected) {
    errors.push(`graph_digest_stale: recorded ${document.canonical_digest}, computed ${expected}`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// The canonicalization reference
// ---------------------------------------------------------------------------

/**
 * Whether this implementation reproduces the shipped reference.
 *
 * Two implementations are compared by the reference and not by the prose: a
 * fork the reference does not exercise is left to whoever writes the second
 * implementation, exactly as if the rule had never been written down.
 */
export function validateReference(reference) {
  const errors = [];
  const decode = (encoded) => Buffer.from(encoded, "base64").toString("utf8");

  const canonicalOf = (encodedInput) => {
    const bytes = canonicalBytes(parseStrict(decode(encodedInput)));
    return { base64: bytes.toString("base64"), digest: createHash("sha256").update(bytes).digest("hex") };
  };

  const document = canonicalOf(reference.document.input_utf8_base64);
  if (document.base64 !== reference.document.canonical_utf8_base64) {
    errors.push("reference document: canonical bytes do not reproduce");
  }
  if (document.digest !== reference.document.canonical_digest) {
    errors.push(
      `reference document: digest does not reproduce: recorded ${reference.document.canonical_digest}, ` +
        `computed ${document.digest}`,
    );
  }

  const seen = new Set();
  for (const fork of reference.forks) {
    seen.add(fork.fork);
    if (fork.outcome === "converges") {
      for (const encoded of fork.inputs_utf8_base64) {
        const produced = canonicalOf(encoded);
        if (produced.base64 !== fork.canonical_utf8_base64) {
          errors.push(`${fork.fork}: an input does not canonicalize to the recorded bytes`);
        }
        if (produced.digest !== fork.canonical_digest) {
          errors.push(`${fork.fork}: an input does not produce the recorded digest`);
        }
      }
    } else if (fork.outcome === "refused") {
      let refusal = "";
      try {
        parseStrict(decode(fork.input_utf8_base64));
      } catch (error) {
        refusal = error.message;
      }
      if (!refusal) errors.push(`${fork.fork}: the input was accepted and the reference says it is refused`);
      else if (!refusal.startsWith(fork.refusal)) {
        errors.push(`${fork.fork}: refused with ${refusal}, and the reference records ${fork.refusal}`);
      }
    } else if (fork.outcome === "stays_distinct") {
      const encodings = new Set();
      for (const input of fork.inputs) {
        const name = String.fromCharCode(...input.code_units);
        const encoded = encodeName(name);
        if (encoded !== input.expected_base64) {
          errors.push(`${fork.fork}: ${input.label} encodes to ${encoded}, and the reference records ${input.expected_base64}`);
        }
        encodings.add(encoded);
      }
      if (encodings.size !== fork.inputs.length) {
        errors.push(`${fork.fork}: the inputs collapse to one encoding, and the fork exists because they must not`);
      }
    } else {
      errors.push(`${fork.fork}: unknown outcome ${fork.outcome}`);
    }
  }

  // The plan names the four forks the reference must exercise. A reference that
  // quietly drops one leaves that fork to the implementation, which is what
  // shipping no reference at all would have done.
  for (const required of ["integer_two_spellings", "string_two_spellings", "duplicate_key", "lone_surrogate_name"]) {
    if (!seen.has(required)) errors.push(`reference: fork ${required} is not exercised`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export function loadFiles(root = ROOT) {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, REFUSED_PATH, REFERENCE_PATH]) {
    files[relative] = readFileSync(path.join(root, relative), "utf8");
  }
  return files;
}

export function workflowGraphDesignDigest(files) {
  return createHash("sha256")
    .update(
      Object.keys(files)
        .sort()
        .map((relative) => `${relative} ${createHash("sha256").update(files[relative], "utf8").digest("hex")}`)
        .join(""),
    )
    .digest("hex");
}

export function validateWorkflowGraphDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  for (const refusal of REFUSALS) {
    if (!contract.includes(`\`${refusal}\``)) {
      errors.push(`${CONTRACT_PATH}: does not close ${refusal}`);
    }
  }

  let schema;
  try {
    schema = parseStrict(files[SCHEMA_PATH]);
  } catch (error) {
    return [...errors, `${SCHEMA_PATH}: ${error.message}`];
  }

  for (const relative of [EXAMPLE_PATH, REFUSED_PATH]) {
    let document;
    try {
      document = parseStrict(files[relative]);
    } catch (error) {
      errors.push(`${relative}: ${error.message}`);
      continue;
    }
    const found = validateGraph(document, schema);
    if (relative === EXAMPLE_PATH) {
      errors.push(...found.map((message) => `${relative}: ${message}`));
    } else if (found.length === 0) {
      errors.push(`${relative}: accepted, and it exists to be refused`);
    }
  }

  try {
    errors.push(...validateReference(parseStrict(files[REFERENCE_PATH])).map((message) => `${REFERENCE_PATH}: ${message}`));
  } catch (error) {
    errors.push(`${REFERENCE_PATH}: ${error.message}`);
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateWorkflowGraphDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const example = parseStrict(files[EXAMPLE_PATH]);
    console.log("Workflow graph design validation PASS");
    console.log(`design_digest=${workflowGraphDesignDigest(files)}`);
    console.log(`canonical_digest=${example.canonical_digest}`);
  }
}
