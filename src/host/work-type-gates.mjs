/** Work-type prerequisites and batch sufficiency (#24).
 *
 * Including the playbook text in a prompt is not enough: a model can read a
 * requirement and still proceed to verification. So `work_type` is a typed
 * field with deterministic gates, checked before implementation starts and
 * again when the batch reports.
 *
 * The sentence the sufficiency half exists for: a batch is not sufficient
 * because a temporary script exited 0.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

export const WORK_TYPES = immutable(['feature', 'bug-fix', 'refactoring', 'perf']);

/** Four of these are not failures of the product. */
export const NON_PRODUCT_OUTCOMES = immutable([
  'green_control_failed',
  'mutation_not_applied',
  'tool_execution_failed',
  'indeterminate',
]);

export const REFUSALS = immutable([
  'worktype_missing',
  'worktype_mixed',
  'bugfix_root_cause_unknown',
  'bugfix_investigate_and_fix_combined',
  'refactor_behavior_pin_missing',
  'perf_threshold_after_result',
  'batch_contract_missing',
  'batch_proof_contract_incomplete',
  'batch_mutation_not_applied',
  'batch_green_control_failed',
  'batch_restore_unverified',
  'batch_result_stale',
  'batch_listing_disposition_evaded',
]);

/** The identity fields a batch result binds to. Any of them moving makes it stale. */
export const BINDING_FIELDS = immutable([
  'candidate_tree_oid',
  'environment_digest',
  'tool_digest',
  'harness_digest',
  'mutation_set_digest',
  'attempt',
  'policy_digest',
]);

/** Shape, not behaviour: neither of these pins what the code does. */
const NOT_A_BEHAVIOUR_PIN = immutable(['typecheck', 'lint', 'format']);

/**
 * The prerequisites a ticket must satisfy before implementation starts.
 *
 * Checked here rather than described in a prompt, because a requirement a
 * model can read and skip is a suggestion.
 */
export function prerequisiteErrors(ticket) {
  const errors = [];
  if (!ticket.work_type) return [{ reason: 'worktype_missing', detail: ticket.ticket_id }];
  if (!WORK_TYPES.includes(ticket.work_type)) {
    return [{ reason: 'worktype_missing', detail: `unknown work type ${ticket.work_type}` }];
  }
  if ((ticket.additional_work_types ?? []).length > 0) {
    // Bug investigation, refactor and feature are not silently glued into one
    // unbounded ticket.
    errors.push({ reason: 'worktype_mixed', detail: [ticket.work_type, ...ticket.additional_work_types].join('+') });
  }

  if (ticket.work_type === 'feature') {
    for (const field of ['data_shape', 'why_not_booleans', 'rejected_alternatives']) {
      if (!ticket[field]) errors.push({ reason: 'batch_proof_contract_incomplete', detail: `feature: ${field}` });
    }
    if (!ticket.tests_in_same_ticket) {
      errors.push({ reason: 'batch_proof_contract_incomplete', detail: 'feature: tests for the new behaviour' });
    }
  }

  if (ticket.work_type === 'bug-fix') {
    if (!ticket.root_cause) {
      errors.push({ reason: 'bugfix_root_cause_unknown', detail: ticket.ticket_id });
    }
    if (!ticket.runtime_evidence_pointer) {
      errors.push({ reason: 'bugfix_root_cause_unknown', detail: 'no runtime evidence pointer' });
    }
    if (!ticket.repro_confirmed_on_surface) {
      errors.push({ reason: 'bugfix_root_cause_unknown', detail: 'the repro is not confirmed on a matching surface' });
    }
    if (!ticket.failing_regression_test_before_fix) {
      // Without it, "fixed" is a claim about code nobody watched fail.
      errors.push({ reason: 'bugfix_root_cause_unknown', detail: 'no failing regression test before the fix' });
    }
    if (ticket.includes_investigation) {
      // A handoff that may change the code has no way to prove what the code
      // did before it.
      errors.push({ reason: 'bugfix_investigate_and_fix_combined', detail: ticket.ticket_id });
    }
  }

  if (ticket.work_type === 'refactoring') {
    const pin = ticket.behaviour_pin;
    if (!pin) {
      errors.push({ reason: 'refactor_behavior_pin_missing', detail: 'no characterization test or equivalence harness' });
    } else if (NOT_A_BEHAVIOUR_PIN.includes(pin.kind)) {
      // They constrain shape, not behaviour.
      errors.push({ reason: 'refactor_behavior_pin_missing', detail: `${pin.kind} is not a behaviour pin` });
    }
    if (!ticket.equivalence_proof_target) {
      errors.push({ reason: 'refactor_behavior_pin_missing', detail: 'no artifact or surface to prove equivalence on' });
    }
  }

  if (ticket.work_type === 'perf') {
    const method = ticket.measurement_method ?? {};
    for (const field of ['warm_up', 'min_repeats', 'spread_statistic', 'noise_threshold', 'command', 'workload', 'environment', 'hypothesis']) {
      if (method[field] === undefined) {
        errors.push({ reason: 'batch_proof_contract_incomplete', detail: `perf: ${field}` });
      }
    }
    if (method.threshold_fixed_after_results) {
      // A threshold chosen afterwards is a description of the result.
      errors.push({ reason: 'perf_threshold_after_result', detail: ticket.ticket_id });
    }
  }
  return errors;
}

/**
 * A perf delta inside the threshold is inconclusive, never a pass.
 */
