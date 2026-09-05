/** Closed schema registered with autoskd's host-projection authority. */
import { readFileSync } from 'node:fs';
import { closedRecord, demand, assertDigest, assertOid, sha256, digest } from '../runtime/contracts.mjs';

const SCHEMA_DIGEST = digest('autosk-flow/execution-projection-schema/v1', {
  schema: sha256(readFileSync(new URL(import.meta.url))),
  contracts: sha256(readFileSync(new URL('../runtime/contracts.mjs', import.meta.url))),
});
const FIELDS = ['schema_version', 'operation_id', 'key', 'plan_identity', 'recovery_target_digest',
  'commit_oid', 'tree_oid', 'retention_ref', 'phase', 'object_receipt', 'custody_receipt'];
const PHASES = ['prepared', 'objects_verified', 'retained', 'verified'];
export function validateExecutionProjection(key, record) {
  closedRecord(record, FIELDS);
  demand(record.schema_version === 1 && record.key === key && /^execution-base:[a-f0-9]{64}:[A-Za-z0-9._-]{1,128}:(?:T[0-9]{2,8}|staging)$/u.test(key),
    'projection_binding_mismatch', 'Execution projection key or version is invalid');
  for (const field of ['operation_id', 'plan_identity', 'recovery_target_digest']) assertDigest(record[field]);
  const format = typeof record.commit_oid === 'string' && record.commit_oid.length === 40 ? 'sha1' : 'sha256';
  assertOid(record.commit_oid, format); assertOid(record.tree_oid, format);
  demand(typeof record.retention_ref === 'string'
    && new RegExp(`^refs/autosk/epics/[a-f0-9]{64}/execution-bases/${record.plan_identity}$`, 'u').test(record.retention_ref),
  'projection_binding_mismatch', 'Projection retention ref does not bind the plan');
  const phase = PHASES.indexOf(record.phase);
  demand(phase >= 0 && (phase >= 1) === (record.object_receipt !== null)
    && (phase >= 2) === (record.custody_receipt !== null), 'projection_phase_invalid', 'Invalid execution-operation receipt prefix');
  if (record.object_receipt !== null) {
    const receipt = record.object_receipt;
    closedRecord(receipt, ['schema_version', 'identity_digest', 'commit_oid', 'tree_oid', 'recovery_target_digest', 'status']);
    demand(receipt.schema_version === 1 && receipt.identity_digest === record.plan_identity
      && receipt.commit_oid === record.commit_oid && receipt.tree_oid === record.tree_oid
      && receipt.recovery_target_digest === record.recovery_target_digest && receipt.status === 'objects_verified_not_retained',
    'projection_binding_mismatch', 'Object receipt does not bind the execution projection');
  }
  if (record.custody_receipt !== null) {
    // Custody has its own separately pinned closed schema and verifier. At this
    // storage boundary require its controlling binding, but do not impersonate
    // that authority or convert an arbitrary receipt to an approved result.
    const receipt = record.custody_receipt;
    demand(receipt && typeof receipt === 'object' && !Array.isArray(receipt)
      && receipt.operation_id === record.operation_id && receipt.ref === record.retention_ref
      && receipt.commit_oid === record.commit_oid && receipt.tree_oid === record.tree_oid,
    'projection_binding_mismatch', 'Custody receipt does not bind the operation');
    assertDigest(receipt.receipt_digest);
  }
  return true;
}
export function executionProjectionSchema() {
  return Object.freeze({ id: 'execution-base-v1',
    sha256: SCHEMA_DIGEST, validate: validateExecutionProjection });
}
