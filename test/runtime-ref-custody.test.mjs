/**
 * Tests for asking the ref-custody helper to write under `refs/autosk/**`
 * (debt 11a, ADR-095).
 *
 * The host writes no ref there itself. It forms the one request an action of
 * the helper's closed protocol carries, hands it to a client, and reads the
 * answer against the request it made. These tests use hand-written clients, so
 * every way a request or an answer can be wrong is one assertion; the drivers'
 * own tests run the git-backed client of `test/support/git-ref-custody.mjs`.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import * as custodyModule from "../src/host/ref-custody.mjs";
import {
  HOST_REF_CUSTODY_ACTIONS,
  NO_REF_CUSTODY,
  PROTECTED_REF,
  REF_CUSTODY_ACTIONS,
  askCustody as askCustodyWith,
} from "../src/host/ref-custody.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const read = (relative) => JSON.parse(readFileSync(path.join(ROOT, relative), "utf8"));
const code = (name) => (error) => error.code === name;

const KEY = "a916c907fd14e54bfb1f3591a573675ccb1fdfeb49a8875c3c10c6bc00c5fb37";
const OTHER_KEY = "b".repeat(64);
const CANDIDATE = "c".repeat(64);
const STAGING = `refs/autosk/epics/${KEY}/staging`;
const PLANNING = `refs/autosk/epics/${KEY}/planning`;
const LIVE = `refs/autosk/epics/${KEY}/candidates/${CANDIDATE}`;
// The operation identity every request carries (debt 12g): the pair the
// daemon-side intent requires. Existing tests ask with this one.
// Literal, not derived at load: a fault in the derivation must fail the tests that name it, not the file's loading.
const IDENTITY = Object.freeze({
  owner_operation_id: "5b0f4d1e-9c3a-4e7b-8a21-6d0c7e9f1a35",
  request_id: "c1d2e3f4-a5b6-4c7d-9e8f-0a1b2c3d4e5f",
});
// One request per action, as the derivation gives them: an action's own pair, not one pair for all of them.
// (An action the host does not ask for has no pair to derive; the request is refused on the action, not the pair.)
const askCustody = (custody, action, updates, identity = HOST_REF_CUSTODY_ACTIONS.includes(action) ? custodyModule.custodyIdentity("test-operation", action) : IDENTITY) => askCustodyWith(custody, action, updates, identity);
const A = "1".repeat(40);
const B = "2".repeat(40);
const C = "3".repeat(40);

/** A client that answers every action with `respond(request)`, and remembers what it was asked. */
function client(respond) {
  const asked = [];
  const handler = async (request) => {
    asked.push(request);
    return respond(request);
  };
  return {
    asked,
    custody: Object.fromEntries(HOST_REF_CUSTODY_ACTIONS.map((action) => [action, handler])),
  };
}

/** The committed answer the helper gives when every expected old value held. */
function committed(request) {
  return {
    action: request.action,
    status: "committed",
    not_applied_reason: null,
    ref_observations: request.ref_updates.map((update) => ({
      operation: update.operation,
      ref: update.ref,
      expected_old_oid: update.expected_old_oid,
      requested_new_oid: update.new_oid,
      observed_old_oid: update.expected_old_oid,
      observed_new_oid: update.operation === "delete" ? null : update.new_oid,
    })),
  };
}

/** The refusal the helper gives when a ref did not hold its expected old value. */
function mismatch(request, held = C) {
  return {
    action: request.action,
    status: "not_applied",
    not_applied_reason: "expected_old_mismatch",
    ref_observations: request.ref_updates.map((update) => ({
      operation: update.operation,
      ref: update.ref,
      expected_old_oid: update.expected_old_oid,
      requested_new_oid: update.new_oid,
      observed_old_oid: held,
      observed_new_oid: held,
    })),
  };
}

const advance = [{ operation: "update", ref: STAGING, expected_old_oid: A, new_oid: B }];

