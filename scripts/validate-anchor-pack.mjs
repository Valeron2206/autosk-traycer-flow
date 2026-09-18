#!/usr/bin/env node

/**
 * Design-time validator for the ticket 15 anchor pack slot.
 *
 * Before the slot, a panel round record named an `anchor_version` and a
 * `scope_identity`, and neither named the pack's bytes: `scope_identity` is the
 * digest of a snapshot `identity.rows` listing absolute paths on the dispatch
 * machine, a file that never existed in this repository. The slot is the named
 * carrier: every member's path, digest, size and provenance, plus a
 * `pack_digest` that recomputes over the declared canonical form.
 *
 * The checks are the contract's refusal classes. Members whose `source` is
 * byte-verifiable (`repo_file`, `doc_sections`) are rebuilt from the slot's
 * `frozen_commit` through `git cat-file`; a member that cannot be checked is a
 * refusal, not a pass. The set-level check refuses two packs claiming one
 * `anchor_version` with different member bytes. The round-record check binds
 * the slot to the record that froze the dispatch.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bundleDigest } from "./validate-governance-bundle.mjs";
import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/anchor-pack.md";
export const SCHEMA_PATH = "resources/anchor-pack/anchor-pack.schema.json";
export const SLOT_PATH = "resources/anchor-pack/anchor-pack.v1.json";
export const REFUSED_PATH = "resources/anchor-pack/anchor-pack.refused.example.json";
export const CONTRACT_MARKER = "<!-- anchor-pack-contract:v1 -->";

export const REFUSAL_CLASSES = Object.freeze([
  "anchor_pack_digest_stale",
  "anchor_pack_member_duplicated",
  "anchor_pack_source_malformed",
  "anchor_pack_source_unfrozen",
  "anchor_pack_source_unverifiable",
  "anchor_pack_source_drifted",
  "anchor_pack_conflict",
  "anchor_pack_round_unbound",
]);

/** Which fields a `source` of each kind must carry, and may carry. */
export const SOURCE_FIELDS = Object.freeze({
  authored: { required: [], allowed: [] },
  built: { required: ["builder"], allowed: ["builder"] },
  doc_sections: {
    required: ["commit", "path", "from_heading", "until_heading"],
    allowed: ["commit", "path", "from_heading", "until_heading"],
  },
  repo_file: { required: ["commit", "path"], allowed: ["commit", "path"] },
});

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The aggregate is the governance-bundle rule: `path\0sha256\n`, byte order. */
export function packDigest(members) {
  return bundleDigest(members);
}

/**
 * The `doc_sections` member rule: the document text from the first line that
 * starts with `from_heading` up to the first later line that starts with
 * `until_heading`, with the trailing newline run collapsed to one. Returns null
 * when either boundary is absent.
 */
export function docSection(text, fromHeading, untilHeading) {
  const lines = text.split("\n");
  const from = lines.findIndex((line) => line.startsWith(fromHeading));
  if (from < 0) return null;
  const until = lines.findIndex((line, index) => index > from && line.startsWith(untilHeading));
  if (until < 0) return null;
  return `${lines.slice(from, until).join("\n")}\n`.replace(/\n+$/, "\n");
}

/** Fields a `source` may carry are exactly the fields its kind requires. */
export function sourceShapeErrors(source) {
  const shape = SOURCE_FIELDS[source?.kind];
  if (!shape) return [`anchor_pack_source_malformed: unknown source kind ${JSON.stringify(source?.kind)}`];
  const errors = [];
  for (const field of shape.required) {
    if (source[field] === undefined) {
      errors.push(`anchor_pack_source_malformed: ${source.kind} requires ${field}`);
    }
  }
  for (const field of Object.keys(source)) {
    if (field !== "kind" && !shape.allowed.includes(field)) {
      errors.push(`anchor_pack_source_malformed: ${source.kind} may not carry ${field}`);
    }
  }
  return errors;
}

/**
 * Rebuild a member's bytes from its declared source. `ctx.catBlob(commit,
 * path)` returns the blob bytes or null; `ctx.repoFileExists(path)` answers the
 * `built` check. Returns null for members with no byte-verifiable source and
 * for sources that cannot be read.
 */
export function memberSourceBytes(member, ctx = {}) {
  const source = member.source;
  if (source.kind === "repo_file") {
    return typeof ctx.catBlob === "function" ? ctx.catBlob(source.commit, source.path) : null;
  }
  if (source.kind === "doc_sections") {
    const bytes = typeof ctx.catBlob === "function" ? ctx.catBlob(source.commit, source.path) : null;
    if (bytes === null) return null;
    const section = docSection(bytes.toString("utf8"), source.from_heading, source.until_heading);
    return section === null ? null : Buffer.from(section, "utf8");
  }
  return null;
}

