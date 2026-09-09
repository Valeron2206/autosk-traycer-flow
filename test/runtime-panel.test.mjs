/**
 * Tests for the four-model panel orchestrator (#15/#16/#18/#19/#20/#26).
 *
 * The orchestrator decides nothing on its own; what it owns is the order the
 * six pieces run in and what happens when one refuses. Two sentences carry it:
 * a seat that could not be dispatched is not a seat that passed, and a seat
 * whose run cannot be confirmed is neither a pass nor a fail.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { SUBMISSION_CLOSE, SUBMISSION_OPEN } from "../src/host/model-result.mjs";
import { PROJECTED_FIELDS } from "../src/host/gate-projection.mjs";
import { compileCarrier } from "../src/host/stage-carrier.mjs";
import { panelVerdict, runPanel, runSeat } from "../src/host/panel.mjs";
import { ROOT } from "../scripts/validate-planning-ref-design.mjs";

const carrierRegistry = JSON.parse(
  await readFile(path.join(ROOT, "resources/stage-carriers/stage-carriers.v1.json"), "utf8"),
);

const NOW = Date.parse("2026-09-08T17:00:00.000Z");
const BINDING = "sha256:" + "a".repeat(58);

const SEAT_KEY = Object.keys(carrierRegistry.carriers)[0];
const [SEAT_ROLE, SEAT_STAGE] = SEAT_KEY.split(".");

const bundle = { read: (file) => `bytes of ${file}\n` };
const anchors = Object.fromEntries(
  carrierRegistry.carriers[SEAT_KEY].anchors.map((anchor) => [anchor, `anchor ${anchor}\n`]),
);

function route(id, overrides = {}) {
  return {
    route_id: id,
    model_supported: true,
    requested_effort: "max",
    effective_effort: "max",
    effort_confirmation: "observed",
    auth: { state: "valid" },
    smoke: { state: "passed" },
    permission_modes: ["read_only"],
    timeouts: { idle_ms: 1000, wall_clock_ms: 2000 },
    warning_detection: { dropped_parameter: null },
    auto_context: { disposition: "disabled" },
    failure_domain: id.split("/")[0],
    retry_budget: { used: 0, max: 3 },
    expires_at: new Date(NOW + 3_600_000).toISOString(),
    ...overrides,
  };
}

function storeState(overrides = {}) {
  const base = {};
  for (const field of PROJECTED_FIELDS) base[field] = `${field}-value`;
  return { ...base, project_binding: BINDING, timestamps: { at: "t0" }, ...overrides };
}

function seatSpec(name, routeId, overrides = {}) {
  const context = {
    bundle_digest: carrierRegistry.bundle_digest,
    project: BINDING,
    epic: "epic-store-lock",
    task: "T-102",
    dispatch_id: `disp-${name}`,
    round: 1,
    attempt: 1,
    serialization_version: 1,
  };
  return {
    seat: name,
    role: SEAT_ROLE,
    stage: SEAT_STAGE,
    requested_effort: "max",
    route: route(routeId),
    context,
    dispatch: {
      dispatch_id: `disp-${name}`,
      task_id: "T-102",
      attempt: 1,
      artifact_identity: "b".repeat(64),
      candidate_identity: "c".repeat(64),
      anchor_digest: "d".repeat(64),
      runtime_identity_digest: "e".repeat(64),
      attribution: "autosk-flow/stage-carrier/v1#panel",
      anchor_version: 3,
      included_sources: [{ logical_id: "brief", sha256: "f".repeat(64) }],
      serialized_at: new Date(NOW).toISOString(),
    },
    store_before: storeState(),
    store_after: storeState(),
    journal: [],
    projection_version: 1,
    ...overrides,
  };
}

/** The headers a seat is expected to echo, computed the way the host does. */
function headersFor(spec) {
  return compileCarrier(carrierRegistry, {
    role: spec.role,
    stage: spec.stage,
    context: spec.context,
    bundle,
    anchors,
  }).headers;
}

