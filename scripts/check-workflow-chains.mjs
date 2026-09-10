/**
 * Checks section 2's eight arrow-chain blocks against the workflow graph.
 *
 * The blocks are not rendered from the document and cannot be: the document
 * carries no chain layout — no line order, no indentation column, no alternative
 * grouping, no placeholder prose — and in section 2 the indentation is
 * load-bearing, because a continuation line attaches to the step whose part
 * starts at or before its arrow column. So the blocks stay hand-drawn and this
 * checks that what they draw is what the graph declares.
 *
 * Two properties, and they fail for different reasons. A chain that draws an
 * edge the graph does not declare is a picture of a flow that cannot happen. A
 * `(human)` mark on a step the graph does not run as a human status is the
 * drawing and the data disagreeing about where a person acts, which is the one
 * thing the chains say that the transition tables never do.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DOCUMENT_PATH, parseStrict } from "./validate-workflow-graph.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PLAN_PATH = "03-technical-plan.md";

/**
 * The paths section 2 draws that its own transition tables do not support.
 *
 * The tables govern, because only they carry conditions. Where a table declares
 * no exit from a step at all the chain supplies one, but these three leave steps
 * the tables do describe leaving — to `human` in every case — so the drawing and
 * the specification disagree rather than one filling the other's silence.
 *
 * Editing section 2's prose to settle them is a normative change to what the plan
 * says the flow is, and that is the plan author's call, not this checker's. So
 * they are named here and closed by the contract: a divergence has to be written
 * down to be tolerated, and one that is not written down fails.
 */
export const KNOWN_CHAIN_DIVERGENCES = Object.freeze([
  "autosk-planned: resume_repaired_tickets -> ticket_join",
  "autosk-quick: intake -> implement",
  "autosk-quick: invalidate_quick_classification -> done",
]);

