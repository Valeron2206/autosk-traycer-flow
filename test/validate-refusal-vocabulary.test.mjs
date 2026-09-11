/**
 * Tests for the closed park vocabulary (#4).
 *
 * The rule under test is that the set of reachable park states is finite,
 * derived from the table that decides it, and bound to steps that exist. These
 * check the derivation rather than the resource, because a resource somebody
 * maintains by hand is the thing this contract removes.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CONTRACT_MARKER,
  CONTRACT_PATH,
  FLOWS_PATH,
  GRAPH_PATH,
  PLAN_PATH,
  REFUSALS,
  REFUSED_PATH,
  ROOT,
  SCHEMA_PATH,
  VOCABULARY_PATH,
  driftErrors,
  extractVocabulary,
  parkTable,
  producerErrors,
  readContracts,
  readSources,
  registeredSteps,
  stepErrors,
  ownerErrors,
  unclosedContracts,
  unmappedCodes,
  validateDesign,
  vocabularyDigest,
  vocabularyErrors,
  WORKFLOW_OWNER,
} from "../scripts/validate-refusal-vocabulary.mjs";

const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");
const files = Object.fromEntries(
  [CONTRACT_PATH, SCHEMA_PATH, VOCABULARY_PATH, REFUSED_PATH].map((relative) => [relative, read(relative)]),
);
const plan = read(PLAN_PATH);
const graph = JSON.parse(read(GRAPH_PATH));
const flows = read(FLOWS_PATH);
const context = { plan, graph, flows, sources: readSources(), contracts: readContracts() };
const vocabulary = () => JSON.parse(files[VOCABULARY_PATH]);
const reasons = (list) => [...new Set(list.map((entry) => entry.reason))].sort();

test("the shipped design validates", () => {
  assert.deepEqual(validateDesign(files, context), []);
});

test("the steps come from the graph document, not from a scrape of the prose", () => {
  // A hand-kept list of steps is a second place for the truth to live, and so is
  // a regular expression over prose: it saw a step wherever a token matched the
  // name pattern, so a rename stayed registered until someone noticed.
  const steps = registeredSteps(graph);
  for (const step of ["implement", "verify", "freeze", "record_alignment", "init_planning_ref", "rebuild_code_anchor"]) {
    assert.ok(steps.includes(step), step);
  }
  assert.deepEqual(steps, [...steps].sort(), "the steps come back in one order");
  assert.equal(new Set(steps).size, steps.length, "the document declares each step once");
  assert.throws(() => registeredSteps("## 2. x\n## 3. y\n"), TypeError, "the plan text is no longer a source of steps");
});

test("one table owns the vocabulary", () => {
  const rows = parkTable(plan);
  assert.ok(rows.length > 70);
  assert.ok(rows.every((row) => row.reason.length > 0 && row.step.length > 0));
  assert.deepEqual(parkTable("no table here"), []);
});

test("a misspelled step is not accepted quietly; the row parks nowhere", () => {
  // Filtering the step column to registered steps could hide a typo. It does
  // not, because a reason with no step and no class is refused.
  // The misspelling is applied to whatever step the row currently names, rather
  // than to a step name written here: the second column is `parks_at` rendered,
  // so pinning its text would make this test fail whenever that column widens
  // — which is what it did the first time a reason gained a step.
  const row = plan.split("\n").find((line) => line.startsWith("| code_verdict_invalid |"));
  assert.ok(row, "the park table still has a row for this reason");
  // Every step the cell names, not just the first: the column widened to two
  // and misspelling one left the other standing, so the row still parked
  // somewhere and the assertion below no longer measured anything.
  const steps = row.split("|")[2].trim().split(",").map((name) => name.trim());
  assert.ok(steps.length > 0);
  const broken = plan.replace(row, steps.reduce((line, name) => line.replace(name, name.replace(/[aeiou]/u, "")), row));
  assert.notEqual(broken, plan);
  const entry = extractVocabulary(broken, graph).find((candidate) => candidate.code === "code_verdict_invalid");
  assert.deepEqual(entry.parks_at, []);
  const claimed = { ...vocabulary(), park_reasons: [{ ...entry, producer: "daemon", producer_files: [] }] };
  assert.ok(reasons(stepErrors(claimed, registeredSteps(graph))).includes("refusal_vocabulary_unknown_step"));
});

test("the resource never wins an argument with the table", () => {
  const extracted = extractVocabulary(plan, graph);
  assert.deepEqual(driftErrors(vocabulary(), extracted), []);

  const invented = vocabulary();
  invented.park_reasons = [...invented.park_reasons, {
    code: "park_reason_nobody_declared",
    parks_at: ["freeze"],
    parks_at_classes: [],
    producer: "daemon",
    producer_files: [],
  }];
  assert.deepEqual(reasons(driftErrors(invented, extracted)), ["refusal_vocabulary_drift"]);

  const dropped = vocabulary();
  dropped.park_reasons = dropped.park_reasons.slice(1);
  assert.deepEqual(reasons(driftErrors(dropped, extracted)), ["refusal_vocabulary_drift"]);

  const moved = vocabulary();
  moved.park_reasons = moved.park_reasons.map((entry, index) =>
    index === 0 ? { ...entry, parks_at: ["cleanup"] } : entry);
  assert.deepEqual(reasons(driftErrors(moved, extracted)), ["refusal_vocabulary_drift"]);
});

test("a class defined as everything else is recomputed, not trusted", () => {
  const steps = registeredSteps(graph);
  assert.deepEqual(stepErrors(vocabulary(), steps), []);

  const edited = vocabulary();
  edited.step_classes = edited.step_classes.map((entry) =>
    entry.derivation.startsWith("complement:") ? { ...entry, members: entry.members.slice(1) } : entry);
  assert.ok(reasons(stepErrors(edited, steps)).includes("refusal_vocabulary_unknown_class"));

  const unregistered = vocabulary();
  unregistered.step_classes = unregistered.step_classes.map((entry, index) =>
    index === 0 ? { ...entry, members: [...entry.members, "step_nobody_registered"] } : entry);
  assert.ok(reasons(stepErrors(unregistered, steps)).includes("refusal_vocabulary_unknown_step"));

  const unknownClass = vocabulary();
  unknownClass.park_reasons = unknownClass.park_reasons.map((entry, index) =>
    index === 0 ? { ...entry, parks_at_classes: ["class_nobody_declared"] } : entry);
  assert.ok(reasons(stepErrors(unknownClass, steps)).includes("refusal_vocabulary_unknown_class"));
});

test("a producer claim the repository contradicts is refused", () => {
  const sources = { "src/host/a.mjs": "throw new FlowError('cleanup_dirty')" };
  const daemonClaim = {
    park_reasons: [{ code: "cleanup_dirty", parks_at: ["cleanup"], parks_at_classes: [], producer: "daemon", producer_files: [] }],
  };
  assert.deepEqual(reasons(producerErrors(daemonClaim, sources)), ["refusal_vocabulary_producer_misdeclared"]);
  assert.deepEqual(
    producerErrors({ park_reasons: [{ ...daemonClaim.park_reasons[0], producer: "host", producer_files: ["src/host/a.mjs"] }] }, sources),
    [],
  );
  assert.deepEqual(
    reasons(producerErrors({ park_reasons: [{ ...daemonClaim.park_reasons[0], producer: "host", producer_files: [] }] }, sources)),
    ["refusal_vocabulary_producer_missing"],
  );
  assert.deepEqual(
    reasons(producerErrors({ park_reasons: [{ ...daemonClaim.park_reasons[0], producer: "host", producer_files: ["src/host/b.mjs"] }] }, sources)),
    ["refusal_vocabulary_producer_missing"],
  );
  assert.deepEqual(
    reasons(producerErrors({ park_reasons: [{ ...daemonClaim.park_reasons[0], producer: "daemon", producer_files: ["src/host/a.mjs"] }] }, sources)),
    ["refusal_vocabulary_producer_misdeclared"],
  );
  // A daemon entry naming a file at all is already wrong, whether or not that
  // file happens to contain the code — the two halves are separate claims.
  assert.deepEqual(
    reasons(producerErrors(
      { park_reasons: [{ ...daemonClaim.park_reasons[0], producer: "daemon", producer_files: ["src/host/b.mjs"] }] },
      { "src/host/b.mjs": "nothing relevant" },
    )),
    ["refusal_vocabulary_producer_misdeclared"],
  );
});

test("a short code is not produced by a file that only writes a longer one", () => {
  // `foreign movement` is a suffix of the planning-ref reason, and a substring
  // match would have credited the wrong file with producing it.
  const sources = { "src/host/a.mjs": "'planning_ref_foreign_movement'" };
  const entry = { code: "foreign_movement", parks_at: ["integration_recovery"], parks_at_classes: [], producer: "daemon", producer_files: [] };
  assert.deepEqual(producerErrors({ park_reasons: [entry] }, sources), []);
});

test("a park reason with no recorded owner, or the wrong one, is refused", () => {
  // "Somebody must have closed this somewhere" is how a code with no owner
  // survives, so the owner is a field rather than an inference.
  const contracts = { "a.md": "Closed set: `alpha_beta`, `gamma_delta`.\n" };
  const entry = { code: "alpha_beta", parks_at: ["freeze"], parks_at_classes: [], producer: "daemon", producer_files: [] };
  assert.deepEqual(ownerErrors({ park_reasons: [{ ...entry, closed_by: "docs/contracts/a.md" }] }, contracts), []);
  assert.deepEqual(
    reasons(ownerErrors({ park_reasons: [{ ...entry, closed_by: undefined }] }, contracts)),
    ["refusal_vocabulary_owner_missing"],
  );
  assert.deepEqual(
    reasons(ownerErrors({ park_reasons: [{ ...entry, closed_by: "docs/contracts/other.md" }] }, contracts)),
    ["refusal_vocabulary_owner_missing"],
  );
  // A reason no contract closes belongs to the workflow, and must say so.
  const workflow = { ...entry, code: "some_workflow_park" };
  assert.deepEqual(ownerErrors({ park_reasons: [{ ...workflow, closed_by: WORKFLOW_OWNER }] }, contracts), []);
  assert.deepEqual(
    reasons(ownerErrors({ park_reasons: [{ ...workflow, closed_by: "docs/contracts/a.md" }] }, contracts)),
    ["refusal_vocabulary_owner_missing"],
  );
});

test("a name two contracts declare is refused rather than resolved by precedence", () => {
  // A caller branching on the name cannot tell which of the two conditions it
  // got, and the vocabulary would have to give it two producers and two steps.
  const shared = {
    "a.md": "Closed set: `alpha_beta`.\n",
    "b.md": "Closed set: `alpha_beta`.\n",
  };
  assert.ok(
    reasons(ownerErrors({ park_reasons: [] }, shared)).includes("refusal_vocabulary_owner_ambiguous"),
  );
  assert.deepEqual(
    reasons(ownerErrors({ park_reasons: [] }, { "a.md": "Closed set: `alpha_beta`.\n" })),
    [],
  );
});

test("no shipped contract declares a name another one also declares", () => {
  assert.deepEqual(
    ownerErrors({ park_reasons: [] }, context.contracts)
      .filter((entry) => entry.reason === "refusal_vocabulary_owner_ambiguous"),
    [],
  );
});

test("every contract closes its refusal set", () => {
  assert.deepEqual(unclosedContracts(context.contracts), []);
  assert.deepEqual(
    reasons(unclosedContracts({ "open.md": "# Open\n\nIt refuses sometimes.\n" })),
    ["refusal_vocabulary_unclosed_contract"],
  );
  // Both forms count: the inline closed set and the bulleted section.
  assert.deepEqual(unclosedContracts({ "a.md": "Closed set: `alpha_beta`, `gamma_delta`.\n" }), []);
  assert.deepEqual(unclosedContracts({ "b.md": "\n## 6. Refusal classes\n\n- `alpha_beta`;\n" }), []);
});

test("a machine code in the user-facing table is a park state like any other", () => {
  assert.deepEqual(unmappedCodes(vocabulary(), flows), []);
  const narrowed = { park_reasons: vocabulary().park_reasons.filter((entry) => entry.code !== "tickets_manifest_invalid") };
  assert.deepEqual(reasons(unmappedCodes(narrowed, flows)), ["refusal_vocabulary_code_unmapped"]);
});

test("the digest recomputes over the vocabulary and not over itself", () => {
  const current = vocabulary();
  assert.equal(current.vocabulary_digest, vocabularyDigest(current));
  const restamped = { ...current, vocabulary_digest: "0".repeat(64) };
  assert.equal(vocabularyDigest(restamped), current.vocabulary_digest);
  const changed = { ...current, park_reasons: current.park_reasons.slice(1) };
  assert.notEqual(vocabularyDigest(changed), current.vocabulary_digest);
  assert.ok(reasons(vocabularyErrors(restamped, context)).includes("refusal_vocabulary_digest_stale"));
});

test("the design self-check can fail, so its passing means something", () => {
  const broken = (changes) => validateDesign({ ...files, ...changes }, context);
  assert.ok(
    broken({ [CONTRACT_PATH]: files[CONTRACT_PATH].replace(CONTRACT_MARKER, "") })
      .some((error) => /contract marker is missing/u.test(error)),
  );
  assert.ok(
    broken({ [CONTRACT_PATH]: files[CONTRACT_PATH].replaceAll("`refusal_vocabulary_drift`", "drift") })
      .some((error) => /refusal_vocabulary_drift is not named/u.test(error)),
  );
  const open = JSON.parse(files[SCHEMA_PATH]);
  open.additionalProperties = true;
  assert.ok(broken({ [SCHEMA_PATH]: JSON.stringify(open) }).some((error) => /schema is not closed/u.test(error)));
  assert.ok(
    broken({ [VOCABULARY_PATH]: files[REFUSED_PATH] }).some((error) => /refusal_vocabulary_/u.test(error)),
  );
  // A refused example that is really the shipped one proves nothing.
  assert.ok(
    broken({ [REFUSED_PATH]: files[VOCABULARY_PATH] })
      .some((error) => /produces only 0 refusal classes/u.test(error)),
  );
});

test("every refusal class the contract closes can be produced", () => {
  const produced = new Set(
    vocabularyErrors(JSON.parse(files[REFUSED_PATH]), context).map((entry) => entry.reason),
  );
  for (const entry of unclosedContracts({ "open.md": "no closed set here" })) produced.add(entry.reason);
  for (const entry of ownerErrors(
    { park_reasons: [] },
    { "a.md": "Closed set: `alpha_beta`.\n", "b.md": "Closed set: `alpha_beta`.\n" },
  )) produced.add(entry.reason);
  for (const refusal of REFUSALS) {
    assert.ok(produced.has(refusal), `${refusal} is documented and never produced`);
  }
});
