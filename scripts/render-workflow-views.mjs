/**
 * Renders the workflow graph's views back into the documents they belong to.
 *
 * The failure this closes is that the resume contract was written three times —
 * once as the graph's `recovery`, once as the park table in the technical plan,
 * once as the resume table in core flows — and three hand-kept copies drift. A
 * check that notices the drift makes it detectable; generating two of them from
 * the third makes it unrepresentable, which is what the plan asked for.
 *
 * The rendered unit is the row and not the reason, because the tables group: one
 * row can stand for several reasons, and one reason appears in several rows under
 * different qualifiers. So the document carries the rows, and this puts them back
 * byte for byte. What it does not carry it cannot render, and the coverage check
 * below is what stops a reason from quietly leaving one table and not the other.
 *
 * `--check` compares and exits non-zero on any difference; `--write` replaces the
 * table in place. Neither touches anything outside the rows between a view's
 * header line and the first line that is not a table row.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHash } from "node:crypto";

import { DOCUMENT_PATH, canonicalText, parseStrict, producedAt } from "./validate-workflow-graph.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The views the shipped graph must carry.
 *
 * Without this the check trusts whatever views the document happens to declare:
 * deleting `park_table` from the JSON left the coverage and render checks with
 * nothing to disagree with, so the plan's table stopped being checked at all and
 * everything still passed. A required view has to be named somewhere that
 * deleting it cannot also delete, and the contract closes this list.
 */
export const REQUIRED_VIEWS = Object.freeze([
  { id: "park_table", renders_into: "03-technical-plan.md" },
  { id: "core_flows_resume", renders_into: "01-core-flows.md" },
]);

/**
 * What a view row is bound to in `recovery`.
 *
 * Names alone were not enough: rewriting a reason's `resume_targets` changed the
 * rule while the row explaining it stayed as written, and nothing refused. The
 * digest covers the whole recovery entry, so changing any part of the rule
 * obliges whoever changed it to revisit the sentence that explains it.
 */
export function bindingDigest(document, covers) {
  const byReason = new Map(document.recovery.map((row) => [row.reason, row]));
  const bound = [...covers].sort().map((reason) => byReason.get(reason) ?? null);
  return createHash("sha256").update(canonicalText(bound), "utf8").digest("hex");
}

/** Every required view the document fails to carry, or carries somewhere else. */
export function rosterErrors(document) {
  const errors = [];
  const declared = new Map((document.views ?? []).map((view) => [view.id, view]));
  for (const required of REQUIRED_VIEWS) {
    const view = declared.get(required.id);
    if (!view) {
      errors.push(`view_missing: the graph must carry ${required.id}, rendered into ${required.renders_into}`);
    } else if (view.renders_into !== required.renders_into) {
      errors.push(`view_misplaced: ${required.id} must render into ${required.renders_into}, not ${view.renders_into}`);
    }
  }
  return errors.sort();
}

/** Every row whose binding no longer matches the recovery it explains. */
export function bindingErrors(document) {
  const errors = [];
  for (const view of document.views ?? []) {
    for (const [index, row] of view.rows.entries()) {
      const expected = bindingDigest(document, row.covers);
      if (row.binds !== expected) {
        errors.push(`view_binding_stale: ${view.id} row ${index + 1} explains ${row.covers.join(", ") || "nothing"} and its binding no longer matches`);
      }
    }
  }
  return errors.sort();
}

/** One rendered row: the cells joined the way the file writes them. */
export function renderRow(cells) {
  return `| ${cells.join(" | ")} |`;
}

export function renderView(view) {
  return [view.header, view.rule, ...view.rows.map((row) => renderRow(row.cells))];
}

/**
 * Where a view sits in its file.
 *
 * Located by its header rather than by a line number, so an edit above it moves
 * the table without moving this.
 */
export function locate(lines, header) {
  const start = lines.indexOf(header);
  if (start === -1) return null;
  let end = start + 2;
  while (end < lines.length && lines[end].startsWith("|")) end += 1;
  return { start, end };
}

/**
 * Every reason the views cover against every reason the graph declares.
 *
 * Both directions matter. A reason in `recovery` that no view mentions is a park
 * a reader is never told how to leave; a reason a view mentions and `recovery`
 * does not is a resume path into a park that cannot happen.
 */
export function coverageErrors(document) {
  const declared = new Set(document.recovery.map((row) => row.reason));
  const errors = [];
  for (const view of document.views ?? []) {
    const covered = new Set(view.rows.flatMap((row) => row.covers));
    const omitted = new Set(view.omits ?? []);
    for (const reason of covered) {
      if (!declared.has(reason)) errors.push(`view_reason_undeclared: ${view.id} covers ${reason}, which recovery does not declare`);
      if (omitted.has(reason)) errors.push(`view_reason_both_ways: ${view.id} both covers and omits ${reason}`);
    }
    for (const reason of omitted) {
      if (!declared.has(reason)) errors.push(`view_reason_undeclared: ${view.id} omits ${reason}, which recovery does not declare`);
    }
    // Covered and omitted together must be exactly what the graph declares. A
    // complete view has nothing to omit; a partial one has to name what it leaves
    // out, so a reason cannot stop being explained without an edit someone reads.
    for (const reason of declared) {
      if (!covered.has(reason) && !omitted.has(reason)) {
        errors.push(`view_reason_unaccounted: ${view.id} neither explains nor omits ${reason}`);
      }
    }
  }
  return [...new Set(errors)].sort();
}

