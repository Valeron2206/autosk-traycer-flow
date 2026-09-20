#!/usr/bin/env node

/**
 * produce-refusals — drives every selected refusal class to the code that
 * produces it, and asserts the produced code is the declared class.
 *
 * The package's section 4 counts refusal classes named in linked modules; this
 * command measures the other half: each declared case is executed, the codes
 * the run produced are collected, and the case fails unless the set contains
 * its class. The runner holds no class names — every declaration lives in the
 * per-contract `*.cases.json` data, so the vocabulary's producer scan reads
 * this file as machinery, not as a claim to produce anything.
 *
 * The coverage floor is measured, not declared: `measureContracts()` reads each
 * contract's closed set, and the run fails naming any class no case covers and
 * any case whose class the contract does not declare. A case's `produced` list
 * is the classes read through the refusal channel its drive kind defines — a
 * normal return is not a refusal, and input bytes are never read as output.
 *
 * The report binds the source bytes it was produced from: the module closure
 * it executed, the data each manifest declares its fixture opens, and the
 * contract documents. A package rendered on other bytes refuses the column.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { measureContracts } from "./build-panel-package.mjs";
import { bindSource } from "./lib/produced-source.mjs";
import * as ticketsManifest from "./produce-refusals-tickets-manifest.mjs";
import * as workflowGraph from "./produce-refusals-workflow-graph.mjs";
import * as identityLock from "./produce-refusals-runtime-identity-lock.mjs";
import * as refusalVocabulary from "./produce-refusals-refusal-vocabulary.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const MANIFESTS = [ticketsManifest, workflowGraph, identityLock, refusalVocabulary];

/**
 * The smallest document `index`/`buildWorkflow` can stand up: one agent step
 * with no outgoing edges and no `no_transition_reason`. The schema forbids
 * exactly this shape, which is why the fallback code it reaches is declared
 * unreachable from a valid document — producing it asks the runtime, not the
 * validator.
 */
const SYNTHETIC_DOCUMENT = Object.freeze({
  workflow: "produce-refusals-probe",
  first_step: "s0",
  steps: [{ name: "s0", kind: "agent" }],
  predicates: [],
  guards: [],
  transitions: [],
  caps: [],
  recovery: [],
  entry_steps: [],
  external_operations: [],
});

/* ---------------------------------------------------------------------- */
/* document mutation — JSON-pointer ops, enough to state every case         */
/* ---------------------------------------------------------------------- */

