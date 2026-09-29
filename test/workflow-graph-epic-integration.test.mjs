/**
 * The Epic's integration order, read from the graph the daemon runs.
 *
 * Panel #39 round 5 found the order fixed in prose and not in the state
 * machine (R5-7): the workflow graph — a design-candidate member whose digest
 * is pinned into task identity — still ran ticket_join → accept → integrate,
 * moving the target once per Ticket, and only then aggregate_verify → cleanup.
 * No private staging, no acceptance of the verified staging identity, no single
 * target CAS after aggregate PASS, no post-CAS read-back, and no branch for a
 * delivery profile that hands the final movement to a PR or a merge queue
 * (R5-8). Core flows §7 and the accept predicate spoke of a completed prefix
 * and remaining transitions while epic-staging requires exactly one CAS
 * (R5-9). Issue #230 asks for the same order in the plan and the graph.
 *
 * So the order is asserted as properties of the graph rather than as a picture
 * of it: the two steps that end an Epic's integration — the one CAS and the
 * hand-off to the delivery profile — are unreachable without the aggregate PASS
 * gate and without the acceptance gate, each gate reads the identity it binds,
 * the CAS is read back before cleanup, and no resume lands after acceptance
 * from a stop before it. Each property is shown to fail on a graph mutated to
 * break exactly it, so a check that passes because it cannot see is caught too.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { verifyAggregate } from "../src/host/aggregate-driver.mjs";
import { aggregateErrors, casAdmission } from "../src/host/epic-staging.mjs";
import { createStaging, epicRefKey, observeTarget, readRef, stagingRef } from "../src/host/staging-driver.mjs";
import { gitRefCustody, identityFor } from "./support/git-ref-custody.mjs";
import { readChains } from "../scripts/check-workflow-chains.mjs";
import { DOCUMENT_PATH, parseStrict, producedAt } from "../scripts/validate-workflow-graph.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");
const shipped = () => parseStrict(read(DOCUMENT_PATH));
const vocabulary = () => JSON.parse(read("resources/refusal-vocabulary/refusal-vocabulary.v1.json"));

/** The steps that end an Epic's integration: the one CAS, and the hand-off to the profile. */
export const TERMINAL_MOVES = Object.freeze(["integrate_staging", "deliver_staging"]);
/** Everything after acceptance: the terminal moves and the CAS read-back. */
export const AFTER_ACCEPTANCE = Object.freeze([...TERMINAL_MOVES, "verify_target"]);
/** The Epic's own integration steps. */
export const EPIC_STEPS = Object.freeze(["apply_staging", "accept_staging", ...AFTER_ACCEPTANCE]);
/** The aggregate PASS gate: the only way into acceptance. */
export const PASS_GATE = Object.freeze({ from: "aggregate_verify", to: "accept_staging" });
/** What the PASS gate binds: the exact staging identity the aggregate ran on. */
export const PASS_READS = Object.freeze(["aggregate_binding", "staging_commit_oid", "staging_tree_oid"]);
/** What an acceptance gate binds: the accepted identity, its aggregate and the delivery plan. */
export const ACCEPTANCE_READS = Object.freeze([
  "aggregate_binding",
  "delivery_plan",
  "staging_acceptance",
  "staging_commit_oid",
  "staging_tree_oid",
]);
/** The old order, pair by pair: a target moved per Ticket before any aggregate ran. */
export const OLD_ORDER = Object.freeze([
  ["ticket_join", "accept"],
  ["ticket_join", "integrate"],
  ["integrate", "aggregate_verify"],
  ["aggregate_verify", "cleanup"],
  ["aggregate_verify", "done"],
]);
/** The per-candidate integration Quick keeps, which no Epic step may enter. */
const QUICK_INTEGRATION = Object.freeze(["accept", "integrate", "integration_recovery"]);

/**
 * The Epic's own steps: those the autosk-planned chain in 03 §2 draws and no
 * other workflow's chain does. Read from the chains rather than listed here,
 * so a step joining the Epic joins this set with it. The steps the Epic shares
 * — intake, cleanup, done, human, the repair steps, dispatch_narrow_review —
 * are not in it: a stop there belongs to every workflow standing there.
 */
export function epicSteps(plan = read("03-technical-plan.md"), graph = shipped()) {
  const { edges } = readChains(plan, new Set(graph.steps.map((step) => step.name)));
  const drawn = new Map();
  for (const edge of edges) {
    for (const name of [edge.from, edge.to]) {
      if (!drawn.has(name)) drawn.set(name, new Set());
      drawn.get(name).add(edge.workflow);
    }
  }
  return [...drawn].filter(([, workflows]) => workflows.size === 1 && workflows.has("autosk-planned"))
    .map(([name]) => name).sort();
}

/**
 * The Epic's integration segment, from where the execution chain starts to
 * acceptance: select_next, which also opens the aggregate remediation, the
 * Ticket DAG and its join, the private staging, the aggregate and its
 * remediation, and acceptance itself.
 */
export const INTEGRATION_SEGMENT = Object.freeze([
  "select_next",
  "dispatch_ticket_dag",
  "resume_repaired_tickets",
  "ticket_join",
  "ticket_join_wait",
  "apply_staging",
  "aggregate_verify",
  "record_aggregate_remediation",
  "accept_staging",
]);

/**
 * The steps an Epic shares with other workflows and stands on before
 * acceptance: human, where every park lands, the entry, the daemon's repair
 * steps and the narrow-review dispatch the planning cycle shares with code
 * review. cleanup and done are shared too, but an Epic reaches them only after
 * the read-back or the delivery predicate.
 */
export const SHARED_BEFORE_ACCEPTANCE = Object.freeze([
  "authority_recovery",
  "dispatch_narrow_review",
  "human",
  "intake",
  "repair_protocol_snapshot",
]);

/**
 * Reasons an Epic cannot record at a shared step: every edge producing them is
 * guarded by a predicate reading the task's workflow and naming Quick or
 * Ticket, and no step produces them as its own. The test checks that, rather
 * than trusting this list.
 */
export const EPIC_CANNOT_RECORD = Object.freeze(["no_external_reviewer"]);

/** Where a resume may not land from a stop before acceptance, nor one edge before. */
export const RESUME_FORBIDDEN = Object.freeze([
  "cleanup",
  "done",
  "verify_target",
  ...TERMINAL_MOVES,
  ...QUICK_INTEGRATION,
]);

/**
 * Planning-phase rows excused from the rule below. There are none.
 *
 * Five used to be named here: the three planning-ref reasons, which park at
 * cleanup beside the Epic's planning steps and lent cleanup and done to every
 * one of them, and artifact_mapping_required and review_cap, which share a row
 * with Quick's freeze and record_code_verdict and lent the Epic's planning
 * stops Quick's steps and done (R9c-14, R9c-15). The planning-ref rows are
 * origin-scoped now, review_cap resumes only along the edges out of its origin,
 * and artifact_mapping_required no longer lists done. The list stays, empty,
 * so the stale check pins it at zero: a row added here that does not leak
 * fails as stale, and one that does is refused anyway, since an excused leak
 * into any forbidden step is still a finding.
 */
export const KNOWN_PLANNING_RESUME_LEAKS = Object.freeze([]);

/** Every step reachable from the graph's declared entries over the given edges. */
function reachable(graph, edges) {
  const seeds = [graph.first_step, ...(graph.entry_steps ?? []).map((entry) => entry.step)];
  const outgoing = new Map();
  for (const edge of edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge.to);
  }
  const reached = new Set();
  const queue = [...seeds];
  while (queue.length > 0) {
    const current = queue.shift();
    if (reached.has(current)) continue;
    reached.add(current);
    for (const next of outgoing.get(current) ?? []) queue.push(next);
  }
  return reached;
}

/**
 * Every way the graph departs from the Epic order epic-staging §1 fixes.
 *
 * Returned as named findings rather than asserted in place, so the negative
 * controls below can show that each finding fires on exactly the mutation that
 * earns it.
 */
export function epicIntegrationErrors(graph, options = {}) {
  const errors = [];
  const steps = new Map(graph.steps.map((step) => [step.name, step]));
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  const predicates = new Map(graph.predicates.map((entry) => [entry.id, entry]));
  const edges = graph.transitions;
  const between = (from, to) => edges.filter((edge) => edge.from === from && edge.to === to);
  const has = (from, to) => between(from, to).length > 0;
  const readsOf = (edge) =>
    new Set(edge.guards.flatMap((id) => predicates.get(guards.get(id)?.predicate)?.reads ?? []));

  for (const name of EPIC_STEPS) {
    if (steps.get(name)?.kind !== "agent") errors.push(`epic_step_missing: ${name}`);
  }

  // 1. The old order is gone, and the new one starts at the private staging.
  for (const [from, to] of OLD_ORDER) {
    if (has(from, to)) errors.push(`old_order: ${from} -> ${to}`);
  }
  for (const from of [...EPIC_STEPS, "aggregate_verify"]) {
    for (const to of QUICK_INTEGRATION) {
      if (has(from, to)) errors.push(`old_order: ${from} -> ${to}`);
    }
  }
  if (!has("ticket_join", "apply_staging")) errors.push("staging_not_entered: ticket_join -> apply_staging");
  if (!has("apply_staging", "aggregate_verify")) errors.push("staging_not_verified: apply_staging -> aggregate_verify");

  // 2 and 3. The terminal moves are unreachable without the PASS gate and
  // without the acceptance gate: removing either set of edges strands them.
  const everything = reachable(graph, edges);
  const withoutPass = reachable(graph, edges.filter((edge) => !(edge.from === PASS_GATE.from && edge.to === PASS_GATE.to)));
  const withoutAcceptance = reachable(
    graph,
    edges.filter((edge) => !(edge.from === "accept_staging" && TERMINAL_MOVES.includes(edge.to))),
  );
  for (const move of TERMINAL_MOVES) {
    if (!everything.has(move)) errors.push(`terminal_unreachable: ${move}`);
    if (withoutPass.has(move)) errors.push(`bypasses_aggregate: ${move} is reachable without ${PASS_GATE.from} -> ${PASS_GATE.to}`);
    if (withoutAcceptance.has(move)) errors.push(`bypasses_acceptance: ${move} is reachable without accept_staging -> ${move}`);
  }

  // 4. The gates read what they bind, and acceptance is entered only through PASS.
  const passEdges = between(PASS_GATE.from, PASS_GATE.to);
  if (passEdges.length === 0) errors.push(`pass_gate_missing: ${PASS_GATE.from} -> ${PASS_GATE.to}`);
  for (const edge of passEdges) {
    const reads = readsOf(edge);
    for (const token of PASS_READS) {
      if (!reads.has(token)) errors.push(`gate_blind: ${edge.from} -> ${edge.to} does not read ${token}`);
    }
  }
  for (const edge of edges) {
    if (edge.to === "accept_staging" && edge.from !== "accept_staging" && edge.from !== PASS_GATE.from) {
      errors.push(`acceptance_entered_elsewhere: ${edge.from} -> accept_staging`);
    }
  }
  for (const move of TERMINAL_MOVES) {
    const gates = between("accept_staging", move);
    if (gates.length === 0) errors.push(`acceptance_gate_missing: accept_staging -> ${move}`);
    for (const edge of gates) {
      if (edge.guards.length === 0 || edge.guards.some((id) => guards.get(id)?.authority?.actor !== "human")) {
        errors.push(`acceptance_not_human: accept_staging -> ${move}`);
      }
      const reads = readsOf(edge);
      for (const token of ACCEPTANCE_READS) {
        if (!reads.has(token)) errors.push(`gate_blind: accept_staging -> ${move} does not read ${token}`);
      }
    }
    for (const edge of edges) {
      if (edge.to === move && edge.from !== move && edge.from !== "accept_staging") {
        errors.push(`acceptance_bypassed: ${edge.from} -> ${move}`);
      }
    }
  }

  // 5. One CAS, read back before anything else happens.
  if (!has("integrate_staging", "verify_target")) errors.push("read_back_missing: integrate_staging -> verify_target");
  for (const to of ["cleanup", "done"]) {
    if (has("integrate_staging", to)) errors.push(`no_read_back: integrate_staging -> ${to}`);
  }
  for (const edge of edges) {
    if (edge.to === "verify_target" && edge.from !== "integrate_staging") {
      errors.push(`read_back_entered_elsewhere: ${edge.from} -> verify_target`);
    }
  }
  if (!has("verify_target", "cleanup")) errors.push("read_back_unfinished: verify_target -> cleanup");
  for (const to of ["apply_staging", "accept_staging", ...TERMINAL_MOVES]) {
    if (has("verify_target", to)) errors.push(`second_cas: verify_target -> ${to}`);
  }

  // 6. The delivery-profile branch: the host hands the movement over and waits
  // for the profile's completion predicate, and never moves the branch itself.
  if (!has("deliver_staging", "cleanup")) errors.push("delivery_unfinished: deliver_staging -> cleanup");
  for (const to of ["integrate_staging", "verify_target", ...QUICK_INTEGRATION]) {
    if (has("deliver_staging", to)) errors.push(`delivery_moves_target: deliver_staging -> ${to}`);
  }
  const produced = producedAt(graph);
  if (!produced.get("completion_predicate_unmet")?.has("deliver_staging")) {
    errors.push("completion_unparked: deliver_staging does not park completion_predicate_unmet");
  }

  // 7b. Nor one that lands on cleanup, done, the read-back, a target move or
  // Quick's integration, or one edge before any of them. What a stop may resume
  // into is its row's targets — the union the row lends every step it names —
  // unless the row is origin-scoped, where the stop resumes only into the step
  // the park recorded as its origin, which for a stop standing at a step is
  // that step. Two edges are no way around the order one edge before a
  // forbidden step: the acceptance gates, which a resume into accept_staging
  // must pass, and an edge whose guards read the task's creation-bound
  // workflow, which the landing's own selection evaluates. A direct landing is
  // never excused: it runs no guard at all.
  const outgoing = new Map();
  for (const edge of edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge);
  }
  const forbidden = new Set(RESUME_FORBIDDEN);
  const isGate = (edge) => edge.from === "accept_staging" && TERMINAL_MOVES.includes(edge.to);
  const keyedByWorkflow = (edge) => edge.guards.length > 0
    && edge.guards.every((id) => predicates.get(guards.get(id)?.predicate)?.reads.includes("workflow"));
  // Origin-scoped: the stand itself. Scoped to the origin's edges: the stand
  // and the steps an edge out of it reaches. Neither lends a target across the
  // steps the row names; only the union does.
  const effective = (row, stand) => {
    if (row.resume_scope === "origin") return row.resume_targets.filter((target) => target === stand);
    if (row.resume_scope === "origin_edges") {
      return row.resume_targets.filter((target) =>
        target === stand || (outgoing.get(stand) ?? []).some((edge) => edge.to === target));
    }
    return row.resume_targets;
  };
  const leaksOf = (targets) => {
    const leaks = new Set();
    for (const target of targets) {
      if (forbidden.has(target)) leaks.add(target);
      for (const edge of outgoing.get(target) ?? []) {
        if (!isGate(edge) && !keyedByWorkflow(edge) && forbidden.has(edge.to)) leaks.add(`${target} -> ${edge.to}`);
      }
    }
    return [...leaks].sort();
  };
  const epic = new Set(options.epicSteps ?? epicSteps(options.plan, graph));
  const segment = new Set(INTEGRATION_SEGMENT);
  const sharedBefore = new Set(SHARED_BEFORE_ACCEPTANCE);
  const cannot = new Set(options.cannot ?? EPIC_CANNOT_RECORD);
  const known = new Set(options.known ?? KNOWN_PLANNING_RESUME_LEAKS);
  const beforePass = (name) => (epic.has(name) && name !== "accept_staging" && !AFTER_ACCEPTANCE.includes(name))
    || sharedBefore.has(name);
  const leaking = new Set();
  for (const row of graph.recovery) {
    const stands = [...row.parks_at, ...(row.handled_at ?? [])];
    const strict = [];
    const planning = [];
    for (const stand of stands) {
      const epicStand = segment.has(stand) || (sharedBefore.has(stand) && !cannot.has(row.reason));
      const planningStand = epic.has(stand) && !AFTER_ACCEPTANCE.includes(stand) && !segment.has(stand);
      if (!epicStand && !planningStand) continue;
      const targets = effective(row, stand);
      const leaks = leaksOf(targets);
      if (leaks.length > 0) (epicStand ? strict : planning).push({ stand, leaks });
      if (beforePass(stand) && targets.includes("accept_staging") && !cannot.has(row.reason)) {
        errors.push(`resume_skips_pass: ${row.reason} resumes into accept_staging from ${stand}`);
      }
      if (targets.includes("aggregate_verify") && !["aggregate_verify", "accept_staging"].includes(stand)
        && !["aggregate_verify_failed", "aggregate_remediation_required"].includes(row.reason)
        && (epic.has(stand) || sharedBefore.has(stand)) && !cannot.has(row.reason)) {
        errors.push(`resume_reaggregates: ${row.reason} resumes into aggregate_verify from ${stand}`);
      }
    }
    const describe = (found) => `${[...new Set(found.flatMap((entry) => entry.leaks))].sort().join(", ")} from ${found.map((entry) => entry.stand).join(", ")}`;
    if (strict.length > 0) {
      leaking.add(row.reason);
      errors.push(`resume_leak: ${row.reason} resumes into ${describe(strict)}`);
    }
    if (planning.length > 0) {
      leaking.add(row.reason);
      if (!known.has(row.reason)) errors.push(`resume_leak_unnamed: ${row.reason} resumes into ${describe(planning)}`);
      // Naming a row excuses no landing on a forbidden step: cleanup and done
      // end an Epic as surely as a target move does (R9c-14).
      else if (planning.some((entry) => entry.leaks.some((leak) => RESUME_FORBIDDEN.some((move) => leak.endsWith(move))))) {
        errors.push(`resume_leak_forbidden: ${row.reason} resumes into ${describe(planning)}`);
      }
    }
  }
  for (const reason of known) {
    if (!leaking.has(reason)) errors.push(`resume_leak_stale: ${reason} is named and no longer leaks`);
  }
  // A reason the Epic cannot record is excused at the shared steps only
  // because every edge that produces it is keyed away from the Planned workflow.
  for (const reason of cannot) {
    const producing = edges.filter((edge) => steps.get(edge.to)?.status === "human"
      && edge.guards.some((id) => guards.get(id)?.park_reason === reason));
    const keyed = producing.every((edge) => edge.guards.every((id) => {
      const predicate = predicates.get(guards.get(id)?.predicate);
      return predicate?.reads.includes("workflow") && /workflow=autosk-(quick|ticket)/u.test(predicate.description);
    }));
    const stepProduced = graph.steps.some((step) => step.no_transition_reason === reason);
    if (producing.length === 0 || !keyed || stepProduced) errors.push(`epic_cannot_record_unkeyed: ${reason}`);
  }

  // 7c. And a stop the daemon records for an Epic has a row that can recover
  // it by re-entering where it stood: the Epic's boundary row is origin-scoped,
  // names every Epic step, human and the shared steps an Epic stands on before
  // acceptance, and lists every Epic agent step as a target of its own. The
  // shared boundary row is origin-scoped too and names no Epic step.
  const boundary = graph.recovery.find((row) => row.reason === "epic_boundary_invalid");
  if (!boundary) {
    errors.push("epic_boundary_missing: no row recovers a boundary stop at an Epic step");
  } else {
    if (boundary.resume_scope !== "origin") errors.push("epic_boundary_unscoped: epic_boundary_invalid lends its targets to every step it names");
    const named = new Set([...boundary.parks_at, ...(boundary.handled_at ?? [])]);
    if (!boundary.parks_at.includes("human")) errors.push("epic_boundary_unnamed: human");
    for (const name of [...epic, ...EPIC_STEPS, ...sharedBefore]) {
      if (!named.has(name)) errors.push(`epic_boundary_unnamed: ${name}`);
    }
    for (const name of [...epic, ...EPIC_STEPS]) {
      if (steps.get(name)?.kind === "agent" && !boundary.resume_targets.includes(name)) {
        errors.push(`epic_boundary_unrecoverable: a boundary stop at ${name} cannot resume into it`);
      }
    }
    for (const target of boundary.resume_targets) {
      if (!named.has(target)) errors.push(`epic_boundary_foreign_target: ${target}`);
    }
  }
  const shared = graph.recovery.find((row) => row.reason === "project_boundary_invalid");
  if (shared?.resume_scope !== "origin") errors.push("shared_boundary_unscoped: project_boundary_invalid lends its targets to every step it names");
  for (const name of [...(shared?.parks_at ?? []), ...(shared?.handled_at ?? [])]) {
    if (epic.has(name) || EPIC_STEPS.includes(name)) errors.push(`epic_boundary_shared: project_boundary_invalid names ${name}`);
  }

  // 7. No resume lands after acceptance from a stop before it.
  const after = new Set(AFTER_ACCEPTANCE);
  for (const row of graph.recovery) {
    for (const stand of [...row.parks_at, ...(row.handled_at ?? [])]) {
      if (after.has(stand) || steps.get(stand)?.kind === "status") continue;
      const into = effective(row, stand).filter((target) => after.has(target));
      if (into.length > 0) errors.push(`resume_skips_acceptance: ${row.reason} resumes into ${into.join(", ")} from ${stand}`);
    }
  }
  return [...new Set(errors)].sort();
}

