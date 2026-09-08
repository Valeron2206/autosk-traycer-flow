/**
 * Tests for the provider preflight and dispatch guard (issue #26 runtime).
 *
 * One sentence carries the design: a silent downgrade destroys the panel
 * identity. Four seats chosen for four different lenses are not four seats if
 * two of them quietly ran at the provider's default effort — so most of these
 * are about what a route is allowed to leave unproven.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  EFFORT_CONFIRMATION,
  REFUSALS,
  assertAdmits,
  assertResumable,
  boundDiagnostics,
  classifyExit,
  dispatchOutcome,
  domainReady,
  isExpired,
  replacementSession,
  routeAdmission,
  routesInDomain,
  waitExceeded,
} from "../src/host/provider-preflight.mjs";
import { ROOT } from "../scripts/validate-planning-ref-design.mjs";

const code = (name) => (error) => error.code === name;

const NOW = Date.parse("2026-09-08T16:00:00.000Z");

const shippedExample = JSON.parse(
  await readFile(path.join(ROOT, "resources/provider-preflight/provider-preflight.example.json"), "utf8"),
).routes[0];

function route(overrides = {}) {
  return {
    schema_version: 1,
    registry_version: 1,
    route_id: "anthropic/claude-opus-5",
    provider: "anthropic",
    harness: "oh-my-pi",
    executable_version: "1.4.0",
    model_id: "claude-opus-5",
    model_supported: true,
    requested_effort: "max",
    effective_effort: "max",
    effort_confirmation: "observed",
    auth: { state: "valid" },
    smoke: { state: "passed" },
    permission_modes: ["read_only", "workspace_write"],
    session_resume: { mechanism: "session_id", format: "jsonl" },
    limits: { max_prompt_bytes: 1_000_000, max_output_bytes: 200_000 },
    timeouts: { idle_ms: 120_000, wall_clock_ms: 900_000 },
    process_tree_termination: "tree_kill",
    warning_detection: { dropped_parameter: null },
    failure_domain: "anthropic-api",
    retry_budget: { used: 0, max: 3 },
    checked_at: new Date(NOW - 60_000).toISOString(),
    expires_at: new Date(NOW + 3_600_000).toISOString(),
    privacy: { telemetry: "off" },
    residual_risks: [],
    ...overrides,
  };
}

const admits = (overrides = {}, options = {}) =>
  routeAdmission(route(overrides), { nowMs: NOW, requestedEffort: "max", permissionMode: "read_only", ...options });

test("a fully attested route is admitted, and admitting one does not throw", () => {
  // `assertAdmits` reads the first refusal reason; computing it eagerly would
  // make the success path throw, which is the path that matters most.
  assert.equal(admits().admitted, true);
  assert.doesNotThrow(() =>
    assertAdmits(route(), { nowMs: NOW, requestedEffort: "max", permissionMode: "read_only" }),
  );
});

test("assertAdmits refuses with the first reason and names them all", () => {
  assert.throws(
    () =>
      assertAdmits(route({ auth: { state: "expired" }, smoke: { state: "failed" } }), {
        nowMs: NOW,
        requestedEffort: "max",
        permissionMode: "read_only",
      }),
    (error) =>
      error.code === "route_auth_expired" &&
      error.details.reasons.length === 2 &&
      error.details.route_id === "anthropic/claude-opus-5",
  );
});

test("the shipped example carries the fields the guard reads", () => {
  // The runtime and the shipped attestation are checked against each other,
  // rather than against two separate ideas of the same record.
  for (const field of ["route_id", "requested_effort", "effective_effort", "effort_confirmation", "failure_domain"]) {
    assert.ok(Object.hasOwn(shippedExample, field), field);
  }
  assert.ok(EFFORT_CONFIRMATION.includes(shippedExample.effort_confirmation));
});

test("a route never falls back to a default effort", () => {
  // There is no silent substitution, in either direction.
  const lowered = admits({ effective_effort: "high" });
  assert.equal(lowered.admitted, false);
  assert.ok(lowered.reasons.some((entry) => entry.reason === "route_effort_dropped"));
  const attestedForLess = admits({ requested_effort: "high", effective_effort: "high" });
  assert.equal(attestedForLess.admitted, false);
});

test("a dropped-parameter warning makes the route unavailable, not degraded", () => {
  // A warning nobody acts on is a warning nobody needed to send.
  const warned = admits({ warning_detection: { dropped_parameter: "reasoning_effort" } });
  assert.equal(warned.admitted, false);
  assert.ok(warned.reasons.some((entry) => entry.reason === "route_effort_dropped"));
});

test("an unconfirmable effort is admitted only under an accepted policy", () => {
  const unconfirmed = { effort_confirmation: "unconfirmable", effective_effort: "max" };
  assert.equal(admits(unconfirmed).admitted, false);
  assert.ok(
    admits(unconfirmed).reasons.some((entry) => entry.reason === "route_effort_unconfirmable"),
  );
  // Never by default — with the policy, and only then.
  assert.equal(admits(unconfirmed, { policy: { admits_unconfirmed_effort: true } }).admitted, true);
});

test("expiry, auth, smoke and model support each stop the route", () => {
  for (const [overrides, reason] of [
    [{ expires_at: new Date(NOW - 1).toISOString() }, "route_preflight_expired"],
    [{ auth: { state: "expired" } }, "route_auth_expired"],
    [{ smoke: { state: "failed" } }, "route_smoke_failed"],
    [{ model_supported: false }, "route_model_unsupported"],
  ]) {
    const outcome = admits(overrides);
    assert.equal(outcome.admitted, false, reason);
    assert.ok(outcome.reasons.some((entry) => entry.reason === reason), reason);
  }
  assert.equal(isExpired(route(), NOW + 4_000_000), true);
  assert.equal(isExpired(route(), NOW), false);
});

test("a permission mode the provider does not offer is not one to assume", () => {
  const outcome = admits({ permission_modes: ["workspace_write"] });
  assert.equal(outcome.admitted, false);
  assert.ok(outcome.reasons.some((entry) => entry.reason === "route_permission_mode_unavailable"));
});

test("every reason is reported, not only the first", () => {
  // An operator fixing one thing at a time on a route with three problems
  // learns about them one deployment apart.
  const outcome = admits({ auth: { state: "expired" }, smoke: { state: "failed" }, model_supported: false });
  assert.equal(outcome.reasons.length >= 3, true);
});

test("a failure domain is a property of the harness, not the vendor", () => {
  // Cursor going down takes Grok and Kimi with it and leaves Codex and Claude
  // alone.
  const routes = [
    route({ route_id: "cursor/cursor-grok-4.6", failure_domain: "cursor" }),
    route({ route_id: "cursor/cursor-kimi", failure_domain: "cursor" }),
    route({ route_id: "openai-codex/gpt-6-astra", failure_domain: "openai-codex" }),
    route(),
  ];
  assert.deepEqual(routesInDomain(routes, "cursor"), ["cursor/cursor-grok-4.6", "cursor/cursor-kimi"]);
  const down = routeAdmission(routes[0], {
    nowMs: NOW,
    requestedEffort: "max",
    permissionMode: "read_only",
    domainState: { cursor: "down" },
  });
  assert.equal(down.admitted, false);
  assert.ok(down.reasons.some((entry) => entry.reason === "route_failure_domain_down"));
  // ...and the routes on another domain are unaffected.
  assert.equal(
    routeAdmission(routes[2], {
      nowMs: NOW,
      requestedEffort: "max",
      permissionMode: "read_only",
      domainState: { cursor: "down" },
    }).admitted,
    true,
  );
});

test("a domain does not carry a new child straight after an exhausted error", () => {
  // Retrying into the same outage is how a bounded retry becomes an unbounded
  // one.
  assert.equal(domainReady("cursor", { lastExhaustedAtMs: NOW, nowMs: NOW + 1000, cooldownMs: 60_000 }), false);
  assert.equal(domainReady("cursor", { lastExhaustedAtMs: NOW, nowMs: NOW + 60_000, cooldownMs: 60_000 }), true);
  assert.equal(domainReady("cursor", { nowMs: NOW, cooldownMs: 60_000 }), true);
});

test("the retry budget is bounded and recorded per route", () => {
  const outcome = admits({ retry_budget: { used: 3, max: 3 } });
  assert.equal(outcome.admitted, false);
  assert.ok(outcome.reasons.some((entry) => entry.reason === "route_retry_budget_exhausted"));
});

test("exit zero without a structured result is a failure", () => {
  // "The process ended" is not "the work was done".
  assert.equal(classifyExit({ exit_code: 0, structured_result: false }), "no_result");
  assert.equal(dispatchOutcome("no_result"), "route_result_missing");
  // ...and a non-zero exit after a valid result is still a submission.
  assert.equal(classifyExit({ exit_code: 1, structured_result: true }), "result_with_nonzero_exit");
  assert.equal(dispatchOutcome("result_with_nonzero_exit"), "submitted");
  assert.equal(dispatchOutcome(classifyExit({ exit_code: 0, structured_result: true })), "submitted");
});

test("a timeout kills the tree, and an orphan is not a clean timeout", () => {
  assert.equal(classifyExit({ timed_out: true, tree_killed: true, orphans: 0 }), "timeout_clean");
  assert.equal(classifyExit({ timed_out: true, tree_killed: true, orphans: 1 }), "timeout_leaked");
  assert.equal(classifyExit({ timed_out: true, tree_killed: false, orphans: 0 }), "timeout_leaked");
  assert.equal(dispatchOutcome("timeout_leaked"), "timeout");
  assert.throws(() => dispatchOutcome("invented"), code("route_result_missing"));
});

test("both wait budgets exist, because one without the other leaves the other unbounded", () => {
  const timeouts = route().timeouts;
  assert.equal(waitExceeded({ idleMs: 0, elapsedMs: 0 }, timeouts), null);
  assert.equal(waitExceeded({ idleMs: 120_000, elapsedMs: 200_000 }, timeouts), "idle");
  // A reply that keeps producing bytes forever is not idle, and the wall clock
  // is what stops it.
  assert.equal(waitExceeded({ idleMs: 10, elapsedMs: 900_000 }, timeouts), "wall_clock");
  assert.throws(() => waitExceeded({ idleMs: 0, elapsedMs: 0 }, { idle_ms: 1 }), code("route_smoke_failed"));
  assert.throws(() => waitExceeded({ idleMs: 0, elapsedMs: 0 }, { wall_clock_ms: 1 }), code("route_smoke_failed"));
});

test("a replacement session carries a generation and what it replaces", () => {
  // So two attempts can never be read as one.
  const first = { session_id: "s-1", generation: 1 };
  const second = replacementSession(first, { session_id: "s-2", nowMs: NOW });
  assert.equal(second.generation, 2);
  assert.equal(second.replaces, "s-1");
  assert.throws(() => replacementSession(first, { session_id: "s-1", nowMs: NOW }), code("route_session_generation_conflict"));
});

test("a resume that would merge two generations is refused", () => {
  const expected = { session_id: "s-2", generation: 2 };
  assert.doesNotThrow(() => assertResumable({ session_id: "s-2", generation: 2 }, expected));
  assert.throws(() => assertResumable({ session_id: "s-1", generation: 2 }, expected), code("route_session_generation_conflict"));
  assert.throws(() => assertResumable({ session_id: "s-2", generation: 3 }, expected), code("route_session_generation_conflict"));
});

test("diagnostics are redacted and bounded before they are stored", () => {
  assert.equal(boundDiagnostics("/home/operator/x", { home: "/home/operator" }), "<home>/x");
  assert.equal(Buffer.byteLength(boundDiagnostics("x".repeat(9000)), "utf8"), 4096 + 2);
  assert.equal(boundDiagnostics(undefined), "");
});

test("every refusal class the contract closes can be produced", () => {
  const produced = new Set();
  const outcomes = [
    admits({ model_supported: false }),
    admits({ effective_effort: "high" }),
    admits({ effort_confirmation: "unconfirmable" }),
    admits({ auth: { state: "expired" } }),
    admits({ smoke: { state: "failed" } }),
    admits({ permission_modes: [] }),
    admits({ expires_at: new Date(NOW - 1).toISOString() }),
    routeAdmission(route(), { nowMs: NOW, domainState: { "anthropic-api": "down" } }),
    admits({ retry_budget: { used: 5, max: 3 } }),
  ];
  for (const outcome of outcomes) {
    for (const entry of outcome.reasons) produced.add(entry.reason);
  }
  produced.add(dispatchOutcome("no_result"));
  try {
    assertResumable({ session_id: "s-9", generation: 1 }, { session_id: "s-1", generation: 1 });
  } catch (error) {
    produced.add(error.code);
  }
  for (const refusal of REFUSALS) {
    assert.ok(produced.has(refusal), `${refusal} is documented and never produced`);
  }
});
