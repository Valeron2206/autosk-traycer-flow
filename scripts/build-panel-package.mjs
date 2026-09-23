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

import { digestOf, sourceDrift } from './lib/produced-source.mjs';
import { RULES as MUTATION_RULES, reportDigest } from './mutation-report.mjs';
import { panelVerdicts } from './validate-design-candidate.mjs';
import { classifySeam } from './verify-autosk-migration-seam.mjs';

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
    contracts.push({
      path: contractPath,
      readers,
      evaluators,
      refusals_named: named.length,
      ...outline,
    });
  }
  return contracts;
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

/** The package. Deterministic: the same inputs give the same bytes. */
export async function buildPackage({ commit, tree, candidate, cleanRoom, matrix, mutation, compat, tests, contracts, vocabulary, verdicts = panelVerdicts(), produced = null, migrationSeam = null, migrationSeamRefusal = null }) {
  if (produced !== null) {
    if (!produced.source) {
      throw new Error("the produced report carries no source binding — nothing proves it ran on this tree");
    }
    const drift = sourceDrift(ROOT, produced.source);
    if (drift.length > 0) {
      throw new Error(`the produced report was produced on another tree: ${drift.join("; ")}`);
    }
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
  const sections = [];
  const classes = contracts.reduce((sum, entry) => sum + entry.refusals.length, 0);
  const producedBy = new Map((produced?.contracts ?? []).map((entry) => [entry.contract, entry]));
  const open = contracts.filter((entry) => entry.refusals.length === 0);
  // A whole heading, not a substring: "never the latest source" and
  // "Attestation binds a candidate" are not test sections.
  const requiredTests = contracts.filter((entry) =>
    entry.headings.some((heading) => /^\d+\.\s+required (implementation|runtime) tests$/iu.test(heading)),
  );
  // The refusal counts are read off the bound report rather than written into
  // prose — a typed number is exactly how a stale one survives a re-measurement.
  // A class counts only when a passing case produced it under a name its
  // contract declares: a failed case contributes nothing, and neither does a
  // produced code outside the contract's closed set. The not-clean list below
  // is read from the same cases, so the explanation cannot disagree with the
  // count whatever the report's aggregates say.
  const declaredBy = new Map(contracts.map((entry) => [entry.path, new Set(entry.refusals)]));
  const producedCases = (produced?.contracts ?? []).flatMap((entry) =>
    (entry.cases ?? []).map((entryCase) => ({ ...entryCase, contract: entry.contract, declared: declaredBy.get(entry.contract) ?? new Set() })),
  );
  const passingCases = producedCases.filter((entryCase) => entryCase.pass === true);
  const producedClasses = produced === null ? null
    : new Set(passingCases.flatMap((entryCase) => (entryCase.produced ?? []).filter((code) => entryCase.declared.has(code)))).size;
  const drivenClasses = new Set(producedCases.map((entryCase) => entryCase.class).filter((name) => name !== undefined)).size;
  const drivenClassLabel = drivenClasses === 1 ? "refusal class" : "refusal classes";
  const daemonJudged = produced === null ? null
    : passingCases.filter((entryCase) => entryCase.predicate_owner === "daemon").length;
  const unproducedDeclared = produced === null ? 0 : produced.contracts.reduce((sum, entry) => {
    const declared = declaredBy.get(entry.contract) ?? new Set();
    const confirmed = new Set(passingCases.filter((entryCase) => entryCase.contract === entry.contract)
      .flatMap((entryCase) => (entryCase.produced ?? []).filter((code) => declared.has(code))));
    return sum + [...declared].filter((code) => !confirmed.has(code)).length;
  }, 0);
  const undeclaredProduced = produced === null ? 0
    : new Set(producedCases.flatMap((entryCase) => (entryCase.produced ?? []).filter((code) => !entryCase.declared.has(code)))).size;
  const listedSignatures = (field) => producedCases.reduce(
    (sum, entryCase) => sum + (Array.isArray(entryCase[field]) ? entryCase[field].length : 0),
    0,
  );
  const unexecutedSignatures = listedSignatures("unexecuted");
  const harnessSignatures = listedSignatures("harness");
  const producedDeviations = produced === null ? [] : [
    ...(producedCases.length === passingCases.length ? [] : [`${countWord(producedCases.length - passingCases.length)} case${producedCases.length - passingCases.length === 1 ? "" : "s"} failed`]),
    ...(unproducedDeclared === 0 ? [] : [`${countWord(unproducedDeclared)} declared class${unproducedDeclared === 1 ? " has" : "es have"} no passing case`]),
    ...(undeclaredProduced === 0 ? [] : [`${countWord(undeclaredProduced)} produced code${undeclaredProduced === 1 ? " names" : "s name"} no declared class`]),
    ...(unexecutedSignatures === 0 ? [] : [`${countWord(unexecutedSignatures)} signature${unexecutedSignatures === 1 ? "" : "s"} did not run during ${unexecutedSignatures === 1 ? "its" : "their"} case`]),
    ...(harnessSignatures === 0 ? [] : [`${countWord(harnessSignatures)} signature${harnessSignatures === 1 ? "" : "s"} name${harnessSignatures === 1 ? "s" : ""} the produce-refusals harness`]),
  ];
  const sameTree = cleanRoom.extension?.tree === tree && cleanRoom.extension?.dirty === false;

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
ADR-023, ADR-025) that upstream does not implement — the series supplies them.

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

${vocabulary.park_reasons.filter((entry) => entry.producer === 'host').length} are produced by code in this repository; the other
${vocabulary.park_reasons.filter((entry) => entry.producer === 'daemon').length} are parked by the daemon, which is delivered as the pinned
patch series in section 1 and is not in the mutation table.

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

\`npm test\` on the frozen commit: **${tests.passed} pass, ${tests.failed} fail**.

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
| extension tree exercised | \`${cleanRoom.extension?.tree ?? 'not recorded'}\` |
| worktree clean at run time | ${cleanRoom.extension?.dirty === false ? 'yes' : 'no'} |
| same bytes as the version under review | ${sameTree ? 'yes — the exercised tree equals the main tree in section 1' : 'NO — this run is about other bytes, and section 1 is not proven end to end by it'} |
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

${matrix.groups.map((group) => `- \`${group.id}\` (${group.boundary}) — ${group.description}`).join('\n')}

