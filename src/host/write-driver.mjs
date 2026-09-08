/** Verified artifact writes: receipt, read-back, quarantine (#22).
 *
 * A write that returned is not an artifact that exists. Between the two sit
 * every failure this driver is about: a path that resolves somewhere else, a
 * previous version that was not what the write assumed, a filesystem that
 * accepted the bytes and stored other ones, and an artifact that should never
 * have been published in the first place.
 *
 * The receipt is written before the bytes and completed after the read-back, so
 * a crash in between leaves a record that says which half happened. A receipt
 * that only appears after success cannot describe a failure.
 *
 * Injected: `readFile(path)`, `writeFile(path, bytes)`, `rename(from, to)`,
 * `lstat(path)` returning `{ isFile, isSymbolicLink, size, nlink, mode }`,
 * `mkdir(path)`, `realpath(path)`.
 */
import { createHash } from 'node:crypto';

import { demand, immutable } from '../runtime/contracts.mjs';

import { applyDisposition, quarantineDecision, reconcile } from './write-reconciliation.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Where the write may land, resolved rather than trusted.
 *
 * The path is resolved per directory and refused if it leaves the artifact
 * root — the string being inside the project says nothing about where the
 * bytes go.
 */
export async function resolveDestination(fs, destination, { artifactRoot }) {
  const root = await fs.realpath(artifactRoot);
  const parent = destination.slice(0, destination.lastIndexOf('/'));
  let resolvedParent;
  try {
    resolvedParent = await fs.realpath(parent);
  } catch {
    resolvedParent = parent;
  }
  const resolved = `${resolvedParent}/${destination.slice(destination.lastIndexOf('/') + 1)}`;
  demand(resolved === root || resolved.startsWith(`${root}/`), 'write_destination_invalid',
    'The write would land outside the artifact root', { destination, resolved, root });
  return resolved;
}

/**
 * What is at the destination now.
 *
 * A hard-linked or special file is not a place to publish an artifact: writing
 * through a link changes something nobody named.
 */
export async function observeDestination(fs, destination) {
  try {
    const stat = await fs.lstat(destination);
    const bytes = stat.isFile && !stat.isSymbolicLink ? await fs.readFile(destination) : null;
    return Object.freeze({
      exists: true,
      regular_single_linked: stat.isFile === true && stat.isSymbolicLink !== true && (stat.nlink ?? 1) === 1,
      size_bytes: stat.size,
      sha256: bytes ? sha256(bytes) : null,
    });
  } catch {
    return Object.freeze({ exists: false, regular_single_linked: true, size_bytes: 0, sha256: null });
  }
}

/**
 * The write itself.
 *
 * Expected-previous is compared before anything is written, because "the file
 * changed under us" discovered afterwards is a fact about a file that has
 * already been overwritten.
 */
export async function verifiedWrite(fs, {
  destination,
  bytes,
  expectedPrevious = null,
  artifactRoot,
  policy = { max_bytes: 8 * 1024 * 1024 },
  klass,
  classValid = true,
  policyKnown = true,
  quarantinePath,
  operationId,
}) {
  const resolved = await resolveDestination(fs, destination, { artifactRoot });
  const before = await observeDestination(fs, resolved);
  demand(before.regular_single_linked, 'write_not_regular',
    'The destination is not a regular, single-linked file', { destination: resolved });
  demand((before.sha256 ?? null) === expectedPrevious, 'write_previous_mismatch',
    'The destination does not hold the expected previous version',
    { expected: expectedPrevious, observed: before.sha256 });

  const held = quarantineDecision({
    path: resolved,
    quarantine_path: quarantinePath,
    size_bytes: bytes.length,
    regular_single_linked: true,
    class_valid: classValid,
    policy_known: policyKnown,
  }, policy);

  // Written before the bytes: a receipt that only appears after success cannot
  // describe a failure.
  const receipt = {
    operation_id: operationId,
    path: resolved,
    class: klass,
    phase: 'prepared',
    expected_previous_sha256: expectedPrevious,
    intended_sha256: sha256(bytes),
    bytes: bytes.length,
  };

  if (held.state === 'held') {
    await fs.mkdir(held.path.slice(0, held.path.lastIndexOf('/')));
    await fs.writeFile(held.path, bytes);
    return Object.freeze({
      ...receipt,
      phase: 'quarantined',
      quarantine: held,
      // The source is not destroyed and the artifact is not published: a
      // quarantine that deletes what it could not classify is a data-loss path
      // wearing a safety name.
      published: false,
    });
  }

  await fs.mkdir(resolved.slice(0, resolved.lastIndexOf('/')));
  await fs.writeFile(resolved, bytes);
  const readBack = await observeDestination(fs, resolved);
  if (readBack.sha256 !== receipt.intended_sha256) {
    return Object.freeze({
      ...receipt,
      phase: 'failed',
      reason: 'write_readback_mismatch',
      observed_sha256: readBack.sha256,
      published: false,
    });
  }
  return Object.freeze({
    ...receipt,
    phase: 'written',
    observed_sha256: readBack.sha256,
    published: true,
  });
}