/** Section 2's fenced blocks and the workflow each belongs to, in file order. */
export function chainBlocks(plan) {
  const lines = plan.split("\n");
  const from = lines.findIndex((line) => line.startsWith("## 2. "));
  const to = lines.findIndex((line) => line.startsWith("## 3. "));
  if (from === -1 || to === -1) return [];
  const section = lines.slice(from, to).join("\n");
  const blocks = [...section.matchAll(/~~~text\n([\s\S]*?)\n~~~/gu)].map((match) => match[1]);
  const workflows = [...section.matchAll(/^### (autosk-[\w-]+)/gmu)].map((match) => match[1]);
  return blocks.map((text, index) => ({ text, workflow: workflows[index] ?? "unknown" }));
}

/** A token shaped like a step name: what a typo of one would look like. */
const NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;

/**
 * What a segment names: the declared steps, and the things that only look like
 * them.
 *
 * The chains draw through prose placeholders — `create/enroll autosk-planned
 * replacement` — and those must not stop a chain. But dropping everything
 * undeclared treated a misspelled step as a placeholder too, so renaming a step
 * and missing one drawing of it passed the gate that exists to catch exactly
 * that. A placeholder is prose; anything shaped like a step name and not
 * declared is a name that has gone wrong.
 */
function stepsIn(segment, declared) {
  const steps = [];
  const unknown = [];
  for (const option of segment.split("|").map((part) => part.replace(/\([^)]*\)/gu, "").trim())) {
    if (option === "") continue;
    if (declared.has(option)) steps.push(option);
    else if (NAME.test(option)) unknown.push(option);
  }
  return { steps, unknown };
}

/** Which step on the previous line starts at or before this column. */
function anchorAt(previous, column) {
  let best = null;
  for (const part of previous) {
    if (part.steps.length === 0) continue;
    if (part.start <= column) best = part.steps[part.steps.length - 1];
  }
  return best;
}

/** One line walked into its parts, plus the edges it states. */
function walk(line, declared, anchor) {
  const parts = [];
  let cursor = 0;
  for (const piece of line.split("->")) {
    parts.push({ text: piece, start: cursor, ...stepsIn(piece, declared) });
    cursor += piece.length + 2;
  }
  const edges = [];
  const unknown = parts.flatMap((part) => part.unknown);
  let previous = parts[0].steps.length > 0 ? parts[0].steps : anchor ? [anchor] : [];
  for (const part of parts.slice(1)) {
    // A segment naming no step is a placeholder the chain draws through, so the
    // chain continues across it rather than stopping there.
    if (part.steps.length === 0) continue;
    for (const from of previous) for (const to of part.steps) edges.push({ from, to });
    previous = part.steps;
  }
  return { edges, ends: previous, parts, unknown };
}

/** Every edge and every `(human)` mark the chains draw. */
export function readChains(plan, declared) {
  const edges = [];
  const marks = [];
  const unknown = [];
  for (const block of chainBlocks(plan)) {
    let previousParts = null;
    let previousEnds = null;
    for (const raw of block.text.split("\n")) {
      if (raw.trim() === "") continue;
      for (const match of raw.matchAll(/([a-z][a-z0-9_]*)\s*\(human\)/gu)) {
        if (declared.has(match[1])) marks.push({ step: match[1], workflow: block.workflow });
      }
      const arrow = raw.indexOf("->");
      if (arrow < 0) {
        // A line with no arrow is either a label naming the sources for the arrow
        // that follows, or a step standing alone as the source of the next line —
        // which is how every block opens. Treating only the label as a source
        // lost the Planned flow's first transition entirely.
        const label = /^([^:]*):\s*$/u.exec(raw.trim());
        if (label) {
          previousEnds = label[1].split(/[\s/]+/u).filter((word) => declared.has(word));
        } else {
          const alone = stepsIn(raw, declared);
          unknown.push(...alone.unknown.map((name) => ({ name, workflow: block.workflow })));
          previousEnds = alone.steps.length > 0 ? alone.steps : null;
        }
        previousParts = null;
        continue;
      }
      const continuation = raw.trim().startsWith("->");
      const anchor = continuation && previousParts ? anchorAt(previousParts, arrow) : null;
      const line = continuation ? raw : raw.replace(/^[^:]*:\s*/u, (match) => (match.includes("->") ? match : ""));
      const sources = continuation && !anchor && previousEnds ? previousEnds : anchor ? [anchor] : null;
      const walked = walk(line, declared, sources ? sources[0] : null);
      if (sources && sources.length > 1 && walked.parts[1]?.steps.length) {
        for (const from of sources) for (const to of walked.parts[1].steps) walked.edges.push({ from, to });
      }
      for (const edge of walked.edges) edges.push({ ...edge, workflow: block.workflow });
      for (const name of walked.unknown) unknown.push({ name, workflow: block.workflow });
      previousParts = walked.parts;
      previousEnds = walked.ends;
    }
  }
  return { edges, marks, unknown };
}

/** Every step the graph can get to from `origin`, following declared edges. */
export function reachableFrom(document, origin) {
  const outgoing = new Map();
  for (const edge of document.transitions) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const seen = new Set();
  const queue = [origin];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of outgoing.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/**
 * Whether the drawings still describe the graph.
 *
 * The property is reachability, not adjacency, because the notation summarises
 * paths: block 1 draws `select_next -> record_alignment` where the flow passes
 * through the alignment cycle to get there. Reading each adjacent pair as an edge
 * and demanding the graph declare it would fail on 23 pairs that are the chains
 * abbreviating, not the chains disagreeing. What a summary must not do is draw a
 * step the flow cannot get to at all, and that is what this refuses.
 *
 * The `(human)` marks are checked as themselves. They are the only thing the
 * chains state that the transition tables never do, so nothing else can catch a
 * mark that has drifted from the step it marks.
 */
export function chainErrors(document, { root = ROOT, read = readFileSync } = {}) {
  const declared = new Set(document.steps.map((step) => step.name));
  const humanSteps = new Set(
    document.steps.filter((step) => step.kind === "status" && step.status === "human").map((step) => step.name),
  );

  const { edges, marks, unknown } = readChains(read(path.join(root, PLAN_PATH), "utf8"), declared);
  const known = new Set(KNOWN_CHAIN_DIVERGENCES);
  const reach = new Map();
  const errors = [];
  const seen = new Set();
  for (const edge of edges) {
    if (!reach.has(edge.from)) reach.set(edge.from, reachableFrom(document, edge.from));
    if (reach.get(edge.from).has(edge.to)) continue;
    const named = `${edge.workflow}: ${edge.from} -> ${edge.to}`;
    seen.add(named);
    if (!known.has(named)) {
      errors.push(`chain_step_unreachable: ${edge.workflow} draws ${edge.from} -> ${edge.to} and the graph cannot get from one to the other`);
    }
  }
  // A divergence that has been settled must stop being tolerated, or the list
  // grows into a place where a real one can hide behind a stale entry.
  for (const named of known) {
    if (!seen.has(named)) errors.push(`chain_divergence_stale: ${named} is named as known and no longer diverges`);
  }
  for (const entry of unknown) {
    errors.push(`chain_step_unknown: ${entry.workflow} draws ${entry.name}, which the graph does not declare as a step`);
  }
  for (const mark of marks) {
    if (!humanSteps.has(mark.step)) {
      errors.push(`chain_human_mark_unmatched: ${mark.workflow} marks ${mark.step} (human) and the graph does not run it as a human status step`);
    }
  }
  return [...new Set(errors)].sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const document = parseStrict(readFileSync(path.join(ROOT, DOCUMENT_PATH), "utf8"));
  const errors = chainErrors(document);
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    const declared = new Set(document.steps.map((step) => step.name));
    const { edges, marks } = readChains(readFileSync(path.join(ROOT, PLAN_PATH), "utf8"), declared);
    console.log("Workflow chain consistency PASS");
    console.log(`blocks=${chainBlocks(readFileSync(path.join(ROOT, PLAN_PATH), "utf8")).length} edges=${edges.length} human_marks=${marks.length}`);
  }
}
