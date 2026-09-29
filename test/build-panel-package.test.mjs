/**
 * Tests for the review package the final panel reads (#39).
 *
 * Round 1 returned four `fail` verdicts, and several findings were about the
 * package rather than the design: it told the seats that twenty-two contracts
 * declared no closed refusal set when every one of them did, and it truncated
 * the digests a seat would need to recompute what it was reviewing. A package
 * defect costs a whole panel round, so the parts that decide what a seat sees
 * are tested here.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { FULL_TEXT, ROOT, buildPackage, contractOutline, measureContracts, namesRefusal, panelRecords, testSummary } from "../scripts/build-panel-package.mjs";
import { MEASURER_FILES } from "../scripts/lib/seam-engine-gate.mjs";
import { bindSource, digestOf, sourceDrift } from "../scripts/lib/produced-source.mjs";
import { PANEL_BY_ROUND, panelVerdicts, validatePanelRound } from "../scripts/validate-design-candidate.mjs";
import { UNPINNED_DAEMON_PRIMITIVES } from "../src/host/daemon-preflight.mjs";
import { cleanRoomRun, coverageReport, faultCoverage, harnessCoverage, identityAcrossRun } from "../scripts/clean-room-e2e.mjs";
import { stubbedSteps } from "./support/clean-room-steps.mjs";

const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

const contractNames = readdirSync(path.join(ROOT, "docs/contracts")).filter((name) => name.endsWith(".md")).sort();
const contracts = contractNames.map((name) => ({
  path: `docs/contracts/${name}`,
  ...contractOutline(read(`docs/contracts/${name}`)),
}));

const candidate = JSON.parse(read("resources/design-candidate/design-candidate.v1.json"));
const matrix = JSON.parse(read("resources/clean-room-e2e/fault-matrix.v1.json"));
const compat = JSON.parse(read("compat/autosk/manifest.v1.json"));

// Only the fault harness's own cases carry a control; F001 belongs to the
// crash harness, which is exactly the difference the table has to show.
// Review of 10h (Low): the build refuses a run that did not run every
// fault-harness group, so the fixture carries a record for each; F020 keeps
// its full record, the others a minimal one.
const FAULTS = [
  ...matrix.groups
    .filter((group) => group.injection !== "real_path" && group.id !== "F020")
    .map((group) => ({ id: group.id, detected: true, control: true, detail: `${group.id} detail`, git_ref_writes: { fixture: [], fault: [] } })),
  {
    id: "F020",
    detected: true,
    control: true,
    detail: "the audit copy exists while the live one still does",
    git_ref_writes: { fixture: ["commit", "update-ref --create-reflog refs/autosk/epics/k/planning"], fault: ["update-ref --create-reflog refs/autosk/epics/k/audit", "update-ref -d refs/autosk/epics/k/candidate"] },
  },
];

// Debt 11f (R7-6): the daemon harnesses' steps in the shape they print them,
// and a coverage table the run's own functions derive from these records —
// it used to be written here as `covered_by_real_fault: 20`, the count the
// run printed and the contract does not allow.
const DAEMON_STEPS = [
  {
    step: "harness:crash",
    ok: true,
    summary: {
      passed: 6,
      cases: ["reservation.before", "reservation.after", "task.before", "task.after", "activation.before", "activation.after"].map((point) => ({ point })),
    },
  },
  { step: "harness:identity", ok: true, summary: { passed: 6, evidence: { fault: "F004", control: "resumed under the admitted digest" } } },
];

const cleanRoom = {
  faults: FAULTS,
  upstream_commit: compat.upstream.commit,
  source_tree: compat.result_tree,
  extension: { commit: "c".repeat(40), tree: "t".repeat(40), dirty: false },
  report_digest: "r".repeat(64),
  ok: true,
  steps: [{ step: "prepare", ok: true }, ...DAEMON_STEPS],
  coverage: coverageReport(matrix, { ...harnessCoverage(DAEMON_STEPS), ...faultCoverage({ results: FAULTS }) }),
};
const mutation = {
  totals: { modules: 49, mutants: 513, killed: 513 },
  modules: [
    { module: "src/host/approved-delta.mjs", test: "test/runtime-approved-delta.test.mjs", mutants: 31, killed: 31 },
    { module: "src/host/doctor-checks.mjs", test: "test/runtime-doctor.test.mjs", mutants: 0, killed: 0 },
  ],
  survivors: [],
  rules: ["demand(", "errors.push("],
  report_digest: "m".repeat(64),
};

const vocabulary = JSON.parse(read("resources/refusal-vocabulary/refusal-vocabulary.v1.json"));

const TESTS = Object.freeze({
  tests: 1770, passed: 1769, failed: 0, cancelled: 0, skipped: 1, todo: 0,
  skipped_names: [{ name: "a case folded by the filesystem", reason: "filesystem does not fold case" }],
  failed_names: [],
});

const build = (overrides = {}) => buildPackage({
  commit: "c".repeat(40),
  tree: "t".repeat(40),
  candidate,
  cleanRoom,
  matrix,
  mutation,
  compat,
  // Debt 10h (a1 low): the skipped test is reported by name, so the fixture
  // carries the run's skipped count and names, as a real log gives them.
  tests: TESTS,
  contracts,
  vocabulary,
  // The band is required evidence: builds under test carry a valid record
  // unless they are the refusal-path tests, which pass null plus a reason.
  migrationSeam: seamRecord(),
  ...overrides,
});

test("a closed refusal set is read in both forms a contract may use", () => {
  // Reading only the inline sentence is how round 1 was told that twenty-two
  // contracts declared no closed set when every one of them did.
  const inline = contractOutline("## 3. Rules\n\nClosed set: `alpha_one`, `beta_two`.\n");
  assert.deepEqual(inline.refusals, ["alpha_one", "beta_two"]);
  assert.equal(inline.form, "inline");

  // The lead-in sentence names no codes, so the section is the only source
  // here; what matters is that the codes are found, not which sentence led.
  const bulleted = contractOutline("## 8. Refusal classes\n\nClosed set, so a caller may branch:\n\n- `alpha_one` — a reason;\n- `beta_two` — another;\n");
  assert.deepEqual(bulleted.refusals, ["alpha_one", "beta_two"]);
  assert.equal(bulleted.form, "section");

  // The inline reader took everything up to the end of the paragraph, so a name
  // mentioned in a bullet's explanation became a tenth class in a set of nine —
  // `docs/contracts/artifact-write-receipt.md` declares nine and the row said
  // ten. Only the enumeration itself is the declaration.
  const explained = contractOutline(
    "## 8. Refusal classes\n\nClosed set, so a caller may branch on them:\n\n- `alpha_one` — the destination is not what `expected_previous` says;\n- `beta_two` — another.\n",
  );
  assert.deepEqual(explained.refusals, ["alpha_one", "beta_two"]);
  assert.equal(explained.form, "section");

  // An enumeration that wraps across lines is still one enumeration, and the
  // sentence after it is not part of it.
  const wrapped = contractOutline(
    'Closed set, each carrying the file:\n`alpha_one`, `beta_two`,\n`gamma_three`. "Not resolved" is not one of them, nor is `delta_four`.\n',
  );
  assert.deepEqual(wrapped.refusals, ["alpha_one", "beta_two", "gamma_three"]);
  assert.equal(wrapped.form, "inline");

  // The line may wrap before the joining word as well as after the comma. An
  // editor's reflow is not a change to the declared set.
  const beforeAnd = contractOutline("Closed set: `alpha_one`\nand `beta_two`.\n");
  assert.deepEqual(beforeAnd.refusals, ["alpha_one", "beta_two"]);

  // But a blank line ends it: the next paragraph is prose, whatever it opens with.
  const paragraph = contractOutline("Closed set: `alpha_one`,\n\nand `beta_two` is something else entirely.\n");
  assert.deepEqual(paragraph.refusals, ["alpha_one"]);

  const section = contractOutline("## 6. Refusal classes\n\n- `alpha_one`;\n- `beta_two`;\n");
  assert.deepEqual(section.refusals, ["alpha_one", "beta_two"]);
  assert.equal(section.form, "section");

  assert.deepEqual(contractOutline("# A contract\n\nNo refusals here.\n").refusals, []);
  assert.equal(contractOutline("# A contract\n").form, "none");
});

test("every shipped contract reports a closed set, and the package says so", async () => {
  const open = contracts.filter((entry) => entry.refusals.length === 0);
  assert.deepEqual(open.map((entry) => entry.path), []);
  const { text } = await build();
  assert.match(text, /\*\*\d+ contracts, \d+ refusal classes, 0 declaring no closed set\.\*\*/u);
  assert.match(text, /Every contract closes its own set\./u);
});

