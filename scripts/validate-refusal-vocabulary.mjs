#!/usr/bin/env node

/**
 * The closed park vocabulary and its validator.
 *
 * The design says a workflow parks in `human` with a named reason and never
 * with a sentence. Until something enumerates those reasons and checks them,
 * that is a claim about prose: panel round 1 found the reachable park states
 * asserted in three documents with no schema and no validator behind them.
 *
 * This extracts the vocabulary from the one table that owns it — the resume
 * contract in `03-technical-plan.md` §7 — and then asks four questions of every
 * entry: does it park at a step somebody registered, does the class it names
 * exist, does the producer it claims exist, and does the checked-in resource
 * still say what the table says.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/refusal-vocabulary.md";
export const SCHEMA_PATH = "resources/refusal-vocabulary/refusal-vocabulary.schema.json";
export const VOCABULARY_PATH = "resources/refusal-vocabulary/refusal-vocabulary.v1.json";
export const REFUSED_PATH = "resources/refusal-vocabulary/refusal-vocabulary.refused.example.json";
export const PLAN_PATH = "03-technical-plan.md";
export const GRAPH_PATH = "resources/workflow-graph/workflow-graph.v1.json";
export const FLOWS_PATH = "01-core-flows.md";
export const CONTRACT_MARKER = "<!-- refusal-vocabulary-contract:v1 -->";

/** The closed refusal set, as the contract states it. */
export const REFUSALS = Object.freeze([
  "refusal_vocabulary_drift",
  "refusal_vocabulary_unknown_step",
  "refusal_vocabulary_unknown_class",
  "refusal_vocabulary_producer_missing",
  "refusal_vocabulary_producer_misdeclared",
  "refusal_vocabulary_code_unmapped",
  "refusal_vocabulary_unclosed_contract",
  "refusal_vocabulary_owner_missing",
  "refusal_vocabulary_owner_ambiguous",
  "refusal_vocabulary_digest_stale",
]);

const CODE = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gu;
const TOKEN = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\b/gu;
const CLASS_REF = /<([a-z][a-z0-9_]*)>/gu;

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const all = (pattern, text) => [...text.matchAll(new RegExp(pattern))].map((match) => match[1]);

/**
 * The steps a workflow may actually be at.
 *
 * Read from the workflow graph document, which declares them. This used to
 * scrape §2's prose with a regular expression, and a scrape is a second reading
 * of a text the graph already states: it saw a step wherever a token happened to
 * match the name pattern, so a renamed step stayed registered until someone
 * noticed, and a step the prose spelled twice was one step by luck rather than
 * by declaration.
 */
export function registeredSteps(document) {
  if (typeof document === "string") {
    throw new TypeError("registeredSteps reads the workflow graph document, not the plan text");
  }
  return document.steps.map((step) => step.name).sort();
}

/**
 * The resume contract, row by row.
 *
 * One table owns the vocabulary. A reason recorded anywhere else is prose about
 * a park, not a park state.
 */
export function parkTable(plan) {
  const lines = plan.split("\n");
  const header = lines.findIndex((line) => line.startsWith("| park.reason |"));
  if (header === -1) return [];
  const rows = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|");
    rows.push({ reason: cells[1].trim(), step: cells[2].trim() });
  }
  return rows;
}

/**
 * The vocabulary the documents actually declare.
 *
 * The step column is written for a person and carries qualifying prose, so only
 * tokens that name a registered step are taken from it. A misspelled step is
 * therefore not silently accepted: the row ends up naming no step at all, which
 * `stepErrors` refuses.
 */
export function extractVocabulary(plan, graph) {
  const registered = new Set(registeredSteps(graph));
  const byCode = new Map();
  for (const row of parkTable(plan)) {
    const classes = all(CLASS_REF, row.step);
    const steps = all(TOKEN, row.step.replace(CLASS_REF, " ")).filter((token) => registered.has(token));
    for (const code of all(CODE, row.reason)) {
      const entry = byCode.get(code) ?? { code, named_at: new Set(), named_at_classes: new Set() };
      for (const step of steps) entry.named_at.add(step);
      for (const name of classes) entry.named_at_classes.add(name);
      byCode.set(code, entry);
    }
  }
  return [...byCode.values()]
    .map((entry) => ({
      code: entry.code,
      named_at: [...entry.named_at].sort(),
      named_at_classes: [...entry.named_at_classes].sort(),
    }))
    .sort((a, b) => (a.code < b.code ? -1 : 1));
}

