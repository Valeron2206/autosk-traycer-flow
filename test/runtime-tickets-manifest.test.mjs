/**
 * Tests for the Tickets manifest runtime (issue #6).
 *
 * Three narrow things, each narrow for a reason: the selector dialect, because
 * a pattern is a selector whose scope depends on what happens to be on disk;
 * the topological order, because "a valid order" is not an order; and the
 * overlap rule, because two Tickets that can address the same path and cannot
 * be ordered will race.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEPENDENCY_RATIONALES,
  ERROR_CODES,
  collisionKey,
  comparable,
  dispatchAdmission,
  graphErrors,
  kahnOrder,
  manifestDigest,
  overlapErrors,
  selectorAddresses,
  selectorPathErrors,
  selectorSetErrors,
  selectorsOverlap,
  validateManifest,
  assertDispatchable,
} from "../src/host/tickets-manifest.mjs";

const code = (name) => (error) => error.code === name;

function ticket(id, { depends_on = [], scope = [] } = {}) {
  return {
    ticket_id: id,
    depends_on,
    dependency_rationales: depends_on.map((parent) => ({ depends_on: parent, kind: "semantic" })),
    scope,
  };
}

function manifest(tickets) {
  return { tickets, topological_order: kahnOrder(tickets) };
}

const file = (path) => ({ kind: "file", path });
const dir = (path) => ({ kind: "directory", path });

test("the dialect accepts a literal file and a directory prefix", () => {
  assert.deepEqual(selectorPathErrors("src/session/store.ts"), []);
  assert.deepEqual(selectorSetErrors([dir("src/session"), file("src/session/store.ts")]), []);
});

test("everything the dialect rejects means something different somewhere else", () => {
  const cases = [
    ["", "empty path"],
    ["/etc/passwd", "absolute path"],
    ["C:/src/a.ts", "drive or UNC prefix"],
    ["src\\a.ts", "backslash separator"],
    ["src//a.ts", "repeated separator"],
    ["src/../etc/a.ts", "dot segment"],
    ["./a.ts", "dot segment"],
    [":(exclude)src", "leading colon"],
    ["src/*.ts", "glob byte *"],
    ["src/a?.ts", "glob byte ?"],
    ["src/[ab].ts", "glob byte ["],
  ];
  for (const [path, detail] of cases) {
    const errors = selectorPathErrors(path);
    assert.ok(
      errors.some((error) => error.code === "tickets_selector_invalid" && error.detail === detail),
      `${path}: expected ${detail}, got ${JSON.stringify(errors)}`,
    );
  }
  assert.ok(selectorPathErrors("src/\0a.ts").some((error) => error.detail === "NUL byte"));
});

test("a non-NFC path is rejected, because two spellings would be two selectors", () => {
  const decomposed = "src/cafe\u0301.ts";
  assert.notEqual(decomposed, decomposed.normalize("NFC"));
  assert.ok(selectorPathErrors(decomposed).some((error) => error.detail === "not NFC"));
});

test("selectors are sorted and unique, so two manifests with the same scope compare equal", () => {
  assert.ok(
    selectorSetErrors([file("src/b.ts"), file("src/a.ts")]).some((error) => error.code === "tickets_selector_unsorted"),
  );
  assert.ok(
    selectorSetErrors([file("src/a.ts"), file("src/a.ts")]).some((error) => error.code === "tickets_selector_unsorted"),
  );
  assert.ok(selectorSetErrors([{ kind: "glob", path: "src/a.ts" }]).some((error) => /unknown kind/u.test(error.detail)));
});

test("a directory includes descendants on segment boundaries, and not by prefix", () => {
  assert.equal(selectorAddresses(dir("src/session"), "src/session/store.ts"), true);
  assert.equal(selectorAddresses(dir("src/session"), "src/session"), true);
  // The case that a naive prefix check gets wrong.
  assert.equal(selectorAddresses(dir("src/session"), "src/session-store/a.ts"), false);
  assert.equal(selectorAddresses(file("src/a.ts"), "src/a.ts"), true);
  assert.equal(selectorAddresses(file("src/a.ts"), "src/a.ts.bak"), false);
});

test("the collision key is conservative, because a case-insensitive filesystem is not", () => {
  // Two paths whose bytes differ only by case are one file there, and a
  // manifest that assumed otherwise would schedule two Tickets onto it.
  assert.equal(collisionKey("src/Store.ts"), collisionKey("src/store.ts"));
  assert.equal(selectorsOverlap(file("src/Store.ts"), file("src/store.ts")), true);
  assert.equal(selectorsOverlap(dir("src/Session"), file("src/session/store.ts")), true);
  assert.equal(selectorsOverlap(dir("src/a"), dir("src/a/b")), true);
  assert.equal(selectorsOverlap(dir("src/a"), dir("src/b")), false);
  assert.equal(selectorsOverlap(file("src/a.ts"), dir("src/b")), false);

  // Each branch of the overlap rule, asked where the branches differ. Predicate
  // mutation found the kind comparisons and the prefix alternatives untested:
  // `===` could have been `!==` and the `||` chain could have been an `&&`,
  // with every case above still passing.
  assert.equal(selectorsOverlap(file("src/a.ts"), file("src/b.ts")), false);
  assert.equal(selectorsOverlap(dir("src/a"), dir("src/a")), true);
  assert.equal(selectorsOverlap(dir("src/a/b"), dir("src/a")), true);
  // A shared textual prefix that is not a path boundary is not an overlap:
  // `src/ab` is not inside `src/a`, and a `startsWith` without the separator
  // would say it is.
  assert.equal(selectorsOverlap(dir("src/a"), dir("src/ab")), false);
  assert.equal(selectorsOverlap(dir("src/a"), file("src/ab.ts")), false);
  // A file exactly at the directory, and a file below it.
  assert.equal(selectorsOverlap(dir("src/a"), file("src/a")), true);
  assert.equal(selectorsOverlap(file("src/a/b.ts"), dir("src/a")), true);
  // A file whose path is a prefix of a directory does not overlap it: nothing
  // is inside a file. Reading the rule as "either side is a directory" would
  // make this true, which is why the two kinds are asked together and not
  // separately.
  assert.equal(selectorsOverlap(file("src/a"), dir("src/a/b")), false);
});

test("the digest of a manifest does not depend on the order its tickets were written", () => {
  // The projection sorts by id, and the comparator's ties are unreachable while
  // duplicate ids are refused — so the property that matters is the one tested:
  // the same set in another order is the same digest.
  const one = manifest([ticket("T1"), ticket("T2"), ticket("T3")]);
  const other = manifest([ticket("T3"), ticket("T1"), ticket("T2")]);
  assert.equal(manifestDigest(one), manifestDigest(other));
  const different = manifest([ticket("T1"), ticket("T2")]);
  assert.notEqual(manifestDigest(one), manifestDigest(different));
});

test("overlapping Tickets must be ordered in one direction", () => {
  // Two Tickets that can address the same path and cannot be ordered will race.
  const racing = manifest([
    ticket("T1", { scope: [file("src/a.ts")] }),
    ticket("T2", { scope: [file("src/a.ts")] }),
  ]);
  assert.ok(overlapErrors(racing).some((error) => error.code === "tickets_scope_overlap_unordered"));

  const ordered = manifest([
    ticket("T1", { scope: [file("src/a.ts")] }),
    ticket("T2", { depends_on: ["T1"], scope: [file("src/a.ts")] }),
  ]);
  assert.deepEqual(overlapErrors(ordered), []);

  // Transitively ordered counts: the constraint is that they cannot run at the
  // same time, not that the edge is direct.
  const transitive = manifest([
    ticket("T1", { scope: [file("src/a.ts")] }),
    ticket("T2", { depends_on: ["T1"] }),
    ticket("T3", { depends_on: ["T2"], scope: [dir("src")] }),
  ]);
  assert.deepEqual(overlapErrors(transitive), []);
  assert.equal(comparable(transitive, "T1", "T3"), true);
  assert.equal(comparable(racing, "T1", "T2"), false);
});

test("the topological order is Kahn with ASCII tie-breaking, not any valid order", () => {
  // Two runs that scheduled differently would build the same Epic two ways.
  const tickets = [
    ticket("T3"),
    ticket("T1"),
    ticket("T2", { depends_on: ["T1"] }),
  ];
  // T1 and T3 are ready first; T1 wins the tie, and T2 becomes ready before T3
  // is taken, so it is re-sorted in — the tie-break is among nodes that are
  // ready now, not among the ones that were ready at the start.
  assert.deepEqual(kahnOrder(tickets), ["T1", "T2", "T3"]);
  // "T1, T3, T2" is a perfectly valid topological order, and it is refused:
  // a valid order is not the order.
  const wrong = { tickets, topological_order: ["T1", "T3", "T2"] };
  assert.ok(graphErrors(wrong).some((error) => error.code === "tickets_topological_order_invalid"));
});

test("a cycle does not order, and says so", () => {
  const cyclic = {
    tickets: [ticket("A", { depends_on: ["B"] }), ticket("B", { depends_on: ["A"] })],
    topological_order: [],
  };
  assert.ok(graphErrors(cyclic).some((error) => error.code === "tickets_dependency_cyclic"));
});

test("a dangling, self or unexplained dependency is refused", () => {
  const dangling = manifest([ticket("A", { depends_on: ["Z"] })]);
  assert.ok(graphErrors(dangling).some((error) => error.code === "tickets_dependency_dangling"));

  const self = manifest([ticket("A", { depends_on: ["A"] })]);
  assert.ok(graphErrors(self).some((error) => error.code === "tickets_dependency_self"));

  // An edge with no stated reason is a schedule constraint nobody can review.
  const unexplained = {
    tickets: [ticket("A"), { ...ticket("B", { depends_on: ["A"] }), dependency_rationales: [] }],
    topological_order: ["A", "B"],
  };
  assert.ok(graphErrors(unexplained).some((error) => error.code === "tickets_dependency_rationale_missing"));

  const wrongKind = {
    tickets: [
      ticket("A"),
      { ...ticket("B", { depends_on: ["A"] }), dependency_rationales: [{ depends_on: "A", kind: "because" }] },
    ],
    topological_order: ["A", "B"],
  };
  assert.ok(graphErrors(wrongKind).some((error) => error.code === "tickets_dependency_rationale_missing"));
  assert.deepEqual(DEPENDENCY_RATIONALES.slice(), ["semantic", "scope_serialization"]);
});

test("a duplicated Ticket id is refused", () => {
  const duplicated = { tickets: [ticket("A"), ticket("A")], topological_order: ["A", "A"] };
  assert.ok(graphErrors(duplicated).some((error) => error.code === "tickets_duplicate_id"));
});

test("the digest is over content, not over writing order", () => {
  const a = manifest([ticket("T1", { scope: [file("src/a.ts")] }), ticket("T2", { depends_on: ["T1"] })]);
  const reordered = {
    tickets: [
      { ...a.tickets[1], depends_on: ["T1"] },
      a.tickets[0],
    ],
    topological_order: a.topological_order,
  };
  assert.equal(manifestDigest(reordered), manifestDigest(a));
  const changed = manifest([ticket("T1", { scope: [file("src/b.ts")] }), ticket("T2", { depends_on: ["T1"] })]);
  assert.notEqual(manifestDigest(changed), manifestDigest(a));
});

test("the dispatcher compares the graph before it creates anything", () => {
  const value = manifest([ticket("T1"), ticket("T2", { depends_on: ["T1"] })]);
  const digest = manifestDigest(value);
  const good = dispatchAdmission(value, { children: ["T1", "T2"], edges: ["T1->T2"] }, digest);
  assert.equal(good.admitted, true);
  assert.deepEqual(good.creates.slice(), ["T1", "T2"]);

  // Zero side effects on refusal: a partially built graph is worse than none.
  const wrongChildren = dispatchAdmission(value, { children: ["T1"], edges: ["T1->T2"] }, digest);
  assert.equal(wrongChildren.admitted, false);
  assert.deepEqual(wrongChildren.creates.slice(), []);
  assert.ok(wrongChildren.errors.some((error) => error.code === "tickets_graph_mismatch"));

  const wrongEdges = dispatchAdmission(value, { children: ["T1", "T2"], edges: [] }, digest);
  assert.ok(wrongEdges.errors.some((error) => /edge set/u.test(error.detail)));

  const wrongDigest = dispatchAdmission(value, { children: ["T1", "T2"], edges: ["T1->T2"] }, "0".repeat(64));
  assert.ok(wrongDigest.errors.some((error) => /manifest digest/u.test(error.detail)));
});

test("a manifest that does not validate is not dispatched", () => {
  const racing = manifest([
    ticket("T1", { scope: [file("src/a.ts")] }),
    ticket("T2", { scope: [file("src/a.ts")] }),
  ]);
  assert.throws(
    () => assertDispatchable(racing, { children: ["T1", "T2"], edges: [] }, manifestDigest(racing)),
    code("tickets_scope_overlap_unordered"),
  );
  const good = manifest([ticket("T1"), ticket("T2", { depends_on: ["T1"] })]);
  assert.doesNotThrow(() =>
    assertDispatchable(good, { children: ["T1", "T2"], edges: ["T1->T2"] }, manifestDigest(good)),
  );
});

test("validateManifest reports selector problems against the Ticket that has them", () => {
  const bad = manifest([ticket("T1", { scope: [file("/absolute.ts")] })]);
  const errors = validateManifest(bad);
  assert.ok(errors.some((error) => error.code === "tickets_selector_invalid" && error.detail.startsWith("T1:")));
});

test("every error code this module declares can be produced", () => {
  const produced = new Set();
  const collect = (errors) => {
    for (const error of errors) produced.add(error.code);
  };
  collect(selectorPathErrors("/x"));
  collect(selectorSetErrors([file("b"), file("a")]));
  collect(overlapErrors(manifest([
    ticket("T1", { scope: [file("src/a.ts")] }),
    ticket("T2", { scope: [file("src/a.ts")] }),
  ])));
  collect(graphErrors(manifest([ticket("A", { depends_on: ["Z"] })])));
  collect(graphErrors(manifest([ticket("A", { depends_on: ["A"] })])));
  collect(graphErrors({
    tickets: [ticket("A", { depends_on: ["B"] }), ticket("B", { depends_on: ["A"] })],
    topological_order: [],
  }));
  collect(graphErrors({
    tickets: [ticket("A"), { ...ticket("B", { depends_on: ["A"] }), dependency_rationales: [] }],
    topological_order: ["A", "B"],
  }));
  collect(graphErrors({ tickets: [ticket("A"), ticket("B")], topological_order: ["B", "A"] }));
  collect(graphErrors({ tickets: [ticket("A"), ticket("A")], topological_order: ["A", "A"] }));
  collect(dispatchAdmission(manifest([ticket("A")]), { children: [], edges: [] }, "0".repeat(64)).errors);
  for (const errorCode of ERROR_CODES) {
    assert.ok(produced.has(errorCode), `${errorCode} is declared and never produced`);
  }
});