/** The member set as a comparable signature: the bytes claim, nothing else. */
function memberSignature(pack) {
  return pack.members
    .map((member) => `${member.path}\x00${member.sha256}`)
    .sort()
    .join("\n");
}

/**
 * One `anchor_version`, one byte set. `packs` is a list of
 * `{ label, pack }`; two entries sharing an `anchor_version` must carry an
 * identical member set or the version names nothing.
 */
export function conflictErrors(packs) {
  const errors = [];
  const byVersion = new Map();
  for (const entry of packs) {
    const group = byVersion.get(entry.pack.anchor_version) ?? [];
    group.push(entry);
    byVersion.set(entry.pack.anchor_version, group);
  }
  for (const [version, group] of [...byVersion.entries()].sort((a, b) => a[0] - b[0])) {
    const signature = memberSignature(group[0].pack);
    for (const entry of group.slice(1)) {
      if (memberSignature(entry.pack) !== signature) {
        errors.push(
          `anchor_pack_conflict: anchor_version ${version} is claimed by ${group[0].label} and ` +
            `${entry.label} with different member bytes`,
        );
      }
    }
  }
  return errors;
}

/** A slot no record references is a claim about nothing. */
export function roundBindingErrors(pack, record, slotPath = SLOT_PATH) {
  const errors = [];
  if (record.anchor_pack_slot !== slotPath) {
    errors.push(
      `anchor_pack_round_unbound: anchor_pack_slot is ${JSON.stringify(record.anchor_pack_slot)}, not ${slotPath}`,
    );
  }
  if (record.anchor_pack_sha256 !== pack.pack_digest) {
    errors.push(
      `anchor_pack_round_unbound: anchor_pack_sha256 is ${JSON.stringify(record.anchor_pack_sha256)}, ` +
        `not the slot's pack_digest`,
    );
  }
  for (const field of ["anchor_version", "round", "attempt", "frozen_commit", "scope_identity", "candidate_digest"]) {
    if (record[field] !== pack[field]) {
      errors.push(
        `anchor_pack_round_unbound: ${field} is ${JSON.stringify(record[field])}, ` +
          `the slot records ${JSON.stringify(pack[field])}`,
      );
    }
  }
  // package_sha256 is the only pin on the package member's bytes — they cannot
  // be rebuilt — so the record's value must be the member's declared digest.
  const packageMember = pack.members.find((member) => member.path === "pack/panel-package.md");
  if (!packageMember) {
    errors.push("anchor_pack_round_unbound: the slot has no pack/panel-package.md member for package_sha256 to bind");
  } else if (record.package_sha256 !== packageMember.sha256) {
    errors.push(
      `anchor_pack_round_unbound: package_sha256 is ${JSON.stringify(record.package_sha256)}, ` +
        `the slot's pack/panel-package.md member carries ${packageMember.sha256}`,
    );
  }
  return errors;
}

