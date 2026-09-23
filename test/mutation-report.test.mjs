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

import { PREDICATE_RULES, RULES, TEST_SPAWN_ARGS, classifyRun, killedByAssertion, moduleMutants, mutants, pairs, reportDigest, unnamedSurvivors, unnamedTimeoutKills } from "../scripts/mutation-report.mjs";

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

test("a regex after `return` is not read as division", () => {
  // A keyword ends in a letter, which read the slash as division: `(?<=` was
  // offered as a predicate and the mutant `/(?<a)b/u` did not parse.
  const cases = mutants("return /(?<=a)b/u.test(s) && y;");
  assert.deepEqual(cases.map((entry) => entry.guard), ["&& -> ||"]);
  for (const entry of cases) assert.doesNotThrow(() => new Function(entry.source));
});

test("a quote inside a regex after `return` does not swallow the rest of the file", () => {
  // The apostrophe put the scanner into string state until the next quote, so
  // `&&`, `<` and the next function's `>` were silently dropped.
  const source = [
    "function f(s, a, b) {",
    "  if (a > 0) return /it's/u.test(s) && a < b;",
    "  return s;",
    "}",
    "function g(x) {",
    "  return x > 0;",
    "}",
  ].join("\n");
  const predicate = mutants(source).filter((entry) => entry.kind === "predicate");
  assert.deepEqual(predicate.map((entry) => [entry.line, entry.guard]), [
    [2, "&& -> ||"],
    [2, "> -> >="],
    [6, "> -> >="],
    [2, "< -> <="],
  ]);
});

test("a slash after a value is still division, even a keyword-shaped one", () => {
  // `xreturn` is one identifier, `obj.return` a property, `(a + b)` a value:
  // the slash stays division, so the `>` behind it is still offered — a regex
  // reading would swallow it to the next slash.
  for (const source of ["const y = xreturn / 2 > 1;", "const y = obj.return / 2 > 1;", "const y = (a + b) / 2 > 1;"]) {
    assert.deepEqual(
      mutants(source).filter((entry) => entry.kind === "predicate").map((entry) => entry.guard),
      ["> -> >="],
    );
  }
  // `of` is a plain identifier, not a reserved word: `of /` is division, and a
  // regex reading would swallow the rest of the file to the next slash.
  const divided = mutants([
    "function f(total) {",
    "  const of = total;",
    "  const half = of / 2 > 1 && total < 9;",
    "  return half;",
    "}",
    "function g(x) { return x > 0; }",
  ].join("\n")).filter((entry) => entry.kind === "predicate");
  assert.deepEqual(divided.map((entry) => [entry.line, entry.guard]), [
    [3, "&& -> ||"],
    [3, "> -> >="],
    [6, "> -> >="],
    [3, "< -> <="],
  ]);
  // And `= /re/` stays a regex: the `>` inside it offers nothing.
  const predicate = mutants("const r = /a>b/u; const y = x > 1;").filter((entry) => entry.kind === "predicate");
  assert.equal(predicate.length, 1);
  assert.ok(predicate[0].source.includes("x >= 1"));
});

test("a comment never makes the slash after it a regex", () => {
  // The decision used to read the raw text before the slash, comments included:
  // `// then return` ends in a reserved word and `// ratio:` in an operator
  // character, and each read the division as a regex that swallowed the file.
  for (const comment of ["then return", "ratio:"]) {
    const predicate = mutants([
      "function f(a, b, c) {",
      `  const r = a // ${comment}`,
      "    / b > c;",
      "  return r;",
      "}",
      "function g(x) { return x > 0; }",
    ].join("\n")).filter((entry) => entry.kind === "predicate");
    assert.deepEqual(predicate.map((entry) => [entry.line, entry.guard]), [[3, "> -> >="], [6, "> -> >="]]);
  }
  // The same holds across a block comment.
  const blocked = mutants("const y = a /* return */ / b > c;").filter((entry) => entry.kind === "predicate");
  assert.deepEqual(blocked.map((entry) => entry.guard), ["> -> >="]);
});

