/** The prompt compiler: which governance bytes a role and stage receive, and the echo that proves it.
 *
 * A reference is not a delivery. "Read `protocol/playbooks/feature.md`" assumes
 * the child can reach the bundle, that it reads the version the Epic is locked
 * to, and that it read it at all. So the orchestrator inserts the bytes, labels
 * them, and the child echoes the labels back.
 *
 * The compiler reads the pinned bundle and never live protocol: an Epic that
 * silently upgraded its rules mid-flight has changed the question it is
 * answering.
 */
import { createHash } from 'node:crypto';

import { demand, immutable } from '../runtime/contracts.mjs';

export const REFUSALS = immutable([
  'carrier_mapping_unknown',
  'carrier_file_missing',
  'carrier_forbidden_fragment',
  'carrier_bundle_unpinned',
  'carrier_budget_exceeded',
  'carrier_echo_missing',
  'carrier_echo_mismatch',
  'carrier_echo_wrong_scope',
  'carrier_echo_duplicate',
  'carrier_coverage_incomplete',
]);

/** The fields an attribution header carries, in the order it serialises them. */
export const HEADER_FIELDS = immutable([
  'logical_id',
  'file_sha256',
  'range_digest',
  'bundle_digest',
  'project',
  'epic',
  'task',
  'role',
  'stage',
  'dispatch_id',
  'round',
  'attempt',
  'serialization_version',
]);

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The carrier key for a role at a stage. */
export function carrierKey(role, stage) {
  return `${role}.${stage}`;
}

/**
 * The mapping for a key, or a refusal.
 *
 * Fail-closed before the provider call: guessing a mapping is how a role
 * silently receives someone else's context.
 */
export function mappingFor(registry, role, stage) {
  const key = carrierKey(role, stage);
  const mapping = registry.carriers[key];
  demand(Boolean(mapping), 'carrier_mapping_unknown', 'No carrier mapping for this role and stage', { key });
  return mapping;
}

/**
 * Every governance file has a consumer, or says why it does not.
 *
 * A file that appears in no `required` set and is not marked inactive is a file
 * nobody can say why we ship.
 */
export function coverageErrors(registry) {
  const consumed = new Set();
  for (const mapping of Object.values(registry.carriers)) {
    for (const path of mapping.required) consumed.add(path);
  }
  const errors = [];
  for (const file of registry.governance_files) {
    if (consumed.has(file.path)) continue;
    if (file.status === 'inactive_in_v1' && file.decided_by) continue;
    errors.push({
      reason: 'carrier_coverage_incomplete',
      path: file.path,
      detail: file.status === 'inactive_in_v1' ? 'inactive without the decision that made it so' : 'no consumer',
    });
  }
  return errors;
}

/** The canonical header for one inserted fragment. */
export function attributionHeader(fragment, context) {
  const header = {
    logical_id: fragment.logical_id,
    file_sha256: fragment.file_sha256,
    // Present only for an extract: the whole file needs no range.
    range_digest: fragment.range_digest ?? null,
    bundle_digest: context.bundle_digest,
    project: context.project,
    epic: context.epic,
    task: context.task,
    role: context.role,
    stage: context.stage,
    dispatch_id: context.dispatch_id,
    round: context.round,
    attempt: context.attempt,
    serialization_version: context.serialization_version,
  };
  return Object.freeze(header);
}

/** The header as bytes, in the fixed field order. */
export function serializeHeader(header) {
  return HEADER_FIELDS.map((field) => `${field}=${String(header[field])}`).join('\n');
}

/**
 * Compiles the fragments for one dispatch.
 *
 * Deterministic: declared order, the same inputs serialise to the same bytes.
 * `bundle.read` returns the pinned bytes — the compiler never reads live
 * protocol.
 */