/** A well-formed request for each host action. */
const VALID = {
  init: [{ operation: "update", ref: PLANNING, expected_old_oid: null, new_oid: A }],
  advance_planning: [
    { operation: "verify", ref: LIVE, expected_old_oid: C, new_oid: C },
    { operation: "update", ref: PLANNING, expected_old_oid: A, new_oid: B },
  ],
  create_staging: [{ operation: "update", ref: STAGING, expected_old_oid: null, new_oid: A }],
  advance_staging: advance,
  delete_staging: [{ operation: "delete", ref: STAGING, expected_old_oid: A, new_oid: null }],
};

test("the roster is the helper's closed protocol, and the host asks for five of its actions", () => {
  const wire = read("resources/planning-publication/ref-custody-helper-wire.schema.json");
  const intents = read("resources/planning-publication/ref-custody-helper-intents.schema.json");
  const contract = read("resources/planning-publication/ref-custody-helper-contract.example.json");
  assert.deepEqual([...REF_CUSTODY_ACTIONS], wire.$defs.action.enum);
  assert.deepEqual([...REF_CUSTODY_ACTIONS], intents.$defs.action.enum);
  assert.deepEqual([...REF_CUSTODY_ACTIONS], contract.actions.map((entry) => entry.action));
  assert.deepEqual([...HOST_REF_CUSTODY_ACTIONS], ["init", "advance_planning", "create_staging", "advance_staging", "delete_staging"]);
  for (const action of HOST_REF_CUSTODY_ACTIONS) assert.ok(REF_CUSTODY_ACTIONS.includes(action), action);
});

test("the ref grammar is the helper's, staging included, in every schema that names it", () => {
  const wire = read("resources/planning-publication/ref-custody-helper-wire.schema.json");
  const intents = read("resources/planning-publication/ref-custody-helper-intents.schema.json");
  // A RegExp's source escapes `/`; the schemas' patterns do not need to.
  const same = (pattern) => new RegExp(pattern, "u").source;
  assert.equal(PROTECTED_REF.source, same(wire.$defs.protected_ref.pattern));
  assert.equal(PROTECTED_REF.source, same(wire.$defs.ref_update.properties.ref.pattern));
  assert.equal(PROTECTED_REF.source, same(intents.$defs.observation.properties.ref.pattern));
  for (const ref of [PLANNING, LIVE, `refs/autosk/epics/${KEY}/audit/candidates/${CANDIDATE}`, STAGING]) {
    assert.ok(PROTECTED_REF.test(ref), ref);
  }
  for (const ref of [
    "refs/heads/main",
    `refs/autosk/epics/${KEY}/candidate`,
    `refs/autosk/epics/${KEY}/audit`,
    "refs/autosk/epics/e-1/staging",
    "refs/autosk/planning/e-1",
    `refs/autosk/epics/${KEY}/staging/x`,
  ]) {
    assert.equal(PROTECTED_REF.test(ref), false, ref);
  }
});

test("with no helper, every action is refused as a missing capability and nothing is asked", async () => {
  // The product default: the helper is #5 implementation work, and a host
  // with no helper does not fall back to writing the ref itself.
  assert.deepEqual(Object.keys(VALID), [...HOST_REF_CUSTODY_ACTIONS]);
  for (const action of HOST_REF_CUSTODY_ACTIONS) {
    await assert.rejects(() => askCustody(NO_REF_CUSTODY, action, VALID[action]), code("planning_ref_capability_missing"), action);
  }
  await assert.rejects(() => askCustody(undefined, "advance_staging", advance), code("planning_ref_capability_missing"));
  await assert.rejects(() => askCustody(null, "advance_staging", advance), code("planning_ref_capability_missing"));
  // A client that has other actions but not this one is no helper for it.
  const partial = { create_staging: async () => { throw new Error("must not be asked"); } };
  await assert.rejects(() => askCustody(partial, "advance_staging", advance), code("planning_ref_capability_missing"));
  assert.equal(Object.isFrozen(NO_REF_CUSTODY), true);
  assert.deepEqual(Object.keys(NO_REF_CUSTODY), []);
});

