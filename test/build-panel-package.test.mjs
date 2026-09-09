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
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { FULL_TEXT, ROOT, buildPackage, contractOutline } from "../scripts/build-panel-package.mjs";

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
  upstream_commit: compat.upstream.commit,
  source_tree: compat.result_tree,
  extension: { commit: "c".repeat(40), tree: "t".repeat(40), dirty: false },
  report_digest: "r".repeat(64),
  ok: true,
  steps: [{ step: "prepare", ok: true }, { step: "harness:crash", ok: true }],
  coverage: { counts: { covered_by_real_fault: 16, covered_indirectly: 0, not_covered: 0 }, complete: true },
};
const mutation = {
  totals: { modules: 49, mutants: 513, killed: 513 },
  survivors: [],
  rules: ["demand(", "errors.push("],
  report_digest: "m".repeat(64),
};

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

test("the mutation claim carries its own numbers and its own rules", async () => {
  const { text } = await build();
  assert.match(text, /\| mutants \| 513 \|/u);
  assert.match(text, /\| killed \| 513 \|/u);
  assert.match(text, /`demand\(`, `errors\.push\(`/u);
  assert.match(text, /node scripts\/mutation-report\.mjs/u);
  // And it does not quietly borrow the broader hand-run counts.
  assert.match(text, /the two are not the same number/u);
});

test("the package is deterministic and names what it left out", async () => {
  const one = await build();
  const two = await build();
  assert.equal(one.digest, two.digest);
  assert.equal(one.text, two.text);
  for (const name of FULL_TEXT) assert.match(one.text, new RegExp(`### ${name.replace(".", "\\.")}`, "u"));
  assert.match(one.text, /Not reproduced, and named so a verdict can say what it covered/u);
});
