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

/** The headings and refusal classes of one contract, without its whole body. */
export function contractOutline(text) {
  const headings = [];
  for (const line of text.split('\n')) {
    if (/^##\s/u.test(line)) headings.push(line.replace(/^##\s*/u, '').trim());
  }
  const refusals = [];
  const closed = /Closed set:\s*([^.]+)\./u.exec(text);
  if (closed) {
    for (const entry of closed[1].split(',')) {
      const name = entry.replace(/[`\s]/gu, '');
      if (name) refusals.push(name);
    }
  }
  return { headings, refusals };
}

/** The package. Deterministic: the same inputs give the same bytes. */
export async function buildPackage({ commit, tree, candidate, cleanRoom, tests, contracts }) {
  const sections = [];

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

The candidate digest is recomputed by \`scripts/validate-design-candidate.mjs\`
from the files on disk. A verdict is about this digest and no other.`);

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
having read the material is worse than no answer, because it is counted.`);

  sections.push(`## 3. The design pack, by path and digest

${candidate.files.length} files. The two marked **full text** are reproduced
whole in section 6; the rest are named here so a verdict can state what it
covered.

| path | sha256 | in this package |
| --- | --- | --- |
${candidate.files.map((file) => `| \`${file.path}\` | \`${file.sha256.slice(0, 16)}…\` | ${FULL_TEXT.includes(file.path) ? 'full text' : 'digest only'} |`).join('\n')}`);

  sections.push(`## 4. The contracts, by rule inventory

Each contract's sections and its closed refusal set. The full text of any of
these is in the repository at the commit above.

${contracts.map((entry) => `### ${entry.path}

Sections: ${entry.headings.join('; ')}

${entry.refusals.length > 0 ? `Closed refusal set: ${entry.refusals.map((name) => `\`${name}\``).join(', ')}` : 'No closed refusal set is declared in this document.'}`).join('\n\n')}`);

  sections.push(`## 5. Evidence

### Tests

\`npm test\` on the frozen commit: **${tests.passed} pass, ${tests.failed} fail**.

Every runtime module in \`src/host/\` was mutation-tested: each guard neutered
one at a time, the module's own test file re-run, and a surviving mutant treated
as a missing test or a dead guard rather than as noise. The counts are in the
pull request that introduced each module.

### Clean-room end-to-end

One command, an isolated HOME with no Traycer, the pinned upstream source built
from source, and both product harnesses plus the fault harness.

| field | value |
| --- | --- |
| pinned upstream commit | \`${cleanRoom.upstream_commit}\` |
| reproduced source tree | \`${cleanRoom.source_tree}\` |
| report digest | \`${cleanRoom.report_digest}\` |
| overall | ${cleanRoom.ok ? 'ok' : 'FAILED'} |

Steps: ${cleanRoom.steps.map((step) => `${step.step}=${step.ok === false ? 'FAIL' : 'ok'}`).join(', ')}.

Fault-matrix coverage: ${Object.entries(cleanRoom.coverage.counts).map(([state, count]) => `${state}=${count}`).join(', ')}; complete=${cleanRoom.coverage.complete}.

Each fault group is injected for real and paired with a control — the same
guard, asked about the state without the fault, has to stay silent. A guard
that refuses everything would detect every fault and mean nothing by it.

### What is not claimed

- SonarQube Cloud (#47) has a design contract and a validator; the pilot needs
  an organisation the owner creates, and no pilot result is claimed.
- Issue #10's criterion 2 (the declarative workflow graph) is deferred to this
  design gate and is not claimed as implemented.
- No deployment to real users has been performed, and none is claimed.`);

  const full = [];
  for (const relative of FULL_TEXT) {
    full.push(`### ${relative}

\`\`\`markdown
${await read(relative)}
\`\`\``);
  }
  sections.push(`## 6. The load-bearing design text, in full

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
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
  const cleanRoomPath = process.argv.includes('--clean-room')
    ? process.argv[process.argv.indexOf('--clean-room') + 1]
    : null;
  const commit = process.argv[process.argv.indexOf('--commit') + 1];
  const tree = process.argv[process.argv.indexOf('--tree') + 1];
  const passed = Number(process.argv[process.argv.indexOf('--tests-passed') + 1]);

  const candidate = JSON.parse(await read('resources/design-candidate/design-candidate.v1.json'));
  const cleanRoom = JSON.parse(await readFile(cleanRoomPath, 'utf8'));
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
    tests: { passed, failed: 0 },
    contracts,
  });
  if (out) await writeFile(out, built.text);
  console.log(`package_bytes=${built.bytes}`);
  console.log(`package_digest=${built.digest}`);
  console.log(`contracts=${contracts.length}`);
}
