import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseBunTestLog,
  parseGoTestJsonl,
  runCli,
  verifyAutoskTests,
} from "../scripts/verify-autosk-tests.mjs";

function bunLog({ pass = 1, fail = 0, skip = 0, todo = 0, canceled = 0 } = {}) {
  const lines = ["bun test v1.4.0 (34cbb9a40)", "", "fixture.test.ts:"];
  for (let index = 0; index < pass; index += 1) lines.push(`(pass) passes ${index} [0.01ms]`);
  for (let index = 0; index < fail; index += 1) lines.push(`(fail) fails ${index} [0.01ms]`);
  for (let index = 0; index < skip; index += 1) lines.push(`(skip) skips ${index}`);
  for (let index = 0; index < todo; index += 1) lines.push(`(todo) todos ${index}`);
  for (let index = 0; index < canceled; index += 1) lines.push(`(canceled) cancels ${index}`);
  lines.push("");
  if (pass > 0) lines.push(` ${pass} pass`);
  if (skip > 0) lines.push(` ${skip} skip`);
  if (todo > 0) lines.push(` ${todo} todo`);
  if (canceled > 0) lines.push(` ${canceled} canceled`);
  lines.push(` ${fail} fail`);
  lines.push(` ${pass + fail} expect() calls`);
  lines.push(`Ran ${pass + fail + skip + todo + canceled} tests across 1 file. [1.00ms]`);
  return `${lines.join("\n")}\n`;
}

function bunColorPositiveLog() {
  return [
    "\x1B[0m\x1B[1mbun test \x1B[0m\x1B[2mv1.4.0 (34cbb9a40)\x1B[0m",
    "\x1B[0m",
    "format.test.ts:",
    "\x1B[0m\x1B[32m\u2713\x1B[0m\x1B[0m\x1B[1m passes\x1B[0m \x1B[0m\x1B[2m[0.24ms\x1B[0m\x1B[2m]\x1B[0m",
    "",
    "\x1B[0m\x1B[32m 1 pass\x1B[0m",
    "\x1B[0m\x1B[2m 0 fail\x1B[0m",
    " 1 expect() calls",
    "Ran 1 test across 1 file. \x1B[0m\x1B[2m[\x1B[1m47.00ms\x1B[0m\x1B[2m]\x1B[0m",
    "",
  ].join("\n");
}

function unsafeBunCountLog() {
  return [
    "bun test v1.4.0 (34cbb9a40)",
    "",
    "format.test.ts:",
    "(pass) passes [0.03ms]",
    "",
    " 9007199254740992 pass",
    " 0 fail",
    " 1 expect() calls",
    "Ran 1 test across 1 file. [4.00ms]",
    "",
  ].join("\n");
}

function goEvent(event) {
  return `${JSON.stringify({ Time: "2026-09-07T00:00:00Z", ...event })}\n`;
}

function goLog({ pass = 1, fail = 0, skip = 0, noTestPackage = true } = {}) {
  let text = "";
  if (noTestPackage) {
    text += goEvent({ Action: "start", Package: "fixture/notests" });
    text += goEvent({ Action: "output", Package: "fixture/notests", Output: "?  \tfixture/notests\t[no test files]\n" });
    text += goEvent({ Action: "skip", Package: "fixture/notests", Elapsed: 0 });
  }
  text += goEvent({ Action: "start", Package: "fixture/pkg" });
  for (let index = 0; index < pass; index += 1) {
    text += goEvent({ Action: "run", Package: "fixture/pkg", Test: `TestPass${index}` });
    text += goEvent({ Action: "pass", Package: "fixture/pkg", Test: `TestPass${index}`, Elapsed: 0 });
  }
  for (let index = 0; index < fail; index += 1) {
    text += goEvent({ Action: "run", Package: "fixture/pkg", Test: `TestFail${index}` });
    text += goEvent({ Action: "fail", Package: "fixture/pkg", Test: `TestFail${index}`, Elapsed: 0 });
  }
  for (let index = 0; index < skip; index += 1) {
    text += goEvent({ Action: "run", Package: "fixture/pkg", Test: `TestSkip${index}` });
    text += goEvent({ Action: "skip", Package: "fixture/pkg", Test: `TestSkip${index}`, Elapsed: 0 });
  }
  text += goEvent({ Action: fail > 0 ? "fail" : "pass", Package: "fixture/pkg", Elapsed: 0 });
  return text;
}

