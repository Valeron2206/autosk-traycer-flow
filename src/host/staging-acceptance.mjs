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
import { demand, digest, immutable } from '../runtime/contracts.mjs';

import { assertPacketDecidable, answerRequest, openRequest } from './decision-queue.mjs';
import { DELIVERY_MODES } from './epic-staging.mjs';
import { verifiedUserDecision } from './user-decision.mjs';

/** The facts an approval has to carry to be an approval of anything. */
export const REQUIRED_FACTS = immutable([
  'project_identity',
  'epic_id',
  'staging_commit_oid',
  'staging_tree_oid',
  'aggregate_record_hash',
  'included_tickets',
  'target_ref',
  'recorded_target_base',
  'delivery_profile_digest',
  'delivery_mode',
  'outstanding_debt',
]);

/** The two facts a squash adds: the commit that lands, and the digest of its recipe. */
export const SQUASH_FACTS = immutable(['target_commit_oid', 'target_commit_recipe_sha256']);

/** The graph step an acceptance resumes at: the `acceptance_missing` row's only step. */
export const RESUME_STEP = Object.freeze({ workflow: 'autosk-planned', step: 'accept_staging' });

const IDENTITY_DOMAIN = 'autosk-flow/staging-identity/v1';
const AUTHORIZATION_PAYLOAD_DOMAIN = 'autosk-flow/integration-authorization-payload/v1';
const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * The facts being accepted, from the staging state and what is in force now.
 *
 * `current` carries what the staging state does not: the delivery profile
 * digest, the delivery mode, the outstanding debt, and under `squash` the
 * target commit (`{ oid, recipe_sha256 }`). The packet shows these facts, the
 * identity is taken over them, and the record repeats them — one list, so the
 * approver is never shown a fact the identity does not bind.
 */
export function acceptanceFacts(state, { deliveryProfileDigest, deliveryMode, outstandingDebt = [], targetCommit } = {}) {
  for (const field of ['staging_commit_oid', 'staging_tree_oid', 'epic_id']) {
    demand(typeof state[field] === 'string' && state[field].length > 0, 'acceptance_missing',
      `An acceptance identity needs ${field}`, { field });
  }
  demand(DELIVERY_MODES.includes(deliveryMode), 'acceptance_missing',
    'An acceptance names the delivery mode it is given for', { delivery_mode: deliveryMode });
  demand(Array.isArray(outstandingDebt), 'acceptance_missing',
    'An acceptance states the outstanding debt, even when there is none', {});
  const facts = {
    project_identity: state.project_identity,
    epic_id: state.epic_id,
    staging_commit_oid: state.staging_commit_oid,
    staging_tree_oid: state.staging_tree_oid,
    aggregate_record_hash: state.aggregate?.record_hash,
    // Sets: a repeat is not a second fact, and the order listed is not a fact
    // about the tree.
    included_tickets: immutable([...new Set(state.receipts.map((receipt) => receipt.ticket_id))].sort()),
    target_ref: state.target_ref,
    recorded_target_base: state.recorded_target_base,
    delivery_profile_digest: deliveryProfileDigest,
    delivery_mode: deliveryMode,
    outstanding_debt: immutable([...new Set(outstandingDebt)].sort()),
  };
  for (const field of REQUIRED_FACTS) {
    const value = facts[field];
    demand(value !== undefined && value !== null, 'acceptance_missing',
      `An acceptance packet states ${field}`, { field });
  }
  if (deliveryMode === 'squash') {
    // A person accepts the exact commit that lands, not only its tree.
    demand(OID.test(targetCommit?.oid ?? '') && SHA256.test(targetCommit?.recipe_sha256 ?? ''), 'acceptance_missing',
      'A squash acceptance names the squash commit and the digest of its recipe', {});
    facts.target_commit_oid = targetCommit.oid;
    facts.target_commit_recipe_sha256 = targetCommit.recipe_sha256;
  } else {
    demand(targetCommit === undefined, 'acceptance_missing',
      `A ${deliveryMode} delivery names no target commit`, { delivery_mode: deliveryMode });
  }
  return Object.freeze(facts);
}

