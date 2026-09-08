/** The doctor report: assembly, redaction and the rule that keeps `warn` from becoming ready.
 *
 * This file performs no I/O. It takes check results, validates each against the
 * contract in `docs/contracts/doctor-report.md`, and answers two questions: what
 * the overall status is, and whether a workflow that requires a particular set
 * of checks may start. The probes that produce the results live in
 * `doctor-checks.mjs`, and the workflow preflight uses these same functions —
 * two implementations of one check agree until they do not.
 */
import { createHash } from 'node:crypto';

import { demand, immutable } from '../runtime/contracts.mjs';

/** Every check declares exactly one, so a workflow can require a category
 * without enumerating its members and without silently missing a later one. */
export const CATEGORIES = immutable([
  'project_identity',
  'daemon',
  'governance',
  'providers',
  'git_delivery',
  'security',
  'scheduler',
]);

export const CHECK_STATUSES = immutable(['pass', 'warn', 'fail', 'unverifiable']);

/** Evidence is bounded because a doctor report is pasted into issues. */
export const MAX_EVIDENCE_VALUE = 200;
export const MAX_EVIDENCE_KEYS = 24;

const ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;

/** Substrings that make a value look like a credential rather than a fact.
 *
 * Deliberately not "any long high-entropy run": a sha256 digest has exactly
 * that shape, and digests are the evidence this report exists to state.
 * Redacting them would empty the identity checks while looking careful.
 */
const SECRET_HINTS = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}/u,
  /\bsk-[A-Za-z0-9-]{16,}/u,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/iu,
  /\b(?:api[_-]?key|secret|token|password|passwd|authorization)\s*[:=]\s*\S+/iu,
];

/** Redacts one evidence value.
 *
 * A token in the evidence of the check that found a token is the same leak the
 * check exists to prevent, so this runs on the way in rather than being left to
 * whoever writes a check.
 */
export function redactValue(value, { home } = {}) {
  if (typeof value !== 'string') return value;
  let text = value;
  if (home && home.length > 1) text = text.split(home).join('~');
  for (const pattern of SECRET_HINTS) text = text.replace(pattern, '[redacted]');
  if (text.length > MAX_EVIDENCE_VALUE) text = `${text.slice(0, MAX_EVIDENCE_VALUE - 1)}…`;
  return text;
}

export function redactEvidence(evidence, options = {}) {
  const entries = Object.entries(evidence ?? {});
  demand(entries.length <= MAX_EVIDENCE_KEYS, 'doctor_evidence_unredacted',
    'Evidence carries more keys than a report may hold', { keys: entries.length });
  const out = {};
  for (const [key, value] of entries) {
    demand(key.length <= 64, 'doctor_evidence_unredacted', 'Evidence key is too long', { key });
    demand(['string', 'number', 'boolean'].includes(typeof value), 'doctor_evidence_unredacted',
      'Evidence values are scalars', { key });
    out[key] = redactValue(value, options);
  }
  return out;
}

/** Validates and normalises one check result, or throws `FlowError`. */
export function checkResult(result, { home } = {}) {
  demand(ID_PATTERN.test(result.id ?? ''), 'doctor_category_unknown', 'Invalid check id', { id: result.id });
  demand(CATEGORIES.includes(result.category), 'doctor_category_unknown', 'Unknown check category',
    { id: result.id, category: result.category });
  demand(CHECK_STATUSES.includes(result.status), 'doctor_category_unknown', 'Unknown check status',
    { id: result.id, status: result.status });
  // A failure with neither a remediation nor a park reason tells the operator
  // that something is wrong and leaves them exactly where they were.
  demand(result.status !== 'fail' || result.remediation || result.park_reason,
    'doctor_remediation_missing', 'A failing check carries a remediation or a park reason', { id: result.id });
  // "We could not test it" never becomes "it passed".
  demand(result.status !== 'unverifiable' || result.unverifiable_reason,
    'doctor_check_unverifiable', 'An unverifiable check says why', { id: result.id });
  const check = {
    id: result.id,
    category: result.category,
    status: result.status,
    evidence: redactEvidence(result.evidence, { home }),
    provenance: result.provenance,
  };
  if (result.remediation) check.remediation = result.remediation;
  if (result.park_reason) check.park_reason = result.park_reason;
  if (result.unverifiable_reason) check.unverifiable_reason = result.unverifiable_reason;
  return check;
}

/** An expired result is not a result: the daemon it describes may be gone. */
export function isExpired(check, nowMs) {
  return Date.parse(check.provenance.expires_at) <= nowMs;
}

/** `unverifiable` does not degrade the status, and that is a line rather than a
 * loophole: those properties can never be established read-only, so a status
 * that degraded on them would be permanently yellow on a healthy project. */
export function overallStatus(checks) {
  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'warn')) return 'warn';
  return 'pass';
}

/** Whether a workflow requiring these checks may start.
 *
 * The strictness that `unverifiable` does not apply to the status lives here
 * instead: a workflow that REQUIRES such a check cannot start, and `warn` never
 * counts as ready either.
 */
export function readiness(report, requiredIds, nowMs) {
  const byId = new Map(report.checks.map((check) => [check.id, check]));
  const blocking = [];
  for (const id of requiredIds) {
    const check = byId.get(id);
    if (!check) {
      blocking.push({ id, reason: 'doctor_required_set_unsatisfied' });
      continue;
    }
    if (isExpired(check, nowMs)) {
      blocking.push({ id, reason: 'doctor_check_expired' });
      continue;
    }
    if (check.status === 'unverifiable') blocking.push({ id, reason: 'doctor_check_unverifiable' });
    else if (check.status !== 'pass') blocking.push({ id, reason: 'doctor_required_set_unsatisfied' });
  }
  return { ready: blocking.length === 0, blocking };
}

/** The report, assembled from validated checks. */
export function buildReport({ checks, projectIdentity, runtimeIdentity, tool, generatedAt, home }) {
  demand(Array.isArray(checks) && checks.length > 0, 'doctor_required_set_unsatisfied',
    'A report carries at least one check');
  const validated = checks.map((check) => checkResult(check, { home }));
  const ids = validated.map((check) => check.id);
  demand(new Set(ids).size === ids.length, 'doctor_category_unknown', 'A check id appears twice');
  return {
    schema_version: 1,
    status: overallStatus(validated),
    project_identity: projectIdentity,
    runtime_identity: runtimeIdentity,
    generated_at: generatedAt,
    tool,
    checks: validated,
  };
}

/** The report's own identity, for evidence that quotes it. */
export function reportDigest(report) {
  return createHash('sha256').update(JSON.stringify(report), 'utf8').digest('hex');
}

/** How many checks could not be established, reported beside the status. */
export function unverifiableCount(report) {
  return report.checks.filter((check) => check.status === 'unverifiable').length;
}
