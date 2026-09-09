#!/usr/bin/env node

/**
 * The mutation run, as a command rather than a claim in a pull request.
 *
 * Every runtime module's guards are neutered one at a time and the module's own
 * test file is re-run. A mutant that survives is a missing test, a dead guard,
 * or an equivalent mutant — and the third is only allowed when somebody has
 * written down why, at the line it applies to. A survivor nobody has named
 * fails this command. A timeout kill is the same obligation: named, at its
 * line, with a proof that that site cannot terminate — or the command fails.
 *
 * The point is not the number. The point is that the number can be recomputed
 * by anyone holding the frozen tree, which is what "mutation-tested" has to
 * mean before it can be evidence.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const EXPECTED_PATH = "resources/mutation-report/mutation-survivors.v1.json";

/** How long one mutant's test file may run before it counts as killed by hang. */
export const TEST_TIMEOUT_MS = 45_000;

/** The runner argv that produces the TAP classifyRun parses. */
export const TEST_SPAWN_ARGS = Object.freeze([
  "--test",
  "--test-reporter=tap",
  "--test-isolation=none",
]);

/**
 * How a refusal's emission is neutered.
 *
 * Each rule turns one refusal into a no-op that still evaluates its arguments,
 * so the mutant is a program that runs and simply never refuses.
 */
export const RULES = Object.freeze([
  { from: "demand(", to: "void (true && " },
  // `[].push(` rather than `void (`: a call that spreads its argument —
  // `errors.push(...someErrors())` — is not a valid `void` expression, so the
  // old rule produced a syntax error that every test failed on and the run
  // counted as a kill. Fifteen of the previous 514 were that. Pushing onto a
  // throwaway array evaluates the arguments and discards them, and parses in
  // both forms.
  { from: "errors.push(", to: "[].push(" },
  { from: "reasons.push(", to: "[].push(" },
  { from: "findings.push(", to: "[].push(" },
  { from: "problems.push(", to: "[].push(" },
]);

/**
 * How the condition that decides a refusal is changed.
 *
 * Panel round 3 was right about the previous operator set: neutering only the
 * emission proves that a test notices a deleted refusal, not that the guard is
 * correctly conditioned. A boundary written `>=` where it should be `>`, an
 * equality that should be an inequality, or an `&&` that should be an `||`
 * survives an emission-only run untouched.
 *
 * Longest operators first, so `===` is never matched as `==` plus a stray `=`.
 */
export const PREDICATE_RULES = Object.freeze([
  { from: "===", to: "!==" },
  { from: "!==", to: "===" },
  { from: ">=", to: ">" },
  { from: "<=", to: "<" },
  { from: "&&", to: "||" },
  { from: "||", to: "&&" },
  { from: ">", to: ">=" },
  { from: "<", to: "<=" },
]);

/**
 * The offsets that are real code.
 *
 * An operator inside a message, a comment or a regular expression is not a
 * predicate, and mutating one produces either a meaningless mutant or a syntax
 * error counted as a kill — which would inflate the number this command exists
 * to make honest. So the source is scanned once and only code offsets are
 * offered.
 */
export function codeOffsets(source) {
  const code = new Uint8Array(source.length);
  let state = "code";
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") { state = "line"; continue; }
      if (ch === "/" && next === "*") { state = "block"; i += 1; continue; }
      if (ch === "'" || ch === '"' || ch === "`") { state = ch; continue; }
      // A slash after an operator or an opening bracket starts a regex; after a
      // value it is division. The conservative reading is regex, because a
      // missed regex would offer its contents as predicates.
      if (ch === "/") {
        const before = source.slice(0, i).trimEnd();
        const last = before[before.length - 1];
        if (last === undefined || "=(,:[!&|?{};+-*%<>~^".includes(last)) { state = "regex"; continue; }
      }
      code[i] = 1;
      continue;
    }
    if (state === "line") { if (ch === "\n") state = "code"; continue; }
    if (state === "block") { if (ch === "*" && next === "/") { state = "code"; i += 1; } continue; }
    if (state === "regex") {
      if (ch === "\\") { i += 1; continue; }
      if (ch === "/") state = "code";
      continue;
    }
    // Inside a string of some kind.
    if (ch === "\\") { i += 1; continue; }
    if (ch === state) state = "code";
  }
  return code;
}

const lineOf = (source, offset) => source.slice(0, offset).split("\n").length;

