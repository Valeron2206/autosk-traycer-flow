/** Asking the ref-custody helper to write a ref under `refs/autosk/**`.
 *
 * The ref-custody helper writes every ref under `refs/autosk/**`, the staging ref included; the host only asks it, and the daemon's `integrateApproved` alone moves the target ref.
 *
 * The helper is `autosk-flow-ref-custody` of 02 §2 (#5,
 * `src/git/ref-custody-helper.ts`), a process of the installing user
 * (ADR-102): autoskd persists the helper intent,
 * signs the request and calls it, and it performs one expected-old
 * `update-ref` transaction under its lock. What the host owns is the request:
 * the action of the helper's closed protocol, the identity of the operation
 * that asks, and the exact ref updates that action carries, formed here and never
 * widened by a caller, and the reading of the answer against the request it made.
 * Nothing here runs git.
 *
 * The identity is the pair the daemon-side intent requires and persists before
 * the socket call, `owner_operation_id` and `request_id`
 * (`ref-custody-helper-intents.schema.json`; the wire body's `operation_id` and
 * `request_id` are the same two values). The host supplies it because a retry
 * after a crash has to reach the intent and the journal of the request already
 * made rather than mint a second one (02 §2): the daemon finds the intent by the
 * pair, and only the asking operation can say it is asking again. The pair is
 * derived from the operation (`custodyIdentity`), so it is the same after the
 * crash without being read back from anywhere.
 *
 * The client is injected. The product has no helper yet, so the default client
 * answers no action and every request is refused as a missing capability: a
 * host with no helper does not fall back to writing the ref itself (ADR-095).
 * Tests hand the drivers a git-backed stand-in (`test/support/git-ref-custody.mjs`).
 *
 * A request the host cannot form is `custody_request_invalid` (debt 13a, R9-9,
 * ADR-109): a fault of the host's own call, raised before anything is asked, so
 * it is no state of any task and no park reason. `cas_conflict` is git's refusal
 * of a compare-and-swap and nothing else; the request-formation errors used to
 * share it, and a caller could not tell "git refused the CAS" from "the host
 * never made one".
 */
import { createHash } from 'node:crypto';

import { FlowError, boundedText, demand, immutable, oidFormat } from '../runtime/contracts.mjs';

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

