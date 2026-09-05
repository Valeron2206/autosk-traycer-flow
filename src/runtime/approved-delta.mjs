/** Exact approved deltas. No textual merge, hooks, filters, renormalization or ref writes. */
import { demand, assertOid, assertPath, closedRecord, compareCodePoints, digest, immutable, sameIdentity } from './contracts.mjs';

function value(entry) { return entry ? { mode: entry.mode, oid: entry.oid } : null; }
export function assertLiteralSelectors(selectors) {
  demand(Array.isArray(selectors) && selectors.length > 0 && selectors.length <= 1000, 'invalid_scope', 'A bounded nonempty scope is required');
  for (const selector of selectors) {
    closedRecord(selector, ['kind', 'path']); assertPath(selector.path);
    demand(['file', 'directory'].includes(selector.kind) && !/^:/u.test(selector.path) && !/[*?[]/u.test(selector.path),
      'invalid_scope', 'Only literal file/directory selectors are supported');
  }
}
export function inScope(name, selectors) {
  return selectors.some((selector) => selector.path === name
    || (selector.kind === 'directory' && name.startsWith(`${selector.path}/`)));
}
export function literalGitArguments(selectors) {
  assertLiteralSelectors(selectors);
  return Object.freeze(['--literal-pathspecs', '--', ...selectors.map((selector) => selector.path)]);
}
export function deriveApprovedDelta(git, baseOid, approvedOid, selectors) {
  assertOid(baseOid, git.objectFormat); assertOid(approvedOid, git.objectFormat); assertLiteralSelectors(selectors);
  const base = git.commit(baseOid); const approved = git.commit(approvedOid);
  demand(approved.parent_oids.length === 1 && approved.parent_oids[0] === baseOid,
    'approved_parent_mismatch', 'Approved commit must have the exact execution base as its sole parent');
  const before = new Map(git.readTree(base.tree_oid).map((entry) => [entry.path, entry]));
  const after = new Map(git.readTree(approved.tree_oid).map((entry) => [entry.path, entry]));
  const changes = [];
  for (const name of [...new Set([...before.keys(), ...after.keys()])].sort(compareCodePoints)) {
    const oldValue = value(before.get(name)); const newValue = value(after.get(name));
    if (sameIdentity(oldValue, newValue)) continue;
    demand(inScope(name, selectors), 'delta_out_of_scope', 'Approved commit changes an undeclared path', { path: name });
    demand(!name.split('/').some((segment) => ['.autosk', '.autosk-evidence', '.git'].includes(segment.toLowerCase())),
      'delta_protected_path', 'A Ticket cannot mutate host task/evidence storage');
    for (const item of [oldValue, newValue]) if (item && item.mode !== '160000') git.readObject('blob', item.oid);
    changes.push({ path: name, before: oldValue, after: newValue });
  }
  const body = immutable({ schema_version: 1, object_format: git.objectFormat,
    execution_base_oid: baseOid, base_tree_oid: base.tree_oid, approved_commit_oid: approvedOid,
    approved_tree_oid: approved.tree_oid, scope_selectors: selectors, changes });
  return immutable({ ...body, delta_digest: digest('autosk-flow/approved-delta/v1', body) });
}

/** Preimages must match exactly; even a plausible textual merge requires a new review. */
export function applyApprovedDelta(git, entries, delta) {
  const { delta_digest: claimed, ...body } = delta;
  demand(claimed === digest('autosk-flow/approved-delta/v1', body), 'delta_identity_mismatch', 'Delta digest mismatch');
  const result = new Map(entries.map((entry) => [entry.path, { ...entry }]));
  for (const change of delta.changes) {
    demand(sameIdentity(value(result.get(change.path)), change.before), 'delta_conflict',
      'Delta preimage mismatch; automatic semantic resolution is forbidden', { path: change.path });
    if (change.after === null) result.delete(change.path);
    else result.set(change.path, { path: change.path, ...change.after });
  }
  const output = [...result.values()].sort((a, b) => compareCodePoints(a.path, b.path));
  git.validateEntries(output);
  return immutable(output);
}
