/**
 * Tests for the Ticket execution base (issue #7 runtime).
 *
 * The defect the contract names: the DAG is a schedule, not a build of state,
 * so a dependent Ticket could start from a tree where its predecessor's work
 * does not exist. These check the composition, and the ways the same base can
 * stop meaning the same thing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  PARK_REASONS,
  baseAdmission,
  baseDigest,
  ensureComposition,
  invalidatedBy,
  overlapErrors,
  recordComposition,
  refMovementErrors,
  retryPlan,
  transitiveClosure,
} from "../src/host/execution-base.mjs";

const code = (name) => (error) => error.code === name;

const oid = (char) => char.repeat(40);

/** T1 → T2, T1 → T3, T2+T3 → T4: the diamond the contract names. */
const diamond = {
  topological_order: ["T1", "T2", "T3", "T4"],
  tickets: [
    { ticket_id: "T1", depends_on: [] },
    { ticket_id: "T2", depends_on: ["T1"] },
    { ticket_id: "T3", depends_on: ["T1"] },
    { ticket_id: "T4", depends_on: ["T2", "T3"] },
  ],
};

const linear = {
  topological_order: ["A", "B", "C"],
  tickets: [
    { ticket_id: "A", depends_on: [] },
    { ticket_id: "B", depends_on: ["A"] },
    { ticket_id: "C", depends_on: ["B"] },
  ],
};

const roots = {
  topological_order: ["R1", "R2", "R3"],
  tickets: [
    { ticket_id: "R1", depends_on: [] },
    { ticket_id: "R2", depends_on: [] },
    { ticket_id: "R3", depends_on: [] },
  ],
};

function predecessor(id, overrides = {}) {
  return {
    ticket_id: id,
    commit_oid: oid(id.toLowerCase().slice(-1)),
    delta_digest: id.repeat(16).slice(0, 64).padEnd(64, "0"),
    entries: [{ path: `src/${id}.ts`, new_blob: oid("1"), new_mode: "100644" }],
    ...overrides,
  };
}

function base(overrides = {}) {
  const value = {
    schema_version: 1,
    ticket_id: "T4",
    planning_head: oid("p"),
    composition_order: ["T1", "T2", "T3"],
    predecessors: [predecessor("T1"), predecessor("T2"), predecessor("T3")],
    composition_commit_oid: oid("c"),
    tree_oid: oid("t"),
    dag_digest: "dag-1",
    anchor_version: 3,
    ...overrides,
  };
  value.digest = overrides.digest ?? baseDigest(value);
  return value;
}

function states(overrides = {}) {
  return {
    T1: { commit_oid: oid("a"), delta_digest: "d1", pass: "valid" },
    T2: { commit_oid: oid("b"), delta_digest: "d2", pass: "valid" },
    T3: { commit_oid: oid("c"), delta_digest: "d3", pass: "valid" },
    ...overrides,
  };
}

const objects = new Set([oid("c"), oid("t")]);

test("no dependencies means the base is planning_head", () => {
  assert.deepEqual(transitiveClosure(roots, "R2"), []);
  const root = base({ ticket_id: "R2", composition_order: [], predecessors: [], composition_commit_oid: undefined });
  assert.deepEqual(baseAdmission(root, { predecessorStates: {}, objects }), []);
});

test("a linear DAG composes in order", () => {
  assert.deepEqual(transitiveClosure(linear, "C"), ["A", "B"]);
  assert.deepEqual(transitiveClosure(linear, "A"), []);
});

test("a diamond DAG yields the manifest's order, not a discovered one", () => {
  // Recorded rather than recomputed, because a diamond applied in two orders
  // can produce two trees, and then "the same base" would mean two things.
  assert.deepEqual(transitiveClosure(diamond, "T4"), ["T1", "T2", "T3"]);
  assert.deepEqual(transitiveClosure(diamond, "T2"), ["T1"]);
});

test("the digest keeps the order, unlike the set-valued fields elsewhere", () => {
  // Two bases built from the same predecessors in different orders are
  // different bases, and a digest that hid that would claim a determinism the
  // composition does not have.
  const forward = base();
  const swapped = base({ composition_order: ["T1", "T3", "T2"] });
  assert.notEqual(baseDigest(swapped), forward.digest);
  // ...and it covers the tree, so the same inputs producing a different tree is
  // a different base.
  assert.notEqual(baseDigest({ ...forward, tree_oid: oid("9") }), forward.digest);
});

