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
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { ROOT, produceCase, produceReport } from "../scripts/produce-refusals.mjs";
import { sourceDrift } from "../scripts/lib/produced-source.mjs";
import { collectRecordedPaths, reduceToInputs, toRepoRelative } from "../scripts/lib/measured-inputs.mjs";
import * as ticketsManifest from "../scripts/produce-refusals-tickets-manifest.mjs";
import * as workflowGraph from "../scripts/produce-refusals-workflow-graph.mjs";
import * as identityLock from "../scripts/produce-refusals-runtime-identity-lock.mjs";

test("every declared case produces its own class", async () => {
  const report = await produceReport();
  const failures = report.contracts.flatMap((entry) => entry.cases.filter((row) => !row.pass));
  assert.deepEqual(failures.map((row) => row.class), []);
  assert.equal(report.passed, report.cases);
});

test("the declared cases cover each contract's measured closed set exactly", async () => {
  // The floor is the contract's own class list as `measureContracts` reads it,
  // not a count typed into this file — a class added to a contract without a
  // case fails `uncovered`, and a case naming no declared class fails
  // `undeclared`, both with the name attached.
  const report = await produceReport();
  assert.equal(report.cases, report.contracts.reduce((sum, entry) => sum + entry.declared, 0));
  for (const entry of report.contracts) {
    assert.deepEqual(entry.uncovered, [], `${entry.contract} declares classes no case produces`);
    assert.deepEqual(entry.undeclared, [], `${entry.contract} has cases outside its closed set`);
  }
});

test("a declared class with no case fails the run, named", async () => {
  const short = {
    ...workflowGraph,
    cases: workflowGraph.cases.filter((entry) => entry.class !== "graph_schema"),
  };
  const report = await produceReport([short]);
  assert.deepEqual(report.contracts[0].uncovered, ["graph_schema"]);
  assert.equal(report.uncovered, 1);
});

test("a case naming no declared class fails the run, named", async () => {
  const extra = {
    ...ticketsManifest,
    cases: [
      ...ticketsManifest.cases,
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
  const stale = ticketsManifest.cases.find((entry) => entry.class === "tickets_manifest_stale");
  // The same edge, asserted against a different class the same step also
  // carries: the produced set contains the carrier's reason, not this one.
  const result = await produceCase({ ...stale, class: "tickets_manifest_invalid" }, fixture, ticketsManifest.emitters);
  assert.equal(result.pass, false);
  assert.equal(result.class, "tickets_manifest_invalid");
  assert.ok(result.produced.includes("tickets_manifest_stale"));
});

test("a runtime case that drifts to the step's own reason fails", async () => {
  const fixture = ticketsManifest.fixture();
  const stale = ticketsManifest.cases.find((entry) => entry.class === "tickets_manifest_stale");
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
  const unreachable = workflowGraph.cases.find((entry) => entry.class === "graph_step_unreachable");
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
  const found = workflowGraph.cases.find((entry) => entry.class === "graph_number_not_canonical");
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
  const found = workflowGraph.cases.find((entry) => entry.class === "graph_number_not_canonical");
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

test("the report binds the source bytes it was produced from", async () => {
  const report = await produceReport();
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

test("every file the run actually reads is bound by the report", async () => {
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
    const run = spawnSync(
      process.execPath,
      ["scripts/produce-refusals.mjs", "--out", reportPath],
      {
        cwd: rootPath,
        env: {
          ...process.env,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(path.join(ROOT, "scripts/lib/design-reads-instrument.mjs")).href}`.trim(),
          DESIGN_READS_LOG: logDir,
        },
        encoding: "utf8",
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
