import test from 'node:test';
import assert from 'node:assert/strict';
import { requireDaemonCapabilities, REQUIRED_DAEMON_CAPABILITIES } from '../src/host/daemon-preflight.mjs';
import { loadAutoskManifest } from '../scripts/prepare-autosk.mjs';

const report = (overrides = {}) => ({
  capabilities: [{ name: 'task.creation-binding', version: 1, methods: ['task.create_bound'], ...overrides }],
});
const refuses = (input, code) => {
  assert.throws(() => requireDaemonCapabilities(input), (error) => {
    assert.equal(error.name, 'FlowError');
    assert.equal(error.code, code);
    return true;
  });
};

test('a daemon with the required capability is admitted and the report is pinned', () => {
  const admitted = requireDaemonCapabilities(report());
  assert.deepEqual(admitted, { schema_version: 1,
    capabilities: [{ name: 'task.creation-binding', version: 1, methods: ['task.create_bound'] }] });
  assert.ok(Object.isFrozen(admitted));
  assert.ok(Object.isFrozen(admitted.capabilities[0]));
});

test('the required set is exactly what #11 delivers, at the revision this flow was written for', () => {
  assert.deepEqual([...REQUIRED_DAEMON_CAPABILITIES], [{ name: 'task.creation-binding', version: 1 }]);
  assert.ok(Object.isFrozen(REQUIRED_DAEMON_CAPABILITIES));
});

test('a daemon without the capability does not start the flow', () => {
  refuses({ capabilities: [] }, 'daemon_capability_missing');
  refuses({ capabilities: [{ name: 'other.thing', version: 1, methods: ['x'] }] }, 'daemon_capability_missing');
});

test('a later revision is refused, not accepted as "at least"', () => {
  // The revision is incremented exactly when a client must notice the change, so
  // accepting a higher one would accept the change the increment exists to warn about.
  refuses(report({ version: 2 }), 'daemon_capability_version_mismatch');
  refuses(report({ version: 99 }), 'daemon_capability_version_mismatch');
});

test('a capability that names no method is a claim, not a report', () => {
  // The daemon derives the list from its live handler table, so an entry with no
  // methods cannot have come from there.
  refuses(report({ methods: [] }), 'daemon_capability_invalid');
});

test('an unreadable report is a refusal, never a downgrade', () => {
  // Nothing here is evidence of the guarantee, so every one of them must stop the
  // flow. Which refusal code fires is not the point; that none of them pass is.
  const REFUSALS = new Set(['invalid_record', 'daemon_capability_invalid']);
  for (const input of [
    null, undefined, 'capabilities', 42, [], true,
    { capabilities: null }, { capabilities: {} }, { capabilities: 'task.creation-binding' },
    { capabilities: [], extra: 1 }, {},
  ]) {
    assert.throws(() => requireDaemonCapabilities(input), (error) => {
      assert.equal(error.name, 'FlowError');
      assert.ok(REFUSALS.has(error.code), `unexpected code ${error.code} for ${JSON.stringify(input)}`);
      return true;
    }, `expected a refusal for ${JSON.stringify(input)}`);
  }
});

test('malformed entries are refused field by field', () => {
  refuses({ capabilities: [{ name: 'task.creation-binding', version: 1 }] }, 'invalid_record');
  refuses({ capabilities: [{ name: 'task.creation-binding', version: 1, methods: ['x'], extra: 1 }] }, 'invalid_record');
  refuses(report({ name: 'Task.Creation-Binding' }), 'daemon_capability_invalid');
  refuses(report({ version: 0 }), 'daemon_capability_invalid');
  refuses(report({ version: 1.5 }), 'daemon_capability_invalid');
  refuses(report({ methods: ['x', 42] }), 'daemon_capability_invalid');
  refuses(report({ methods: 'task.create_bound' }), 'daemon_capability_invalid');
});

test('the same capability reported twice is refused rather than deduplicated', () => {
  refuses({ capabilities: [
    { name: 'task.creation-binding', version: 1, methods: ['task.create_bound'] },
    { name: 'task.creation-binding', version: 2, methods: ['task.create_bound'] },
  ] }, 'daemon_capability_invalid');
});

test('an oversized list is refused', () => {
  const many = Array.from({ length: 65 }, (_, i) => ({ name: `cap.${i}`, version: 1, methods: ['x'] }));
  refuses({ capabilities: many }, 'daemon_capability_invalid');
});

test('accessors and array holes cannot smuggle a capability past validation', () => {
  const sparse = [];
  sparse.length = 1;
  refuses({ capabilities: sparse }, 'daemon_capability_invalid');
  const accessor = [];
  Object.defineProperty(accessor, '0', { enumerable: true, get: () => report().capabilities[0] });
  refuses({ capabilities: accessor }, 'daemon_capability_invalid');
});

test('a proxy report is refused', () => {
  refuses(new Proxy(report(), {}), 'invalid_record');
  refuses({ capabilities: new Proxy(report().capabilities, {}) }, 'daemon_capability_invalid');
});

test('what this flow requires is what the shipped daemon patches declare', () => {
  // The required set and the daemon's declaration live in two repositories, so
  // without this they are two constants kept equal by hand. The patch bytes are
  // pinned by SHA-256 in the manifest, so comparing against them compares against
  // exactly what gets built — a version bump or rename on the daemon side fails
  // here instead of at runtime on a user's machine.
  const { manifest, patches } = loadAutoskManifest();
  assert.ok(patches.length === manifest.patches.length && patches.length > 0);
  const series = patches.map((patch) => patch.content.toString('utf8')).join('\n');
  for (const want of REQUIRED_DAEMON_CAPABILITIES) {
    const declarations = [...series.matchAll(
      new RegExp(`\\{ name: "${want.name.replace(/[.]/gu, '\\.')}", version: (\\d+), methods: \\[([^\\]]*)\\] \\}`, 'gu'),
    )];
    // The literal appears in the daemon source and in the daemon's own tests, so the
    // check is not "exactly once" but "every occurrence agrees with what this flow
    // requires" — a bump on the daemon side leaves at least one that does not.
    assert.ok(declarations.length >= 1, `${want.name} is not declared anywhere in the series`);
    for (const [, version, methods] of declarations) {
      assert.equal(Number(version), want.version,
        `${want.name} is declared at a different revision than this flow requires`);
      assert.ok(methods.trim().length > 0, `${want.name} is declared without methods`);
    }
  }
});
