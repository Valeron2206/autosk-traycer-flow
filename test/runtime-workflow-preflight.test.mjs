/**
 * Tests for the dispatch gate (issue #34, "one implementation, two callers").
 *
 * The gate exists so that a workflow cannot start on a project doctor calls
 * broken. These check the two halves of that: the required sets are real names
 * that exist, and every non-pass status on a required check stops the dispatch.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildReport } from "../src/host/doctor.mjs";
import { checkRegistry } from "../src/host/doctor-checks.mjs";
import {
  REQUIRED_CHECKS,
  WORKFLOWS,
  admits,
  assertAdmits,
  preflight,
  requiredFor,
} from "../src/host/workflow-preflight.mjs";

const NOW = Date.parse("2026-09-08T12:00:00.000Z");

const provenance = {
  tool: "autosk-flow-doctor",
  version: "0.0.0",
  checked_at: new Date(NOW).toISOString(),
  expires_at: new Date(NOW + 300_000).toISOString(),
};

/** A report where everything passes, built from the real registry's ids. */
function passingReport(overrides = new Map()) {
  const checks = checkRegistry(fakeEnv()).map((entry) => ({
    id: entry.id,
    category: entry.category,
    status: overrides.get(entry.id) ?? "pass",
    evidence: {},
    provenance,
    ...(overrides.get(entry.id) === "unverifiable" ? { unverifiable_reason: "not read-only" } : {}),
    ...(overrides.get(entry.id) === "fail" ? { remediation: "do the thing" } : {}),
  }));
  return buildReport({
    checks,
    projectIdentity: "autosk-flow:test",
    runtimeIdentity: "r".repeat(64),
    tool: { name: "autosk-flow-doctor", version: "0.0.0" },
    generatedAt: new Date(NOW).toISOString(),
  });
}

function fakeEnv() {
  return {
    root: "/project",
    home: "/home/operator",
    processEnv: {},
    nowMs: () => NOW,
    toolVersion: "0.0.0",
    nodeVersion: "v24.4.0",
    requiredNodeMajor: 24,
    daemonBinary: "/bin/autoskd",
    helperBinary: "/bin/autosk-store-lock",
    join: (...parts) => parts.join("/"),
    async readFile(relative) {
      if (relative === "compat/autosk/manifest.v1.json") {
        return JSON.stringify({ upstream: { commit: "abc" }, patches: [], result_tree: "t" });
      }
      if (relative === "resources/artifact-registry/artifact-registry.v1.json") {
        return JSON.stringify({ classes: [{ class: "contract_document", paths: [] }] });
      }
      if (relative === "resources/design-candidate/design-candidate.v1.json") {
        return JSON.stringify({ required_panel: [1, 2, 3, 4].map((n) => ({ seat: `s${n}`, route: `r${n}` })) });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    async readFileBytes() {
      return Buffer.from("bytes");
    },
    async stat() {
      return { size: 1 };
    },
    async run(command, args) {
      if (command === "git" && args[0] === "status") return { code: 0, stdout: "" };
      if (command === "git" && args[0] === "remote") return { code: 0, stdout: "origin\n" };
      return { code: 0, stdout: "ok\n" };
    },
    async which() {
      return "";
    },
  };
}

test("every required check is a check that exists", () => {
  // A required set naming a check nobody implements would block every dispatch
  // with a reason that reads like a bug in the project.
  const known = new Set(checkRegistry(fakeEnv()).map((entry) => entry.id));
  for (const workflow of WORKFLOWS) {
    for (const id of requiredFor(workflow)) {
      assert.ok(known.has(id), `${workflow} requires ${id}, which no check produces`);
    }
  }
});

test("an unknown workflow is refused rather than admitted by default", () => {
  assert.throws(() => requiredFor("whatever"), (error) => error.code === "doctor_required_set_unsatisfied");
});

test("a healthy project admits every workflow", () => {
  const report = passingReport();
  for (const workflow of WORKFLOWS) {
    assert.equal(admits(report, workflow, NOW).ready, true, workflow);
  }
});

test("a required check that warns blocks the workflow that requires it", () => {
  // ...and only that one: the difference lives in the declaration, not in the
  // report.
  const report = passingReport(new Map([["git_delivery.origin_configured", "warn"]]));
  assert.equal(admits(report, "delivery", NOW).ready, false);
  assert.equal(admits(report, "planning", NOW).ready, true);
  assert.equal(admits(report, "implementation", NOW).ready, true);
});

test("a required check that could not be established blocks too", () => {
  // "We could not test it" never becomes "it passed" for anyone who depends on
  // it, even though the same status leaves the overall report green.
  const report = passingReport(new Map([["daemon.binary_present", "unverifiable"]]));
  assert.equal(report.status, "pass");
  assert.deepEqual(admits(report, "implementation", NOW).blocking, [
    { id: "daemon.binary_present", reason: "doctor_check_unverifiable" },
  ]);
  assert.equal(admits(report, "planning", NOW).ready, true);
});

test("an expired report admits nothing that depends on the expired check", () => {
  const report = passingReport();
  const later = NOW + 600_000;
  assert.equal(admits(report, "planning", later).ready, false);
  for (const entry of admits(report, "planning", later).blocking) {
    assert.equal(entry.reason, "doctor_check_expired");
  }
});

test("assertAdmits names every blocking check, not only the first", () => {
  const report = passingReport(new Map([
    ["daemon.binary_present", "fail"],
    ["daemon.store_lock_helper", "fail"],
  ]));
  assert.throws(
    () => assertAdmits(report, "implementation", NOW),
    (error) =>
      error.code === "doctor_required_set_unsatisfied" &&
      error.details.blocking.length === 2 &&
      error.details.blocking.every((entry) => entry.endsWith(":doctor_required_set_unsatisfied")),
  );
  assert.doesNotThrow(() => assertAdmits(report, "planning", NOW));
});

test("preflight runs the same checks the doctor runs", async () => {
  // Not a second implementation: the same registry, asked a narrower question.
  const { report, admission } = await preflight(fakeEnv(), "planning", {
    projectIdentity: "autosk-flow:test",
    runtimeIdentity: "r".repeat(64),
    tool: { name: "autosk-flow-doctor", version: "0.0.0" },
  });
  assert.equal(report.checks.length, checkRegistry(fakeEnv()).length);
  assert.equal(admission.ready, true);
  const panel = await preflight(fakeEnv(), "panel", {
    projectIdentity: "autosk-flow:test",
    runtimeIdentity: "r".repeat(64),
    tool: { name: "autosk-flow-doctor", version: "0.0.0" },
  });
  assert.equal(panel.admission.ready, true);
});

test("planning does not require a daemon, and implementation does", () => {
  // Requiring one everywhere would park work that has no need of it, which is
  // how a gate becomes something people route around.
  assert.ok(!REQUIRED_CHECKS.planning.includes("daemon.binary_present"));
  assert.ok(REQUIRED_CHECKS.implementation.includes("daemon.binary_present"));
  const report = passingReport(new Map([["daemon.binary_present", "fail"]]));
  assert.equal(admits(report, "planning", NOW).ready, true);
  assert.equal(admits(report, "implementation", NOW).ready, false);
});
