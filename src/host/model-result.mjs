/** The submission path: one structured result in, one transition out.
 *
 * A model returns data. It does not move a task, edit metadata, write a comment
 * as canonical state, or name the next step — **a model's output is evidence,
 * not an effect**. This is the host side of that: the checks that run before
 * anything moves, and the transition the host selects afterwards.
 *
 * Free-form JSON inside prose is not a result; it is prose that happens to
 * contain braces, and `parseSubmission` says so rather than guessing.
 */
import { createHash } from 'node:crypto';

import { demand, immutable } from '../runtime/contracts.mjs';

export const RESULT_KINDS = immutable([
  'artifact_author',
  'implementation',
  'fix',
  'verification',
  'verification_batch',
  'arena_candidate',
  'requirement_analysis',
]);

export const OUTCOMES = immutable([
  'ready_for_verification',
  'blocked',
  'needs_human',
  'pass',
  'fail',
  'tool_failure',
  'indeterminate',
]);

/** No role gets a generic mutation tool. Not a policy — the absence of the tool. */
export const FORBIDDEN_TOOLS = immutable([
  'autosk_task_mutate',
  'autosk_step_mutate',
  'autosk_comment_write',
  'autosk_metadata_mutate',
]);

export const PARK_REASONS = immutable([
  'no_result_submitted',
  'multiple_results_submitted',
  'schema_invalid',
  'unknown_field',
  'scope_mismatch',
  'evidence_unresolved',
  'stale_anchor',
  'stale_runtime_identity',
  'tool_failure_not_product_disposition',
  'missing_application_proof',
  'missing_green_control',
  'missing_restore_receipt',
  'stale_harness_digest',
]);

/** The marker a provider wraps its one submission in. */
export const SUBMISSION_OPEN = '<<<autosk-result';
export const SUBMISSION_CLOSE = 'autosk-result>>>';

/**
 * Extracts the structured result from a provider's output.
 *
 * Exactly one delimited submission. Prose containing braces is not a result,
 * and neither is a second submission "clarifying" the first: the second is
 * refused and the first stands, with the discrepancy recorded.
 */
export function parseSubmission(output) {
  const blocks = [];
  let cursor = 0;
  for (;;) {
    const open = output.indexOf(SUBMISSION_OPEN, cursor);
    if (open === -1) break;
    const close = output.indexOf(SUBMISSION_CLOSE, open + SUBMISSION_OPEN.length);
    demand(close !== -1, 'no_result_submitted', 'A submission was opened and never closed');
    blocks.push(output.slice(open + SUBMISSION_OPEN.length, close));
    cursor = close + SUBMISSION_CLOSE.length;
  }
  demand(blocks.length > 0, 'no_result_submitted',
    'The step produced no structured result; free-form text is not a result');
  demand(blocks.length === 1, 'multiple_results_submitted',
    'A step submits exactly one result', { submissions: blocks.length });
  try {
    return JSON.parse(blocks[0]);
  } catch (error) {
    throw Object.assign(new Error(`Submission is not JSON: ${error.message}`), {
      name: 'FlowError',
      code: 'schema_invalid',
      details: {},
    });
  }
}

/**
 * The checks that run before anything moves.
 *
 * `env` supplies `actualChangedPaths()` and `resolveEvidence(locator)`. The
 * dispatch identities are passed in, not read from the result: a result that
 * asserted the identity it was checked against would be checking itself.
 */
export function validateSubmission(result, { dispatch, env }) {
  demand(RESULT_KINDS.includes(result.kind), 'schema_invalid', 'Unknown result kind', { kind: result.kind });
  demand(OUTCOMES.includes(result.outcome), 'schema_invalid', 'Unknown outcome', { outcome: result.outcome });
  // One guard, not two: a separate "is a non-empty string" check could never
  // fail on its own, because the comparison below rejects everything it would
  // have caught.
  demand(typeof result.attribution_echo === 'string' && result.attribution_echo === dispatch.attribution,
    'schema_invalid', 'The attribution echo is not the one the step was dispatched with');
  // A model that could name its own next step would be moving the task with
  // extra steps.
  demand(!Object.hasOwn(result, 'next_step') && !Object.hasOwn(result, 'transition'),
    'unknown_field', 'A result does not name the next step');

  demand(result.step_identity.anchor_digest === dispatch.anchor_digest, 'stale_anchor',
    'The anchor moved since the step was dispatched');
  demand(result.step_identity.runtime_identity_digest === dispatch.runtime_identity_digest,
    'stale_runtime_identity', 'The runtime identity moved since the step was dispatched');
  demand(result.step_identity.task_id === dispatch.task_id && result.step_identity.attempt === dispatch.attempt,
    'scope_mismatch', 'The result is for another step');

  if (result.claimed_changed_paths) {
    // A claim is not evidence of itself.
    const actual = new Set(env.actualChangedPaths());
    const claimed = new Set(result.claimed_changed_paths);
    const invented = [...claimed].filter((path) => !actual.has(path));
    const unclaimed = [...actual].filter((path) => !claimed.has(path));
    demand(invented.length === 0, 'scope_mismatch', 'A claimed path did not change', { paths: invented.slice(0, 8) });
    demand(unclaimed.length === 0, 'scope_mismatch', 'A path changed that the result did not claim',
      { paths: unclaimed.slice(0, 8) });
  }
  for (const entry of result.evidence ?? []) {
    demand(env.resolveEvidence(entry.locator), 'evidence_unresolved', 'An evidence reference does not resolve',
      { criterion: entry.criterion, locator: entry.locator });
  }
  if (result.kind === 'verification_batch') validateBatch(result, dispatch);
  return result;
}

