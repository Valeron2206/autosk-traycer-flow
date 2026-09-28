/** A daemon UserDecisionRecord, as far as the host can check one (ADR-023).
 *
 * Only autoskd makes a user decision, after a signed user-presence challenge;
 * the host cannot make one and must not mint one from a name. What the host
 * can do is refuse everything that is not such a record: a record whose fields
 * are not the daemon schema's, whose signed bytes are not the canonical
 * challenge it repeats, or whose signature does not verify under a key the
 * project pinned.
 *
 * The signature is verified by a function the caller hands in, and the default
 * verifier answers nothing: the pinned daemon reports no signer (ADR-090), so
 * on a real host today every record is refused. That is the fail-closed half
 * of ADR-023, not a bypass waiting to be removed; the signer, its key pin and
 * the verifier that reads it are ADR-023 work that matrix v1 gives to #4
 * (ADR-092).
 *
 * It names no refusal of its own: each caller passes the code its contract
 * declares (the decision queue `decision_approver_mismatch`, the Epic
 * acceptance `acceptance_missing`, the workflow factory's resume
 * `resume_target_not_permitted`).
 */
import { canonicalBytes, demand, digest, immutable, sha256 } from '../runtime/contracts.mjs';

/** The record's required fields: the closed daemon schema of 03 without its optional ones. */
export const RECORD_FIELDS = immutable([
  'schema',
  'record_id',
  'project_root_sha256',
  'actor',
  'request_id',
  'anchor_version',
  'subject_hash',
  'payload_hash',
  'signed_challenge_canonical_b64',
  'signed_challenge_hash',
  'challenge_nonce_hash',
  'challenge_expires_at',
  'signer_public_key_id',
  'signature',
  'journal_sequence',
  'previous_record_hash',
  'previous_secure_head_hash',
  'issued_at',
]);

/** The schema's optional fields, and nothing else. */
export const OPTIONAL_FIELDS = immutable(['epic_id', 'task_id', 'target_record_id', 'terminal_disposition']);

/** The canonical object the signed bytes are, byte for byte (01 §2, 03). */
export const CHALLENGE_FIELDS = immutable([
  'project_root_sha256',
  'record_id',
  'nonce',
  'expires_at',
  'request_id',
  'epic_id',
  'task_id',
  'anchor_version',
  'subject_hash',
  'payload_hash',
  'previous_secure_head_hash',
  'journal_sequence',
]);

/** The fields the record repeats from the challenge under the same name. */
const REPEATED = immutable([
  'project_root_sha256',
  'record_id',
  'request_id',
  'anchor_version',
  'subject_hash',
  'payload_hash',
  'previous_secure_head_hash',
  'journal_sequence',
]);

/** The domain separator the signature is taken over, before the canonical bytes. */
export const SIGNATURE_DOMAIN = 'autosk-flow/user-presence-challenge/v1';

const RECORD_DOMAIN = 'autosk-flow/user-decision-record/v1';
const PROVENANCE_DOMAIN = 'autosk-flow/user-decision-provenance/v1';
const PAYLOAD_DOMAIN = 'autosk-flow/user-decision-payload/v1';
const RESUME_DECISION_DOMAIN = 'autosk-flow/resume-decision/v1';

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const HEX = /^[a-f0-9]{64}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
// Text the canonical form accepts: NFC, no NUL, no lone surrogate.
const text = (value) => typeof value === 'string' && value.length > 0 && value === value.normalize('NFC')
  && !value.includes('\0') && !/[\uD800-\uDFFF]/u.test(value);
const hex = (value) => typeof value === 'string' && HEX.test(value);
const time = (value) => typeof value === 'string' && RFC3339.test(value) && !Number.isNaN(Date.parse(value));
const string = (value) => typeof value === 'string';

/** Each field's shape, so a value the canonical form would refuse is the caller's refusal, not an identity error. */
const SHAPES = Object.freeze({
  schema: Number.isSafeInteger,
  record_id: text,
  project_root_sha256: hex,
  actor: string,
  request_id: text,
  anchor_version: (value) => Number.isSafeInteger(value) && value >= 1,
  subject_hash: hex,
  payload_hash: hex,
  signed_challenge_canonical_b64: string,
  signed_challenge_hash: hex,
  challenge_nonce_hash: hex,
  challenge_expires_at: time,
  signer_public_key_id: text,
  signature: string,
  journal_sequence: (value) => Number.isSafeInteger(value) && value >= 0,
  previous_record_hash: (value) => value === null || hex(value),
  previous_secure_head_hash: hex,
  issued_at: time,
  epic_id: text,
  task_id: text,
  target_record_id: text,
  terminal_disposition: (value) => value === null || string(value),
});

/** The default verifier: the pinned daemon reports no signer, so no key verifies anything. */
export function noSigner() {
  return null;
}

/** The digest a record is named by. */
export function userDecisionRecordHash(record) {
  return digest(RECORD_DOMAIN, record);
}

