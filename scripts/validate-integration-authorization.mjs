#!/usr/bin/env node

/**
 * Validator for the integration authorization record.
 *
 * The record is the only token that authorizes the one irreversible step, and
 * in v1 the person signs it at the stop (ADR-103), so the checks here are about
 * the ways it could authorize something nobody signed: an expired record still
 * being honoured, a transition that does not start where the record says the
 * branch was or where the branch is, a record issued by a policy, a terminal
 * record that still reads as permission, and a way into the CAS or delivery
 * that would let something other than the person accept.
 *
 * The target moves by one CAS, so a record names exactly one transition. The
 * per-Ticket order this validator was first written for — an ordered plan, a
 * start index into it and a receipt for the completed prefix — is gone with that
 * order, and the schema refuses a record shaped for it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/integration-authorization.md";
export const SCHEMA_PATH = "resources/integration-authorization/integration-authorization.schema.json";
export const EXAMPLE_PATH = "resources/integration-authorization/integration-authorization.example.json";
export const REFUSED_PATH = "resources/integration-authorization/integration-authorization.refused.example.json";
export const GRAPH_PATH = "resources/workflow-graph/workflow-graph.v1.json";
export const MATRIX_PATH = "resources/program-capabilities/matrix.v1.json";
export const CONTRACT_MARKER = "<!-- integration-authorization-contract:v1 -->";

/** The step an Epic's acceptance is given at, and the steps that move its target or deliver it. */
export const ACCEPTANCE_STEP = "accept_staging";
export const ACCEPTANCE_EXITS = Object.freeze(["integrate_staging", "deliver_staging"]);

/**
 * The two kinds of request an acceptance answers, by which autoskd recognizes
 * the excluded class at commit (§3; ADR-103, ADR-112). A decision is committed
 * before the record it completes exists, so the class is keyed by the kind of
 * request the decision answers — the request's own `park_reason`, which the
 * graph parks at exactly one step — and never by its payload: an Epic's packet
 * parked with `acceptance_missing` at `accept_staging`, or a Quick run's parked
 * with `integration_authorization_required` at `accept`. Each kind belongs to
 * one scope shape, the two the record's schema admits.
 */
export const ACCEPTANCE_REQUESTS = Object.freeze([
  Object.freeze({ scope: "epic:<epic-id>", scope_of: "an Epic's scope", packet_of: "an Epic's", reason: "acceptance_missing", step: "accept_staging" }),
  Object.freeze({ scope: "quick:<task-id>", scope_of: "a Quick run's scope", packet_of: "a Quick run's", reason: "integration_authorization_required", step: "accept" }),
]);

/** The issue that recognizes the class at commit: the daemon's heads are #4's. */
export const ACCEPTANCE_CLASS_OWNER = 4;

/** The issue that compares the heads at the CAS and owns Quick's `accept` step. */
export const ACCEPTANCE_COMPARISON_OWNER = 9;

/** The class's key clause as IA §3 states it, whole: a rewrite that keeps the words but changes the sense is not this text. */
export function acceptanceKeyClause(requests = ACCEPTANCE_REQUESTS) {
  const kinds = requests.map((request) => `${request.packet_of} packet parked with \`${request.reason}\` at \`${request.step}\` for ${request.scope_of} (\`${request.scope}\`)`);
  return "keys the class by the kind of request the decision answers, which is the request's own `park_reason` — the graph parks each of these reasons at exactly one step, so a packet needs no field for the step — one rule for both kinds of scope (ADR-112): "
    + `${kinds.join(", or ")}, never by its payload`;
}

/** The same two kinds as #4's obligation says them, whole. */
export function acceptanceObligationClause(requests = ACCEPTANCE_REQUESTS) {
  return requests
    .map((request, index) => `${request.packet_of} ${index === 0 ? "packet " : ""}parked with \`${request.reason}\` at \`${request.step}\` (scope \`${request.scope}\`)`)
    .join(", or ");
}

/**
 * The graph's stops that ask for the record: a step whose park reason has a
 * recovery row that presents the IntegrationAuthorizationRecord and parks at
 * that step alone. Read from the graph, so a third such stop is found rather
 * than left out of the table (review of 13d, L3).
 */