const pointer = (ref) =>
  ref.split("/").slice(1).map((segment) => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"));

function pointerOwner(doc, ref) {
  const segments = pointer(ref);
  let owner = doc;
  for (const segment of segments.slice(0, -1)) {
    owner = owner[segment];
    if (owner === undefined || owner === null) throw new Error(`mutation path ${ref} does not exist`);
  }
  return { owner, key: segments[segments.length - 1] };
}

export function mutate(doc, ops = []) {
  const copy = structuredClone(doc);
  for (const op of ops) {
    const { owner, key } = pointerOwner(copy, op.path);
    const at = Array.isArray(owner) ? (key === "-" ? owner.length : Number(key)) : key;
    if (op.op === "replace" || op.op === "add") {
      if (Array.isArray(owner)) {
        if (op.op === "add") owner.splice(at, 0, op.value);
        else owner[at] = op.value;
      } else owner[key] = op.value;
    } else if (op.op === "remove") {
      if (Array.isArray(owner)) owner.splice(at, 1);
      else delete owner[key];
    } else if (op.op === "copy") {
      const source = pointerOwner(copy, op.from);
      const value = source.owner[Array.isArray(source.owner) ? Number(source.key) : source.key];
      if (Array.isArray(owner)) owner.splice(at, 0, structuredClone(value));
      else owner[key] = structuredClone(value);
    } else {
      throw new Error(`unknown mutation op ${op.op}`);
    }
  }
  return copy;
}

/** Literal find-and-replace over text fixtures (the flows document). */
const editText = (text, edits = []) =>
  edits.reduce((body, edit) => {
    if (!body.includes(edit.find)) throw new Error(`text fixture anchor not found: ${edit.find.slice(0, 60)}`);
    return body.replace(edit.find, edit.with);
  }, text);

/* ---------------------------------------------------------------------- */
/* produced-code collection — the refusal channel each drive kind defines    */
/* ---------------------------------------------------------------------- */

/**
 * A drive produces a refusal through exactly one channel, and nowhere else:
 *
 * - `returned` — a design validator's returned error entries. Each entry is a
 *   refusal: `{ reason }` objects carry the class typed; `"code: detail"`
 *   strings carry it as the first segment, after at most one `<file>:`
 *   subject prefix (`resources/x.json: lock_not_json: ...`). A class that
 *   appears only inside a detail — echoed payload text — is not collected.
 * - `thrown` — the emitter throws: `GraphRefusal` and the park/resume/admit
 *   boundaries carry the class in `reason`; the parser and canonical
 *   serializer spell it as the `code:` prefix of the message.
 * - `written` — a parked run writes `park.reason <class>` through `ctx.exec`;
 *   the argv is the refusal.
 *
 * A normal return on a `thrown` channel produced nothing — fields on a
 * returned value are data, not a refusal. A throw on a `returned`/`written`
 * channel is a crash, not a refusal.
 */
const CHANNEL = {
  graph_validate: "returned",
  graph_parse: "thrown",
  graph_canonical: "thrown",
  park_edge: "written",
  park_step: "written",
  admit: "thrown",
  resume: "thrown",
  lock_validate: "returned",
  lock_design: "returned",
  vocab: "returned",
};

// `code:` at its defined position — the entry's first segment, after at most
// one filename subject (`file.json: code: detail`).
const ENTRY_CODE = /^(?:[\w./~-]+\.[a-z0-9]+: )?([a-z][a-z0-9_]*):/u;
const MESSAGE_CODE = /^([a-z][a-z0-9_]*):/u;

function collectReturned(produced, output) {
  const entries = Array.isArray(output) ? output : (output?.errors ?? []);
  for (const entry of entries) {
    if (typeof entry === "string") {
      const match = ENTRY_CODE.exec(entry);
      if (match) produced.add(match[1]);
    } else if (entry !== null && typeof entry === "object" && typeof entry.reason === "string") {
      produced.add(entry.reason);
    }
  }
}

function collectThrown(produced, error) {
  if (typeof error?.reason === "string") produced.add(error.reason);
  const match = MESSAGE_CODE.exec(error?.message ?? "");
  if (match) produced.add(match[1]);
}

/** `recordPark` writes through ctx.exec — the argv IS the observable refusal. */
function collectWrites(produced, execs) {
  for (const argv of execs) {
    const at = argv.indexOf("park.reason");
    if (at >= 0 && typeof argv[at + 1] === "string") produced.add(argv[at + 1]);
  }
}

const recordingCtx = () => {
  const execs = [];
  return {
    projectRoot: "/produce-refusals",
    sessionToken: "produce-refusals",
    tasks: { currentId: "case", current: async () => ({ metadata: {} }) },
    exec: async (argv) => {
      execs.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    },
    transit: async () => {},
    execs,
  };
};

/* ---------------------------------------------------------------------- */
/* drives                                                                   */
/* ---------------------------------------------------------------------- */

const DRIVES = {
  // design-time: mutate the shipped document, restamp its digest, run the validator
  async graph_validate(drive, fixture, emitters) {
    const doc = mutate(fixture.document(), drive.mutate);
    if (drive.restamp !== false) doc.canonical_digest = emitters.graphDigest(doc);
    return emitters.validateGraph(doc, fixture.schema);
  },
  // design-time parse refusals: the raw text is the fixture
  async graph_parse(drive, fixture, emitters) {
    return emitters.parseStrict(drive.text);
  },
  // the canonical serializer refuses a document the parser accepted
  async graph_canonical(drive, fixture, emitters) {
    return emitters.graphDigest(mutate(fixture.document(), drive.mutate));
  },
  // runtime: build the workflow and run the step so the named edge is the
  // one the selector can take — the edge's declared reason is the park write
  async park_edge(drive, fixture, emitters) {
    const edge = fixture.document().transitions.find((entry) => entry.id === drive.edge);
    if (!edge) throw new Error(`drive names no edge ${drive.edge}`);
    const evaluate = (_predicate, guard) => edge.guards.includes(guard.id);
    const workflow = emitters.buildWorkflow(fixture.document(), { evaluate });
    const ctx = recordingCtx();
    await workflow.steps[drive.step].onRun(ctx);
    return ctx.execs;
  },
  // runtime: no candidate edge holds, so the step's own no_transition_reason
  // is the reason recorded — or the graph's own fallback when the step names none
  async park_step(drive, fixture, emitters) {
    const document = drive.synthetic ? SYNTHETIC_DOCUMENT : fixture.document();
    const workflow = emitters.buildWorkflow(document, { evaluate: () => false });
    const ctx = recordingCtx();
    await workflow.steps[drive.step].onRun(ctx);
    return ctx.execs;
  },
  // runtime, exported boundary: an attempted move the document never declared
  async admit(drive, fixture, emitters) {
    const state = emitters.index(fixture.document());
    emitters.admit(
      state,
      { step: drive.step, status: "work", parked: false, parkedWith: undefined, park: {}, visits: {} },
      { step: drive.to },
      () => false,
    );
    return [];
  },
  // runtime, exported boundary: a resume target the reason's row does not permit
  async resume(drive, fixture, emitters) {
    const state = emitters.index(fixture.document());
    emitters.permitsResume(state, drive.reason, drive.to);
    return [];
  },
  // design-time: the lock validator over mutated resource objects
  async lock_validate(drive, fixture, emitters) {
    const lock = mutate(JSON.parse(fixture.files[emitters.LOCK_PATH]), drive.lock);
    const manifest = mutate(JSON.parse(fixture.files[emitters.MANIFEST_PATH]), drive.manifest);
    if (drive.restamp !== false) lock.lock_digest = emitters.lockDigest(lock);
    const overrides = drive.patches ?? {};
    const readPatch = (relative) => {
      if (Object.hasOwn(overrides, relative)) {
        if (overrides[relative] === null) throw new Error(`${relative}: not on disk (produced case)`);
        return overrides[relative];
      }
      return fixture.readPatch(relative);
    };
    return emitters.validateLock(lock, fixture.schema, { manifest, readPatch });
  },
  // design-time: the file-level shape — a file whose bytes do not parse
  async lock_design(drive, fixture, emitters) {
    const files = { ...fixture.files };
    for (const [relative, edit] of Object.entries(drive.files ?? {})) {
      files[relative] = edit.text !== undefined ? edit.text : JSON.stringify(mutate(JSON.parse(files[relative]), edit.mutate));
    }
    return emitters.validateDesign(files, { readPatch: fixture.readPatch });
  },
  // design-time: the vocabulary validator over mutated resource objects
  async vocab(drive, fixture, emitters) {
    const vocabulary = mutate(fixture.vocabulary, drive.mutate);
    if (drive.restamp !== false) vocabulary.vocabulary_digest = emitters.vocabularyDigest(vocabulary);
    const context = {
      ...fixture.context,
      flows: editText(fixture.context.flows, drive.flows),
      contracts: { ...fixture.context.contracts, ...(drive.extra_contracts ?? {}) },
    };
    return emitters.vocabularyErrors(vocabulary, context);
  },
};

/* ---------------------------------------------------------------------- */
/* execution                                                                */
/* ---------------------------------------------------------------------- */

export async function produceCase(caseDecl, fixture, emitters) {
  const produced = new Set();
  const channel = CHANNEL[caseDecl.drive?.kind];
  if (channel === undefined) throw new Error(`unknown drive kind ${caseDecl.drive?.kind}`);
  try {
    const output = await DRIVES[caseDecl.drive.kind](caseDecl.drive, fixture, emitters);
    if (channel === "returned") collectReturned(produced, output);
    else if (channel === "written") collectWrites(produced, output);
  } catch (error) {
    if (channel === "thrown") collectThrown(produced, error);
  }
  const pass = produced.has(caseDecl.class);
  return {
    class: caseDecl.class,
    side: caseDecl.side,
    emitter: caseDecl.emitter,
    drive: caseDecl.drive.kind,
    produced: [...produced].sort(),
    pass,
    ...(caseDecl.also ? { also: caseDecl.also } : {}),
    ...(caseDecl.predicate_owner ? { predicate_owner: caseDecl.predicate_owner } : {}),
    ...(caseDecl.note ? { note: caseDecl.note } : {}),
  };
}

/**
 * The module bytes the run executed: the in-repo `import`/`export ... from`
 * closure starting at this file, so the manifests, the validators and host
 * emitters they name, and every module those modules reach are bound by their
 * bytes — a neutered emitter anywhere in the closure is a different tree.
 */
const RELATIVE_IMPORT = /\b(?:import|export)\b[^"';]*?\bfrom\s+["'](\.[^"']+)["']|\bimport\s+["'](\.[^"']+)["']/gu;

function moduleClosure() {
  const entry = fileURLToPath(import.meta.url);
  const seen = new Set();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    const relative = path.relative(ROOT, file).split(path.sep).join("/");
    if (seen.has(relative)) continue;
    seen.add(relative);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(RELATIVE_IMPORT)) {
      stack.push(path.resolve(path.dirname(file), match[1] ?? match[2]));
    }
  }
  return seen;
}

