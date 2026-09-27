/** The human decision queue: opening a request, answering it, and the status projection.
 *
 * Parked with no packet, the user sees that something stopped and has to
 * reconstruct what happened, what may be decided and what will resume — from
 * comments each step wrote in its own words. This is the queue side of #35's
 * contract: requests are immutable once written, an answer is bound to the
 * identity it was asked about, a duplicate answer produces the same record and
 * no second effect, and the status is a view of records rather than a ledger.
 *
 * Storage is injected. Nothing here decides anything on the user's behalf.
 *
 * Implements: docs/contracts/human-decision.md
 */
import { createHash } from 'node:crypto';

import { demand, immutable } from '../runtime/contracts.mjs';

import { decisionPayloadHash, verifiedUserDecision } from './user-decision.mjs';

export const REQUEST_STATES = immutable(['pending', 'answered', 'voided', 'expired']);

/** The identity fields an answer is bound to. A change in any of them means the
 * answer is about a different question, not a stale answer to the same one. */
export const BOUND_IDENTITIES = immutable(['anchor_version', 'candidate']);

/** Markers of a raw transcript. A packet is read in a terminal, pasted into
 * chat and kept, so an excerpt in it has left the boundary it lived behind. */
const TRANSCRIPT_HINTS = [
  // Written against the value as a reader would see it, and tolerant of one
  // level of escaping, because a pasted fragment often arrives already escaped.
  /\\?"(?:role|type)\\?"\s*:\s*\\?"(?:assistant|user|system|tool_use|tool_result)\\?"/u,
  /(?:^|\n)\s*(?:Human|Assistant):\s/mu,
];

/** Every string a packet carries, at any depth.
 *
 * The scan runs over the values rather than over `JSON.stringify(packet)`: in
 * the serialised form the quote depth depends on how the fragment was pasted,
 * and a pattern that matches one depth silently misses the others while
 * reading like a working check.
 */
export function packetStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(packetStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(packetStrings);
  return [];
}

const digest = (value) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

/** Refuses a packet that is missing what makes it decidable, or carries what it must not.
 *
 * The two load-bearing fields are checked here rather than left to the schema:
 * a packet without "why the automation may not decide" reads as a request for
 * permission to do something obvious, and options without consequences ask the
 * user to choose between words.
 */
export function assertPacketDecidable(request) {
  demand(typeof request.why_automation_may_not_decide === 'string'
    && request.why_automation_may_not_decide.trim().length >= 16,
  'decision_packet_incomplete', 'A packet says why the automation may not decide',
  { request_id: request.request_id });
  demand(Array.isArray(request.options) && request.options.length >= 2,
    'decision_packet_incomplete', 'A packet offers at least two options',
    { request_id: request.request_id });
  for (const option of request.options) {
    demand(typeof option.consequence === 'string' && option.consequence.trim().length >= 10,
      'decision_packet_incomplete', 'Every option states its consequence',
      { request_id: request.request_id, option_id: option.option_id });
  }
  for (const text of packetStrings(request)) {
    for (const hint of TRANSCRIPT_HINTS) {
      demand(!hint.test(text), 'decision_packet_contains_transcript',
        'A packet carries no raw transcript', { request_id: request.request_id });
    }
  }
  return request;
}

/** Opens a request. The id is minted before the write, so a crash between the
 * two is a replay rather than a second request. */
export function openRequest(request, { nowMs }) {
  assertPacketDecidable(request);
  demand(request.state === 'pending', 'decision_packet_incomplete',
    'A new request is pending', { state: request.state });
  demand(Date.parse(request.expires_at) > nowMs, 'decision_expired',
    'A request opens with an expiry in the future', { request_id: request.request_id });
  return Object.freeze({ ...request });
}

/** The current state of a request, computed rather than stored. */
export function requestState(request, nowMs) {
  if (request.state === 'voided') return 'voided';
  if (request.answer) return 'answered';
  if (Date.parse(request.expires_at) <= nowMs) return 'expired';
  return 'pending';
}

