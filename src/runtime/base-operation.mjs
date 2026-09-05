/** Crash-safe execution-base publication over autoskd-owned state and custody ports. */
import { FlowError, demand, closedRecord, digest, immutable, sameIdentity, assertDigest } from './contracts.mjs';
import { assertExecutionPlan, materializeExecutionObjects } from './execution-base.mjs';
import { requireEvidence } from './published-tickets.mjs';

const PHASES = Object.freeze(['prepared', 'objects_verified', 'retained', 'verified']);
const RECORD_FIELDS = ['schema_version', 'operation_id', 'key', 'plan_identity', 'recovery_target_digest',
  'commit_oid', 'tree_oid', 'retention_ref', 'phase', 'object_receipt', 'custody_receipt'];

function operationKey(plan) {
  const context = plan.identity.context;
  return `execution-base:${context.project_root_sha256}:${context.epic_id}:${plan.identity.target_ticket_id ?? 'staging'}`;
}
export function retentionRequest(plan) {
  assertExecutionPlan(plan);
  const context = plan.identity.context;
  const namespace = digest('autosk-flow/execution-base-namespace/v1', {
    project_root_sha256: context.project_root_sha256, epic_id: context.epic_id,
  });
  return immutable({ schema_version: 1,
    operation_id: digest('autosk-flow/execution-base-operation/v1', { key: operationKey(plan), plan_identity: plan.identity_digest }),
    project_root_sha256: context.project_root_sha256,
    ref: `refs/autosk/epics/${namespace}/execution-bases/${plan.identity_digest}`,
    expected_old_oid: null, commit_oid: plan.execution_base_oid, tree_oid: plan.tree_oid,
    plan_identity: plan.identity_digest, recovery_target_digest: plan.recovery_target_digest });
}
function initialOperation(plan) {
  const request = retentionRequest(plan);
  return immutable({ schema_version: 1, operation_id: request.operation_id, key: operationKey(plan),
    plan_identity: plan.identity_digest, recovery_target_digest: plan.recovery_target_digest,
    commit_oid: plan.execution_base_oid, tree_oid: plan.tree_oid, retention_ref: request.ref,
    phase: 'prepared', object_receipt: null, custody_receipt: null });
}
function validateOperation(operation, expected) {
  closedRecord(operation, RECORD_FIELDS);
  demand(PHASES.includes(operation.phase), 'operation_corrupt', 'Unknown operation phase');
  for (const field of RECORD_FIELDS.filter((key) => !['phase', 'object_receipt', 'custody_receipt'].includes(key))) {
    demand(sameIdentity(operation[field], expected[field]), 'operation_identity_mismatch', 'Active operation belongs to a different candidate', { field });
  }
  const phase = PHASES.indexOf(operation.phase);
  demand((phase >= 1) === (operation.object_receipt !== null)
    && (phase >= 2) === (operation.custody_receipt !== null), 'operation_corrupt', 'Invalid durable receipt prefix');
}
function checkCustody(custody, request, receipt) {
  demand(receipt && typeof receipt === 'object' && custody.verify(request, receipt) === true,
    'custody_receipt_invalid', 'Retention requires exact helper-journal ownership evidence');
  // The custody port verifies signature, reflog/journal continuity and project binding.
  demand(receipt.operation_id === request.operation_id && receipt.ref === request.ref
    && receipt.commit_oid === request.commit_oid && receipt.tree_oid === request.tree_oid,
  'custody_receipt_invalid', 'Custody receipt does not bind this operation');
  assertDigest(receipt.receipt_digest);
}

/**
 * state implements read(key) and compareAndSwap(key, revision, record), atomically in autoskd.
 * custody implements idempotent retain/observe/verify using the protected ref owner.
 * Neither port may be reconstructed from model-authored JSON. No default unsafe port exists.
 */