test("a regex after a comment is not read as division", () => {
  // The last raw character before the slash used to be the `e` of `note`, so
  // the regex body was scanned as code and `(?<=` offered a mutant that does
  // not parse.
  const cases = mutants("const r = // note\n    /(?<=a)b/u.test(s) && y;");
  assert.deepEqual(cases.map((entry) => entry.guard), ["&& -> ||"]);
  for (const entry of cases) assert.doesNotThrow(() => new Function(entry.source));
});

test("a slash inside a regex character class does not end the regex", () => {
  // `[/]` closed the regex at the class's own slash, and the `'` after it put
  // the scanner into string state for the rest of the file.
  const predicate = mutants([
    "function f(s, a, b) {",
    "  return /[/]'x/u.test(s) && a < b;",
    "}",
    "function g(x) { return x > 0; }",
  ].join("\n")).filter((entry) => entry.kind === "predicate");
  assert.deepEqual(predicate.map((entry) => [entry.line, entry.guard]), [
    [2, "&& -> ||"],
    [4, "> -> >="],
    [2, "< -> <="],
  ]);
  // Controls: the src/host/evidence-sweeper.mjs:64 shape, correct today only
  // by luck, and an escaped `]` plus escaped `/`, which neither open nor close
  // anything.
  for (const source of [
    "const pattern = /evidence\\/([A-Za-z0-9._\\-/]+)/gu; const y = a > b;",
    "const r = /a\\]\\//u; const y = a > b;",
  ]) {
    assert.deepEqual(
      mutants(source).filter((entry) => entry.kind === "predicate").map((entry) => entry.guard),
      ["> -> >="],
    );
  }
});

test("a slash after a dotted, private or suffixed keyword is still division", () => {
  // The keyword check read the character next to the token and used an ASCII
  // boundary: `obj. return`, `obj./* note */return`, `obj?. return`,
  // `this.#return` and `πreturn` each produced a false regex that swallowed
  // the rest of the file.
  for (const line of [
    "const y = obj. return / 2 > 1;",
    "const y = obj./* note */return / 2 > 1;",
    "const y = obj?. return / 2 > 1;",
    "const πreturn = 8; const y = πreturn / 2 > 1;",
    "class A { #return = 8; f() { return this.#return / 2 > 1; } }",
  ]) {
    const predicate = mutants(`${line}\nfunction g(x) { return x > 0; }`).filter((entry) => entry.kind === "predicate");
    assert.deepEqual(predicate.map((entry) => [entry.line, entry.guard]), [[1, "> -> >="], [2, "> -> >="]]);
  }
});

test("`export default` opens a regex the way `return` does", () => {
  // `default` is reserved and `export default` may be followed by an
  // expression, so `(?<=` inside the regex offers nothing.
  const cases = mutants("export default /(?<=a)b/u.test(s) && y;");
  assert.deepEqual(cases.map((entry) => entry.guard), ["&& -> ||"]);
});

const predicateGuards = (source) => mutants(source).filter((entry) => entry.kind === "predicate").map((entry) => [entry.line, entry.guard]);

test("a slash after ++ is division, and later slashes stay division", () => {
  // `i++ / 2` is division. Reading the slash as a regex swallowed both
  // comparisons on the line.
  const source = [
    "let i = 0; const a = 1, b = 2, c = 3, d = 4;",
    "export const r = i++ / 2 > 1; export const q = [a / b]; export const y = c > d;",
  ].join("\n");
  assert.deepEqual(predicateGuards(source), [[2, "> -> >="], [2, "> -> >="]]);
});

test("a slash inside a template literal does not swallow later code", () => {
  const source = [
    "export function f(a, b, n) {",
    "  const m = `${dim(`[${a}/${b}]`)} ok`;",
    "  process.stdout.write(`\\x1B[${n}A\\x1B[J`);",
    "  const t = `${dim(`[${a}/${b}]`)} ok`;",
    "  return n > 0;",
    "}",
    "export function g(x) {",
    "  return x > 0;",
    "}",
  ].join("\n");
  assert.deepEqual(predicateGuards(source), [[5, "> -> >="], [8, "> -> >="]]);
});

