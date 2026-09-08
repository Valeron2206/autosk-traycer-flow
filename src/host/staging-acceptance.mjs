/** Acceptance of a staging identity, through the human decision queue.
 *
 * #9 says acceptance is of an identity, not of a plan to produce one, and #35
 * says a question about a candidate that has since changed is a different
 * question. This is the one place those two meet: the packet binds the exact
 * staging identity, so an answer that arrives after the tree moved is refused
 * by the queue rather than applied to something nobody looked at.
 *
 * Nothing here decides anything on the operator's behalf. A pinned auto-policy
 * is held to the same binding as a person, because a policy that accepted an
 * identity it never saw is not a policy, it is a default.
 */
import { createHash } from 'node:crypto';

import { demand, immutable } from '../runtime/contracts.mjs';

import { assertPacketDecidable, answerRequest, openRequest } from './decision-queue.mjs';

/** The eight facts an approval has to carry to be an approval of anything. */
export const REQUIRED_FACTS = immutable([
  'project_identity',
  'epic_id',
  'staging_commit_oid',
  'staging_tree_oid',
  'aggregate_record_hash',
  'tickets',
  'target_ref',
  'recorded_target_base',
  'delivery_profile_digest',
  'outstanding_debt',
]);

/**
 * The identity being accepted.
 *
 * Every load-bearing field is in it, so "the approval is stale" and "something
 * it was about has changed" are the same statement.
 */
export function stagingIdentity(state) {
  for (const field of ['staging_commit_oid', 'staging_tree_oid', 'epic_id']) {
    demand(typeof state[field] === 'string' && state[field].length > 0, 'acceptance_missing',
      `An acceptance identity needs ${field}`, { field });
  }
  return createHash('sha256')
    .update(JSON.stringify({
      project_identity: state.project_identity,
      epic_id: state.epic_id,
      staging_commit_oid: state.staging_commit_oid,
      staging_tree_oid: state.staging_tree_oid,
      aggregate_record_hash: state.aggregate?.record_hash,
      tickets: [...state.receipts.map((receipt) => receipt.ticket_id)].sort(),
      target_ref: state.target_ref,
      recorded_target_base: state.recorded_target_base,
    }), 'utf8')
    .digest('hex');
}

/**
 * The packet an operator answers.
 *
 * Two options and their consequences, because "approve?" with one button is not
 * a decision. The refusal is named as an outcome rather than left as the
 * absence of an approval, so a declined Epic is a recorded state and not a
 * silence.
 */
export function acceptancePacket(state, { requestId, approver, expiresAt, anchorVersion, deliveryProfileDigest, outstandingDebt = [] }) {
  const tickets = [...state.receipts.map((receipt) => receipt.ticket_id)].sort();
  const facts = {
    project_identity: state.project_identity,
    epic_id: state.epic_id,
    staging_commit_oid: state.staging_commit_oid,
    staging_tree_oid: state.staging_tree_oid,
    aggregate_record_hash: state.aggregate?.record_hash,
    tickets,
    target_ref: state.target_ref,
    recorded_target_base: state.recorded_target_base,
    delivery_profile_digest: deliveryProfileDigest,
    outstanding_debt: immutable([...outstandingDebt]),
  };
  for (const field of REQUIRED_FACTS) {
    const value = facts[field];
    demand(value !== undefined && value !== null, 'acceptance_missing',
      `An acceptance packet states ${field}`, { field });
  }
  const request = {
    request_id: requestId,
    project_identity: state.project_identity,
    park_reason: 'acceptance_missing',
    required_approver: approver,
    expires_at: expiresAt,
    state: 'pending',
    resume_target: 'final_cas',
    flags: { irreversible: true },
    identities: { anchor_version: anchorVersion, candidate: stagingIdentity(state) },
    why_automation_may_not_decide:
      'Advancing the target branch is the one step this flow cannot undo by retrying.',
    options: [
      {
        option_id: 'accept',
        irreversible: true,
        consequence: `The target ${state.target_ref} advances once, from ${state.recorded_target_base} to the accepted staging commit.`,
      },
      {
        option_id: 'refuse',
        consequence: 'The target branch stays where it is and the Epic is recorded as declined.',
      },
    ],
    facts,
  };
  assertPacketDecidable(request);
  return request;
}

/** Opens the packet, with the queue's own rules about expiry and completeness. */
export function openAcceptance(state, options, { nowMs }) {
  return openRequest(acceptancePacket(state, options), { nowMs });
}

/**
 * Turns an answer into the acceptance record, or into a refusal.
 *
 * The queue has already refused an answer whose bound identities moved; what is
 * added here is that the record is rebuilt from the *current* state and
 * compared, so a record cannot be assembled from the answer alone.
 */
export function acceptanceFromDecision(state, request, response, { nowMs }) {
  const { request: answered, decision, effect } = answerRequest(request, response, { nowMs });
  demand(decision.identities.candidate === stagingIdentity(state), 'acceptance_stale',
    'The staging identity moved between the question and the record',
    { asked: decision.identities.candidate });
  if (decision.option_id === 'refuse') {
    return Object.freeze({ outcome: 'refused', request: answered, decision, effect });
  }
  demand(decision.option_id === 'accept', 'acceptance_missing',
    'The answer is neither an acceptance nor a refusal', { option_id: decision.option_id });
  return Object.freeze({
    outcome: 'accepted',
    request: answered,
    decision,
    effect,
    acceptance: Object.freeze({
      kind: 'human',
      approver: decision.answered_by,
      decided_at: decision.answered_at,
      decision_digest: decision.decision_digest,
      staging_commit_oid: state.staging_commit_oid,
      staging_tree_oid: state.staging_tree_oid,
      aggregate_record_hash: state.aggregate?.record_hash,
      tickets: immutable([...state.receipts.map((receipt) => receipt.ticket_id)].sort()),
    }),
  });
}

/**
 * A pinned auto-policy, held to the same binding as a person.
 *
 * The policy names the identity it was pinned to and what it tolerates. One
 * that accepted an identity it never saw is not a policy, it is a default, and
 * debt outside what it names is not something it agreed to.
 */
export function autoPolicyAcceptance(state, policy, { outstandingDebt = [] } = {}) {
  demand(typeof policy?.policy_ref === 'string' && policy.policy_ref.length > 0, 'acceptance_missing',
    'An auto-policy names the policy that pinned it', {});
  demand(policy.pinned_identity === stagingIdentity(state), 'acceptance_stale',
    'The policy was pinned to another staging identity',
    { pinned: policy.pinned_identity });
  const tolerated = new Set(policy.tolerated_debt ?? []);
  const untolerated = outstandingDebt.filter((item) => !tolerated.has(item));
  demand(untolerated.length === 0, 'acceptance_missing',
    'The outstanding debt is not what the policy agreed to',
    { debt: immutable(untolerated) });
  return Object.freeze({
    kind: 'auto_policy',
    policy_ref: policy.policy_ref,
    staging_commit_oid: state.staging_commit_oid,
    staging_tree_oid: state.staging_tree_oid,
    aggregate_record_hash: state.aggregate?.record_hash,
    tickets: immutable([...state.receipts.map((receipt) => receipt.ticket_id)].sort()),
  });
}
