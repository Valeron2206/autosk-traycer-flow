#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BUN_STATUSES = ["pass", "fail", "skip", "todo", "canceled"];
const BUN_STATUS_SYMBOLS = new Map([
  ["\u2713", "pass"],
  ["\u2717", "fail"],
  ["\u00BB", "skip"],
  ["\u270E", "todo"],
]);
const GO_ACTIONS = new Set([
  "start",
  "run",
  "pause",
  "cont",
  "output",
  "pass",
  "fail",
  "skip",
  "bench",
  "build-output",
  "build-fail",
]);

function emptyBunCounts() {
  return Object.fromEntries(BUN_STATUSES.map((status) => [status, 0]));
}

function normalizeBunStatus(status) {
  return status === "cancelled" ? "canceled" : status;
}

function stripAnsi(text) {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function parseCount(value, errors, suiteName, label) {
  const count = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(count) || count < 0) {
    errors.push(`${suiteName}: invalid ${label} count ${value}`);
    return 0;
  }
  return count;
}

function addCount(counts, status, count, errors, suiteName, label) {
  if (count === 0) return;
  const next = counts[status] + count;
  if (!Number.isSafeInteger(next)) {
    errors.push(`${suiteName}: ${label} count overflow`);
    counts[status] = Number.MAX_SAFE_INTEGER;
    return;
  }
  counts[status] = next;
}

function sumCounts(counts, errors, suiteName, label) {
  let total = 0;
  for (const count of Object.values(counts)) {
    const next = total + count;
    if (!Number.isSafeInteger(next)) {
      errors.push(`${suiteName}: ${label} total overflow`);
      return Number.MAX_SAFE_INTEGER;
    }
    total = next;
  }
  return total;
}

function parseBunBodyStatus(line) {
  const parenthesized = line.match(/^\((pass|fail|skip|todo|canceled|cancelled)\)\s/);
  if (parenthesized) return normalizeBunStatus(parenthesized[1]);
  for (const [symbol, status] of BUN_STATUS_SYMBOLS.entries()) {
    if (line.startsWith(`${symbol} `)) return status;
  }
  return null;
}

