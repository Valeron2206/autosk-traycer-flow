/**
 * Tests for the dispatch gate (issue #34, "one implementation, two callers").
 *
 * The gate exists so that a workflow cannot start on a project doctor calls
 * broken. These check the two halves of that: the required sets are real names
 * that exist, and every non-pass status on a required check stops the dispatch.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseArgs, requiredSet } from "../scripts/autosk-flow-doctor.mjs";
import { buildReport } from "../src/host/doctor.mjs";
import { checkRegistry } from "../src/host/doctor-checks.mjs";
import {
  MODEL_STEP_CHECKS,
  PHASE_CHECKS,
  WORKFLOW_PHASES,
  admits,
  assertAdmits,
  preflight,
  registeredWorkflows,
  requiredChecks,
  requiredFor,
  runsModelStep,
} from "../src/host/workflow-preflight.mjs";

const GRAPH_TEXT = readFileSync(new URL("../resources/workflow-graph/workflow-graph.v1.json", import.meta.url), "utf8");
/** A fresh copy each time, so a test that edits one cannot leak into the next. */
const graph = () => JSON.parse(GRAPH_TEXT);
const GRAPH = graph();
const WORKFLOWS = registeredWorkflows(GRAPH).map((entry) => entry.name);

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
    // A healthy host declares where its signer is and the daemon says it runs
    // outside this process: that is what "the boundary was checked" means.
    signerEndpoint: "/run/autosk/signer.sock",
    signerIdentity: async () => ({ same_process: false }),
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
      if (relative === "resources/workflow-graph/workflow-graph.v1.json") return GRAPH_TEXT;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    async readFileBytes() {
      return Buffer.from("bytes");
    },
    async stat(target) {
      // Everything this host has is present — except the signer socket, which
      // is the point: a boundary you can stat from here is not a boundary.
      // A path that is merely absent is not a boundary (debt 10d, R6-12).
      if (target === "/run/autosk/signer.sock") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
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
    for (const id of requiredFor(GRAPH, workflow)) {
      assert.ok(known.has(id), `${workflow} requires ${id}, which no check produces`);
    }
  }
});

