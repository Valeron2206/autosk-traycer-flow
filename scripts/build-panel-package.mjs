#!/usr/bin/env node

/**
 * Builds the review package the final panel reads (#39, and the program's own
 * completion condition).
 *
 * One package, byte-identical for every seat. The seats disagree about the
 * candidate or they do not disagree at all; a package assembled per seat would
 * make every disagreement ambiguous.
 *
 * It is sized deliberately. The four required routes do not have the same
 * context window — the smallest is 200k tokens — and the package has to fit the
 * smallest one whole, because a seat that received a truncated package reviewed
 * something the others did not. So the package carries the load-bearing design
 * text in full, and everything else by path and digest: a seat can state
 * exactly what it read and what it did not.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { COVERAGE_STATES, INJECTION_KINDS, coverageReport, faultCoverage, harnessCoverage } from './lib/clean-room-coverage.mjs';
import { filesUsing } from './lib/code-references.mjs';
import { digestOf, sourceDrift } from './lib/produced-source.mjs';
import { RULES as MUTATION_RULES, reportDigest } from './mutation-report.mjs';
import { panelVerdicts } from './validate-design-candidate.mjs';
import { acceptanceAuthority } from './validate-integration-authorization.mjs';
import { classifySeam } from './verify-autosk-migration-seam.mjs';
import { PARK_REASONS as ALIGNMENT_PARK_REASONS } from '../src/host/alignment-gates.mjs';
import { UNPINNED_DAEMON_PRIMITIVES } from '../src/host/daemon-preflight.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The documents every seat reads in full. */
export const FULL_TEXT = Object.freeze([
  '01-core-flows.md',
  '02-architecture.md',
]);

/** The contracts whose rules are summarised by heading and refusal class. */
export const CONTRACT_GLOB = 'docs/contracts';

async function read(relative) {
  return readFile(path.join(ROOT, relative), 'utf8');
}

/**
 * The names a `Closed set:` sentence enumerates, and nothing after them.
 *
 * The enumeration is backticked names joined by commas or `and`, and it may wrap
 * across lines on either side of the joining word — reflowing a paragraph is not
 * a change to the declared set. It ends at the first thing that is not one of
 * those: a full stop, a word, or a bullet, which is how the bulleted form
 * declines this reader and leaves the section to the other one. A blank line ends
 * it too, so it cannot run on into the next paragraph.
 */
function inlineEnumeration(text) {
  const lead = /Closed set[^:]*:/u.exec(text);
  if (!lead) return null;
  // One line break, not a paragraph break: `[ \t]*\n?[ \t]*` on both sides of a
  // name lets the list wrap while stopping at a blank line.
  const step = /^[ \t]*\n?[ \t]*(?:and[ \t]*\n?[ \t]*)?`([a-z][a-z0-9_]{4,})`[ \t]*\n?[ \t]*(,|and\b)?/u;
  let rest = text.slice(lead.index + lead[0].length);
  const names = [];
  for (;;) {
    const found = step.exec(rest);
    if (!found) break;
    names.push(found[1]);
    rest = rest.slice(found[0].length);
    if (!found[2]) break;
  }
  return names.length > 0 ? names : null;
}

/**
 * The headings and refusal classes of one contract, without its whole body.
 *
 * Contracts close their sets in two forms — an inline `Closed set:` sentence
 * and a bulleted `Refusal classes` section — and reading only the first is how
 * a package tells a panel that twenty-two contracts declare no closed set when
 * every one of them does. Round 1 found exactly that, so both forms are read
 * and the form is reported.
 *
 * The inline reader takes the enumeration and stops: it used to take the rest of
 * the paragraph, so a field name a bullet mentioned while explaining a class
 * became a class of its own — `artifact-write-receipt.md` declares nine and the
 * package said ten.
 */
