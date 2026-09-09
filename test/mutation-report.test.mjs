/**
 * Tests for the mutation command (#39 evidence).
 *
 * The command exists so that "every runtime module was mutation-tested" can be
 * recomputed by whoever holds the frozen tree instead of being read out of a
 * pull request. These check the parts that decide what it means: what counts as
 * a guard, which test file answers for which module, and when a survivor or a
 * timeout kill is allowed to stand.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { PREDICATE_RULES, RULES, TEST_SPAWN_ARGS, classifyRun, killedByAssertion, mutants, pairs, reportDigest, unnamedSurvivors, unnamedTimeoutKills } from "../scripts/mutation-report.mjs";

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
  const emission = cases.filter((entry) => entry.kind === "emission");
  assert.deepEqual(emission.map((entry) => entry.line), [2, 4]);
  assert.ok(emission[0].source.includes("void (true && x > 0, 'code', 'positive')"));
  assert.ok(emission[0].source.includes("errors.push"), "the other guard is untouched");
  assert.ok(emission[1].source.includes("demand(x > 0"), "the first guard is untouched");
  assert.ok(emission[1].source.includes("[].push({ reason: 'missing' })"));

  // The predicate operators sit alongside them, one per real comparison.
  const predicate = cases.filter((entry) => entry.kind === "predicate");
  assert.equal(predicate.length, 1, "one comparison: `x > 0`");
  assert.ok(predicate[0].source.includes("x >= 0"));

  // Every mutant is still parseable, or it would "fail" for the wrong reason
  // and the run would count a syntax error as a kill.
  for (const entry of cases) assert.doesNotThrow(() => new Function(entry.source.replace(/^function/u, "return function")));
});

test("an operator inside a message or a comment is not a predicate", () => {
  // Mutating one produces a meaningless mutant or a syntax error counted as a
  // kill, which is the number this command exists to make honest.
  const source = [
    "// a > b in a comment",
    "const message = 'x && y';",
    "const pattern = /a>b/u;",
    "const real = a === b;",
  ].join("\n");
  const predicate = mutants(source).filter((entry) => entry.kind === "predicate");
  assert.equal(predicate.length, 1);
  assert.ok(predicate[0].source.includes("a !== b"));
  // An arrow is not a comparison: mutating its `>` would not parse.
  assert.deepEqual(mutants("const f = (x) => x;\n").filter((entry) => entry.kind === "predicate"), []);
});

test("a line with no guard produces no mutant", () => {
  assert.deepEqual(mutants("const x = 1;\nreturn x;\n"), []);
  assert.deepEqual(RULES.map((rule) => rule.from), ["demand(", "errors.push(", "reasons.push(", "findings.push(", "problems.push("]);
  assert.deepEqual(
    PREDICATE_RULES.map((rule) => `${rule.from} -> ${rule.to}`),
    ["=== -> !==", "!== -> ===", ">= -> >", "<= -> <", "&& -> ||", "|| -> &&", "> -> >=", "< -> <="],
  );
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

test("a timeout kill stands only where somebody named it, at its line", () => {
  const timedOut = [
    { module: "src/host/a.mjs", line: 12, guard: "> -> >=" },
    { module: "src/host/b.mjs", line: 40, guard: "demand(" },
  ];
  const expected = {
    equivalent_mutants: [],
    non_terminating_mutants: [{
      module: "src/host/a.mjs",
      line: 12,
      guard: "> -> >=",
      reason: "while (queue.length > 0) becomes >= 0, which holds for an empty queue",
    }],
  };
  assert.deepEqual(unnamedTimeoutKills(timedOut, expected).map((entry) => entry.module), ["src/host/b.mjs"]);
  // The line is part of the name: moving the loop does not carry the excuse.
  assert.equal(unnamedTimeoutKills(timedOut, { non_terminating_mutants: [{ module: "src/host/a.mjs", line: 13 }] }).length, 2);
  assert.equal(unnamedTimeoutKills(timedOut, { non_terminating_mutants: [] }).length, 2);
  // A named equivalent is a different class: it does not excuse a timeout.
  assert.equal(unnamedTimeoutKills(timedOut, { equivalent_mutants: [{ module: "src/host/a.mjs", line: 12 }] }).length, 2);
});

test("a load failure is not an assertion kill", () => {
  const load = {
    status: 1,
    signal: null,
    stdout: [
      "✖ load-fail.test.mjs (0.8ms)",
      "ℹ tests 1",
      "ℹ pass 0",
      "ℹ fail 1",
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'x'",
      "    at finalizeResolution (node:internal/modules/esm/resolve:271:11)",
    ].join("\n"),
    stderr: "",
  };
  const missingExport = {
    status: 1,
    signal: null,
    stdout: [
      "✖ missing-export.test.mjs (1.1ms)",
      "ℹ tests 1",
      "ℹ fail 1",
      "SyntaxError: The requested module './m.mjs' does not provide an export named 'x'",
      "    at #asyncInstantiate (node:internal/modules/esm/module_job:326:21)",
    ].join("\n"),
    stderr: "",
  };
  const assertion = {
    status: 1,
    signal: null,
    stdout: [
      "TAP version 13",
      "# Subtest: fails",
      "not ok 1 - fails",
      "  ---",
      "  type: 'test'",
      "  failureType: 'testCodeFailure'",
      "  name: 'AssertionError'",
      "  ...",
      "# tests 1",
      "# fail 1",
      "",
    ].join("\n"),
    stderr: "",
  };
  const thrown = {
    status: 1,
    signal: null,
    stdout: [
      "TAP version 13",
      "# Subtest: throws",
      "not ok 1 - throws",
      "  ---",
      "  type: 'test'",
      "  failureType: 'testCodeFailure'",
      "  error: 'boom'",
      "  ...",
      "# tests 1",
      "# fail 1",
      "",
    ].join("\n"),
    stderr: "",
  };
  const late = {
    status: 1,
    signal: null,
    stdout: [
      "TAP version 13",
      "# Subtest: late",
      "not ok 1 - late",
      "  ---",
      "  type: 'test'",
      "  failureType: 'testCodeFailure'",
      "  name: 'AssertionError'",
      "  stack: |-",
      "    Timeout._onTimeout (file:///dev/fd/0:5:18)",
      "  ...",
      "",
    ].join("\n"),
    stderr: "",
  };
  assert.equal(killedByAssertion([load]), 0);
  assert.equal(killedByAssertion([missingExport]), 0);
  assert.equal(killedByAssertion([assertion]), 1);
  assert.equal(killedByAssertion([thrown]), 1);
  assert.equal(killedByAssertion([late]), 1);
  assert.equal(classifyRun(load), "environment");
  assert.equal(classifyRun(missingExport), "environment");
  assert.equal(classifyRun(assertion), "assertion");
  assert.equal(classifyRun(thrown), "assertion");
  assert.equal(classifyRun(late), "assertion");
});

test("an import-time ENOENT is not an assertion kill", () => {
  const run = spawnSync(process.execPath, [...TEST_SPAWN_ARGS, "/dev/stdin"], {
    input: [
      'import { readFileSync } from "node:fs";',
      'import test from "node:test";',
      'readFileSync("/dev/__review_missing_fixture__");',
      'test("unreached", () => {});',
      "",
    ].join("\n"),
    encoding: "utf8",
  });
  assert.equal(run.status, 1);
  assert.equal(killedByAssertion([run]), 0);
  assert.equal(classifyRun(run), "environment");
});

test("AssertionError text without an executed test is not an assertion kill", () => {
  const poisoned = {
    status: 1,
    signal: null,
    stdout: [
      "✖ load-fail.test.mjs (0.8ms)",
      "ℹ tests 1",
      "ℹ fail 1",
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'x' — see AssertionError docs",
      "    at finalizeResolution (node:internal/modules/esm/resolve:271:11)",
    ].join("\n"),
    stderr: "",
  };
  assert.equal(killedByAssertion([poisoned]), 0);
  assert.equal(classifyRun(poisoned), "environment");
});

test("a beforeEach hook failure is not an assertion kill", () => {
  const run = spawnSync(process.execPath, [...TEST_SPAWN_ARGS, "/dev/stdin"], {
    input: [
      'import { readFileSync } from "node:fs";',
      'import test from "node:test";',
      'test.beforeEach(() => { readFileSync("/dev/__review_missing_fixture__"); });',
      'test("unreached", () => {});',
      "",
    ].join("\n"),
    encoding: "utf8",
  });
  assert.equal(run.status, 1);
  assert.equal(killedByAssertion([run]), 0);
  assert.equal(classifyRun(run), "environment");
});

test("arbitrary TestContext text without a TAP testCodeFailure is not an assertion kill", () => {
  const run = {
    status: 1,
    signal: null,
    stdout: [
      "initializing TestContext",
      "TAP version 13",
      "# Subtest: /dev/stdin",
      "not ok 1 - /dev/stdin",
      "  ---",
      "  type: 'test'",
      "  code: 'ERR_MODULE_NOT_FOUND'",
      "  ...",
      "",
    ].join("\n"),
    stderr: "",
  };
  assert.equal(killedByAssertion([run]), 0);
  assert.equal(classifyRun(run), "environment");
});

test("a live missing import after a console.log is not an assertion kill", () => {
  const run = spawnSync(process.execPath, [...TEST_SPAWN_ARGS, "/dev/stdin"], {
    input: [
      'console.log("initializing TestContext");',
      'await import("./no-such-module.mjs");',
      "",
    ].join("\n"),
    encoding: "utf8",
  });
  assert.equal(run.status, 1);
  assert.equal(killedByAssertion([run]), 0);
  assert.equal(classifyRun(run), "environment");
});

test("the digest covers the counts, so a report cannot be cited for another run", () => {
  const report = { totals: { modules: 1, mutants: 4, killed: 4 }, survivors: [] };
  assert.equal(reportDigest(report), reportDigest({ ...report }));
  assert.notEqual(reportDigest(report), reportDigest({ ...report, totals: { modules: 1, mutants: 4, killed: 3 } }));
});