export function perfVerdict({ deltaRatio, noiseThreshold }) {
  demand(typeof noiseThreshold === 'number' && noiseThreshold > 0, 'perf_threshold_after_result',
    'A perf comparison needs a threshold fixed before the numbers');
  if (Math.abs(deltaRatio) < noiseThreshold) return 'inconclusive';
  return deltaRatio < 0 ? 'improved' : 'regressed';
}

/**
 * Whether a planning artifact owes an exact scaffolding listing.
 *
 * A missing listing is not a finding when the proof contract is complete and
 * unambiguously executable. Missing both is a finding.
 */
export function listingObligation(artifact) {
  if (artifact.exact_listing_present) return Object.freeze({ owed: false, reason: 'listing_present' });
  if (artifact.proof_contract_complete && artifact.proof_contract_executable) {
    return Object.freeze({ owed: false, reason: 'proof_contract_sufficient' });
  }
  return Object.freeze({ owed: true, reason: 'batch_proof_contract_incomplete' });
}

/**
 * Removing a listing on an operator's disposition means removing it.
 *
 * Rewriting it, moving it to an appendix, hiding it under a fold, translating
 * it, or leaving equivalent pseudocode all keep the thing the disposition asked
 * to remove.
 */
export function dispositionEvasions(before, after) {
  const evasions = [];
  if (after.exact_listing_present) evasions.push('the listing is still present');
  if (after.appendix_listing || after.collapsed_listing) evasions.push('the listing was moved rather than removed');
  if (after.translated_listing) evasions.push('the listing was translated rather than removed');
  if (after.equivalent_pseudocode) evasions.push('equivalent pseudocode of the same implementation remains');
  if (evasions.length === 0 && after.artifact_identity === before.artifact_identity) {
    // The obligation survives as a declarative contract, and the change creates
    // a new planning-artifact identity.
    evasions.push('the removal did not create a new artifact identity');
  }
  return evasions.map((detail) => ({ reason: 'batch_listing_disposition_evaded', detail }));
}

/**
 * Whether a batch demonstrated what it claims.
 *
 * A batch is not sufficient because a temporary script exited 0.
 */
export function batchSufficiencyErrors(batch) {
  const errors = [];
  if (!batch) return [{ reason: 'batch_contract_missing', detail: 'no batch record' }];
  for (const field of ['batch_id', 'purpose', 'candidate_identity', 'acceptance_rule', 'failure_taxonomy']) {
    if (!batch[field]) errors.push({ reason: 'batch_contract_missing', detail: `missing ${field}` });
  }
  for (const mutation of batch.mutations ?? []) {
    if (!mutation.application_proof) {
      errors.push({ reason: 'batch_mutation_not_applied', detail: mutation.id });
    }
    if (!mutation.expected_killer || !mutation.observed_red_signature) {
      errors.push({ reason: 'batch_proof_contract_incomplete', detail: `${mutation.id}: no killer and red signature` });
    }
  }
  if (batch.green_control !== 'passed') {
    // If the unmutated candidate fails its own controls, a red result says
    // nothing.
    errors.push({ reason: 'batch_green_control_failed', detail: String(batch.green_control) });
  }
  if (!batch.harness_self_test && !batch.known_killed_mutation) {
    errors.push({ reason: 'batch_proof_contract_incomplete', detail: 'no harness self-test or known killed mutation' });
  }
  if (!batch.repository_tests_final_run) {
    errors.push({ reason: 'batch_proof_contract_incomplete', detail: 'the existing repository tests were not re-run' });
  }
  if (batch.restore_verified !== true) {
    errors.push({ reason: 'batch_restore_unverified', detail: batch.batch_id ?? 'unknown batch' });
  }
  return errors;
}

/**
 * Whether a result still describes the thing it was run on.
 *
 * Changing any binding makes the old result stale, not merely old.
 */
export function stalenessErrors(result, current) {
  return BINDING_FIELDS
    .filter((field) => result[field] !== current[field])
    .map((field) => ({ reason: 'batch_result_stale', detail: `${field}: ${result[field]} -> ${current[field]}` }));
}

/** Scaffolding that is kept stops being exempt from ordinary review. */
export function scaffoldingErrors(scaffolding) {
  const errors = [];
  if (scaffolding.lifecycle === 'ephemeral') {
    if (scaffolding.inside_product_source_tree) {
      errors.push({ reason: 'batch_proof_contract_incomplete', detail: 'ephemeral scaffolding inside the product tree' });
    }
    if (!scaffolding.source_digest || !scaffolding.binary_digest || !scaffolding.config_digest) {
      errors.push({ reason: 'batch_proof_contract_incomplete', detail: 'ephemeral scaffolding without recorded digests' });
    }
    if (scaffolding.deleted && scaffolding.restore_verified !== true) {
      errors.push({ reason: 'batch_restore_unverified', detail: 'deleted before the restore was verified' });
    }
    if (scaffolding.is_deliverable) {
      errors.push({ reason: 'batch_proof_contract_incomplete', detail: 'ephemeral scaffolding is never a deliverable' });
    }
  }
  if (scaffolding.lifecycle === 'committed_reusable') {
    if (!scaffolding.has_own_tests || !scaffolding.cross_family_review) {
      // No longer covered by the exemption for temporary listings.
      errors.push({ reason: 'batch_listing_disposition_evaded', detail: 'committed scaffolding takes its own tests and review' });
    }
  }
  return errors;
}
