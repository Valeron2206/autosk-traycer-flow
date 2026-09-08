#!/usr/bin/env node

/**
 * Design-time validator for the issue #8 approved delta.
 *
 * Full-tree equality reports the presence of approved work as a difference,
 * which is a false negative on exactly the case the DAG exists to support. The
 * reviewed unit is therefore a delta — and a delta is more than a patch, so
 * these checks are mostly about the ways two textually identical changes differ
 * in effect: a mode flip with no diff, a symlink that looks like a file, a
 * gitlink that is not content at all, a rename whose blob never changed.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/approved-delta.md";
export const SCHEMA_PATH = "resources/approved-delta/approved-delta.schema.json";
export const EXAMPLE_PATH = "resources/approved-delta/approved-delta.example.json";
export const CONTRACT_MARKER = "<!-- approved-delta-contract:v1 -->";

/** Recoverable phases, in order. "We do not know which" is what causes double application. */
export const PHASES = Object.freeze([
  "prepared",
  "revalidated",
  "applied",
  "committed",
  "ref_advanced",
  "verified",
]);

/** Closed park reasons of section 9. */
export const PARK_REASONS = Object.freeze([
  "delta_stale",
  "scope_violation",
  "untracked_collision",
  "ignored_collision",
  "foreign_ref_movement",
  "indeterminate_post_state",
  "reflog_ambiguous",
  "inherited_git_env",
  "dirty_worktree",
  "state_identity_collision",
  "unreviewed_bytes",
  "containment_mismatch",
]);

/** Git environment variables that silently redirect every command that follows. */
export const INHERITED_GIT_ENV = Object.freeze([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
]);

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The identity of section 3.
 *
 * Entries are sorted by path because a delta is a set of entries — the order
 * they were discovered in is not part of what was approved. Everything that
 * changes the EFFECT is inside: status, both blobs, both modes, the rename
 * source. Text alone is not identity, which is the whole point of the field
 * list, so a digest over text alone would defeat it.
 */
export function deltaDigest(delta) {
  const entries = delta.entries
    .map((entry) =>
      [
        entry.path,
        entry.status,
        entry.from_path ?? "",
        entry.old_blob ?? "",
        entry.new_blob ?? "",
        entry.old_mode ?? "",
        entry.new_mode ?? "",
      ].join(":"),
    )
    .sort();
  return sha256(
    [
      delta.base_commit_oid,
      delta.base_tree_oid,
      delta.candidate_tree_oid,
      [...delta.pathspec].sort().join(","),
      ...entries,
    ].join("\0"),
  );
}

export function approvedDeltaDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

/** Whether `candidate` is inside one of the declared pathspec prefixes. */
export function inScope(candidate, pathspec) {
  return pathspec.some((pattern) => {
    const prefix = pattern.endsWith("/**") ? pattern.slice(0, -2) : null;
    if (prefix !== null) return candidate.startsWith(prefix);
    return candidate === pattern;
  });
}

