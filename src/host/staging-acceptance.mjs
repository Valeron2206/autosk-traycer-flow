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
import { DELIVERY_MODES, integrationAuthorizationHash } from './epic-staging.mjs';
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
  'controlling_anchor_digest',
  'relevant_authority_projection_hash',
  'dependency_head_hash',
  'intent_head_hash',
]);

/**
 * The controlling anchor digest and the three heads the acceptance is asked
 * under (debt 11b, R7-30): what the IntegrationAuthorizationRecord binds and
 * `integrateApproved` compares before the CAS. The identity binds them too, so
 * an answer given under other heads is an answer to another question.
 */
export const HEAD_FACTS = immutable([
  'controlling_anchor_digest',
  'relevant_authority_projection_hash',
  'dependency_head_hash',
  'intent_head_hash',
]);

/** The two facts a squash adds: the commit that lands, and the digest of its recipe. */
export const SQUASH_FACTS = immutable(['target_commit_oid', 'target_commit_recipe_sha256']);

/** The graph step an acceptance resumes at: the `acceptance_missing` row's only step. */
export const RESUME_STEP = Object.freeze({ workflow: 'autosk-planned', step: 'accept_staging' });

const IDENTITY_DOMAIN = 'autosk-flow/staging-identity/v1';
const AUTHORIZATION_PAYLOAD_DOMAIN = 'autosk-flow/integration-authorization-payload/v1';
const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const named = (value) => typeof value === 'string' && value.length > 0;

/**
 * The facts being accepted, from the staging state and what is in force now.
 *
 * `current` carries what the staging state does not: the delivery profile
 * digest, the delivery mode, the outstanding debt, the controlling anchor
 * digest and the three heads in force (`heads`, keyed by `HEAD_FACTS`), and
 * under `squash` the target commit (`{ oid, recipe_sha256 }`). The packet shows these facts, the
 * identity is taken over them, and the record repeats them — one list, so the
 * approver is never shown a fact the identity does not bind.
 */