/**
 * The step classes the park table's cells may name, read from the vocabulary.
 *
 * Not a list kept here. The park table's own extraction resolves class references
 * against this resource, so a second copy would be a second place for the members
 * of a class to live — which is the failure this whole family of checks exists to
 * prevent.
 */
function stepClasses({ root = ROOT, read = readFileSync } = {}) {
  const file = path.join(root, "resources/refusal-vocabulary/refusal-vocabulary.v1.json");
  const vocabulary = JSON.parse(read(file, "utf8"));
  return new Map((vocabulary.step_classes ?? []).map((entry) => [entry.class, entry.members]));
}

/**
 * Every step the graph parks a reason at that no row of the park table names.
 *
 * `coverageErrors` above asks about reasons, and a reason can be covered by rows
 * that between them name only some of the steps it parks at. The shipped document
 * had ten such steps under one reason: five of its fifteen were covered by the row
 * written for gate children, and the other ten are deterministic steps with no gate
 * child, which that row cannot reach. Nothing refused, because nothing asked.
 *
 * A cell may name a step outright or name a class, and a class counts for the
 * members it declares. A reason a view omits is not asked anything — omission is
 * already a decision the view states and `coverageErrors` already checks it.
 */
export function stepCoverageErrors(document, options = {}) {
  const classes = stepClasses(options);
  const registered = new Set(document.steps.map((step) => step.name));
  const errors = [];
  for (const view of document.views ?? []) {
    if (view.id !== "park_table") continue;
    const omitted = new Set(view.omits ?? []);
    const named = new Map();
    for (const row of view.rows) {
      const cell = row.cells[1] ?? "";
      const steps = new Set();
      for (const [, name] of cell.matchAll(/<([a-z_]+)>/g)) for (const step of classes.get(name) ?? []) steps.add(step);
      for (const token of cell.split(/[^a-z0-9_]+/)) if (registered.has(token)) steps.add(token);
      for (const reason of row.covers) {
        if (!named.has(reason)) named.set(reason, new Set());
        for (const step of steps) named.get(reason).add(step);
      }
    }
    for (const [reason, where] of producedAt(document)) {
      if (omitted.has(reason)) continue;
      for (const step of [...where].sort()) {
        if (named.get(reason)?.has(step)) continue;
        errors.push(`view_park_step_unexplained: ${view.id} leaves ${reason} at ${step} with no row that names it`);
      }
    }
  }
  return errors.sort();
}

export function renderErrors(document, { root = ROOT, read = readFileSync } = {}) {
  const errors = [];
  for (const view of document.views ?? []) {
    const file = path.join(root, view.renders_into);
    const lines = read(file, "utf8").split("\n");
    const at = locate(lines, view.header);
    if (at === null) {
      errors.push(`view_header_missing: ${view.id} has no header line in ${view.renders_into}`);
      continue;
    }
    const rendered = renderView(view);
    const present = lines.slice(at.start, at.end);
    if (present.length !== rendered.length) {
      errors.push(`view_row_count: ${view.id} renders ${rendered.length} lines and ${view.renders_into} has ${present.length}`);
      continue;
    }
    for (const [index, line] of rendered.entries()) {
      if (line !== present[index]) {
        errors.push(`view_row_differs: ${view.id} line ${at.start + index + 1} of ${view.renders_into}`);
      }
    }
  }
  return errors;
}

export function writeViews(document, { root = ROOT } = {}) {
  const written = [];
  for (const view of document.views ?? []) {
    const file = path.join(root, view.renders_into);
    const lines = readFileSync(file, "utf8").split("\n");
    const at = locate(lines, view.header);
    if (at === null) throw new Error(`view_header_missing: ${view.id} in ${view.renders_into}`);
    lines.splice(at.start, at.end - at.start, ...renderView(view));
    writeFileSync(file, lines.join("\n"));
    written.push(`${view.id} -> ${view.renders_into}`);
  }
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const document = parseStrict(readFileSync(path.join(ROOT, DOCUMENT_PATH), "utf8"));
  if (process.argv.includes("--write")) {
    for (const line of writeViews(document)) console.log(`wrote ${line}`);
  } else {
    const errors = [
      ...rosterErrors(document),
      ...coverageErrors(document),
      ...stepCoverageErrors(document),
      ...bindingErrors(document),
      ...renderErrors(document),
    ];
    if (errors.length > 0) {
      console.error(errors.join("\n"));
      process.exitCode = 1;
    } else {
      const rows = (document.views ?? []).reduce((total, view) => total + view.rows.length, 0);
      console.log("Workflow view render check PASS");
      console.log(`views=${(document.views ?? []).length} rows=${rows} reasons=${document.recovery.length}`);
    }
  }
}
