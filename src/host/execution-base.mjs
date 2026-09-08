/** The Ticket execution base: the exact tree a Ticket is built from.
 *
 * A dependency edge schedules work. It does not carry the predecessor's code
 * into the dependent Ticket's Git base, and until this contract nothing did:
 * `T2 depends_on T1` could start with a worktree built from `planning_head`,
 * where `T1`'s approved commit does not exist. The DAG is a schedule, not a
 * build of state, and the implementer of `T2` discovers that by finding the API
 * the plan told them to use is not there.
 *
 * So every Ticket has a recorded base, and its worktree is created only after
 * that exact commit and tree are verified.
 */
import { createHash } from 'node:crypto';

import { demand, immutable } from '../runtime/contracts.mjs';

export const PARK_REASONS = immutable([
  'missing_predecessor_binding',
  'stale_predecessor_pass',
  'incompatible_overlapping_deltas',
  'composition_failed',
  'base_mismatch',
  'dag_changed',
  'anchor_changed',
  'foreign_ref_movement',
  'unreachable_composition_object',
]);

/**
 * The transitive predecessors of a Ticket, in the manifest's topological order.
 *
 * Computed from the frozen manifest rather than from the live graph, so two
 * runs of the same Epic compute the same closure.
 */
export function transitiveClosure(manifest, ticketId) {
  const byId = new Map(manifest.tickets.map((ticket) => [ticket.ticket_id, ticket]));
  demand(byId.has(ticketId), 'dag_changed', 'The Ticket is not in this manifest', { ticket_id: ticketId });
  const seen = new Set();
  const walk = (id) => {
    for (const parent of byId.get(id)?.depends_on ?? []) {
      demand(byId.has(parent), 'dag_changed', 'A dependency is not in this manifest',
        { ticket_id: id, depends_on: parent });
      if (seen.has(parent)) continue;
      seen.add(parent);
      walk(parent);
    }
  };
  walk(ticketId);
  // The manifest's order restricted to the closure — recorded, not recomputed,
  // because a diamond DAG applied in two orders can produce two trees, and then
  // "the same base" would mean two different things on a retry.
  return manifest.topological_order.filter((id) => seen.has(id));
}

/**
 * The base's identity.
 *
 * Order is deliberately not sorted away, unlike the set-valued fields
 * elsewhere: two bases built from the same predecessors in different orders are
 * different bases, and a digest that hid that would be claiming a determinism
 * the composition does not have.
 */
export function baseDigest({ planning_head, composition_order, predecessors, tree_oid }) {
  const byId = new Map(predecessors.map((entry) => [entry.ticket_id, entry]));
  return createHash('sha256')
    .update(
      JSON.stringify({
        planning_head,
        predecessors: composition_order.map((id) => ({
          ticket_id: id,
          commit_oid: byId.get(id)?.commit_oid ?? null,
          delta_digest: byId.get(id)?.delta_digest ?? null,
        })),
        tree_oid,
      }),
      'utf8',
    )
    .digest('hex');
}

/**
 * Whether two predecessors' deltas can be composed.
 *
 * Compatible overlap is the same path with the same resulting blob and mode:
 * two Tickets that made the same change. Anything else is a semantic conflict,
 * and a model choosing one side is a decision made by something that was not
 * asked to make it.
 */
export function overlapErrors(predecessors) {
  const byPath = new Map();
  const errors = [];
  for (const predecessor of predecessors) {
    for (const entry of predecessor.entries ?? []) {
      const previous = byPath.get(entry.path);
      if (!previous) {
        byPath.set(entry.path, { ...entry, ticket_id: predecessor.ticket_id });
        continue;
      }
      if (previous.new_blob !== entry.new_blob || previous.new_mode !== entry.new_mode) {
        errors.push({
          reason: 'incompatible_overlapping_deltas',
          detail: `${entry.path}: ${previous.ticket_id} and ${predecessor.ticket_id} differ`,
        });
      }
    }
  }
  return errors;
}

/**
 * What must hold before a worktree exists.
 *
 * Verified before enroll, not after the agent has started and produced work
 * against the wrong tree.
 */
