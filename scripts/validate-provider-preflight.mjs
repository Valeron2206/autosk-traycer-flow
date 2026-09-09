#!/usr/bin/env node

/**
 * Design-time validator for the issue #26 provider preflight.
 *
 * A catalog listing a model and a synthetic call returning does not establish
 * that a route will do what the panel needs. The checks here are about the one
 * failure that destroys the panel outright — a silent downgrade — and about the
 * two that make a bounded system unbounded: a wait with only half a budget, and
 * a retry into the outage that just exhausted it.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/provider-preflight.md";
export const SCHEMA_PATH = "resources/provider-preflight/provider-preflight.schema.json";
export const EXAMPLE_PATH = "resources/provider-preflight/provider-preflight.example.json";
export const UNAVAILABLE_EXAMPLE_PATH = "resources/provider-preflight/provider-preflight.unavailable.example.json";
export const CONTRACT_MARKER = "<!-- provider-preflight-contract:v1 -->";

/** The panel this program's owner specified, route and effort exactly. */
export const REQUIRED_PANEL = Object.freeze([
  { route_id: "anthropic/claude-opus-5", effort: "max" },
  { route_id: "openai-codex/gpt-6-astra", effort: "high" },
  { route_id: "cursor/cursor-grok-4.6", effort: "xhigh" },
  { route_id: "meta/muse-spark-1.3-contributor", effort: "max" },
]);

export const FAMILY_PARTITION_PATH = "resources/panel-roster/family-partition.v1.json";

/**
 * The family each route belongs to.
 *
 * Cross-family independence is the mechanism behind the panel gate, behind Lead
 * selection and behind `arena_judge_family_conflict`. Panel round 3 found that
 * "family" was a naming convention nothing pinned, so a partition that quietly
 * put two seats in one family would have left the gate looking intact.
 */
export function familyOf(routeId, partition) {
  const match = partition.families.find((entry) =>
    entry.route_prefixes.some((prefix) => routeId.startsWith(prefix)));
  return match ? match.family : null;
}

/** Whether the required panel really is four distinct families. */
export function partitionErrors(partition, panel = REQUIRED_PANEL) {
  const errors = [];
  const declared = partition.families.map((entry) => entry.family);
  if (new Set(declared).size !== declared.length) {
    errors.push(`${FAMILY_PARTITION_PATH}: a family is declared twice`);
  }
  const ordered = [...partition.master_order].sort();
  if (ordered.join(",") !== [...declared].sort().join(",")) {
    // A master order over families that are not the declared ones would rank
    // something the partition does not contain.
    errors.push(`${FAMILY_PARTITION_PATH}: the master order and the declared families differ`);
  }
  const seats = panel.map((entry) => ({ route: entry.route_id, family: familyOf(entry.route_id, partition) }));
  for (const seat of seats) {
    if (!seat.family) errors.push(`${FAMILY_PARTITION_PATH}: ${seat.route} belongs to no declared family`);
  }
  const families = seats.filter((seat) => seat.family).map((seat) => seat.family);
  if (new Set(families).size !== panel.length) {
    // Four seats in three families is a three-model panel wearing four names.
    errors.push(`${FAMILY_PARTITION_PATH}: the ${panel.length} required routes span ${new Set(families).size} families`);
  }
  return errors;
}

export const REFUSALS = Object.freeze([
  "route_model_unsupported",
  "route_effort_dropped",
  "route_effort_unconfirmable",
  "route_auth_expired",
  "route_smoke_failed",
  "route_permission_mode_unavailable",
  "route_preflight_expired",
  "route_failure_domain_down",
  "route_retry_budget_exhausted",
  "route_result_missing",
  "route_session_generation_conflict",
  "route_auto_context_unpinned",
]);

/**
 * Whether a route may be dispatched to, at a given moment.
 *
 * Computed rather than stored: an availability flag written at check time would
 * still say `available` after the attestation expired, which is the one state a
 * caller must never see.
 */
export function routeAvailability(route, { nowMs, downDomains = [] } = {}) {
  if (route.auth !== "live") return "refused:route_auth_expired";
  if (route.smoke.state !== "passed") return "refused:route_smoke_failed";
  // A dropped parameter makes the route unavailable, not degraded: a warning
  // nobody acts on is a warning nobody needed to send.
  if (route.effective_effort === null) return "refused:route_effort_dropped";
  if (route.effective_effort !== route.requested_effort) return "refused:route_effort_dropped";
  if (route.effort_confirmation === "unconfirmable" && route.policy_admits_unconfirmed_effort !== true) {
    return "refused:route_effort_unconfirmable";
  }
  if (nowMs !== undefined && Date.parse(route.expires_at) <= nowMs) return "refused:route_preflight_expired";
  if (downDomains.includes(route.failure_domain)) return "refused:route_failure_domain_down";
  return "available";
}

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, UNAVAILABLE_EXAMPLE_PATH, FAMILY_PARTITION_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function preflightDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

