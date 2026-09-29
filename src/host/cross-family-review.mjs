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

export const PARK_REASONS = immutable([
  'no_external_reviewer',
  'review_family_unknown',
  'review_session_reused',
  'review_exemption_not_permitted',
  'review_not_a_panel',
]);

/** The categories no editorial exemption may cover. */
export const NEVER_EXEMPT = immutable(['behavior_defining', 'governance_defining']);

/** A person: outside every model family, so a human author excludes no reviewer. */
export const HUMAN = 'human';

/** The model a route serves: everything after the harness prefix. */
export function modelOf(routeId) {
  const slash = routeId.indexOf('/');
  return slash === -1 ? routeId : routeId.slice(slash + 1);
}

/**
 * The family each route belongs to, answered by the model and not by the
 * harness that serves it.
 *
 * Cross-family independence is the mechanism behind the panel gate, behind Lead
 * selection, behind this review and behind `arena_judge_family_conflict`. Panel
 * round 3 found that "family" was a naming convention nothing pinned, so a
 * partition that quietly put two seats in one family would have left the gate
 * looking intact. A partition keyed on the route prefix reopens the same hole
 * the moment one harness serves several families — `cursor/` serves Grok, Kimi
 * and Muse — so the partition names each family's model ids, and a model it
 * does not name belongs to none.
 */
export function familyOf(routeId, partition) {
  const model = modelOf(routeId);
  const match = partition.families.find((entry) => Array.isArray(entry.models) && entry.models.includes(model));
  return match ? match.family : null;
}

/**
 * The family a participant belongs to, read from the partition.
 *
 * A participant is named by what it ran — a route or a model id — because a
 * family is a property of the model. Panel round 5 (R5-16) found families
 * arriving as caller strings: `anthropic` became `claude` where the partition
 * says `opus`, and `cursor` or `meta` excluded no reviewer at all. So a label
 * the partition does not resolve is refused by name rather than treated as a
 * family nobody else belongs to: an unknown participant is not an external
 * one. The one name that is not a model is a person, who belongs to no model
 * family.
 */
export function participantFamily(participant, partition) {
  demand(Array.isArray(partition?.families) && Array.isArray(partition.master_order), 'review_family_unknown',
    'Families are read from the partition, not from the caller', {});
  if (participant === HUMAN) return null;
  const family = typeof participant === 'string' ? familyOf(participant, partition) : null;
  demand(family !== null, 'review_family_unknown',
    'A participant resolves to a declared family through the partition', { participant });
  return family;
}

/**
 * The families that wrote any of the candidate: authors and fixers alike.
 *
 * A fixer from the reviewer's family makes the reviewer the author of part of
 * what they are reviewing, which is the one property this review has. An
 * author set nobody named excludes nobody, which is the same hole from the
 * other side, so it is refused.
 */
export function excludedFamilies({ partition, authors, fixers = [] }) {
  demand(Array.isArray(authors) && authors.length > 0, 'review_family_unknown',
    'The candidate names who authored it', { authors });
  const families = [...authors, ...fixers]
    .map((participant) => participantFamily(participant, partition))
    .filter((family) => family !== null);
  return immutable([...new Set(families)].sort());
}

/**
 * Who may review, in order: the partition's master order minus every family
 * that authored or fixed the candidate.
 *
 * The order is the partition's `master_order`, the same one 01 §3 applies to
 * Lead. A second list kept here was how Opus came to be offered for no author
 * set while 01 §6 routed four of them to it.
 */
export function reviewerRoute({ partition, authors, fixers = [] }) {
  const excluded = excludedFamilies({ partition, authors, fixers });
  return immutable(partition.master_order.filter((family) => !excluded.includes(family)));
}

/**
 * The admission for a review round.
 *
 * The ranking is only who may review. A family is dispatched to only through
 * an exact reviewer route that is available — the routes provider preflight
 * admitted, today the `REQUIRED_PANEL` routes — so the caller names those
 * routes and a family without one is skipped — in the live roster that is Kimi, so
 * Muse is first for Codex. Availability is never assumed: without the list the
 * ranking would be admitted unfiltered, and a family nobody can reach would be
 * "the reviewer".
 *
 * With no family left the review does not quietly not happen: the task goes to
 * a person, with the three things they can actually do about it.
 *
 * How many rounds may run is not decided here. The graph's caps count the
 * takings of every NOT_PASS (`code_review_round`, `artifact_review_round`) and
 * park at their limit, a stop with a recovery row and the user's decision for
 * each round past it (ADR-104). A count of this module's own parked one review
 * earlier, with a reason no row carries (ADR-113).
 */
export function reviewAdmission({ partition, authors, fixers = [], reviewers, reviewerSession, authorSessions = [] }) {
  const ranked = reviewerRoute({ partition, authors, fixers });
  demand(Array.isArray(reviewers), 'review_family_unknown',
    'The available exact reviewer routes are named, not assumed', { reviewers });
  const available = reviewers.map((reviewer) => ({ reviewer, family: participantFamily(reviewer, partition) }));
  const route = immutable(ranked.filter((family) => available.some((entry) => entry.family === family)));
  if (route.length === 0) {
    return Object.freeze({
      decision: 'park',
      reason: 'no_external_reviewer',
      detail: ranked.length === 0
        ? `every reviewer family also authored or fixed: ${excludedFamilies({ partition, authors, fixers }).join(', ')}`
        : `no exact reviewer route for a family outside the authors and fixers: ${ranked.join(', ')}`,
      options: immutable(['human_review', 're_express_candidate', 'exact_waiver']),
    });
  }
  if (reviewerSession !== undefined) {
    demand(!authorSessions.includes(reviewerSession), 'review_session_reused',
      'The reviewer session is one of the author sessions', { reviewerSession });
  }
  // A family can have more than one route (Muse is served as meta/ and as
  // cursor/), so the admission names the exact one: the chosen family's first
  // route in the order the caller listed them.
  const admitted = available.find((entry) => entry.family === route[0]);
  return Object.freeze({ decision: 'review', family: route[0], reviewer_route: admitted.reviewer, route });
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
    return Object.freeze({ decision: 'park', reason: 'no_external_reviewer', detail: 'no review record' });
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
