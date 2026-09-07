import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalBytes, closedRecord, compareCodePoints, digest, immutable,
  assertDigest, equalDigest, assertOid, gitObjectOid, assertPath, assertTicketId, sameIdentity,
  FlowError } from '../src/runtime/contracts.mjs';
import { validateContext } from '../src/runtime/context.mjs';

const context = () => ({ project_root_sha256: 'a'.repeat(64),
  epic_id: '11111111-1111-4111-8111-111111111111', anchor_version: 1,
  protocol_digest: 'b'.repeat(64), runtime_lock_digest: 'c'.repeat(64),
  project_instruction_digest: 'd'.repeat(64), delivery_profile_digest: 'e'.repeat(64) });

test('canonical runtime identities preserve Unicode, ignore key order, and terminate once', () => {
  assert.equal(canonicalBytes({ z: 2, a: 'é😀', ok: true }).toString(), '{"a":"é😀","ok":true,"z":2}\n');
  assert.ok(sameIdentity({ b: [null, false], a: 1 }, { a: 1, b: [null, false] }));
  assert.ok(compareCodePoints('\uE000', '😀') < 0);
  assert.ok(compareCodePoints('a', 'aa') < 0);
  assert.equal(compareCodePoints('a', 'a'), 0);
});

test('runtime hash preimage has an explicit domain and exact serialized bytes', () => {
  const data = { x: 1 };
  const expected = createHash('sha256').update('test/identity/v1\0').update('{"x":1}\n').digest('hex');
  assert.equal(digest('test/identity/v1', data), expected);
  assert.notEqual(expected, digest('test/identity/v2', data));
  for (const domain of ['', 'test', 'v1', 'test\0/v1', 'test/v0']) assert.throws(() => digest(domain, data));
});

test('non-JSON numbers, undefined, functions and non-NFC text cannot become identities', () => {
  for (const value of [undefined, () => {}, NaN, Infinity, 0.5, -0,
    Number.MAX_SAFE_INTEGER + 1, 1n, new Date(), new Map(), Buffer.from('x'),
    'e\u0301', '\uD800', 'a\0b', { x: undefined }]) {
    assert.throws(() => canonicalBytes(value));
  }
});

test('hidden properties, symbols and getters are rejected before getter invocation', () => {
  let called = 0;
  const record = { a: 1 };
  Object.defineProperty(record, 'b', { enumerable: true, get() { called++; return 2; } });
  assert.throws(() => canonicalBytes(record), { code: 'invalid_record' });
  assert.equal(called, 0);
  const hidden = { a: 1 }; Object.defineProperty(hidden, 'hidden', { value: 2 });
  assert.throws(() => canonicalBytes(hidden));
  assert.throws(() => canonicalBytes({ [Symbol('x')]: 1 }));
  assert.throws(() => closedRecord(Object.create({ a: 1 }), ['a']));
  assert.throws(() => closedRecord({ a: 1, b: 2 }, ['a']));
});

test('sparse/accessor arrays and cycles cannot become identities; shared data can', () => {
  assert.throws(() => canonicalBytes(Array(1)));
  const array = [1]; array.extra = 2;
  assert.throws(() => canonicalBytes(array));
  let called = 0; const accessor = [];
  Object.defineProperty(accessor, '0', { enumerable: true, get() { called++; return 1; } });
  assert.throws(() => canonicalBytes(accessor)); assert.equal(called, 0);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => canonicalBytes(cycle));
  const shared = { x: 1 }; assert.doesNotThrow(() => canonicalBytes([shared, shared]));
});

test('custom array prototypes are refused without invoking inherited methods', () => {
  for (const method of ['map', Symbol.iterator]) {
    let calls = 0;
    const array = [1];
    Object.setPrototypeOf(array, Object.assign(Object.create(Array.prototype), {
      [method]() { calls++; return method === 'map' ? ['1'] : [1][Symbol.iterator](); },
    }));
    assert.throws(() => canonicalBytes({ array }), { code: 'invalid_identity' });
    assert.equal(calls, 0);
  }
});