// --- the shipped graph ------------------------------------------------------

test("the old order is gone: no target movement per Ticket before the aggregate runs", () => {
  const errors = epicIntegrationErrors(shipped());
  assert.deepEqual(errors.filter((message) => /^(old_order|staging_not_|epic_step_missing)/u.test(message)), []);
});

test("the one CAS and the delivery hand-off are unreachable without the aggregate PASS gate", () => {
  const errors = epicIntegrationErrors(shipped());
  assert.deepEqual(errors.filter((message) => /^(terminal_unreachable|bypasses_aggregate|pass_gate_missing)/u.test(message)), []);
});

test("the one CAS and the delivery hand-off are unreachable without acceptance", () => {
  const errors = epicIntegrationErrors(shipped());
  assert.deepEqual(errors.filter((message) => /^(bypasses_acceptance|acceptance_gate_missing|acceptance_bypassed)/u.test(message)), []);
});

test("each gate reads the identity it binds, and acceptance is a person's", () => {
  const errors = epicIntegrationErrors(shipped());
  assert.deepEqual(
    errors.filter((message) =>
      /^(gate_blind|acceptance_not_human|acceptance_entered_elsewhere|pass_gate_missing|acceptance_gate_missing)/u.test(message)),
    [],
  );
});

test("the target moves by one CAS, and the CAS is read back before cleanup", () => {
  const errors = epicIntegrationErrors(shipped());
  assert.deepEqual(errors.filter((message) => /^(read_back_|no_read_back|second_cas)/u.test(message)), []);
});

test("a delivery profile that hands the movement over has a branch, and it ends", () => {
  const errors = epicIntegrationErrors(shipped());
  assert.deepEqual(errors.filter((message) => /^(delivery_|completion_unparked)/u.test(message)), []);
});

test("no stop in the Epic's integration segment resumes past the gates, into cleanup or done, or into Quick's integration", () => {
  const errors = epicIntegrationErrors(shipped());
  assert.deepEqual(errors.filter((message) => message.startsWith("resume_leak:")), []);
});

test("nor does a stop at human or at a step the Epic shares, and a reason it cannot record there is keyed away from it", () => {
  // R9c-9: the Epic stands at human after most of its parks, and at intake,
  // dispatch_narrow_review and the daemon's repair steps it shares with other
  // workflows; the rows naming those steps are held to the same rule.
  const errors = epicIntegrationErrors(shipped());
  assert.deepEqual(errors.filter((message) => /^(resume_leak:|epic_cannot_record_unkeyed)/u.test(message)), []);
});

test("no stop before the aggregate PASS resumes into acceptance, and only a stop past the apply re-enters the aggregate", () => {
  // R9c-10 and R9c-11: accept_staging is entered only through the PASS edge,
  // and aggregate_verify is re-entered only where the staging was applied and
  // its receipts and lineage checked — the aggregate itself, acceptance, or
  // the NOT_PASS remediation that keeps the staging the aggregate ran on.
  const errors = epicIntegrationErrors(shipped());
  assert.deepEqual(errors.filter((message) => /^resume_(skips_pass|reaggregates)/u.test(message)), []);
});

test("no planning-phase stop resumes into cleanup, done, the read-back, a target move or Quick's integration, and none is excused", () => {
  // R9c-14 and R9c-15: the list of excused rows is empty, and stays so.
  assert.deepEqual(KNOWN_PLANNING_RESUME_LEAKS, []);
  const errors = epicIntegrationErrors(shipped());
  assert.deepEqual(errors.filter((message) => /^resume_leak_(unnamed|stale|forbidden)/u.test(message)), []);
});

test("the planning-ref reasons resume only into the recorded helper-calling step", () => {
  // R9c-14. Each parks at cleanup beside the Epic's planning steps, and under
  // the union a stop at freeze_artifact could resume into cleanup and reach
  // done with no Tickets, no aggregate PASS and no acceptance. Origin-scoped,
  // a stop resumes into the step it stood at and into nothing else, and every
  // target is a step the row names.
  const graph = shipped();
  for (const reason of ["planning_candidate_keepalive_invalid", "planning_ref_capability_missing", "planning_ref_foreign_movement"]) {
    const row = graph.recovery.find((entry) => entry.reason === reason);
    assert.equal(row.resume_scope, "origin", `${reason} is not origin-scoped`);
    const named = new Set([...row.parks_at, ...(row.handled_at ?? [])]);
    assert.deepEqual(row.resume_targets.filter((target) => !named.has(target)), [], `${reason} lists a target it does not name`);
    assert.ok(!row.resume_targets.includes("done"), `${reason} still lists done`);
  }
});

test("review_cap and artifact_mapping_required lend an Epic planning stop no Quick step, cleanup or done", () => {
  // R9c-15. review_cap parks at narrow_review_join for the Planned cap and at
  // record_code_verdict for the Quick and Ticket one; resuming along the edges
  // out of the step the park stood at gives each its own recovery and neither
  // the other's. artifact_mapping_required is scoped the same way since debt
  // 12d's review (M1): a stop resumes into its origin or along an edge out of
  // it, so a Quick or Ticket stop at freeze is lent no Epic step and the
  // Epic's stop at freeze_artifact none of Quick's; done, lent only by
  // Quick's invalidate_quick_classification, is not a target of it.
  const graph = shipped();
  const epic = new Set(epicSteps());
  // A Quick step: one the Quick or Ticket chain draws and the Planned chain does not.
  const { edges: chains } = readChains(read("03-technical-plan.md"), new Set(graph.steps.map((step) => step.name)));
  const drawnBy = (name) => new Set(chains.filter((edge) => edge.from === name || edge.to === name).map((edge) => edge.workflow));
  const foreign = (name) => {
    const drawn = drawnBy(name);
    return ["cleanup", "done"].includes(name)
      || ((drawn.has("autosk-quick") || drawn.has("autosk-ticket")) && !drawn.has("autosk-planned"));
  };
  const cap = graph.recovery.find((entry) => entry.reason === "review_cap");
  assert.equal(cap.resume_scope, "origin_edges");
  const mapping = graph.recovery.find((entry) => entry.reason === "artifact_mapping_required");
  assert.equal(mapping.resume_scope, "origin_edges", "artifact_mapping_required lends nothing across its steps");
  const out = (name) => graph.transitions.filter((edge) => edge.from === name).map((edge) => edge.to);
  const stands = [...cap.parks_at, ...(cap.handled_at ?? [])].filter((name) => epic.has(name));
  assert.ok(stands.length > 0, "review_cap names an Epic step");
  for (const stand of stands) {
    const admitted = cap.resume_targets.filter((target) => target === stand || out(stand).includes(target));
    assert.deepEqual(admitted.filter(foreign), [], `review_cap lends a Quick step, cleanup or done to ${stand}`);
  }
  const mappingStands = [...mapping.parks_at, ...(mapping.handled_at ?? [])].filter((name) => epic.has(name));
  assert.ok(mappingStands.length > 0, "artifact_mapping_required names an Epic step");
  for (const stand of mappingStands) {
    const admitted = mapping.resume_targets.filter((target) => target === stand || out(stand).includes(target));
    assert.deepEqual(admitted.filter(foreign), [], `artifact_mapping_required lends a Quick step, cleanup or done to ${stand}`);
  }
  // Nor is the Epic's step lent to a Quick or Ticket stop: from freeze the
  // row admits freeze and a person's stop, and draft_artifact is an Epic step.
  assert.ok(epic.has("draft_artifact") && !epic.has("freeze"));
  const fromFreeze = mapping.resume_targets.filter((target) => target === "freeze" || out("freeze").includes(target));
  assert.deepEqual(fromFreeze.filter((target) => epic.has(target)), [], "artifact_mapping_required lends an Epic step to a Quick or Ticket stop at freeze");
});

test("a boundary stop at an Epic step has its own row and resumes where the gates still hold", () => {
  const errors = epicIntegrationErrors(shipped());
  assert.deepEqual(errors.filter((message) => /^(epic_boundary_|shared_boundary_)/u.test(message)), []);
  // The segment is the Epic's own: every step of it is one only the Planned chain draws.
  const epic = new Set(epicSteps());
  for (const name of INTEGRATION_SEGMENT) assert.ok(epic.has(name), `${name} is not an Epic step`);
  for (const name of EPIC_STEPS) assert.ok(epic.has(name), `${name} is not an Epic step`);
});

test("the Epic boundary row claims the anchor and acceptance re-check only where a guard reads them (R9c-16, closed for the hand-off by debt 12g)", () => {
  // R9c-16. integrate_staging's edges read the acceptance and the anchor;
  // verify_target's read the post-CAS observation and deliver_staging's read the
  // completion predicate, so an origin resume into either re-checked neither.
  // Risk 8 named the hand-off window that left. Debt 12g gave deliver_staging
  // the two edges integrate_staging has (blocked_anchor, acceptance_stale), so
  // the hand-off re-reads both, after a resume too; verify_target still reads
  // back a target the CAS already moved, and re-checks neither.
  const graph = shipped();
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  const predicates = new Map(graph.predicates.map((entry) => [entry.id, entry]));
  const reads = (from) => new Set(graph.transitions.filter((edge) => edge.from === from)
    .flatMap((edge) => edge.guards.flatMap((id) => predicates.get(guards.get(id)?.predicate)?.reads ?? [])));
  const rechecks = AFTER_ACCEPTANCE.filter((name) =>
    reads(name).has("staging_acceptance") && reads(name).has("controlling_anchor_digest"));
  assert.deepEqual(rechecks.sort(), ["deliver_staging", "integrate_staging"]);
  const row = graph.recovery.find((entry) => entry.reason === "epic_boundary_invalid");
  assert.doesNotMatch(row.required_state, /re-checked at integrate_staging only/u);
  assert.doesNotMatch(row.required_state, /re-runs the hand-off without re-checking the anchor/u);
  assert.match(row.required_state, /re-checked at integrate_staging and at deliver_staging/u);
  assert.match(row.required_state, /verify_target only re-reads the target the CAS already moved/u);
  const plan = read("03-technical-plan.md").split("\n").find((line) => line.startsWith("| epic_boundary_invalid |")) ?? "";
  assert.doesNotMatch(plan, /сверяются заново только в integrate_staging/u);
  assert.doesNotMatch(plan, /повторяет передачу без сверки anchor/u);
  assert.match(plan, /сверяются заново в integrate_staging и deliver_staging/u);
  // Risk 8 is closed, with the ADR that closed it, and no longer says the window is open.
  const risks = read("04-decisions.md").split("\n").find((line) => line.startsWith("8. (ADR-084")) ?? "";
  assert.match(risks, /ADR-108/u);
  assert.match(risks, /закрыт/u);
  assert.doesNotMatch(risks, /это окно передачи названо, а не закрыто/u);
  // The row says nothing the graph does not: both edges are at deliver_staging, parked under the two reasons.
  for (const reason of ["blocked_anchor", "acceptance_stale"]) {
    assert.ok(graph.recovery.find((entry) => entry.reason === reason).parks_at.includes("deliver_staging"), reason);
  }
});

test("the vocabulary's epic_step class is the set only the Planned chain draws", () => {
  const found = vocabulary().step_classes.find((entry) => entry.class === "epic_step");
  assert.ok(found, "the vocabulary declares no epic_step class");
  assert.deepEqual([...found.members].sort(), epicSteps());
});

test("project_boundary_invalid is named at the deterministic steps that are not the Epic's", () => {
  // R9c-12: the two boundary reasons are named at disjoint classes, so the
  // table no longer names both at the 41 Epic steps.
  const classes = new Map(vocabulary().step_classes.map((entry) => [entry.class, entry.members]));
  const epic = new Set(classes.get("epic_step") ?? []);
  const expected = (classes.get("deterministic_step") ?? []).filter((name) => !epic.has(name)).sort();
  assert.deepEqual([...(classes.get("non_epic_deterministic_step") ?? [])].sort(), expected);
  const entry = vocabulary().park_reasons.find((reason) => reason.code === "project_boundary_invalid");
  assert.deepEqual(entry.named_at_classes, ["non_epic_deterministic_step"]);
  const plan = read("03-technical-plan.md").split("\n");
  const boundary = plan.find((line) => line.startsWith("| Project boundary/path guard не прошёл |")) ?? "";
  assert.match(boundary, /epic_boundary_invalid/u, "03's generic boundary row names the Epic's reason");
  const authority = plan.find((line) => line.startsWith("| authority_recovery | integration authorization file/head")) ?? "";
  assert.match(authority, /acceptance_stale|autosk-planned/u, "03's authority-recovery row qualifies the Quick park for an Epic");
});

