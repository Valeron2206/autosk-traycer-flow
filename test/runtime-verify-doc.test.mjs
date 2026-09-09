/**
 * Tests for verification recipes, self-proof and coverage (issue #23 runtime).
 *
 * A verification document is what everything else is verified against, so it is
 * held to its own instructions: until they have been run end to end on a
 * permitted surface, it is a plan for verifying, whatever it says about itself.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  RECIPE_PARTS,
  REFUSALS,
  SURFACES,
  classifyRun,
  commandErrors,
  coverageErrors,
  driftPlan,
  isDeliverable,
  recipeErrors,
  selfProofState,
  surfaceErrors,
} from "../src/host/verify-doc.mjs";

const code = (name) => (error) => error.code === name;

function recipe(overrides = {}) {
  return {
    recipe_id: "r-1",
    launch: "bun install --frozen-lockfile && bun run build",
    doctor: { checks: ["daemon reachable"], infrastructure_failure_classification: "park as environment_failure" },
    drive: "read a 40k-line session transcript through the chunked reader",
    evidence: { capture: "stdout json", observed_values: { runes_intact: true } },
    cleanup: "rm -rf $TMPDIR/session-fixture",
    surface: "local",
    commands: [
      {
        id: "read",
        invocation: "node scripts/read-transcript.mjs --offset 0 --limit 4096",
        exit_semantics: "0 means the chunk was returned whole",
        cleanup: "none",
      },
    ],
    ...overrides,
  };
}

function doc(overrides = {}) {
  return {
    commit_oid: "a".repeat(40),
    tree_oid: "b".repeat(40),
    environment_digest: "c".repeat(64),
    config_digest: "d".repeat(64),
    recipes: [recipe()],
    self_proof: {
      executed_end_to_end: true,
      document_commit_oid: "a".repeat(40),
      document_tree_oid: "b".repeat(40),
      environment_digest: "c".repeat(64),
      config_digest: "d".repeat(64),
      recipe_id: "r-1",
    },
    ...overrides,
  };
}

test("a recipe has all five parts", () => {
  assert.deepEqual(recipeErrors(recipe()), []);
  for (const part of RECIPE_PARTS) {
    const missing = recipe();
    delete missing[part];
    assert.ok(recipeErrors(missing).some((error) => error.detail === `missing ${part}`), part);
  }
  assert.ok(recipeErrors(undefined).some((error) => error.reason === "verify_recipe_missing"));
});

test("the doctor says how an infrastructure failure is classified", () => {
  // Without it an infrastructure failure and a product failure look the same,
  // and the difference decides whether the ticket is wrong or the machine is.
  const errors = recipeErrors(recipe({ doctor: { checks: ["daemon reachable"] } }));
  assert.ok(errors.some((error) => error.reason === "verify_infrastructure_failure_mislabeled"));
});

test("evidence names what is observed, not that something was observed", () => {
  const errors = recipeErrors(recipe({ evidence: { capture: "stdout" } }));
  assert.ok(errors.some((error) => /names no observed values/u.test(error.detail)));
});

test("a command is written literally, with its exit semantics and cleanup", () => {
  assert.deepEqual(commandErrors(recipe()), []);
  for (const vague of [
    "the implementer will write a script",
    "run some tool that checks it",
    "run the thing as appropriate",
    "TBD",
  ]) {
    assert.ok(
      commandErrors(recipe({ commands: [{ id: "c", invocation: vague, exit_semantics: "0", cleanup: "none" }] }))
        .some((error) => error.reason === "verify_command_not_exact"),
      vague,
    );
  }
  for (const field of ["exit_semantics", "cleanup"]) {
    const command = { id: "c", invocation: "node x.mjs" };
    command[field === "exit_semantics" ? "cleanup" : "exit_semantics"] = "given";
    assert.ok(
      commandErrors(recipe({ commands: [command] })).some((error) => error.detail.endsWith(`no ${field}`)),
      field,
    );
  }
  // A command with no invocation is refused there and not carried on into the
  // field checks: the fields belong to a command, and there is not one yet.
  assert.deepEqual(
    commandErrors(recipe({ commands: [{ id: "c" }] })).map((error) => error.detail),
    ["c: no invocation"],
  );
  assert.deepEqual(
    commandErrors(recipe({ commands: [{ id: "c", invocation: "   " }] })).map((error) => error.detail),
    ["c: no invocation"],
  );
});

test("new scaffolding is contracted rather than promised", () => {
  // A full listing of an unwritten helper is not required; a vague promise to
  // write tooling later is not accepted in its place.
  const promised = recipe({ needs_new_scaffolding: true });
  const errors = commandErrors(promised);
  assert.ok(errors.length >= 10);
  const contracted = recipe({
    needs_new_scaffolding: true,
    scaffolding_contract: {
      batch_contract_identity: "b-1",
      purpose: "inject a mid-rune offset",
      owner: "implementer",
      lifecycle: "ephemeral",
      invocation_contract: "node scripts/inject.mjs --offset 3",
      expected_red: "the reader refuses",
      expected_green: "the unmutated reader returns whole runes",
      taxonomy: "product vs tool",
      restore_contract: "delete the fixture and verify the tree",
      evidence_locations: "evidence/T-102/inject/",
    },
  });
  assert.deepEqual(commandErrors(contracted), []);
});

test("a shared surface needs recorded permission", () => {
  // "It only reads" is a claim about code that has not run yet.
  assert.deepEqual(surfaceErrors(recipe()), []);
  assert.deepEqual(surfaceErrors(recipe({ surface: "ephemeral" })), []);
  assert.ok(
    surfaceErrors(recipe({ surface: "shared" })).some((error) => error.reason === "verify_surface_not_permitted"),
  );
  assert.deepEqual(surfaceErrors(recipe({ surface: "shared", surface_permission_ref: "decision-4" })), []);
  assert.ok(surfaceErrors(recipe({ surface: "production" })).length === 1);
  assert.deepEqual(SURFACES.slice(), ["local", "ephemeral", "shared"]);
});

test("a document that has never been run is a draft, whatever it says", () => {
  assert.equal(selfProofState(doc()).state, "proved");
  assert.equal(isDeliverable(doc()), true);
  const never = doc();
  delete never.self_proof;
  assert.equal(selfProofState(never).reason, "verify_never_executed");
  assert.equal(isDeliverable(never), false);
  assert.equal(
    selfProofState(doc({ self_proof: { ...doc().self_proof, executed_end_to_end: false } })).reason,
    "verify_never_executed",
  );
});

test("a proof about an earlier version of the document is stale", () => {
  // The instructions have since changed, so the proof is about other
  // instructions.
  for (const field of ["document_commit_oid", "document_tree_oid", "environment_digest", "config_digest"]) {
    const drifted = doc();
    drifted.self_proof = { ...drifted.self_proof, [field]: "9".repeat(field.endsWith("oid") ? 40 : 64) };
    assert.equal(selfProofState(drifted).reason, "verify_self_proof_stale", field);
  }
  const unknownRecipe = doc();
  unknownRecipe.self_proof = { ...unknownRecipe.self_proof, recipe_id: "r-9" };
  assert.equal(selfProofState(unknownRecipe).reason, "verify_self_proof_stale");
});

test("coverage is checked before dispatch, so the gap is cheap", () => {
  // Behaviour with no recipe is not proven by an argument that it obviously
  // works.
  const ticket = { behaviours: [{ id: "b-1", recipe_ids: ["r-1"] }] };
  assert.deepEqual(coverageErrors(ticket, ["r-1"]), []);
  assert.ok(
    coverageErrors({ behaviours: [{ id: "b-1" }] }, ["r-1"])
      .some((error) => error.reason === "verify_coverage_gap"),
  );
  assert.ok(
    coverageErrors(ticket, []).some((error) => /r-1 does not exist/u.test(error.detail)),
  );
});

test("an uncertain verification impact counts as required until someone decides", () => {
  const uncertain = { behaviours: [], verification_impact: "uncertain" };
  assert.ok(coverageErrors(uncertain, []).some((error) => error.reason === "verify_coverage_gap"));
  assert.deepEqual(coverageErrors({ ...uncertain, impact_decision_ref: "decision-5" }, []), []);
});

test("drift is fixed in the ticket when it is in scope, and becomes a correction otherwise", () => {
  const ticket = { pathspec: ["docs/verify"] };
  assert.equal(driftPlan(ticket, []).action, "none");
  assert.equal(driftPlan(ticket, ["docs/verify/transcript.md"]).action, "fix_in_this_ticket");
  assert.equal(driftPlan(ticket, ["docs/verify/a.md", "docs/other/b.md"]).action, "correction_ticket");
  assert.throws(() => driftPlan(ticket, "docs/verify/a.md"), code("verify_doc_drift"));
});

test("an infrastructure failure is not reported as a product failure", () => {
  // That sends someone to debug the wrong thing, which is what the doctor step
  // exists to prevent.
  assert.equal(classifyRun({ doctor_outcome: "passed", evidence_matches_expected: true }), "verified");
  assert.equal(classifyRun({ doctor_outcome: "passed", evidence_matches_expected: false }), "product_failure");
  assert.equal(classifyRun({ doctor_outcome: "passed" }), "indeterminate");
  assert.equal(classifyRun({ doctor_outcome: "failed", reported_as: "infrastructure_failure" }), "infrastructure_failure");
  assert.throws(
    () => classifyRun({ doctor_outcome: "failed", reported_as: "product_failure" }),
    code("verify_infrastructure_failure_mislabeled"),
  );
});

test("every refusal class the contract closes can be produced", () => {
  const produced = new Set();
  const collect = (errors) => {
    for (const error of errors) produced.add(error.reason);
  };
  collect(recipeErrors(undefined));
  collect(recipeErrors(recipe({ launch: "" })));
  collect(commandErrors(recipe({ commands: [{ id: "c", invocation: "TBD" }] })));
  collect(recipeErrors(recipe({ doctor: { checks: [] } })));
  collect(surfaceErrors(recipe({ surface: "shared" })));
  collect(coverageErrors({ behaviours: [{ id: "b" }] }, []));
  produced.add(selfProofState({ recipes: [] }).reason);
  produced.add(selfProofState(doc({ self_proof: { ...doc().self_proof, recipe_id: "r-9" } })).reason);
  produced.add(driftPlan({ pathspec: [] }, ["x"]).reason);
  for (const refusal of REFUSALS) {
    assert.ok(produced.has(refusal), `${refusal} is documented and never produced`);
  }
});
