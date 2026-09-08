/**
 * Tests for the provider preflight executor (issue #26).
 *
 * Run against fake provider processes, because the interesting behaviours are
 * the ones a real provider cannot be asked to perform on demand: dropping the
 * effort it was given, exiting zero with nothing structured, or never
 * answering at all.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { MODES, parseResult } from "../scripts/fake-provider.mjs";
import { ROOT } from "../scripts/clean-room-e2e.mjs";
import { routeAdmission } from "../src/host/provider-preflight.mjs";
import {
  authState,
  detectDroppedParameter,
  effortConfirmation,
  modelSupported,
  preflightRoute,
  runSmoke,
} from "../src/host/preflight-runner.mjs";

const execFileAsync = promisify(execFile);
const PROVIDER = path.join(ROOT, "scripts/fake-provider.mjs");
const NOW = Date.parse("2026-09-09T10:00:00Z");
const TIMEOUTS = { idle_ms: 2000, wall_clock_ms: 2000 };

/** The injected runner: a real child process, its exit status kept. */
const run = async (command, args, { timeoutMs }) =>
  execFileAsync(command, args, { timeout: timeoutMs, killSignal: "SIGKILL" }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr, timedOut: false }),
    (error) => ({
      code: error.killed ? null : (typeof error.code === "number" ? error.code : 1),
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error),
      timedOut: error.killed === true,
    }),
  );

const route = (overrides = {}) => ({
  route_id: "r-1",
  model_id: "fake-model-1",
  failure_domain: "fake",
  requested_effort: "high",
  permission_modes: ["isolated"],
  command: "node",
  args: [PROVIDER],
  mode: "ok",
  retry_budget: { used: 0, max: 3 },
  ...overrides,
});

test("a route that answers with what it was asked for is admitted", async () => {
  const record = await preflightRoute(run, route(), { timeouts: TIMEOUTS, nowMs: NOW, parseResult });
  assert.equal(record.smoke.state, "passed");
  assert.equal(record.auth.state, "valid");
  assert.equal(record.effective_effort, "high");
  assert.equal(record.effort_confirmation, "observed");
  assert.equal(record.warning_detection.dropped_parameter, null);
  const admission = routeAdmission(record, { nowMs: NOW, requestedEffort: "high", permissionMode: "isolated" });
  assert.deepEqual({ admitted: admission.admitted, reasons: [...admission.reasons] }, { admitted: true, reasons: [] });
});

test("a provider that quietly used its own effort is not a route that complied", async () => {
  // The case the whole record exists for: exit 0, a result, and an effort
  // nobody asked for.
  const record = await preflightRoute(run, route({ mode: "drop_effort" }), {
    timeouts: TIMEOUTS,
    nowMs: NOW,
    parseResult,
  });
  assert.equal(record.smoke.state, "passed");
  assert.equal(record.effective_effort, "default");
  assert.equal(record.warning_detection.dropped_parameter, "effort");
  const admission = routeAdmission(record, { nowMs: NOW, requestedEffort: "high" });
  assert.equal(admission.admitted, false);
  assert.ok(admission.reasons.some((reason) => reason.reason === "route_effort_dropped"));
});

test("an effort nobody confirmed is admitted only under a policy that says so", async () => {
  const record = await preflightRoute(run, route({ mode: "unconfirmable_effort" }), {
    timeouts: TIMEOUTS,
    nowMs: NOW,
    parseResult,
  });
  assert.equal(record.effort_confirmation, "unconfirmable");
  const byDefault = routeAdmission(record, { nowMs: NOW, requestedEffort: "high" });
  assert.ok(byDefault.reasons.some((reason) => reason.reason === "route_effort_unconfirmable"));
  const byPolicy = routeAdmission(record, {
    nowMs: NOW,
    requestedEffort: "high",
    policy: { admits_unconfirmed_effort: true },
  });
  assert.equal(byPolicy.admitted, true);
});

test("exit zero with nothing structured is a failed smoke, not a passed one", async () => {
  const record = await preflightRoute(run, route({ mode: "no_result" }), {
    timeouts: TIMEOUTS,
    nowMs: NOW,
    parseResult,
  });
  assert.equal(record.smoke.state, "failed");
  assert.ok(routeAdmission(record, { nowMs: NOW }).reasons.some((reason) => reason.reason === "route_smoke_failed"));
});