export function contractOutline(text) {
  const headings = [];
  for (const line of text.split('\n')) {
    if (/^##\s/u.test(line)) headings.push(line.replace(/^##\s*/u, '').trim());
  }
  const refusals = new Set();
  const inline = inlineEnumeration(text);
  for (const name of inline ?? []) refusals.add(name);
  const section = /(?:^|\n)##\s*\d+\.\s*(?:Refusal classes|What a refusal looks like)\s*\n([\s\S]*?)(?=\n##\s|$)/u.exec(text);
  if (section) {
    for (const match of section[1].matchAll(/^-\s*`([a-z][a-z0-9_]{4,})`/gmu)) refusals.add(match[1]);
  }
  const form = inline && section ? 'both' : inline ? 'inline' : section ? 'section' : 'none';
  return { headings, refusals: [...refusals].sort(), form };
}

/** Where the host modules the mutation table scores live. */
const HOST_DIR = 'src/host';

/** How a module declares the contract it implements, next to the code. */
const IMPLEMENTS = /\bImplements:\s*(docs\/contracts\/[a-z0-9-]+\.md)\b/gu;

/**
 * Whether a module names a refusal class, as that whole name.
 *
 * `expected_previous` occurs inside `expected_previous_sha256`, so a substring
 * test counts a class as named by a field that merely starts the same way.
 */
export function namesRefusal(text, code) {
  return new RegExp(`(?<![A-Za-z0-9_])${code}(?![A-Za-z0-9_])`, 'u').test(text);
}

/**
 * Each contract, with what reads it and what evaluates it, measured.
 *
 * The enforcement column was computed from a filename: `docs/contracts/<stem>.md`
 * had to meet `src/host/<stem>.mjs`. That printed "design only" twice over a real
 * implementation — `src/host/workflow-graph-canonical.mjs` evaluates the graph
 * contract's canonical form, and `src/host/gate-projection.mjs` evaluates
 * `gate-store-projection.md` — and neither name is reachable from a stem. Worse,
 * the cell turned a measurement that found nothing into a claim that nothing
 * exists. Three links are measured instead:
 *
 * - `import` — a script that names the contract imports the module. The chain is
 *   complete: the document is read, and that reader runs this code.
 * - `implements` — the module declares the contract, in the `Implements:` line
 *   above its own code. A declaration beside what it describes moves with a
 *   rename and dies with a deletion; the same fact in a central list does not.
 * - `name` — only the filename convention matches. Kept, because dropping it
 *   would deny twelve contracts a module that plainly evaluates them, and
 *   labelled, because a convention is not a declaration.
 *
 * A module found by more than one link is reported under the strongest. None of
 * the three proves the rules are evaluated, and a row with none of them reports
 * that nothing was measured, not that nothing runs.
 */
export async function measureContracts() {
  const scriptText = new Map();
  for (const name of (await readdir(path.join(ROOT, 'scripts'))).sort()) {
    if (name.endsWith('.mjs')) scriptText.set(`scripts/${name}`, await read(`scripts/${name}`));
  }
  const hostText = new Map();
  for (const name of (await readdir(path.join(ROOT, HOST_DIR))).sort()) {
    if (name.endsWith('.mjs')) hostText.set(`${HOST_DIR}/${name}`, await read(`${HOST_DIR}/${name}`));
  }

  // Every file under src/, for the second measurement a row with no link gets
  // (debt 10h, R6-21): whether any of the contract's classes is named anywhere
  // in this repository's runtime code at all.
  const srcText = new Map();
  const walk = async (relative) => {
    for (const entry of (await readdir(path.join(ROOT, relative), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) srcText.set(child, await read(child));
    }
  };
  await walk('src');

  const declarations = new Map();
  for (const [module, text] of hostText) {
    declarations.set(module, new Set([...text.matchAll(IMPLEMENTS)].map((match) => match[1])));
  }

  const importsOf = new Map();
  for (const [script, text] of scriptText) {
    const modules = new Set();
    for (const match of text.matchAll(/from\s+'([^']+)'|from\s+"([^"]+)"/gu)) {
      const specifier = match[1] ?? match[2];
      if (!specifier.startsWith('.')) continue;
      const target = path.posix.join(path.posix.dirname(script), specifier);
      if (hostText.has(target)) modules.add(target);
    }
    importsOf.set(script, modules);
  }

  const contracts = [];
  for (const name of (await readdir(path.join(ROOT, CONTRACT_GLOB))).sort()) {
    if (!name.endsWith('.md')) continue;
    const contractPath = `${CONTRACT_GLOB}/${name}`;
    // Which scripts name this contract's path. Measured, not declared: a list a
    // human keeps is the second place for this truth to live.
    const readers = [...scriptText].filter(([, text]) => text.includes(contractPath)).map(([script]) => script);
    const links = new Map();
    const stem = `${HOST_DIR}/${name.replace(/\.md$/u, '')}.mjs`;
    if (hostText.has(stem)) links.set(stem, { module: stem, link: 'name' });
    for (const [module, declared] of declarations) {
      if (declared.has(contractPath)) links.set(module, { module, link: 'implements' });
    }
    for (const reader of readers) {
      for (const module of importsOf.get(reader)) {
        const via = links.get(module)?.link === 'import' ? links.get(module).via : [];
        links.set(module, { module, link: 'import', via: [...via, reader] });
      }
    }
    const outline = contractOutline(await read(contractPath));
    // What the column exists to answer, as far as it can be answered by
    // measurement: how many of the refusals this contract declares are named in
    // the code linked to it. A link says where to look; this says what was found
    // there, and a partial implementation shows as a number rather than as an
    // adjective somebody chose.
    const evaluators = [...links.values()].sort((left, right) => (left.module < right.module ? -1 : 1));
    const named = outline.refusals.filter((code) =>
      evaluators.some((evaluator) => namesRefusal(hostText.get(evaluator.module), code)),
    );
    // The second measurement (review of 10h, H1): a class search cannot see an
    // implementation that names none of the contract's classes. So the
    // contract counts as referenced when a src/ file names it — its file name,
    // or its stem as a whole token — or when its own text names a src/ path
    // that exists.
    const contractStem = name.replace(/\.md$/u, '');
    const stemToken = new RegExp(`(?<![A-Za-z0-9_-])${contractStem}(?![A-Za-z0-9_-])`, 'u'); // stems are [a-z0-9-]
    const contractText = await read(contractPath);
    const srcReferences = {
      naming: [...srcText].filter(([, text]) => text.includes(name) || stemToken.test(text)).map(([file]) => file),
      named_paths: [...new Set([...contractText.matchAll(/\bsrc\/[A-Za-z0-9_./-]*[A-Za-z0-9_]/gu)].map((match) => match[0]))]
        .filter((file) => srcText.has(file))
        .sort(),
    };
    const namedUnderSrc = outline.refusals
      .map((code) => ({ code, modules: [...srcText].filter(([, text]) => namesRefusal(text, code)).map(([file]) => file) }))
      .filter((entry) => entry.modules.length > 0);
    contracts.push({
      path: contractPath,
      readers,
      evaluators,
      refusals_named: named.length,
      named_under_src: namedUnderSrc,
      src_references: srcReferences,
      ...outline,
    });
  }
  return contracts;
}

/** The workflow factory, which applies a caller's predicate evaluator, and its entry. */
export const FACTORY_MODULE = 'src/host/workflow-factory.mjs';
export const FACTORY_EXPORT = 'buildWorkflow';

/**
 * Who hands the workflow graph an evaluator, measured: every code file under
 * `scripts/` and `src/` — JavaScript or TypeScript — that uses the factory's
 * entry, whether it calls it, passes it on, imports it or writes it into a
 * module it generates, the factory itself apart.
 *
 * The factory decides nothing about a predicate: the caller supplies the
 * evaluator, so whether any product code evaluates the graph is a question
 * about its users. Round 7 of #39 (R7-10) found the package silent on it
 * while every user was a script; the answer is read from the tree rather than
 * written into the package, so a user under `src/` changes it. Review of 11c
 * (L1): a literal call in a `.mjs` file was all that was counted, so a
 * TypeScript entry point or a callback would have gone unseen.
 */
export async function factoryCallers({ root = ROOT } = {}) {
  return filesUsing({ root, dirs: ['scripts', 'src'], identifier: FACTORY_EXPORT, exclude: [FACTORY_MODULE] });
}

/** The workflow graph whose recovery rows name the park reasons the design admits. */
export const GRAPH_PATH = 'resources/workflow-graph/workflow-graph.v1.json';

/** The binding a pinned auto-policy is held to, and the module that defines it. */
export const AUTO_POLICY_EXPORT = 'autoPolicyAcceptance';
export const AUTO_POLICY_MODULE = 'src/host/staging-acceptance.mjs';

/**
 * Who uses the auto-policy's binding, measured as the factory's users are:
 * every code file under `scripts/` and `src/` that uses it, its own module
 * apart (round 8 of #39, R8-3). None means no product path calls it.
 */
export async function autoPolicyCallers({ root = ROOT } = {}) {
  return filesUsing({ root, dirs: ['scripts', 'src'], identifier: AUTO_POLICY_EXPORT, exclude: [AUTO_POLICY_MODULE] });
}

/** The two steps where the graph decides an alignment; its alignment reasons park at them. */
const ALIGNMENT_STEPS = Object.freeze(['clarify_alignment', 'record_alignment']);

/**
 * The reason names the host's alignment gates park with that the graph's
 * recovery rows do not carry, beside the graph's own alignment reasons — the
 * rows that park where an alignment is decided. Measured, not written into
 * the package (round 7 of #39, R7-23): the list is the module's own
 * `PARK_REASONS`, which `npm test` holds to the codes the module raises, so a
 * rename in either place changes what the package says.
 */
export function alignmentReasonGap(graph, raised = ALIGNMENT_PARK_REASONS) {
  const recovery = new Set((graph?.recovery ?? []).map((row) => row.reason));
  return Object.freeze({
    missing: Object.freeze([...raised].filter((code) => !recovery.has(code)).sort()),
    graph: Object.freeze((graph?.recovery ?? [])
      .filter((row) => (row.parks_at ?? []).some((step) => ALIGNMENT_STEPS.includes(step)))
      .map((row) => row.reason)
      .sort()),
  });
}

/**
 * Where a clean-room report says something its own records do not.
 *
 * Review of 11f (M1): the package printed a report's `counts` and `complete`
 * as given and held each row only to the coverage rule, so correct rows could
 * sit under the round-7 headline, a row could be missing or claim a control
 * the crash harness never asks, and a failed case or harness could stand
 * beside a covered row. The package now recomputes the coverage from the
 * run's own records — the daemon harnesses' steps and the fault harness's
 * cases — with the run's own functions, and a report must say exactly that:
 * one row per matrix group, each equal to the recomputed one, and the same
 * counts and `complete`.
 */
export function coverageRefusals(report, recomputed, matrix) {
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  const ids = rows.map((row) => row?.id);
  const groups = matrix.groups.map((group) => group.id);
  const missing = groups.filter((id) => !ids.includes(id));
  const outside = [...new Set(ids.filter((id) => !groups.includes(id)))];
  const repeated = [...new Set(ids.filter((id, index) => groups.includes(id) && ids.indexOf(id) !== index))];
  if (missing.length + outside.length + repeated.length > 0) {
    return [`the run's coverage rows are not one per matrix group: ${[
      missing.length > 0 ? `missing ${missing.join(', ')}` : null,
      repeated.length > 0 ? `repeated ${repeated.join(', ')}` : null,
      outside.length > 0 ? `not in the matrix ${outside.join(', ')}` : null,
    ].filter((part) => part !== null).join('; ')}`];
  }
  const errors = [];
  const said = (object, keys) => keys.map((key) => `${key} ${JSON.stringify(object[key])}`).join(', ');
  for (const row of recomputed.rows) {
    const given = rows.find((entry) => entry.id === row.id);
    const differing = [...new Set([...Object.keys(row), ...Object.keys(given)])].filter((key) => !Object.is(given[key], row[key]));
    if (differing.length > 0) {
      errors.push(`${row.id}: the run's row says ${said(given, differing)}, and its own records give ${said(row, differing)}`);
    }
  }
  const counts = report?.counts ?? {};
  const differingCounts = [...new Set([...Object.keys(recomputed.counts), ...Object.keys(counts)])]
    .filter((state) => !Object.is(counts[state], recomputed.counts[state]));
  if (differingCounts.length > 0) {
    const listed = (object) => differingCounts.map((state) => `${state}=${object[state]}`).join(', ');
    errors.push(`the run's counts say ${listed(counts)}, and its own records give ${listed(recomputed.counts)}`);
  }
  if (report?.complete !== recomputed.complete) {
    errors.push(`the run says complete=${report?.complete}, and its own records give complete=${recomputed.complete}`);
  }
  return errors;
}

/**
 * The cell answers "of the classes this contract declares, how many the run
 * produced" — the denominator is the contract's own closed set, not the number
 * of cases, so a run short of the set cannot print a fraction that reads as
 * complete. A shortfall names the classes; a case outside the set is named too.
 */
function producedCell(reportEntry, refusals) {
  const covered = new Set(
    (reportEntry.cases ?? [])
      .filter((row) => row.pass && refusals.includes(row.class))
      .map((row) => row.class),
  );
  const missing = refusals.filter((name) => !covered.has(name));
  const outside = [
    ...new Set(
      (reportEntry.cases ?? [])
        .filter((row) => !refusals.includes(row.class))
        .map((row) => row.class),
    ),
  ];
  let cell = `${covered.size} of ${refusals.length}`;
  if (missing.length > 0) cell += ` — not produced: ${missing.join(", ")}`;
  if (outside.length > 0) cell += ` — outside the declared set: ${outside.join(", ")}`;
  return cell;
}

const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

const countWord = (count) => COUNT_WORDS[count] ?? String(count);

const CLOSURE_LISTS = ["undriven", "missing", "duplicate"];

const COUNT_TAIL = "so the produced count above is of declared classes confirmed produced by a passing case, not of classes driven.";

const RECORD_LISTS = ["malformed", "uncovered", "undeclared"];

function contractName(entry) {
  return typeof entry?.contract === "string" && entry.contract !== "" ? entry.contract : "unnamed";
}

function requireProducedRecords(produced) {
  const unnamed = CLOSURE_LISTS.filter((name) => !Array.isArray(produced.closure?.[name]));
  if (unnamed.length > 0) {
    const noun = unnamed.length === 1 ? "list" : "lists";
    throw new Error(`the produced report records no ${unnamed.join(", ")} closure ${noun}`);
  }
  if (!Array.isArray(produced.contracts)) {
    throw new Error("the produced report records no contracts array");
  }
  for (const entry of produced.contracts) {
    const missing = RECORD_LISTS.filter((name) => !Array.isArray(entry?.[name]));
    if (missing.length === 0) continue;
    const noun = missing.length === 1 ? "array" : "arrays";
    throw new Error(`the produced report's contract ${contractName(entry)} records no ${missing.join(", ")} ${noun}`);
  }
}

// An exact repeat is one code path writing the same entry twice. Key order is
// part of that equality, which is what JSON.stringify compares.
function withoutRepeats(contracts) {
  const seen = new Set();
  const kept = [];
  for (const entry of contracts) {
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(entry);
  }
  return kept;
}

// A CommonMark code span. An empty name is words, because two backticks are
// not a span. The fence is one backtick longer than any run inside the text.
// A space is added at both ends when the text starts or ends with a backtick,
// and when it starts and ends with a space without being all spaces: CommonMark
// then strips exactly that padding.
function codeSpan(text) {
  if (text === "") return "an empty name";
  const runs = text.match(/`+/gu) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(longest + 1);
  const edgeBacktick = text.startsWith("`") || text.endsWith("`");
  const edgeSpace = text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "";
  const pad = edgeBacktick || edgeSpace ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

const quotedNames = (names) => names.map((name) => codeSpan(String(name))).join(", ");

function distinctRecordNames(contracts, field) {
  const seen = new Set();
  const names = [];
  for (const entry of contracts) {
    for (const name of entry[field]) {
      const key = `${entry.contract}\0${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

function namedDeviation(names, one, many) {
  if (names.length === 0) return null;
  const listed = quotedNames(names);
  if (names.length === 1) return one(listed);
  return many(countWord(names.length), listed);
}

const present = (clauses) => clauses.filter((clause) => clause !== null);

function unexecutedDeviation(cases) {
  const rows = cases.filter((entry) => Array.isArray(entry.unexecuted) && entry.unexecuted.length > 0);
  const count = rows.reduce((sum, entry) => sum + entry.unexecuted.length, 0);
  if (count === 0) return null;
  if (count === 1) return "one signature's function did not run during its case";
  const where = rows.length === 1 ? "case" : "cases";
  return `${countWord(count)} signatures' functions did not run during their ${where}`;
}

function harnessDeviation(cases) {
  const count = cases.reduce((sum, entry) => sum + (Array.isArray(entry.harness) ? entry.harness.length : 0), 0);
  if (count === 0) return null;
  if (count === 1) return "one signature names the produce-refusals harness, not a producer";
  return `${countWord(count)} signatures name the produce-refusals harness, not a producer`;
}

function malformedDeviation(contracts) {
  return namedDeviation(
    contracts.flatMap((entry) => entry.malformed),
    (listed) => `one driven case (${listed}) records no emitter it can be traced to`,
    (word, listed) => `${word} driven cases (${listed}) record no emitter they can be traced to`,
  );
}

const CLOSURE_DEVIATIONS = [
  {
    list: "undriven",
    one: (listed) => `one producing-cases file on disk is declared by no executed manifest (${listed})`,
    many: (word, listed) => `${word} producing-cases files on disk are declared by no executed manifest (${listed})`,
  },
  {
    list: "missing",
    one: (listed) => `one cases path that an executed manifest declares is outside the driven namespace (${listed})`,
    many: (word, listed) => `${word} cases paths that executed manifests declare are outside the driven namespace (${listed})`,
  },
  {
    list: "duplicate",
    one: (listed) => `one cases path is declared by more than one executed manifest (${listed})`,
    many: (word, listed) => `${word} cases paths are declared by more than one executed manifest (${listed})`,
  },
];

function closureDeviation(paths, kind) {
  return namedDeviation(paths, kind.one, kind.many);
}

function boundRunClause(qualifying, other) {
  if (qualifying.length === 0 && other.length === 0) return "";
  if (qualifying.length === 0) return ` The bound run is not clean — ${other.join("; ")}.`;
  const head = ` The bound run is not clean — ${qualifying.join("; ")} — ${COUNT_TAIL}`;
  if (other.length === 0) return head;
  const sentence = other.join("; ");
  return `${head} ${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/u;

/**
 * A store-composed refusal reason for the package page.
 *
 * The record keeps the store's verbatim string — that is the text a reader
 * compares against a real incident — and the project directory it was
 * measured under, so the machine-local path is substituted verbatim rather
 * than parsed: a path containing an apostrophe is still matched whole, where
 * a quote-bounded read would end the store's quoting early and leave a
 * volatile tail. What the substitution leaves may hold a quoted path outside
 * the project, which renders as outside and carries no path; anything else —
 * an unbalanced quote, an unquoted path fragment — means the reason cannot be
 * delimited safely, and the leading class is rendered with the path withheld
 * rather than half-rewritten.
 */
function seamReason(reason, projectDirs) {
  if (typeof reason !== "string") return "not recorded";
  const withhold = () => {
    const cls = reason.split(/['/]/u)[0].replace(/[\s:,]+$/u, "");
    return `${cls === "" ? "store refusal" : cls} — path withheld`;
  };
  // Every namespace the reason may embed — the project dir as passed and as
  // the loader realpathed it — substituted verbatim, longest first.
  let rendered = reason;
  const dirs = [...new Set([projectDirs].flat())]
    .filter((dir) => typeof dir === "string" && dir.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const dir of dirs) rendered = rendered.split(dir).join("<project>");
  const segments = rendered.split("'");
  // An odd apostrophe count means a path carried a quote of its own.
  if (segments.length % 2 === 0) return withhold();
  const out = [];
  for (const [index, segment] of segments.entries()) {
    if (index % 2 === 1) {
      // Inside the store's quoting: a `<project>` path is already rewritten;
      // a path outside the project is named as outside, carrying no path.
      out.push(segment.startsWith("/") ? "'<path outside the project>'" : `'${segment}'`);
    } else {
      // An unquoted path fragment cannot be delimited safely.
      if (segment.includes("/")) return withhold();
      out.push(segment);
    }
  }
  return out.join("");
}

/** Where the panel's round records live. */
export const PANEL_DIR = 'resources/design-candidate/panel';

/**
 * Each recorded panel round, whether the candidate lists it, and how many
 * anchor corrections it carries (debt 10h, R6-22).
 *
 * Membership is the `files[]` list alone. A round record is listed when the
 * design rests on something it carries — round 4's third anchor correction is
 * the operative membership rule, which `membershipRuleErrors` checks — and the
 * other records carry none: they are what a round found, checked by
 * `validatePanelRound` against the roster that round sat, whether listed or not.
 */
export async function panelRecords(candidate) {
  const listed = new Set(candidate.files.map((file) => file.path));
  const records = [];
  for (const name of (await readdir(path.join(ROOT, PANEL_DIR))).sort()) {
    if (!/^round-\d+\.json$/u.test(name)) continue;
    const relative = `${PANEL_DIR}/${name}`;
    const round = JSON.parse(await read(relative));
    records.push({
      path: relative,
      member: listed.has(relative),
      anchor_corrections: Array.isArray(round.anchor_corrections) ? round.anchor_corrections.length : 0,
    });
  }
  return records.sort((left, right) => Number(/\d+/u.exec(left.path.split('/').pop())[0]) - Number(/\d+/u.exec(right.path.split('/').pop())[0]));
}

/**
 * The `npm test` summary, read from the run's own log (debt 10h, a1 low).
 *
 * The builder took a pass count by flag and wrote `0 fail` itself, and the
 * skipped test went unreported. The totals and the skipped and failed names are
 * now read from the output of `node --test`, in the spec reporter (the default)
 * or TAP; a log without its summary lines is refused rather than read as zero.
 */
export function testSummary(log) {
  const lines = log.replace(/\r\n?/gu, '\n').split('\n');
  const KEYS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
  const counts = {};
  for (const line of lines) {
    const match = /^(?:ℹ|#) (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/u.exec(line);
    if (match) (counts[match[1]] ??= []).push(Number(match[2]));
  }
  const missing = KEYS.filter((name) => counts[name] === undefined);
  if (missing.length === KEYS.length) throw new Error('the test log carries no test summary');
  if (missing.length > 0) throw new Error(`the test log carries no complete test summary (${missing.join(', ')} not found)`);
  const blocks = Math.max(...KEYS.map((name) => counts[name].length));
  if (blocks !== 1 || KEYS.some((name) => counts[name].length !== 1)) {
    throw new Error(`the test log carries ${blocks} summary blocks — one run, one summary`);
  }
  const tap = lines.some((line) => /^\s*(?:not )?ok \d+ - /u.test(line));
  const skipped = [];
  const failed = [];
  const unescape = (name) => name.replace(/\\#/gu, '#');
  if (tap) {
    // TAP says whether a skipped entry is a test or a suite in its YAML block.
    for (const [index, line] of lines.entries()) {
      const entry = /^\s*(not )?ok \d+ - (.*)$/u.exec(line);
      if (!entry) continue;
      const directive = /^(.*?)(?<!\\) # (SKIP|TODO)\b ?(.*)$/iu.exec(entry[2]);
      const name = unescape(directive ? directive[1] : entry[2]);
      let type = 'test';
      for (const next of lines.slice(index + 1)) {
        if (/^\s*(?:not )?ok \d+ - /u.test(next)) break;
        const found = /^\s*type: '([a-z]+)'/u.exec(next);
        if (found) { type = found[1]; break; }
      }
      if (directive?.[2].toUpperCase() === 'SKIP' && type === 'test') skipped.push({ name, reason: directive[3] });
      if (entry[1] && directive?.[2].toUpperCase() !== 'TODO') failed.push(name);
    }
  } else {
    // The spec reporter prints a skipped suite like a skipped test; the names
    // then outnumber the count, and the build refuses rather than guess.
    for (const line of lines) {
      const spec = /^\s*﹣ (.+) \([\d.]+ms\) # (.*)$/u.exec(line);
      if (spec) skipped.push({ name: spec[1], reason: spec[2] === 'SKIP' ? '' : spec[2] });
    }
    const section = lines.findIndex((line) => /^✖ failing tests:\s*$/u.test(line));
    for (const line of section === -1 ? lines : lines.slice(section + 1)) {
      const failure = /^\s*✖ (.+) \([\d.]+ms\)$/u.exec(line);
      if (failure) failed.push(failure[1]);
    }
  }
  return {
    tests: counts.tests[0],
    passed: counts.pass[0],
    failed: counts.fail[0],
    cancelled: counts.cancelled[0],
    skipped: counts.skipped[0],
    todo: counts.todo[0],
    skipped_names: skipped,
    failed_names: failed,
  };
}

function requireTestEvidence(tests) {
  const numbers = ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo'];
  if (!tests || numbers.some((name) => !Number.isInteger(tests[name])) || !Array.isArray(tests.skipped_names) || !Array.isArray(tests.failed_names)) {
    throw new Error('the test evidence is not a summary read from a test log — run `npm test` and pass its output with --tests-log <file>');
  }
  if (tests.skipped_names.length !== tests.skipped) {
    throw new Error(`the test log reports ${tests.skipped} skipped test${tests.skipped === 1 ? '' : 's'} and ${tests.skipped_names.length} named — a skipped test is reported by name (a TAP log tells a skipped suite from a skipped test)`);
  }
  const unfinished = tests.failed + tests.cancelled;
  if (tests.failed_names.length !== unfinished) {
    throw new Error(`the test log reports ${unfinished} failed or cancelled test${unfinished === 1 ? '' : 's'} and ${tests.failed_names.length} named — each is reported by name`);
  }
}

/**
 * What each injection kind of the fault matrix means on the page. The groups
 * under each are read from the matrix and the kinds from the coverage rule's
 * own list (`INJECTION_KINDS`), which the validator holds the schema to; only
 * the meaning is written here (debt 10h, R6-20; review of 11f), and `npm test`
 * holds these keys to that list, so a kind cannot be rendered by one and
 * missed by the other.
 */
export const INJECTION_MEANINGS = Object.freeze({
  real_path: 'the fault is made against the daemon built from section 1\'s source, and the daemon answers on its own path — the one kind that counts toward the gate, and only where the run is also the fault the group designs.',
  measured_observation: 'the fault harness makes the fault in a temporary fixture — a file, a process, an environment, a Git repository — and hands a host guard values it read back from that fixture; no host driver, daemon or helper runs, so the state is `covered_by_host_function` and does not count toward the gate.',
  written_observation: 'the host guard is handed an observation the harness wrote, in whole or in the fields named on the row; the harness checks its fixture beside the guard, not through it.',
});

/**
 * What the page says of whether a group's run is the fault the group designs:
 * `yes`, or `no — <design_departure>` (the departure the matrix records, or
 * `not recorded`). Returned as text so the fault list and its readers see the
 * same words the matrix's `injection_matches_design` and `design_departure` give.
 */
function designMet(group) {
  return group.injection_matches_design === true ? 'yes' : `no — ${group.design_departure ?? 'not recorded'}`;
}

/**
 * The table cell for a group's `injection`: the kind in code font, followed by
 * the fields a `written_observation` writes, or `not declared` when the matrix
 * has no kind for it — so a row shows how its fault reached what answered.
 */
function injectionCell(group) {
  if (!group?.injection) return 'not declared';
  const written = Array.isArray(group.written_fields) && group.written_fields.length > 0
    ? `: ${group.written_fields.map((name) => `\`${name}\``).join(', ')}`
    : '';
  return `\`${group.injection}\`${written}`;
}

/** The package. Deterministic: the same inputs give the same bytes. */
export async function buildPackage({ commit, tree, candidate, cleanRoom, matrix, mutation, compat, tests, contracts, vocabulary, verdicts = panelVerdicts(), produced = null, migrationSeam = null, migrationSeamRefusal = null, panelRecords: givenPanelRecords = null, factoryCallers: givenFactoryCallers = null, autoPolicyCallers: givenAutoPolicyCallers = null, graph: givenGraph = null }) {
  requireTestEvidence(tests);
  const callers = givenFactoryCallers ?? await factoryCallers();
  const graph = givenGraph ?? JSON.parse(await read(GRAPH_PATH));
  const alignmentGap = alignmentReasonGap(graph);
  // Round 8 of #39, R8-3: whether anything in v1 reaches the auto-policy's
  // binding is read from the graph and the code, not typed — since the review
  // of 99fd30b (L1), from every way into the CAS and delivery, by the
  // validator's own measure, and so is the sentence that v1 has one authority.
  const acceptance = acceptanceAuthority(graph);
  const policyCallers = givenAutoPolicyCallers ?? await autoPolicyCallers();
  const oneAuthority = acceptance.exits.length > 0 && acceptance.actors.length === 1 && acceptance.actors[0] === 'human'
    && acceptance.bypasses.length === 0 && acceptance.entries.length === 0;
  const waysIn = [
    ...acceptance.bypasses.map((id) => `\`${id}\``),
    ...acceptance.entries.map((step) => `\`${step}\` as an entry step`),
  ];
  const codeList = (codes) => codes.map((code) => `\`${code}\``).join(', ');
  const srcCallers = callers.filter((file) => file.startsWith('src/'));
  const scriptCallers = callers.filter((file) => !file.startsWith('src/'));
  const fileList = (files) => files.map((file) => `\`${file}\``).join(', ') || 'none';
  const groupById = new Map(matrix.groups.map((group) => [group.id, group]));
  const records = givenPanelRecords ?? await panelRecords(candidate);
  for (const record of records) {
    const name = record.path.split('/').pop();
    if (record.anchor_corrections > 0 && !record.member) {
      throw new Error(`${name} carries ${record.anchor_corrections} anchor corrections and is not a member — the rule it carries would bind nothing`);
    }
    if (record.anchor_corrections === 0 && record.member) {
      throw new Error(`${name} is a member and carries no anchor correction — nothing the design rests on says why it is listed`);
    }
  }
  const gitRecorded = (cleanRoom.faults ?? []).length > 0
    && cleanRoom.faults.every((entry) => Array.isArray(entry.git_ref_writes?.fault) && Array.isArray(entry.git_ref_writes?.fixture));
  const gitFaultGroups = gitRecorded ? cleanRoom.faults.filter((entry) => entry.git_ref_writes.fault.length > 0) : [];
  const gitFixtureOnly = gitRecorded
    ? cleanRoom.faults.filter((entry) => entry.git_ref_writes.fault.length === 0 && entry.git_ref_writes.fixture.length > 0)
    : [];
  const unlinked = contracts.filter((entry) => (entry.evaluators ?? []).length === 0);
  const srcMeasured = unlinked.every((entry) => Array.isArray(entry.named_under_src)
    && Array.isArray(entry.src_references?.naming) && Array.isArray(entry.src_references?.named_paths));
  /**
   * Whether `src/` holds anything of a contract no evaluator is linked to: a
   * refusal it declares named in a src file, a src file naming the contract,
   * or a src path the contract names that exists.
   */
  const foundUnderSrc = (entry) => entry.named_under_src.length > 0
    || entry.src_references.naming.length > 0 || entry.src_references.named_paths.length > 0;
  const unreferenced = srcMeasured ? unlinked.filter((entry) => !foundUnderSrc(entry)) : [];
  const referenced = srcMeasured ? unlinked.filter(foundUnderSrc) : [];
  if (produced !== null) {
    if (!produced.source) {
      throw new Error("the produced report carries no source binding — nothing proves it ran on this tree");
    }
    const drift = sourceDrift(ROOT, produced.source);
    if (drift.length > 0) {
      throw new Error(`the produced report was produced on another tree: ${drift.join("; ")}`);
    }
    requireProducedRecords(produced);
  }
  if (migrationSeam === null) {
    // The band is required evidence; the only way out is a refusal the
    // package prints with its stated reason — silence is not an outcome.
    if (typeof migrationSeamRefusal !== "string" || migrationSeamRefusal.trim() === "") {
      throw new Error(
        "the migration-seam measurement is missing — run " +
          "`node scripts/verify-autosk-migration-seam.mjs <prefix> --record <file>` and pass --migration-seam <file>, " +
          'or decline it on record with --no-migration-seam "<reason>"',
      );
    }
  } else {
    if (migrationSeamRefusal !== null) {
      throw new Error("a migration-seam measurement and a recorded refusal of it cannot both be given");
    }
    if (!migrationSeam.bound?.source) {
      throw new Error("the migration-seam record carries no source binding — nothing proves it ran on this tree");
    }
    const seamDrift = sourceDrift(ROOT, migrationSeam.bound.source);
    if (seamDrift.length > 0) {
      throw new Error(`the migration-seam record was produced on another tree: ${seamDrift.join("; ")}`);
    }
    if (migrationSeam.bound.source_tree !== compat.result_tree) {
      throw new Error(
        `the migration-seam record measured patched source tree ${migrationSeam.bound.source_tree ?? "none"} — ` +
          `this package is built over ${compat.result_tree}`,
      );
    }
    // The source tree names tracked bytes only; the record must also bind the
    // executed surface it cannot name — the installed modules and the
    // store-lock helper the run executed. The binding is verified to be
    // coherent: its digest recomputes over exactly its recorded members, and
    // the helper the run spawned is one of them.
    const executed = migrationSeam.bound?.executed;
    const executedFiles = executed?.files;
    if (!Array.isArray(executedFiles) || executedFiles.length === 0 || !LOWERCASE_SHA256.test(executed?.digest ?? "")) {
      throw new Error("the migration-seam record binds no executed surface — installed modules and the store-lock helper are unnamed");
    }
    if (digestOf(executedFiles, []) !== executed.digest) {
      throw new Error("the migration-seam record's executed-surface digest does not recompute over its recorded members");
    }
    if (!LOWERCASE_SHA256.test(executedFiles.find((file) => file?.path === "bin/autosk-store-lock")?.sha256 ?? "")) {
      throw new Error("the migration-seam record does not bind the store-lock helper binary it executed");
    }
  }
  // The band's own checks are the builder's too: a record that fails them —
  // malformed, controls that cannot report present, an executed member
  // outside the install roots — is not a measurement the package may quote.
  const seamVerdict = migrationSeam === null ? null : classifySeam(migrationSeam);
  if (seamVerdict !== null && !seamVerdict.ok) {
    throw new Error(`the migration-seam record fails the band's own checks: ${seamVerdict.failures.join("; ")}`);
  }
  // The run and the matrix must agree on who ran what: a group the matrix
  // calls a real daemon path is not one the fault harness ran, and a
  // fault-harness group the run did not run has no row to stand on.
  if (cleanRoom.faults) {
    const ran = new Set(cleanRoom.faults.map((entry) => entry.id));
    for (const entry of cleanRoom.faults) {
      if (groupById.get(entry.id)?.injection === 'real_path') {
        throw new Error(`${entry.id}: the matrix calls it real_path, and the fault harness ran it`);
      }
    }
    for (const group of matrix.groups) {
      if (group.injection !== 'real_path' && !ran.has(group.id)) {
        throw new Error(`${group.id}: the matrix calls it ${group.injection}, and the fault harness did not run it`);
      }
    }
  }
  // Review of 11f (M1): the coverage this package prints is recomputed from
  // the run's own records, and those records are about the tree the run
  // exercised — so the run must have exercised this package's tree, clean.
  if (typeof cleanRoom.extension?.tree !== 'string' || cleanRoom.extension.tree.length === 0) {
    throw new Error('the clean-room run recorded no extension tree, so nothing says which bytes its records are about');
  }
  if (cleanRoom.extension.dirty === true) {
    throw new Error(`the clean-room run exercised a dirty worktree of ${cleanRoom.extension.tree} — its records are about bytes in no commit`);
  }
  // CodeRabbit on #271: a run whose extension moved while it ran records
  // `dirty: null` and names both identities; neither is the one it read.
  if (cleanRoom.extension.dirty !== false) {
    const why = cleanRoom.extension.error ? `: ${cleanRoom.extension.error}` : '';
    throw new Error(`the clean-room run cannot say its worktree of ${cleanRoom.extension.tree} was clean${why} — its records may be about bytes in no commit`);
  }
  if (cleanRoom.extension.tree !== tree) {
    throw new Error(`the clean-room run exercised tree ${cleanRoom.extension.tree}, and this package is built over ${tree}`);
  }
  // Debt 11f (R7-6) and its review (M1): the round-7 run counted all twenty
  // groups `covered_by_real_fault`. The coverage is recomputed with the run's
  // own functions from its records, and a report that says anything else —
  // rows, counts or `complete` — is refused, not reprinted.
  const coverage = coverageReport(matrix, {
    ...harnessCoverage(cleanRoom.steps ?? []),
    ...faultCoverage({ results: cleanRoom.faults ?? [] }),
  });
  const coverageErrors = coverageRefusals(cleanRoom.coverage, coverage, matrix);
  if (coverageErrors.length > 0) throw new Error(coverageErrors.join('; '));
  const sections = [];
  const classes = contracts.reduce((sum, entry) => sum + entry.refusals.length, 0);
  const producedBy = new Map((produced?.contracts ?? []).map((entry) => [entry.contract, entry]));
  const open = contracts.filter((entry) => entry.refusals.length === 0);
  // A whole heading, not a substring: "never the latest source" and
  // "Attestation binds a candidate" are not test sections.
  const requiredTests = contracts.filter((entry) =>
    entry.headings.some((heading) => /^\d+\.\s+required (implementation|runtime) tests$/iu.test(heading)),
  );
  // Repeats are removed before anything is counted. A contract entry that
  // JSON.stringify equals an earlier entry was written by the same code path
  // and counts once. Case rows are not deduplicated, and two entries for one
  // contract path that differ both count.
  // Uncovered and undeclared then count distinct (contract path, name) pairs.
  // The clause names each of the runner's seven exit conditions that fired,
  // from these records and never from an aggregate. An exit-0 report, whose
  // records are empty, gets no clause. A failed case, an unexecuted signature
  // and a harness signature are read from the case rows. Uncovered, undeclared
  // and malformed names come from each counted contract entry. Unclosed paths
  // come from the closure lists (undriven, missing, duplicate). The tail
  // follows only a failed case, an uncovered class or an undeclared class:
  // those are what can make the produced count differ from the driven classes.
  const declaredBy = new Map(contracts.map((entry) => [entry.path, new Set(entry.refusals)]));
  const countedContracts = produced === null ? null : withoutRepeats(produced.contracts);
  const producedCases = (countedContracts ?? []).flatMap((entry) =>
    (entry.cases ?? []).map((entryCase) => ({ ...entryCase, contract: entry.contract, declared: declaredBy.get(entry.contract) ?? new Set() })),
  );
  const passingCases = producedCases.filter((entryCase) => entryCase.pass === true);
  const producedClasses = produced === null ? null
    : new Set(passingCases.flatMap((entryCase) => (entryCase.produced ?? []).filter((code) => entryCase.declared.has(code)))).size;
  const drivenClasses = new Set(producedCases.map((entryCase) => entryCase.class).filter((name) => name !== undefined)).size;
  const drivenClassLabel = drivenClasses === 1 ? "refusal class" : "refusal classes";
  const contractCount = countedContracts === null ? 0
    : new Set(countedContracts.map((entry) => entry.contract)).size;
  const contractLabel = contractCount === 1 ? "contract" : "contracts";
  const daemonJudged = produced === null ? null
    : new Set(passingCases.filter((entryCase) => entryCase.predicate_owner === "daemon").map((entryCase) => entryCase.class)).size;
  const ticketLifecycleLabel = daemonJudged === 1 ? "ticket-lifecycle class" : "ticket-lifecycle classes";
  const failedCases = produced === null ? 0 : producedCases.length - passingCases.length;
  const qualifying = produced === null ? [] : present([
    failedCases === 0 ? null : `${countWord(failedCases)} case${failedCases === 1 ? "" : "s"} failed`,
    namedDeviation(
      distinctRecordNames(countedContracts, "uncovered"),
      (listed) => `one declared class has no case in its manifest (${listed})`,
      (word, listed) => `${word} declared classes have no case in their manifest (${listed})`,
    ),
    namedDeviation(
      distinctRecordNames(countedContracts, "undeclared"),
      (listed) => `one driven class is not declared by its contract (${listed})`,
      (word, listed) => `${word} driven classes are not declared by their contract (${listed})`,
    ),
  ]);
  const other = produced === null ? [] : present([
    unexecutedDeviation(producedCases),
    harnessDeviation(producedCases),
    malformedDeviation(countedContracts),
    ...CLOSURE_DEVIATIONS.map((kind) => closureDeviation(produced.closure[kind.list], kind)),
  ]);
  const boundRun = boundRunClause(qualifying, other);
  sections.push(`# autosk-traycer-flow — final acceptance package

This package is read-only. It names one frozen version and asks four questions
about it. Every seat receives these exact bytes.

## 1. The version under review

| field | value |
| --- | --- |
| repository | Valeron2206/autosk-traycer-flow |
| main commit | \`${commit}\` |
| main tree | \`${tree}\` |
| design candidate | \`${candidate.candidate_id}\` |
| candidate digest | \`${candidate.candidate_digest}\` |
| candidate files | ${candidate.files.length} |
| attestation state before this panel | \`${candidate.attestation.state}\` |

The candidate digest is recomputable from section 3 alone. The rule, as
\`scripts/validate-design-candidate.mjs\` implements it, is

\`\`\`
candidate_digest = sha256( join("\\n", sort( map(files, f => f.path + " " + f.sha256) )) )
\`\`\`

over the UTF-8 bytes of that joined string, with no trailing newline. Section 3
carries the full 64-hex digest of every file for that reason: a truncated
digest cannot be recomputed, and a verdict about a digest nobody can recompute
is a verdict about a claim.

### What is being delivered

The extension is this repository. The daemon it runs against is **not** upstream
\`autosk\` as published: it is upstream plus a pinned patch series, and the
distinction matters because the design rests on three primitives (ADR-014,
ADR-023, ADR-025) that upstream does not implement — the series supplies the first of them and not the other two.
Section 5 names what is missing and what refuses to run without it.

| field | value |
| --- | --- |
| upstream repository | ${compat.upstream.repository} |
| upstream commit | \`${compat.upstream.commit}\` |
| upstream tree | \`${compat.upstream.tree}\` |
| pinned patches | ${compat.patches.length}, each SHA-256 pinned in \`compat/autosk/manifest.v1.json\` |
| resulting source tree | \`${compat.result_tree}\` |

The clean-room run in section 5 built exactly that tree.`);

  sections.push(`## 2. What the seats are asked

Four questions, in this order. Answer each one about the version above.

1. **Is the design internally consistent?** One system, or several that
   contradict each other in places.
2. **Is anything load-bearing missing or only described?** A rule that nothing
   evaluates, a refusal class nothing can produce, a guarantee whose mechanism
   is absent.
3. **Is the evidence in section 5 what it claims to be?** Say plainly where a
   claim outruns what was actually run.
4. **Are there Critical or High findings that should block acceptance?**

A seat that cannot answer a question says so. An answer of "looks fine" without
having read the material is worse than no answer, because it is counted.

This panel is asked about the **design and the evidence**, not about whether
every issue in the program is finished. Section 5's "what is not claimed" list
is part of what you are reviewing: if something there should not have been
deferred, that is a finding.`);

  sections.push(`## 3. The design pack, by path and full digest

${candidate.files.length} files. The ${FULL_TEXT.length} marked **full text** are
reproduced whole in section 6; the rest are named here with their complete
digests, so section 1's candidate digest can be recomputed from this table and
any file can be checked against the repository at the commit above.

| path | sha256 | in this package |
| --- | --- | --- |
${candidate.files.map((file) => `| \`${file.path}\` | \`${file.sha256}\` | ${FULL_TEXT.includes(file.path) ? 'full text' : 'digest only'} |`).join('\n')}`);

  sections.push(`## 4. The contracts, by rule inventory

Each contract's sections and its closed refusal set, read from both forms a
contract may use — the inline \`Closed set:\` sentence and the bulleted
\`Refusal classes\` section.

**${contracts.length} contracts, ${classes} refusal classes, ${open.length} declaring no closed set.**
${open.length > 0 ? `Declaring none: ${open.map((entry) => `\`${entry.path}\``).join(', ')}.` : 'Every contract closes its own set.'}

The park reasons those classes feed are enumerated separately in
\`resources/refusal-vocabulary/refusal-vocabulary.v1.json\` and checked by
\`npm run validate:refusal-vocabulary\`, which binds each reason to a registered
workflow step and records whether this repository or the daemon produces it.

**${vocabulary.park_reasons.length} park reasons.** ${vocabulary.park_reasons.filter((entry) => entry.closed_by.startsWith('docs/')).length}
are closed by the artifact contract they belong to; the remaining
${vocabulary.park_reasons.filter((entry) => !entry.closed_by.startsWith('docs/')).length} are the workflow's own vocabulary and are owned by the
resume contract in \`03-technical-plan.md\` §7. That is why the alignment park
reasons appear in no contract's closed set above and are still owned: the owner
is a recorded field, not an inference. Each entry in the vocabulary names it,
and the validator refuses an entry with no owner, an entry naming a document
that does not close it, and a name two contracts declare.

${vocabulary.park_reasons.filter((entry) => entry.producer === 'host').length} are produced by runtime code in this repository, checked by naming or by
the recorded emitter. The rest are declared ownership, not measured:
${vocabulary.park_reasons.filter((entry) => entry.producer === 'daemon').length} are declared the daemon's side, and
${vocabulary.park_reasons.filter((entry) => entry.producer === 'none').length} are declared by the design and produced by nothing yet (section 5).
Runtime code that produced either kind would refute the declaration; nothing
here checks either kind against the patch series in section 1.

**Where each contract's rules are evaluated.** A closed rule set with nothing
that runs it is a design obligation, not an implemented one, and the difference
belongs on the row rather than in a reader's inference. Three facts are kept
apart. A script that reads the contract document is not a module whose guards the
mutation table scored. Each module says **how** it was linked, because the three
links are not equal evidence: \`imported by\` follows a reader into the code it
runs, \`declared\` is the module's own \`Implements:\` line, and \`name match only\`
is this repository's filename convention and nothing more. And the last column is
the only measurement here about the rules themselves — how many of the refusal
classes the contract declares are named in the modules linked to it.

Read the limits of this table exactly. A link is where to look, not proof that
the rules run, and a refusal class named in a module may still be produced on a
path nothing reaches. \`no link measured\` means these three measurements found
nothing — **not** that nothing evaluates the contract. Two implementations whose
names no convention could reach were missed exactly that way before the links
were measured.

One more column is a different kind of fact, and the difference is the point of
it. \`refusal classes named there\` counts a class appearing in the text of a
linked host module; \`produced\` reports \`npm run produce:refusals\` on this
tree — every declared case driven to refusal and the produced code compared to
its class by exact string. The report binds the bytes it ran on — every file
the run reads plus the membership of each directory its scans enumerate,
measured against the run itself under the fs instrument, and every bound
name must be its own physical path: the same bytes reached through a link
are a different input — and a package built
on a different tree refuses the column rather than printing a number produced
elsewhere. A file is bound because the run opened it, which makes it a
dependency, not a proof that the production needed it. Five of the
produced classes are ticket-lifecycle
reasons whose predicate is the daemon's judgment: the cell records that the
host writes the class when the predicate holds, not that the host judges the
predicate. Three produced codes are the graph's own park reasons, which no
edge and no step can carry — they surface at the factory's exported boundary,
but by different routes: \`no_transition_reason\` is \`select\` over a
synthetic document, because the schema forbids the shape that reaches it;
\`resume_target_not_permitted\` and \`transition_not_declared\` are
\`permitsResume\` and \`admit\` refusing a move the document does not allow,
over the shipped, schema-valid document itself. A row with no
producing case reports the absence rather than implying one.

| contract | rules evaluated in | refusal classes named there | produced | document read by |
| --- | --- | --- | --- | --- |
${contracts.map((entry) => {
    const readers = entry.readers ?? [];
    const evaluators = entry.evaluators ?? [];
    const evaluated = evaluators.map((evaluator) => {
      const scored = mutation.modules.find((row) => row.module === evaluator.module);
      const score = !scored
        ? 'not in the mutation table'
        : scored.mutants === 0
          ? 'no mutable guard'
          : `${scored.killed}/${scored.mutants}`;
      const link =
        evaluator.link === 'import'
          ? `imported by ${evaluator.via.map((name) => `\`${name}\``).join(', ')}`
          : evaluator.link === 'implements'
            ? 'declared'
            : 'name match only';
      return `\`${evaluator.module}\` (${score}, ${link})`;
    });
    const named = evaluators.length === 0
      ? 'not measured — no module linked'
      : `${entry.refusals_named ?? 0} of ${entry.refusals.length}`;
    const producedText = producedBy.has(entry.path)
      ? producedCell(producedBy.get(entry.path), entry.refusals)
      : 'not in the produced run';
    return `| \`${entry.path}\` | ${evaluated.join('; ') || 'no link measured'} | ${named} | ${producedText} | ${readers.map((name) => `\`${name}\``).join(', ') || 'nothing in `scripts/` names it'} |`;
  }).join('\n')}

${contracts.map((entry) => `### ${entry.path}