export async function publishExecutionBase({ git, plan, state, custody, authority, maxTransitions = 12 }) {
  assertExecutionPlan(plan);
  demand(state?.capabilities?.atomic_projection_cas === true
    && typeof state.read === 'function' && typeof state.compareAndSwap === 'function',
  'daemon_capability_missing', 'autoskd atomic projection CAS is required');
  demand(custody?.capabilities?.journaled_ref_cas === true
    && ['retain', 'observe', 'verify'].every((key) => typeof custody[key] === 'function'),
  'custody_capability_missing', 'Protected journaled ref custody is required');
  demand(Number.isSafeInteger(maxTransitions) && maxTransitions >= 1 && maxTransitions <= 100,
    'invalid_limit', 'Invalid operation retry budget');
  const expected = initialOperation(plan); const request = retentionRequest(plan);
  for (let attempt = 0; attempt < maxTransitions; attempt += 1) {
    requireEvidence(authority, 'execution_plan_current', { context: plan.identity.context,
      publication_binding_digest: plan.identity.publication_binding_digest, identity_digest: plan.identity_digest });
    const stored = await state.read(expected.key);
    closedRecord(stored, ['revision', 'value']);
    demand(Number.isSafeInteger(stored.revision) && stored.revision >= 0,
      'operation_corrupt', 'Invalid daemon projection revision');
    if (stored.value === null) {
      const result = await state.compareAndSwap(expected.key, stored.revision, expected);
      demand(['applied', 'conflict'].includes(result), 'daemon_response_invalid', 'Invalid atomic write response');
      continue;
    }
    validateOperation(stored.value, expected);
    const operation = immutable(stored.value);
    if (operation.object_receipt !== null) {
      demand(sameIdentity(operation.object_receipt, {
        schema_version: 1, identity_digest: plan.identity_digest,
        commit_oid: plan.execution_base_oid, tree_oid: plan.tree_oid,
        recovery_target_digest: plan.recovery_target_digest, status: 'objects_verified_not_retained',
      }), 'operation_corrupt', 'Stored object receipt is not bound to this exact plan');
    }
    let next;
    if (operation.phase === 'prepared') {
      // Lost response or pruned unpublished objects: same bytes, same OIDs, no duplicate identity.
      const receipt = materializeExecutionObjects(git, plan);
      next = { ...operation, phase: 'objects_verified', object_receipt: receipt };
    } else if (operation.phase === 'objects_verified') {
      const actual = materializeExecutionObjects(git, plan);
      demand(sameIdentity(actual, operation.object_receipt), 'operation_corrupt', 'Object receipt mismatch');
      const receipt = await custody.retain(request);
      checkCustody(custody, request, receipt);
      next = { ...operation, phase: 'retained', custody_receipt: receipt };
    } else {
      const observation = await custody.observe(request);
      checkCustody(custody, request, observation);
      demand(sameIdentity(observation, operation.custody_receipt), 'custody_foreign_movement',
        'Retention state is not the journaled transition');
      const commit = git.verifySnapshot(operation.commit_oid);
      demand(commit.tree_oid === operation.tree_oid, 'operation_corrupt', 'Retained commit does not match verified tree');
      requireEvidence(authority, 'execution_plan_current', { context: plan.identity.context,
        publication_binding_digest: plan.identity.publication_binding_digest, identity_digest: plan.identity_digest });
      if (operation.phase === 'verified') return immutable({ schema_version: 1,
        status: 'verified', operation_id: operation.operation_id, plan_identity: operation.plan_identity,
        commit_oid: operation.commit_oid, tree_oid: operation.tree_oid,
        recovery_target_digest: operation.recovery_target_digest,
        custody_receipt_digest: operation.custody_receipt.receipt_digest });
      next = { ...operation, phase: 'verified' };
    }
    const result = await state.compareAndSwap(expected.key, stored.revision, immutable(next));
    demand(['applied', 'conflict'].includes(result), 'daemon_response_invalid', 'Invalid atomic write response');
  }
  throw new FlowError('operation_retry_exhausted', 'Atomic operation retry budget exhausted');
}