test("a base whose digest does not recompute is refused", () => {
  const errors = baseAdmission(base({ digest: "0".repeat(64) }), { predecessorStates: states(), objects });
  assert.ok(errors.some((error) => error.reason === "base_mismatch"));
});

test("a missing predecessor binding stops the base before any worktree exists", () => {
  const missing = baseAdmission(base(), { predecessorStates: states({ T2: undefined }), objects });
  assert.ok(missing.some((error) => error.reason === "missing_predecessor_binding"));
  const unbound = baseAdmission(base(), {
    predecessorStates: states({ T2: { pass: "valid" } }),
    objects,
  });
  assert.ok(unbound.some((error) => /no commit or delta binding/u.test(error.detail)));
});

test("a stale predecessor PASS is a PASS about a tree that no longer exists", () => {
  const errors = baseAdmission(base(), {
    predecessorStates: states({ T3: { commit_oid: oid("c"), delta_digest: "d3", pass: "stale" } }),
    objects,
  });
  assert.ok(errors.some((error) => error.reason === "stale_predecessor_pass"));
});

test("overlapping compatible deltas compose, and incompatible ones do not", () => {
  // Two Tickets that made the same change compose; a semantic conflict is a
  // decision, and a model choosing one side is a decision made by something
  // that was not asked to make it.
  const same = [
    predecessor("T1", { entries: [{ path: "src/shared.ts", new_blob: oid("1"), new_mode: "100644" }] }),
    predecessor("T2", { entries: [{ path: "src/shared.ts", new_blob: oid("1"), new_mode: "100644" }] }),
  ];
  assert.deepEqual(overlapErrors(same), []);
  const different = [
    predecessor("T1", { entries: [{ path: "src/shared.ts", new_blob: oid("1"), new_mode: "100644" }] }),
    predecessor("T2", { entries: [{ path: "src/shared.ts", new_blob: oid("2"), new_mode: "100644" }] }),
  ];
  assert.ok(overlapErrors(different).some((error) => error.reason === "incompatible_overlapping_deltas"));
  // A mode that differs is the same conflict with no textual difference to see.
  const mode = [
    predecessor("T1", { entries: [{ path: "src/shared.ts", new_blob: oid("1"), new_mode: "100644" }] }),
    predecessor("T2", { entries: [{ path: "src/shared.ts", new_blob: oid("1"), new_mode: "100755" }] }),
  ];
  assert.ok(mode.length === 2 && overlapErrors(mode).length === 1);
});

test("a predecessor that changed voids every descendant base, transitively", () => {
  // A base is not "probably still fine" because the change looked small.
  assert.deepEqual(invalidatedBy(diamond, "T1"), ["T2", "T3", "T4"]);
  assert.deepEqual(invalidatedBy(diamond, "T2"), ["T4"]);
  assert.deepEqual(invalidatedBy(diamond, "T4"), []);
  assert.deepEqual(invalidatedBy(linear, "A"), ["B", "C"]);
});

test("a moved DAG or anchor is refused rather than absorbed", () => {
  const dag = baseAdmission(base(), { predecessorStates: states(), objects, dagDigest: "dag-2" });
  assert.ok(dag.some((error) => error.reason === "dag_changed"));
  const anchor = baseAdmission(base(), { predecessorStates: states(), objects, anchorVersion: 4 });
  assert.ok(anchor.some((error) => error.reason === "anchor_changed"));
});

test("a composition object that is not reachable is refused", () => {
  const errors = baseAdmission(base(), { predecessorStates: states(), objects: new Set([oid("t")]) });
  assert.ok(errors.some((error) => error.reason === "unreachable_composition_object"));
  const noTree = baseAdmission(base(), { predecessorStates: states(), objects: new Set([oid("c")]) });
  assert.ok(noTree.some((error) => error.reason === "unreachable_composition_object"));
});