test("a slash inside an interpolated template does not swallow the next function", () => {
  const source = [
    "export function f(dir) {",
    "  return `${dir ? `saved in /${dir}` : \"\"}`;",
    "}",
    "export function g(x) {",
    "  return x > 0;",
    "}",
  ].join("\n");
  assert.deepEqual(predicateGuards(source), [[5, "> -> >="]]);
});

test("a regex after ) is a regex, so in inside it is not code", () => {
  const source = [
    "export function f(s, y) {",
    "  if (s) /\\s+in/u.test(s) && y > 0;",
    "  return s;",
    "}",
    "export function g(x) {",
    "  return x > 0;",
    "}",
  ].join("\n");
  assert.deepEqual(predicateGuards(source), [[2, "&& -> ||"], [2, "> -> >="], [6, "> -> >="]]);
});

test("a braced unicode escape stays inside the identifier", () => {
  // `\\u{78}in` is one identifier, `xin`, so the slash is division.
  const source = [
    "const \\u{78}in = 8;",
    "export const y = \\u{78}in / 2 > 1;",
    "export function g(x) { return x > 0; }",
  ].join("\n");
  assert.deepEqual(predicateGuards(source), [[2, "> -> >="], [3, "> -> >="]]);
});

test("`extends` is followed by a regex", () => {
  assert.deepEqual(predicateGuards("class A extends /(?<=a)b/.constructor {}"), []);
});

test("a comparison inside a template interpolation is code", () => {
  const source = [
    "export function f(n) {",
    "  return `${n > 1 ? \"many\" : \"one\"}`;",
    "}",
  ].join("\n");
  assert.deepEqual(predicateGuards(source), [[2, "> -> >="]]);
});

test("a comparison inside a nested template interpolation is code", () => {
  const source = [
    "export function f(n) {",
    "  return `${n > 1 ? `${n}` : n}`;",
    "}",
  ].join("\n");
  assert.deepEqual(predicateGuards(source), [[2, "> -> >="]]);
});

test("a brace inside an interpolated string does not end the template", () => {
  const source = [
    "export function f(n) {",
    "  return `${n > 1 ? \"}\" : \"{\"}`;",
    "}",
  ].join("\n");
  assert.deepEqual(predicateGuards(source), [[2, "> -> >="]]);
});

test("a newline after break, continue or debugger opens a regex", () => {
  // The statement after the newline is a regex, so the `>` inside it is not code.
  for (const word of ["break", "continue", "debugger"]) {
    const source = [
      "export function f(s) {",
      "  for (;;) {",
      `    ${word}`,
      "    /a>b/u;",
      "  }",
      "  return s > 1;",
      "}",
    ].join("\n");
    assert.deepEqual(predicateGuards(source), [[6, "> -> >="]]);
  }
});

test("await is followed by a regex at top level and inside an async function", () => {
  assert.deepEqual(predicateGuards("await /a>b/u;\nexport function g(x) { return x > 0; }"), [[2, "> -> >="]]);
  const source = [
    "export async function f(s) {",
    "  await /a>b/u;",
    "  return s > 1;",
    "}",
  ].join("\n");
  assert.deepEqual(predicateGuards(source), [[3, "> -> >="]]);
});

test("a property name after ?. is followed by division", () => {
  const g = "\nfunction g(x) { return x > 0; }";
  assert.deepEqual(predicateGuards(`const y = obj?.of / 2 > 1;${g}`), [[1, "> -> >="], [2, "> -> >="]]);
  assert.deepEqual(predicateGuards(`const y = a?.b?.return / 2 > 1;${g}`), [[1, "> -> >="], [2, "> -> >="]]);
  assert.deepEqual(
    predicateGuards(`const y = obj?.return / 2 > 1; const z = a / b;${g}`),
    [[1, "> -> >="], [2, "> -> >="]],
  );
  assert.deepEqual(
    predicateGuards(`const y = obj?.return\n  / 2 > 1 /g;${g}`),
    [[2, "> -> >="], [3, "> -> >="]],
  );
});