test("the request the client receives is exactly the action, its operation identity and its ref updates, frozen", async () => {
  const { asked, custody } = client(committed);
  const answer = await askCustody(custody, "advance_staging", advance);
  assert.equal(asked.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(asked[0])), { action: "advance_staging", ...custodyModule.custodyIdentity("test-operation", "advance_staging"), ref_updates: advance });
  assert.equal(Object.isFrozen(asked[0]), true);
  assert.equal(Object.isFrozen(asked[0].ref_updates[0]), true);
  assert.equal(answer.status, "committed");
  assert.equal(answer.not_applied_reason, null);
  assert.equal(answer.ref_observations[0].observed_new_oid, B);
});

test("each host action carries exactly the ref updates the helper's protocol gives it", async () => {
  const { custody } = client(committed);
  for (const [action, updates] of Object.entries(VALID)) {
    const answer = await askCustody(custody, action, updates);
    assert.equal(answer.status, "committed", action);
  }
  // SHA-256 object format, one width throughout, is the same request.
  const wide = [{ operation: "update", ref: STAGING, expected_old_oid: "1".repeat(64), new_oid: "2".repeat(64) }];
  assert.equal((await askCustody(custody, "advance_staging", wide)).status, "committed");
});

test("a request the helper's protocol does not have is refused before the client is asked", async () => {
  const { asked, custody } = client(committed);
  const refused = [
    // An action the host does not ask for, and one that does not exist.
    ["ensure_audit_ref", advance],
    ["swap_target", advance],
    ["toString", advance],
    // Not a list, or the wrong number of updates.
    ["advance_staging", undefined],
    ["advance_staging", []],
    ["advance_staging", [...advance, ...advance]],
    // The wrong operation for the action.
    ["advance_staging", [{ ...advance[0], operation: "delete" }]],
    ["delete_staging", [{ operation: "update", ref: STAGING, expected_old_oid: A, new_oid: null }]],
    // A ref outside the grammar, and a grammar ref of the wrong kind.
    ["advance_staging", [{ ...advance[0], ref: "refs/heads/main" }]],
    ["advance_staging", [{ ...advance[0], ref: "refs/autosk/epics/e-1/staging" }]],
    ["advance_staging", [{ ...advance[0], ref: PLANNING }]],
    ["init", [{ operation: "update", ref: STAGING, expected_old_oid: null, new_oid: A }]],
    ["advance_planning", [
      { operation: "verify", ref: PLANNING, expected_old_oid: C, new_oid: C },
      { operation: "update", ref: PLANNING, expected_old_oid: A, new_oid: B },
    ]],
    // Two Epics in one request.
    ["advance_planning", [
      { operation: "verify", ref: `refs/autosk/epics/${OTHER_KEY}/candidates/${CANDIDATE}`, expected_old_oid: C, new_oid: C },
      { operation: "update", ref: PLANNING, expected_old_oid: A, new_oid: B },
    ]],
    // Expected-absent and expected-present values the wrong way round.
    ["create_staging", [{ operation: "update", ref: STAGING, expected_old_oid: A, new_oid: B }]],
    ["advance_staging", [{ ...advance[0], expected_old_oid: null }]],
    ["delete_staging", [{ operation: "delete", ref: STAGING, expected_old_oid: null, new_oid: null }]],
    ["delete_staging", [{ operation: "delete", ref: STAGING, expected_old_oid: A, new_oid: B }]],
    ["create_staging", [{ operation: "update", ref: STAGING, expected_old_oid: null, new_oid: null }]],
    // A verify that would move the ref.
    ["advance_planning", [
      { operation: "verify", ref: LIVE, expected_old_oid: C, new_oid: B },
      { operation: "update", ref: PLANNING, expected_old_oid: A, new_oid: B },
    ]],
    // Something that is not an OID, and two object formats in one request.
    ["advance_staging", [{ ...advance[0], new_oid: "HEAD" }]],
    ["advance_staging", [{ ...advance[0], expected_old_oid: "1".repeat(39) }]],
    ["advance_staging", [{ ...advance[0], new_oid: "2".repeat(64) }]],
    // An update that is not a plain record.
    ["advance_staging", [null]],
    ["advance_staging", ["update"]],
  ];
  for (const [action, updates] of refused) {
    await assert.rejects(() => askCustody(custody, action, updates), code("custody_request_invalid"), `${action} ${JSON.stringify(updates)}`);
  }
  assert.equal(asked.length, 0);
});