test("no resume lands after acceptance from a stop before it", () => {
  const graph = shipped();
  const errors = epicIntegrationErrors(graph);
  assert.deepEqual(errors.filter((message) => message.startsWith("resume_skips_acceptance")), []);
  // Not vacuous: a stop after acceptance does resume into the step it stopped
  // at — the CAS after a conflict, the hand-off while its predicate is unmet.
  for (const move of TERMINAL_MOVES) {
    assert.ok(
      graph.recovery.some((row) => row.resume_targets.includes(move) && row.parks_at.includes(move)),
      `no row parked at ${move} resumes into it`,
    );
  }
});

test("the shipped graph departs from the Epic order in no way at all", () => {
  assert.deepEqual(epicIntegrationErrors(shipped()), []);
});

// --- negative controls: each finding fires on the mutation that earns it -----

/** A mutated copy of the shipped graph; the helper never reads the digest. */
function mutated(mutate) {
  const graph = structuredClone(shipped());
  mutate(graph);
  return graph;
}

/** An edge with the guards of an existing one, so only its endpoints change. */
function edgeLike(graph, from, to, template) {
  const source = graph.transitions.find((edge) => edge.from === template.from && edge.to === template.to);
  assert.ok(source, `the shipped graph declares ${template.from} -> ${template.to}`);
  graph.transitions.push({ id: `t_control_${from}_${to}`, from, to, priority: 999, guards: [...source.guards] });
}

const CONTROLS = [
  {
    name: "the old order put back: the target moves before the aggregate",
    mutate: (graph) => edgeLike(graph, "aggregate_verify", "cleanup", PASS_GATE),
    finding: /^old_order: aggregate_verify -> cleanup$/u,
  },
  {
    name: "a staging that skips the aggregate straight into acceptance",
    mutate: (graph) => edgeLike(graph, "apply_staging", "accept_staging", PASS_GATE),
    finding: /^bypasses_aggregate: integrate_staging /u,
  },
  {
    name: "an aggregate PASS that moves the target with nobody accepting",
    mutate: (graph) => edgeLike(graph, "aggregate_verify", "integrate_staging", PASS_GATE),
    finding: /^bypasses_acceptance: integrate_staging /u,
  },
  {
    name: "an acceptance an agent may give",
    mutate: (graph) => {
      const gate = graph.transitions.find((edge) => edge.from === "accept_staging" && edge.to === "integrate_staging");
      for (const id of gate.guards) graph.guards.find((guard) => guard.id === id).authority = { actor: "agent" };
    },
    finding: /^acceptance_not_human: accept_staging -> integrate_staging$/u,
  },
  {
    name: "an acceptance that does not read the tree it accepts",
    mutate: (graph) => {
      const gate = graph.transitions.find((edge) => edge.from === "accept_staging" && edge.to === "integrate_staging");
      for (const id of gate.guards) {
        const predicate = graph.predicates.find((entry) => entry.id === graph.guards.find((guard) => guard.id === id).predicate);
        predicate.reads = predicate.reads.filter((token) => token !== "staging_tree_oid");
      }
    },
    finding: /^gate_blind: accept_staging -> integrate_staging does not read staging_tree_oid$/u,
  },
  {
    name: "a CAS that goes to cleanup without being read back",
    mutate: (graph) => edgeLike(graph, "integrate_staging", "cleanup", { from: "verify_target", to: "cleanup" }),
    finding: /^no_read_back: integrate_staging -> cleanup$/u,
  },
  {
    name: "a stop before acceptance that resumes into the CAS",
    mutate: (graph) => {
      graph.recovery.find((row) => row.reason === "delta_stale").resume_targets.push("integrate_staging");
    },
    finding: /^resume_skips_acceptance: delta_stale resumes into integrate_staging from apply_staging$/u,
  },
  {
    name: "the Epic's boundary row lends its targets to every step it names",
    mutate: (graph) => { delete graph.recovery.find((row) => row.reason === "epic_boundary_invalid").resume_scope; },
    finding: /^resume_leak: epic_boundary_invalid resumes into .*cleanup.* from /u,
  },
  {
    name: "the shared boundary row lends Quick's integration and cleanup to an Epic standing at human",
    mutate: (graph) => { delete graph.recovery.find((row) => row.reason === "project_boundary_invalid").resume_scope; },
    finding: /^resume_leak: project_boundary_invalid resumes into accept, .*cleanup.*integrate.* from .*human/u,
  },
  {
    name: "a stop at human that resumes into cleanup",
    mutate: (graph) => { graph.recovery.find((row) => row.reason === "no_external_panel_lead").resume_targets.push("cleanup"); },
    finding: /^resume_leak: no_external_panel_lead resumes into cleanup, .* from .*human/u,
  },
  {
    name: "a stop in the segment that resumes into Quick's integrate",
    mutate: (graph) => { graph.recovery.find((row) => row.reason === "aggregate_binding_void").resume_targets.push("integrate"); },
    finding: /^resume_leak: aggregate_binding_void resumes into .*integrate/u,
  },
  {
    name: "an anchor stop in the segment that resumes one unguarded edge before done",
    mutate: (graph) => { graph.recovery.find((row) => row.reason === "blocked_anchor").resume_targets.push("invalidate_quick_classification"); },
    finding: /^resume_leak: blocked_anchor resumes into invalidate_quick_classification -> done /u,
  },
  {
    name: "a stop before the aggregate PASS that resumes into acceptance",
    mutate: (graph) => { graph.recovery.find((row) => row.reason === "delta_stale").resume_targets.push("accept_staging"); },
    finding: /^resume_skips_pass: delta_stale resumes into accept_staging from apply_staging$/u,
  },
  {
    name: "a stop before the apply that re-enters the aggregate",
    mutate: (graph) => { graph.recovery.find((row) => row.reason === "receipt_missing").resume_targets.push("aggregate_verify"); },
    finding: /^resume_reaggregates: receipt_missing resumes into aggregate_verify from apply_staging$/u,
  },
  {
    name: "a reason excused at the shared steps whose producing edge stops reading the workflow",
    mutate: (graph) => {
      for (const predicate of graph.predicates) {
        if (/нет reviewer семьи/u.test(predicate.description)) predicate.reads = predicate.reads.filter((token) => token !== "workflow");
      }
    },
    finding: /^epic_cannot_record_unkeyed: no_external_reviewer$/u,
  },
  {
    name: "a row named as a planning leak that does not leak is caught as stale",
    mutate: () => {},
    options: { known: ["planning_ref_capability_missing"] },
    finding: /^resume_leak_stale: planning_ref_capability_missing /u,
  },
  {
    name: "a planning-ref row that lends its targets again reaches cleanup and done",
    mutate: (graph) => { delete graph.recovery.find((row) => row.reason === "planning_ref_capability_missing").resume_scope; },
    finding: /^resume_leak_unnamed: planning_ref_capability_missing resumes into cleanup, cleanup -> cleanup, cleanup -> done/u,
  },
  {
    name: "naming a planning row does not excuse its landing on cleanup",
    mutate: (graph) => { delete graph.recovery.find((row) => row.reason === "planning_candidate_keepalive_invalid").resume_scope; },
    options: { known: ["planning_candidate_keepalive_invalid"] },
    finding: /^resume_leak_forbidden: planning_candidate_keepalive_invalid resumes into cleanup/u,
  },
  {
    name: "review_cap lending its Quick targets to the Planned stop again",
    mutate: (graph) => { delete graph.recovery.find((row) => row.reason === "review_cap").resume_scope; },
    finding: /^resume_leak_unnamed: review_cap resumes into invalidate_quick_classification -> done from narrow_review_join/u,
  },
  {
    // Since debt 12d's review (M1) the row is scoped to its origin's edges, so
    // `done` listed alone is a target no origin reaches and leaks nothing; the
    // control lists it in a row that lends its targets again, as it was.
    name: "artifact_mapping_required listing done again and lending its targets across its steps",
    mutate: (graph) => {
      const row = graph.recovery.find((entry) => entry.reason === "artifact_mapping_required");
      delete row.resume_scope;
      row.resume_targets.push("done");
    },
    finding: /^resume_leak_unnamed: artifact_mapping_required resumes into done from /u,
  },
  {
    name: "a delivery hand-off that moves the branch after all",
    mutate: (graph) => edgeLike(graph, "deliver_staging", "integrate_staging", { from: "deliver_staging", to: "cleanup" }),
    finding: /^delivery_moves_target: deliver_staging -> integrate_staging$/u,
  },
];

for (const control of CONTROLS) {
  test(`negative control — ${control.name}`, () => {
    const clean = epicIntegrationErrors(shipped());
    assert.ok(!clean.some((message) => control.finding.test(message)), `the shipped graph already carries ${control.finding}`);
    const errors = epicIntegrationErrors(mutated(control.mutate), control.options);
    assert.ok(
      errors.some((message) => control.finding.test(message)),
      `expected ${control.finding}, got:\n${errors.join("\n") || "(no findings)"}`,
    );
  });
}

// --- review findings on the first pass (R9c-2, R9c-3, R9c-5, R9c-1's forward half, R9c-6) ---

/** The guards and their predicates' reads on the edges from one step to another. */
function edgeReads(graph, from, to, reason) {
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  const predicates = new Map(graph.predicates.map((entry) => [entry.id, entry]));
  return graph.transitions
    .filter((edge) => edge.from === from && edge.to === to)
    .filter((edge) => reason === undefined || edge.guards.some((id) => guards.get(id)?.park_reason === reason))
    .map((edge) => ({
      edge,
      reads: new Set(edge.guards.flatMap((id) => predicates.get(guards.get(id)?.predicate)?.reads ?? [])),
      says: edge.guards.map((id) => predicates.get(guards.get(id)?.predicate)?.description ?? "").join(" "),
    }));
}

test("an authorization that lapses before the CAS makes the acceptance stale where the CAS would run", () => {
  // R9c-2. integrateApproved re-resolves the authorization under the mutex; an
  // expired, revoked, replaced or head-mismatched one is refused there, and the
  // edge that classifies the refusal is integrate_staging's acceptance_stale
  // park, which resumes at accept_staging for a new acceptance.
  const graph = shipped();
  const [stale] = edgeReads(graph, "integrate_staging", "human", "acceptance_stale");
  assert.ok(stale, "integrate_staging parks acceptance_stale");
  assert.ok(stale.reads.has("integration_authorization"), `reads ${[...stale.reads].join(", ")}`);
  assert.match(stale.says, /expired|истек/u);
  const row = graph.recovery.find((entry) => entry.reason === "acceptance_stale");
  assert.ok(row.parks_at.includes("integrate_staging"));
  assert.deepEqual([...row.resume_targets].sort(), ["accept_staging", "human"]);
  // And the prose says the same for an Epic: the Quick park is not the Epic's.
  const contract = read("docs/contracts/integration-authorization.md");
  const section5 = contract.slice(contract.indexOf("## 5."), contract.indexOf("## 6."));
  assert.match(section5, /acceptance_stale/u);
  const architecture = read("02-architecture.md").split("\n").find((line) => line.startsWith("`IntegrationAuthorizationRecord` authoritative source")) ?? "";
  assert.match(architecture, /acceptance_stale/u);
  const plan = read("03-technical-plan.md");
  assert.ok(!/makes the auto-policy acceptance stale at accept_staging/u.test(plan), "03 still places the stale acceptance at accept_staging");
});

test("a staging that moved after PASS is re-applied before it is re-aggregated", () => {
  // R9c-3. The move is one nobody recorded, so the staging goes back through
  // apply_staging's receipt and lineage check rather than straight into a new
  // aggregate over a commit nobody accounted for.
  const graph = shipped();
  const row = graph.recovery.find((entry) => entry.reason === "staging_moved_after_pass");
  assert.deepEqual([...row.resume_targets].sort(), ["apply_staging", "human"]);
  // R9c-11: at aggregate_verify too, the same move is the same reason.
  assert.deepEqual([...row.parks_at].sort(), ["accept_staging", "aggregate_verify"]);
  for (const from of ["accept_staging", "aggregate_verify"]) {
    const [back] = edgeReads(graph, from, "apply_staging");
    assert.ok(back, `${from} declares the resume edge into apply_staging`);
    assert.ok(back.reads.has("integration_receipts"), `${from} -> apply_staging does not read integration_receipts`);
  }
  const [void_] = edgeReads(graph, "aggregate_verify", "human", "aggregate_binding_void");
  for (const token of ["staging_commit_oid", "staging_tree_oid"]) {
    assert.ok(!void_.reads.has(token), `aggregate_binding_void at aggregate_verify still reads ${token}: a moved staging is staging_moved_after_pass`);
  }
  const [onward] = edgeReads(graph, "apply_staging", "aggregate_verify");
  for (const token of ["integration_receipts", "recorded_target_base"]) {
    assert.ok(onward.reads.has(token), `apply_staging -> aggregate_verify does not read ${token}`);
  }
});

test("the CAS edge reads the acceptance and the anchor it acts under", () => {
  // R9c-5. The pre-CAS checks are in the graph, not only in the step's prose.
  const [cas] = edgeReads(shipped(), "integrate_staging", "verify_target");
  for (const token of ["staging_acceptance", "controlling_anchor_digest", "cas_receipt", "recorded_target_base"]) {
    assert.ok(cas.reads.has(token), `integrate_staging -> verify_target does not read ${token}`);
  }
});

test("every edge into Quick's integration is guarded by the workflow the task was created in", () => {
  // The forward half of R9c-1. Planned reaches record_code_verdict and
  // record_editorial_exemption through review steps it shares with Quick and
  // Ticket, and from there the graph draws edges into Quick's accept and
  // integrate. What stops an Epic there is a guard reading the task's
  // creation-bound workflow, and every such edge must carry one.
  const graph = shipped();
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  const predicates = new Map(graph.predicates.map((entry) => [entry.id, entry]));
  const unguarded = [];
  for (const edge of graph.transitions) {
    if (!QUICK_INTEGRATION.includes(edge.to) || QUICK_INTEGRATION.includes(edge.from)) continue;
    const bound = edge.guards.some((id) => {
      const predicate = predicates.get(guards.get(id)?.predicate);
      return predicate?.reads.includes("workflow") && /workflow=autosk-quick/u.test(predicate.description);
    });
    if (!bound) unguarded.push(`${edge.id} ${edge.from} -> ${edge.to}`);
  }
  assert.deepEqual(unguarded, []);
});

test("the graph contracts and the validator cite only ids the document declares", () => {
  // R9c-6: ids deleted with the per-Ticket order must not be cited as present.
  const graph = shipped();
  const declared = new Set([
    ...graph.transitions.map((edge) => edge.id),
    ...graph.guards.map((guard) => guard.id),
    ...graph.predicates.map((entry) => entry.id),
  ]);
  const cited = [];
  for (const relative of ["docs/contracts/workflow-graph.md", "docs/contracts/workflow-factory.md", "scripts/validate-workflow-graph.mjs"]) {
    for (const [id] of read(relative).matchAll(/\b(?:t|guard|cond)_\d{3}\b/gu)) {
      if (!declared.has(id)) cited.push(`${relative}: ${id}`);
    }
  }
  assert.deepEqual([...new Set(cited)], []);
});

// --- debt 10b: one Epic integration model (ADR-088) ----------------------------

test("a foreign target movement resumes into apply_staging on a recorded re-stage decision", () => {
  // R6-4. The movement is not this Epic's, so it is never overwritten; the
  // user may decide to re-stage onto it: the new base is recorded, every
  // approved delta is revalidated against it, and prior PASS and acceptance
  // are void. A person decides. Since debt 11e it is the one re-stage out of
  // the CAS: target_moved and its resume are gone (ADR-099).
  const graph = shipped();
  const row = graph.recovery.find((entry) => entry.reason === "foreign_target_movement");
  assert.deepEqual([...row.resume_targets].sort(), ["apply_staging", "human"]);
  const [back] = edgeReads(graph, "integrate_staging", "apply_staging", "foreign_target_movement");
  assert.ok(back, "integrate_staging declares the foreign_target_movement resume edge into apply_staging");
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  assert.ok(back.edge.guards.every((id) => guards.get(id).authority.actor === "human"), "the re-stage is a person's decision");
  for (const token of ["recorded_target_base", "resume_intent", "approved_deltas"]) {
    assert.ok(back.reads.has(token), `the resume edge does not read ${token}`);
  }
  assert.match(back.says, /delta_stale/u);
  assert.match(back.says, /void/u);
  // The re-stage puts one receipted planning replay commit on the new base
  // before the deltas, so the rebuilt staging still carries the planning
  // artifacts while the planning ref itself is untouched.
  assert.match(back.says, /planning replay commit под receipt/u);
  assert.ok(back.reads.has("planning"), "the re-stage resume does not read the planning state");
  assert.deepEqual(edgeReads(graph, "integrate_staging", "apply_staging", "target_moved"), []);
  assert.match(row.required_state, /apply_staging/u);
  // 03 section 2 carries the row the edge is drawn from.
  const plan = read("03-technical-plan.md");
  assert.ok(plan.split("\n").some((line) => line.startsWith("| integrate_staging | resume --to apply_staging под park.reason=foreign_target_movement")),
    "03 section 2 has no foreign_target_movement resume row");
});