/**
 * Whether the checked-in vocabulary still says what the table says.
 *
 * The resource is the enumeration a reviewer reads; the table is where the
 * design decides. Drift between them is the failure this file exists to make
 * loud.
 */
export function driftErrors(vocabulary, extracted) {
  const errors = [];
  const recorded = new Map(vocabulary.park_reasons.map((entry) => [entry.code, entry]));
  for (const entry of extracted) {
    const found = recorded.get(entry.code);
    if (!found) {
      errors.push({ reason: "refusal_vocabulary_drift", detail: `${entry.code} is in the table and not in the resource` });
      continue;
    }
    // Only the fields the table decides are compared; the producer is curated.
    const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
    if (!same(found.named_at, entry.named_at) || !same(found.named_at_classes, entry.named_at_classes)) {
      errors.push({ reason: "refusal_vocabulary_drift", detail: `${entry.code} parks elsewhere than the table says` });
    }
  }
  const known = new Set(extracted.map((entry) => entry.code));
  for (const entry of vocabulary.park_reasons) {
    if (!known.has(entry.code)) {
      errors.push({ reason: "refusal_vocabulary_drift", detail: `${entry.code} is in the resource and not in the table` });
    }
  }
  return errors;
}

/** Step classes, and the steps and classes every reason names. */
export function stepErrors(vocabulary, steps) {
  const errors = [];
  const registered = new Set(steps);
  const classes = new Map(vocabulary.step_classes.map((entry) => [entry.class, entry]));
  for (const entry of vocabulary.step_classes) {
    for (const member of entry.members) {
      if (!registered.has(member)) {
        errors.push({ reason: "refusal_vocabulary_unknown_step", detail: `${entry.class}: ${member}` });
      }
    }
    if (entry.derivation.startsWith("complement:")) {
      // A class defined as "everything else" is checked against the derivation
      // rather than trusted, or it becomes a list somebody edits.
      const other = classes.get(entry.derivation.slice("complement:".length));
      const excluded = new Set(other ? other.members : []);
      const expected = steps.filter((step) => !excluded.has(step));
      if (expected.join(",") !== [...entry.members].sort().join(",")) {
        errors.push({ reason: "refusal_vocabulary_unknown_class", detail: `${entry.class} does not equal its derivation` });
      }
    }
  }
  for (const entry of vocabulary.park_reasons) {
    for (const step of entry.named_at) {
      if (!registered.has(step)) {
        errors.push({ reason: "refusal_vocabulary_unknown_step", detail: `${entry.code}: ${step}` });
      }
    }
    for (const name of entry.named_at_classes) {
      if (!classes.has(name)) {
        errors.push({ reason: "refusal_vocabulary_unknown_class", detail: `${entry.code}: ${name}` });
      }
    }
    if (entry.named_at.length === 0 && entry.named_at_classes.length === 0) {
      errors.push({ reason: "refusal_vocabulary_unknown_step", detail: `${entry.code} parks nowhere` });
    }
  }
  return errors;
}

/**
 * Who produces each reason.
 *
 * Most of these are parked by the daemon, which is not in this repository, and
 * saying otherwise would make the enumeration look better checked than it is.
 * So the claim is recorded and then contradicted where the repository does
 * produce the code.
 */
export function producerErrors(vocabulary, sources) {
  const errors = [];
  for (const entry of vocabulary.park_reasons) {
    // A whole-word match. A short code is a suffix of longer ones, and a file
    // that only ever writes the longer code does not produce the short one.
    const names = new RegExp(`\\b${entry.code}\\b`, "u");
    const naming = Object.keys(sources).filter((file) => names.test(sources[file])).sort();
    if (entry.producer === "host") {
      if (entry.producer_files.length === 0) {
        errors.push({ reason: "refusal_vocabulary_producer_missing", detail: `${entry.code} claims a host producer and names none` });
      }
      for (const file of entry.producer_files) {
        if (!naming.includes(file)) {
          errors.push({ reason: "refusal_vocabulary_producer_missing", detail: `${entry.code}: ${file} does not name it` });
        }
      }
    } else {
      if (entry.producer_files.length > 0) {
        errors.push({ reason: "refusal_vocabulary_producer_misdeclared", detail: `${entry.code} is daemon-produced and names host files` });
      }
      if (naming.length > 0) {
        errors.push({
          reason: "refusal_vocabulary_producer_misdeclared",
          detail: `${entry.code} is declared daemon-produced and ${naming[0]} produces it`,
        });
      }
    }
  }
  return errors;
}