export function acceptanceStops(graph) {
  const rows = new Map((graph?.recovery ?? []).map((row) => [row.reason, row]));
  return (graph?.steps ?? []).flatMap((step) => {
    const row = rows.get(step.no_transition_reason);
    const asks = row !== undefined && /IntegrationAuthorizationRecord/u.test(String(row.required_state))
      && (row.parks_at ?? []).length === 1 && row.parks_at[0] === step.name;
    return asks ? [{ reason: row.reason, step: step.name }] : [];
  });
}

/**
 * Whether the class of §3 is keyed by both kinds of request, and each kind is
 * one the graph parks (R9-7). 12b keyed it only for an Epic, so a Quick run's
 * acceptance, asked at `accept` under `quick:<task-id>`, read literally moved
 * the heads it accepts and went stale at `integrateApproved`. Nothing in the
 * repository computes the class — it is autoskd's — so the contract states the
 * key clause once, whole and inside §3, #4's obligation says it, #9's names
 * both stops, and the graph has the park each kind is keyed by: at its step
 * alone, as that step's own reason, and no other stop asks for the record.
 */
export function acceptanceRequestErrors(graph, contract, matrix) {
  const errors = [];
  const rows = new Map((graph?.recovery ?? []).map((row) => [row.reason, row]));
  const records = matrix?.records ?? [];
  const obligationOf = (issue) => String(records.find((record) => record.issue_number === issue)?.implementation_obligation_before_mvp ?? "");
  const text = String(contract ?? "");
  const start = text.indexOf("## 3.");
  const binds = start < 0 ? "" : text.slice(start, text.indexOf("## 4.", start) < 0 ? undefined : text.indexOf("## 4.", start));
  const occurrences = (haystack, needle) => haystack.split(needle).length - 1;
  if (!binds.includes(acceptanceKeyClause())) {
    errors.push(`${CONTRACT_PATH}: §3 does not state the key clause of the acceptance class, whole: "${acceptanceKeyClause()}" (ADR-112)`);
  }
  if (occurrences(binds, "outside the class") !== 1) {
    errors.push(`${CONTRACT_PATH}: §3 says "outside the class" ${occurrences(binds, "outside the class")} times; only every other decision is outside it, once (ADR-112)`);
  }
  if (!obligationOf(ACCEPTANCE_CLASS_OWNER).includes(acceptanceObligationClause())) {
    errors.push(`${MATRIX_PATH}: #${ACCEPTANCE_CLASS_OWNER} recognizes the acceptance class at commit and its obligation does not state the key clause, whole: "${acceptanceObligationClause()}" (ADR-112)`);
  }
  const steps = new Map((graph?.steps ?? []).map((step) => [step.name, step]));
  for (const request of ACCEPTANCE_REQUESTS) {
    const row = rows.get(request.reason);
    if (occurrences(binds, `\`${request.reason}\``) !== 1) {
      errors.push(`${CONTRACT_PATH}: §3 names ${request.reason} ${occurrences(binds, `\`${request.reason}\``)} times; it names it once, in the key clause (ADR-112)`);
    }
    if (!row) {
      errors.push(`${GRAPH_PATH}: ${request.reason} keys the acceptance class of ${request.scope} and has no recovery row`);
    } else if (!(row.parks_at ?? []).includes(request.step)) {
      errors.push(`${GRAPH_PATH}: ${request.reason} keys the acceptance class of ${request.scope} and does not park at ${request.step}`);
    } else if (row.parks_at.length !== 1) {
      errors.push(`${GRAPH_PATH}: ${request.reason} keys the acceptance class of ${request.scope} and must park exactly at ${request.step}, not at ${row.parks_at.join(", ")}: a packet has no field for the step`);
    }
    const step = steps.get(request.step);
    if (!step) {
      errors.push(`${GRAPH_PATH}: the graph has no step ${request.step}, where ${request.reason} keys the acceptance class of ${request.scope}`);
    } else if (step.no_transition_reason !== request.reason) {
      errors.push(`${GRAPH_PATH}: the step ${request.step} does not park ${request.reason} (its no_transition_reason is ${step.no_transition_reason ?? "none"}), which keys the acceptance class of ${request.scope}`);
    }
    if (!obligationOf(ACCEPTANCE_COMPARISON_OWNER).includes(request.reason)) {
      errors.push(`${MATRIX_PATH}: #${ACCEPTANCE_COMPARISON_OWNER} compares the heads at the CAS and owns the acceptance stops, and its obligation does not name ${request.reason} (ADR-112)`);
    }
  }
  for (const stop of acceptanceStops(graph)) {
    if (!ACCEPTANCE_REQUESTS.some((request) => request.reason === stop.reason && request.step === stop.step)) {
      errors.push(`${GRAPH_PATH}: ${stop.step} asks for the IntegrationAuthorizationRecord with ${stop.reason}, and no ACCEPTANCE_REQUESTS kind keys it (ADR-112)`);
    }
  }
  return errors;
}

