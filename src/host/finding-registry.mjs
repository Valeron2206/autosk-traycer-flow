/** The canonical finding pipeline: merge, triage, contest and the gate.
 *
 * Four reviewers produce four answers, and what turns them into one decision is
 * this pipeline rather than a synthesis step. `synthesize_panel` as prose is
 * where reproducibility is lost: the same four answers can be summarised two
 * ways, and nothing in the record says which was used.
 *
 * So every function here is a function of its inputs and nothing else — not of
 * the order the seats replied in, and not of who is reading.
 */
import { createHash } from 'node:crypto';

import { demand, immutable } from '../runtime/contracts.mjs';

/** Shared and closed. A seat reporting outside it is malformed, not novel. */
export const SEVERITIES = immutable(['critical', 'high', 'medium', 'low']);

export const TRIAGE_DECISIONS = immutable([
  'confirmed',
  'confirmed_higher_severity',
  'confirmed_lower_severity',
  'rejected',
]);

export const REJECTION_REASONS = immutable(['out_of_scope', 'intended_behavior', 'duplicate', 'reviewer_error']);

export const BASIS_KINDS = immutable(['anchor', 'accepted_decision', 'factual_proof']);

export const CONTEST_OUTCOMES = immutable(['upheld', 'withdrawn', 'forfeited', 'disagreed']);

export const PARK_REASONS = immutable([
  'unknown_severity',
  'unmergeable_finding',
  'missing_citable_basis',
  'contest_incomplete',
  'undispositioned_medium',
  'missing_debt_ticket',
  'stale_candidate_binding',
  'originator_unknown',
  'finding_registry_drift',
]);

const rank = (severity) => SEVERITIES.indexOf(severity);

/** `seat:raw_id`, so two seats numbering from 1 do not collide. */
export function originatorId(finding) {
  return `${finding.seat}:${finding.raw_id}`;
}

/**
 * The key two findings must share to be the same finding.
 *
 * The root cause, expressed as what is violated and where. Claim text is
 * deliberately not part of it: four seats describe one defect in four
 * sentences, and merging on prose would keep them apart.
 */
export function rootCauseKey(finding) {
  return `${finding.violated_anchor} ${[...finding.affected_scope].sort().join(',')}`;
}

/**
 * Merges raw findings into canonical ones.
 *
 * Deterministic: sorted by the key, every originator kept, and the pre-triage
 * severity is the highest any seat reported — a merge that averaged could
 * quietly downgrade a critical to a medium by majority.
 */
export function canonicalMerge(rawFindings) {
  const groups = new Map();
  for (const finding of rawFindings) {
    demand(SEVERITIES.includes(finding.severity), 'unknown_severity',
      'A seat reported a severity outside the shared scale',
      { seat: finding.seat, raw_id: finding.raw_id, severity: finding.severity });
    const key = rootCauseKey(finding);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(finding);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, findings], index) => ({
      canonical_id: `C${String(index + 1).padStart(3, '0')}`,
      root_cause_key: key,
      originators: findings.map(originatorId).sort(),
      reported_severity: findings
        .map((finding) => finding.severity)
        .sort((a, b) => rank(a) - rank(b))[0],
      state: 'open',
    }));
}

/**
 * Applies a triage decision, or refuses it.
 *
 * Disagreeing is allowed; disagreeing without citing anything is not. That is
 * the rule that keeps triage from becoming a way to make findings go away, so
 * a decision without its basis leaves the finding confirmed at the severity the
 * seats reported rather than at the one the triage preferred.
 */
export function applyTriage(canonical, triage) {
  demand(TRIAGE_DECISIONS.includes(triage.decision), 'unmergeable_finding',
    'Unknown triage decision', { canonical_id: canonical.canonical_id, decision: triage.decision });
  if (triage.decision === 'rejected') {
    demand(Boolean(triage.basis) && BASIS_KINDS.includes(triage.basis.kind) && Boolean(triage.basis.reference),
      'missing_citable_basis', 'A rejection cites an anchor, an accepted decision or a factual proof',
      { canonical_id: canonical.canonical_id });
    demand(REJECTION_REASONS.includes(triage.rejection_reason), 'missing_citable_basis',
      'A rejection names one of the four reasons', { canonical_id: canonical.canonical_id });
  }
  if (triage.decision === 'confirmed_lower_severity') {
    demand(Boolean(triage.basis) && BASIS_KINDS.includes(triage.basis.kind) && Boolean(triage.basis.reference),
      'missing_citable_basis', 'A downgrade cites a basis', { canonical_id: canonical.canonical_id });
    demand(SEVERITIES.includes(triage.severity) && rank(triage.severity) > rank(canonical.reported_severity),
      'missing_citable_basis', 'A downgrade lowers the severity', { canonical_id: canonical.canonical_id });
  }
  if (triage.decision === 'confirmed_higher_severity') {
    // A reason, not a basis: raising a severity does not make a finding go
    // away, so it is held to a lower bar than removing one.
    demand(typeof triage.reason === 'string' && triage.reason.trim().length > 0,
      'missing_citable_basis', 'A raise states its reason', { canonical_id: canonical.canonical_id });
    demand(SEVERITIES.includes(triage.severity) && rank(triage.severity) < rank(canonical.reported_severity),
      'missing_citable_basis', 'A raise raises the severity', { canonical_id: canonical.canonical_id });
  }
  return Object.freeze({ ...canonical, triage: { ...triage } });
}

