/**
 * A test-only stand-in for the daemon's user-presence signer (ADR-023).
 *
 * The product has no signer and no key: `src/host/user-decision.mjs` verifies a
 * UserDecisionRecord only through a verifier it is handed, and its default
 * verifier refuses every record. These tests hand it one built here, over an
 * Ed25519 key generated for the run, so every record they use is really signed
 * and really verified; nothing in `src/` can reach this file.
 */
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";

import { canonicalBytes } from "../../src/runtime/contracts.mjs";
import { SIGNATURE_DOMAIN, decisionPayloadHash } from "../../src/host/user-decision.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const framed = (domain, bytes) => Buffer.concat([Buffer.from(`${domain}\0`, "utf8"), bytes]);

/**
 * A key, the verifier that knows it, and a way to issue records under it.
 *
 * `role` is what the verifier answers for this key: the approver role the
 * project pinned it to. A verifier that does not know the key answers nothing.
 */
export function testSigner({ keyId = "test-key-1", role = "owner" } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  const verifySignature = ({ signer_public_key_id: id, domain, bytes, signature }) => {
    if (id !== keyId) return null;
    return verify(null, framed(domain, bytes), publicKey, Buffer.from(signature, "base64")) ? role : null;
  };

  /**
   * A record as the daemon would write it. `challenge` overrides fields of the
   * signed challenge only, and `record` overrides fields of the record after
   * signing, so a test can make the two disagree.
   */
  function issue({
    request_id,
    project_root_sha256,
    anchor_version,
    subject_hash,
    payload_hash,
    epic_id = null,
    task_id = null,
    record_id = "udr-0001",
    nonce = "nonce-0001",
    issued_at = "2026-09-08T12:30:00.000Z",
    challenge_expires_at = "2026-09-09T10:10:00.000Z",
    journal_sequence = 1,
    previous_record_hash = null,
    previous_secure_head_hash = "0".repeat(64),
    challenge = {},
    record = {},
  }) {
    const signed = {
      project_root_sha256,
      record_id,
      nonce,
      expires_at: challenge_expires_at,
      request_id,
      epic_id,
      task_id,
      anchor_version,
      subject_hash,
      payload_hash,
      previous_secure_head_hash,
      journal_sequence,
      ...challenge,
    };
    const bytes = canonicalBytes(signed);
    const written = {
      schema: 1,
      record_id,
      project_root_sha256,
      actor: "user",
      request_id,
      ...(epic_id === null ? {} : { epic_id }),
      ...(task_id === null ? {} : { task_id }),
      anchor_version,
      subject_hash,
      payload_hash,
      signed_challenge_canonical_b64: bytes.toString("base64"),
      signed_challenge_hash: sha256(bytes),
      challenge_nonce_hash: sha256(Buffer.from(nonce, "utf8")),
      challenge_expires_at,
      signer_public_key_id: keyId,
      signature: sign(null, framed(SIGNATURE_DOMAIN, bytes), privateKey).toString("base64"),
      journal_sequence,
      previous_record_hash,
      previous_secure_head_hash,
      issued_at,
    };
    return { ...written, ...record };
  }

  /**
   * A response to `request`: the answer payload, and the record that signed it.
   * `answer` overrides the payload the response carries; `signedAnswer`
   * overrides the payload the record signed, so the two can disagree.
   */
  function respond(request, answer = {}, { signedAnswer, ...recordOptions } = {}) {
    const payload = {
      option_id: answer.option_id ?? request.options[0].option_id,
      identities: answer.identities ?? {
        anchor_version: request.identities.anchor_version,
        candidate: request.identities.candidate,
      },
      ...(answer.normalized_from === undefined ? {} : { normalized_from: answer.normalized_from }),
      ...(answer.confirmed_material_scope === undefined
        ? {}
        : { confirmed_material_scope: answer.confirmed_material_scope }),
    };
    const record = issue({
      request_id: request.request_id,
      project_root_sha256: request.project_identity.replace(/^sha256:/u, ""),
      anchor_version: request.identities.anchor_version,
      subject_hash: request.identities.candidate,
      payload_hash: decisionPayloadHash(signedAnswer ?? payload),
      ...recordOptions,
    });
    return { ...payload, ...answer, user_decision_record: record };
  }

  return { keyId, role, verifySignature, issue, respond };
}
