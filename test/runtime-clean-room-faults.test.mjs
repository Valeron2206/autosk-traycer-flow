/**
 * Tests for the clean-room fault harness (issue #36, groups F005-F016).
 *
 * The harness is exercised by running it: every case creates its fault on disk
 * and asks the guard that owns the boundary. What is asserted here is the part
 * a run cannot assert about itself — that no group is silently absent, that a
 * detection is only claimed when the case's own control stayed silent, and that
 * the coverage table is derived from the run rather than declared beside it.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { CASES, runFaults } from "../scripts/clean-room-faults.mjs";
import { COVERAGE, MATRIX_PATH, ROOT, coverageReport, faultCoverage } from "../scripts/clean-room-e2e.mjs";

const matrix = JSON.parse(await readFile(path.join(ROOT, MATRIX_PATH), "utf8"));
const report = await runFaults();

test("every fault the harness owns is injected and detected", () => {
  for (const entry of report.results) {
    assert.equal(entry.detected, true, `${entry.id}: ${entry.detail}`);
  }
  assert.equal(report.detected, report.total);
});

test("every case's control stays silent without the fault", () => {
  // A guard that refuses everything would detect twelve faults and mean nothing
  // by it, so the control is what makes the detection a statement.
  for (const entry of report.results) {
    assert.equal(entry.control, true, `${entry.id}: the control did not stay silent`);
  }
  assert.equal(report.ok, true);
});

test("the harness owns exactly the groups the other two harnesses do not", () => {
  const owned = Object.keys(CASES);
  assert.deepEqual(owned, matrix.groups.map((group) => group.id).filter((id) => owned.includes(id)));
  for (const group of matrix.groups) {
    const covered = Object.hasOwn(CASES, group.id) || COVERAGE[group.id].harness !== null;
    if (!covered) {
      // Stated rather than passed over: F004 is the distribution swapped
      // between enroll and resume, and no harness performs it yet.
      assert.equal(group.id, "F004", `${group.id} is in the matrix and nothing covers it`);
    }
  }
});

test("a case that failed its control is not claimed as a real fault", () => {
  const derived = faultCoverage({
    results: [
      { id: "F005", detected: true, control: true, detail: "the symlink escaped" },
      { id: "F006", detected: true, control: false, detail: "the guard refuses everything" },
      { id: "F007", detected: false, control: true, detail: "nothing was detected" },
    ],
  });
  assert.equal(derived.F005.real_fault, true);
  assert.equal(derived.F006.real_fault, false);
  assert.equal(derived.F007.real_fault, false);
  // Demoted, not dropped: the row still says which harness looked at it.
  assert.equal(derived.F006.harness, "faults");
  assert.equal(derived.F006.evidence, "the guard refuses everything");
});

test("the coverage table is derived from the run, and the run completes it", () => {
  const covered = coverageReport(matrix, { ...COVERAGE, ...faultCoverage(report) });
  for (const id of Object.keys(CASES)) {
    assert.equal(covered.rows.find((row) => row.id === id).state, "covered_by_real_fault", id);
  }
  // Every group is now covered by a fault that actually ran, F004 included.
  assert.equal(covered.counts.not_covered, undefined);
  assert.equal(covered.counts.covered_by_real_fault, matrix.groups.length);
  assert.equal(covered.complete, true);
  // And the table on its own still claims none of the groups this harness owns:
  // they are covered by the run, not by the declaration beside it.
  const declared = coverageReport(matrix);
  assert.equal(declared.counts.not_covered, Object.keys(CASES).length);
});

// Debt 10h (R6-20, a1): the package said only F017–F020 touch Git directly.
// Which git commands that write a ref each case ran is now recorded by the run
// itself, split into fixture setup and the fault step, so the package can say
// it from a measurement rather than from prose.
test("each case records the ref-writing git commands it ran, fixture and fault apart", () => {
  const STAGING = "refs/autosk/epics/";
  const fault = Object.fromEntries(report.results.map((entry) => [entry.id, entry.git_ref_writes.fault]));
  assert.deepEqual(fault, {
    F005: [], F006: ["commit"], F007: ["commit"], F008: ["commit", "reset --hard"],
    F009: [], F010: [], F011: [], F012: [], F013: [], F014: [], F015: [],
    F016: ["update-ref refs/heads/main"],
    F017: [],
    F018: [fault.F018[0]],
    F019: [fault.F019[0]],
    F020: [fault.F020[0], fault.F020[1]],
  });
  assert.match(fault.F018[0], /^update-ref --create-reflog refs\/autosk\/epics\/[^ ]+\/planning$/u);
  assert.match(fault.F019[0], /^update-ref -d refs\/autosk\/epics\/[^ ]+\/candidate$/u);
  assert.match(fault.F020[0], /^update-ref --create-reflog refs\/autosk\/epics\/[^ ]+\/audit$/u);
  assert.match(fault.F020[1], /^update-ref -d refs\/autosk\/epics\/[^ ]+\/candidate$/u);
  // Fixture setup is recorded too, and no OID leaks into a command.
  const fixture = Object.fromEntries(report.results.map((entry) => [entry.id, entry.git_ref_writes.fixture]));
  assert.deepEqual(fixture.F005, []);
  assert.deepEqual(fixture.F006, ["commit"]);
  assert.ok(fixture.F015.some((command) => command.startsWith(`update-ref ${STAGING}`)), fixture.F015.join(", "));
  for (const entry of report.results) {
    for (const command of [...entry.git_ref_writes.fixture, ...entry.git_ref_writes.fault]) {
      assert.doesNotMatch(command, /\b[0-9a-f]{40}\b/u, `${entry.id}: ${command}`);
    }
  }
});

test("the clean-room report carries each case's git ref writes", async () => {
  const { faultRecords } = await import("../scripts/clean-room-e2e.mjs");
  const records = faultRecords(report);
  const f016 = records.find((entry) => entry.id === "F016");
  assert.deepEqual(f016.git_ref_writes.fault, ["update-ref refs/heads/main"]);
  assert.deepEqual(Object.keys(f016), ["id", "detected", "control", "detail", "git_ref_writes"]);
});

test("a real_path group is one a daemon harness covers, and no fault-harness case is one", () => {
  for (const group of matrix.groups) {
    if (group.injection === "real_path") {
      assert.equal(Object.hasOwn(CASES, group.id), false, group.id);
      assert.ok(["crash", "identity"].includes(COVERAGE[group.id].harness), group.id);
      assert.equal(COVERAGE[group.id].real_fault, true, group.id);
    } else {
      assert.equal(Object.hasOwn(CASES, group.id), true, group.id);
    }
  }
});

// Review of 10h (Low): every git subcommand the harness runs is classified —
// a ref writer is recorded, a known reader is not, anything else refuses —
// and a git call that bypasses the recorder may only read.
test("a git subcommand the recorder does not know refuses rather than going unrecorded", async () => {
  const { refWriteOf } = await import("../scripts/clean-room-faults.mjs");
  assert.equal(refWriteOf(["update-ref", "-d", "refs/autosk/x"]), "update-ref -d refs/autosk/x");
  assert.equal(refWriteOf(["commit", "--quiet", "-m", "base"]), "commit");
  assert.equal(refWriteOf(["rev-parse", "HEAD"]), null);
  assert.equal(refWriteOf(["reflog", "show", "refs/x"]), null);
  assert.throws(() => refWriteOf(["gc"]), /git gc is not classified/u);
  assert.throws(() => refWriteOf(["reflog", "expire", "--all"]), /git reflog expire is not classified/u);
  assert.throws(() => refWriteOf(["branch", "x"]), /not classified/u);
});

test("a direct git call outside the recorder only reads", async () => {
  const { GIT_READERS } = await import("../scripts/clean-room-faults.mjs");
  const source = await readFile(path.join(ROOT, "scripts/clean-room-faults.mjs"), "utf8");
  const direct = [...source.matchAll(/execFileAsync\('git', \['([a-z-]+)'/gu)].map((match) => match[1]);
  assert.ok(direct.length > 0);
  for (const subcommand of direct) assert.ok(GIT_READERS.has(subcommand), subcommand);
  // And every other git call is the recorder's own, so none escapes the scan.
  const recorder = [...source.matchAll(/execFileAsync\('git', args, \{/gu)].length;
  assert.equal(recorder, 1);
  assert.equal([...source.matchAll(/execFileAsync\('git'/gu)].length, direct.length + recorder);
});