Coverage: ${Object.entries(cleanRoom.coverage.counts).map(([state, count]) => `${state}=${count}`).join(', ')}; complete=${cleanRoom.coverage.complete}.
Read \`complete\` as complete over this enumeration and over injection —
${cleanRoom.coverage.rows.filter((row) => row.control === true || (cleanRoom.faults ?? []).some((entry) => entry.id === row.id && entry.control)).length} of ${matrix.groups.length} groups also carry a silent control.

Every group is injected for real. Most are also **paired with a control** — the
same guard, asked about the state without the fault, has to stay silent — and
three are not. F001–F003 are run by the crash harness, which injects at two
points in a write and never asks the un-faulted question.

That distinction is load-bearing and the coverage line does not carry it, so it
is stated here instead: \`complete=true\` means every group was injected, not that
every guard was shown to be specific. For the three uncontrolled groups the
package cannot rule out a guard that would refuse the un-faulted state too.

The per-case result is given rather than the count it rolls up into:

${cleanRoom.coverage.rows.length > 0
    ? `Every group in the matrix appears here. Sixteen are injected by the fault
harness and carry a control, the identity harness runs both a fault and its
control, and the crash harness injects without one — the row says which, so a
partial row is not read as a missing one.

| group | harness | fault detected | control silent | evidence |
| --- | --- | --- | --- | --- |
${cleanRoom.coverage.rows.map((row) => {
      const injected = (cleanRoom.faults ?? []).find((entry) => entry.id === row.id);
      const detected = injected ? (injected.detected ? 'yes' : 'NO') : row.state === 'covered_by_real_fault' ? 'yes' : 'NO';
      const control = injected
        ? (injected.control ? 'yes' : 'NO')
        : row.control === true ? 'yes' : 'not paired';
      return `| \`${row.id}\` | ${row.harness ?? 'none'} | ${detected} | ${control} | ${injected ? injected.detail : row.evidence ?? 'not covered'} |`;
    }).join('\n')}`
    : 'The run recorded no per-group results, so the counts above are all this package can show.'}

### Mutation, module by module

| module | test file | mutants | killed |
| --- | --- | --- | --- |
${mutation.modules.map((entry) => `| \`${entry.module}\` | \`${entry.test}\` | ${entry.mutants} | ${entry.killed} |`).join('\n')}

