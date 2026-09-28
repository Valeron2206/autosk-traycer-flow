/**
 * Tests for the clean-room runner (issue #36).
 *
 * The runner itself is exercised by running it; these cover the parts that
 * decide what the run means — what the environment may carry, what the
 * toolchain is allowed to bring in, and the coverage report, which has to say
 * what was not covered rather than implying the matrix was finished — and,
 * over stubbed steps (`test/support/clean-room-steps.mjs`), every return of
 * the run itself.
 */

import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  CLEAN_ROOM_IO,
  COVERAGE,
  FORBIDDEN_ENV,
  MATRIX_PATH,
  ROOT,
  TOOLCHAIN,
  cleanRoomEnv,
  cleanRoomRun,
  coverageReport,
  environmentErrors,
  extensionIdentity,
  extensionSummary,
  faultCoverage,
  harnessCoverage,
  identityAcrossRun,
  resolveToolchain,
} from "../scripts/clean-room-e2e.mjs";
import { runFaults } from "../scripts/clean-room-faults.mjs";
import { COVERAGE_STATES, coverageState } from "../scripts/lib/clean-room-coverage.mjs";
import { stubbedSteps } from "./support/clean-room-steps.mjs";

const matrix = JSON.parse(await readFile(path.join(ROOT, MATRIX_PATH), "utf8"));

/** A readable identity, as `extensionIdentity` reports one. */
const IDENTITY = Object.freeze({ commit: "c".repeat(40), tree: "t".repeat(40), dirty: false, error: null });

// Review of 11g (C1): the first start-and-end identity read shadowed its own
// variable. Every early return threw a ReferenceError that replaced the
// step's error, and the success return recorded an identity with no tree,
// which the package refuses. The tests beside `identityAcrossRun` drove it
// alone; these drive `cleanRoomRun` itself through each of its returns.

test("the run takes its steps from its caller, and the defaults are the real ones", () => {
  assert.deepEqual(Object.keys(CLEAN_ROOM_IO).sort(), ["identity", "resolveToolchain", "run", "runFaults", "stat"]);
  assert.equal(CLEAN_ROOM_IO.identity, extensionIdentity);
  assert.equal(CLEAN_ROOM_IO.resolveToolchain, resolveToolchain);
  assert.equal(CLEAN_ROOM_IO.stat, stat);
  assert.equal(CLEAN_ROOM_IO.runFaults, runFaults);
  assert.equal(typeof CLEAN_ROOM_IO.run, "function");
  assert.ok(Object.isFrozen(CLEAN_ROOM_IO));
});

test("a readable extension identity records no error, and an unreadable one says why", async () => {
  const outputs = { "rev-parse HEAD^{tree}": `${"t".repeat(40)}\n`, "rev-parse HEAD": `${"c".repeat(40)}\n`, "status --porcelain": "" };
  const clean = async (args) => ({ stdout: outputs[args.join(" ")] });
  assert.deepEqual(await extensionIdentity(clean), IDENTITY);
  const dirty = async (args) => ({ stdout: args[0] === "status" ? " M README.md\n" : outputs[args.join(" ")] });
  assert.deepEqual(await extensionIdentity(dirty), { ...IDENTITY, dirty: true });
  const broken = async () => {
    throw new Error("not a git repository");
  };
  assert.deepEqual(await extensionIdentity(broken), { commit: null, tree: null, dirty: null, error: "Error: not a git repository" });
});

test("every early return records the failing step's own error and the identity the run held", async () => {
  for (const step of ["prepare", "deps:daemon", "deps:pi-tools", "build:go", "build:daemon"]) {
    const failed = { ok: false, stdout: "", stderr: `${step} failed on purpose`, ms: 1 };
    const { io, calls } = stubbedSteps({ identities: [IDENTITY], answers: { [step]: failed } });
    const report = await cleanRoomRun({ io });
    assert.equal(report.error, `${step} failed on purpose`, step);
    assert.equal(report.ok, false, step);
    assert.deepEqual(report.steps.at(-1), { step, ok: false, ms: 1 }, step);
    assert.deepEqual(report.extension, IDENTITY, step);
    assert.deepEqual([calls[0], calls.at(-1)], ["identity", "identity"], step);
  }
  // The environment's return names what was missing.
  const missing = stubbedSteps({ identities: [IDENTITY], missingTools: ["go"] });
  const environment = await cleanRoomRun({ io: missing.io });
  assert.equal(environment.error, "environment");
  assert.deepEqual(environment.steps.at(-1).errors, [{ reason: "clean_room_toolchain_missing", detail: "go" }]);
  assert.deepEqual(environment.extension, IDENTITY);
  // A step that throws is caught with its own message.
  const thrown = stubbedSteps({ identities: [IDENTITY], statError: new Error("ENOENT: no bin/autoskd") });
  const threw = await cleanRoomRun({ io: thrown.io });
  assert.equal(threw.error, "Error: ENOENT: no bin/autoskd");
  assert.equal(threw.ok, false, "every step that ran passed, and the run still failed");
  assert.deepEqual(threw.extension, IDENTITY);
});

