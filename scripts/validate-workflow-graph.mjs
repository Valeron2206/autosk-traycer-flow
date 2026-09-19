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

// One implementation of canonical, in `src/host` because the factory of slice 5
// needs it too. Re-exported here so every existing caller of this validator
// keeps its import: a second spelling of "canonical" is what slice 1 exists to
// prevent, and moving the code without keeping the surface would have produced
// one by accident.
export {
  canonicalBytes,
  canonicalText,
  graphDigest,
  normalizeGraph,
} from "../src/host/workflow-graph-canonical.mjs";
import { canonicalBytes, graphDigest } from "../src/host/workflow-graph-canonical.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/workflow-graph.md";
export const SCHEMA_PATH = "resources/workflow-graph/workflow-graph.schema.json";
export const EXAMPLE_PATH = "resources/workflow-graph/workflow-graph.example.json";
export const DOCUMENT_PATH = "resources/workflow-graph/workflow-graph.v1.json";
export const REFUSED_PATH = "resources/workflow-graph/workflow-graph.refused.example.json";
export const REFERENCE_PATH = "resources/workflow-graph/canonical-reference.json";
export const VOCABULARY_PATH = "resources/refusal-vocabulary/refusal-vocabulary.v1.json";
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
  "graph_cap_binding_ambiguous",
  "graph_cap_binding_incomplete",
  "graph_cap_quantity_undeclared",
  "graph_cap_transition_shared",
  "graph_cap_transition_unknown",
  "graph_digest_stale",
  "graph_duplicate_key",
  "graph_duplicate_name",
  "graph_entry_step_unknown",
  "graph_external_outcome_uncarried",
  "graph_first_step_unknown",
  "graph_guard_unknown",
  "graph_lone_surrogate",
  "graph_not_json",
  "graph_number_not_canonical",
  "graph_park_reason_ambiguous",
  "graph_park_reason_reserved",
  "graph_park_reason_unknown",
  "graph_predicate_unknown",
  "graph_priority_ambiguous",
  "graph_recovery_handled_at_parks",
  "graph_recovery_lists_overlap",
  "graph_recovery_missing",
  "graph_recovery_parks_at_incomplete",
  "graph_recovery_parks_at_unproduced",
  "graph_recovery_reason_unknown",
  "graph_recovery_terminal_resume",
  "graph_schema",
  "graph_step_stranded",
  "graph_step_unknown",
  "graph_step_unreachable",
  "graph_terminal_step_leaves",
  "no_transition_reason",
  "resume_target_not_permitted",
  "transition_not_declared",
]);

/** The three this contract owns. Every other code a graph names is the workflow's. */
export const GRAPH_PARK_REASONS = Object.freeze([
  "no_transition_reason",
  "resume_target_not_permitted",
  "transition_not_declared",
]);

/**
 * The codes an ordinary step, guard, cap or recovery row may name.
 *
 * This is the workflow's own vocabulary and nothing else. Owning a code and
 * being allowed to name it are different questions: the three above belong to
 * the graph, which issues them about itself, so a document that put one on a
 * guard would be claiming an edge refused for a reason that exists precisely
 * when there is no edge.
 *
 * The schema says a code outside the vocabulary is refused. Checking only the
 * spelling would leave that sentence unenforced: `totally_unknown_reason` has
 * the right shape and belongs to nobody.
 *
 * Read every time, and a fresh set every time. One remembered set is shared
 * mutable state: a caller that adds to it widens what every later check will
 * accept, and a second root would silently be checked against the first root's
 * vocabulary.
 */
export function parkReasons(root = ROOT) {
  const vocabulary = JSON.parse(readFileSync(path.join(root, VOCABULARY_PATH), "utf8"));
  return new Set(vocabulary.park_reasons.map((entry) => entry.code));
}

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
/**
 * The integer a numeric token exactly denotes, or a refusal.
 *
 * Integrality is a property of what was written, not of the float it becomes.
 * `1.00000000000000001` rounds to exactly 1 and `1e-4000` underflows to 0, so a
 * check made after the conversion accepts two fractions as integers — and an
 * implementation with exact decimal arithmetic would refuse both, which is the
 * disagreement the canonical reference exists to prevent. The digits are read
 * first and converted only once the value is known to be an integer the range
 * can hold exactly.
 *
 * The spellings that mean one integer still converge: `1`, `1.0`, `1e0` and
 * `10e-1` all arrive here as 1.
 */