function resultFor(spec, { findings = [], echo, outcome = "pass" } = {}) {
  return {
    result_schema_version: 1,
    kind: "verification",
    role: "gate",
    step_identity: {
      task_id: spec.dispatch.task_id,
      session_id: `s-${spec.seat}`,
      attempt: spec.dispatch.attempt,
      anchor_digest: spec.dispatch.anchor_digest,
      runtime_identity_digest: spec.dispatch.runtime_identity_digest,
    },
    outcome,
    summary: `${spec.seat} reviewed the candidate`,
    attribution_echo: spec.dispatch.attribution,
    received_attributions: echo ?? headersFor(spec).map((header) => ({ ...header })),
    findings,
  };
}

function deps(overrides = {}) {
  return {
    registry: { projected_fields: PROJECTED_FIELDS, projection_version: 1 },
    carrierRegistry,
    bundle,
    anchors,
    scanner: {
      tool: "gitleaks",
      version: "8.28.0",
      config_digest: "a".repeat(64),
      scan(body) {
        const findings = [];
        if (body.includes("AKIAZZ7EXAMPLEPLANTED42")) findings.push({ rule: "planted" });
        if (/ghp_[A-Za-z0-9]{20,}/u.test(body)) findings.push({ rule: "pat" });
        return { launched: true, exit_code: findings.length > 0 ? 1 : 0, findings };
      },
    },
    personalDataReview: { state: "reviewed", disposition: "clear" },
    provider: { call: () => "" },
    env: {
      nowMs: () => NOW,
      actualChangedPaths: () => [],
      resolveEvidence: () => true,
      readBack: () => true,
    },
    nowMs: NOW,
    home: "/home/operator",
    ...overrides,
  };
}

function providerReturning(map) {
  return {
    call(routeId) {
      const value = map[routeId];
      if (typeof value === "string") return value;
      return `${SUBMISSION_OPEN}${JSON.stringify(value)}${SUBMISSION_CLOSE}`;
    },
  };
}

const SEATS = [
  seatSpec("opus", "anthropic/claude-opus-5"),
  seatSpec("astra", "openai-codex/gpt-6-astra"),
  seatSpec("grok", "cursor/cursor-grok-4.6"),
  seatSpec("muse", "meta/muse-spark-1.3-contributor"),
];

function allAnswering(extra = {}) {
  return providerReturning(
    Object.fromEntries(SEATS.map((spec) => [spec.route.route_id, extra[spec.seat] ?? resultFor(spec)])),
  );
}

test("four answering seats with no findings pass", () => {
  const outcome = runPanel(SEATS, deps({ provider: allAnswering() }));
  assert.equal(outcome.verdict, "pass");
  assert.equal(outcome.seats.every((seat) => seat.outcome === "answered"), true);
  assert.equal(outcome.identical_carriers, false, "each seat has its own dispatch identity in its headers");
});

test("a seat whose route is not admitted is unavailable, not passing", () => {
  // A seat that could not be dispatched is not a seat that passed.
  const seats = [seatSpec("opus", "anthropic/claude-opus-5", { route: route("anthropic/claude-opus-5", { auth: { state: "expired" } }) }), ...SEATS.slice(1)];
  const outcome = runPanel(seats, deps({ provider: allAnswering() }));
  assert.equal(outcome.verdict, "incomplete");
  assert.equal(outcome.reason, "seat_unavailable");
  assert.deepEqual(outcome.seats.find((seat) => seat.seat === "opus").outcome, "unavailable");
});

test("a downgraded effort takes the seat out rather than answering at another effort", () => {
  const seats = [
    seatSpec("grok", "cursor/cursor-grok-4.6", {
      route: route("cursor/cursor-grok-4.6", { effective_effort: "high" }),
    }),
    ...SEATS.slice(1),
  ];
  const outcome = runPanel(seats, deps({ provider: allAnswering() }));
  assert.equal(outcome.verdict, "incomplete");
});