test("the gate is keyed by the graph's workflows, which are section 2's", () => {
  // Round 6 (R6-13): the keys were planning, implementation, panel and delivery
  // — phases no daemon registers — so nothing that starts a workflow could ask
  // the gate about it by its name.
  const plan = readFileSync(new URL("../03-technical-plan.md", import.meta.url), "utf8");
  const headings = [...plan.slice(plan.indexOf("## 2. "), plan.indexOf("## 3. ")).matchAll(/^### (autosk-[\w-]+)/gmu)]
    .map((match) => match[1]);
  assert.equal(WORKFLOWS.length, 8);
  assert.deepEqual([...WORKFLOWS].sort(), [...headings].sort());
  assert.deepEqual(Object.keys(requiredChecks(GRAPH)).sort(), [...WORKFLOWS].sort());
  assert.deepEqual(Object.keys(WORKFLOW_PHASES).sort(), [...WORKFLOWS].sort());
});

test("a graph whose workflows are not the declared ones is refused, in both directions", () => {
  const extra = graph();
  extra.workflows.push({ name: "autosk-unplanned", first_step: "intake" });
  assert.throws(() => requiredChecks(extra), (error) =>
    error.code === "doctor_required_set_unsatisfied" && error.details.undeclared.includes("autosk-unplanned"));
  const fewer = graph();
  fewer.workflows = fewer.workflows.filter((entry) => entry.name !== "autosk-quick");
  assert.throws(() => requiredChecks(fewer), (error) =>
    error.code === "doctor_required_set_unsatisfied" && error.details.unregistered.includes("autosk-quick"));
  const none = graph();
  delete none.workflows;
  assert.throws(() => requiredChecks(none), (error) => error.code === "doctor_required_set_unsatisfied");
  assert.throws(() => requiredChecks({ ...graph(), workflows: [] }), (error) =>
    error.code === "doctor_required_set_unsatisfied");
});

test("every workflow that runs a model step requires the signer boundary, planning included", () => {
  // Round 6 (R6-11): the planning set left the boundary out on the claim that
  // planning runs no provider, while the planned chain runs draft_artifact and
  // fix_artifact and is where alignment decisions are made.
  for (const workflow of WORKFLOWS) {
    const { first_step: first } = registeredWorkflows(GRAPH).find((entry) => entry.name === workflow);
    assert.equal(runsModelStep(GRAPH, first), true, `${workflow} runs a model step`);
    for (const id of MODEL_STEP_CHECKS) assert.ok(requiredFor(GRAPH, workflow).includes(id), `${workflow} requires ${id}`);
  }
  assert.ok(requiredFor(GRAPH, "autosk-planned").includes("security.signer_boundary"));
  const report = passingReport(new Map([["security.signer_boundary", "unverifiable"]]));
  for (const workflow of WORKFLOWS) {
    assert.deepEqual(admits(report, GRAPH, workflow, NOW).blocking, [
      { id: "security.signer_boundary", reason: "doctor_check_unverifiable" },
    ], workflow);
  }
});

test("the boundary requirement is derived from the graph, not listed by hand", () => {
  // No phase names it: the requirement comes from what the graph runs, so a
  // workflow added later that runs an agent step cannot be forgotten.
  for (const [phase, ids] of Object.entries(PHASE_CHECKS)) {
    for (const id of MODEL_STEP_CHECKS) assert.ok(!ids.includes(id), `${phase} lists ${id} by hand`);
  }
  // A workflow that starts at a step running nothing and leading nowhere runs no
  // model step, and is not asked for the boundary.
  const idle = graph();
  idle.workflows.find((entry) => entry.name === "autosk-ticket").first_step = "done";
  assert.equal(runsModelStep(idle, "done"), false);
  assert.ok(!requiredFor(idle, "autosk-ticket").includes("security.signer_boundary"));
  // Reaching an agent step through a status step still counts.
  const via = graph();
  via.steps.push({ name: "gate", kind: "status", status: "human" });
  via.transitions.push({ id: "t_gate", from: "gate", to: "implement", priority: 0, guards: [] });
  assert.equal(runsModelStep(via, "gate"), true);
  // A first step the graph does not declare is refused, not read as "runs no
  // model": a typo must not waive the boundary (review of debt 10d, L4).
  assert.throws(() => runsModelStep(via, "not_a_step"), (error) => error.code === "doctor_required_set_unsatisfied");
  const typo = graph();
  typo.workflows.find((entry) => entry.name === "autosk-ticket").first_step = "implemnt";
  assert.throws(() => requiredChecks(typo), (error) =>
    error.code === "doctor_required_set_unsatisfied" && error.details.first_step === "implemnt");
  const twice = graph();
  twice.workflows.push({ ...twice.workflows.find((entry) => entry.name === "autosk-ticket"), first_step: "done" });
  assert.throws(() => requiredChecks(twice), (error) =>
    error.code === "doctor_required_set_unsatisfied" && error.details.duplicate.includes("autosk-ticket"));
  // A cycle of status steps that never reaches an agent step ends, and says no.
  const loop = graph();
  loop.steps.push({ name: "wait_a", kind: "status", status: "human" }, { name: "wait_b", kind: "status", status: "human" });
  loop.transitions.push(
    { id: "t_wait_ab", from: "wait_a", to: "wait_b", priority: 0, guards: [] },
    { id: "t_wait_ba", from: "wait_b", to: "wait_a", priority: 0, guards: [] },
  );
  assert.equal(runsModelStep(loop, "wait_a"), false);
});

test("a graph that registers no workflow names none, rather than an empty gate", () => {
  for (const workflows of [undefined, [], "autosk-planned"]) {
    assert.throws(() => registeredWorkflows({ ...graph(), workflows }),
      (error) => error.code === "doctor_required_set_unsatisfied", String(workflows));
  }
  assert.equal(registeredWorkflows(GRAPH), GRAPH.workflows);
});

test("an unknown workflow is refused rather than admitted by default", () => {
  assert.throws(() => requiredFor(GRAPH, "whatever"), (error) => error.code === "doctor_required_set_unsatisfied");
  assert.throws(() => requiredFor(GRAPH, "planning"), (error) => error.code === "doctor_required_set_unsatisfied");
});

test("a healthy project admits every workflow", () => {
  const report = passingReport();
  for (const workflow of WORKFLOWS) {
    assert.equal(admits(report, GRAPH, workflow, NOW).ready, true, workflow);
  }
});

test("a required check that warns blocks the workflow that requires it", () => {
  // ...and only that one: the difference lives in the declaration, not in the
  // report.
  const report = passingReport(new Map([["git_delivery.origin_configured", "warn"]]));
  assert.equal(admits(report, GRAPH, "autosk-planned", NOW).ready, false);
  assert.equal(admits(report, GRAPH, "autosk-ticket", NOW).ready, true);
  assert.equal(admits(report, GRAPH, "autosk-panel-seat", NOW).ready, true);
});

test("a required check that could not be established blocks too", () => {
  // "We could not test it" never becomes "it passed" for anyone who depends on
  // it, even though the same status leaves the overall report green.
  const report = passingReport(new Map([["providers.panel_routes_declared", "unverifiable"]]));
  assert.equal(report.status, "pass");
  assert.deepEqual(admits(report, GRAPH, "autosk-panel-seat", NOW).blocking, [
    { id: "providers.panel_routes_declared", reason: "doctor_check_unverifiable" },
  ]);
  assert.equal(admits(report, GRAPH, "autosk-ticket", NOW).ready, true);
});

test("an expired report admits nothing that depends on the expired check", () => {
  const report = passingReport();
  const later = NOW + 600_000;
  assert.equal(admits(report, GRAPH, "autosk-planned", later).ready, false);
  for (const entry of admits(report, GRAPH, "autosk-planned", later).blocking) {
    assert.equal(entry.reason, "doctor_check_expired");
  }
});

test("assertAdmits names every blocking check, not only the first", () => {
  const report = passingReport(new Map([
    ["providers.panel_routes_declared", "fail"],
    ["git_delivery.origin_configured", "fail"],
  ]));
  assert.throws(
    () => assertAdmits(report, GRAPH, "autosk-planned", NOW),
    (error) =>
      error.code === "doctor_required_set_unsatisfied" &&
      error.details.workflow === "autosk-planned" &&
      error.details.blocking.length === 2 &&
      error.details.blocking.every((entry) => entry.endsWith(":doctor_required_set_unsatisfied")),
  );
  assert.equal(assertAdmits(report, GRAPH, "autosk-ticket", NOW), report);
});

test("preflight runs the same checks the doctor runs", async () => {
  // Not a second implementation: the same registry, asked a narrower question.
  const identity = {
    projectIdentity: "autosk-flow:test",
    runtimeIdentity: "r".repeat(64),
    tool: { name: "autosk-flow-doctor", version: "0.0.0" },
  };
  const { report, admission } = await preflight(fakeEnv(), GRAPH, "autosk-planned", identity);
  assert.equal(report.checks.length, checkRegistry(fakeEnv()).length);
  assert.equal(admission.ready, true);
  const panel = await preflight(fakeEnv(), GRAPH, "autosk-panel-seat", identity);
  assert.equal(panel.admission.ready, true);
  // And the boundary it requires is the probe's verdict: a missing endpoint
  // stops a planned run.
  const missing = await preflight({
    ...fakeEnv(),
    async stat() { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
  }, GRAPH, "autosk-planned", identity);
  assert.equal(missing.admission.ready, false);
  assert.ok(missing.admission.blocking.some((entry) => entry.id === "security.signer_boundary"));
});

test("a seat is a daemon child task, and the Epic that dispatches seats needs their routes", () => {
  // Review of debt 10d (M1): seats were given the dispatching panel's set, which
  // names no daemon, while 03 §2 makes each seat a daemon-registered child task
  // that submits through `submit_gate_result`. The routes a panel will use are
  // the dispatcher's concern, and the dispatcher is the planned Epic.
  for (const seat of ["autosk-panel-seat", "autosk-contest-seat"]) {
    for (const id of ["daemon.binary_present", "daemon.store_lock_helper", "providers.panel_routes_declared"]) {
      assert.ok(requiredFor(GRAPH, seat).includes(id), `${seat} requires ${id}`);
    }
  }
  assert.ok(requiredFor(GRAPH, "autosk-planned").includes("providers.panel_routes_declared"));
  assert.ok(!requiredFor(GRAPH, "autosk-ticket").includes("providers.panel_routes_declared"));
  const report = passingReport(new Map([["daemon.binary_present", "fail"]]));
  assert.equal(admits(report, GRAPH, "autosk-panel-seat", NOW).ready, false);
  assert.equal(admits(report, GRAPH, "autosk-contest-seat", NOW).ready, false);
  const routes = passingReport(new Map([["providers.panel_routes_declared", "fail"]]));
  assert.equal(admits(routes, GRAPH, "autosk-planned", NOW).ready, false);
  assert.equal(admits(routes, GRAPH, "autosk-quick", NOW).ready, true);
});

test("a required set is the union of its phases and the model-step checks, once each", () => {
  const planned = requiredFor(GRAPH, "autosk-planned");
  assert.equal(new Set(planned).size, planned.length);
  for (const phase of WORKFLOW_PHASES["autosk-planned"]) {
    for (const id of PHASE_CHECKS[phase]) assert.ok(planned.includes(id), `autosk-planned lost ${id} of ${phase}`);
  }
  assert.ok(Object.isFrozen(planned));
  assert.ok(Object.isFrozen(requiredChecks(GRAPH)));
});

test("a doctor option given without a value is refused, not dropped", () => {
  // `--workflow` with nothing after it used to leave the gate off, and the
  // report still exited 0 (review of debt 10d, M2).
  for (const option of ["--workflow", "--out", "--require"]) {
    assert.throws(() => parseArgs([option]), new RegExp(`${option} needs a value`, "u"));
    assert.throws(() => parseArgs([option, ""]), new RegExp(`${option} needs a value`, "u"));
  }
  assert.throws(() => parseArgs(["--require", ","]), /--require needs a value/u);
  assert.throws(() => parseArgs(["--workflow", "--json"]), /--workflow needs a value/u);
  assert.deepEqual(parseArgs(["--require", "a.b,c.d", "--json"]), { out: "", require: ["a.b", "c.d"], json: true });
  assert.equal(parseArgs(["--out", "/tmp/report.json"]).out, "/tmp/report.json");
});

test("the doctor asks the gate for a workflow's set by its name", async () => {
  // The gate's first caller outside tests: `autosk-flow doctor --workflow <name>`
  // checks exactly what that workflow's dispatch would require.
  assert.deepEqual(parseArgs(["--workflow", "autosk-planned"]).workflow, "autosk-planned");
  const env = fakeEnv();
  assert.deepEqual(await requiredSet(env, { workflow: "autosk-planned", require: [] }),
    [...requiredFor(GRAPH, "autosk-planned")]);
  assert.deepEqual(
    await requiredSet(env, { workflow: "autosk-panel-seat", require: ["git_delivery.origin_configured", "daemon.binary_present"] }),
    [...requiredFor(GRAPH, "autosk-panel-seat"), "git_delivery.origin_configured"],
  );
  assert.deepEqual(await requiredSet(env, { require: ["a.b"] }), ["a.b"]);
  // A workflow named but empty is refused rather than read as "no gate"
  // (review of debt 10d, M2).
  await assert.rejects(() => requiredSet(env, { workflow: "", require: [] }),
    (error) => error.code === "doctor_required_set_unsatisfied");
  await assert.rejects(() => requiredSet(env, { workflow: "planning", require: [] }),
    (error) => error.code === "doctor_required_set_unsatisfied");
});