Sections: ${entry.headings.join('; ')}

${entry.refusals.length > 0 ? `Closed refusal set (${entry.form}): ${entry.refusals.map((name) => `\`${name}\``).join(', ')}` : 'No closed refusal set is declared in this document.'}`).join('\n\n')}`);

  sections.push(`## 5. Evidence

### Tests

\`npm test\` on the frozen commit: **${tests.passed} pass, ${tests.failed} fail, ${tests.cancelled} cancelled, ${tests.skipped} skipped** of ${tests.tests} tests${tests.todo > 0 ? ` (${tests.todo} todo)` : ''}, read from
the run's own log rather than typed in.${tests.skipped_names.length > 0 ? ` Skipped: ${tests.skipped_names.map((entry) => `${entry.name}${entry.reason ? ` — ${entry.reason}` : ''}`).join('; ')}.` : ''}${tests.failed_names.length > 0 ? ` Failed or cancelled: ${tests.failed_names.join('; ')}.` : ''}

### Mutation

Reproducible as \`node scripts/mutation-report.mjs\`, not deferred to a pull
request. Each guard is neutered one at a time and the module's own test file is
re-run; a mutant that survives is a missing test, a dead guard, or an equivalent
mutant, and the third is allowed only where somebody has written down why, at
the line it applies to.

| field | value |
| --- | --- |
| modules with at least one mutable guard | ${mutation.modules.filter((entry) => entry.mutants > 0).length} of ${mutation.totals.modules} |
| modules with none, which prove nothing about test strength | ${mutation.modules.filter((entry) => entry.mutants === 0).map((entry) => '\`' + entry.module + '\`').join(', ') || 'none'} |
| mutants | ${mutation.totals.mutants} |
| killed | ${mutation.totals.killed} |
| survivors | ${mutation.survivors.length}, all named in \`resources/mutation-report/mutation-survivors.v1.json\` |
| report digest | \`${mutation.report_digest}\` |

What is mutated is exactly this and nothing else: ${mutation.rules.map((rule) => `\`${rule}\``).join(', ')}.
A broader hand-run procedure was used while each module was written and its
counts are in the pull requests; the number above is the one this command
reproduces, and the two are not the same number.

