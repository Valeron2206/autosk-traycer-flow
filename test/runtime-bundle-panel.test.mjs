/**
 * Tests for the four-seat panel over a governance bundle candidate (#37).
 *
 * The seats are fixed by the contract: four routes at four efforts. A panel run
 * with three of them and a convenient stand-in is not this panel, and an
 * attestation saying it is would be the most consequential false sentence this
 * program could produce — so the substitution is refused where it would happen,
 * when the seats are built.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { SUBMISSION_CLOSE, SUBMISSION_OPEN } from "../src/host/model-result.mjs";
import { PROJECTED_FIELDS } from "../src/host/gate-projection.mjs";
import { compileCarrier } from "../src/host/stage-carrier.mjs";
import { REQUIRED_SEATS, attestationErrors } from "../src/host/governance-bundle.mjs";
import { runBundlePanel, seatsFor } from "../src/host/bundle-panel.mjs";
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
  Object.values(carrierRegistry.carriers)
    .flatMap((mapping) => mapping.anchors)
    .map((anchor) => [anchor, `anchor ${anchor}\n`]),
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

const CANDIDATE = "9".repeat(64);
const code = (name) => (error) => error.code === name;

const routes = (overrides = {}) => ({
  opus: route("anthropic/claude-opus-5"),
  astra: route("openai-codex/gpt-6-astra", { requested_effort: "high", effective_effort: "high" }),
  grok: route("cursor/cursor-grok-4.6", { requested_effort: "xhigh", effective_effort: "xhigh" }),
  muse: route("meta/muse-spark-1.3-contributor"),
  ...overrides,
});

const panelContext = {
  bundle_digest: carrierRegistry.bundle_digest,
  project: BINDING,
  epic: "bundle-release",
  task: "T-102",
  dispatch_id: "disp-bundle",
  round: 1,
  attempt: 1,
  serialization_version: 1,
};

const panelDispatch = {
  dispatch_id: "disp-bundle",
  task_id: "T-102",
  attempt: 1,
  artifact_identity: "b".repeat(64),
  anchor_digest: "d".repeat(64),
  runtime_identity_digest: "e".repeat(64),
  attribution: "autosk-flow/stage-carrier/v1#panel",
  anchor_version: 3,
  included_sources: [{ logical_id: "brief", sha256: "f".repeat(64) }],
  serialized_at: new Date(NOW).toISOString(),
};

const runState = () => ({
  store_before: storeState(),
  store_after: storeState(),
  journal: [],
  projection_version: 1,
});

function bundleSeats(overrides = {}) {
  return seatsFor({
    candidateDigest: CANDIDATE,
    routes: routes(overrides),
    context: panelContext,
    dispatch: panelDispatch,
    runState,
  });
}

/** A provider that answers for every seat, echoing that seat's own headers. */
function answeringProvider(seats, { outcome = "pass", except = {} } = {}) {
  const byRoute = {};
  for (const seat of seats) {
    byRoute[seat.route.route_id] = except[seat.seat] ?? resultFor(seat, { outcome });
  }
  return providerReturning(byRoute);
}

function bundleDeps(seats, provider, overrides = {}) {
  return {
    ...deps({ provider }),
    candidateDigest: CANDIDATE,
    routes: routes(),
    context: panelContext,
    dispatch: panelDispatch,
    runState,
    releaseActor: "owner",
    ...overrides,
  };
}

test("the four seats are the contract's four, with their exact routes and efforts", () => {
  const seats = bundleSeats();
  assert.deepEqual(seats.map((seat) => seat.seat), REQUIRED_SEATS.map((entry) => entry.seat));
  assert.deepEqual(seats.map((seat) => seat.route.route_id), REQUIRED_SEATS.map((entry) => entry.route));
  assert.deepEqual(seats.map((seat) => seat.requested_effort), REQUIRED_SEATS.map((entry) => entry.effort));
  for (const seat of seats) assert.equal(seat.dispatch.candidate_identity, CANDIDATE);
  // Each seat reads the candidate through its own carrier: the registry has
  // `panel.opus`, `panel.astra` and the rest, and one seat's lens is not
  // another's even when today's mappings happen to agree.
  assert.deepEqual(seats.map((seat) => `${seat.role}.${seat.stage}`), [
    "panel.opus",
    "panel.astra",
    "panel.grok",
    "panel.muse",
  ]);
});

