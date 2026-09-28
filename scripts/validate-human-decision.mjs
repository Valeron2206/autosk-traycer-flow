#!/usr/bin/env node

/**
 * Design-time validator for the issue #35 decision queue and status projection.
 *
 * Parked with no packet, a user sees that something stopped and reconstructs
 * what happened from comments each step wrote in its own words. The checks here
 * are about the two fields that make a packet worth reading, and about an answer
 * being bound to the identity it was asked about.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/human-decision.md";
export const REQUEST_SCHEMA_PATH = "resources/human-decision/human-decision-request.schema.json";
export const STATUS_SCHEMA_PATH = "resources/human-decision/project-status.schema.json";
export const REQUEST_EXAMPLE_PATH = "resources/human-decision/human-decision-request.example.json";
export const ANSWERED_EXAMPLE_PATH = "resources/human-decision/human-decision-request.answered.example.json";
export const STATUS_EXAMPLE_PATH = "resources/human-decision/project-status.example.json";
export const CONTRACT_MARKER = "<!-- human-decision-contract:v1 -->";

export const GRAPH_PATH = "resources/workflow-graph/workflow-graph.v1.json";

/** The task's `park.reason` is what a packet carries, so its closed set is the
 * graph's: one reason per recovery row, read from the document the daemon runs
 * rather than restated here (R6-8). */
export function graphParkReasons(graphText) {
  return Object.freeze(JSON.parse(graphText).recovery.map((row) => row.reason).sort());
}

/** A packet resumes into a workflow the graph registers (R7-7): its `workflows[]`. */
export function graphWorkflows(graphText) {
  return Object.freeze(JSON.parse(graphText).workflows.map((entry) => entry.name).sort());
}

const GRAPH_TEXT = readFileSync(path.join(ROOT, GRAPH_PATH), "utf8");

/** The graph the shipped packets are held to. */
export const GRAPH = Object.freeze(JSON.parse(GRAPH_TEXT));

export const PARK_REASONS = graphParkReasons(GRAPH_TEXT);

export const WORKFLOWS = graphWorkflows(GRAPH_TEXT);

/** A step and every step the graph's transitions lead to from it. */
function reachFrom(graph, start) {
  const next = new Map();
  for (const edge of graph.transitions) next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  const reached = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    for (const step of next.get(queue.shift()) ?? []) {
      if (reached.has(step)) continue;
      reached.add(step);
      queue.push(step);
    }
  }
  return reached;
}

/**
 * The steps a registered workflow reaches: its `first_step` and every step
 * the graph's transitions lead to from there. A workflow the graph does not
 * register reaches nothing.
 */
export function workflowReach(graph, name) {
  const workflow = graph.workflows.find((entry) => entry.name === name);
  return workflow === undefined ? new Set() : reachFrom(graph, workflow.first_step);
}

/**
 * The steps only an out-of-band entry reaches, by entry (review of 11e, L-a).
 *
 * An out-of-band entry is an `entry_steps` step that is no registered
 * workflow's first step: the daemon enters a task there wherever it stands,
 * whatever its workflow. Its region is that step and every step it reaches
 * that no workflow reaches from its first step — read from the graph, so a
 * new entry or step needs no list here.
 */
export function outOfBandRegions(graph) {
  const firsts = new Set(graph.workflows.map((entry) => entry.first_step));
  const reached = new Set(graph.workflows.flatMap((entry) => [...reachFrom(graph, entry.first_step)]));
  const regions = new Map();
  for (const { step } of graph.entry_steps ?? []) {
    if (firsts.has(step)) continue;
    regions.set(step, new Set([...reachFrom(graph, step)].filter((name) => !reached.has(name))));
  }
  return regions;
}

/**
 * Whether a task of the named workflow can stand at a packet's step under the
 * packet's row: a step the workflow reaches from its first step, or a step
 * only an out-of-band entry reaches when the row names a step of that entry's
 * region — the daemon takes the entry for a task of any workflow, and the row
 * that names it is how such a task stops there. Seeding every workflow's
 * reach with the out-of-band entries instead would lend each workflow every
 * step the entries lead on to, a judge seat `panel_join` among them (L2).
 */
export function workflowStands(graph, name, step, row) {
  if (workflowReach(graph, name).has(step)) return true;
  const named = new Set([...(row?.parks_at ?? []), ...(row?.handled_at ?? [])]);
  return [...outOfBandRegions(graph).values()].some((region) => region.has(step) && [...region].some((member) => named.has(member)));
}

/**
 * Whether a packet names a resume target a resume can admit (R7-7, ADR-099).
 *
 * ADR-089's point is that a packet resumes into its row's graph step, and a
 * schema that checks the target by length admits a packet naming a workflow
 * the graph does not register or a step no resume from its park can reach.
 * The workflow must be one of the graph's `workflows[]`, the step one a task
 * of that workflow can stand at (`workflowStands`: review of 11e, L2 — a
 * registered workflow and a permitted step are not yet a workflow standing
 * there, and a judge seat never stands where a panel joins — and L-a, a step
 * only an out-of-band entry reaches), and one of the `resume_targets` of the
 * recovery row whose `reason` is the packet's `park_reason`; a packet that
 * names another is not decidable into anything.
 */
