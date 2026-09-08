/** The delivery profile: what this project allows, and what that forbids here.
 *
 * A flow that assumes it may move a branch will discover otherwise on the day
 * it tries, with approved commits already produced against an assumption nobody
 * checked. So the profile is resolved before the first implementation dispatch
 * and consulted at the one operation that cannot be undone.
 *
 * Nothing here falls back. `unknown` is a value: an Epic whose integration mode
 * depends on an unresolved field parks with a decision packet rather than
 * picking the mode that happens to work on this machine.
 */
import { createHash } from 'node:crypto';

import { demand, immutable } from '../runtime/contracts.mjs';

export const INTEGRATION_MODES = immutable([
  'merge',
  'squash',
  'rebase',
  'pull_request',
  'merge_queue',
  'fork_pull_request',
]);

/** The modes the host performs by moving the target ref itself. */
export const DIRECT_MODES = immutable(['merge', 'squash', 'rebase']);

export const PARK_REASONS = immutable([
  'unsupported_integration_mode',
  'unknown_binding_field',
  'discovery_unavailable',
  'discovery_expired',
  'remote_unreachable',
  'permission_denied',
  'profile_drift',
  'credential_missing',
  'completion_predicate_unmet',
]);

/** The four that are facts about resolution and can sit in the lock itself. */
export const RESOLUTION_REASONS = immutable([
  'unknown_binding_field',
  'discovery_unavailable',
  'discovery_expired',
  'credential_missing',
]);

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The value a `binding_fields` pointer names. */
export function valueAt(profile, pointer) {
  return pointer.split('/').reduce((node, key) => (node === undefined ? undefined : node[key]), profile);
}

/**
 * Content, not the order it happened to be written in.
 *
 * Every array in this schema is a SET — allowed modes, required checks, a
 * decision's scope. Serialising them positionally would make a re-resolution
 * that returns the same permissions in a different order look like drift, and
 * drift invalidates approvals. Object keys are sorted for the same reason.
 */
