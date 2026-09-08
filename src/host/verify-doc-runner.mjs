/** Executing a verification document's own recipe (#23).
 *
 * A verification document is what everything else is verified against, which is
 * why the contract holds it to its own instructions: until they have been run
 * end to end, it is a plan for verifying, whatever it says about itself.
 *
 * Running them is this file. The two things it will not do are run a recipe it
 * has already refused — a document with a vague command is not improved by
 * executing the parts that are exact — and record a proof for a run whose
 * doctor failed, because that run says nothing about the product.
 *
 * Injected `run(command, args, { cwd, env, timeoutMs })` returns
 * `{ code, stdout, stderr }`, with `code: null` when the command never started.
 */
import { createHash } from 'node:crypto';

import { demand, immutable } from '../runtime/contracts.mjs';

import { classifyRun, recipeErrors, selfProofState } from './verify-doc.mjs';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * An invocation split into a command and its arguments, quotes respected.
 *
 * Splitting on whitespace would read `sh -c 'exit 0'` as four words and run
 * something else — the invocation looks right and is executed wrong, which is
 * the exact failure this contract is about. An unterminated quote is refused
 * rather than guessed at.
 */
export function tokenize(invocation) {
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  for (const character of invocation) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  demand(quote === null, 'verify_command_not_exact', 'The invocation has an unterminated quote', { invocation });
  if (started) tokens.push(current);
  return immutable(tokens);
}

/** One step of the recipe, run as written. */
export async function runStep(run, { id, invocation, cwd, env, timeoutMs = 120_000 }) {
  const [command, ...args] = tokenize(invocation);
  demand(Boolean(command), 'verify_command_not_exact', 'A step has no command', { id });
  const started = Date.now();
  const result = await run(command, args, { cwd, env, timeoutMs });
  return Object.freeze({
    id,
    invocation,
    exit_code: result.code,
    // A command that never started is not a command that failed: the first is
    // about the machine and the second is about the product.
    started: result.code !== null && result.code !== undefined,
    stdout: (result.stdout ?? '').slice(0, 4096),
    stderr: (result.stderr ?? '').slice(0, 4096),
    ms: Date.now() - started,
  });
}

/**
 * Executes the recipe end to end and records what happened.
 *
 * The document is refused before anything runs if its own recipe does not hold
 * up: a vague command is not improved by executing the parts that are exact.
 */
export async function executeRecipe(run, { recipe, cwd, env, doctor }) {
  const problems = recipeErrors(recipe);
  demand(problems.length === 0, problems[0]?.reason ?? 'verify_recipe_incomplete',
    'The recipe does not hold up, so running it proves nothing',
    { detail: problems[0]?.detail });

  // The doctor decides what a later failure means, so it runs first and its
  // outcome is carried rather than recomputed.
  const doctorRun = doctor ? await runStep(run, { id: 'doctor', invocation: doctor, cwd, env }) : null;
  const doctorOutcome = doctorRun === null
    ? 'skipped'
    : (doctorRun.started && doctorRun.exit_code === 0 ? 'passed' : 'failed');

  const steps = [];
  if (doctorRun) steps.push(doctorRun);
  if (doctorOutcome !== 'failed') {
    for (const command of recipe.commands ?? []) {
      const step = await runStep(run, { id: command.id, invocation: command.invocation, cwd, env });
      steps.push(step);
      if (!step.started) break;
    }
  }

  const infrastructure = steps.find((step) => !step.started);
  // A failed doctor has already produced `infrastructure_failure` below, so
  // this list never has to exclude it.
  const failed = steps.filter((step) => step.started && step.exit_code !== 0);
  const outcome = classifyRun({
    doctor_outcome: doctorOutcome === 'failed' ? 'failed' : 'passed',
    reported_as: doctorOutcome === 'failed' ? 'infrastructure_failure' : undefined,
    evidence_matches_expected: infrastructure ? undefined : failed.length === 0,
  });
  return Object.freeze({
    recipe_id: recipe.recipe_id,
    doctor_outcome: doctorOutcome,
    outcome: infrastructure ? 'infrastructure_failure' : outcome,
    steps: immutable(steps),
    // Named on purpose: a run that stopped because the machine could not run a
    // command has not verified anything, and has not failed anything either.
    infrastructure_step: infrastructure?.id ?? null,
  });
}

/**
 * The self-proof, bound to the document it was produced from.
 *
 * Bound to the commit, the tree, the environment and the configuration,
 * because a proof about an earlier version of the document is a proof about
 * instructions that have since changed.
 */
export function selfProof(doc, execution) {
  demand(execution.outcome === 'verified', 'verify_never_executed',
    'A self-proof records a run that verified, not one that did not',
    { outcome: execution.outcome });
  return Object.freeze({
    executed_end_to_end: true,
    document_commit_oid: doc.commit_oid,
    document_tree_oid: doc.tree_oid,
    environment_digest: doc.environment_digest,
    config_digest: doc.config_digest,
    recipe_id: execution.recipe_id,
    run_digest: sha256(JSON.stringify(execution.steps.map((step) => [step.id, step.exit_code]))),
  });
}

/**
 * Runs the document's own recipe and returns the document with its proof.
 *
 * The state is recomputed from the contract's own reader rather than asserted
 * here: one place decides whether a document is a deliverable.
 */
export async function proveDocument(run, { doc, recipeId, cwd, env }) {
  const recipe = (doc.recipes ?? []).find((entry) => entry.recipe_id === recipeId);
  demand(Boolean(recipe), 'verify_recipe_missing', 'The document has no such recipe', { recipeId });
  // The five parts are checked by `executeRecipe` through the contract's own
  // reader; a second loop here would refuse the same recipes in other words.
  const execution = await executeRecipe(run, {
    recipe,
    cwd,
    env,
    doctor: recipe.doctor?.invocation,
  });
  if (execution.outcome !== 'verified') {
    return Object.freeze({ doc, execution, state: selfProofState(doc) });
  }
  const proved = { ...doc, self_proof: selfProof(doc, execution) };
  return Object.freeze({ doc: Object.freeze(proved), execution, state: selfProofState(proved) });
}