/**
 * Applies an answer.
 *
 * Returns `{ request, decision, effect }` where `effect` is `applied` for the
 * first answer and `replayed` for an identical repeat. A duplicate answer is
 * idempotent: the same answer to the same request produces the same decision
 * record and no second side effect.
 *
 * An answer is a daemon UserDecisionRecord (ADR-023), never a name: who
 * answered is the role `verifySignature` gives the key that signed it, and when
 * is the record's `issued_at`. The record must answer this request, in this
 * project, about this candidate, and must have signed exactly this answer.
 * With no verifier handed in — the product today, since the pinned daemon
 * reports no signer — every answer is refused.
 */
export function answerRequest(request, response, { nowMs, verifySignature }) {
  const state = requestState(request, nowMs);
  demand(state !== 'voided', 'decision_request_voided', 'The request was voided',
    { request_id: request.request_id });
  demand(state !== 'expired', 'decision_expired', 'The request has expired',
    { request_id: request.request_id });
  // A name the answer gives itself is the authority model debt 10e removed:
  // any process that knew the approver string could answer.
  demand(response.answered_by === undefined, 'decision_approver_mismatch',
    'An answer does not name its own approver; the daemon UserDecisionRecord does',
    { request_id: request.request_id });
  const signed = verifiedUserDecision(response.user_decision_record,
    { code: 'decision_approver_mismatch', verifySignature });
  demand(signed.role === request.required_approver, 'decision_approver_mismatch',
    'The answer is not from the required approver',
    { request_id: request.request_id, required: request.required_approver });
  const option = request.options.find((entry) => entry.option_id === response.option_id);
  demand(Boolean(option), 'decision_option_unknown', 'The answer names an option the packet did not offer',
    { request_id: request.request_id, option_id: response.option_id });
  // An answer to a question about a candidate that has since changed is not a
  // stale answer to the same question; it is an answer to a different one.
  for (const field of BOUND_IDENTITIES) {
    demand(response.identities?.[field] === request.identities[field], 'decision_identity_stale',
      `The ${field} moved since the question was asked`,
      { request_id: request.request_id, field, asked: request.identities[field], answered: response.identities?.[field] });
  }
  const record = response.user_decision_record;
  demand(record.request_id === request.request_id
    && `sha256:${record.project_root_sha256}` === request.project_identity,
  'decision_identity_stale', 'The UserDecisionRecord answers another request or project',
  { request_id: request.request_id, answered: record.request_id });
  // Issued while the question stood: not after now, and not before the packet
  // was created when it says when. Not after its expiry follows: an expired
  // request was refused above, so now — and the record — is before it.
  const issued = Date.parse(record.issued_at);
  demand(issued <= nowMs && (request.created_at === undefined || issued >= Date.parse(request.created_at)),
    'decision_identity_stale', 'The UserDecisionRecord was not issued while the question stood',
    { request_id: request.request_id, issued_at: record.issued_at });
  demand(record.anchor_version === request.identities.anchor_version
    && record.subject_hash === request.identities.candidate,
  'decision_identity_stale', 'The UserDecisionRecord was signed about another candidate',
  { request_id: request.request_id });
  // Free text is normalised, and a normalisation that changes material scope is
  // confirmed: silently interpreting free text is how "sure, but only for the
  // docs" becomes an approval for everything.
  demand(!response.normalized_from || response.confirmed_material_scope === true
    || option.irreversible !== true,
  'decision_packet_incomplete', 'A normalised free-text answer to an irreversible option needs confirmation',
  { request_id: request.request_id });

  const payload = {
    option_id: response.option_id,
    identities: { ...response.identities },
    ...(response.normalized_from !== undefined ? { normalized_from: response.normalized_from } : {}),
    ...(response.confirmed_material_scope !== undefined
      ? { confirmed_material_scope: response.confirmed_material_scope }
      : {}),
  };
  demand(record.payload_hash === decisionPayloadHash(payload), 'decision_approver_mismatch',
    'The UserDecisionRecord signed another answer', { request_id: request.request_id });
  const answer = {
    ...payload,
    answered_by: signed.role,
    answered_at: record.issued_at,
    user_decision_record_id: signed.record_id,
    user_decision_record_hash: signed.record_hash,
    user_decision_provenance_hash: signed.provenance_hash,
  };
  if (request.answer) {
    // The same answer under another record is a second decision about a
    // question already decided, not an answer naming an unknown option.
    demand(request.answer.option_id !== answer.option_id
      || request.answer.user_decision_record_id === answer.user_decision_record_id,
    'decision_identity_stale', 'The request was already answered by another UserDecisionRecord',
    { request_id: request.request_id });
    const same = digest(request.answer) === digest(answer);
    demand(same, 'decision_option_unknown', 'The request already carries a different answer',
      { request_id: request.request_id });
    return { request, decision: decisionRecord(request, request.answer), effect: 'replayed' };
  }
  const answered = Object.freeze({ ...request, state: 'answered', answer });
  return { request: answered, decision: decisionRecord(answered, answer), effect: 'applied' };
}

