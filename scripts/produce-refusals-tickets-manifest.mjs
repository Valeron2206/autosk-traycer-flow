/**
 * Producing cases for the tickets-manifest contract's closed set.
 *
 * All seven classes are park reasons the graph document carries on edges into
 * `human` or on a step's own `no_transition_reason`; the host module that turns
 * a taken edge into the recorded reason is the workflow factory. This module
 * is deliberately the only place the link is declared: naming the contract and
 * importing its emitter is what `measureContracts` scores, and the case data
 * stays in JSON so no source file claims classes whose predicate is the
 * daemon's judgment.
 */

import { readFileSync } from "node:fs";

import { buildWorkflow } from "../src/host/workflow-factory.mjs";

export const CONTRACT = "docs/contracts/tickets-manifest.md";

const CASES_PATH = "scripts/produce-refusals-tickets-manifest.cases.json";
const DOCUMENT_PATH = "resources/workflow-graph/workflow-graph.v1.json";

export const cases = JSON.parse(
  readFileSync(new URL(`../${CASES_PATH}`, import.meta.url), "utf8"),
);

export const emitters = { buildWorkflow };

export const fixture = () => ({
  document: () =>
    JSON.parse(readFileSync(new URL(`../${DOCUMENT_PATH}`, import.meta.url), "utf8")),
});

// Every repo-relative path `fixture` opens — the report binds these bytes.
export const sources = () => [CASES_PATH, DOCUMENT_PATH];
