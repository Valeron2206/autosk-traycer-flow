/** Requirement revision: the semantic front end to the crash-safe rebuild (#25).
 *
 * The mechanics already exist. `anchor_rebuild_op` knows how to rebuild and
 * `ticket_repair_op` knows how to repair a Ticket set, and both are crash-safe.
 * What neither can know is whether a change was entitled to reach code before
 * it reached the product layer. That is what this file is: the order, the
 * classification, and the recorded decisions — ending in a request to the
 * machinery that already works, never in a second implementation of it.
 *
 * The classification is where the whole path is most easily skipped: calling a
 * product change a "clarification" removes every panel from it in one word.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

export const CLASSES = immutable([
  'product_behavior',
  'technical_constraint',
  'delivery_operations_security_data',
  'evidence_clarification',
  'non_material_correction',
]);

/** The three that take the full path. */
export const MATERIAL = immutable([
  'product_behavior',
  'technical_constraint',
  'delivery_operations_security_data',
]);

/** Twelve stages; each takes the previous stage's approved output as its input. */
export const STAGES = immutable([
  'record_instruction',
  'confirm_intent',
  'update_product_layer',
  'product_panel',
  'update_technical_layer',
  'technical_panel',
  'regenerate_manifest',
  'ticket_panel',
  'impact_and_disposition_map',
  'implemented_work_options',
  'consistency_sweep',
  'hand_to_rebuild',
]);

export const DISPOSITIONS = immutable([
  'rework_current_ticket',
  'correction_ticket',
  'new_epic',
  'intentional_defer',
]);

export const REFUSALS = immutable([
  'revision_out_of_order',
  'revision_class_mismatch',
  'revision_decision_missing',
  'revision_panel_missing',
  'revision_manifest_early',
  'revision_supersession_forked',
  'revision_closed_epic',
  'revision_rebind_unproven',
  'revision_stale_reference',
  'revision_round_replay',
  'revision_instruction_rewritten',
]);

/** Artifact layers the two non-material kinds may not touch. */
const PROTECTED_LAYERS = immutable(['product', 'technical']);

/** Whether the kind takes the full path. */
export function isMaterial(kind) {
  demand(CLASSES.includes(kind), 'revision_class_mismatch', 'Unknown revision class', { kind });
  return MATERIAL.includes(kind);
}

/**
 * The classification, and what it is allowed to touch.
 *
 * A clarification that edits a Core Flow is refused rather than reviewed
 * leniently: the edit is the evidence that the classification was wrong.
 */
export function classificationErrors(revision) {
  const errors = [];
  if (!CLASSES.includes(revision.kind)) {
    return [{ reason: 'revision_class_mismatch', detail: `unknown class ${revision.kind}` }];
  }
  if (!revision.classification_rationale || revision.classification_rationale.trim().length < 16) {
    errors.push({ reason: 'revision_class_mismatch', detail: 'the classification carries no rationale' });
  }
  if (!MATERIAL.includes(revision.kind)) {
    for (const artifact of revision.touches ?? []) {
      if (PROTECTED_LAYERS.includes(artifact.layer)) {
        errors.push({
          reason: 'revision_class_mismatch',
          detail: `${revision.kind} may not touch ${artifact.layer}: ${artifact.path}`,
        });
      }
    }
  }
  return errors;
}

/**
 * Whether a side effect is allowed at the stage that is running.
 *
 * A product change is not applied to code or Tickets first, and the refusal
 * names the stage that was running — "out of order" without the order is a
 * complaint, not a diagnosis.
 */
export function stageAdmission({ stage, sideEffect }) {
  demand(STAGES.includes(stage), 'revision_out_of_order', 'Unknown revision stage', { stage });
  const index = STAGES.indexOf(stage);
  if (sideEffect === 'regenerate_manifest' && index < STAGES.indexOf('regenerate_manifest')) {
    // A manifest regenerated before the technical layer settled is a manifest
    // of the previous plan — and it does not look stale, it looks current.
    return Object.freeze({ decision: 'refuse', reason: 'revision_manifest_early', stage });
  }
  if ((sideEffect === 'ticket' || sideEffect === 'code') && index < STAGES.indexOf('hand_to_rebuild')) {
    return Object.freeze({ decision: 'refuse', reason: 'revision_out_of_order', stage, side_effect: sideEffect });
  }
  return Object.freeze({ decision: 'allow', stage, side_effect: sideEffect });
}