export function parseBunTestLog(text, suiteName = "bun") {
  const errors = [];
  const cleaned = stripAnsi(String(text)).replace(/\r\n/g, "\n");
  const lines = cleaned.split("\n");
  const nonEmpty = lines
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.trim() !== "");

  const bodyCounts = emptyBunCounts();
  for (const { line } of nonEmpty) {
    const status = parseBunBodyStatus(line);
    if (status) addCount(bodyCounts, status, 1, errors, suiteName, `body ${status}`);
  }

  let version = null;
  const versionLine = nonEmpty.find(({ line }) => line.startsWith("bun test "));
  if (versionLine) {
    const versionMatch = versionLine.line.match(/^bun test (.+)$/);
    if (versionMatch) version = versionMatch[1];
    else errors.push(`${suiteName}: malformed bun version line at ${versionLine.lineNumber}`);
  } else {
    errors.push(`${suiteName}: missing bun version line`);
  }

  const finalLine = nonEmpty.at(-1);
  let tests = 0;
  let files = 0;
  let duration = null;
  if (!finalLine) {
    errors.push(`${suiteName}: empty log`);
    errors.push(`${suiteName}: missing or malformed final test summary`);
  } else {
    const finalMatch = finalLine.line.match(/^Ran (\d+) tests? across (\d+) files?\. \[([^\]]+)\]$/);
    if (!finalMatch) {
      errors.push(`${suiteName}: missing or malformed final test summary`);
    } else {
      tests = parseCount(finalMatch[1], errors, suiteName, "reported tests");
      files = parseCount(finalMatch[2], errors, suiteName, "reported files");
      duration = finalMatch[3];
    }
  }

  const summaryCounts = emptyBunCounts();
  const seenSummaryStatuses = new Set();
  let expectCalls = null;
  if (finalLine) {
    for (let index = nonEmpty.length - 2; index >= 0; index -= 1) {
      const line = nonEmpty[index].line;
      const statusMatch = line.match(/^\s*(\d+)\s+(pass|fail|skip|todo|canceled|cancelled)\b/);
      if (statusMatch) {
        const status = normalizeBunStatus(statusMatch[2]);
        if (seenSummaryStatuses.has(status)) errors.push(`${suiteName}: duplicate ${status} summary line`);
        seenSummaryStatuses.add(status);
        addCount(
          summaryCounts,
          status,
          parseCount(statusMatch[1], errors, suiteName, status),
          errors,
          suiteName,
          status,
        );
        continue;
      }
      const expectMatch = line.match(/^\s*(\d+)\s+expect\(\) calls\b/);
      if (expectMatch) {
        if (expectCalls !== null) errors.push(`${suiteName}: duplicate expect() summary line`);
        expectCalls = parseCount(expectMatch[1], errors, suiteName, "expect()");
        continue;
      }
      break;
    }
  }

  if (!seenSummaryStatuses.has("pass")) errors.push(`${suiteName}: missing pass count in final summary`);
  if (!seenSummaryStatuses.has("fail")) errors.push(`${suiteName}: missing fail count in final summary`);
  if (expectCalls === null) errors.push(`${suiteName}: missing expect() count in final summary`);

  if (tests > 0 || files > 0 || duration !== null) {
    const summaryTotal = sumCounts(summaryCounts, errors, suiteName, "summary status");
    const bodyTotal = sumCounts(bodyCounts, errors, suiteName, "body status");
    if (summaryTotal !== tests) {
      errors.push(`${suiteName}: summary status total ${summaryTotal} does not match reported tests ${tests}`);
    }
    if (bodyTotal !== tests) {
      errors.push(`${suiteName}: body status total ${bodyTotal} does not match reported tests ${tests}`);
    }
    for (const status of BUN_STATUSES) {
      if (bodyCounts[status] !== summaryCounts[status]) {
        errors.push(
          `${suiteName}: body ${status} count ${bodyCounts[status]} does not match summary ${summaryCounts[status]}`,
        );
      }
    }
  }

  if (summaryCounts.pass <= 0) errors.push(`${suiteName}: expected a positive pass count`);
  if (summaryCounts.fail !== 0) errors.push(`${suiteName}: ${summaryCounts.fail} failed test(s)`);
  if (summaryCounts.skip !== 0) errors.push(`${suiteName}: ${summaryCounts.skip} skipped test(s)`);
  if (summaryCounts.todo !== 0) errors.push(`${suiteName}: ${summaryCounts.todo} todo test(s)`);
  if (summaryCounts.canceled !== 0) errors.push(`${suiteName}: ${summaryCounts.canceled} canceled test(s)`);

  return {
    kind: "bun",
    status: errors.length === 0 ? "passed" : "failed",
    version,
    pass: summaryCounts.pass,
    fail: summaryCounts.fail,
    skip: summaryCounts.skip,
    todo: summaryCounts.todo,
    canceled: summaryCounts.canceled,
    expectCalls,
    tests,
    files,
    duration,
    bodyCounts,
    errors,
  };
}

function ensurePackage(packages, name) {
  let record = packages.get(name);
  if (!record) {
    record = {
      started: false,
      terminal: null,
      sawNoTestFiles: false,
      tests: new Map(),
    };
    packages.set(name, record);
  }
  return record;
}

function ensureTest(packageRecord, name) {
  let record = packageRecord.tests.get(name);
  if (!record) {
    record = { started: false, terminal: null };
    packageRecord.tests.set(name, record);
  }
  return record;
}

