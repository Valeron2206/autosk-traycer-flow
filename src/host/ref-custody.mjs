/** Asking the ref-custody helper to write a ref under `refs/autosk/**`.
 *
 * The ref-custody helper writes every ref under `refs/autosk/**`, the staging ref included; the host only asks it, and the daemon's `integrateApproved` alone moves the target ref.
 *
 * The helper is the separate-account `autosk-flow-ref-custody` service of 02 §2
 * (#5, `src/git/ref-custody-helper.ts`): autoskd persists the helper intent,
 * signs the request and calls it, and it performs one expected-old
 * `update-ref` transaction under its lock. What the host owns is the request:
 * the action of the helper's closed protocol and the exact ref updates that
 * action carries, formed here and never widened by a caller, and the reading of
 * the answer against the request it made. Nothing here runs git.
 *
 * The client is injected. The product has no helper yet, so the default client
 * answers no action and every request is refused as a missing capability: a
 * host with no helper does not fall back to writing the ref itself (ADR-095).
 * Tests hand the drivers a git-backed stand-in (`test/support/git-ref-custody.mjs`).
 */
import { demand, immutable, oidFormat } from '../runtime/contracts.mjs';

/** The helper's closed action roster, in the order of its wire schema. */
export const REF_CUSTODY_ACTIONS = immutable([
  'init',
  'create_keepalive',
  'advance_planning',
  'ensure_audit_ref',
  'delete_live_ref',
  'delete_expired_audit',
  'create_staging',
  'advance_staging',
  'delete_staging',
]);

/** Every ref the helper writes: one Epic's planning, candidate, audit and staging refs. */
export const PROTECTED_REF = /^refs\/autosk\/epics\/[0-9a-f]{64}\/(?:planning|candidates\/[0-9a-f]{64}|audit\/candidates\/[0-9a-f]{64}|staging)$/u;

const KIND = Object.freeze({
  planning: /^refs\/autosk\/epics\/([0-9a-f]{64})\/planning$/u,
  candidate: /^refs\/autosk\/epics\/([0-9a-f]{64})\/candidates\/[0-9a-f]{64}$/u,
  staging: /^refs\/autosk\/epics\/([0-9a-f]{64})\/staging$/u,
});

/**
 * What each action a host driver asks for carries, one entry per ref update:
 * the operation, the kind of ref, and whether the expected old and the new
 * value are absent (`null`), present (an OID), another OID than the expected
 * old one (an advance) or, for a verify, the same OID.
 * The other four actions belong to the candidate keepalive and audit custody of
 * #5's publication adapter, which is not host code yet.
 */
const SHAPES = Object.freeze({
  init: [['update', 'planning', 'absent', 'present']],
  advance_planning: [['verify', 'candidate', 'present', 'same'], ['update', 'planning', 'present', 'other']],
  create_staging: [['update', 'staging', 'absent', 'present']],
  advance_staging: [['update', 'staging', 'present', 'other']],
  delete_staging: [['delete', 'staging', 'present', 'absent']],
});

/** The actions a host driver asks for. */
export const HOST_REF_CUSTODY_ACTIONS = immutable(Object.keys(SHAPES));

/** The client a product host has: no helper, so no action. */
export const NO_REF_CUSTODY = Object.freeze({});

const NOT_APPLIED = Object.freeze(['expected_old_mismatch', 'packed_refs_drift', 'authorization_invalid']);
const isOid = (value) => oidFormat(value) !== null;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function holds(value, expect, old) {
  if (expect === 'absent') return value === null;
  if (expect === 'same') return value === old;
  // An update moves the ref: to the value it already holds is no advance.
  if (expect === 'other') return isOid(value) && value !== old;
  return isOid(value);
}

/** The request, formed and checked against the action's shape; refused before anything is asked. */
function formRequest(action, refUpdates) {
  const shape = Object.hasOwn(SHAPES, action) ? SHAPES[action] : null;
  demand(shape !== null, 'cas_conflict', 'The host asks the helper for no such action', { action });
  demand(Array.isArray(refUpdates) && refUpdates.length === shape.length, 'cas_conflict',
    'The request does not carry the ref updates its action does', { action });
  const keys = new Set();
  const formats = new Set();
  const updates = shape.map(([operation, kind, old, next], index) => {
    const update = refUpdates[index];
    demand(isRecord(update), 'cas_conflict', 'A ref update is a record', { action, index });
    demand(update.operation === operation, 'cas_conflict', 'The ref update is not the operation its action performs',
      { action, index, operation: update.operation });
    const named = typeof update.ref === 'string' ? KIND[kind].exec(update.ref) : null;
    demand(named !== null, 'cas_conflict', 'The ref is not one this action of the helper writes',
      { action, index, ref: update.ref });
    keys.add(named[1]);
    demand(holds(update.expected_old_oid, old) && holds(update.new_oid, next, update.expected_old_oid), 'cas_conflict',
      'The expected old or the new value is not what the action allows', { action, index });
    for (const oid of [update.expected_old_oid, update.new_oid]) if (oid !== null) formats.add(oidFormat(oid));
    return Object.freeze({
      operation,
      ref: update.ref,
      expected_old_oid: update.expected_old_oid,
      new_oid: update.new_oid,
    });
  });
  // One Epic and one object format per request, as the helper's wire requires.
  demand(keys.size === 1, 'cas_conflict', 'One request names one Epic', { action });
  demand(formats.size === 1, 'cas_conflict', 'One request uses one object format', { action });
  return Object.freeze({ action, ref_updates: Object.freeze(updates) });
}