test("a source acorn cannot parse is refused, not guessed", () => {
  assert.throws(() => mutants("const y = a > ;"), /Unexpected token/);
  assert.throws(
    () => moduleMutants("src/host/example.mjs", "const y = a > ;"),
    /cannot parse src\/host\/example\.mjs/,
  );
});

test("yield in a generator method is followed by a regex", () => {
  const body = "    yield /^\\s*#/u.test(line) && line.length > 1;";
  const tail = "export function g(x) { return x > 0; }";
  const sources = [
    ["export class Lines {", "  *matches(line) {", body, "  }", "}", tail].join("\n"),
    ["export class Lines {", "  static *matches(line) {", body, "  }", "}", tail].join("\n"),
    ["export const lines = {", "  *[Symbol.iterator]() {", body, "  },", "};", tail].join("\n"),
    ["export class Lines {", "  async *matches(line) {", body, "  }", "}", tail].join("\n"),
  ];
  for (const source of sources) {
    assert.deepEqual(predicateGuards(source), [[3, "&& -> ||"], [3, "> -> >="], [6, "> -> >="]]);
  }
});

test("of as an identifier starts a statement that ASI ends", () => {
  assert.deepEqual(
    predicateGuards("let of = 4\nof / 2 > 1\nexport function g(x) { return x > 0; }"),
    [[2, "> -> >="], [3, "> -> >="]],
  );
  assert.deepEqual(
    predicateGuards("function f() { return 1 }\nf()\nof / 2 > 1\nexport function g(x) { return x > 0; }"),
    [[3, "> -> >="], [4, "> -> >="]],
  );
});

test("moduleMutants does not blame a module for an error that is not a parse failure", () => {
  assert.throws(
    () => moduleMutants("src/host/example.mjs", null),
    (error) => error instanceof TypeError && !String(error.message).startsWith("cannot parse"),
  );
});

test("a generator function, a delegated yield, a yield property and a for-of head stay as they are", () => {
  assert.deepEqual(
    predicateGuards("export function* f(line) {\n  yield /^\\s*#/u.test(line) && line.length > 1;\n}\nexport function g(x) { return x > 0; }"),
    [[2, "&& -> ||"], [2, "> -> >="], [4, "> -> >="]],
  );
  assert.deepEqual(
    predicateGuards("export function* f() {\n  yield* /a>b/u;\n}\nexport function g(x) { return x > 0; }"),
    [[4, "> -> >="]],
  );
  assert.deepEqual(
    predicateGuards("export class Lines {\n  *matches(obj) {\n    return obj.yield / 2 > 1;\n  }\n}\nexport function g(x) { return x > 0; }"),
    [[3, "> -> >="], [6, "> -> >="]],
  );
  assert.deepEqual(
    predicateGuards("for (const c of /a>b/u.source) {}\nexport function g(x) { return x > 0; }"),
    [[2, "> -> >="]],
  );
  assert.deepEqual(
    predicateGuards("export async function f() {\n  for await (const c of /a>b/u.source) {}\n  return 1;\n}\nexport function g(x) { return x > 0; }"),
    [[5, "> -> >="]],
  );
  assert.deepEqual(
    predicateGuards("let of = 4; of / 2 > 1\nexport function g(x) { return x > 0; }"),
    [[1, "> -> >="], [2, "> -> >="]],
  );
});