function goWarningLog() {
  return goEvent({
    Action: "build-output",
    ImportPath: "example.invalid/logformat [example.invalid/logformat.test]",
    Output: "# example.invalid/logformat [example.invalid/logformat.test]\n./warning.go:3:2: warning: \"autosk format probe warning\" [-W#warnings]\n",
  })
    + goEvent({ Action: "start", Package: "example.invalid/logformat" })
    + goEvent({ Action: "run", Package: "example.invalid/logformat", Test: "TestPass" })
    + goEvent({ Action: "pass", Package: "example.invalid/logformat", Test: "TestPass", Elapsed: 0 })
    + goEvent({ Action: "pass", Package: "example.invalid/logformat", Elapsed: 0.397 });
}

function goBuildFailLog() {
  return goEvent({
    Action: "build-output",
    ImportPath: "example.invalid/logformat [example.invalid/logformat.test]",
    Output: "# example.invalid/logformat [example.invalid/logformat.test]\n",
  })
    + goEvent({
      Action: "build-output",
      ImportPath: "example.invalid/logformat [example.invalid/logformat.test]",
      Output: "./broken.go:2:14: undefined: undefinedForProbe\n",
    })
    + goEvent({
      Action: "build-fail",
      ImportPath: "example.invalid/logformat [example.invalid/logformat.test]",
    })
    + goEvent({ Action: "start", Package: "example.invalid/logformat" })
    + goEvent({
      Action: "output",
      Package: "example.invalid/logformat",
      Output: "FAIL\texample.invalid/logformat [build failed]\n",
    })
    + goEvent({
      Action: "fail",
      Package: "example.invalid/logformat",
      Elapsed: 0,
      FailedBuild: "example.invalid/logformat [example.invalid/logformat.test]",
    });
}

function messages(report) {
  return report.errors.join("\n");
}

test("accepts complete Bun, Go and Pi reports with positive pass counts", () => {
  const report = verifyAutoskTests({
    bunLog: bunLog({ pass: 3 }),
    goTestJsonl: goLog({ pass: 2, noTestPackage: true }),
    piLog: bunLog({ pass: 1 }),
  });
  assert.equal(report.status, "passed");
  assert.equal(report.suites.bun.pass, 3);
  assert.equal(report.suites.go.individual.pass, 2);
  assert.equal(report.suites.go.packageActions.skip, 1);
  assert.deepEqual(report.suites.go.packagesWithNoTests, ["fixture/notests"]);
  assert.equal(report.totals.goPackagesWithNoTests, 1);
});

test("counts Bun colored unicode status symbols after stripping ANSI", () => {
  const parsed = parseBunTestLog(bunColorPositiveLog());
  assert.equal(parsed.status, "passed");
  assert.equal(parsed.pass, 1);
  assert.equal(parsed.tests, 1);
  assert.deepEqual(parsed.bodyCounts, { pass: 1, fail: 0, skip: 0, todo: 0, canceled: 0 });
});