/** The intent schema's `uuid`: lowercase, version 4. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** A UUID v4 out of 16 bytes of a digest: the version and variant bits set, the rest the digest's. */
function uuidFrom(text) {
  const bytes = createHash('sha256').update(text, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The identity one operation asks the helper under, for one action.
 *
 * `owner_operation_id` is the operation's, the same across its actions;
 * `request_id` is one request's — a different one per action, as the helper's
 * transfer takes a different request for each of its two calls. Both derive
 * from the operation's own id, so an operation that asks again after a crash
 * asks under the same pair and the daemon finds the intent it persisted.
 */
export function custodyIdentity(operationId, action) {
  demand(typeof operationId === 'string' && operationId.length > 0, 'custody_request_invalid',
    'A request is made under an operation, and none is named', { action });
  demand(typeof action === 'string' && Object.hasOwn(SHAPES, action), 'custody_request_invalid',
    'The host asks the helper for no such action', { action });
  return Object.freeze({
    owner_operation_id: uuidFrom(`autosk-flow/ref-custody-owner-operation/v1\0${operationId}`),
    request_id: uuidFrom(`autosk-flow/ref-custody-request/v1\0${action}\0${operationId}`),
  });
}

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
function formRequest(action, refUpdates, identity) {
  const shape = Object.hasOwn(SHAPES, action) ? SHAPES[action] : null;
  demand(shape !== null, 'custody_request_invalid', 'The host asks the helper for no such action', { action });
  // The pair the daemon-side intent persists: without it a retry could only mint a second request.
  demand(isRecord(identity) && Object.keys(identity).length === 2
    && UUID_V4.test(identity.owner_operation_id) && UUID_V4.test(identity.request_id), 'custody_request_invalid',
  'The request names no operation and request identity the daemon-side intent can be found by', { action });
  demand(Array.isArray(refUpdates) && refUpdates.length === shape.length, 'custody_request_invalid',
    'The request does not carry the ref updates its action does', { action });
  const keys = new Set();
  const formats = new Set();
  const updates = shape.map(([operation, kind, old, next], index) => {
    const update = refUpdates[index];
    demand(isRecord(update), 'custody_request_invalid', 'A ref update is a record', { action, index });
    demand(update.operation === operation, 'custody_request_invalid', 'The ref update is not the operation its action performs',
      { action, index, operation: update.operation });
    const named = typeof update.ref === 'string' ? KIND[kind].exec(update.ref) : null;
    demand(named !== null, 'custody_request_invalid', 'The ref is not one this action of the helper writes',
      { action, index, ref: update.ref });
    keys.add(named[1]);
    demand(holds(update.expected_old_oid, old) && holds(update.new_oid, next, update.expected_old_oid), 'custody_request_invalid',
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
  demand(keys.size === 1, 'custody_request_invalid', 'One request names one Epic', { action });
  demand(formats.size === 1, 'custody_request_invalid', 'One request uses one object format', { action });
  return Object.freeze({
    action,
    owner_operation_id: identity.owner_operation_id,
    request_id: identity.request_id,
    ref_updates: Object.freeze(updates),
  });
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

/** A client that failed: what it threw, with its errno as the cause (`client_failed` when it has none), both bounded. */
function clientFailure(action, error) {
  const code = error instanceof FlowError ? error.code : error?.code;
  const said = typeof error?.message === 'string' && error.message.length > 0 ? `: ${boundedText(error.message, 200)}` : '';
  return new FlowError('planning_ref_capability_missing', `The ref-custody client failed${said}`,
    { action, cause: typeof code === 'string' && code.length > 0 ? boundedText(code, 64) : 'client_failed' });
}

/**
 * Asks the helper for one action and returns its answer, read against the request.
 *
 * `committed` is the transaction done; `not_applied` with `expected_old_mismatch`
 * is an answer the caller reads, with what each ref holds. Anything else — no
 * helper for the action, a refusal for a capability reason (`packed_refs_drift`,
 * `authorization_invalid`), an answer that does not answer the request, or a client call that throws — is
 * `planning_ref_capability_missing`, the code the helper's contract maps its
 * capability failures to, whatever the action, with what the helper said as `details.cause`.
 */
export async function askCustody(custody, action, refUpdates, identity) {
  const request = formRequest(action, refUpdates, identity);
  // Looking the client up can throw too (a getter): that is the client's failure like any other.
  let ask = null;
  let lookup = null;
  try {
    ask = isRecord(custody) && Object.hasOwn(custody, action) ? custody[action] : null;
  } catch (error) {
    lookup = error;
  }
  if (lookup !== null) throw clientFailure(action, lookup);
  // Every way the helper cannot be relied on is the one code, with what it said as the cause (debt 13a, review M1, M3): `no_helper`,
  // the reason the helper gave (`packed_refs_drift`, `authorization_invalid`), `unanswered` for an answer that answers nothing,
  // or the errno of a client call that threw. What a client that fails after the helper committed did is not known here, so the
  // stop leaves the apply to its recipe, which recognises a commit that was made.
  demand(typeof ask === 'function', 'planning_ref_capability_missing',
    'No ref-custody helper answers this action, and the host never writes the ref itself', { action, cause: 'no_helper' });
  let answer;
  try {
    answer = await ask(request);
  } catch (error) {
    // A stop the client raises is its answer; any other code it raises is its failure, and the code becomes the cause.
    if (error instanceof FlowError && error.code === 'planning_ref_capability_missing') throw error;
    throw clientFailure(action, error);
  }
  const status = isRecord(answer) ? answer.status : undefined;
  const unanswered = (message, extra = {}) => new FlowError('planning_ref_capability_missing', message, { action, cause: 'unanswered', ...extra });
  if (!(isRecord(answer) && answer.action === action && (status === 'committed' || status === 'not_applied'))) throw unanswered('The helper did not answer this request');
  if (!(status === 'committed' ? answer.not_applied_reason === null : NOT_APPLIED.includes(answer.not_applied_reason))) {
    throw unanswered('The helper answered with a reason its protocol does not give', { reason: answer.not_applied_reason ?? null });
  }
  const observations = answer.ref_observations;
  const format = formatOf(request);
  if (!(Array.isArray(observations) && observations.length === request.ref_updates.length
    && request.ref_updates.every((update, index) => answersUpdate(observations[index], update, status, format)))) {
    throw unanswered('The helper observed something other than the refs it was asked about');
  }
  demand(status === 'committed' || answer.not_applied_reason === 'expected_old_mismatch', 'planning_ref_capability_missing',
    'The helper refused for a capability reason', { action, reason: answer.not_applied_reason ?? null, cause: answer.not_applied_reason ?? 'unanswered', status });
  // A mismatch the helper saw is a ref that did not hold its expected value.
  if (!(status === 'committed'
    || observations.some((observation, index) => observation.observed_old_oid !== request.ref_updates[index].expected_old_oid))) {
    throw unanswered('The helper reported a mismatch on refs that held their expected values');
  }
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
