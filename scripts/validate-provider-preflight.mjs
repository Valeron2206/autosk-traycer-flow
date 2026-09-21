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
export const ARCH_PATH = "02-architecture.md";
/**
 * §9 of the architecture document keeps its route table as historical target
 * intent; this marker anchors the marking that keeps the table from reading as
 * the live roster.
 */
export const PANEL_HISTORICAL_MARKER = "<!-- panel-roster-historical:v1 -->";

/**
 * The whole of §9, byte for byte — from the "## 9. Модели" heading through the
 * route table, bounded by "## 10.". Threat model, per the owner's decision:
 * the carrier protects the marking against accidental edits. Deliberate hiding
 * by CommonMark trickery is out of scope — an actor doing that can delete this
 * carrier in the same PR, and review sees both. Any byte change in the span
 * fails until this constant is updated in the same commit.
 */
const SECTION_NINE_MARKING = `## 9. Модели

<!-- panel-roster-historical:v1 -->

**Таблица ниже — историческое целевое намерение, а не действующий состав панели.** Действующий состав задаёт только \`REQUIRED_PANEL\` в \`scripts/validate-provider-preflight.mjs\` — маршрут для панели берётся оттуда, из таблицы его брать нельзя. Расхождение построчно, замер 2026-09-21:

| Роль | Записано здесь | \`REQUIRED_PANEL\` на тот день | Итог |
| --- | --- | --- | --- |
| GPT critique/review | \`openai-codex/gpt-5.6-sol:max\` | \`openai-codex/gpt-6-astra\` / \`high\` | разошлись модель и effort |
| Opus coordination/architecture | \`pi-claude-code-provider/opus:max\` | \`anthropic/claude-opus-5\` / \`max\` | разошлись харнесс и модель |
| Grok implementation/feasibility | \`cursor/cursor-grok-4.6:xhigh\` | \`cursor/cursor-grok-4.6\` / \`xhigh\` | совпадает точно |
| Kimi intent/scope | \`cursor/kimi-k3:max\` | \`meta/muse-spark-1.3-contributor\` / \`max\` | разошлись харнесс и модель |

Три из четырёх записанных маршрутов \`family-partition.v1.json\` не относит ни к одному семейству — собранная по этой таблице панель получает отказ \`partitionErrors\`.

Целевые Pi route specs (историческая запись, не действующий состав):

| Роль | Route |
| --- | --- |
| GPT critique/review | openai-codex/gpt-5.6-sol:max |
| Opus coordination/architecture | pi-claude-code-provider/opus:max |
| Grok implementation/feasibility | cursor/cursor-grok-4.6:xhigh |
| Kimi intent/scope | cursor/kimi-k3:max |

Перед каждым epic preflight проверяет наличие exact route и делает короткий синтетический вызов без приватного кода. Наличие модели в каталоге не считается доказательством готовой авторизации.

`;

/** The panel this program's owner specified, route and effort exactly. */
export const REQUIRED_PANEL = Object.freeze([
  { route_id: "anthropic/claude-opus-5", effort: "max" },
  { route_id: "openai-codex/gpt-6-astra", effort: "high" },
  { route_id: "cursor/cursor-grok-4.6", effort: "xhigh" },
  { route_id: "meta/muse-spark-1.3-contributor", effort: "max" },
]);

export const FAMILY_PARTITION_PATH = "resources/panel-roster/family-partition.v1.json";

/** The model a route serves: everything after the harness prefix. */
export function modelOf(routeId) {
  const slash = routeId.indexOf("/");
  return slash === -1 ? routeId : routeId.slice(slash + 1);
}

/**
 * The family each route belongs to, answered by the model and not by the
 * harness that serves it.
 *
 * Cross-family independence is the mechanism behind the panel gate, behind Lead
 * selection and behind `arena_judge_family_conflict`. Panel round 3 found that
 * "family" was a naming convention nothing pinned, so a partition that quietly
 * put two seats in one family would have left the gate looking intact. A
 * partition keyed on the route prefix reopens the same hole the moment one
 * harness serves two families — `cursor/` serves both Grok and Kimi — so the
 * partition names each family's model ids, and a model it does not name
 * belongs to none.
 */
