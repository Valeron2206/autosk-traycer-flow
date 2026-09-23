/**
 * Tests for the produce-refusals command.
 *
 * A closed refusal set is only as real as the code that can produce each entry,
 * so the command drives every declared case to refusal and asserts the produced
 * code is the declared class. These tests check the command itself: that the
 * full set produces, that a wrong production is a named failure, that a runtime
 * case which drifts to a step's own reason does not pass on the wrong edge, and
 * that a mutation the schema rejects early cannot mask the check it was meant
 * to reach.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import { pathToFileURL } from "node:url";

import { HOST_COVERAGE, ROOT, isHarnessFile, produceCase, produceReport } from "../scripts/produce-refusals.mjs";
import { vocabularyDigest } from "../scripts/validate-refusal-vocabulary.mjs";
import { sourceDrift } from "../scripts/lib/produced-source.mjs";
import { collectRecordedPaths, reduceToInputs, toRepoRelative } from "../scripts/lib/measured-inputs.mjs";
import {
  caseEmitterFiles,
  executedManifests,
  loadCases,
} from "../scripts/produce-refusals-manifests.mjs";
import * as ticketsManifest from "../scripts/produce-refusals-tickets-manifest.mjs";
import * as workflowGraph from "../scripts/produce-refusals-workflow-graph.mjs";
import * as identityLock from "../scripts/produce-refusals-runtime-identity-lock.mjs";

// produce:refusals starts its own precise coverage. A host that already holds
// the isolate's coverage session cannot be measured inside, so these tests
// skip rather than corrupt that session.
const hostCoverageSkip = process.env.NODE_V8_COVERAGE
  ? "produce:refusals must run in its own process; a host coverage session (NODE_V8_COVERAGE) cannot share its isolate"
  : false;

function drives(name, fn) {
  test(name, hostCoverageSkip ? { skip: hostCoverageSkip } : {}, fn);
}

// Case data comes through the one shared loader — a manifest's declared
// `CASES_PATH` is the path read, here as in the run.
const manifests = executedManifests();
const ticketsCases = loadCases(ticketsManifest.CASES_PATH);
const workflowCases = loadCases(workflowGraph.CASES_PATH);

// One coverage run for every test that only reads the default manifests.
let defaultReportPromise;
function defaultReport() {
  defaultReportPromise ??= produceReport();
  return defaultReportPromise;
}

drives("every declared case produces its own class", async () => {
  const report = await defaultReport();
  const failures = report.contracts.flatMap((entry) => entry.cases.filter((row) => !row.pass));
  assert.deepEqual(failures.map((row) => row.class), []);
  assert.equal(report.passed, report.cases);
  assert.equal(report.unexecuted, 0);
  assert.equal(report.harness, 0);
});

drives("the declared cases cover each contract's measured closed set exactly", async () => {
  // The floor is the contract's own class list as `measureContracts` reads it,
  // not a count typed into this file — a class added to a contract without a
  // case fails `uncovered`, and a case naming no declared class fails
  // `undeclared`, both with the name attached.
  const report = await defaultReport();
  // One class may have a case per producer. The declared set is still exact:
  // uncovered and undeclared name any class on only one side.
  assert.ok(report.cases >= report.contracts.reduce((sum, entry) => sum + entry.declared, 0));
  for (const entry of report.contracts) {
    assert.deepEqual(entry.uncovered, [], `${entry.contract} declares classes no case produces`);
    assert.deepEqual(entry.undeclared, [], `${entry.contract} has cases outside its closed set`);
    const filesByClass = new Map();
    for (const row of entry.cases) {
      const file = row.emitter.slice(0, row.emitter.indexOf("#"));
      const seen = filesByClass.get(row.class) ?? new Set();
      assert.equal(seen.has(file), false, `${entry.contract} ${row.class} records ${file} twice`);
      seen.add(file);
      filesByClass.set(row.class, seen);
    }
  }
});

drives("two passing cases for one class count that class once", async () => {
  const report = await defaultReport();
  const workflow = report.contracts.find((entry) => entry.contract === "docs/contracts/workflow-graph.md");
  const passingClasses = new Set(workflow.cases.filter((row) => row.pass).map((row) => row.class));
  assert.equal(workflow.of, workflow.cases.length);
  assert.ok(workflow.of > passingClasses.size, "the contract no longer has two cases for one class");
  assert.equal(workflow.produced, passingClasses.size);
  assert.equal(workflow.produced, workflow.declared);
});

drives("a declared class with no case fails the run, named", async () => {
  const short = {
    ...workflowGraph,
    cases: workflowCases.filter((entry) => entry.class !== "graph_schema"),
  };
  const report = await produceReport([short]);
  assert.deepEqual(report.contracts[0].uncovered, ["graph_schema"]);
  assert.equal(report.uncovered, 1);
});

drives("a driven case that records no emitter fails the run, named", async () => {
  // The case still drives and still produces its class — what is missing is
  // the record of who emitted it, and a manifest silent about that measured
  // nothing a declaration can be checked against.
  const stripped = ticketsCases.map((entry) => {
    if (entry.class !== "tickets_manifest_stale") return entry;
    const copy = { ...entry };
    delete copy.emitter;
    return copy;
  });
  const report = await produceReport([{ ...ticketsManifest, cases: stripped }]);
  assert.deepEqual(report.contracts[0].malformed, ["tickets_manifest_stale"]);
  assert.equal(report.malformed, 1);
  const row = report.contracts[0].cases.find((entry) => entry.class === "tickets_manifest_stale");
  assert.equal(row.pass, true, "the class was still produced — the record, not the run, is what failed");
});

drives("a case naming no declared class fails the run, named", async () => {
  const extra = {
    ...ticketsManifest,
    cases: [
      ...ticketsCases,
      {
        class: "no_such_class",
        side: "runtime",
        emitter: "src/host/workflow-factory.mjs#recordPark",
        drive: { kind: "park_step", step: "dispatch_ticket_dag" },
      },
    ],
  };
  const report = await produceReport([extra]);
  assert.deepEqual(report.contracts[0].undeclared, ["no_such_class"]);
  assert.equal(report.undeclared, 1);
});

test("a case whose drive produces the wrong class fails, named", async () => {
  const fixture = ticketsManifest.fixture();
  const stale = ticketsCases.find((entry) => entry.class === "tickets_manifest_stale");
  // The same edge, asserted against a different class the same step also
  // carries: the produced set contains the carrier's reason, not this one.
  const result = await produceCase({ ...stale, class: "tickets_manifest_invalid" }, fixture, ticketsManifest.emitters);
  assert.equal(result.pass, false);
  assert.equal(result.class, "tickets_manifest_invalid");
  assert.ok(result.produced.includes("tickets_manifest_stale"));
});

test("a runtime case that drifts to the step's own reason fails", async () => {
  const fixture = ticketsManifest.fixture();
  const stale = ticketsCases.find((entry) => entry.class === "tickets_manifest_stale");
  // park_step holds no candidate edge open, so the step's own
  // no_transition_reason is what recordPark writes — the fixture trap this
  // guards is a case silently producing a step's declared reason rather than
  // the edge's.
  const drifted = { ...stale, drive: { kind: "park_step", step: "freeze_artifact" } };
  const result = await produceCase(drifted, fixture, ticketsManifest.emitters);
  assert.equal(result.pass, false);
  assert.ok(result.produced.includes("artifact_freeze_invalid"));
  assert.ok(!result.produced.includes("tickets_manifest_stale"));
});

test("a mutation the schema rejects cannot pass on the masking error", async () => {
  const fixture = workflowGraph.fixture();
  const unreachable = workflowCases.find((entry) => entry.class === "graph_step_unreachable");
  // Removing /recovery fails the schema, and validateGraph returns the shape
  // errors without reaching the reachability walk — so the expected class is
  // absent even though an error was produced.
  const masked = {
    ...unreachable,
    drive: { kind: "graph_validate", mutate: [{ op: "remove", path: "/recovery" }, ...unreachable.drive.mutate] },
  };
  const result = await produceCase(masked, fixture, workflowGraph.emitters);
  assert.equal(result.pass, false);
  assert.ok(result.produced.includes("graph_schema"));
  assert.ok(!result.produced.includes("graph_step_unreachable"));
});

test("a code written into the input is not a produced code", async () => {
  const fixture = workflowGraph.fixture();
  const found = workflowCases.find((entry) => entry.class === "graph_number_not_canonical");
  // The declared class is written into the document twice as a key, so the
  // parser's real refusal is the duplicate key. The declared class appearing
  // in the input — echoed inside the refusal's detail — is not a production.
  const planted = {
    ...found,
    drive: {
      kind: "graph_parse",
      text: '{"graph_number_not_canonical:":1,"graph_number_not_canonical:":2}',
    },
  };
  const result = await produceCase(planted, fixture, workflowGraph.emitters);
  assert.equal(result.pass, false);
  assert.deepEqual(result.produced, ["graph_duplicate_key"]);
});

test("a normal return is not a production, whatever the payload carries", async () => {
  const fixture = workflowGraph.fixture();
  const found = workflowCases.find((entry) => entry.class === "graph_number_not_canonical");
  // parseStrict returns this document normally — the declared class sits in a
  // field of the returned value, and a returned value is never a refusal.
  const payload = {
    ...found,
    drive: { kind: "graph_parse", text: '{"reason":"graph_number_not_canonical"}' },
  };
  const result = await produceCase(payload, fixture, workflowGraph.emitters);
  assert.equal(result.pass, false);
  assert.deepEqual(result.produced, []);
});

test("a class echoed inside a refusal's detail is not the produced code", async () => {
  const fixture = identityLock.fixture();
  // The declared class is planted inside a free-text field of the input — the
  // validator's refusal is `lock_requirement_unmet`, and the class that exists
  // only as input bytes is never collected.
  const planted = {
    class: "lock_schema",
    side: "design",
    emitter: "scripts/validate-runtime-identity-lock.mjs#validateLock",
    drive: {
      kind: "lock_validate",
      lock: [{ op: "replace", path: "/requirements/0/added_line", value: "lock_schema: planted" }],
    },
  };
  const result = await produceCase(planted, fixture, identityLock.emitters);
  assert.equal(result.pass, false);
  assert.ok(result.produced.includes("lock_requirement_unmet"), JSON.stringify(result.produced));
  assert.ok(!result.produced.includes("lock_schema"), JSON.stringify(result.produced));
});

drives("the executed manifests close against the producing namespace on disk", async () => {
  // Every `produce-refusals-*.cases.json` is case data an executed manifest
  // must declare, and every declared CASES_PATH must be one of those files,
  // once — a gap in either direction is a boundary leak the run refuses.
  const report = await defaultReport();
  assert.deepEqual(report.closure, { undriven: [], missing: [], duplicate: [] });
  assert.equal(report.unclosed, 0);
});

drives("a cases file on disk that no manifest declares fails the run, named", async () => {
  // The array entry gone but the import kept is the leak this closes: the
  // file is still read at module load, yet nothing drives its cases — the
  // report names it rather than letting the measured set silently shrink.
  const report = await produceReport([manifests[0]]);
  const expected = manifests.slice(1).map((manifest) => manifest.CASES_PATH).sort();
  assert.deepEqual(report.closure.undriven, expected);
  assert.equal(report.unclosed, expected.length);
});

drives("a manifest declaring a cases path outside the namespace fails the run, named", async () => {
  const moved = { ...manifests[0], CASES_PATH: "resources/workflow-graph/workflow-graph.v1.json" };
  const report = await produceReport([moved]);
  assert.deepEqual(report.closure.missing, ["resources/workflow-graph/workflow-graph.v1.json"]);
});

drives("two manifests declaring one cases file fails the run, named", async () => {
  const second = { ...manifests[1], CASES_PATH: manifests[0].CASES_PATH, cases: manifests[0].cases };
  const report = await produceReport([manifests[0], second]);
  assert.deepEqual(report.closure.duplicate, [manifests[0].CASES_PATH]);
});

drives("a manifest fixture function is not a signature that ran", async () => {
  const signature = "scripts/produce-refusals-tickets-manifest.mjs#document";
  const cases = ticketsCases.map((entry) =>
    entry.class === "tickets_manifest_stale" ? { ...entry, also: signature } : entry,
  );
  const report = await produceReport([{ ...ticketsManifest, cases }]);
  const row = report.contracts[0].cases.find((entry) => entry.class === "tickets_manifest_stale");
  assert.ok(row.harness.includes(signature), JSON.stringify(row.harness));
  assert.equal(row.unexecuted.includes(signature), false);
});

drives("a parser reached only by fixture parsing is not the resume case's emitter", async () => {
  const signature = "scripts/validate-workflow-graph.mjs#parseValue";
  const cases = workflowCases.map((entry) =>
    entry.class === "resume_target_not_permitted" && entry.drive.kind === "resume"
      ? { ...entry, emitter: signature }
      : entry,
  );
  const report = await produceReport([{ ...workflowGraph, cases }]);
  const row = report.contracts[0].cases.find(
    (entry) => entry.class === "resume_target_not_permitted" && entry.drive === "resume",
  );
  assert.ok(row.unexecuted.includes(signature), JSON.stringify(row.unexecuted));
});

test("a manifest's cases are loaded from its declared CASES_PATH", () => {
  // The declaration and the read are one value, loaded once through the
  // shared loader — a manifest cannot name one file while another file's
  // bytes drive its cases.
  for (const manifest of manifests) {
    assert.deepEqual(manifest.cases, loadCases(manifest.CASES_PATH));
  }
});

test("every producing module loads as the first import, in a fresh process", () => {
  // The manifests, the shared list, the runner and the validator form an
  // import cycle; a module that reads a manifest's exports during its own
  // evaluation crashes when that manifest is the entry point. One shared
  // process masks it — each module must load cleanly on its own.
  for (const module of [
    "scripts/produce-refusals-manifests.mjs",
    "scripts/produce-refusals-tickets-manifest.mjs",
    "scripts/produce-refusals-workflow-graph.mjs",
    "scripts/produce-refusals-runtime-identity-lock.mjs",
    "scripts/produce-refusals-refusal-vocabulary.mjs",
    "scripts/produce-refusals.mjs",
    "scripts/validate-refusal-vocabulary.mjs",
  ]) {
    const run = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import("./${module}")`],
      { cwd: realpathSync.native(ROOT), encoding: "utf8" },
    );
    assert.equal(run.status, 0, `${module} as first import: ${run.stderr.trim()}`);
  }
});

test("an emitter record is file#symbol — an empty or missing half is malformed", () => {
  // The record still has to be one file and one symbol. Whether that function
  // ran is a separate check, made from the coverage of the case.
  for (const bad of ["a.mjs#", "a.mjs##", "#f", "a.mjs", "", 7]) {
    assert.equal(caseEmitterFiles({ class: "x", emitter: bad }), null, JSON.stringify(bad));
  }
  assert.equal(caseEmitterFiles({ class: "x", emitter: "a.mjs#f", also: "b.mjs#" }), null);
  assert.deepEqual(
    [...caseEmitterFiles({ class: "x", emitter: "a.mjs#f", also: "b.mjs#g" })].sort(),
    ["a.mjs", "b.mjs"],
  );
});

drives("the report binds the source bytes it was produced from", async () => {
  const report = await defaultReport();
  assert.deepEqual(sourceDrift(ROOT, report.source), []);
  // The binding reaches what the run depended on: the emitters the closure
  // executes, the data each fixture opens, and the contract documents.
  const bound = new Set(report.source.files.map((file) => file.path));
  assert.ok(bound.has("src/host/workflow-factory.mjs"));
  assert.ok(bound.has("src/host/workflow-graph-canonical.mjs"));
  assert.ok(bound.has("scripts/validate-workflow-graph.mjs"));
  assert.ok(bound.has("resources/workflow-graph/workflow-graph.v1.json"));
  assert.ok(bound.has("docs/contracts/workflow-graph.md"));
  assert.ok(bound.has("scripts/produce-refusals-workflow-graph.cases.json"));
});

const DETECTOR = "scripts/validate-tickets-manifest-design.mjs#validateTicketsManifestDesign";
const TICKET_CASES = "scripts/produce-refusals-tickets-manifest.cases.json";
const VOCABULARY = "resources/refusal-vocabulary/refusal-vocabulary.v1.json";

function copyTree(dest) {
  cpSync(ROOT, dest, {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(ROOT, source);
      return (
        rel !== "node_modules" &&
        !rel.startsWith(`node_modules${path.sep}`) &&
        rel !== ".git" &&
        !rel.startsWith(`.git${path.sep}`)
      );
    },
  });
}

function runProduce(dest, args = ["scripts/produce-refusals.mjs"], env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: dest, env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function rewriteJson(dest, relative, edit) {
  const file = path.join(dest, relative);
  const value = JSON.parse(readFileSync(file, "utf8"));
  edit(value);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

async function withScratch(edit) {
  const scratch = mkdtempSync(path.join(tmpdir(), "produce-refusals-"));
  try {
    copyTree(scratch);
    edit(scratch);
    return await runProduce(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("a manifest module is part of the harness", () => {
  assert.equal(isHarnessFile("scripts/produce-refusals-tickets-manifest.mjs"), true);
  assert.equal(isHarnessFile("scripts/produce-refusals-workflow-graph.mjs"), true);
  assert.equal(isHarnessFile("scripts/produce-refusals.mjs"), true);
  assert.equal(isHarnessFile("scripts/validate-workflow-graph.mjs"), false);
  assert.equal(isHarnessFile("src/host/workflow-factory.mjs"), false);
});

drives("produceReport refuses NODE_V8_COVERAGE before measuring", async () => {
  const previous = process.env.NODE_V8_COVERAGE;
  process.env.NODE_V8_COVERAGE = path.join(tmpdir(), "produce-report-coverage-probe");
  try {
    await assert.rejects(
      () => produceReport(),
      (error) => error?.message === HOST_COVERAGE,
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_V8_COVERAGE;
    else process.env.NODE_V8_COVERAGE = previous;
  }
});

describe("public CLI checks", { concurrency: true }, () => {
drives("every file the run actually reads is bound by the report", async () => {
  // The closure is derived textually, so the binding's completeness is
  // measured, not argued: the runner is spawned under the ticket-8 fs
  // instrument (NODE_OPTIONS --import, so the patch precedes module linking —
  // and a dynamically imported module is a recorded read too), and every
  // recorded read must be bound. An empty record fails closed — the
  // instrument not taking cannot pass for coverage.
  const scratch = mkdtempSync(path.join(tmpdir(), "produce-reads-"));
  const logDir = path.join(scratch, "reads");
  const reportPath = path.join(scratch, "report.json");
  mkdirSync(logDir);
  const rootPath = realpathSync.native(ROOT);
  try {
    const run = await runProduce(
      rootPath,
      ["scripts/produce-refusals.mjs", "--out", reportPath],
      {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(path.join(ROOT, "scripts/lib/design-reads-instrument.mjs")).href}`.trim(),
        DESIGN_READS_LOG: logDir,
      },
    );
    assert.equal(run.status, 0, run.stderr);
    const reads = collectRecordedPaths(logDir);
    assert.ok(reads.size > 0, "the instrument recorded no reads — it did not take");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const bound = new Set(report.source.files.map((file) => file.path));
    // reduceToInputs drops directory listings (their member files are
    // recorded individually) and refuses the records it cannot pin; the
    // data inputs it yields must all be bound, and so must every file
    // record it sets aside as code — a module read is a dependency too.
    for (const input of reduceToInputs(reads, rootPath)) {
      assert.ok(bound.has(input), `measured input not bound: ${input}`);
    }
    const listings = report.source.listings ?? [];
    for (const record of reads) {
      const mark = record.indexOf("\t");
      const kind = mark === -1 ? "file" : record.slice(0, mark);
      const body = mark === -1 ? record : record.slice(mark + 1);
      const relative = toRepoRelative(body, rootPath);
      if (relative === null) continue;
      if (kind === "file") {
        assert.ok(bound.has(relative), `measured file read not bound: ${relative}`);
      } else if (kind === "dir") {
        // A directory read is a scan — a member added after the run must
        // refuse, so the report records a listing covering every scan the
        // instrument observed.
        const covered = listings.some(
          (listing) => relative === listing.dir || (listing.deep && relative.startsWith(`${listing.dir}/`)),
        );
        assert.ok(covered, `directory read not covered by a recorded listing: ${relative}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

drives("a signature naming a function that did not run fails the command, named", async () => {
  const run = await withScratch((dest) => {
    rewriteJson(dest, TICKET_CASES, (cases) => {
      cases.find((entry) => entry.class === "tickets_manifest_invalid").emitter =
        "src/host/workflow-factory.mjs#definitelyNotAnEmitter";
    });
  });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stdout, /\bunexecuted=1\b/u);
  assert.match(
    run.stderr,
    /UNEXECUTED tickets_manifest_invalid src\/host\/workflow-factory\.mjs#definitelyNotAnEmitter — the signature's function did not run during its case/u,
  );
});

drives("a detector file recorded as the emitter fails the command, named", async () => {
  const run = await withScratch((dest) => {
    rewriteJson(dest, TICKET_CASES, (cases) => {
      for (const name of ["tickets_manifest_invalid", "tickets_manifest_stale"]) {
        cases.find((entry) => entry.class === name).emitter = DETECTOR;
      }
    });
    rewriteJson(dest, VOCABULARY, (vocabulary) => {
      for (const entry of vocabulary.park_reasons) {
        if (entry.code === "tickets_manifest_invalid" || entry.code === "tickets_manifest_stale") {
          entry.producer_files = ["scripts/validate-tickets-manifest-design.mjs"];
        }
      }
      vocabulary.vocabulary_digest = vocabularyDigest(vocabulary);
    });
  });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stdout, /\bunexecuted=2\b/u);
  for (const name of ["tickets_manifest_invalid", "tickets_manifest_stale"]) {
    assert.match(
      run.stderr,
      new RegExp(
        `UNEXECUTED ${name} scripts/validate-tickets-manifest-design\\.mjs#validateTicketsManifestDesign — the signature's function did not run during its case`,
        "u",
      ),
    );
  }
});

drives("a detector file recorded as also fails the command, named", async () => {
  const run = await withScratch((dest) => {
    rewriteJson(dest, TICKET_CASES, (cases) => {
      for (const name of ["tickets_manifest_invalid", "tickets_manifest_stale"]) {
        cases.find((entry) => entry.class === name).also = DETECTOR;
      }
    });
    rewriteJson(dest, VOCABULARY, (vocabulary) => {
      for (const entry of vocabulary.park_reasons) {
        if (entry.code === "tickets_manifest_invalid" || entry.code === "tickets_manifest_stale") {
          entry.producer_files = [...entry.producer_files, "scripts/validate-tickets-manifest-design.mjs"];
        }
      }
      vocabulary.vocabulary_digest = vocabularyDigest(vocabulary);
    });
  });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stdout, /\bunexecuted=2\b/u);
  for (const name of ["tickets_manifest_invalid", "tickets_manifest_stale"]) {
    assert.match(
      run.stderr,
      new RegExp(
        `UNEXECUTED ${name} scripts/validate-tickets-manifest-design\\.mjs#validateTicketsManifestDesign — the signature's function did not run during its case`,
        "u",
      ),
    );
  }
});

drives("the runner is not a producer of a park reason", async () => {
  const signature = "scripts/produce-refusals.mjs#collectWrites";
  const run = await withScratch((dest) => {
    rewriteJson(dest, TICKET_CASES, (cases) => {
      cases.find((entry) => entry.class === "tickets_manifest_invalid").emitter = signature;
    });
    rewriteJson(dest, VOCABULARY, (vocabulary) => {
      vocabulary.park_reasons.find((entry) => entry.code === "tickets_manifest_invalid").producer_files = [
        "scripts/produce-refusals.mjs",
      ];
      vocabulary.vocabulary_digest = vocabularyDigest(vocabulary);
    });
  });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stdout, /\bharness=1\b/u);
  assert.match(run.stdout, /\bunexecuted=0\b/u);
  assert.match(
    run.stderr,
    /HARNESS tickets_manifest_invalid scripts\/produce-refusals\.mjs#collectWrites — the signature names the produce-refusals harness, not a producer/u,
  );
  assert.doesNotMatch(run.stderr, /UNEXECUTED tickets_manifest_invalid scripts\/produce-refusals\.mjs#collectWrites/u);
});

drives("fixture parsing is not the build case's emitter", async () => {
  const signature = "scripts/validate-workflow-graph.mjs#parseStrict";
  const run = await withScratch((dest) => {
    rewriteJson(dest, "scripts/produce-refusals-workflow-graph.cases.json", (cases) => {
      const row = cases.find((entry) => entry.class === "graph_digest_stale" && entry.drive.kind === "graph_build");
      row.emitter = signature;
    });
  });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stdout, /\bunexecuted=1\b/u);
  assert.match(run.stderr, /UNEXECUTED graph_digest_stale scripts\/validate-workflow-graph\.mjs#parseStrict — /u);
});

test("a host coverage session is refused by name", async () => {
  const coverageDir = mkdtempSync(path.join(tmpdir(), "produce-host-coverage-"));
  try {
    const run = await runProduce(realpathSync.native(ROOT), ["scripts/produce-refusals.mjs"], {
      ...process.env,
      NODE_V8_COVERAGE: coverageDir,
    });
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stderr, new RegExp(`^${HOST_COVERAGE}$`, "mu"));
    assert.doesNotMatch(run.stderr, /^Error:/mu);
    assert.doesNotMatch(run.stderr, /^\s+at /mu);
  } finally {
    rmSync(coverageDir, { recursive: true, force: true });
  }
});
});