test("a keyword property, a call, a computed key and a ternary after ? stay themselves", () => {
  assert.deepEqual(
    predicateGuards("const y = obj?.function / 2 > 1;\n{ const z = a > b; }"),
    [[1, "> -> >="], [2, "> -> >="]],
  );
  assert.deepEqual(
    predicateGuards("const y = obj?.class / 2 > 1;\n{ const z = a > b; }"),
    [[1, "> -> >="], [2, "> -> >="]],
  );
  assert.deepEqual(predicateGuards("const y = a?.(/a>b/u) && c > 1;"), [[1, "&& -> ||"], [1, "> -> >="]]);
  assert.deepEqual(predicateGuards("const y = a?.[/a>b/u.source] && c > 1;"), [[1, "&& -> ||"], [1, "> -> >="]]);
  assert.deepEqual(predicateGuards("const y = x?.5:1;"), []);
});

test("a regex that starts with = after await is a regex", () => {
  const g = "\nexport function g(x) { return x > 0; }";
  assert.deepEqual(
    predicateGuards("export async function f(s) {\n  return (await /=+/u.test(s)) && s > 1;\n}" + g),
    [[2, "&& -> ||"], [2, "> -> >="], [4, "> -> >="]],
  );
  assert.deepEqual(
    predicateGuards("export const r = await /=a/u.test(\"=a\");" + g),
    [[2, "> -> >="]],
  );
});

test("a regex that starts with = after a newline or in a for-await head is a regex", () => {
  const g = "\nexport function g(x) { return x > 0; }";
  assert.deepEqual(
    predicateGuards("export function f(s) {\n  for (;;) {\n    break\n    /=a/u.test(s);\n  }\n  return s > 1;\n}" + g),
    [[6, "> -> >="], [8, "> -> >="]],
  );
  assert.deepEqual(
    predicateGuards("export async function f(s) {\n  for await (const c of /=a/u.source) s += c;\n  return s > 1;\n}" + g),
    [[3, "> -> >="], [5, "> -> >="]],
  );
});

test("a yield property after ?. stays division", () => {
  const g = "\nexport function g(x) { return x > 0; }";
  assert.deepEqual(
    predicateGuards("export function* h(a) {\n  yield a?.yield / 2 > 1;\n}" + g),
    [[2, "> -> >="], [4, "> -> >="]],
  );
  assert.deepEqual(
    predicateGuards("export class Lines {\n  *matches(a) {\n    yield a?.yield / 2 > 1;\n  }\n}" + g),
    [[3, "> -> >="], [6, "> -> >="]],
  );
});

test("source nested past acorn's recursion depth is refused by name", () => {
  const source = `export const y = ${"[".repeat(100000)}0${"]".repeat(100000)};`;
  assert.throws(
    () => moduleMutants("src/host/deep.mjs", source),
    (error) => String(error.message).startsWith("cannot parse src/host/deep.mjs: Not enough stack space"),
  );
});

test("slash-equals stays division as an operator and a regex after for-of or yield", () => {
  const g = "\nexport function g(x) { return x > 0; }";
  assert.deepEqual(predicateGuards("const y = a /= b > 1 ? 2 : 1;"), [[1, "> -> >="]]);
  assert.deepEqual(predicateGuards("let x = 1\nx\n/= 2" + g), [[4, "> -> >="]]);
  assert.deepEqual(predicateGuards("for (const c of /=a/u.source) {}" + g), [[2, "> -> >="]]);
  assert.deepEqual(
    predicateGuards("export function* f() {\n  yield /=a/u;\n}" + g),
    [[4, "> -> >="]],
  );
});

test("a module is answered for by its own test file, and one without is refused by name", () => {
  const listing = {
    modules: ["approved-delta", "doctor-checks"],
    tests: ["runtime-approved-delta.test.mjs", "runtime-doctor.test.mjs"],
  };
  assert.deepEqual(pairs(listing), [
    { module: "src/host/approved-delta.mjs", test: "test/runtime-approved-delta.test.mjs" },
    { module: "src/host/doctor-checks.mjs", test: "test/runtime-doctor.test.mjs" },
  ]);
  assert.throws(
    () => pairs({ modules: ["approved-delta", "orphan"], tests: ["runtime-approved-delta.test.mjs"] }),
    /src\/host\/orphan\.mjs/,
  );
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
