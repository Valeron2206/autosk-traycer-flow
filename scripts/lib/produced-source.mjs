/**
 * The source binding a produced report carries.
 *
 * `produce:refusals` measures refusals on one tree; the package renders the
 * result on another only if the inputs agree. The report names two things:
 *
 * - `files`: every repo-relative file the derivation depends on — the module
 *   closure it executed, the data each manifest's fixture opens, the contract
 *   documents — each with its sha256;
 * - `listings`: each directory enumeration a scan performed, recorded as the
 *   filtered member paths. A file added under a scanned directory is an input
 *   the member digests cannot see: no recorded member drifts, yet the run's
 *   output would change. Recording the listing makes the check symmetric —
 *   added, removed and changed inputs all refuse.
 *
 * `digest` folds files and listings into one sha256 over sorted lines, the
 * `candidateDigest` convention. Consumption recomputes the members and the
 * listings on the current tree: any difference refuses the column rather than
 * printing a number produced elsewhere.
 *
 * A bound name is a position, not only bytes: `src/host/factory.mjs` replaced
 * by a link to an identical copy outside the repository keeps every recorded
 * digest, but Node resolves the module's own `./…` imports against the copy's
 * physical directory — neighbours the binding never saw execute. So every
 * bound name — file, listing directory, listing member — must be its own
 * physical path: the logical name below the physical root is the identity,
 * and a name that resolves elsewhere refuses at bind and at consumption.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** One scan spec -> its filtered membership, repo-relative and sorted. */
function enumerate(root, { dir, suffix, deep }) {
  const members = [];
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (deep) walk(next);
      } else if (entry.name.endsWith(suffix)) {
        members.push(next);
      }
    }
  };
  walk(dir);
  return members.sort();
}

export const digestOf = (files, listings) =>
  sha256(
    files
      .map((file) => `${file.path} ${file.sha256}`)
      .concat(
        listings.map(
          (listing) =>
            `listing ${listing.dir} ${listing.suffix}${listing.deep ? " deep" : ""}: ${listing.members.join(" ")}`,
        ),
      )
      .join("\n"),
  );

/**
 * The physical name `relative` resolves to under `root`, or null when it
 * resolves to nothing. `realRoot` is the physical root, so a name is its own
 * physical path exactly when resolving it lands on `realRoot` + itself —
 * any link, in the final component or an ancestor, moves it elsewhere.
 */
const physicalName = (realRoot, root, relative) => {
  try {
    return realpathSync(path.join(root, relative));
  } catch {
    return null;
  }
};

/**
 * The shallowest ancestor-or-self of `relative` that resolves elsewhere, or
 * null when the whole chain is physical. A component that resolves to
 * nothing ends the walk — a missing name is reported by the byte or
 * membership checks, not here.
 */
const linkPoint = (realRoot, root, relative) => {
  const parts = relative.split("/");
  for (let depth = 1; depth <= parts.length; depth++) {
    const prefix = parts.slice(0, depth).join("/");
    const resolved = physicalName(realRoot, root, prefix);
    if (resolved === null) return null;
    if (resolved !== path.join(realRoot, prefix)) return prefix;
  }
  return null;
};

/**
 * Repo-relative paths + scan specs -> the bound source: each file hashed,
 * each listing's membership recorded, one digest over both. Refuses to bind
 * a name whose physical path is elsewhere — a linked file or directory makes
 * bytes outside the repository execute under an in-repo name.
 */
export function bindSource(root, paths, listingSpecs = []) {
  const realRoot = realpathSync(root);
  const listings = listingSpecs.map((spec) => ({ ...spec, members: enumerate(root, spec) }));
  const bound = new Set(paths);
  for (const listing of listings) {
    bound.add(listing.dir);
    for (const member of listing.members) bound.add(member);
  }
  for (const relative of bound) {
    const point = linkPoint(realRoot, root, relative);
    if (point !== null) {
      const where = point === relative ? "resolves" : `${point} resolves`;
      throw new Error(
        `cannot bind ${relative}: ${where} to ${physicalName(realRoot, root, point)} — a bound name must be its own physical path`,
      );
    }
    if (physicalName(realRoot, root, relative) === null) {
      throw new Error(`cannot bind ${relative}: resolves to nothing — a bound name must be a file that exists`);
    }
  }
  const files = [...new Set(paths)].sort().map((relative) => ({
    path: relative,
    sha256: sha256(readFileSync(path.join(root, relative))),
  }));
  return { files, listings, digest: digestOf(files, listings) };
}

/**
 * The bound set recomputed on this tree: one line per member that drifted or
 * went missing, one per listing member added, removed, or a listing whose
 * directory is gone, and one more if the recorded digest does not recompute
 * over the recorded members. An empty list means the report was produced here.
 */
export function sourceDrift(root, source) {
  const drift = [];
  let realRoot = null;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = null;
  }
  const files = source?.files ?? [];
  const listings = source?.listings ?? [];
  // A bound name that resolves elsewhere is a different input, whatever its
  // bytes. Each violation reports the shallowest linked component once —
  // a linked directory covers the names under it.
  const points = new Map();
  const underPoint = (relative) =>
    [...points.keys()].some((point) => relative.startsWith(`${point}/`));
  if (realRoot !== null) {
    const bound = new Set(files.map((file) => file.path));
    for (const listing of listings) {
      bound.add(listing.dir);
      for (const member of listing.members ?? []) bound.add(member);
    }
    for (const relative of bound) {
      if (underPoint(relative)) continue;
      const point = linkPoint(realRoot, root, relative);
      if (point !== null && !points.has(point)) {
        points.set(point, physicalName(realRoot, root, point));
      }
    }
    for (const [point, resolved] of [...points.entries()].sort()) {
      drift.push(`${point}: bound name resolves to ${resolved} — a bound name must be its own physical path`);
    }
  }
  for (const file of files) {
    if (points.has(file.path) || underPoint(file.path)) continue;
    let actual = null;
    try {
      actual = sha256(readFileSync(path.join(root, file.path)));
    } catch {
      actual = null;
    }
    if (actual !== file.sha256) {
      drift.push(`${file.path}: report binds ${file.sha256}, this tree has ${actual ?? "no file"}`);
    }
  }
  if (source && !Array.isArray(source.listings)) {
    drift.push("the report records no directory listings — an added input would go unnoticed");
  }
  for (const listing of listings) {
    if (points.has(listing.dir)) continue;
    let members = null;
    try {
      members = enumerate(root, listing);
    } catch {
      members = null;
    }
    if (members === null) {
      drift.push(`${listing.dir}: the report lists this directory's members, this tree has no such directory`);
      continue;
    }
    const recorded = new Set(listing.members ?? []);
    for (const member of members.filter((name) => !recorded.has(name))) {
      drift.push(`${member}: an input the report's run did not have — the listing of ${listing.dir} gains a member`);
    }
    for (const member of (listing.members ?? []).filter((name) => !members.includes(name) && !underPoint(name))) {
      drift.push(`${member}: the report lists it under ${listing.dir}, this tree does not`);
    }
  }
  const recomputed = digestOf(source?.files ?? [], source?.listings ?? []);
  if (source?.digest !== recomputed) {
    drift.push(`source digest does not recompute over the recorded members`);
  }
  return drift;
}
