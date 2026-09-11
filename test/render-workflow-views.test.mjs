/**
 * Tests for the workflow graph's rendered views.
 *
 * The failure this closes is that the resume contract was written three times —
 * as the graph's `recovery`, as the park table in the technical plan, and as the
 * resume table in core flows — and three hand-kept copies drift. Each case below
 * is a way that drift could survive: a table edited where it is rendered, a
 * document edited without re-rendering, a reason that quietly leaves one side.
 *
 * The two directions are separate tests on purpose. A check that only compares
 * text would pass a document and a table that agree with each other and disagree
 * with the vocabulary; a check that only compares coverage would pass a table
 * whose cells had been rewritten.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DOCUMENT_PATH, parseStrict } from "../scripts/validate-workflow-graph.mjs";
import { ROOT } from "../scripts/validate-refusal-vocabulary.mjs";
import {
  REQUIRED_VIEWS,
  bindingErrors,
  coverageErrors,
  locate,
  renderErrors,
  renderRow,
  renderView,
  rosterErrors,
  stepCoverageErrors,
} from "../scripts/render-workflow-views.mjs";

const document = () => parseStrict(readFileSync(path.join(ROOT, DOCUMENT_PATH), "utf8"));

/** A reader that serves one file from memory and everything else from disk. */
function servingInstead(relative, text) {
  const target = path.join(ROOT, relative);
  return (file, encoding) => (file === target ? text : readFileSync(file, encoding));
}

test("the shipped views render byte for byte into their documents", () => {
  assert.deepEqual(renderErrors(document()), []);
});

test("the shipped views cover exactly the reasons the graph declares", () => {
  assert.deepEqual(coverageErrors(document()), []);
});

test("the views are worth having: each one carries rows", () => {
  const graph = document();
  assert.ok(graph.views.length > 0, "the document declares at least one view");
  for (const view of graph.views) {
    assert.ok(view.rows.length > 0, `${view.id} renders rows`);
    assert.ok(view.header.startsWith("|"), `${view.id} names its header line`);
    assert.ok(view.renders_into.length > 0, `${view.id} names the file it renders into`);
  }
});

test("a table edited where it is rendered no longer matches the document", () => {
  const graph = document();
  const view = graph.views[0];
  const file = path.join(ROOT, view.renders_into);
  const lines = readFileSync(file, "utf8").split("\n");
  const at = locate(lines, view.header);
  assert.notEqual(at, null, "the header locates the table");

  const edited = [...lines];
  edited[at.start + 2] = `${edited[at.start + 2]} `;
  const errors = renderErrors(graph, { read: servingInstead(view.renders_into, edited.join("\n")) });
  assert.ok(
    errors.some((message) => message.startsWith("view_row_differs")),
    `a trailing space should be caught, got: ${errors.join("\n") || "(nothing)"}`,
  );
});

test("a row removed from the rendered table is caught by count, not by luck", () => {
  const graph = document();
  const view = graph.views[0];
  const lines = readFileSync(path.join(ROOT, view.renders_into), "utf8").split("\n");
  const at = locate(lines, view.header);
  const edited = [...lines];
  edited.splice(at.start + 3, 1);
  const errors = renderErrors(graph, { read: servingInstead(view.renders_into, edited.join("\n")) });
  assert.ok(
    errors.some((message) => message.startsWith("view_row_count")),
    `a deleted row should be caught, got: ${errors.join("\n") || "(nothing)"}`,
  );
});

test("a document edited without re-rendering no longer matches the table", () => {
  const graph = document();
  graph.views[0].rows[0].cells[1] = "somewhere_else";
  assert.ok(
    renderErrors(graph).some((message) => message.startsWith("view_row_differs")),
    "changing a cell in the document must not agree with the file",
  );
});

test("a view whose header is gone is a failure, not an empty pass", () => {
  const graph = document();
  const view = graph.views[0];
  const lines = readFileSync(path.join(ROOT, view.renders_into), "utf8").split("\n");
  const at = locate(lines, view.header);
  const edited = [...lines];
  edited[at.start] = `${edited[at.start]} renamed`;
  const errors = renderErrors(graph, { read: servingInstead(view.renders_into, edited.join("\n")) });
  assert.deepEqual(errors, [`view_header_missing: ${view.id} has no header line in ${view.renders_into}`]);
});

test("a reason that leaves a view is caught even when the text still matches", () => {
  const graph = document();
  const dropped = graph.views[0].rows[0].covers[0];
  graph.views[0].rows[0] = { ...graph.views[0].rows[0], covers: [] };
  const errors = coverageErrors(graph);
  assert.ok(
    errors.includes(`view_reason_unaccounted: ${graph.views[0].id} neither explains nor omits ${dropped}`),
    `dropping ${dropped} from a view must fail, got: ${errors.join("\n") || "(nothing)"}`,
  );
  // The text is untouched, so the render check alone would have passed it.
  assert.deepEqual(renderErrors(graph), []);
});

test("a partial view must name what it leaves out, and cannot do both", () => {
  const graph = document();
  const partial = graph.views.find((view) => view.coverage === "partial");
  assert.ok(partial, "one view explains part of the enumeration");
  assert.ok(partial.omits.length > 0, `${partial.id} names the reasons it does not explain`);

  // Dropping an omission is the same failure as dropping a covered reason: the
  // reason stops being accounted for, which is the whole point of writing the
  // omissions down instead of letting the view be quietly short.
  const shortened = document();
  const target = shortened.views.find((view) => view.coverage === "partial");
  const dropped = target.omits[0];
  target.omits = target.omits.slice(1);
  assert.ok(
    coverageErrors(shortened).includes(`view_reason_unaccounted: ${target.id} neither explains nor omits ${dropped}`),
    "an omission removed without the row to explain it must fail",
  );

  const both = document();
  const claimed = both.views.find((view) => view.coverage === "partial");
  claimed.omits = [...claimed.omits, claimed.rows.find((row) => row.covers.length > 0).covers[0]];
  assert.ok(
    coverageErrors(both).some((message) => message.startsWith("view_reason_both_ways")),
    "a view cannot both explain a reason and claim to omit it",
  );
});

