/** Epic staging: approved Tickets accumulate privately, and the target moves once.
 *
 * Moving the target once per Ticket looks simpler and is not. Two Tickets that
 * are individually green can regress together, and by the time the second is
 * integrated the first is already on the user's branch. Aggregate verification
 * exists because *individually green* is not a property of the set.
 *
 * Everything here is about one sentence: a PASS is about a tree, not about an
 * intention. Acceptance is of an identity, not of a plan to produce one.
 */

import { demand, digest, immutable, oneObjectFormat } from '../runtime/contracts.mjs';

export const PHASES = immutable([
  'staging_created',
  'deltas_applied',
  'aggregate_verified',
  'accepted',
  'target_advanced',
  'post_cas_verified',
]);

export const PARK_REASONS = immutable([
  'aggregate_failed',
  'aggregate_binding_void',
  'staging_moved_after_pass',
  'foreign_target_movement',
  'acceptance_missing',
  'acceptance_stale',
  'cas_conflict',
  'post_cas_mismatch',
  'environment_failure',
  'receipt_missing',
]);

const AGGREGATE_RECORD_DOMAIN = 'autosk-flow/aggregate-record/v1';

/**
 * The digest an aggregate record is named by, and the acceptance binds.
 *
 * It covers the whole record the staging schema closes — the staging commit
 * and tree, the verification configuration and instruction-lock digests, the
 * included Tickets and the outcome — and the project and Epic the record
 * belongs to (`owner`, the staging state), domain-separated and canonical
 * (debt 11e, ADR-099). The acceptance's `aggregate_record_hash` is this
 * digest, so it binds the tree a PASS ran on and the configuration and lock
 * it ran under, not only that a PASS happened: a record's binding is its hash,
 * and there is no second field for it.
 */
export function aggregateRecordHash(owner, aggregate) {
  return digest(AGGREGATE_RECORD_DOMAIN, {
    project: owner.project_identity,
    epic_id: owner.epic_id,
    staging_commit_oid: aggregate.staging_commit_oid,
    staging_tree_oid: aggregate.staging_tree_oid,
    verification_config_digest: aggregate.verification_config_digest,
    instruction_lock_digest: aggregate.instruction_lock_digest,
    included_tickets: [...new Set(aggregate.included_tickets)].sort(),
    outcome: aggregate.outcome,
    environment_outcome: aggregate.environment_outcome,
  });
}

/**
 * A Ticket set as one reading of it: a repeat is not a second fact (ADR-089),
 * so every place that compares Ticket sets compares these (review of 11e, L3).
 */
const ticketSet = (list) => [...new Set(list)].sort().join(',');

/** Whether a record's hash recomputes over its own fields; one that cannot be hashed does not. */
function recomputes(owner, aggregate) {
  try {
    return aggregate.record_hash === aggregateRecordHash(owner, aggregate);
  } catch {
    return false;
  }
}

/**
 * Whether the aggregate still describes what would be pushed.
 *
 * Any change to staging after the PASS voids the binding: the record is about
 * the tree it ran on, and a tree that moved is a different subject. So the
 * record must recompute — a record rewritten after its run, another
 * configuration, lock or outcome than the one hashed, is void — and must name
 * this state's staging commit and tree and the Tickets its receipts name.
 */
export function aggregateErrors(state) {
  const errors = [];
  const aggregate = state.aggregate;
  if (!aggregate) return [{ reason: 'aggregate_failed', detail: 'no aggregate record' }];

  // A command failure and an environment failure are different outcomes: only
  // one of them is a statement about the product. Which check failed and what
  // it said is the run's evidence, not the record's (ADR-099).
  if (aggregate.environment_outcome === 'environment_failure') {
    errors.push({ reason: 'environment_failure', detail: 'the machine could not run the checks' });
  } else if (aggregate.outcome !== 'pass') {
    errors.push({ reason: 'aggregate_failed', detail: aggregate.outcome });
  }
  // The Tickets as a set, as the identity reads them.
  const bound = aggregate.staging_commit_oid === state.staging_commit_oid
    && aggregate.staging_tree_oid === state.staging_tree_oid
    && ticketSet(aggregate.included_tickets ?? []) === ticketSet((state.receipts ?? []).map((receipt) => receipt.ticket_id));
  if (!recomputes(state, aggregate) || !bound) {
    errors.push({ reason: 'aggregate_binding_void', detail: 'the record does not recompute over this staging state' });
  }
  if (aggregate.staging_commit_oid !== state.staging_commit_oid) {
    errors.push({ reason: 'staging_moved_after_pass', detail: state.staging_commit_oid });
  }
  return errors;
}

