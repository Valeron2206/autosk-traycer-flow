/**
 * Tests for the material decision manifest (#4).
 *
 * The rule is that unreferenced prose is not material authority. These check
 * that it is a property rather than a sentence: one block, stable ids, sections
 * that cite what they rest on, and a projector that compares rather than
 * interprets.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CONTRACT_MARKER,
  CONTRACT_PATH,
  EXAMPLE_PATH,
  REFUSALS,
  REFUSED_PATH,
  ROOT,
  SCHEMA_PATH,
  extractManifest,
  freezeDecision,
  manifestErrors,
  manifestHash,
  project,
  sectionErrors,
  validateDesign,
} from "../scripts/validate-material-decisions.mjs";

const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");
const files = Object.fromEntries(
  [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, REFUSED_PATH].map((relative) => [relative, read(relative)]),
);
const approved = () => JSON.parse(files[EXAMPLE_PATH]);
const draft = () => JSON.parse(files[EXAMPLE_PATH]);
const reasons = (list) => list.map((entry) => entry.reason);

const fenced = (json) => `# Core Flow\n\nSome prose.\n\n\`\`\`autosk-material-decisions\n${JSON.stringify(json)}\n\`\`\`\n\nMore prose.\n`;

test("the shipped design validates", () => {
  assert.deepEqual(validateDesign(files), []);
});

test("one block, and two are refused rather than merged", () => {
  const one = extractManifest(fenced(approved()));
  assert.deepEqual(one.errors, []);
  assert.equal(one.manifest.artifact_id, "core-flow-0001");
  // Merging would make the artifact's authority depend on which block a reader
  // reached first.
  const two = extractManifest(`${fenced(approved())}\n${fenced(approved())}`);
  assert.deepEqual(reasons(two.errors), ["material_manifest_duplicate"]);
  assert.deepEqual(reasons(extractManifest("# Core Flow\n\nJust prose.\n").errors), ["material_manifest_missing"]);
  assert.deepEqual(
    reasons(extractManifest("```autosk-material-decisions\n{not json\n```\n").errors),
    ["material_manifest_malformed"],
  );
});

test("an id reused for a different statement is refused", () => {
  // That is how an approval survives the decision it was about.
  const manifest = approved();
  manifest.decisions.push({
    ...manifest.decisions[0],
    statement: "Cancelling a run keeps partial work for a later resume.",
  });
  assert.ok(reasons(manifestErrors(manifest)).includes("material_decision_id_reused"));
  assert.deepEqual(manifestErrors(approved()), []);
});

test("an id that supersedes itself is refused; superseding a retired id is not", () => {
  // Superseding an id the manifest no longer contains is what superseding
  // means; superseding yourself is id reuse written as a lineage.
  const retired = approved();
  retired.decisions[0].supersedes = "cancel-stops-at-step-boundary-v0";
  assert.deepEqual(manifestErrors(retired), []);
  const itself = approved();
  itself.decisions[0].supersedes = itself.decisions[0].decision_id;
  assert.deepEqual(reasons(manifestErrors(itself)), ["material_decision_id_reused"]);
});

test("a section may only cite decisions the manifest contains", () => {
  const manifest = approved();
  manifest.normative_sections[0].decision_ids = ["never-declared"];
  assert.ok(reasons(manifestErrors(manifest)).includes("material_decision_unknown"));
});

test("a normative section that decides something and cites nothing is refused", () => {
  const manifest = approved();
  // Section 5 is explanation and cites nothing, which is fine — until somebody
  // says it is normative.
  assert.deepEqual(sectionErrors(manifest, { normative: ["3. Cancel"] }), []);
  assert.deepEqual(reasons(sectionErrors(manifest, { normative: ["5. Glossary"] })), ["material_section_unmapped"]);
  assert.deepEqual(reasons(sectionErrors(manifest, { normative: ["7. Absent"] })), ["material_section_unmapped"]);
});

test("the projector names four differences rather than one", () => {
  const base = approved();
  assert.deepEqual(project(base, draft()), []);

  const changed = draft();
  changed.decisions[0].statement = "Cancelling a run keeps partial work for a later resume.";
  assert.deepEqual(reasons(project(base, changed)), ["material_decision_changed"]);

  const dropped = draft();
  dropped.decisions = [dropped.decisions[0]];
  assert.deepEqual(reasons(project(base, dropped)), ["material_decision_missing"]);

  const invented = draft();
  invented.decisions.push({
    decision_id: "retry-doubles-timeout",
    kind: "technical_constraint",
    statement: "A retry doubles the timeout of the step it repeats.",
    sections: ["6. Retry"],
  });
  assert.deepEqual(reasons(project(base, invented)), ["material_decision_unknown"]);

  const unmapped = draft();
  unmapped.normative_sections.push({ section: "6. Retry", decision_ids: [] });
  assert.deepEqual(reasons(project(base, unmapped)), ["material_section_unmapped"]);
});

test("a section that was explanation and stayed explanation is not a finding", () => {
  // Otherwise every glossary would read as a regression.
  const base = approved();
  const same = draft();
  assert.deepEqual(project(base, same), []);
  assert.ok(base.normative_sections.some((entry) => entry.decision_ids.length === 0));
});

test("only byte-equivalence or a proven local addition allows a freeze", () => {
  const base = approved();
  assert.equal(freezeDecision(base, draft()).decision, "freeze");
  assert.equal(freezeDecision(base, draft()).basis, "byte_equivalent_projection");

  const changed = draft();
  changed.decisions[0].statement = "Cancelling a run keeps partial work.";
  const refused = freezeDecision(base, changed);
  assert.equal(refused.decision, "clarify");
  assert.ok(reasons(refused.reasons).includes("material_decision_changed"));

  // "It reads the same" is not byte-equivalent; a classifier proof is the only
  // other basis, and it names the registry it was proven under.
  const proven = freezeDecision(base, changed, {
    classifierProof: { local_non_material: true, registry_digest: "d".repeat(64) },
  });
  assert.equal(proven.decision, "freeze");
  assert.equal(proven.basis, "classifier_proven_local_addition");
  assert.equal(
    freezeDecision(base, changed, { classifierProof: { local_non_material: true } }).decision,
    "clarify",
  );
});

test("the hash an approval binds covers the decisions, not the prose around them", () => {
  const base = approved();
  const reworded = draft();
  reworded.decisions[0].rationale = "Rewritten explanation, same decision.";
  assert.equal(manifestHash(reworded), manifestHash(base));
  const moved = draft();
  moved.decisions.reverse();
  assert.equal(manifestHash(moved), manifestHash(base));
  const different = draft();
  different.decisions[0].statement = "Cancelling keeps partial work.";
  assert.notEqual(manifestHash(different), manifestHash(base));
});

test("a decision that names a section the manifest does not list is refused", () => {
  // Otherwise a decision could claim to govern a section nobody declared
  // normative, and the projector would never look at it.
  const manifest = approved();
  manifest.decisions[0].sections = ["9. Nowhere"];
  assert.ok(reasons(manifestErrors(manifest)).includes("material_section_unmapped"));
});

test("the design self-check can fail, so its passing means something", () => {
  // Five guards decide whether the shipped contract, schema and examples agree.
  // Each is checked here against a design that breaks exactly one of them.
  const broken = (changes) => validateDesign({ ...files, ...changes });

  assert.ok(
    broken({ [CONTRACT_PATH]: files[CONTRACT_PATH].replace(CONTRACT_MARKER, "") })
      .some((error) => /contract marker is missing/u.test(error)),
  );
  assert.ok(
    broken({ [CONTRACT_PATH]: files[CONTRACT_PATH].replaceAll("`material_manifest_duplicate`", "duplicate blocks") })
      .some((error) => /material_manifest_duplicate is not named/u.test(error)),
  );

  const open = JSON.parse(files[SCHEMA_PATH]);
  open.additionalProperties = true;
  assert.ok(broken({ [SCHEMA_PATH]: JSON.stringify(open) }).some((error) => /schema is not closed/u.test(error)));

  const refusedExample = approved();
  refusedExample.decisions[0].sections = ["9. Nowhere"];
  assert.ok(
    broken({ [EXAMPLE_PATH]: JSON.stringify(refusedExample) })
      .some((error) => /the worked example is refused/u.test(error)),
  );

  // A refused example that is really just the worked one produces nothing, and
  // a refusal set nobody can reach is the pattern this program keeps finding.
  assert.ok(
    broken({ [REFUSED_PATH]: files[EXAMPLE_PATH] })
      .some((error) => /produces only 0 refusal classes/u.test(error)),
  );
});

test("every refusal class the contract closes can be produced", () => {
  const produced = new Set();
  const base = approved();
  for (const entry of extractManifest("no block here").errors) produced.add(entry.reason);
  for (const entry of extractManifest(`${fenced(base)}${fenced(base)}`).errors) produced.add(entry.reason);
  for (const entry of extractManifest("```autosk-material-decisions\n{\n```\n").errors) produced.add(entry.reason);
  const reused = approved();
  reused.decisions.push({ ...reused.decisions[0], statement: "Another statement entirely, same id." });
  for (const entry of manifestErrors(reused)) produced.add(entry.reason);
  const invented = draft();
  invented.decisions.push({
    decision_id: "retry-doubles-timeout",
    kind: "technical_constraint",
    statement: "A retry doubles the timeout of the step it repeats.",
    sections: ["6. Retry"],
  });
  for (const entry of project(base, invented)) produced.add(entry.reason);
  const dropped = draft();
  dropped.decisions = [dropped.decisions[0]];
  for (const entry of project(base, dropped)) produced.add(entry.reason);
  const changed = draft();
  changed.decisions[0].statement = "Something else.";
  for (const entry of project(base, changed)) produced.add(entry.reason);
  for (const entry of sectionErrors(base, { normative: ["5. Glossary"] })) produced.add(entry.reason);
  for (const refusal of REFUSALS) {
    assert.ok(produced.has(refusal), `${refusal} is documented and never produced`);
  }
});
