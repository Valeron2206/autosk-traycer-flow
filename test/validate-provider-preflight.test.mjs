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
  ARCH_PATH,
  CONTRACT_PATH,
  EXAMPLE_PATH,
  FAMILY_PARTITION_PATH,
  FLOWS_PATH,
  PANEL_HISTORICAL_MARKER,
  REFUSALS,
  REQUIRED_PANEL,
  SCHEMA_PATH,
  UNAVAILABLE_EXAMPLE_PATH,
  familyOf,
  flowsRosterMarkingErrors,
  loadFiles,
  masterOrderProseErrors,
  modelOf,
  partitionErrors,
  preflightDesignDigest,
  routeAvailability,
  validateProviderPreflightDesign,
  validateRoute,
} from "../scripts/validate-provider-preflight.mjs";
import { familyOf as hostFamilyOf, modelOf as hostModelOf } from "../src/host/cross-family-review.mjs";

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
  // Cursor going down takes Grok; Codex, Claude and Meta are unaffected.
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

test("a family is a property of the model, not of the harness serving it", () => {
  // `cursor/` serves Grok, Kimi and Muse, so a partition keyed on the route
  // prefix calls a kimi model grok and nothing notices. The same holds the
  // other way round: Meta's Muse is Muse whether `meta/` or `cursor/` serves
  // it, and filing it under another vendor's family (panel round 5, R5-14)
  // lets a Kimi-authored artifact exclude an unrelated reviewer.
  const partition = JSON.parse(files[FAMILY_PARTITION_PATH]);
  assert.equal(familyOf("anthropic/claude-opus-5", partition), "opus");
  assert.equal(familyOf("openai-codex/gpt-6-astra", partition), "gpt");
  assert.equal(familyOf("cursor/muse-spark-1.3", partition), "muse");
  assert.equal(familyOf("cursor/cursor-grok-4.6", partition), "grok");
  assert.equal(familyOf("cursor/cursor-kimi-2.5", partition), "kimi");
  assert.equal(familyOf("meta/muse-spark-1.3-contributor", partition), "muse");
  // One resolver for the design check and for the host: the code review and
  // the panel roles read families through the same function this validator
  // holds the roster to (R5-16), not through a second reading of the rule.
  assert.equal(familyOf, hostFamilyOf);
  assert.equal(modelOf, hostModelOf);
});

test("the product roster spans four declared families, Meta's in its own", () => {
  // The Intent seat serves Meta's Muse; counting it as Kimi made four
  // distinct families out of a vendor relabelled to fill the fourth.
  const partition = JSON.parse(files[FAMILY_PARTITION_PATH]);
  assert.deepEqual(REQUIRED_PANEL.map((seat) => familyOf(seat.route_id, partition)).sort(), ["gpt", "grok", "muse", "opus"]);
  assert.deepEqual(partition.master_order, ["gpt", "kimi", "muse", "grok", "opus"]);
  assert.deepEqual(partitionErrors(partition), []);
});

test("01 §3 marks its roster tables historical, as 02 §9 does", () => {
  // Panel round 5 (R5-15): 02 §9 marked the GPT-5.6 Sol / Kimi K3 / Opus 5
  // routes historical while 01 §3 still presented them as the panel.
  const flows = files[FLOWS_PATH];
  assert.deepEqual(flowsRosterMarkingErrors(flows), []);
  const unmarked = flows.replace(`${PANEL_HISTORICAL_MARKER}\n\n`, "");
  assert.notEqual(unmarked, flows);
  assert.ok(flowsRosterMarkingErrors(unmarked).some((message) => /lack their historical-intent marking/u.test(message)));
  assert.ok(
    validateProviderPreflightDesign({ ...files, [FLOWS_PATH]: unmarked }).some((message) =>
      /lack their historical-intent marking/u.test(message),
    ),
  );
  const seatHeader = "| Место | Маршрут | Фокус |";
  const late = unmarked.replace(seatHeader, `${seatHeader}\n\n${PANEL_HISTORICAL_MARKER}\n`);
  assert.notEqual(late, unmarked);
  assert.ok(flowsRosterMarkingErrors(late).some((message) => /must sit before the roster tables/u.test(message)));
  // A marker with no visible claim marks nothing, and a claim a comment
  // hides does not render.
  const claim = /\*\*Обе таблицы ниже — историческое целевое намерение[^\n]*/u;
  assert.match(flows, claim);
  const silent = flows.replace(claim, "");
  assert.ok(flowsRosterMarkingErrors(silent).some((message) => /историческое целевое намерение/u.test(message)));
  assert.ok(flowsRosterMarkingErrors(silent).some((message) => /`REQUIRED_PANEL`/u.test(message)));
  const hidden = flows.replace(claim, (text) => `<!-- ${text} -->`);
  assert.ok(flowsRosterMarkingErrors(hidden).some((message) => /историческое целевое намерение/u.test(message)));
});