/**
 * The batch keeps #24's taxonomy rather than inventing a second one.
 *
 * "The harness broke" and "the product is wrong" are different facts, and a
 * transition table that collapses them manufactures verdicts.
 */
export function validateBatch(result, dispatch) {
  const batch = result.batch;
  demand(Boolean(batch), 'schema_invalid', 'A verification batch result carries its batch');
  demand(batch.tool_outcome === 'ok' || result.outcome === 'tool_failure',
    'tool_failure_not_product_disposition', 'A tool failure is not a product disposition',
    { product_outcome: batch.product_outcome, outcome: result.outcome });
  demand(batch.environment_outcome === 'ok' || result.outcome === 'tool_failure',
    'tool_failure_not_product_disposition', 'An environment failure is not a product disposition');
  demand(batch.product_outcome !== 'indeterminate' || result.outcome === 'indeterminate',
    'tool_failure_not_product_disposition', 'An indeterminate batch is not a pass or a fail');
  if (result.outcome === 'pass' || result.outcome === 'fail') {
    // Missing any of the three means the batch did not demonstrate what it
    // claims.
    demand(Boolean(batch.application_proof), 'missing_application_proof',
      'The batch proves the mutation was applied');
    demand(Boolean(batch.green_control), 'missing_green_control',
      'The batch carries a green control on the unmutated candidate');
    demand(Boolean(batch.restore_receipt), 'missing_restore_receipt',
      'The batch carries a receipt that the candidate was restored');
  }
  demand(batch.harness_digest === dispatch.harness_digest, 'stale_harness_digest',
    'The harness digest is not the one the batch was dispatched with');
  demand(batch.mutation_set_digest === dispatch.mutation_set_digest, 'stale_harness_digest',
    'The mutation-set digest is not the one the batch was dispatched with');
  return batch;
}

/**
 * The transition the host selects. The model never names it.
 *
 * A tool failure and an indeterminate outcome route to their own transitions,
 * because collapsing them into `fail` would report a broken harness as a defect
 * in the product.
 */
export function selectTransition(result) {
  switch (result.outcome) {
    case 'ready_for_verification':
      return 'to_verification';
    case 'pass':
      return 'to_review';
    case 'fail':
      return 'to_fix';
    case 'blocked':
      return 'to_blocked';
    case 'needs_human':
      return 'to_human';
    case 'tool_failure':
      return 'to_tool_recovery';
    case 'indeterminate':
      return 'to_reverify';
    default:
      return demand(false, 'schema_invalid', 'Unknown outcome', { outcome: result.outcome });
  }
}

/**
 * What a role may do.
 *
 * Checked against the capability model rather than against a list written here,
 * so a role added to the model does not silently inherit whatever this file
 * happened to allow.
 */
export function toolsFor(capabilityModel, role) {
  const tools = capabilityModel.roles[role];
  demand(Array.isArray(tools), 'scope_mismatch', 'Unknown role', { role });
  for (const forbidden of capabilityModel.forbidden_for_every_role) {
    demand(!tools.includes(forbidden), 'scope_mismatch', 'A role was granted a forbidden tool',
      { role, tool: forbidden });
  }
  return immutable([...tools]);
}

/** Whether a role may call a tool at all. An unknown tool is not permitted by default. */
export function permits(capabilityModel, role, tool) {
  return toolsFor(capabilityModel, role).includes(tool);
}

/**
 * Applies a submission end to end.
 *
 * Returns the immutable record and the transition. A failure anywhere leaves
 * the task where it was: an invalid or missing result does not clear a blocker
 * and does not create a PASS, which is the difference between a system that
 * verifies and one that hopes.
 */
export function applySubmission(output, { dispatch, env, previousRecord }) {
  demand(!previousRecord, 'multiple_results_submitted', 'This step already submitted a result',
    { task_id: dispatch.task_id, attempt: dispatch.attempt });
  const result = parseSubmission(output);
  validateSubmission(result, { dispatch, env });
  const record = Object.freeze({
    ...result,
    recorded_at: new Date(env.nowMs()).toISOString(),
    record_digest: createHash('sha256').update(JSON.stringify(result), 'utf8').digest('hex'),
  });
  // Read back before the transition: a record nobody could read afterwards is
  // not a record.
  demand(env.readBack(record.record_digest), 'schema_invalid',
    'The result record could not be read back', { digest: record.record_digest });
  return { record, transition: selectTransition(result) };
}