test("the success return records the tree the run held, a boolean dirty and no error", async () => {
  const crash = { ok: true, stdout: `building…\n{"passed":6}\n`, ms: 1 };
  const { io, calls } = stubbedSteps({ identities: [IDENTITY], answers: { "harness:crash": crash } });
  const report = await cleanRoomRun({ io });
  // A harness's summary is its last JSON line; a harness that printed none has none.
  assert.deepEqual(report.steps.find((step) => step.step === "harness:crash").summary, { passed: 6 });
  assert.equal(report.steps.find((step) => step.step === "harness:creation").summary, null);
  assert.equal(report.ok, true);
  assert.equal(report.error, null);
  assert.equal(typeof report.extension.tree, "string");
  assert.equal(typeof report.extension.dirty, "boolean");
  assert.equal(report.extension.error, null);
  assert.deepEqual(report.extension, IDENTITY);
  assert.equal(report.source_tree, "s".repeat(40));
  // The identity is read before the first step and after the last.
  assert.deepEqual(calls, [
    "identity", "prepare", "deps:daemon", "deps:pi-tools", "build:go", "build:daemon",
    "harness:creation", "harness:crash", "harness:identity", "harness:faults", "identity",
  ]);
});

test("an extension that changes while the run runs is recorded as not clean", async () => {
  const moved = { ...IDENTITY, commit: "d".repeat(40), tree: "u".repeat(40) };
  const { io } = stubbedSteps({ identities: [IDENTITY, moved] });
  const report = await cleanRoomRun({ io });
  assert.deepEqual(report.extension, {
    commit: IDENTITY.commit,
    tree: IDENTITY.tree,
    dirty: null,
    error: `extension moved during the run: ${"c".repeat(40)} (tree ${"t".repeat(40)}, clean) -> ${"d".repeat(40)} (tree ${"u".repeat(40)}, clean)`,
  });
  // An early return is held to the same comparison.
  const early = stubbedSteps({ identities: [IDENTITY, moved], answers: { prepare: { ok: false, stdout: "", stderr: "x", ms: 1 } } });
  const stopped = await cleanRoomRun({ io: early.io });
  assert.equal(stopped.error, "x");
  assert.equal(stopped.extension.dirty, null);
});

test("the extension identity is the run's only when it held from the first step to the last", () => {
  // CodeRabbit on #271: the identity was read once, in `finish`, minutes after
  // the steps read the extension's bytes, so a commit, a branch switch or a
  // revert during the run let the report claim a tree, or a clean worktree,
  // that the run did not load.
  const start = Object.freeze({ commit: "c".repeat(40), tree: "t".repeat(40), dirty: false });
  assert.deepEqual(identityAcrossRun(start, { ...start }), start);
  const moves = [
    [{ ...start, commit: "d".repeat(40) }, `${"d".repeat(40)} (tree ${"t".repeat(40)}, clean)`],
    [{ ...start, commit: "d".repeat(40), tree: "u".repeat(40) }, `${"d".repeat(40)} (tree ${"u".repeat(40)}, clean)`],
    [{ ...start, dirty: true }, `${"c".repeat(40)} (tree ${"t".repeat(40)}, dirty)`],
  ];
  for (const [end, named] of moves) {
    assert.deepEqual(identityAcrossRun(start, end), {
      commit: start.commit,
      tree: start.tree,
      dirty: null,
      error: `extension moved during the run: ${"c".repeat(40)} (tree ${"t".repeat(40)}, clean) -> ${named}`,
    });
  }
  // An identity that could not be read at either end is not clean either.
  const unreadable = Object.freeze({ commit: null, tree: null, dirty: null, error: "Error: not a git repository" });
  assert.deepEqual(identityAcrossRun(unreadable, start), unreadable);
  assert.deepEqual(identityAcrossRun(start, unreadable), unreadable);
  // The command's line says which of the three it was.
  assert.equal(extensionSummary(start), `extension_tree=${"t".repeat(40)}`);
  assert.equal(extensionSummary({ ...start, dirty: true }), `extension_tree=${"t".repeat(40)} (dirty)`);
  assert.equal(
    extensionSummary(identityAcrossRun(start, { ...start, dirty: true })),
    `extension_tree=${"t".repeat(40)} (extension moved during the run: ${"c".repeat(40)} (tree ${"t".repeat(40)}, clean) -> ${"c".repeat(40)} (tree ${"t".repeat(40)}, dirty))`,
  );
  assert.equal(extensionSummary(unreadable), "extension_tree=null (Error: not a git repository)");
});

