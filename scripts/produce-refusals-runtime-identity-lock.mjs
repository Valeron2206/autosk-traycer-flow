/**
 * Producing cases for the runtime-identity-lock contract's closed set.
 *
 * Every one of the nine classes is emitted by the contract's own validator —
 * a script, not a host module — so this manifest imports nothing under
 * `src/host` and the contract's row keeps "no link measured" while gaining the
 * produced column.
 */

import { readFileSync } from "node:fs";

import {
  LOCK_PATH,
  MANIFEST_PATH,
  PATCH_ROOT,
  SCHEMA_PATH,
  loadFiles,
  lockDigest,
  patchReader,
  validateDesign,
  validateLock,
} from "./validate-runtime-identity-lock.mjs";

export const CONTRACT = "docs/contracts/runtime-identity-lock.md";

export const CASES_PATH = "scripts/produce-refusals-runtime-identity-lock.cases.json";

export const emitters = {
  LOCK_PATH,
  MANIFEST_PATH,
  lockDigest,
  validateDesign,
  validateLock,
};

export const fixture = () => ({
  files: loadFiles(),
  schema: JSON.parse(loadFiles()[SCHEMA_PATH]),
  readPatch: patchReader(),
});

// Every repo-relative path `fixture` and the validator open: the five load
// files plus each patch the compat manifest's patch list names — drives may
// override a patch's bytes, but the shipped bytes are what `readPatch` reads.
export const sources = () => {
  const files = loadFiles();
  const patches = JSON.parse(files[MANIFEST_PATH]).patches.map(
    (entry) => `${PATCH_ROOT}/${entry.file}`,
  );
  return [CASES_PATH, ...Object.keys(files), ...patches];
};