test("a failure domain going down takes exactly the seats that share it", () => {
  const outcome = runPanel(SEATS, deps({ provider: allAnswering(), domainState: { cursor: "down" } }));
  assert.equal(outcome.verdict, "incomplete");
  const unavailable = outcome.seats.filter((seat) => seat.outcome === "unavailable").map((seat) => seat.seat);
  assert.deepEqual(unavailable, ["grok"]);
});

test("a body that will not clear is a seat that was never dispatched", () => {
  const leaking = deps({
    provider: allAnswering(),
    bundle: { read: (file) => `bytes of ${file} ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa\n` },
  });
  const outcome = runPanel(SEATS, leaking);
  assert.equal(outcome.verdict, "incomplete");
  assert.equal(outcome.seats[0].reasons[0].reason, "clearance_secret_found");
});

test("a seat that submits nothing is a blocking non-verdict, not a fail", () => {
  // Neither "it passed" nor "it failed" is a truthful summary.
  const provider = providerReturning({
    ...Object.fromEntries(SEATS.map((spec) => [spec.route.route_id, resultFor(spec)])),
    "cursor/cursor-grok-4.6": "the run completed successfully",
  });
  const outcome = runPanel(SEATS, deps({ provider }));
  assert.equal(outcome.verdict, "blocking_non_verdict");
  assert.equal(outcome.seats.find((seat) => seat.seat === "grok").reasons[0].reason, "no_result_submitted");
});

test("a seat that echoes nothing is a blocking non-verdict", () => {
  const provider = allAnswering({ muse: resultFor(SEATS[3], { echo: [] }) });
  const outcome = runPanel(SEATS, deps({ provider }));
  assert.equal(outcome.verdict, "blocking_non_verdict");
  assert.equal(outcome.seats.find((seat) => seat.seat === "muse").reasons[0].reason, "carrier_echo_missing");
});

test("a seat whose store projection moved is a blocking non-verdict", () => {
  const moved = seatSpec("astra", "openai-codex/gpt-6-astra", {
    store_after: storeState({ candidate_identity: "moved" }),
  });
  const seats = [SEATS[0], moved, SEATS[2], SEATS[3]];
  const provider = providerReturning(
    Object.fromEntries(seats.map((spec) => [spec.route.route_id, resultFor(spec)])),
  );
  const outcome = runPanel(seats, deps({ provider }));
  assert.equal(outcome.verdict, "blocking_non_verdict");
  assert.equal(
    outcome.seats.find((seat) => seat.seat === "astra").reasons[0].reason,
    "projection_changed",
  );
});

test("findings from four seats merge, and an open high blocks the panel", () => {
  const finding = (seat, id, severity) => ({
    raw_id: id,
    severity,
    claim: `${seat} claim`,
    evidence_locator: `e/${seat}`,
    violated_anchor: "AC-4",
    affected_scope: ["src/store.ts"],
    attempt: 1,
  });
  const provider = allAnswering({
    opus: resultFor(SEATS[0], { findings: [finding("opus", "F1", "high")] }),
    astra: resultFor(SEATS[1], { findings: [finding("astra", "F1", "medium")] }),
  });
  const outcome = runPanel(SEATS, deps({ provider }));
  // One canonical finding, both originators kept, highest severity before triage.
  assert.equal(outcome.canonical_findings.length, 1);
  assert.deepEqual(outcome.canonical_findings[0].originators, ["astra:F1", "opus:F1"]);
  assert.equal(outcome.canonical_findings[0].reported_severity, "high");
  assert.equal(outcome.verdict, "blocked");
  assert.equal(outcome.reason, "findings_gate");
});

