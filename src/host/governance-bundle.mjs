/** The governance bundle: build, scan, attest, release (#37).
 *
 * Three places, never one — the imported baseline, the working adaptation and
 * the released bundle the runtime uses. Mixing any two is the failure the
 * separation exists to prevent.
 *
 * One input must give one digest, so the canonical form is stated rather than
 * assumed, and timestamps are not in it: a build that embedded the moment it
 * ran could never be reproduced, and a digest nobody can recompute is a name
 * rather than an identity.
 */
import { createHash } from 'node:crypto';

import { demand, immutable } from '../runtime/contracts.mjs';

export const STAGES = immutable(['baseline', 'adaptation', 'release']);

export const REFUSALS = immutable([
  'bundle_inventory_missing',
  'bundle_inventory_extra',
  'bundle_not_canonical',
  'bundle_traycer_reference',
  'bundle_private_path',
  'bundle_scan_unreadable',
  'bundle_attestation_mismatch',
  'bundle_panel_incomplete',
  'bundle_release_conflict',
  'bundle_stage_mixed',
]);

/** The panel seats an attestation must carry, exactly. */
export const REQUIRED_SEATS = immutable([
  { seat: 'opus', route: 'anthropic/claude-opus-5', effort: 'max' },
  { seat: 'astra', route: 'openai-codex/gpt-6-astra', effort: 'high' },
  { seat: 'grok', route: 'cursor/cursor-grok-4.6', effort: 'xhigh' },
  { seat: 'muse', route: 'meta/muse-spark-1.3-contributor', effort: 'max' },
]);

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Whether a text member is in canonical form.
 *
 * UTF-8 without a BOM, LF endings, and a trailing newline. Each of these is a
 * byte difference that would otherwise make one input give two digests.
 */
export function canonicalTextErrors(path, bytes) {
  const errors = [];
  if (bytes.startsWith('\uFEFF')) errors.push({ reason: 'bundle_not_canonical', detail: `${path}: BOM` });
  if (bytes.includes('\r')) errors.push({ reason: 'bundle_not_canonical', detail: `${path}: CR` });
  if (bytes.length > 0 && !bytes.endsWith('\n')) {
    errors.push({ reason: 'bundle_not_canonical', detail: `${path}: no trailing newline` });
  }
  return errors;
}