export function acceptanceFacts(state, { deliveryProfileDigest, deliveryMode, outstandingDebt = [], targetCommit, heads } = {}) {
  for (const field of ['staging_commit_oid', 'staging_tree_oid', 'epic_id']) {
    demand(typeof state[field] === 'string' && state[field].length > 0, 'acceptance_missing',
      `An acceptance identity needs ${field}`, { field });
  }
  demand(DELIVERY_MODES.includes(deliveryMode), 'acceptance_missing',
    'An acceptance names the delivery mode it is given for', { delivery_mode: deliveryMode });
  demand(Array.isArray(outstandingDebt), 'acceptance_missing',
    'An acceptance states the outstanding debt, even when there is none', {});
  demand(heads !== null && typeof heads === 'object'
    && Object.keys(heads).length === HEAD_FACTS.length
    && HEAD_FACTS.every((field) => SHA256.test(heads[field] ?? '')), 'acceptance_missing',
  'An acceptance names the controlling anchor digest and the authority, dependency and intent heads it is asked under',
  { fields: HEAD_FACTS });
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
    controlling_anchor_digest: heads.controlling_anchor_digest,
    relevant_authority_projection_hash: heads.relevant_authority_projection_hash,
    dependency_head_hash: heads.dependency_head_hash,
    intent_head_hash: heads.intent_head_hash,
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
 * The IntegrationAuthorizationRecord for this identity, composed before the
 * question (debt 11b, `docs/contracts/integration-authorization.md` §1).
 *
 * One mechanism for both paths: the record is composed here from the staging
 * state, the facts the identity binds and what the plan names that neither
 * does — the record and run ids, the integration plan and classifier proof
 * digests, the authorization head it chains from and its expiry — and its
 * payload (`authorizationPayloadHash`) is what the user's UserDecisionRecord
 * signs. The verified decision then completes it with its own id and digest.
 * The host composes and verifies; the daemon stores and chains it under
 * `integration_authorization_head` (ADR-023), and `integrateApproved` checks
 * the heads it names against the ones in force before the CAS.
 */
export function composeAuthorization(state, {
  recordId, runId, integrationPlanHash, classifierProofHash, previousAuthorizationHeadHash, expiresAt, ...current
} = {}) {
  const facts = acceptanceFacts(state, current);
  const project = /^sha256:([a-f0-9]{64})$/u.exec(facts.project_identity);
  demand(project !== null, 'acceptance_missing', 'The record names the project root it is for',
    { project_identity: facts.project_identity });
  const commits = state.receipts.map((receipt) => receipt.applied_commit_oid);
  demand(commits.length > 0 && commits.every((commit) => OID.test(commit ?? '')), 'acceptance_missing',
    'The record names the commit each applied Ticket was applied as, in the order applied', {});
  demand(named(recordId) && named(runId), 'acceptance_missing', 'The record names itself and its run', {});
  demand(SHA256.test(integrationPlanHash ?? '') && SHA256.test(classifierProofHash ?? ''), 'acceptance_missing',
    'The record names the integration plan and the classifier proof it was composed from', {});
  demand(previousAuthorizationHeadHash === null || SHA256.test(previousAuthorizationHeadHash ?? ''), 'acceptance_missing',
    'The record names the authorization head it chains from, or null for the first', {});
  demand(typeof expiresAt === 'string' && RFC3339.test(expiresAt) && !Number.isNaN(Date.parse(expiresAt)),
    'acceptance_missing', 'The record names when it expires', { expires_at: expiresAt });
  return Object.freeze({
    schema_version: 1,
    record_id: recordId,
    scope_id: `epic:${facts.epic_id}`,
    project_root_sha256: project[1],
    epic_id: facts.epic_id,
    run_id: runId,
    target_ref: facts.target_ref,
    initial_target_oid: facts.recorded_target_base,
    ordered_ticket_commit_oids: immutable(commits),
    ref_transition: Object.freeze({
      from_oid: facts.recorded_target_base,
      to_oid: facts.target_commit_oid ?? facts.staging_commit_oid,
    }),
    final_tree_oid: facts.staging_tree_oid,
    integration_plan_hash: integrationPlanHash,
    controlling_anchor_digest: facts.controlling_anchor_digest,
    classifier_proof_hash: classifierProofHash,
    relevant_authority_projection_hash: facts.relevant_authority_projection_hash,
    dependency_head_hash: facts.dependency_head_hash,
    intent_head_hash: facts.intent_head_hash,
    previous_authorization_head_hash: previousAuthorizationHeadHash,
    expires_at: expiresAt,
    terminal_disposition: 'active',
    issued_by: 'user_decision_record',
  });
}

/**
 * Whether a record is about exactly this identity: this project, Epic, scope
 * and target, the one transition from the recorded base to the commit that
 * lands, the accepted tree, the applied commits in order, the controlling
 * anchor digest and the heads the identity binds, and signed as `active`.
 * Anything else is a record for another integration (`acceptance_stale`).
 */
function assertComposedFor(authorization, facts, state) {
  const transition = authorization.ref_transition;
  const landing = facts.target_commit_oid ?? facts.staging_commit_oid;
  demand(`sha256:${authorization.project_root_sha256}` === facts.project_identity
    && authorization.epic_id === facts.epic_id && authorization.scope_id === `epic:${facts.epic_id}`
    && authorization.target_ref === facts.target_ref,
  'acceptance_stale', 'The authorization is for another project, Epic or target', {});
  demand(authorization.initial_target_oid === facts.recorded_target_base
    && transition?.from_oid === facts.recorded_target_base && transition?.to_oid === landing
    && authorization.final_tree_oid === facts.staging_tree_oid,
  'acceptance_stale', 'The authorization is for another transition than the recorded base to the commit that lands',
  { to_oid: transition?.to_oid });
  const commits = state.receipts.map((receipt) => receipt.applied_commit_oid);
  const ordered = authorization.ordered_ticket_commit_oids;
  demand(Array.isArray(ordered) && ordered.length === commits.length && ordered.every((commit, index) => commit === commits[index]),
    'acceptance_stale', 'The authorization names other applied commits, or another order', {});
  const moved = HEAD_FACTS.filter((field) => authorization[field] !== facts[field]);
  demand(moved.length === 0, 'acceptance_stale',
    'The authorization was composed under another controlling anchor or other heads', { fields: immutable(moved) });
  demand(authorization.terminal_disposition === 'active', 'acceptance_stale',
    'The authorization was signed as terminal', { terminal_disposition: authorization.terminal_disposition });
}

/** A record composed for this identity and not yet signed: the one the question presents. */
function assertComposed(authorization, facts, state) {
  demand(authorization !== null && typeof authorization === 'object', 'acceptance_missing',
    'An acceptance packet presents the IntegrationAuthorizationRecord its accept option signs', {});
  demand(authorization.issued_by === 'user_decision_record', 'acceptance_missing',
    'An IntegrationAuthorizationRecord is issued by a signed user decision', { issued_by: authorization.issued_by });
  demand(!Object.hasOwn(authorization, 'user_decision_record_id') && !Object.hasOwn(authorization, 'user_decision_record_hash'),
    'acceptance_missing', 'A record composed before the question names no decision yet', {});
  assertComposedFor(authorization, facts, state);
}

/**
 * The packet an operator answers.
 *
 * Two options and their consequences, because "approve?" with one button is not
 * a decision. The refusal is named as an outcome rather than left as the
 * absence of an approval, so a declined Epic is a recorded state and not a
 * silence. It parks with the graph's `acceptance_missing` and resumes at the
 * one step that row permits.
 *
 * The packet presents the IntegrationAuthorizationRecord composed for this
 * identity (`composeAuthorization`), field by field, and its `accept` option
 * signs that record's payload rather than the answer object (debt 11b): the
 * one irreversible step rests on the record's own fields under the user's
 * signature, as a pinned auto-policy's does.
 */
export function acceptancePacket(state, { requestId, approver, expiresAt, anchorVersion, operationId, authorization, ...current }) {
  const facts = acceptanceFacts(state, current);
  demand(typeof operationId === 'string' && operationId.length > 0, 'acceptance_missing',
    'An acceptance packet names the operation it resumes', {});
  assertComposed(authorization, facts, state);
  // The record outlives the question: one that lapses before the answer is due
  // would be signed for a CAS that could never run under it.
  demand(Date.parse(authorization.expires_at) >= Date.parse(expiresAt), 'acceptance_stale',
    'The IntegrationAuthorizationRecord expires before the question does',
    { expires_at: authorization.expires_at, request_expires_at: expiresAt });
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
        consequence: `The target ${state.target_ref} advances once, from ${state.recorded_target_base} to the accepted staging commit, under the IntegrationAuthorizationRecord ${authorization.record_id} this answer signs, valid until ${authorization.expires_at}.`,
        signed_payload_hash: authorizationPayloadHash(authorization),
      },
      {
        option_id: 'refuse',
        consequence: 'The target branch stays where it is and the Epic is recorded as declined.',
      },
    ],
    facts,
    integration_authorization: authorization,
  };
  assertPacketDecidable(request);
  return request;
}