export function parseGoTestJsonl(text, suiteName = "go") {
  const errors = [];
  const packages = new Map();
  const individual = { pass: 0, fail: 0, skip: 0, run: 0 };
  const packageActions = { pass: 0, fail: 0, skip: 0, start: 0 };
  const failedTests = [];
  const skippedTests = [];
  const failedPackages = [];
  const failedBuilds = [];
  const packagesWithNoTests = [];
  const skippedPackages = [];
  const packageFinal = {};
  const buildActions = { output: 0, fail: 0 };

  const rawText = String(text).replace(/\r\n/g, "\n");
  if (rawText.trim() === "") errors.push(`${suiteName}: empty log`);

  const lines = rawText.split("\n");
  for (const [lineIndex, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line === "") continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      errors.push(`${suiteName}: line ${lineIndex + 1} is not valid JSON: ${error.message}`);
      continue;
    }

    if (!event || typeof event !== "object" || Array.isArray(event)) {
      errors.push(`${suiteName}: line ${lineIndex + 1} is not a JSON object`);
      continue;
    }
    if (typeof event.Action !== "string" || !GO_ACTIONS.has(event.Action)) {
      errors.push(`${suiteName}: line ${lineIndex + 1} has invalid Action`);
      continue;
    }
    if (event.Action === "build-output" || event.Action === "build-fail") {
      if (typeof event.ImportPath !== "string" || event.ImportPath === "") {
        errors.push(`${suiteName}: line ${lineIndex + 1} has invalid ImportPath`);
        continue;
      }
      if (event.Action === "build-output") {
        if (typeof event.Output !== "string") {
          errors.push(`${suiteName}: line ${lineIndex + 1} has invalid Output`);
          continue;
        }
        buildActions.output += 1;
      } else {
        buildActions.fail += 1;
        failedBuilds.push(event.ImportPath);
      }
      continue;
    }
    if (typeof event.Package !== "string" || event.Package === "") {
      errors.push(`${suiteName}: line ${lineIndex + 1} has invalid Package`);
      continue;
    }
    if (event.Test !== undefined && typeof event.Test !== "string") {
      errors.push(`${suiteName}: line ${lineIndex + 1} has invalid Test`);
      continue;
    }

    const packageRecord = ensurePackage(packages, event.Package);
    const testName = event.Test ?? null;

    if (event.Action === "output" && testName === null && typeof event.Output === "string") {
      if (event.Output.includes("[no test files]")) packageRecord.sawNoTestFiles = true;
      continue;
    }

    if (testName === null) {
      if (event.Action === "start") {
        packageRecord.started = true;
        packageActions.start += 1;
      } else if (["pass", "fail", "skip"].includes(event.Action)) {
        if (packageRecord.terminal !== null) {
          errors.push(`${suiteName}: package ${event.Package} has duplicate final action`);
        }
        packageRecord.terminal = event.Action;
        packageActions[event.Action] += 1;
        packageFinal[event.Package] = event.Action;
        if (event.Action === "skip") skippedPackages.push(event.Package);
        if (event.Action === "fail") failedPackages.push(event.Package);
      }
      continue;
    }

    const testRecord = ensureTest(packageRecord, testName);
    if (event.Action === "run") {
      testRecord.started = true;
      individual.run += 1;
    } else if (["pass", "fail", "skip"].includes(event.Action)) {
      if (testRecord.terminal !== null) {
        errors.push(`${suiteName}: test ${event.Package}/${testName} has duplicate final action`);
      }
      testRecord.terminal = event.Action;
      individual[event.Action] += 1;
      if (event.Action === "fail") failedTests.push(`${event.Package}/${testName}`);
      if (event.Action === "skip") skippedTests.push(`${event.Package}/${testName}`);
    }
  }

  const incompletePackages = [];
  const incompleteTests = [];
  for (const [packageName, packageRecord] of packages.entries()) {
    if (!packageRecord.started) errors.push(`${suiteName}: package ${packageName} is missing start`);
    if (packageRecord.terminal === null) {
      incompletePackages.push(packageName);
      errors.push(`${suiteName}: package ${packageName} is missing final action`);
    }
    if (packageRecord.terminal === "skip") {
      if (!packageRecord.sawNoTestFiles) {
        errors.push(`${suiteName}: package ${packageName} skip is missing no test files output`);
      }
      if (packageRecord.tests.size > 0) {
        errors.push(`${suiteName}: package ${packageName} skip has individual test result(s)`);
      }
      if (packageRecord.sawNoTestFiles && packageRecord.tests.size === 0) packagesWithNoTests.push(packageName);
    }
    for (const [testName, testRecord] of packageRecord.tests.entries()) {
      if (!testRecord.started) errors.push(`${suiteName}: test ${packageName}/${testName} is missing run`);
      if (testRecord.terminal === null) {
        incompleteTests.push(`${packageName}/${testName}`);
        errors.push(`${suiteName}: test ${packageName}/${testName} is missing final action`);
      }
    }
  }

  if (incompletePackages.length > 0) {
    errors.push(`${suiteName}: incomplete package result(s): ${incompletePackages.join(", ")}`);
  }
  if (incompleteTests.length > 0) {
    errors.push(`${suiteName}: incomplete test result(s): ${incompleteTests.join(", ")}`);
  }
  if (individual.pass <= 0) errors.push(`${suiteName}: expected a positive individual pass count`);
  if (individual.fail !== 0) errors.push(`${suiteName}: ${individual.fail} failed individual test(s)`);
  if (packageActions.fail !== 0) errors.push(`${suiteName}: ${packageActions.fail} failed package(s)`);
  if (buildActions.fail !== 0) errors.push(`${suiteName}: ${buildActions.fail} build failure(s)`);
  if (individual.skip !== 0) errors.push(`${suiteName}: ${individual.skip} skipped individual test(s)`);

  return {
    kind: "go-json",
    status: errors.length === 0 ? "passed" : "failed",
    individual,
    packageActions,
    buildActions,
    packagesWithNoTests,
    skippedPackages,
    packagesWithoutNoTestOutput: skippedPackages.filter((packageName) => !packages.get(packageName)?.sawNoTestFiles),
    packagesFinal: packageFinal,
    failedTests,
    skippedTests,
    failedPackages,
    failedBuilds,
    incompletePackages,
    incompleteTests,
    errors,
  };
}

