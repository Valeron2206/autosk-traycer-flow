/** Human alignment gates before Brief, Core Flow, Tech Plan and Tickets (#4).
 *
 * A four-model panel checks the quality of a decision. It cannot establish that
 * the decision was the model's to make. These gates are the difference: the
 * user's authority over the product goal, the user-visible behaviour, the
 * architectural direction and the composition of the work is recorded, not
 * inferred from the absence of an objection.
 *
 * Every rule here follows from one sentence: a model does not confirm its own
 * material decision on the user's behalf. That is why a bare resume does not
 * pass a gate, why an autonomous mode is an exact recorded policy rather than
 * the absence of a question, and why material ambiguity cannot be written down
 * as an ordinary assumption and carried forward.
 */
import { createHash } from 'node:crypto';

import { demand, immutable } from '../runtime/contracts.mjs';

import { answerRequest, assertPacketDecidable } from './decision-queue.mjs';

/** The four artifacts whose framing is the user's to settle. */
export const KINDS = immutable(['brief', 'core_flow', 'tech_plan', 'tickets']);

export const PARK_REASONS = immutable([
  'alignment_missing',
  'alignment_stale',
  'material_ambiguity_unresolved',
  'policy_scope_exceeded',
]);

/** What each kind has to put in front of the user before it can be normative. */
export const REQUIRED_FRAMING = immutable({
  brief: immutable(['goal', 'affected', 'why_now', 'scope', 'non_goals', 'success_criteria', 'open_questions']),
  core_flow: immutable(['user_actions', 'visible_states', 'unhappy_paths', 'actor_rights', 'decisions']),
  tech_plan: immutable(['unknowns', 'multi_implementation_answers', 'silent_inferences', 'closed_decisions']),
  tickets: immutable(['ticket_set', 'dependency_graph', 'per_ticket_scope', 'verifiable_outcome', 'exclusions']),
});

const sha256 = (value) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

/**
 * What an approval is an approval of.
 *
 * Project, Epic, artifact kind, anchor version and the scope the user was shown
 * — so an approval cannot survive the thing it was about changing underneath
 * it.
 */
export function alignmentIdentity({ projectIdentity, epicId, kind, anchorVersion, scopeDigest }) {
  demand(KINDS.includes(kind), 'alignment_missing', 'Unknown alignment kind', { kind });
  demand(Number.isInteger(anchorVersion), 'alignment_stale', 'An approval names the anchor version it was given under', { anchorVersion });
  return sha256({ project: projectIdentity, epic_id: epicId, kind, anchor_version: anchorVersion, scope: scopeDigest });
}

/** The digest of what the user was actually shown. */
export function scopeDigest(kind, framing) {
  const missing = REQUIRED_FRAMING[kind].filter((field) => framing?.[field] === undefined);
  demand(missing.length === 0, 'alignment_missing', `The ${kind} framing is incomplete`,
    { missing: immutable(missing) });
  return sha256(Object.fromEntries(REQUIRED_FRAMING[kind].map((field) => [field, framing[field]])));
}

/**
 * Material ambiguity is not an assumption.
 *
 * An assumption is a thing the implementer may proceed on. A question whose
 * answers lead to materially different implementations is not that, and writing
 * it in the assumptions list is how a decision that was the user's gets made by
 * whoever drafts next.
 */
export function materialAmbiguityErrors(framing) {
  const errors = [];
  for (const assumption of framing.assumptions ?? []) {
    if (assumption.material === true || (assumption.alternatives ?? []).length > 1) {
      errors.push({
        reason: 'material_ambiguity_unresolved',
        detail: `${assumption.id}: recorded as an assumption, but the answers differ materially`,
      });
    }
  }
  for (const inference of framing.silent_inferences ?? []) {
    if (!inference.shown_to_user) {
      errors.push({ reason: 'material_ambiguity_unresolved', detail: `${inference.id}: never shown to the user` });
    }
  }
  return errors;
}

/**
 * The packet that asks for the alignment.
 *
 * The framing goes in the packet, so the approval is of what the user saw
 * rather than of a title. Two options, because "confirmed?" with one button
 * records an approval whether or not one was given.
 */
export function alignmentPacket({ kind, framing, projectIdentity, epicId, anchorVersion, requestId, approver, expiresAt }) {
  const scope = scopeDigest(kind, framing);
  const ambiguity = materialAmbiguityErrors(framing);
  demand(ambiguity.length === 0, 'material_ambiguity_unresolved',
    'A material ambiguity is not an assumption', { detail: ambiguity[0]?.detail });
  const request = {
    request_id: requestId,
    project_identity: projectIdentity,
    park_reason: 'alignment_missing',
    required_approver: approver,
    expires_at: expiresAt,
    state: 'pending',
    resume_target: `record_${kind}_alignment`,
    flags: { irreversible: false },
    identities: {
      anchor_version: anchorVersion,
      candidate: alignmentIdentity({ projectIdentity, epicId, kind, anchorVersion, scopeDigest: scope }),
    },
    why_automation_may_not_decide:
      'The model drafted this framing; confirming it would be the model approving its own material decision.',
    options: [
      { option_id: 'confirm', consequence: `The ${kind} becomes normative and the flow continues from it.` },
      { option_id: 'revise', consequence: 'The framing goes back for another round and nothing normative is produced.' },
    ],
    framing,
    kind,
    scope_digest: scope,
  };
  assertPacketDecidable(request);
  return request;
}

