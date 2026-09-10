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

import { DOCUMENT_PATH, parseStrict } from "./validate-workflow-graph.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    const errors = [...coverageErrors(document), ...renderErrors(document)];
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