### What is not claimed

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
- Membership is the \`files[]\` list alone. Of the code, only
  \`src/host/workflow-graph-canonical.mjs\` is a member, because the canonical
  form it implements carries criterion 2 and the task identity digest. The rest
  of the code is outside the candidate: the code evidence this section presents
  is evidence about code the verdict does not bind.
- The review-round cap is bound and evaluated — ticket 7 closed on the binding,
  not on a retracted finding and not on a wait for patch \`0034\`; ticket 17
  closed on the evaluator landing, not on \`blocked_by: 0035\`: the quantity
  the caps fire on is declared — \`transition_takings\` is in the predicates'
  \`reads\` vocabulary and in the \`reads\` of the four cap predicates, and the
  validator refuses a cap predicate comparing with a quantity no predicate
  declares it reads. The evaluator is the term the factory applies over the
  caller's evaluator at both decision sites, bound per guard at build;
  \`scripts/verify-autosk-cap.mjs\` drives it against a real daemon, where an
  unenforced cap lets the count pass the limit and an enforced one parks with
  \`review_cap\` at it. Like the two measurers above, that run is carried by
  the compatibility workflow and is no band of this section.
- ${mutation.modules.filter((entry) => entry.mutants > 0).length} runtime modules carry a mutable guard and are covered by the
  reproducible mutation command. The daemon is not in this repository and its
  guards are not mutated by it, so nothing here is evidence about them.
- ${contracts.filter((entry) => (entry.evaluators ?? []).length === 0).length} of the ${contracts.length} contracts say **no link measured** in section 4. That
  means the three measurements on that row found no module, and it is **not** a
  claim that nothing evaluates them. This row asserted "design only in this
  version" over two implementations whose names no convention could reach, until
  the links were measured; whether the remaining ones are unimplemented or only
  unlinked is open, and a seat that wants to know has to read the code.
- There is no mapping from a refusal class to a killed mutant. The command shows
  that each module's guards are exercised by its own tests; it does not show
  that every one of the ${classes} declared classes is reachable. Nor does each
  contract carry an "every refusal class can be produced" test: ${requiredTests.length}
  of the ${contracts.length} contracts carry a required-tests section, and what
  produces classes at all is one command — ${produced === null
    ? `no produced report is bound to this build, so no produced count is claimed here.`
    : `\`npm run produce:refusals\` drives ${produced.cases} cases over ${drivenClasses} ${drivenClassLabel} of ${countWord(produced.contracts.length)} contracts to the refusal that carries each class and compares the produced code with the declared class; the class list is read from this package's own contract measurement, so a class without a case fails the run. Of the ${classes} classes the contracts declare, this command produces ${producedClasses}; the other ${classes - producedClasses} are declared and not produced by it, and this table prints that rather than implying coverage.${producedDeviations.length === 0 ? "" : ` The bound run is not clean — ${producedDeviations.join("; ")} — so the produced count above is of declared classes confirmed produced by a passing case, not of classes driven.`} For ${countWord(daemonJudged)} ticket-lifecycle classes the evidence is that the host writes the class when the predicate holds — the predicate is the daemon's judgment. The report is bound to the bytes, the directory membership and the positions it ran against, which is evidence about this tree and not an attestation of the Node runtime it ran under.`}
  Section 4's refusal-class count is not that mapping either: it counts the
  classes named in the linked modules, which is a measurement over text and not
  a proof that any of them can be reached.
- \`npm test\` is reported as a pass/fail total with no coverage figure. Read it
  as "the suite is green", not as "the suite is adequate".
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
  const passed = Number(arg('--tests-passed'));
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
    tests: { passed, failed: 0 },
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
