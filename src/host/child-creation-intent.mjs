/** Compile a trusted dispatch decision to autoskd's write-once creation pair.
 * This function does not authorize a provider, create/enroll tasks or move refs.
 * The daemon capability boundary remains a separate, mandatory dependency.
 */
import { closedRecord, demand, assertDigest, digest, immutable } from '../runtime/contracts.mjs';
import { validateContext } from '../runtime/context.mjs';
export const CHILD_CREATION_INTENT_FIELDS = Object.freeze([
  'schema_version', 'context', 'parent_task_id', 'operation_id', 'slot_id',
  'child_role', 'seat', 'candidate_digest', 'target_workflow', 'initial_step',
  'provider_session_intent_digest', 'sandbox_snapshot_intent_digest',
]);
const identifier = (value, field) => demand(typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value),
'invalid_creation_intent', 'Invalid bounded logical identifier', { field });
export function compileChildCreationIntent(input) {
  closedRecord(input, CHILD_CREATION_INTENT_FIELDS);
  demand(input.schema_version === 1, 'invalid_creation_intent', 'Unsupported creation intent version');
  validateContext(input.context);
  demand(typeof input.parent_task_id === 'string' && /^ask-[a-f0-9]{6}$/u.test(input.parent_task_id),
    'invalid_creation_intent', 'An actual parent task ID is required');
  for (const field of ['operation_id', 'slot_id', 'child_role', 'target_workflow', 'initial_step']) identifier(input[field], field);
  if (input.seat !== null) identifier(input.seat, 'seat');
  for (const field of ['candidate_digest', 'provider_session_intent_digest', 'sandbox_snapshot_intent_digest']) assertDigest(input[field], `/${field}`);
  const intent = immutable(input);
  // A changed candidate, role, seat, route/session or lock is a BINDING conflict
  // for an existing logical slot, not a license to silently create a new child.
  const slot = { schema_version: 1, project_root_sha256: intent.context.project_root_sha256,
    parent_task_id: intent.parent_task_id, operation_id: intent.operation_id, slot_id: intent.slot_id };
  return immutable({ schema_version: 1,
    creation_key: `flow:${digest('autosk-flow/child-creation-slot/v1', slot)}`,
    creation_binding_hash: digest('autosk-flow/child-creation-binding/v1', intent),
  });
}