test("the environment is a fresh HOME with no Traycer in it", () => {
  const env = cleanRoomEnv({ home: "/tmp/clean/home", sourceDir: "/tmp/clean/source" });
  assert.equal(env.HOME, "/tmp/clean/home");
  assert.deepEqual(environmentErrors(env), []);
  for (const name of FORBIDDEN_ENV) {
    assert.ok(
      environmentErrors({ ...env, [name]: "/opt/traycer" })
        .some((error) => error.reason === "clean_room_traycer_present"),
      name,
    );
  }
  // A variable that merely points into a Traycer directory counts too.
  assert.ok(
    environmentErrors({ ...env, SOME_CONFIG: "/home/x/.traycer/config" })
      .some((error) => error.reason === "clean_room_traycer_present"),
  );
});

test("the operator's PATH is not inherited; the toolchain is admitted by name", () => {
  // Inheriting it would let anything on that path answer for one of these
  // tools.
  const env = cleanRoomEnv({
    home: "/tmp/clean/home",
    sourceDir: "/tmp/clean/source",
    toolchainDirs: ["/opt/homebrew/bin"],
  });
  const entries = env.PATH.split(":");
  assert.equal(entries[0], "/tmp/clean/source/bin");
  assert.ok(entries.includes("/opt/homebrew/bin"));
  assert.ok(entries.includes("/usr/bin"));
  assert.ok(!entries.includes(process.env.HOME ?? "never"));
  // Duplicates are collapsed, so the reported path is the path.
  const duplicated = cleanRoomEnv({
    home: "/h",
    sourceDir: "/s",
    toolchainDirs: ["/usr/bin", "/usr/bin"],
  });
  assert.equal(new Set(duplicated.PATH.split(":")).size, duplicated.PATH.split(":").length);
});

test("the module cache is declared and lives outside the ephemeral HOME", () => {
  // The clean room isolates autosk state, not Go's package cache; burying the
  // cache in a directory deleted after every run would re-download everything
  // and prove nothing extra.
  const env = cleanRoomEnv({ home: "/tmp/clean/home", sourceDir: "/s", moduleCache: "/tmp/modcache" });
  assert.equal(env.GOMODCACHE, "/tmp/modcache");
  assert.ok(!env.GOMODCACHE.startsWith(env.HOME));
  assert.equal(cleanRoomEnv({ home: "/h", sourceDir: "/s" }).GOMODCACHE, undefined);
});

test("the toolchain resolves by walking the path, not by asking a shell", () => {
  // A shell would apply the operator's aliases and functions, which are not
  // what a build would execute.
  assert.deepEqual(TOOLCHAIN.slice(), ["bun", "go", "make", "git", "node"]);
  return resolveToolchain("/usr/bin:/bin").then((found) => {
    assert.equal(typeof found, "object");
    for (const dir of Object.values(found)) {
      assert.ok(dir === "/usr/bin" || dir === "/bin", dir);
    }
  });
});

test("the coverage report names what was not covered", () => {
  // A run that listed sixteen groups and exercised four would be the artefact
  // this program keeps finding.
  // Debt 11f (R7-6): the declared table no longer counts F001–F004 covered on
  // its own — with no run, no group is covered, the daemon groups included.
  const report = coverageReport(matrix);
  assert.equal(report.rows.length, matrix.groups.length);
  assert.equal(report.complete, false);
  assert.equal(report.counts.not_covered, matrix.groups.length);
  for (const row of report.rows) {
    assert.ok(COVERAGE_STATES.includes(row.state), row.id);
    assert.equal(row.detected, false, row.id);
  }
  // Review of 11f (L3): a run with no harness step names no harness on any
  // row, and carries no evidence — the rule the old table stated.
  const nothingRan = coverageReport(matrix, harnessCoverage([{ step: "prepare", ok: false }]));
  for (const row of nothingRan.rows) {
    assert.equal(row.state, "not_covered", row.id);
    assert.equal(row.harness, null, row.id);
    assert.equal(row.evidence, null, row.id);
  }
});