/** The refusal classes each contract closes, by contract file name. */
export function closedByContract(contracts) {
  const owners = new Map();
  for (const [name, text] of Object.entries(contracts)) {
    const inline = /Closed set[^:]*:\s*(.+?)(?:\n\n|\.\s*\n)/su.exec(text);
    const section = /(?:^|\n)##\s*\d+\.\s*(?:Refusal classes|What a refusal looks like)\s*\n([\s\S]*?)(?=\n##\s|$)/u.exec(text);
    const codes = new Set([
      ...(inline ? all(/`([a-z][a-z0-9_]{4,})`/gu, inline[1]) : []),
      ...(section ? all(/^-\s*`([a-z][a-z0-9_]{4,})`/gmu, section[1]) : []),
    ]);
    // Keyed by the path the vocabulary records, so the two are comparable.
    const path = name.includes("/") ? name : `docs/contracts/${name}`;
    for (const code of codes) owners.set(code, [...(owners.get(code) ?? []), path]);
  }
  return owners;
}

/**
 * Who owns each park reason.
 *
 * Most of these are the workflow's own vocabulary and are owned by the resume
 * contract; some are additionally closed by the artifact contract they belong
 * to. Either way the owner is a field rather than something a reader infers,
 * because "somebody must have closed this somewhere" is how a code with no
 * owner survives.
 *
 * A name two contracts declare has no single owner, and therefore no single
 * producer and no single step — which is what the rest of this file checks.
 */
export function ownerErrors(vocabulary, contracts) {
  const owners = closedByContract(contracts);
  const errors = [];
  for (const [code, declaring] of owners) {
    if (declaring.length > 1) {
      errors.push({ reason: "refusal_vocabulary_owner_ambiguous", detail: `${code}: ${declaring.join(", ")}` });
    }
  }
  for (const entry of vocabulary.park_reasons) {
    const declaring = owners.get(entry.code) ?? [];
    if (!entry.closed_by) {
      errors.push({ reason: "refusal_vocabulary_owner_missing", detail: entry.code });
      continue;
    }
    if (declaring.length > 0 && !declaring.includes(entry.closed_by)) {
      errors.push({
        reason: "refusal_vocabulary_owner_missing",
        detail: `${entry.code}: recorded ${entry.closed_by}, closed by ${declaring.join(", ")}`,
      });
    }
    if (declaring.length === 0 && entry.closed_by !== WORKFLOW_OWNER) {
      errors.push({
        reason: "refusal_vocabulary_owner_missing",
        detail: `${entry.code}: no contract closes it, so the owner is ${WORKFLOW_OWNER}`,
      });
    }
  }
  return errors;
}

/** The document that owns a park reason no artifact contract closes. */
export const WORKFLOW_OWNER = "03-technical-plan.md";

/** Every contract closes its refusal set, so none of them is open-ended. */
export function unclosedContracts(contracts) {
  const errors = [];
  for (const [name, text] of Object.entries(contracts)) {
    const inline = /Closed set[^:]*:\s*(.+?)(?:\n\n|\.\s*\n)/su.exec(text);
    const section = /(?:^|\n)##\s*\d+\.\s*(?:Refusal classes|What a refusal looks like)\s*\n([\s\S]*?)(?=\n##\s|$)/u.exec(text);
    const codes = new Set([
      ...(inline ? all(/`([a-z][a-z0-9_]{4,})`/gu, inline[1]) : []),
      ...(section ? all(/^-\s*`([a-z][a-z0-9_]{4,})`/gmu, section[1]) : []),
    ]);
    if (codes.size === 0) {
      errors.push({ reason: "refusal_vocabulary_unclosed_contract", detail: name });
    }
  }
  return errors;
}

/**
 * A code the user-facing recovery table names must be in the vocabulary.
 *
 * §8 of the core flows is written for a person and mostly describes situations;
 * where it does name a machine code, that code is a park state and belongs to
 * the enumeration like any other.
 */