### Clean-room end-to-end

One command, an isolated HOME with no Traycer, the pinned source built from
source, and both product harnesses plus the fault harness.

| field | value |
| --- | --- |
| upstream commit | \`${cleanRoom.upstream_commit}\` |
| reproduced source tree | \`${cleanRoom.source_tree}\` |
| extension commit exercised | \`${cleanRoom.extension?.commit ?? 'not recorded'}\` |
| extension tree exercised | \`${cleanRoom.extension.tree}\` |
| worktree clean at run time | yes |
| same bytes as the version under review | yes — the exercised tree equals the main tree in section 1; the package refuses a run over other bytes or a dirty worktree |
| report digest | \`${cleanRoom.report_digest}\` |
| overall | ${cleanRoom.ok ? 'ok' : 'FAILED'} |

Steps: ${cleanRoom.steps.map((step) => `${step.step}=${step.ok === false ? 'FAIL' : 'ok'}`).join(', ')}.

### Migration seam

${migrationSeam === null
    ? `The migration-seam band did not run for this build — a recorded refusal,
not silence. The stated reason: "${migrationSeamRefusal}"`
    : `Measured by \`node scripts/verify-autosk-migration-seam.mjs\` on the pinned
source tree. The record binds the patched tree as git names it, the measurer's
own bytes, and the executed bytes git cannot name — the installed module tree
and the store-lock helper — and the script bytes were re-verified against this
package's tree, so these are this tree's values, not a run made elsewhere.

| field | value |
| --- | --- |
| measured source tree | \`${migrationSeam.bound.source_tree}\` |
| executed bytes | ${migrationSeam.bound.executed.files.length} files outside the tracked tree — digest \`${migrationSeam.bound.executed.digest}\` |
| workflow | \`${migrationSeam.workflow}\` |
| pinned before the move | \`${migrationSeam.migrated_task?.pin_before?.pin?.pin?.digest ?? migrationSeam.migrated_task?.pin_before?.pin?.state}\` — helper ${seamVerdict.control.read_back_before_migration} |
| migrate plan | ${migrationSeam.migration?.plan?.supported === true ? `supported — \`${migrationSeam.migration.plan.from}\` → \`${migrationSeam.migration.plan.to}\`` : `refused — ${migrationSeam.migration?.plan?.reason ?? 'no plan'}`} |
| migrate apply | ${migrationSeam.migration?.apply?.ok === true ? `sealed receipt \`${migrationSeam.migration.apply.receipt.id}\`` : `did not seal — ${migrationSeam.migration?.apply?.reason ?? 'no receipt'}`} |
| pinned after the move | \`${migrationSeam.migrated_task?.pin_after?.pin?.pin?.digest ?? migrationSeam.migrated_task?.pin_after?.pin?.state}\` — helper ${seamVerdict.measured.helper} |
| resume answer | ${seamVerdict.measured.resume}${seamVerdict.measured.refusal ? ` — \`${seamVerdict.measured.refusal}\`` : ''} |
| old distribution record | bytes_held=${migrationSeam.old_distribution?.bytes_held} — ${seamReason(migrationSeam.old_distribution?.not_held_reason, [migrationSeam.project_dir, migrationSeam.project_dir_physical])} |
| controls | pre-migration read-back ${seamVerdict.control.read_back_before_migration}; fresh admission ${seamVerdict.control.fresh_admission_helper}, resume ${seamVerdict.control.fresh_admission_resume} |