export function canonicalValue(value) {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) {
    return `[${value.map(canonicalValue).sort().join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The digest identity is bound to.
 *
 * It covers exactly the fields the profile names as binding, so a rationale can
 * be reworded without invalidating a candidate that never depended on it, and a
 * required check cannot be added without invalidating one that did.
 */
export function profileDigest(profile) {
  const canonical = profile.binding_fields
    .slice()
    .sort()
    .map((pointer) => `${pointer}=${canonicalValue(valueAt(profile, pointer))}`)
    .join(';');
  return sha256(canonical);
}

/**
 * Whether the profile is resolved enough to act on.
 *
 * Discovery is evidence with a shelf life: branch protection read an hour ago
 * may not hold now, so a field whose discovery has expired is re-resolved
 * before the operation that depends on it rather than trusted because it was
 * true once.
 */
export function resolutionErrors(profile, { nowMs, fields }) {
  const errors = [];
  const wanted = fields ?? profile.binding_fields;
  for (const entry of profile.unresolved ?? []) {
    if (!wanted.some((pointer) => pointer === entry.field || pointer.startsWith(`${entry.field}/`))) continue;
    demand(RESOLUTION_REASONS.includes(entry.reason), 'unknown_binding_field',
      'An unresolved entry carries a resolution reason', { field: entry.field, reason: entry.reason });
    errors.push({ reason: entry.reason, detail: entry.field });
  }
  for (const pointer of wanted) {
    const section = pointer.split('/')[0];
    const provenance = profile.provenance?.[section];
    if (!provenance) {
      errors.push({ reason: 'unknown_binding_field', detail: `${pointer}: no provenance` });
      continue;
    }
    if (valueAt(profile, pointer) === undefined) {
      // Absent is not false, and not the default that would happen to work.
      errors.push({ reason: 'unknown_binding_field', detail: pointer });
    }
    if (provenance.source === 'remote_discovery' && Date.parse(provenance.expires_at) <= nowMs) {
      errors.push({ reason: 'discovery_expired', detail: `${section}: ${provenance.expires_at}` });
    }
  }
  return errors;
}

/**
 * Whether the host may move the target ref itself.
 *
 * "We did not see a protection rule" is not the same as "direct push is
 * allowed", which is why the profile states it and this reads what it states.
 */
export function directMovementAdmission(profile, { mode, nowMs }) {
  const reasons = [];
  if (!INTEGRATION_MODES.includes(mode)) {
    reasons.push({ reason: 'unsupported_integration_mode', detail: `unknown mode ${mode}` });
  } else if (!(profile.integration?.allowed_modes ?? []).includes(mode)) {
    reasons.push({ reason: 'unsupported_integration_mode', detail: mode });
  }
  if (DIRECT_MODES.includes(mode)) {
    if (profile.target?.direct_push_allowed !== true) {
      reasons.push({ reason: 'unsupported_integration_mode', detail: 'direct push is not allowed by this profile' });
    }
    if (profile.integration?.final_push !== 'host') {
      reasons.push({ reason: 'unsupported_integration_mode', detail: 'the final push is not the host\'s to make' });
    }
    if (profile.integration?.merge_queue_required === true) {
      reasons.push({ reason: 'unsupported_integration_mode', detail: 'a merge queue owns the final movement' });
    }
  }
  reasons.push(...resolutionErrors(profile, {
    nowMs,
    fields: ['target/direct_push_allowed', 'integration/allowed_modes', 'integration/final_push'],
  }));
  return Object.freeze({
    decision: reasons.length === 0 ? 'may_move_target' : 'refused',
    mode,
    reasons: immutable(reasons.map(Object.freeze)),
  });
}

/**
 * Required checks, bound to the exact commit they ran on.
 *
 * A green check on another commit is a fact about another commit. The
 * asymmetry is deliberate: a check that appeared mid-run invalidates a result
 * that never ran it, and a check that disappeared does not retroactively
 * validate a run that failed it.
 */
export function requiredCheckErrors(profile, { results, commitOid }) {
  const errors = [];
  const byName = new Map(results.map((result) => [result.name, result]));
  for (const check of profile.checks?.required ?? []) {
    const result = byName.get(check.name);
    if (!result) {
      errors.push({ reason: 'completion_predicate_unmet', detail: `${check.name}: no result` });
      continue;
    }
    if (result.commit_oid !== commitOid) {
      errors.push({
        reason: 'completion_predicate_unmet',
        detail: `${check.name}: ran on ${result.commit_oid}, not ${commitOid}`,
      });
      continue;
    }
    if (result.conclusion !== 'success') {
      errors.push({ reason: 'completion_predicate_unmet', detail: `${check.name}: ${result.conclusion}` });
    }
  }
  for (const result of results) {
    if (result.conclusion === 'failure' && result.commit_oid === commitOid) {
      // A failing result that is no longer required still happened, and a run
      // that failed it is not validated by the requirement going away.
      const required = (profile.checks?.required ?? []).some((check) => check.name === result.name);
      if (!required) {
        errors.push({ reason: 'completion_predicate_unmet', detail: `${result.name}: failed and no longer required` });
      }
    }
  }
  return errors;
}

/**
 * Drift in a binding field.
 *
 * Switching `merge` to `squash`, or a pull-request profile to a local update,
 * is not a repair — it is a different delivery with the same name.
 */
export function driftErrors(recorded, observed) {
  const errors = [];
  const fields = new Set([...(recorded.binding_fields ?? []), ...(observed.binding_fields ?? [])]);
  for (const pointer of [...fields].sort()) {
    const before = canonicalValue(valueAt(recorded, pointer));
    const after = canonicalValue(valueAt(observed, pointer));
    if (before !== after) errors.push({ reason: 'profile_drift', detail: `${pointer}: ${before} -> ${after}` });
  }
  if (profileDigest(recorded) !== recorded.profile_digest) {
    errors.push({ reason: 'profile_drift', detail: 'the recorded digest does not recompute' });
  }
  return errors;
}

/**
 * What a failed discovery is, said plainly.
 *
 * A forge that could not be reached and a token that may not read the ruleset
 * are different problems with different fixes, and neither is "no protection
 * rules were found".
 */
export function discoveryOutcome({ reachable, permitted, available }) {
  if (reachable === false) return Object.freeze({ ok: false, reason: 'remote_unreachable' });
  if (permitted === false) return Object.freeze({ ok: false, reason: 'permission_denied' });
  if (available === false) return Object.freeze({ ok: false, reason: 'discovery_unavailable' });
  return Object.freeze({ ok: true, reason: null });
}

/** Credentials belong to the host, and never to a project artifact. */
export function credentialErrors(document) {
  const errors = [];
  const walk = (node, path) => {
    if (typeof node === 'string') {
      if (/(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/u.test(node)) {
        errors.push({ reason: 'credential_missing', detail: `${path}: a credential is recorded in a project artifact` });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}/${index}`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) walk(value, `${path}/${key}`);
    }
  };
  walk(document, '');
  return errors;
}

/**
 * The final integration, read through the profile.
 *
 * The host either performs the movement or hands it to the path the project
 * requires. What it does not do is discover the difference at the moment it
 * would otherwise push.
 */
export function finalIntegrationPlan(profile, { mode, nowMs }) {
  const admission = directMovementAdmission(profile, { mode, nowMs });
  if (DIRECT_MODES.includes(mode) && admission.decision === 'may_move_target') {
    return Object.freeze({ action: 'move_target', mode, reasons: admission.reasons });
  }
  if (!DIRECT_MODES.includes(mode) && (profile.integration?.allowed_modes ?? []).includes(mode)) {
    return Object.freeze({
      action: mode === 'merge_queue' ? 'enqueue' : 'open_pull_request',
      mode,
      responsibility: profile.integration?.pull_request ?? 'external',
      reasons: immutable([]),
    });
  }
  return Object.freeze({ action: 'park', mode, reasons: admission.reasons });
}