test("an aggregate NOT_PASS parks at human, and no competing edge with the same condition runs first", () => {
  // a1 medium: t_370 (-> select_next) and t_371 (-> human, aggregate_verify_failed)
  // carried one condition, so the lower-priority park was dead.
  const graph = shipped();
  assert.deepEqual(edgeReads(graph, "aggregate_verify", "select_next"), [], "aggregate_verify -> select_next is gone");
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  const failing = graph.transitions.filter((edge) => edge.from === "aggregate_verify"
    && edge.guards.some((id) => guards.get(id)?.park_reason === "aggregate_verify_failed"));
  assert.deepEqual(failing.map((edge) => edge.to), ["human"]);
});

test("the prose says one integration model: who moves the target, what authorizes it, where staging starts", () => {
  const section = (text, from, to) => text.slice(text.indexOf(from), to ? text.indexOf(to, text.indexOf(from)) : undefined);
  // The record is always required for the Epic CAS, in every place that states it.
  const authorization = read("docs/contracts/integration-authorization.md");
  assert.match(section(authorization, "## 1.", "## 2."), /always required/u);
  const flows = read("01-core-flows.md");
  const seven = section(flows, "## 7. ", "## 8. ");
  assert.match(seven, /IntegrationAuthorizationRecord` требуется всегда/u);
  assert.ok(!/Пропустить эту остановку может только/u.test(seven), "01 section 7 still makes the record an optional skip");
  // Staging is created at the verified planning_head, which descends from the
  // recorded target base; the base stays the CAS expected old, and the final
  // tree carries the planning artifacts (#9's criterion is not ours to change).
  const staging = read("docs/contracts/epic-staging.md");
  assert.ok(!/delivery profile's model/u.test(staging), "epic-staging still defers the staging base to a profile field that does not exist");
  const one = section(staging, "## 1.", "## 2.");
  assert.match(one, /first created at the verified `planning_head`, which descends from `planning\.base_oid`/u);
  assert.match(one, /expected old value of the one target CAS is `recorded_target_base`/u);
  assert.match(staging, /\| Planning artifacts and approved code are in the final staging tree \| §9 \|/u);
  assert.match(seven, /созданному на verified `planning_head`, который происходит от `planning\.base_oid`[^\n]*или, после пересборки, на новой `recorded_target_base` с одним planning replay commit под receipt/u);
  const planning = read("docs/contracts/epic-planning-ref.md");
  const issue9 = planning.split("\n").find((line) => line.startsWith("- **Issue #9:**")) ?? "";
  assert.match(issue9, /starts from the verified planning head/u);
  assert.match(issue9, /`recorded_target_base`/u);
  assert.match(issue9, /never change during an Epic/u);
  // The daemon's integrateApproved is the only writer of the target ref.
  for (const relative of ["02-architecture.md", "03-technical-plan.md", "docs/contracts/epic-staging.md", "src/host/staging-driver.mjs"]) {
    assert.match(read(relative), /integrateApproved[^\n]*(?:единственн|only writer)/u, `${relative} does not say integrateApproved is the only writer`);
  }
});

test("delivery completes on the accepted tree above the base, and a direct move on the move's own commit", () => {
  // a1 high, R6-5. A squash or rebase merge never puts the exact staging
  // commit on the target, so delivery completion reads the tree and the base.
  const graph = shipped();
  const [done] = edgeReads(graph, "deliver_staging", "cleanup");
  assert.ok(!/exact accepted staging commit/u.test(done.says), "deliver_staging -> cleanup still requires the exact staging commit");
  assert.match(done.says, /tree/u);
  assert.match(done.says, /recorded target base/u);
  assert.ok(done.reads.has("recorded_target_base"), "deliver_staging -> cleanup does not read recorded_target_base");
  const [readBack] = edgeReads(graph, "verify_target", "cleanup");
  assert.match(readBack.says, /squash/u);
  const [cas] = edgeReads(graph, "integrate_staging", "verify_target");
  assert.match(cas.says, /squash/u);
});

/** The text of a section, from its heading to the next one named. */
const sectionOf = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));

// --- debt 10b review: the re-stage keeps the lineage, the PR path re-stages too ---

test("a re-stage replays the planning change as one receipted commit, and the planning ref never moves", () => {
  // Narrow re-review of e2a5225: republishing the planning ref contradicted
  // epic-planning-ref §3/§4/§8/§9/§10. The planning ref stays untouched; the
  // staging record's own recorded_target_base moves, and the rebuilt staging
  // starts with exactly one planning replay commit bound by a receipt.
  const graph = shipped();
  // Two since debt 11e: target_moved's resume went with the reason (ADR-099).
  const resumes = [
    ...edgeReads(graph, "integrate_staging", "apply_staging", "foreign_target_movement"),
    ...edgeReads(graph, "deliver_staging", "apply_staging", "completion_predicate_unmet"),
  ];
  assert.equal(resumes.length, 2);
  for (const resume of resumes) {
    assert.match(resume.says, /recorded_target_base := новый target/u, resume.edge.id);
    assert.match(resume.says, /один planning replay commit под receipt/u, resume.edge.id);
    assert.match(resume.says, /cleanupStaging/u, resume.edge.id);
    assert.match(resume.says, /createStaging на новой base/u, resume.edge.id);
    assert.match(resume.says, /каждая approved delta/u, resume.edge.id);
  }
  assert.match(graph.recovery.find((row) => row.reason === "foreign_target_movement").required_state, /planning replay commit/u);
  // No republication anywhere: the planning ref's base and head never change.
  const everywhere = [
    read("docs/contracts/epic-planning-ref.md"), read("docs/contracts/epic-staging.md"), read("01-core-flows.md"),
    read("03-technical-plan.md"), read(DOCUMENT_PATH),
  ].join("\n");
  assert.ok(!/target_rebase|rebase_history|переопубликов/u.test(everywhere), "a planning-ref republication is still described");
  assert.ok(!/### 10\.1/u.test(read("docs/contracts/epic-planning-ref.md")));
  const staging = read("docs/contracts/epic-staging.md");
  const one = sectionOf(staging, "## 1.", "## 2.");
  assert.match(one, /`cleanupStaging`[^\n]*expected[^\n]*`createStaging`/u);
  assert.match(one, /exactly one planning replay commit/u);
  assert.match(one, /`planning\.base_oid` and `planning_head` never change during an Epic/u);
  // The lineage rule names both starts.
  const [onward] = edgeReads(graph, "apply_staging", "aggregate_verify");
  assert.match(onward.says, /ровно один planning replay commit с receipt/u);
});

test("no 03 or graph text rebuilds staging on planning_head without the replay alternative", () => {
  // Round-3 re-review M1: after a re-stage the line starts at the new
  // recorded_target_base with one receipted planning replay commit, so a
  // sentence that rebuilds "на planning_head" alone describes the first stage only.
  const graph = shipped();
  const texts = [
    ...read("03-technical-plan.md").split("\n").map((line, index) => [`03:${index + 1}`, line]),
    ...graph.predicates.map((entry) => [entry.id, entry.description]),
    ...graph.recovery.map((row) => [`recovery ${row.reason}`, row.required_state]),
    ...graph.views.flatMap((view) => view.rows.map((row, index) => [`${view.id} ${index + 1}`, row.cells.join(" | ")])),
  ];
  const bare = texts.filter(([, text]) => /(?:на|through|через) (?:verified )?`?planning_head/u.test(text) && !/planning replay commit/u.test(text))
    .map(([where]) => where);
  assert.deepEqual(bare, []);
  for (const reason of ["receipt_missing", "staging_moved_after_pass"]) {
    assert.match(graph.recovery.find((row) => row.reason === reason).required_state, /recorded_target_base/u, reason);
  }
});

test("a planning change that conflicts with the new base parks delta_stale, and apply_staging stays refused", () => {
  // MEDIUM 2. No new park reason: delta_stale names the case, and its
  // remediation is re-planning, since no resume target of the row leads there.
  const graph = shipped();
  const row = graph.recovery.find((entry) => entry.reason === "delta_stale");
  assert.match(row.required_state, /planning change/u);
  const plan = read("03-technical-plan.md");
  assert.ok(plan.split("\n").some((line) => line.startsWith("| delta_stale |") && /новый план Epic/u.test(line)),
    "the 03 §7 park table row for delta_stale does not name the exits");
  const [stale] = edgeReads(graph, "apply_staging", "human", "delta_stale");
  // In v1 the only exits are cancel or a new Epic plan, said plainly.
  for (const text of [row.required_state, stale.says]) {
    assert.match(text, /cancel/u);
    assert.match(text, /(?:new Epic plan|новый план Epic)/u);
  }
  const decisions = read("04-decisions.md");
  const risk = decisions.slice(decisions.indexOf("## Оставшиеся риски")).split("\n").find((line) => /^\d+\. \(ADR-088\)/u.test(line));
  assert.match(risk, /новый план Epic/u);
});

test("a delivery whose tree differs because the target moved re-stages, a person deciding", () => {
  // MEDIUM 3a. The PR path had no re-stage: R6-4 held there as before.
  const graph = shipped();
  const row = graph.recovery.find((entry) => entry.reason === "completion_predicate_unmet");
  assert.deepEqual([...row.resume_targets].sort(), ["apply_staging", "deliver_staging", "human"]);
  const [back] = edgeReads(graph, "deliver_staging", "apply_staging", "completion_predicate_unmet");
  assert.ok(back, "deliver_staging declares a resume edge into apply_staging");
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  assert.ok(back.edge.guards.every((id) => guards.get(id).authority.actor === "human"));
  for (const token of ["recorded_target_base", "resume_intent", "delivery_receipt", "target"]) {
    assert.ok(back.reads.has(token), `the delivery re-stage does not read ${token}`);
  }
  assert.match(back.says, /void/u);
  // Only an unmerged delivery re-stages; the old receipt is void and the old
  // PR or queue entry is withdrawn before a new one is opened.
  assert.match(back.says, /не смержен/u);
  assert.match(back.says, /закрыт/u);
  const plan = read("03-technical-plan.md");
  const rows = plan.split("\n");
  assert.ok(rows.some((line) => line.startsWith("| deliver_staging | resume --to apply_staging под park.reason=completion_predicate_unmet") && /не смержен/u.test(line)));
  // A merged delivery holding another tree is a stop with no re-stage and no rewrite.
  assert.ok(rows.some((line) => line.startsWith("| deliver_staging |") && /смержен/u.test(line) && /history не переписывается|история не переписывается/u.test(line)));
  assert.match(row.required_state, /merged/u);
});

test("the busy-target risk is named in the risk list and ADR-088 points at it", () => {
  // MEDIUM 3b.
  const decisions = read("04-decisions.md");
  const risks = decisions.slice(decisions.indexOf("## Оставшиеся риски"));
  const entry = risks.split("\n").find((line) => /^\d+\. \(ADR-088\)/u.test(line));
  assert.ok(entry, "no (ADR-088) risk entry");
  assert.match(entry, /post-v1/u);
  const number = entry.match(/^(\d+)\./u)[1];
  const adr = decisions.slice(decisions.indexOf("## ADR-088"), decisions.indexOf("## Оставшиеся риски"));
  assert.match(adr, new RegExp(`риск ${number}\\b`, "u"));
});

test("in squash mode the accepted identity names the squash commit, and the record's to_oid is it", () => {
  // MEDIUM 4.
  const authorization = read("docs/contracts/integration-authorization.md");
  assert.match(sectionOf(authorization, "## 3.", "## 4."), /`to_oid` equals the squash commit OID the acceptance names/u);
  const flows = read("01-core-flows.md");
  assert.match(sectionOf(flows, "## 7. ", "## 8. "), /squash commit OID и digest его recipe/u);
  const staging = read("docs/contracts/epic-staging.md");
  assert.match(sectionOf(staging, "## 5.", "## 6."), /target_commit_recipe_sha256/u);
  const [move] = edgeReads(shipped(), "accept_staging", "integrate_staging");
  assert.match(move.says, /squash commit OID и digest его recipe/u);
  assert.ok(move.reads.has("delivery_plan"));
});

test("acceptance_missing says how the person's acceptance produces the record, everywhere it is resumed", () => {
  // LOW 5, and debt 11b (R7-2): "produces" with no mechanism behind it became
  // the mechanism — the person signs the payload of the record composed before
  // the question.
  const graph = shipped();
  const produces = /payload IntegrationAuthorizationRecord, составленного до вопроса/u;
  for (const view of graph.views) {
    const row = view.rows.find((entry) => entry.covers.includes("acceptance_missing"));
    assert.match(row.cells[2], produces, view.id);
  }
});

// --- the park reasons the order needs are the graph's own -------------------

/** A contract's closed refusal set, read the way the vocabulary validator reads it. */
function closedSet(relative) {
  const text = read(relative);
  const inline = /Closed set[^:]*:\s*(.+?)(?:\n\n|\.\s*\n)/su.exec(text);
  return [...(inline?.[1] ?? "").matchAll(/`([a-z][a-z0-9_]{4,})`/gu)].map((match) => match[1]);
}

test("epic-staging's park reasons and the profile's completion predicate are park reasons of the graph", () => {
  const graph = shipped();
  const produced = producedAt(graph);
  const rows = new Set(graph.recovery.map((row) => row.reason));
  const owned = new Map(vocabulary().park_reasons.map((entry) => [entry.code, entry]));
  const missing = [];
  const staging = closedSet("docs/contracts/epic-staging.md");
  // Ten since debt 11e: target_moved left with the per-Ticket movements that produced it (ADR-099).
  assert.equal(staging.length, 10, "epic-staging closes ten classes");
  const expected = [
    ...staging.filter((code) => code !== "aggregate_failed").map((code) => [code, "docs/contracts/epic-staging.md"]),
    ["completion_predicate_unmet", "docs/contracts/delivery-profile.md"],
    ["unsupported_integration_mode", "docs/contracts/delivery-profile.md"],
    ["delta_stale", "docs/contracts/approved-delta.md"],
  ];
  for (const [code, owner] of expected) {
    if (!produced.has(code)) missing.push(`${code}: the graph parks it nowhere`);
    if (!rows.has(code)) missing.push(`${code}: no recovery row`);
    if (owned.get(code)?.closed_by !== owner) missing.push(`${code}: the vocabulary does not record ${owner} as its owner`);
  }
  // aggregate_failed is the one class with no park reason of its own: the graph
  // already stops a failed aggregate as aggregate_verify_failed, and the
  // contract says so rather than leaving two names for one stop.
  if (!produced.get("aggregate_verify_failed")?.has("aggregate_verify")) {
    missing.push("aggregate_failed: aggregate_verify does not park aggregate_verify_failed");
  }
  if (!/`aggregate_failed`[^\n]*`aggregate_verify_failed`/u.test(read("docs/contracts/epic-staging.md").split("## 8.")[1] ?? "")) {
    missing.push("aggregate_failed: epic-staging §8 does not say which graph reason carries it");
  }
  assert.deepEqual(missing, []);
});

// --- one target CAS, not a completed prefix ------------------------------------

const PREFIX_WORDING = /completed[- ]prefix|remaining (?:ref )?transitions|ordered ref transitions|receipt\/prefix/iu;

test("neither the graph nor core flows §7 speaks of a completed prefix or remaining transitions", () => {
  const graph = shipped();
  const said = [
    ...graph.predicates.map((entry) => [`predicate ${entry.id}`, entry.description]),
    ...graph.recovery.map((row) => [`recovery ${row.reason}`, row.required_state]),
    ...graph.views.flatMap((view) => view.rows.map((row, index) => [`${view.id} row ${index + 1}`, row.cells.join(" | ")])),
  ].filter(([, text]) => PREFIX_WORDING.test(text)).map(([where]) => where);
  const flows = read("01-core-flows.md");
  const section = flows.slice(flows.indexOf("## 7. "), flows.indexOf("## 8. "));
  if (PREFIX_WORDING.test(section)) said.push("01-core-flows.md §7");
  assert.deepEqual(said, []);
  assert.ok(section.includes("один ref transition"), "core flows §7 names the one ref transition the record authorizes");
});

// --- the host already does this; the graph now asks it to --------------------

const execFileAsync = promisify(execFile);

const gitIn = (root) => async (args, { cwd } = {}) =>
  execFileAsync("git", args, {
    cwd: cwd ?? root,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GIT_AUTHOR_NAME: "autosk test",
      GIT_AUTHOR_EMAIL: "test@autosk.invalid",
      GIT_COMMITTER_NAME: "autosk test",
      GIT_COMMITTER_EMAIL: "test@autosk.invalid",
    },
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error) => ({ code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) }),
  );