/** The object format a formed request is in: the one its OIDs share. */
function formatOf(request) {
  const update = request.ref_updates[0];
  return oidFormat(update.expected_old_oid ?? update.new_oid);
}

/** The observation the helper owes for one requested update, in the request's object format. */
function answersUpdate(observation, update, status, format) {
  if (!isRecord(observation)) return false;
  if (observation.operation !== update.operation || observation.ref !== update.ref) return false;
  if (observation.expected_old_oid !== update.expected_old_oid || observation.requested_new_oid !== update.new_oid) return false;
  // What the ref holds is nothing, or an OID of the repository's one format
  // (ADR-098), which the request carries; the new value is then held equal to
  // it (refused) or to what was requested (committed), so it needs no check of
  // its own.
  if (observation.observed_old_oid !== null && oidFormat(observation.observed_old_oid) !== format) return false;
  if (status === 'not_applied') return observation.observed_new_oid === observation.observed_old_oid;
  const after = update.operation === 'delete' ? null : update.new_oid;
  return observation.observed_old_oid === update.expected_old_oid && observation.observed_new_oid === after;
}

/**
 * Asks the helper for one action and returns its answer, read against the request.
 *
 * `committed` is the transaction done; `not_applied` with `expected_old_mismatch`
 * is an answer the caller reads, with what each ref holds. Anything else — no
 * helper for the action, a refusal for a capability reason (`packed_refs_drift`,
 * `authorization_invalid`), or an answer that does not answer the request — is
 * `planning_ref_capability_missing`, the code the helper's contract maps its
 * capability failures to, whatever the action.
 */
export async function askCustody(custody, action, refUpdates) {
  const request = formRequest(action, refUpdates);
  const ask = isRecord(custody) && Object.hasOwn(custody, action) ? custody[action] : null;
  demand(typeof ask === 'function', 'planning_ref_capability_missing',
    'No ref-custody helper answers this action, and the host never writes the ref itself', { action });
  const answer = await ask(request);
  const status = isRecord(answer) ? answer.status : undefined;
  demand(isRecord(answer) && answer.action === action && (status === 'committed' || status === 'not_applied'),
    'planning_ref_capability_missing', 'The helper did not answer this request', { action });
  demand(status === 'committed' ? answer.not_applied_reason === null : NOT_APPLIED.includes(answer.not_applied_reason),
    'planning_ref_capability_missing', 'The helper answered with a reason its protocol does not give',
    { action, reason: answer.not_applied_reason });
  const observations = answer.ref_observations;
  const format = formatOf(request);
  demand(Array.isArray(observations) && observations.length === request.ref_updates.length
    && request.ref_updates.every((update, index) => answersUpdate(observations[index], update, status, format)),
  'planning_ref_capability_missing', 'The helper observed something other than the refs it was asked about', { action });
  demand(status === 'committed' || answer.not_applied_reason === 'expected_old_mismatch', 'planning_ref_capability_missing',
    'The helper refused for a capability reason', { action, reason: answer.not_applied_reason });
  // A mismatch the helper saw is a ref that did not hold its expected value.
  demand(status === 'committed'
    || observations.some((observation, index) => observation.observed_old_oid !== request.ref_updates[index].expected_old_oid),
  'planning_ref_capability_missing', 'The helper reported a mismatch on refs that held their expected values', { action });
  return immutable({
    status,
    not_applied_reason: answer.not_applied_reason,
    ref_observations: observations.map((observation) => ({
      operation: observation.operation,
      ref: observation.ref,
      expected_old_oid: observation.expected_old_oid,
      requested_new_oid: observation.requested_new_oid,
      observed_old_oid: observation.observed_old_oid,
      observed_new_oid: observation.observed_new_oid,
    })),
  });
}