/**
 * Every applied Ticket leaves one durable receipt, or the set is not what it
 * claims.
 *
 * A Ticket with two receipts is refused by name after the missing ones: the
 * set reads it once everywhere, so nothing else would say which receipt stands
 * for it (review of 11e, L3).
 */
export function receiptErrors(state, expectedTickets) {
  const present = new Set(state.receipts.map((receipt) => receipt.ticket_id));
  const seen = new Set();
  const repeated = new Set();
  for (const receipt of state.receipts) {
    if (seen.has(receipt.ticket_id)) repeated.add(receipt.ticket_id);
    seen.add(receipt.ticket_id);
  }
  return [
    ...expectedTickets.filter((ticket) => !present.has(ticket)).map((ticket) => ({ reason: 'receipt_missing', detail: ticket })),
    ...[...repeated].map((ticket) => ({ reason: 'receipt_missing', detail: `${ticket} has more than one integration receipt` })),
  ];
}

/** The delivery modes a profile may allow; the acceptance names the one it is of. */
export const DELIVERY_MODES = immutable(['merge', 'squash', 'rebase', 'pull_request', 'merge_queue', 'fork_pull_request']);

const SHA256 = /^[a-f0-9]{64}$/u;
const named = (value) => typeof value === 'string' && value.length > 0;

const AUTHORIZATION_RECORD_DOMAIN = 'autosk-flow/integration-authorization-record/v1';

/**
 * The digest an acceptance names its IntegrationAuthorizationRecord by: every
 * field of the completed record, the decision that signed it included
 * (`docs/contracts/integration-authorization.md` §3, debt 11b).
 */
export function integrationAuthorizationHash(authorization) {
  return digest(AUTHORIZATION_RECORD_DOMAIN, authorization);
}

/**
 * Whether the record the CAS is asked under is the one the acceptance names,
 * and still backs it (debt 11b).
 *
 * The host checks what it can see: the reference is well formed, the record
 * presented (`current.authorization`) is the one named by id — the same id
 * with other bytes is that record revoked, replaced or rewritten, so stale —
 * it is about this project, Epic, scope, target, one transition, tree and
 * applied commits in order, and it is active and unexpired at `current.nowMs`,
 * which the CAS must name. That the UserDecisionRecord behind it signed
 * it was checked when the acceptance was made (`acceptanceFromDecision`,
 * `autoPolicyAcceptance`); the daemon's `integrateApproved` resolves the record
 * by scope and id from its own store and checks it against
 * `integration_authorization_head`, the authority projection and the
 * dependency and intent heads, none of which the host can read.
 */
function authorizationErrors(state, acceptance, current, missing, stale) {
  if (!named(acceptance.integration_authorization_id) || !SHA256.test(acceptance.integration_authorization_sha256 ?? '')) {
    missing('an acceptance names the IntegrationAuthorizationRecord it stands on');
    return;
  }
  const record = current.authorization;
  if (record === null || typeof record !== 'object' || record.record_id !== acceptance.integration_authorization_id) {
    missing('the CAS is not asked under the IntegrationAuthorizationRecord the acceptance names');
    return;
  }
  if (!Number.isFinite(current.nowMs)) {
    missing('the CAS names the instant it is asked at');
    return;
  }
  // The record named, with other bytes: revoked, replaced or rewritten since
  // the acceptance named it. That is the record lapsing, not a record missing
  // (`integration-authorization.md` §5).
  if (integrationAuthorizationHash(record) !== acceptance.integration_authorization_sha256) {
    stale('the IntegrationAuthorizationRecord the acceptance names has changed since: revoked, replaced or rewritten');
    return;
  }
  const landing = acceptance.delivery_mode === 'squash' ? acceptance.target_commit_oid : state.staging_commit_oid;
  const commits = (state.receipts ?? []).map((receipt) => receipt.applied_commit_oid);
  const ordered = record.ordered_ticket_commit_oids;
  if (`sha256:${record.project_root_sha256}` !== state.project_identity
    || record.epic_id !== state.epic_id || record.scope_id !== `epic:${state.epic_id}` || record.target_ref !== state.target_ref
    || record.initial_target_oid !== state.recorded_target_base
    || record.ref_transition?.from_oid !== state.recorded_target_base || record.ref_transition?.to_oid !== landing
    || record.final_tree_oid !== state.staging_tree_oid
    || !Array.isArray(ordered) || ordered.length !== commits.length || ordered.some((commit, index) => commit !== commits[index])) {
    stale('the IntegrationAuthorizationRecord is for another integration than this staging state');
  }
  if (record.terminal_disposition !== 'active' || !(Date.parse(record.expires_at) > current.nowMs)) {
    stale('the IntegrationAuthorizationRecord is terminal or has expired');
  }
}

