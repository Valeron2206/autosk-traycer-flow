#!/usr/bin/env node

/**
 * Classifies the files a changeset touches, and refuses when one of them is
 * governed by nothing.
 *
 * "An artifact with no lifecycle does not skip its gate — it never had one."
 * This is where that stops being a sentence: a path no class covers parks the
 * changeset, and the remedy is one registry entry rather than a judgement call
 * about which review it probably needed. Every park is the same stop, the
 * workflow graph's `artifact_mapping_required`; the remedy follows its cause
 * (debt 12d, R8-6).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PARK_CAUSES, classifyChangeset } from "../src/host/artifact-classifier.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REGISTRY_PATH = "resources/artifact-registry/artifact-registry.v1.json";

export function loadRegistry() {
  return JSON.parse(readFileSync(path.join(ROOT, REGISTRY_PATH), "utf8"));
}

/** The paths a changeset touches. With no base, every tracked file. */
export function changedPaths(base) {
  const args = base ? ["diff", "--name-only", `${base}...HEAD`] : ["ls-files"];
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * What a parked path needs, by why it parked. No class governs it
 * (`unknown_class`): a registry entry. Classes of two categories claim it
 * (`ambiguous_class`): patterns narrowed until one class owns it. Its class is
 * one v1 does not govern (`class_not_v1`, debt 11g): the issue that owns the
 * class, not an entry — the class is registered already; and when that issue
 * is outside matrix v1 (#47), a successor matrix first. Its class does not say
 * whether v1 governs it: that lifecycle, in the registry. Review of 11g (L1,
 * L4): the last two were told the first's remedy.
 */
export const REMEDIES = Object.freeze({
  unregistered: "are governed by no class; add a registry entry rather than guessing the review.",
  ambiguous: "are claimed by classes of different categories; narrow the patterns so that one class owns each path.",
  later: "belong to a class v1 does not govern; the issue that owns the class activates it, not a registry entry.",
  successor: "belong to a class that waits for a successor matrix; v1 governs it only once a successor matrix classifies its issue.",
  unmarked: "belong to a class that does not say whether v1 governs it; give the class its lifecycle in the registry.",
});

/**
 * Which of `REMEDIES` a parked path needs: its cause's, and for a class v1
 * does not govern, its lifecycle's. The cause is read, not inferred from which
 * fields the result carries (debt 12d).
 */
export function parkKind(result) {
  if (result.cause === "unknown_class") return "unregistered";
  if (result.cause === "ambiguous_class") return "ambiguous";
  if (result.cause !== "class_not_v1") {
    throw new Error(`park cause ${JSON.stringify(result.cause)} of ${result.path} is none of ${PARK_CAUSES.join(", ")}, so no remedy is known for it`);
  }
  if (result.lifecycle === null) return "unmarked";
  return result.lifecycle === "successor_matrix_candidate" ? "successor" : "later";
}

/**
 * The changeset as a reviewer reads it: one line per path, then the review,
 * the approval and the closure it costs, and one remedy line for each kind of
 * parked path. A parked path names the stop and its cause; one whose class v1
 * does not govern is named with the class's lifecycle and the issue that owns
 * it.
 */
export function render(outcome) {
  const lines = [];
  for (const result of outcome.results) {
    if (result.status === "classified") {
      lines.push(`  ${result.category.padEnd(20)} ${result.class.padEnd(24)} ${result.path}`);
    } else if (result.status === "parked") {
      const kind = parkKind(result);
      let lifecycle = "";
      if (kind === "later" || kind === "successor") lifecycle = ` (${result.lifecycle}, ${result.decided_by})`;
      else if (kind === "unmarked") lifecycle = " (no lifecycle)";
      lines.push(`  PARKED ${result.park_reason} ${`(${result.cause})`.padEnd(17)} ${`${result.candidates.join(",")}${lifecycle}`.padEnd(24)} ${result.path}`);
    }
  }
  lines.push(`review: ${outcome.review_mode}   human approval: ${outcome.human_approval}`);
  lines.push(`impacted classes: ${outcome.impacted_classes.join(" ") || "(none)"}`);
  for (const [kind, remedy] of Object.entries(REMEDIES)) {
    const count = outcome.parked.filter((result) => parkKind(result) === kind).length;
    if (count > 0) lines.push(`${count} path(s) ${remedy}`);
  }
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = process.argv[2] ?? "";
  const outcome = classifyChangeset(loadRegistry(), changedPaths(base));
  console.log(render(outcome));
  process.exitCode = outcome.admits ? 0 : 1;
}