export function validateRoute(route, schema) {
  const errors = validateJsonSchema(route, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  if (Date.parse(route.expires_at) <= Date.parse(route.checked_at)) {
    errors.push("an attestation that expires before it was taken attests nothing");
  }
  // Half a budget leaves the other half unbounded.
  if (route.timeouts.idle_ms >= route.timeouts.wall_clock_ms) {
    errors.push("an idle budget at or above the wall-clock budget can never fire");
  }
  // Anything the provider will not confirm is written down, not assumed away.
  if (route.effort_confirmation !== "observed" && route.residual_risks.length === 0) {
    errors.push("an unobserved effort must be recorded as a named residual risk");
  }
  if (route.effective_effort === null && route.effort_confirmation === "observed") {
    errors.push("an effort that was dropped cannot have been observed");
  }
  // A read-only role on a full-access provider needs isolation, so the record
  // has to say which modes exist rather than implying one.
  if (!route.permission_modes.includes("read_only") && !route.residual_risks.some((r) => /read.only/iu.test(r.risk))) {
    errors.push("a route with no read-only mode must name that as a residual risk");
  }
  if (route.process_tree_termination === "unknown" && route.residual_risks.length === 0) {
    errors.push("unknown process-tree termination is a residual risk, not a blank");
  }
  return errors;
}

export function validateProviderPreflightDesign(files) {
  const errors = [];
  errors.push(...partitionErrors(JSON.parse(files[FAMILY_PARTITION_PATH])));
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const refusal of REFUSALS) {
    if (!contract.includes(refusal)) errors.push(`${CONTRACT_PATH}: refusal ${refusal} is not documented`);
  }
  if (!contract.includes("A silent downgrade destroys the panel identity")) {
    errors.push(`${CONTRACT_PATH}: does not state what a silent downgrade costs`);
  }
  if (!contract.includes("a property of the harness, not of the model")) {
    errors.push(`${CONTRACT_PATH}: does not state what a failure domain is`);
  }
  if (!contract.includes('"The process ended" is not "the work was done"')) {
    errors.push(`${CONTRACT_PATH}: does not state that a zero exit is not a result`);
  }

  let schema;
  try {
    schema = JSON.parse(files[SCHEMA_PATH]);
  } catch (error) {
    return [...errors, `${SCHEMA_PATH}: not valid JSON: ${error.message}`];
  }
  if (schema.additionalProperties !== false) {
    errors.push(`${SCHEMA_PATH}: root must be closed (additionalProperties:false)`);
  }
  // The record has no `available` field: availability is computed, and a stored
  // flag would still say `available` after the attestation expired.
  if ("available" in (schema.properties ?? {})) {
    errors.push(`${SCHEMA_PATH}: availability must be computed, not stored`);
  }
  const confirmations = schema.properties?.effort_confirmation?.enum ?? [];
  if (confirmations.slice().sort().join(",") !== "observed,reported,unconfirmable") {
    errors.push(`${SCHEMA_PATH}: effort confirmation must be exactly observed, reported, unconfirmable`);
  }
  if (schema.properties?.smoke?.properties?.contains_project_data?.const !== false) {
    errors.push(`${SCHEMA_PATH}: a smoke call must carry no project data`);
  }

  let panel;
  try {
    panel = JSON.parse(files[EXAMPLE_PATH]);
  } catch (error) {
    return [...errors, `${EXAMPLE_PATH}: not valid JSON: ${error.message}`];
  }
  for (const route of panel.routes) {
    errors.push(...validateRoute(route, schema).map((message) => `${EXAMPLE_PATH}: ${route.route_id}: ${message}`));
  }
  // The four seats the owner specified are the four this registry must describe.
  for (const required of REQUIRED_PANEL) {
    const route = panel.routes.find((entry) => entry.route_id === required.route_id);
    if (!route) {
      errors.push(`${EXAMPLE_PATH}: ${required.route_id} is not attested`);
      continue;
    }
    if (route.requested_effort !== required.effort) {
      errors.push(`${EXAMPLE_PATH}: ${required.route_id} requests ${route.requested_effort}, not ${required.effort}`);
    }
  }
  // Two seats sharing a failure domain would take each other down together, and
  // a panel that can lose two seats to one outage is not four independent reads.
  const domains = panel.routes.map((route) => route.failure_domain);
  if (new Set(domains).size !== domains.length) {
    errors.push(`${EXAMPLE_PATH}: two panel routes share a failure domain`);
  }

  let unavailable;
  try {
    unavailable = JSON.parse(files[UNAVAILABLE_EXAMPLE_PATH]);
  } catch (error) {
    return [...errors, `${UNAVAILABLE_EXAMPLE_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...validateRoute(unavailable, schema).map((message) => `${UNAVAILABLE_EXAMPLE_PATH}: ${message}`));
  if (routeAvailability(unavailable) === "available") {
    errors.push(`${UNAVAILABLE_EXAMPLE_PATH}: a route whose effort was dropped is available`);
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateProviderPreflightDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Provider preflight design validation PASS");
    console.log(`design_digest=${preflightDesignDigest(files)}`);
    console.log(`routes=${REQUIRED_PANEL.length} refusals=${REFUSALS.length}`);
  }
}