export function unmappedCodes(vocabulary, flows) {
  const lines = flows.split("\n");
  const from = lines.findIndex((line) => line.startsWith("## 8. "));
  const to = lines.findIndex((line, index) => index > from && line.startsWith("## 9. "));
  const known = new Set(vocabulary.park_reasons.map((entry) => entry.code));
  const errors = [];
  for (const line of lines.slice(from, to)) {
    if (!line.startsWith("|") || line.includes("---")) continue;
    for (const code of all(CODE, line.split("|")[1])) {
      if (!known.has(code)) errors.push({ reason: "refusal_vocabulary_code_unmapped", detail: code });
    }
  }
  return errors;
}

/** The digest the enumeration is bound to. */
export function vocabularyDigest(vocabulary) {
  const { vocabulary_digest, ...body } = vocabulary;
  return sha256(JSON.stringify(body));
}

/** Everything, in the order a reader would ask it. */
export function vocabularyErrors(vocabulary, { plan, graph, flows, sources, contracts }) {
  const errors = [
    ...driftErrors(vocabulary, extractVocabulary(plan, graph)),
    ...stepErrors(vocabulary, registeredSteps(graph)),
    ...producerErrors(vocabulary, sources),
    ...ownerErrors(vocabulary, contracts),
    ...unmappedCodes(vocabulary, flows),
    ...unclosedContracts(contracts),
  ];
  if (vocabulary.vocabulary_digest !== vocabularyDigest(vocabulary)) {
    errors.push({ reason: "refusal_vocabulary_digest_stale", detail: "the recorded digest does not recompute" });
  }
  return errors;
}

/** The shipped design. */
export function validateDesign(files, { plan, graph, flows, sources, contracts }) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract || !contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: the contract marker is missing`);
  for (const refusal of REFUSALS) {
    if (contract && !contract.includes(`\`${refusal}\``)) {
      errors.push(`${CONTRACT_PATH}: ${refusal} is not named in the contract`);
    }
  }
  const schema = JSON.parse(files[SCHEMA_PATH]);
  if (schema.additionalProperties !== false) errors.push(`${SCHEMA_PATH}: the schema is not closed`);

  const vocabulary = JSON.parse(files[VOCABULARY_PATH]);
  errors.push(
    ...vocabularyErrors(vocabulary, { plan, graph, flows, sources, contracts })
      .map((entry) => `${VOCABULARY_PATH}: ${entry.reason}: ${entry.detail}`),
  );

  const refused = JSON.parse(files[REFUSED_PATH]);
  const produced = new Set(
    vocabularyErrors(refused, { plan, graph, flows, sources, contracts }).map((entry) => entry.reason),
  );
  if (produced.size < 4) {
    errors.push(`${REFUSED_PATH}: the refused example produces only ${produced.size} refusal classes`);
  }
  return errors;
}

/** Every `.mjs` under `src/` and `scripts/`, by repo-relative path. */
export function readSources(root = ROOT) {
  const sources = {};
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith(".mjs")) sources[next] = readFileSync(path.join(root, next), "utf8");
    }
  };
  walk("src");
  walk("scripts");
  return sources;
}

export function readContracts(root = ROOT) {
  const contracts = {};
  for (const name of readdirSync(path.join(root, "docs/contracts")).sort()) {
    if (name.endsWith(".md")) contracts[name] = readFileSync(path.join(root, "docs/contracts", name), "utf8");
  }
  return contracts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");
  const files = Object.fromEntries(
    [CONTRACT_PATH, SCHEMA_PATH, VOCABULARY_PATH, REFUSED_PATH].map((relative) => [relative, read(relative)]),
  );
  const context = {
    plan: read(PLAN_PATH),
    graph: JSON.parse(read(GRAPH_PATH)),
    flows: read(FLOWS_PATH),
    sources: readSources(),
    contracts: readContracts(),
  };
  const errors = validateDesign(files, context);
  for (const error of errors) console.error(error);
  if (errors.length > 0) process.exitCode = 1;
  else {
    const vocabulary = JSON.parse(files[VOCABULARY_PATH]);
    const host = vocabulary.park_reasons.filter((entry) => entry.producer === "host").length;
    console.log("Refusal vocabulary validation PASS");
    console.log(`park_reasons=${vocabulary.park_reasons.length} host=${host} daemon=${vocabulary.park_reasons.length - host}`);
    console.log(`registered_steps=${registeredSteps(context.graph).length}`);
    console.log(`vocabulary_digest=${vocabulary.vocabulary_digest}`);
  }
}
