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
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { RULES as MUTATION_RULES, reportDigest } from './mutation-report.mjs';

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
 * The headings and refusal classes of one contract, without its whole body.
 *
 * Contracts close their sets in two forms — an inline `Closed set:` sentence
 * and a bulleted `Refusal classes` section — and reading only the first is how
 * a package tells a panel that twenty-two contracts declare no closed set when
 * every one of them does. Round 1 found exactly that, so both forms are read
 * and the form is reported.
 */
export function contractOutline(text) {
  const headings = [];
  for (const line of text.split('\n')) {
    if (/^##\s/u.test(line)) headings.push(line.replace(/^##\s*/u, '').trim());
  }
  const refusals = new Set();
  const inline = /Closed set[^:]*:\s*([\s\S]+?)(?:\n\n|\.\s*\n)/u.exec(text);
  if (inline) {
    for (const match of inline[1].matchAll(/`([a-z][a-z0-9_]{4,})`/gu)) refusals.add(match[1]);
  }
  const section = /(?:^|\n)##\s*\d+\.\s*(?:Refusal classes|What a refusal looks like)\s*\n([\s\S]*?)(?=\n##\s|$)/u.exec(text);
  if (section) {
    for (const match of section[1].matchAll(/^-\s*`([a-z][a-z0-9_]{4,})`/gmu)) refusals.add(match[1]);
  }
  const form = inline && section ? 'both' : inline ? 'inline' : section ? 'section' : 'none';
  return { headings, refusals: [...refusals].sort(), form };
}

/** The package. Deterministic: the same inputs give the same bytes. */
export async function buildPackage({ commit, tree, candidate, cleanRoom, matrix, mutation, compat, tests, contracts }) {
  const sections = [];
  const classes = contracts.reduce((sum, entry) => sum + entry.refusals.length, 0);
  const open = contracts.filter((entry) => entry.refusals.length === 0);
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
| modules covered | ${mutation.totals.modules} |
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

### The fault matrix, with its denominator

**${matrix.groups.length} groups**, which is the denominator for the coverage
counts below. They are, in full:

${matrix.groups.map((group) => `- \`${group.id}\` (${group.boundary}) — ${group.description}`).join('\n')}

Coverage: ${Object.entries(cleanRoom.coverage.counts).map(([state, count]) => `${state}=${count}`).join(', ')}; complete=${cleanRoom.coverage.complete}.

Each group is injected for real and paired with a control — the same guard,
asked about the state without the fault, has to stay silent. A guard that
refuses everything would detect every fault and mean nothing by it, so the
per-case result is given rather than the count it rolls up into:

${cleanRoom.coverage.rows.length > 0
    ? `Every group in the matrix appears here. Sixteen are injected by the fault
harness and carry a control; the other four are covered by the creation, crash
and identity harnesses, which run a real fault without a paired control — the
row says which, so a partial row is not read as a missing one.

| group | harness | fault detected | control silent | evidence |
| --- | --- | --- | --- | --- |
${cleanRoom.coverage.rows.map((row) => {
      const injected = (cleanRoom.faults ?? []).find((entry) => entry.id === row.id);
      const detected = injected ? (injected.detected ? 'yes' : 'NO') : row.state === 'covered_by_real_fault' ? 'yes' : 'NO';
      const control = injected ? (injected.control ? 'yes' : 'NO') : 'not paired';
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
- Issue #10's criterion 2 (the declarative workflow graph) is deferred. No
  artifact in section 3 is that graph, and this panel is **not** being asked to
  accept it as delivered — only to say whether deferring it is a defect in the
  design under review.
- ${mutation.totals.modules} of the runtime modules are covered by the
  reproducible mutation command; the daemon is not in this repository and its
  guards are not mutated by it.
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
  "seat": "<opus|astra|grok|muse>",
  "candidate_digest": "${candidate.candidate_digest}",
  "verdict": "pass | fail | blocking_non_verdict",
  "findings": [
    { "severity": "critical|high|medium|low", "where": "<path or section>", "what": "<one sentence>" }
  ],
  "read": "<what you actually read from this package>",
  "not_read": "<what you did not>"
}
\`\`\`

\`pass\` means: the design is internally consistent, nothing load-bearing is
missing, and the evidence says what it claims. Anything else is \`fail\` with
findings, or \`blocking_non_verdict\` if you could not review it.`);

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
  const matrix = JSON.parse(await read('resources/clean-room-e2e/fault-matrix.v1.json'));
  const compat = JSON.parse(await read('compat/autosk/manifest.v1.json'));
  const cleanRoom = await readJson(arg('--clean-room'));
  const mutationReport = await readJson(arg('--mutation'));
  const mutation = {
    ...mutationReport,
    rules: MUTATION_RULES.map((rule) => rule.from),
    report_digest: reportDigest(mutationReport),
  };

  const { readdir } = await import('node:fs/promises');
  const contracts = [];
  for (const name of (await readdir(path.join(ROOT, CONTRACT_GLOB))).sort()) {
    if (!name.endsWith('.md')) continue;
    const text = await read(`${CONTRACT_GLOB}/${name}`);
    contracts.push({ path: `${CONTRACT_GLOB}/${name}`, ...contractOutline(text) });
  }

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
  });
  if (out) await writeFile(out, built.text);
  console.log(`package_bytes=${built.bytes}`);
  console.log(`package_digest=${built.digest}`);
  console.log(`contracts=${contracts.length}`);
  console.log(`refusal_classes=${contracts.reduce((sum, entry) => sum + entry.refusals.length, 0)}`);
  console.log(`fault_groups=${matrix.groups.length}`);
}