/** The severity a finding carries after triage. */
export function effectiveSeverity(canonical) {
  const decision = canonical.triage?.decision;
  if (decision === 'confirmed_lower_severity' || decision === 'confirmed_higher_severity') {
    return canonical.triage.severity;
  }
  return canonical.reported_severity;
}

/** Whether a finding is still counted against the candidate. */
export function isOpen(canonical) {
  if (canonical.state === 'stale') return false;
  if (canonical.triage?.decision === 'rejected') return false;
  return canonical.state === 'open';
}

/**
 * Whether the contest is complete for a finding.
 *
 * It goes to every originating seat, not only the loudest one, and a seat that
 * is unavailable forfeits its window. Forfeiting does not close a confirmed
 * finding: absence is not agreement.
 */
export function contestComplete(canonical) {
  if (canonical.triage?.decision === 'rejected') return true;
  const owed = new Set(canonical.originators.map((originator) => originator.split(':')[0]));
  const answered = new Set((canonical.contest ?? []).map((entry) => entry.seat));
  for (const entry of canonical.contest ?? []) {
    demand(CONTEST_OUTCOMES.includes(entry.outcome), 'contest_incomplete', 'Unknown contest outcome',
      { canonical_id: canonical.canonical_id, seat: entry.seat });
    demand(owed.has(entry.seat), 'originator_unknown', 'A seat that did not originate the finding contested it',
      { canonical_id: canonical.canonical_id, seat: entry.seat });
  }
  return [...owed].every((seat) => answered.has(seat));
}

/** Disagreement that survives the contest escalates rather than being resolved here. */
export function escalates(canonical) {
  return (canonical.contest ?? []).some((entry) => entry.outcome === 'disagreed');
}

/**
 * The gate predicate. Computed, not judged.
 *
 * A finding closes only on a re-review disposition of `resolved`: having made
 * an edit is not a disposition, which is why `state` is checked and not the
 * presence of a fix.
 */
export function computeGate(registry) {
  let blockingOpen = 0;
  let undispositionedMedium = 0;
  const reasons = [];
  for (const canonical of registry.canonical_findings) {
    if (canonical.state === 'stale') continue;
    if (canonical.triage?.decision === 'rejected') continue;
    const severity = effectiveSeverity(canonical);
    if (isOpen(canonical) && !contestComplete(canonical)) {
      reasons.push(`contest_incomplete:${canonical.canonical_id}`);
    }
    if (escalates(canonical)) reasons.push(`contest_disagreement:${canonical.canonical_id}`);
    if (severity === 'critical' || severity === 'high') {
      if (isOpen(canonical)) {
        blockingOpen += 1;
        reasons.push(`open_${severity}:${canonical.canonical_id}`);
      }
      continue;
    }
    if (severity === 'medium') {
      if (!canonical.disposition && canonical.state !== 'resolved') {
        undispositionedMedium += 1;
        reasons.push(`undispositioned_medium:${canonical.canonical_id}`);
        continue;
      }
      if (canonical.disposition === 'deferred') {
        // Deferred debt stays visible: a deferral with no ticket is a decision
        // nobody can find later.
        demand(Boolean(canonical.debt_ticket), 'missing_debt_ticket',
          'A deferred medium creates a debt Ticket', { canonical_id: canonical.canonical_id });
      }
    }
    // `low` does not block. A low that is really an understated high is caught
    // by triage, which is what `confirmed_higher_severity` is for.
  }
  return Object.freeze({
    blocking_open: blockingOpen,
    undispositioned_medium: undispositionedMedium,
    verdict: reasons.length === 0 ? 'pass' : 'blocked',
    reasons: reasons.sort(),
  });
}

/**
 * Carries open findings onto a new candidate.
 *
 * A finding does not disappear because the candidate moved; a contest answered
 * about a superseded candidate does not apply to the current one, so the
 * contest is cleared while the finding is kept.
 */
export function supersede(registry, newCandidateIdentity) {
  demand(newCandidateIdentity !== registry.candidate_identity, 'stale_candidate_binding',
    'Superseding to the same candidate', { candidate: newCandidateIdentity });
  const carried = registry.canonical_findings
    .filter((canonical) => isOpen(canonical))
    .map((canonical) => {
      const { contest, ...rest } = canonical;
      return Object.freeze({ ...rest });
    });
  return Object.freeze({
    ...registry,
    candidate_identity: newCandidateIdentity,
    canonical_findings: carried,
  });
}

/**
 * Where a late finding lands, by the state of the work it lands on.
 *
 * History is not rewritten to make a late finding look like it was known
 * earlier, so each of these is a forward action rather than an amendment.
 */
export function lateFindingRoute(severity, workState) {
  demand(SEVERITIES.includes(severity), 'unknown_severity', 'Unknown severity', { severity });
  const blocking = severity === 'critical' || severity === 'high';
  switch (workState) {
    case 'superseded':
      return 'recorded_stale';
    case 'unintegrated':
      return blocking ? 'reopen_pass' : 'ordinary_disposition';
    case 'integrated':
      return blocking ? 'correction_ticket' : 'ordinary_disposition';
    case 'released':
      return 'change_issue';
    default:
      return demand(false, 'finding_registry_drift', 'Unknown work state', { work_state: workState });
  }
}

/** The registry's identity: its content, not its writing order. */
export function registryDigest(registry) {
  const { registry_digest, ...body } = registry;
  return createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
}