test("a seat can recompute the candidate digest from the table it is given", async () => {
  const { text } = await build();
  for (const file of candidate.files) {
    // Full digests, not prefixes: a truncated digest cannot be recomputed, and
    // a verdict about a digest nobody can recompute is a verdict about a claim.
    assert.match(text, new RegExp(`\`${file.sha256}\``, "u"));
  }
  assert.match(text, /candidate_digest = sha256\(/u);
});

test("the package names the delivered source as upstream plus the patch series", async () => {
  // The design rests on three primitives the published upstream does not
  // implement; a package that named only the upstream commit would be showing
  // the panel a daemon that cannot support the design under review.
  const { text } = await build();
  assert.match(text, new RegExp(compat.upstream.commit, "u"));
  assert.match(text, new RegExp(`${compat.patches.length}, each SHA-256 pinned`, "u"));
  assert.match(text, new RegExp(compat.result_tree, "u"));
});

test("the package says which primitives the series supplies and which it does not", async () => {
  // Round 5 of #39 (R5-1): the package said the series supplies ADR-014, ADR-023
  // and ADR-025. It supplies the first; the other two, and the ref-custody
  // helper, exist nowhere, and the preflight refuses every daemon until they do.
  const { text } = await build();
  assert.doesNotMatch(text, /the series supplies them/u);
  assert.match(text, /the series supplies the first of them and not the other two/u);
  assert.equal(UNPINNED_DAEMON_PRIMITIVES.length, 2);
  for (const primitive of UNPINNED_DAEMON_PRIMITIVES) {
    assert.ok(text.includes(`\`${primitive.name}\` (${primitive.adr})`), primitive.name);
  }
  // Debt 10h (R6-20): this bullet named F017–F020 as the groups that exercise
  // Git directly; the run shows more of them do. The groups are now read from
  // the run's own record of the ref-writing git commands each case ran.
  // ADR-102, fix round 2 of debt 12a: the helper runs as the installing user,
  // so the boundary no fault group shows is the model account's (was: "the
  // separate-account boundary").
  assert.ok(text.includes("no fault group shows anything about a helper-mediated CAS or the\n  model account's boundary"), text);
  assert.doesNotMatch(text, /separate-account/u);
  assert.doesNotMatch(text, /planning-publication fault groups/u);
  assert.ok(text.includes("`src/git/ref-custody-helper.ts`) does not exist"));
  assert.match(text, /the preflight refuses every daemon today, including the one this series builds/u);
});

test("the fault matrix is stated with its denominator and its groups", async () => {
  const { text } = await build();
  assert.match(text, new RegExp(`\\*\\*${matrix.groups.length} groups\\*\\*`, "u"));
  for (const group of matrix.groups) assert.match(text, new RegExp(`\`${group.id}\``, "u"));
});

test("the run was about the reviewed bytes, or the package refuses it", async () => {
  const same = await build();
  assert.match(same.text, /same bytes as the version under review \| yes/u);
  assert.match(same.text, /worktree clean at run time \| yes/u);

  // Review of 11f (M1): the coverage is recomputed from the run's records,
  // which are about the tree the run exercised; a run over other bytes, or
  // over a dirty worktree, is refused rather than printed beside a "NO".
  await assert.rejects(
    build({ cleanRoom: { ...cleanRoom, extension: { commit: "9".repeat(40), tree: "9".repeat(40), dirty: false } } }),
    /the clean-room run exercised tree 9{40}, and this package is built over t{40}/u,
  );
  await assert.rejects(
    build({ cleanRoom: { ...cleanRoom, extension: { ...cleanRoom.extension, dirty: true } } }),
    /the clean-room run exercised a dirty worktree/u,
  );
  await assert.rejects(
    build({ cleanRoom: { ...cleanRoom, extension: { commit: null, tree: null, dirty: null } } }),
    /the clean-room run recorded no extension tree/u,
  );
  // CodeRabbit on #271: an extension that moved during the run is recorded as
  // not clean, naming both identities, and the refusal says so rather than
  // calling the worktree dirty.
  const moved = identityAcrossRun(cleanRoom.extension, { ...cleanRoom.extension, commit: "d".repeat(40), tree: "u".repeat(40) });
  assert.equal(moved.dirty, null);
  await assert.rejects(
    build({ cleanRoom: { ...cleanRoom, extension: moved } }),
    new RegExp(`the clean-room run cannot say its worktree of t{40} was clean: extension moved during the run: c{40} \\(tree t{40}, clean\\) -> d{40} \\(tree u{40}, clean\\)`, "u"),
  );
});

test("a report the clean-room run itself writes is one the package builds from", async () => {
  // Review of 11g (C1): the first start-and-end identity read recorded no
  // tree on the run's success, so every new report was refused here; the
  // fixtures above were written by hand and could not show it. This report
  // is the run's own, over stubbed steps that answer as the fixtures do.
  const identity = { ...cleanRoom.extension, error: null };
  const { io } = stubbedSteps({
    identities: [identity],
    receipt: { source_tree: compat.result_tree, upstream_commit: compat.upstream.commit },
    answers: Object.fromEntries(DAEMON_STEPS.map((step) => [step.step, { ok: true, stdout: `${JSON.stringify(step.summary)}\n`, ms: 1 }])),
    faults: { ok: true, detected: FAULTS.length, controlled: FAULTS.length, total: FAULTS.length, results: FAULTS },
  });
  const report = await cleanRoomRun({ io });
  assert.equal(report.ok, true);
  assert.deepEqual(report.extension, identity);
  const { text } = await build({ cleanRoom: report });
  assert.match(text, /extension tree exercised \| `t{40}`/u);
  assert.match(text, /worktree clean at run time \| yes/u);
});

test("a reason owned by the workflow is shown as owned, not as missing", async () => {
  // From the package alone, an alignment park reason appears in no contract's
  // closed set — three seats read that as unowned across two rounds. The owner
  // is a recorded field, so the package states the split rather than leaving a
  // reader to infer it from an absence.
  const { text } = await build();
  const byContract = vocabulary.park_reasons.filter((entry) => entry.closed_by.startsWith("docs/")).length;
  assert.match(text, new RegExp(`\\*\\*${vocabulary.park_reasons.length} park reasons\\.\\*\\*`, "u"));
  assert.match(text, new RegExp(`${byContract}\\s*\\n?are closed by the artifact contract`, "u"));
  assert.match(text, /alignment park\s*\n?reasons appear in no contract's closed set/u);
});

test("a contract with no measured link says that, not that nothing runs", async () => {
  // The cell read "none — design only in this version", which is a claim the
  // measurement cannot support: `src/host/gate-projection.mjs` evaluates
  // `gate-store-projection.md` and every heuristic missed it, so the row denied
  // an implementation that exists. The absence of a link is now reported as the
  // absence of a link.
  const { text } = await build();
  assert.match(text, /Where each contract's rules are evaluated/u);
  assert.match(text, /no link measured/u);
  assert.doesNotMatch(text, /design only in this version/u);
  assert.match(text, /\*\*not\*\* that nothing evaluates the contract/u);
});

test("a contract is linked to the module that evaluates it, whatever the module is called", async () => {
  // The row was computed by a filename guess: `docs/contracts/<stem>.md` had to
  // meet `src/host/<stem>.mjs`. So the workflow-graph contract printed "design
  // only" while `src/host/workflow-graph-canonical.mjs` evaluated its canonical
  // form, and no stem can ever reach that name. The link is measured instead,
  // and each one says which measurement carried it.
  const measured = await measureContracts();
  const graph = measured.find((entry) => entry.path === "docs/contracts/workflow-graph.md");
  // The factory joined the canonical module when the production manifest began
  // reading the contract through it: `select`, `admit` and `recordPark` in it
  // are the runtime emitters, so the import link is real.
  assert.deepEqual(graph.evaluators, [
    {
      module: "src/host/workflow-factory.mjs",
      link: "import",
      via: ["scripts/produce-refusals-workflow-graph.mjs"],
    },
    {
      module: "src/host/workflow-graph-canonical.mjs",
      link: "import",
      via: ["scripts/produce-refusals-workflow-graph.mjs", "scripts/validate-workflow-graph.mjs"],
    },
  ]);

  // And the case no heuristic could reach: the name differs from the stem, the
  // document validator does not import it, and nothing in it names the contract.
  // `src/host/gate-projection.mjs` evaluates `gate-store-projection.md` — the
  // whole closed park set is in it — and the row said "design only". It is found
  // now because the module declares what it implements.
  const projection = measured.find((entry) => entry.path === "docs/contracts/gate-store-projection.md");
  assert.deepEqual(
    projection.evaluators.map((entry) => [entry.module, entry.link]),
    [["src/host/gate-projection.mjs", "implements"]],
  );
  assert.equal(projection.refusals_named, projection.refusals.length);

  const doctor = measured.find((entry) => entry.path === "docs/contracts/doctor-report.md");
  assert.deepEqual(
    doctor.evaluators.map((entry) => [entry.module, entry.link]),
    [["src/host/doctor.mjs", "implements"]],
  );

  // A stem that happens to match is still reported, and reported as what it is.
  const gates = measured.find((entry) => entry.path === "docs/contracts/work-type-gates.md");
  assert.deepEqual(
    gates.evaluators.map((entry) => [entry.module, entry.link]),
    [["src/host/work-type-gates.mjs", "name"]],
  );

  for (const entry of measured) {
    for (const evaluator of entry.evaluators) {
      assert.ok(["import", "implements", "name"].includes(evaluator.link), `${entry.path}: ${evaluator.link}`);
    }
  }
});

test("a declared link is checked against the contract it claims", async () => {
  // A declaration nobody verifies is the hand-kept list it replaced. Every
  // `Implements:` marker has to name a contract that exists and a refusal class
  // that contract declares, or the marker is a claim and not a measurement.
  const measured = await measureContracts();
  const byPath = new Map(measured.map((entry) => [entry.path, entry]));
  const declared = [];
  for (const name of readdirSync(path.join(ROOT, "src/host")).sort()) {
    if (!name.endsWith(".mjs")) continue;
    const module = `src/host/${name}`;
    const text = read(module);
    for (const match of text.matchAll(/\bImplements:\s*(\S+)/gu)) {
      const contract = byPath.get(match[1]);
      assert.ok(contract, `${module} declares ${match[1]}, which is not a contract`);
      assert.ok(
        contract.refusals.some((code) => namesRefusal(text, code)),
        `${module} declares ${match[1]} and names none of its refusal classes`,
      );
      assert.ok(
        contract.evaluators.some((entry) => entry.module === module),
        `${module} declares ${match[1]} and is not linked to it`,
      );
      declared.push(module);
    }
  }
  // The declarations are the point of the mechanism; an empty set would make
  // every assertion above vacuous.
  assert.ok(declared.length >= 16, `${declared.length} declarations`);
});

test("the count is over whole names from the declared set, not substrings of them", async () => {
  // Two ways the number lied about `artifact-write-receipt.md`. Its set is nine
  // classes; the parser read the field name `expected_previous` out of a bullet's
  // explanation as a tenth, and then `includes` found that name inside
  // `expected_previous_sha256` in `src/host/write-driver.mjs`. The row printed
  // `10 of 10` for a contract that declares nine.
  const measured = await measureContracts();
  const receipt = measured.find((entry) => entry.path === "docs/contracts/artifact-write-receipt.md");
  assert.equal(receipt.refusals.length, 9);
  assert.ok(!receipt.refusals.includes("expected_previous"), receipt.refusals.join(","));
  assert.equal(receipt.refusals_named, 9);

  // The helper itself, both directions: a class name is not named by an
  // identifier that merely contains it, at either end.
  assert.ok(namesRefusal("if (!expected_previous) return;", "expected_previous"));
  assert.ok(!namesRefusal("const expected_previous_sha256 = x;", "expected_previous"));
  assert.ok(!namesRefusal("const prefix_expected_previous = x;", "expected_previous"));
  assert.ok(namesRefusal("throw new Error('expected_previous');", "expected_previous"));

  // And a class that only occurs inside a longer identifier is not named.
  const { text } = await build({
    contracts: [
      {
        path: "docs/contracts/one.md",
        readers: [],
        evaluators: [{ module: "src/host/only.mjs", link: "implements" }],
        headings: ["1. Rules"],
        form: "inline",
        refusals: ["alpha_one", "beta_two"],
        refusals_named: 1,
      },
    ],
    mutation: { ...mutation, modules: [{ module: "src/host/only.mjs", test: "t", mutants: 3, killed: 3 }] },
  });
  assert.match(text, /\| `docs\/contracts\/one\.md` \| `src\/host\/only\.mjs` \(3\/3, declared\) \| 1 of 2 \|/u);
});

test("the row counts how many of a contract's refusal classes the code names", async () => {
  // The links say where to look. This is the only column that says what is
  // there — and it makes a partial implementation a number instead of an
  // adjective: the creation-grant contract's signing half is simply absent.
  const measured = await measureContracts();
  const grant = measured.find((entry) => entry.path === "docs/contracts/creation-grant.md");
  assert.equal(grant.refusals.length, 9);
  assert.equal(grant.refusals_named, 3);

  const { text } = await build({ contracts: measured });
  assert.match(text, /\| `docs\/contracts\/creation-grant\.md` \| [^|]*\| 3 of 9 \|/u);
  assert.match(text, /\| `docs\/contracts\/gate-store-projection\.md` \| [^|]*\| 8 of 8 \|/u);
  // A contract with no module linked has nothing to count, and says so rather
  // than printing a zero that reads as a measurement.
  assert.match(text, /\| `docs\/contracts\/debate\.md` \| no link measured \| not measured — no module linked \|/u);
});

test("the row separates reading the contract from evaluating its rules", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const { text } = await build({
    contracts: [
      {
        path: graph,
        readers: ["scripts/validate-workflow-graph.mjs"],
        evaluators: [
          { module: "src/host/absent.mjs", link: "implements" },
          { module: "src/host/workflow-graph-canonical.mjs", link: "import", via: ["scripts/validate-workflow-graph.mjs"] },
          { module: "src/host/workflow-preflight.mjs", link: "name" },
        ],
        refusals_named: 2,
        ...contractOutline(read(graph)),
      },
    ],
    mutation: {
      ...mutation,
      modules: [
        { module: "src/host/workflow-graph-canonical.mjs", test: "test/workflow-graph.test.mjs", mutants: 19, killed: 18 },
        { module: "src/host/workflow-preflight.mjs", test: "test/workflow-preflight.test.mjs", mutants: 0, killed: 0 },
      ],
    },
  });
  // Reading the document and scoring the guards are two different facts, and a
  // module the mutation table never scored is a third. Each is on the row.
  const outline = contractOutline(read(graph));
  assert.match(
    text,
    new RegExp(
      "\\| `docs/contracts/workflow-graph\\.md` \\| `src/host/absent\\.mjs` \\(not in the mutation table, declared\\); " +
        "`src/host/workflow-graph-canonical\\.mjs` \\(18/19, imported by `scripts/validate-workflow-graph\\.mjs`\\); " +
        `\`src/host/workflow-preflight\\.mjs\` \\(no mutable guard, name match only\\) \\| 2 of ${outline.refusals.length} \\| ` +
        "not in the produced run \\| `scripts/validate-workflow-graph\\.mjs` \\|",
      "u",
    ),
  );
});

const EMPTY_CLOSURE = { undriven: [], missing: [], duplicate: [] };
const COUNT_TAIL = "so the produced count above is of declared classes confirmed produced by a passing case, not of classes driven.";

function produceSentence(text) {
  const start = text.indexOf("`npm run produce:refusals` drives ");
  assert.notEqual(start, -1, "the package has no produce:refusals sentence");
  const end = text.indexOf("Node runtime it ran under.", start);
  assert.notEqual(end, -1, "the produce:refusals sentence does not close");
  return text.slice(start, end);
}

// Every declared class has a passing case, so a signature or closure deviation
// is the only thing the clause can be about.
function coveredCases(graph) {
  return contractOutline(read(graph)).refusals.map((name) => ({ class: name, pass: true, produced: [name] }));
}

function stampEntry(entry) {
  return {
    ...entry,
    malformed: entry.malformed ?? [],
    uncovered: entry.uncovered ?? [],
    undeclared: entry.undeclared ?? [],
  };
}

function boundReport(graph, { cases, malformed = [], uncovered = [], undeclared = [], closure = EMPTY_CLOSURE, contracts, casesAggregate } = {}) {
  const entries = (contracts ?? [{ contract: graph, malformed, uncovered, undeclared, cases }]).map(stampEntry);
  const rows = entries.reduce((sum, entry) => sum + entry.cases.length, 0);
  return {
    source: bindSource(ROOT, [graph]),
    cases: casesAggregate ?? rows,
    closure,
    contracts: entries,
  };
}

test("a produced report with more cases than classes does not call the cases classes", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const produced = {
    source: bindSource(ROOT, [graph]),
    cases: 2,
    closure: EMPTY_CLOSURE,
    contracts: [
      {
        contract: graph,
        malformed: [],
        uncovered: [],
        undeclared: [],
        produced: 1,
        of: 2,
        cases: [
          { class: "graph_schema", pass: true, produced: ["graph_schema"] },
          { class: "graph_schema", pass: true, produced: ["graph_schema"] },
        ],
      },
    ],
  };
  const { text } = await build({ produced });
  assert.match(text, /drives 2 cases over 1 refusal class/u);
  assert.doesNotMatch(text, /2 refusal classes/u);
});

test("signatures that did not run or name the harness do not read as a clean run", async () => {
  // Every case passes and every declared class is produced. That is the shape
  // that read as clean: the not-clean list looked only at pass and produced,
  // so a signature that did not run, or one that names the harness, never
  // reached the sentence a seat reads.
  const graph = "docs/contracts/workflow-graph.md";
  const outline = contractOutline(read(graph));
  const cases = outline.refusals.map((name, index) => ({
    class: name,
    pass: true,
    produced: [name],
    unexecuted: index === 0 ? ["src/host/workflow-graph-canonical.mjs#canonicalString"] : [],
    harness: index === 1 ? ["scripts/produce-refusals.mjs#collectWrites"] : [],
  }));
  assert.ok(cases.length > 1, "the fixture needs two cases so each array is its own signature");
  const produced = boundReport(graph, { cases });
  const { text } = await build({ produced });
  const clause = produceSentence(text);
  assert.match(clause, new RegExp(`drives ${cases.length} cases over ${cases.length} refusal classes`, "u"));
  // Signatures do not change the produced count, so the tail does not follow them.
  assert.match(
    clause,
    /The bound run is not clean — one signature's function did not run during its case; one signature names the produce-refusals harness, not a producer\./u,
  );
  assert.doesNotMatch(clause, new RegExp(COUNT_TAIL, "u"));
  assert.doesNotMatch(clause, /\bcases? failed\b/u);
});

test("a malformed record is named and does not qualify the produced count", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const produced = boundReport(graph, { cases: coveredCases(graph), malformed: ["graph_schema"] });
  const sentence = produceSentence((await build({ produced })).text);
  assert.match(
    sentence,
    /The bound run is not clean — one driven case \(`graph_schema`\) records no emitter it can be traced to\./u,
  );
  assert.doesNotMatch(sentence, new RegExp(COUNT_TAIL, "u"));
});

test("an undriven cases file is named and does not qualify the produced count", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const casesPath = "scripts/produce-refusals-zz-undriven.cases.json";
  const produced = boundReport(graph, {
    cases: coveredCases(graph),
    closure: { undriven: [casesPath], missing: [], duplicate: [] },
  });
  const sentence = produceSentence((await build({ produced })).text);
  assert.match(
    sentence,
    new RegExp(
      `The bound run is not clean — one producing-cases file on disk is declared by no executed manifest \\(\`${casesPath}\`\\)\\.`,
      "u",
    ),
  );
  assert.doesNotMatch(sentence, new RegExp(COUNT_TAIL, "u"));
});

test("a missing cases path is named and does not qualify the produced count", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const casesPath = "scripts/tickets-manifest.cases.json";
  const produced = boundReport(graph, {
    cases: coveredCases(graph),
    closure: { undriven: [], missing: [casesPath], duplicate: [] },
  });
  const sentence = produceSentence((await build({ produced })).text);
  assert.match(
    sentence,
    new RegExp(
      `The bound run is not clean — one cases path that an executed manifest declares is outside the driven namespace \\(\`${casesPath}\`\\)\\.`,
      "u",
    ),
  );
  assert.doesNotMatch(sentence, new RegExp(COUNT_TAIL, "u"));
});

test("a duplicate cases path is named and does not qualify the produced count", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const casesPath = "scripts/produce-refusals-tickets-manifest.cases.json";
  const produced = boundReport(graph, {
    cases: coveredCases(graph),
    closure: { undriven: [], missing: [], duplicate: [casesPath] },
  });
  const sentence = produceSentence((await build({ produced })).text);
  assert.match(
    sentence,
    new RegExp(
      `The bound run is not clean — one cases path is declared by more than one executed manifest \\(\`${casesPath}\`\\)\\.`,
      "u",
    ),
  );
  assert.doesNotMatch(sentence, new RegExp(COUNT_TAIL, "u"));
});

test("two unexecuted signatures in one case say during their case", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const cases = coveredCases(graph);
  cases[0].unexecuted = [
    "src/host/workflow-graph-canonical.mjs#canonicalString",
    "src/host/workflow-graph-canonical.mjs#otherSymbol",
  ];
  const sentence = produceSentence((await build({ produced: boundReport(graph, { cases }) })).text);
  assert.match(sentence, /The bound run is not clean — two signatures' functions did not run during their case\./u);
  assert.doesNotMatch(sentence, /during their cases/u);
  assert.doesNotMatch(sentence, new RegExp(COUNT_TAIL, "u"));
});

test("two unexecuted signatures across cases say during their cases", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const cases = coveredCases(graph);
  cases[0].unexecuted = ["src/host/workflow-graph-canonical.mjs#canonicalString"];
  cases[1].unexecuted = ["src/host/workflow-graph-canonical.mjs#otherSymbol"];
  const sentence = produceSentence((await build({ produced: boundReport(graph, { cases }) })).text);
  assert.match(sentence, /The bound run is not clean — two signatures' functions did not run during their cases\./u);
  assert.doesNotMatch(sentence, new RegExp(COUNT_TAIL, "u"));
});

test("a failed case keeps the count tail and a harness signature follows it", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const cases = coveredCases(graph);
  cases[0].harness = ["scripts/produce-refusals.mjs#collectWrites"];
  // The class still has its passing case, so the failure does not also leave a class unproduced.
  cases.push({ class: cases[0].class, pass: false, produced: [cases[0].class] });
  const sentence = produceSentence((await build({ produced: boundReport(graph, { cases }) })).text);
  assert.match(
    sentence,
    /The bound run is not clean — one case failed — so the produced count above is of declared classes confirmed produced by a passing case, not of classes driven\. One signature names the produce-refusals harness, not a producer\./u,
  );
});

test("a produced report without a closure is refused by name", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const produced = {
    source: bindSource(ROOT, [graph]),
    contracts: [{ contract: graph, malformed: [], cases: [] }],
  };
  await assert.rejects(
    () => build({ produced }),
    (error) =>
      error.message === "the produced report records no undriven, missing, duplicate closure lists",
  );
});

test("a produced contract without a malformed array is refused by name", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const produced = {
    source: bindSource(ROOT, [graph]),
    closure: EMPTY_CLOSURE,
    contracts: [{ contract: graph, cases: [] }],
  };
  await assert.rejects(
    () => build({ produced }),
    (error) => error.message.includes("malformed") && error.message.includes(graph),
  );
});