export function familyOf(routeId, partition) {
  const model = modelOf(routeId);
  const match = partition.families.find((entry) => Array.isArray(entry.models) && entry.models.includes(model));
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
  for (const entry of partition.families) {
    if (!Array.isArray(entry.models)) {
      errors.push(`${FAMILY_PARTITION_PATH}: ${entry.family} declares no model list`);
    }
  }
  const models = partition.families.flatMap((entry) => (Array.isArray(entry.models) ? entry.models : []));
  if (new Set(models).size !== models.length) {
    // `find` answers with the first match, so a model listed twice resolves to
    // whichever family happens to come first.
    errors.push(`${FAMILY_PARTITION_PATH}: a model is listed more than once`);
  }
  const seats = panel.map((entry) => ({ route: entry.route_id, family: familyOf(entry.route_id, partition) }));
  for (const seat of seats) {
    if (!seat.family) {
      errors.push(`${FAMILY_PARTITION_PATH}: ${seat.route} (model ${modelOf(seat.route)}) belongs to no declared family`);
    }
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
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, UNAVAILABLE_EXAMPLE_PATH, FAMILY_PARTITION_PATH, ARCH_PATH]) {
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
  // §9's route table stays in the architecture document as historical target
  // intent, with REQUIRED_PANEL the only source of the live roster. While the
  // table stands, the marking that stops it reading as live must stand too —
  // where the eye lands before the table — or a dropped note turns the table
  // back into a claim.
  // The service marker is itself an HTML comment — held as a sentinel — and
  // every other comment is stripped, so no comment can satisfy a check of a
  // visible claim. An unterminated comment strips to the end of
  // the input: in CommonMark it hides everything after it, and a mid-line
  // `<!--` with no closing is stripped the same way — over-conservative for a
  // construct that is literal text there, but the fail-safe side. A literal
  // NUL could impersonate the sentinel, so it is refused outright.
  if (files[ARCH_PATH].includes("\u0000")) {
    errors.push(`${ARCH_PATH}: contains a literal NUL — it could impersonate the marking sentinel`);
  }
  // The pin is the closure: whatever survives every named check below still
  // has to match SECTION_NINE_MARKING byte for byte. Its two anchors must each
  // occur exactly once — a duplicate heading can move where the pinned span
  // begins, and a copy of either outside the span would stand there unmarked.
  for (const anchor of ["## 9. Модели", "| Роль | Route |"]) {
    if (files[ARCH_PATH].split(anchor).length - 1 !== 1) {
      errors.push(`${ARCH_PATH}: "${anchor}" must occur exactly once — a duplicate can spoof the §9 pin`);
    }
  }
  const sectionNineAt = files[ARCH_PATH].indexOf("## 9. Модели");
  const sectionTenAt = sectionNineAt === -1 ? -1 : files[ARCH_PATH].indexOf("## 10.", sectionNineAt);
  if (sectionTenAt === -1 || files[ARCH_PATH].slice(sectionNineAt, sectionTenAt) !== SECTION_NINE_MARKING) {
    errors.push(`${ARCH_PATH}: §9 differs from the pinned text — update SECTION_NINE_MARKING in scripts/validate-provider-preflight.mjs only if the change is intended`);
  }
  const SENTINEL = "\u0000panel-roster-historical\u0000";
  const visible = files[ARCH_PATH]
    .replaceAll(PANEL_HISTORICAL_MARKER, SENTINEL)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  const afterNine = visible.split("## 9. Модели")[1] ?? "";
  if (afterNine !== "" && !afterNine.includes("## 10.")) {
    errors.push(`${ARCH_PATH}: §9 has no following "## 10." boundary — the section cannot be scoped`);
  }
  const section = afterNine.split("## 10.")[0];
  const markerAt = section.indexOf(SENTINEL);
  const tableAt = section.indexOf("| Роль | Route |");
  if (markerAt === -1) {
    errors.push(`${ARCH_PATH} §9: the route table lacks its historical-intent marking (${PANEL_HISTORICAL_MARKER})`);
  } else {
    const marking = section.slice(markerAt, tableAt === -1 ? section.length : tableAt);
    if (tableAt !== -1 && markerAt > tableAt) {
      errors.push(`${ARCH_PATH} §9: ${PANEL_HISTORICAL_MARKER} must sit before the route table, not after it`);
    }
    // Diagnosis, not closure: the pin above is the closure, and this list is
    // not exhaustive — a list of named constructs loses to the next one. It
    // exists so a failure says why: a marking line that is a link reference
    // definition, an HTML tag, indented code, or a fence is refused by name
    // instead of being searched for a claim it cannot render.
    const DISALLOWED_LINE = [
      ["a link reference definition", /^ {0,3}\[[^\]]+\]:/],
      ["an HTML tag", /<[a-zA-Z/!?]/],
      ["an indented code line", /^(?: {4}|\t)/],
      ["a code fence", /^ {0,3}(?:```|~~~)/],
    ];
    const kept = [];
    for (const line of marking.split("\n")) {
      if (line.trim() === "") continue;
      const hit = DISALLOWED_LINE.find(([, pattern]) => pattern.test(line));
      if (hit) {
        errors.push(`${ARCH_PATH} §9: the marking holds ${hit[0]} — a claim is pinned only where it renders`);
      } else {
        kept.push(line);
      }
    }
    const claims = kept.join("\n");
    if (!claims.includes("историческое целевое намерение")) {
      errors.push(`${ARCH_PATH} §9: the marking must declare the table историческое целевое намерение, not the live roster`);
    }
    // The exclusive-source statement is pinned on its own, on the lines kept
    // above and before the first table row — a column header in the dated
    // comparison must never be able to satisfy it.
    const firstRow = kept.findIndex((line) => line.trimStart().startsWith("|"));
    const prologue = kept.slice(0, firstRow === -1 ? kept.length : firstRow).join("\n");
    for (const fragment of [
      "задаёт только `REQUIRED_PANEL`",
      "`scripts/validate-provider-preflight.mjs`",
      "из таблицы его брать нельзя",
    ]) {
      if (!prologue.includes(fragment)) {
        errors.push(`${ARCH_PATH} §9: the marking must state "${fragment}" before any table`);
      }
    }
    for (const role of ["critique/review", "coordination/architecture", "implementation/feasibility", "intent/scope"]) {
      if (!claims.includes(role)) {
        errors.push(`${ARCH_PATH} §9: the marking must name the ${role} row's divergence`);
      }
    }
  }
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
