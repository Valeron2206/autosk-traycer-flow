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

import { FlowError, demand, digest, immutable } from '../runtime/contracts.mjs';

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

/** The twelve fields of 02 §7's alignment approval identity, in its order. */
export const IDENTITY_FIELDS = immutable([
  'project_root_sha256',
  'epic_id',
  'kind',
  'anchor_version',
  'scope_hash',
  'subject_hash',
  'material_manifest_hash',
  'projector',
  'user_decision',
  'classifier',
  'policy',
  'protocol_hash',
]);

/** What the user is asked about: the same preimage without the decision, which
 * exists only once they answer. */
export const QUESTION_FIELDS = immutable(IDENTITY_FIELDS.filter((field) => field !== 'user_decision'));

const APPROVAL_DOMAIN = 'autosk-flow/alignment-approval/v1';
const QUESTION_DOMAIN = 'autosk-flow/alignment-question/v1';
const HEX = /^[a-f0-9]{64}$/u;

const sha256 = (value) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
const hex = (value) => typeof value === 'string' && HEX.test(value);
const shaped = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/** Each fact's shape; a fact that is missing or malformed is not a fact the identity can bind. */
const FACT_CHECKS = Object.freeze({
  project_root_sha256: hex,
  epic_id: (value) => typeof value === 'string' && value.length > 0,
  scope_hash: hex,
  subject_hash: hex,
  material_manifest_hash: hex,
  projector: (value) => shaped(value, ['version', 'hash', 'inputs_hash'])
    && Number.isInteger(value.version) && hex(value.hash) && hex(value.inputs_hash),
  user_decision: (value) => value === null || (shaped(value, ['record_id', 'record_hash', 'provenance_hash'])
    && typeof value.record_id === 'string' && value.record_id.length > 0
    && hex(value.record_hash) && hex(value.provenance_hash)),
  classifier: (value) => shaped(value, ['version', 'hash']) && Number.isInteger(value.version) && hex(value.hash),
  policy: (value) => value === null || (shaped(value, ['issuance_hash', 'disposition_hash'])
    && hex(value.issuance_hash) && hex(value.disposition_hash)),
  protocol_hash: hex,
});

/** Refuses facts that are not exactly `fields`, each in its shape. */
function assertFacts(facts, fields) {
  demand(KINDS.includes(facts?.kind), 'alignment_missing', 'Unknown alignment kind', { kind: facts?.kind });
  demand(Number.isInteger(facts.anchor_version), 'alignment_stale',
    'An approval names the anchor version it was given under', { anchor_version: facts.anchor_version });
  const unknown = Object.keys(facts).filter((field) => !fields.includes(field));
  demand(unknown.length === 0, 'alignment_missing', 'An alignment identity binds only its own fields',
    { unknown: immutable(unknown) });
  for (const field of fields.filter((name) => Object.hasOwn(FACT_CHECKS, name))) {
    demand(Object.hasOwn(facts, field) && FACT_CHECKS[field](facts[field]), 'alignment_missing',
      `An alignment identity needs ${field}`, { field });
  }
}

/**
 * What an approval is an approval of: 02 §7's alignment approval identity.
 *
 * All twelve fields — project, Epic, kind, anchor version, scope, subject,
 * material manifest, projector proof, the user decision record, classifier,
 * current policy issuance and disposition (or null), protocol — as a
 * domain-separated canonical digest, so an approval cannot survive any of them
 * changing underneath it, and cannot be read as another record's digest. An
 * approval has a source: a user decision, or a current policy.
 */
export function alignmentIdentity(facts) {
  assertFacts(facts, IDENTITY_FIELDS);
  demand(facts.user_decision !== null || facts.policy !== null, 'alignment_missing',
    'An approval has a source: a user decision or a current policy', {});
  return digest(APPROVAL_DOMAIN, facts);
}

