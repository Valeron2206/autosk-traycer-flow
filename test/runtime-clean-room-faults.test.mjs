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