test("an expected-old mismatch is an answer the caller reads, with what the ref holds", async () => {
  const { custody } = client((request) => mismatch(request));
  const answer = await askCustody(custody, "advance_staging", advance);
  assert.equal(answer.status, "not_applied");
  assert.equal(answer.not_applied_reason, "expected_old_mismatch");
  assert.equal(answer.ref_observations[0].observed_old_oid, C);
  assert.equal(Object.isFrozen(answer), true);
  // An absent ref is an observation too.
  const absent = await askCustody(client((request) => mismatch(request, null)).custody, "advance_staging", advance);
  assert.equal(absent.ref_observations[0].observed_old_oid, null);
});

test("a helper refusing for a capability reason is a missing capability, not a movement", async () => {
  // epic-planning-ref.md: `packed_refs_drift` and `authorization_invalid` map
  // to `planning_ref_capability_missing`, whatever the action — even when the
  // refs it observed did move, so the reason alone decides.
  for (const reason of ["packed_refs_drift", "authorization_invalid"]) {
    const { custody } = client((request) => ({ ...mismatch(request), not_applied_reason: reason }));
    await assert.rejects(() => askCustody(custody, "advance_staging", advance), code("planning_ref_capability_missing"), reason);
  }
});

test("an answer that does not answer the request is a missing capability", async () => {
  const wrong = [
    ["no answer", () => undefined],
    ["another action", (request) => ({ ...committed(request), action: "create_staging" })],
    ["unknown status", (request) => ({ ...committed(request), status: "done" })],
    ["committed with a reason", (request) => ({ ...committed(request), not_applied_reason: "expected_old_mismatch" })],
    ["refused without a reason", (request) => ({ ...mismatch(request), not_applied_reason: null })],
    ["refused for a reason the protocol does not have", (request) => ({ ...mismatch(request), not_applied_reason: "busy" })],
    ["no observations", (request) => ({ ...committed(request), ref_observations: undefined })],
    ["too many observations", (request) => ({ ...committed(request), ref_observations: [...committed(request).ref_observations, ...committed(request).ref_observations] })],
    ["too few observations", (request) => ({ ...committed(request), ref_observations: [] })],
    ["an observation that is not a record", (request) => ({ ...committed(request), ref_observations: [null] })],
    ["another operation", (request) => {
      const answer = committed(request);
      answer.ref_observations[0].operation = "verify";
      return answer;
    }],
    ["another ref", (request) => {
      const answer = committed(request);
      answer.ref_observations[0].ref = PLANNING;
      return answer;
    }],
    ["another expected old value", (request) => {
      const answer = committed(request);
      answer.ref_observations[0].expected_old_oid = C;
      return answer;
    }],
    ["another requested value", (request) => {
      const answer = committed(request);
      answer.ref_observations[0].requested_new_oid = C;
      return answer;
    }],
    ["committed from another old value", (request) => {
      const answer = committed(request);
      answer.ref_observations[0].observed_old_oid = C;
      return answer;
    }],
    ["committed to another value", (request) => {
      const answer = committed(request);
      answer.ref_observations[0].observed_new_oid = C;
      return answer;
    }],
    ["refused but moved", (request) => {
      const answer = mismatch(request);
      answer.ref_observations[0].observed_new_oid = B;
      return answer;
    }],
    ["an observed value that is not an OID", (request) => {
      const answer = mismatch(request);
      answer.ref_observations[0].observed_old_oid = "HEAD";
      answer.ref_observations[0].observed_new_oid = "HEAD";
      return answer;
    }],
  ];
  for (const [label, respond] of wrong) {
    const { custody } = client(respond);
    await assert.rejects(() => askCustody(custody, "advance_staging", advance), code("planning_ref_capability_missing"), label);
  }
});

