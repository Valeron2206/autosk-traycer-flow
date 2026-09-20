/**
 * Producing cases for the workflow-graph contract's closed set.
 *
 * Thirty-two prefixed classes are design-time: the validator refuses the
 * document, the strict parser refuses the text, and the canonical serializer
 * refuses a string with no UTF-8 spelling. The three unprefixed codes are the
 * graph's own park reasons and are produced at the factory's exported boundary,
 * which is the only place a schema-valid document cannot reach. This module
 * names only its own contract and imports only the modules that emit its
 * classes — the factory is linked because it genuinely emits them here.
 */

import { readFileSync } from "node:fs";

import { graphDigest } from "../src/host/workflow-graph-canonical.mjs";
import { admit, buildWorkflow, index, permitsResume } from "../src/host/workflow-factory.mjs";
import {
  DOCUMENT_PATH,
  SCHEMA_PATH,
  VOCABULARY_PATH,
  parseStrict,
  validateGraph,
} from "./validate-workflow-graph.mjs";

export const CONTRACT = "docs/contracts/workflow-graph.md";

const CASES_PATH = "scripts/produce-refusals-workflow-graph.cases.json";

export const cases = JSON.parse(
  readFileSync(new URL(`../${CASES_PATH}`, import.meta.url), "utf8"),
);

export const emitters = { graphDigest, buildWorkflow, index, admit, permitsResume, parseStrict, validateGraph };

export const fixture = () => ({
  document: () => parseStrict(readFileSync(new URL(`../${DOCUMENT_PATH}`, import.meta.url), "utf8")),
  schema: JSON.parse(readFileSync(new URL(`../${SCHEMA_PATH}`, import.meta.url), "utf8")),
});

// Every repo-relative path `fixture` and the validator open — `parkReasons`
// reads the vocabulary inside `validateGraph`.
export const sources = () => [CASES_PATH, DOCUMENT_PATH, SCHEMA_PATH, VOCABULARY_PATH];
