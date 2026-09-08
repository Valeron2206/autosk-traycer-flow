/** The single cross-family code review.
 *
 * It is not the panel and the panel is not it. The panel is four seats reading
 * a planning artifact; this is one reviewer from a family that did not write
 * the code reading the code. Substituting either for the other loses the
 * property that made it worth running: independence from the author, or four
 * readings of one document.
 *
 * The route is chosen by the union of the families that actually authored and
 * fixed the candidate, not by the family that was assigned at dispatch — a
 * fixer from the reviewer's own family makes the reviewer the author of part of
 * what they are reviewing.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

import { classify } from './artifact-classifier.mjs';

/** The reviewer families, in the master preference order. */
export const REVIEWER_ORDER = immutable(['gpt', 'kimi', 'grok']);

/** Families that write code here. `codex` is the `gpt` family under its tool name. */
export const FAMILY_ALIASES = Object.freeze({ codex: 'gpt', openai: 'gpt', anthropic: 'claude' });

export const PARK_REASONS = immutable([
  'review_no_external_family',
  'review_family_collision',
  'review_session_reused',
  'review_exemption_not_permitted',
  'review_round_limit',
  'review_not_a_panel',
]);

/** The maximum full review cycles before the task is a person's. */
export const ROUND_LIMIT = 10;

/** The categories no editorial exemption may cover. */
export const NEVER_EXEMPT = immutable(['behavior_defining', 'governance_defining']);

/** One spelling per family, so a tool name and a family name cannot disagree. */
export function normalizeFamily(family) {
  const normalized = FAMILY_ALIASES[family] ?? family;
  demand(typeof normalized === 'string' && normalized.length > 0, 'review_family_collision',
    'A participating family has a name', { family });
  return normalized;
}

/**
 * Who may review, in order.
 *
 * The union of authors and fixers is excluded, because a fixer from the
 * reviewer's family makes the reviewer the author of part of what they are
 * reviewing — which is the one property this review has.
 */
export function reviewerRoute({ authors = [], fixers = [] }) {
  const excluded = new Set([...authors, ...fixers].map(normalizeFamily));
  return immutable(REVIEWER_ORDER.filter((family) => !excluded.has(family)));
}

/**
 * The admission for a review round.
 *
 * With no external family the review does not quietly not happen: the task goes
 * to a person, with the three things they can actually do about it.
 */
export function reviewAdmission({ authors, fixers, round = 1, reviewerSession, authorSessions = [] }) {
  const route = reviewerRoute({ authors, fixers });
  if (round > ROUND_LIMIT) {
    return Object.freeze({
      decision: 'park',
      reason: 'review_round_limit',
      detail: `${round} rounds`,
      options: immutable(['human_review', 're_express_candidate', 'exact_waiver']),
    });
  }
  if (route.length === 0) {
    return Object.freeze({
      decision: 'park',
      reason: 'review_no_external_family',
      detail: `every reviewer family also authored or fixed: ${[...new Set([...authors, ...fixers].map(normalizeFamily))].sort().join(', ')}`,
      options: immutable(['human_review', 're_express_candidate', 'exact_waiver']),
    });
  }
  if (reviewerSession !== undefined) {
    demand(!authorSessions.includes(reviewerSession), 'review_session_reused',
      'The reviewer session is one of the author sessions', { reviewerSession });
  }
  return Object.freeze({ decision: 'review', family: route[0], route });
}

/**
 * Whether a purely editorial Quick change may skip the review.
 *
 * Deterministic classification, exact candidate identity and the changed path
 * set — an exemption argued from a description of the change is the reviewer's
 * judgement without the reviewer.
 */
export function editorialExemption(registry, { paths, candidateIdentity, declaredEditorial }) {
  demand(typeof candidateIdentity === 'string' && candidateIdentity.length > 0,
    'review_exemption_not_permitted', 'An exemption names the exact candidate it covers', {});
  demand(Array.isArray(paths) && paths.length > 0, 'review_exemption_not_permitted',
    'An exemption names the changed path set', {});
  if (declaredEditorial !== true) {
    return Object.freeze({ exempt: false, reason: 'review_exemption_not_permitted', detail: 'not declared editorial' });
  }
  for (const path of paths) {
    const classified = classify(registry, path);
    if (classified.status !== 'classified') {
      // An exemption cannot rest on a file nobody can classify.
      return Object.freeze({
        exempt: false,
        reason: 'review_exemption_not_permitted',
        detail: `${path}: ${classified.status}`,
      });
    }
    if (NEVER_EXEMPT.includes(classified.category)) {
      return Object.freeze({
        exempt: false,
        reason: 'review_exemption_not_permitted',
        detail: `${path}: ${classified.category}`,
      });
    }
  }
  return Object.freeze({ exempt: true, candidate_identity: candidateIdentity, paths: immutable([...paths].sort()) });
}

/**
 * What a narrow re-review covers.
 *
 * The open findings, the difference from the previous candidate, and the
 * relations those touch. Not the whole candidate again, and not only the lines
 * that changed.
 */
export function narrowRereviewScope({ openFindings = [], changedPaths = [], relatedPaths = [] }) {
  const paths = new Set([...changedPaths, ...relatedPaths]);
  for (const finding of openFindings) {
    for (const path of finding.paths ?? []) paths.add(path);
  }
  return Object.freeze({
    findings: immutable(openFindings.map((finding) => finding.id).sort()),
    paths: immutable([...paths].sort()),
  });
}

/**
 * A review verdict is not a panel verdict.
 *
 * They answer different questions about different artifacts, and a flow that
 * accepted one for the other would have exactly one reading of the code, or no
 * reading of the plan.
 */
export function assertNotSubstitute(record) {
  demand(record.kind === 'cross_family_review', 'review_not_a_panel',
    'A panel verdict is not a code review', { kind: record.kind });
  demand(record.seats === undefined, 'review_not_a_panel',
    'A code review has one reviewer, not seats', { seats: record.seats });
  return record;
}

/**
 * The gate this review is: a candidate advances on a review of its exact bytes.
 *
 * A PASS carried from an earlier candidate is a PASS about other bytes, which
 * is the failure the whole freeze step exists to prevent.
 */
export function reviewGate({ candidateIdentity, review }) {
  if (!review) {
    return Object.freeze({ decision: 'park', reason: 'review_no_external_family', detail: 'no review record' });
  }
  assertNotSubstitute(review);
  if (review.candidate_identity !== candidateIdentity) {
    return Object.freeze({
      decision: 'park',
      reason: 'review_not_a_panel',
      detail: `the review is of ${review.candidate_identity}`,
    });
  }
  if (review.outcome !== 'pass') {
    return Object.freeze({ decision: 'fix', reason: null, findings: immutable(review.findings ?? []) });
  }
  return Object.freeze({ decision: 'proceed', family: review.family, candidate_identity: candidateIdentity });
}
