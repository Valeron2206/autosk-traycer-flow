/** The approved delta: what gets integrated, and what an integration must prove.
 *
 * Full-tree equality asks "does the staging tree equal the reviewed candidate
 * tree?", and for the second independent Ticket the answer is no — not because
 * anything is wrong, but because the first Ticket's approved work is already
 * there. The check reports a difference that is the presence of approved work,
 * which is a false negative on exactly the case the DAG exists to support.
 *
 * So the reviewed unit is a delta, and an integration proves six things about
 * the result rather than one thing about the tool.
 */
import { createHash } from 'node:crypto';

import { demand, immutable } from '../runtime/contracts.mjs';

export const STATUSES = immutable(['A', 'M', 'D', 'R', 'C']);

/** Modes a tree entry can carry. Each one is a way two "identical" patches differ. */
export const MODES = immutable(['100644', '100755', '120000', '160000']);

/** Recoverable phases. Part of the schema, not an implementation detail. */
export const PHASES = immutable(['prepared', 'revalidated', 'applied', 'committed', 'ref_advanced', 'verified']);

export const PARK_REASONS = immutable([
  'delta_stale',
  'scope_violation',
  'untracked_collision',
  'ignored_collision',
  'foreign_ref_movement',
  'indeterminate_post_state',
  'reflog_ambiguous',
  'inherited_git_env',
  'dirty_worktree',
  'state_identity_collision',
  'unreviewed_bytes',
  'containment_mismatch',
]);

/** Git environment variables that silently redirect every command that follows. */
export const INHERITED_GIT_ENV = immutable([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
]);

/** `*` within a segment, `**` across. Nothing else is a metacharacter. */
export function withinPathspec(pathspec, filePath) {
  return pathspec.some((pattern) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
    const expanded = escaped.split('**').map((part) => part.split('*').join('[^/]*')).join('.*');
    return new RegExp(`^${expanded}$`, 'u').test(filePath);
  });
}

/**
 * The delta's identity.
 *
 * Over the entries and the bases both, so a delta cannot be reinterpreted
 * against a different base than the one it was reviewed on.
 */
