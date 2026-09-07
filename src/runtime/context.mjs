/** Closed controlling context for host-owned creation identities. No I/O or authority minting. */
import { closedRecord, assertDigest, demand } from './contracts.mjs';

export const CONTEXT_FIELDS = Object.freeze(['project_root_sha256', 'epic_id', 'anchor_version',
  'protocol_digest', 'runtime_lock_digest', 'project_instruction_digest', 'delivery_profile_digest']);
export function validateContext(context) {
  closedRecord(context, CONTEXT_FIELDS);
  for (const field of CONTEXT_FIELDS.filter((key) => key.endsWith('digest') || key.endsWith('sha256'))) assertDigest(context[field], `/${field}`);
  demand(typeof context.epic_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(context.epic_id),
    'invalid_epic_id', 'Epic identity must be an immutable UUID');
  demand(Number.isSafeInteger(context.anchor_version) && context.anchor_version > 0, 'invalid_anchor', 'Invalid anchor version');
}
