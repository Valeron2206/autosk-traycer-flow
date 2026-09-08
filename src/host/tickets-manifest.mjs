/** The Tickets manifest runtime: the path dialect, the DAG order and dispatch admission.
 *
 * Three things here are deliberately narrow. The selector dialect is literal
 * files and directory prefixes and nothing else, because a pattern is a
 * selector whose scope depends on what happens to be on disk. The topological
 * order is Kahn with ASCII tie-breaking, because "a valid order" is not an
 * order — two runs would schedule differently and the same Epic would build two
 * trees. And overlapping Tickets must be ordered, because two Tickets that can
 * address the same path and cannot be ordered will race.
 */
import { createHash } from 'node:crypto';

import { demand, immutable } from '../runtime/contracts.mjs';

export const SELECTOR_KINDS = immutable(['file', 'directory']);

export const DEPENDENCY_RATIONALES = immutable(['semantic', 'scope_serialization']);

export const ERROR_CODES = immutable([
  'tickets_selector_invalid',
  'tickets_selector_unsorted',
  'tickets_scope_overlap_unordered',
  'tickets_dependency_dangling',
  'tickets_dependency_self',
  'tickets_dependency_cyclic',
  'tickets_dependency_rationale_missing',
  'tickets_topological_order_invalid',
  'tickets_duplicate_id',
  'tickets_graph_mismatch',
]);

/**
 * Whether a selector path is one v1 accepts.
 *
 * Project-relative NFC with `/` separators. Everything rejected here is
 * rejected because it means something different somewhere else: an absolute
 * path escapes the project, a drive prefix means one thing on Windows and
 * another everywhere, a dot segment resolves at use rather than at validation,
 * and a glob byte turns a selector into a question about the filesystem.
 */
export function selectorPathErrors(path) {
  const errors = [];
  if (typeof path !== 'string' || path.length === 0) {
    return [{ code: 'tickets_selector_invalid', detail: 'empty path' }];
  }
  if (path !== path.normalize('NFC')) errors.push({ code: 'tickets_selector_invalid', detail: 'not NFC' });
  if (path.startsWith('/')) errors.push({ code: 'tickets_selector_invalid', detail: 'absolute path' });
  if (/^[A-Za-z]:/u.test(path) || path.startsWith('\\\\')) {
    errors.push({ code: 'tickets_selector_invalid', detail: 'drive or UNC prefix' });
  }
  if (path.includes('\\')) errors.push({ code: 'tickets_selector_invalid', detail: 'backslash separator' });
  if (path.includes('\0')) errors.push({ code: 'tickets_selector_invalid', detail: 'NUL byte' });
  if (path.includes('//')) errors.push({ code: 'tickets_selector_invalid', detail: 'repeated separator' });
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) {
    errors.push({ code: 'tickets_selector_invalid', detail: 'dot segment' });
  }
  if (path.startsWith(':')) {
    // Git magic such as `:(exclude)` is a pathspec, not a path.
    errors.push({ code: 'tickets_selector_invalid', detail: 'leading colon' });
  }
  for (const glob of ['*', '?', '[']) {
    if (path.includes(glob)) errors.push({ code: 'tickets_selector_invalid', detail: `glob byte ${glob}` });
  }
  return errors;
}

/** Selectors are sorted and unique, so two manifests with the same scope compare equal. */
export function selectorSetErrors(selectors) {
  const errors = [];
  for (const selector of selectors) {
    if (!SELECTOR_KINDS.includes(selector.kind)) {
      errors.push({ code: 'tickets_selector_invalid', detail: `unknown kind ${selector.kind}` });
    }
    errors.push(...selectorPathErrors(selector.path));
  }
  const keys = selectors.map((selector) => `${selector.kind}:${selector.path}`);
  const sorted = [...keys].sort();
  if (keys.join('\n') !== sorted.join('\n')) {
    errors.push({ code: 'tickets_selector_unsorted', detail: 'selectors are not sorted' });
  }
  if (new Set(keys).size !== keys.length) {
    errors.push({ code: 'tickets_selector_unsorted', detail: 'a selector appears twice' });
  }
  return errors;
}