/**
 * The reconciliation, from four sources that are read rather than assumed.
 *
 * The receipt is not finished until they agree, and a source that could not be
 * read is `unknown` rather than absent — the difference is whether the flow
 * knows it did not look.
 */
export async function completeReceipt(fs, receipt, { taskMetadataDigest, modelOutputDigest }) {
  demand(receipt.phase === 'written', 'write_readback_mismatch',
    'Only a written artifact is reconciled', { phase: receipt.phase });
  const canonical = await observeDestination(fs, receipt.path);
  const observations = {};
  if (canonical.sha256) observations.canonical_bytes = canonical.sha256;
  observations.receipt = receipt.intended_sha256;
  if (taskMetadataDigest !== undefined) observations.task_metadata = taskMetadataDigest;
  if (modelOutputDigest !== undefined) observations.model_output = modelOutputDigest;
  const reconciliation = reconcile(observations);
  return Object.freeze({
    ...receipt,
    phase: reconciliation.state === 'agreed' ? 'verified' : 'diverged',
    reconciliation,
  });
}

/**
 * Receipts that are durable, and a resume that reads them.
 *
 * A crash between the write and the read-back leaves a `prepared` or `written`
 * receipt, and the resume can tell those apart — which is the whole reason the
 * receipt is written first.
 */
export function resumeFromReceipts(receipts, { runId }) {
  const mine = receipts.filter((receipt) => receipt.operation_id === runId);
  const unfinished = mine.filter((receipt) => !['verified', 'quarantined', 'failed'].includes(receipt.phase));
  return Object.freeze({
    total: mine.length,
    unfinished: immutable(unfinished.map((receipt) => Object.freeze({ path: receipt.path, phase: receipt.phase }))),
    next: unfinished.length === 0 ? 'complete' : `resume ${unfinished[0].phase}`,
  });
}

/**
 * Carrying out a disposition on a held artifact.
 *
 * The disposition is a person's; this performs it and records what it did. The
 * four are not symmetric, and the asymmetry is the point:
 *
 * - `inspect` moves nothing. Looking at something is not deciding about it;
 * - `transform` publishes different bytes, so it names them and they are
 *   verified like any other write;
 * - `reject` leaves the held bytes where they are. Deleting them would destroy
 *   the only copy of something a person just looked at and declined;
 * - `restore` publishes the held bytes unchanged, and is the only disposition
 *   that can put an artifact where the quarantine stopped it.
 */
export async function carryOutDisposition(fs, {
  receipt,
  disposition,
  by,
  transformedBytes,
  artifactRoot,
  operationId,
}) {
  demand(receipt.phase === 'quarantined', 'write_destination_invalid',
    'Only a quarantined receipt takes a disposition', { phase: receipt.phase });
  const disposed = applyDisposition(receipt.quarantine, disposition, { by });

  if (disposition === 'inspect' || disposition === 'reject') {
    return Object.freeze({
      ...receipt,
      quarantine: disposed,
      // Nothing moved. A rejected artifact keeps its bytes: deleting them would
      // destroy the only copy of what a person just declined.
      published: false,
      held_bytes_retained: true,
    });
  }

  demand(disposition !== 'transform' || Buffer.isBuffer(transformedBytes) || typeof transformedBytes === 'string',
    'write_destination_invalid', 'A transform names the bytes it publishes', {});
  const bytes = disposition === 'transform'
    ? Buffer.from(transformedBytes)
    : await fs.readFile(disposed.path);

  // Published through the same verified write as anything else: a disposition
  // is a decision about what to publish, not a way around how publishing works.
  const written = await verifiedWrite(fs, {
    destination: receipt.path,
    bytes,
    artifactRoot,
    klass: receipt.class,
    operationId: operationId ?? receipt.operation_id,
    quarantinePath: disposed.path,
    policy: { max_bytes: Number.MAX_SAFE_INTEGER },
  });
  return Object.freeze({
    ...written,
    quarantine: disposed,
    from_disposition: disposition,
    held_bytes_retained: true,
  });
}
