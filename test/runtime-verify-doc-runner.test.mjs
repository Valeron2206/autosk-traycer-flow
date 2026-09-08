/**
 * Tests for executing a verification document's own recipe (issue #23).
 *
 * The document is what everything else is verified against, so it is held to
 * its own instructions: until they have been run end to end, it is a plan for
 * verifying, whatever it says about itself. These run them, with real
 * processes.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { isDeliverable } from "../src/host/verify-doc.mjs";
import { readFile } from "node:fs/promises";

import { ROOT } from "../scripts/validate-artifact-registry.mjs";
import {
  bootstrapDecision,
  dispatchCoverage,
  executeRecipe,
  proveDocument,
  runStep,
  selfProof,
  tokenize,
} from "../src/host/verify-doc-runner.mjs";

const registry = JSON.parse(
  await readFile(path.join(ROOT, "resources/artifact-registry/artifact-registry.v1.json"), "utf8"),
);

const execFileAsync = promisify(execFile);
const code = (name) => (error) => error.code === name;

const run = async (command, args, { cwd, env, timeoutMs }) =>
  execFileAsync(command, args, { cwd, env: { PATH: process.env.PATH, ...env }, timeout: timeoutMs }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error) => ({
      code: error.code === "ENOENT" ? null : (typeof error.code === "number" ? error.code : 1),
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error),
    }),
  );

async function workspace(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), "autosk-verify-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

const recipe = (overrides = {}) => ({
  recipe_id: "r-1",
  launch: "/bin/sh -c 'exit 0'",
  doctor: {
    invocation: "/bin/sh -c 'exit 0'",
    checks: ["the shell runs"],
    infrastructure_failure_classification: "park as environment_failure",
  },
  drive: "read the fixture",
  evidence: { capture: "stdout", observed_values: { lines: 1 } },
  cleanup: "rm -rf $TMPDIR/fixture",
  surface: "local",
  commands: [
    { id: "drive", invocation: "/bin/sh -c 'echo one'", exit_semantics: "0 means the line was produced", cleanup: "none" },
  ],
  ...overrides,
});

const doc = (overrides = {}) => ({
  commit_oid: "a".repeat(40),
  tree_oid: "b".repeat(40),
  environment_digest: "c".repeat(64),
  config_digest: "d".repeat(64),
  recipes: [recipe()],
  ...overrides,
});

test("a document that runs its own recipe end to end becomes a deliverable", async (t) => {
  const cwd = await workspace(t);
  const result = await proveDocument(run, { doc: doc(), recipeId: "r-1", cwd });
  assert.equal(result.execution.outcome, "verified");
  assert.equal(result.state.state, "proved");
  assert.equal(isDeliverable(result.doc), true);
  assert.equal(result.doc.self_proof.recipe_id, "r-1");
  assert.equal(result.doc.self_proof.document_commit_oid, doc().commit_oid);
  assert.ok(result.doc.self_proof.run_digest.length === 64);
});

test("a document that has not been run is a draft, whatever it says about itself", async (t) => {
  const cwd = await workspace(t);
  const failing = doc({
    recipes: [recipe({
      commands: [{ id: "drive", invocation: "/bin/sh -c 'exit 3'", exit_semantics: "0", cleanup: "none" }],
    })],
  });
  const result = await proveDocument(run, { doc: failing, recipeId: "r-1", cwd });
  assert.equal(result.execution.outcome, "product_failure");
  assert.equal(result.state.reason, "verify_never_executed");
  assert.equal(result.doc.self_proof, undefined);
  assert.equal(isDeliverable(result.doc), false);
});

test("a recipe that does not hold up is refused before anything runs", async (t) => {
  const cwd = await workspace(t);
  let ran = false;
  const watcher = async () => {
    ran = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  // A vague command is not improved by executing the parts that are exact.
  await assert.rejects(
    () => executeRecipe(watcher, {
      recipe: recipe({
        commands: [{ id: "drive", invocation: "the implementer will write a script", exit_semantics: "0", cleanup: "none" }],
      }),
      cwd,
    }),
    code("verify_command_not_exact"),
  );
  assert.equal(ran, false);
});

test("a failed doctor is an infrastructure failure, and the rest does not run", async (t) => {
  const cwd = await workspace(t);
  const broken = recipe({
    doctor: {
      invocation: "/bin/sh -c 'exit 1'",
      checks: ["the daemon answers"],
      infrastructure_failure_classification: "park as environment_failure",
    },
  });
  const execution = await executeRecipe(run, { recipe: broken, cwd, doctor: broken.doctor.invocation });
  assert.equal(execution.doctor_outcome, "failed");
  assert.equal(execution.outcome, "infrastructure_failure");
  // Only the doctor ran: the steps after it would report on a machine already
  // known not to be running them.
  assert.deepEqual(execution.steps.map((step) => step.id), ["doctor"]);
  assert.throws(() => selfProof(doc(), execution), code("verify_never_executed"));
});

test("a command that never started is not a command that failed", async (t) => {
  const cwd = await workspace(t);
  const missing = recipe({
    commands: [
      { id: "drive", invocation: "./there-is-no-such-tool", exit_semantics: "0", cleanup: "none" },
      { id: "after", invocation: "/bin/sh -c 'exit 0'", exit_semantics: "0", cleanup: "none" },
    ],
  });
  const execution = await executeRecipe(run, { recipe: missing, cwd, doctor: missing.doctor.invocation });
  assert.equal(execution.outcome, "infrastructure_failure");
  assert.equal(execution.infrastructure_step, "drive");
  // And it stops there rather than reporting on the steps behind it.
  assert.deepEqual(execution.steps.map((step) => step.id), ["doctor", "drive"]);
});

test("a proof about an earlier version of the document does not travel", async (t) => {
  const cwd = await workspace(t);
  const proved = (await proveDocument(run, { doc: doc(), recipeId: "r-1", cwd })).doc;
  // The instructions have since changed, so the proof is about other
  // instructions.
  const edited = { ...proved, tree_oid: "9".repeat(40) };
  assert.equal(isDeliverable(edited), false);
  const rebuilt = { ...proved, environment_digest: "9".repeat(64) };
  assert.equal(isDeliverable(rebuilt), false);
});

test("an invocation is split the way a shell would split it", () => {
  // Splitting on whitespace reads this as four words and runs something else:
  // the invocation looks right and is executed wrong.
  assert.deepEqual([...tokenize("/bin/sh -c 'echo one two'")], ["/bin/sh", "-c", "echo one two"]);
  assert.deepEqual([...tokenize('node script.mjs --title "a b"')], ["node", "script.mjs", "--title", "a b"]);
  assert.deepEqual([...tokenize("  spaced   out  ")], ["spaced", "out"]);
  assert.deepEqual([...tokenize("node script.mjs --empty ''")], ["node", "script.mjs", "--empty", ""]);
  assert.throws(() => tokenize("node script.mjs --title 'unterminated"), code("verify_command_not_exact"));
});

test("a recipe the document does not have, and a step with no command", async (t) => {
  const cwd = await workspace(t);
  await assert.rejects(
    () => proveDocument(run, { doc: doc(), recipeId: "r-9", cwd }),
    code("verify_recipe_missing"),
  );
  await assert.rejects(
    () => runStep(run, { id: "empty", invocation: "   ", cwd }),
    code("verify_command_not_exact"),
  );
});

test("the run digest is over what actually ran", async (t) => {
  const cwd = await workspace(t);
  await writeFile(path.join(cwd, "fixture.txt"), "one\n");
  const first = await proveDocument(run, { doc: doc(), recipeId: "r-1", cwd });
  const second = await proveDocument(run, { doc: doc(), recipeId: "r-1", cwd });
  assert.equal(second.doc.self_proof.run_digest, first.doc.self_proof.run_digest);

  const other = doc({
    recipes: [recipe({
      commands: [{ id: "different", invocation: "/bin/sh -c 'exit 0'", exit_semantics: "0", cleanup: "none" }],
    })],
  });
  const third = await proveDocument(run, { doc: other, recipeId: "r-1", cwd });
  assert.notEqual(third.doc.self_proof.run_digest, first.doc.self_proof.run_digest);
});

test("a project gets a verification document when it has behaviour to verify", () => {
  // Creating one for a repository with nothing to drive produces a document
  // that describes how to verify nothing — and then has to be maintained,
  // read, and eventually believed.
  const docsOnly = bootstrapDecision(registry, { paths: ["README.md"] });
  assert.equal(docsOnly.decision, "not_needed");

  const withCode = bootstrapDecision(registry, { paths: ["README.md", "src/host/panel.mjs"] });
  assert.equal(withCode.decision, "create");
  assert.deepEqual([...withCode.behaviour], ["src/host/panel.mjs"]);
  assert.equal(bootstrapDecision(registry, { paths: ["src/host/panel.mjs"], existingDoc: {} }).decision, "exists");

  // "Probably just docs" is the reading the registry exists to remove.
  const unknown = bootstrapDecision(registry, { paths: ["some/unregistered/thing.txt"] });
  assert.equal(unknown.decision, "create");
  assert.deepEqual([...unknown.unclassified], ["some/unregistered/thing.txt"]);
});

test("coverage is asked before dispatch, so the gap is cheap", () => {
  const covered = dispatchCoverage({ behaviours: [{ id: "b-1", recipe_ids: ["r-1"] }] }, doc());
  assert.equal(covered.decision, "dispatch");
  const gap = dispatchCoverage({ behaviours: [{ id: "b-1" }] }, doc());
  assert.equal(gap.decision, "park");
  assert.ok(gap.errors.some((error) => error.reason === "verify_coverage_gap"));
  const unknownRecipe = dispatchCoverage({ behaviours: [{ id: "b-1", recipe_ids: ["r-9"] }] }, doc());
  assert.equal(unknownRecipe.decision, "park");
});