/** The three panels a material revision runs, each after its own layer. */
export function panelErrors(revision) {
  if (!isMaterial(revision.kind)) return [];
  const errors = [];
  for (const [panel, stage] of [['product', 'product_panel'], ['technical', 'technical_panel'], ['tickets', 'ticket_panel']]) {
    const record = revision.panels?.[panel];
    if (!record) {
      errors.push({ reason: 'revision_panel_missing', detail: `${stage}: no panel record` });
      continue;
    }
    if (record.verdict !== 'pass') {
      errors.push({ reason: 'revision_panel_missing', detail: `${stage}: ${record.verdict}` });
    }
  }
  return errors;
}

/**
 * The fate of work that already exists.
 *
 * The model prepares the options with their consequences and does not choose.
 * `intentional_defer` is held to the same proof as the rest, because it is the
 * one most likely to be recorded as an observation rather than a choice.
 */
export function dispositionErrors(map) {
  const errors = [];
  for (const entry of map.tickets ?? []) {
    if (entry.status === 'work' && entry.paused !== true) {
      // Replacing the requirement under a running Ticket leaves a model working
      // from a plan that no longer exists.
      errors.push({ reason: 'revision_out_of_order', detail: `${entry.ticket_id}: superseded while running` });
    }
    if (!['staged', 'integrated'].includes(entry.status)) continue;
    if (!DISPOSITIONS.includes(entry.disposition)) {
      errors.push({ reason: 'revision_decision_missing', detail: `${entry.ticket_id}: ${entry.disposition ?? 'no disposition'}` });
      continue;
    }
    if (!entry.decision_ref) {
      errors.push({ reason: 'revision_decision_missing', detail: `${entry.ticket_id}: ${entry.disposition} with no decision record` });
    }
  }
  return errors;
}

/**
 * Rounds supersede; they do not merge.
 *
 * Two rounds claiming the same predecessor are a fork, which is precisely the
 * case where the second correction quietly reverts the first.
 */
export function supersessionErrors(rounds) {
  const errors = [];
  const claimed = new Map();
  for (const round of rounds) {
    if (!round.supersedes) continue;
    const existing = claimed.get(round.supersedes);
    if (existing) {
      errors.push({
        reason: 'revision_supersession_forked',
        detail: `${existing} and ${round.round_id} both supersede ${round.supersedes}`,
      });
      continue;
    }
    claimed.set(round.supersedes, round.round_id);
  }
  for (const round of rounds) {
    const previous = rounds.find((entry) => entry.round_id === round.supersedes);
    if (previous && round.original_instruction_of?.[previous.round_id] !== undefined
      && round.original_instruction_of[previous.round_id] !== previous.original_instruction) {
      // The normalized record is the interpretation; an interpretation that can
      // replace its source cannot be checked against it.
      errors.push({ reason: 'revision_instruction_rewritten', detail: previous.round_id });
    }
  }
  return errors;
}

/** A closed or released Epic is not rewritten; the revision becomes change work. */
export function closedEpicErrors(epic) {
  if (epic.state === 'closed' || epic.state === 'released') {
    return [{ reason: 'revision_closed_epic', detail: `${epic.epic_id} is ${epic.state}` }];
  }
  return [];
}

/**
 * Keeping an existing verdict is a proof, not an impression.
 *
 * The rebind is the only step in the path that saves work, so it is the one
 * under pressure. "It looks unrelated" is a description of a reading.
 */