/**
 * The conservative collision key.
 *
 * NFC and lowercase, so two paths whose bytes differ only by case are treated
 * as one file. On a case-insensitive filesystem they are, and a manifest that
 * assumed otherwise would schedule two Tickets onto the same file.
 */
export function collisionKey(path) {
  return path.normalize('NFC').toLowerCase();
}

/** Whether a selector can address a path. A directory includes descendants on segment boundaries. */
export function selectorAddresses(selector, path) {
  const key = collisionKey(path);
  const own = collisionKey(selector.path);
  if (selector.kind === 'file') return key === own;
  return key === own || key.startsWith(`${own}/`);
}

/** Whether two selectors can address the same path. */
export function selectorsOverlap(a, b) {
  const left = collisionKey(a.path);
  const right = collisionKey(b.path);
  if (a.kind === 'file' && b.kind === 'file') return left === right;
  if (a.kind === 'directory' && b.kind === 'directory') {
    return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  }
  const [dir, file] = a.kind === 'directory' ? [left, right] : [right, left];
  return file === dir || file.startsWith(`${dir}/`);
}

/** Kahn ordering with ASCII tie-breaking among ready nodes. */
export function kahnOrder(tickets) {
  const indegree = new Map(tickets.map((ticket) => [ticket.ticket_id, 0]));
  const children = new Map(tickets.map((ticket) => [ticket.ticket_id, []]));
  for (const ticket of tickets) {
    for (const parent of ticket.depends_on ?? []) {
      if (!indegree.has(parent)) continue;
      indegree.set(ticket.ticket_id, indegree.get(ticket.ticket_id) + 1);
      children.get(parent).push(ticket.ticket_id);
    }
  }
  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id).sort();
  const order = [];
  while (ready.length > 0) {
    // Sorted on every step: "a valid order" is not an order, and two runs that
    // scheduled differently would build the same Epic two ways.
    ready.sort();
    const id = ready.shift();
    order.push(id);
    for (const child of children.get(id) ?? []) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) ready.push(child);
    }
  }
  return order;
}

/**
 * The dependency graph's own validity.
 *
 * Every edge resolves inside this manifest, none is self-referential, the graph
 * is acyclic, and every edge carries a rationale — an edge with no stated
 * reason is a schedule constraint nobody can review.
 */
export function graphErrors(manifest) {
  const errors = [];
  const ids = manifest.tickets.map((ticket) => ticket.ticket_id);
  if (new Set(ids).size !== ids.length) {
    errors.push({ code: 'tickets_duplicate_id', detail: 'a Ticket id appears twice' });
  }
  const known = new Set(ids);
  for (const ticket of manifest.tickets) {
    for (const parent of ticket.depends_on ?? []) {
      if (parent === ticket.ticket_id) {
        errors.push({ code: 'tickets_dependency_self', detail: ticket.ticket_id });
        continue;
      }
      if (!known.has(parent)) {
        errors.push({ code: 'tickets_dependency_dangling', detail: `${ticket.ticket_id} -> ${parent}` });
        continue;
      }
      const rationale = (ticket.dependency_rationales ?? []).find((entry) => entry.depends_on === parent);
      if (!rationale || !DEPENDENCY_RATIONALES.includes(rationale.kind)) {
        errors.push({ code: 'tickets_dependency_rationale_missing', detail: `${ticket.ticket_id} -> ${parent}` });
      }
    }
  }
  const order = kahnOrder(manifest.tickets);
  if (order.length !== manifest.tickets.length) {
    errors.push({ code: 'tickets_dependency_cyclic', detail: 'the graph does not order' });
  } else if ((manifest.topological_order ?? []).join(',') !== order.join(',')) {
    errors.push({ code: 'tickets_topological_order_invalid', detail: order.join(',') });
  }
  return errors;
}

/** Whether `from` reaches `to` through dependencies, in either direction. */
export function comparable(manifest, a, b) {
  const byId = new Map(manifest.tickets.map((ticket) => [ticket.ticket_id, ticket]));
  const reaches = (from, to) => {
    const seen = new Set();
    const stack = [from];
    while (stack.length > 0) {
      const id = stack.pop();
      for (const parent of byId.get(id)?.depends_on ?? []) {
        if (parent === to) return true;
        if (seen.has(parent)) continue;
        seen.add(parent);
        stack.push(parent);
      }
    }
    return false;
  };
  return reaches(a, b) || reaches(b, a);
}

