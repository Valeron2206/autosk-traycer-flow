/**
 * Tests for the canonical form, in the file the mutation gate pairs with it.
 *
 * This code was `scripts/validate-workflow-graph.mjs`'s while that validator was
 * its only reader, and `test/validate-workflow-graph.test.mjs` exercises it
 * through the validator's surface — a document accepted or refused. Slice 5 gave
 * it a second reader and moved it into `src/host`, which puts it under the
 * mutation gate for the first time. That gate pairs `src/host/<name>.mjs` with
 * `test/runtime-<name>.test.mjs` and silently covers nothing when the pairing
 * file is missing, so the module needs its own, exercising the functions
 * directly rather than through a validator's verdict.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  byKeyComparator,
  canonicalBytes,
  canonicalText,
  graphDigest,
  normalizeGraph,
} from "../src/host/workflow-graph-canonical.mjs";

// --- what a value is allowed to look like ------------------------------------

test("an integer has one spelling and everything else has none", () => {
  assert.equal(canonicalText(1), "1");
  assert.equal(canonicalText(-1), "-1");
  assert.equal(canonicalText(0), "0");
  for (const refused of [1.5, -0, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity]) {
    assert.throws(() => canonicalText(refused), /graph_number_not_canonical/u, String(refused));
  }
  // `1`, `1.0` and `1e0` are one value and converge; the refusal is about the
  // value, not the way it was typed.
  assert.equal(canonicalText(1.0), canonicalText(1e0));
});

test("only what JSON requires is escaped, and a control character is", () => {
  assert.equal(canonicalText("plain"), '"plain"');
  assert.equal(canonicalText('a"b'), '"a\\"b"');
  assert.equal(canonicalText("a\\b"), '"a\\\\b"');
  assert.equal(canonicalText("a\nb"), '"a\\nb"');
  assert.equal(canonicalText("a\tb"), '"a\\tb"');
  assert.equal(canonicalText("ab"), '"a\\u0001b"');
  assert.equal(canonicalText("a\u001fb"), '"a\\u001fb"', "the last control character still is one");
  // And the first character that is not: a space is escaped by no rule, so
  // the boundary sits where it says rather than one past it.
  assert.equal(canonicalText("a b"), '"a b"');
  // A character that needs no escape keeps its literal spelling, so one string
  // has one canonical form rather than two that both parse back to it.
  assert.equal(canonicalText("é☃"), '"é☃"');
});

test("a surrogate pair survives and a lone surrogate has no spelling", () => {
  assert.equal(canonicalText("\u{1f600}"), '"\u{1f600}"');
  assert.throws(() => canonicalText("\ud800"), /graph_lone_surrogate/u);
  assert.throws(() => canonicalText("\udc00"), /graph_lone_surrogate/u);
  assert.throws(() => canonicalText("a\ud800b"), /graph_lone_surrogate/u);
  // The pair is what makes the refusal about being unpaired rather than about
  // the range: the same high surrogate followed by its low one is accepted.
  assert.equal(canonicalText("😀"), '"\u{1f600}"');
});

test("every edge of the surrogate ranges is where it says it is", () => {
  // Four comparisons decide which code unit is a high surrogate, which is a low
  // one, and which is neither. Off by one at any of them and either a real pair
  // is refused or a lone surrogate is written into the bytes, so each boundary
  // is checked at the value itself rather than somewhere inside the range.
  assert.equal(canonicalText("\u{10000}"), '"\u{10000}"', "D800 DC00: the first unit of each range");
  assert.equal(canonicalText("\u{10ffff}"), '"\u{10ffff}"', "DBFF DFFF: the last unit of each");
  assert.equal(canonicalText("\ud7ff"), '"\ud7ff"', "one below the high range is an ordinary character");
  assert.equal(canonicalText("\ue000"), '"\ue000"', "and one above the low range is too");
  assert.throws(() => canonicalText("\udbff"), /graph_lone_surrogate/u, "the last high surrogate, unpaired");
  assert.throws(() => canonicalText("\udfff"), /graph_lone_surrogate/u, "the last low surrogate, alone");
  assert.throws(() => canonicalText("\ud800\ud800"), /graph_lone_surrogate/u, "a high surrogate is not a low one");
  assert.throws(() => canonicalText("\ud800\ue000"), /graph_lone_surrogate/u, "and neither is what follows the range");
});

test("the other kinds have their one spelling too", () => {
  assert.equal(canonicalText(null), "null");
  assert.equal(canonicalText(true), "true");
  assert.equal(canonicalText(false), "false");
  assert.equal(canonicalText([1, "a", null]), '[1,"a",null]');
  assert.throws(() => canonicalText(undefined), /graph_number_not_canonical/u);
});

test("object keys are ordered by their code units, not by insertion", () => {
  assert.equal(canonicalText({ b: 1, a: 2 }), canonicalText({ a: 2, b: 1 }));
  assert.equal(canonicalText({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

// --- which arrays are sets and which carry order -----------------------------

const graph = () => ({
  workflow: "w",
  first_step: "a",
  canonical_digest: "0".repeat(64),
  predicates: [
    { id: "p2", reads: ["b", "a"], description: "second" },
    { id: "p1", reads: ["a"], description: "first" },
  ],
  steps: [
    { name: "b", kind: "status", status: "done" },
    { name: "a", kind: "agent", no_transition_reason: "r", hooks: ["onRun"] },
  ],
  guards: [
    { id: "g2", predicate: "p2", authority: { actor: "policy", policy_rules: ["r2", "r1"] }, park_reason: "r" },
    { id: "g1", predicate: "p1", authority: { actor: "agent" }, park_reason: "r" },
  ],
  transitions: [
    { id: "t2", from: "a", to: "b", priority: 1, guards: ["g2", "g1"] },
    { id: "t1", from: "a", to: "b", priority: 0, guards: ["g1"] },
  ],
  caps: [{ cycle: "c2", counted_transition: "t2", limit: 1, park_reason: "r" }],
  recovery: [{ reason: "r", parks_at: ["b", "a"], handled_at: ["b", "a"], resume_targets: ["b", "a"], required_state: "n/a" }],
});

test("a set reshuffled is the same document and an order-carrying array is not", () => {
  const written = graph();
  const shuffled = graph();
  shuffled.predicates.reverse();
  shuffled.steps.reverse();
  shuffled.guards.reverse();
  shuffled.caps = [...shuffled.caps];
  shuffled.recovery[0].handled_at.reverse();
  assert.equal(graphDigest(shuffled), graphDigest(written), "sets are sets however they were typed");

  // `transitions` and `resume_targets` are declared order-carrying by the plan,
  // so reordering them is a different graph and must move the digest.
  const reordered = graph();
  reordered.transitions.reverse();
  assert.notEqual(graphDigest(reordered), graphDigest(written));
  const resumeReordered = graph();
  resumeReordered.recovery[0].resume_targets.reverse();
  assert.notEqual(graphDigest(resumeReordered), graphDigest(written));
});

test("the members a set holds are sorted too", () => {
  const normalized = normalizeGraph(graph());
  assert.deepEqual(normalized.predicates.map((entry) => entry.id), ["p1", "p2"]);
  assert.deepEqual(normalized.predicates[1].reads, ["a", "b"]);
  assert.deepEqual(normalized.steps.map((entry) => entry.name), ["a", "b"]);
  assert.deepEqual(normalized.guards.map((entry) => entry.id), ["g1", "g2"]);
  assert.deepEqual(normalized.guards[1].authority.policy_rules, ["r1", "r2"]);
  assert.deepEqual(normalized.transitions[0].guards, ["g1", "g2"], "an edge's guards are a set");
  assert.deepEqual(normalized.transitions.map((entry) => entry.id), ["t2", "t1"], "the edges themselves are not");
  assert.deepEqual(normalized.recovery[0].parks_at, ["a", "b"]);
  // `handled_at` is a set for the same reason `parks_at` is, and it says so here
  // rather than only in the contract: a field that reaches the digest unsorted
  // makes the order somebody typed it in part of the graph's identity.
  assert.deepEqual(normalized.recovery[0].handled_at, ["a", "b"]);
  assert.deepEqual(normalized.recovery[0].resume_targets, ["b", "a"], "and neither are resume targets");
});

test("a view's cases and a row's rule are sets; the rows themselves are not", () => {
  const written = graph();
  written.decision_options = ["b_opt", "a_opt"];
  written.views = [{
    id: "v",
    cases: ["b_case", "a_case"],
    rows: [
      { covers: ["r"], binds: "b1", cells: ["x"],
        rule: { requires: ["b", "a"], admits: ["d", "c"], excludes: ["f", "e"] } },
      { covers: ["r"], binds: "b2", cells: ["y"] },
    ],
  }];
  const normalized = normalizeGraph(written);
  assert.deepEqual(normalized.decision_options, ["a_opt", "b_opt"]);
  assert.deepEqual(normalized.views[0].cases, ["a_case", "b_case"]);
  assert.deepEqual(normalized.views[0].rows[0].rule.requires, ["a", "b"]);
  assert.deepEqual(normalized.views[0].rows[0].rule.admits, ["c", "d"]);
  assert.deepEqual(normalized.views[0].rows[0].rule.excludes, ["e", "f"]);
  // A row with no rule passes through untouched, and the order of the rows is
  // the table's: `rows` is order-carrying even where its members hold sets.
  assert.equal(normalized.views[0].rows[1].rule, undefined);
  assert.deepEqual(normalized.views[0].rows.map((row) => row.cells[0]), ["x", "y"]);
  // And a reshuffled annotation is the same document under the digest.
  const shuffled = graph();
  shuffled.decision_options = ["a_opt", "b_opt"];
  shuffled.views = [{
    id: "v",
    cases: ["a_case", "b_case"],
    rows: [
      { covers: ["r"], binds: "b1", cells: ["x"],
        rule: { requires: ["a", "b"], admits: ["c", "d"], excludes: ["e", "f"] } },
      { covers: ["r"], binds: "b2", cells: ["y"] },
    ],
  }];
  assert.equal(graphDigest(shuffled), graphDigest(written));
});

test("a step with no hooks and a guard with no policy rules pass through", () => {
  // The two conditional branches in `normalizeGraph`: both shapes are legal and
  // the one without the optional member must not acquire one.
  const normalized = normalizeGraph(graph());
  assert.equal(normalized.steps[1].hooks, undefined, "the status step declares none");
  assert.deepEqual(normalized.steps[0].hooks, ["onRun"]);
  assert.equal(normalized.guards[0].authority.policy_rules, undefined);
});

test("the set ordering is a comparator contract, not a property of one engine's sort", () => {
  // Equal keys must answer 0: a comparator that returns 1 for a tie is
  // observably wrong to anything that calls it, whatever a given sort does
  // with the answer. Smaller gives -1, larger gives 1.
  const byId = byKeyComparator("id");
  assert.equal(byId({ id: "a" }, { id: "b" }), -1);
  assert.equal(byId({ id: "b" }, { id: "a" }), 1);
  assert.equal(byId({ id: "a" }, { id: "a" }), 0);
});

test("two members a document should not have keep the order it wrote them in", () => {
  // A valid document has distinct keys, so the comparator's two branches are
  // only distinguishable on one that does not. `normalizeGraph` runs before any
  // schema sees the object — the factory hands it whatever it was called with —
  // so what it does with a duplicate is observable and must not be arbitrary.
  const written = { steps: [{ name: "a", mark: 1 }, { name: "a", mark: 2 }] };
  assert.deepEqual(normalizeGraph(written).steps.map((entry) => entry.mark), [1, 2]);
});

test("a document with none of the arrays is normalized rather than refused", () => {
  // Every branch is guarded by `Array.isArray`, so a partial object — which is
  // what a malformed document looks like before the schema sees it — must come
  // back rather than throw on a missing member.
  assert.deepEqual(normalizeGraph({ workflow: "w" }), { workflow: "w" });
});

// --- the bytes the digest is taken over --------------------------------------

test("the canonical bytes are UTF-8, carry no BOM, and exclude the document's own digest", () => {
  const bytes = canonicalBytes(graph());
  assert.ok(Buffer.isBuffer(bytes));
  assert.notEqual(bytes[0], 0xef, "a BOM would make one document two");
  assert.ok(!bytes.toString("utf8").includes("canonical_digest"));

  const { canonical_digest, ...body } = graph();
  assert.equal(bytes.toString("utf8"), canonicalText(normalizeGraph(body)));
});

test("the digest is the sha256 of exactly those bytes, and ignores the recorded one", () => {
  const written = graph();
  assert.equal(graphDigest(written), createHash("sha256").update(canonicalBytes(written)).digest("hex"));

  const relabelled = graph();
  relabelled.canonical_digest = "f".repeat(64);
  assert.equal(graphDigest(relabelled), graphDigest(written), "what a document claims is not what it is");

  const changed = graph();
  changed.caps[0].limit = 2;
  assert.notEqual(graphDigest(changed), graphDigest(written));
});