/** Who signed, under which key, at which place in the journal. */
export function userDecisionProvenance(record) {
  return digest(PROVENANCE_DOMAIN, {
    actor: record.actor,
    signer_public_key_id: record.signer_public_key_id,
    journal_sequence: record.journal_sequence,
    previous_record_hash: record.previous_record_hash,
    previous_secure_head_hash: record.previous_secure_head_hash,
  });
}

/** The digest of the answer a record signs: its `payload_hash`. */
export function decisionPayloadHash(payload) {
  return digest(PAYLOAD_DOMAIN, payload);
}

/**
 * What a decision to resume a parked task into a target is about: the
 * `subject_hash` a UserDecisionRecord that decides such a resume signs. It is
 * the task, the park — its reason and its watermark, the visit counts of the
 * reason's `parks_at` steps when the park was recorded — and the target, so a
 * record decides one resume of one task from one park and nothing else
 * (CodeRabbit on #270). The answer the record signs is
 * `decisionPayloadHash({ resume_target })`.
 */
export function resumeDecisionSubject({ task_id, reason, watermark, target }) {
  return digest(RESUME_DECISION_DOMAIN, { task_id, reason, watermark, target });
}

/** The signed bytes and the challenge they decode to, or a refusal. */
function signedChallenge(record, refuse) {
  const encoded = record.signed_challenge_canonical_b64;
  let bytes;
  let challenge;
  let canonical = false;
  try {
    bytes = Buffer.from(encoded, 'base64');
    challenge = JSON.parse(bytes.toString('utf8'));
    // Base64 that decodes loosely, or JSON not in canonical form, is not the
    // byte-exact object the signature was taken over.
    canonical = bytes.toString('base64') === encoded && canonicalBytes(challenge).equals(bytes);
  } catch {
    canonical = false;
  }
  refuse(canonical, 'The signed bytes are not the canonical challenge the record carries');
  refuse(plain(challenge) && Object.keys(challenge).length === CHALLENGE_FIELDS.length
    && CHALLENGE_FIELDS.every((field) => Object.hasOwn(challenge, field)),
  'The signed challenge does not have exactly the challenge fields');
  return { bytes, challenge };
}

/**
 * Verifies a UserDecisionRecord and returns what it proves, or throws `code`.
 *
 * Returns the role the verifier gives the signing key, and the record's id,
 * digest and provenance digest, which is what a decision, an alignment or an
 * integration authorization binds. Binding the record to a particular request,
 * subject and payload is the caller's: this says only that the record is one
 * the daemon signed.
 */
export function verifiedUserDecision(record, { code, verifySignature = noSigner }) {
  const refuse = (condition, message, details = {}) => demand(condition, code, message, details);
  refuse(plain(record), 'An answer is a daemon UserDecisionRecord, not a name');
  const missing = RECORD_FIELDS.filter((field) => !Object.hasOwn(record, field));
  const unknown = Object.keys(record).filter((field) => !RECORD_FIELDS.includes(field) && !OPTIONAL_FIELDS.includes(field));
  refuse(missing.length === 0 && unknown.length === 0, 'A UserDecisionRecord has exactly the daemon schema fields',
    { missing: immutable(missing), unknown: immutable(unknown) });
  const misshapen = Object.keys(record).filter((field) => !SHAPES[field](record[field]));
  refuse(misshapen.length === 0, 'A UserDecisionRecord field does not have its shape',
    { fields: immutable(misshapen) });
  refuse(record.schema === 1 && record.actor === 'user', 'Only a schema-1 record with actor user is a user decision',
    { actor: record.actor });
  refuse(record.terminal_disposition === undefined || record.terminal_disposition === null,
    'A terminal UserDecisionRecord decides nothing', { terminal_disposition: record.terminal_disposition });

  const { bytes, challenge } = signedChallenge(record, refuse);
  for (const field of REPEATED) {
    refuse(challenge[field] === record[field], `The record's ${field} is not the signed challenge's`, { field });
  }
  refuse(challenge.epic_id === (record.epic_id ?? null) && challenge.task_id === (record.task_id ?? null),
    'The record names another Epic or task than the signed challenge');
  refuse(challenge.expires_at === record.challenge_expires_at, 'The record names another expiry than the signed challenge');
  refuse(typeof challenge.nonce === 'string' && sha256(Buffer.from(challenge.nonce, 'utf8')) === record.challenge_nonce_hash,
    'The nonce hash is not the hash of the signed nonce');
  refuse(sha256(bytes) === record.signed_challenge_hash, 'The record names another hash of the signed bytes');
  refuse(Date.parse(record.issued_at) <= Date.parse(record.challenge_expires_at),
    'The record was issued after its challenge expired');

  let role = null;
  try {
    role = verifySignature({
      signer_public_key_id: record.signer_public_key_id,
      domain: SIGNATURE_DOMAIN,
      bytes,
      signature: record.signature,
    });
  } catch {
    role = null;
  }
  refuse(typeof role === 'string' && role.length > 0,
    'The signature does not verify under a pinned signer key; the pinned daemon reports no signer (ADR-023)',
    { signer_public_key_id: record.signer_public_key_id });
  return Object.freeze({
    role,
    record_id: record.record_id,
    record_hash: userDecisionRecordHash(record),
    provenance_hash: userDecisionProvenance(record),
  });
}
