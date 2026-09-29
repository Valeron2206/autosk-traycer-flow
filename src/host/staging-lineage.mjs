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
import { createHash, randomBytes } from 'node:crypto';

import { FlowError, demand, immutable } from '../runtime/contracts.mjs';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The receipted chain from `base` (an Epic's planning head) to the head.
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

/** The digest of an apply recipe: every field but the digest itself, in a fixed order. */
function recipeDigestOf(recipe) {
  const { recipe_digest: ignored, ...body } = recipe;
  return sha256(`autosk-flow/staging-apply-recipe/v1\0${JSON.stringify(Object.fromEntries(Object.keys(body).sort().map((key) => [key, body[key]])))}`);
}

/** An apply key: the digest an apply's recipe is filed under, and so a file name. */
const APPLY_KEY = /^[0-9a-f]{64}$/u;

/**
 * The durable journal of apply recipes, a file per apply key in a directory.
 *
 * A recipe is written before the helper is asked to advance the staging ref
 * (`applyDelta`), so a host that dies between the helper's commit and the
 * receipt still holds the commit it asked for, and a retry can tell its own
 * commit from anyone else's (debt 12g). There is no shared file to tear, cut or
 * fuse, because two applies never write one: a save writes the recipe to a
 * temporary file of its own in the directory (`.<key>.<nonce>.pending`, created
 * exclusively), syncs it, gives it its name with `link` — which is atomic and
 * fails if the name exists — removes the temporary name and syncs the directory.
 * A crash leaves either no recipe under the key (the save never returned, so the
 * helper was never asked: the ask follows the save) or a whole one; what it
 * leaves besides is a temporary file, which no read looks at and which is
 * harmless to remove once it is old — a live save's temporary file has the same
 * name, so only its age tells them apart. Two saves of one key at once meet at
 * `link`: the second finds the name taken and compares.
 *
 * A recipe that is found is made durable before it is relied on: the name it was
 * linked under may be another save's, or the save's own that died before its
 * directory sync, and a helper that commits on the strength of a recipe the
 * filesystem then loses leaves a commit no recipe can vouch for. So `load` of a
 * recipe, and a repeated `save`, sync the directory, and a sync that fails is a
 * failure (`journal_io`), not a recipe. Any refusal of the sync counts, the ones a
 * platform gives for a directory it cannot open (`EISDIR`, `EPERM`) or sync
 * (`EINVAL`, `ENOTSUP`) among them: they say the filesystem cannot promise the
 * name is durable, which is what the journal exists to know.
 *
 * A recipe is written once: the same again is a no-op, another under the same
 * key is refused. A file that is not the one written — edited, cut short, not a
 * record, or another key's — is refused when its key is read: the journal cannot
 * vouch for it, and without the recipe the receipt of that apply cannot be
 * restored, which is `receipt_missing` at `apply_staging`, the stop the graph has
 * for it. It stops that key and no other. The way back is the person's: the file
 * is quarantined — renamed to its own name and `.quarantined` in the same
 * directory — and the delta is re-applied under a fresh operation. The renamed
 * file is a marker, and it refuses: the recipe held the apply's reflog guard and
 * its request pair, so a same-operation apply with no recipe would make a new one
 * and send the pair of a request that already committed. A quarantined key is
 * refused by name (`receipt_missing`, `cause: journal`) on every read and save;
 * a fresh operation is another key. Any failure to read or write — a full disk, a directory the process
 * may not use — is an environment failure (`environment_failure`, `cause:
 * journal_io`, with the errno), which leaves nothing half done and needs no
 * restoring: the apply is resumed.
 *
 * `fs` is `readFile`, `open`, `link` and `unlink` of `node:fs/promises`, and the
 * directory exists.
 */
export function recipeJournal(fs, { directory }) {
  const nameOf = (key) => `${directory}/${key}.recipe`;
  const assertKey = (key) => demand(typeof key === 'string' && APPLY_KEY.test(key), 'invalid_record',
    'A recipe is filed under the digest of its apply, and nothing else names a file', {});
  const cannotVouch = (detail, key) => demand(false, 'receipt_missing',
    'The recipe journal cannot vouch for this apply: the receipts cannot be restored from what it holds', { cause: 'journal', apply_key: key, detail });
  const ioFailure = (what, error) => new FlowError('environment_failure',
    `The recipe journal could not ${what}${typeof error?.message === 'string' ? `: ${error.message}` : ''}`,
    { cause: 'journal_io', errno: typeof error?.code === 'string' ? error.code : null });

  const quarantinedOf = (key) => `${nameOf(key)}.quarantined`;

  async function read(key) {
    // Before the recipe is looked at: a quarantined key has none to trust, whatever is or is not under its name.
    try {
      await fs.readFile(quarantinedOf(key));
      cannotVouch('the recipe of this apply was quarantined: a fresh operation re-applies it', key);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error instanceof FlowError) throw error;
        throw ioFailure('read a recipe', error);
      }
    }
    let buffer;
    try {
      buffer = Buffer.from(await fs.readFile(nameOf(key)));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw ioFailure('read a recipe', error);
    }
    let parsed = null;
    try {
      parsed = JSON.parse(buffer.toString('utf8'));
    } catch {
      parsed = null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) cannotVouch('a line is not a record', key);
    if (parsed.apply_key !== key || parsed.recipe_digest !== recipeDigestOf(parsed)) cannotVouch('a line is not the one that was written', key);
    return parsed;
  }

  async function syncDirectory() {
    // No refusal of the sync is tolerated (#280 carry, debt 13a): a directory that cannot be opened or synced is a
    // filesystem on which the name of a recipe may be lost, and an apply that then asks the helper can leave a commit no
    // recipe vouches for. The supported platforms — linux-x64 on ext4, btrfs and xfs, darwin-arm64 on APFS — sync a
    // directory, so a refusal is an unsupported filesystem, and it stops the apply where it can be told.
    let handle;
    try {
      handle = await fs.open(directory, 'r');
      await handle.sync();
    } catch (error) {
      throw ioFailure('make its directory durable', error);
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  return Object.freeze({
    async load(key) {
      assertKey(key);
      const held = await read(key);
      if (held === null) return null;
      // Relied on from here: whatever linked it may have died before it made the name durable.
      await syncDirectory();
      return immutable(held);
    },
    async save(recipe) {
      assertKey(recipe?.apply_key);
      const key = recipe.apply_key;
      const line = { ...recipe, recipe_digest: recipeDigestOf(recipe) };
      const agree = (held) => {
        if (held.recipe_digest !== line.recipe_digest) cannotVouch('the apply already has another recipe', key);
      };
      const held = await read(key);
      if (held !== null) {
        agree(held);
        await syncDirectory();
        return;
      }
      const bytes = Buffer.from(`${JSON.stringify(line)}\n`, 'utf8');
      const pending = `${directory}/.${key}.${randomBytes(8).toString('hex')}.pending`;
      try {
        let handle;
        try {
          handle = await fs.open(pending, 'wx', 0o600);
        } catch (error) {
          throw ioFailure('create a file', error);
        }
        try {
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
            if (!(bytesWritten > 0)) throw ioFailure('write a recipe: the write made no progress', null);
            offset += bytesWritten;
          }
          await handle.sync();
        } catch (error) {
          throw error instanceof FlowError ? error : ioFailure('write a recipe', error);
        } finally {
          await handle.close().catch(() => {});
        }
        try {
          await fs.link(pending, nameOf(key));
        } catch (error) {
          if (error?.code !== 'EEXIST') throw ioFailure('give a recipe its name', error);
          // Another save of this key got there first: what it saved is what this one has to agree with.
          const winner = await read(key);
          if (winner === null) throw ioFailure('give a recipe its name', error);
          agree(winner);
        }
      } finally {
        await fs.unlink(pending).catch(() => {});
      }
      await syncDirectory();
    },
  });
}
