/**
 * Proof that every mutant the run can produce parses.
 *
 * A mutant that cannot parse fails to load its test file. The run's
 * classifyRun() reads that from the runner's TAP and reports an environment
 * failure rather than a kill, but that is a reading of output after the spawn,
 * not a measurement of the mutant. Parseability rests on two parts of the
 * harness: RULES and PREDICATE_RULES are chosen so the mutated text is still a
 * program, and codeOffsets() offers only offsets that are real code. Both are
 * text heuristics, so this test measures the consequence instead of trusting
 * the mechanism: it enumerates exactly what the command enumerates — the same
 * listing, pairs() and mutants() — and parses every mutant with V8. It runs no
 * tests of the mutated modules; parse is all that is proved.
 *
 * The parser is `vm.SourceTextModule`, which throws on construction, before
 * linking or evaluating, so one child process under `--experimental-vm-modules`
 * checks the whole set in a single spawn and no dependency is added. The flag
 * is required on Node 24, which CI uses, and still accepted on later versions.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { ROOT, hostListing, mutants, pairs } from "../scripts/mutation-report.mjs";

const PARSE_WORKER = `
  import vm from "node:vm";
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const errors = JSON.parse(input).map((source) => {
      try {
        new vm.SourceTextModule(source);
        return null;
      } catch (error) {
        return String(error);
      }
    });
    process.stdout.write(JSON.stringify(errors));
  });
`;

/** The mutants whose source V8 refuses to parse, named by module:line and guard. */
function unparseable(cases) {
  const run = spawnSync(
    process.execPath,
    ["--experimental-vm-modules", "--input-type=module", "--eval", PARSE_WORKER],
    { input: JSON.stringify(cases.map((entry) => entry.source)), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(run.status, 0, run.stderr);
  const errors = JSON.parse(run.stdout);
  return cases
    .map((entry, index) => (errors[index] === null ? null : `${entry.module}:${entry.line} ${entry.guard}: ${errors[index]}`))
    .filter((entry) => entry !== null);
}

test("every mutant of every covered host module parses", () => {
  const cases = [];
  for (const pair of pairs(hostListing())) {
    const source = readFileSync(path.join(ROOT, pair.module), "utf8");
    for (const mutant of mutants(source)) {
      cases.push({ module: pair.module, line: mutant.line, guard: mutant.guard, source: mutant.source });
    }
  }
  assert.ok(cases.length > 0, "the enumeration produced no mutants");
  assert.deepEqual(unparseable(cases), []);
});

test("every mutant offered from a module with a regex literal parses", () => {
  // A fixture outside src/host: `(?<=` inside a regex is not a predicate, and
  // a scanner that offered it would emit `/(?<a)b/u`, which V8 rejects as an
  // invalid capture group. The guard line keeps the set non-empty.
  const source = [
    "export function f(x) {",
    "  demand(x > 0, 'code', 'positive');",
    "  const behind = /(?<=a)b/u;",
    "  return behind.test(x);",
    "}",
    "",
  ].join("\n");
  const cases = mutants(source).map((mutant) => ({ module: "fixture", ...mutant }));
  assert.ok(cases.length > 0, "the fixture produced no mutants");
  assert.deepEqual(unparseable(cases), []);
});
