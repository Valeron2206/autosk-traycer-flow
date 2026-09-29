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
import { COVERAGE, MATRIX_PATH, ROOT, coverageReport, faultCoverage, harnessCoverage } from "../scripts/clean-room-e2e.mjs";
import { coverageState } from "../scripts/lib/clean-room-coverage.mjs";

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
  // Debt 11f (R7-6): the entry carries what the run observed — detection and
  // control — and the state is read from it with the matrix's injection.
  const derived = faultCoverage({
    results: [
      { id: "F005", detected: true, control: true, detail: "the symlink escaped" },
      { id: "F006", detected: true, control: false, detail: "the guard refuses everything" },
      { id: "F007", detected: false, control: true, detail: "nothing was detected" },
    ],
  });
  const kind = (id) => matrix.groups.find((group) => group.id === id);
  // Debt 12e (R8-12): F005 is a measured observation, so its detected fault with a
  // silent control is answered by a host function — it does not count for the gate.
  assert.equal(coverageState(kind("F005"), derived.F005), "covered_by_host_function");
  assert.equal(coverageState(kind("F006"), derived.F006), "control_failed");
  assert.equal(coverageState(kind("F007"), derived.F007), "not_covered");
  // Demoted, not dropped: the row still says which harness looked at it.
  assert.equal(derived.F006.harness, "faults");
  assert.equal(derived.F006.evidence, "the guard refuses everything");
  assert.deepEqual({ detected: derived.F006.detected, control: derived.F006.control }, { detected: true, control: false });
});

/** The daemon harnesses' steps as they print their summaries: the creation harness's checks, all six crash points, and F004 with its control. */
const DAEMON_STEPS = Object.freeze([
  {
    step: "harness:creation",
    ok: true,
    summary: { passed: 2, checks: ["SIGKILL restart preserves creation identity", "legacy CLI output remains available"] },
  },
  {
    step: "harness:crash",
    ok: true,
    summary: {
      passed: 6,
      cases: ["reservation.before", "reservation.after", "task.before", "task.after", "activation.before", "activation.after"]
        .map((point) => ({ point })),
    },
  },
  { step: "harness:identity", ok: true, summary: { passed: 6, evidence: { fault: "F004", control: "resumed under the admitted digest" } } },
]);

test("the coverage table is derived from the run, and says how each group was covered", () => {
  // Debt 11f (R7-6): the run counted all twenty as covered by a real fault —
  // F001–F003, which ask no control, and every group whose guard is handed a
  // written observation. Each row's state is now the one its injection and
  // its control give, and the run is not complete.
  const covered = coverageReport(matrix, { ...harnessCoverage(DAEMON_STEPS), ...faultCoverage(report) });
  const kinds = (kind) => matrix.groups.filter((group) => group.injection === kind).map((group) => group.id);
  const inState = (state) => covered.rows.filter((row) => row.state === state).map((row) => row.id);
  // Debt 12e: only F004 is the designed fault met on the product path, with a
  // silent control (it was F004 and the five measured groups: 6).
  assert.deepEqual(inState("covered_by_real_fault"), ["F004"]);
  // Debt 13f: F002's designed fault is the creation harness's (no control paired, as F001's).
  assert.deepEqual(inState("covered_without_control"), ["F001", "F002"]);
  assert.deepEqual(inState("covered_by_substitute_fault"), ["F003"]);
  assert.deepEqual(inState("covered_by_host_function"), kinds("measured_observation"));
  assert.deepEqual(inState("covered_by_written_observation"), kinds("written_observation"));
  assert.deepEqual(inState("control_failed"), []);
  assert.deepEqual(inState("not_covered"), []);
  assert.equal(covered.complete, false);
  // And the table on its own claims none of the groups: every one is covered
  // by the run, not by the declaration beside it — the daemon groups included.
  const declared = coverageReport(matrix);
  assert.equal(declared.counts.not_covered, matrix.groups.length);
});

test("every row's state is the one its matrix injection and its control give", () => {
  // Held on the real run: no written observation and no uncontrolled row is
  // covered by a real fault, and a real fault needs a real injection.
  const covered = coverageReport(matrix, { ...harnessCoverage(DAEMON_STEPS), ...faultCoverage(report) });
  for (const row of covered.rows) {
    const group = matrix.groups.find((entry) => entry.id === row.id);
    assert.equal(row.injection, group.injection, row.id);
    assert.equal(row.injection_matches_design, group.injection_matches_design, row.id);
    const expected = !row.detected ? "not_covered"
      : row.control === false ? "control_failed"
        : group.injection === "written_observation" ? "covered_by_written_observation"
          : group.injection === "measured_observation" ? "covered_by_host_function"
            : group.injection_matches_design !== true ? "covered_by_substitute_fault"
              : row.control === true ? "covered_by_real_fault" : "covered_without_control";
    assert.equal(row.state, expected, row.id);
    if (row.state === "covered_by_real_fault") {
      // Debt 12e: the gate counts the product path only, and only the designed fault.
      assert.equal(group.injection, "real_path", row.id);
      assert.equal(group.injection_matches_design, true, row.id);
      assert.equal(row.control, true, row.id);
    }
  }
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
  assert.match(fault.F019[0], /^update-ref -d refs\/autosk\/epics\/[0-9a-f]{64}\/candidates\/[0-9a-f]{64}$/u);
  assert.match(fault.F020[0], /^update-ref --create-reflog refs\/autosk\/epics\/[0-9a-f]{64}\/audit\/candidates\/[0-9a-f]{64}$/u);
  assert.match(fault.F020[1], /^update-ref -d refs\/autosk\/epics\/[0-9a-f]{64}\/candidates\/[0-9a-f]{64}$/u);
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
      assert.ok(["creation", "crash", "identity"].includes(COVERAGE[group.id].harness), group.id);
      // Debt 11f (R7-6): the table names the harness and what its run must
      // show; whether the fault was detected is the run's, never the table's.
      for (const claim of ["real_fault", "detected", "control"]) {
        assert.equal(Object.hasOwn(COVERAGE[group.id], claim), false, `${group.id} declares ${claim}`);
      }
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

test("every ref the harness writes under refs/autosk/** is one the helper's grammar has (R7-22)", async () => {
  // Round 7 of #39, R7-22: F017-F020 wrote `.../candidate` and `.../audit`,
  // names the helper's closed grammar never creates, so those rows were
  // evidence about refs the design does not have. The harness's own git
  // stands where the helper would write (the helper is #5 work); the names it
  // writes are the helper's.
  const { PROTECTED_REF } = await import("../src/host/ref-custody.mjs");
  const written = new Set();
  for (const entry of report.results) {
    for (const command of [...entry.git_ref_writes.fixture, ...entry.git_ref_writes.fault]) {
      for (const ref of command.split(" ").filter((part) => part.startsWith("refs/autosk/"))) written.add(ref);
    }
  }
  assert.ok(written.size >= 4, [...written].join(", "));
  for (const ref of written) assert.ok(PROTECTED_REF.test(ref), ref);
  for (const kind of ["planning", "staging", "candidates/", "audit/candidates/"]) {
    assert.ok([...written].some((ref) => ref.includes(`/${kind}`)), kind);
  }
  // And the matrix says why the harness, not the helper, writes them.
  for (const id of ["F017", "F018", "F019", "F020"]) {
    const group = matrix.groups.find((entry) => entry.id === id);
    assert.match(group.injection_note, /stands in for the ref-custody helper/u, id);
  }
});