/** One mutant per guard occurrence and per predicate operator, in file order. */
export function mutants(source) {
  const lines = source.split("\n");
  const out = [];
  for (const [index, line] of lines.entries()) {
    for (const rule of RULES) {
      if (!line.includes(rule.from)) continue;
      const mutated = [...lines];
      mutated[index] = line.replace(rule.from, rule.to);
      out.push({
        line: index + 1, kind: "emission", guard: rule.from,
        text: line.trim().slice(0, 90), source: mutated.join("\n"),
      });
    }
  }
  const code = codeOffsets(source);
  const taken = new Set();
  for (const rule of PREDICATE_RULES) {
    let at = source.indexOf(rule.from);
    while (at !== -1) {
      const end = at + rule.from.length;
      const inCode = [...Array(rule.from.length).keys()].every((offset) => code[at + offset] === 1);
      // A longer operator claims its offsets first: `>` inside `>=` is not a
      // separate site, and `=` after `!==` is not an equality.
      const overlaps = [...Array(rule.from.length).keys()].some((offset) => taken.has(at + offset));
      // `=>` is an arrow, not a comparison: mutating its `>` yields `=>=`,
      // which does not parse — and a mutant that cannot parse would be counted
      // as killed by every test, inflating exactly the number this command
      // exists to make honest.
      const arrow = rule.from === ">" && source[at - 1] === "=";
      const adjacent = /[=<>!&|]/u.test(source[at - 1] ?? "") || /[=<>!&|]/u.test(source[end] ?? "");
      if (inCode && !overlaps && !arrow && !adjacent) {
        for (let offset = at; offset < end; offset += 1) taken.add(offset);
        out.push({
          line: lineOf(source, at), kind: "predicate", guard: `${rule.from} -> ${rule.to}`,
          text: source.slice(source.lastIndexOf("\n", at) + 1, source.indexOf("\n", at)).trim().slice(0, 90),
          source: `${source.slice(0, at)}${rule.to}${source.slice(end)}`,
        });
      }
      at = source.indexOf(rule.from, at + 1);
    }
  }
  return out;
}

/** The pairs this command covers: a module and the test file that owns it. */
export function pairs(listing) {
  const tests = new Set(listing.tests);
  return listing.modules
    .map((name) => {
      const candidates = [`runtime-${name}.test.mjs`, `runtime-${name.replace(/-checks$/u, "")}.test.mjs`];
      const test = candidates.find((candidate) => tests.has(candidate));
      return test ? { module: `src/host/${name}.mjs`, test: `test/${test}` } : null;
    })
    .filter(Boolean);
}

function unnamedAgainst(entries, named) {
  const allowed = new Map(
    named.map((entry) => [`${entry.module}:${entry.line}`, entry]),
  );
  return entries.filter((entry) => !allowed.has(`${entry.module}:${entry.line}`));
}

/** A survivor is allowed only when it is named, at its line, with a reason. */
export function unnamedSurvivors(survivors, expected) {
  return unnamedAgainst(survivors, expected.equivalent_mutants);
}

/** A timeout kill is allowed only when it is named, at its line, with a reason. */
export function unnamedTimeoutKills(timedOut, expected) {
  return unnamedAgainst(timedOut, expected.non_terminating_mutants ?? []);
}

/**
 * How one spawn is classified.
 *
 * The harness asks the runner for TAP. An assertion kill is a `not ok` record
 * whose diagnostic names `failureType: testCodeFailure` — a declared test
 * that ran and failed. A hook failure (`hookFailed`), a file-level load
 * failure (no `failureType`), and any other unproven nonzero are environment.
 */
export function classifyRun(run) {
  if (run.status === 0) return "survived";
  if (run.status === null) return "timeout";
  if (tapTestCodeFailure(`${run.stdout ?? ""}${run.stderr ?? ""}`)) return "assertion";
  return "environment";
}

function tapTestCodeFailure(text) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^not ok \d+ - /u.test(lines[i])) continue;
    if (lines[i + 1] !== "  ---") continue;
    i += 2;
    while (i < lines.length && lines[i] !== "  ...") {
      if (/^  failureType: ['"]testCodeFailure['"]$/u.test(lines[i])) return true;
      i += 1;
    }
  }
  return false;
}

/** The number the owner's rule governs: tests that ran and failed. */
export function killedByAssertion(runs) {
  return runs.filter((run) => classifyRun(run) === "assertion").length;
}

/** The digest the report is cited by. */
export function reportDigest(report) {
  return createHash("sha256").update(JSON.stringify(report), "utf8").digest("hex");
}

/** The sidecar a run leaves beside a module while that module is mutated. */
export const BACKUP_SUFFIX = ".mutation-backup";

/**
 * Restores anything a previous run left mutated.
 *
 * `finally` does not run on SIGKILL, and a run killed mid-module leaves a
 * neutered guard in the working tree where the next `git add -A` would commit
 * it. Writing the original beside the module before touching it makes that
 * recoverable, and recovering is the first thing the next run does.
 */
