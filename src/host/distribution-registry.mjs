/** The extension distribution registry, its cache and its migrations (#10).
 *
 * A distribution is named by the digest of its bytes, so "the same version"
 * cannot mean two different things on two machines. The registry is what makes
 * that name usable: which distributions the project holds, which Epics are
 * pinned to which of them, and what may therefore be removed.
 *
 * The reference count is the whole safety property. An Epic is admitted under a
 * distribution and keeps running against it; evicting those bytes because a
 * newer version arrived would leave a running Epic without the code it was
 * admitted with, and the failure would surface as something else entirely.
 *
 * A rollback does not delete what it rolled back from. Deleting it would make
 * rolling forward a re-download, and would destroy the bytes somebody may need
 * to explain what happened.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

export const REFUSALS = immutable([
  'distribution_unknown',
  'distribution_in_use',
  'distribution_digest_mismatch',
  'distribution_migration_blocked',
]);

/** The empty registry, so a caller never has to invent its shape. */
export function emptyRegistry() {
  return Object.freeze({ distributions: Object.freeze({}), current: null, holds: Object.freeze({}) });
}

/**
 * Registers a distribution by the digest of its bytes.
 *
 * The same digest twice is one distribution, not two: that is what naming it by
 * content means, and a registry that counted it twice would report a cache size
 * nobody could reconcile with the disk.
 */
export function registerDistribution(registry, { digest, version, members }) {
  demand(/^[0-9a-f]{64}$/u.test(digest ?? ''), 'distribution_digest_mismatch',
    'A distribution is named by the digest of its bytes', { digest });
  const existing = registry.distributions[digest];
  if (existing) {
    demand(existing.version === version, 'distribution_digest_mismatch',
      'The same bytes are already registered under another version',
      { digest, registered: existing.version, supplied: version });
    return Object.freeze({ ...registry, effect: 'already_registered' });
  }
  return Object.freeze({
    ...registry,
    distributions: Object.freeze({
      ...registry.distributions,
      [digest]: Object.freeze({ digest, version, members: immutable([...members].sort()) }),
    }),
    effect: 'registered',
  });
}

/** Makes a registered distribution the one new Epics are admitted under. */
export function setCurrent(registry, digest) {
  demand(Boolean(registry.distributions[digest]), 'distribution_unknown',
    'A distribution is registered before it becomes current', { digest });
  return Object.freeze({ ...registry, current: digest, previous: registry.current ?? null });
}

/**
 * An Epic takes a hold on the distribution it was admitted under.
 *
 * Held by Epic rather than counted, so the registry can say *who* is pinning a
 * distribution. "Three references" tells an operator nothing they can act on.
 */
export function acquire(registry, { digest, epicId }) {
  demand(Boolean(registry.distributions[digest]), 'distribution_unknown',
    'An Epic cannot be admitted under a distribution nobody registered', { digest });
  const holders = registry.holds[digest] ?? [];
  if (holders.includes(epicId)) return Object.freeze({ ...registry, effect: 'already_held' });
  return Object.freeze({
    ...registry,
    holds: Object.freeze({ ...registry.holds, [digest]: immutable([...holders, epicId].sort()) }),
    effect: 'acquired',
  });
}

/** Releases one Epic's hold. Releasing twice is not an error; it is the same state. */
export function release(registry, { digest, epicId }) {
  const holders = registry.holds[digest] ?? [];
  const remaining = holders.filter((holder) => holder !== epicId);
  return Object.freeze({
    ...registry,
    holds: Object.freeze({ ...registry.holds, [digest]: immutable(remaining) }),
    effect: holders.length === remaining.length ? 'not_held' : 'released',
  });
}

/** Who is pinning this distribution right now. */
export function holders(registry, digest) {
  return immutable(registry.holds[digest] ?? []);
}

/**
 * What the cache may remove.
 *
 * Never the current one, and never one an Epic holds — and the plan says which
 * Epic is holding what it kept, because an eviction plan that only lists what
 * it will delete cannot be checked against what it should not.
 */
export function evictionPlan(registry, { keepPrevious = true } = {}) {
  const evict = [];
  const kept = [];
  for (const digest of Object.keys(registry.distributions).sort()) {
    const held = holders(registry, digest);
    // Every reason it is kept, not the first one that matched: a distribution
    // is often current and held, and reporting one of those would make the
    // other invisible to whoever is trying to free space.
    const reasons = [];
    if (digest === registry.current) reasons.push('current');
    // The version a rollback would return to. Deleting it makes rolling back a
    // re-download of bytes the project already had.
    if (keepPrevious && digest === registry.previous) reasons.push('previous');
    if (held.length > 0) reasons.push('held');
    if (reasons.length === 0) {
      evict.push(digest);
      continue;
    }
    kept.push({ digest, reasons: immutable(reasons), ...(held.length > 0 ? { by: immutable([...held]) } : {}) });
  }
  return Object.freeze({ evict: immutable(evict), keep: immutable(kept.map(Object.freeze)) });
}

/**
 * Migrating the project to another distribution.
 *
 * Open Epics keep the one they were admitted under: a running Epic moved to
 * other code is an Epic whose earlier steps were verified against something
 * else. New Epics get the new one, and the migration says exactly which Epics
 * it did not move rather than reporting a version that is only true for some of
 * them.
 */
export function migrationPlan(registry, { to, openEpics }) {
  demand(Boolean(registry.distributions[to]), 'distribution_unknown',
    'A migration names a registered distribution', { to });
  const staying = [];
  for (const epic of openEpics) {
    if (epic.distribution_digest !== to) {
      staying.push(Object.freeze({ epic_id: epic.epic_id, digest: epic.distribution_digest }));
    }
  }
  return Object.freeze({
    action: 'migrate',
    to,
    from: registry.current,
    // Not moved, and named: a version that is only true for some Epics is a
    // version nobody can reason about.
    epics_staying: immutable(staying),
    new_epics_use: to,
  });
}

/**
 * Rolling back to a distribution the project already holds.
 *
 * Refused if the bytes are gone: a rollback to something that has to be
 * fetched again is not a rollback, it is a new install wearing the old
 * version's name.
 */
export function rollbackPlan(registry, { to, decisionRef }) {
  demand(Boolean(registry.distributions[to]), 'distribution_migration_blocked',
    'A rollback needs the bytes it is rolling back to', { to });
  demand(typeof decisionRef === 'string' && decisionRef.length > 0, 'distribution_migration_blocked',
    'A rollback records the decision that asked for it', {});
  return Object.freeze({
    action: 'rollback',
    to,
    from: registry.current,
    decision_ref: decisionRef,
    // The version rolled back from stays: deleting it would destroy the bytes
    // somebody needs to explain what happened.
    retains: registry.current,
  });
}