export function rebindErrors(artifact, digests) {
  const errors = [];
  if (digests.before[artifact.id] !== digests.after[artifact.id]) {
    errors.push({ reason: 'revision_rebind_unproven', detail: `${artifact.id}: its own content changed` });
  }
  for (const dependency of artifact.depends_on ?? []) {
    if (digests.before[dependency] !== digests.after[dependency]) {
      errors.push({ reason: 'revision_rebind_unproven', detail: `${artifact.id}: ${dependency} changed` });
    }
  }
  return errors;
}

/**
 * The sweep says what it searched.
 *
 * "No stale references" from a sweep that resolved nothing is indistinguishable
 * from a clean result, and reads better.
 */
export function sweepReport({ surviving, references, resolvable }) {
  const stale = [];
  const searched = [];
  for (const artifact of surviving) {
    for (const reference of references[artifact] ?? []) {
      searched.push(`${artifact} -> ${reference}`);
      if (!resolvable.includes(reference)) {
        stale.push({ reason: 'revision_stale_reference', detail: `${artifact} -> ${reference}` });
      }
    }
  }
  return Object.freeze({
    searched: immutable(searched.sort()),
    searched_count: searched.length,
    stale: immutable(stale.map(Object.freeze)),
    clean: stale.length === 0 && searched.length > 0,
  });
}

/**
 * A round is minted before stage 1, so a crash is a replay rather than a second
 * round, and the anchor bump is idempotent per round.
 */
export function roundAdmission({ roundId, recorded }) {
  const existing = (recorded ?? []).find((round) => round.round_id === roundId);
  if (!existing) return Object.freeze({ decision: 'start', round_id: roundId, anchor_bump: true });
  return Object.freeze({
    decision: 'replay',
    reason: 'revision_round_replay',
    round_id: roundId,
    // Idempotent: a retried round does not advance the anchor twice.
    anchor_bump: false,
    resume_stage: existing.stage,
  });
}

/**
 * Where the planning invalidation goes, computed once.
 *
 * Earliest affected product or technical artifact means the alignment cycle
 * starts again; a Tickets-only revision goes back to the breakdown. Recomputing
 * this later from live metadata is how a resumed operation ends up in a
 * different place than the one it recorded.
 */
export function invalidationTarget(affectedKinds) {
  for (const kind of ['brief', 'core_flow', 'tech_plan']) {
    if (affectedKinds.includes(kind)) return 'clarify_alignment';
  }
  demand(affectedKinds.includes('tickets'), 'revision_out_of_order',
    'A revision affects at least one planning kind', { affectedKinds: immutable([...affectedKinds]) });
  return 'present_tickets_breakdown';
}

/**
 * The hand-off: a request to the machinery that already exists.
 *
 * This names the operation and what it is bound to. It does not rebuild
 * anything, because the rebuild is crash-safe and this is not.
 */
export function rebuildRequest(revision, { affectedKinds, dispositions = [] }) {
  const blocking = [
    ...classificationErrors(revision),
    ...panelErrors(revision),
    ...dispositionErrors({ tickets: dispositions }),
  ];
  demand(blocking.length === 0, blocking[0]?.reason ?? 'revision_out_of_order',
    'The revision is not ready to hand over', { detail: blocking[0]?.detail });
  demand(revision.stage === 'hand_to_rebuild', 'revision_out_of_order',
    'The hand-off happens at the last stage', { stage: revision.stage });

  const planningAffected = ['brief', 'core_flow', 'tech_plan'].some((kind) => affectedKinds.includes(kind));
  const ticketsAffected = affectedKinds.includes('tickets');
  return Object.freeze({
    // Named, not invented: these are the operations that already know how.
    anchor_rebuild_op: Object.freeze({
      source: planningAffected ? 'planning' : 'code_only',
      round_id: revision.round_id,
      recorded_target_step: invalidationTarget(affectedKinds),
      dispositions: immutable(dispositions.map((entry) => Object.freeze({
        ticket_id: entry.ticket_id,
        status: entry.status,
        disposition: entry.disposition ?? null,
        decision_ref: entry.decision_ref ?? null,
      }))),
    }),
    ticket_repair_op: ticketsAffected
      ? Object.freeze({ source: 'planning', round_id: revision.round_id })
      : null,
  });
}