test("01 §3's marking is scoped to the section and counted only where it renders", () => {
  const flows = files[FLOWS_PATH];
  const claim = /\*\*Обе таблицы ниже — историческое целевое намерение[^\n]*/u;
  assert.ok(flowsRosterMarkingErrors(`${flows}\u0000`).some((message) => /literal NUL/u.test(message)));
  const heading = "## 3. Четырёхмодельная панель";
  assert.ok(flowsRosterMarkingErrors(`${flows}\n${heading}\n`).some((message) => /must occur exactly once/u.test(message)));
  const unbounded = flows.replace("\n## 4.", "\n## Four.");
  assert.notEqual(unbounded, flows);
  assert.ok(flowsRosterMarkingErrors(unbounded).some((message) => /no following "## 4\." boundary/u.test(message)));
  const twice = flows.replace("\n**Supplementary**", `\n${PANEL_HISTORICAL_MARKER}\n\n**Supplementary**`);
  assert.notEqual(twice, flows);
  assert.ok(flowsRosterMarkingErrors(twice).some((message) => /must occur once in the section/u.test(message)));
  // A claim above the marker is not the marking.
  const [line] = flows.match(claim);
  const above = flows.replace(`${PANEL_HISTORICAL_MARKER}\n\n${line}`, `${line}\n\n${PANEL_HISTORICAL_MARKER}`);
  assert.notEqual(above, flows);
  assert.ok(flowsRosterMarkingErrors(above).some((message) => /историческое целевое намерение/u.test(message)));
  const indented = flows.replace(claim, (text) => `    ${text}`);
  const errors = flowsRosterMarkingErrors(indented);
  assert.ok(errors.some((message) => /an indented code line/u.test(message)));
  assert.ok(errors.some((message) => /историческое целевое намерение/u.test(message)));
});

test("01 §6's master order is the partition's", () => {
  // Two orders — one in the partition, one in prose — would give one
  // author/fixer set different lawful reviewers depending on which was read.
  const partition = JSON.parse(files[FAMILY_PARTITION_PATH]);
  const flows = files[FLOWS_PATH];
  assert.deepEqual(masterOrderProseErrors(flows, partition), []);
  const shuffled = { ...partition, master_order: ["gpt", "muse", "kimi", "grok", "opus"] };
  assert.ok(masterOrderProseErrors(flows, shuffled).some((message) => /master order/u.test(message)));
  const stale = flows.replace("**GPT, Kimi, Muse, Grok, Opus**", "**GPT, Kimi, Grok, Opus**");
  assert.notEqual(stale, flows);
  assert.ok(validateProviderPreflightDesign({ ...files, [FLOWS_PATH]: stale }).some((message) => /master order/u.test(message)));
  const unlisted = flows.replace("**GPT, Kimi, Muse, Grok, Opus**", "GPT, Kimi, Muse, Grok, Opus");
  assert.notEqual(unlisted, flows);
  assert.ok(masterOrderProseErrors(unlisted, partition).some((message) => /master order/u.test(message)));
  // An order a comment holds is not stated.
  const lead = "Мастер-порядок здесь тот же, что в §3 — **GPT, Kimi, Muse, Grok, Opus**";
  assert.ok(flows.includes(lead));
  const commented = flows.replace(lead, `<!-- ${lead} -->`);
  assert.ok(masterOrderProseErrors(commented, partition).some((message) => /is missing/u.test(message)));
});