test('identity proxies are rejected before invoking traps', () => {
  for (const target of [{ value: 1 }, [1]]) {
    let calls = 0;
    const proxy = new Proxy(target, {
      get(object, key) { calls++; return Reflect.get(object, key); },
      getPrototypeOf(object) { calls++; return Reflect.getPrototypeOf(object); },
      ownKeys(object) { calls++; return Reflect.ownKeys(object); },
    });
    assert.throws(() => canonicalBytes(proxy), { code: 'invalid_identity' });
    assert.equal(calls, 0);
  }
  const { proxy, revoke } = Proxy.revocable({}, {}); revoke();
  assert.throws(() => closedRecord(proxy, []), { code: 'invalid_record' });
});

test('depth and byte budgets reject oversized identity before returning a digest', () => {
  let deep = null;
  for (let i = 0; i < 66; i++) deep = [deep];
  assert.throws(() => canonicalBytes(deep), { code: 'identity_limit' });
  assert.throws(() => canonicalBytes('x'.repeat(16_777_216)), { code: 'identity_limit' });
});

test('immutable copies detach source references and recursively freeze', () => {
  const raw = { a: [{ value: 1 }] }; const copy = immutable(raw);
  raw.a[0].value = 2;
  assert.equal(copy.a[0].value, 1); assert.ok(Object.isFrozen(copy.a[0]));
  assert.throws(() => { copy.a[0].value = 3; });
});

test('digests and object OIDs validate full identities and object types', () => {
  const hash = 'a'.repeat(64); assert.equal(assertDigest(hash), hash);
  assert.ok(equalDigest(hash, hash)); assert.equal(equalDigest(hash, 'b'.repeat(64)), false);
  for (const invalid of ['A'.repeat(64), 'a'.repeat(63), null]) assert.throws(() => assertDigest(invalid));
  assert.equal(assertOid('a'.repeat(40), 'sha1'), 'a'.repeat(40));
  assert.equal(assertOid(hash, 'sha256'), hash);
  for (const [oid, format] of [['0'.repeat(40), 'sha1'], [hash, 'sha1'], [hash, 'unknown']]) assert.throws(() => assertOid(oid, format));
  const bytes = Buffer.from('x');
  assert.equal(gitObjectOid('blob', bytes, 'sha1'), createHash('sha1').update('blob 1\0x').digest('hex'));
  assert.notEqual(gitObjectOid('blob', bytes, 'sha256'), gitObjectOid('tree', bytes, 'sha256'));
  assert.throws(() => gitObjectOid('wrong', bytes, 'sha1'));
});

test('lexical path validation and Ticket grammar do not claim filesystem custody', () => {
  assert.equal(assertPath('src/é/data.txt'), 'src/é/data.txt');
  for (const path of ['', '/absolute', '../parent', 'x//y', 'x/./y', 'x/.Git/y', 'C:/x', 'x\\y', 'x\0y', 'e\u0301']) assert.throws(() => assertPath(path));
  assert.equal(assertTicketId('T01'), 'T01'); assert.throws(() => assertTicketId('T1'));
});

test('controlling context requires exact fields, UUID, positive anchor and all locks', () => {
  assert.doesNotThrow(() => validateContext(context()));
  for (const patch of [{ anchor_version: 0 }, { anchor_version: 0.5 }, { epic_id: '../other' },
    { project_instruction_digest: null }, { extra: true }, { project_root_sha256: 'latest' }]) {
    assert.throws(() => validateContext({ ...context(), ...patch }));
  }
  const missing = context(); delete missing.runtime_lock_digest;
  assert.throws(() => validateContext(missing));
});

test('errors serialize stable machine codes and caller-provided diagnostics', () => {
  assert.deepEqual(new FlowError('invalid', 'message', { pointer: '/x' }).toJSON(),
    { code: 'invalid', message: 'message', details: { pointer: '/x' } });
});