export function verifyAutoskTests({ bunLog, goTestJsonl, piLog }) {
  const suites = {
    bun: parseBunTestLog(bunLog, "bun"),
    go: parseGoTestJsonl(goTestJsonl, "go"),
    pi: parseBunTestLog(piLog, "pi"),
  };
  const errors = Object.values(suites).flatMap((suite) => suite.errors);
  const totals = {
    pass: suites.bun.pass + suites.go.individual.pass + suites.pi.pass,
    fail: suites.bun.fail + suites.go.individual.fail + suites.pi.fail,
    skip: suites.bun.skip + suites.go.individual.skip + suites.pi.skip,
    todo: suites.bun.todo + suites.pi.todo,
    canceled: suites.bun.canceled + suites.pi.canceled,
    failedGoPackages: suites.go.packageActions.fail,
    failedGoBuilds: suites.go.buildActions.fail,
    goPackagesWithNoTests: suites.go.packagesWithNoTests.length,
  };

  return {
    schema_version: 1,
    status: errors.length === 0 ? "passed" : "failed",
    totals,
    suites,
    errors,
  };
}

function readLog(filePath) {
  const bytes = readFileSync(filePath);
  return {
    text: bytes.toString("utf8"),
    identity: {
      path: filePath,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

export function buildAutoskTestReport({ bunPath, goPath, piPath }) {
  const bun = readLog(bunPath);
  const go = readLog(goPath);
  const pi = readLog(piPath);
  return {
    ...verifyAutoskTests({
      bunLog: bun.text,
      goTestJsonl: go.text,
      piLog: pi.text,
    }),
    inputs: {
      bun: bun.identity,
      go: go.identity,
      pi: pi.identity,
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--help") return { help: true };
    if (!["--bun", "--go", "--pi", "--output"].includes(key) || value === undefined) {
      throw new Error(
        "usage: node scripts/verify-autosk-tests.mjs --bun <bun-test.log> --go <go-test.jsonl> --pi <pi-test.log> --output <test-summary.json>",
      );
    }
    args[key.slice(2)] = value;
  }
  for (const key of ["bun", "go", "pi", "output"]) {
    if (!args[key]) {
      throw new Error(
        "usage: node scripts/verify-autosk-tests.mjs --bun <bun-test.log> --go <go-test.jsonl> --pi <pi-test.log> --output <test-summary.json>",
      );
    }
  }
  return args;
}

export function runCli(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(
      "usage: node scripts/verify-autosk-tests.mjs --bun <bun-test.log> --go <go-test.jsonl> --pi <pi-test.log> --output <test-summary.json>",
    );
    return 0;
  }

  const report = buildAutoskTestReport({
    bunPath: args.bun,
    goPath: args.go,
    piPath: args.pi,
  });
  mkdirSync(path.dirname(args.output), { recursive: true });
  writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);

  if (report.status !== "passed") {
    for (const error of report.errors) console.error(error);
    return 1;
  }

  console.log(
    [
      "verified autosk tests",
      `bun=${report.suites.bun.pass}/0/0`,
      `go=${report.suites.go.individual.pass}/0/0`,
      `pi=${report.suites.pi.pass}/0/0`,
      `go_no_test_packages=${report.suites.go.packageActions.skip}`,
    ].join(" "),
  );
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