/**
 * Whether the acceptance still applies.
 *
 * Acceptance is of an identity: if the staging tree changed afterwards, the
 * acceptance no longer applies to what would be pushed. The record is the one
 * `resources/epic-staging/epic-staging.schema.json` closes: it names the target
 * ref and base and the delivery profile it was given under, and a profile that
 * changed since (`current.deliveryProfileDigest`, the profile in force now) is
 * another delivery — so is a CAS asked without saying which profile is in force.
 * It also names the IntegrationAuthorizationRecord it stands on, which the CAS
 * must be asked under (`current.authorization`, at `current.nowMs`).
 */
export function acceptanceErrors(state, current = {}) {
  const acceptance = state.acceptance;
  if (!acceptance) return [{ reason: 'acceptance_missing', detail: 'nothing was accepted' }];
  const errors = [];
  const missing = (detail) => errors.push({ reason: 'acceptance_missing', detail });
  const stale = (detail) => errors.push({ reason: 'acceptance_stale', detail });
  if (acceptance.kind === 'pinned_auto_policy') {
    // A pinned auto-policy is held to the same binding as a person.
    if (!named(acceptance.policy_ref)) missing('an auto-policy names the policy that pinned it');
  } else if (acceptance.kind === 'human') {
    if (!named(acceptance.decision_id)) missing('a human acceptance names the decision it came from');
  } else {
    missing('an acceptance is by a person or by a pinned auto-policy');
  }
  if (acceptance.staging_commit_oid !== state.staging_commit_oid
    || acceptance.staging_tree_oid !== state.staging_tree_oid) {
    stale('the accepted identity is not the current one');
  }
  if (acceptance.aggregate_record_hash !== state.aggregate?.record_hash) {
    stale('the accepted aggregate record is not the current one');
  }
  // As sets, as the record and the acceptance facts write them (review of 11e, L3).
  if (ticketSet(acceptance.included_tickets ?? []) !== ticketSet(state.receipts.map((receipt) => receipt.ticket_id))) {
    stale('the accepted Ticket set is not the included one');
  }
  if (!named(acceptance.target_ref) || !named(acceptance.recorded_target_base)) {
    missing('an acceptance names the target ref and base it was given against');
  } else if (acceptance.target_ref !== state.target_ref || acceptance.recorded_target_base !== state.recorded_target_base) {
    stale('the acceptance names another target ref or base');
  }
  // Both sides must be digests before they are compared: two absent profiles
  // are equal and say nothing.
  if (!SHA256.test(acceptance.delivery_profile_digest ?? '')) {
    missing('an acceptance names the delivery profile it was given under');
  } else if (typeof current.deliveryProfileDigest !== 'string' || !SHA256.test(current.deliveryProfileDigest)) {
    missing('the CAS names the delivery profile in force');
  } else if (acceptance.delivery_profile_digest !== current.deliveryProfileDigest) {
    stale('the acceptance was given under another delivery profile');
  }
  if (!DELIVERY_MODES.includes(acceptance.delivery_mode)) {
    missing('an acceptance names the delivery mode it was given for');
  } else if (acceptance.delivery_mode === 'squash') {
    // A person accepts the exact commit that lands, not only its tree; its
    // object format is held below with the staging state's.
    if (acceptance.target_commit_oid === undefined || !SHA256.test(acceptance.target_commit_recipe_sha256 ?? '')) {
      missing('a squash acceptance names the squash commit and the digest of its recipe');
    }
  } else if (acceptance.target_commit_oid !== undefined || acceptance.target_commit_recipe_sha256 !== undefined) {
    missing(`a ${acceptance.delivery_mode} delivery names no target commit`);
  }
  // One object format (ADR-098): the base, the staging commit and tree, each
  // commit a Ticket was applied as and, under squash, the commit that lands
  // are objects of one repository, so OIDs of one format, as the identity
  // (acceptanceFacts) and the delivered commit (deliveryCompleted) are. An
  // absent one is no format: its absence is refused where it is required, and
  // the record, which binds the commits, is compared with the receipts below.
  const applied = (state.receipts ?? []).map((receipt) => receipt.applied_commit_oid);
  const landing = acceptance.delivery_mode === 'squash' ? [acceptance.target_commit_oid] : [];
  const oids = [state.recorded_target_base, state.staging_commit_oid, state.staging_tree_oid, ...applied, ...landing]
    .filter((oid) => oid !== undefined);
  if (oneObjectFormat(oids) === null) {
    missing('the base, the staging commit and tree, the applied commits and the commit that lands are OIDs of one object format');
  }
  // Both kinds stand on a signed IntegrationAuthorizationRecord (IA §1).
  authorizationErrors(state, acceptance, current, missing, stale);
  return errors;
}

