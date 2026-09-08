/** Verification recipes, self-proof and coverage (#23).
 *
 * A verification document is the artefact everything else is verified against,
 * which is why it is held to its own instructions: until they have been
 * executed end to end on a permitted surface, it is a plan for verifying,
 * whatever it says about itself.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

/** Five parts, each answering a different question. */
export const RECIPE_PARTS = immutable(['launch', 'doctor', 'drive', 'evidence', 'cleanup']);

export const SURFACES = immutable(['local', 'ephemeral', 'shared']);

export const REFUSALS = immutable([
  'verify_recipe_missing',
  'verify_recipe_incomplete',
  'verify_command_not_exact',
  'verify_never_executed',
  'verify_self_proof_stale',
  'verify_surface_not_permitted',
  'verify_coverage_gap',
  'verify_doc_drift',
  'verify_infrastructure_failure_mislabeled',
]);

/** Phrases that defer the work instead of naming the invocation. */
const VAGUE_COMMAND = [
  /\bthe implementer will\b/iu,
  /\bwrite a script\b/iu,
  /\bsome(?:thing| tool| command)\b/iu,
  /\bas (?:appropriate|needed)\b/iu,
  /\betc\.?$/iu,
  /\bTBD\b/iu,
];

/**
 * A recipe has all five parts.
 *
 * `Doctor` is not a convenience: without it an infrastructure failure and a
 * product failure look the same, and the difference decides whether the ticket
 * is wrong or the machine is.
 */
export function recipeErrors(recipe) {
  const errors = [];
  if (!recipe) return [{ reason: 'verify_recipe_missing', detail: 'no recipe' }];
  for (const part of RECIPE_PARTS) {
    const value = recipe[part];
    if (!value || (typeof value === 'string' && value.trim().length === 0)) {
      errors.push({ reason: 'verify_recipe_incomplete', detail: `missing ${part}` });
    }
  }
  if (recipe.doctor && !recipe.doctor.infrastructure_failure_classification) {
    errors.push({
      reason: 'verify_infrastructure_failure_mislabeled',
      detail: 'the doctor does not say how an infrastructure failure is classified',
    });
  }
  if (recipe.evidence && !recipe.evidence.observed_values) {
    // "The command exits 0" is not evidence of behaviour unless exit 0 is the
    // behaviour.
    errors.push({ reason: 'verify_recipe_incomplete', detail: 'evidence names no observed values' });
  }
  errors.push(...commandErrors(recipe));
  errors.push(...surfaceErrors(recipe));
  return errors;
}

/**
 * Commands are written literally.
 *
 * "The implementer will write a script" does not replace the exact invocation
 * of a tool that already exists.
 */
export function commandErrors(recipe) {
  const errors = [];
  for (const command of recipe.commands ?? []) {
    if (!command.invocation || command.invocation.trim().length === 0) {
      errors.push({ reason: 'verify_command_not_exact', detail: `${command.id ?? 'command'}: no invocation` });
      continue;
    }
    if (VAGUE_COMMAND.some((pattern) => pattern.test(command.invocation))) {
      errors.push({ reason: 'verify_command_not_exact', detail: command.invocation.slice(0, 60) });
    }
    for (const field of ['exit_semantics', 'cleanup']) {
      if (!command[field]) {
        errors.push({ reason: 'verify_command_not_exact', detail: `${command.id ?? 'command'}: no ${field}` });
      }
    }
  }
  if (recipe.needs_new_scaffolding) {
    // A full listing of an unwritten helper is not required; a vague promise to
    // write tooling later is not accepted in its place.
    const contract = recipe.scaffolding_contract ?? {};
    for (const field of ['batch_contract_identity', 'purpose', 'owner', 'lifecycle', 'invocation_contract', 'expected_red', 'expected_green', 'taxonomy', 'restore_contract', 'evidence_locations']) {
      if (!contract[field]) {
        errors.push({ reason: 'verify_command_not_exact', detail: `scaffolding contract: ${field}` });
      }
    }
  }
  return errors;
}

/**
 * A shared or production surface needs recorded permission.
 *
 * "It only reads" is a claim about code that has not run yet.
 */
