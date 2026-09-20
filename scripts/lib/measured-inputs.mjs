/**
 * Shared rules for the runtime design-input measurement.
 *
 * The runner (`scripts/measure-design-inputs.mjs`) records what the
 * validators actually opened; this module reduces that record to the member
 * set and owns the artifact's digest so the runner and the candidate
 * validator compute it identically.
 *
 * Declared blind spots of a run-time measurement — it sees what happened,
 * not what could:
 *
 * - a read on a branch the shipped data does not take is not observed, and
 *   it cannot move today's verdict either;
 * - code the validators do not execute is not observed;
 * - module imports are not recorded — they are code;
 * - reads performed by spawned non-node processes (`git cat-file` and
 *   friends) are not observed — for the anchor pack those bytes carry their
 *   own digests;
 * - internal surfaces outside the public `node:fs` surface —
 *   `process.binding("fs").readFileUtf8` and friends — are not classified
 *   (the declared boundary covers module exports only);
 * - the runner spawns each `validate:*` with the arguments package.json
 *   declares; CI additionally passes the pull request's base SHA to
 *   `validate:scope`, so the measured run uses its default `origin/main`.
 *   That reader records no non-code inputs either way on the shipped code,
 *   so the difference moves no member today — declared, not parity.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const MEASURED_PATH = "resources/design-candidate/measured-inputs.v1.json";
export const CANDIDATE_PATH = "resources/design-candidate/design-candidate.v1.json";

/**
 * Code by extension only — never by directory. `.patch` is code: a compat
 * patch's bytes are pinned by the autosk manifest, so a changed patch fails
 * the lock validator before membership is asked, and a manifest edit moves
 * `candidate_digest` because the manifest is a member (stated in
 * docs/contracts/runtime-identity-lock.md).
 */
export function isCodePath(relative) {
  return /\.(?:[cm]?[jt]s|[jt]sx|patch)$/u.test(relative);
}

/** One recorded path → repo-relative form, or null outside the repository. */
export function toRepoRelative(recorded, root) {
  const absolute = path.isAbsolute(recorded) ? path.normalize(recorded) : path.resolve(root, recorded);
  const relative = path.relative(root, absolute);
  // Outside means a real parent component: `..` itself or `..` before a
  // separator. A name like `..input.json` inside the root is a file, not
  // a parent reference, and stays inside.
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative.split(path.sep).join("/");
}

/** Every raw path recorded in a log directory, one `<pid>.log` per process. */
export function collectRecordedPaths(logDir, fsx = { readdirSync, readFileSync }) {
  const paths = new Set();
  for (const name of fsx.readdirSync(logDir)) {
    for (const line of fsx.readFileSync(path.join(logDir, name), "utf8").split("\n")) {
      if (line !== "") paths.add(line);
    }
  }
  return paths;
}

/**
 * The recorded set → sorted repo-relative member candidates.
 *
 * A record is written only when the operation has happened, and it says
 * what the API did. `file\t<physical>` is a proven file read: inside the
 * repository it must still be a file that can be pinned — gone,
 * unreadable, or replaced by a directory refuses the measurement by name
 * rather than dropping a proven read. `dir\t<physical>` is a proven
 * directory listing; directories are not members — the files a reader
 * opens beneath them are recorded by name. A physical name outside the
 * repository is ignored either way, and the candidate is never its own
 * member.
 *
 * `copy\t<call>\t<done>\t<call site>` is a copy attempt — written when
 * the operation settles, success or failure, because a copy that threw
 * can already have copied part of its source. Copies read bytes the
 * measurement does not model, so it refuses when either resolution
 * could be inside the repository or the two differ, and ignores a
 * source outside at both observations. `conflict\t<call>\t<done>`
 * means the name moved while the operation was in flight — `?` prefixes
 * a name that did not resolve; if either side could be inside the
 * repository the measurement refuses, naming both. `other\t<physical>`
 * is a proven open of something that is neither file nor directory —
 * inside the repository it cannot be pinned and refuses. A bare line
 * is a file read in the oldest log shape and is classified the same way.
 */
export function reduceToInputs(recordedPaths, root, fsx = { statSync }) {
  const inputs = new Set();
  const possiblyInside = (desc) =>
    toRepoRelative(desc.startsWith("?") ? desc.slice(1) : desc, root) !== null;
  for (const line of recordedPaths) {
    const mark = line.indexOf("\t");
    const kind = mark === -1 ? "file" : line.slice(0, mark);
    const body = mark === -1 ? line : line.slice(mark + 1);
    if (kind === "copy") {
      const parts = body.split("\t");
      const call = parts[0] ?? "";
      const done = parts.length > 2 ? parts[1] : call;
      const site = parts.length > 2 ? parts.slice(2).join("\t") : (parts[1] ?? "unknown call site");
      if (possiblyInside(call) || possiblyInside(done) || call !== done) {
        throw new Error(`a copy whose source cannot be proven outside the repository: ${call} -> ${done} (${site})`);
      }
      continue; // a copy whose source stayed outside at both observations is ignored
    }
    if (kind === "other") {
      const relative = toRepoRelative(body, root);
      if (relative !== null) {
        throw new Error(`a measured open produced neither a file nor a directory — it cannot be pinned: ${relative}`);
      }
      continue;
    }
    if (kind === "dir") continue; // a listing is proven; directories are not members
    if (kind === "conflict") {
      const sep = body.indexOf("\t");
      const call = sep === -1 ? body : body.slice(0, sep);
      const done = sep === -1 ? "" : body.slice(sep + 1);
      if (possiblyInside(call) || possiblyInside(done)) {
        throw new Error(`a read whose name moved during the operation cannot be pinned: ${call} -> ${done}`);
      }
      continue; // both sides are physically outside the repository
    }
    const relative = toRepoRelative(body, root);
    if (relative === null) continue; // physically outside the repository
    if (relative === CANDIDATE_PATH || isCodePath(relative)) continue;
    let stat;
    try {
      stat = fsx.statSync(path.join(root, relative));
    } catch {
      throw new Error(`a measured read cannot be pinned — the path is gone or unreadable: ${relative}`);
    }
    if (!stat.isFile()) {
      throw new Error(`a measured file read cannot be pinned — the path is no longer a file: ${relative}`);
    }
    inputs.add(relative);
  }
  return [...inputs].sort();
}

/**
 * The artifact's digest binds the readers that ran and the inputs they were
 * observed to read, in sorted order, and nothing else — no absolute paths,
 * no timestamps — so it recomputes identically on any machine.
 */
export function measuredDigest({ schema_version, readers, inputs }) {
  return createHash("sha256")
    .update(JSON.stringify({ schema_version, readers, inputs }), "utf8")
    .digest("hex");
}

/** What changed between a recorded artifact and a fresh measurement. */
export function diffArtifact(artifact, next) {
  const difference = (from, into) => from.filter((item) => !into.includes(item));
  return {
    readersAdded: difference(next.readers ?? [], artifact.readers ?? []),
    readersRemoved: difference(artifact.readers ?? [], next.readers ?? []),
    inputsAdded: difference(next.inputs, artifact.inputs ?? []),
    inputsRemoved: difference(artifact.inputs ?? [], next.inputs),
  };
}
