/** Importing and building the governance bundle (#37).
 *
 * One input must give one digest, so everything that could make the same bytes
 * hash differently is refused rather than normalised: a BOM, a CRLF, a missing
 * trailing newline. Normalising them quietly would mean the bundle that was
 * scanned is not the bundle that was written.
 *
 * The build reads the manifest's members and only those. A directory walk would
 * make an accidentally-added file part of the bundle, and a member that
 * disappeared would go unnoticed because the count still looked plausible.
 *
 * Injected: `readFile(path)` returning bytes, `writeFile(path, text)`.
 */
import { createHash } from 'node:crypto';

import { demand, immutable } from '../runtime/contracts.mjs';

import {
  bundleDigest,
  canonicalJson,
  canonicalTextErrors,
  inventoryErrors,
  scanErrors,
  stageErrors,
} from './governance-bundle.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A text member is text; anything else is carried as bytes and not scanned as prose. */
const TEXT_SUFFIXES = immutable(['.md', '.json', '.mjs', '.js', '.txt', '.yml', '.yaml']);

export function isTextMember(path) {
  return TEXT_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

/**
 * Reads the declared members, and only the declared members.
 *
 * A member that could not be read is reported rather than skipped: a bundle
 * built from the files that happened to be readable is a different bundle.
 */
export async function importMembers(fs, { root, manifest }) {
  const members = [];
  for (const declared of manifest.members) {
    const path = `${root}/${declared.path}`;
    let bytes;
    try {
      bytes = await fs.readFile(path);
    } catch (error) {
      members.push(Object.freeze({
        path: declared.path,
        readable: false,
        detail: error?.code ?? String(error),
      }));
      continue;
    }
    const text = isTextMember(declared.path) ? bytes.toString('utf8') : null;
    members.push(Object.freeze({
      path: declared.path,
      readable: true,
      sha256: sha256(bytes),
      bytes: bytes.length,
      ...(text === null ? {} : { text }),
      // The contract's reader takes decoded text: a BOM is a character there,
      // and passing raw bytes would ask it a question about a Buffer.
      canonical_errors: immutable(text === null ? [] : canonicalTextErrors(declared.path, text)),
    }));
  }
  return immutable(members);
}

/**
 * The deterministic build.
 *
 * Every check that decides whether these bytes may be a bundle runs before the
 * digest is reported, so a digest is never printed for a candidate that is not
 * one.
 */
export async function buildBundle(fs, { root, manifest, stage = 'baseline' }) {
  const members = await importMembers(fs, { root, manifest });
  const errors = [];
  for (const member of members) {
    if (!member.readable) {
      errors.push({ reason: 'bundle_scan_unreadable', detail: `${member.path}: ${member.detail}` });
      continue;
    }
    for (const problem of member.canonical_errors) errors.push(problem);
  }
  // Only the members that are actually there: a declared file that could not
  // be read is missing from the inventory as well as unreadable, and reporting
  // it as present would leave the count looking plausible.
  const present = members.filter((member) => member.readable);
  errors.push(...inventoryErrors(manifest, present));
  errors.push(...scanErrors(present.map((member) => ({
    path: member.path,
    // A member with no text is not scanned as prose; it is carried by digest.
    readable: true,
    text: member.text ?? '',
  }))));
  errors.push(...stageErrors({ stage, ...manifest }));

  const digest = bundleDigest(present);
  return Object.freeze({
    stage,
    digest,
    members: immutable(members.map((member) => Object.freeze({
      path: member.path,
      sha256: member.sha256 ?? null,
      bytes: member.bytes ?? null,
      readable: member.readable,
    }))),
    errors: immutable(errors.map(Object.freeze)),
    ok: errors.length === 0,
  });
}

/**
 * The candidate document, in the canonical JSON the contract fixes.
 *
 * Written through the same serialiser the digest assumes, because a candidate
 * serialised two ways is two candidates.
 */
export function candidateDocument(built, manifest) {
  demand(built.ok, built.errors[0]?.reason ?? 'bundle_inventory_missing',
    'A candidate is not written for a bundle that did not build', { detail: built.errors[0]?.detail });
  return canonicalJson({
    schema_version: 1,
    stage: built.stage,
    bundle_digest: built.digest,
    // Timestamps are not in the digest and not in the candidate: a build that
    // embedded the moment it ran could never be reproduced.
    members: built.members.map((member) => ({ path: member.path, sha256: member.sha256 })),
    source_manifest: manifest.manifest_id,
  });
}

/** Writes the candidate, and reports what it wrote rather than that it wrote. */
export async function writeCandidate(fs, { path, built, manifest }) {
  const text = candidateDocument(built, manifest);
  await fs.writeFile(path, text);
  return Object.freeze({ path, digest: built.digest, bytes: Buffer.byteLength(text, 'utf8') });
}