/**
 * The identity being accepted.
 *
 * Every fact the packet shows is in it, so "the approval is stale" and
 * "something it was about has changed" are the same statement. It is the
 * domain-separated canonical digest (`digest` in `src/runtime/contracts.mjs`),
 * not a hash of `JSON.stringify`, whose bytes depend on key order and could be
 * read as another record's digest.
 */
export function stagingIdentity(state, current) {
  return digest(IDENTITY_DOMAIN, acceptanceFacts(state, current));
}

/**
 * The packet an operator answers.
 *
 * Two options and their consequences, because "approve?" with one button is not
 * a decision. The refusal is named as an outcome rather than left as the
 * absence of an approval, so a declined Epic is a recorded state and not a
 * silence. It parks with the graph's `acceptance_missing` and resumes at the
 * one step that row permits.
 */
export function acceptancePacket(state, { requestId, approver, expiresAt, anchorVersion, operationId, ...current }) {
  const facts = acceptanceFacts(state, current);
  demand(typeof operationId === 'string' && operationId.length > 0, 'acceptance_missing',
    'An acceptance packet names the operation it resumes', {});
  const request = {
    request_id: requestId,
    project_identity: state.project_identity,
    park_reason: 'acceptance_missing',
    required_approver: approver,
    expires_at: expiresAt,
    state: 'pending',
    resume_target: { ...RESUME_STEP, operation_id: operationId },
    flags: { irreversible: true },
    identities: { anchor_version: anchorVersion, candidate: digest(IDENTITY_DOMAIN, facts) },
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

/** The acceptance record `epic-staging.schema.json` closes, for one kind of acceptor. */
function acceptanceRecord(facts, acceptor) {
  return Object.freeze({
    ...acceptor,
    staging_commit_oid: facts.staging_commit_oid,
    staging_tree_oid: facts.staging_tree_oid,
    aggregate_record_hash: facts.aggregate_record_hash,
    included_tickets: facts.included_tickets,
    target_ref: facts.target_ref,
    recorded_target_base: facts.recorded_target_base,
    delivery_profile_digest: facts.delivery_profile_digest,
    delivery_mode: facts.delivery_mode,
    ...(facts.delivery_mode === 'squash'
      ? { target_commit_oid: facts.target_commit_oid, target_commit_recipe_sha256: facts.target_commit_recipe_sha256 }
      : {}),
  });
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
export function acceptanceFromDecision(state, request, response, { nowMs, verifySignature, ...current }) {
  const { request: answered, decision, effect } = answerRequest(request, response, { nowMs, verifySignature });
  const facts = acceptanceFacts(state, current);
  demand(decision.identities.candidate === digest(IDENTITY_DOMAIN, facts), 'acceptance_stale',
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
    // The decision record names who answered and when; the acceptance names
    // that record.
    acceptance: acceptanceRecord(facts, { kind: 'human', decision_id: decision.decision_digest }),
  });
}

/**
 * What the UserDecisionRecord behind an IntegrationAuthorizationRecord signs:
 * every field of the record but the two that name that decision.
 */
export function authorizationPayloadHash(authorization) {
  const { user_decision_record_id: _id, user_decision_record_hash: _hash, ...signed } = authorization;
  return digest(AUTHORIZATION_PAYLOAD_DOMAIN, signed);
}

/**
 * The signed IntegrationAuthorizationRecord a pinned auto-policy carries (ADR-088).
 *
 * `integration-authorization.md` §1: the record is always required for the
 * Epic CAS, and for a pinned auto-policy the user signed it in advance. So the
 * record must name the UserDecisionRecord presented beside it, that record must
 * verify and must have signed exactly this authorization about exactly this
 * identity, and the authorization must be for this project, Epic, target and
 * the one transition from the recorded base to the commit that lands. A
 * missing or unsigned record is `acceptance_missing`, and one that is about
 * something else, terminal or expired is `acceptance_stale` (§5, for an Epic).
 * With no verifier handed in — the product today — it is always refused.
 */
function assertAuthorized(policy, facts, identity, { nowMs, verifySignature, anchorVersion }) {
  const authorization = policy.authorization;
  demand(authorization !== null && typeof authorization === 'object', 'acceptance_missing',
    'A pinned auto-policy carries the signed IntegrationAuthorizationRecord it was given (ADR-088)', {});
  // The schema leaves `issued_by` optional; the host takes a record for one a
  // user decision issued only when it says so.
  demand(authorization.issued_by === 'user_decision_record', 'acceptance_missing',
    'An IntegrationAuthorizationRecord is issued by a signed user decision', { issued_by: authorization.issued_by });
  const record = policy.user_decision_record;
  const signed = verifiedUserDecision(record, { code: 'acceptance_missing', verifySignature });
  // A record that names no decision names none of the verified record's id or digest.
  demand(signed.record_id === authorization.user_decision_record_id
    && signed.record_hash === authorization.user_decision_record_hash, 'acceptance_missing',
  'The authorization names another UserDecisionRecord', { named: authorization.user_decision_record_id });
  demand(record.payload_hash === authorizationPayloadHash(authorization), 'acceptance_missing',
    'The UserDecisionRecord did not sign this authorization', { record_id: authorization.record_id });
  demand(record.subject_hash === identity, 'acceptance_stale',
    'The authorization was signed for another staging identity', { signed: record.subject_hash });
  const transition = authorization.ref_transition;
  const landing = facts.target_commit_oid ?? facts.staging_commit_oid;
  const project = `sha256:${authorization.project_root_sha256}`;
  demand(project === facts.project_identity && record.project_root_sha256 === authorization.project_root_sha256
    && authorization.epic_id === facts.epic_id && record.epic_id === facts.epic_id
    && authorization.target_ref === facts.target_ref,
  'acceptance_stale', 'The authorization is for another project, Epic or target', {});
  demand(record.anchor_version === anchorVersion, 'acceptance_stale',
    'The authorization was signed under another anchor version', { signed: record.anchor_version, current: anchorVersion });
  demand(authorization.initial_target_oid === facts.recorded_target_base
    && transition?.from_oid === facts.recorded_target_base && transition?.to_oid === landing
    && authorization.final_tree_oid === facts.staging_tree_oid,
  'acceptance_stale', 'The authorization is for another transition than the recorded base to the commit that lands',
  { to_oid: transition?.to_oid });
  // Signed as terminal, or expired by now. A revocation made after signing
  // changes the record's bytes, so that copy was refused above as unsigned; one
  // the host never sees is enforced by `integrateApproved` against the
  // authorization head (IA §5), not here.
  demand(authorization.terminal_disposition === 'active' && Date.parse(authorization.expires_at) > nowMs,
    'acceptance_stale', 'The authorization is terminal or has expired',
    { terminal_disposition: authorization.terminal_disposition, expires_at: authorization.expires_at });
}

/**
 * A pinned auto-policy, held to the same binding as a person.
 *
 * The policy names the identity it was pinned to and what it tolerates. One
 * that accepted an identity it never saw is not a policy, it is a default, and
 * debt outside what it names is not something it agreed to. Its authority is
 * the signed IntegrationAuthorizationRecord it carries, not its own pin.
 */
export function autoPolicyAcceptance(state, policy, { nowMs, verifySignature, anchorVersion, ...current } = {}) {
  demand(typeof policy?.policy_ref === 'string' && policy.policy_ref.length > 0, 'acceptance_missing',
    'An auto-policy names the policy that pinned it', {});
  const facts = acceptanceFacts(state, current);
  // Debt first: a policy is refused for debt it never agreed to before it is
  // compared with an identity that, binding the debt, could not match anyway.
  const tolerated = new Set(policy.tolerated_debt ?? []);
  const untolerated = facts.outstanding_debt.filter((item) => !tolerated.has(item));
  demand(untolerated.length === 0, 'acceptance_missing',
    'The outstanding debt is not what the policy agreed to',
    { debt: immutable(untolerated) });
  const identity = digest(IDENTITY_DOMAIN, facts);
  demand(policy.pinned_identity === identity, 'acceptance_stale',
    'The policy was pinned to another staging identity',
    { pinned: policy.pinned_identity });
  assertAuthorized(policy, facts, identity, { nowMs, verifySignature, anchorVersion });
  return acceptanceRecord(facts, { kind: 'pinned_auto_policy', policy_ref: policy.policy_ref });
}