/** The immutable record an answer becomes. It names the resume target, so the
 * decision is actionable without re-reading the packet. */
export function decisionRecord(request, answer) {
  return Object.freeze({
    request_id: request.request_id,
    project_identity: request.project_identity,
    option_id: answer.option_id,
    answered_by: answer.answered_by,
    answered_at: answer.answered_at,
    identities: { ...answer.identities },
    user_decision_record_id: answer.user_decision_record_id,
    user_decision_record_hash: answer.user_decision_record_hash,
    user_decision_provenance_hash: answer.user_decision_provenance_hash,
    resume_target: request.resume_target,
    decision_digest: digest({ request_id: request.request_id, answer }),
  });
}

/** Voids a pending request. A correction updates or voids rather than racing. */
export function voidRequest(request, reason, { nowMs }) {
  demand(requestState(request, nowMs) === 'pending', 'decision_request_voided',
    'Only a pending request can be voided', { request_id: request.request_id });
  demand(typeof reason === 'string' && reason.trim().length > 0, 'decision_packet_incomplete',
    'Voiding a request records why', { request_id: request.request_id });
  return Object.freeze({ ...request, state: 'voided', voided_reason: reason });
}

/**
 * The status projection for one project.
 *
 * A view of records that exist: everything it shows can be traced to one, and a
 * request belonging to another project is not counted, named or hinted at.
 */
export function statusProjection(requests, { projectIdentity, nowMs }) {
  const mine = requests.filter((request) => request.project_identity === projectIdentity);
  const pending = mine.filter((request) => requestState(request, nowMs) === 'pending');
  const projection = Object.freeze({
    project_identity: projectIdentity,
    generated_at: new Date(nowMs).toISOString(),
    pending_decisions: pending.map((request) => Object.freeze({
      request_id: request.request_id,
      park_reason: request.park_reason,
      required_approver: request.required_approver,
      expires_at: request.expires_at,
      irreversible: request.flags.irreversible,
      resume_target: request.resume_target,
    })),
    counts: Object.freeze({
      pending: pending.length,
      answered: mine.filter((request) => requestState(request, nowMs) === 'answered').length,
      expired: mine.filter((request) => requestState(request, nowMs) === 'expired').length,
      voided: mine.filter((request) => requestState(request, nowMs) === 'voided').length,
    }),
    // The next safe action is the oldest pending decision, because nothing that
    // waits on a decision can proceed before it.
    next_safe_action: pending.length > 0
      ? `answer ${pending[0].request_id}`
      : 'no decision is pending',
  });
  // Checked on the way out, not on the way in: the filter above already decides
  // which records are read, so a guard beside it could never fail. What can
  // fail is a field added later that copies something across, and this is the
  // shape of that leak — another project's identity in the emitted view.
  const foreign = new Set(requests
    .map((request) => request.project_identity)
    .filter((identity) => identity !== projectIdentity));
  const emitted = JSON.stringify(projection);
  for (const identity of foreign) {
    demand(!emitted.includes(identity), 'status_cross_project_leak',
      'A projection contains another project', { project_identity: projectIdentity });
  }
  return projection;
}
