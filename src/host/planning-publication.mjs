/** The planning publication: the deterministic commit recipe and the CAS state machine (#5).
 *
 * Two things here are exact on purpose. The commit bytes are built from
 * structured fields and compared byte for byte, because a commit regenerated
 * from "latest configuration" after a crash is a different commit wearing the
 * same intent. And the CAS uses an exact expected-old value: no fetch-and-retry
 * against a new parent, no force update, no rebase, merge, cherry-pick or
 * branch-name inference.
 */
import { demand, immutable } from '../runtime/contracts.mjs';

/** The closed trailer set. Sorted by code point; the list order is not positional. */
export const TRAILERS = immutable([
  'Autosk-Anchor-Version',
  'Autosk-Epic-ID',
  'Autosk-Operation-ID',
  'Autosk-Payload-Kind',
  'Autosk-Project-Instruction-Digest',
  'Autosk-Project-Root-SHA256',
  'Autosk-Protocol-Digest',
  'Autosk-Runtime-Lock-Digest',
]);

/** Payload-specific trailers, added to the closed set by kind. */
export const ARTIFACT_TRAILERS = immutable(['Autosk-Artifact-Identity', 'Autosk-Verdict-Or-Waiver-Digest']);
export const INVALIDATION_TRAILERS = immutable(['Autosk-Impact-Digest', 'Autosk-Impact-Identity']);

export const SUBJECT = 'autosk-flow planning publication';

export const PHASES = immutable([
  'prepared',
  'commit_created',
  'ref_advanced',
  'verified',
  'voided_before_ref',
  'audit_retained',
]);

export const PARK_REASONS = immutable([
  'planning_ref_foreign_movement',
  'planning_publication_corrupt',
  'planning_candidate_keepalive_invalid',
  'planning_signing_unavailable',
]);

/**
 * The trailers a payload kind requires, sorted by Unicode code point.
 *
 * The sort rule alone determines the bytes, so two hosts that listed them in
 * different orders still produce one commit.
 */
