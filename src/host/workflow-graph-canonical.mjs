/**
 * The canonical form of a graph document, and the digest taken over it.
 *
 * Slice 1 pinned what canonical means so that two implementers reading the same
 * document arrive at the same `workflow_graph_digest`. This lived inside
 * `scripts/validate-workflow-graph.mjs` while the only reader was that
 * validator. Slice 5 gave it a second reader — the factory has to compute a
 * document's digest rather than believe the one the document carries — and a
 * second implementation of "canonical" is exactly the failure slice 1 exists to
 * prevent. So it lives here, and the validator re-exports it.
 *
 * `normalizeGraph` decides which arrays are sets and which carry order;
 * `canonicalText` fixes the spelling of every value; `canonicalBytes` is what
 * the digest is taken over, and it excludes the document's own digest field.
 */

import { createHash } from "node:crypto";

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