export async function produceReport(manifests = MANIFESTS) {
  // One measurement defines the class list for the run and for the package's
  // column: a declared class with no case, or a case naming no declared class,
  // fails the run the way a wrong produced code does.
  const declaredBy = new Map(
    (await measureContracts()).map((entry) => [entry.path, entry.refusals]),
  );
  const contracts = [];
  for (const manifest of manifests) {
    const fixture = manifest.fixture();
    const cases = [];
    for (const caseDecl of manifest.cases) {
      cases.push(await produceCase(caseDecl, fixture, manifest.emitters));
    }
    const declared = declaredBy.get(manifest.CONTRACT) ?? [];
    const caseClasses = cases.map((entry) => entry.class);
    contracts.push({
      contract: manifest.CONTRACT,
      declared: declared.length,
      produced: cases.filter((entry) => entry.pass).length,
      of: cases.length,
      uncovered: declared.filter((name) => !caseClasses.includes(name)),
      undeclared: [...new Set(caseClasses.filter((name) => !declared.includes(name)))],
      cases,
    });
  }
  // The report binds the bytes it was produced from: the module closure, the
  // data each manifest's fixture declares it opens, and the contract document
  // whose closed set the coverage check measured. The manifests' recorded
  // directory listings cover every scan the derivation performs — the
  // measureContracts flat scans are subsets of the deep ones — so an input
  // added after the run refuses the column too.
  const bound = moduleClosure();
  const listings = [];
  for (const manifest of manifests) {
    for (const source of manifest.sources()) bound.add(source);
    bound.add(manifest.CONTRACT);
    listings.push(...(manifest.listings?.() ?? []));
  }
  return {
    tool: "produce-refusals",
    cases: contracts.reduce((sum, entry) => sum + entry.of, 0),
    passed: contracts.reduce((sum, entry) => sum + entry.produced, 0),
    uncovered: contracts.reduce((sum, entry) => sum + entry.uncovered.length, 0),
    undeclared: contracts.reduce((sum, entry) => sum + entry.undeclared.length, 0),
    source: bindSource(ROOT, [...bound], listings),
    contracts,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;
  const report = await produceReport();
  for (const entry of report.contracts) {
    console.log(
      `${entry.contract}: produced ${entry.produced} of ${entry.declared} declared classes (${entry.of} cases)`,
    );
    for (const name of entry.uncovered) {
      console.error(`  UNCOVERED ${name} — the contract declares it, no case produces it`);
    }
    for (const name of entry.undeclared) {
      console.error(`  UNDECLARED ${name} — a case produces it, the contract does not declare it`);
    }
    for (const failure of entry.cases.filter((row) => !row.pass)) {
      console.error(`  FAIL ${failure.class} (${failure.drive}) produced: ${failure.produced.join(", ") || "nothing"}`);
    }
  }
  console.log(
    `cases=${report.cases} produced=${report.passed} failed=${report.cases - report.passed} ` +
      `uncovered=${report.uncovered} undeclared=${report.undeclared}`,
  );
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  if (report.passed !== report.cases || report.uncovered > 0 || report.undeclared > 0) {
    process.exitCode = 1;
  }
}