/**
 * The issue whose own post-v1 design work an unattended acceptance is — a
 * policy that accepts at the stop without the person (ADR-103): Autobuild,
 * whose run contract names an `approved_auto_policy`. v1 keeps
 * `autoPolicyAcceptance`, which holds a pinned policy to the person's
 * signature over the exact post-aggregate identity, so under it a policy adds
 * no autonomy and an unattended acceptance cannot pass it (review of
 * `99fd30b`, M1): that path needs another binding, which is this issue's to
 * design and a successor panel's to review.
 */
export const AUTO_POLICY_OWNER = 28;

/**
 * What #28's obligation must say about an unattended acceptance, and what it
 * may no longer say (ADR-103; review of `99fd30b`, M1 and L2). Each clause is
 * held as written, so an obligation that names the binding only to negate it,
 * or keeps the claim the review found unmeetable, is refused rather than
 * matched by a word.
 */
export const UNATTENDED_ACCEPTANCE = Object.freeze({
  clauses: Object.freeze([
    "this issue's own post-v1 design work",
    "which a successor panel reviews",
    "an auto-policy adds no autonomy",
    "only removes the wait after the person has signed that exact post-aggregate staging identity",
    "needs a different binding",
    "something the person signs before the identity exists",
    "a narrow exception, for that path alone, to the rule that no policy issues the IntegrationAuthorizationRecord",
    "`autoPolicyAcceptance` cannot admit it",
  ]),
  refused: Object.freeze([
    "passes `autoPolicyAcceptance`",
    "must pass `autoPolicyAcceptance`",
    "the graph edge that reaches it",
  ]),
});

/** The closed refusal set, as the contract states it. */
export const REFUSALS = Object.freeze([
  "integration_authorization_required",
  "integration_authorization_expired",
  "integration_authorization_scope_mismatch",
  "integration_authorization_prefix_mismatch",
  "integration_authorization_head_mismatch",
  "integration_authorization_policy_issued",
  "integration_authorization_terminal",
]);

/**
 * What refuses this record, given when it is being read.
 *
 * Every reason, not the first: a record can be both expired and revoked, and an
 * operator fixing them one round at a time learns the second only after fixing
 * the first.
 */