test("a view claiming a reason the graph never declares is caught too", () => {
  const graph = document();
  graph.views[0].rows[0] = { ...graph.views[0].rows[0], covers: ["never_declared_reason"] };
  assert.ok(
    coverageErrors(graph).some((message) => message.startsWith("view_reason_undeclared")),
    "a view must not invent a park reason",
  );
});

test("a row renders as the file writes it", () => {
  assert.equal(renderRow(["a", "b", "c"]), "| a | b | c |");
  const graph = document();
  const view = graph.views[0];
  assert.deepEqual(renderView(view).slice(0, 2), [view.header, view.rule]);
});

test("a required view cannot be deleted out of the check's sight", () => {
  const graph = document();
  assert.deepEqual(rosterErrors(graph), []);
  for (const required of REQUIRED_VIEWS) {
    // Deleting a view used to leave the coverage and render checks with nothing
    // to disagree with, so the table it renders stopped being checked and the
    // gate still passed.
    const without = { ...graph, views: graph.views.filter((view) => view.id !== required.id) };
    assert.deepEqual(coverageErrors(without), [], "the remaining checks are the ones that fell silent");
    assert.deepEqual(renderErrors(without), []);
    assert.deepEqual(rosterErrors(without), [
      `view_missing: the graph must carry ${required.id}, rendered into ${required.renders_into}`,
    ]);
  }
});

test("a required view cannot be pointed at another file either", () => {
  const graph = document();
  const view = graph.views.find((entry) => entry.id === REQUIRED_VIEWS[0].id);
  const moved = { ...graph, views: graph.views.map((entry) => (entry === view ? { ...entry, renders_into: "README.md" } : entry)) };
  assert.ok(rosterErrors(moved).some((message) => message.startsWith("view_misplaced")));
});

test("changing a resume rule obliges a look at the row explaining it", () => {
  const graph = document();
  assert.deepEqual(bindingErrors(graph), []);

  // The row's text and its `covers` are untouched, so coverage and render both
  // still pass; the rule underneath the sentence is what moved.
  const rewired = document();
  const rule = rewired.recovery.find((row) => row.resume_targets.length > 1);
  rule.resume_targets = [rule.resume_targets[0]];
  assert.deepEqual(coverageErrors(rewired), []);
  assert.deepEqual(renderErrors(rewired), []);
  const stale = bindingErrors(rewired);
  assert.ok(stale.length > 0, "a rewritten resume rule must not leave every check silent");
  for (const message of stale) assert.match(message, /^view_binding_stale: /u);
});

test("a required_state rewritten in place is caught too", () => {
  const rewired = document();
  rewired.recovery[0].required_state = "something else entirely";
  assert.ok(
    bindingErrors(rewired).some((message) => message.includes(rewired.recovery[0].reason)),
    "the binding covers the whole recovery entry, not only its targets",
  );
});

/**
 * Coverage at step granularity, which is what the reason-level check above cannot
 * see. A reason may be covered by rows that name only some of the steps the graph
 * parks it at, and then a reader of the table is never told about the rest: the
 * shipped document had ten such steps under one reason, all of them deterministic
 * steps with no gate child, so the row written for gate children did not reach
 * them. Nothing refused, because every check in place asked about reasons.
 *
 * A class reference in a step cell counts for the members it declares, and the
 * classes come from the vocabulary rather than from a list kept here — that is
 * the same resource the park table's own extraction reads.
 */

test("the shipped park table names every step the graph parks a reason at", () => {
  assert.deepEqual(stepCoverageErrors(document()), []);
});

test("view_park_step_unexplained: a parked step no row of its reason names", () => {
  const graph = document();
  const row = graph.views
    .find((view) => view.id === "park_table")
    .rows.find((candidate) => candidate.covers.includes("blocked_anchor") && candidate.cells[1].includes("accept"));
  // The row added for the ten steps with no gate child, minus one of its steps: the
  // graph still parks blocked_anchor at `accept` and now no row says so.
  row.cells[1] = row.cells[1].replace(/\baccept\b/, "");
  const errors = stepCoverageErrors(graph);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^view_park_step_unexplained: park_table leaves blocked_anchor at accept/);
});

test("a step cell naming a class counts for that class's declared members", () => {
  const graph = document();
  const row = graph.views
    .find((view) => view.id === "park_table")
    .rows.find((candidate) => candidate.cells[1].includes("<gate_join_step>"));
  assert.ok(row, "the park table names a step class");
  // Spelled out, the same five steps are covered and the check is silent either way.
  row.cells[1] = row.cells[1].replace("<gate_join_step>", "arena_join contest_join narrow_review_join panel_join review_join");
  assert.deepEqual(stepCoverageErrors(graph), []);
});

test("a reason a view omits is not asked to name its steps", () => {
  const graph = document();
  const view = graph.views.find((entry) => entry.id === "park_table");
  const omitted = "blocked_anchor";
  view.rows = view.rows.filter((row) => !row.covers.includes(omitted));
  view.omits = [...(view.omits ?? []), omitted];
  assert.deepEqual(stepCoverageErrors(graph), []);
});