export function validateDelta(delta, schema) {
  const errors = validateJsonSchema(delta, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const seen = new Set();
  for (const entry of delta.entries) {
    const at = `${entry.status} ${entry.path}`;
    if (seen.has(entry.path)) errors.push(`${at}: the same path appears twice in one delta`);
    seen.add(entry.path);

    // Nothing may be approved outside the declared scope. An entry outside it
    // was reviewed as part of a different question.
    if (!inScope(entry.path, delta.pathspec)) {
      errors.push(`${at}: outside the declared pathspec (scope_violation)`);
    }

    // Each status implies exactly which sides of the entry must exist. A delete
    // with a new blob, or an add with an old one, describes something that did
    // not happen.
    const needsOld = entry.status !== "A";
    const needsNew = entry.status !== "D";
    if (needsOld && !entry.old_blob) errors.push(`${at}: status ${entry.status} requires old_blob`);
    if (needsNew && !entry.new_blob) errors.push(`${at}: status ${entry.status} requires new_blob`);
    if (!needsOld && entry.old_blob) errors.push(`${at}: an added path has no old_blob`);
    if (!needsNew && entry.new_blob) errors.push(`${at}: a deleted path has no new_blob`);
    if (needsNew && !entry.new_mode) errors.push(`${at}: status ${entry.status} requires new_mode`);

    if ((entry.status === "R" || entry.status === "C") && !entry.from_path) {
      errors.push(`${at}: a rename or copy must record the path it came from`);
    }
    if (entry.status !== "R" && entry.status !== "C" && entry.from_path) {
      errors.push(`${at}: only a rename or copy has a source path`);
    }
    if (entry.from_path && !inScope(entry.from_path, delta.pathspec)) {
      errors.push(`${at}: renamed from outside the declared pathspec (scope_violation)`);
    }

    // A modification that changes neither the blob nor the mode is not a
    // modification. Recording one would let an empty entry carry approval.
    if (entry.status === "M" && entry.old_blob === entry.new_blob && entry.old_mode === entry.new_mode) {
      errors.push(`${at}: modifies nothing — same blob and same mode`);
    }
  }

  // A result is recorded from the phase it exists in, and not before: a commit
  // OID present at `prepared` claims something that has not happened yet.
  const phaseIndex = PHASES.indexOf(delta.phase);
  const committed = phaseIndex >= PHASES.indexOf("committed");
  if (committed && (!delta.result_commit_oid || !delta.result_tree_oid)) {
    errors.push(`phase ${delta.phase} must record the result commit and tree it produced`);
  }
  if (!committed && (delta.result_commit_oid || delta.result_tree_oid)) {
    errors.push(`phase ${delta.phase} records a result that does not exist yet`);
  }

  const expected = deltaDigest(delta);
  if (delta.delta_digest !== expected) {
    errors.push(`delta_digest does not recompute: recorded ${delta.delta_digest}, computed ${expected}`);
  }
  return errors;
}

export function validateApprovedDeltaDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const reason of PARK_REASONS) {
    if (!contract.includes(reason)) errors.push(`${CONTRACT_PATH}: park reason ${reason} is not documented`);
  }
  // The three environment variables the issue names by hand must be named in the
  // contract too, or "neutralised" is a word with no list behind it.
  for (const variable of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
    if (!contract.includes(variable)) errors.push(`${CONTRACT_PATH}: does not name ${variable}`);
  }
  // Explicitly out of scope, and it stays out: cherry-pick as a hidden fallback
  // is how an unreviewed resolution gets in wearing a familiar name.
  if (!contract.includes("cherry-pick")) {
    errors.push(`${CONTRACT_PATH}: does not state that cherry-pick is not a fallback`);
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
  const phases = schema.properties?.phase?.enum ?? [];
  if (phases.join(",") !== PHASES.join(",")) {
    errors.push(`${SCHEMA_PATH}: phases must be exactly ${PHASES.join(", ")}`);
  }
  const modes = schema.properties?.entries?.items?.properties?.new_mode?.enum ?? [];
  for (const required of ["100644", "100755", "120000", "160000"]) {
    if (!modes.includes(required)) {
      errors.push(`${SCHEMA_PATH}: mode ${required} is not representable, so that case cannot be reviewed`);
    }
  }

  let example;
  try {
    example = JSON.parse(files[EXAMPLE_PATH]);
  } catch (error) {
    return [...errors, `${EXAMPLE_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...validateDelta(example, schema).map((message) => `${EXAMPLE_PATH}: ${message}`));

  // The example must actually exercise the cases text alone cannot express;
  // otherwise the field list is decoration.
  const statuses = new Set(example.entries.map((entry) => entry.status));
  for (const status of ["A", "M", "D", "R"]) {
    if (!statuses.has(status)) errors.push(`${EXAMPLE_PATH}: no ${status} entry, so that status is undemonstrated`);
  }
  const exercised = new Set(example.entries.flatMap((entry) => [entry.old_mode, entry.new_mode]));
  for (const mode of ["120000", "160000"]) {
    if (!exercised.has(mode)) {
      errors.push(`${EXAMPLE_PATH}: no entry with mode ${mode}, so that case is undemonstrated`);
    }
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateApprovedDeltaDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const example = JSON.parse(files[EXAMPLE_PATH]);
    console.log("Approved delta design validation PASS");
    console.log(`design_digest=${approvedDeltaDesignDigest(files)}`);
    console.log(`delta_digest=${example.delta_digest}`);
    console.log(`entries=${example.entries.length}`);
  }
}