test("a committed delete observes the ref gone, and a committed verify observes it unmoved", async () => {
  const del = [{ operation: "delete", ref: STAGING, expected_old_oid: A, new_oid: null }];
  const gone = await askCustody(client(committed).custody, "delete_staging", del);
  assert.equal(gone.ref_observations[0].observed_new_oid, null);
  const kept = (request) => {
    const answer = committed(request);
    answer.ref_observations[0].observed_new_oid = A;
    return answer;
  };
  await assert.rejects(() => askCustody(client(kept).custody, "delete_staging", del), code("planning_ref_capability_missing"));
  const verify = [
    { operation: "verify", ref: LIVE, expected_old_oid: C, new_oid: C },
    { operation: "update", ref: PLANNING, expected_old_oid: A, new_oid: B },
  ];
  const answer = await askCustody(client(committed).custody, "advance_planning", verify);
  assert.equal(answer.ref_observations[0].observed_new_oid, C);
  assert.equal(answer.ref_observations[1].observed_new_oid, B);
});

// --- debt 11a review -----------------------------------------------------------

test("an expected-old mismatch names a ref that did not hold its expected value (review L1)", async () => {
  // A refusal whose every observation says the ref held exactly what was
  // expected is not a mismatch the helper could have seen.
  const lying = (request) => mismatch(request, request.ref_updates[0].expected_old_oid);
  await assert.rejects(() => askCustody(client(lying).custody, "advance_staging", advance), code("planning_ref_capability_missing"));
  // For advance_planning one differing ref is enough: the keepalive moved.
  const keepaliveMoved = (request) => {
    const answer = mismatch(request);
    answer.ref_observations[0].observed_old_oid = B;
    answer.ref_observations[0].observed_new_oid = B;
    answer.ref_observations[1].observed_old_oid = A;
    answer.ref_observations[1].observed_new_oid = A;
    return answer;
  };
  const answer = await askCustody(client(keepaliveMoved).custody, "advance_planning", VALID.advance_planning);
  assert.equal(answer.status, "not_applied");
  // And for a create, an absent expected value that is still absent is no mismatch.
  const create = VALID.create_staging;
  await assert.rejects(() => askCustody(client((request) => mismatch(request, null)).custody, "create_staging", create),
    code("planning_ref_capability_missing"));
});

test("an advance to the commit the ref already holds is refused before the client is asked (review L3)", async () => {
  const { asked, custody } = client(committed);
  await assert.rejects(() => askCustody(custody, "advance_staging", [{ ...advance[0], new_oid: A }]), code("custody_request_invalid"));
  await assert.rejects(() => askCustody(custody, "advance_planning", [
    VALID.advance_planning[0],
    { ...VALID.advance_planning[1], new_oid: A },
  ]), code("custody_request_invalid"));
  assert.equal(asked.length, 0);
});

// --- debt 11d: one object format ----------------------------------------------

test("a helper that observes an OID of another object format did not observe this repository (debt 11d)", async () => {
  // ADR-098: a repository has one object format, and the helper's wire holds
  // one width across each exchange's request and response. What a refusal says
  // a ref holds is read in the request's format; a 64-hex observation of a
  // 40-hex request, or the reverse, answers no request this host made.
  const wideHeld = "3".repeat(64);
  const refusing = (held) => client((request) => mismatch(request, held)).custody;
  await assert.rejects(() => askCustody(refusing(wideHeld), "advance_staging", advance), code("planning_ref_capability_missing"));
  await assert.rejects(() => askCustody(refusing(wideHeld), "create_staging", VALID.create_staging), code("planning_ref_capability_missing"));
  await assert.rejects(() => askCustody(refusing(wideHeld), "delete_staging", VALID.delete_staging), code("planning_ref_capability_missing"));
  const wide = [{ operation: "update", ref: STAGING, expected_old_oid: "1".repeat(64), new_oid: "2".repeat(64) }];
  await assert.rejects(() => askCustody(refusing(C), "advance_staging", wide), code("planning_ref_capability_missing"));
  // In the request's own format the same refusal is an answer the caller reads,
  // and an absent ref is an observation in either.
  assert.equal((await askCustody(refusing(wideHeld), "advance_staging", wide)).ref_observations[0].observed_old_oid, wideHeld);
  assert.equal((await askCustody(refusing(null), "advance_staging", wide)).ref_observations[0].observed_old_oid, null);
  // Every observation of the request is held to it: here the planning ref's.
  const planningWide = (request) => {
    const answer = mismatch(request);
    answer.ref_observations[1].observed_old_oid = wideHeld;
    answer.ref_observations[1].observed_new_oid = wideHeld;
    return answer;
  };
  await assert.rejects(() => askCustody(client(planningWide).custody, "advance_planning", VALID.advance_planning),
    code("planning_ref_capability_missing"));
});