export function recordRefusals(record, { nowMs, scopeId, targetOid, headsBeforeStore }) {
  // Absent is its own refusal, and the one the workflow meets most often: the
  // integrate step asks for a record and there is none.
  if (!record) return [{ reason: "integration_authorization_required", detail: "no record" }];
  const refusals = [];
  if (headsBeforeStore !== undefined) {
    // This models autoskd's store-time check (ADR-103; review of `99fd30b`,
    // L4): `headsBeforeStore` maps each scope to the digest of its latest
    // record just before this one is stored, and a scope with none has no
    // head, so its first record chains from null. A record whose predecessor
    // is not its scope's head then was written against a different history
    // than the one on disk; another scope's record, which moves the global
    // `integration_authorization_head` and its own scope's head, is not its
    // predecessor and stales nothing here. The check at the CAS is another
    // one — its scope's head is the named record's own digest — and it is
    // `integrateApproved`'s, against a store this model does not read (IA §5).
    const head = Object.hasOwn(headsBeforeStore, record.scope_id) ? headsBeforeStore[record.scope_id] : null;
    if (record.previous_scope_authorization_hash !== head) {
      refusals.push({
        reason: "integration_authorization_head_mismatch",
        detail: `chains from ${record.previous_scope_authorization_hash}, the head of ${record.scope_id} is ${head}`,
      });
    }
  }
  if (Date.parse(record.expires_at) <= nowMs) {
    // Including before the CAS it was signed for: an expired record does not
    // authorize the movement it once did.
    refusals.push({ reason: "integration_authorization_expired", detail: record.expires_at });
  }
  if (record.terminal_disposition !== "active") {
    refusals.push({ reason: "integration_authorization_terminal", detail: record.terminal_disposition });
  }
  if (scopeId !== undefined && record.scope_id !== scopeId) {
    refusals.push({ reason: "integration_authorization_scope_mismatch", detail: record.scope_id });
  }
  if (record.issued_by !== undefined && record.issued_by !== "user_decision_record") {
    refusals.push({ reason: "integration_authorization_policy_issued", detail: String(record.issued_by) });
  }
  if (!record.user_decision_record_id || !record.user_decision_record_hash) {
    // A policy cannot issue one, and neither can an absence.
    refusals.push({ reason: "integration_authorization_policy_issued", detail: "no signed decision record" });
  }
  if (targetOid !== undefined && record.ref_transition.from_oid !== targetOid) {
    // The one transition starts where the record says the branch was. A branch
    // that is somewhere else is a different branch state from the one signed
    // for, and the record does not follow it there.
    refusals.push({
      reason: "integration_authorization_prefix_mismatch",
      detail: `starts from ${record.ref_transition.from_oid}, branch is at ${targetOid}`,
    });
  }
  return refusals;
}

/**
 * Whether the record's one transition is the one it says it is.
 *
 * It starts at `initial_target_oid`, the branch state the signature was made
 * against — the recorded base the one CAS expects to find.
 */
export function planErrors(record) {
  const errors = [];
  const transition = record.ref_transition;
  if (transition.from_oid !== record.initial_target_oid) {
    errors.push("ref_transition does not start at initial_target_oid");
  }
  if (record.epic_id === null && !record.quick_task_id) {
    errors.push("a Quick authorization names its quick_task_id");
  }
  if (record.epic_id === null && record.ordered_ticket_commit_oids.length !== 1) {
    // A Quick run integrates one reviewed candidate; a record naming several is
    // about some other integration.
    errors.push("a Quick authorization names its one reviewed candidate");
  }
  if (record.epic_id !== null && record.quick_task_id) {
    errors.push("an Epic authorization does not also name a Quick task");
  }
  return errors;
}

/**
 * Who may move an Epic's target or deliver it, read from the graph (ADR-103;
 * review of `99fd30b`, L1): the edges out of the acceptance step into the CAS
 * and delivery steps (`exits`) and the authority actors their guards name,
 * sorted; each of those steps' own retries (`retries`), taken only from inside
 * the step; and every other way in, which would skip the stop whoever its
 * guard names — an edge from any other step (`bypasses`), or the step being
 * one a workflow or the daemon starts at (`entries`). A resume re-enters the
 * step a park recorded, on the person's own signed decision (R8-15), so it is
 * not a way around the stop, and `integrateApproved` refuses the CAS without
 * the acceptance's record either way.
 */