test("CLI writes a failure report for unsafe Bun counts", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "autosk-test-summary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bunPath = path.join(root, "bun-test.log");
  const goPath = path.join(root, "go-test.jsonl");
  const piPath = path.join(root, "pi-test.log");
  const outputPath = path.join(root, "build/evidence/test-summary.json");
  writeFileSync(bunPath, unsafeBunCountLog());
  writeFileSync(goPath, goLog({ pass: 1 }));
  writeFileSync(piPath, bunLog({ pass: 1 }));

  const originalError = console.error;
  const errors = [];
  console.error = (message) => errors.push(message);
  try {
    assert.equal(runCli(["--bun", bunPath, "--go", goPath, "--pi", piPath, "--output", outputPath]), 1);
  } finally {
    console.error = originalError;
  }
  assert.equal(existsSync(outputPath), true);
  const report = JSON.parse(readFileSync(outputPath, "utf8"));
  assert.equal(report.status, "failed");
  assert.match(messages(report), /bun: invalid pass count/);
  assert.match(errors.join("\n"), /bun: invalid pass count/);
});

test("rejects Bun summary count totals that overflow safe integers", () => {
  const parsed = parseBunTestLog([
    "bun test v1.4.0 (34cbb9a40)",
    "",
    "fixture.test.ts:",
    "(pass) passes [0.01ms]",
    "",
    " 9007199254740991 pass",
    " 1 fail",
    " 1 expect() calls",
    "Ran 1 test across 1 file. [1.00ms]",
    "",
  ].join("\n"));
  assert.equal(parsed.status, "failed");
  assert.match(messages(parsed), /bun: summary status total overflow/);
});

test("rejects individual skips from Bun and Go reports", () => {
  const bunSkipped = verifyAutoskTests({
    bunLog: bunLog({ pass: 1, skip: 1 }),
    goTestJsonl: goLog({ pass: 1 }),
    piLog: bunLog({ pass: 1 }),
  });
  assert.equal(bunSkipped.status, "failed");
  assert.match(messages(bunSkipped), /bun: 1 skipped test/);

  const goSkipped = verifyAutoskTests({
    bunLog: bunLog({ pass: 1 }),
    goTestJsonl: goLog({ pass: 1, skip: 1 }),
    piLog: bunLog({ pass: 1 }),
  });
  assert.equal(goSkipped.status, "failed");
  assert.match(messages(goSkipped), /go: 1 skipped individual test/);
});

test("rejects empty and absent final summaries", () => {
  const empty = verifyAutoskTests({
    bunLog: "",
    goTestJsonl: goLog({ pass: 1 }),
    piLog: bunLog({ pass: 1 }),
  });
  assert.equal(empty.status, "failed");
  assert.match(messages(empty), /bun: empty log/);
  assert.match(messages(empty), /bun: missing or malformed final test summary/);

  const missingFinal = verifyAutoskTests({
    bunLog: "bun test v1.4.0 (34cbb9a40)\n(pass) passes [0.01ms]\n 1 pass\n 0 fail\n 1 expect() calls\n",
    goTestJsonl: goLog({ pass: 1 }),
    piLog: bunLog({ pass: 1 }),
  });
  assert.equal(missingFinal.status, "failed");
  assert.match(messages(missingFinal), /bun: missing or malformed final test summary/);
});

test("rejects truncated Bun and Go reports", () => {
  const truncatedBun = verifyAutoskTests({
    bunLog: "bun test v1.4.0 (34cbb9a40)\n(pass) passes [0.01ms]\n",
    goTestJsonl: goLog({ pass: 1 }),
    piLog: bunLog({ pass: 1 }),
  });
  assert.equal(truncatedBun.status, "failed");
  assert.match(messages(truncatedBun), /bun: missing or malformed final test summary/);

  const truncatedGo = verifyAutoskTests({
    bunLog: bunLog({ pass: 1 }),
    goTestJsonl: goEvent({ Action: "start", Package: "fixture/pkg" })
      + goEvent({ Action: "run", Package: "fixture/pkg", Test: "TestNeverFinished" }),
    piLog: bunLog({ pass: 1 }),
  });
  assert.equal(truncatedGo.status, "failed");
  assert.match(messages(truncatedGo), /go: incomplete package result/);
  assert.match(messages(truncatedGo), /go: incomplete test result/);
});

