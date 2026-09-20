/**
 * The manifests `npm run produce:refusals` drives — the single list.
 *
 * The runner iterates this array and nothing else, and the vocabulary's
 * producer check reads the same array's `cases` for the set of measured
 * classes. A manifest that exists on disk but is not listed here drives
 * nothing and measures nothing — the executed set is this file, not a
 * filename pattern.
 *
 * Each entry's `cases` are loaded here, from the manifest's own declared
 * `CASES_PATH` — the declaration and the read are one value, so a manifest
 * cannot name one file while another file's bytes drive its cases.
 *
 * The list is built on first call, not at this module's own evaluation:
 * the vocabulary manifest imports the validator, which imports this list,
 * so reaching this module through that manifest finds its exports still
 * uninitialized. Building lazily keeps the entry-point order irrelevant.
 */

import { readFileSync } from "node:fs";

import * as ticketsManifest from "./produce-refusals-tickets-manifest.mjs";
import * as workflowGraph from "./produce-refusals-workflow-graph.mjs";
import * as identityLock from "./produce-refusals-runtime-identity-lock.mjs";
import * as refusalVocabulary from "./produce-refusals-refusal-vocabulary.mjs";

/** The one read of a manifest's case data — the declared path is the path read. */
export const loadCases = (casesPath) =>
  JSON.parse(readFileSync(new URL(`../${casesPath}`, import.meta.url), "utf8"));

const withCases = (manifest) =>
  Object.freeze({ ...manifest, cases: loadCases(manifest.CASES_PATH) });

let built = null;

/**
 * The executed manifests, each wrapped with the cases loaded from its
 * declared `CASES_PATH`. Built once, on first call — after every module's
 * exports have settled — then frozen and shared.
 */
export function executedManifests() {
  if (built === null) {
    built = Object.freeze(
      [ticketsManifest, workflowGraph, identityLock, refusalVocabulary].map(withCases),
    );
  }
  return built;
}

/**
 * The files a case records as emitting its class — the file halves of the
 * `file#symbol` declarations in `emitter` and `also`.
 *
 * Returns null when the record cannot say who emitted: `emitter` missing or
 * not exactly one `file#symbol` with both halves non-empty, or `also`
 * present and malformed. Whether a case was driven is a separate question,
 * answered by `manifest.cases` — a driven case whose record is malformed is
 * a broken manifest, not a class that quietly drops out of the measured set.
 */
export function caseEmitterFiles(caseDecl) {
  const files = new Set();
  for (const key of ["emitter", "also"]) {
    const value = caseDecl[key];
    if (value === undefined) {
      if (key === "emitter") return null;
      continue;
    }
    const parts = typeof value === "string" ? value.split("#") : [];
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return null;
    files.add(parts[0]);
  }
  return files;
}

/**
 * The boundary between the executed list and the producing namespace on
 * disk — every `produce-refusals-*.cases.json` file is case data a manifest
 * in `MANIFESTS` must declare, and every declared `CASES_PATH` must be one
 * of those files, exactly once.
 *
 * `manifests` are the executed entries, `namespaceFiles` the repo-relative
 * members of the namespace as the caller enumerated them. Returns the three
 * leaks: `undriven` files no manifest declares, `missing` declarations no
 * namespace file matches, and `duplicate` paths declared more than once.
 * An empty result means the list and the namespace are the same set.
 */
export function casesClosureErrors(manifests, namespaceFiles) {
  const onDisk = new Set(namespaceFiles);
  const seen = new Set();
  const duplicate = new Set();
  for (const manifest of manifests) {
    if (seen.has(manifest.CASES_PATH)) duplicate.add(manifest.CASES_PATH);
    seen.add(manifest.CASES_PATH);
  }
  return {
    undriven: namespaceFiles.filter((file) => !seen.has(file)).sort(),
    missing: [...seen].filter((path) => !onDisk.has(path)).sort(),
    duplicate: [...duplicate].sort(),
  };
}
