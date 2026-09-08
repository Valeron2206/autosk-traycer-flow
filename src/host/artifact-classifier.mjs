/** The classifier: which class governs a changed path, and what that costs.
 *
 * The decision is a function of the registry, not of a reviewer's judgement.
 * An artifact matching no class, or matching two classes with different
 * categories, parks — it is not classified as explanatory because nothing else
 * fit, which is how an artifact acquires the cheapest lifecycle by accident.
 *
 * Reads the registry it is given; performs no I/O of its own.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

export const PARK_REASONS = immutable([
  'unknown_class',
  'ambiguous_class',
  'missing_predecessor',
  'unregistered_artifact',
  'registry_drift',
  'cyclic_impact_graph',
  'validator_missing',
  'schema_missing',
]);

export const CATEGORIES = immutable([
  'behavior_defining',
  'governance_defining',
  'explanatory',
  'runtime_evidence',
]);

/** Paths that are never artifacts of this project's governance.
 *
 * Deliberately short. Anything not listed here and not matched by a class
 * parks, because "it is obviously not governed" is the judgement the classifier
 * exists to remove.
 */
export const UNGOVERNED = immutable(['.git/', 'node_modules/']);

/**
 * Matches one registry path pattern.
 *
 * `*` matches within a segment and `**` across segments; nothing else is a
 * metacharacter. A pattern language larger than that would let a class quietly
 * widen its own scope.
 */
export function matchesPattern(pattern, filePath) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  const expanded = escaped
    .split('**')
    .map((part) => part.split('*').join('[^/]*'))
    .join('.*');
  return new RegExp(`^${expanded}$`, 'u').test(filePath);
}

/** Every class whose declared paths cover this file. */
export function matchingClasses(registry, filePath) {
  return registry.classes.filter((entry) => entry.paths.some((pattern) => matchesPattern(pattern, filePath)));
}

/**
 * Classifies one path.
 *
 * Returns `{ status: 'classified', class, category, review, human_approval }`
 * or `{ status: 'parked', park_reason, candidates }`. Never a class chosen
 * because it was the only one left.
 */
export function classify(registry, filePath) {
  if (UNGOVERNED.some((prefix) => filePath.startsWith(prefix))) {
    return Object.freeze({ status: 'ungoverned', path: filePath });
  }
  const matches = matchingClasses(registry, filePath);
  if (matches.length === 0) {
    return Object.freeze({ status: 'parked', path: filePath, park_reason: 'unknown_class', candidates: [] });
  }
  const categories = new Set(matches.map((entry) => entry.category));
  if (categories.size > 1) {
    // Two classes with different categories disagree about what changing this
    // file means, and picking either would be the reviewer's judgement wearing
    // the registry's authority.
    return Object.freeze({
      status: 'parked',
      path: filePath,
      park_reason: 'ambiguous_class',
      candidates: matches.map((entry) => entry.class).sort(),
    });
  }
  // Several classes of one category are not ambiguous: the category decides the
  // lifecycle, and the most specific pattern decides the owner.
  const owner = matches
    .map((entry) => ({
      entry,
      specificity: Math.max(...entry.paths
        .filter((pattern) => matchesPattern(pattern, filePath))
        .map((pattern) => (pattern.includes('*') ? pattern.replace(/\*+/gu, '').length : 10_000))),
    }))
    .sort((a, b) => b.specificity - a.specificity || (a.entry.class < b.entry.class ? -1 : 1))[0].entry;
  return Object.freeze({
    status: 'classified',
    path: filePath,
    class: owner.class,
    category: owner.category,
    review: owner.review,
    human_approval: owner.human_approval,
    publication: owner.publication,
  });
}

/**
 * The classes affected when an instance of this class changes.
 *
 * Walked, not hand-maintained: a list that says which reviews to redo is a list
 * that goes stale the first time a class is added.
 */
export function impactClosure(registry, className) {
  const byName = new Map(registry.classes.map((entry) => [entry.class, entry]));
  demand(byName.has(className), 'unknown_class', 'No such class', { class: className });
  const seen = new Set();
  const queue = [className];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of byName.get(current)?.impacts ?? []) {
      // A class named in `impacts` that does not exist is registry drift, not a
      // silently empty closure.
      demand(byName.has(next), 'registry_drift', 'A class impacts one that is not registered',
        { class: current, impacts: next });
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return [...seen].sort();
}

/**
 * Classifies a changeset and reports what it costs.
 *
 * Every path is accounted for: classified, ungoverned, or parked with a reason.
 * A changeset with a single parked path does not proceed — that is what
 * "an artifact with no lifecycle does not skip its gate" means operationally.
 */
export function classifyChangeset(registry, paths) {
  const results = paths.map((filePath) => classify(registry, filePath));
  const parked = results.filter((result) => result.status === 'parked');
  const classified = results.filter((result) => result.status === 'classified');
  const closure = new Set();
  for (const result of classified) {
    closure.add(result.class);
    for (const impacted of impactClosure(registry, result.class)) closure.add(impacted);
  }
  const reviews = new Set(classified.map((result) => result.review.mode));
  return Object.freeze({
    results,
    parked,
    // A changeset needs the strictest review any of its files needs; taking the
    // gentlest would let one narrow-review file carry a panel-reviewed one.
    review_mode: reviews.has('full_panel') ? 'full_panel' : reviews.has('narrow_review') ? 'narrow_review' : 'none',
    human_approval: classified.some((result) => result.human_approval === 'required') ? 'required' : 'not_required',
    impacted_classes: [...closure].sort(),
    admits: parked.length === 0,
  });
}