/**
 * Whether the final CAS may run.
 *
 * There is no per-Ticket intermediate movement of the target — not as an
 * optimisation, not as a fallback — so this is the only place the target moves,
 * and it runs only while the target still holds the recorded base.
 * `current.deliveryProfileDigest` is the delivery profile in force now; the
 * acceptance must have been given under it.
 *
 * This is also the one serialization of two Epics on one target (ADR-099):
 * both may be staged, verified and accepted at once, the first CAS lands, and
 * the other finds the target off its recorded base here.
 */
export function casAdmission(state, observedTarget, expectedTickets = [], current = {}) {
  const reasons = [
    ...receiptErrors(state, expectedTickets),
    ...aggregateErrors(state),
    ...acceptanceErrors(state, current),
  ];
  if (observedTarget.oid === state.post_cas?.expected_new_oid) {
    // Idempotent: if the target already holds the recorded result, the
    // operation is complete rather than in conflict.
    return Object.freeze({ decision: 'already_complete', reasons: immutable(reasons.map(Object.freeze)) });
  }
  if (observedTarget.oid !== state.recorded_target_base) {
    // Off the recorded base and not at this Epic's own result. This Epic
    // moves the target once, by its CAS, and its result was answered above,
    // so this answer reads the movement as someone else's — a commit pushed
    // to the branch, a rewind, another Epic landing on the same target.
    // Overwriting it is the one outcome that cannot be undone by retrying:
    // the ref is not touched, and only a recorded decision to re-stage onto
    // the moved target resumes the flow (R7-5, R7-16). What this answer cannot
    // see is named rather than guessed (review of 11e, L5): in a race both
    // admissions may pass before either lands, and the loser's expected-old
    // CAS is then refused at write time (cas_conflict), so this is what its
    // retry reads; and a target holding this Epic's own landed result under
    // commits pushed on top, found by a retry after a crash, reads here as
    // foreign too — the pending CAS receipt resolves that case from the exact
    // ref and reflog before any new side effect, which is #9's.
    reasons.push({ reason: 'foreign_target_movement', detail: observedTarget.oid });
  }
  return Object.freeze({
    decision: reasons.length === 0 ? 'may_swap' : 'refused',
    reasons: immutable(reasons.map(Object.freeze)),
  });
}

/**
 * What the swap must be able to say afterwards.
 *
 * A CAS that reported success is not evidence that the ref holds what was
 * intended, so the OID, the tree, containment and the reflog are read back.
 */
export function postCasErrors(state, observed) {
  const errors = [];
  if (observed.oid !== state.post_cas.expected_new_oid) {
    errors.push({ reason: 'post_cas_mismatch', detail: `target is ${observed.oid}` });
  }
  if (observed.tree_oid !== state.staging_tree_oid) {
    errors.push({ reason: 'post_cas_mismatch', detail: 'the target tree is not the accepted one' });
  }
  if (observed.contains_recorded_result !== true) {
    errors.push({ reason: 'post_cas_mismatch', detail: 'the recorded result is not contained' });
  }
  if (observed.reflog_entries !== 1) {
    errors.push({ reason: 'post_cas_mismatch', detail: `${observed.reflog_entries} reflog entries` });
  }
  return errors;
}

/**
 * Where a crash resumes.
 *
 * A crash after aggregate PASS and before the CAS resumes without another model
 * run: everything needed is recorded, and re-running a model at that point
 * would produce different bytes and quietly discard an approval that was about
 * the old ones.
 */
export function resumePlan(state) {
  demand(PHASES.includes(state.phase), 'aggregate_binding_void', 'Unknown phase', { phase: state.phase });
  const index = PHASES.indexOf(state.phase);
  return Object.freeze({
    next_phase: index === PHASES.length - 1 ? 'complete' : PHASES[index + 1],
    // The model runs again only while the work is still being produced.
    requires_model_run: index < PHASES.indexOf('aggregate_verified'),
  });
}

