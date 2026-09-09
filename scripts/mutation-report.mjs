#!/usr/bin/env node

/**
 * The mutation run, as a command rather than a claim in a pull request.
 *
 * Every runtime module's guards are neutered one at a time and the module's own
 * test file is re-run. A mutant that survives is a missing test, a dead guard,
 * or an equivalent mutant — and the third is only allowed when somebody has
 * written down why, at the line it applies to. A survivor nobody has named
 * fails this command.
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

/**
 * How a guard is neutered.
 *
 * Each rule turns one refusal into a no-op that still evaluates its arguments,
 * so the mutant is a program that runs and simply never refuses.
 */
export const RULES = Object.freeze([
  { from: "demand(", to: "void (true && " },
  { from: "errors.push(", to: "void (" },
  { from: "reasons.push(", to: "void (" },
  { from: "findings.push(", to: "void (" },
  { from: "problems.push(", to: "void (" },
]);

/** One mutant per guard occurrence, in file order. */
export function mutants(source) {
  const lines = source.split("\n");
  const out = [];
  for (const [index, line] of lines.entries()) {
    for (const rule of RULES) {
      if (!line.includes(rule.from)) continue;
      const mutated = [...lines];
      mutated[index] = line.replace(rule.from, rule.to);
      out.push({ line: index + 1, guard: rule.from, text: line.trim().slice(0, 90), source: mutated.join("\n") });
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

/** A survivor is allowed only when it is named, at its line, with a reason. */
export function unnamedSurvivors(survivors, expected) {
  const allowed = new Map(
    expected.equivalent_mutants.map((entry) => [`${entry.module}:${entry.line}`, entry]),
  );
  return survivors.filter((entry) => !allowed.has(`${entry.module}:${entry.line}`));
}

/** The digest the report is cited by. */
export function reportDigest(report) {
  return createHash("sha256").update(JSON.stringify(report), "utf8").digest("hex");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { readdirSync } = await import("node:fs");
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
  for (const pair of covered) {
    const absolute = path.join(ROOT, pair.module);
    const original = readFileSync(absolute, "utf8");
    const cases = mutants(original);
    let killed = 0;
    try {
      for (const mutant of cases) {
        writeFileSync(absolute, mutant.source);
        const run = spawnSync(process.execPath, ["--test", pair.test], {
          cwd: ROOT,
          encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
        });
        if (run.status !== 0) killed += 1;
        else survivors.push({ module: pair.module, line: mutant.line, guard: mutant.guard, text: mutant.text });
      }
    } finally {
      writeFileSync(absolute, original);
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
  };
  const unnamed = unnamedSurvivors(report.survivors, expected);
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`modules=${report.totals.modules} mutants=${report.totals.mutants} killed=${report.totals.killed}`);
  console.log(`survivors=${report.survivors.length} named=${report.survivors.length - unnamed.length}`);
  console.log(`report_digest=${reportDigest(report)}`);
  for (const entry of unnamed) console.error(`unnamed survivor ${entry.module}:${entry.line} ${entry.text}`);
  if (unnamed.length > 0) process.exitCode = 1;
}
