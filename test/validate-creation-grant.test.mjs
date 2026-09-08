/**
 * Tests for the issue #11 signed creation grant.
 *
 * These do not check that a signature field is present. They tamper with a real
 * grant and check a real Ed25519 verification fails — because the gap being
 * closed is not a missing field, it is that a caller inside the session knows
 * every value the daemon validates, so a hand-written grant with correct fields
 * passes every check that is not a signature.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CONTRACT_PATH,
  EXAMPLE_PATH,
  PARK_REASONS,
  PUBLIC_KEY_PATH,
  ROOT,
  SCHEMA_PATH,
  creationGrantDesignDigest,
  loadFiles,
  signedMessage,
  validateCreationGrantDesign,
  validateGrant,
  verifyGrant,
} from "../scripts/validate-creation-grant.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);
const publicKeyPem = files[PUBLIC_KEY_PATH];

function example() {
  return JSON.parse(files[EXAMPLE_PATH]);
}

function mutated(mutate) {
  const value = example();
  mutate(value);
  return value;
}

test("the shipped design validates", () => {
  assert.deepEqual(validateCreationGrantDesign(files), []);
});

test("the shipped grant's signature really verifies", () => {
  // Not "has a signature field" — verifies, with the shipped public key.
  assert.equal(verifyGrant(example(), publicKeyPem), true);
  assert.deepEqual(validateGrant(example(), schema, publicKeyPem), []);
});

test("a hand-written grant with entirely correct fields is refused", () => {
  // The case the daemon could not previously tell apart: every field is one the
  // caller knows about its own session, so field validation admits it.
  const forged = mutated((value) => {
    value.signature = { algorithm: "ed25519", key_id: value.signature.key_id, value: "0".repeat(128) };
  });
  assert.equal(verifyGrant(forged, publicKeyPem), false);
  assert.ok(
    validateGrant(forged, schema, publicKeyPem).some((message) => /grant_signature_invalid/u.test(message)),
  );
});

test("a grant signed by another key is refused", () => {
  // A daemon from another run, or anyone else with a keypair.
  const { privateKey } = generateKeyPairSync("ed25519");
  const other = mutated((value) => {
    value.signature.value = sign(null, signedMessage(value), privateKey).toString("hex");
  });
  assert.equal(verifyGrant(other, publicKeyPem), false);
});

test("appending a slot after signing is refused", () => {
  // This is why the slots are signed and not only the binding: the slot list is
  // what the grant permits, so an appended slot would create a child the host
  // never authorised while presenting a signature that verifies over the binding.
  const appended = mutated((value) => {
    value.slots = [
      ...value.slots,
      {
        slot_id: "child-c",
        creation_key: `flow:${"c".repeat(64)}`,
        creation_binding_hash: "d".repeat(64),
      },
    ];
  });
  assert.equal(verifyGrant(appended, publicKeyPem), false);
});

test("changing any slot field is refused", () => {
  for (const field of ["slot_id", "creation_key", "creation_binding_hash"]) {
    const tampered = mutated((value) => {
      value.slots[0][field] =
        field === "creation_key" ? `flow:${"e".repeat(64)}` : field === "slot_id" ? "renamed" : "f".repeat(64);
    });
    assert.equal(verifyGrant(tampered, publicKeyPem), false, `${field} was not covered by the signature`);
  }
});

test("changing any binding field is refused", () => {
  for (const field of ["parent_task_id", "session_id", "step", "step_visit", "operation_id", "expires_at_ms"]) {
    const tampered = mutated((value) => {
      value.binding[field] =
        typeof value.binding[field] === "number" ? value.binding[field] + 1 : `${value.binding[field]}x`;
    });
    assert.equal(verifyGrant(tampered, publicKeyPem), false, `${field} was not covered by the signature`);
  }
});

test("an expired grant is refused even with a valid signature", () => {
  // Replay of a genuine signature at a later time. The signature is still good;
  // the grant is not.
  const errors = validateGrant(example(), schema, publicKeyPem, { nowMs: 4102444800001 });
  assert.ok(errors.some((message) => /grant_expired/u.test(message)));
  assert.deepEqual(validateGrant(example(), schema, publicKeyPem, { nowMs: 1 }), []);
});

test("two slots may not share a creation key", () => {
  // One grant could otherwise create the same child twice, and the second create
  // would resolve as an existing task rather than as the refusal it is.
  const dup = mutated((value) => {
    value.slots[1].creation_key = value.slots[0].creation_key;
  });
  const errors = validateGrant(dup, schema, publicKeyPem);
  assert.ok(errors.some((message) => /two slots share a creation key/u.test(message)));
});

test("an unsigned grant is not even shape-valid", () => {
  // An unsigned grant is exactly what a caller can write, so it must not be a
  // legal document at any level.
  assert.ok(schema.required.includes("signature"));
  const unsigned = mutated((value) => {
    delete value.signature;
  });
  assert.ok(validateGrant(unsigned, schema, publicKeyPem).some((message) => /schema:/u.test(message)));
});

test("verifyGrant itself refuses a grant with no signature", () => {
  // The schema catches this first in the shipped path, so without a direct test
  // the guard inside `verifyGrant` would never be evaluated — and `verifyGrant`
  // is exported, so something else may reach it with the schema out of the way.
  const unsigned = mutated((value) => {
    delete value.signature;
  });
  assert.equal(verifyGrant(unsigned, publicKeyPem), false);
});

test("the design validator refuses a private key in the resource", () => {
  // Checked through the validator, not only by reading the shipped file: the
  // file being clean today says nothing about the check that keeps it clean.
  const withPrivate = {
    ...files,
    [PUBLIC_KEY_PATH]: `${files[PUBLIC_KEY_PATH]}\n-----BEGIN PRIVATE KEY-----\nnot a real key\n-----END PRIVATE KEY-----\n`,
  };
  assert.ok(
    validateCreationGrantDesign(withPrivate).some((message) => /must never be in the repository/u.test(message)),
    "a private key in the resource was accepted",
  );
});

test("no private key is in the repository", () => {
  // Verification needs only the public half, so the signing key never has to be
  // here — and a design that required it here would not be a design.
  assert.ok(publicKeyPem.includes("BEGIN PUBLIC KEY"));
  assert.ok(!publicKeyPem.includes("PRIVATE KEY"));
});

test("the contract states both decisions it exists to make", () => {
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  assert.ok(contract.includes("binding **and** the slots"), "the signed scope is not stated");
  assert.ok(contract.includes("extension load"), "the preflight call site is not stated");
  // ...and it says plainly what is decided versus what is delivered.
  assert.ok(contract.includes("runtime remains") || contract.includes("the entry point remains"));
});

test("every park reason is documented in the contract", () => {
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  for (const reason of PARK_REASONS) {
    assert.ok(contract.includes(reason), `${reason} is not documented`);
  }
});

test("the design digest changes when any shipped file changes", () => {
  const before = creationGrantDesignDigest(files);
  const after = creationGrantDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
