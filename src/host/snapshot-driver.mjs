/** Minting external source snapshots against a real filesystem (#21).
 *
 * The contract says what a snapshot record has to prove. This produces one, and
 * the two facts it exists to establish are both about bytes that were actually
 * read: the source was a regular file when it was read, and what landed in the
 * snapshot is what was read back out of it.
 *
 * `lstat`, never `stat`. A symlink where a file was expected is the difference
 * between snapshotting a project's file and snapshotting whatever it points at,
 * and `stat` cannot tell them apart — it answers about the target.
 *
 * Injected: `readFile(path)` returning bytes, `writeFile(path, bytes)`,
 * `lstat(path)` returning `{ isFile, isSymbolicLink, size }`, `mkdir(path)` and
 * `realpath(path)`.
 */
import { createHash } from 'node:crypto';

import { demand, immutable } from '../runtime/contracts.mjs';

import { hashingMode, locationErrors } from './source-snapshot.mjs';

/** The digest of these exact bytes, in the mode the media type requires. */
export function digestBytes(bytes, mediaType) {
  const mode = hashingMode(mediaType);
  const hash = createHash('sha256');
  // `utf8_exact` and `binary_exact` differ in what the caller may normalise
  // before arriving here, not in how the bytes are hashed: the digest is over
  // the bytes either way, and saying so is the point of recording the mode.
  hash.update(bytes);
  return Object.freeze({ sha256: hash.digest('hex'), mode, bytes: bytes.length });
}

/**
 * What the source is, right now, without following anything.
 *
 * A source that disappeared and a source that became a symlink are different
 * facts, and `mintErrors` has a different refusal for each.
 */
export async function observeSource(fs, locator) {
  try {
    const stat = await fs.lstat(locator);
    return Object.freeze({
      available: true,
      regular_file: stat.isFile === true && stat.isSymbolicLink !== true,
      size: stat.size,
    });
  } catch {
    return Object.freeze({ available: false, regular_file: false, size: null });
  }
}

/**
 * Where the snapshot may be written, resolved rather than concatenated.
 *
 * A directory replaced by a symlink out of the project turns an in-project path
 * into an out-of-project write, and the string still looks right.
 */
export async function assertSnapshotLocation(fs, snapshotPath, location) {
  const parent = snapshotPath.slice(0, snapshotPath.lastIndexOf('/'));
  let resolvedParent;
  try {
    resolvedParent = await fs.realpath(parent);
  } catch {
    // Nothing to resolve yet: the directory is created inside the project below.
    resolvedParent = parent;
  }
  const resolved = `${resolvedParent}/${snapshotPath.slice(snapshotPath.lastIndexOf('/') + 1)}`;
  const errors = locationErrors(resolved, location);
  demand(errors.length === 0, errors[0]?.reason ?? 'snapshot_out_of_project',
    'The snapshot would not land in the project', { detail: errors[0]?.detail, resolved });
  return resolved;
}

/**
 * Mints the snapshot: read, hash, write, read back, hash again.
 *
 * The read-back is not a formality. A write that returned is a statement about
 * a syscall; the second digest is the statement about the bytes, and they are
 * different claims often enough that the record carries both.
 */
export async function mintSnapshot(fs, { locator, snapshotPath, mediaType, location }) {
  const source = await observeSource(fs, locator);
  demand(source.available, 'snapshot_source_unavailable', 'The source is not there', { locator });
  demand(source.regular_file, 'snapshot_source_not_regular', 'The source is not a regular file', { locator });

  const resolved = await assertSnapshotLocation(fs, snapshotPath, location);
  const bytes = await fs.readFile(locator);
  const written = digestBytes(bytes, mediaType);
  await fs.mkdir(snapshotPath.slice(0, snapshotPath.lastIndexOf('/')));
  await fs.writeFile(snapshotPath, bytes);
  const readBack = digestBytes(await fs.readFile(snapshotPath), mediaType);

  return Object.freeze({
    locator,
    snapshot_path: resolved,
    media_type: mediaType,
    hashing_mode: written.mode,
    source_sha256: written.sha256,
    snapshot_sha256: written.sha256,
    // Two fields, not one: a snapshot that was never read back proves the write
    // returned, not that the bytes are there.
    read_back_sha256: readBack.sha256,
    bytes: written.bytes,
  });
}

/**
 * What the source looks like now, against what was recorded.
 *
 * `identity_uncertain` is its own answer: a source that is there but cannot be
 * read as the same kind of thing is neither unchanged nor changed, and guessing
 * either way is how a snapshot stops describing anything.
 */
export async function observeDrift(fs, record) {
  const source = await observeSource(fs, record.locator);
  if (!source.available) return Object.freeze({ state: 'unavailable', locator: record.locator });
  if (!source.regular_file) return Object.freeze({ state: 'identity_uncertain', locator: record.locator });
  const now = digestBytes(await fs.readFile(record.locator), record.media_type);
  if (now.mode !== record.hashing_mode) {
    return Object.freeze({ state: 'identity_uncertain', locator: record.locator, detail: 'the hashing mode changed' });
  }
  if (now.sha256 === record.source_sha256) return Object.freeze({ state: 'unchanged', locator: record.locator });
  return Object.freeze({
    state: 'changed',
    locator: record.locator,
    observed_sha256: now.sha256,
    normative: record.normative !== false,
  });
}

/**
 * The gate hook: every snapshot in the controlling set, re-observed.
 *
 * Checked at the gate rather than at the mint, because the interesting drift
 * happens in between — and a gate that trusts a digest recorded an hour ago is
 * a gate about an hour ago.
 */
export async function gateHook(fs, { records }) {
  const observations = [];
  for (const record of records) {
    observations.push({ record: record.locator, observation: await observeDrift(fs, record) });
  }
  const blocking = observations.filter((entry) => entry.observation.state !== 'unchanged');
  return Object.freeze({
    checked: observations.length,
    observations: immutable(observations.map((entry) => Object.freeze({ ...entry }))),
    decision: blocking.length === 0 ? 'proceed' : 'park',
    blocking: immutable(blocking.map((entry) => entry.record).sort()),
  });
}