export function surfaceErrors(recipe) {
  if (!SURFACES.includes(recipe.surface)) {
    return [{ reason: 'verify_surface_not_permitted', detail: `unknown surface ${recipe.surface}` }];
  }
  if (recipe.surface === 'shared' && !recipe.surface_permission_ref) {
    return [{ reason: 'verify_surface_not_permitted', detail: 'a shared surface needs recorded permission' }];
  }
  return [];
}

/**
 * Whether a document has proved itself.
 *
 * Bound to the exact document commit and tree, the environment and config
 * identity and the recipe id — a proof about an earlier version of the document
 * is a proof about instructions that have since changed.
 */
export function selfProofState(doc) {
  const proof = doc.self_proof;
  if (!proof) return Object.freeze({ state: 'draft', reason: 'verify_never_executed' });
  if (!proof.executed_end_to_end) return Object.freeze({ state: 'draft', reason: 'verify_never_executed' });
  if (proof.document_commit_oid !== doc.commit_oid || proof.document_tree_oid !== doc.tree_oid) {
    return Object.freeze({ state: 'stale', reason: 'verify_self_proof_stale' });
  }
  if (proof.environment_digest !== doc.environment_digest || proof.config_digest !== doc.config_digest) {
    return Object.freeze({ state: 'stale', reason: 'verify_self_proof_stale' });
  }
  if (!(doc.recipes ?? []).some((recipe) => recipe.recipe_id === proof.recipe_id)) {
    return Object.freeze({ state: 'stale', reason: 'verify_self_proof_stale' });
  }
  return Object.freeze({ state: 'proved', recipe_id: proof.recipe_id });
}

/** A document is a deliverable only once it has proved itself. */
export function isDeliverable(doc) {
  return selfProofState(doc).state === 'proved';
}

/**
 * Coverage, checked before dispatch.
 *
 * Behaviour with no recipe is not proven by an argument that it obviously
 * works, and checking before dispatch is what makes the gap cheap to fix.
 */
export function coverageErrors(ticket, recipeIds) {
  const known = new Set(recipeIds);
  const errors = [];
  for (const behaviour of ticket.behaviours ?? []) {
    if (!behaviour.recipe_ids || behaviour.recipe_ids.length === 0) {
      errors.push({ reason: 'verify_coverage_gap', detail: `${behaviour.id}: no recipe` });
      continue;
    }
    for (const id of behaviour.recipe_ids) {
      if (!known.has(id)) errors.push({ reason: 'verify_coverage_gap', detail: `${behaviour.id}: ${id} does not exist` });
    }
  }
  // An uncertain documentation or verification impact counts as required until
  // someone decides it is not.
  if (ticket.verification_impact === 'uncertain' && !ticket.impact_decision_ref) {
    errors.push({ reason: 'verify_coverage_gap', detail: 'an uncertain verification impact counts as required' });
  }
  return errors;
}

/**
 * Where drift is fixed.
 *
 * In the same ticket when the verify-doc paths are inside its scope, and as a
 * correction ticket otherwise — so the fix never quietly widens a Ticket's
 * declared scope.
 */
export function driftPlan(ticket, driftedPaths) {
  demand(Array.isArray(driftedPaths), 'verify_doc_drift', 'Drift is a list of paths');
  if (driftedPaths.length === 0) return Object.freeze({ action: 'none' });
  const inScope = driftedPaths.every((path) =>
    (ticket.pathspec ?? []).some((prefix) => path === prefix || path.startsWith(`${prefix}/`)),
  );
  return Object.freeze({
    action: inScope ? 'fix_in_this_ticket' : 'correction_ticket',
    reason: 'verify_doc_drift',
    paths: immutable([...driftedPaths].sort()),
  });
}

/**
 * How a run's outcome is classified.
 *
 * An infrastructure failure reported as a product failure sends someone to
 * debug the wrong thing, which is exactly what the doctor step exists to
 * prevent.
 */
export function classifyRun(run) {
  if (run.doctor_outcome === 'failed') {
    demand(run.reported_as !== 'product_failure', 'verify_infrastructure_failure_mislabeled',
      'The doctor failed, so this is not a statement about the product',
      { reported_as: run.reported_as });
    return 'infrastructure_failure';
  }
  if (run.evidence_matches_expected === true) return 'verified';
  if (run.evidence_matches_expected === false) return 'product_failure';
  return 'indeterminate';
}