test("a crash after the commit object exists does not produce a second base", () => {
  // The next attempt recomputes the same identity, finds the object, and
  // records it.
  const value = base();
  assert.deepEqual(ensureComposition(value, { objects, recordedMetadata: undefined }), {
    action: "record_existing_object",
    digest: value.digest,
  });
  assert.equal(
    ensureComposition(value, { objects, recordedMetadata: { digest: value.digest } }).action,
    "already_recorded",
  );
  assert.equal(
    ensureComposition(value, { objects: new Set([oid("t")]), recordedMetadata: undefined }).action,
    "create",
  );
  assert.throws(
    () => ensureComposition({ ...value, digest: "0".repeat(64) }, { objects }),
    code("base_mismatch"),
  );
});

test("a builder that failed and one that built another tree are different facts", () => {
  // The second is the one that would otherwise be recorded as a success under
  // an identity it does not have.
  const value = base();
  assert.deepEqual(recordComposition(value, { ok: true, commit_oid: oid("c"), tree_oid: oid("t") }), {
    ticket_id: "T4",
    digest: value.digest,
    composition_commit_oid: oid("c"),
    tree_oid: oid("t"),
  });
  assert.throws(
    () => recordComposition(value, { ok: false, detail: "the merge produced conflicts" }),
    code("composition_failed"),
  );
  assert.throws(
    () => recordComposition(value, { ok: true, commit_oid: oid("c"), tree_oid: oid("9") }),
    code("base_mismatch"),
  );
});

test("a retry reuses the base, or voids the candidate, and never rebuilds silently", () => {
  const value = base();
  assert.equal(retryPlan(value, { dagDigest: "dag-1", anchorVersion: 3 }).action, "reuse_base");
  assert.equal(retryPlan(value, { dagDigest: "dag-2", anchorVersion: 3 }).reason, "dag_changed");
  assert.equal(retryPlan(value, { dagDigest: "dag-1", anchorVersion: 4 }).reason, "anchor_changed");
  assert.equal(retryPlan(value, { dagDigest: "dag-2", anchorVersion: 4 }).action, "void_candidate");
});

test("foreign movement of the private ref is classified, not raced", () => {
  assert.deepEqual(refMovementErrors(oid("a"), oid("a")), []);
  assert.deepEqual(refMovementErrors(oid("f"), oid("a")), [
    { reason: "foreign_ref_movement", detail: oid("f") },
  ]);
});

test("a dependency that is not in the manifest is a DAG change, not a missing file", () => {
  const broken = {
    topological_order: ["X"],
    tickets: [{ ticket_id: "X", depends_on: ["Y"] }],
  };
  assert.throws(() => transitiveClosure(broken, "X"), code("dag_changed"));
  assert.throws(() => transitiveClosure(diamond, "T9"), code("dag_changed"));
});

test("every park reason the contract closes can be produced", () => {
  const produced = new Set();
  const collect = (errors) => {
    for (const error of errors) produced.add(error.reason);
  };
  collect(baseAdmission(base(), { predecessorStates: states({ T2: undefined }), objects }));
  collect(baseAdmission(base(), {
    predecessorStates: states({ T3: { commit_oid: oid("c"), delta_digest: "d", pass: "stale" } }),
    objects,
  }));
  collect(overlapErrors([
    predecessor("T1", { entries: [{ path: "p", new_blob: oid("1"), new_mode: "100644" }] }),
    predecessor("T2", { entries: [{ path: "p", new_blob: oid("2"), new_mode: "100644" }] }),
  ]));
  collect(baseAdmission(base({ digest: "0".repeat(64) }), { predecessorStates: states(), objects }));
  collect(baseAdmission(base(), { predecessorStates: states(), objects, dagDigest: "dag-2" }));
  collect(baseAdmission(base(), { predecessorStates: states(), objects, anchorVersion: 9 }));
  collect(baseAdmission(base(), { predecessorStates: states(), objects: new Set() }));
  collect(refMovementErrors(oid("f"), oid("a")));
  try {
    recordComposition(base(), { ok: false, detail: "the merge produced conflicts" });
  } catch (error) {
    produced.add(error.code);
  }
  for (const reason of PARK_REASONS) {
    assert.ok(produced.has(reason), `${reason} is documented and never produced`);
  }
});