// --- debt 12g (R8-9): the request carries the operation's identity -----------

test("the request carries the pair the daemon-side intent requires, under the intent's own names", async () => {
  const intents = read("resources/planning-publication/ref-custody-helper-intents.schema.json");
  const required = intents.$defs.intent.required;
  for (const field of ["owner_operation_id", "request_id"]) assert.ok(required.includes(field), field);
  const { asked, custody } = client(committed);
  await askCustody(custody, "advance_staging", advance);
  for (const field of ["owner_operation_id", "request_id"]) assert.equal(asked[0][field], custodyModule.custodyIdentity("test-operation", "advance_staging")[field], field);
  // Nothing else crosses the boundary: the daemon mints the nonce, the digests and the signature.
  assert.deepEqual(Object.keys(asked[0]).sort(), ["action", "owner_operation_id", "ref_updates", "request_id"]);
  // A retry hands the same pair over again: the daemon finds its intent, it does not mint a second request.
  await askCustody(custody, "advance_staging", advance);
  assert.deepEqual([asked[1].owner_operation_id, asked[1].request_id], [asked[0].owner_operation_id, asked[0].request_id]);
});

test("a request with no operation identity, or a malformed one, is refused before the client is asked", async () => {
  const intents = read("resources/planning-publication/ref-custody-helper-intents.schema.json");
  const uuid = new RegExp(intents.$defs.uuid.pattern, "u");
  assert.ok(uuid.test(IDENTITY.owner_operation_id) && uuid.test(IDENTITY.request_id));
  const bad = [
    undefined,
    null,
    "5b0f4d1e-9c3a-4e7b-8a21-6d0c7e9f1a35",
    {},
    { owner_operation_id: IDENTITY.owner_operation_id },
    { request_id: IDENTITY.request_id },
    { ...IDENTITY, owner_operation_id: "op-1" },
    { ...IDENTITY, request_id: "not-a-uuid" },
    // Not a version-4 UUID, and not lowercase: the intent schema's pattern refuses both.
    { ...IDENTITY, request_id: "c1d2e3f4-a5b6-1c7d-9e8f-0a1b2c3d4e5f" },
    { ...IDENTITY, request_id: "C1D2E3F4-A5B6-4C7D-9E8F-0A1B2C3D4E5F" },
    { ...IDENTITY, owner_operation_id: 7 },
    { ...IDENTITY, extra: true },
  ];
  const { asked, custody } = client(committed);
  for (const action of HOST_REF_CUSTODY_ACTIONS) {
    for (const identity of bad) {
      await assert.rejects(() => askCustodyWith(custody, action, VALID[action], identity), code("custody_request_invalid"), `${action} ${JSON.stringify(identity)}`);
    }
  }
  assert.deepEqual(asked, []);
});

test("custodyIdentity derives the pair from the operation: stable across a retry, one owner, one request per action", () => {
  const intents = read("resources/planning-publication/ref-custody-helper-intents.schema.json");
  const uuid = new RegExp(intents.$defs.uuid.pattern, "u");
  const { custodyIdentity } = custodyModule;
  const first = custodyIdentity("op-7f3c1a", "advance_staging");
  assert.deepEqual(Object.keys(first).sort(), ["owner_operation_id", "request_id"]);
  assert.ok(uuid.test(first.owner_operation_id) && uuid.test(first.request_id));
  // The same operation and action give the same pair again, after a crash and in another process.
  assert.deepEqual(custodyIdentity("op-7f3c1a", "advance_staging"), first);
  // One operation has one owner id across its actions, and one request per action (the helper's
  // transfer takes a different request for each of its two calls).
  const other = custodyIdentity("op-7f3c1a", "create_staging");
  assert.equal(other.owner_operation_id, first.owner_operation_id);
  assert.notEqual(other.request_id, first.request_id);
  const elsewhere = custodyIdentity("op-other", "advance_staging");
  assert.notEqual(elsewhere.owner_operation_id, first.owner_operation_id);
  assert.notEqual(elsewhere.request_id, first.request_id);
  assert.notEqual(first.owner_operation_id, first.request_id);
  assert.equal(Object.isFrozen(first), true);
  // The names it accepts are the ones it can be derived from: an empty operation and an action the
  // host does not ask for name nothing.
  for (const operation of ["", undefined, 7]) assert.throws(() => custodyIdentity(operation, "advance_staging"), code("custody_request_invalid"));
  for (const action of ["swap_target", "", undefined, "toString"]) assert.throws(() => custodyIdentity("op-7f3c1a", action), code("custody_request_invalid"));
  // The derived pair is a pair the request accepts.
  return askCustody(client(committed).custody, "advance_staging", advance, first);
});

