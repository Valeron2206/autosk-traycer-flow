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
  unclosedContracts,
  unmappedCodes,
  validateDesign,
  vocabularyDigest,
  vocabularyErrors,
} from "../scripts/validate-refusal-vocabulary.mjs";

const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");
const files = Object.fromEntries(
  [CONTRACT_PATH, SCHEMA_PATH, VOCABULARY_PATH, REFUSED_PATH].map((relative) => [relative, read(relative)]),
);
const plan = read(PLAN_PATH);
const flows = read(FLOWS_PATH);
const context = { plan, flows, sources: readSources(), contracts: readContracts() };
const vocabulary = () => JSON.parse(files[VOCABULARY_PATH]);
const reasons = (list) => [...new Set(list.map((entry) => entry.reason))].sort();

test("the shipped design validates", () => {
  assert.deepEqual(validateDesign(files, context), []);
});

test("the steps come from the registered workflow graphs, not from a list", () => {
  // A hand-kept list of steps is a second place for the truth to live.
  const steps = registeredSteps(plan);
  for (const step of ["implement", "verify", "freeze", "record_alignment", "init_planning_ref", "rebuild_code_anchor"]) {
    assert.ok(steps.includes(step), step);
  }
  assert.ok(!steps.includes("recovery: rebuild_code_anchor"));
  assert.ok(!steps.includes("human alignment before normative planning"));
  assert.equal(registeredSteps("## 2. x\n## 3. y\n").length, 0);
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
  const broken = plan.replace("| code_verdict_invalid | freeze |", "| code_verdict_invalid | freze |");
  assert.notEqual(broken, plan);
  const entry = extractVocabulary(broken).find((candidate) => candidate.code === "code_verdict_invalid");
  assert.deepEqual(entry.parks_at, []);
  const claimed = { ...vocabulary(), park_reasons: [{ ...entry, producer: "daemon", producer_files: [] }] };
  assert.ok(reasons(stepErrors(claimed, registeredSteps(plan))).includes("refusal_vocabulary_unknown_step"));
});

test("the resource never wins an argument with the table", () => {
  const extracted = extractVocabulary(plan);
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
  const steps = registeredSteps(plan);
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
  for (const refusal of REFUSALS) {
    assert.ok(produced.has(refusal), `${refusal} is documented and never produced`);
  }
});
