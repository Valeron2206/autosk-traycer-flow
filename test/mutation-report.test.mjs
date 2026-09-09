/**
 * Tests for the mutation command (#39 evidence).
 *
 * The command exists so that "every runtime module was mutation-tested" can be
 * recomputed by whoever holds the frozen tree instead of being read out of a
 * pull request. These check the parts that decide what it means: what counts as
 * a guard, which test file answers for which module, and when a survivor is
 * allowed to stand.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { RULES, mutants, pairs, reportDigest, unnamedSurvivors } from "../scripts/mutation-report.mjs";

test("each mutant neuters exactly one guard and leaves a program that runs", () => {
  const source = [
    "function f(x) {",
    "  demand(x > 0, 'code', 'positive');",
    "  const errors = [];",
    "  if (!x) errors.push({ reason: 'missing' });",
    "  return errors;",
    "}",
  ].join("\n");
  const cases = mutants(source);
  assert.equal(cases.length, 2);
  assert.deepEqual(cases.map((entry) => entry.line), [2, 4]);
  assert.ok(cases[0].source.includes("void (true && x > 0, 'code', 'positive')"));
  assert.ok(cases[0].source.includes("errors.push"), "the other guard is untouched");
  assert.ok(cases[1].source.includes("demand(x > 0"), "the first guard is untouched");
  // Every mutant is still parseable, or it would "fail" for the wrong reason.
  for (const entry of cases) assert.doesNotThrow(() => new Function(entry.source.replace(/^function/u, "return function")));
});

test("a line with no guard produces no mutant", () => {
  assert.deepEqual(mutants("const x = 1;\nreturn x;\n"), []);
  assert.deepEqual(RULES.map((rule) => rule.from), ["demand(", "errors.push(", "reasons.push(", "findings.push(", "problems.push("]);
});

test("a module is answered for by its own test file, and one without is not covered", () => {
  const listing = {
    modules: ["approved-delta", "doctor-checks", "orphan"],
    tests: ["runtime-approved-delta.test.mjs", "runtime-doctor.test.mjs"],
  };
  assert.deepEqual(pairs(listing), [
    { module: "src/host/approved-delta.mjs", test: "test/runtime-approved-delta.test.mjs" },
    { module: "src/host/doctor-checks.mjs", test: "test/runtime-doctor.test.mjs" },
  ]);
});

test("a survivor stands only where somebody named it, at its line", () => {
  const survivors = [
    { module: "src/host/a.mjs", line: 12, guard: "demand(", text: "demand(x)" },
    { module: "src/host/b.mjs", line: 40, guard: "demand(", text: "demand(y)" },
  ];
  const expected = { equivalent_mutants: [{ module: "src/host/a.mjs", line: 12, reason: "the same condition is re-asserted downstream" }] };
  assert.deepEqual(unnamedSurvivors(survivors, expected).map((entry) => entry.module), ["src/host/b.mjs"]);
  // The line is part of the name: moving the guard does not carry the excuse.
  assert.equal(unnamedSurvivors(survivors, { equivalent_mutants: [{ module: "src/host/a.mjs", line: 13 }] }).length, 2);
  assert.equal(unnamedSurvivors(survivors, { equivalent_mutants: [] }).length, 2);
});

test("the digest covers the counts, so a report cannot be cited for another run", () => {
  const report = { totals: { modules: 1, mutants: 4, killed: 4 }, survivors: [] };
  assert.equal(reportDigest(report), reportDigest({ ...report }));
  assert.notEqual(reportDigest(report), reportDigest({ ...report, totals: { modules: 1, mutants: 4, killed: 3 } }));
});
