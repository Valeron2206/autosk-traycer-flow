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
  auto_context: { disposition: "disabled" },
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
  // The last line reads two facts together, and each alone is not the answer:
  // a result with a non-zero exit is still an answer, and a missing result with
  // a zero exit is a provider that said nothing but did not fail. Only both at
  // once means "we cannot tell".
  assert.equal(authState({ stderr: "", exit_code: 2, result: null }), "unknown");
  assert.equal(authState({ stderr: "", exit_code: 2, result: {} }), "valid");
  assert.equal(authState({ stderr: "", exit_code: 0, result: null }), "valid");
  // The credential wording alone does not make it expired: a provider that
  // mentions a token and exits zero has not refused anything.
  assert.equal(authState({ stderr: "refreshed the token", exit_code: 0, result: {} }), "valid");
});

test("a probe that answered late is timed out even though nothing killed it", async () => {
  // `timedOut === true || exceeded !== null` — the process finishing on its own
  // does not mean it finished in time. With an `&&` there, a route that answers
  // an hour late would read as a route that answers.
  const record = await preflightRoute(run, route(), {
    timeouts: { idle_ms: 0, wall_clock_ms: 2000 },
    nowMs: NOW,
    parseResult,
  });
  assert.equal(record.smoke.state, "timed_out");

  // And the opposite: the same provider answering the same way inside its
  // budget passes, so the difference is the budget and not the answer.
  const inTime = await preflightRoute(run, route(), { timeouts: TIMEOUTS, nowMs: NOW, parseResult });
  assert.equal(inTime.smoke.state, "passed");
});

test("a provider that reports no effort does not get the one we asked for back", async () => {
  // "Read back, not repeated" is the rule this line states. A provider that
  // answers with an explicit null effort has told us something — that it has
  // none — and substituting the requested effort there would turn our own
  // request into the provider's answer. The fallback belongs only to the case
  // where nothing was confirmable at all.
  const nullEffort = async () => ({
    code: 0,
    stdout: `<<<autosk-result ${JSON.stringify({ effort: null, effort_echoed: true })}>>>\n`,
    stderr: "",
    timedOut: false,
  });
  const record = await preflightRoute(nullEffort, route(), { timeouts: TIMEOUTS, nowMs: NOW, parseResult });
  assert.equal(record.effort_confirmation, "reported");
  assert.equal(record.effective_effort, null);

  // And the genuinely unconfirmable case does fall back, which is why the two
  // have to be told apart.
  const noEffort = async () => ({ code: 0, stdout: `<<<autosk-result ${JSON.stringify({ ok: true })}>>>\n`, stderr: "", timedOut: false });
  const unconfirmable = await preflightRoute(noEffort, route(), { timeouts: TIMEOUTS, nowMs: NOW, parseResult });
  assert.equal(unconfirmable.effort_confirmation, "unconfirmable");
  assert.equal(unconfirmable.effective_effort, "high");
});

test("a runner that reports its tree was left alive is not a clean probe", async () => {
  // `treeKilled !== false` reads an absent field as "we did not have to kill
  // anything". An explicit `false` is the runner saying it tried and could not,
  // which is a different fact and must not be read as the absent one.
  // The distinction only exists on a timed-out probe: that is where a leftover
  // process is a leak the next run inherits, and where the two classifications
  // diverge.
  const late = { idle_ms: 0, wall_clock_ms: 2000 };
  const leaves = async (command, args, options) => ({ ...(await run(command, args, options)), treeKilled: false, orphans: 2 });
  // Read from the probe rather than the route record: the record collapses both
  // timeouts to one state, and the distinction being tested lives one level
  // down, where the classification is made.
  const leaked = await runSmoke(leaves, route(), { timeouts: late, parseResult });
  assert.equal(leaked.state, "timed_out");
  assert.equal(leaked.observed.classification, "timeout_leaked");

  // The same timeout with nothing left behind is the clean classification, so
  // an absent `treeKilled` reads as "nothing had to be killed" rather than as
  // "the kill failed".
  const clean = await runSmoke(run, route(), { timeouts: late, parseResult });
  assert.equal(clean.observed.classification, "timeout_clean");

  // And an orphan alone leaks it, even when the kill reported success.
  const orphaned = async (command, args, options) => ({ ...(await run(command, args, options)), orphans: 1 });
  const withOrphan = await runSmoke(orphaned, route(), { timeouts: late, parseResult });
  assert.equal(withOrphan.observed.classification, "timeout_leaked");
  assert.equal(modelSupported({ stderr: "error: model x is not available on this account", exit_code: 3, result: null }, "x"), false);
  assert.equal(modelSupported({ stderr: "", exit_code: 0, result: {} }, "x"), true);
});