/**
 * Records the user's answer as the alignment for that kind.
 *
 * A revision is a recorded outcome too: it is the user having decided that this
 * framing is not it, which is different from nobody having answered.
 */
export function recordAlignment(request, response, { nowMs }) {
  const { request: answered, decision } = answerRequest(request, response, { nowMs });
  if (decision.option_id === 'revise') {
    return Object.freeze({ outcome: 'revise', request: answered, decision });
  }
  demand(decision.option_id === 'confirm', 'alignment_missing',
    'The answer is neither a confirmation nor a revision', { option_id: decision.option_id });
  return Object.freeze({
    outcome: 'confirmed',
    request: answered,
    decision,
    record: Object.freeze({
      kind: request.kind,
      identity: decision.identities.candidate,
      anchor_version: decision.identities.anchor_version,
      scope_digest: request.scope_digest,
      approved_by: decision.answered_by,
      approved_at: decision.answered_at,
      decision_digest: decision.decision_digest,
      authority: 'user',
    }),
  });
}

/**
 * A pre-approved autonomous mode.
 *
 * An exact policy with a scope and the same audit trail as a person, not the
 * absence of a question. It covers what it names and nothing adjacent.
 */
export function policyAlignment(policy, { kind, projectIdentity, epicId, anchorVersion, scopeDigest: scope }) {
  demand(typeof policy?.policy_ref === 'string' && policy.policy_ref.length > 0, 'alignment_missing',
    'An autonomous alignment names the policy that granted it', {});
  demand((policy.kinds ?? []).includes(kind), 'policy_scope_exceeded',
    'The policy does not cover this artifact kind', { kind, covered: immutable([...(policy.kinds ?? [])]) });
  demand(policy.anchor_version === anchorVersion, 'alignment_stale',
    'The policy was granted under another anchor version',
    { granted: policy.anchor_version, current: anchorVersion });
  return Object.freeze({
    kind,
    identity: alignmentIdentity({ projectIdentity, epicId, kind, anchorVersion, scopeDigest: scope }),
    anchor_version: anchorVersion,
    scope_digest: scope,
    approved_by: policy.policy_ref,
    authority: 'policy',
    policy_ref: policy.policy_ref,
  });
}

/**
 * Whether the flow may produce the normative artifact, or dispatch the DAG.
 *
 * Fail-closed on purpose: no record is not an approval, a record from an
 * earlier anchor version is not an approval of this one, and a record about
 * another scope is an approval of something else.
 */
export function gateAdmission({ kind, records, projectIdentity, epicId, anchorVersion, scopeDigest: scope }) {
  // The kind is checked by the identity this computes: a second check beside it
  // would answer with the same code and the same words.
  const wanted = alignmentIdentity({ projectIdentity, epicId, kind, anchorVersion, scopeDigest: scope });
  const forKind = (records ?? []).filter((record) => record.kind === kind);
  const exact = forKind.find((record) => record.identity === wanted);
  if (exact) return Object.freeze({ decision: 'proceed', authority: exact.authority, identity: wanted });
  const reason = forKind.length === 0 ? 'alignment_missing' : 'alignment_stale';
  return Object.freeze({
    decision: 'park',
    reason,
    detail: forKind.length === 0
      ? `no alignment record for ${kind}`
      : `the ${kind} alignment was given for another anchor version or scope`,
    resume_target: `await_${kind}_alignment`,
  });
}

/**
 * A resume does not pass a gate.
 *
 * The one place where "it was already running" would otherwise be treated as an
 * approval — and a crash is not a decision.
 */
export function resumeAdmission(state) {
  return gateAdmission({
    kind: state.kind,
    records: state.records,
    projectIdentity: state.project_identity,
    epicId: state.epic_id,
    anchorVersion: state.anchor_version,
    scopeDigest: state.scope_digest,
  });
}

/**
 * A correction while a gate is waiting.
 *
 * It raises the anchor version, which makes every alignment given under the old
 * one stale — including the one being waited for. The cycle restarts rather
 * than the answer arriving against a question that has changed.
 */
export function correctionEffect({ anchorVersion, records, waitingFor }) {
  const next = anchorVersion + 1;
  const invalidated = (records ?? []).filter((record) => record.anchor_version < next);
  return Object.freeze({
    anchor_version: next,
    invalidated: immutable(invalidated.map((record) => record.kind).sort()),
    restart: waitingFor ? `clarify_${waitingFor}` : null,
  });
}

/**
 * Quick flow gets no gates it did not earn.
 *
 * While the classification holds, these states do not apply. Material scope
 * growth reclassifies it as Planned, and then the gates are the Planned ones —
 * granted from that moment, not backdated over work already done.
 */
export function quickFlowGates({ classification, scopeGrowth }) {
  if (classification !== 'quick') {
    return Object.freeze({ flow: 'planned', gates: KINDS });
  }
  if (scopeGrowth === 'material') {
    return Object.freeze({
      flow: 'planned',
      reclassified: true,
      gates: KINDS,
      reason: 'material_scope_growth',
    });
  }
  return Object.freeze({ flow: 'quick', gates: immutable([]) });
}