/** What the packet asks about: the approval preimage without the decision, under its own domain. */
export function alignmentQuestion(facts) {
  assertFacts(facts, QUESTION_FIELDS);
  return digest(QUESTION_DOMAIN, facts);
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
export function alignmentPacket({ kind, framing, facts, requestId, approver, expiresAt }) {
  const scope = scopeDigest(kind, framing);
  const ambiguity = materialAmbiguityErrors(framing);
  demand(ambiguity.length === 0, 'material_ambiguity_unresolved',
    'A material ambiguity is not an assumption', { detail: ambiguity[0]?.detail });
  // `facts` is the question's preimage but for the kind and the scope, which
  // are this packet's own.
  const question = Object.freeze({ ...facts, kind, scope_hash: scope });
  const request = {
    request_id: requestId,
    project_identity: `sha256:${question.project_root_sha256}`,
    park_reason: 'alignment_missing',
    required_approver: approver,
    expires_at: expiresAt,
    state: 'pending',
    resume_target: `record_${kind}_alignment`,
    flags: { irreversible: false },
    identities: {
      anchor_version: question.anchor_version,
      candidate: alignmentQuestion(question),
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
    alignment_facts: question,
  };
  assertPacketDecidable(request);
  return request;
}

/**
 * Records the user's answer as the alignment for that kind.
 *
 * A revision is a recorded outcome too: it is the user having decided that this
 * framing is not it, which is different from nobody having answered. The
 * answer is a daemon UserDecisionRecord verified by the queue; the record's
 * identity binds it, with the question's facts.
 */
export function recordAlignment(request, response, { nowMs, verifySignature }) {
  const { request: answered, decision } = answerRequest(request, response, { nowMs, verifySignature });
  // The user signed the packet's question; the facts the record binds must be
  // that question, with the packet's own kind and scope, or the record would
  // bind facts nobody was asked about.
  const facts = request.alignment_facts;
  demand(alignmentQuestion(facts) === decision.identities.candidate
    && facts.kind === request.kind && facts.scope_hash === request.scope_digest, 'alignment_stale',
  'The facts this record would bind are not the question the user signed', { kind: request.kind });
  if (decision.option_id === 'revise') {
    return Object.freeze({ outcome: 'revise', request: answered, decision });
  }
  demand(decision.option_id === 'confirm', 'alignment_missing',
    'The answer is neither a confirmation nor a revision', { option_id: decision.option_id });
  const userDecision = Object.freeze({
    record_id: decision.user_decision_record_id,
    record_hash: decision.user_decision_record_hash,
    provenance_hash: decision.user_decision_provenance_hash,
  });
  return Object.freeze({
    outcome: 'confirmed',
    request: answered,
    decision,
    record: Object.freeze({
      kind: request.kind,
      identity: alignmentIdentity({ ...facts, user_decision: userDecision }),
      anchor_version: decision.identities.anchor_version,
      scope_digest: request.scope_digest,
      approved_by: decision.answered_by,
      approved_at: decision.answered_at,
      decision_digest: decision.decision_digest,
      authority: 'user',
      source: 'user_decision',
      user_decision: userDecision,
    }),
  });
}

/**
 * A pre-approved autonomous mode.
 *
 * An exact policy with a scope and the same audit trail as a person, not the
 * absence of a question. It covers what it names and nothing adjacent, and its
 * identity binds the current policy's issuance and disposition in place of a
 * user decision, so a revoked or replaced policy no longer admits anything.
 */
export function policyAlignment(policy, facts) {
  demand(typeof policy?.policy_ref === 'string' && policy.policy_ref.length > 0, 'alignment_missing',
    'An autonomous alignment names the policy that granted it', {});
  const { kind, anchor_version: anchorVersion } = facts;
  demand((policy.kinds ?? []).includes(kind), 'policy_scope_exceeded',
    'The policy does not cover this artifact kind', { kind, covered: immutable([...(policy.kinds ?? [])]) });
  demand(policy.anchor_version === anchorVersion, 'alignment_stale',
    'The policy was granted under another anchor version',
    { granted: policy.anchor_version, current: anchorVersion });
  return Object.freeze({
    kind,
    identity: alignmentIdentity({ ...facts, user_decision: null }),
    anchor_version: anchorVersion,
    scope_digest: facts.scope_hash,
    approved_by: policy.policy_ref,
    authority: 'policy',
    source: 'project_policy',
    policy_ref: policy.policy_ref,
    user_decision: null,
  });
}

/** The identity a record would have under the facts in force, or null when it cannot have one. */
function identityUnder(facts, record) {
  try {
    return alignmentIdentity({ ...facts, user_decision: record.user_decision ?? null });
  } catch (error) {
    if (error instanceof FlowError) return null;
    throw error;
  }
}

/**
 * Whether the flow may produce the normative artifact, or dispatch the DAG.
 *
 * Fail-closed on purpose: no record is not an approval, a record from an
 * earlier anchor version is not an approval of this one, and a record about
 * another scope is an approval of something else.
 */
export function gateAdmission({ records, facts }) {
  // The facts, the kind among them, are checked by the question this computes:
  // a second check beside it would answer with the same code and the same words.
  alignmentQuestion(facts);
  const { kind } = facts;
  // A record passes when its identity is the one it would have now: the facts
  // in force, with the decision (or the policy) it names.
  const forKind = (records ?? []).filter((record) => record.kind === kind);
  const exact = forKind.find((record) => record.identity === identityUnder(facts, record));
  if (exact) return Object.freeze({ decision: 'proceed', authority: exact.authority, identity: exact.identity });
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
  return gateAdmission({ records: state.records, facts: state.facts });
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