test("a second family on an already-used prefix is a data row, not a rule change", () => {
  // The one-harness-several-families case is pinned by routes the shipped
  // data already carries: a grok, a kimi and a muse model all stand on
  // `cursor/`.
  const partition = JSON.parse(files[FAMILY_PARTITION_PATH]);
  const panel = [
    { route_id: "cursor/cursor-grok-4.6", effort: "xhigh" },
    { route_id: "cursor/cursor-kimi-2.5", effort: "max" },
    { route_id: "cursor/muse-spark-1.3", effort: "max" },
  ];
  const resolved = panel.map((seat) => familyOf(seat.route_id, partition));
  assert.deepEqual(new Set(resolved), new Set(["grok", "kimi", "muse"]));
  assert.ok(partitionErrors(partition, panel).every((message) => !/belongs to no declared family/u.test(message)));
});

test("a model the partition does not name belongs to no family, and says so by name", () => {
  // A prefix that once meant a family cannot lend it: the refusal names the
  // route instead of letting it inherit `xai/`'s.
  const partition = JSON.parse(files[FAMILY_PARTITION_PATH]);
  assert.equal(familyOf("xai/grok-9.9-unlisted", partition), null);
  const errors = partitionErrors(partition, [{ route_id: "xai/grok-9.9-unlisted", effort: "max" }]);
  assert.ok(errors.some((message) => /xai\/grok-9\.9-unlisted/u.test(message)));
});

test("the same model may not be listed in two families", () => {
  // `find` would answer with whichever family came first.
  const partition = JSON.parse(files[FAMILY_PARTITION_PATH]);
  partition.families.find((entry) => entry.family === "kimi").models.push("claude-opus-5");
  assert.ok(partitionErrors(partition).some((message) => /more than once/u.test(message)));
});

test("the design digest changes when any shipped file changes", () => {
  const before = preflightDesignDigest(files);
  const after = preflightDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});

test("any byte change inside §9 fails the pin", () => {
  // The marking stays honest only while no edit inside the span slips by.
  const droppedClause = {
    ...files,
    [ARCH_PATH]: files[ARCH_PATH].replace(" — маршрут для панели берётся оттуда, из таблицы его брать нельзя", ""),
  };
  assert.ok(validateProviderPreflightDesign(droppedClause).some((message) => /§9 differs from the pinned text/u.test(message)));
  const retimedRoute = {
    ...files,
    [ARCH_PATH]: files[ARCH_PATH].replace("openai-codex/gpt-5.6-sol:max |", "openai-codex/gpt-5.6-sol:high |"),
  };
  assert.ok(validateProviderPreflightDesign(retimedRoute).some((message) => /§9 differs from the pinned text/u.test(message)));
});

test("the §9 pin's anchors each occur exactly once", () => {
  // A second heading or route-table header would stand outside the pin,
  // unmarked, and a duplicate heading can move where the pinned span begins.
  const secondHeading = { ...files, [ARCH_PATH]: `${files[ARCH_PATH]}\n## 9. Модели\n` };
  assert.ok(validateProviderPreflightDesign(secondHeading).some((message) => /must occur exactly once/u.test(message)));
  const secondHeader = { ...files, [ARCH_PATH]: `${files[ARCH_PATH]}\n| Роль | Route |\n` };
  assert.ok(validateProviderPreflightDesign(secondHeader).some((message) => /must occur exactly once/u.test(message)));
});

test("a missing \"## 10.\" boundary fails rather than widening the section", () => {
  const widened = { ...files, [ARCH_PATH]: files[ARCH_PATH].replace("\n## 10.", "\n## Ten.") };
  assert.ok(validateProviderPreflightDesign(widened).some((message) => /no following "## 10\." boundary/u.test(message)));
});