export function restoreLeftovers({ readdirSync, readFileSync, writeFileSync, unlinkSync }, root = ROOT) {
  const dir = path.join(root, "src/host");
  const restored = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(BACKUP_SUFFIX)) continue;
    const backup = path.join(dir, name);
    const module = path.join(dir, name.slice(0, -BACKUP_SUFFIX.length));
    writeFileSync(module, readFileSync(backup, "utf8"));
    unlinkSync(backup);
    restored.push(name.slice(0, -BACKUP_SUFFIX.length));
  }
  return restored.sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { readdirSync, unlinkSync } = await import("node:fs");
  const leftovers = restoreLeftovers({ readdirSync, readFileSync, writeFileSync, unlinkSync });
  for (const name of leftovers) process.stderr.write(`restored ${name} from a killed run\n`);
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
  const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;

  const listing = {
    modules: readdirSync(path.join(ROOT, "src/host")).filter((n) => n.endsWith(".mjs")).map((n) => n.replace(/\.mjs$/u, "")).sort(),
    tests: readdirSync(path.join(ROOT, "test")),
  };
  const covered = pairs(listing).filter((pair) => !only || pair.module.includes(only));
  const expected = JSON.parse(readFileSync(path.join(ROOT, EXPECTED_PATH), "utf8"));

  const modules = [];
  const survivors = [];
  const timedOut = [];
  const environmentFailures = [];
  let assertionKilled = 0;
  for (const pair of covered) {
    const absolute = path.join(ROOT, pair.module);
    const original = readFileSync(absolute, "utf8");
    const backup = `${absolute}${BACKUP_SUFFIX}`;
    const cases = mutants(original);
    let killed = 0;
    writeFileSync(backup, original);
    try {
      for (const mutant of cases) {
        writeFileSync(absolute, mutant.source);
        // A mutant that flips a loop bound or an `&&` can hang rather than
        // fail, and an unbounded wait turns a six-minute run into an overnight
        // one. A timeout is still a kill — the tests did not pass — but it is
        // counted separately, because "the suite never finished" is a different
        // observation from "the suite failed", and it is admissible only when
        // the site is named with a proof that that mutant cannot terminate.
        //
        // `--test-isolation=none` matters more than the timeout: with the
        // default, the runner spawns a grandchild per test file, the timeout
        // kills only the direct child, and the grandchild is reparented to init
        // and keeps spinning. One looping mutant left an orphan burning a core
        // for eleven minutes, which is what actually exhausted this machine —
        // a harness that leaks a process per hanging mutant cannot finish a run
        // that has any.
        const run = spawnSync(process.execPath, [...TEST_SPAWN_ARGS, pair.test], {
          cwd: ROOT,
          encoding: "utf8",
          timeout: TEST_TIMEOUT_MS,
          killSignal: "SIGKILL",
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
        });
        // Status is not the classification: a load or setup failure also
        // exits 1, and that is not a test that ran and failed.
        const kind = classifyRun(run);
        if (kind === "survived") {
          survivors.push({ module: pair.module, line: mutant.line, guard: mutant.guard, text: mutant.text });
        } else if (kind === "timeout") {
          killed += 1;
          timedOut.push({ module: pair.module, line: mutant.line, guard: mutant.guard });
        } else if (kind === "assertion") {
          killed += 1;
          assertionKilled += 1;
        } else {
          environmentFailures.push({ module: pair.module, line: mutant.line, guard: mutant.guard });
        }
      }
    } finally {
      writeFileSync(absolute, original);
      unlinkSync(backup);
    }
    modules.push({ module: pair.module, test: pair.test, mutants: cases.length, killed });
    process.stderr.write(`${pair.module}: ${killed}/${cases.length}\n`);
  }

  const report = {
    schema_version: 1,
    modules: modules.sort((a, b) => (a.module < b.module ? -1 : 1)),
    totals: {
      modules: modules.length,
      mutants: modules.reduce((sum, entry) => sum + entry.mutants, 0),
      killed: modules.reduce((sum, entry) => sum + entry.killed, 0),
    },
    survivors: survivors.sort((a, b) => (a.module === b.module ? a.line - b.line : a.module < b.module ? -1 : 1)),
    killed_by_timeout: timedOut,
    environment_failures: environmentFailures,
  };
  const unnamed = unnamedSurvivors(report.survivors, expected);
  const unnamedTimeouts = unnamedTimeoutKills(report.killed_by_timeout, expected);
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`modules=${report.totals.modules} mutants=${report.totals.mutants} killed=${report.totals.killed}`);
  console.log(`survivors=${report.survivors.length} named=${report.survivors.length - unnamed.length}`);
  console.log(`killed_by_assertion=${assertionKilled}`);
  console.log(`killed_by_timeout=${report.killed_by_timeout.length} named=${report.killed_by_timeout.length - unnamedTimeouts.length}`);
  console.log(`environment_failures=${report.environment_failures.length}`);
  console.log(`report_digest=${reportDigest(report)}`);
  for (const entry of unnamed) console.error(`unnamed survivor ${entry.module}:${entry.line} ${entry.text}`);
  for (const entry of unnamedTimeouts) console.error(`unnamed timeout ${entry.module}:${entry.line} ${entry.guard}`);
  for (const entry of environmentFailures) console.error(`environment failure ${entry.module}:${entry.line} ${entry.guard}`);
  if (unnamed.length > 0 || unnamedTimeouts.length > 0 || environmentFailures.length > 0) process.exitCode = 1;
}
