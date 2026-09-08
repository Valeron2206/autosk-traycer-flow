import test from 'node:test';
import assert from 'node:assert/strict';
import { requireDaemonCapabilities, REQUIRED_DAEMON_CAPABILITIES } from '../src/host/daemon-preflight.mjs';
import { loadAutoskManifest } from '../scripts/prepare-autosk.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const report = (overrides = {}) => ({
  capabilities: [{ name: 'task.creation-binding', version: 2, methods: ['task.create_bound'], ...overrides }],
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
    capabilities: [{ name: 'task.creation-binding', version: 2, methods: ['task.create_bound'] }] });
  assert.ok(Object.isFrozen(admitted));
  assert.ok(Object.isFrozen(admitted.capabilities[0]));
});

test('the required set is exactly what #11 delivers, at the revision this flow was written for', () => {
  assert.deepEqual([...REQUIRED_DAEMON_CAPABILITIES],
    [{ name: 'task.creation-binding', version: 2, methods: ['task.create_bound'] }]);
  assert.ok(Object.isFrozen(REQUIRED_DAEMON_CAPABILITIES));
});

test('a required capability implemented by a different method is refused', () => {
  // Refusing an EMPTY method list because it could not have been derived, and then
  // never looking at the one non-empty list we are handed, would let a renamed
  // method through the very check written to notice it.
  refuses(report({ methods: ['task.create_unbound'] }), 'daemon_capability_method_mismatch');
  refuses(report({ methods: ['task.create_bound', 'task.create_extra'] }), 'daemon_capability_method_mismatch');
});

test('a capability naming the same method twice, or sharing one, is refused', () => {
  refuses(report({ methods: ['task.create_bound', 'task.create_bound'] }), 'daemon_capability_invalid');
  refuses({ capabilities: [
    { name: 'task.creation-binding', version: 2, methods: ['task.create_bound'] },
    { name: 'other.thing', version: 1, methods: ['task.create_bound'] },
  ] }, 'daemon_capability_invalid');
});

test('a daemon without the capability does not start the flow', () => {
  refuses({ capabilities: [] }, 'daemon_capability_missing');
  refuses({ capabilities: [{ name: 'other.thing', version: 1, methods: ['x'] }] }, 'daemon_capability_missing');
});

test('any revision but the required one is refused, in both directions', () => {
  // The revision is incremented exactly when a client must notice the change, so
  // accepting a higher one would accept the change the increment exists to warn about.
  refuses(report({ version: 3 }), 'daemon_capability_version_mismatch');
  refuses(report({ version: 99 }), 'daemon_capability_version_mismatch');
  // And an EARLIER one is the case that matters now: a v1 daemon accepts bound
  // creates with no session attached, which is the gap #10 criterion 7 closes.
  // Starting on it would run the flow against the very hole it requires closed.
  refuses(report({ version: 1 }), 'daemon_capability_version_mismatch');
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
    { name: 'task.creation-binding', version: 2, methods: ['task.create_bound'] },
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

/** Rebuilds one file as the shipped patch series actually leaves it.
 * Regexing the patch text would not do: patches are append-only by policy, so
 * patch 0013's lines stay in the series for ever and keep matching even after a
 * later patch renames, edits or deletes the declaration. Applying the series is
 * the only way to read what a built daemon would contain, and it needs no network
 * because this file is created by the series itself.
 */
function shippedFile(relativePath) {
  const { patches } = loadAutoskManifest();
  const dir = mkdtempSync(join(tmpdir(), 'autosk-declared-'));
  try {
    for (const patch of patches) {
      if (!patch.content.toString('utf8').includes(relativePath)) continue;
      execFileSync('git', ['apply', `--include=${relativePath}`, '-p1', '-'],
        { cwd: dir, input: patch.content, stdio: ['pipe', 'pipe', 'pipe'] });
    }
    const file = join(dir, relativePath);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('what this flow requires is what the shipped daemon source declares', () => {
  // The required set and the daemon's declaration live in two repositories. This
  // compares against the source the pinned series actually produces, so a rename,
  // a revision bump, a reformat or an outright deletion in ANY patch fails here
  // rather than at runtime on a user's machine.
  const source = shippedFile('daemon/core/src/rpc/capabilities.ts');
  assert.ok(source, 'the daemon capability module is not present in the shipped series');
  const declared = [...source.matchAll(
    /\{ name: "([^"]+)", version: (\d+), methods: \[([^\]]*)\] \}/gu,
  )].map(([, name, version, methods]) => ({
    name,
    version: Number(version),
    methods: methods.split(',').map((m) => m.trim().replace(/^"|"$/gu, '')).filter((m) => m.length > 0),
  }));
  for (const want of REQUIRED_DAEMON_CAPABILITIES) {
    const have = declared.filter((entry) => entry.name === want.name);
    assert.equal(have.length, 1, `expected exactly one declaration of ${want.name} in the shipped source`);
    assert.deepEqual(have[0], { name: want.name, version: want.version, methods: [...want.methods] },
      `${want.name} is declared differently than this flow requires`);
  }
  // A capability the daemon gained and this flow has never seen is not a failure —
  // the flow requires a subset — but two capabilities must never share a method,
  // which `requireDaemonCapabilities` refuses at runtime too.
  const claimed = declared.flatMap((entry) => entry.methods);
  assert.equal(new Set(claimed).size, claimed.length, 'two declared capabilities share a method');
});
