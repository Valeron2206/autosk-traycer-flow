/**
 * Tests for the issue #26 provider preflight.
 *
 * One failure destroys the panel outright — a silent downgrade — and two make a
 * bounded system unbounded: a wait with half a budget, and a retry into the
 * outage that just exhausted it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_PATH,
  EXAMPLE_PATH,
  REFUSALS,
  REQUIRED_PANEL,
  SCHEMA_PATH,
  UNAVAILABLE_EXAMPLE_PATH,
  loadFiles,
  preflightDesignDigest,
  routeAvailability,
  validateProviderPreflightDesign,
  validateRoute,
} from "../scripts/validate-provider-preflight.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

const panel = () => JSON.parse(files[EXAMPLE_PATH]);
const opus = () => panel().routes.find((route) => route.route_id === "anthropic/claude-opus-5");
const dropped = () => JSON.parse(files[UNAVAILABLE_EXAMPLE_PATH]);

function mutated(mutate, base = opus) {
  const value = base();
  mutate(value);
  return value;
}

test("the shipped design validates", () => {
  assert.deepEqual(validateProviderPreflightDesign(files), []);
});

test("the four seats the owner specified are attested at their exact efforts", () => {
  for (const required of REQUIRED_PANEL) {
    const route = panel().routes.find((entry) => entry.route_id === required.route_id);
    assert.ok(route, `${required.route_id} is not attested`);
    assert.equal(route.requested_effort, required.effort);
  }
});

test("no two panel seats share a failure domain", () => {
  // A panel that can lose two seats to one outage is not four independent reads.
  const domains = panel().routes.map((route) => route.failure_domain);
  assert.equal(new Set(domains).size, domains.length);
});

test("a dropped effort makes the route unavailable, not degraded", () => {
  // A warning nobody acts on is a warning nobody needed to send.
  assert.equal(routeAvailability(dropped()), "refused:route_effort_dropped");
  assert.equal(
    routeAvailability(
      mutated((route) => {
        route.effective_effort = "high";
      }),
    ),
    "refused:route_effort_dropped",
  );
});

test("an unconfirmable effort is admitted only under an accepted policy", () => {
  const unconfirmed = mutated((route) => {
    route.effort_confirmation = "unconfirmable";
    route.residual_risks = [{ risk: "effort cannot be observed", reason: "no confirmation channel" }];
  });
  assert.equal(routeAvailability(unconfirmed), "refused:route_effort_unconfirmable");
  unconfirmed.policy_admits_unconfirmed_effort = true;
  assert.equal(routeAvailability(unconfirmed), "available");
});

test("anything the provider will not confirm is written down", () => {
  const errors = validateRoute(
    mutated((route) => {
      route.effort_confirmation = "reported";
      route.residual_risks = [];
    }),
    schema,
  );
  assert.ok(errors.some((message) => /named residual risk/u.test(message)));
});

test("an effort that was dropped cannot also have been observed", () => {
  const errors = validateRoute(
    mutated((route) => {
      route.effective_effort = null;
    }),
    schema,
  );
  assert.ok(errors.some((message) => /cannot have been observed/u.test(message)));
});

test("availability is computed, so an expired attestation stops attesting", () => {
  // A stored flag would still say `available` after the expiry, which is the one
  // state a caller must never see.
  assert.ok(!("available" in schema.properties));
  const route = opus();
  const before = Date.parse(route.expires_at) - 1000;
  const after = Date.parse(route.expires_at) + 1000;
  assert.equal(routeAvailability(route, { nowMs: before }), "available");
  assert.equal(routeAvailability(route, { nowMs: after }), "refused:route_preflight_expired");
});

test("an attestation that expires before it was taken attests nothing", () => {
  const errors = validateRoute(
    mutated((route) => {
      route.expires_at = route.checked_at;
    }),
    schema,
  );
  assert.ok(errors.some((message) => /expires before it was taken/u.test(message)));
});

test("a failure domain takes its routes down together and leaves the others alone", () => {
  // Cursor going down takes Grok and Kimi; Codex and Claude are unaffected.
  const routes = panel().routes;
  const down = ["cursor"];
  for (const route of routes) {
    const expected = route.failure_domain === "cursor" ? "refused:route_failure_domain_down" : "available";
    assert.equal(routeAvailability(route, { downDomains: down }), expected, route.route_id);
  }
});

test("expired auth and a failed smoke both refuse", () => {
  assert.equal(
    routeAvailability(
      mutated((route) => {
        route.auth = "expired";
      }),
    ),
    "refused:route_auth_expired",
  );
  assert.equal(
    routeAvailability(
      mutated((route) => {
        route.smoke.state = "failed";
      }),
    ),
    "refused:route_smoke_failed",
  );
});

test("half a wait budget is not a budget", () => {
  const errors = validateRoute(
    mutated((route) => {
      route.timeouts.idle_ms = route.timeouts.wall_clock_ms;
    }),
    schema,
  );
  assert.ok(errors.some((message) => /can never fire/u.test(message)));
});

test("a route with no read-only mode says so as a risk", () => {
  // The provider's own permission mode is evidence, not a substitute for
  // isolating a read-only role.
  const errors = validateRoute(
    mutated((route) => {
      route.permission_modes = ["full_access"];
    }),
    schema,
  );
  assert.ok(errors.some((message) => /no read-only mode/u.test(message)));
});

test("unknown process-tree termination is a risk, not a blank", () => {
  const errors = validateRoute(
    mutated((route) => {
      route.process_tree_termination = "unknown";
    }),
    schema,
  );
  assert.ok(errors.some((message) => /residual risk, not a blank/u.test(message)));
});

test("a smoke call carries no project data, and the schema is what says so", () => {
  assert.equal(schema.properties.smoke.properties.contains_project_data.const, false);
});

test("every refusal is documented", () => {
  const contract = files[CONTRACT_PATH];
  for (const refusal of REFUSALS) assert.ok(contract.includes(refusal), `${refusal} is not documented`);
});

test("a zero exit without a structured result is not a pass", () => {
  assert.ok(files[CONTRACT_PATH].includes('"The process ended" is not "the work was done"'));
});

test("the design digest changes when any shipped file changes", () => {
  const before = preflightDesignDigest(files);
  const after = preflightDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
