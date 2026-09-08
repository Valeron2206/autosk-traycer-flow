/** Sweeping a real evidence root, and the inventory that protects it (#27).
 *
 * The retention rules already say what may be deleted. What they need before
 * anything is deleted is an inventory of what is referenced — and the order
 * matters: a sweep that builds the inventory *while* deleting will delete
 * something that a record it has not read yet still points at.
 *
 * So this reads the whole reference set first, then plans, then deletes only
 * what the plan named, recording a tombstone for each. Nothing is removed that
 * the inventory did not clear, and the sweep reports what it walked rather than
 * only what it removed.
 *
 * Injected: `readdir(path)` returning names, `lstat(path)`, `readFile(path)`,
 * `rm(path)`.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

import { CLASS_DURABILITY, cleanupPlan, tombstoneFor } from './evidence-retention.mjs';

/** Every file under the evidence root, with the id the records use. */
export async function walkEvidence(fs, root, prefix = '') {
  const entries = [];
  let names;
  try {
    names = await fs.readdir(prefix ? `${root}/${prefix}` : root);
  } catch {
    return immutable([]);
  }
  for (const name of names.sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const absolute = `${root}/${relative}`;
    const stat = await fs.lstat(absolute);
    if (stat.isDirectory) {
      entries.push(...await walkEvidence(fs, root, relative));
      continue;
    }
    entries.push(Object.freeze({
      evidence_id: relative,
      path: absolute,
      size_bytes: stat.size,
      // A symlink inside the evidence root points at bytes the sweep does not
      // own, and deleting it is not deleting what it names.
      symlink: stat.isSymbolicLink === true,
    }));
  }
  return immutable(entries);
}

/**
 * Every evidence id anything still points at.
 *
 * Built completely before the plan, from every referring record. A partial
 * inventory is worse than none: it reads like a complete one.
 */
export async function referenceInventory(fs, { referringFiles, pattern = /evidence\/([A-Za-z0-9._\-/]+)/gu }) {
  const references = new Set();
  const read = [];
  const unreadable = [];
  for (const file of referringFiles) {
    let text;
    try {
      text = (await fs.readFile(file)).toString('utf8');
    } catch {
      unreadable.push(file);
      continue;
    }
    read.push(file);
    for (const match of text.matchAll(pattern)) references.add(match[1]);
  }
  // A referring record nobody could read leaves the inventory incomplete, and
  // an incomplete inventory may not clear anything for deletion.
  demand(unreadable.length === 0, 'evidence_referenced_deletion',
    'A referring record could not be read, so the inventory is incomplete',
    { unreadable: immutable(unreadable) });
  return Object.freeze({ references, read: immutable(read.sort()), count: references.size });
}

/**
 * The sweep: walk, inventory, plan, delete, tombstone.
 *
 * `dryRun` is the default. A sweeper whose first behaviour is to delete is one
 * nobody can safely point at a directory to find out what it would do.
 */
export async function sweep(fs, {
  root,
  records,
  referringFiles,
  nowMs,
  actor,
  operationId,
  policy,
  dryRun = true,
}) {
  const present = await walkEvidence(fs, root);
  const inventory = await referenceInventory(fs, { referringFiles });
  const byId = new Map(present.map((entry) => [entry.evidence_id, entry]));

  // Records about evidence that is no longer there are reported, not planned:
  // deleting what is already gone hides that something else removed it.
  const missing = records.filter((record) => !byId.has(record.evidence_id));
  const orphans = present.filter((entry) => !records.some((record) => record.evidence_id === entry.evidence_id));

  const plan = cleanupPlan(records.filter((record) => byId.has(record.evidence_id)), {
    references: inventory.references,
    nowMs,
    policy,
  });

  const tombstones = [];
  const deleted = [];
  if (!dryRun) {
    for (const id of plan.delete) {
      const entry = byId.get(id);
      const record = records.find((candidate) => candidate.evidence_id === id);
      demand(entry.symlink !== true, 'evidence_referenced_deletion',
        'A symlink in the evidence root is not deleted as if it were the evidence', { evidence_id: id });
      await fs.rm(entry.path);
      deleted.push(id);
      tombstones.push(tombstoneFor(record, {
        reason: `retention: ${CLASS_DURABILITY[record.class]}`,
        nowMs,
        actor,
        operationId,
      }));
    }
  }

  return Object.freeze({
    // Reported, not implied: this is what the sweep looked at.
    walked: present.length,
    referenced: inventory.count,
    referring_files_read: inventory.read,
    plan,
    dry_run: dryRun,
    deleted: immutable(deleted.sort()),
    tombstones: immutable(tombstones),
    missing: immutable(missing.map((record) => record.evidence_id).sort()),
    orphans: immutable(orphans.map((entry) => entry.evidence_id).sort()),
  });
}