export function trailerNamesFor(payloadKind) {
  const extra = payloadKind === 'anchor_invalidation' ? INVALIDATION_TRAILERS : ARTIFACT_TRAILERS;
  return [...TRAILERS, ...extra].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Duplicate, unknown and missing trailers are all invalid. */
export function trailerErrors(payloadKind, provided) {
  const expected = trailerNamesFor(payloadKind);
  const names = provided.map((entry) => entry.name);
  const errors = [];
  for (const name of expected) {
    if (!names.includes(name)) errors.push({ reason: 'planning_publication_corrupt', detail: `missing ${name}` });
  }
  for (const name of names) {
    if (!expected.includes(name)) errors.push({ reason: 'planning_publication_corrupt', detail: `unknown ${name}` });
  }
  if (new Set(names).size !== names.length) {
    errors.push({ reason: 'planning_publication_corrupt', detail: 'a trailer appears twice' });
  }
  return errors;
}

/**
 * The commit message: the fixed subject, one blank line, and the sorted trailers.
 *
 * No model-authored bytes enter it. The message is not a place to explain
 * anything, because anything explained there would be bytes nobody reviewed.
 */
export function commitMessage(payloadKind, values) {
  const names = trailerNamesFor(payloadKind);
  const lines = names.map((name) => {
    const value = values[name];
    demand(value !== undefined && value !== null && `${value}`.length > 0,
      'planning_publication_corrupt', 'A trailer has no value', { name });
    demand(!/[\r\n]/u.test(`${value}`), 'planning_publication_corrupt',
      'A trailer value contains a line break', { name });
    return `${name}=${value}`;
  });
  return `${SUBJECT}\n\n${lines.join('\n')}\n`;
}

/**
 * An actor identity Git will accept and a reader can attribute.
 *
 * CR, LF and the ident delimiters are refused because they would let a name
 * forge a second header line, and an email has exactly one `@` so an identity
 * cannot be two identities.
 */
export function actorErrors(actor) {
  const errors = [];
  for (const [field, value] of [['name', actor.name], ['email', actor.email]]) {
    if (typeof value !== 'string' || value.length === 0) {
      errors.push({ reason: 'planning_publication_corrupt', detail: `${field} is empty` });
      continue;
    }
    if (/[\r\n]/u.test(value)) {
      errors.push({ reason: 'planning_publication_corrupt', detail: `${field} contains a line break` });
    }
    if (/[<>]/u.test(value)) {
      errors.push({ reason: 'planning_publication_corrupt', detail: `${field} contains a Git ident delimiter` });
    }
  }
  if (typeof actor.email === 'string' && (actor.email.match(/@/gu) ?? []).length !== 1) {
    errors.push({ reason: 'planning_publication_corrupt', detail: 'email has more or fewer than one @' });
  }
  return errors;
}

/**
 * The recipe is checked before `prepared`, and never regenerated afterwards.
 *
 * No post-crash call may rebuild author data, timestamps, message text or
 * signatures from latest configuration: that would produce a different commit
 * under the same operation.
 */
export function recipeErrors(recipe) {
  const errors = [
    ...actorErrors(recipe.author),
    ...actorErrors(recipe.committer),
    ...trailerErrors(recipe.payload_kind, recipe.trailers),
  ];
  if (recipe.parents.length !== 1) {
    // The commit has no merge parent.
    errors.push({ reason: 'planning_publication_corrupt', detail: `${recipe.parents.length} parents` });
  } else if (recipe.parents[0] !== recipe.expected_planning_head) {
    errors.push({ reason: 'planning_publication_corrupt', detail: 'the parent is not the expected planning head' });
  }
  if (recipe.tree_oid !== recipe.candidate_tree_oid) {
    errors.push({ reason: 'planning_publication_corrupt', detail: 'the tree is not the candidate tree' });
  }
  if (recipe.signing_mode === 'exact' && !recipe.signature_header_base64) {
    // Parked before any PASS, operation, object or ref side effect: a signature
    // that cannot be replayed after a crash means the commit cannot be either.
    errors.push({ reason: 'planning_signing_unavailable', detail: 'signing is required and no exact header exists' });
  }
  if (recipe.signing_mode === 'none' && recipe.signature_header_base64) {
    errors.push({ reason: 'planning_publication_corrupt', detail: 'a signature header with signing mode none' });
  }
  if (recipe.commit_object_bytes_base64 === undefined) {
    errors.push({ reason: 'planning_publication_corrupt', detail: 'the exact commit bytes are not persisted' });
  }
  // A digest without the complete exact bytes is not a recovery record.
  if (recipe.expected_commit_oid && !recipe.commit_object_bytes_base64) {
    errors.push({ reason: 'planning_publication_corrupt', detail: 'an OID without the bytes it names' });
  }
  return errors;
}

/**
 * The publication state machine.
 *
 * `observation` carries `phase`, `ref` (`expected_parent` | `expected_commit` |
 * `other`), `reflog` (`checkpoint` | `one_new_matching` | `changed` |
 * `unknown`), `object` (`absent` | `matching` | `mismatch` | `pruned`),
 * `keepalive` (`exact` | `invalid` | `verified` | `released` | `audit_retained`)
 * and `binding` (`exact` | `drifted`).
 *
 * Returned actions are named after what they do, and every path that cannot be
 * accounted for parks rather than retrying: a retry against an unknown state is
 * how one uncertain outcome becomes two.
 */
export function publicationDecision(observation) {
  const { phase, ref, reflog, object, keepalive, binding } = observation;
  demand(PHASES.includes(phase), 'planning_publication_corrupt', 'Unknown phase', { phase });

  // A keepalive whose snapshot is missing, moved or mismatched stops everything
  // before any publication object or planning-ref side effect.
  if (keepalive === 'invalid' && ['prepared', 'commit_created', 'ref_advanced', 'verified'].includes(phase)) {
    return park('planning_candidate_keepalive_invalid');
  }

  // Foreign movement, including move-away-and-back: the ref being back where it
  // belongs is not evidence that nothing happened to it.
  if (ref === 'other' || reflog === 'unknown') return park('planning_ref_foreign_movement');
  if (ref === 'expected_parent' && reflog === 'changed') return park('planning_ref_foreign_movement');
  if (object === 'mismatch') return park('planning_publication_corrupt');

  if (binding === 'drifted' && (phase === 'prepared' || phase === 'commit_created') && ref === 'expected_parent') {
    // The binding moved before the ref did, so nothing has to be undone: the
    // operation is voided before any ref side effect and the anchor impact is
    // prepared instead.
    return Object.freeze({
      action: 'void_before_ref',
      phase: 'voided_before_ref',
      terminal_reason: 'binding_drift',
      recovery_target: 'prepare_anchor_impact',
    });
  }

  if (phase === 'prepared') {
    if (ref === 'expected_parent' && object === 'absent') {
      return Object.freeze({ action: 'write_commit_object', phase: 'commit_created' });
    }
    if (ref === 'expected_parent' && object === 'matching') {
      // The object survived a crash; verifying it is the whole remaining step.
      return Object.freeze({ action: 'verify_existing_object', phase: 'commit_created' });
    }
    if (ref === 'expected_commit' && reflog === 'one_new_matching') {
      // The CAS landed and the record did not: reconstruct the receipt after
      // verifying the commit, rather than moving the ref a second time.
      return Object.freeze({ action: 'reconstruct_cas_receipt', phase: 'ref_advanced' });
    }
  }

  if (phase === 'commit_created') {
    if (object === 'pruned' && ref === 'expected_parent' && reflog === 'checkpoint') {
      // Reconstruction, not a new logical commit: the same bytes, the same OID.
      return Object.freeze({ action: 'rewrite_exact_object', phase: 'commit_created' });
    }
    if (ref === 'expected_parent' && keepalive !== 'invalid' && reflog === 'checkpoint') {
      return Object.freeze({ action: 'cas_advance_ref', phase: 'ref_advanced' });
    }
    if (ref === 'expected_commit' && reflog === 'one_new_matching') {
      return Object.freeze({ action: 'reconstruct_cas_receipt', phase: 'ref_advanced' });
    }
  }

  if (phase === 'ref_advanced' && ref === 'expected_commit') {
    if (binding === 'drifted') {
      // Verified against the binding it ran under, then routed to the impact
      // rather than to any downstream dispatch.
      return Object.freeze({
        action: 'record_verified_against_recorded_binding',
        phase: 'verified',
        next_step: 'prepare_anchor_impact',
      });
    }
    return Object.freeze({ action: 'verify_and_record', phase: 'verified', next_step: 'select_next' });
  }

  if (phase === 'verified') {
    if (keepalive === 'verified') {
      // Audit-first transfer: the audit copy exists before the live one is
      // deleted, so no window has neither.
      return Object.freeze({ action: 'transfer_keepalive_to_audit', phase: 'verified' });
    }
    if (keepalive === 'released') {
      return Object.freeze({
        action: 'finalize_metadata_only',
        phase: 'verified',
        // Never another commit and never another ref movement.
        next_step: binding === 'drifted' ? 'prepare_anchor_impact' : 'select_next',
      });
    }
  }

  if (phase === 'voided_before_ref') {
    if (keepalive === 'verified') {
      return Object.freeze({ action: 'resume_audit_transfer', phase: 'voided_before_ref' });
    }
    if (keepalive === 'audit_retained') {
      return Object.freeze({
        action: 'archive_terminal_records',
        phase: 'audit_retained',
        next_step: 'prepare_anchor_impact',
      });
    }
  }

  // Anything this table cannot account for is indeterminate, and an
  // indeterminate observation is parked rather than retried.
  return park('planning_publication_corrupt');
}

function park(reason) {
  return Object.freeze({ action: 'park', park_reason: reason });
}

/** What the host records once a publication is verified. */
export function verifiedUpdates(operation) {
  return Object.freeze({
    'planning.head_oid': operation.expected_commit_oid,
    'planning.head_tree_oid': operation.candidate_tree_oid,
    'planning.generation': operation.generation + 1,
    'planning.last_verified_reflog_tail': operation.reflog_tail,
    'artifact_pass.publication_status': 'verified',
    'artifact_pass.published_commit_oid': operation.expected_commit_oid,
    'artifact_pass.publication_operation_id': operation.operation_id,
    current_artifact: null,
  });
}

/** A correction that arrives after the CAS is a new impact, not a rewind. */
export function lateCorrectionPlan() {
  return Object.freeze({
    action: 'complete_verification_then_new_impact',
    rewinds: false,
  });
}
