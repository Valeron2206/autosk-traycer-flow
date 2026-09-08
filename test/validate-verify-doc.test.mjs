/**
 * Tests for the issue #23 project verification document.
 *
 * Three things make a recipe worth having: exact commands, an infrastructure
 * failure distinguishable from a product one, and a document nobody may call a
 * deliverable before running it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_PATH,
  EXAMPLE_PATH,
  REFUSALS,
  SCHEMA_PATH,
  coverage,
  loadFiles,
  recipeUsable,
  validateMap,
  validateVerifyDocDesign,
  verifyDocDesignDigest,
} from "../scripts/validate-verify-doc.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

const map = () => JSON.parse(files[EXAMPLE_PATH]);
const proved = (m = map()) => m.recipes.find((recipe) => recipe.state === "self_proved");
const draft = (m = map()) => m.recipes.find((recipe) => recipe.state === "draft");

function mutated(mutate) {
  const value = map();
  mutate(value);
  return value;
}

function assertRejects(value, pattern) {
  const errors = validateMap(value, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

test("the shipped design validates", () => {
  assert.deepEqual(validateVerifyDocDesign(files), []);
});

test("a recipe nobody has run is a draft, whatever it says about itself", () => {
  // This is the artefact everything else is verified against, so the difference
  // between a plan for verifying and a verification matters most here.
  const value = map();
  assert.equal(recipeUsable(proved(value), value), "usable");
  assert.equal(recipeUsable(draft(value), value), "refused:verify_never_executed");
});

test("self-proof from another document version is stale", () => {
  // The evidence is bound to the exact commit and tree, so editing the recipe
  // invalidates the run that proved the old one.
  const value = mutated((m) => {
    m.doc_commit = "9".repeat(40);
  });
  assert.equal(recipeUsable(proved(value), value), "refused:verify_self_proof_stale");
  const swapped = mutated((m) => {
    proved(m).self_proof.recipe_id = "some-other-recipe";
  });
  assert.equal(recipeUsable(proved(swapped), swapped), "refused:verify_self_proof_stale");
});

test("all five parts are required; a recipe missing one is not a shorter recipe", () => {
  for (const part of ["launch", "doctor", "drive", "evidence", "cleanup"]) {
    assert.ok(schema.properties.recipes.items.required.includes(part), `${part} is optional`);
  }
});

test("a command is a command, not a description of one", () => {
  // "The implementer will write a script" defers the only part that makes a
  // recipe repeatable.
  for (const vague of [
    "the implementer will write a script to drive it",
    "run the tool or similar",
    "start the daemon somehow",
    "cleanup: TBD",
  ]) {
    assertRejects(
      mutated((m) => {
        proved(m).drive.push(vague);
      }),
      /verify_command_not_exact/u,
    );
  }
});

test("every doctor check says how its failure is recognised", () => {
  // Without it an infrastructure failure and a product failure look the same,
  // and that difference decides whether the ticket is wrong or the machine is.
  assertRejects(
    mutated((m) => {
      proved(m).doctor[0].infrastructure_failure_signal = "   ";
    }),
    /how its failure is recognised/u,
  );
});

test("a shared surface needs recorded permission, and nothing else carries one", () => {
  // "It only reads" is a claim about code that has not run yet.
  assertRejects(
    mutated((m) => {
      proved(m).surface = "shared";
    }),
    /verify_surface_not_permitted/u,
  );
  const permitted = mutated((m) => {
    const recipe = proved(m);
    recipe.surface = "shared";
    recipe.surface_permission = { approved_by: "owner", reason: "the staging instance is disposable" };
  });
  assert.deepEqual(validateMap(permitted, schema), []);
  assertRejects(
    mutated((m) => {
      proved(m).surface_permission = { approved_by: "owner", reason: "why not" };
    }),
    /only a shared surface carries a permission/u,
  );
});

test("a draft cannot carry self-proof, and self-proved cannot lack it", () => {
  assertRejects(
    mutated((m) => {
      draft(m).self_proof = proved(m).self_proof;
    }),
    /draft cannot carry self-proof/u,
  );
  assertRejects(
    mutated((m) => {
      delete proved(m).self_proof;
    }),
    /self-proved without evidence/u,
  );
});

test("coverage is decided by usable recipes, not by drafts", () => {
  // The gap is found before dispatch, while it is cheap.
  const value = map();
  assert.equal(coverage(value, ["#11 criterion 1"]), "covered");
  assert.match(coverage(value, ["#37 criterion 2"]), /verify_coverage_gap/u);
  assert.match(coverage(value, ["#99 unmapped"]), /verify_coverage_gap/u);
});

test("disposable scaffolding is cited by contract identity, not promised", () => {
  const scaffolded = draft();
  assert.match(scaffolded.scaffolding.batch_contract_digest, /^[0-9a-f]{64}$/u);
  for (const field of ["purpose", "owner", "lifecycle", "invocation", "expected_red",
                       "expected_green", "restore_contract", "evidence_location"]) {
    assert.ok(scaffolded.scaffolding[field], `${field} is absent`);
  }
});

test("committed scaffolding names the exact command it became", () => {
  assertRejects(
    mutated((m) => {
      draft(m).scaffolding.lifecycle = "committed";
    }),
    /canonical command and version/u,
  );
});

test("a duplicated recipe id is refused", () => {
  assertRejects(
    mutated((m) => {
      m.recipes.push({ ...proved(m), feature_id: "another-feature" });
    }),
    /appears twice/u,
  );
});

test("every refusal is documented", () => {
  const contract = files[CONTRACT_PATH];
  for (const refusal of REFUSALS) assert.ok(contract.includes(refusal), `${refusal} is not documented`);
});

test("the design digest changes when any shipped file changes", () => {
  const before = verifyDocDesignDigest(files);
  const after = verifyDocDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