test("an identical repeated contract entry is counted once and the duplicate path is named", async () => {
  // The aggregate `cases` counts the repeat, which is what the runner writes.
  // The sentence must not.
  const graph = "docs/contracts/workflow-graph.md";
  const cases = coveredCases(graph);
  cases[0].predicate_owner = "daemon";
  const entry = { contract: graph, malformed: [], cases };
  const casesPath = "scripts/produce-refusals-tickets-manifest.cases.json";
  const produced = boundReport(graph, {
    contracts: [entry, JSON.parse(JSON.stringify(entry))],
    casesAggregate: cases.length * 2,
    closure: { undriven: [], missing: [], duplicate: [casesPath] },
  });
  const sentence = produceSentence((await build({ produced })).text);
  assert.match(sentence, new RegExp(`drives ${cases.length} cases over ${cases.length} refusal classes of one contract\\b`, "u"));
  assert.match(sentence, /For one ticket-lifecycle class\b/u);
  assert.doesNotMatch(sentence, new RegExp(`drives ${cases.length * 2} cases`, "u"));
  assert.doesNotMatch(sentence, /For two ticket-lifecycle classes/u);
  assert.match(
    sentence,
    new RegExp(
      `The bound run is not clean — one cases path is declared by more than one executed manifest \\(\`${casesPath}\`\\)\\.`,
      "u",
    ),
  );
  assert.doesNotMatch(sentence, new RegExp(COUNT_TAIL, "u"));
});

test("two passing cases of one daemon-judged class count as one ticket-lifecycle class", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const row = { class: "graph_schema", pass: true, produced: ["graph_schema"], predicate_owner: "daemon" };
  const sentence = produceSentence((await build({ produced: boundReport(graph, { cases: [row, { ...row }] }) })).text);
  assert.match(sentence, /drives 2 cases/u);
  assert.match(sentence, /For one ticket-lifecycle class\b/u);
  assert.doesNotMatch(sentence, /For two ticket-lifecycle classes/u);
});

test("two different entries for one contract path both count as driven cases", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const entry = (rows) => ({ contract: graph, malformed: [], cases: rows });
  const produced = boundReport(graph, {
    contracts: [
      entry([{ class: "graph_schema", pass: true, produced: ["graph_schema"] }]),
      entry([
        { class: "graph_duplicate_name", pass: true, produced: ["graph_duplicate_name"] },
        { class: "graph_step_unknown", pass: true, produced: ["graph_step_unknown"] },
      ]),
    ],
    casesAggregate: 3,
  });
  const sentence = produceSentence((await build({ produced })).text);
  assert.match(sentence, /drives 3 cases/u);
  assert.match(sentence, /of one contract\b/u);
  assert.doesNotMatch(sentence, /of two contracts/u);
});

test("a side-produced uncovered class is named from the record and qualifies the count", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const cases = coveredCases(graph);
  const dropped = cases[1].class;
  cases[0].produced = [cases[0].class, dropped];
  const kept = cases.filter((row) => row.class !== dropped);
  const sentence = produceSentence((await build({
    produced: boundReport(graph, { cases: kept, uncovered: [dropped] }),
  })).text);
  assert.match(
    sentence,
    new RegExp(
      `The bound run is not clean — one declared class has no case in its manifest \\(\`${dropped}\`\\) — ${COUNT_TAIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      "u",
    ),
  );
  assert.doesNotMatch(sentence, /no passing case/u);
});

test("an undeclared record is named and qualifies the count", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const sentence = produceSentence((await build({
    produced: boundReport(graph, { cases: coveredCases(graph), undeclared: ["not_a_declared_class"] }),
  })).text);
  assert.match(
    sentence,
    /The bound run is not clean — one driven class is not declared by its contract \(`not_a_declared_class`\) — so the produced count above is of declared classes confirmed produced by a passing case, not of classes driven\./u,
  );
  assert.doesNotMatch(sentence, /names no declared class/u);
});

test("a side-produced code outside the declared set with empty records is not a clause", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const cases = coveredCases(graph);
  cases[0].produced = [cases[0].class, "not_declared_anywhere"];
  const sentence = produceSentence((await build({ produced: boundReport(graph, { cases }) })).text);
  assert.doesNotMatch(sentence, /not clean/u);
  assert.doesNotMatch(sentence, /not_declared_anywhere/u);
});

test("a class uncovered on two different entries of one contract counts once", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const cases = coveredCases(graph);
  const dropped = cases[1].class;
  const rows = cases.filter((row) => row.class !== dropped);
  const entry = (marker) => ({
    contract: graph,
    malformed: [],
    uncovered: [dropped],
    undeclared: [],
    cases: rows.map((row, index) => (index === 0 ? { ...row, marker } : { ...row })),
  });
  const sentence = produceSentence((await build({
    produced: boundReport(graph, { contracts: [entry("first"), entry("second")] }),
  })).text);
  assert.match(sentence, new RegExp(`one declared class has no case in its manifest \\(\`${dropped}\`\\)`, "u"));
  assert.doesNotMatch(sentence, /two declared classes have no case in their manifest/u);
});

test("a path that is both missing and duplicate is named in both clauses", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const casesPath = "scripts/tickets-manifest.cases.json";
  const sentence = produceSentence((await build({
    produced: boundReport(graph, {
      cases: coveredCases(graph),
      closure: { undriven: [], missing: [casesPath], duplicate: [casesPath] },
    }),
  })).text);
  assert.match(
    sentence,
    new RegExp(
      `The bound run is not clean — one cases path that an executed manifest declares is outside the driven namespace \\(\`${casesPath}\`\\); one cases path is declared by more than one executed manifest \\(\`${casesPath}\`\\)\\.`,
      "u",
    ),
  );
  assert.doesNotMatch(sentence, new RegExp(COUNT_TAIL, "u"));
});

test("a class-less malformed name with backticks renders as a valid code span", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const internal = JSON.stringify({ emitter: "x", note: "see `graph_schema`" });
  const leading = "`see` graph_schema";
  const internalSentence = produceSentence((await build({
    produced: boundReport(graph, { cases: coveredCases(graph), malformed: [internal] }),
  })).text);
  assert.match(internalSentence, new RegExp(`one driven case \\(\`\`${internal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\`\`\\) records no emitter`, "u"));
  const leadingSentence = produceSentence((await build({
    produced: boundReport(graph, { cases: coveredCases(graph), malformed: [leading] }),
  })).text);
  assert.match(leadingSentence, /one driven case \(`` `see` graph_schema ``\) records no emitter/u);
});

test("a produced report without a contracts array is refused by name", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  await assert.rejects(
    () => build({ produced: { source: bindSource(ROOT, [graph]), closure: EMPTY_CLOSURE } }),
    (error) => error.message === "the produced report records no contracts array",
  );
});

test("a contract entry without an uncovered array is refused by name", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  await assert.rejects(
    () => build({
      produced: {
        source: bindSource(ROOT, [graph]),
        closure: EMPTY_CLOSURE,
        contracts: [{ contract: graph, malformed: [], undeclared: [], cases: [] }],
      },
    }),
    (error) => error.message === `the produced report's contract ${graph} records no uncovered array`,
  );
});

test("a contract entry without an undeclared array is refused by name", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  await assert.rejects(
    () => build({
      produced: {
        source: bindSource(ROOT, [graph]),
        closure: EMPTY_CLOSURE,
        contracts: [{ contract: graph, malformed: [], uncovered: [], cases: [] }],
      },
    }),
    (error) => error.message === `the produced report's contract ${graph} records no undeclared array`,
  );
});

test("two harness signatures are a plural clause", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const cases = coveredCases(graph);
  cases[0].harness = ["scripts/produce-refusals.mjs#collectWrites"];
  cases[1].harness = ["scripts/produce-refusals.mjs#produceReport"];
  const sentence = produceSentence((await build({ produced: boundReport(graph, { cases }) })).text);
  assert.match(sentence, /The bound run is not clean — two signatures name the produce-refusals harness, not a producer\./u);
  assert.doesNotMatch(sentence, new RegExp(COUNT_TAIL, "u"));
});

test("two malformed names are a plural clause", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const sentence = produceSentence((await build({
    produced: boundReport(graph, { cases: coveredCases(graph), malformed: ["graph_schema", "graph_duplicate_name"] }),
  })).text);
  assert.match(
    sentence,
    /The bound run is not clean — two driven cases \(`graph_schema`, `graph_duplicate_name`\) record no emitter they can be traced to\./u,
  );
  assert.doesNotMatch(sentence, new RegExp(COUNT_TAIL, "u"));
});

test("two undriven paths are a plural clause", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const sentence = produceSentence((await build({
    produced: boundReport(graph, {
      cases: coveredCases(graph),
      closure: { undriven: ["scripts/produce-refusals-a.cases.json", "scripts/produce-refusals-b.cases.json"], missing: [], duplicate: [] },
    }),
  })).text);
  assert.match(
    sentence,
    /The bound run is not clean — two producing-cases files on disk are declared by no executed manifest \(`scripts\/produce-refusals-a\.cases\.json`, `scripts\/produce-refusals-b\.cases\.json`\)\./u,
  );
});

test("two missing paths use the path wording", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const sentence = produceSentence((await build({
    produced: boundReport(graph, {
      cases: coveredCases(graph),
      closure: { undriven: [], missing: ["scripts/a.cases.json", "scripts/b.cases.json"], duplicate: [] },
    }),
  })).text);
  assert.match(
    sentence,
    /The bound run is not clean — two cases paths that executed manifests declare are outside the driven namespace \(`scripts\/a\.cases\.json`, `scripts\/b\.cases\.json`\)\./u,
  );
});

test("two duplicate paths are a plural clause", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const sentence = produceSentence((await build({
    produced: boundReport(graph, {
      cases: coveredCases(graph),
      closure: { undriven: [], missing: [], duplicate: ["scripts/a.cases.json", "scripts/b.cases.json"] },
    }),
  })).text);
  assert.match(
    sentence,
    /The bound run is not clean — two cases paths are declared by more than one executed manifest \(`scripts\/a\.cases\.json`, `scripts\/b\.cases\.json`\)\./u,
  );
});

test("two uncovered names are a plural clause", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const sentence = produceSentence((await build({
    produced: boundReport(graph, { cases: coveredCases(graph), uncovered: ["graph_schema", "graph_duplicate_name"] }),
  })).text);
  assert.match(
    sentence,
    /The bound run is not clean — two declared classes have no case in their manifest \(`graph_schema`, `graph_duplicate_name`\) — so the produced count above/u,
  );
});

test("an empty malformed name is words, not a code span", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const sentence = produceSentence((await build({
    produced: boundReport(graph, { cases: coveredCases(graph), malformed: [""] }),
  })).text);
  assert.match(sentence, /one driven case \(an empty name\) records no emitter it can be traced to/u);
  assert.doesNotMatch(sentence, /one driven case \(``\)/u);
});

test("a name padded with spaces keeps those spaces inside the code span", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const sentence = produceSentence((await build({
    produced: boundReport(graph, { cases: coveredCases(graph), malformed: [" padded "] }),
  })).text);
  assert.ok(
    sentence.includes("one driven case (`  padded  `) records no emitter it can be traced to"),
    sentence,
  );
});

test("two undeclared names are a plural clause", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const sentence = produceSentence((await build({
    produced: boundReport(graph, { cases: coveredCases(graph), undeclared: ["alpha", "beta"] }),
  })).text);
  assert.match(
    sentence,
    /The bound run is not clean — two driven classes are not declared by their contract \(`alpha`, `beta`\) — so the produced count above/u,
  );
});

test("a produced report fills the cell against the contract's own closed set", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const outline = contractOutline(read(graph));
  const produced = {
    source: bindSource(ROOT, [graph]),
    closure: EMPTY_CLOSURE,
    contracts: [
      {
        contract: graph,
        malformed: [],
        uncovered: [],
        undeclared: [],
        produced: outline.refusals.length,
        of: outline.refusals.length,
        cases: outline.refusals.map((name) => ({ class: name, pass: true })),
      },
    ],
  };
  const { text } = await build({ produced });
  const lines = text.split("\n");
  const table = lines.findIndex((line) => line.startsWith("| contract | rules evaluated in"));
  const row = lines.slice(table).find((line) => line.startsWith(`| \`${graph}\``));
  assert.equal(row.split("|")[4].trim(), `${outline.refusals.length} of ${outline.refusals.length}`);
});

test("a produced run short of the closed set does not read as complete", async () => {
  // Three passing cases over three cases would print `3 of 3` if the cell
  // counted cases; against the contract's own set it must show the shortfall
  // and name what the run did not produce.
  const graph = "docs/contracts/workflow-graph.md";
  const outline = contractOutline(read(graph));
  const covered = outline.refusals.slice(0, 3);
  const produced = {
    source: bindSource(ROOT, [graph]),
    closure: EMPTY_CLOSURE,
    contracts: [
      {
        contract: graph,
        malformed: [],
        uncovered: [],
        undeclared: [],
        produced: covered.length,
        of: covered.length,
        cases: covered.map((name) => ({ class: name, pass: true })),
      },
    ],
  };
  const { text } = await build({ produced });
  const lines = text.split("\n");
  const table = lines.findIndex((line) => line.startsWith("| contract | rules evaluated in"));
  const row = lines.slice(table).find((line) => line.startsWith(`| \`${graph}\``));
  const cell = row.split("|")[4].trim();
  assert.ok(cell.startsWith(`3 of ${outline.refusals.length}`), cell);
  assert.ok(cell.includes("not produced:"), cell);
  assert.ok(cell.includes(outline.refusals.at(-1)), cell);
  assert.ok(!/\b3 of 3\b/u.test(cell), cell);
});

test("a produced report bound to other bytes refuses to render", async () => {
  // The report says it measured one set of bytes; this tree has others — the
  // build must refuse the column rather than print a number produced
  // elsewhere.
  const graph = "docs/contracts/workflow-graph.md";
  const source = bindSource(ROOT, [graph]);
  source.files[0].sha256 = "0".repeat(64);
  const produced = {
    source,
    contracts: [
      {
        contract: graph,
        produced: 1,
        of: 1,
        cases: [{ class: "graph_schema", pass: true }],
      },
    ],
  };
  await assert.rejects(
    () => build({ produced }),
    (error) => error.message.includes("produced on another tree") && error.message.includes(graph),
  );
});

test("a produced report with no source binding refuses to render", async () => {
  await assert.rejects(
    () => build({ produced: { contracts: [] } }),
    /no source binding/u,
  );
});

test("a produced report refuses a tree that gained a scanned member", async () => {
  // A file added under a scanned directory drifts no recorded member, so the
  // listing membership is the check that catches it — drop one real contract
  // from the record, as a report made before it existed would read.
  const graph = "docs/contracts/workflow-graph.md";
  const source = bindSource(ROOT, [graph], [{ dir: "docs/contracts", suffix: ".md", deep: false }]);
  const added = source.listings[0].members.find((name) => name !== graph);
  source.listings[0].members = source.listings[0].members.filter((name) => name !== added);
  const produced = { source, contracts: [] };
  await assert.rejects(
    () => build({ produced }),
    (error) => error.message.includes("produced on another tree") && error.message.includes(added),
  );
});

test("a produced report refuses a tree that lost a scanned member", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const source = bindSource(ROOT, [graph], [{ dir: "docs/contracts", suffix: ".md", deep: false }]);
  source.listings[0].members.push("docs/contracts/zz-removed-since.md");
  const produced = { source, contracts: [] };
  await assert.rejects(
    () => build({ produced }),
    (error) =>
      error.message.includes("produced on another tree") &&
      error.message.includes("docs/contracts/zz-removed-since.md"),
  );
});