export function compileCarrier(registry, { role, stage, context, bundle, anchors = {} }) {
  demand(Boolean(context.bundle_digest) && context.bundle_digest === registry.bundle_digest,
    'carrier_bundle_unpinned', 'The dispatch is not pinned to the registry bundle',
    { registry: registry.bundle_digest, dispatch: context.bundle_digest });

  const mapping = mappingFor(registry, role, stage);
  const fragments = [];
  for (const path of mapping.required) {
    const bytes = bundle.read(path);
    demand(typeof bytes === 'string', 'carrier_file_missing', 'A required governance file is not in the bundle',
      { path });
    // The forbidden set is not decoration: the Judge rubric reaching an Arena
    // candidate is the failure it exists to prevent.
    demand(!mapping.forbidden.includes(path), 'carrier_forbidden_fragment',
      'A fragment this key must never receive was about to be inserted', { path });
    fragments.push({ logical_id: path, file_sha256: sha256(bytes), bytes });
  }
  for (const anchor of mapping.anchors) {
    const value = anchors[anchor];
    demand(typeof value === 'string', 'carrier_file_missing', 'A required anchor was not supplied', { anchor });
    fragments.push({ logical_id: `anchor:${anchor}`, file_sha256: sha256(value), bytes: value });
  }

  const headers = fragments.map((fragment) => attributionHeader(fragment, { ...context, role, stage }));
  const body = fragments
    .map((fragment, index) => `${serializeHeader(headers[index])}\n---\n${fragment.bytes}`)
    .join('\n===\n');
  const size = Buffer.byteLength(body, 'utf8');
  demand(size <= registry.budget.max_bytes, 'carrier_budget_exceeded',
    'The compiled carrier is larger than the fixed budget', { size, max: registry.budget.max_bytes });

  return Object.freeze({
    key: carrierKey(role, stage),
    headers: immutable(headers),
    body,
    size,
    body_sha256: sha256(body),
  });
}

/**
 * Compares the child's echo against what was sent, field by field.
 *
 * A missing or mismatched echo is a blocking non-verdict: the child answered a
 * question the host cannot confirm it was asked, and neither "it passed" nor
 * "it failed" is a truthful summary of that.
 */
export function verifyEcho(sentHeaders, received) {
  const reasons = [];
  if (!Array.isArray(received) || received.length === 0) {
    return [{ reason: 'carrier_echo_missing', detail: 'no attributions were echoed' }];
  }
  const seen = new Set();
  for (const echo of received) {
    const id = echo.logical_id;
    if (seen.has(id)) reasons.push({ reason: 'carrier_echo_duplicate', detail: id });
    seen.add(id);
    const sent = sentHeaders.find((header) => header.logical_id === id);
    if (!sent) {
      // Echoing something that was not sent is not a mismatch of a fragment; it
      // is a claim about a different dispatch.
      reasons.push({ reason: 'carrier_echo_wrong_scope', detail: id });
      continue;
    }
    for (const field of HEADER_FIELDS) {
      if (String(echo[field] ?? null) !== String(sent[field])) {
        reasons.push({ reason: 'carrier_echo_mismatch', detail: `${id}.${field}` });
      }
    }
  }
  for (const header of sentHeaders) {
    if (!seen.has(header.logical_id)) {
      reasons.push({ reason: 'carrier_echo_missing', detail: header.logical_id });
    }
  }
  return reasons;
}

/**
 * A retry mints a new dispatch identity and fresh headers.
 *
 * Reusing the dispatch identity would make the second attempt indistinguishable
 * from the first in the record, which is precisely what the echo exists to make
 * distinguishable. The candidate does not change.
 */
export function retryContext(context, nextDispatchId) {
  demand(nextDispatchId !== context.dispatch_id, 'carrier_echo_wrong_scope',
    'A retry mints a new dispatch identity', { dispatch_id: context.dispatch_id });
  return Object.freeze({ ...context, dispatch_id: nextDispatchId, attempt: context.attempt + 1 });
}

/**
 * The bytes two seats share.
 *
 * The common panel and anchor bytes are byte-identical across seats; only the
 * role contract differs, so a disagreement between seats is about the lens and
 * not about what they were shown.
 */
export function sharedBytes(compiledA, compiledB) {
  const byId = new Map(compiledB.headers.map((header) => [header.logical_id, header]));
  return compiledA.headers
    .filter((header) => byId.has(header.logical_id))
    .filter((header) => byId.get(header.logical_id).file_sha256 === header.file_sha256)
    .map((header) => header.logical_id)
    .sort();
}
