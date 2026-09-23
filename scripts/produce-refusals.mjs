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
 * The `emitter` a case carries, and `also` when a case still carries one, are
 * signatures. A signature passes when a function of that name in that file,
 * outside the produce-refusals harness, ran during its case, read from V8
 * precise coverage by script url and function name. Which of the functions
 * that ran produced the code is not checked. `NODE_V8_COVERAGE` is refused,
 * including when `node --test --experimental-test-coverage` sets it. A
 * coverage session started in the same process through `node:inspector`, or a
 * DevTools coverage recording, cannot be detected. Running `produceReport`
 * inside such a host corrupts that host's coverage. `produce:refusals` must
 * run in its own process. `--inspect` alone is not a coverage session and is
 * left alone.
 *
 * The executed list is closed against the namespace it draws from: every
 * `produce-refusals-*.cases.json` on disk must be declared by an executed
 * manifest, every manifest's `CASES_PATH` must be one of those files, and
 * no two manifests may declare the same one — a gap in any direction is a
 * boundary leak the run refuses, not a data error it reports per case.
 *
 * The report binds the source bytes it was produced from: the module closure
 * it executed, the data each manifest declares its fixture opens, and the
 * contract documents. A package rendered on other bytes refuses the column.
 */

import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { measureContracts } from "./build-panel-package.mjs";
import { bindSource } from "./lib/produced-source.mjs";
import { caseEmitterFiles, casesClosureErrors, executedManifests } from "./produce-refusals-manifests.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export { executedManifests };

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
  graph_build: "thrown",
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
  // runtime build: the factory throws before a workflow exists. The document
  // is mutated and restamped the same way graph_validate does, then built.
  async graph_build(drive, fixture, emitters) {
    const doc = mutate(fixture.document(), drive.mutate);
    if (drive.restamp !== false) doc.canonical_digest = emitters.graphDigest(doc);
    return emitters.buildWorkflow(doc, { evaluate: () => false });
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

const ROOT_REAL = realpathSync(ROOT);

function scriptRelative(url) {
  if (!url.startsWith("file:")) return null;
  let file;
  try {
    file = realpathSync(fileURLToPath(url));
  } catch {
    return null;
  }
  const relative = path.relative(ROOT_REAL, file);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join("/");
}

/** file → functionName → highest call count in this take. A name that is absent did not run. */
function executedFunctions(coverage) {
  const byFile = new Map();
  for (const script of coverage.result) {
    const rel = scriptRelative(script.url);
    if (rel === null) continue;
    let names = byFile.get(rel);
    if (!names) {
      names = new Map();
      byFile.set(rel, names);
    }
    for (const fn of script.functions) {
      const count = fn.ranges[0]?.count ?? 0;
      if (count > (names.get(fn.functionName) ?? 0)) names.set(fn.functionName, count);
    }
  }
  return byFile;
}

const HARNESS_FILE = /^scripts\/produce-refusals(?:-.+)?\.mjs$/u;
export const HOST_COVERAGE = "HOST_COVERAGE NODE_V8_COVERAGE — a host coverage session cannot share this isolate";

/** The runner and every manifest module. A signature that names one is not a producer. */
export function isHarnessFile(file) {
  return HARNESS_FILE.test(file);
}

function signatureRan(byFile, signature) {
  const mark = signature.indexOf("#");
  const file = signature.slice(0, mark);
  const symbol = signature.slice(mark + 1);
  return (byFile.get(file)?.get(symbol) ?? 0) > 0;
}

function classifySignatures(caseDecl, ran) {
  const harness = [];
  const unexecuted = [];
  for (const signature of caseSignatures(caseDecl)) {
    if (isHarnessFile(signature.slice(0, signature.indexOf("#")))) harness.push(signature);
    else if (!signatureRan(ran, signature)) unexecuted.push(signature);
  }
  return { harness, unexecuted };
}

/** Parse a fixture document once, outside the per-case window, and hand each case its own copy. */
function freezeDocument(fixture) {
  if (typeof fixture.document !== "function") return fixture;
  const document = fixture.document();
  return { ...fixture, document: () => structuredClone(document) };
}

/** Signatures a well-formed case declares. A malformed record is counted elsewhere. */
function caseSignatures(caseDecl) {
  if (caseEmitterFiles(caseDecl) === null) return [];
  return caseDecl.also === undefined ? [caseDecl.emitter] : [caseDecl.emitter, caseDecl.also];
}

async function closeCoverage(session) {
  await session.post("Profiler.stopPreciseCoverage");
  await session.post("Profiler.disable");
  session.disconnect();
}

export async function produceReport(manifests = executedManifests()) {
  // One measurement defines the class list for the run and for the package's
  // column: a declared class with no case, or a case naming no declared class,
  // fails the run the way a wrong produced code does.
  // The executed list must close against the producing namespace on disk:
  // a `produce-refusals-*.cases.json` no manifest declares drives nothing
  // but sits where a reader expects driven data, and a manifest whose
  // `CASES_PATH` is outside the namespace — or shared with another
  // manifest — is a boundary leak, not a data error.
  const closure = casesClosureErrors(
    manifests,
    readdirSync(path.join(ROOT, "scripts"))
      .filter((name) => name.startsWith("produce-refusals-") && name.endsWith(".cases.json"))
      .map((name) => `scripts/${name}`),
  );
  if (process.env.NODE_V8_COVERAGE) throw new Error(HOST_COVERAGE);
  const declaredBy = new Map(
    (await measureContracts()).map((entry) => [entry.path, entry.refusals]),
  );
  // Modules are already evaluated. Precise coverage still counts calls made
  // after it starts, including functions compiled at import. Fixture documents
  // are parsed once here, and the take that follows clears that work, so a
  // case's take is only the case.
  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
  try {
    const prepared = manifests.map((manifest) => ({ manifest, fixture: freezeDocument(manifest.fixture()) }));
    await session.post("Profiler.takePreciseCoverage");
    const contracts = [];
    for (const { manifest, fixture } of prepared) {
      const cases = [];
      for (const caseDecl of manifest.cases) {
        const row = await produceCase(caseDecl, fixture, manifest.emitters);
        const ran = executedFunctions(await session.post("Profiler.takePreciseCoverage"));
        const { harness, unexecuted } = classifySignatures(caseDecl, ran);
        cases.push({ ...row, unexecuted, harness });
      }
      const declared = declaredBy.get(manifest.CONTRACT) ?? [];
      const caseClasses = cases.map((entry) => entry.class);
      // A driven case that does not record who emitted its class is a manifest
      // that measured nothing checkable — refused by name, not silently kept.
      const malformed = manifest.cases
        .filter((caseDecl) => caseEmitterFiles(caseDecl) === null)
        .map((caseDecl) => caseDecl.class ?? JSON.stringify(caseDecl));
      contracts.push({
        contract: manifest.CONTRACT,
        declared: declared.length,
        // Distinct classes that have a passing case. A class with two producers
        // is one class; the case count stays on `of`.
        produced: new Set(cases.filter((entry) => entry.pass).map((entry) => entry.class)).size,
        of: cases.length,
        malformed,
        unexecuted: cases.reduce((sum, entry) => sum + entry.unexecuted.length, 0),
        // A harness signature is not "did not run": the function may have run,
        // and the exclusion is what refused it. Counted apart from unexecuted.
        harness: cases.reduce((sum, entry) => sum + entry.harness.length, 0),
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
    // The closure scan above is a directory enumeration — record it so a
    // cases file added after the run refuses the column too.
    listings.push({ dir: "scripts", suffix: ".cases.json", deep: false });
    return {
      tool: "produce-refusals",
      cases: contracts.reduce((sum, entry) => sum + entry.of, 0),
      passed: contracts.reduce((sum, entry) => sum + entry.cases.filter((row) => row.pass).length, 0),
      uncovered: contracts.reduce((sum, entry) => sum + entry.uncovered.length, 0),
      undeclared: contracts.reduce((sum, entry) => sum + entry.undeclared.length, 0),
      malformed: contracts.reduce((sum, entry) => sum + entry.malformed.length, 0),
      unclosed: closure.undriven.length + closure.missing.length + closure.duplicate.length,
      unexecuted: contracts.reduce((sum, entry) => sum + entry.unexecuted, 0),
      harness: contracts.reduce((sum, entry) => sum + entry.harness, 0),
      closure,
      source: bindSource(ROOT, [...bound], listings),
      contracts,
    };
  } finally {
    await closeCoverage(session);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;
  if (process.env.NODE_V8_COVERAGE) {
    console.error(HOST_COVERAGE);
    process.exitCode = 1;
  } else {
    const report = await produceReport();
    for (const file of report.closure.undriven) {
      console.error(`UNDRIVEN ${file} — a producing-cases file on disk that no executed manifest declares`);
    }
    for (const file of report.closure.missing) {
      console.error(`MISSING ${file} — an executed manifest declares a cases path outside the driven namespace`);
    }
    for (const file of report.closure.duplicate) {
      console.error(`DUPLICATE ${file} — more than one executed manifest declares it as its cases file`);
    }
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
      for (const name of entry.malformed) {
        console.error(`  MALFORMED ${name} — a driven case records no emitter it can be traced to`);
      }
      for (const failure of entry.cases.filter((row) => !row.pass)) {
        console.error(`  FAIL ${failure.class} (${failure.drive}) produced: ${failure.produced.join(", ") || "nothing"}`);
      }
      for (const row of entry.cases) {
        for (const signature of row.harness) {
          console.error(
            `  HARNESS ${row.class} ${signature} — the signature names the produce-refusals harness, not a producer`,
          );
        }
        for (const signature of row.unexecuted) {
          console.error(
            `  UNEXECUTED ${row.class} ${signature} — the signature's function did not run during its case`,
          );
        }
      }
    }
    console.log(
      "a signature passes when a function of that name in that file, outside the produce-refusals harness, ran during its case; which of the functions that ran produced the code is not checked.",
    );
    console.log(
      `cases=${report.cases} produced=${report.passed} failed=${report.cases - report.passed} ` +
        `uncovered=${report.uncovered} undeclared=${report.undeclared} malformed=${report.malformed} unclosed=${report.unclosed} unexecuted=${report.unexecuted} harness=${report.harness}`,
    );
    if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    if (
      report.passed !== report.cases ||
      report.uncovered > 0 ||
      report.undeclared > 0 ||
      report.malformed > 0 ||
      report.unclosed > 0 ||
      report.unexecuted > 0 ||
      report.harness > 0
    ) {
      process.exitCode = 1;
    }
  }
}