export function resumeTargetErrors(request, graph = GRAPH) {
  const errors = [];
  const target = request.resume_target;
  const row = graph.recovery.find((entry) => entry.reason === request.park_reason);
  if (!graph.workflows.some((entry) => entry.name === target.workflow)) {
    errors.push(`resume_target.workflow ${target.workflow} is not a workflow the graph registers (decision_packet_incomplete)`);
  } else if (!workflowStands(graph, target.workflow, target.step, row)) {
    errors.push(`resume_target.step ${target.step} is not a step ${target.workflow} reaches (decision_packet_incomplete)`);
  }
  if (!(row?.resume_targets ?? []).includes(target.step)) {
    errors.push(`resume_target.step ${target.step} is not a target the ${request.park_reason} recovery row permits (decision_packet_incomplete)`);
  }
  return errors;
}

export const REFUSALS = Object.freeze([
  "decision_identity_stale",
  "decision_request_voided",
  "decision_option_unknown",
  "decision_approver_mismatch",
  "decision_expired",
  "decision_packet_incomplete",
  "decision_packet_contains_transcript",
  "status_cross_project_leak",
]);

/** Shapes a packet must never carry. A packet is read in a terminal and pasted into chat. */
export const FORBIDDEN_SHAPES = Object.freeze([
  // The quotes may be escaped: the packet is serialised before it is scanned, and
  // a transcript fragment embedded as a string arrives as \"type\":\"assistant\".
  { name: "transcript line", pattern: /\\?"type\\?"\s*:\s*\\?"(assistant|user|tool_result)\\?"/u },
  { name: "credential", pattern: /\b(gh[pousr]_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/u },
  { name: "absolute home path", pattern: /(^|[^A-Za-z0-9_])\/(Users|home)\/[A-Za-z0-9._-]+/u },
]);

/**
 * Whether an answer may be applied.
 *
 * Identity first, and that ordering is the point: an answer to a question about
 * a candidate that has since changed is not a stale answer to the same question,
 * it is an answer to a different one.
 */
export function answerDecision(request, answer, { nowMs, approver } = {}) {
  if (request.state === "voided") return "refused:decision_request_voided";
  if (nowMs !== undefined && Date.parse(request.expires_at) <= nowMs) return "refused:decision_expired";
  if (answer.identities.candidate !== request.identities.candidate) return "refused:decision_identity_stale";
  if (answer.identities.anchor_version !== request.identities.anchor_version) {
    return "refused:decision_identity_stale";
  }
  if (!request.options.some((option) => option.option_id === answer.option_id)) {
    return "refused:decision_option_unknown";
  }
  if (request.required_approver === "owner" && approver !== undefined && approver !== "owner") {
    return "refused:decision_approver_mismatch";
  }
  // A duplicate of the answer already recorded is not a second decision.
  if (request.state === "answered") {
    const same =
      request.answer.option_id === answer.option_id &&
      request.answer.identities.candidate === answer.identities.candidate;
    return same ? "idempotent" : "refused:decision_identity_stale";
  }
  return "accepted";
}

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, REQUEST_SCHEMA_PATH, STATUS_SCHEMA_PATH,
                          REQUEST_EXAMPLE_PATH, ANSWERED_EXAMPLE_PATH, STATUS_EXAMPLE_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function decisionDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

export function validateRequest(request, schema, graph = GRAPH) {
  const errors = validateJsonSchema(request, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;
  errors.push(...resumeTargetErrors(request, graph));

  const text = JSON.stringify(request);
  for (const { name, pattern } of FORBIDDEN_SHAPES) {
    if (pattern.test(text)) {
      errors.push(`the packet carries a ${name} (decision_packet_contains_transcript)`);
    }
  }
  // Two options is the minimum for a choice; one is an announcement.
  const ids = request.options.map((option) => option.option_id);
  if (new Set(ids).size !== ids.length) errors.push("an option id appears twice");
  if (request.recommendation && !ids.includes(request.recommendation)) {
    errors.push("the recommendation is not one of the options");
  }
  // An irreversible option must be visible ON the option, not only in a preamble.
  const anyIrreversible = request.options.some((option) => option.irreversible === true);
  if (anyIrreversible !== request.flags.irreversible) {
    errors.push("the irreversible flag disagrees with the options");
  }
  if (Date.parse(request.expires_at) <= Date.parse(request.created_at)) {
    errors.push("a request that expires before it was made cannot be answered");
  }
  if (request.state === "answered" && request.answer === undefined) {
    errors.push("an answered request must carry its answer");
  }
  if (request.state !== "answered" && request.answer !== undefined) {
    errors.push("only an answered request carries an answer");
  }
  // A free-text answer that changed material scope must have been confirmed.
  if (request.answer?.normalized_from && request.answer.confirmed_material_scope === undefined) {
    errors.push("a normalised answer must say whether it changed material scope");
  }
  return errors;
}

export function validateStatus(status, schema, { requests = [] } = {}) {
  const errors = validateJsonSchema(status, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  // Everything shown must trace to a record. A status that lists a decision
  // nobody filed is a second source of truth in its first sentence.
  for (const id of status.pending_decisions) {
    if (!requests.some((request) => request.request_id === id)) {
      errors.push(`pending decision ${id} has no request record`);
    }
  }
  for (const epic of status.epics) {
    if (epic.tickets.done + epic.tickets.blocked > epic.tickets.total) {
      errors.push(`${epic.epic_id}: done and blocked exceed the total`);
    }
  }
  const text = JSON.stringify(status);
  for (const { name, pattern } of FORBIDDEN_SHAPES) {
    if (pattern.test(text)) errors.push(`the status carries a ${name}`);
  }
  return errors;
}

/** Whether a status describes exactly one project. */
export function crossProjectLeak(status, ownIdentity) {
  const identities = JSON.stringify(status).match(/sha256:[0-9a-f]{64}/gu) ?? [];
  return identities.some((identity) => identity !== ownIdentity);
}

export function validateHumanDecisionDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(REQUEST_SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at the request schema`);
  for (const refusal of REFUSALS) {
    if (!contract.includes(refusal)) errors.push(`${CONTRACT_PATH}: refusal ${refusal} is not documented`);
  }
  if (!contract.includes("it is an answer to a different one")) {
    errors.push(`${CONTRACT_PATH}: does not state why a stale answer is refused`);
  }
  if (!contract.includes("a view of records that exist")) {
    errors.push(`${CONTRACT_PATH}: does not state that status is a projection`);
  }

  let requestSchema;
  let statusSchema;
  try {
    requestSchema = JSON.parse(files[REQUEST_SCHEMA_PATH]);
    statusSchema = JSON.parse(files[STATUS_SCHEMA_PATH]);
  } catch (error) {
    return [...errors, `human decision: not valid JSON: ${error.message}`];
  }
  for (const [name, schema] of [["request", requestSchema], ["status", statusSchema]]) {
    if (schema.additionalProperties !== false) {
      errors.push(`${name} schema: root must be closed (additionalProperties:false)`);
    }
  }
  // The two fields that make a packet worth reading are required, not optional.
  for (const field of ["why_automation_may_not_decide", "options"]) {
    if (!(requestSchema.required ?? []).includes(field)) {
      errors.push(`${REQUEST_SCHEMA_PATH}: ${field} must be required (decision_packet_incomplete)`);
    }
  }
  if ((requestSchema.properties?.options?.minItems ?? 0) < 2) {
    errors.push(`${REQUEST_SCHEMA_PATH}: a choice needs at least two options`);
  }
  if ((requestSchema.properties?.options?.items?.required ?? []).includes("consequence") !== true) {
    errors.push(`${REQUEST_SCHEMA_PATH}: every option must state its consequence`);
  }
  const reasons = requestSchema.properties?.park_reason?.enum ?? [];
  if (reasons.slice().sort().join(",") !== [...PARK_REASONS].sort().join(",")) {
    errors.push(`${REQUEST_SCHEMA_PATH}: the park reasons must be exactly the workflow graph's recovery reasons`);
  }
  const workflows = requestSchema.properties?.resume_target?.properties?.workflow?.enum ?? [];
  if (workflows.slice().sort().join(",") !== [...WORKFLOWS].join(",")) {
    errors.push(`${REQUEST_SCHEMA_PATH}: the resume workflows must be exactly the workflow graph's workflows`);
  }

  const requests = [];
  for (const relative of [REQUEST_EXAMPLE_PATH, ANSWERED_EXAMPLE_PATH]) {
    let request;
    try {
      request = JSON.parse(files[relative]);
    } catch (error) {
      errors.push(`${relative}: not valid JSON: ${error.message}`);
      continue;
    }
    requests.push(request);
    errors.push(...validateRequest(request, requestSchema).map((message) => `${relative}: ${message}`));
  }

  let status;
  try {
    status = JSON.parse(files[STATUS_EXAMPLE_PATH]);
  } catch (error) {
    return [...errors, `${STATUS_EXAMPLE_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...validateStatus(status, statusSchema, { requests }).map((m) => `${STATUS_EXAMPLE_PATH}: ${m}`));
  if (crossProjectLeak(status, status.project_identity)) {
    errors.push(`${STATUS_EXAMPLE_PATH}: names another project (status_cross_project_leak)`);
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateHumanDecisionDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Human decision design validation PASS");
    console.log(`design_digest=${decisionDesignDigest(files)}`);
    console.log(`park_reasons=${PARK_REASONS.length} workflows=${WORKFLOWS.length} refusals=${REFUSALS.length}`);
  }
}
