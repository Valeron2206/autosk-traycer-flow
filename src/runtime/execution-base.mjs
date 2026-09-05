/** Dependency-aware composition shared by Ticket bases and private Epic staging. */
import { demand, closedRecord, assertDigest, assertOid, assertTicketId, digest, immutable, sha256 } from './contracts.mjs';
import { assertPublishedTickets, requireEvidence } from './published-tickets.mjs';
import { deriveApprovedDelta, applyApprovedDelta } from './approved-delta.mjs';

const plans = new WeakSet();
const APPROVAL_FIELDS = ['schema_version', 'ticket_id', 'ticket_entry_digest', 'publication_binding_digest',
  'execution_base_oid', 'approved_commit_oid', 'approved_tree_oid', 'delta_digest', 'review_verdict_digest',
  'verification_digest', 'recovery_target_digest'];
export function approvalBinding(published, ticketId, basePlan, approvedCommit, delta, evidence) {
  assertPublishedTickets(published); assertExecutionPlan(basePlan); assertTicketId(ticketId);
  demand(basePlan.identity.target_ticket_id === ticketId && basePlan.identity.publication_binding_digest === published.binding_digest,
    'approval_base_mismatch', 'Approval must use this Ticket and publication');
  closedRecord(evidence, ['review_verdict_digest', 'verification_digest']);
  assertDigest(evidence.review_verdict_digest); assertDigest(evidence.verification_digest);
  const entry = published.ticket_entry_digests.find((item) => item.ticket_id === ticketId);
  demand(entry, 'ticket_missing', 'Ticket is absent from published manifest');
  demand(approvedCommit.oid === delta.approved_commit_oid && approvedCommit.tree_oid === delta.approved_tree_oid
    && delta.execution_base_oid === basePlan.execution_base_oid, 'approval_delta_mismatch', 'Delta and approval identities differ');
  return immutable({ schema_version: 1, ticket_id: ticketId, ticket_entry_digest: entry.digest,
    publication_binding_digest: published.binding_digest, execution_base_oid: basePlan.execution_base_oid,
    approved_commit_oid: approvedCommit.oid, approved_tree_oid: approvedCommit.tree_oid,
    delta_digest: delta.delta_digest, ...evidence, recovery_target_digest: basePlan.recovery_target_digest });
}
export function assertExecutionPlan(plan) {
  demand(plan && plans.has(plan), 'execution_plan_untrusted', 'Recompute execution plans from current immutable inputs');
}
function closure(byId, ticketId, budget) {
  const seen = new Set(); const stack = [...byId.get(ticketId).depends_on];
  while (stack.length) {
    budget(); const id = stack.pop();
    demand(byId.has(id) && id !== ticketId, 'dag_invalid', 'Invalid published dependency graph');
    if (seen.has(id)) continue;
    seen.add(id); stack.push(...byId.get(id).depends_on);
  }
  return seen;
}