/** JSON canonical form: sorted keys, two-space indent, trailing newline. */
export function canonicalJson(value) {
  const sortDeep = (item) => {
    if (Array.isArray(item)) return item.map(sortDeep);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sortDeep(item[key])]));
    }
    return item;
  };
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`;
}

/**
 * The aggregate digest, over `path\0sha256\n` in path order.
 *
 * Paths are compared as raw bytes, so the order does not depend on a locale.
 */
export function bundleDigest(members) {
  const lines = [...members]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((member) => `${member.path}\0${member.sha256}\n`)
    .join('');
  return sha256(lines);
}

/**
 * The inventory must match the manifest exactly.
 *
 * A missing member and an extra member are both refusals: a bundle that
 * carries a file nobody declared is a bundle whose contents nobody can vouch
 * for.
 */
export function inventoryErrors(manifest, members) {
  const declared = new Set(manifest.members.map((member) => member.path));
  const present = new Set(members.map((member) => member.path));
  const errors = [];
  for (const path of declared) {
    if (!present.has(path)) errors.push({ reason: 'bundle_inventory_missing', detail: path });
  }
  for (const path of present) {
    if (!declared.has(path)) errors.push({ reason: 'bundle_inventory_extra', detail: path });
  }
  // Named individually rather than by glob: a glob would let one protocol file
  // go missing without the count changing.
  for (const path of declared) {
    if (path.includes('*')) {
      errors.push({ reason: 'bundle_inventory_missing', detail: `${path} is a glob, not a member` });
    }
  }
  return errors;
}

/**
 * The pre-release scan, fail-closed.
 *
 * A member the scanner cannot read is treated as failing, because "I could not
 * check it" is not "it is clean".
 */
export function scanErrors(members) {
  const errors = [];
  for (const member of members) {
    if (member.readable === false || typeof member.text !== 'string') {
      errors.push({ reason: 'bundle_scan_unreadable', detail: member.path });
      continue;
    }
    if (/traycer_[a-z0-9_]+/iu.test(member.text) || member.text.includes('.traycer')) {
      errors.push({ reason: 'bundle_traycer_reference', detail: member.path });
    }
    for (const prefix of ['/Users/', '/home/', '/root/', 'C:\\']) {
      if (member.text.includes(prefix)) {
        errors.push({ reason: 'bundle_private_path', detail: `${member.path}: ${prefix}` });
      }
    }
    if (member.private_session_file) {
      errors.push({ reason: 'bundle_private_path', detail: `${member.path}: private session file` });
    }
  }
  return errors;
}

/** A candidate carries exactly one stage, and never two. */
export function stageErrors(candidate) {
  if (!STAGES.includes(candidate.stage)) {
    return [{ reason: 'bundle_stage_mixed', detail: `unknown stage ${candidate.stage}` }];
  }
  const foreign = (candidate.members ?? []).filter((member) => member.stage && member.stage !== candidate.stage);
  return foreign.map((member) => ({
    reason: 'bundle_stage_mixed',
    detail: `${member.path} is ${member.stage} inside a ${candidate.stage} bundle`,
  }));
}

/**
 * The attestation binds a candidate, not a build.
 *
 * A panel fix changes the digest, so verdicts collected before it are about a
 * candidate that no longer exists. Rounding that up is the temptation this
 * removes.
 */
export function attestationErrors(attestation, candidateDigest) {
  const errors = [];
  if (attestation.candidate_digest !== candidateDigest) {
    errors.push({ reason: 'bundle_attestation_mismatch', detail: attestation.candidate_digest });
  }
  for (const required of REQUIRED_SEATS) {
    const verdict = (attestation.verdicts ?? []).find((entry) => entry.seat === required.seat);
    if (!verdict) {
      errors.push({ reason: 'bundle_panel_incomplete', detail: `${required.seat} did not answer` });
      continue;
    }
    if (verdict.route !== required.route || verdict.effort !== required.effort) {
      errors.push({
        reason: 'bundle_panel_incomplete',
        detail: `${required.seat}: ${verdict.route}/${verdict.effort} is not ${required.route}/${required.effort}`,
      });
    }
    if (verdict.candidate_digest !== candidateDigest) {
      errors.push({ reason: 'bundle_attestation_mismatch', detail: `${required.seat} answered about another candidate` });
    }
    if (verdict.verdict !== 'pass') {
      errors.push({ reason: 'bundle_panel_incomplete', detail: `${required.seat}: ${verdict.verdict}` });
    }
  }
  if (!attestation.release_actor) {
    errors.push({ reason: 'bundle_attestation_mismatch', detail: 'no release actor' });
  }
  return errors;
}

/** Everything a candidate must satisfy before it can be released. */
export function releaseAdmission(candidate, attestation) {
  const digest = bundleDigest(candidate.members);
  const errors = [
    ...stageErrors(candidate),
    ...inventoryErrors(candidate.manifest, candidate.members),
    ...candidate.members.flatMap((member) =>
      typeof member.text === 'string' && member.path.endsWith('.md')
        ? canonicalTextErrors(member.path, member.text)
        : [],
    ),
    ...scanErrors(candidate.members),
    ...attestationErrors(attestation, digest),
  ];
  if (candidate.stage !== 'release') {
    errors.push({ reason: 'bundle_stage_mixed', detail: 'only a release-stage candidate is released' });
  }
  return Object.freeze({ digest, admitted: errors.length === 0, errors: immutable(errors.map(Object.freeze)) });
}

/**
 * Moving the `current` pointer.
 *
 * Compare-and-swap, so two concurrent releases cannot both win, and releasing
 * an existing digest again is idempotent rather than a second release.
 */
export function releasePointer(current, { digest, expectedCurrent }) {
  if (current === digest) return Object.freeze({ action: 'already_current', digest });
  demand(current === expectedCurrent, 'bundle_release_conflict',
    'The current pointer moved since it was read', { expected: expectedCurrent, actual: current });
  return Object.freeze({ action: 'advance', from: current, to: digest });
}

/**
 * Rollback creates a new current-pointer decision.
 *
 * It never edits or deletes a release: history is added to, so the record of
 * what was current when a verdict was taken survives the rollback.
 */
export function rollbackPlan(current, { toDigest, releases, decisionRef }) {
  demand(releases.includes(toDigest), 'bundle_release_conflict',
    'A rollback target is an existing release', { to: toDigest });
  demand(Boolean(decisionRef), 'bundle_release_conflict', 'A rollback is a recorded decision');
  return Object.freeze({
    action: 'new_pointer_decision',
    from: current,
    to: toDigest,
    decision_ref: decisionRef,
    // Nothing is deleted, and no release is edited.
    deletes: immutable([]),
  });
}

/**
 * Which bundle an Epic uses.
 *
 * A pinned Epic keeps its bundle while any lock references it; a new Epic takes
 * the current one; moving an active Epic is a separate approved workflow rather
 * than a side effect of releasing.
 */
export function bundleForEpic(epic, { current }) {
  if (epic.pinned_bundle) {
    return Object.freeze({ bundle: epic.pinned_bundle, reason: 'pinned', retained: true });
  }
  return Object.freeze({ bundle: current, reason: 'current', retained: false });
}

/** Moving an active Epic to a new bundle needs its own approval. */
export function epicMigrationErrors(epic, { toBundle, approvalRef }) {
  const errors = [];
  if (!approvalRef) {
    errors.push({ reason: 'bundle_release_conflict', detail: 'moving an active Epic is an approved workflow' });
  }
  if (epic.state === 'active' && toBundle === epic.pinned_bundle) {
    errors.push({ reason: 'bundle_release_conflict', detail: 'the Epic is already on that bundle' });
  }
  return errors;
}