A repository-side band measures the migration seam on the pinned, patched
source: it records what the runtime identity pin held before the move, what it
held after, and what resume answered, together with the state of the old
distribution's held bytes. It reports a measured fact rather than a required
property — today \`helper\` is ${seamVerdict.measured.helper} after the move and
resume ${seamVerdict.measured.resume === "refused" ? `refuses${seamVerdict.measured.refusal ? ` \`${seamVerdict.measured.refusal}\`` : ""}` : `is ${seamVerdict.measured.resume}`} — and the package refuses to build without that
measurement or a recorded reason for its absence. The measurement is bound to
the patched tree, to the measurer's own bytes and to the importable surface it
ran against, including installed modules git does not track. It does not
exercise the RPC or CLI path, does not perform a step transition, and attests
nothing about the runtime it ran under.
`}

### The fault matrix, with its denominator

**${matrix.groups.length} groups**, which is the denominator for the coverage
counts below. They are, in full:

${matrix.groups.map((group) => `- \`${group.id}\` (${group.boundary}) — designed: ${group.description}. Injected: ${group.injection_note ?? 'not recorded'}. Run is the designed fault: ${designMet(group)}.`).join('\n')}

Each line gives the group as the matrix designs it and as the run injects it
(\`injection_note\`), because the two differ, and says whether the run is the
designed fault (\`injection_matches_design\`, and \`design_departure\` where it is
not): read the injected fault as what the rows below are evidence of.

Coverage, by state: ${COVERAGE_STATES.map((state) => `${state}=${coverage.counts[state]}`).join(', ')}; complete=${coverage.complete}.
Only \`covered_by_real_fault\` counts toward the release gate (#36): the designed
fault (\`injection_matches_design\`), made against the built daemon
(\`real_path\`), was detected, and its control stayed silent. Every other state
names what is missing (the clean-room contract, §7) — a fault the run made in
place of the designed one (\`covered_by_substitute_fault\`), a host function's
answer to a fixture (\`covered_by_host_function\`), a control not asked, a
guard handed a written observation — and \`complete\` is true only when every
group is in that one. The gate counts ${coverage.counts.covered_by_real_fault}
of ${matrix.groups.length} groups: ${coverage.rows.filter((row) => row.state === 'covered_by_real_fault').map((row) => `\`${row.id}\``).join(', ') || 'none'}.