const runner = async (command, args, { cwd, env }) =>
  execFileAsync(command, args, { cwd, env: { PATH: process.env.PATH, ...env } }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error) => ({
      code: error.code === "ENOENT" ? null : (typeof error.code === "number" ? error.code : 1),
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error),
    }),
  );

test("two individually green Tickets that regress together leave the target where it was", async (t) => {
  // Characterization of the host the graph now routes through: each Ticket
  // alone passes the check, the two together fail it, and the aggregate on the
  // private staging refuses the CAS — so the user's branch never holds the
  // combination. Under the old order the first Ticket was already on it.
  const root = await mkdtemp(path.join(tmpdir(), "autosk-epic-order-"));
  t.after(async () => {
    await execFileAsync("chmod", ["-R", "u+w", root]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const git = gitIn(root);
  await git(["init", "--quiet", "--initial-branch=main"]);
  const check = "#!/bin/sh\nif [ \"$(cat a.txt)\" = new ] && [ \"$(cat b.txt)\" = new ]; then exit 1; fi\nexit 0\n";
  await writeFile(path.join(root, "check.sh"), check, { mode: 0o755 });
  await writeFile(path.join(root, "a.txt"), "old\n");
  await writeFile(path.join(root, "b.txt"), "old\n");
  await git(["add", "check.sh", "a.txt", "b.txt"]);
  await git(["commit", "--quiet", "-m", "base"]);
  const base = (await git(["rev-parse", "HEAD"])).stdout.trim();

  const commit = async (parent, changes, message) => {
    await git(["read-tree", parent]);
    for (const [file, content] of changes) {
      await writeFile(path.join(root, ".blob"), `${content}\n`);
      const blob = (await git(["hash-object", "-w", ".blob"])).stdout.trim();
      await git(["update-index", "--cacheinfo", `100644,${blob},${file}`]);
    }
    const tree = (await git(["write-tree"])).stdout.trim();
    const oid = (await git(["commit-tree", tree, "-p", parent, "-m", message])).stdout.trim();
    await git(["read-tree", base]);
    return { oid, tree };
  };
  // The project identity is the staging state's sha256:<64 hex>, which the
  // driver now checks before it runs (review of 11e, L1), and the instruction
  // lock is the caller's input rather than a prior record's (H1).
  const identity = (commitOid, tree, tickets) => ({
    project_identity: `sha256:${"0".repeat(64)}`,
    epic_id: "epic-order",
    staging_commit_oid: commitOid,
    staging_tree_oid: tree,
    receipts: tickets.map((ticket_id) => ({ ticket_id })),
  });
  const checks = [{ id: "unit", command: "./check.sh" }];
  const instructionLockDigest = "d".repeat(64);

  // Each Ticket is green on its own.
  const first = await commit(base, [["a.txt", "new"]], "T-1");
  const second = await commit(base, [["b.txt", "new"]], "T-2");
  for (const [ticket, alone] of [["T-1", first], ["T-2", second]]) {
    const { aggregate: verdict } = await verifyAggregate({ realpath,
      git, run: runner, state: identity(alone.oid, alone.tree, [ticket]), checks, dir: path.join(root, `alone-${ticket}`), instructionLockDigest,
    });
    assert.equal(verdict.outcome, "pass", `${ticket} is green alone`);
  }

  // Both applied to the private staging: the aggregate fails.
  const key = epicRefKey("0".repeat(64), "epic-order");
  // The helper writes the staging ref (ADR-095); the test hands its stand-in.
  const custody = gitRefCustody(root);
  await createStaging(custody, { generation: 0, epicRefKey: key, base });
  const together = await commit(first.oid, [["b.txt", "new"]], "T-2 on staging");
  const advanced = await custody.advance_staging({
    action: "advance_staging",
    ...identityFor("advance_staging"),
    ref_updates: [{ operation: "update", ref: stagingRef(key), expected_old_oid: base, new_oid: together.oid }],
  });
  assert.equal(advanced.status, "committed");
  const state = identity(together.oid, together.tree, ["T-1", "T-2"]);
  const { aggregate } = await verifyAggregate({ realpath, git, run: runner, state, checks, dir: path.join(root, "aggregate"), instructionLockDigest });
  assert.equal(aggregate.outcome, "fail");
  assert.equal(aggregate.environment_outcome, "ok", "a regression is a product failure, not a machine that could not run");
  assert.ok(aggregateErrors({ ...state, aggregate }).some((error) => error.reason === "aggregate_failed"));

  // The CAS is refused, and the target is untouched.
  const staged = { ...state, recorded_target_base: base, aggregate, post_cas: { expected_new_oid: together.oid } };
  const observed = await observeTarget(git, { ref: "refs/heads/main" });
  const admission = casAdmission(staged, observed, ["T-1", "T-2"]);
  assert.equal(admission.decision, "refused");
  assert.ok(admission.reasons.some((entry) => entry.reason === "aggregate_failed"));
  assert.equal(await readRef(git, "refs/heads/main"), base);

  // And the graph stops the same failure where the host does: the aggregate's
  // NOT_PASS edges never lead into acceptance or a target movement.
  const graph = shipped();
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  const failing = graph.transitions.filter((edge) =>
    edge.from === "aggregate_verify" && edge.guards.some((id) => guards.get(id)?.park_reason === "aggregate_verify_failed"));
  assert.ok(failing.length > 0, "aggregate_verify parks a failed aggregate");
  for (const edge of failing) assert.ok(!["accept_staging", ...AFTER_ACCEPTANCE].includes(edge.to), `${edge.id} -> ${edge.to}`);
});

test("the aggregate_verify_failed row says where it parks, as its parks_at does (R6-26)", () => {
  const graph = shipped();
  const row = graph.recovery.find((entry) => entry.reason === "aggregate_verify_failed");
  assert.deepEqual(row.parks_at, ["aggregate_verify"]);
  assert.match(row.required_state, /^Section 2 parks with this reason at aggregate_verify:/u);
  assert.doesNotMatch(row.required_state, /parks with this reason at record_aggregate_remediation/u);
  // record_aggregate_remediation is where the row is handled: entered by a
  // resume from human, not by an edge.
  assert.deepEqual(row.handled_at, ["record_aggregate_remediation"]);
  assert.match(row.required_state, /record_aggregate_remediation/u);
  // And epic-staging §8 names every step the graph parks staging_moved_after_pass at.
  const moved = graph.recovery.find((entry) => entry.reason === "staging_moved_after_pass");
  const section = sectionOf(read("docs/contracts/epic-staging.md"), "## 8. Park reasons", "## 9.");
  for (const step of moved.parks_at.filter((name) => name !== "human")) {
    assert.match(section, new RegExp(`\`${step}\`[^.;]*\`staging_moved_after_pass\`|\`staging_moved_after_pass\`[^.;]*\`${step}\``, "u"), step);
  }
});

test("01 gives a round past the review cap to the user alone, one per recorded cap decision, and never a new limit (R7-4)", () => {
  // a1 medium: the cap's limit is the document's, its count is the durable
  // takings, and nothing a person decides resets or widens either (capHolds in
  // src/host/workflow-factory.mjs). Round 7 of #39, R7-4: "nobody" was the
  // wrong answer to "who may exceed ten rounds" — 01 §8, 03 §7 and the graph's
  // view resume review_cap into a new round on a new daemon-attributed cap
  // decision, which is exactly an exceeding round. The user decides it, one
  // round per decision, and the count and the limit stay (ADR-099).
  const flows = read("01-core-flows.md");
  const row = flows.split("\n").find((line) => line.startsWith("| Превысить 10 раундов |"));
  assert.ok(row, "01 names who may exceed ten rounds");
  const [, , who, how] = row.split("|").map((cell) => cell.trim());
  assert.doesNotMatch(who, /никто/u);
  assert.match(who, /только пользователь/u);
  assert.match(who, /один раунд на каждое записанное cap decision/u);
  assert.doesNotMatch(how, /новый конечный предел/u);
  assert.match(how, /capHolds/u);
  assert.match(how, /не сбрасывает счёт и не поднимает `limit`/u);
  assert.match(how, /`park\.decision`/u);
  assert.match(how, /следующий NOT_PASS на этом шаге снова паркует `review_cap`/u);
  // Review of 11e, M1: only a resume that runs another round owes the
  // decision; the exits that run none are named, and owe none.
  assert.match(how, /`decision_targets`/u);
  assert.match(how, /выход без нового раунда[^|]*`invalidate_quick_classification`[^|]*решения не требует/u);
  // The factory contract says the factory holds the resume to the decision,
  // and no longer that the cap is absolute for want of a decision format.
  const factory = read("docs/contracts/workflow-factory.md");
  assert.doesNotMatch(factory, /until one exists the cap is absolute/u);
  assert.match(factory, /`park\.decision`/u);
  assert.match(factory, /`decision_targets`/u);
  assert.doesNotMatch(factory, /cap_decision/u);
  // ADR-099 supersedes ADR-089's "nobody", and the graph's row names what its resume owes.
  const decisions = read("04-decisions.md");
  assert.match(decisions, /^## ADR-099:/mu);
  assert.match(sectionOf(decisions, "## ADR-089:", "## ADR-090:"), /Изменено ADR-099/u);
  const capRow = shipped().recovery.find((entry) => entry.reason === "review_cap");
  assert.match(capRow.required_state, /new daemon-attributed cap decision recorded under this park \(park\.decision\)/u);
  assert.match(capRow.required_state, /human and invalidate_quick_classification run no round and owe none/u);
});

// --- debt 11a: one custody model for refs/autosk/** --------------------------

/** The one sentence every document that names a writer of refs/autosk/** carries (ADR-095). */
const CUSTODY_EN = "The ref-custody helper writes every ref under `refs/autosk/**`, the staging ref included; the host only asks it, and the daemon's `integrateApproved` alone moves the target ref.";
const CUSTODY_RU = "ref-custody helper пишет каждый ref под `refs/autosk/**`, включая staging ref; host только просит его, а target ref двигает только daemon `integrateApproved`.";

test("the prose says one custody model: the helper writes refs/autosk/**, the host asks, integrateApproved moves the target (R7-1)", () => {
  // Round 7 of #39, R7-1: 02 §2 made the separate-account helper the sole
  // writer of refs/autosk/** while ADR-088, 02 §2/§7 and epic-staging §1 gave
  // the staging ref to the host's applyDelta/swapTarget.
  for (const relative of ["docs/contracts/epic-staging.md", "docs/contracts/epic-planning-ref.md", "src/host/ref-custody.mjs"]) {
    assert.ok(read(relative).includes(CUSTODY_EN), `${relative} does not carry the custody sentence`);
  }
  for (const relative of ["01-core-flows.md", "02-architecture.md", "03-technical-plan.md", "04-decisions.md"]) {
    assert.ok(read(relative).includes(CUSTODY_RU), `${relative} does not carry the custody sentence`);
  }
  assert.ok(sectionOf(read("02-architecture.md"), "### Git", "### Planning publication adapter").includes(CUSTODY_RU), "02 §2 Git");
  assert.ok(sectionOf(read("01-core-flows.md"), "## 7. ", "## 8. ").includes(CUSTODY_RU), "01 §7");
  assert.ok(sectionOf(read("docs/contracts/epic-staging.md"), "## 1.", "## 2.").includes(CUSTODY_EN), "epic-staging §1");
  // No document still has the host write a ref under refs/autosk/**.
  const stale = [
    /in the host it has one caller/u,
    /moves only the private staging ref/u,
    /в host её единственный вызывающий/u,
    /в host она двигает только приватный staging ref/u,
    /host двигает только приватный staging ref/u,
    /The host moves the staging ref and nothing else/u,
  ];
  for (const relative of [
    "01-core-flows.md", "02-architecture.md", "03-technical-plan.md", "README.md",
    "docs/contracts/epic-staging.md", "docs/contracts/epic-planning-ref.md", "docs/contracts/integration-authorization.md",
    "src/host/staging-driver.mjs", "src/host/delta-driver.mjs", "src/host/planning-driver.mjs",
  ]) {
    for (const pattern of stale) assert.doesNotMatch(read(relative), pattern, `${relative}: ${pattern}`);
  }
  // ADR-088 keeps its text and points forward to the ADR that amends it.
  const adr088 = sectionOf(read("04-decisions.md"), "## ADR-088:", "## ADR-089:");
  assert.match(adr088, /ADR-095/u);
  const adr095 = sectionOf(read("04-decisions.md"), "## ADR-095:", "## Оставшиеся риски");
  assert.match(adr095, /изменяет ADR-088/u);
  // The planning driver, which says it implements epic-planning-ref.md, asks too.
  assert.doesNotMatch(read("src/host/planning-driver.mjs"), /['"]update-ref['"]/u);
});

test("a missing ref-custody capability parks at apply_staging and resumes there (review M2)", () => {
  // The staging drivers raise planning_ref_capability_missing; the graph must
  // route it where they run, as it does at every other helper-calling step.
  const graph = shipped();
  const row = graph.recovery.find((entry) => entry.reason === "planning_ref_capability_missing");
  assert.ok(row.parks_at.includes("apply_staging"));
  assert.ok(row.resume_targets.includes("apply_staging"));
  assert.ok(row.parks_at.includes("cleanup"), "the staging cleanup step already parks it");
  assert.equal(row.resume_scope, "origin");
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  const edges = graph.transitions.filter((edge) => edge.from === "apply_staging" && edge.to === "human"
    && edge.guards.some((id) => guards.get(id)?.park_reason === "planning_ref_capability_missing"));
  assert.equal(edges.length, 1);
  // Before any delta is tried, after the anchor check.
  const order = graph.transitions.filter((edge) => edge.from === "apply_staging").sort((a, b) => a.priority - b.priority)
    .map((edge) => guards.get(edge.guards[0]).park_reason);
  assert.deepEqual(order.slice(0, 3), ["blocked_anchor", "planning_ref_capability_missing", "delta_stale"]);
  assert.match(read("03-technical-plan.md"), /\| apply_staging \| helper response status=not_applied[^\n]*planning_ref_capability_missing/u);
  const vocabulary = JSON.parse(read("resources/refusal-vocabulary/refusal-vocabulary.v1.json"));
  assert.ok(vocabulary.park_reasons.find((entry) => entry.code === "planning_ref_capability_missing").named_at.includes("apply_staging"));
  // integrate_staging runs no helper action: the re-stage's delete and create
  // run after the resume into apply_staging.
  assert.ok(!row.parks_at.includes("integrate_staging"));
});

test("ADR-095 and README say which park answers a missing custody, and when (review M3)", () => {
  const adr = sectionOf(read("04-decisions.md"), "## ADR-095:", "## Оставшиеся риски");
  assert.match(adr, /нового кода словаря park-причин нет/u);
  assert.match(adr, /единственное новое ребро графа — `apply_staging`/u);
  assert.match(adr, /одна новая park-причина платформы — `ref_custody_unavailable`/u);
  assert.match(adr, /`ref_custody_unavailable`[^\n]*при открытии проекта[^\n]*`planning_ref_capability_missing`[^\n]*внутри шага/u);
  const readme = read("README.md");
  const rule = readme.split("\n").find((line) => line.startsWith("19. ")) ?? "";
  assert.match(rule, /обязательство #13/u);
  assert.doesNotMatch(rule, /паркуется при открытии, до первого побочного эффекта\./u);
});

// --- debt 11e: the state machine does what the documents say (R7-5, R7-16) ---

test("nothing parks target_moved: under the one CAS every movement of the target off its recorded base is foreign (R7-16)", () => {
  // Round 7 of #39, R7-16: the one-CAS model (ADR-088) moves the target once,
  // by this Epic's own CAS, whose result reads already_complete first. What
  // the staging driver called attributable was a movement to a commit this
  // Epic wrote or to one below its base: a rewind, or someone else moving the
  // target into the Epic's own unlanded line — none of them this Epic's.
  const graph = shipped();
  assert.ok(!JSON.stringify(graph).includes("target_moved"), "the graph still names target_moved");
  const declared = new Set([
    ...graph.transitions.map((edge) => edge.id),
    ...graph.guards.map((guard) => guard.id),
    ...graph.predicates.map((entry) => entry.id),
  ]);
  for (const id of ["t_566", "t_569", "guard_570", "guard_573", "cond_445", "cond_448"]) {
    assert.ok(!declared.has(id), `${id} is still declared`);
  }
  // At the CAS a target off its base parks one way, and resumes one way: a
  // person's recorded decision to re-stage onto the moved target.
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  const predicates = new Map(graph.predicates.map((entry) => [entry.id, entry]));
  const off = graph.transitions.filter((edge) => edge.from === "integrate_staging"
    && edge.guards.some((id) => predicates.get(guards.get(id).predicate).description.startsWith("target ref не на recorded target base")));
  assert.deepEqual(off.map((edge) => [edge.to, guards.get(edge.guards[0]).park_reason]), [["human", "foreign_target_movement"]]);
  const back = graph.transitions.filter((edge) => edge.from === "integrate_staging" && edge.to === "apply_staging");
  assert.deepEqual(back.map((edge) => guards.get(edge.guards[0]).park_reason), ["foreign_target_movement"]);
  assert.equal(guards.get(back[0].guards[0]).authority.actor, "human");
  for (const relative of [
    "01-core-flows.md",
    "03-technical-plan.md",
    "docs/contracts/epic-staging.md",
    "resources/refusal-vocabulary/refusal-vocabulary.v1.json",
    "resources/human-decision/human-decision-request.schema.json",
    "scripts/validate-epic-staging.mjs",
    "src/host/epic-staging.mjs",
    "src/host/staging-driver.mjs",
  ]) {
    assert.ok(!read(relative).includes("target_moved"), `${relative} still names target_moved`);
  }
  assert.ok(!/attributed_to_this_epic|attributable\(/u.test(read("src/host/staging-driver.mjs") + read("src/host/epic-staging.mjs")),
    "the host still attributes a target movement to the Epic");
  assert.ok(!/движение атрибутируемо этому Epic|движение этому Epic не атрибутируемо/u.test(read("03-technical-plan.md")));
  const risks = sectionOf(read("04-decisions.md"), "## Оставшиеся риски", "\n## ");
  assert.ok(!risks.includes("target_moved"), "a remaining risk still names target_moved");
});

test("Epics on one target are serialized by the one CAS, and the documents say what it does (R7-5)", () => {
  // Round 7 of #39, R7-5: epic-staging §1 said the second of two re-stages
  // waits until the first lands and that no two open lines share a base,
  // with no step, blocker or park reason for the wait; crossEpicErrors, the
  // only detector, had no caller, and it flagged two Epics planned from one
  // target head — whose first stages necessarily share recorded_target_base.
  const one = sectionOf(read("docs/contracts/epic-staging.md"), "## 1.", "## 2.");
  assert.doesNotMatch(one, /waits until the first lands/u);
  assert.doesNotMatch(one, /no two open lines share/u);
  assert.match(one, /serialized by the one CAS and by nothing else/u);
  assert.match(one, /may be staged, verified and accepted at once/u);
  assert.match(one, /parks `foreign_target_movement`/u);
  for (const relative of ["docs/contracts/epic-staging.md", "03-technical-plan.md", "src/host/staging-lineage.mjs"]) {
    assert.ok(!read(relative).includes("crossEpicErrors"), `${relative} still names crossEpicErrors`);
  }
  assert.doesNotMatch(read("03-technical-plan.md"), /второй ждёт, пока первый приземлится/u);
  const risks = sectionOf(read("04-decisions.md"), "## Оставшиеся риски", "\n## ");
  assert.ok(!risks.includes("crossEpicErrors"), "a remaining risk still names crossEpicErrors");
  assert.doesNotMatch(risks, /ждёт приземления первого/u);

  // What the one CAS does with two Epics planned from one head: both first
  // stages record that head, the first CAS lands, and the second finds the
  // target at the first Epic's result — a movement it did not make.
  const head = "a".repeat(40);
  const landed = "b".repeat(40);
  const mine = { recorded_target_base: head, receipts: [], post_cas: { expected_new_oid: "c".repeat(40) } };
  const admission = casAdmission(mine, { oid: landed }, [], {});
  assert.equal(admission.decision, "refused");
  assert.deepEqual(admission.reasons.filter((entry) => entry.reason.includes("target")).map((entry) => entry.reason), ["foreign_target_movement"]);
  const row = shipped().recovery.find((entry) => entry.reason === "foreign_target_movement");
  assert.deepEqual([...row.resume_targets].sort(), ["apply_staging", "human"]);
  assert.match(row.required_state, /another Epic's landing/u);
});

test("the prose says what the one CAS does in a race and after a crash, and names what it leaves open (review L5, L6)", () => {
  // Review of 11e, L5: in a true race the Epic that loses parks cas_conflict
  // (git refuses its expected-old CAS at write time), not
  // foreign_target_movement; and a target that holds the Epic's landed
  // result under commits pushed on top before a crash-retry is a movement
  // off the base that was partly the Epic's own — the pending CAS receipt
  // resolves that from the reflog, and the case is left open for #9.
  const staging = read("docs/contracts/epic-staging.md");
  const one = sectionOf(staging, "## 1.", "## 2.");
  assert.match(one, /`cas_conflict`/u);
  assert.doesNotMatch(one, /no movement of the target off the recorded base is ever that Epic's own/u);
  assert.match(one, /pending CAS receipt/u);
  assert.match(sectionOf(staging, "## 9.", "## 10."), /`cas_conflict`/u);
  assert.match(sectionOf(read("01-core-flows.md"), "## 7. ", "## 8. "), /`cas_conflict`/u);
  assert.match(read("03-technical-plan.md"), /сериализует только один CAS[^\n]*`cas_conflict`/u);
  const adr = sectionOf(read("04-decisions.md"), "## ADR-099:", "## Оставшиеся риски");
  assert.match(adr, /pending CAS receipt[^\n]*#9/u);
  // L6: what the leaf does not bind is named as the verifier's to check.
  assert.match(adr, /`task_id`[^\n]*watermark/u);
});

// --- debt 11e narrow re-review: a rebuild under staging_moved_after_pass keeps the base (L-f), and a repeated receipt is named (nit) ---

test("a rebuild under staging_moved_after_pass keeps the recorded base: the staging ref moved, not the target (review L-f)", () => {
  // Narrow re-review of 11e, L-f: the row, cond_454, cond_456 and 03 let this
  // resume rebuild staging "by the epic-staging §1 re-stage method", which
  // re-records recorded_target_base onto a moved target — a re-stage with no
  // park.decision, the one thing the factory holds to a decision. Under this
  // reason what moved is the staging ref, so the rebuild is at the recorded
  // base, and a re-stage stays the two rows that declare it.
  const graph = shipped();
  const row = graph.recovery.find((entry) => entry.reason === "staging_moved_after_pass");
  assert.equal(row.decision_targets, undefined);
  assert.match(row.required_state, /rebuilds staging at the recorded base \(recorded_target_base unchanged/u);
  const lines = read("03-technical-plan.md").split("\n").filter((line) => line.includes("staging_moved_after_pass"));
  const texts = [
    ["row", row.required_state],
    ...["cond_454", "cond_456"].map((id) => [id, graph.predicates.find((entry) => entry.id === id).description]),
    ...lines.map((line) => [`03: ${line.slice(0, 60)}`, line]),
  ];
  for (const [label, text] of texts) {
    assert.doesNotMatch(text, /re-stage method|способом пересборки|пересборка способом/u, label);
  }
  for (const id of ["cond_454", "cond_456"]) {
    assert.match(graph.predicates.find((entry) => entry.id === id).description, /recorded_target_base не меняется/u, id);
  }
  const resumes = lines.filter((line) => /resume --to apply_staging|aggregate_verify or accept_staging/u.test(line));
  assert.equal(resumes.length, 3, "two 03 §2 resume rows and the 03 §7 row");
  for (const line of resumes) assert.match(line, /recorded_target_base не меняется|на той же recorded_target_base/u, line.slice(0, 60));
});

test("a Ticket with two integration receipts is receipt_missing in the graph's row and in the staging contract, as receiptErrors refuses it (review nit)", () => {
  const row = shipped().recovery.find((entry) => entry.reason === "receipt_missing");
  assert.match(row.required_state, /a Ticket has more than one/u);
  assert.match(read("docs/contracts/epic-staging.md"), /more than one integration receipt[^.]*`receipt_missing`/u);
});

// --- CodeRabbit on #270: the documents say what a decision-gated resume is admitted on ---

test("the documents say a decision-gated resume is admitted only on a verified record of this task's resume from this park, under the domain the factory binds (CodeRabbit on #270)", () => {
  // CodeRabbit on PR #270: the factory checked the leaf and nothing behind
  // it. It now verifies the record the leaf names through the caller's
  // verifier, and the documents say that, and that without a signer nothing
  // is admitted.
  const factory = read("docs/contracts/workflow-factory.md");
  assert.match(factory, /`autosk-flow\/resume-decision\/v1`/u);
  assert.match(factory, /`verifySignature`[^.]*`noSigner`/u);
  assert.doesNotMatch(factory, /checks the leaf's shape and park, not the record it names/u);
  const row = read("01-core-flows.md").split("\n").find((line) => line.startsWith("| Превысить 10 раундов |"));
  assert.match(row, /проверяет своим verifier/u);
  assert.match(read("docs/contracts/human-decision.md"), /`autosk-flow\/resume-decision\/v1`/u);
  assert.match(read("docs/contracts/workflow-graph.md"), /verified `UserDecisionRecord`/u);
  const adr = sectionOf(read("04-decisions.md"), "## ADR-099:", "## Оставшиеся риски");
  assert.match(adr, /CodeRabbit на #270/u);
});

test("the documents say a resume decision binds the project, and the admitter answers for one project (R8-15)", () => {
  // Round 8 of #39, R8-15: the resume subject bound the task, the park and the
  // target, and the admitter never compared the record's project with the
  // resuming one, so isolation between projects rested on the store's location
  // and on task ids never colliding. The subject binds the project and the
  // admitter is one project's; the documents that describe it say so.
  const factory = read("docs/contracts/workflow-factory.md");
  assert.match(factory, /`resumeDecisionAdmitter\(\{ projectRootSha256, record, verifySignature \}\)`/u);
  assert.match(factory, /`resumeDecisionSubject\(\{ project_root_sha256, task_id, reason, watermark, target \}\)`/u);
  assert.match(factory, /its `project_root_sha256` must be the resuming project's/u);
  assert.doesNotMatch(factory, /`resumeDecisionAdmitter\(\{ record, verifySignature \}\)`|`resumeDecisionSubject\(\{ task_id, reason, watermark, target \}\)`/u);
  const row = read("01-core-flows.md").split("\n").find((line) => line.startsWith("| Превысить 10 раундов |"));
  assert.match(row, /запись этого проекта и этой задачи о resume из этого park'а в эту цель/u);
  assert.match(read("docs/contracts/human-decision.md"), /this project's task's resume from this park into this target/u);
  assert.match(read("docs/contracts/workflow-graph.md"), /a verified `UserDecisionRecord` of this project's task's resume/u);
  const adr = sectionOf(read("04-decisions.md"), "## ADR-099:", "## ADR-100:");
  assert.match(adr, /Изменено ADR-103[^\n]*проект/u);
});

// --- debt 12c: the caps count what they claim (R8-4, R8-5, R8-10, R8-11) ---

/** The rendered row of `view` explaining `reason`, split into its cells, from the file the view renders into. */
const renderedRow = (graph, view, reason) => {
  const entry = graph.views.find((candidate) => candidate.id === view);
  const row = entry.rows.find((candidate) => candidate.covers.includes(reason));
  const line = read(entry.renders_into).split("\n").find((candidate) => candidate === `| ${row.cells.join(" | ")} |`);
  assert.ok(line, `${view}'s ${reason} row is rendered where it belongs`);
  return line.split(" | ").map((cell) => cell.replace(/^\| /u, "").replace(/ \|$/u, ""));
};

test("01, 03 and the factory contract say what the caps count: every NOT_PASS round of an artifact, narrow or full, one count; the code round; the repair cycle its own cap (R8-4, R8-5)", () => {
  // Round 8 of #39, R8-4: 01 §6 and §9 called the ten-round limit absolute
  // while the cap counted the narrow NOT_PASS alone; a full panel's NOT_PASS
  // (t_205) was never counted. R8-5: the repair cycle's cap had no limit and
  // no mechanism. The documents now say exactly what each cap counts.
  const flows = read("01-core-flows.md");
  const review = sectionOf(flows, "## 6. Freeze, Review и исправления", "## 7.");
  assert.doesNotMatch(review, /Лимит полного цикла/u);
  assert.match(review, /cap графа считает каждый автономный раунд/u);
  for (const pair of ["`record_code_verdict → fix`", "`narrow_review_join → fix_artifact`", "`synthesize_panel → fix_artifact`", "`verify → fix`"]) {
    assert.ok(review.includes(pair), pair);
  }
  assert.match(review, /одним счётом/u);
  assert.match(review, /`verification_cap`/u);
  assert.match(sectionOf(flows, "## 3. Четырёхмодельная панель", "## 4."), /Существенное изменение scope запускает новую полную панель; её NOT_PASS считается тем же cap/u);
  const exceed = flows.split("\n").find((line) => line.startsWith("| Превысить 10 раундов |"));
  for (const name of ["`artifact_review_round`", "`code_review_round`", "`verification_repair_round`", "`verification_cap`"]) {
    assert.ok(exceed.includes(name), name);
  }
  const plan = read("03-technical-plan.md");
  assert.ok(plan.includes("| synthesize_panel | подтверждены findings and candidate_keepalive phase=audit_retained и transition_takings >= cap | human с park.reason=review_cap |"));
  assert.ok(plan.includes("| synthesize_panel | подтверждены findings and candidate_keepalive phase=audit_retained и transition_takings < cap | fix_artifact |"));
  assert.ok(plan.includes("| verify | проверки нашли candidate defect и transition_takings < cap | сохранить verification findings, fix |"));
  assert.ok(plan.includes("| verify | проверки нашли candidate defect и transition_takings >= cap | human с park.reason=verification_cap |"));
  assert.doesNotMatch(plan, /repair cycle (?:ниже|достиг) cap/u);
  assert.doesNotMatch(plan, /Review cap читает монотонный current cycle round/u);
  assert.match(plan, /Review cap и cap цикла ремонта читают durable transition_takings/u);
  // The predicates the rows are extracted into compare the declared quantity.
  const graph = shipped();
  const predicate = (id) => graph.predicates.find((entry) => entry.id === id);
  for (const [id, comparison] of [["cond_110", "<"], ["cond_460", ">="], ["cond_308", "<"], ["cond_309", ">="]]) {
    assert.ok(predicate(id).reads.includes("transition_takings"), id);
    assert.ok(predicate(id).description.includes(`transition_takings ${comparison} cap`), id);
  }
  const factory = read("docs/contracts/workflow-factory.md");
  assert.match(factory, /Cap `artifact_review_round` counts two, `t_205` and `t_231`/u);
  assert.match(factory, /cap `verification_repair_round` counts `t_416`/u);
  assert.doesNotMatch(factory, /is parked by a predicate and not by a declared cap/u);
  assert.doesNotMatch(factory, /counts the taking of one named transition/u);
  const contract = read("docs/contracts/workflow-graph.md");
  assert.match(contract, /counts the takings of the transitions it names/u);
  assert.doesNotMatch(contract, /counted by the taking of one named transition/u);
});

test("the repair cycle's cap closes what ADR-099 left open to #32, and its owner holds it (R8-5)", () => {
  const decisions = read("04-decisions.md");
  assert.match(decisions, /^## ADR-104:/mu);
  const adr099 = sectionOf(decisions, "## ADR-099:", "## ADR-100:");
  assert.match(adr099, /^- Изменено ADR-104:[^\n]*`verification_cap`[^\n]*`verification_repair_round`/mu);
  const adr104 = sectionOf(decisions, "## ADR-104:", "## Оставшиеся риски");
  assert.match(adr104, /R8-4/u);
  assert.match(adr104, /R8-5/u);
  assert.match(adr104, /R8-10/u);
  assert.match(adr104, /R8-11/u);
  const matrix = JSON.parse(read("resources/program-capabilities/matrix.v1.json"));
  const loop = matrix.records.find((record) => record.issue_number === 32);
  assert.match(loop.implementation_obligation_before_mvp, /`verification_repair_round`/u);
  assert.match(loop.implementation_obligation_before_mvp, /ADR-104/u);
  const row = shipped().recovery.find((entry) => entry.reason === "verification_cap");
  assert.match(row.required_state, /^Section 2 parks with this reason at verify:/u);
  assert.match(row.required_state, /new daemon-attributed cap decision recorded under this park \(park\.decision\)/u);
  assert.match(row.required_state, /human and invalidate_quick_classification run no round and owe none/u);
});

test("01 §8 and 03 §7 name the review cap's resume targets apart from its park steps, and the same targets 01 §9, the factory contract and the graph do (R8-10; CodeRabbit on #276)", () => {
  // Round 8 of #39, R8-10: 01 §8's review-cap row named `fix_artifact` and
  // `fix`, then the park steps as "также", and not `rebuild_code_anchor`,
  // which 01 §9 and the graph make a round owed the user's decision. The row
  // now says where a resume goes — the targets that run a round and the ones
  // that run none — and apart from that where the park stands.
  const graph = shipped();
  const cap = graph.recovery.find((entry) => entry.reason === "review_cap");
  for (const view of ["core_flows_resume", "park_table"]) {
    const [, steps] = renderedRow(graph, view, "review_cap");
    const [resume, park] = steps.split(/;\s*park:/u);
    assert.ok(park !== undefined, `${view}: the park steps stand apart`);
    const names = (text) => new Set(text.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+|\b(?:fix|human|verify)\b/gu) ?? []);
    for (const target of [...cap.decision_targets, "human", "invalidate_quick_classification"]) {
      assert.ok(names(resume).has(target), `${view}: the resume part names ${target}`);
    }
    for (const step of cap.parks_at) {
      assert.ok(names(park).has(step), `${view}: the park part names ${step}`);
      assert.ok(!names(resume).has(step), `${view}: the resume part does not name the park step ${step}`);
    }
  }
  const exceed = read("01-core-flows.md").split("\n").find((line) => line.startsWith("| Превысить 10 раундов |"));
  const listed = /у `review_cap` — ((?:`\w+`(?:, )?)+)/u.exec(exceed);
  assert.ok(listed, "01 §9 lists the review cap's decision targets");
  assert.deepEqual([...listed[1].matchAll(/`(\w+)`/gu)].map((match) => match[1]).sort(), [...cap.decision_targets].sort());
  const repair = graph.recovery.find((entry) => entry.reason === "verification_cap");
  const repairListed = /у `verification_cap` — ((?:`\w+`(?:, )?)+)/u.exec(exceed);
  assert.ok(repairListed, "01 §9 lists the repair cap's decision targets");
  assert.deepEqual([...repairListed[1].matchAll(/`(\w+)`/gu)].map((match) => match[1]).sort(), [...repair.decision_targets].sort());
  // CodeRabbit on #276: the factory contract's section 4 still gave
  // `verification_cap` `verify` and `rebuild_code_anchor` after the review of
  // 12c (M2) made `fix` a decision target too; it names each cap's targets
  // as the graph does.
  const factory = sectionOf(read("docs/contracts/workflow-factory.md"), "## 4.", "## 5.");
  for (const row of [cap, repair]) {
    const declared = new RegExp(`\`${row.reason}\` declares ((?:\`\\w+\`(?:, | and )?)+)`, "u").exec(factory);
    assert.ok(declared, `factory §4 lists ${row.reason}'s decision targets`);
    assert.deepEqual([...declared[1].matchAll(/`(\w+)`/gu)].map((match) => match[1]).sort(), [...row.decision_targets].sort(), row.reason);
  }
});

test("01, 03, the contracts, ADR-104 and #32's obligation say the review cap bounds each artifact's review cycle, which only the verified publication of a PASS closes (review of 12c, M1)", () => {
  // Review of 12c, M1: ADR-104 made the review cap's count the task's, so
  // an Epic's four artifacts shared ten rounds, while 03 gives each artifact
  // its own cycle (§4, §5, §8). The cap now counts per artifact's cycle, and
  // every document that states the scope says the same.
  const graph = shipped();
  assert.deepEqual(graph.caps.find((cap) => cap.cycle === "artifact_review_round").cycle_boundary, { from: "publish_artifact_pass", to: "select_next" });
  const schema = JSON.parse(read("resources/workflow-graph/workflow-graph.schema.json"));
  assert.ok(JSON.stringify(schema).includes("cycle_boundary"), "the schema declares the field");
  const flows = read("01-core-flows.md");
  const review = sectionOf(flows, "## 6. Freeze, Review и исправления", "## 7.");
  assert.doesNotMatch(review, /делят все её артефакты/u);
  assert.match(review, /свой цикл review/u);
  assert.ok(review.includes("`publish_artifact_pass → select_next`"), "01 §6 names the boundary");
  const exceed = flows.split("\n").find((line) => line.startsWith("| Превысить 10 раундов |"));
  assert.doesNotMatch(exceed, /всех артефактов Epic/u);
  assert.ok(exceed.includes("`publish_artifact_pass → select_next`"), "01 §9 names the boundary");
  const plan = read("03-technical-plan.md");
  assert.doesNotMatch(plan, /одним счётом задачи Epic на все её артефакты/u);
  const invariant = plan.split("\n").find((line) => line.startsWith("- Review cap и cap цикла ремонта читают durable transition_takings"));
  assert.ok(invariant.includes("publish_artifact_pass → select_next"), "03 §6 names the boundary");
  assert.match(sectionOf(plan, "Для planning artifact current_cycle означает", "### Read-only review"), /Cap графа следует тому же/u);
  assert.match(plan, /четыре артефакта по девять NOT_PASS не паркуют/u);
  const factory = read("docs/contracts/workflow-factory.md");
  assert.doesNotMatch(factory, /so an Epic task's artifacts share it/u);
  assert.match(factory, /`cycle_boundary`/u);
  assert.match(factory, /`cap_baselines\.<cycle>\.<n>`/u);
  assert.match(read("docs/contracts/workflow-graph.md"), /`cycle_boundary`/u);
  const matrix = JSON.parse(read("resources/program-capabilities/matrix.v1.json"));
  const loop = matrix.records.find((record) => record.issue_number === 32).implementation_obligation_before_mvp;
  assert.match(loop, /each artifact's review cycle/u);
  assert.match(loop, /`publish_artifact_pass -> select_next`/u);
  const adr104 = sectionOf(read("04-decisions.md"), "## ADR-104:", "## Оставшиеся риски");
  assert.match(adr104, /\*\*Решение \(ревью, M1\)/u);
  assert.match(adr104, /Альтернатива 9 \(ревью, M1\): счёт задачи/u);
});

test("after verification_cap a recorded decision buys a repair round: fix is the row's decision target in the graph, 01 §9, 03 §7 and #32's obligation, and ADR-104 says base 03 named it (review of 12c, M2)", () => {
  // Review of 12c, M2: the documents said a decision past the repair cap
  // buys another repair round, while fix was no resume target: a decision
  // bought only a re-check of an unchanged candidate. Base 03 §7 named
  // `fix, verify` for the row, and ADR-104's fourth alternative said 03
  // never had fix.
  const graph = shipped();
  const row = graph.recovery.find((entry) => entry.reason === "verification_cap");
  assert.ok(row.resume_targets.includes("fix"));
  assert.deepEqual([...row.decision_targets].sort(), ["fix", "rebuild_code_anchor", "verify"]);
  assert.match(row.required_state, /fix, which repairs and runs verify/u);
  const [, steps] = renderedRow(graph, "park_table", "verification_cap");
  const resume = steps.split(";").filter((segment) => segment.trim().startsWith("resume")).join(";");
  for (const target of row.decision_targets) assert.match(resume, new RegExp(`(?<![a-z_])${target}(?![a-z_])`, "u"), target);
  const matrix = JSON.parse(read("resources/program-capabilities/matrix.v1.json"));
  assert.match(matrix.records.find((record) => record.issue_number === 32).implementation_obligation_before_mvp, /`fix`, `verify` or `rebuild_code_anchor`/u);
  const adr104 = sectionOf(read("04-decisions.md"), "## ADR-104:", "## Оставшиеся риски");
  assert.doesNotMatch(adr104, /ни граф, ни 01, ни 03 не делают `fix` целью resume этой строки/u);
  assert.match(adr104, /`verification_cap \| fix, verify`/u);
});

test("the documents state what the per-cycle count holds — never below the rounds since the last verified PASS publication — and where it is conservative: a resume through a status park at the boundary, and a PASS published under binding drift (narrow re-review of 12c, Low 1, Low 2)", () => {
  // Narrow re-review of 12c: the documents said a resume opens no cycle,
  // counted `human -> <target>`, while a status park keeps the step and a
  // resume counts the taking out of it (Low 1); and none named that a PASS
  // published under binding drift closes no cycle (Low 2).
  const factory = read("docs/contracts/workflow-factory.md");
  assert.doesNotMatch(factory, /a resume \(`human -> <target>`\), an anchor rebuild into `select_next` and every other move leave it where it stood/u);
  assert.match(factory, /never falls below the rounds taken since the last verified publication of a PASS/u);
  assert.match(factory, /a status move — no candidate edge — keeps the step/u);
  assert.match(factory, /A PASS published under binding drift closes no cycle/u);
  const source = read("src/host/workflow-factory.mjs");
  assert.doesNotMatch(source, /a decision, a resume \(`human -> <target>`\) or any other move opens no\s+\* cycle/u);
  const flows = sectionOf(read("01-core-flows.md"), "## 6. Freeze, Review и исправления", "## 7.");
  assert.doesNotMatch(flows, /а не решение, resume, пересборка якоря/u);
  assert.match(flows, /не меньше раундов с последней проверенной публикации PASS/u);
  const plan = read("03-technical-plan.md");
  assert.doesNotMatch(plan, /Решение, resume и возврат к более раннему kind \(anchor rebuild, aggregate remediation\) новый цикл не открывают/u);
  assert.match(sectionOf(plan, "Для planning artifact current_cycle означает", "### Read-only review"), /при дрейфе binding/u);
  assert.match(plan, /resume из status park на шаге публикации считается пересечением/u);
  const adr104 = sectionOf(read("04-decisions.md"), "## ADR-104:", "## Оставшиеся риски");
  assert.match(adr104, /\*\*Решение \(узкое ревью, Low 1–3\)/u);
  assert.match(adr104, /Альтернатива 13 \(узкое ревью, Low 1\): ключ по visits/u);
  const notDone = adr104.split("\n").find((line) => line.startsWith("- Что не сделано и названо:"));
  for (const name of ["`t_246`", "`t_260`", "`t_320`", "`planning_publication_corrupt`"]) assert.ok(notDone.includes(name), name);
  const matrix = JSON.parse(read("resources/program-capabilities/matrix.v1.json"));
  const loop = matrix.records.find((record) => record.issue_number === 32).implementation_obligation_before_mvp;
  assert.doesNotMatch(loop, /no decision, resume or anchor rebuild opens a cycle/u);
  assert.match(loop, /never falls below the rounds since the last verified PASS publication/u);
  assert.doesNotMatch(read("docs/contracts/workflow-graph.md"), /no decision, resume or anchor rebuild opens a cycle/u);
});

test("ADR-088's decision bullets that later decisions changed say so at the bullet (R8-11)", () => {
  // Round 8 of #39, R8-11: ADR-088's decision text still said `swapTarget`
  // has one caller, `applyDelta`, that a record signed in advance for a
  // pinned auto-policy passes the stop, and that re-stages obey
  // `crossEpicErrors` and wait for each other — facts ADR-095, ADR-103 and
  // ADR-099 removed. The notes at the end of the ADR pointed forward, but the
  // bullets read as current. Each now carries its note where it is read.
  const adr = sectionOf(read("04-decisions.md"), "## ADR-088:", "## ADR-089:");
  const bullet = (marker) => adr.split("\n").find((line) => line.includes(marker));
  assert.match(bullet("один вызывающий, `applyDelta`"), /\(Изменено ADR-095: [^)]*вызывающих нет/u);
  assert.match(bullet("и тогда только такой record"), /\(Изменено ADR-103: [^)]*`accept_staging`/u);
  assert.match(bullet("Пересборка подчиняется `crossEpicErrors`"), /\(Изменено ADR-099: [^)]*`crossEpicErrors`[^)]*удален/u);
});

// --- debt 12g (R8-9): a crash-safe staging apply keeps its operation identity ---------

test("the stop a moved staging ref parks under is one the graph has: the driver refuses with receipt_missing, whose row says what restores the receipt (R8-9, ADR-108)", () => {
  const graph = shipped();
  const source = read("src/host/delta-driver.mjs");
  // The driver's refusal for a staging ref that is not where the apply left it is a park reason parked at apply_staging.
  assert.match(source, /demand\(false, 'receipt_missing'/u);
  assert.doesNotMatch(source, /demand\([^)]*'foreign_ref_movement'/u);
  const row = graph.recovery.find((entry) => entry.reason === "receipt_missing");
  assert.ok(row.parks_at.includes("apply_staging"));
  assert.ok(row.resume_targets.includes("apply_staging"));
  // The row names the mechanism, the rewound case 12a left open, and the way back.
  for (const phrase of [/recipe/u, /already done/u, /no second helper request/u, /behind a commit a receipt names/u, /fresh operation/u, /staging_moved_after_pass/u, /cannot vouch/u]) {
    assert.match(row.required_state, phrase);
  }
  // The way back says only what is true: the graph rebuilds nothing, and a re-applied delta is a new operation with its own pair
  // (review M2) — not "from their recipes", which re-sends a request that already committed.
  assert.doesNotMatch(row.required_state, /from their recipes|same commits|the same planning commits/u);
  // And a name that no edge carries is no name the driver refuses a staging ref with.
  assert.equal(graph.recovery.some((entry) => entry.reason === "foreign_ref_movement"), false);
  const edge = edgeReads(graph, "apply_staging", "human", "receipt_missing");
  assert.ok(edge.length >= 1, "no edge parks receipt_missing at apply_staging");
});

test("epic-staging §7, approved-delta, 02 and the planning-ref contract say the crash between the helper's commit and the receipt, and the pair a request carries (R8-9, ADR-108)", () => {
  const staging = read("docs/contracts/epic-staging.md");
  const recovery = staging.slice(staging.indexOf("## 7. Recovery"), staging.indexOf("## 8. Park reasons"));
  assert.match(recovery, /A crash between the helper's `advance_staging` and the durable integration receipt resumes \*\*without a second helper request/u);
  for (const phrase of [/`expected_commit_oid`/u, /recipeJournal/u, /the apply is already done/u, /rewritten from the recorded bytes/u, /`behind` the base/u, /`receipt_missing` at `apply_staging`/u, /`state_identity_collision`/u]) {
    assert.match(recovery, phrase);
  }
  assert.match(staging, /`owner_operation_id` and `request_id`/u);
  assert.match(staging, /a crash before and after each staging apply: after the helper committed and before the receipt/u);
  assert.match(read("docs/contracts/approved-delta.md"), /apply recipe[^\n]*not `foreign_ref_movement`/u);
  assert.match(read("docs/contracts/epic-planning-ref.md"), /Every host request carries the identity of the operation that asks, `owner_operation_id` and `request_id`/u);
  assert.match(read("02-architecture.md"), /the host's request carries the asking operation's `owner_operation_id` and `request_id`/u);
  // The stop 12a named open, and 12g's ADR, say the same thing.
  const decisions = read("04-decisions.md");
  const guard = decisions.slice(decisions.indexOf("## ADR-102"), decisions.indexOf("## ADR-103"));
  assert.doesNotMatch(guard, /дело долга 12g с #18/u);
  assert.match(guard, /`receipt_missing`[^\n]*`behind`|Изменено ADR-108/u);
  const adr = decisions.slice(decisions.indexOf("## ADR-108"), decisions.indexOf("## Оставшиеся риски"));
  assert.ok(adr.length > 0, "ADR-108 is not in 04-decisions.md");
  for (const phrase of [/R8-9/u, /Альтернатива/u, /`applyDelta`/u, /`custodyIdentity`/u, /`recipeJournal`/u, /test\/runtime-delta-driver\.test\.mjs/u, /Что не сделано и названо/u, /Источники/u, /изменяет ADR-095/u]) {
    assert.match(adr, phrase);
  }
  const note = decisions.slice(decisions.indexOf("## ADR-095"), decisions.indexOf("## ADR-096"));
  assert.match(note, /Изменено ADR-108/u);
});

test("the documents say what the recipe key, the journal and the reflog check are, and what a rebuild is (review M1, M2, L1, L2)", () => {
  const staging = read("docs/contracts/epic-staging.md");
  const recovery = staging.slice(staging.indexOf("## 7. Recovery"), staging.indexOf("## 8. Park reasons"));
  // Scoped, not the free-string id alone: two Epics or projects naming an operation alike do not share a pair.
  assert.match(recovery, /scoped key/u);
  assert.match(recovery, /staging ref[^.]*operation id[^.]*base[^.]*delta digest|ref, the operation id, the base commit and the delta digest/u);
  // The journal's layout: a file per key, made atomically (it was one appended file until the narrow re-review, N1).
  assert.match(recovery, /one file per apply key/u);
  assert.match(recovery, /fsyncs it/u);
  // The ref at the base after the recipe's movement is behind, and the helper is not asked again.
  assert.match(recovery, /reflog[^.]*recorded depth/u);
  assert.match(recovery, /`autosk-flow staging <owner_operation_id>`/u);
  assert.doesNotMatch(recovery, /can only be this apply's/u);
  // A rebuild and a re-stage are fresh operations.
  assert.match(recovery, /fresh operation/u);
  assert.match(recovery, /re-stage[^.]*new base/u);
  assert.match(read("docs/contracts/approved-delta.md"), /fresh operation/u);
});

test("ADR-108 records the review decisions of the fix round, and every test it names exists (M1-M3, L1-L5)", () => {
  const decisions = read("04-decisions.md");
  const adr = decisions.slice(decisions.indexOf("## ADR-108"), decisions.indexOf("## Оставшиеся риски"));
  const review = adr.slice(adr.indexOf("**Решения ревью"), adr.indexOf("- Альтернатива 1:"));
  assert.ok(review.length > 0, "ADR-108 has no review decisions");
  for (const finding of ["M1", "M2", "M3", "L1", "L2", "L3", "L4", "L5"]) assert.match(review, new RegExp(`- ${finding} `, "u"), finding);
  // What the ADR no longer says: a journal that is called append-only and is not, and a cond_462 that mirrors cond_444 and does not.
  assert.doesNotMatch(adr, /append-only, как receipts/u);
  assert.match(adr, /`cond_462` читает всё, что читает `cond_444`/u);
  // Every test named in «…» is a test of the suite (by its opening words).
  const tests = readdirSync(path.join(ROOT, "test")).filter((name) => name.endsWith(".test.mjs")).map((name) => read(`test/${name}`)).join("\n");
  const named = [...review.matchAll(/«([^»]+)»/gu)].map((match) => match[1].replace(/…$/u, "").replace(/\s+$/u, ""));
  assert.ok(named.length >= 10, `${named.length} tests named`);
  for (const name of named) assert.ok(tests.includes(`test("${name}`), `ADR-108 names a test that is not in the suite: ${name}`);
});

// --- debt 12g, narrow re-review (N1-N10) -----------------------------------------------------------

test("an environment failure at apply_staging is a stop the graph has, and the recipe journal's I/O is one of its causes (N3)", () => {
  const graph = shipped();
  const row = graph.recovery.find((entry) => entry.reason === "environment_failure");
  for (const step of ["aggregate_verify", "apply_staging"]) assert.ok(row.parks_at.includes(step), `environment_failure does not park at ${step}`);
  assert.ok(row.resume_targets.includes("apply_staging"));
  assert.match(row.required_state, /recipe journal/u);
  assert.match(row.required_state, /apply_staging/u);
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  const predicates = new Map(graph.predicates.map((entry) => [entry.id, entry]));
  const edges = graph.transitions.filter((edge) => edge.from === "apply_staging" && edge.to === "human"
    && edge.guards.some((id) => guards.get(id).park_reason === "environment_failure"));
  assert.equal(edges.length, 1, "apply_staging has no environment_failure edge");
  const predicate = predicates.get(guards.get(edges[0].guards[0]).predicate);
  assert.equal(predicate.domain, "staging_aggregate", "the apply's own outcome at apply_staging is the Epic staging's, #9's (ADR-107; review F-b)");
  assert.match(predicate.description, /(?:recipe journal|journal)/u);
  // The driver and the journal produce it, and the vocabulary says so.
  const entry = vocabulary().park_reasons.find((reason) => reason.code === "environment_failure");
  assert.ok(entry.named_at.includes("apply_staging"));
  for (const file of ["src/host/delta-driver.mjs", "src/host/staging-lineage.mjs"]) assert.ok(entry.producer_files.includes(file), file);
  for (const file of ["src/host/delta-driver.mjs", "src/host/staging-lineage.mjs"]) assert.match(read(file), /'environment_failure'/u, file);
  // Every stop of the apply carries a row at apply_staging: none of the codes the journal or the driver raise is without one.
  const parked = new Set(graph.recovery.filter((r) => r.parks_at.includes("apply_staging")).map((r) => r.reason));
  for (const reason of ["receipt_missing", "environment_failure", "delta_stale", "planning_ref_capability_missing", "blocked_anchor"]) assert.ok(parked.has(reason), reason);
});

test("a staging ref rebuilt after it moved is rebuilt the way receipt_missing says: no receipted deltas from their recipes, and a fresh operation each (N4)", () => {
  const graph = shipped();
  const row = graph.recovery.find((entry) => entry.reason === "staging_moved_after_pass");
  assert.doesNotMatch(row.required_state, /cleanupStaging by the recorded staging OID/u);
  assert.doesNotMatch(row.required_state, /the receipted deltas\)/u);
  assert.match(row.required_state, /fresh operation/u);
  assert.match(row.required_state, /receipt_missing/u);
  assert.match(row.required_state, /recorded_target_base/u);
  const plan = read("03-technical-plan.md").split("\n").find((line) => line.startsWith("| staging_moved_after_pass |")) ?? "";
  assert.match(plan, /под новой операцией/u);
  assert.doesNotMatch(plan, /receipted deltas заново из своих recipes/u);
  const missing = graph.recovery.find((entry) => entry.reason === "receipt_missing");
  // The journal that cannot vouch stops its own key, and the way back for that key is named, with its owner.
  assert.match(missing.required_state, /(?:quarantine|quarantined)/u);
  assert.match(missing.required_state, /that key/u);
  const staging = read("docs/contracts/epic-staging.md");
  const recovery = staging.slice(staging.indexOf("## 7. Recovery"), staging.indexOf("## 8. Park reasons"));
  assert.match(recovery, /newest reflog entry/u);
  assert.match(recovery, /generation/u);
  assert.match(recovery, /one file per apply key/u);
  assert.match(recovery, /link/u);
  assert.match(recovery, /quarantine/u);
  // Not the premise that was false: applies are not serialized by the one CAS, and Epics may be staged at once.
  assert.doesNotMatch(recovery, /serializes the Epic's applies/u);
  assert.doesNotMatch(recovery, /the journal of an Epic is written by the host/u);
  assert.doesNotMatch(recovery, /can only be this apply's/u);
});

test("the hand-off's acceptance re-read reads what the CAS's does, the profile digest included, in the graph and in the documents (N9)", () => {
  const graph = shipped();
  const predicates = new Map(graph.predicates.map((entry) => [entry.id, entry]));
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  const stale = (from) => graph.transitions.filter((edge) => edge.from === from && edge.guards.some((id) => guards.get(id).park_reason === "acceptance_stale" && guards.get(id).authority.actor === "agent"))
    .map((edge) => predicates.get(guards.get(edge.guards[0]).predicate))[0];
  const atCas = stale("integrate_staging");
  const atHandOff = stale("deliver_staging");
  assert.ok(atCas.reads.includes("delivery_profile_digest"), "the CAS's acceptance check does not read the delivery profile digest");
  assert.match(atCas.description, /delivery_profile_digest/u);
  for (const fact of atCas.reads) assert.ok(atHandOff.reads.includes(fact), fact);
  const risks = read("04-decisions.md").split("\n").find((line) => line.startsWith("8. (ADR-084")) ?? "";
  assert.match(risks, /IntegrationAuthorizationRecord/u);
  assert.match(risks, /delivery_profile_digest/u);
});

test("risk 8 is closed for the hand-off's re-read, and the window of a live PR or queue entry while parked is named with its owner (N5)", () => {
  const risks = read("04-decisions.md").split("\n").find((line) => line.startsWith("8. (ADR-084")) ?? "";
  assert.match(risks, /ADR-108/u);
  assert.match(risks, /не закрыт[оаы]? целиком|остаётся окно/u, "risk 8 says it is closed whole");
  assert.match(risks, /#17/u);
  assert.match(risks, /(?:PR|entry)[^.]*(?:пока|во время)[^.]*(?:припаркован|парк)/u);
  const adr = read("04-decisions.md");
  const section = adr.slice(adr.indexOf("## ADR-108"), adr.indexOf("## Оставшиеся риски"));
  assert.match(section, /N5/u);
});

test("ADR-108 records the narrow re-review's decisions and every test it names exists (N1-N10)", () => {
  const decisions = read("04-decisions.md");
  const adr = decisions.slice(decisions.indexOf("## ADR-108"), decisions.indexOf("## Оставшиеся риски"));
  const start = adr.indexOf("**Решения узкого ревью");
  assert.ok(start >= 0, "ADR-108 has no narrow re-review decisions");
  const review = adr.slice(start, adr.indexOf("- Альтернатива 1:"));
  for (const finding of ["N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8", "N9", "N10"]) assert.match(review, new RegExp(`- ${finding} `, "u"), finding);
  // What ADR-108 and the contract no longer say.
  assert.doesNotMatch(decisions, /может быть только этого apply/u);
  assert.doesNotMatch(adr, /журнал Epic пишет host, который сериализует/u);
  assert.match(adr, /по одному файлу на ключ apply/u);
  const tests = readdirSync(path.join(ROOT, "test")).filter((name) => name.endsWith(".test.mjs")).map((name) => read(`test/${name}`)).join("\n");
  const named = [...review.matchAll(/«([^»]+)»/gu)].map((match) => match[1].replace(/…$/u, "").replace(/\s+$/u, ""));
  assert.ok(named.length >= 10, `${named.length} tests named`);
  for (const name of named) assert.ok(tests.includes(`test("${name}`), `ADR-108 names a test that is not in the suite: ${name}`);
});

test("the priming entry says what the tests were red on, and no more (N8)", () => {
  const priming = read("docs/cloud-agent-priming.md");
  assert.doesNotMatch(priming, /"two applies saving at once…" \(one recipe lost\)/u);
  assert.match(priming, /Narrow re-review \(on `56b03eb`, a fresh process\)/u);
});

// --- debt 12g, focused re-review (F1-F4, a-f) -------------------------------------------------------------

const MD = (file) => read(file);
const resumesFromRecipe = /recipe/u;

test("the environment failure at apply_staging says what is true of a resume, in the predicate, the row, 03 and both views (review F-a)", () => {
  const graph = shipped();
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  const edge = graph.transitions.find((entry) => entry.from === "apply_staging" && entry.guards.some((id) => guards.get(id).park_reason === "environment_failure"));
  const predicate = graph.predicates.find((entry) => entry.id === guards.get(edge.guards[0]).predicate);
  const row = graph.recovery.find((entry) => entry.reason === "environment_failure");
  const views = graph.views.flatMap((view) => view.rows).filter((entry) => entry.covers.includes("environment_failure"));
  assert.equal(views.length, 2);
  const texts = [predicate.description, row.required_state, ...views.map((entry) => entry.cells[2])];
  const plan = MD("03-technical-plan.md").split("\n").find((line) => line.startsWith("| apply_staging | git-команда или recipe journal")) ?? "";
  assert.notEqual(plan, "", "03 has no row for an environment failure at apply_staging");
  for (const text of [...texts, plan]) {
    // The helper may have been asked and may have committed: the apply is resumed, and a recorded recipe is what it resumes from.
    assert.doesNotMatch(text, /helper не спрашивался|helper was not asked|восстанавливать нечего|nothing is restored|so nothing to restore/u);
    assert.match(text, resumesFromRecipe, text.slice(0, 80));
  }
  for (const text of [predicate.description, plan, views[0].cells[2]]) assert.match(text, /expected_commit_oid/u);
  assert.match(row.required_state, /recovered, not asked again/u);
});

test("cond_464 belongs to the domain of the other predicates at apply_staging, staging_aggregate (review F-b)", () => {
  const graph = shipped();
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  const predicates = new Map(graph.predicates.map((entry) => [entry.id, entry]));
  const domains = new Map();
  for (const edge of graph.transitions.filter((entry) => entry.from === "apply_staging")) {
    for (const id of edge.guards) {
      const predicate = predicates.get(guards.get(id).predicate);
      domains.set(predicate.id, predicate.domain);
    }
  }
  assert.equal(domains.get("cond_464"), "staging_aggregate");
  // ADR-107's rule as the graph keeps it: what parks at apply_staging is #9's, except the anchor's and the planning ref's stops.
  assert.deepEqual([...new Set([...domains.values()])].sort(), ["anchor_binding", "planning_ref_lifecycle", "staging_aggregate"]);
  const matrix = JSON.parse(read("resources/program-capabilities/matrix.v1.json"));
  const staging = matrix.predicate_domains.find((entry) => entry.domain === "staging_aggregate");
  assert.deepEqual([...staging.owner_issues], [9]);
  assert.match(staging.delivery, /applying the approved deltas/u);
  const nine = matrix.records.find((entry) => entry.issue_number === 9).implementation_obligation_before_mvp;
  assert.match(nine, /environment failure at apply_staging[^.]*parks environment_failure and the resume continues from the recipe/u);
});

test("receipt_missing's row says what the rebuild and the quarantine are, and staging_moved_after_pass's row points at it truthfully (review F-d, F3)", () => {
  const graph = shipped();
  const missing = graph.recovery.find((entry) => entry.reason === "receipt_missing");
  const moved = graph.recovery.find((entry) => entry.reason === "staging_moved_after_pass");
  assert.ok(missing.required_state.length <= 1024);
  // The row the other row points at says what it is pointed at for.
  assert.match(moved.required_state, /as receipt_missing's row says: a new generation/u);
  assert.match(missing.required_state, /new generation/u);
  assert.match(missing.required_state, /fresh operation/u);
  assert.match(missing.required_state, /<key>\.recipe\.quarantined/u);
  assert.match(missing.required_state, /refusing that key alone/u);
  const view = graph.views.flatMap((entry) => entry.rows).find((entry) => entry.covers.length === 1 && entry.covers[0] === "receipt_missing");
  assert.match(view.cells[2], /новом поколении/u);
  assert.match(view.cells[2], /<key>\.recipe\.quarantined/u);
  assert.doesNotMatch(view.cells[2], /убирается в карантин/u);
  // The quarantine is one procedure everywhere it is written: the file's new name, and a fresh operation.
  for (const [file, pattern] of [
    ["docs/contracts/epic-staging.md", /`<key>\.recipe\.quarantined`[\s\S]{0,500}fresh operation/u],
    ["src/host/staging-lineage.mjs", /`\.quarantined`[\s\S]{0,400}fresh\s+operation/u],
    ["resources/program-capabilities/matrix.v1.json", /`\.recipe\.quarantined`, which the journal then refuses by name/u],
    ["04-decisions.md", /`<key>\.recipe\.quarantined`/u],
  ]) assert.match(MD(file), pattern, file);
});

test("no document says a temporary file's name says it is abandoned, and the reflog check and the durable read are written where the journal is (review F-e, F1, F2, F4)", () => {
  for (const file of ["docs/contracts/epic-staging.md", "src/host/staging-lineage.mjs"]) {
    assert.doesNotMatch(MD(file), /whose name says it is abandoned/u, file);
  }
  const contract = MD("docs/contracts/epic-staging.md");
  assert.match(contract, /only its age tells them apart/u);
  assert.match(contract, /A recipe that is found is made durable before it is relied on/u);
  assert.match(contract, /display options[^)]*signature report[^)]*switched off/u);
  assert.match(contract, /never an entry that is not there/u);
  assert.match(contract, /a git command that fails while the apply reads the line \(the reflog included\)/u);
  const lineage = MD("src/host/staging-lineage.mjs");
  assert.match(lineage, /only its age tells them apart/u);
  assert.match(lineage, /A recipe that is found is made durable before it is relied on/u);
  const driver = MD("src/host/staging-driver.mjs");
  for (const flag of ["log.showSignature=false", "--no-show-signature"]) assert.ok(driver.includes(flag), flag);
});

test("01's row for an environment failure at apply_staging says the apply resumes from its recipe (review F-f)", () => {
  const line = MD("01-core-flows.md").split("\n").find((entry) => entry.startsWith("| Aggregate не привязан к staging")) ?? "";
  assert.match(line, /apply_staging/u);
  assert.match(line, /окружение в apply_staging — apply возобновляется из своего recipe, без model run/u);
  assert.match(line, /expected_commit_oid — apply уже сделан/u);
});

test("ADR-108 records the focused re-review's decisions and every test it names exists (F1-F4, F-a to F-f)", () => {
  const decisions = read("04-decisions.md");
  const adr = decisions.slice(decisions.indexOf("## ADR-108"), decisions.indexOf("## Оставшиеся риски"));
  const start = adr.indexOf("**Решения повторного узкого ревью");
  assert.ok(start >= 0, "ADR-108 has no focused re-review decisions");
  const review = adr.slice(start, adr.indexOf("- Альтернатива 1:"));
  for (const finding of ["F1", "F2", "F3", "F4", "F-a", "F-b", "F-c", "F-d", "F-e", "F-f"]) assert.match(review, new RegExp(`- ${finding} `, "u"), finding);
  const tests = readdirSync(path.join(ROOT, "test")).filter((name) => name.endsWith(".test.mjs")).map((name) => read(`test/${name}`)).join("\n");
  const named = [...review.matchAll(/«([^»]+)»/gu)].map((match) => match[1].replace(/…$/u, "").replace(/\s+$/u, ""));
  assert.ok(named.length >= 18, `${named.length} tests named`);
  for (const name of named) assert.ok(tests.includes(`test("${name}`), `ADR-108 names a test that is not in the suite: ${name}`);
  // The earlier round's record no longer says the domain it moved from.
  assert.doesNotMatch(adr, /`cond_464` в домене `delta_commit`/u);
});

test("the priming entry records the focused re-review, and no further round (review)", () => {
  const priming = read("docs/cloud-agent-priming.md");
  assert.match(priming, /Focused re-review \(on `07ff672`, a fresh process\): no Critical, High or Medium; N1–N6 closed; four Low and six nits, all addressed test-first in a follow-up commit/u);
  assert.match(priming, /No further re-review: the focused re-review raised only Lows and nits/u);
});
