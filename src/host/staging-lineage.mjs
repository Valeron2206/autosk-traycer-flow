/** How a staging ref got where it is, and where the receipts live (#8, #9).
 *
 * A staging ref at a commit says nothing about how it arrived. The lineage is
 * the chain of applied deltas that produced it, each link naming the delta and
 * the commit it made — and a commit in that chain nobody holds a receipt for is
 * reported as a gap rather than passed over, because an unaccounted commit on
 * a staging ref is precisely the thing the aggregate is about to verify.
 *
 * Receipts are stored append-only. A file that can be rewritten is a file whose
 * earlier contents were a draft, and the resume that reads it needs to know
 * that what it finds is what was written.
 */
import { createHash } from 'node:crypto';

import { demand, immutable } from '../runtime/contracts.mjs';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The chain from the recorded base to the head.
 *
 * Built by following each receipt's base to the commit the previous one
 * produced, so a receipt that does not connect is a break rather than an entry
 * out of order.
 */
export function lineageFor(receipts, { base, head }) {
  const byBase = new Map(receipts.map((receipt) => [receipt.base_commit_oid, receipt]));
  const chain = [];
  const seen = new Set();
  let cursor = base;
  while (cursor !== head) {
    const receipt = byBase.get(cursor);
    if (!receipt) break;
    demand(!seen.has(receipt.staging_commit_oid), 'containment_mismatch',
      'The lineage loops back on a commit it already used', { commit: receipt.staging_commit_oid });
    seen.add(receipt.staging_commit_oid);
    chain.push(Object.freeze({
      base_commit_oid: receipt.base_commit_oid,
      staging_commit_oid: receipt.staging_commit_oid,
      delta_digest: receipt.delta_digest,
      operation_id: receipt.operation_id,
    }));
    cursor = receipt.staging_commit_oid;
  }
  const complete = cursor === head;
  return Object.freeze({
    base,
    head,
    chain: immutable(chain),
    complete,
    // Named, not implied: the commit the chain stopped at is where the
    // unaccounted work begins.
    gap_at: complete ? null : cursor,
    unused: immutable(receipts
      .filter((receipt) => !seen.has(receipt.staging_commit_oid))
      .map((receipt) => receipt.staging_commit_oid)
      .sort()),
  });
}

/**
 * Two Epics staging onto one target.
 *
 * They may run at once; what they may not do is record the same base while
 * neither has integrated. The second to swap would then advance a branch from a
 * base that no longer describes it, and its aggregate verified a tree that is
 * not what would land.
 */
export function crossEpicErrors(lineages) {
  const errors = [];
  const byTarget = new Map();
  for (const lineage of lineages) {
    const key = `${lineage.target_ref}`;
    byTarget.set(key, [...(byTarget.get(key) ?? []), lineage]);
  }
  for (const [target, group] of byTarget) {
    const open = group.filter((lineage) => lineage.integrated !== true);
    const bases = new Map();
    for (const lineage of open) {
      const existing = bases.get(lineage.recorded_target_base);
      if (existing) {
        errors.push({
          reason: 'foreign_target_movement',
          detail: `${existing} and ${lineage.epic_id} both staged ${target} from ${lineage.recorded_target_base}`,
        });
        continue;
      }
      bases.set(lineage.recorded_target_base, lineage.epic_id);
    }
    for (const lineage of open) {
      // A base taken from inside another Epic's unintegrated chain is a base
      // that only exists if that Epic lands first, which nobody promised.
      for (const other of open) {
        if (other.epic_id === lineage.epic_id) continue;
        if ((other.chain ?? []).some((link) => link.staging_commit_oid === lineage.recorded_target_base)) {
          errors.push({
            reason: 'foreign_target_movement',
            detail: `${lineage.epic_id} staged from a commit inside ${other.epic_id}'s unintegrated lineage`,
          });
        }
      }
    }
  }
  return errors;
}

/** The digest of a receipt, over the fields that decide what it says. */
export function receiptDigest(receipt) {
  return sha256(JSON.stringify({
    operation_id: receipt.operation_id,
    base_commit_oid: receipt.base_commit_oid,
    staging_commit_oid: receipt.staging_commit_oid,
    staging_tree_oid: receipt.staging_tree_oid,
    delta_digest: receipt.delta_digest,
    phase: receipt.phase,
  }));
}

/**
 * Appends a receipt to the durable log.
 *
 * Append-only, and the previous digest is carried into the next line, so a line
 * edited afterwards breaks the chain rather than sitting there looking
 * original.
 */
export async function appendReceipt(fs, { path, receipt, previous = null }) {
  const digest = receiptDigest(receipt);
  const line = JSON.stringify({ ...receipt, receipt_digest: digest, previous_digest: previous });
  let existing = '';
  try {
    existing = (await fs.readFile(path)).toString('utf8');
  } catch {
    existing = '';
  }
  await fs.writeFile(path, `${existing}${line}\n`);
  return Object.freeze({ digest, previous_digest: previous });
}

/**
 * Reads the log back, and says where it stops making sense.
 *
 * A log that is read as a list of receipts hides the one thing worth knowing
 * about it: whether the lines are the lines that were written.
 */
export async function loadReceipts(fs, { path }) {
  let text;
  try {
    text = (await fs.readFile(path)).toString('utf8');
  } catch {
    return Object.freeze({ receipts: immutable([]), intact: true, broken_at: null });
  }
  const receipts = [];
  let previous = null;
  let brokenAt = null;
  for (const [index, line] of text.split('\n').filter(Boolean).entries()) {
    const parsed = JSON.parse(line);
    const expected = receiptDigest(parsed);
    if (brokenAt === null && (parsed.receipt_digest !== expected || parsed.previous_digest !== previous)) {
      brokenAt = index;
    }
    receipts.push(Object.freeze(parsed));
    previous = parsed.receipt_digest;
  }
  return Object.freeze({
    receipts: immutable(receipts),
    intact: brokenAt === null,
    broken_at: brokenAt,
  });
}
