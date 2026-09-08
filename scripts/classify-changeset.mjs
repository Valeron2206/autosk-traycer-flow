#!/usr/bin/env node

/**
 * Classifies the files a changeset touches, and refuses when one of them is
 * governed by nothing.
 *
 * "An artifact with no lifecycle does not skip its gate — it never had one."
 * This is where that stops being a sentence: a path no class covers parks the
 * changeset, and the remedy is one registry entry rather than a judgement call
 * about which review it probably needed.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyChangeset } from "../src/host/artifact-classifier.mjs";

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

export function render(outcome) {
  const lines = [];
  for (const result of outcome.results) {
    if (result.status === "classified") {
      lines.push(`  ${result.category.padEnd(20)} ${result.class.padEnd(24)} ${result.path}`);
    } else if (result.status === "parked") {
      lines.push(`  PARKED ${result.park_reason.padEnd(17)} ${result.candidates.join(",").padEnd(24)} ${result.path}`);
    }
  }
  lines.push(`review: ${outcome.review_mode}   human approval: ${outcome.human_approval}`);
  lines.push(`impacted classes: ${outcome.impacted_classes.join(" ") || "(none)"}`);
  if (!outcome.admits) {
    lines.push(`${outcome.parked.length} path(s) are governed by no class; add a registry entry rather than guessing the review.`);
  }
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = process.argv[2] ?? "";
  const outcome = classifyChangeset(loadRegistry(), changedPaths(base));
  console.log(render(outcome));
  process.exitCode = outcome.admits ? 0 : 1;
}