export function exactInteger(token, refuse) {
  const parts = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(token);
  if (!parts) return refuse(`${token} is not a number the graph writes`);
  const [, sign, whole, fraction = "", exponent = "0"] = parts;
  const digits = whole + fraction;

  // Zero first, and without touching the exponent. An exponent is a number in
  // the input, not a length: `0e1000000000` is twelve characters and is zero,
  // and deciding that by shifting a decimal point would ask for a billion of
  // them.
  const significant = digits.search(/[1-9]/u);
  if (significant === -1) return sign === "-" ? refuse("-0 is a second spelling of 0") : 0;

  // Where the decimal point lands among the digits. Beyond it is the fraction,
  // and a non-zero digit there means the token is not an integer however it was
  // written. Slicing past the end costs nothing, so a huge point is safe here.
  const point = whole.length + Number(exponent);
  if (point <= significant || /[1-9]/u.test(digits.slice(point))) {
    return refuse(`${token} is not an integer`);
  }

  // How many digits the integer has, counted rather than built. The largest
  // exactly representable integer has sixteen, so anything longer is refused
  // before a string of that length is ever allocated.
  const length = point - significant;
  if (length > String(Number.MAX_SAFE_INTEGER).length) {
    return refuse(`${token} is outside the exactly representable range`);
  }
  const magnitude = BigInt(digits.slice(significant, point).padEnd(length, "0"));
  const value = sign === "-" ? -magnitude : magnitude;
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    return refuse(`${token} is outside the exactly representable range`);
  }
  return Number(value);
}

export function parseStrict(text) {
  let at = 0;

  const failWith = (code, message) => {
    throw new SyntaxError(`${code}: ${message} at offset ${at}`);
  };
  const fail = (message) => failWith("graph_not_json", message);

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
    return exactInteger(text.slice(start, at), (message) => failWith("graph_number_not_canonical", message));
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
          failWith("graph_duplicate_key", `${JSON.stringify(key)} is written twice in one object`);
        }
        seen.add(key);
        skipWhitespace();
        expect(":");
        // Defined rather than assigned: `value.__proto__ = x` moves the object's
        // prototype instead of creating an own property, and a closed schema
        // reads own properties — so an assigned `__proto__` would be invisible
        // to `additionalProperties: false` and dropped by the serializer.
        Object.defineProperty(value, key, {
          value: parseValue(),
          enumerable: true,
          writable: true,
          configurable: true,
        });
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


// ---------------------------------------------------------------------------
// The graph itself
// ---------------------------------------------------------------------------

/**
 * Where the graph itself parks each reason, keyed by reason.
 *
 * Three producers, and the step is a different field in each: a guard on an
 * edge into a step that stops for a person parks at the step the edge LEAVES,
 * not at the one it enters — the flow got there by taking that edge. A step's
 * own `no_transition_reason` parks where the step is. A cap parks where its
 * counted transition leaves.
 */
export function producedAt(document, steps = new Map(document.steps.map((step) => [step.name, step]))) {
  const where = new Map();
  const add = (reason, name) => {
    if (!where.has(reason)) where.set(reason, new Set());
    where.get(reason).add(name);
  };
  const guards = new Map(document.guards.map((guard) => [guard.id, guard]));
  for (const edge of document.transitions) {
    const to = steps.get(edge.to);
    if (to?.kind !== "status" || to.status !== "human") continue;
    for (const id of edge.guards) {
      const reason = guards.get(id)?.park_reason;
      if (reason !== undefined) add(reason, edge.from);
    }
  }
  for (const step of document.steps) if (step.no_transition_reason) add(step.no_transition_reason, step.name);
  for (const cap of document.caps) {
    const counted = document.transitions.find((edge) => edge.id === cap.counted_transition);
    if (counted) add(cap.park_reason, counted.from);
  }
  return where;
}

/**
 * Whether a document could be the graph it claims to be.
 *
 * The schema decides shape; everything below decides whether the shape refers
 * to anything. A schema-valid document whose edges point at steps that do not
 * exist is exactly the failure prose graphs have today.
 */