export function acceptanceAuthority(graph) {
  const guards = new Map((graph?.guards ?? []).map((guard) => [guard.id, guard]));
  const into = (graph?.transitions ?? []).filter((edge) => ACCEPTANCE_EXITS.includes(edge.to));
  const exits = into.filter((edge) => edge.from === ACCEPTANCE_STEP);
  const retries = into.filter((edge) => edge.from === edge.to);
  const bypasses = into.filter((edge) => edge.from !== ACCEPTANCE_STEP && edge.from !== edge.to);
  const starts = [
    graph?.first_step,
    ...(graph?.entry_steps ?? []).map((entry) => entry?.step),
    ...(graph?.workflows ?? []).map((workflow) => workflow?.first_step),
  ];
  const actors = new Set(exits.flatMap((edge) => {
    const named = edge.guards ?? [];
    return named.length === 0 ? ["none"] : named.map((id) => guards.get(id)?.authority?.actor ?? "none");
  }));
  const ids = (edges) => Object.freeze(edges.map((edge) => edge.id).sort());
  return Object.freeze({
    exits: ids(exits),
    actors: Object.freeze([...actors].sort()),
    retries: ids(retries),
    bypasses: ids(bypasses),
    entries: Object.freeze([...new Set(starts.filter((step) => ACCEPTANCE_EXITS.includes(step)))].sort()),
  });
}

/**
 * Whether the graph and the matrix say what §1 says: v1 has one acceptance
 * authority, the person's signature at the stop (ADR-103).
 *
 * Every edge into the CAS or delivery leaves the acceptance step or is that
 * step's own retry, and neither step is where a run starts (review of
 * `99fd30b`, L1); every edge out of the acceptance step toward them carries a
 * guard, and every guard on it names the person; there is at least one such
 * edge, or nothing accepts at all. An unattended acceptance is a
 * `planned_after_v1` issue's own design, and its obligation says what that
 * path needs, clause by clause, and not the claim the review found unmeetable
 * (M1, L2). A policy guard on those edges, another way in, or the owner moved
 * into v1, is a change of the decision, not of the data.
 */
export function acceptanceAuthorityErrors(graph, matrix) {
  const errors = [];
  const guards = new Map((graph?.guards ?? []).map((guard) => [guard.id, guard]));
  const authority = acceptanceAuthority(graph);
  const edges = new Map((graph?.transitions ?? []).map((edge) => [edge.id, edge]));
  if (authority.exits.length === 0) {
    errors.push(`${GRAPH_PATH}: no edge leaves ${ACCEPTANCE_STEP} toward ${ACCEPTANCE_EXITS.join(" or ")}, so nothing accepts at all`);
  }
  for (const id of authority.exits) {
    const edge = edges.get(id);
    const named = edge.guards ?? [];
    if (named.length === 0) {
      errors.push(`${GRAPH_PATH}: ${edge.id} (${ACCEPTANCE_STEP} -> ${edge.to}) carries no guard; v1 has one acceptance authority, the person at the stop (ADR-103)`);
    }
    for (const guard of named) {
      const actor = guards.get(guard)?.authority?.actor ?? "none";
      if (actor !== "human") {
        errors.push(`${GRAPH_PATH}: ${edge.id} (${ACCEPTANCE_STEP} -> ${edge.to}) is guarded by ${guard} with authority ${actor}; v1 has one acceptance authority, the person at the stop (ADR-103)`);
      }
    }
  }
  for (const id of authority.bypasses) {
    const edge = edges.get(id);
    errors.push(`${GRAPH_PATH}: ${edge.id} (${edge.from} -> ${edge.to}) enters ${edge.to} without leaving ${ACCEPTANCE_STEP}, so it skips the stop; v1 has one acceptance authority, the person at the stop (ADR-103)`);
  }
  for (const step of authority.entries) {
    errors.push(`${GRAPH_PATH}: ${step} is an entry step, so a run could start past the stop; v1 has one acceptance authority, the person at the stop (ADR-103)`);
  }
  const owner = (matrix?.records ?? []).find((record) => record.issue_number === AUTO_POLICY_OWNER);
  if (owner?.lifecycle !== "planned_after_v1") {
    errors.push(`${MATRIX_PATH}: #${AUTO_POLICY_OWNER} owns the design of an unattended acceptance and is ${owner?.lifecycle ?? "absent"}, not planned_after_v1 (ADR-103)`);
  } else {
    const text = String(owner.implementation_obligation_before_mvp);
    for (const clause of UNATTENDED_ACCEPTANCE.clauses) {
      if (!text.includes(clause)) {
        errors.push(`${MATRIX_PATH}: #${AUTO_POLICY_OWNER} owns the design of an unattended acceptance and its obligation does not say "${clause}" (ADR-103; review of 99fd30b, M1)`);
      }
    }
    for (const claim of UNATTENDED_ACCEPTANCE.refused) {
      if (text.includes(claim)) {
        errors.push(`${MATRIX_PATH}: #${AUTO_POLICY_OWNER}'s obligation says "${claim}", a binding no unattended acceptance can pass (ADR-103; review of 99fd30b, M1)`);
      }
    }
  }
  return errors;
}