test("rejects failed tests and nonzero Bun todo or canceled counts", () => {
  const failed = verifyAutoskTests({
    bunLog: bunLog({ pass: 1, fail: 1 }),
    goTestJsonl: goLog({ pass: 1, fail: 1 }),
    piLog: bunLog({ pass: 1 }),
  });
  assert.equal(failed.status, "failed");
  assert.match(messages(failed), /bun: 1 failed test/);
  assert.match(messages(failed), /go: 1 failed individual test/);
  assert.match(messages(failed), /go: 1 failed package/);
  assert.equal(failed.totals.fail, 2, "a failed Go package must not count its failed test twice");
  assert.equal(failed.totals.failedGoPackages, 1);

  const nonSuccess = verifyAutoskTests({
    bunLog: bunLog({ pass: 1, todo: 1, canceled: 1 }),
    goTestJsonl: goLog({ pass: 1 }),
    piLog: bunLog({ pass: 1 }),
  });
  assert.equal(nonSuccess.status, "failed");
  assert.match(messages(nonSuccess), /bun: 1 todo test/);
  assert.match(messages(nonSuccess), /bun: 1 canceled test/);
});

test("keeps Go package skips separate from individual skips", () => {
  const parsed = parseGoTestJsonl(goLog({ pass: 1, noTestPackage: true }));
  assert.equal(parsed.status, "passed");
  assert.equal(parsed.individual.skip, 0);
  assert.equal(parsed.packageActions.skip, 1);
  assert.deepEqual(parsed.packagesWithNoTests, ["fixture/notests"]);
});

test("accepts Go build-output warnings with ImportPath", () => {
  const parsed = parseGoTestJsonl(goWarningLog());
  assert.equal(parsed.status, "passed");
  assert.equal(parsed.individual.pass, 1);
  assert.equal(parsed.packageActions.pass, 1);
  assert.equal(parsed.buildActions.output, 1);
  assert.equal(parsed.buildActions.fail, 0);
});

test("reports Go build failures separately from test results and no-test packages", () => {
  const parsed = parseGoTestJsonl(goBuildFailLog());
  assert.equal(parsed.status, "failed");
  assert.equal(parsed.individual.fail, 0);
  assert.equal(parsed.packageActions.fail, 1);
  assert.equal(parsed.buildActions.output, 2);
  assert.equal(parsed.buildActions.fail, 1);
  assert.deepEqual(parsed.failedBuilds, ["example.invalid/logformat [example.invalid/logformat.test]"]);
  assert.deepEqual(parsed.packagesWithNoTests, []);
  assert.match(messages(parsed), /go: 1 build failure/);
});

test("rejects malformed Go build events", () => {
  const parsed = parseGoTestJsonl(
    goEvent({ Action: "build-output", ImportPath: "", Output: "warning\n" })
      + goLog({ pass: 1, noTestPackage: false }),
  );
  assert.equal(parsed.status, "failed");
  assert.match(messages(parsed), /go: line 1 has invalid ImportPath/);
});

