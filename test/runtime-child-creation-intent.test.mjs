import test from 'node:test';
import assert from 'node:assert/strict';
import { compileChildCreationIntent } from '../src/host/child-creation-intent.mjs';
const base = () => ({ schema_version: 1,
  context: { project_root_sha256: '1'.repeat(64), epic_id: '11111111-1111-4111-8111-111111111111', anchor_version: 1,
    protocol_digest: '2'.repeat(64), runtime_lock_digest: '3'.repeat(64), project_instruction_digest: '4'.repeat(64), delivery_profile_digest: '5'.repeat(64) },
  parent_task_id: 'ask-123abc', operation_id: 'operation-01', slot_id: 'panel:gpt', child_role: 'panel_seat', seat: 'gpt',
  candidate_digest: '6'.repeat(64), target_workflow: 'autosk-artifact-panel', initial_step: 'review',
  provider_session_intent_digest: '7'.repeat(64), sandbox_snapshot_intent_digest: '8'.repeat(64) });
test('creation pair is reproducible, bounded and immutable', () => {
  const original = base(); const a = compileChildCreationIntent(original);
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  assert.deepEqual(a, compileChildCreationIntent(reordered));
  assert.match(a.creation_key, /^flow:[a-f0-9]{64}$/u); assert.match(a.creation_binding_hash, /^[a-f0-9]{64}$/u);
  assert.ok(Object.isFrozen(a)); original.context.anchor_version++;
  assert.notEqual(a.creation_binding_hash, compileChildCreationIntent(original).creation_binding_hash);
});
for (const [field, value] of [
  ['child_role', 'code_reviewer'], ['seat', 'opus'], ['candidate_digest', '9'.repeat(64)],
  ['target_workflow', 'different-flow'], ['initial_step', 'different-step'],
  ['provider_session_intent_digest', '9'.repeat(64)], ['sandbox_snapshot_intent_digest', '9'.repeat(64)],
]) test(`changed ${field} conflicts within the same logical creation slot`, () => {
  const original = compileChildCreationIntent(base()); const changed = compileChildCreationIntent({ ...base(), [field]: value });
  assert.equal(changed.creation_key, original.creation_key); assert.notEqual(changed.creation_binding_hash, original.creation_binding_hash);
});
for (const field of ['protocol_digest', 'runtime_lock_digest', 'project_instruction_digest', 'delivery_profile_digest']) {
  test(`changed ${field} is not a new logical child`, () => {
    const input = base(); const before = compileChildCreationIntent(input); input.context[field] = '9'.repeat(64);
    const after = compileChildCreationIntent(input); assert.equal(after.creation_key, before.creation_key);
    assert.notEqual(after.creation_binding_hash, before.creation_binding_hash);
  });
}
for (const field of ['parent_task_id', 'operation_id', 'slot_id', 'project_root_sha256']) {
  test(`changed ${field} has a separate creation namespace`, () => {
    const input = base(); const before = compileChildCreationIntent(input);
    if (field === 'project_root_sha256') input.context[field] = 'a'.repeat(64);
    else input[field] = field === 'parent_task_id' ? 'ask-aabbcc' : 'another-slot';
    const after = compileChildCreationIntent(input); assert.notEqual(after.creation_key, before.creation_key);
    assert.notEqual(after.creation_binding_hash, before.creation_binding_hash);
  });
}
test('human title and description cannot accidentally become controlling intent', () => {
  for (const field of ['title', 'description']) assert.throws(() => compileChildCreationIntent({ ...base(), [field]: 'human summary' }), { code: 'invalid_record' });
});
test('incomplete, malformed, model-selected transition and accessor intents fail closed', () => {
  const missing = base(); delete missing.seat;
  assert.throws(() => compileChildCreationIntent(missing), { code: 'invalid_record' });
  for (const patch of [{ schema_version: 2 }, { parent_task_id: '../../user' }, { initial_step: 'step\nthen rm' }, { seat: '' }, { candidate_digest: 'latest' }]) {
    assert.throws(() => compileChildCreationIntent({ ...base(), ...patch }));
  }
  let ran = false; const getter = base(); Object.defineProperty(getter, 'candidate_digest', { enumerable: true, get() { ran = true; return 'a'.repeat(64); } });
  assert.throws(() => compileChildCreationIntent(getter)); assert.equal(ran, false);
});