test("every fault-matrix group has a coverage entry, so none is silently absent", () => {
  for (const group of matrix.groups) {
    assert.ok(Object.hasOwn(COVERAGE, group.id), `${group.id} has no coverage entry`);
  }
  for (const id of Object.keys(COVERAGE)) {
    assert.ok(matrix.groups.some((group) => group.id === id), `${id} is not in the matrix`);
  }
});

// Debt 11f (R7-6, round 7 of #39): `clean-room-e2e.md` §7 counts a group as
// covered by a real fault only when the fault was detected and its control
// stayed silent, and the run counted all twenty — F001–F003, which ask no
// control, and the eleven groups whose guard is handed an observation the
// harness wrote. The state now says how a group was covered, from the matrix's
// `injection`, what the run detected and whether a control was asked.

const group = (id) => matrix.groups.find((entry) => entry.id === id);

test("only a detected fault that reached what answers for real, with a silent control, is covered by a real fault", () => {
  assert.deepEqual([...COVERAGE_STATES], [
    "covered_by_real_fault",
    "covered_without_control",
    "covered_by_written_observation",
    "control_failed",
    "not_covered",
  ]);
  const seen = (detected, control) => ({ harness: "h", evidence: "e", detected, control });
  for (const injection of ["real_path", "measured_observation"]) {
    assert.equal(coverageState({ injection }, seen(true, true)), "covered_by_real_fault", injection);
    // Detected, and nobody asked the un-faulted question: the crash harness.
    assert.equal(coverageState({ injection }, seen(true, null)), "covered_without_control", injection);
  }
  // A guard handed a state the harness wrote answered a description, not the fault.
  assert.equal(coverageState({ injection: "written_observation" }, seen(true, true)), "covered_by_written_observation");
  assert.equal(coverageState({ injection: "written_observation" }, seen(true, null)), "covered_by_written_observation");
  // A control that did not stay silent demotes the row, whatever the kind.
  for (const injection of ["real_path", "measured_observation", "written_observation"]) {
    assert.equal(coverageState({ injection }, seen(true, false)), "control_failed", injection);
    assert.equal(coverageState({ injection }, seen(false, true)), "not_covered", injection);
  }
  // Nothing ran it, or a detection no harness reported: not covered.
  assert.equal(coverageState({ injection: "real_path" }, null), "not_covered");
  assert.equal(coverageState({ injection: "real_path" }, { harness: null, detected: true, control: true }), "not_covered");
  // A kind the rule does not know counts for nothing.
  assert.equal(coverageState({}, seen(true, true)), "not_covered");
  assert.equal(coverageState({ injection: "described" }, seen(true, true)), "not_covered");
});

/** The daemon harnesses' steps, in the shape `verify-autosk-{crash,identity}.mjs` print their summaries. */
const POINTS = ["reservation.before", "reservation.after", "task.before", "task.after", "activation.before", "activation.after"];
const crashStep = (points = POINTS, ok = true) => ({
  step: "harness:crash",
  ok,
  summary: ok ? { passed: points.length, failed: 0, skipped: 0, cases: points.map((point) => ({ point, outcome: "created" })) } : null,
});
const identityStep = (evidence = { fault: "F004", control: "resumed under the admitted digest" }, ok = true) => ({
  step: "harness:identity",
  ok,
  summary: ok ? { passed: 6, failed: 0, skipped: 0, evidence } : null,
});