/**
 * The request of the swap, checked before git is asked: the compare-and-swap is made from the base the staging record names and
 * from no other. Anything else is a request the host cannot form (`custody_request_invalid`, a host invariant, ADR-109) and it
 * is refused before the target ref is touched. `applySwap` reads a swap that already ran; this is the one that has not.
 */
export function assertSwapRequest(state, { expectedOld }) {
  demand(typeof expectedOld === 'string' && expectedOld.length > 0 && expectedOld === state.recorded_target_base, 'custody_request_invalid',
    'The swap would be attempted against another base', { expected: state.recorded_target_base, attempted: expectedOld });
}

/**
 * The swap itself.
 *
 * The compare-and-swap can fail even after admission: the target can move in
 * the window between reading it and writing it, which is precisely why the
 * write is a compare-and-swap and not a write. A conflict here is not a
 * refusal to try — it is the try, reporting that the world moved.
 *
 * A swap that ran from a base the record does not name is no request the host formed wrongly (`assertSwapRequest`, which
 * `swapTarget` calls, refuses that before git is asked): it is a result, and the target has to be investigated. It is the conflict the
 * graph's `cas_conflict` row carries, never thrown past the step, and the two cases are told apart (debt 13a, review M2, N5):
 * `swapped_from_unrecorded_base` — the swap landed, so the user's branch was overwritten, `landed` is true and `restore_to` is
 * the commit it held, which is to be put back before anything resumes (a resume into `integrate_staging` over it reads the result as
 * `already_complete`), and `refused_from_unrecorded_base` — git refused it, `landed` is false and `observed_old_oid` is what
 * the ref held. The input is checked, not read as it happens to be.
 */
export function applySwap(state, casResult) {
  demand(typeof state?.recorded_target_base === 'string' && state.recorded_target_base.length > 0
    && casResult !== null && typeof casResult === 'object' && typeof casResult.expected_old_oid === 'string'
    && typeof casResult.swapped === 'boolean', 'custody_request_invalid',
  'The result of a swap is read against a recorded base, with the base it was made from and whether it landed', {});
  if (casResult.expected_old_oid !== state.recorded_target_base) {
    if (casResult.swapped) {
      return Object.freeze({
        outcome: 'conflict',
        reason: 'cas_conflict',
        cause: 'swapped_from_unrecorded_base',
        landed: true,
        restore_to: casResult.expected_old_oid,
        detail: `the swap landed from ${casResult.expected_old_oid}, and the record names ${state.recorded_target_base}: the target was overwritten and ${casResult.expected_old_oid} is to be restored`,
      });
    }
    return Object.freeze({
      outcome: 'conflict',
      reason: 'cas_conflict',
      cause: 'refused_from_unrecorded_base',
      landed: false,
      observed_old_oid: casResult.observed_old_oid ?? null,
      detail: `git refused a swap made from ${casResult.expected_old_oid}, and the record names ${state.recorded_target_base}; the ref held ${casResult.observed_old_oid ?? 'nothing'}`,
    });
  }
  if (casResult.swapped) {
    return Object.freeze({ outcome: 'swapped', new_oid: casResult.new_oid });
  }
  return Object.freeze({
    outcome: 'conflict',
    reason: 'cas_conflict',
    detail: `the ref held ${casResult.observed_old_oid} at write time`,
  });
}

/**
 * An integration-fix Ticket is a Ticket.
 *
 * Its own id, its own acceptance criteria, and the ordinary verify, freeze and
 * review — not a patch applied under someone else's approval.
 */
export function integrationFixErrors(ticket, parent) {
  const errors = [];
  if (!ticket.ticket_id || ticket.ticket_id === parent.ticket_id) {
    errors.push({ reason: 'receipt_missing', detail: 'an integration fix has its own Ticket id' });
  }
  if (!ticket.acceptance_criteria || ticket.acceptance_criteria.length === 0) {
    errors.push({ reason: 'receipt_missing', detail: 'an integration fix has its own acceptance criteria' });
  }
  if (!ticket.manifest_overlay && !ticket.manifest_revision) {
    errors.push({ reason: 'receipt_missing', detail: 'an integration fix enters the manifest' });
  }
  if (ticket.reused_approval_of) {
    errors.push({ reason: 'acceptance_stale', detail: 'an integration fix is not applied under another approval' });
  }
  return errors;
}