// --- debt 13a (R9-9, ADR-109): one code for a request the host cannot form, and cas_conflict only where git refused a CAS ---

test("cas_conflict is raised only where git refused a compare-and-swap: a request the host cannot form is custody_request_invalid (R9-9)", () => {
  const host = path.join(ROOT, "src/host");
  const literal = /'cas_conflict'/gu;
  const found = readdirSync(host).filter((file) => file.endsWith(".mjs"))
    .map((file) => [file, (readFileSync(path.join(host, file), "utf8").match(literal) ?? []).length]).filter(([, count]) => count > 0);
  // epic-staging.mjs: the vocabulary entry and both conflict outcomes of the swap (git's refusal, and a swap from an unrecorded base);
  // staging-driver.mjs: the helper's expected-absent create finding the ref at another commit.
  assert.deepEqual(found, [["epic-staging.mjs", 3], ["staging-driver.mjs", 1]]);
  for (const file of ["ref-custody.mjs", "delta-driver.mjs", "planning-driver.mjs"]) {
    assert.doesNotMatch(readFileSync(path.join(host, file), "utf8"), literal, file);
  }
});

test("every way the host can fail to form a request is custody_request_invalid, before the helper is asked (R9-9)", async () => {
  const { asked, custody } = client(committed);
  const identity = custodyModule.custodyIdentity("op-7f3c1a", "advance_staging");
  const attempts = [
    () => askCustody(custody, "swap_target", advance, identity),
    () => askCustodyWith(custody, "advance_staging", advance),
    () => askCustody(custody, "advance_staging", [], identity),
    () => askCustody(custody, "advance_staging", [{ ...advance[0], ref: "refs/heads/main" }], identity),
    () => askCustody(custody, "advance_staging", [{ ...advance[0], new_oid: advance[0].expected_old_oid }], identity),
    () => custodyModule.custodyIdentity("", "advance_staging"),
  ];
  for (const attempt of attempts) await assert.rejects(async () => attempt(), code("custody_request_invalid"));
  assert.deepEqual(asked, []);
  // A helper that is not there is a capability, not a fault of the request.
  await assert.rejects(() => askCustody({}, "advance_staging", advance, identity), code("planning_ref_capability_missing"));
});

test("a stop for the helper says why: no helper, a capability refusal, an answer that answers nothing, a client that throws (review M1, M3)", async () => {
  const request = advance;
  const cause = async (custody) => (await askCustody(custody, "advance_staging", request).then(() => null, (thrown) => thrown));
  const none = await cause({});
  assert.equal(none?.code, "planning_ref_capability_missing");
  assert.equal(none.details.cause, "no_helper");
  const refused = await cause(client((asked) => ({ ...mismatch(asked), not_applied_reason: "packed_refs_drift" })).custody);
  assert.equal(refused?.code, "planning_ref_capability_missing");
  assert.equal(refused.details.cause, "packed_refs_drift");
  const garbage = await cause(client(() => ({ status: "committed" })).custody);
  assert.equal(garbage.details.cause, "unanswered");
  const thrown = await cause({ advance_staging: async () => { throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); } });
  assert.equal(thrown?.code, "planning_ref_capability_missing");
  assert.equal(thrown.details.cause, "ECONNRESET");
  assert.equal((await cause({ advance_staging: async () => { throw new Error("plain"); } })).details.cause, "client_failed");
});