test("a daemon group is covered only by its harness's own run, never by the table", () => {
  const ran = harnessCoverage([{ step: "prepare", ok: true }, crashStep(), identityStep()]);
  for (const id of ["F001", "F002", "F003"]) {
    assert.equal(ran[id].harness, "crash", id);
    assert.equal(ran[id].detected, true, id);
    // The crash harness injects at a point in a write and asks no control.
    assert.equal(ran[id].control, null, id);
    assert.equal(coverageState(group(id), ran[id]), "covered_without_control", id);
  }
  assert.equal(ran.F004.detected, true);
  assert.equal(ran.F004.control, true);
  assert.equal(coverageState(group("F004"), ran.F004), "covered_by_real_fault");
  // Review of 11f (L3): a covered group carries the evidence its harness's
  // run stands for.
  for (const id of ["F001", "F002", "F003", "F004"]) assert.equal(ran[id].evidence, COVERAGE[id].evidence, id);

  // A harness that failed covers nothing, and its rows say it failed.
  const failed = harnessCoverage([crashStep(POINTS, false), identityStep(undefined, false)]);
  for (const id of ["F001", "F002", "F003", "F004"]) assert.equal(coverageState(group(id), failed[id]), "not_covered", id);
  assert.equal(failed.F001.evidence, "the crash harness step failed");
  assert.equal(failed.F004.evidence, "the identity harness step failed");
  // A harness that never ran names nothing: no entry, so its rows name no harness.
  const none = harnessCoverage([{ step: "prepare", ok: false }]);
  for (const id of ["F001", "F002", "F003", "F004"]) {
    assert.equal(none[id], undefined, id);
    assert.equal(coverageState(group(id), none[id]), "not_covered", id);
  }
  // A group is detected by the points its harness reports for it, not by the step alone.
  const partial = harnessCoverage([crashStep(POINTS.filter((point) => !point.startsWith("task.")))]);
  assert.equal(partial.F001.detected, true);
  assert.equal(partial.F002.detected, false);
  // Both points of a pair, not one of them (review of 11f, L3).
  const half = harnessCoverage([crashStep(["reservation.before", ...POINTS.slice(2)])]);
  assert.equal(half.F001.detected, false);
  assert.equal(half.F001.evidence, "the crash harness passed without reporting reservation.after");
  assert.equal(half.F002.detected, true);
  // The identity harness answers for F004 only, and its control is the one it reports.
  const other = harnessCoverage([identityStep({ fault: "F009", control: "x" })]).F004;
  assert.equal(other.detected, false);
  assert.equal(other.evidence, "the identity harness passed without reporting F004");
  const uncontrolled = harnessCoverage([identityStep({ fault: "F004" })]).F004;
  assert.equal(coverageState(group("F004"), uncontrolled), "covered_without_control");
  // An empty control report is no control.
  const empty = harnessCoverage([identityStep({ fault: "F004", control: "" })]).F004;
  assert.equal(empty.control, null);
  assert.equal(coverageState(group("F004"), empty), "covered_without_control");
});

test("the coverage report of the current matrix counts no uncontrolled and no written group as covered by a real fault", () => {
  // Every case detected and every control silent, as the shipped run reports.
  const faults = {
    results: matrix.groups
      .filter((entry) => entry.injection !== "real_path")
      .map((entry) => ({ id: entry.id, detected: true, control: true, detail: `${entry.id} detail` })),
  };
  const report = coverageReport(matrix, {
    ...harnessCoverage([crashStep(), identityStep()]),
    ...faultCoverage(faults),
  });
  const byState = (state) => report.rows.filter((row) => row.state === state).map((row) => row.id);
  const byKind = (kind) => matrix.groups.filter((entry) => entry.injection === kind).map((entry) => entry.id);
  assert.deepEqual(byState("covered_without_control"), ["F001", "F002", "F003"]);
  assert.deepEqual(byState("covered_by_written_observation"), byKind("written_observation"));
  assert.deepEqual(byState("covered_by_real_fault"), ["F004", ...byKind("measured_observation")]);
  assert.deepEqual(report.counts, {
    covered_by_real_fault: 1 + byKind("measured_observation").length,
    covered_without_control: 3,
    covered_by_written_observation: byKind("written_observation").length,
    control_failed: 0,
    not_covered: 0,
  });
  // `complete` still means every group is covered by a real fault, and it is not.
  assert.equal(report.complete, false);
  assert.equal(report.controlled, matrix.groups.length - 3);
  for (const row of report.rows) {
    assert.equal(row.injection, group(row.id).injection, row.id);
    assert.equal(row.detected, true, row.id);
    // The row says whether a control was asked: not asked is null, not false.
    assert.equal(row.control, ["F001", "F002", "F003"].includes(row.id) ? null : true, row.id);
    // And it carries its evidence: the daemon harness's, or the case's own detail.
    assert.equal(row.evidence, COVERAGE[row.id].harness ? COVERAGE[row.id].evidence : `${row.id} detail`, row.id);
  }
  // A row whose control did not stay silent is demoted, not reported beside a real fault.
  const noisy = coverageReport(matrix, {
    ...faultCoverage({ results: [{ id: "F005", detected: true, control: false, detail: "refuses everything" }] }),
  });
  assert.equal(noisy.rows.find((row) => row.id === "F005").state, "control_failed");
  assert.equal(noisy.rows.find((row) => row.id === "F005").control, false);
  assert.equal(noisy.rows.find((row) => row.id === "F006").control, null);
  assert.equal(noisy.counts.control_failed, 1);
  // And the whole matrix is complete only when every row is a real fault.
  const everything = Object.fromEntries(
    matrix.groups.map((entry) => [entry.id, { harness: "h", evidence: "e", detected: true, control: true }]),
  );
  const whole = coverageReport({ groups: matrix.groups.map((entry) => ({ ...entry, injection: "measured_observation" })) }, everything);
  assert.equal(whole.complete, true);
  assert.equal(coverageReport(matrix, everything).complete, false);
});