/**
 * What the CLI reports on PASS, read from the graph rather than written
 * (review of `99fd30b`, L1): who the acceptance edges' guards name, which
 * edges they are, the steps' own retries, and how many other ways in there are.
 */
export function acceptanceSummary(graph) {
  const authority = acceptanceAuthority(graph);
  return [
    `refusals=${REFUSALS.length}`,
    `acceptance_authority=${authority.actors.join("+") || "none"}`,
    `acceptance_edges=${authority.exits.join(",") || "none"}`,
    `retries=${authority.retries.join(",") || "none"}`,
    `bypasses=${authority.bypasses.length + authority.entries.length}`,
    `auto_policy_owner=#${AUTO_POLICY_OWNER}`,
  ].join(" ");
}

/** The shipped design: contract, schema, the two examples doing their jobs, and the one acceptance authority. */
export function validateDesign(files, { nowMs = Date.parse("2026-09-09T00:00:00Z") } = {}) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract || !contract.includes(CONTRACT_MARKER)) {
    errors.push(`${CONTRACT_PATH}: the contract marker is missing`);
  }
  for (const refusal of REFUSALS) {
    if (contract && !contract.includes(`\`${refusal}\``)) {
      errors.push(`${CONTRACT_PATH}: ${refusal} is not named in the contract`);
    }
  }
  const schema = JSON.parse(files[SCHEMA_PATH]);
  if (schema.additionalProperties !== false) errors.push(`${SCHEMA_PATH}: the schema is not closed`);

  const example = JSON.parse(files[EXAMPLE_PATH]);
  errors.push(...validateJsonSchema(example, schema).map((message) => `${EXAMPLE_PATH}: ${message}`));
  errors.push(...planErrors(example).map((message) => `${EXAMPLE_PATH}: ${message}`));
  const admitted = recordRefusals(example, { nowMs, scopeId: example.scope_id, targetOid: example.initial_target_oid });
  if (admitted.length > 0) {
    errors.push(`${EXAMPLE_PATH}: the worked example is refused (${admitted.map((entry) => entry.reason).join(", ")})`);
  }

  const refused = JSON.parse(files[REFUSED_PATH]);
  errors.push(...validateJsonSchema(refused, schema).map((message) => `${REFUSED_PATH}: ${message}`));
  const produced = new Set(recordRefusals(refused, { nowMs, scopeId: "another-scope" }).map((entry) => entry.reason));
  // The refused example earns its name by producing more than one class: a
  // record refused for a single reason teaches one rule.
  if (produced.size < 3) {
    errors.push(`${REFUSED_PATH}: the refused example produces only ${produced.size} refusal classes`);
  }
  errors.push(...acceptanceAuthorityErrors(JSON.parse(files[GRAPH_PATH]), JSON.parse(files[MATRIX_PATH])));
  errors.push(...acceptanceRequestErrors(JSON.parse(files[GRAPH_PATH]), contract, JSON.parse(files[MATRIX_PATH])));
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = Object.fromEntries(
    [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, REFUSED_PATH, GRAPH_PATH, MATRIX_PATH].map((relative) => [
      relative,
      readFileSync(path.join(ROOT, relative), "utf8"),
    ]),
  );
  const errors = validateDesign(files);
  for (const error of errors) console.error(error);
  if (errors.length > 0) process.exitCode = 1;
  else {
    console.log("Integration authorization contract validation PASS");
    console.log(acceptanceSummary(JSON.parse(files[GRAPH_PATH])));
  }
}