**Who converts a group to the product path.** #36 owns the conversion, and each
group that is not the designed fault on the product path names in the matrix
(\`product_path_owner\`) what must exist before #36 can convert it. A group
whose guard belongs to a host driver or the helper becomes \`real_path\` by a
decision, when the extension entry point (#18) reaches that driver or helper and
a harness meets the fault through it. \`F001\` has no owner and does not count
either: it is the designed fault on the product path, and counts once #36's
crash harness asks a control.

${matrix.groups.filter((group) => group.product_path_owner).map((group) => `- \`${group.id}\` — ${group.product_path_owner}`).join('\n')}

**How each group is injected.** Read from the matrix's \`injection\` field, which
\`npm run validate:clean-room\` holds to the harness that runs the group: a
\`real_path\` group has no case in \`scripts/clean-room-faults.mjs\`, every other
group has one, and each field a \`written_observation\` names is written as a
literal in that case's source.

${INJECTION_KINDS.map((kind) => {
    const groups = matrix.groups.filter((group) => group.injection === kind);
    return `- \`${kind}\` — ${groups.length} groups (${groups.map((group) => `\`${group.id}\``).join(', ') || 'none'}): ${INJECTION_MEANINGS[kind]}`;
  }).join('\n')}

No case of the fault harness runs a host driver or the daemon: each asks a pure
host function about a fixture it built. A \`measured_observation\` row shows a host
function's answer to a real fixture, which is not the product path meeting the
fault; a \`written_observation\` row shows the guard's answer to a described state,
not its answer to the fault.

**Git, run directly.** ${gitRecorded
    ? `The run records, per case, the git commands that write a ref which the
harness itself ran in its temporary repository, fixture setup apart from the
fault step. ${countWord(gitFaultGroups.length).replace(/^./u, (first) => first.toUpperCase())} groups ran such a command as their fault step — ${gitFaultGroups.map((entry) => `\`${entry.id}\`: ${entry.git_ref_writes.fault.map((command) => `\`${command}\``).join(', ')}`).join('; ') || 'none'} — and
${countWord(gitFixtureOnly.length)} more ran them only to build the fixture (${gitFixtureOnly.map((entry) => `\`${entry.id}\``).join(', ') || 'none'}). None of them goes through a host driver, the daemon or a ref-custody helper.`
    : 'This run did not record which git commands its cases ran, so nothing is said here about which groups touch Git directly.'}

Most groups are also **paired with a control** — the same guard, asked about the
state without the fault, has to stay silent — and the rows marked \`not paired\`
are not: the crash harness injects at a point in a write and never asks the
un-faulted question. For those the package cannot rule out a guard that would
refuse the un-faulted state too.

The per-case result is given rather than the count it rolls up into:

Every group of the matrix appears here, as the run's own records give it: a
fault-harness group's detection and control are its case record's, a daemon
group's its harness step's. The row names the harness that ran it, how the
fault reached what answered (the matrix's \`injection\`, with the fields a
written observation writes), whether the run is the designed fault, and whether
a control was paired, so a partial row is not read as a missing one.

| group | harness | injection | run is the designed fault | fault detected | control silent | evidence |
| --- | --- | --- | --- | --- | --- | --- |
${coverage.rows.map((row) => {
    // Read from the case record where there is one (as before debt 11f), and
    // otherwise from the row recomputed from the harness steps.
    const record = (cleanRoom.faults ?? []).find((entry) => entry.id === row.id);
    const detected = (record ? record.detected === true : row.detected) ? 'yes' : 'NO';
    const control = record ? (record.control === true ? 'yes' : 'NO')
      : row.control === true ? 'yes' : row.control === false ? 'NO' : 'not paired';
    return `| \`${row.id}\` | ${row.harness ?? 'none'} | ${injectionCell(groupById.get(row.id))} | ${row.injection_matches_design ? 'yes' : 'NO'} | ${detected} | ${control} | ${(record ? record.detail : row.evidence) ?? 'not covered'} |`;
  }).join('\n')}

### Mutation, module by module

| module | test file | mutants | killed |
| --- | --- | --- | --- |
${mutation.modules.map((entry) => `| \`${entry.module}\` | \`${entry.test}\` | ${entry.mutants} | ${entry.killed} |`).join('\n')}

### What is not claimed

