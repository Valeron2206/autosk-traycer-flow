/**
 * Producing cases for the refusal-vocabulary contract's closed set.
 *
 * All ten classes are emitted by the contract's own validator — a script, not
 * a host module — so this manifest imports nothing under `src/host` and the
 * contract's row keeps "no link measured" while gaining the produced column.
 */

import { readFileSync } from "node:fs";

import {
  FLOWS_PATH,
  GRAPH_PATH,
  PLAN_PATH,
  ROOT,
  VOCABULARY_PATH,
  readContracts,
  readSources,
  vocabularyDigest,
  vocabularyErrors,
} from "./validate-refusal-vocabulary.mjs";

export const CONTRACT = "docs/contracts/refusal-vocabulary.md";

const CASES_PATH = "scripts/produce-refusals-refusal-vocabulary.cases.json";

export const cases = JSON.parse(
  readFileSync(new URL(`../${CASES_PATH}`, import.meta.url), "utf8"),
);

export const emitters = { vocabularyDigest, vocabularyErrors };

export const fixture = () => {
  const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
  return {
    vocabulary: JSON.parse(read(VOCABULARY_PATH)),
    context: {
      plan: read(PLAN_PATH),
      graph: JSON.parse(read(GRAPH_PATH)),
      flows: read(FLOWS_PATH),
      sources: readSources(ROOT),
      contracts: readContracts(ROOT),
    },
  };
};

// Every repo-relative path `fixture` opens — the same scans the validator
// performs, enumerated by its own readers so the set cannot drift from them.
export const sources = () => [
  CASES_PATH,
  VOCABULARY_PATH,
  PLAN_PATH,
  GRAPH_PATH,
  FLOWS_PATH,
  ...Object.keys(readSources(ROOT)),
  ...Object.keys(readContracts(ROOT)).map((name) => `docs/contracts/${name}`),
];

// The directory enumerations those readers perform — `readSources` walks
// `src` and `scripts` recursively for `.mjs`, `readContracts` lists
// `docs/contracts` for `.md`. Recorded in the report so a member added after
// the run refuses the column; `measureContracts`'s flat scans of `scripts`,
// `src/host` and `docs/contracts` are subsets of these, so nothing they could
// observe escapes the record.
export const listings = () => [
  { dir: "src", suffix: ".mjs", deep: true },
  { dir: "scripts", suffix: ".mjs", deep: true },
  { dir: "docs/contracts", suffix: ".md", deep: false },
];