/**
 * Overlapping Tickets must be ordered by a transitive dependency in one direction.
 *
 * Two Tickets that can address the same path and cannot be ordered will race,
 * and the manifest is the last place that can say so before they both start.
 */
export function overlapErrors(manifest) {
  const errors = [];
  const tickets = manifest.tickets;
  for (let i = 0; i < tickets.length; i += 1) {
    for (let j = i + 1; j < tickets.length; j += 1) {
      const overlapping = (tickets[i].scope ?? []).some((left) =>
        (tickets[j].scope ?? []).some((right) => selectorsOverlap(left, right)),
      );
      if (!overlapping) continue;
      if (!comparable(manifest, tickets[i].ticket_id, tickets[j].ticket_id)) {
        errors.push({
          code: 'tickets_scope_overlap_unordered',
          detail: `${tickets[i].ticket_id} and ${tickets[j].ticket_id}`,
        });
      }
    }
  }
  return errors;
}

/** The manifest's identity: its content, not its formatting. */
export function manifestDigest(manifest) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        // Sorted by id: the order the tickets happen to be written in is
        // formatting, and `topological_order` — which is not sorted — carries
        // the ordering that actually means something.
        tickets: [...manifest.tickets]
          .sort((a, b) => (a.ticket_id < b.ticket_id ? -1 : a.ticket_id > b.ticket_id ? 1 : 0))
          .map((ticket) => ({
            ticket_id: ticket.ticket_id,
            depends_on: [...(ticket.depends_on ?? [])].sort(),
            scope: [...(ticket.scope ?? [])]
              .map((selector) => `${selector.kind}:${selector.path}`)
              .sort(),
          })),
        topological_order: manifest.topological_order,
      }),
      'utf8',
    )
    .digest('hex');
}

export function validateManifest(manifest) {
  const errors = [...graphErrors(manifest), ...overlapErrors(manifest)];
  for (const ticket of manifest.tickets) {
    errors.push(
      ...selectorSetErrors(ticket.scope ?? []).map((error) => ({
        ...error,
        detail: `${ticket.ticket_id}: ${error.detail}`,
      })),
    );
  }
  return errors;
}

/**
 * What the dispatcher compares before it creates anything.
 *
 * The actual child and edge set is compared with the expected graph before
 * enrollment, so a graph that drifted produces zero children rather than a
 * partially built one nobody planned.
 */
export function dispatchAdmission(manifest, observed, expectedDigest) {
  const errors = validateManifest(manifest);
  if (manifestDigest(manifest) !== expectedDigest) {
    errors.push({ code: 'tickets_graph_mismatch', detail: 'the manifest digest is not the dispatched one' });
  }
  const expectedChildren = manifest.topological_order.slice().sort().join(',');
  const observedChildren = [...(observed.children ?? [])].sort().join(',');
  if (expectedChildren !== observedChildren) {
    errors.push({ code: 'tickets_graph_mismatch', detail: 'the child set is not the expected one' });
  }
  const expectedEdges = manifest.tickets
    .flatMap((ticket) => (ticket.depends_on ?? []).map((parent) => `${parent}->${ticket.ticket_id}`))
    .sort()
    .join(',');
  const observedEdges = [...(observed.edges ?? [])].sort().join(',');
  if (expectedEdges !== observedEdges) {
    errors.push({ code: 'tickets_graph_mismatch', detail: 'the edge set is not the expected one' });
  }
  return Object.freeze({
    admitted: errors.length === 0,
    // Zero side effects on refusal: a partially built graph is worse than none.
    creates: errors.length === 0 ? immutable(manifest.topological_order.slice()) : immutable([]),
    errors: immutable(errors.map(Object.freeze)),
  });
}

/** Refuses a dispatch that is not admitted. */
export function assertDispatchable(manifest, observed, expectedDigest) {
  const outcome = dispatchAdmission(manifest, observed, expectedDigest);
  if (!outcome.admitted) {
    demand(false, outcome.errors[0].code, 'The manifest may not be dispatched',
      { errors: outcome.errors.map((error) => `${error.code}:${error.detail}`) });
  }
  return outcome;
}