export function validatePack(pack, schema, ctx = {}) {
  const errors = validateJsonSchema(pack, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const seen = new Set();
  for (const member of pack.members) {
    if (seen.has(member.path)) {
      errors.push(`anchor_pack_member_duplicated: ${member.path} is listed twice`);
    }
    seen.add(member.path);
    errors.push(...sourceShapeErrors(member.source).map((m) => `${member.path}: ${m}`));
  }

  // Members must be written in raw-byte path order, or the slot's own bytes are
  // not canonical and a diff shows a reshuffle rather than a real change.
  const written = pack.members.map((member) => member.path);
  const ordered = [...written].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  if (written.join("") !== ordered.join("")) {
    errors.push("members must be listed in raw-byte path order");
  }

  for (const member of pack.members) {
    const source = member.source;
    if (sourceShapeErrors(source).length > 0) continue;
    if (source.kind === "built") {
      if (typeof ctx.repoFileExists !== "function" || !ctx.repoFileExists(source.builder)) {
        errors.push(`${member.path}: anchor_pack_source_unverifiable: builder ${source.builder} is absent`);
      }
      continue;
    }
    if (source.kind !== "repo_file" && source.kind !== "doc_sections") continue;
    // A member sourced from a real commit that is not the one the panel froze
    // is a pack bound to bytes it was never reviewed against — the violation is
    // the commit, so it is refused here rather than as drift.
    if (source.commit !== pack.frozen_commit) {
      errors.push(
        `${member.path}: anchor_pack_source_unfrozen: source commit ${source.commit} ` +
          `is not the pack's frozen_commit ${pack.frozen_commit}`,
      );
      continue;
    }
    const bytes = memberSourceBytes(member, ctx);
    if (bytes === null) {
      errors.push(
        `${member.path}: anchor_pack_source_unverifiable: ${source.kind} source ` +
          `${source.path} at ${source.commit} could not be read`,
      );
      continue;
    }
    if (sha256(bytes) !== member.sha256 || bytes.length !== member.size) {
      errors.push(
        `${member.path}: anchor_pack_source_drifted: ${source.kind} source ` +
          `${source.path} at ${source.commit} rebuilds to sha256 ${sha256(bytes)}, size ${bytes.length}`,
      );
    }
  }

  const recomputed = packDigest(pack.members);
  if (pack.pack_digest !== recomputed) {
    errors.push(
      `anchor_pack_digest_stale: recorded ${pack.pack_digest}, computed ${recomputed}`,
    );
  }
  return errors;
}

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, SLOT_PATH, REFUSED_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  try {
    const slot = JSON.parse(files[SLOT_PATH]);
    const roundPath = `resources/design-candidate/panel/round-${slot.round}.json`;
    files[roundPath] = readFileSync(path.join(ROOT, roundPath), "utf8");
  } catch {
    // A slot that does not parse is already an error; the round record check
    // reports it rather than masking it behind a load failure.
  }
  return files;
}

export function validateAnchorPackDesign(files, ctx = {}) {
  const errors = [];
  const contract = files[CONTRACT_PATH] ?? "";
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SLOT_PATH)) errors.push(`${CONTRACT_PATH}: does not name ${SLOT_PATH}`);
  for (const refusal of REFUSAL_CLASSES) {
    if (!contract.includes(refusal)) errors.push(`${CONTRACT_PATH}: refusal class ${refusal} is not documented`);
  }

  let schema;
  try {
    schema = JSON.parse(files[SCHEMA_PATH]);
  } catch (error) {
    return [...errors, `${SCHEMA_PATH}: not valid JSON: ${error.message}`];
  }
  if (schema.additionalProperties !== false) {
    errors.push(`${SCHEMA_PATH}: root must be closed (additionalProperties:false)`);
  }

  let slot;
  try {
    slot = JSON.parse(files[SLOT_PATH]);
  } catch (error) {
    return [...errors, `${SLOT_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...validatePack(slot, schema, ctx).map((message) => `${SLOT_PATH}: ${message}`));

  let refused;
  try {
    refused = JSON.parse(files[REFUSED_PATH]);
  } catch (error) {
    return [...errors, `${REFUSED_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...validatePack(refused, schema, ctx).map((message) => `${REFUSED_PATH}: ${message}`));
  if (refused.anchor_version === slot.anchor_version) {
    // The refused example exists to prove the conflict refusal fires: a second
    // claim of the same anchor_version with different bytes must be refused.
    const conflicts = conflictErrors([
      { label: SLOT_PATH, pack: slot },
      { label: REFUSED_PATH, pack: refused },
    ]);
    if (conflicts.length === 0) {
      errors.push(
        `${REFUSED_PATH}: claims anchor_version ${slot.anchor_version} with identical members, ` +
          "so it is not refused",
      );
    }
  }

  const roundPath = `resources/design-candidate/panel/round-${slot.round}.json`;
  let record;
  try {
    record = JSON.parse(files[roundPath]);
  } catch {
    errors.push(`${roundPath}: not readable, so the slot's binding cannot be checked`);
  }
  if (record) {
    if (record.round !== slot.round) {
      errors.push(`${roundPath}: record's round ${record.round} is not the slot's round ${slot.round}`);
    }
    errors.push(...roundBindingErrors(slot, record).map((message) => `${roundPath}: ${message}`));
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const catBlob = (commit, relative) => {
    try {
      return execFileSync("git", ["cat-file", "blob", `${commit}:${relative}`], { cwd: ROOT });
    } catch {
      return null;
    }
  };
  const ctx = { catBlob, repoFileExists: (relative) => existsSync(path.join(ROOT, relative)) };
  const files = loadFiles();
  const errors = validateAnchorPackDesign(files, ctx);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const slot = JSON.parse(files[SLOT_PATH]);
    console.log("Anchor pack design validation PASS");
    console.log(`pack_digest=${slot.pack_digest}`);
    console.log(`anchor_version=${slot.anchor_version}`);
    console.log(`members=${slot.members.length}`);
  }
}
