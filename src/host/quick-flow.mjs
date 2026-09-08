/** Quick classification, its re-checks, and promotion to Planned.
 *
 * Quick is a claim that the work needs no framing: the outcome is unambiguous,
 * there is no new behaviour or architectural choice, and no API, schema,
 * security, concurrency or migration surface is touched. The claim is cheap to
 * make at intake and expensive to be wrong about later, so it is re-checked
 * before every transition rather than settled once.
 *
 * Promotion is not a repair of the Quick task. The Quick task is superseded: a
 * Planned replacement starts from the original base, the worktree is handed
 * over as *unverified work* rather than as a candidate, and the old task can no
 * longer commit or integrate. A dirty worktree is never deleted to tidy the
 * transition, because nobody has reviewed what is in it.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

/** Where the classification is re-checked. Intake is not enough. */
export const RECHECK_POINTS = immutable([
  'implementation',
  'verification',
  'fix',
  'freeze',
  'review_result',
  'accept',
  'integrate_prologue',
]);

/** The surfaces whose presence makes work Planned, whatever it looked like. */
export const PLANNED_TRIGGERS = immutable([
  'new_behavior',
  'api_contract',
  'data_schema',
  'security',
  'concurrency',
  'migration',
  'unclear_boundary',
  'material_scope_growth',
]);

export const PARK_REASONS = immutable([
  'quick_classification_invalid',
  'quick_side_effect_after_invalidation',
  'implementation_scope_invalid',
  'quick_evidence_incomplete',
]);

/**
 * Whether the work is Quick, read from the four conditions at once.
 *
 * All four have to hold. Three of four is Planned, and the reason is named
 * rather than summarised, so the reclassification record says which condition
 * failed.
 */
export function classifyIntake(intake) {
  const triggers = [];
  if (intake.outcome_unambiguous !== true) triggers.push('unclear_boundary');
  if (intake.new_behavior === true) triggers.push('new_behavior');
  for (const surface of ['api_contract', 'data_schema', 'security', 'concurrency', 'migration']) {
    if (intake.surfaces?.[surface] === true) triggers.push(surface);
  }
  if (intake.needs_planning_artifacts === true) triggers.push('new_behavior');
  const unique = immutable([...new Set(triggers)].sort());
  return Object.freeze({
    classification: unique.length === 0 ? 'quick' : 'planned',
    triggers: unique,
  });
}

/**
 * The re-check before a transition.
 *
 * A completion or evidence record that names no new material questions has not
 * been asked; it has to say so explicitly, because "nothing came up" and
 * "nobody looked" are indistinguishable in an empty field.
 */
export function recheck({ point, classification, record }) {
  demand(RECHECK_POINTS.includes(point), 'quick_classification_invalid',
    'Unknown re-check point', { point });
  if (classification !== 'quick') return Object.freeze({ decision: 'proceed', classification });
  demand(Array.isArray(record?.new_material_questions), 'quick_evidence_incomplete',
    'A Quick record lists the material questions it found, even when there are none', { point });
  demand(Array.isArray(record?.planned_triggers), 'quick_evidence_incomplete',
    'A Quick record lists the Planned triggers it found, even when there are none', { point });

  const triggers = [...record.planned_triggers];
  for (const trigger of triggers) {
    demand(PLANNED_TRIGGERS.includes(trigger), 'quick_classification_invalid',
      'Unknown Planned trigger', { trigger });
  }
  if (record.new_material_questions.length > 0 && !triggers.includes('unclear_boundary')) {
    // A material question is an unclear boundary by another name.
    triggers.push('unclear_boundary');
  }
  if (triggers.length === 0) return Object.freeze({ decision: 'proceed', classification: 'quick' });
  return Object.freeze({
    decision: 'invalidate',
    reason: 'quick_classification_invalid',
    triggers: immutable([...new Set(triggers)].sort()),
    point,
  });
}

/**
 * Ordinary scope expansion, which is only ordinary while it stays Quick.
 *
 * Widening the paths a Quick task may touch is allowed; widening them until the
 * work is something else is the promotion path, not this one.
 */
export function expandScope({ current, requested, intake }) {
  const classification = classifyIntake({ ...intake, ...requested.intake });
  if (classification.classification !== 'quick') {
    return Object.freeze({
      decision: 'invalidate',
      reason: 'quick_classification_invalid',
      triggers: classification.triggers,
    });
  }
  return Object.freeze({
    decision: 'expand',
    reason: 'implementation_scope_invalid',
    pathspec: immutable([...new Set([...current.pathspec, ...requested.pathspec])].sort()),
  });
}

/**
 * The promotion itself.
 *
 * Idempotent by the replacement's identity: a crash between creating the
 * replacement and recording the supersession must not create a second Planned
 * Epic for the same Quick task.
 */
export function promote({ quick, triggers, existingReplacement, nowIso }) {
  demand(Array.isArray(triggers) && triggers.length > 0, 'quick_classification_invalid',
    'A promotion names what made the work Planned', {});
  const replacementKey = `${quick.project_identity}:${quick.task_id}:planned`;
  if (existingReplacement) {
    demand(existingReplacement.replacement_key === replacementKey, 'quick_classification_invalid',
      'The existing replacement belongs to another Quick task',
      { expected: replacementKey, found: existingReplacement.replacement_key });
    return Object.freeze({ effect: 'replayed', replacement: existingReplacement, quick: supersede(quick, existingReplacement, triggers, nowIso) });
  }
  const replacement = Object.freeze({
    replacement_key: replacementKey,
    project_identity: quick.project_identity,
    // From the original base, not from wherever the Quick work reached: the
    // Planned flow plans the work, it does not inherit an unreviewed head.
    base_oid: quick.base_oid,
    classification: 'planned',
    supersedes: quick.task_id,
    triggers: immutable([...triggers].sort()),
    created_at: nowIso,
  });
  return Object.freeze({ effect: 'created', replacement, quick: supersede(quick, replacement, triggers, nowIso) });
}

function supersede(quick, replacement, triggers, nowIso) {
  return Object.freeze({
    ...quick,
    outcome: 'reclassified',
    superseded_by: replacement.replacement_key,
    superseded_at: nowIso,
    triggers: immutable([...triggers].sort()),
    may_commit: false,
    may_integrate: false,
  });
}

/**
 * What happens to the worktree.
 *
 * It is handed over by an exact ownership receipt and it is *unverified work*,
 * not a code candidate: nothing in it was reviewed under the classification it
 * was produced under. A dirty worktree is not deleted, because deleting
 * somebody's unreviewed work to tidy a transition is the one outcome that
 * cannot be undone.
 */
export function worktreeHandover({ quick, replacement, worktree }) {
  return Object.freeze({
    receipt: Object.freeze({
      from_task: quick.task_id,
      to_replacement: replacement.replacement_key,
      path: worktree.path,
      head_oid: worktree.head_oid,
      dirty: worktree.dirty === true,
      state: 'unverified_work',
    }),
    // Stated rather than implied: this is not a candidate and cannot be frozen
    // or reviewed as one.
    is_code_candidate: false,
    delete_worktree: false,
  });
}

/**
 * Side effects after invalidation.
 *
 * The point of invalidating is that nothing else happens under the old claim.
 */
export function assertNoQuickSideEffect(quick, effect) {
  demand(quick.outcome !== 'reclassified', 'quick_side_effect_after_invalidation',
    'The Quick task was reclassified and may not act', { effect, task_id: quick.task_id });
  return effect;
}