/** The acceptance record `epic-staging.schema.json` closes, for one kind of acceptor, naming its record. */
function acceptanceRecord(facts, acceptor, authorization) {
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
    integration_authorization_id: authorization.record_id,
    integration_authorization_sha256: integrationAuthorizationHash(authorization),
  });
}

/** Opens the packet, with the queue's own rules about expiry and completeness. */
export function openAcceptance(state, options, { nowMs }) {
  return openRequest(acceptancePacket(state, options), { nowMs });
}

/**
 * Turns an answer into the acceptance record and the IntegrationAuthorizationRecord
 * it stands on, or into a refusal.
 *
 * The queue has already refused an answer whose bound identities moved, and an
 * `accept` whose UserDecisionRecord did not sign the presented record's
 * payload; what is added here is that the record is rebuilt from the *current*
 * state and compared, so a record cannot be assembled from the answer alone,
 * and that the presented record, completed with the verified decision's id and
 * digest, passes exactly the check a pinned auto-policy's record does
 * (`assertAuthorized`). The acceptance names that record by id and digest, and
 * the completed record is returned for the daemon to store and chain.
 */
export function acceptanceFromDecision(state, request, response, { nowMs, verifySignature, anchorVersion, ...current }) {
  const { request: answered, decision, effect } = answerRequest(request, response, { nowMs, verifySignature });
  const facts = acceptanceFacts(state, current);
  const identity = digest(IDENTITY_DOMAIN, facts);
  demand(decision.identities.candidate === identity, 'acceptance_stale',
    'The staging identity moved between the question and the record',
    { asked: decision.identities.candidate });
  if (decision.option_id === 'refuse') {
    return Object.freeze({ outcome: 'refused', request: answered, decision, effect });
  }
  demand(decision.option_id === 'accept', 'acceptance_missing',
    'The answer is neither an acceptance nor a refusal', { option_id: decision.option_id });
  // A packet that presented no record leaves one naming only the decision,
  // which the check below refuses as not issued by a user decision.
  const authorization = Object.freeze({
    ...answered.integration_authorization,
    user_decision_record_id: decision.user_decision_record_id,
    user_decision_record_hash: decision.user_decision_record_hash,
  });
  assertAuthorized({ authorization, user_decision_record: response.user_decision_record }, facts, state, identity,
    // The anchor version in force now, not the one the packet recorded: the
    // decision was about the latter, and an anchor that moved since is stale.
    { nowMs, verifySignature, anchorVersion });
  return Object.freeze({
    outcome: 'accepted',
    request: answered,
    decision,
    effect,
    // The decision record names who answered and when; the acceptance names
    // that record and the IntegrationAuthorizationRecord it signed.
    acceptance: acceptanceRecord(facts, { kind: 'human', decision_id: decision.decision_digest }, authorization),
    authorization,
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
 * The signed IntegrationAuthorizationRecord an acceptance stands on (ADR-088,
 * debt 11b), on either path.
 *
 * `integration-authorization.md` §1: the record is always required for the
 * Epic CAS. The record must name the UserDecisionRecord presented beside it,
 * that record must verify and must have signed exactly this authorization
 * about exactly this identity, and the authorization must be the one composed
 * for this identity (`assertComposedFor`). A missing or unsigned record is
 * `acceptance_missing`, and one that is about something else, terminal or
 * expired is `acceptance_stale` (§5, for an Epic). With no verifier handed in —
 * the product today — it is always refused.
 */
function assertAuthorized(policy, facts, state, identity, { nowMs, verifySignature, anchorVersion }) {
  const authorization = policy.authorization;
  demand(authorization !== null && typeof authorization === 'object', 'acceptance_missing',
    'An acceptance stands on the signed IntegrationAuthorizationRecord it was given (ADR-088)', {});
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
  demand(record.project_root_sha256 === authorization.project_root_sha256 && record.epic_id === facts.epic_id,
    'acceptance_stale', 'The decision is of another project or Epic', {});
  demand(record.anchor_version === anchorVersion, 'acceptance_stale',
    'The authorization was signed under another anchor version', { signed: record.anchor_version, current: anchorVersion });
  assertComposedFor(authorization, facts, state);
  // Expired by now. A revocation made after signing changes the record's
  // bytes, so that copy was refused above as unsigned; one the host never sees
  // is enforced by `integrateApproved` against the authorization head (IA §5),
  // not here.
  demand(Date.parse(authorization.expires_at) > nowMs, 'acceptance_stale', 'The authorization has expired',
    { expires_at: authorization.expires_at });
}

/**
 * A pinned auto-policy, held to the same binding as a person.
 *
 * The policy names the identity it was pinned to and what it tolerates. One
 * that accepted an identity it never saw is not a policy, it is a default, and
 * debt outside what it names is not something it agreed to. Its authority is
 * the signed IntegrationAuthorizationRecord it carries, not its own pin: the
 * same record, composed the same way (`composeAuthorization`) and signed the
 * same way, as a person's acceptance produces. "In advance" means before this
 * acceptance step, for this exact identity — which exists only once the
 * aggregate has passed — never before the staging it names (R7-15).
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
  assertAuthorized(policy, facts, state, identity, { nowMs, verifySignature, anchorVersion });
  return acceptanceRecord(facts, { kind: 'pinned_auto_policy', policy_ref: policy.policy_ref }, policy.authorization);
}