/** No task, worktree, ref or index is created here. authority is a trusted host port. */
export function prepareExecutionBase(git, published, targetTicketId, approvals, authority,
  { maxCompositionWork = 500_000 } = {}) {
  assertPublishedTickets(published);
  if (targetTicketId !== null) assertTicketId(targetTicketId);
  demand(Number.isSafeInteger(maxCompositionWork) && maxCompositionWork > 0 && maxCompositionWork <= 5_000_000,
    'invalid_limit', 'Invalid host composition budget');
  const currentProject = git.identity.repository_root;
  demand(sha256(Buffer.from(currentProject, 'utf8')) === published.binding.context.project_root_sha256,
    'project_identity_mismatch', 'Publication belongs to another project root');
  // Fresh authority check also rejects revoked approvals or a new anchor after handle mint.
  requireEvidence(authority, 'tickets_publication', published.binding);
  demand(git.toolDigest() === published.binding.git_tool_digest, 'git_binary_drift', 'Git tool identity changed');
  const { manifest, binding } = published;
  const byId = new Map(manifest.tickets.map((ticket) => [ticket.id, ticket]));
  demand(targetTicketId === null || byId.has(targetTicketId), 'ticket_missing', 'Target Ticket is not in the publication');
  demand(Array.isArray(approvals) && approvals.length <= manifest.tickets.length, 'approval_limit', 'Invalid approval inventory');
  const byApproval = new Map();
  for (const approval of approvals) {
    closedRecord(approval, APPROVAL_FIELDS); assertTicketId(approval.ticket_id);
    demand(approval.schema_version === 1 && byId.has(approval.ticket_id) && !byApproval.has(approval.ticket_id),
      'approval_invalid', 'Unknown, duplicate or unsupported approval');
    for (const key of APPROVAL_FIELDS.filter((field) => field.endsWith('digest'))) assertDigest(approval[key]);
    for (const key of ['execution_base_oid', 'approved_commit_oid', 'approved_tree_oid']) assertOid(approval[key], git.objectFormat);
    byApproval.set(approval.ticket_id, immutable(approval));
  }
  let work = 0;
  const budget = (amount = 1) => {
    work += amount; demand(work <= maxCompositionWork, 'composition_limit', 'Host composition work budget exhausted');
  };
  const closures = new Map();
  const dependencies = (id) => {
    if (!closures.has(id)) closures.set(id, closure(byId, id, budget));
    return closures.get(id);
  };
  const required = targetTicketId === null ? new Set(byId.keys()) : dependencies(targetTicketId);
  const order = manifest.topological_order.filter((id) => required.has(id));
  demand(order.length === required.size, 'dag_invalid', 'Published order does not cover dependency closure');
  const planning = git.commit(binding.publication_oid);
  demand(planning.tree_oid === binding.publication_tree_oid, 'planning_identity_mismatch', 'Planning commit/tree changed');
  const rootEntries = git.readTree(planning.tree_oid);
  const accepted = new Map();
  function compose(id, selectedOrder) {
    let entries = rootEntries;
    const predecessorBindings = [];
    for (const predecessor of selectedOrder) {
      budget(entries.length + 1);
      const acceptedPredecessor = accepted.get(predecessor);
      demand(acceptedPredecessor, 'predecessor_not_verified', 'A predecessor has no verified approval', { ticket_id: predecessor });
      entries = applyApprovedDelta(git, entries, acceptedPredecessor.delta);
      predecessorBindings.push(acceptedPredecessor.approval);
    }
    const target = id === null ? null : byId.get(id);
    const entryDigest = id === null ? null : published.ticket_entry_digests.find((entry) => entry.ticket_id === id)?.digest;
    const trees = selectedOrder.length ? git.treeRecipe(entries) : { tree_oid: planning.tree_oid, objects: [] };
    const identity = immutable({ schema_version: 1, kind: id === null ? 'epic_staging' : 'ticket_execution_base',
      object_format: git.objectFormat, context: binding.context, publication_binding_digest: published.binding_digest,
      planning_commit_oid: planning.oid, planning_tree_oid: planning.tree_oid,
      target_ticket_id: id, target_entry_digest: entryDigest, composition_order: selectedOrder,
      predecessors: predecessorBindings, result_tree_oid: trees.tree_oid, git_tool_digest: git.toolDigest() });
    const identityDigest = digest('autosk-flow/execution-base/v1', identity);
    const commit = selectedOrder.length ? git.commitRecipe(trees.tree_oid, planning.oid, identityDigest) : null;
    const baseOid = commit?.oid ?? planning.oid;
    const recovery = immutable({ schema_version: 1, context: binding.context,
      publication_binding_digest: published.binding_digest, ticket_id: id,
      frozen_recovery_target: target?.risk_and_rollback.recovery_target ?? null,
      execution_base_oid: baseOid, execution_base_tree_oid: trees.tree_oid });
    const plan = immutable({ identity, identity_digest: identityDigest, execution_base_oid: baseOid,
      tree_oid: trees.tree_oid, recovery_target: recovery,
      recovery_target_digest: digest('autosk-flow/resolved-recovery-target/v1', recovery),
      objects: [...trees.objects, ...(commit ? [commit] : [])] });
    plans.add(plan); return plan;
  }
  for (const id of order) {
    const expectedBase = compose(id, manifest.topological_order.filter((predecessor) => dependencies(id).has(predecessor)));
    const approval = byApproval.get(id);
    demand(approval, 'predecessor_not_verified', 'Approved predecessor is required', { ticket_id: id });
    demand(approval.publication_binding_digest === published.binding_digest
      && approval.execution_base_oid === expectedBase.execution_base_oid
      && approval.recovery_target_digest === expectedBase.recovery_target_digest,
    'predecessor_stale', 'Predecessor was approved against a different base, recovery target or publication', { ticket_id: id });
    const entry = published.ticket_entry_digests.find((item) => item.ticket_id === id);
    demand(entry.digest === approval.ticket_entry_digest, 'predecessor_stale', 'Predecessor Ticket contract changed');
    const delta = deriveApprovedDelta(git, approval.execution_base_oid, approval.approved_commit_oid, byId.get(id).scope_selectors);
    demand(delta.delta_digest === approval.delta_digest && delta.approved_tree_oid === approval.approved_tree_oid,
      'predecessor_stale', 'Approved commit/delta/tree identity mismatch');
    requireEvidence(authority, 'code_approval', approval);
    accepted.set(id, { approval, delta });
  }
  // Do not let an authority callback change repository handles mid-preparation.
  demand(git.identity.repository_root === currentProject, 'project_identity_mismatch', 'Repository handle changed');
  return compose(targetTicketId, order);
}

/** Object publication is idempotent but NOT retention or permission to dispatch. */
export function materializeExecutionObjects(git, plan) {
  assertExecutionPlan(plan);
  demand(git.toolDigest() === plan.identity.git_tool_digest, 'git_binary_drift', 'Plan tool identity changed');
  for (const object of plan.objects) git.writeObject(object);
  const commit = git.verifySnapshot(plan.execution_base_oid);
  demand(commit.tree_oid === plan.tree_oid, 'composition_corrupt', 'Read-back does not match the planned execution tree');
  return immutable({ schema_version: 1, identity_digest: plan.identity_digest,
    commit_oid: commit.oid, tree_oid: commit.tree_oid, recovery_target_digest: plan.recovery_target_digest,
    status: 'objects_verified_not_retained' });
}