- Two of the three daemon primitives the design rests on are implemented
  nowhere. The pinned series supplies ADR-014 (\`task.creation-binding\` v2). It
  does not supply ADR-023 — the signed \`UserDecisionRecord\` journal, the
  protected authority, dependency, intent and result heads, \`authorityGuard\`,
  \`integrateApproved\` — or ADR-025 — step-capability metadata CAS,
  \`orchestrateChildBatch\`, gate-result receipts — and no module in this
  repository implements either. The ref-custody helper of 02 §2
  (\`src/git/ref-custody-helper.ts\`) does not exist: patches \`0016\`–\`0022\` and
  \`0024\` are the store-lock helper, its protocol and trusted-state write fixes,
  and no patch touches \`refs/autosk\`, so no fault group shows anything about a helper-mediated CAS or the
  model account's boundary: ${gitRecorded
    ? `the groups whose fault step writes a ref (${gitFaultGroups.map((entry) => `\`${entry.id}\``).join(', ') || 'none'}, as the run
  recorded them) run the harness's own git commands, and none of them goes through a host driver, the daemon or a ref-custody helper (section 5).`
    : 'the run did not record which fault groups write a ref, and none of the fault harness\'s cases runs a host driver or the daemon (section 5).'} The preflight names
  ${UNPINNED_DAEMON_PRIMITIVES.map((primitive) => `\`${primitive.name}\` (${primitive.adr})`).join(' and ')} as required and unpinned — no revision, no
  methods — so the preflight refuses every daemon today, including the one this series builds.
  Outside tests \`requireDaemonCapabilities\` has one caller, the doctor check
  \`daemon.capabilities_pinned\`, which hands it the daemon's \`meta.capabilities\`
  report and decides nothing itself; doctor does not contact the daemon, so on a real host the check has
  no report and is \`unverifiable\`, and every model workflow's preflight set
  requires it. The call at extension load, before any model launch, has no
  call site: the extension entry point does not exist. None of this is a
  delivered capability. Matrix v1 gives each primitive the preflight requires
  to a \`required_for_v1\` record (ADR-092): ADR-023 to #4 (signer, journal,
  heads) and #9 (\`authorityGuard\`, \`integrateApproved\`), ADR-025 to #18, to
  be delivered as patches \`0052\`+;
  the daemon capability check to #34, the call at extension load to #18's entry point and the function it calls to #11 (ADR-097);
  the typed SDK of #38 stays \`planned_after_v1\`, and the validator holds the
  matrix to the preflight both ways.
- The signer boundary is not established on any host. \`security.signer_boundary\`
  passes only when the declared endpoint is refused to the probing process and
  the daemon reports a signer identity outside it; no daemon of the series
  reports one (its \`meta.capabilities\` names only \`task.creation-binding\`),
  so the check never passes and every model workflow's preflight set is
  unsatisfied. The workflow preflight is keyed by the graph's eight
  \`workflows[]\` and requires the boundary of each; its required sets' one
  caller outside tests is \`autosk-flow doctor --workflow\`, and nothing calls
  the preflight before a model launch yet (ADR-090);
  that dispatch gate is #34's in matrix v1 (ADR-097), and its call before each model launch is #18's launch path (ADR-102).
- The model account, its launch mechanism and both checks are design with owners, implemented nowhere.
  Every model process the series starts, \`claude-agent\`'s and \`pi-agent\`'s among them,
  is a child of autoskd under autoskd's uid, the installing user's: no patch of the series drops a uid
  (patch \`0028\`'s \`autoskEnv\` sets only the environment). The platform contract's §5b gives
  them a dedicated unprivileged account, \`autosk-model\`, which the privileged install creates
  together with the one mechanism autoskd starts model processes under it through,
  a sudoers rule limited to the model runtimes or a service-manager unit, never a setuid binary of this project,
  which kills a model process tree whole on a timeout, since autoskd cannot signal another uid;
  the account opens no Git directory of the project and reaches no signer, secure store,
  keychain or autoskd's RPC token. Until that exists, a model process holds autoskd's rights over the project's Git
  directory, the target ref included, and over the installing user's keychain.
  The ref-custody helper runs as the installing user, and the project's Git directory stays the user's (§5a):
  a protected ref the user's own tools move is found by the helper's compare-and-swap, not denied by the OS. The doctor checks
  \`security.model_account\`, which every model workflow requires, and \`security.ref_custody\`,
  which every workflow that reaches a step asking the ref-custody helper requires — \`autosk-planned\`, \`autosk-quick\` and \`autosk-ticket\`,
  as the graph derives them — answer \`unverifiable\`: no probe
  of either exists, so nothing parks \`ref_custody_unavailable\` at project open,
  and no platform park reason of its §7 has a producer.
  The ref-custody policy's schema admits the ADR-102 profile, the helper as the installing user, beside its committed example,
  which predates ADR-102: the example's digest is computed over the example alone
  and carried by the committed signed goldens, which #5 signs again when the example changes.
  Matrix v1 gives #13 the account, its launch mechanism and both probes, #11 the model process environment, #18 the launch path, and #5 with #13 the helper's bootstrap (ADR-102).
- The host asks the helper under the asking operation's identity, and a staging apply keeps it across a crash (ADR-108): the request carries
  \`owner_operation_id\` and \`request_id\`, and \`applyDelta\` records a recipe of its commit in a durable journal before it asks, so a retry that
  finds the staging ref at the recipe's commit completes the receipt and asks nothing. What is design and not code: the daemon-side intent
  found by that pair, its journal and the helper (#5), the journal file's product wiring and the receipt's caller (#8 with #9), and the delivery
  handler that reads the anchor and the acceptance identity before its hand-off, which the graph's \`deliver_staging\` edges stop for (#17, with #18's
  predicate table). No fault group injects a crash between the helper's commit and the receipt.
- ${srcCallers.length === 0
    ? `No product code evaluates the graph. \`buildWorkflow\` takes the caller's
  predicate evaluator and applies it at both decision sites; the files whose
  code uses it — calling it, passing it on, importing it or writing it into a
  module they generate — are ${fileList(scriptCallers)}, scripts that drive
  the daemon or produce refusals; no file under \`src/\` calls it or uses it
  any other way, JavaScript or TypeScript, so nothing under \`src/\` registers
  the graph's workflows either.`
    : `\`buildWorkflow\` takes the caller's predicate evaluator and applies it at
  both decision sites; the files whose code uses it are ${fileList(scriptCallers)},
  and ${fileList(srcCallers)} under \`src/\`, and whether a user under
  \`src/\` hands it a product evaluator is not measured here.`} The factory does
  not read \`guards[].authority\`, which says who may take a transition
  (the workflow-factory contract, §1). Matrix v1 gives the evaluator mechanism —
  the table from each predicate id to its implementation, applied at both
  decision sites to the predicate and to \`guards[].authority\` — and the
  extension entry point that registers every workflow the graph registers, the
  two Arena workflows among them, to #18 (\`enforcement_points\`, ADR-097);
  each predicate names its domain, the matrix names one owner for each domain
  (\`predicate_domains\`, ADR-107) and that owner's module decides what the
  predicate says, and \`validate:capabilities\` reads those points and those
  domains from the graph.
- A model session can still reach a creation credential and the leaves that
  admit a resume. Patch \`0028\`'s \`autoskEnv\` puts \`AUTOSK_SESSION_TOKEN\`,
  the credential \`task.create_bound\` takes, into the environment of the
  \`claude-agent\` and \`pi-agent\` model processes, and
  \`src/host/workflow-factory.mjs\` writes the leaves it reads to admit a resume
  (\`park.reason\`, \`park.origin\`, \`park.receipts.<step>\`) through plain
  \`autosk metadata set\`, which any holder of the CLI can run, and reads one more it does not write, \`park.decision\`,
  which the same command writes: a model session could mint a bound create or
  forge a receipt that opens a resume; a forged \`park.decision\` opens nothing without a verified record
  (below). 02 §2 gives
  a model session no CLI or decision capability; that is the design, not this
  series. Matrix v1 gives the token's removal to #11 and resume leaves written
  only under the metadata CAS to #18 (ADR-097); roadmap #231 tracks the change.
- No user decision is accepted on any host today. The decision queue takes an answer
  only as a daemon \`UserDecisionRecord\` — a response that names its own
  approver, or carries no record, is refused — and checks its fields, its
  canonical challenge bytes, its binding to the request and the answer it
  signed, and its signature through a verifier the caller hands in; a pinned
  auto-policy is accepted only with a signed \`IntegrationAuthorizationRecord\`
  and that record. The default verifier verifies nothing, because no daemon of
  the series has a signer, so both paths refuse every answer today; the tests
  sign with a key of their own. The alignment identity binds the twelve fields
  of 02 §7 (ADR-091). The signer, its key pin and the verifier are ADR-023 work
  that matrix v1 gives to #4 (ADR-092).
  One path does admit an authority no user signed. \`policyAlignment\`
  (\`src/host/alignment-gates.mjs\`) mints an \`authority: policy\` alignment record
  from a policy object its caller hands in, and of that policy it checks only
  its name, the kinds it lists and its anchor version. It does not check that a
  \`UserDecisionRecord\` issued the policy, never compares the policy's own
  project, Epic, scope and expiry with anything, and never compares the facts'
  policy hashes with the policy object. The record's identity binds the facts
  its caller hands in — their project, Epic and scope, and whatever policy
  hashes they carry. It admits any kind the policy lists, \`brief\` included,
  although 01 §2 lets no policy approve Brief framing, and \`gateAdmission\`
  admits the record, since it recomputes that identity from the facts its caller
  hands in. Outside tests nothing calls either function yet, nor
  \`resumeAdmission\`, the module's own caller of \`gateAdmission\`. The path is
  open in ADR-091 and is #4's phase 3.${alignmentGap.missing.length > 0 ? `
  The same module parks with reason names the graph's recovery rows do not carry — ${codeList(alignmentGap.missing)} — where the graph's alignment rows name ${codeList(alignmentGap.graph)}.` : ''}
  The module resumes into \`record_<kind>_alignment\` and
  \`await_<kind>_alignment\` and restarts at \`clarify_<kind>\`, which are not graph
  steps (the graph's are \`record_alignment\`, \`await_alignment\` and
  \`clarify_alignment\`); its names and steps are #4's phase 3 as well (ADR-091,
  ADR-100).
- An acceptance does not move what it accepts, and its record chains within its
  scope: rules with owners that no code computes. No module here computes a
  scope's relevant authority projection, its dependency or intent head, or
  \`integration_authorization_head\`: the host takes the heads from its caller
  (\`acceptanceFacts\`) and the head a record chains from as the plan names it
  (\`composeAuthorization\`). That a scope's own acceptance — every answer to
  any acceptance packet of the scope, accept or refuse, re-asks included, and
  every \`IntegrationAuthorizationRecord\` of it, keyed at commit by an Epic's
  packet parked with \`acceptance_missing\` at \`accept_staging\` or a Quick run's
  parked with \`integration_authorization_required\` at \`accept\` — never enters
  those heads (the integration-authorization contract, §3) is #4's for the
  daemon's heads and #9's for \`integrateApproved\`'s comparison, and the chain per
  scope under one head kept for integrity (the contract's §5) is #9's (ADR-103,
  ADR-112).
  ${oneAuthority && policyCallers.length === 0
    ? `v1 has one acceptance authority, the person's signature at \`accept_staging\`:
  every edge into \`integrate_staging\` or \`deliver_staging\` leaves \`accept_staging\`
  under a person's guard (${codeList(acceptance.exits)}) or is that step's own retry (${codeList(acceptance.retries) || 'none'}),
  and \`autoPolicyAcceptance\`, the binding a pinned auto-policy is held to, has no
  caller outside tests, so no v1 path reaches it`
    : `Whether v1 has one acceptance authority is not measured here: the edges out
  of \`accept_staging\` toward the CAS or delivery (${codeList(acceptance.exits) || 'none'}) carry guards of
  ${codeList(acceptance.actors) || 'none'}; ${waysIn.length === 0 ? 'nothing else reaches those steps' : `${waysIn.join(', ')} ${waysIn.length === 1 ? 'reaches' : 'reach'} those steps without leaving \`accept_staging\``}; and
  \`autoPolicyAcceptance\`, the binding a pinned auto-policy is held to, ${policyCallers.length === 0 ? 'has no caller outside tests' : `has callers outside tests: ${fileList(policyCallers)}`}`};
  under that binding a pinned auto-policy adds no autonomy, and an unattended
  acceptance needs a different binding, #28's post-v1 design work
  (\`planned_after_v1\`, ADR-103).
- SonarQube Cloud (#47) has a design contract and a validator; the pilot needs
  an organisation the owner creates, and no pilot result is claimed.
- Issue #10's criterion 2 is in this candidate, not deferred: section 3 carries
  the graph document, its schema, the canonical reference, both contracts and the
  patches that put the document's digest inside the identity a task is pinned to.
  What is not claimed inside this section is a band that measures the daemon
  that executes it — that code lives outside this repository — and the
  narrowing is exactly that: \`scripts/verify-autosk-graph-digest.mjs\` and
  \`scripts/verify-autosk-visits.mjs\` do run against it, carried by
  \`.github/workflows/autosk-compatibility.yml\` on every pull request and
  every push to main — on \`228de2cd\`, the commit the round-4 panel froze,
  that run passed on both platforms — and no band of this section lists them.
  This paragraph said the opposite until the work landed and the sentence was
  not rewritten; a panel was dispatched on the stale text and three of its four
  seats found it independently.
- The panel's round records: ${records.filter((record) => record.member).map((record) => `\`${record.path}\` is a member because it carries the operative membership rule (its last anchor correction, checked by \`membershipRuleErrors\`)`).join('; ') || 'none is a member'}. ${records.filter((record) => !record.member).map((record) => `\`${record.path}\``).join(', ') || 'None'} carry no anchor correction and are
  not members: they are records of what a round found, not design the verdict binds,
  and each is checked by \`npm test\` (\`test/validate-design-candidate.test.mjs\`) against the roster its round sat, whether listed or not.
- Membership is the \`files[]\` list alone. Of the code, only
  \`src/host/workflow-graph-canonical.mjs\` is a member, because the canonical
  form it implements carries criterion 2 and the task identity digest. The rest
  of the code is outside the candidate: the code evidence this section presents
  is evidence about code the verdict does not bind.
- The review-round cap is bound and evaluated — ticket 7 closed on the binding,
  not on a retracted finding and not on a wait for patch \`0034\`; ticket 17
  closed on the evaluator landing, not on \`blocked_by: 0035\`: the quantity
  the caps fire on is declared — \`transition_takings\` is in the predicates'
  \`reads\` vocabulary and in the own \`reads\` of every predicate a cap binds
  (a test holds each), and the validator refuses a cap predicate comparing
  with a quantity no predicate declares it reads. A cap counts the takings of
  every transition it names as one count: an artifact's narrow and full-panel
  NOT_PASS share one limit per review cycle, which the publication of the
  artifact's PASS closes, never counting fewer rounds than since the last
  verified publication, and the repair after the checks has a cap of its own
  (ADR-104). The evaluator is the term the factory applies over the
  caller's evaluator at both decision sites, bound per guard at build;
  \`scripts/verify-autosk-cap.mjs\` drives it against a real daemon, where an
  unenforced cap lets the count pass the limit and an enforced one parks with
  \`review_cap\` at it. Like the two measurers above, that run is carried by
  the compatibility workflow and is no band of this section.
  A resume the graph declares the user's decision (a recovery row's
  \`decision_targets\`: a round past \`review_cap\` or \`verification_cap\`, a
  re-stage onto a moved target) is admitted only on a verified \`UserDecisionRecord\` through the caller's verifier:
  the park's leaf (\`park.decision\`: the park's watermark, \`#\` and the record's
  digest) names a record the caller looks up, and the record must verify, name
  this project and this task and have decided this park's resume into this target (ADR-099,
  CodeRabbit on #270; the project, ADR-103) — one round per decision past the cap, with the count and
  the limit unchanged; a resume that runs no round owes none. The factory is handed
  the check as it is handed its evaluator — an admitter, \`resumeDecisionAdmitter\` over this
  project's store and a verifier — and admits nothing without one; the default verifier refuses, so no decision-gated resume is admitted on a real host today
  (no user decision verifies on any host, above).
  The leaf's writer is the resume path (#35), the signer and verifier are #4's, and the CAS on the leaf is #18's (roadmap #231).
- ${mutation.modules.filter((entry) => entry.mutants > 0).length} runtime modules carry a mutable guard and are covered by the
  reproducible mutation command. The daemon is not in this repository and its
  guards are not mutated by it, so nothing here is evidence about them.
- ${unlinked.length} of the ${contracts.length} contracts say **no link measured** in section 4: the three
  measurements on that row found no module. ${srcMeasured
    ? `For those rows two more measurements were made over every file under
  \`src/\`: a whole-name search for each refusal class the contract declares, and
  a search for the contract itself — its file name or its stem as a whole token
  in \`src/\`, or a \`src/\` path that exists named in the contract's text. For ${unreferenced.length} of them nothing was found: none of their declared refusal classes is named under \`src/\`, no \`src/\` file names them, and they name no \`src/\` file — ${unreferenced.map((entry) => `\`${entry.path}\``).join(', ') || 'none'}.
  That is what was measured, and it is not read here as "unimplemented": code
  that implements a contract without naming it or its classes would not be
  found, and a contract the daemon's patch series implements lives outside this
  repository (section 1). The other ${referenced.length} are referenced from \`src/\` (a reference is not a claim of implementation), and what
  was found is listed; a name found is not a link measured by section 4: ${referenced.map((entry) => `\`${entry.path}\`: ${[
      entry.src_references.naming.length > 0 ? `named in ${entry.src_references.naming.map((file) => `\`${file}\``).join(', ')}` : null,
      entry.src_references.named_paths.length > 0 ? `names ${entry.src_references.named_paths.map((file) => `\`${file}\``).join(', ')}` : null,
      ...entry.named_under_src.map((found) => `\`${found.code}\` in ${found.modules.map((module) => `\`${module}\``).join(', ')}`),
    ].filter((part) => part !== null).join('; ')}`).join('. ') || 'none'}.`
    : 'Whether those rows are named elsewhere under `src/` was not measured for this build, and no claim is made either way.'}
- The host takes the alignment identity's derived inputs — \`subject_hash\`, the
  material manifest hash, the projector and the classifier — as given (ADR-091):
  no module in this repository computes any of them, and no calculator is
  claimed. The identity binds what it is handed.
- There is no mapping from a refusal class to a killed mutant. The command shows
  that each module's guards are exercised by its own tests; it does not show
  that every one of the ${classes} declared classes is reachable. Nor does each
  contract carry an "every refusal class can be produced" test: ${requiredTests.length}
  of the ${contracts.length} contracts carry a required-tests section, and what
  produces classes at all is one command — ${produced === null
    ? `no produced report is bound to this build, so no produced count is claimed here.`
    : `\`npm run produce:refusals\` drives ${producedCases.length} cases over ${drivenClasses} ${drivenClassLabel} of ${countWord(contractCount)} ${contractLabel} to the refusal that carries each class and compares the produced code with the declared class; the class list is read from this package's own contract measurement, so a class without a case fails the run. Of the ${classes} classes the contracts declare, this command produces ${producedClasses}; the other ${classes - producedClasses} are declared and not produced by it, and this table prints that rather than implying coverage.${boundRun} For ${countWord(daemonJudged)} ${ticketLifecycleLabel} the evidence is that the host writes the class when the predicate holds — the predicate is the daemon's judgment. The report is bound to the bytes, the directory membership and the positions it ran against, which is evidence about this tree and not an attestation of the Node runtime it ran under.`}
  Section 4's refusal-class count is not that mapping either: it counts the
  classes named in the linked modules, which is a measurement over text and not
  a proof that any of them can be reached.
