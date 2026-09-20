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
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FULL_TEXT, ROOT, buildPackage, contractOutline, measureContracts, namesRefusal } from "../scripts/build-panel-package.mjs";
import { bindSource, sourceDrift } from "../scripts/lib/produced-source.mjs";
import { PANEL_BY_ROUND, panelVerdicts, validatePanelRound } from "../scripts/validate-design-candidate.mjs";

const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

const contractNames = readdirSync(path.join(ROOT, "docs/contracts")).filter((name) => name.endsWith(".md")).sort();
const contracts = contractNames.map((name) => ({
  path: `docs/contracts/${name}`,
  ...contractOutline(read(`docs/contracts/${name}`)),
}));

const candidate = JSON.parse(read("resources/design-candidate/design-candidate.v1.json"));
const matrix = JSON.parse(read("resources/clean-room-e2e/fault-matrix.v1.json"));
const compat = JSON.parse(read("compat/autosk/manifest.v1.json"));

const cleanRoom = {
  // Only the fault harness's own cases carry a control; F001 belongs to the
  // crash harness, which is exactly the difference the table has to show.
  faults: [
    { id: "F020", detected: true, control: true, detail: "the audit copy exists while the live one still does" },
  ],
  upstream_commit: compat.upstream.commit,
  source_tree: compat.result_tree,
  extension: { commit: "c".repeat(40), tree: "t".repeat(40), dirty: false },
  report_digest: "r".repeat(64),
  ok: true,
  steps: [{ step: "prepare", ok: true }, { step: "harness:crash", ok: true }],
  coverage: {
    counts: { covered_by_real_fault: 20, covered_indirectly: 0, not_covered: 0 },
    complete: true,
    rows: [
      { id: "F001", boundary: "task_creation", state: "covered_by_real_fault", harness: "crash", evidence: "reservation.before / reservation.after" },
      { id: "F020", boundary: "planning_publication", state: "covered_by_real_fault", harness: "faults", evidence: "the audit copy exists while the live one still does" },
    ],
  },
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

const build = (overrides = {}) => buildPackage({
  commit: "c".repeat(40),
  tree: "t".repeat(40),
  candidate,
  cleanRoom,
  matrix,
  mutation,
  compat,
  tests: { passed: 1769, failed: 0 },
  contracts,
  vocabulary,
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

test("the fault matrix is stated with its denominator and its groups", async () => {
  const { text } = await build();
  assert.match(text, new RegExp(`\\*\\*${matrix.groups.length} groups\\*\\*`, "u"));
  for (const group of matrix.groups) assert.match(text, new RegExp(`\`${group.id}\``, "u"));
});

test("the run either was about the reviewed bytes or says it was not", async () => {
  const same = await build();
  assert.match(same.text, /same bytes as the version under review \| yes/u);

  const elsewhere = await build({ cleanRoom: { ...cleanRoom, extension: { commit: "9".repeat(40), tree: "9".repeat(40), dirty: false } } });
  assert.match(elsewhere.text, /\| NO — this run is about other bytes/u);

  const dirty = await build({ cleanRoom: { ...cleanRoom, extension: { ...cleanRoom.extension, dirty: true } } });
  assert.match(dirty.text, /\| NO — this run is about other bytes/u);
  assert.match(dirty.text, /worktree clean at run time \| no/u);
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

test("a produced report fills the cell against the contract's own closed set", async () => {
  const graph = "docs/contracts/workflow-graph.md";
  const outline = contractOutline(read(graph));
  const produced = {
    source: bindSource(ROOT, [graph]),
    contracts: [
      {
        contract: graph,
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
    contracts: [
      {
        contract: graph,
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
const linkedFixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "produced-link-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "produced-link-out-"));
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
  assert.match(text, /\| `F001` \| crash \| yes \| not paired \|/u);
  assert.match(text, /\| `F020` \| faults \| yes \| yes \|/u);
  for (const entry of mutation.modules) {
    assert.match(text, new RegExp(entry.module.replace(/[/.]/gu, "\\$&"), "u"));
  }
  // A run that recorded no per-case results says so rather than implying rows.
  const countsOnly = await build({
    cleanRoom: { ...cleanRoom, faults: null, coverage: { ...cleanRoom.coverage, rows: [] } },
  });
  assert.match(countsOnly.text, /recorded no per-group results/u);
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
