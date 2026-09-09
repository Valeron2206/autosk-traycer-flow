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

import { redact } from './clearance.mjs';
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
export async function referenceInventory(fs, {
  referringFiles,
  // Records rather than files: an external-source snapshot points at evidence
  // from a record that was never written to the evidence root, and a sweep that
  // only reads files would not see it referring to anything.
  referringRecords = [],
  pattern = /evidence\/([A-Za-z0-9._\-/]+)/gu,
}) {
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
  for (const record of referringRecords) {
    const text = JSON.stringify(record);
    read.push(record.id ?? record.snapshot_path ?? '<record>');
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
  // Snapshot records from #21: what they point at is referenced, whether or
  // not anything under the evidence root says so.
  snapshots = [],
  nowMs,
  actor,
  operationId,
  policy,
  dryRun = true,
}) {
  const present = await walkEvidence(fs, root);
  const inventory = await referenceInventory(fs, { referringFiles, referringRecords: snapshots });
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

/**
 * What may leave, and in what form.
 *
 * A `restricted` class is not exported as it stands. For an audience inside the
 * project it goes out redacted, and for anyone else it does not go out at all —
 * and the export says which records it withheld, because a bundle that quietly
 * drops evidence is one whose reader cannot tell what is missing.
 */
export function exportSelection(records, { audience, home, replacements = [] }) {
  demand(audience === 'project' || audience === 'public', 'evidence_referenced_deletion',
    'An export names its audience', { audience });
  const included = [];
  const redacted = [];
  const withheld = [];
  for (const record of records) {
    const durability = CLASS_DURABILITY[record.class];
    demand(durability !== undefined, 'evidence_referenced_deletion',
      'An export cannot classify a record it has no class for', { evidence_id: record.evidence_id });
    if (durability !== 'restricted') {
      included.push(record.evidence_id);
      continue;
    }
    if (audience === 'public') {
      withheld.push(Object.freeze({ evidence_id: record.evidence_id, reason: `restricted class ${record.class}` }));
      continue;
    }
    const { body, redactions } = redact(record.text ?? '', { home, replacements });
    redacted.push(Object.freeze({ evidence_id: record.evidence_id, text: body, redactions: immutable(redactions) }));
  }
  return Object.freeze({
    audience,
    include: immutable(included.sort()),
    redact: immutable(redacted),
    // Named, not dropped: a reader can see that something was held back.
    withheld: immutable(withheld),
  });
}