test("a substituted route or a downgraded effort is refused where it would happen", () => {
  // Not noticed later by an attestation reader: by then the run has happened
  // and the verdicts exist, which is exactly when "close enough" gets tempting.
  assert.throws(
    () => bundleSeats({ opus: route("anthropic/claude-sonnet-5") }),
    code("bundle_panel_incomplete"),
  );
  assert.throws(
    () => bundleSeats({ grok: route("cursor/cursor-grok-4.6", { requested_effort: "high" }) }),
    code("bundle_panel_incomplete"),
  );
  assert.throws(() => bundleSeats({ muse: undefined }), code("bundle_panel_incomplete"));
  assert.throws(
    () => seatsFor({ candidateDigest: "short", routes: routes(), context: panelContext, dispatch: panelDispatch }),
    code("bundle_attestation_mismatch"),
  );
});

test("four passes produce an attestation the contract admits", () => {
  const seats = bundleSeats();
  const result = runBundlePanel(bundleDeps(seats, answeringProvider(seats)));
  assert.equal(result.attestation.verdicts.length, 4);
  assert.deepEqual([...result.unavailable], []);
  assert.deepEqual(attestationErrors(result.attestation, CANDIDATE), []);
  assert.equal(result.attestation.release_actor, "owner");
});

test("a seat that did not answer produces no verdict, and the attestation is incomplete", () => {
  const seats = bundleSeats();
  // The route is down: the seat is unavailable, which is a different fact from
  // a seat that answered.
  const withDownRoute = seatsFor({
    candidateDigest: CANDIDATE,
    routes: routes({ muse: route("meta/muse-spark-1.3-contributor", { smoke: { state: "failed" } }) }),
    context: panelContext,
    dispatch: panelDispatch,
    runState,
  });
  const result = runBundlePanel({
    ...bundleDeps(withDownRoute, answeringProvider(withDownRoute)),
    routes: routes({ muse: route("meta/muse-spark-1.3-contributor", { smoke: { state: "failed" } }) }),
  });
  assert.equal(result.attestation.verdicts.length, 3);
  assert.equal(result.unavailable.length, 1);
  assert.equal(result.unavailable[0].seat, "muse");
  // "Three seats passed" and "four seats passed" read the same in a summary
  // that only counts passes.
  const errors = attestationErrors(result.attestation, CANDIDATE);
  assert.ok(errors.some((error) => /muse did not answer/u.test(error.detail)));
});

test("a seat that answered with anything other than a pass is carried as what it said", () => {
  const seats = bundleSeats();
  const failing = answeringProvider(seats, {
    except: { grok: resultFor(seats[2], { outcome: "fail" }) },
  });
  const result = runBundlePanel(bundleDeps(seats, failing));
  const grok = result.attestation.verdicts.find((verdict) => verdict.seat === "grok");
  assert.equal(grok.verdict, "fail");
  assert.ok(attestationErrors(result.attestation, CANDIDATE).some((error) => /grok: fail/u.test(error.detail)));
});

test("an attestation about another candidate is not this candidate's", () => {
  const seats = bundleSeats();
  const result = runBundlePanel(bundleDeps(seats, answeringProvider(seats)));
  const errors = attestationErrors(result.attestation, "0".repeat(64));
  assert.ok(errors.some((error) => error.reason === "bundle_attestation_mismatch"));
});

test("a release actor is recorded, never inferred", () => {
  const seats = bundleSeats();
  const result = runBundlePanel({ ...bundleDeps(seats, answeringProvider(seats)), releaseActor: undefined });
  assert.equal(result.attestation.release_actor, null);
  assert.ok(
    attestationErrors(result.attestation, CANDIDATE).some((error) => /no release actor/u.test(error.detail)),
  );
});

test("every seat is shown the same snapshot bytes, so a disagreement is about the lens", () => {
  // Not the same carrier: each seat's headers carry its own dispatch identity.
  // What has to be identical is the fragment digest — one snapshot, one hash,
  // four readers.
  const seats = bundleSeats();
  const digests = new Map();
  for (const seat of seats) {
    const compiled = compileCarrier(carrierRegistry, {
      role: seat.role,
      stage: seat.stage,
      context: seat.context,
      bundle,
      anchors,
    });
    for (const header of compiled.headers) {
      const seen = digests.get(header.logical_id);
      if (seen === undefined) digests.set(header.logical_id, header.file_sha256);
      else assert.equal(header.file_sha256, seen, `${header.logical_id} differs between seats`);
    }
  }
  // And the anchors are among what they all saw.
  assert.ok([...digests.keys()].some((id) => id.startsWith("anchor:")), [...digests.keys()].join(","));
});