// A bound name is a position: a regular file swapped for a same-bytes link to
// an outside copy keeps every recorded digest, but the copy's physical
// neighbours — never bound, never hashed — are what the run's own imports
// would load. The bound name must be its own physical path, so the consumer
// refuses the topology, not the bytes.
const linkedDirs = [];
after(() => {
  for (const dir of linkedDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const linkedFixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "produced-link-"));
  linkedDirs.push(root);
  const outside = mkdtempSync(path.join(os.tmpdir(), "produced-link-out-"));
  linkedDirs.push(outside);
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(outside, "member.mjs"), "export const m = 1;\n");
  writeFileSync(path.join(outside, "neighbour.mjs"), "export const swapped = true;\n");
  copyFileSync(path.join(outside, "member.mjs"), path.join(root, "src", "member.mjs"));
  return { root, outside };
};

test("a bound file replaced by a same-bytes link refuses — the name is not the physical path", () => {
  const { root, outside } = linkedFixture();
  const source = bindSource(root, ["src/member.mjs"], [{ dir: "src", suffix: ".mjs", deep: true }]);
  rmSync(path.join(root, "src", "member.mjs"));
  symlinkSync(path.join(outside, "member.mjs"), path.join(root, "src", "member.mjs"));
  const drift = sourceDrift(root, source);
  assert.ok(
    drift.some((line) => line.includes("src/member.mjs") && line.includes("physical path")),
    `expected a topology refusal for src/member.mjs, got: ${drift.join("; ") || "none"}`,
  );
});

test("a bound directory replaced by a link refuses — the ancestor is the same attack one level up", () => {
  const { root, outside } = linkedFixture();
  const source = bindSource(root, ["src/member.mjs"], [{ dir: "src", suffix: ".mjs", deep: true }]);
  rmSync(path.join(root, "src"), { recursive: true });
  symlinkSync(outside, path.join(root, "src"), "dir");
  const drift = sourceDrift(root, source);
  assert.ok(
    drift.some((line) => line.startsWith("src:") && line.includes("physical path")),
    `expected a topology refusal for src, got: ${drift.join("; ") || "none"}`,
  );
  // The linked dir's own line carries it — its members do not pile on.
  assert.ok(
    !drift.some((line) => line.startsWith("src/member.mjs:")),
    `expected the directory line to carry the members, got: ${drift.join("; ")}`,
  );
});

test("bindSource refuses to bind a name that resolves through a link", () => {
  const { root, outside } = linkedFixture();
  rmSync(path.join(root, "src", "member.mjs"));
  symlinkSync(path.join(outside, "member.mjs"), path.join(root, "src", "member.mjs"));
  assert.throws(
    () => bindSource(root, ["src/member.mjs"], [{ dir: "src", suffix: ".mjs", deep: true }]),
    /cannot bind src\/member\.mjs.*physical path/u,
  );
});

test("the evidence is given as rows, not only as counts", async () => {
  // A reviewer holding counts cannot tell a discriminating guard from one that
  // refuses everything, and that distinction is why each case runs a control.
  const { text } = await build();
  // Every group in the matrix, not only the injected ones: sixteen rows under a
  // twenty-group matrix reads as four missing, and the difference between "no
  // control" and "no coverage" has to be on the row rather than inferred.
  for (const row of cleanRoom.coverage.rows) {
    assert.match(text, new RegExp(`\\| \`${row.id}\` \\| ${row.harness}`, "u"));
  }
  // Debt 10h: each row now carries its injection kind (from the matrix).
  // Debt 12e: and whether its run is the designed fault, beside the detection.
  assert.match(text, /\| `F001` \| crash \| `real_path` \| yes \| yes \| not paired \|/u);
  assert.match(text, /\| `F002` \| crash \| `real_path` \| NO \| yes \| not paired \|/u);
  assert.match(text, /\| `F020` \| faults \| `written_observation`: [^|]+ \| NO \| yes \| yes \|/u);
  for (const entry of mutation.modules) {
    assert.match(text, new RegExp(entry.module.replace(/[/.]/gu, "\\$&"), "u"));
  }
  // Review of 11f (M1): a run that recorded no per-group rows used to print its
  // counts alone; the package now holds a report to one row per matrix group,
  // so counts with no rows behind them are refused.
  await assert.rejects(
    build({ cleanRoom: { ...cleanRoom, faults: null, coverage: { ...cleanRoom.coverage, rows: [] } } }),
    new RegExp(`the run's coverage rows are not one per matrix group: missing ${matrix.groups.map((group) => group.id).join(", ")}$`, "u"),
  );
});

test("the mutation claim carries its own numbers and its own rules", async () => {
  const { text } = await build();
  assert.match(text, /\| mutants \| 513 \|/u);
  assert.match(text, /\| killed \| 513 \|/u);
  assert.match(text, /`demand\(`, `errors\.push\(`/u);
  assert.match(text, /node scripts\/mutation-report\.mjs/u);
  // And it does not quietly borrow the broader hand-run counts.
  assert.match(text, /the two are not the same number/u);
});

test("every verdict the package asks for is one the archive accepts", async () => {
  // The block asked for `blocking_non_verdict` — the runtime's word for a seat
  // that could not answer — while the archive reads the attestation vocabulary,
  // which spells that `non_verdict`. A seat following the instruction exactly
  // produced a record the archive refused, which is this ticket's own defect
  // arriving from the other end. The producer and the consumer read one list.
  const { text } = await build();
  const block = /"verdict": "([^"]+)"/u.exec(text);
  assert.ok(block, "the verdict block must state which verdicts it accepts");
  const offered = block[1].split("|").map((name) => name.trim());
  assert.deepEqual(offered, panelVerdicts());

  for (const verdict of offered) {
    const seats = PANEL_BY_ROUND[1].map((seat, index) => ({
      ...seat,
      verdict,
      session_id: `session-${index + 1}`,
      findings: verdict === "pass" ? [] : [{ severity: "high", where: "x", what: "y" }],
    }));
    assert.deepEqual(validatePanelRound({ round: 1, seats }, PANEL_BY_ROUND[1]), [], verdict);
  }

  // And a word the package does not offer is still refused.
  const seats = PANEL_BY_ROUND[1].map((seat, index) => ({
    ...seat,
    verdict: "blocking_non_verdict",
    session_id: `session-${index + 1}`,
    findings: [{ severity: "high", where: "x", what: "y" }],
  }));
  assert.equal(validatePanelRound({ round: 1, seats }, PANEL_BY_ROUND[1]).length, 4);
});

test("the verdict block asks for the seats this candidate requires", async () => {
  // The block spelled its seats by hand, so amending the roster left it asking
  // for a seat that no longer sits and never offering the one that does: the
  // deepseek panelist would have had to break the stated format or answer under
  // another seat's name, and `computeAttestationState` then finds no deepseek
  // verdict and holds the candidate at `pending_final_panel` forever.
  const { text } = await build();
  const block = /"seat": "<([^>]+)>"/u.exec(text);
  assert.ok(block, "the verdict block must state which seats it accepts");
  assert.deepEqual(
    block[1].split("|").sort(),
    candidate.required_panel.map((entry) => entry.seat).sort(),
  );
});

test("the package is deterministic and names what it left out", async () => {
  const one = await build();
  const two = await build();
  assert.equal(one.digest, two.digest);
  assert.equal(one.text, two.text);
  for (const name of FULL_TEXT) assert.match(one.text, new RegExp(`### ${name.replace(".", "\\.")}`, "u"));
  assert.match(one.text, /Not reproduced, and named so a verdict can say what it covered/u);
});

/**
 * A migration-seam record in the shape the measurer emits, bound to this tree:
 * `MEASURER_FILES` hashed the way the gate binds them, and the manifest's own
 * patched-tree id as the source it ran against.
 */
const SEAM_EXECUTED_FILES = [
  { path: "bin/autosk-store-lock", sha256: "0".repeat(64) },
  { path: "daemon/node_modules/@autosk/sdk/src/index.ts", sha256: "1".repeat(64) },
];

const seamRecord = (over = {}) => ({
  band: "migration-seam",
  project_dir: "/tmp/autosk-migration-seam-test/project",
  project_dir_physical: "/private/tmp/autosk-migration-seam-test/project",
  bound: {
    source_tree: compat.result_tree,
    source: bindSource(ROOT, MEASURER_FILES),
    executed: {
      files: SEAM_EXECUTED_FILES.map((file) => ({ ...file })),
      listings: [],
      digest: digestOf(SEAM_EXECUTED_FILES, []),
    },
  },
  workflow: "seam-flow",
  served: {
    before: { digest: "a".repeat(64), graph: "c".repeat(64) },
    after: { digest: "b".repeat(64), graph: "c".repeat(64) },
  },
  old_distribution: {
    bytes_held: false,
    not_held_reason: "root cannot be read: ENOENT: no such file or directory",
    index_file: ".autosk/runtime/v1/index.json",
    restorable_after_update: false,
  },
  migrated_task: {
    id: "ask-migrated",
    pin_before: {
      file: ".autosk/tasks/ask-migrated/task.json",
      pin: { state: "pinned", pin: { workflow: "seam-flow", digest: "a".repeat(64), graph: "c".repeat(64), helper: "e".repeat(64) } },
    },
    pin_after: {
      file: ".autosk/tasks/ask-migrated/task.json",
      pin: { state: "pinned", pin: { workflow: "seam-flow", digest: "b".repeat(64), graph: "c".repeat(64) } },
    },
    resume_decision: {
      ok: false,
      reason: "extension_version_mismatch: seam-flow has no recorded store helper for this task",
    },
  },
  migration: {
    plan: { supported: true, from: "a".repeat(64), to: "b".repeat(64) },
    apply: { ok: true, receipt: { id: "f".repeat(64), completed_at: "2026-01-01T00:00:00Z" } },
  },
  control: {
    read_back_before_migration: {
      task: "ask-migrated",
      file: ".autosk/tasks/ask-migrated/task.json",
      pin: { state: "pinned", pin: { workflow: "seam-flow", digest: "a".repeat(64), graph: "c".repeat(64), helper: "e".repeat(64) } },
    },
    fresh_admission_after_migration: {
      task: "ask-witness",
      file: ".autosk/tasks/ask-witness/task.json",
      pin: { state: "pinned", pin: { workflow: "seam-flow", digest: "b".repeat(64), graph: "c".repeat(64), helper: "e".repeat(64) } },
      resume_decision: { ok: true },
    },
  },
  ...over,
});