export function validateGraph(document, schema, allowed = parkReasons()) {
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

  // Every status this document can drive must have something that performs it. The question
  // is who executes, not where the outcome is mentioned: the statuses come from the step
  // schema's own enum rather than from a list here, so the rule cannot drift from what a
  // document is allowed to say, and it reads no prose, so it cannot be argued with.
  //
  // A status is carried by a step that drives it or by an entry in `external_operations`,
  // and never by both. `human` and `done` are carried by steps. `cancel` was carried by
  // nothing: `cond_272` said the outcome of an unresolved foreign movement is "human or
  // cancel", the graph drew the human half as `t_367` and the cancel half as nothing at
  // all, and the views described a status operation without naming what performs it — so a
  // task under that reason stood with an exit the document promised and could not
  // execute. Both halves are refused here because either one alone is a document that
  // contradicts itself: a status with no carrier promises what nothing performs, and a
  // status with two says it is outside the workflow while an edge inside carries it.
  const admittedStatuses = schema?.properties?.steps?.items?.properties?.status?.enum ?? [];
  const operations = new Map((document.external_operations ?? []).map((op) => [op.status, op]));
  for (const status of [...admittedStatuses].sort()) {
    const steppedBy = document.steps.filter((step) => step.status === status).map((step) => step.name);
    const external = operations.has(status);
    if (steppedBy.length === 0 && !external) {
      errors.push(
        `graph_external_outcome_uncarried: nothing carries ${status} — no step drives it and no ` +
          "external operation executes it, so a document may name that outcome and nothing performs it",
      );
    }
    if (steppedBy.length > 0 && external) {
      errors.push(
        `graph_external_outcome_uncarried: ${status} is declared an operation outside the ` +
          `workflow and ${steppedBy.sort().join(", ")} drives it as a step`,
      );
    }
  }
  if (operations.size !== (document.external_operations ?? []).length) {
    errors.push(
      "graph_external_outcome_uncarried: two entries declare an executor for one status, " +
        "so which operation performs it is not decided",
    );
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

  // The mirror image: a status step may end the flow because ending is what it
  // is for, but an agent step may not — one with no outgoing edge can only ever
  // park, and a flow that can only park has nowhere to go. The shipped document
  // carried exactly one for a release; the rule keys on the kind rather than on
  // a list so the next one is refused instead of named.
  for (const step of document.steps) {
    if (step.kind === "agent" && (outgoing.get(step.name) ?? []).length === 0) {
      errors.push(`graph_step_stranded: ${step.name} is an agent step and declares no way out`);
    }
  }

  for (const cap of document.caps) {
    if (!transitions.has(cap.counted_transition)) {
      errors.push(`graph_cap_transition_unknown: cap ${cap.cycle} counts ${cap.counted_transition}`);
    }
  }

  // A cap is measured at runtime by the durable transition_takings counter,
  // which is keyed by the (from, to) pair an edge traverses — the step the flow
  // leaves and the step it lands on — not by the transition's own id. So the
  // counted edge must be the only one on its pair: a second transition over
  // the same pair would have its takings counted toward the cap as well, and
  // the document would be claiming a precision the counter cannot give. An
  // uncapped shared pair is fine — nothing reads its count.
  const byPair = new Map();
  for (const edge of document.transitions) {
    const pair = `${edge.from} -> ${edge.to}`;
    byPair.set(pair, [...(byPair.get(pair) ?? []), edge.id]);
  }
  for (const cap of document.caps) {
    const counted = document.transitions.find((edge) => edge.id === cap.counted_transition);
    if (!counted) continue; // already refused as graph_cap_transition_unknown
    const siblings = (byPair.get(`${counted.from} -> ${counted.to}`) ?? []).filter((id) => id !== counted.id);
    if (siblings.length > 0) {
      errors.push(
        `graph_cap_transition_shared: cap ${cap.cycle} counts ${counted.id} (${counted.from} -> ${counted.to}), ` +
          `which shares its pair with ${siblings.join(", ")}`,
      );
    }
  }

  // The same per-guard binding the runtime applies is checked here, so a
  // document that cannot be bound is refused before it ships rather than at
  // build. Two ways the binding is incomplete: a counted edge that declares
  // no guards carries nothing the below-limit term can bind to, and a cap no
  // sibling edge carries the park_reason of has nothing to park on at the
  // limit. Two ways it is ambiguous: a guard the binding reaches that another
  // edge also references would carry the cap's constraint onto a move the cap
  // never named, and an edge two caps bind would owe both limits.
  const guardRefs = new Map();
  for (const edge of document.transitions) {
    for (const id of new Set(edge.guards)) {
      guardRefs.set(id, [...(guardRefs.get(id) ?? []), edge]);
    }
  }
  const boundGuards = new Map();
  const boundEdges = new Map();
  for (const cap of document.caps) {
    const counted = document.transitions.find((edge) => edge.id === cap.counted_transition);
    if (!counted) continue; // already refused as graph_cap_transition_unknown
    if (counted.guards.length === 0) {
      errors.push(
        `graph_cap_binding_incomplete: cap ${cap.cycle} counts ${counted.id}, ` +
          "which declares no guards to bind below its limit",
      );
      continue;
    }
    const countedEntry = boundEdges.get(counted.id) ?? { edge: counted, caps: new Set() };
    countedEntry.caps.add(cap);
    boundEdges.set(counted.id, countedEntry);
    for (const id of counted.guards) {
      boundGuards.set(id, [...(boundGuards.get(id) ?? []), { edge: counted, cap }]);
    }
    const carrying = (outgoing.get(counted.from) ?? []).filter(
      (edge) => edge.id !== counted.id && edge.guards.some((id) => guards.get(id)?.park_reason === cap.park_reason),
    );
    if (carrying.length === 0) {
      errors.push(
        `graph_cap_binding_incomplete: cap ${cap.cycle} has no edge out of ${counted.from} ` +
          `carrying ${cap.park_reason} to park on at the limit`,
      );
      continue;
    }
    for (const edge of carrying) {
      const entry = boundEdges.get(edge.id) ?? { edge, caps: new Set() };
      entry.caps.add(cap);
      boundEdges.set(edge.id, entry);
      for (const id of edge.guards) {
        boundGuards.set(id, [...(boundGuards.get(id) ?? []), { edge, cap }]);
      }
    }
  }
  for (const [id, bindings] of boundGuards) {
    const caps = [...new Set(bindings.map(({ cap }) => cap.cycle))].join(" and ");
    const boundSet = new Set(bindings.map(({ edge }) => edge.id));
    const outside = (guardRefs.get(id) ?? []).filter((edge) => !boundSet.has(edge.id));
    if (outside.length > 0) {
      errors.push(
        `graph_cap_binding_ambiguous: guard ${id} carries ${caps}'s term on ${[...boundSet].join(", ")} ` +
          `and is also referenced by ${outside.map((edge) => edge.id).join(", ")}`,
      );
      continue;
    }
    if (boundSet.size > 1) {
      errors.push(
        `graph_cap_binding_ambiguous: guard ${id} carries ${caps}'s term on ${[...boundSet].join(" and ")}`,
      );
    }
  }
  for (const { edge, caps } of boundEdges.values()) {
    if (caps.size > 1) {
      errors.push(
        `graph_cap_binding_ambiguous: edge ${edge.id}, guarded by ${edge.guards.join(", ")}, ` +
          `is bound by ${[...caps].map((cap) => cap.cycle).join(" and ")}`,
      );
    }
  }

  // Which predicates are a cap's is read off the edges, not off the predicates:
  // the guards on its counted transition — they let the flow take another
  // round — and the guards on the sibling edge that carries the cap's own
  // park_reason, which is the edge the flow parks on when the limit is reached.
  // Whatever those descriptions compare with `cap` is the quantity the cap
  // fires on, and the document must declare it readable: the union of every
  // predicate's `reads` is the vocabulary an evaluator draws names from, and a
  // compared quantity outside it is a quantity nothing names. The shipped
  // document compared `round` with both caps while no predicate's reads
  // declared it. The check stays this narrow on purpose: naming ANY word of
  // the vocabulary in a description outside one's own reads is a different,
  // measuredly lawful shape — most predicates do it — and refusing that would
  // redden the document on the majority that is not the defect.
  //
  // The comparison notation the check reads is a closed set, parsed exactly —
  // a pattern patched per counterexample always has a next counterexample.
  // `operand OP operand`, the word `cap` on one side and an identifier on the
  // other, each operand either bare or wrapped in ONE balanced pair of
  // parentheses, whitespace free, OP one of `<`, `>`, `<=`, `>=`, `=`, `==`,
  // `!=`, `≤`, `≥`, `≠`. Chains are not supported: a `cap` whose comparison
  // touches another operator on either side is refused, never checked on
  // either side — `transition_takings >= cap > round` hid an undeclared
  // quantity behind a lawful first comparison. So is a `cap` beside an
  // unbalanced or stray parenthesis, or with no comparison around it at all.
  // A predicate that never names `cap` owes nothing — auxiliary guards are
  // left alone.
  //
  // The token boundary is the whole run of identifier characters, leading
  // digits included: `0transition_takings` is ONE run and not an identifier,
  // so it is no operand, and `0cap` contains no `cap` word at all — the rule
  // never reaches it. Slicing the run at the digit let the first through and
  // made the second a false refusal.
  const declaredReads = new Set(document.predicates.flatMap((entry) => entry.reads));
  const capToken = /[A-Za-z0-9_]+|<=|>=|==|!=|≤|≥|≠|<|>|=|\(|\)|[\s\S]/gu;
  const isOperator = (token) => typeof token === "string" && /^(?:<=|>=|==|!=|≤|≥|≠|<|>|=)$/u.test(token);
  const isIdentifier = (token) => typeof token === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(token);
  const isParen = (token) => token === "(" || token === ")";
  for (const cap of document.caps) {
    const counted = document.transitions.find((edge) => edge.id === cap.counted_transition);
    if (!counted) continue; // already refused as graph_cap_transition_unknown
    const named = new Set(counted.guards.map((id) => guards.get(id)?.predicate));
    for (const edge of outgoing.get(counted.from) ?? []) {
      if (edge.id === counted.id) continue;
      if (edge.guards.some((id) => guards.get(id)?.park_reason === cap.park_reason)) {
        for (const id of edge.guards) named.add(guards.get(id)?.predicate);
      }
    }
    for (const id of named) {
      const entry = document.predicates.find((candidate) => candidate.id === id);
      if (!entry) continue; // already refused as graph_predicate_unknown
      const tokens = [...entry.description.matchAll(capToken)]
        .map((match) => match[0])
        .filter((token) => !/^\s+$/u.test(token));
      for (let at = 0; at < tokens.length; at += 1) {
        if (tokens[at] !== "cap") continue;
        // cap's operand is bare, or exactly one balanced pair of parentheses —
        // any other paren next to it is a form the check cannot read.
        let lo = at;
        let hi = at;
        let malformed = false;
        if (tokens[at - 1] === "(" && tokens[at + 1] === ")") {
          lo = at - 1;
          hi = at + 1;
        } else if (isParen(tokens[at - 1]) || isParen(tokens[at + 1])) {
          malformed = true;
        }
        const leftOp = isOperator(tokens[lo - 1]);
        const rightOp = isOperator(tokens[hi + 1]);
        if (leftOp === rightOp) malformed = true; // both sides is a chain, neither is no comparison
        let quantity;
        if (!malformed) {
          const operator = leftOp ? lo - 1 : hi + 1;
          const near = leftOp ? operator - 1 : operator + 1;
          let operandLo = near;
          let operandHi = near;
          if (leftOp && tokens[near] === ")" && isIdentifier(tokens[near - 1]) && tokens[near - 2] === "(") {
            operandLo = near - 2;
          } else if (!leftOp && tokens[near] === "(" && isIdentifier(tokens[near + 1]) && tokens[near + 2] === ")") {
            operandHi = near + 2;
          } else if (!isIdentifier(tokens[near])) {
            malformed = true;
          }
          const before = tokens[Math.min(lo, operandLo) - 1];
          const after = tokens[Math.max(hi, operandHi) + 1];
          if (isOperator(before) || isOperator(after) || isParen(before) || isParen(after)) malformed = true;
          quantity = tokens[operandLo] === "(" ? tokens[operandLo + 1] : tokens[operandLo];
        }
        if (malformed) {
          errors.push(
            `graph_cap_quantity_undeclared: cap ${cap.cycle}'s predicate ${id} mentions cap outside ` +
              "a comparison the validator can read",
          );
        } else if (!declaredReads.has(quantity)) {
          errors.push(
            `graph_cap_quantity_undeclared: cap ${cap.cycle}'s predicate ${id} compares with ${quantity}, ` +
              "which no predicate's reads declares",
          );
        }
      }
    }
  }

  // A graph is entered at first_step and at every step entry_steps declares: the
  // other registered workflows start elsewhere, and the daemon enters its repair
  // steps out of band. Reachability from that whole set is what makes a step
  // orphaned or not; measuring from first_step alone called eight workflows dead.
  const entries = [document.first_step];
  for (const entry of document.entry_steps ?? []) {
    if (!steps.has(entry.step)) {
      errors.push(`graph_entry_step_unknown: ${entry.step} is not a declared step`);
      continue;
    }
    entries.push(entry.step);
  }

  const reached = new Set();
  const queue = entries.filter((name) => steps.has(name));
  const entered = queue.join(", ");
  while (queue.length > 0) {
    const current = queue.shift();
    if (reached.has(current)) continue;
    reached.add(current);
    for (const edge of outgoing.get(current) ?? []) if (steps.has(edge.to)) queue.push(edge.to);
  }
  for (const name of steps.keys()) {
    if (!reached.has(name)) errors.push(`graph_step_unreachable: ${name} is not reachable from ${entered}`);
  }

  // Every reason the graph can park with, except the two the graph issues about
  // itself: those park wherever the flow already stands, so no single row could
  // describe where they resume from.
  const produced = new Set();
  for (const step of document.steps) if (step.no_transition_reason) produced.add(step.no_transition_reason);
  for (const guard of document.guards) produced.add(guard.park_reason);
  for (const cap of document.caps) produced.add(cap.park_reason);

  // The schema says a code outside the vocabulary is refused. Checking only the
  // spelling would leave that a sentence: a well-formed name owned by nobody is
  // exactly the code no recovery contract can be read for.
  for (const [named, reason] of [
    ...document.steps
      .filter((step) => step.no_transition_reason)
      .map((step) => [`step ${step.name}`, step.no_transition_reason]),
    ...document.guards.map((guard) => [`guard ${guard.id}`, guard.park_reason]),
    ...document.caps.map((cap) => [`cap ${cap.cycle}`, cap.park_reason]),
    ...document.recovery.map((row) => [`recovery row ${row.reason}`, row.reason]),
  ]) {
    if (GRAPH_PARK_REASONS.includes(reason)) {
      errors.push(`graph_park_reason_reserved: ${named} names ${reason}, which the graph issues about itself`);
    } else if (!allowed.has(reason)) {
      errors.push(`graph_park_reason_unknown: ${named} names ${reason}`);
    }
  }

  // A declared edge into a step that stops the flow for a person stops it just
  // as surely as finding no candidate does, and the reason recorded there is
  // what operation 2 reads permission off. So the edge has to say which reason,
  // and exactly one guard's worth of it.
  //
  // The runtime refuses this too, and refusing it only there was not enough: a
  // build happens after the document is shipped, pinned and digested, and the
  // example in this repository is the proof — the validator accepted it while
  // the factory could not build it at all.
  for (const edge of document.transitions) {
    const to = steps.get(edge.to);
    if (to?.kind !== "status" || to.status !== "human") continue;
    const named = new Set(edge.guards.map((id) => guards.get(id)?.park_reason).filter((reason) => reason !== undefined));
    if (named.size === 1) continue;
    errors.push(
      named.size === 0
        ? `graph_park_reason_ambiguous: ${edge.id} parks the task and no guard names a reason`
        : `graph_park_reason_ambiguous: ${edge.id} parks the task and its guards name ${[...named].sort().join(", ")}`,
    );
  }

  const rows = new Map(document.recovery.map((row) => [row.reason, row]));
  for (const reason of [...produced].sort()) {
    if (!rows.has(reason)) errors.push(`graph_recovery_missing: nothing says how to resume from ${reason}`);
  }
  for (const row of document.recovery) {
    if (!produced.has(row.reason)) {
      errors.push(`graph_recovery_reason_unknown: no step, guard or cap produces ${row.reason}`);
    }
    // Resume is permitted out of either list. `parks_at` says where the flow stops
    // with the reason, `handled_at` says where the reason is dealt with, and 114 of
    // the document's targets are an edge out of the second only — reading the rule
    // over `parks_at` alone would refuse the resume paths the plan describes.
    const named = [...row.parks_at, ...(row.handled_at ?? [])];
    const permitted = new Set();
    for (const name of named) {
      if (!steps.has(name)) errors.push(`graph_step_unknown: recovery row ${row.reason} parks at ${name}`);
      for (const edge of outgoing.get(name) ?? []) permitted.add(edge.to);
    }
    for (const target of row.resume_targets) {
      if (!permitted.has(target)) {
        errors.push(
          `resume_target_not_permitted: ${row.reason} resumes at ${target}, ` +
            `which is not a declared edge from ${named.join(" or ")}`,
        );
      }
    }
    // A step with no outgoing edge may be where a row's tasks stand or where a
    // resume lands, but never both in one row. `parks_at` records where the flow
    // stops with the reason; `resume_targets` is what a task parked there may
    // move to — and a task parked on the step resuming INTO it arrives again,
    // and every arrival replays the step's body. The union is untouched: the
    // step stays a lawful target of every other row that does not park there.
    for (const name of row.parks_at) {
      if ((outgoing.get(name) ?? []).length > 0) continue;
      if (row.resume_targets.includes(name)) {
        errors.push(
          `graph_recovery_terminal_resume: ${row.reason} parks at ${name} ` +
            "and permits resume into it, a step with no way out",
        );
      }
    }
  }

  // `parks_at` is checked against the graph in BOTH directions, because it says
  // one thing now. Where the graph produces a reason must be listed, or the union
  // `resume_targets` is bound to is computed over steps the flow never stops at;
  // and what is listed must be where the graph produces it, or the field is back
  // to doing two jobs and neither is checkable. A step where the reason is dealt
  // with rather than raised belongs in `handled_at`, which the resume rule reads
  // as well — so the second direction moves a step, it does not delete it.
  //
  // The exemption is keyed on the kind and nothing else: a status step is where a
  // parked task STANDS, and standing there is what this field records, so one is
  // accepted here WITHOUT the graph having to park the reason from it. That is a
  // boundary of the check, not a proof about any one reference — and not the claim
  // that a status step can never be produced: an edge out of a status step into a
  // human status step puts it there, and such a document is legal. What holds of
  // the shipped document is that none of its eight status references is produced,
  // so each rests on this line. Requiring the step to be the LANDING of an edge
  // carrying the reason was measured instead and rejected: five of the eight pass
  // and three do not, all under the reason the daemon raises outside the graph
  // wherever a task stands. The codes are not spelled in these comments because the
  // vocabulary's producer scan reads a mention as a claim to produce it, which is
  // how this block failed the gate the first time.
  const producedFor = producedAt(document, steps);
  for (const [reason, where] of producedFor) {
    const row = rows.get(reason);
    if (!row) continue;
    const listed = new Set(row.parks_at);
    for (const name of [...where].sort()) {
      if (listed.has(name)) continue;
      errors.push(`graph_recovery_parks_at_incomplete: ${reason} parks at ${name}, which its row does not list`);
    }
  }
  // Both fields are checked against the graph, because each makes a statement the
  // other does not. One says the flow stops here, the other says the reason never
  // arises here, and a field whose negative statement nothing enforces is a field
  // that can be written either way: before this, one step could be claimed as both
  // a place the reason is produced and a place it is not.
  //
  // The overlap check is not implied by the other two. A step the graph parks at is
  // caught by the second loop and a step it does not by the first, but a status step
  // is exempt from the first and absent from what the graph produces, so it could
  // sit in both lists with each saying the opposite of the other.
  for (const row of document.recovery) {
    const where = producedFor.get(row.reason) ?? new Set();
    for (const name of [...row.parks_at].sort()) {
      if (where.has(name) || steps.get(name)?.kind === "status") continue;
      errors.push(
        `graph_recovery_parks_at_unproduced: ${row.reason} lists ${name}, ` +
          "where nothing in the graph parks it; a step that only handles it belongs in the other list",
      );
    }
    const parking = new Set(row.parks_at);
    for (const name of [...(row.handled_at ?? [])].sort()) {
      if (where.has(name)) {
        errors.push(
          `graph_recovery_handled_at_parks: ${row.reason} calls ${name} a step that only handles it, ` +
            "and the graph parks it there",
        );
      }
      if (parking.has(name)) {
        errors.push(`graph_recovery_lists_overlap: ${row.reason} names ${name} in both of its lists`);
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
 * The array paths `normalizeGraph` sorts — the rewrite's sets.
 *
 * Membership is a property of the field, not of the values it happens to
 * hold: two `views[].rows` that differ only inside their sorted sets are
 * canonically equal, so probing whether a reversal moves the canonical bytes
 * would call that ordered array a set. The roles are stated here instead,
 * read off `normalizeGraph` as it stands — `*` marks an element of the array
 * above it, so `transitions.*.guards` is the guard list inside each written
 * transition, while `transitions` itself is absent and keeps its order. The
 * tests pin every listed entry against the canonicalizer and check the array
 * reversals observable in the shipped example; a change to `normalizeGraph`
 * still requires checking this table against it.
 */
export const SORTED_ARRAY_PATHS = new Set([
  "predicates",
  "predicates.*.reads",
  "steps",
  "steps.*.hooks",
  "guards",
  "guards.*.authority.policy_rules",
  "transitions.*.guards",
  "caps",
  "recovery",
  "recovery.*.parks_at",
  "recovery.*.handled_at",
  "decision_options",
  "views.*.cases",
  "views.*.rows.*.rule.requires",
  "views.*.rows.*.rule.admits",
  "views.*.rows.*.rule.excludes",
]);

/**
 * The document case's input, rebuilt from the example rather than copied.
 *
 * The case exists to prove the canonical bytes do not care how the document is
 * written, which an input equal to the example cannot show. So the input is
 * the example rewritten: every object's keys in reverse order, every array in
 * `SORTED_ARRAY_PATHS` written back to front, and a four-space indent.
 * `transitions`, `resume_targets` and every other order-carrying array keep
 * their written order whatever their elements hold: whether an array is a
 * set is a property of its field, read off `normalizeGraph`, not of what a
 * reversal does to the bytes.
 */
export function rewriteExampleInput(exampleText) {
  const rewrite = (node, path) => {
    if (Array.isArray(node)) {
      const items = node.map((item) => rewrite(item, `${path}.*`));
      return SORTED_ARRAY_PATHS.has(path) ? items.reverse() : items;
    }
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(
        Object.keys(node)
          .reverse()
          .map((key) => [key, rewrite(node[key], path === "" ? key : `${path}.${key}`)]),
      );
    }
    return node;
  };
  return `${JSON.stringify(rewrite(parseStrict(exampleText), ""), null, 4)}\n`;
}

/**
 * Whether this implementation reproduces the shipped reference.
 *
 * Two implementations are compared by the reference and not by the prose: a
 * fork the reference does not exercise is left to whoever writes the second
 * implementation, exactly as if the rule had never been written down.
 */
export function validateReference(reference, exampleText) {
  const errors = [];
  const decode = (encoded) => Buffer.from(encoded, "base64").toString("utf8");

  const canonicalOf = (encodedInput) => {
    const bytes = canonicalBytes(parseStrict(decode(encodedInput)));
    return { base64: bytes.toString("base64"), digest: createHash("sha256").update(bytes).digest("hex") };
  };

  // The document case proves the digest survives a rewrite, so the input has
  // to be one: an input equal to the example's own bytes reproduces everything
  // and shows nothing — which is how the rewrite was lost. The refusal names
  // the expected input, so regenerating the file is paste, not authorship.
  const expected = rewriteExampleInput(exampleText);
  if (!Buffer.from(reference.document.input_utf8_base64, "base64").equals(Buffer.from(expected, "utf8"))) {
    errors.push(
      "reference document: input is not the shipped example rewritten — " +
        `expected input_utf8_base64 ${Buffer.from(expected, "utf8").toString("base64")}`,
    );
  }
  if (!canonicalBytes(parseStrict(expected)).equals(canonicalBytes(parseStrict(exampleText)))) {
    errors.push("reference document: the rewrite does not canonicalize to the example's bytes");
  }

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
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, DOCUMENT_PATH, REFUSED_PATH, REFERENCE_PATH]) {
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

  for (const relative of [EXAMPLE_PATH, DOCUMENT_PATH, REFUSED_PATH]) {
    let document;
    try {
      document = parseStrict(files[relative]);
    } catch (error) {
      errors.push(`${relative}: ${error.message}`);
      continue;
    }
    const found = validateGraph(document, schema);
    if (relative === REFUSED_PATH) {
      if (found.length === 0) errors.push(`${relative}: accepted, and it exists to be refused`);
    } else {
      errors.push(...found.map((message) => `${relative}: ${message}`));
    }
  }

  try {
    errors.push(
      ...validateReference(parseStrict(files[REFERENCE_PATH]), files[EXAMPLE_PATH]).map(
        (message) => `${REFERENCE_PATH}: ${message}`,
      ),
    );
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