test("an expired credential and an unavailable model are different refusals", async () => {
  const expired = await preflightRoute(run, route({ mode: "auth_expired" }), {
    timeouts: TIMEOUTS,
    nowMs: NOW,
    parseResult,
  });
  assert.equal(expired.auth.state, "expired");
  const expiredReasons = routeAdmission(expired, { nowMs: NOW }).reasons.map((reason) => reason.reason);
  assert.ok(expiredReasons.includes("route_auth_expired"));
  // And the failure is attributed to the credential, not to the model:
  // inferring the model from any failure sends somebody to change the route
  // when the fix is to log in.
  assert.equal(expired.model_supported, true);
  assert.ok(!expiredReasons.includes("route_model_unsupported"), expiredReasons.join(","));

  const unsupported = await preflightRoute(run, route({ mode: "model_unsupported" }), {
    timeouts: TIMEOUTS,
    nowMs: NOW,
    parseResult,
  });
  assert.equal(unsupported.model_supported, false);
  assert.ok(
    routeAdmission(unsupported, { nowMs: NOW }).reasons.some((reason) => reason.reason === "route_model_unsupported"),
  );
});

test("a route with no id is not a route", async () => {
  await assert.rejects(
    () => preflightRoute(run, { ...route(), route_id: "" }, { timeouts: TIMEOUTS, nowMs: NOW, parseResult }),
    (error) => error.code === "route_smoke_failed",
  );
});

test("a result that arrived with a non-zero exit is still a result", async () => {
  // The exit code is not the result in either direction.
  const record = await preflightRoute(run, route({ mode: "result_with_nonzero_exit" }), {
    timeouts: TIMEOUTS,
    nowMs: NOW,
    parseResult,
  });
  assert.equal(record.smoke.state, "passed");
  assert.equal(record.effort_confirmation, "observed");
});

test("a provider that never answers is a timeout, not a failure", async () => {
  const smoke = await runSmoke(run, route({ mode: "hang" }), {
    timeouts: { idle_ms: 300, wall_clock_ms: 300 },
    parseResult,
  });
  assert.equal(smoke.state, "timed_out");
  assert.equal(smoke.observed.outcome, "timeout");
  assert.ok(smoke.observed.elapsed_ms >= 300, String(smoke.observed.elapsed_ms));
});

test("the preflight has a shelf life, and an expired one is not a preflight", async () => {
  const record = await preflightRoute(run, route(), { timeouts: TIMEOUTS, nowMs: NOW, ttlMs: 60_000, parseResult });
  assert.equal(record.expires_at, new Date(NOW + 60_000).toISOString());
  assert.equal(routeAdmission(record, { nowMs: NOW + 30_000 }).admitted, true);
  const stale = routeAdmission(record, { nowMs: NOW + 90_000 });
  assert.ok(stale.reasons.some((reason) => reason.reason === "route_preflight_expired"));
});

test("the fake provider offers every behaviour the runner classifies", () => {
  // The preflight's own set, plus the echo modes the send path needs.
  assert.deepEqual([...MODES], [
    "ok",
    "drop_effort",
    "unconfirmable_effort",
    "no_result",
    "auth_expired",
    "model_unsupported",
    "result_with_nonzero_exit",
    "hang",
    "echo",
    "echo_foreign",
    "echo_partial",
  ]);
});

test("the readings that turn prose into a decision", () => {
  assert.equal(detectDroppedParameter("warning: unsupported parameter 'effort'; using the default"), "effort");
  assert.equal(detectDroppedParameter("", "note: ignoring reasoning_effort"), "reasoning_effort");
  assert.equal(detectDroppedParameter("everything is fine"), null);

  // Echoed and equal is evidence; anything less is the request repeated back.
  assert.equal(effortConfirmation({ effort: "high", effort_echoed: true }, "high"), "observed");
  assert.equal(effortConfirmation({ effort: "default", effort_echoed: true }, "high"), "reported");
  assert.equal(effortConfirmation({ effort: "high" }, "high"), "reported");
  assert.equal(effortConfirmation({}, "high"), "unconfirmable");
  assert.equal(effortConfirmation(null, "high"), "unconfirmable");

  assert.equal(authState({ stderr: "error: authentication token expired", exit_code: 2, result: null }), "expired");
  assert.equal(authState({ stderr: "", exit_code: null, result: null }), "unknown");
  assert.equal(authState({ stderr: "", exit_code: 0, result: {} }), "valid");
  assert.equal(modelSupported({ stderr: "error: model x is not available on this account", exit_code: 3, result: null }, "x"), false);
  assert.equal(modelSupported({ stderr: "", exit_code: 0, result: {} }, "x"), true);
});