test("a non-verdict outranks an unavailable seat in the panel's answer", () => {
  // Both are "not an answer", and the one the operator has to look at first is
  // the run nobody can confirm.
  const seats = [
    { seat: "a", outcome: "unavailable" },
    { seat: "b", outcome: "blocking_non_verdict" },
    { seat: "c", outcome: "answered" },
  ];
  const verdict = panelVerdict(seats, { verdict: "pass" });
  assert.equal(verdict.verdict, "blocking_non_verdict");
  assert.deepEqual(verdict.seats, ["b"]);
});

test("three passes and a silence is not a pass", () => {
  // The same rule the design candidate applies to the final attestation,
  // applied where the seats run.
  const verdict = panelVerdict(
    [
      { seat: "a", outcome: "answered" },
      { seat: "b", outcome: "answered" },
      { seat: "c", outcome: "answered" },
      { seat: "d", outcome: "unavailable" },
    ],
    { verdict: "pass" },
  );
  assert.equal(verdict.verdict, "incomplete");
  assert.equal(verdict.reason, "seat_unavailable");
});

test("a seat with no recognised outcome is not counted as an answer", () => {
  // The three outcomes are the whole vocabulary; anything else is a bug in the
  // caller, and treating it as an answer would let a panel pass on it.
  assert.throws(
    () => panelVerdict([{ seat: "x", outcome: "probably_fine" }], { verdict: "pass" }),
    (error) => error.code === "seat_non_verdict",
  );
});

test("a panel with no seats is refused rather than passing vacuously", () => {
  assert.throws(() => runPanel([], deps()), (error) => error.code === "seat_non_verdict");
});

test("one seat's refusal does not stop the others", () => {
  // The operator needs to know whether one route is down or four are.
  const seats = SEATS.map((spec, index) =>
    index === 0 ? seatSpec("opus", "anthropic/claude-opus-5", { route: route("anthropic/claude-opus-5", { smoke: { state: "failed" } }) }) : spec,
  );
  const outcome = runPanel(seats, deps({ provider: allAnswering() }));
  assert.equal(outcome.seats.length, 4);
  assert.equal(outcome.seats.filter((seat) => seat.outcome === "answered").length, 3);
});

test("a single seat run returns a record rather than throwing", () => {
  const record = runSeat(
    seatSpec("opus", "anthropic/claude-opus-5", { route: route("anthropic/claude-opus-5", { model_supported: false }) }),
    deps({ provider: allAnswering() }),
  );
  assert.equal(record.outcome, "unavailable");
  assert.ok(record.reasons.some((entry) => entry.reason === "route_model_unsupported"));
});

test("the carrier digest is reported so a disagreement can be read", () => {
  // Whether the answered seats saw the same bytes is a fact the reader needs
  // when the seats disagree.
  const outcome = runPanel([SEATS[0]], deps({ provider: allAnswering() }));
  assert.equal(outcome.identical_carriers, true);
  // No seat answered is not "they all saw the same bytes": an empty set holds
  // one distinct value the way a silent room holds one opinion.
  // `answered.length > 0` is what keeps the report from saying so.
  const noneAdmitted = SEATS.map((spec) =>
    seatSpec(spec.seat, spec.route.route_id, { route: route(spec.route.route_id, { auth: { state: "expired" } }) }));
  const none = runPanel(noneAdmitted, deps({ provider: allAnswering() }));
  assert.equal(none.seats.every((seat) => seat.outcome !== "answered"), true);
  assert.equal(none.identical_carriers, false);
  assert.match(outcome.seats[0].carrier_digest, /^[0-9a-f]{64}$/u);
  assert.equal(
    outcome.seats[0].carrier_digest,
    createHash("sha256")
      .update(
        compileCarrier(carrierRegistry, {
          role: SEATS[0].role,
          stage: SEATS[0].stage,
          context: SEATS[0].context,
          bundle,
          anchors,
        }).body,
        "utf8",
      )
      .digest("hex"),
  );
});