export function baseAdmission(base, { predecessorStates, anchorVersion, dagDigest, objects }) {
  const errors = [];
  for (const id of base.composition_order) {
    const state = predecessorStates[id];
    if (!state) {
      errors.push({ reason: 'missing_predecessor_binding', detail: id });
      continue;
    }
    if (!state.commit_oid || !state.delta_digest) {
      errors.push({ reason: 'missing_predecessor_binding', detail: `${id}: no commit or delta binding` });
    }
    if (state.pass !== 'valid') {
      // A stale PASS is a PASS about a tree that no longer exists.
      errors.push({ reason: 'stale_predecessor_pass', detail: `${id}: ${state.pass}` });
    }
  }
  errors.push(...overlapErrors(base.predecessors));

  if (base.digest !== baseDigest(base)) {
    errors.push({ reason: 'base_mismatch', detail: 'the digest does not recompute' });
  }
  if (dagDigest !== undefined && base.dag_digest !== undefined && base.dag_digest !== dagDigest) {
    errors.push({ reason: 'dag_changed', detail: dagDigest });
  }
  if (anchorVersion !== undefined && base.anchor_version !== undefined && base.anchor_version !== anchorVersion) {
    errors.push({ reason: 'anchor_changed', detail: String(anchorVersion) });
  }
  if (objects) {
    if (base.composition_commit_oid && !objects.has(base.composition_commit_oid)) {
      errors.push({ reason: 'unreachable_composition_object', detail: base.composition_commit_oid });
    }
    if (!objects.has(base.tree_oid)) {
      errors.push({ reason: 'unreachable_composition_object', detail: base.tree_oid });
    }
  }
  return errors;
}

/**
 * The descendants a changed predecessor invalidates.
 *
 * Transitive, and computed from the same closure: a base is not "probably still
 * fine" because the change looked small.
 */
export function invalidatedBy(manifest, changedTicketId) {
  return manifest.tickets
    .map((ticket) => ticket.ticket_id)
    .filter((id) => id !== changedTicketId && transitiveClosure(manifest, id).includes(changedTicketId))
    .sort();
}

/**
 * Creating a composition base is idempotent.
 *
 * A crash after the commit object exists but before the metadata is written
 * must not produce a second base or lose the object: the next attempt
 * recomputes the same identity, finds the object, and records it.
 */
export function ensureComposition(base, { objects, recordedMetadata }) {
  const digest = baseDigest(base);
  demand(digest === base.digest, 'base_mismatch', 'The base identity does not recompute',
    { recorded: base.digest, computed: digest });
  if (recordedMetadata?.digest === digest) return Object.freeze({ action: 'already_recorded', digest });
  if (base.composition_commit_oid && objects.has(base.composition_commit_oid)) {
    // The object survived the crash; recording it is the whole remaining step.
    return Object.freeze({ action: 'record_existing_object', digest });
  }
  return Object.freeze({ action: 'create', digest });
}

/**
 * Records a composition the builder produced.
 *
 * A builder that failed is `composition_failed`, and a builder that succeeded
 * while producing another tree is `base_mismatch` — two different facts, and
 * the second is the one that would otherwise be recorded as a success under an
 * identity it does not have.
 */
export function recordComposition(base, built) {
  demand(built.ok, 'composition_failed', 'The composition could not be built',
    { ticket_id: base.ticket_id, detail: built.detail });
  demand(built.tree_oid === base.tree_oid, 'base_mismatch',
    'The composition produced another tree', { recorded: base.tree_oid, built: built.tree_oid });
  return Object.freeze({
    ticket_id: base.ticket_id,
    digest: base.digest,
    composition_commit_oid: built.commit_oid,
    tree_oid: built.tree_oid,
  });
}

/**
 * A retry may reuse the base or void the candidate, and may not do the third thing.
 *
 * Silently rebuilding a different base under the same identity is what would
 * make a retry incomparable with the run it repeats.
 */
export function retryPlan(base, { dagDigest, anchorVersion }) {
  const moved = (base.dag_digest !== undefined && base.dag_digest !== dagDigest)
    || (base.anchor_version !== undefined && base.anchor_version !== anchorVersion);
  return Object.freeze({
    action: moved ? 'void_candidate' : 'reuse_base',
    reason: moved ? (base.dag_digest !== dagDigest ? 'dag_changed' : 'anchor_changed') : null,
  });
}

/** Foreign movement of the private ref is classified separately, not retried. */
export function refMovementErrors(observed, expected) {
  if (observed === expected) return [];
  return [{ reason: 'foreign_ref_movement', detail: observed }];
}
