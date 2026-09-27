/**
 * Tests for the host's check of a daemon UserDecisionRecord (ADR-023, debt 10e).
 *
 * The host cannot make a user decision; it can only refuse to treat anything
 * else as one. Each case below is a way a record could be taken for the user's
 * when it is not: a name instead of a record, a record whose signed bytes say
 * something else, a signature under another key, and — on every real host
 * today — no signer to verify against at all.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalBytes, digest } from "../src/runtime/contracts.mjs";
import {
  CHALLENGE_FIELDS,
  OPTIONAL_FIELDS,
  RECORD_FIELDS,
  SIGNATURE_DOMAIN,
  decisionPayloadHash,
  noSigner,
  userDecisionProvenance,
  userDecisionRecordHash,
  verifiedUserDecision,
} from "../src/host/user-decision.mjs";
import { testSigner } from "./support/user-decision-signer.mjs";

const CODE = "decision_approver_mismatch";
const refused = (pattern) => (error) => error.code === CODE && (pattern === undefined || pattern.test(error.message));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const signer = testSigner();
const fields = {
  request_id: "req-1",
  project_root_sha256: "a".repeat(64),
  anchor_version: 3,
  subject_hash: "b".repeat(64),
  payload_hash: "c".repeat(64),
};
const issue = (overrides = {}) => signer.issue({ ...fields, ...overrides });
const check = (record, verifySignature = signer.verifySignature) =>
  verifiedUserDecision(record, { code: CODE, verifySignature });

test("a record the daemon signed is verified, and names itself by id, hash and provenance", () => {
  const record = issue();
  const verified = check(record);
  assert.equal(verified.role, "owner");
  assert.equal(verified.record_id, "udr-0001");
  assert.equal(verified.record_hash, digest("autosk-flow/user-decision-record/v1", record));
  assert.equal(verified.record_hash, userDecisionRecordHash(record));
  assert.equal(verified.provenance_hash, userDecisionProvenance(record));
  assert.equal(verified.provenance_hash, digest("autosk-flow/user-decision-provenance/v1", {
    actor: "user",
    signer_public_key_id: signer.keyId,
    journal_sequence: 1,
    previous_record_hash: null,
    previous_secure_head_hash: "0".repeat(64),
  }));
  // epic and task, when the daemon names them, are read from the record.
  assert.equal(check(issue({ epic_id: "e-1", task_id: "ask-000001" })).role, "owner");
  assert.equal(Object.isFrozen(verified), true);
});

test("the product has no signer: without an injected verifier every record is refused", () => {
  // The pinned daemon reports no signer (ADR-090), so there is nothing to
  // verify a signature against; the path fails closed rather than trusting it.
  assert.equal(noSigner(), null);
  assert.throws(() => verifiedUserDecision(issue(), { code: CODE }), refused(/ADR-023/u));
  assert.throws(() => check(issue(), noSigner), refused(/ADR-023/u));
  // The code is the caller's: the acceptance path names its own refusal.
  assert.throws(() => verifiedUserDecision(issue(), { code: "acceptance_missing" }), (error) => error.code === "acceptance_missing");
});

test("a signature under another key, a tampered signature, or a verifier that throws is refused", () => {
  const other = testSigner({ keyId: "test-key-2" });
  assert.throws(() => check(other.issue(fields)), refused(/signature/u));
  // The same key id under another key: the verifier knows the id, not this key.
  const impostor = testSigner();
  assert.throws(() => check(impostor.issue(fields)), refused(/signature/u));
  const record = issue();
  const flipped = Buffer.from(record.signature, "base64");
  flipped[0] ^= 1;
  assert.throws(() => check({ ...record, signature: flipped.toString("base64") }), refused(/signature/u));
  assert.throws(() => check(record, () => { throw new Error("verifier down"); }), refused(/signature/u));
  // A role must be a name: an empty or non-string answer is no role.
  assert.throws(() => check(record, () => ""), refused(/signature/u));
  assert.throws(() => check(record, () => true), refused(/signature/u));
  // The verifier is asked about the signed bytes under the challenge domain.
  let asked;
  check(record, (question) => { asked = question; return "owner"; });
  assert.equal(asked.domain, SIGNATURE_DOMAIN);
  assert.equal(asked.signer_public_key_id, signer.keyId);
  assert.equal(asked.signature, record.signature);
  assert.equal(asked.bytes.toString("base64"), record.signed_challenge_canonical_b64);
});

test("a name, or anything that is not a plain record, is not a UserDecisionRecord", () => {
  for (const value of [undefined, null, "owner", 7, ["owner"]]) {
    assert.throws(() => check(value), refused(/UserDecisionRecord/u), String(value));
  }
});

test("the record has exactly the daemon schema's fields", () => {
  const record = issue();
  for (const field of RECORD_FIELDS) {
    const missing = { ...record };
    delete missing[field];
    assert.throws(() => check(missing), refused(/schema/u), field);
  }
  assert.throws(() => check({ ...record, answered_by: "owner" }), refused(/schema/u));
  // The optional fields are optional, not free: each is one of the schema's.
  assert.deepEqual([...OPTIONAL_FIELDS], ["epic_id", "task_id", "target_record_id", "terminal_disposition"]);
  assert.equal(check({ ...record, target_record_id: "udr-0000" }).role, "owner");
  assert.equal(check({ ...record, terminal_disposition: null }).role, "owner");
});

test("only a schema-1 record with actor user and no terminal disposition decides anything", () => {
  const record = issue();
  assert.throws(() => check({ ...record, schema: 2 }), refused(/actor user/u));
  assert.throws(() => check({ ...record, actor: "model" }), refused(/actor user/u));
  assert.throws(() => check({ ...record, terminal_disposition: "revoked" }), refused(/terminal/u));
});

test("the signed bytes are the canonical challenge, byte for byte", () => {
  const record = issue();
  const decoded = JSON.parse(Buffer.from(record.signed_challenge_canonical_b64, "base64").toString("utf8"));
  assert.deepEqual(Object.keys(decoded).sort(), [...CHALLENGE_FIELDS].sort());
  // Not base64 of anything: the bytes the record names are not the bytes it carries.
  assert.throws(() => check({ ...record, signed_challenge_canonical_b64: "@@not base64@@" }), refused(/canonical/u));
  assert.throws(() => check({ ...record, signed_challenge_canonical_b64: 7 }), refused(/shape/u));
  // Base64 of something that is not JSON.
  const garbage = Buffer.from("not json", "utf8");
  assert.throws(
    () => check({ ...record, signed_challenge_canonical_b64: garbage.toString("base64"), signed_challenge_hash: sha256(garbage) }),
    refused(/canonical/u),
  );
  // The same object, not in canonical form.
  const pretty = Buffer.from(JSON.stringify(decoded, null, 2), "utf8");
  assert.throws(
    () => check({ ...record, signed_challenge_canonical_b64: pretty.toString("base64"), signed_challenge_hash: sha256(pretty) }),
    refused(/canonical/u),
  );
  // JSON that the canonical form refuses outright (a fractional number).
  const fractional = Buffer.from('{"a":1.5}\n', "utf8");
  assert.throws(
    () => check({ ...record, signed_challenge_canonical_b64: fractional.toString("base64"), signed_challenge_hash: sha256(fractional) }),
    refused(/canonical/u),
  );
  // Canonical JSON that is not an object.
  const list = canonicalBytes(["a"]);
  assert.throws(
    () => check({ ...record, signed_challenge_canonical_b64: list.toString("base64"), signed_challenge_hash: sha256(list) }),
    refused(/challenge/u),
  );
});

test("the challenge names exactly the canonical fields, and the record repeats each", () => {
  assert.throws(() => check(issue({ challenge: { extra: "x" } })), refused(/challenge fields/u));
  const short = issue();
  const decoded = JSON.parse(Buffer.from(short.signed_challenge_canonical_b64, "base64").toString("utf8"));
  delete decoded.task_id;
  const bytes = canonicalBytes(decoded);
  assert.throws(
    () => check({ ...short, signed_challenge_canonical_b64: bytes.toString("base64"), signed_challenge_hash: sha256(bytes) }),
    refused(/challenge fields/u),
  );
  for (const [field, value] of [
    ["project_root_sha256", "9".repeat(64)],
    ["record_id", "udr-9999"],
    ["request_id", "req-9"],
    ["anchor_version", 4],
    ["subject_hash", "9".repeat(64)],
    ["payload_hash", "9".repeat(64)],
    ["previous_secure_head_hash", "9".repeat(64)],
    ["journal_sequence", 2],
  ]) {
    assert.throws(() => check(issue({ record: { [field]: value } })), refused(/signed challenge/u), field);
  }
  // epic and task: a record that names one the challenge did not, or omits one it did.
  assert.throws(() => check(issue({ record: { epic_id: "e-1" } })), refused(/signed challenge/u));
  assert.throws(() => check(issue({ record: { task_id: "ask-000001" } })), refused(/signed challenge/u));
  const withEpic = issue({ epic_id: "e-1", task_id: "ask-000001" });
  const noEpic = { ...withEpic };
  delete noEpic.epic_id;
  assert.throws(() => check(noEpic), refused(/signed challenge/u));
  const noTask = { ...withEpic };
  delete noTask.task_id;
  assert.throws(() => check(noTask), refused(/signed challenge/u));
  assert.throws(() => check(issue({ record: { challenge_expires_at: "2026-09-09T10:11:00.000Z" } })), refused(/signed challenge/u));
});

test("the nonce, the bytes' hash and the issue time are the ones the challenge fixed", () => {
  assert.throws(() => check(issue({ record: { challenge_nonce_hash: "9".repeat(64) } })), refused(/nonce/u));
  assert.throws(() => check(issue({ record: { signed_challenge_hash: "9".repeat(64) } })), refused(/hash of the signed/u));
  // Issued after the challenge expired: the presence it proves had lapsed.
  assert.throws(() => check(issue({ issued_at: "2026-09-09T10:10:00.001Z" })), refused(/expired/u));
  assert.equal(check(issue({ issued_at: "2026-09-09T10:10:00.000Z" })).role, "owner");
  assert.throws(() => check(issue({ issued_at: "not a time" })), refused(/shape/u));
  // A nonce that is not a string has no hash to compare.
  assert.throws(() => check(issue({ challenge: { nonce: 7 } })), refused(/nonce/u));
});

test("the payload hash is a domain-separated digest of exactly the answer", () => {
  const payload = { option_id: "accept", identities: { anchor_version: 3, candidate: "b".repeat(64) } };
  assert.equal(decisionPayloadHash(payload), digest("autosk-flow/user-decision-payload/v1", payload));
  assert.notEqual(decisionPayloadHash({ ...payload, option_id: "refuse" }), decisionPayloadHash(payload));
  assert.notEqual(decisionPayloadHash({ ...payload, normalized_from: "ok" }), decisionPayloadHash(payload));
});

test("every field has its shape, refused under the caller's code (review L2)", () => {
  // Before, a value the canonical form refuses escaped as `invalid_identity`
  // from the digest instead of the caller's refusal.
  const record = issue();
  for (const [field, value] of [
    ["schema", "1"],
    ["record_id", ""],
    ["record_id", "udr\u0000"],
    ["record_id", "e\u0301"],
    ["record_id", "\uD800"],
    ["record_id", 7],
    ["request_id", ""],
    ["signer_public_key_id", ""],
    ["project_root_sha256", "A".repeat(64)],
    ["subject_hash", "b"],
    ["payload_hash", null],
    ["signed_challenge_hash", 7],
    ["challenge_nonce_hash", "c".repeat(63)],
    ["previous_secure_head_hash", undefined],
    ["previous_record_hash", "d"],
    ["actor", 7],
    ["anchor_version", 0],
    ["anchor_version", 1.5],
    ["journal_sequence", -1],
    ["journal_sequence", 2 ** 53],
    ["signed_challenge_canonical_b64", 7],
    ["signature", null],
    ["challenge_expires_at", "2026-09-09 10:10:00"],
    ["challenge_expires_at", "2026-13-40T99:99:99Z"],
    ["issued_at", 7],
    ["epic_id", ""],
    ["task_id", 7],
    ["target_record_id", ""],
    ["terminal_disposition", 7],
  ]) {
    assert.throws(() => check({ ...record, [field]: value }), refused(/shape/u), `${field}=${JSON.stringify(value)}`);
  }
  // Nulls where the schema allows them, and an offset time, are shapes.
  assert.equal(check(issue({ previous_record_hash: "e".repeat(64) })).role, "owner");
  assert.equal(check(issue({ issued_at: "2026-09-08T14:30:00+02:00" })).role, "owner");
  assert.equal(check(issue({ journal_sequence: 0 })).role, "owner");
  // The bounds are asked at the bound: anchor version 1 is the first there is.
  assert.equal(check(issue({ anchor_version: 1 })).role, "owner");
});