test("a bound migration-seam record renders its measured fields as data", async () => {
  const { text } = await build({ migrationSeam: seamRecord() });
  assert.match(text, /### Migration seam/u);
  assert.match(text, /measured source tree \| `[0-9a-f]{40}`/u);
  assert.match(text, /helper present/u);
  assert.match(text, /helper absent/u);
  assert.match(text, /resume answer \| refused — `extension_version_mismatch`/u);
  assert.match(text, /pre-migration read-back present; fresh admission present, resume admitted/u);
  assert.match(text, /root cannot be read: ENOENT/u);
});

test("a migration-seam record bound to another patched tree refuses by name", async () => {
  // The record says it measured one patched source tree; the manifest this
  // package names another. Rendering the value anyway would certify a claim
  // about bytes nobody here ran.
  const other = seamRecord({ bound: { ...seamRecord().bound, source_tree: "1".repeat(40) } });
  await assert.rejects(
    () => build({ migrationSeam: other }),
    (error) =>
      error.message.includes("measured patched source tree") &&
      error.message.includes("1".repeat(40)) &&
      error.message.includes(compat.result_tree),
  );
});

test("a migration-seam record bound to other script bytes refuses by name", async () => {
  const drifted = seamRecord();
  drifted.bound.source.files.find((file) => file.path === "scripts/verify-autosk-migration-seam.driver.ts").sha256 =
    "0".repeat(64);
  await assert.rejects(
    () => build({ migrationSeam: drifted }),
    (error) =>
      error.message.includes("produced on another tree") &&
      error.message.includes("scripts/verify-autosk-migration-seam.driver.ts"),
  );
});

function runNode(args, cwd) {
  // The test runner sets NODE_TEST_CONTEXT and NODE_TEST_WORKER_ID on this
  // process. The child does not inherit them because this env is explicit.
  const env = { PATH: process.env.PATH, HOME: cwd, TMPDIR: process.env.TMPDIR, NO_COLOR: "1" };
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

test("the package refuses the seam column when a loaded measurer module's bytes change", { timeout: 120_000 }, async () => {
  // The public command, not the in-process builder. The record is bound to
  // this tree's MEASURER_FILES; the package then runs in a copy where one
  // module the measurer loads has a different byte. A binding that omits
  // that module still prints the column.
  const scratch = mkdtempSync(path.join(os.tmpdir(), "seam-column-"));
  try {
    cpSync(ROOT, scratch, {
      recursive: true,
      filter: (source) => path.basename(source) !== "node_modules" && path.basename(source) !== ".git",
    });
    const record = seamRecord();
    const recordPath = path.join(scratch, "seam-record.json");
    writeFileSync(recordPath, `${JSON.stringify(record)}\n`);
    const produced = path.join(scratch, "scripts/lib/produced-source.mjs");
    writeFileSync(produced, `${readFileSync(produced, "utf8")}\n`);
    const cleanRoom = {
      faults: [{ id: "F020", detected: true, control: true, detail: "control" }],
      upstream_commit: compat.upstream.commit,
      source_tree: compat.result_tree,
      extension: { commit: "c".repeat(40), tree: "t".repeat(40), dirty: false },
      report_digest: "r".repeat(64),
      ok: true,
      steps: [{ step: "prepare", ok: true }],
      coverage: {
        counts: { covered_by_real_fault: 1 },
        complete: true,
        rows: [{ id: "F020", state: "covered_by_real_fault", harness: "faults", evidence: "control" }],
      },
    };
    const mutation = {
      totals: { modules: 1, mutants: 1, killed: 1 },
      modules: [{ module: "src/host/workflow-factory.mjs", test: "test/x.test.mjs", mutants: 1, killed: 1 }],
      survivors: [],
    };
    const cleanRoomPath = path.join(scratch, "clean-room.json");
    const mutationPath = path.join(scratch, "mutation.json");
    const testsLogPath = path.join(scratch, "tests.log");
    writeFileSync(testsLogPath, "ℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n");
    writeFileSync(cleanRoomPath, JSON.stringify(cleanRoom));
    writeFileSync(mutationPath, JSON.stringify(mutation));
    // argv and import.meta.url must be the same spelling. tmpdir is under
    // /var, which is a symlink to /private/var, and the CLI compares them
    // with path.resolve, not realpath.
    const scratchReal = realpathSync(scratch);
    const run = await runNode(
      [
        realpathSync(path.join(scratch, "scripts/build-panel-package.mjs")),
        "--commit",
        "c".repeat(40),
        "--tree",
        "t".repeat(40),
        "--tests-log",
        testsLogPath,
        "--clean-room",
        cleanRoomPath,
        "--mutation",
        mutationPath,
        "--migration-seam",
        recordPath,
        "--out",
        path.join(scratchReal, "package.md"),
      ],
      scratchReal,
    );
    const output = `${run.stdout}\n${run.stderr}`;
    assert.notEqual(run.status, 0, output);
    assert.match(output, /produced on another tree: scripts\/lib\/produced-source\.mjs: report binds/u);
    assert.doesNotMatch(run.stdout, /package_bytes=/u);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a migration-seam record with no source binding refuses to render", async () => {
  const unbound = seamRecord({ bound: { source_tree: compat.result_tree } });
  await assert.rejects(() => build({ migrationSeam: unbound }), /no source binding/u);
});

test("a build with no migration-seam measurement refuses, naming the command and the flag", async () => {
  // The band is required evidence: a package without it is not a quieter
  // package, it is one that cannot answer what migrate did to the pin. The
  // refusal has to say how to supply the measurement or record a refusal.
  await assert.rejects(
    () => build({ migrationSeam: null }),
    (error) =>
      error.message.includes("verify-autosk-migration-seam.mjs") &&
      error.message.includes("--migration-seam") &&
      error.message.includes("--no-migration-seam"),
  );
});

test("a recorded refusal renders its reason verbatim, distinguishable from a measurement", async () => {
  const { text } = await build({ migrationSeam: null, migrationSeamRefusal: "no prepared upstream source on this seat" });
  assert.match(text, /### Migration seam/u);
  assert.match(text, /did not run for this build — a recorded refusal/u);
  assert.match(text, /"no prepared upstream source on this seat"/u);
  assert.doesNotMatch(text, /measured source tree/u);
});

test("an empty refusal reason is a refusal to say anything, so it refuses", async () => {
  await assert.rejects(() => build({ migrationSeam: null, migrationSeamRefusal: "  " }), /--no-migration-seam/u);
});

test("a measurement and a recorded refusal cannot both be given", async () => {
  await assert.rejects(
    () => build({ migrationSeam: seamRecord(), migrationSeamRefusal: "why not both" }),
    /cannot both be given/u,
  );
});

test("a migration-seam record whose executed surface does not recompute refuses", async () => {
  // The executed binding is verified for coherence: a member changed without
  // the digest, or a digest that does not fold these members, is a record that
  // cannot be read as bound.
  const tampered = seamRecord();
  tampered.bound.executed.files[1].sha256 = "2".repeat(64);
  await assert.rejects(() => build({ migrationSeam: tampered }), /does not recompute/u);
});

test("a migration-seam record that does not bind the helper it ran refuses", async () => {
  const seam = seamRecord();
  const files = SEAM_EXECUTED_FILES.filter((file) => file.path !== "bin/autosk-store-lock");
  seam.bound.executed = { files, listings: [], digest: digestOf(files, []) };
  await assert.rejects(() => build({ migrationSeam: seam }), /store-lock helper/u);
});

test("a migration-seam record whose executed surface binds no module refuses", async () => {
  // A helper-only member list recomputes, names the helper, and stays in
  // scope — and still establishes nothing about what the run imported.
  const seam = seamRecord();
  const files = SEAM_EXECUTED_FILES.filter((file) => !file.path.includes("node_modules/"));
  seam.bound.executed = { files, listings: [], digest: digestOf(files, []) };
  await assert.rejects(() => build({ migrationSeam: seam }), /fails the band's own checks.*module/u);
});

test("a migration-seam record without a resume answer refuses rather than render refused", async () => {
  // `ok` absent is not `ok: false` — the package must not print a measured
  // refusal for a record that carried no answer.
  const seam = seamRecord();
  delete seam.migrated_task.resume_decision;
  await assert.rejects(() => build({ migrationSeam: seam }), /fails the band's own checks.*resume answer/u);
});

test("the pinned cells render the pin's own digest, not the served distribution's", async () => {
  // The reviewer's serializer-zeroing produced exactly this shape: served
  // says one thing, the pin read from disk says another. The cell quotes the
  // pin — what the record holds — not the field the pin is expected to match.
  const seam = seamRecord();
  seam.migrated_task.pin_before.pin.pin.digest = "9".repeat(64);
  seam.migrated_task.pin_after.pin.pin.digest = "8".repeat(64);
  const { text } = await build({ migrationSeam: seam });
  const before = text.split("\n").find((line) => line.includes("pinned before"));
  const after = text.split("\n").find((line) => line.includes("pinned after"));
  assert.match(before, /`9{64}`/u);
  assert.doesNotMatch(before, /`a{64}`/u);
  assert.match(after, /`8{64}`/u);
  assert.doesNotMatch(after, /`b{64}`/u);
});

test("a migration-seam record that fails the band's own checks refuses", async () => {
  // A coherent digest over a member outside the install roots passes the
  // builder's arithmetic and still is not a measurement the package may
  // quote — the band's own checks are the builder's too.
  const seam = seamRecord();
  const files = [...SEAM_EXECUTED_FILES, { path: "etc/passwd", sha256: "3".repeat(64) }];
  seam.bound.executed = { files, listings: [], digest: digestOf(files, []) };
  await assert.rejects(() => build({ migrationSeam: seam }), /fails the band's own checks/u);
});

test("the migration-seam row carries no machine-local path, and renders identically across temp dirs", async () => {
  // The record keeps the store's verbatim reason — it is the string a reader
  // compares against a real incident — but the package cannot carry the
  // measurer's temp directory: a governance document must not differ between
  // two runs that found exactly the same thing.
  const first = seamRecord();
  first.project_dir = "/tmp/autosk-migration-seam-a1b2C3/project";
  first.project_dir_physical = "/private/tmp/autosk-migration-seam-a1b2C3/project";
  first.old_distribution.not_held_reason =
    "root cannot be read: ENOENT: no such file or directory, lstat '/private/tmp/autosk-migration-seam-a1b2C3/project/.autosk/extensions/seam-flow'";
  const second = seamRecord();
  second.project_dir = "/private/var/folders/zz/autosk-migration-seam-Zz99Yy/project";
  second.project_dir_physical = "/private/var/folders/zz/autosk-migration-seam-Zz99Yy/project";
  second.old_distribution.not_held_reason =
    "root cannot be read: ENOENT: no such file or directory, lstat '/private/var/folders/zz/autosk-migration-seam-Zz99Yy/project/.autosk/extensions/seam-flow'";
  const cell = (text) => text.split("\n").find((line) => line.includes("old distribution record"));
  const one = cell((await build({ migrationSeam: first })).text);
  const two = cell((await build({ migrationSeam: second })).text);
  assert.match(one, /lstat '<project>\/\.autosk\/extensions\/seam-flow'/u);
  assert.doesNotMatch(one, /\/tmp\/|\/private\/|\/var\/folders\//u);
  assert.equal(one, two);
});

test("a project path containing an apostrophe is still rewritten whole", async () => {
  // A quote-bounded read ends the store's quoting early on such a path and
  // leaves a volatile tail; the substitution is verbatim, so the apostrophe
  // is just another byte in the prefix being replaced.
  const seam = seamRecord();
  seam.project_dir = "/tmp/it's-here/autosk-migration-seam-b7/project";
  seam.project_dir_physical = "/private/tmp/it's-here/autosk-migration-seam-b7/project";
  seam.old_distribution.not_held_reason =
    "root cannot be read: ENOENT: no such file or directory, lstat '/private/tmp/it's-here/autosk-migration-seam-b7/project/.autosk/extensions/seam-flow'";
  const { text } = await build({ migrationSeam: seam });
  const cell = text.split("\n").find((line) => line.includes("old distribution record"));
  assert.match(cell, /lstat '<project>\/\.autosk\/extensions\/seam-flow'/u);
  assert.doesNotMatch(cell, /tmp|it's-here/u);
});

test("a reason whose path cannot be delimited renders its class and withholds the path", async () => {
  // An apostrophe inside a path outside the project unbalances the quoting:
  // no rewrite can tell where the path ends, so the cell says the class and
  // that the path was withheld — never a partially rewritten tail.
  const seam = seamRecord();
  seam.old_distribution.not_held_reason =
    "root cannot be read: ENOENT: no such file or directory, lstat '/mnt/vol'ume/seam-flow'";
  const { text } = await build({ migrationSeam: seam });
  const cell = text.split("\n").find((line) => line.includes("old distribution record"));
  assert.match(cell, /path withheld/u);
  assert.doesNotMatch(cell, /mnt|vol|ume/u);
});

test("a reason naming a path outside the project carries no absolute path at all", async () => {
  const seam = seamRecord();
  seam.old_distribution.not_held_reason =
    "root cannot be read: ENOENT: no such file or directory, lstat '/mnt/volume-that-went-away/seam-flow'";
  const { text } = await build({ migrationSeam: seam });
  const cell = text.split("\n").find((line) => line.includes("old distribution record"));
  assert.match(cell, /outside the project/u);
  assert.doesNotMatch(cell, /\/mnt\//u);
});

test("a park reason nothing produces is named as not claimed, not counted as delivered", async () => {
  // Round 5 (R5-6): the vocabulary let a document validator stand in as the
  // producer, so the package counted designed-only parks as produced here.
  const { text } = await build();
  const none = vocabulary.park_reasons.filter((entry) => entry.producer === "none");
  assert.ok(none.length > 0, "the shipped vocabulary declares producer none for designed-only parks");
  assert.match(text, new RegExp(`${none.length} are declared by the design and produced by nothing yet`, "u"));
  for (const entry of none) assert.ok(text.includes(`\`${entry.code}\``), `${entry.code} is not named in the package`);
  const host = vocabulary.park_reasons.filter((entry) => entry.producer === "host").length;
  assert.match(text, new RegExp(`${host} are produced by runtime code in this repository`, "u"));
  assert.doesNotMatch(text, /delivered as the pinned\s*patch series/u);
  const counted = await build({ vocabulary: { ...vocabulary, park_reasons: vocabulary.park_reasons.map((entry) => ({ ...entry, producer: entry.producer === "none" ? "host" : entry.producer })) } });
  assert.doesNotMatch(counted.text, /are declared with no producer yet/u);
});

// Debt 10h (R6-20, R6-21, R6-22, a1): what the package claims, measured.

const section5 = (text) => text.slice(text.indexOf("## 5. Evidence"), text.indexOf("## 6. "));

test("the package does not say every group is injected for real; it says how each one is", async () => {
  const { text } = await build();
  const evidence = section5(text);
  assert.doesNotMatch(evidence, /Every group is injected for real/u);
  assert.doesNotMatch(evidence, /Sixteen are injected/u);
  const byKind = (kind) => matrix.groups.filter((group) => group.injection === kind).map((group) => `\`${group.id}\``).join(", ");
  for (const kind of ["real_path", "measured_observation", "written_observation"]) {
    const count = matrix.groups.filter((group) => group.injection === kind).length;
    assert.ok(evidence.includes(`\`${kind}\` — ${count} groups (${byKind(kind)})`), kind);
  }
  assert.match(evidence, /No case of the fault harness runs a host driver or the daemon/u);
  // Each row carries its kind, and a written observation its written fields.
  assert.match(evidence, /\| `F001` \| crash \| `real_path` \| yes \| yes \| not paired \|/u);
  const f020 = matrix.groups.find((group) => group.id === "F020");
  assert.ok(evidence.includes(`| \`F020\` | faults | \`written_observation\`: ${f020.written_fields.map((name) => `\`${name}\``).join(", ")} | NO | yes | yes |`), evidence);
});

test("the injection kinds are rendered from the matrix, not from prose", async () => {
  const changed = structuredClone(matrix);
  const f005 = changed.groups.find((group) => group.id === "F005");
  f005.injection = "written_observation";
  f005.written_fields = ["projectRoot"];
  // Debt 11f (R7-6): the run's states are read with the matrix it ran
  // against, and a package refuses a run whose states its matrix does not give.
  const run = { ...cleanRoom, coverage: coverageReport(changed, { ...harnessCoverage(DAEMON_STEPS), ...faultCoverage({ results: FAULTS }) }) };
  const { text } = await build({ matrix: changed, cleanRoom: run });
  const count = changed.groups.filter((group) => group.injection === "written_observation").length;
  assert.ok(section5(text).includes(`\`written_observation\` — ${count} groups (\`F005\``), section5(text));
});

test("the package's injection kinds are the coverage rule's, each with its meaning", async () => {
  // Review of 11f (nit): the builder kept its own list of kinds beside the one
  // the coverage rule and the validator read, so a fourth kind could be
  // rendered by one and missed by the other.
  const builder = await import("../scripts/build-panel-package.mjs");
  const { INJECTION_KINDS } = await import("../scripts/lib/clean-room-coverage.mjs");
  assert.deepEqual(Object.keys(builder.INJECTION_MEANINGS ?? {}), [...INJECTION_KINDS]);
  for (const kind of INJECTION_KINDS) assert.ok(builder.INJECTION_MEANINGS[kind].length > 0, kind);
});

test("a run whose fault harness ran a group the matrix calls a real daemon path refuses", async () => {
  const changed = structuredClone(matrix);
  changed.groups.find((group) => group.id === "F020").injection = "real_path";
  await assert.rejects(build({ matrix: changed }), /F020.*real_path.*fault harness/u);
});

test("the git commands a case ran are the run's record, and an unrecorded run says so", async () => {
  const { text } = await build();
  const evidence = section5(text);
  assert.ok(evidence.includes("`F020`: `update-ref --create-reflog refs/autosk/epics/k/audit`, `update-ref -d refs/autosk/epics/k/candidate`"), evidence);
  assert.match(text, /none of them goes through a host driver, the daemon or a ref-custody helper/u);
  const unrecorded = await build({
    cleanRoom: { ...cleanRoom, faults: cleanRoom.faults.map(({ git_ref_writes, ...entry }) => entry) },
  });
  assert.match(section5(unrecorded.text), /This run did not record which git commands its cases ran/u);
  assert.match(unrecorded.text, /the run did not record which fault groups write a ref/u);
});

test("the contracts with no measured link are searched for under src/, and only what was found is stated", async () => {
  const measured = await measureContracts();
  const unlinked = measured.filter((entry) => entry.evaluators.length === 0);
  for (const entry of measured) {
    assert.ok(Array.isArray(entry.named_under_src), entry.path);
    assert.ok(Array.isArray(entry.src_references?.naming) && Array.isArray(entry.src_references?.named_paths), entry.path);
  }
  // Review of 10h (H1): `integration-authorization.md` has no refusal class
  // named under src/, and `staging-acceptance.mjs` still implements its §1 and
  // cites it — so a class search alone cannot say "not implemented". The
  // second measurement is the contract's name in src/, or a src/ path the
  // contract names; the partition is derived from both, never hand-counted.
  const found = (entry) => entry.named_under_src.length > 0
    || entry.src_references.naming.length > 0 || entry.src_references.named_paths.length > 0;
  const unreferenced = unlinked.filter((entry) => !found(entry));
  const referenced = unlinked.filter(found);
  assert.equal(unreferenced.length + referenced.length, unlinked.length);
  // The partition as measured on this tree (ADR-094): pinned so a regression in measureContracts is seen.
  // Debt 12a (R8-13): `validate:platform-support` imports the doctor's registry
  // and the preflight's sets to hold each install record's `checked_by`, so
  // `platform-support.md` is linked by import now (was unlinked and
  // unreferenced: 17 unlinked and 13 unreferenced before).
  assert.equal(unlinked.length, 16);
  assert.equal(unreferenced.length, 12);
  assert.equal(referenced.length, 4);
  const platform = measured.find((entry) => entry.path === "docs/contracts/platform-support.md");
  assert.deepEqual(platform.evaluators.map((entry) => `${entry.link}:${entry.module}`),
    ["import:src/host/doctor-checks.mjs", "import:src/host/workflow-preflight.mjs"]);
  assert.ok(platform.evaluators.every((entry) => entry.via.includes("scripts/validate-platform-support.mjs")));
  const byPath = new Map(unlinked.map((entry) => [entry.path, entry]));
  // Debt 11b: the CAS admission's check of the named record cites the contract too.
  assert.deepEqual(byPath.get("docs/contracts/integration-authorization.md").src_references.naming, ["src/host/epic-staging.mjs", "src/host/staging-acceptance.mjs"]);
  assert.ok(byPath.get("docs/contracts/integration-authorization.md").src_references.named_paths.includes("src/host/staging-acceptance.mjs"));
  assert.ok(byPath.get("docs/contracts/refusal-vocabulary.md").src_references.named_paths.includes("src/host/workflow-factory.mjs"));
  assert.ok(unreferenced.some((entry) => entry.path === "docs/contracts/anchor-pack.md"));
  assert.deepEqual(byPath.get("docs/contracts/arena.md").named_under_src, [{ code: "arena_judge_family_conflict", modules: ["src/host/cross-family-review.mjs"] }]);

  const { text } = await build({ contracts: measured });
  assert.ok(text.includes(`${unlinked.length} of the ${measured.length} contracts say **no link measured**`), text);
  assert.ok(text.includes(`For ${unreferenced.length} of them nothing was found`), text);
  for (const entry of unreferenced) assert.ok(text.includes(`\`${entry.path}\``), entry.path);
  assert.ok(text.includes(`${referenced.length} are referenced from \`src/\` (a reference is not a claim of implementation)`), text);
  assert.ok(text.includes("`docs/contracts/integration-authorization.md`: named in `src/host/epic-staging.mjs`, `src/host/staging-acceptance.mjs`"), text);
  assert.ok(text.includes("`docs/contracts/arena.md`: `arena_judge_family_conflict` in `src/host/cross-family-review.mjs`"), text);
  // Only what was measured: no inference from an absence to "unimplemented".
  assert.doesNotMatch(text, /no runtime code in this repository implements them/u);
  assert.doesNotMatch(text, /whether the remaining ones are unimplemented or only\s+unlinked is open/u);
});

test("the host's alignment inputs are named as taken, not computed", async () => {
  const { text } = await build();
  for (const name of ["`subject_hash`", "material manifest", "projector", "classifier"]) {
    assert.ok(text.includes(name), name);
  }
  assert.match(text, /no module in this repository computes any of them/u);
});

test("the panel records say which is a member and why the others are not", async () => {
  const records = await panelRecords(candidate);
  assert.deepEqual(records.map((entry) => [entry.path.split("/").pop(), entry.member, entry.anchor_corrections]), [
    ["round-1.json", false, 0],
    ["round-2.json", false, 0],
    ["round-3.json", false, 0],
    ["round-4.json", true, 3],
    ["round-5.json", false, 0],
    ["round-6.json", false, 0],
    ["round-7.json", false, 0],
    ["round-8.json", false, 0],
    ["round-9.json", false, 0],
  ]);
  const { text } = await build();
  assert.match(text, /`resources\/design-candidate\/panel\/round-4\.json` is a member because it carries the operative membership rule/u);
  assert.ok(text.includes("`resources/design-candidate/panel/round-5.json`"), text);
  assert.ok(text.includes("`resources/design-candidate/panel/round-6.json`"), text);
  assert.ok(text.includes("`resources/design-candidate/panel/round-7.json`"), text);
  assert.ok(text.includes("`resources/design-candidate/panel/round-8.json`"), text);
  assert.ok(text.includes("`resources/design-candidate/panel/round-9.json`"), text);
  assert.match(text, /records of what a round found, not design the verdict binds/u);
});

test("a panel record that carries anchor corrections and is not a member refuses the build", async () => {
  const records = (await panelRecords(candidate)).map((entry) => ({ ...entry, member: false }));
  await assert.rejects(build({ panelRecords: records }), /round-4\.json carries 3 anchor corrections and is not a member/u);
});

test("the test evidence names its skipped tests and refuses a count it cannot name", async () => {
  const { text } = await build();
  assert.match(text, /\*\*1769 pass, 0 fail, 0 cancelled, 1 skipped\*\* of 1770 tests/u);
  assert.match(text, /Skipped: a case folded by the filesystem — filesystem does not fold case\./u);
  await assert.rejects(
    build({ tests: { ...TESTS, skipped_names: [] } }),
    /1 skipped test.*0 named/u,
  );
  // Review of 10h (M3): a failed or cancelled test is named too.
  await assert.rejects(build({ tests: { ...TESTS, failed: 1, cancelled: 1, failed_names: ["one"] } }), /2 failed or cancelled.*1 named/u);
  await assert.rejects(build({ tests: { passed: 1769, failed: 0 } }), /test evidence/u);
  const cancelled = await build({ tests: { ...TESTS, passed: 1767, failed: 1, cancelled: 1, failed_names: ["broken", "cut short"] } });
  assert.match(cancelled.text, /\*\*1767 pass, 1 fail, 1 cancelled, 1 skipped\*\*/u);
  assert.match(cancelled.text, /Failed or cancelled: broken; cut short\./u);
  // A skip with no reason is named without a dangling separator.
  const bare = await build({ tests: { ...TESTS, skipped_names: [{ name: "bare", reason: "" }] } });
  assert.match(bare.text, /Skipped: bare\./u);
});

// Real node 24 output shapes (spec, the default reporter, and TAP), captured
// from `node --test` over a file with a plain, a skipped, a todo, a failing
// todo, a failing test, a skipped suite, and a timed-out parent whose child
// was cancelled.
const SPEC_LOG = [
  "",
  "> autosk-traycer-flow@0.0.0 test",
  "> node --test test/*.test.mjs",
  "",
  "✔ ok one (0.876572ms)",
  "﹣ skip plain (0.116577ms) # SKIP",
  "✔ todo one (0.128461ms) # later",
  "⚠ todo failing (0.187728ms) # TODO",
  "✖ fails (0.158848ms)",
  "▶ outer",
  "  ✖ inner slow (30.728247ms)",
  "✖ outer (31.204134ms)",
  "ℹ tests 8",
  "ℹ suites 0",
  "ℹ pass 2",
  "ℹ fail 1",
  "ℹ cancelled 2",
  "ℹ skipped 1",
  "ℹ todo 2",
  "ℹ duration_ms 111.36869",
  "",
  "✖ failing tests:",
  "",
  "test at tt/b.test.mjs:5:1",
  "⚠ todo failing (0.187728ms) # TODO",
  "  Error: x",
  "",
  "test at tt/b.test.mjs:6:1",
  "✖ fails (0.158848ms)",
  "  Error: boom",
  "",
  "test at tt/c.test.mjs:3:11",
  "✖ inner slow (30.728247ms)",
  "  'test did not finish before its parent and was cancelled'",
  "",
  "test at tt/c.test.mjs:2:1",
  "✖ outer (31.204134ms)",
  "  'test timed out after 30ms'",
].join("\r\n");

const TAP_LOG = [
  "TAP version 13",
  "ok 1 - ok one",
  "  ---",
  "  type: 'test'",
  "  ...",
  "ok 2 - skip plain # SKIP",
  "  ---",
  "  type: 'test'",
  "  ...",
  "ok 3 - todo one # TODO later",
  "not ok 4 - todo failing # TODO",
  "not ok 5 - fails",
  "ok 6 - skipped suite # SKIP suite reason",
  "  ---",
  "  type: 'suite'",
  "  ...",
  "    not ok 1 - inner slow",
  "      ---",
  "      type: 'test'",
  "      failureType: 'cancelledByParent'",
  "      ...",
  "not ok 7 - outer",
  "ok 8 - with \\# hash # SKIP why",
  "  ---",
  "  type: 'test'",
  "  ...",
  "# tests 9",
  "# suites 1",
  "# pass 2",
  "# fail 1",
  "# cancelled 2",
  "# skipped 2",
  "# todo 2",
].join("\n");

test("the test summary is read from the run's own log, in either reporter", () => {
  assert.deepEqual(testSummary(SPEC_LOG), {
    tests: 8, passed: 2, failed: 1, cancelled: 2, skipped: 1, todo: 2,
    skipped_names: [{ name: "skip plain", reason: "" }],
    failed_names: ["fails", "inner slow", "outer"],
  });
  // TAP tells a skipped suite from a skipped test by its `type`, escapes `#`
  // in names, and a failing todo is not a failure.
  assert.deepEqual(testSummary(TAP_LOG), {
    tests: 9, passed: 2, failed: 1, cancelled: 2, skipped: 2, todo: 2,
    skipped_names: [{ name: "skip plain", reason: "" }, { name: "with # hash", reason: "why" }],
    failed_names: ["fails", "inner slow", "outer"],
  });
  assert.throws(() => testSummary("no summary here"), /no test summary/u);
});

test("a log with more than one summary block, or none of cancelled, is refused", () => {
  const twice = `${SPEC_LOG}\n${SPEC_LOG}`;
  assert.throws(() => testSummary(twice), /2 summary blocks/u);
  assert.throws(() => testSummary(SPEC_LOG.replace("ℹ cancelled 2\r\n", "")), /cancelled not found/u);
});

test("a skipped line the spec reporter prints for a suite does not pass as a skipped test", async () => {
  // The spec reporter prints a skipped suite like a skipped test and does not
  // count it; the names then outnumber the count and the build refuses.
  const log = SPEC_LOG.replace("✔ todo one", "﹣ a skipped suite (0.1ms) # suite reason\r\n✔ todo one");
  const summary = testSummary(log);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.skipped_names.length, 2);
  await assert.rejects(build({ tests: summary }), /1 skipped test.*2 named/u);
});

test("each group is printed as designed and as injected, so a description claims no more than the run", async () => {
  const { text } = await build();
  for (const group of matrix.groups) {
    assert.ok(text.includes(`- \`${group.id}\` (${group.boundary}) — designed: ${group.description}. Injected: ${group.injection_note}.`), group.id);
  }
  // Review of 10h (M2): F003 is designed as a session-lifecycle crash and
  // injected at the second creation-index write.
  assert.match(matrix.groups.find((group) => group.id === "F003").injection_note, /second creation-index write/u);
  // CodeRabbit on #278: F003's designed outcome is what its kill point leaves —
  // the header written, the meta lost — and the page prints it so.
  assert.ok(text.includes("- `F003` (session_lifecycle) — designed: transcript header written, session meta lost. Injected:"), text);
  assert.doesNotMatch(text, /designed: session meta written, transcript header lost/u);
});

test("a run that did not run a fault-harness group refuses the build", async () => {
  const faults = cleanRoom.faults.filter((entry) => entry.id !== "F009");
  await assert.rejects(build({ cleanRoom: { ...cleanRoom, faults } }), /F009.*the fault harness did not run it/u);
});

test("the round-record sentence names the check that holds it", async () => {
  const { text } = await build();
  assert.match(text, /checked by `npm test` \(`test\/validate-design-candidate\.test\.mjs`\) against the roster its round sat/u);
});

// Debt 11c (R7-10, R7-9, R7-11): §5 says plainly that no product code
// evaluates the graph, measured from who calls `buildWorkflow`, and names the
// v1 owners of the points the design rests on.
import { factoryCallers } from "../scripts/build-panel-package.mjs";

test("the factory's callers are measured, and none of them is product code", async () => {
  const callers = await factoryCallers();
  assert.ok(callers.length > 0);
  assert.deepEqual(callers, [...callers].sort());
  assert.ok(callers.every((file) => file.startsWith("scripts/")), callers.join(", "));
  assert.ok(!callers.includes("src/host/workflow-factory.mjs"), "the definition is not a caller");
  assert.ok(callers.includes("scripts/verify-autosk-exits.mjs"));
});

test("§5 states that no product evaluator of the graph exists, from the measured callers", async () => {
  const callers = await factoryCallers();
  const { text } = await build();
  const evidence = section5(text);
  assert.match(evidence, /No product code evaluates the graph\./u);
  for (const file of callers) assert.ok(evidence.includes(`\`${file}\``), file);
  assert.match(evidence, /`guards\[\]\.authority`/u);
  assert.match(evidence, /no file under `src\/` calls it/u);
  assert.match(evidence, /#18 \(`enforcement_points`, ADR-097\)/u);
  // Review of 11c (M1): #18 owns the mechanism; the meaning of a predicate is its
  // domain owner's. Debt 12f (R8-8): each predicate names its domain and the
  // matrix names the domain's one owner, derived from the graph.
  assert.match(evidence, /each predicate names its domain, the matrix names one owner for each domain\s+\(`predicate_domains`, ADR-107\)/u);
  assert.match(evidence, /`validate:capabilities` reads those points and those\s+domains from the graph/u);
  assert.doesNotMatch(evidence, /stays with its domain record/u);
  const product = await build({ factoryCallers: ["scripts/verify-autosk-exits.mjs", "src/host/extension.mjs"] });
  const productEvidence = section5(product.text);
  assert.doesNotMatch(productEvidence, /no file under `src\/` calls it/u);
  assert.doesNotMatch(productEvidence, /No product code evaluates the graph\./u);
  assert.match(productEvidence, /`src\/host\/extension\.mjs` under `src\/`/u);
});

test("§5 names the daemon capability check, the session token and the resume leaves with their v1 owners", async () => {
  const evidence = section5((await build()).text);
  assert.match(evidence, /`daemon\.capabilities_pinned`/u);
  // Review of 11c (M2): the load-time call is the entry point's (#18), and the function it calls #11's.
  assert.match(evidence, /the daemon capability check to #34, the call at extension load to #18's entry point and the function it calls to #11 \(ADR-097\)/u);
  assert.match(evidence, /that dispatch gate is #34's in matrix v1 \(ADR-097\)/u);
  assert.match(evidence, /`AUTOSK_SESSION_TOKEN`/u);
  assert.match(evidence, /`autosk metadata set`/u);
  assert.match(evidence, /#231/u);
  assert.doesNotMatch(evidence, /nothing calls it before a model launch yet\. All of this is implementation work\s+under #40/u);
  assert.doesNotMatch(evidence, /\(ADR-090, #40\)|\(ADR-091, #40\)/u);
  // The gap the bullet discloses is the tree's: the pinned patch hands the
  // token to both agents' model processes, and the factory writes the resume
  // leaves through the plain CLI.
  const patch = read("compat/autosk/patches/0028-session-bound-create.patch");
  for (const agent of ["claude-agent", "pi-agent"]) {
    const hunk = patch.slice(patch.indexOf(`+++ b/daemon/extensions/${agent}/src/index.ts`));
    assert.match(hunk.slice(0, hunk.indexOf("\ndiff --git")), /^\+ {4}AUTOSK_SESSION_TOKEN: ctx\.sessionToken,$/mu, agent);
  }
  assert.match(read("src/host/workflow-factory.mjs"), /\["autosk", "metadata", "set", ctx\.tasks\.currentId, `park\.receipts\.\$\{stepName\}`/u);
});

test("the factory's users are measured by identifier over every code extension, TypeScript included", async () => {
  // Review of 11c (L1): a TypeScript entry point, or a caller that passes
  // `buildWorkflow` on instead of calling it, is product code that uses the
  // factory; the measurement must see both.
  const root = mkdtempSync(path.join(os.tmpdir(), "factory-callers-"));
  const write = (relative, text) => {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), text);
  };
  try {
    write("src/host/workflow-factory.mjs", "export function buildWorkflow(document) { return document; }\n");
    write("src/host/extension.ts", "export default (autosk) => autosk.registerWorkflow(buildWorkflow(graph, { evaluate }));\n");
    write("scripts/build-all.mjs", "const built = documents.map(buildWorkflow);\n");
    write("scripts/notes.mjs", "// buildWorkflow is described elsewhere\n");
    const callers = await factoryCallers({ root });
    assert.deepEqual(callers, ["scripts/build-all.mjs", "src/host/extension.ts"]);
    const evidence = section5((await build({ factoryCallers: callers })).text);
    assert.match(evidence, /`src\/host\/extension\.ts` under `src\/`/u);
    assert.doesNotMatch(evidence, /No product code evaluates the graph\./u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("§5 says a resume the graph declares the user's decision is admitted only on a verified record through the caller's verifier, and who writes, signs and guards the leaf (R7-4; review M1, M2; CodeRabbit on #270)", async () => {
  // Round 7 of #39, R7-4, and the review of 11e (M1, M2): the factory refuses
  // a resume into a declared decision target without the decision recorded
  // under the park. CodeRabbit on #270: the leaf alone was checked, so a copy
  // opened another task; the record it names is now verified through the
  // caller's verifier, which refuses by default, and the package says so.
  const evidence = section5((await build()).text);
  assert.match(evidence, /A resume the graph declares the user's decision[^.]*is admitted only on a verified `UserDecisionRecord` through the caller's verifier/u);
  assert.match(evidence, /the default verifier refuses, so no decision-gated resume is admitted on a real host today/u);
  assert.match(evidence, /The leaf's writer is the resume path \(#35\), the signer and verifier are #4's, and the CAS on the leaf is #18's \(roadmap #231\)/u);
  assert.match(evidence, /reads one more it does not write, `park\.decision`/u);
  assert.match(evidence, /forge a receipt that opens a resume/u);
  assert.match(evidence, /a forged `park\.decision` opens nothing without a verified record/u);
  assert.doesNotMatch(evidence, /cap_decision|shape and park only|verified by nobody/u);
});

test("§5 says every predicate a cap binds declares the quantity it compares, and names both caps a round past which is the user's (R8-4, R8-5)", async () => {
  // Round 8 of #39, R8-5: ADR-099 left the repair cycle's cap open to #32
  // and the package did not say so. The cap is declared now, so the package
  // names it among the decision-gated rounds rather than in what is not
  // claimed; and the count of cap predicates is no longer four (R8-4).
  const evidence = section5((await build()).text);
  assert.match(evidence, /a round past `review_cap` or `verification_cap`/u);
  assert.match(evidence, /in the own `reads` of every predicate a cap binds/u);
  assert.doesNotMatch(evidence, /the four cap predicates/u);
});

// Debt 11f (R7-6, round 7 of #39): the package printed
// `covered_by_real_fault=20; complete=true` and then explained that the state
// name "says no more than that". The run now gives each group the state that
// says how it was covered, and the package prints the count of every state.

import { COVERAGE_STATES } from "../scripts/lib/clean-room-coverage.mjs";

test("the package prints the coverage by state, and only covered_by_real_fault counts toward the release gate", async () => {
  const evidence = section5((await build()).text);
  const kind = (injection) => matrix.groups.filter((group) => group.injection === injection).length;
  // Debt 12e: F004 alone (it was F004 and the five measured groups: 6).
  const counts = {
    covered_by_real_fault: 1,
    covered_without_control: 1,
    covered_by_substitute_fault: 2,
    covered_by_host_function: kind("measured_observation"),
    covered_by_written_observation: kind("written_observation"),
    control_failed: 0,
    not_covered: 0,
  };
  const line = `Coverage, by state: ${COVERAGE_STATES.map((state) => `${state}=${counts[state]}`).join(", ")}; complete=false.`;
  assert.ok(evidence.includes(line), evidence);
  assert.match(evidence, /Only `covered_by_real_fault` counts toward the release gate \(#36\)/u);
  // Debt 12e (R8-7, R8-12): the count requires the designed fault, met on the product path.
  const flat = evidence.replace(/\s+/gu, " ");
  assert.match(flat, /the designed fault \(`injection_matches_design`\), made against the built daemon \(`real_path`\)/u);
  assert.doesNotMatch(flat, /`real_path` or `measured_observation`/u);
  assert.match(flat, /The gate counts 1 of 20 groups: `F004`\./u);
  // The prose that explained the old count away is gone, not lengthened.
  assert.doesNotMatch(evidence, /says no more than that/u);
  assert.doesNotMatch(evidence, /not\*\* a statement that every group was injected for real/u);
  // The rows carry what the state is read from.
  assert.match(evidence, /\| `F001` \| crash \| `real_path` \| yes \| yes \| not paired \|/u);
  assert.match(evidence, /\| `F004` \| identity \| `real_path` \| yes \| yes \| yes \|/u);
  assert.match(evidence, /\| `F005` \| faults \| `measured_observation` \| yes \| yes \| yes \|/u);
  // A state no row is in is printed as zero, not left out; and a daemon
  // harness that never ran names no harness on its rows (review of 11f, L3).
  const failed = runReport({ steps: [{ step: "prepare", ok: false }] });
  const printed = section5((await build({ cleanRoom: failed })).text);
  assert.ok(printed.includes(`covered_by_real_fault=0, covered_without_control=0, covered_by_substitute_fault=0, covered_by_host_function=${counts.covered_by_host_function}, covered_by_written_observation=${counts.covered_by_written_observation}, control_failed=0, not_covered=4;`), printed);
  assert.match(printed, /\| `F001` \| none \| `real_path` \| yes \| NO \| not paired \| not covered \|/u);
});

test("the package says, per group, whether the designed fault was met, and who converts each group that does not count", async () => {
  // Debt 12e (R8-7, R8-12): the page gives what the matrix's fields say — the
  // departure where the run is not the designed fault, and the record that
  // owns the product path — so a reader is not left to infer either from `injection_note`.
  const evidence = section5((await build()).text);
  for (const entry of matrix.groups) {
    const line = evidence.split("\n").find((text) => text.startsWith(`- \`${entry.id}\` (${entry.boundary}) — designed:`));
    assert.ok(line, entry.id);
    if (entry.injection_matches_design) assert.ok(line.endsWith(" Run is the designed fault: yes."), line);
    else assert.ok(line.endsWith(` Run is the designed fault: no — ${entry.design_departure}.`), line);
  }
  assert.match(evidence, /Run is the designed fault: no — the run does not kill the daemon or restart it/u);
  assert.ok(evidence.includes("**Who converts a group to the product path.**"), evidence);
  for (const entry of matrix.groups.filter((group) => group.product_path_owner)) {
    assert.ok(evidence.includes(`- \`${entry.id}\` — ${entry.product_path_owner}`), entry.id);
  }
  for (const id of ["F001", "F004"]) assert.ok(!evidence.includes(`- \`${id}\` — #36`), id);
  // Review of 12e (L3, nits): the owners are for each group that is not the designed
  // fault on the product path — not "each group that does not count", which F001
  // (an owner-less group that counts once a control is asked) refutes — and a
  // conversion of a host driver's group to `real_path` is a decision.
  const flat = evidence.replace(/\s+/gu, " ");
  assert.match(flat, /each group that is not the designed fault on the product path names in the matrix/u);
  assert.doesNotMatch(flat, /each group that does not count names/u);
  assert.match(flat, /`F001` has no owner and does not count either: it is the designed fault on the product path, and counts once #36's crash harness asks a control/u);
  assert.match(flat, /becomes `real_path` by a decision, when the extension entry point \(#18\) reaches that driver or helper/u);
  // The column and the bullets say "run is the designed fault", not "met", which
  // the gate's "met on the product path" would collide with.
  assert.ok(evidence.includes("| group | harness | injection | run is the designed fault | fault detected | control silent | evidence |"), evidence);
  assert.doesNotMatch(evidence, /designed fault met/iu);
  // A measured group is a host function's answer, and is not counted.
  assert.match(evidence.replace(/\s+/gu, " "), /A `measured_observation` row shows a host function's answer to a real fixture/u);
});

test("a report whose rows lack only the flag, or that counts by the old five states, is refused (review of 12e, L2)", async () => {
  // The package recomputes a run's coverage from its records and refuses a report
  // that says otherwise; these two shapes of an older report are pinned by name.
  const restated = (change) => ({ ...cleanRoom, coverage: { ...cleanRoom.coverage, ...change } });
  const unflagged = cleanRoom.coverage.rows.map(({ injection_matches_design, ...row }) => row);
  await assert.rejects(
    build({ cleanRoom: restated({ rows: unflagged }) }),
    /F001: the run's row says injection_matches_design undefined, and its own records give injection_matches_design true; F002: the run's row says injection_matches_design undefined, and its own records give injection_matches_design false/u,
  );
  const old = { covered_by_real_fault: 6, covered_without_control: 3, covered_by_written_observation: 11, control_failed: 0, not_covered: 0 };
  await assert.rejects(
    build({ cleanRoom: restated({ counts: old }) }),
    /the run's counts say covered_by_real_fault=6, covered_without_control=3, covered_by_substitute_fault=undefined, covered_by_host_function=undefined, and its own records give covered_by_real_fault=1, covered_without_control=1, covered_by_substitute_fault=2, covered_by_host_function=5$/u,
  );
});

/** A clean-room report as the run writes it: its coverage is what the run's own functions derive from its records. */
function runReport({ steps = cleanRoom.steps, faults = FAULTS } = {}) {
  return { ...cleanRoom, steps, faults, coverage: coverageReport(matrix, { ...harnessCoverage(steps), ...faultCoverage({ results: faults ?? [] }) }) };
}

test("the package prints the coverage the run's own records give, and refuses a report that says otherwise", async () => {
  // Review of 11f (M1): the package printed the report's counts and `complete`
  // as given and held each row only to the coverage rule, so a report could
  // say what its records do not. It now recomputes the coverage with the
  // run's own functions from the run's records — the daemon harnesses' steps
  // and the fault harness's cases — and refuses rows, counts or `complete`
  // that differ, with exactly one row per matrix group.
  const restated = (change) => ({ ...cleanRoom, coverage: { ...cleanRoom.coverage, ...change } });
  const rowsWith = (id, change) => cleanRoom.coverage.rows.map((row) => (row.id === id ? { ...row, ...change } : row));
  // (a) Correct rows under the round-7 headline.
  await assert.rejects(
    build({ cleanRoom: restated({ counts: { ...cleanRoom.coverage.counts, covered_by_real_fault: 20, covered_without_control: 0, covered_by_written_observation: 0 } }) }),
    /the run's counts say covered_by_real_fault=20, covered_without_control=0, covered_by_written_observation=0, and its own records give covered_by_real_fault=1, covered_without_control=1, covered_by_written_observation=11/u,
  );
  await assert.rejects(build({ cleanRoom: restated({ complete: true }) }), /the run says complete=true, and its own records give complete=false/u);
  // (b) The round-7 counts with no rows behind them.
  const everyGroup = matrix.groups.map((group) => group.id).join(", ");
  await assert.rejects(
    build({ cleanRoom: restated({ rows: [], counts: { covered_by_real_fault: 20 }, complete: true }) }),
    new RegExp(`the run's coverage rows are not one per matrix group: missing ${everyGroup}$`, "u"),
  );
  // (c) A report missing a group's row, repeating one, or adding one the matrix does not have.
  await assert.rejects(
    build({ cleanRoom: restated({ rows: cleanRoom.coverage.rows.filter((row) => row.id !== "F001") }) }),
    /the run's coverage rows are not one per matrix group: missing F001$/u,
  );
  await assert.rejects(build({ cleanRoom: restated({ rows: [...cleanRoom.coverage.rows, cleanRoom.coverage.rows[4]] }) }), /the run's coverage rows are not one per matrix group: repeated F005$/u);
  await assert.rejects(
    build({ cleanRoom: restated({ rows: [...cleanRoom.coverage.rows, { ...cleanRoom.coverage.rows[4], id: "F099" }] }) }),
    /the run's coverage rows are not one per matrix group: not in the matrix F099$/u,
  );
  // (d) The crash harness asks no control; a row saying it did is refused.
  await assert.rejects(
    build({ cleanRoom: restated({ rows: rowsWith("F001", { control: true, state: "covered_by_real_fault" }) }) }),
    /F001: the run's row says state "covered_by_real_fault", control true, and its own records give state "covered_without_control", control null/u,
  );
  // (d2) Debt 12e (R8-7): F002's run is a substitute for its designed fault, and
  // a report that counts it, with a control the crash harness never asked, is refused.
  await assert.rejects(
    build({ cleanRoom: restated({ rows: rowsWith("F002", { control: true, state: "covered_by_real_fault" }) }) }),
    /F002: the run's row says state "covered_by_real_fault", control true, and its own records give state "covered_by_substitute_fault", control null/u,
  );
  // (d3) Debt 12e (R8-12): a measured group counted as a real fault is refused too.
  await assert.rejects(
    build({ cleanRoom: restated({ rows: rowsWith("F005", { state: "covered_by_real_fault" }) }) }),
    /F005: the run's row says state "covered_by_real_fault", and its own records give state "covered_by_host_function"/u,
  );
  // (e) A case record whose control did not stay silent, beside a row saying it did.
  const noisy = FAULTS.map((entry) => (entry.id === "F005" ? { ...entry, control: false } : entry));
  await assert.rejects(
    build({ cleanRoom: { ...cleanRoom, faults: noisy } }),
    /F005: the run's row says state "covered_by_host_function", control true, and its own records give state "control_failed", control false/u,
  );
  // (f) A crash harness step that failed, beside rows still covered.
  const crashFailed = cleanRoom.steps.map((step) => (step.step === "harness:crash" ? { ...step, ok: false } : step));
  await assert.rejects(
    build({ cleanRoom: { ...cleanRoom, steps: crashFailed } }),
    /F001: the run's row says state "covered_without_control", evidence "reservation\.before \/ reservation\.after", detected true, and its own records give state "not_covered", evidence "the crash harness step failed", detected false/u,
  );
  // Round 7's own report — rows from before the run recorded what it observed,
  // under the old headline — is refused, not reprinted.
  const old = restated({
    rows: cleanRoom.coverage.rows.map(({ injection, injection_matches_design, detected, ...row }) => ({ ...row, state: "covered_by_real_fault" })),
    counts: { covered_by_real_fault: 20 },
    complete: true,
  });
  await assert.rejects(build({ cleanRoom: old }), /F001: the run's row says injection undefined, injection_matches_design undefined, state "covered_by_real_fault", detected undefined/u);
  // A report that agrees with its records is printed from the records: a
  // case whose control did not stay silent reads "NO", as its record says.
  const evidence = section5((await build({ cleanRoom: runReport({ faults: noisy }) })).text);
  assert.match(evidence, /\| `F005` \| faults \| `measured_observation` \| yes \| yes \| NO \| F005 detail \|/u);
  assert.ok(evidence.includes("control_failed=1"), evidence);
});

// Debt 11f (R7-14 package half, R7-23 disclosure half): "No user decision is
// accepted on any host" was true and overbroad — one host function mints an
// authority no user signed, and the module that holds it parks with names the
// graph does not carry. The bullet says both, and the tree is held to it here.

import { KINDS, PARK_REASONS as ALIGNMENT_REASONS, alignmentIdentity, correctionEffect, gateAdmission, materialAmbiguityErrors, policyAlignment } from "../src/host/alignment-gates.mjs";
import { filesUsing } from "../scripts/lib/code-references.mjs";

const notClaimed = (text) => text.slice(text.indexOf("### What is not claimed"), text.indexOf("## 6. "));

const alignmentFacts = (kind) => ({
  project_root_sha256: "1".repeat(64), epic_id: "epic-1", kind, anchor_version: 1,
  scope_hash: "2".repeat(64), subject_hash: "3".repeat(64), material_manifest_hash: "4".repeat(64),
  projector: { version: 1, hash: "5".repeat(64), inputs_hash: "6".repeat(64) },
  classifier: { version: 1, hash: "7".repeat(64) },
  policy: { issuance_hash: "8".repeat(64), disposition_hash: "9".repeat(64) },
  protocol_hash: "a".repeat(64),
});

/**
 * The codes `alignment-gates.mjs` raises, read from the module itself: the
 * code of every `demand(` in its source, and the reasons its park and its
 * ambiguity check return when they are run.
 */
function raisedAlignmentCodes() {
  const source = read("src/host/alignment-gates.mjs");
  const codes = new Set();
  for (const call of source.matchAll(/\bdemand\(/gu)) {
    let depth = 0;
    let index = call.index + call[0].length;
    for (; index < source.length; index += 1) {
      const char = source[index];
      if (char === "'" || char === '"' || char === "`") {
        for (index += 1; source[index] !== char; index += source[index] === "\\" ? 2 : 1);
        continue;
      }
      if ("([{".includes(char)) depth += 1;
      else if (")]}".includes(char)) depth -= 1;
      else if (char === "," && depth === 0) break;
    }
    const code = /^\s*'([a-z_]+)'/u.exec(source.slice(index + 1));
    if (code) codes.add(code[1]);
  }
  const facts = alignmentFacts("brief");
  codes.add(gateAdmission({ records: [], facts }).reason);
  codes.add(gateAdmission({ records: [{ kind: "brief", identity: "stale" }], facts }).reason);
  for (const error of materialAmbiguityErrors({ assumptions: [{ id: "a", material: true }] })) codes.add(error.reason);
  return codes;
}

/**
 * The module's own functions that call `policyAlignment` or `gateAdmission`,
 * directly or through each other, read from its source (review of 11f, L2): a
 * product caller of one of them reaches the path as surely as a caller of the
 * two functions.
 */
function alignmentWrappers() {
  const source = read("src/host/alignment-gates.mjs");
  const bodies = new Map([...source.matchAll(/^(?:export )?function (\w+)\([\s\S]*?^\}/gmu)].map((match) => [match[1], match[0].slice(match[0].indexOf("\n"))]));
  const callers = new Set(["policyAlignment", "gateAdmission"]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, body] of bodies) {
      if (!callers.has(name) && [...callers].some((callee) => new RegExp(`(?<![\\w$.])${callee}\\(`, "u").test(body))) {
        callers.add(name);
        grew = true;
      }
    }
  }
  return [...callers].filter((name) => name !== "policyAlignment" && name !== "gateAdmission").sort();
}

test("§5 says no user decision is accepted today, and names the one path that admits an authority no user signed", async () => {
  // The path the bullet describes is the tree's: a policy object the caller
  // makes up — no decision behind it, its own project, Epic, scope and expiry
  // elsewhere, its own policy hashes — mints `authority: policy` for every
  // kind, `brief` included, and the gate admits the record.
  const policy = {
    policy_ref: "made-up", kinds: [...KINDS], anchor_version: 1,
    project_root_sha256: "e".repeat(64), epic_id: "another", scope_hash: "d".repeat(64), expires_at: "2000-01-01T00:00:00Z",
    issuance_hash: "b".repeat(64), disposition_hash: "c".repeat(64),
  };
  assert.ok(KINDS.includes("brief"));
  for (const kind of KINDS) {
    const facts = alignmentFacts(kind);
    const record = policyAlignment(policy, { ...facts, user_decision: null });
    assert.equal(record.authority, "policy", kind);
    assert.equal(record.user_decision, null, kind);
    // Review of 11f (L1): the record is bound — its identity is the facts
    // its caller hands in, whose policy hashes are not the policy object's
    // own — and what nothing checks is the policy.
    assert.equal(record.identity, alignmentIdentity({ ...facts, user_decision: null }), kind);
    assert.notEqual(facts.policy.issuance_hash, policy.issuance_hash);
    const gate = gateAdmission({ records: [record], facts });
    assert.deepEqual([gate.decision, gate.authority], ["proceed", "policy"], kind);
    assert.equal(gateAdmission({ records: [record], facts: { ...facts, project_root_sha256: "f".repeat(64) } }).reason, "alignment_stale", kind);
  }
  // What it does check of the policy: its name, the kinds it lists, its anchor version.
  const brief = { ...alignmentFacts("brief"), user_decision: null };
  const refused = (code) => (error) => error.code === code;
  assert.throws(() => policyAlignment({ ...policy, policy_ref: "" }, brief), refused("alignment_missing"));
  assert.throws(() => policyAlignment({ ...policy, kinds: ["tickets"] }, brief), refused("policy_scope_exceeded"));
  assert.throws(() => policyAlignment({ ...policy, anchor_version: 2 }, brief), refused("alignment_stale"));
  // Review of 11f (L2): nothing outside tests calls either function, nor
  // the module's own function that calls `gateAdmission`.
  const wrappers = alignmentWrappers();
  assert.deepEqual(wrappers, ["resumeAdmission"]);
  for (const identifier of ["policyAlignment", "gateAdmission", ...wrappers]) {
    assert.deepEqual(await filesUsing({ root: ROOT, dirs: ["src", "scripts"], identifier, exclude: ["src/host/alignment-gates.mjs"] }), [], identifier);
  }
  const text = notClaimed((await build()).text);
  // A phrase, whatever the line wrapping.
  const phrase = (words) => new RegExp(words.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/ /gu, "\\s+"), "u");
  assert.match(text, /- No user decision is accepted on any host today\./u);
  assert.match(text, phrase("One path does admit an authority no user signed. `policyAlignment` (`src/host/alignment-gates.mjs`) mints an `authority: policy` alignment record from a policy object its caller hands in, and of that policy it checks only its name, the kinds it lists and its anchor version."));
  assert.match(text, phrase("It does not check that a `UserDecisionRecord` issued the policy, never compares the policy's own project, Epic, scope and expiry with anything, and never compares the facts' policy hashes with the policy object."));
  assert.match(text, phrase("The record's identity binds the facts its caller hands in — their project, Epic and scope, and whatever policy hashes they carry."));
  assert.doesNotMatch(text, /binds the record to no project, Epic, scope or expiry/u);
  assert.match(text, phrase("`brief` included, although 01 §2 lets no policy approve Brief framing"));
  assert.match(text, phrase("`gateAdmission` admits the record"));
  assert.match(text, phrase("Outside tests nothing calls either function yet, nor `resumeAdmission`, the module's own caller of `gateAdmission`."));
  assert.match(text, phrase("open in ADR-091 and is #4's phase 3"));
});

test("§5 lists the reason names the alignment module raises and the graph does not carry, derived from the code", async () => {
  const raised = raisedAlignmentCodes();
  // The list the package reads is the module's own, and it is what the module raises.
  assert.deepEqual([...raised].sort(), [...ALIGNMENT_REASONS].sort());
  const graph = JSON.parse(read("resources/workflow-graph/workflow-graph.v1.json"));
  const recovery = new Set(graph.recovery.map((row) => row.reason));
  const missing = [...raised].filter((code) => !recovery.has(code)).sort();
  // Measured on this tree: all four, `material_ambiguity_unresolved` among them.
  assert.deepEqual(missing, ["alignment_missing", "alignment_stale", "material_ambiguity_unresolved", "policy_scope_exceeded"]);
  const alignmentRows = graph.recovery
    .filter((row) => row.parks_at.some((step) => step === "clarify_alignment" || step === "record_alignment"))
    .map((row) => row.reason).sort();
  const text = notClaimed((await build()).text);
  assert.ok(text.includes(`parks with reason names the graph's recovery rows do not carry — ${missing.map((code) => `\`${code}\``).join(", ")} —`), text);
  assert.ok(text.includes(`where the graph's alignment rows name ${alignmentRows.map((code) => `\`${code}\``).join(", ")}`), text);
  // The steps it names are not the graph's either, and the bullet says so.
  const steps = new Set(graph.steps.map((step) => step.name));
  for (const kind of KINDS) {
    assert.equal(steps.has(gateAdmission({ records: [], facts: alignmentFacts(kind) }).resume_target), false, kind);
    assert.equal(steps.has(correctionEffect({ anchorVersion: 1, records: [], waitingFor: kind }).restart), false, kind);
    assert.equal(steps.has(`record_${kind}_alignment`), false, kind);
  }
  assert.match(read("src/host/alignment-gates.mjs"), /resume_target: `record_\$\{kind\}_alignment`/u);
  assert.match(text, /resumes into `record_<kind>_alignment` and\s+`await_<kind>_alignment` and restarts at `clarify_<kind>`, which are not graph\s+steps/u);
  // Once the graph carries every name the module raises, the sentence goes.
  const converged = structuredClone(graph);
  for (const code of missing) converged.recovery.push({ reason: code, parks_at: ["record_alignment"], resume_targets: ["human"], required_state: "converged" });
  const after = notClaimed((await build({ graph: converged })).text);
  assert.doesNotMatch(after, /parks with reason names the graph's recovery rows do not carry/u);
});

// Debt 11f (R7-28): README's work boundary called the creation contracts "the
// first runtime component"; it now says what exists and what does not, and
// what does not is what the package does not claim.

test("README's work boundary says what exists and what does not, and the package does not claim what it lists as missing", async () => {
  const readme = read("README.md");
  const start = readme.indexOf("## Граница текущей работы");
  const boundary = readme.slice(start, readme.indexOf("\n## ", start + 1));
  assert.doesNotMatch(boundary, /Первый runtime-компонент/u);
  for (const exists of ["`src/host/`", "`npm run mutation-report`", "`npm run validate:*`", "`npm run clean-room`"]) {
    assert.ok(boundary.includes(exists), exists);
  }
  const text = notClaimed((await build()).text);
  for (const [readmeWord, packageWord] of [
    ["ADR-023", "ADR-023"],
    ["ADR-025", "ADR-025"],
    ["signer", "signer"],
    ["ref-custody helper", "ref-custody helper"],
    ["точки входа расширения", "extension entry point"],
  ]) {
    assert.ok(boundary.includes(readmeWord), readmeWord);
    assert.ok(text.includes(packageWord), packageWord);
  }
  // No count a validator does not measure.
  assert.doesNotMatch(boundary, /\b\d+\s+(?:модул|валидатор|контракт|host)/u);
});

// Debt 12a (round 8 of #39, R8-1, R8-13, R8-14): the model account, its launch
// mechanism and the checks that prove it and the custody install are design
// with owners, implemented nowhere; the package says so rather than letting
// the platform contract read as delivered.
test("§5 does not claim the model account, its launch or the checks that prove them (R8-1, R8-13, R8-14)", async () => {
  const evidence = section5((await build()).text);
  assert.match(evidence, /The model account, its launch mechanism and both checks are design with owners, implemented nowhere/u);
  for (const phrase of [
    /`autosk-model`/u,
    /`security\.model_account`/u,
    /`security\.ref_custody`/u,
    /`ref_custody_unavailable`/u,
    /no patch of the series drops a uid/u,
    /never a setuid binary of this project/u,
    /no platform park reason of its §7 has a producer/u,
  ]) {
    assert.match(evidence, phrase);
  }
  assert.match(evidence, /#13 the account, its launch mechanism and both probes, #11 the model process environment, #18 the launch path/u);
  // Until the account exists a model process is the installing user, and the
  // bullet says what that means rather than only what is planned.
  assert.match(evidence, /Until that exists, a model process holds autoskd's rights over the project's Git/u);
  // Review of 9b65ad3: the custody check is derived from the graph, so Quick
  // and a Ticket require it too (M1); the policy's schema admits the Linux
  // topology while the example the signed goldens bind still records `0700`,
  // and the schema's modes are not what its digest is over (H1); the launch
  // mechanism stops a model process tree whole (M3).
  assert.match(evidence, /which every workflow that reaches a step asking the ref-custody helper requires — `autosk-planned`, `autosk-quick` and `autosk-ticket`/u);
  assert.doesNotMatch(evidence, /which the planned Epic's planning and delivery phases require/u);
  assert.doesNotMatch(evidence, /The ref-custody policy still fixes the common and per-worktree Git directories at mode `0700`/u);
  assert.doesNotMatch(evidence, /changing it moves the policy's digest/u);
  // Fix round 2 (ADR-102): the helper runs as the installing user and the Git
  // directory stays the user's; the schema admits that profile beside the
  // committed example (was: a `3770` topology beside `0700`, and "the
  // policy's modes on each platform").
  assert.doesNotMatch(evidence, /3770/u);
  assert.match(evidence, /The ref-custody helper runs as the installing user, and the project's Git directory stays the user's/u);
  assert.match(evidence, /found by the helper's compare-and-swap, not denied by the OS/u);
  assert.match(evidence, /The ref-custody policy's schema admits the ADR-102 profile, the helper as the installing user, beside its committed example/u);
  assert.match(evidence, /which predates ADR-102: the example's digest is computed over the example alone/u);
  assert.match(evidence, /kills a model process tree whole on a timeout, since autoskd cannot signal another uid/u);
  assert.match(evidence, /#5 with #13 the helper's bootstrap \(ADR-102\)/u);
  assert.match(evidence, /that dispatch gate is #34's in matrix v1 \(ADR-097\), and its call before each model launch is #18's launch path \(ADR-102\)/u);
  // What the bullet says of the series is the tree's: no patch sets a uid or
  // a gid for a process it starts.
  const patches = readdirSync(path.join(ROOT, "compat/autosk/patches")).filter((name) => name.endsWith(".patch"));
  assert.equal(patches.length, compat.patches.length);
  for (const name of patches) {
    assert.doesNotMatch(read(`compat/autosk/patches/${name}`), /\bset(?:e?[ug]id|re[su]id)\b|initgroups|\bsudo\b|\brunuser\b|systemd-run|launchctl asuser/u, name);
  }
});

// Debt 12b (round 8 of #39, R8-2, R8-3, R8-15, R8-16): what an acceptance's
// heads contain and which chain its record joins are the daemon's rules, and
// no code here computes them, so the package does not claim them; and that no
// v1 path reaches the pinned auto-policy is measured from the graph and the
// code rather than typed — since the review of 99fd30b (L1), from every way
// into the CAS and delivery, with the lead-in derived from that measure.
import { autoPolicyCallers } from "../scripts/build-panel-package.mjs";
import { acceptanceAuthority } from "../scripts/validate-integration-authorization.mjs";

test("§5 names the acceptance rules no code computes, and measures that no v1 path reaches the auto-policy (R8-2, R8-3, R8-15, R8-16; review M1, L1)", async () => {
  const phrase = (words) => new RegExp(words.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/ /gu, "\\s+"), "u");
  const text = notClaimed((await build()).text);
  assert.match(text, phrase("- An acceptance does not move what it accepts, and its record chains within its scope: rules with owners that no code computes."));
  assert.match(text, phrase("the host takes the heads from its caller (`acceptanceFacts`) and the head a record chains from as the plan names it (`composeAuthorization`)"));
  assert.match(text, phrase("is #4's for the daemon's heads and #9's for `integrateApproved`'s comparison, and the chain per scope under one head kept for integrity (the contract's §5) is #9's (ADR-103)"));
  // Review of 99fd30b (L3): the class, as the contract states it.
  assert.match(text, phrase("every answer to any acceptance packet of the Epic, accept or refuse, re-asks included, and every `IntegrationAuthorizationRecord` of its scope"));
  assert.match(text, phrase("v1 has one acceptance authority, the person's signature at `accept_staging`: every edge into `integrate_staging` or `deliver_staging` leaves `accept_staging` under a person's guard (`t_556`, `t_557`) or is that step's own retry (`t_563`, `t_573`), and `autoPolicyAcceptance`, the binding a pinned auto-policy is held to, has no caller outside tests, so no v1 path reaches it"));
  // Review of 99fd30b (M1): under the binding a policy adds no autonomy, and
  // the unattended acceptance is #28's to design, not the binding's to admit.
  assert.match(text, phrase("under that binding a pinned auto-policy adds no autonomy, and an unattended acceptance needs a different binding, #28's post-v1 design work (`planned_after_v1`, ADR-103)."));
  assert.doesNotMatch(text, /the unattended acceptance a pinned auto-policy would give is #28's/u);
  // R8-15: the record a decision-gated resume stands on names this project too.
  assert.match(text, phrase("name this project and this task and have decided this park's resume into this target"));
  // Measured, not typed: a graph whose CAS edge a policy may take, one with
  // another way into the CAS, or a product caller of the binding, is what the
  // bullet says instead — and then it does not say v1 has one authority.
  const graph = JSON.parse(read("resources/workflow-graph/workflow-graph.v1.json"));
  assert.deepEqual(acceptanceAuthority(graph), { exits: ["t_556", "t_557"], actors: ["human"], retries: ["t_563", "t_573"], bypasses: [], entries: [] });
  assert.deepEqual(await autoPolicyCallers(), []);
  const policed = structuredClone(graph);
  policed.guards.find((guard) => guard.id === "guard_560").authority = { actor: "policy", policy_rules: ["derived_rules"], policy_scope: "A policy that stands in for the person at the stop." };
  const withPolicy = notClaimed((await build({ graph: policed })).text);
  assert.doesNotMatch(withPolicy, /so no v1 path reaches it/u);
  assert.doesNotMatch(withPolicy, /v1 has one acceptance authority, the person's signature/u);
  assert.match(withPolicy, phrase("Whether v1 has one acceptance authority is not measured here: the edges out of `accept_staging` toward the CAS or delivery (`t_556`, `t_557`) carry guards of `human`, `policy`; nothing else reaches those steps;"));
  // The reviewer's probe (L1): a policy edge from aggregate_verify straight to the CAS.
  const bypassed = structuredClone(graph);
  bypassed.transitions.push({ id: "t_990", from: "aggregate_verify", to: "integrate_staging", priority: 0, guards: ["guard_120"] });
  const withBypass = notClaimed((await build({ graph: bypassed })).text);
  assert.doesNotMatch(withBypass, /so no v1 path reaches it/u);
  assert.doesNotMatch(withBypass, /v1 has one acceptance authority, the person's signature/u);
  assert.match(withBypass, phrase("carry guards of `human`; `t_990` reaches those steps without leaving `accept_staging`;"));
  const called = notClaimed((await build({ autoPolicyCallers: ["src/host/somewhere.mjs"] })).text);
  assert.doesNotMatch(called, /so no v1 path reaches it/u);
  assert.doesNotMatch(called, /v1 has one acceptance authority, the person's signature/u);
  assert.match(called, phrase("nothing else reaches those steps; and `autoPolicyAcceptance`, the binding a pinned auto-policy is held to, has callers outside tests: `src/host/somewhere.mjs`;"));
});