export function deltaDigest(delta) {
  const body = {
    base_commit_oid: delta.base_commit_oid,
    base_tree_oid: delta.base_tree_oid,
    candidate_tree_oid: delta.candidate_tree_oid,
    pathspec: [...delta.pathspec].sort(),
    entries: [...delta.entries]
      .map((entry) => ({
        path: entry.path,
        from_path: entry.from_path ?? null,
        status: entry.status,
        old_blob: entry.old_blob ?? null,
        new_blob: entry.new_blob ?? null,
        old_mode: entry.old_mode ?? null,
        new_mode: entry.new_mode ?? null,
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  return createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
}

/**
 * Validates a delta's own shape.
 *
 * Text is not identity: an entry records the mode and the blob on both sides,
 * because a mode change has no textual diff, a symlink and a file with the same
 * bytes are different objects, a gitlink points into another repository, and a
 * rename with an identical blob is a real change a content-only view sees as
 * nothing.
 */
export function validateDelta(delta) {
  const errors = [];
  for (const entry of delta.entries) {
    if (!STATUSES.includes(entry.status)) {
      errors.push({ reason: 'containment_mismatch', detail: `${entry.path}: unknown status ${entry.status}` });
      continue;
    }
    if (!withinPathspec(delta.pathspec, entry.path)) {
      errors.push({ reason: 'scope_violation', detail: entry.path });
    }
    if ((entry.status === 'R' || entry.status === 'C') && !entry.from_path) {
      errors.push({ reason: 'containment_mismatch', detail: `${entry.path}: a rename or copy names where it came from` });
    }
    if (entry.status === 'R' && entry.from_path && !withinPathspec(delta.pathspec, entry.from_path)) {
      // A rename out of scope moves a file the Ticket was not allowed to touch.
      errors.push({ reason: 'scope_violation', detail: entry.from_path });
    }
    if (entry.status !== 'D' && !entry.new_blob) {
      errors.push({ reason: 'containment_mismatch', detail: `${entry.path}: no new blob` });
    }
    if (entry.status !== 'A' && entry.status !== 'C' && !entry.old_blob) {
      errors.push({ reason: 'containment_mismatch', detail: `${entry.path}: no old blob` });
    }
    for (const [field, mode] of [['old_mode', entry.old_mode], ['new_mode', entry.new_mode]]) {
      if (mode !== undefined && !MODES.includes(mode)) {
        errors.push({ reason: 'containment_mismatch', detail: `${entry.path}: unknown ${field} ${mode}` });
      }
    }
    if (entry.status === 'M' && entry.old_blob === entry.new_blob && entry.old_mode === entry.new_mode) {
      // A modification that changed neither bytes nor mode is not a
      // modification, and recording one hides what actually moved.
      errors.push({ reason: 'containment_mismatch', detail: `${entry.path}: modification changes nothing` });
    }
  }
  const paths = delta.entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    errors.push({ reason: 'containment_mismatch', detail: 'a path appears twice' });
  }
  if (delta.delta_digest !== deltaDigest(delta)) {
    errors.push({ reason: 'delta_stale', detail: 'the digest does not recompute' });
  }
  return errors;
}

/**
 * Revalidates immediately before apply.
 *
 * A staging base that moved between approval and apply is a different base, and
 * a delta approved against the old one has not been approved against this one.
 */
export function revalidate(delta, stagingBase) {
  const errors = validateDelta(delta);
  if (delta.base_commit_oid !== stagingBase.commit_oid || delta.base_tree_oid !== stagingBase.tree_oid) {
    errors.push({ reason: 'delta_stale', detail: `base moved to ${stagingBase.commit_oid}` });
  }
  return errors;
}

/**
 * The environment an integration may run in.
 *
 * An inherited variable silently redirects every command that follows, so they
 * are neutralised rather than trusted — and an environment that still carries
 * one is refused rather than cleaned in place, because cleaning it would hide
 * how it got there.
 */
export function environmentErrors(env) {
  return INHERITED_GIT_ENV.filter((name) => env[name] !== undefined).map((name) => ({
    reason: 'inherited_git_env',
    detail: name,
  }));
}

/** The worktree an integration may run in. Recorded and refused, never tidied. */
export function worktreeErrors(worktree) {
  const errors = [];
  if (worktree.dirty) errors.push({ reason: 'dirty_worktree', detail: 'tracked changes are present' });
  if (worktree.linked) errors.push({ reason: 'dirty_worktree', detail: 'a linked worktree is attached' });
  if (worktree.autostash) errors.push({ reason: 'dirty_worktree', detail: 'rebase.autostash is configured' });
  return errors;
}

/**
 * Collisions with files nobody reviewed.
 *
 * Fail closed, and nothing is deleted to make room: the file is someone's, and
 * "it was in the way" is not a reason to remove it. Ignored and untracked are
 * separate reasons because they are separate mistakes — one is a build artifact
 * in the way, the other is work somebody has not committed yet.
 */
export function collisionErrors(delta, worktree) {
  const errors = [];
  const touched = new Set(delta.entries.map((entry) => entry.path));
  for (const file of worktree.untracked ?? []) {
    if (touched.has(file)) errors.push({ reason: 'untracked_collision', detail: file });
  }
  for (const file of worktree.ignored ?? []) {
    if (touched.has(file)) errors.push({ reason: 'ignored_collision', detail: file });
  }
  return errors;
}

/**
 * The six statements an integration must prove about the result.
 *
 * Not "it applied cleanly" — that is a statement about the tool.
 */
export function integrationProof(delta, result) {
  const errors = [];
  const approved = new Map(delta.entries.map((entry) => [entry.path, entry]));

  for (const [path, entry] of approved) {
    const applied = result.applied_entries.find((item) => item.path === path);
    if (!applied) {
      errors.push({ reason: 'containment_mismatch', detail: `${path}: approved and not present` });
      continue;
    }
    if (applied.new_blob !== entry.new_blob || applied.new_mode !== entry.new_mode) {
      errors.push({ reason: 'unreviewed_bytes', detail: `${path}: applied bytes are not the approved ones` });
    }
  }
  for (const applied of result.applied_entries) {
    if (!approved.has(applied.path) && withinPathspec(delta.pathspec, applied.path)) {
      // Inside the Ticket's scope, the operation introduced nothing else.
      errors.push({ reason: 'scope_violation', detail: `${applied.path}: introduced and not approved` });
    }
  }
  for (const preserved of result.preserved_from_other_tickets ?? []) {
    if (!preserved.present) {
      errors.push({ reason: 'containment_mismatch', detail: `${preserved.path}: another Ticket's work was lost` });
    }
  }
  if (result.conflicts_resolved_by_new_content) {
    // The point that decides whether this contract means anything: a conflict
    // resolved by producing new content produces bytes nobody reviewed, and no
    // amount of care in choosing them makes them reviewed.
    errors.push({ reason: 'unreviewed_bytes', detail: 'a conflict was resolved by writing new content' });
  }
  if (result.operation_id !== delta.operation_id || result.base_commit_oid !== delta.base_commit_oid) {
    errors.push({ reason: 'containment_mismatch', detail: 'the result is not bound to this operation and base' });
  }
  errors.push(...refMovementErrors(result.ref_movement));
  return errors;
}

/**
 * Branch movement.
 *
 * A foreign or indeterminate movement is classified separately from an ordinary
 * error and is **not retried**: a retry against an unknown post-state is how one
 * uncertain outcome becomes two.
 */
export function refMovementErrors(movement) {
  if (!movement) return [{ reason: 'indeterminate_post_state', detail: 'no ref movement was recorded' }];
  const errors = [];
  if (movement.expected_old_oid !== movement.observed_old_oid) {
    errors.push({ reason: 'foreign_ref_movement', detail: `expected ${movement.expected_old_oid}` });
  }
  if (movement.post_state === 'unknown') {
    errors.push({ reason: 'indeterminate_post_state', detail: movement.ref });
  }
  if (movement.reflog_entries !== undefined && movement.reflog_entries !== 1) {
    // Zero says the move did not happen; more than one says something else
    // moved it too, and neither is a state to advance from.
    errors.push({ reason: 'reflog_ambiguous', detail: `${movement.reflog_entries} entries` });
  }
  return errors;
}

/** Whether a foreign or indeterminate movement may be retried. It may not. */
export function retryable(reason) {
  return !['foreign_ref_movement', 'indeterminate_post_state', 'reflog_ambiguous'].includes(reason);
}

/**
 * Resuming after a crash.
 *
 * A crash in any phase resumes rather than restarts, because "we do not know
 * which phase it died in" is the state that produces double application. A
 * state file whose identity is reused is refused, never overwritten.
 */
export function resumeFrom(state, operationId) {
  demand(PHASES.includes(state.phase), 'indeterminate_post_state', 'Unknown phase', { phase: state.phase });
  demand(state.operation_id === operationId, 'state_identity_collision',
    'The state file belongs to another operation',
    { expected: operationId, found: state.operation_id });
  const index = PHASES.indexOf(state.phase);
  return index === PHASES.length - 1 ? 'complete' : PHASES[index + 1];
}