test("rejects Go terminal events without lifecycle prerequisites", () => {
  const loneTerminalPass = parseGoTestJsonl(
    goEvent({ Action: "pass", Package: "fixture/pkg", Test: "TestPass" }),
  );
  assert.equal(loneTerminalPass.status, "failed");
  assert.match(messages(loneTerminalPass), /go: package fixture\/pkg is missing start/);
  assert.match(messages(loneTerminalPass), /go: test fixture\/pkg\/TestPass is missing run/);
  assert.match(messages(loneTerminalPass), /go: package fixture\/pkg is missing final action/);

  const missingPackageStart = parseGoTestJsonl(
    goEvent({ Action: "run", Package: "fixture/pkg", Test: "TestPass" })
      + goEvent({ Action: "pass", Package: "fixture/pkg", Test: "TestPass" })
      + goEvent({ Action: "pass", Package: "fixture/pkg", Elapsed: 0 }),
  );
  assert.equal(missingPackageStart.status, "failed");
  assert.match(messages(missingPackageStart), /go: package fixture\/pkg is missing start/);

  const missingTestRun = parseGoTestJsonl(
    goEvent({ Action: "start", Package: "fixture/pkg" })
      + goEvent({ Action: "pass", Package: "fixture/pkg", Test: "TestPass" })
      + goEvent({ Action: "pass", Package: "fixture/pkg", Elapsed: 0 }),
  );
  assert.equal(missingTestRun.status, "failed");
  assert.match(messages(missingTestRun), /go: test fixture\/pkg\/TestPass is missing run/);

  const missingPackageTerminal = parseGoTestJsonl(
    goEvent({ Action: "start", Package: "fixture/pkg" })
      + goEvent({ Action: "run", Package: "fixture/pkg", Test: "TestPass" })
      + goEvent({ Action: "pass", Package: "fixture/pkg", Test: "TestPass" }),
  );
  assert.equal(missingPackageTerminal.status, "failed");
  assert.match(messages(missingPackageTerminal), /go: package fixture\/pkg is missing final action/);
});

test("rejects Go package skip unless it is exactly a no-test package", () => {
  const skipWithoutNoTestOutput = parseGoTestJsonl(
    goEvent({ Action: "start", Package: "fixture/pkg" })
      + goEvent({ Action: "skip", Package: "fixture/pkg", Elapsed: 0 }),
  );
  assert.equal(skipWithoutNoTestOutput.status, "failed");
  assert.match(messages(skipWithoutNoTestOutput), /go: package fixture\/pkg skip is missing no test files output/);

  const skipWithIndividualTest = parseGoTestJsonl(
    goEvent({ Action: "start", Package: "fixture/pkg" })
      + goEvent({ Action: "output", Package: "fixture/pkg", Output: "?  \tfixture/pkg\t[no test files]\n" })
      + goEvent({ Action: "run", Package: "fixture/pkg", Test: "TestPass" })
      + goEvent({ Action: "pass", Package: "fixture/pkg", Test: "TestPass", Elapsed: 0 })
      + goEvent({ Action: "skip", Package: "fixture/pkg", Elapsed: 0 }),
  );
  assert.equal(skipWithIndividualTest.status, "failed");
  assert.match(messages(skipWithIndividualTest), /go: package fixture\/pkg skip has individual test result/);
});

test("rejects malformed Go JSON instead of ignoring it", () => {
  const malformed = verifyAutoskTests({
    bunLog: bunLog({ pass: 1 }),
    goTestJsonl: `${goLog({ pass: 1 })}not json\n`,
    piLog: bunLog({ pass: 1 }),
  });
  assert.equal(malformed.status, "failed");
  assert.match(messages(malformed), /go: line \d+ is not valid JSON/);
});

test("CLI writes a machine-readable report", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "autosk-test-summary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bunPath = path.join(root, "bun-test.log");
  const goPath = path.join(root, "go-test.jsonl");
  const piPath = path.join(root, "pi-test.log");
  const outputPath = path.join(root, "build/evidence/test-summary.json");
  writeFileSync(bunPath, bunLog({ pass: 1 }));
  writeFileSync(goPath, goLog({ pass: 1 }));
  writeFileSync(piPath, bunLog({ pass: 1 }));

  const originalLog = console.log;
  const logs = [];
  console.log = (message) => logs.push(message);
  try {
    assert.equal(runCli(["--bun", bunPath, "--go", goPath, "--pi", piPath, "--output", outputPath]), 0);
  } finally {
    console.log = originalLog;
  }
  assert.equal(existsSync(outputPath), true);
  assert.match(logs.join("\n"), /verified autosk tests/);
  const report = JSON.parse(readFileSync(outputPath, "utf8"));
  assert.equal(report.status, "passed");
  assert.equal(report.inputs.bun.sha256.length, 64);
});