${vocabulary.park_reasons.some((entry) => entry.producer === 'none') ? `- ${vocabulary.park_reasons.filter((entry) => entry.producer === 'none').length} park reasons are declared with no producer yet
  (\`producer: none\` in the vocabulary): ${vocabulary.park_reasons.filter((entry) => entry.producer === 'none').map((entry) => '\`' + entry.code + '\`').join(', ')}.
  They are implementation obligations. A script that validates a contract
  document may list them, and that is not production.
` : ''}- \`npm test\` is reported as its totals and its skipped and failed tests by
  name, with no coverage figure. Read it as "the suite is green", not as "the
  suite is adequate".
- No deployment to real users has been performed, and none is claimed.`);

  const full = [];
  for (const relative of FULL_TEXT) {
    full.push(`### ${relative}

\`\`\`markdown
${await read(relative)}
\`\`\``);
  }
  sections.push(`## 6. The load-bearing design text, in full

Reproduced whole: ${FULL_TEXT.map((name) => `\`${name}\``).join(', ')}.

Not reproduced, and named so a verdict can say what it covered: every other file
in section 3 — the ${contracts.length} contracts (summarised by rule inventory in
section 4), the JSON Schemas, the resources and the technical plan. Their full
digests are in section 3, and the repository at the commit in section 1 holds
their bytes.

${full.join('\n\n')}`);

  sections.push(`## 7. The verdict

Reply with exactly one JSON object and nothing else:

\`\`\`json
{
  "seat": "<${candidate.required_panel.map((entry) => entry.seat).join('|')}>",
  "candidate_digest": "${candidate.candidate_digest}",
  "verdict": "${verdicts.join(' | ')}",
  "findings": [
    { "severity": "critical|high|medium|low", "where": "<path or section>", "what": "<one sentence>" }
  ],
  "read": "<what you actually read from this package>",
  "not_read": "<what you did not>"
}
\`\`\`

\`pass\` means: the design is internally consistent, nothing load-bearing is
missing, and the evidence says what it claims. Anything else is \`fail\` with
findings, or \`${verdicts[verdicts.length - 1]}\` if you could not review it.

These are the only three values, and they are the attestation's own — the list
above is read from the schema the verdict is recorded against, so an answer that
follows this instruction is an answer the archive accepts. A different word for
the third case, however reasonable, is refused rather than translated.`);

  const text = `${sections.join('\n\n')}\n`;
  return Object.freeze({ text, digest: sha256(text), bytes: Buffer.byteLength(text, 'utf8') });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
  const out = arg('--out');
  const commit = arg('--commit');
  const tree = arg('--tree');
  const testsLog = arg('--tests-log');
  if (!testsLog) {
    throw new Error('the test evidence is missing — run `npm test`, save its output, and pass it with --tests-log <file>');
  }
  const tests = testSummary(await readFile(testsLog, 'utf8'));
  const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

  const candidate = JSON.parse(await read('resources/design-candidate/design-candidate.v1.json'));
  const vocabulary = JSON.parse(await read('resources/refusal-vocabulary/refusal-vocabulary.v1.json'));
  const matrix = JSON.parse(await read('resources/clean-room-e2e/fault-matrix.v1.json'));
  const compat = JSON.parse(await read('compat/autosk/manifest.v1.json'));
  const cleanRoom = await readJson(arg('--clean-room'));
  const mutationReport = await readJson(arg('--mutation'));
  const mutation = {
    ...mutationReport,
    rules: MUTATION_RULES.map((rule) => rule.from),
    report_digest: reportDigest(mutationReport),
  };
  const produced = arg('--produced') ? await readJson(arg('--produced')) : null;
  const migrationSeam = arg('--migration-seam') ? await readJson(arg('--migration-seam')) : null;
  const migrationSeamRefusal = arg('--no-migration-seam');

  const contracts = await measureContracts();

  const built = await buildPackage({
    commit,
    tree,
    candidate,
    cleanRoom,
    matrix,
    mutation,
    compat,
    tests,
    contracts,
    vocabulary,
    produced,
    migrationSeam,
    migrationSeamRefusal,
  });
  if (out) await writeFile(out, built.text);
  console.log(`package_bytes=${built.bytes}`);
  console.log(`package_digest=${built.digest}`);
  console.log(`contracts=${contracts.length}`);
  console.log(`refusal_classes=${contracts.reduce((sum, entry) => sum + entry.refusals.length, 0)}`);
  console.log(`fault_groups=${matrix.groups.length}`);
}
