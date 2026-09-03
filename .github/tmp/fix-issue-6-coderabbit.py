#!/usr/bin/env python3
from pathlib import Path
import re
import textwrap

ROOT = Path(__file__).resolve().parents[2]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def regex_replace_once(text: str, pattern: str, replacement: str, label: str) -> str:
    compiled = re.compile(pattern, re.DOTALL)
    matches = list(compiled.finditer(text))
    if len(matches) != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {len(matches)}")
    return compiled.sub(lambda _: replacement, text, count=1)


validator_path = ROOT / "scripts/validate-tickets-manifest-design.mjs"
validator = validator_path.read_text()

validator = replace_once(
    validator,
    'export const RECEIPT_SCHEMA_PATH = path.join(ROOT, "resources/tickets-manifest/tickets-validation-receipt.schema.json");\n',
    'export const RECEIPT_SCHEMA_PATH = path.join(ROOT, "resources/tickets-manifest/tickets-validation-receipt.schema.json");\nexport const ABSOLUTE_MAX_MANIFEST_BYTES = 16_777_216;\n',
    "absolute manifest byte cap",
)

old_graph = r'''export function stableTopologicalOrder(tickets) {
  const ids = tickets.map((ticket) => ticket.id);
  const idSet = new Set(ids);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map(ids.map((id) => [id, []]));
  for (const ticket of tickets) {
    for (const dependency of ticket.depends_on ?? []) {
      if (!idSet.has(dependency) || !indegree.has(ticket.id)) continue;
      indegree.set(ticket.id, indegree.get(ticket.id) + 1);
      outgoing.get(dependency).push(ticket.id);
    }
  }
  for (const children of outgoing.values()) children.sort(compareCodePoints);
  const ready = ids.filter((id) => indegree.get(id) === 0).sort(compareCodePoints);
  const ordered = [];
  while (ready.length > 0) {
    const current = ready.shift();
    ordered.push(current);
    for (const child of outgoing.get(current)) {
      const next = indegree.get(child) - 1;
      indegree.set(child, next);
      if (next === 0) {
        ready.push(child);
        ready.sort(compareCodePoints);
      }
    }
  }
  return { ordered, cyclic: ordered.length !== ids.length, outgoing };
}

function reachable(outgoing, from, to) {
  const visited = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const child of outgoing.get(current) ?? []) {
      if (child === to) return true;
      if (!visited.has(child)) {
        visited.add(child);
        queue.push(child);
      }
    }
  }
  return false;
}
'''

new_graph = r'''class MinHeap {
  constructor(compare) {
    this.compare = compare;
    this.values = [];
  }

  get size() {
    return this.values.length;
  }

  push(value) {
    const values = this.values;
    values.push(value);
    let index = values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(values[parent], values[index]) <= 0) break;
      [values[parent], values[index]] = [values[index], values[parent]];
      index = parent;
    }
  }

  pop() {
    const values = this.values;
    if (values.length === 0) return undefined;
    const first = values[0];
    const last = values.pop();
    if (values.length > 0) {
      values[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < values.length && this.compare(values[left], values[smallest]) < 0) smallest = left;
        if (right < values.length && this.compare(values[right], values[smallest]) < 0) smallest = right;
        if (smallest === index) break;
        [values[index], values[smallest]] = [values[smallest], values[index]];
        index = smallest;
      }
    }
    return first;
  }
}

export function stableTopologicalOrder(tickets) {
  const ids = tickets.map((ticket) => ticket.id);
  const idSet = new Set(ids);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map(ids.map((id) => [id, []]));
  for (const ticket of tickets) {
    for (const dependency of ticket.depends_on ?? []) {
      if (!idSet.has(dependency) || !indegree.has(ticket.id)) continue;
      indegree.set(ticket.id, indegree.get(ticket.id) + 1);
      outgoing.get(dependency).push(ticket.id);
    }
  }
  const ready = new MinHeap(compareCodePoints);
  for (const id of ids) if (indegree.get(id) === 0) ready.push(id);
  const ordered = [];
  while (ready.size > 0) {
    const current = ready.pop();
    ordered.push(current);
    for (const child of outgoing.get(current)) {
      const next = indegree.get(child) - 1;
      indegree.set(child, next);
      if (next === 0) ready.push(child);
    }
  }
  return { ordered, cyclic: ordered.length !== ids.length, outgoing };
}

function reachable(outgoing, from, to) {
  const visited = new Set([from]);
  const queue = [from];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    for (const child of outgoing.get(current) ?? []) {
      if (child === to) return true;
      if (!visited.has(child)) {
        visited.add(child);
        queue.push(child);
      }
    }
  }
  return false;
}
'''
validator = replace_once(validator, old_graph, new_graph, "stable Kahn implementation")

validator = replace_once(
    validator,
    '''function oneLine(value) {\n  return String(value).replace(/\\s+/gu, " ").trim();\n}\n\nexport function renderTicketDocuments(manifest) {''',
    '''function oneLine(value) {\n  return String(value).replace(/\\s+/gu, " ").trim();\n}\n\nfunction ticketEntryPayload(ticket) {\n  const { lineage: _lineage, ...payload } = ticket;\n  return payload;\n}\n\nexport function ticketEntryDigest(ticket) {\n  return domainDigest("autosk-flow/ticket-entry/v1", canonicalStringify(ticketEntryPayload(ticket)));\n}\n\nexport function renderTicketDocuments(manifest) {''',
    "Ticket entry digest projection",
)

comparator = r'''
function normalizeDocumentBytes(value) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

function documentInventoryEntries(candidateDocuments) {
  if (candidateDocuments instanceof Map) return [...candidateDocuments.entries()];
  if (Array.isArray(candidateDocuments)) {
    return candidateDocuments.map((entry) => [entry?.path, entry?.bytes ?? entry?.content]);
  }
  if (candidateDocuments && typeof candidateDocuments === "object") return Object.entries(candidateDocuments);
  return null;
}

export function compareRenderedTicketDocuments(manifest, candidateDocuments) {
  const errors = [];
  const entries = documentInventoryEntries(candidateDocuments);
  if (!entries) {
    return [error("tickets_rendered_path_missing", "/rendered_documents", "candidate rendered document inventory is missing")];
  }

  const actual = new Map();
  for (const [index, entry] of entries.entries()) {
    const [documentPath, content] = entry;
    const pointer = `/rendered_documents/${index}`;
    if (typeof documentPath !== "string" || !validRelativePath(documentPath)) {
      errors.push(error("tickets_rendered_path_extra", pointer, "candidate rendered document path is invalid"));
      continue;
    }
    const bytes = normalizeDocumentBytes(content);
    if (!bytes) {
      errors.push(error("tickets_rendered_bytes_mismatch", pointer, "candidate rendered document bytes are invalid", { path: documentPath }));
      continue;
    }
    if (actual.has(documentPath)) {
      errors.push(error("tickets_rendered_path_extra", pointer, "candidate rendered document path is duplicated", { path: documentPath }));
      continue;
    }
    actual.set(documentPath, bytes);
  }

  const expected = renderTicketDocuments(manifest);
  const unmatchedActual = new Set(actual.keys());
  for (const [expectedPath, expectedText] of [...expected.entries()].sort(([left], [right]) => compareCodePoints(left, right))) {
    const pointer = `/rendered_documents/${escapePointer(expectedPath)}`;
    const expectedBytes = Buffer.from(expectedText, "utf8");
    if (actual.has(expectedPath)) {
      unmatchedActual.delete(expectedPath);
      if (!actual.get(expectedPath).equals(expectedBytes)) {
        errors.push(error("tickets_rendered_bytes_mismatch", pointer, "candidate rendered document bytes differ from pinned renderer output", {
          actual_sha256: sha256Bytes(actual.get(expectedPath)),
          expected_sha256: sha256Bytes(expectedBytes),
          path: expectedPath,
        }));
      }
      continue;
    }

    const renamed = [...unmatchedActual]
      .filter((candidatePath) => actual.get(candidatePath)?.equals(expectedBytes))
      .sort(compareCodePoints);
    if (renamed.length === 1) {
      unmatchedActual.delete(renamed[0]);
      errors.push(error("tickets_rendered_path_renamed", pointer, "renderer output exists under a different path", {
        actual_path: renamed[0],
        expected_path: expectedPath,
      }));
    } else {
      errors.push(error("tickets_rendered_path_missing", pointer, "expected renderer output is missing", { expected_path: expectedPath }));
    }
  }

  for (const extraPath of [...unmatchedActual].sort(compareCodePoints)) {
    errors.push(error("tickets_rendered_path_extra", `/rendered_documents/${escapePointer(extraPath)}`, "unexpected rendered document is present", {
      actual_path: extraPath,
    }));
  }
  return errors.sort(errorComparator);
}
'''
validator = replace_once(
    validator,
    '  return documents;\n}\n\nexport function ticketManifestDigests(manifest) {',
    '  return documents;\n}\n' + comparator + '\nexport function ticketManifestDigests(manifest) {',
    "rendered document comparator",
)

validator = replace_once(
    validator,
    '    digest: domainDigest("autosk-flow/ticket-entry/v1", canonicalStringify(ticket)),',
    '    digest: ticketEntryDigest(ticket),',
    "Ticket entry digest use",
)

helpers = r'''
function inputByteLength(value) {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.byteLength;
  return null;
}

function pushLimitError(errors, jsonPointer, limitName, actual, limit) {
  if (Number.isInteger(limit) && actual > limit) {
    errors.push(error("tickets_manifest_limits_exceeded", jsonPointer, `${limitName} exceeded`, {
      actual,
      limit,
      limit_name: limitName,
    }));
  }
}

function countLimitErrors(manifest) {
  const errors = [];
  const limits = manifest.policy?.limits ?? {};
  const tickets = Array.isArray(manifest.tickets) ? manifest.tickets : [];
  pushLimitError(errors, "/tickets", "max_tickets", tickets.length, limits.max_tickets);
  let totalEdges = 0;
  for (const [ticketIndex, ticket] of tickets.entries()) {
    const dependencies = Array.isArray(ticket?.depends_on) ? ticket.depends_on : [];
    const selectors = Array.isArray(ticket?.scope_selectors) ? ticket.scope_selectors : [];
    const criteria = Array.isArray(ticket?.acceptance_criteria) ? ticket.acceptance_criteria : [];
    totalEdges += dependencies.length;
    pushLimitError(errors, `/tickets/${ticketIndex}/depends_on`, "max_dependencies_per_ticket", dependencies.length, limits.max_dependencies_per_ticket);
    pushLimitError(errors, `/tickets/${ticketIndex}/scope_selectors`, "max_selectors_per_ticket", selectors.length, limits.max_selectors_per_ticket);
    pushLimitError(errors, `/tickets/${ticketIndex}/acceptance_criteria`, "max_acceptance_criteria_per_ticket", criteria.length, limits.max_acceptance_criteria_per_ticket);
    for (const [criterionIndex, criterion] of criteria.entries()) {
      const bindings = Array.isArray(criterion?.verification_bindings) ? criterion.verification_bindings : [];
      pushLimitError(
        errors,
        `/tickets/${ticketIndex}/acceptance_criteria/${criterionIndex}/verification_bindings`,
        "max_verification_bindings_per_criterion",
        bindings.length,
        limits.max_verification_bindings_per_criterion,
      );
    }
  }
  pushLimitError(errors, "/tickets", "max_total_edges", totalEdges, limits.max_total_edges);
  return errors.sort(errorComparator);
}

function canonicalText(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: true }).decode(value);
  return null;
}

function validateRevisionLineage(manifest, schema, context, errors) {
  const tickets = Array.isArray(manifest.tickets) ? manifest.tickets : [];
  if (manifest.previous_manifest_digest === null) {
    for (const [index, ticket] of tickets.entries()) {
      if (ticket?.lineage?.kind !== "new" || (ticket?.lineage?.predecessor_ids?.length ?? 0) !== 0) {
        errors.push(error("tickets_lineage_invalid", `/tickets/${index}/lineage`, "initial manifest Tickets must use new lineage without predecessors"));
      }
    }
    if ((manifest.retirements?.length ?? 0) > 0) {
      errors.push(error("tickets_lineage_invalid", "/retirements", "initial manifest cannot retire prior Tickets"));
    }
    return;
  }

  if (!context || typeof context !== "object") {
    errors.push(error("tickets_lineage_invalid", "/previous_manifest_digest", "revised manifest requires exact previous published manifest context"));
    return;
  }
  const previous = context.manifest;
  const previousRaw = canonicalText(context.raw_text);
  if (!previous || typeof previous !== "object" || Array.isArray(previous) || previousRaw === null) {
    errors.push(error("tickets_lineage_invalid", "/previous_manifest_digest", "previous manifest context is malformed"));
    return;
  }
  if (validateJsonSchema(previous, schema).length > 0 || canonicalStringify(previous) !== previousRaw) {
    errors.push(error("tickets_lineage_invalid", "/previous_manifest_digest", "previous manifest bytes are not the exact canonical published manifest"));
    return;
  }

  let previousDigests;
  try {
    previousDigests = ticketManifestDigests(previous);
  } catch (cause) {
    errors.push(error("tickets_lineage_invalid", "/previous_manifest_digest", "previous manifest identity cannot be recomputed", { cause: String(cause) }));
    return;
  }
  if (context.manifest_digest !== previousDigests.manifest_digest
      || canonicalStringify(context.ticket_entry_digests ?? []) !== canonicalStringify(previousDigests.ticket_entry_digests)) {
    errors.push(error("tickets_lineage_invalid", "/previous_manifest_digest", "previous manifest identity does not match exact prior bytes"));
  }
  if (manifest.previous_manifest_digest !== previousDigests.manifest_digest) {
    errors.push(error("tickets_lineage_invalid", "/previous_manifest_digest", "previous_manifest_digest does not identify the exact prior manifest", {
      actual: manifest.previous_manifest_digest,
      expected: previousDigests.manifest_digest,
    }));
  }
  if (manifest.epic_id !== previous.epic_id || manifest.object_format !== previous.object_format) {
    errors.push(error("tickets_lineage_invalid", "/previous_manifest_digest", "previous manifest belongs to a different Epic or object format"));
  }
  if (manifest.manifest_revision !== previous.manifest_revision + 1) {
    errors.push(error("tickets_lineage_invalid", "/manifest_revision", "manifest revision must increment the exact prior revision by one", {
      actual: manifest.manifest_revision,
      expected: previous.manifest_revision + 1,
    }));
  }

  const previousTickets = Array.isArray(previous.tickets) ? previous.tickets : [];
  const previousById = new Map(previousTickets.map((ticket) => [ticket.id, ticket]));
  const currentById = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const mappings = new Map(previousTickets.map((ticket) => [ticket.id, []]));

  for (const [index, ticket] of tickets.entries()) {
    const lineage = ticket?.lineage ?? {};
    const predecessors = Array.isArray(lineage.predecessor_ids) ? lineage.predecessor_ids : [];
    const pointer = `/tickets/${index}/lineage`;
    if (!sortedUnique(predecessors)) {
      errors.push(error("tickets_lineage_invalid", `${pointer}/predecessor_ids`, "predecessor IDs must be unique and sorted"));
    }
    if (lineage.kind === "new") {
      if (predecessors.length !== 0 || previousById.has(ticket.id)) {
        errors.push(error("tickets_lineage_invalid", pointer, "new lineage cannot reuse a prior Ticket or name predecessors"));
      }
      continue;
    }
    for (const predecessorId of predecessors) {
      if (!previousById.has(predecessorId)) {
        errors.push(error("tickets_lineage_invalid", `${pointer}/predecessor_ids`, "lineage predecessor is absent from the exact previous manifest", { predecessor_id: predecessorId }));
      } else {
        mappings.get(predecessorId).push({ current_id: ticket.id, kind: lineage.kind, pointer });
      }
    }
    const predecessor = predecessors.length === 1 ? previousById.get(predecessors[0]) : null;
    if (lineage.kind === "carry") {
      if (!predecessor || ticket.id !== predecessors[0] || ticketEntryDigest(ticket) !== ticketEntryDigest(predecessor)) {
        errors.push(error("tickets_lineage_invalid", pointer, "carry requires the same Ticket ID and byte-identical execution entry digest"));
      }
    } else if (lineage.kind === "revise") {
      if (!predecessor || ticket.id !== predecessors[0] || ticketEntryDigest(ticket) === ticketEntryDigest(predecessor)) {
        errors.push(error("tickets_lineage_invalid", pointer, "revise requires the same Ticket ID and a changed execution entry digest"));
      }
    } else if (lineage.kind === "replace" || lineage.kind === "split_child") {
      if (!predecessor || ticket.id === predecessors[0]) {
        errors.push(error("tickets_lineage_invalid", pointer, `${lineage.kind} requires one different predecessor Ticket ID`));
      }
    } else if (lineage.kind === "merge_result") {
      if (predecessors.length < 2 || predecessors.includes(ticket.id)) {
        errors.push(error("tickets_lineage_invalid", pointer, "merge_result requires at least two different predecessor IDs"));
      }
    }
  }

  const retirements = Array.isArray(manifest.retirements) ? manifest.retirements : [];
  const retirementIds = retirements.map((entry) => entry?.predecessor_id).filter((value) => typeof value === "string");
  if (!sortedUnique(retirementIds)) {
    errors.push(error("tickets_lineage_invalid", "/retirements", "retirements must have unique sorted predecessor IDs"));
  }
  const retirementById = new Map();
  for (const [index, retirement] of retirements.entries()) {
    const pointer = `/retirements/${index}`;
    if (!retirement || typeof retirement !== "object") continue;
    if (retirementById.has(retirement.predecessor_id)) {
      errors.push(error("tickets_lineage_invalid", `${pointer}/predecessor_id`, "duplicate retirement mapping"));
    } else {
      retirementById.set(retirement.predecessor_id, retirement);
    }
    if (!previousById.has(retirement.predecessor_id)) {
      errors.push(error("tickets_lineage_invalid", `${pointer}/predecessor_id`, "retirement predecessor is absent from the exact previous manifest"));
    }
    const successors = Array.isArray(retirement.successor_ids) ? retirement.successor_ids : [];
    if (!sortedUnique(successors)) {
      errors.push(error("tickets_lineage_invalid", `${pointer}/successor_ids`, "retirement successor IDs must be unique and sorted"));
    }
    for (const successorId of successors) {
      if (!currentById.has(successorId)) {
        errors.push(error("tickets_lineage_invalid", `${pointer}/successor_ids`, "retirement successor is absent from the current manifest", { successor_id: successorId }));
      }
    }
    if (["dropped", "deferred"].includes(retirement.disposition) && successors.length !== 0) {
      errors.push(error("tickets_lineage_invalid", pointer, `${retirement.disposition} retirement cannot name successors`));
    }
    if (retirement.disposition === "superseded" && successors.length === 0) {
      errors.push(error("tickets_lineage_invalid", pointer, "superseded retirement requires current successor IDs"));
    }
  }

  for (const previousTicket of previousTickets) {
    const entries = mappings.get(previousTicket.id) ?? [];
    const retirement = retirementById.get(previousTicket.id);
    const successorIds = [...new Set(entries.map((entry) => entry.current_id))].sort(compareCodePoints);
    if (entries.length === 0) {
      if (!retirement) {
        errors.push(error("tickets_lineage_invalid", "/retirements", "previous Ticket is silently dropped", { predecessor_id: previousTicket.id }));
      } else if (retirement.disposition === "superseded") {
        errors.push(error("tickets_lineage_invalid", "/retirements", "superseded retirement has no matching current lineage", { predecessor_id: previousTicket.id }));
      }
      continue;
    }

    const allSplit = entries.every((entry) => entry.kind === "split_child");
    if (entries.length > 1 && !allSplit) {
      errors.push(error("tickets_lineage_invalid", entries[1].pointer, "previous Ticket has ambiguous duplicate lineage mappings", {
        predecessor_id: previousTicket.id,
        successor_ids: successorIds,
      }));
    }
    if (allSplit && successorIds.length < 2) {
      errors.push(error("tickets_lineage_invalid", entries[0].pointer, "split_child requires at least two current successors", {
        predecessor_id: previousTicket.id,
      }));
    }
    if (retirement) {
      if (retirement.disposition !== "superseded"
          || canonicalStringify(retirement.successor_ids ?? []) !== canonicalStringify(successorIds)
          || entries.every((entry) => entry.kind === "carry" || entry.kind === "revise")) {
        errors.push(error("tickets_lineage_invalid", "/retirements", "retirement conflicts with current lineage mapping", {
          predecessor_id: previousTicket.id,
          successor_ids: successorIds,
        }));
      }
    }
  }
}
'''
validator = replace_once(
    validator,
    '\nexport function validateTicketsManifest(manifest, schema, rawText = null) {',
    '\n' + helpers + '\nexport function validateTicketsManifest(manifest, schema, rawText = null, options = {}) {',
    "limit and lineage helpers",
)

new_validate = r'''export function validateTicketsManifest(manifest, schema, rawText = null, options = {}) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [error("tickets_manifest_schema_invalid", "", "manifest root must be an object")];
  }

  const rawBytes = rawText === null ? Buffer.byteLength(canonicalStringify(manifest), "utf8") : inputByteLength(rawText);
  const declaredManifestLimit = manifest.policy?.limits?.max_manifest_bytes;
  if (rawBytes !== null && Number.isInteger(declaredManifestLimit) && rawBytes > declaredManifestLimit) {
    return [error("tickets_manifest_limits_exceeded", "", "max_manifest_bytes exceeded", {
      actual: rawBytes,
      limit: declaredManifestLimit,
      limit_name: "max_manifest_bytes",
    })];
  }

  for (const schemaError of validateJsonSchema(manifest, schema)) {
    errors.push(error("tickets_manifest_schema_invalid", "", String(schemaError)));
  }
  validateStringTree(manifest, "", errors);
  const rawTextValue = rawText === null ? null : canonicalText(rawText);
  if (rawText !== null && (rawTextValue === null || canonicalStringify(manifest) !== rawTextValue)) {
    errors.push(error("tickets_manifest_noncanonical", "", "manifest bytes do not equal canonical serialization"));
  }

  const countErrors = countLimitErrors(manifest);
  if (countErrors.length > 0) return [...errors, ...countErrors].sort(errorComparator);

  const tickets = Array.isArray(manifest.tickets) ? manifest.tickets : [];
  const ticketIds = tickets.map((ticket) => ticket?.id).filter((id) => typeof id === "string");
  if (!sortedUnique(ticketIds)) errors.push(error("tickets_id_duplicate", "/tickets", "Ticket IDs must be unique and sorted"));
  const idSet = new Set(ticketIds);
  const rootRefs = Array.isArray(manifest.governing_artifacts) ? manifest.governing_artifacts.map((entry) => entry.ref_id) : [];
  if (!sortedUnique(rootRefs)) errors.push(error("tickets_governing_ref_invalid", "/governing_artifacts", "governing refs must be unique and sorted"));
  const rootRefSet = new Set(rootRefs);
  const expectedOidLength = manifest.object_format === "sha256" ? 64 : 40;
  for (const [index, governing] of (manifest.governing_artifacts ?? []).entries()) {
    if (typeof governing?.published_commit_oid === "string" && governing.published_commit_oid.length !== expectedOidLength) {
      errors.push(error("tickets_governing_ref_invalid", `/governing_artifacts/${index}/published_commit_oid`, "OID length does not match object_format"));
    }
    if (!validRelativePath(governing?.path)) errors.push(error("tickets_path_invalid", `/governing_artifacts/${index}/path`, "invalid governing-artifact path"));
  }

  const documentCollisions = new Map();
  const acceptanceIds = new Set();
  for (const [index, ticket] of tickets.entries()) {
    const pointer = `/tickets/${index}`;
    if (!ticket || typeof ticket !== "object") continue;
    const dependencies = Array.isArray(ticket.depends_on) ? ticket.depends_on : [];
    if (!sortedUnique(dependencies)) errors.push(error("tickets_dependency_rationale_mismatch", `${pointer}/depends_on`, "dependencies must be unique and sorted"));
    for (const [dependencyIndex, dependency] of dependencies.entries()) {
      if (!idSet.has(dependency)) errors.push(error("tickets_dependency_missing", `${pointer}/depends_on/${dependencyIndex}`, `dependency ${dependency} does not exist`));
      if (dependency === ticket.id) errors.push(error("tickets_dependency_self", `${pointer}/depends_on/${dependencyIndex}`, "Ticket cannot depend on itself"));
    }
    const rationaleIds = Array.isArray(ticket.dependency_rationale) ? ticket.dependency_rationale.map((entry) => entry.dependency_id) : [];
    if (!sortedUnique(rationaleIds) || canonicalStringify(rationaleIds) !== canonicalStringify(dependencies)) {
      errors.push(error("tickets_dependency_rationale_mismatch", `${pointer}/dependency_rationale`, "rationale IDs must exactly match depends_on"));
    }

    if (!validRelativePath(ticket.document_path)) {
      errors.push(error("tickets_path_invalid", `${pointer}/document_path`, "invalid Ticket document path"));
    } else {
      const expectedPrefix = `docs/autosk/epics/${manifest.epic_id}/tickets/${ticket.id}-`;
      if (!ticket.document_path.startsWith(expectedPrefix) || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u.test(ticket.document_path.slice(expectedPrefix.length))) {
        errors.push(error("tickets_rendered_path_mismatch", `${pointer}/document_path`, "document path must be the deterministic Epic/Ticket path"));
      }
      const key = collisionKey(ticket.document_path);
      if (documentCollisions.has(key)) errors.push(error("tickets_path_collision", `${pointer}/document_path`, "document path collides under case/Unicode policy", { other: documentCollisions.get(key) }));
      else documentCollisions.set(key, ticket.document_path);
    }

    const selectors = Array.isArray(ticket.scope_selectors) ? ticket.scope_selectors : [];
    if (!sortedUnique(selectors, selectorComparator)) errors.push(error("tickets_path_invalid", `${pointer}/scope_selectors`, "selectors must be unique and sorted by path then kind"));
    const selectorKeys = new Set();
    for (const [selectorIndex, selector] of selectors.entries()) {
      if (!validRelativePath(selector?.path)) errors.push(error("tickets_path_invalid", `${pointer}/scope_selectors/${selectorIndex}/path`, "invalid scope path"));
      const key = selector?.path ? `${collisionKey(selector.path)}\0${selector.kind}` : `invalid-${selectorIndex}`;
      if (selectorKeys.has(key)) errors.push(error("tickets_path_collision", `${pointer}/scope_selectors/${selectorIndex}`, "duplicate/colliding selector"));
      selectorKeys.add(key);
    }

    const governingRefs = Array.isArray(ticket.governing_refs) ? ticket.governing_refs : [];
    if (!sortedUnique(governingRefs)) errors.push(error("tickets_governing_ref_invalid", `${pointer}/governing_refs`, "Ticket governing refs must be unique and sorted"));
    for (const [referenceIndex, reference] of governingRefs.entries()) {
      if (!rootRefSet.has(reference)) errors.push(error("tickets_governing_ref_invalid", `${pointer}/governing_refs/${referenceIndex}`, "governing ref is not declared at manifest root"));
    }
    if (!governingRefs.some((reference) => reference.startsWith("tech_plan:"))) {
      errors.push(error("tickets_governing_ref_invalid", `${pointer}/governing_refs`, "Planned Ticket must reference Tech Plan authority"));
    }
    if (ticket.review_policy_ref !== manifest.policy?.review_policy_ref) {
      errors.push(error("tickets_governing_ref_invalid", `${pointer}/review_policy_ref`, "Ticket review policy must equal the manifest review policy"));
    }

    const criteria = Array.isArray(ticket.acceptance_criteria) ? ticket.acceptance_criteria : [];
    for (const [criterionIndex, criterion] of criteria.entries()) {
      const criterionPointer = `${pointer}/acceptance_criteria/${criterionIndex}`;
      const expectedPrefix = `AC-${ticket.id}-`;
      if (typeof criterion?.id !== "string" || !criterion.id.startsWith(expectedPrefix)) {
        errors.push(error("tickets_acceptance_invalid", `${criterionPointer}/id`, "acceptance ID is outside the Ticket namespace"));
      } else if (acceptanceIds.has(criterion.id)) {
        errors.push(error("tickets_acceptance_invalid", `${criterionPointer}/id`, "acceptance ID is duplicated"));
      } else acceptanceIds.add(criterion.id);
      if (!Array.isArray(criterion?.verification_bindings) || criterion.verification_bindings.length === 0) {
        errors.push(error("tickets_verification_binding_invalid", `${criterionPointer}/verification_bindings`, "acceptance criterion has no verification binding"));
      }
      for (const [bindingIndex, binding] of (criterion?.verification_bindings ?? []).entries()) {
        if (binding.source_ref !== null && !rootRefSet.has(binding.source_ref)) {
          errors.push(error("tickets_verification_binding_invalid", `${criterionPointer}/verification_bindings/${bindingIndex}/source_ref`, "verification source ref is not declared"));
        }
        if (!sortedUnique(binding.expected_evidence ?? [])) {
          errors.push(error("tickets_verification_binding_invalid", `${criterionPointer}/verification_bindings/${bindingIndex}/expected_evidence`, "evidence classes must be unique and sorted"));
        }
      }
    }
  }

  let renderedDocuments = null;
  try {
    renderedDocuments = renderTicketDocuments(manifest);
  } catch (cause) {
    errors.push(error("tickets_rendered_bytes_mismatch", "/rendered_documents", "pinned renderer could not produce the document set", { cause: String(cause) }));
  }
  if (renderedDocuments) {
    const renderedLimit = manifest.policy?.limits?.max_rendered_document_bytes;
    const renderedLimitErrors = [];
    for (const [documentPath, content] of renderedDocuments.entries()) {
      pushLimitError(
        renderedLimitErrors,
        `/rendered_documents/${escapePointer(documentPath)}`,
        "max_rendered_document_bytes",
        Buffer.byteLength(content, "utf8"),
        renderedLimit,
      );
    }
    if (renderedLimitErrors.length > 0) return [...errors, ...renderedLimitErrors].sort(errorComparator);
    if (Object.prototype.hasOwnProperty.call(options, "candidateDocuments")) {
      errors.push(...compareRenderedTicketDocuments(manifest, options.candidateDocuments));
    }
  }

  const { ordered, cyclic, outgoing } = stableTopologicalOrder(tickets);
  if (cyclic) errors.push(error("tickets_dependency_cycle", "/tickets", "dependency graph contains a cycle"));
  if (canonicalStringify(ordered) !== canonicalStringify(manifest.topological_order ?? [])) {
    errors.push(error("tickets_topological_order_invalid", "/topological_order", "topological_order does not match stable Kahn order", { expected: ordered }));
  }

  for (let leftIndex = 0; leftIndex < tickets.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < tickets.length; rightIndex += 1) {
      const left = tickets[leftIndex];
      const right = tickets[rightIndex];
      const overlaps = (left.scope_selectors ?? []).some((a) => (right.scope_selectors ?? []).some((b) => selectorsOverlap(a, b)));
      if (!overlaps) continue;
      if (!reachable(outgoing, left.id, right.id) && !reachable(outgoing, right.id, left.id)) {
        errors.push(error("tickets_scope_overlap_unordered", `/tickets/${rightIndex}/scope_selectors`, "overlapping Tickets are not transitively ordered", { left: left.id, right: right.id }, [`/tickets/${leftIndex}/scope_selectors`]));
      }
    }
  }

  validateRevisionLineage(manifest, schema, options.previousManifestContext, errors);
  return errors.sort(errorComparator);
}
'''
validator = regex_replace_once(
    validator,
    r'export function validateTicketsManifest\(manifest, schema, rawText = null, options = \{\}\) \{.*?\n\}\n\nexport function parseTicketsManifest',
    new_validate + '\nexport function parseTicketsManifest',
    "validateTicketsManifest body",
)

new_parse = r'''export function parseTicketsManifest(input, options = {}) {
  const errors = [];
  let bytes;
  if (typeof input === "string") bytes = Buffer.from(input, "utf8");
  else if (Buffer.isBuffer(input) || input instanceof Uint8Array) bytes = Buffer.from(input);
  else return { manifest: null, text: null, errors: [error("tickets_manifest_json_invalid", "", "manifest input must be UTF-8 bytes or text")] };

  const requestedLimit = Number.isInteger(options.maxManifestBytes) ? options.maxManifestBytes : ABSOLUTE_MAX_MANIFEST_BYTES;
  const byteLimit = Math.min(Math.max(0, requestedLimit), ABSOLUTE_MAX_MANIFEST_BYTES);
  if (bytes.byteLength > byteLimit) {
    return {
      manifest: null,
      text: null,
      errors: [error("tickets_manifest_limits_exceeded", "", "raw manifest exceeds the pre-parse byte limit", {
        actual: bytes.byteLength,
        limit: byteLimit,
        limit_name: "max_manifest_bytes",
      })],
    };
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    return { manifest: null, text: null, errors: [error("tickets_manifest_noncanonical", "", "manifest is not valid UTF-8", { cause: String(cause) })] };
  }
  if (text.startsWith("\uFEFF")) errors.push(error("tickets_manifest_noncanonical", "", "UTF-8 BOM is forbidden"));
  if (text.includes("\r")) errors.push(error("tickets_manifest_noncanonical", "", "CR/CRLF is forbidden"));
  for (const duplicate of duplicateJsonKeys(text)) {
    errors.push(error("tickets_manifest_json_invalid", "", `duplicate JSON key ${duplicate.key}`, { offset: duplicate.offset }));
  }
  let manifest = null;
  try {
    manifest = JSON.parse(text);
  } catch (cause) {
    errors.push(error("tickets_manifest_json_invalid", "", "invalid JSON", { cause: String(cause) }));
  }
  return { manifest, text, errors: errors.sort(errorComparator) };
}
'''
validator = regex_replace_once(
    validator,
    r'export function parseTicketsManifest\(text\) \{.*?\n\}\n\nexport function loadTicketsManifestFiles',
    new_parse + '\nexport function loadTicketsManifestFiles',
    "pre-parse byte-bounded parser",
)

validator = replace_once(
    validator,
    '    errors.push(...validateTicketsManifest(parsed.manifest, schema, files["resources/tickets-manifest/tickets-manifest.example.json"])\n      .map((entry) => `manifest example ${entry.json_pointer || "/"}: ${entry.code}: ${entry.message}`));\n    const documents = renderTicketDocuments(parsed.manifest);',
    '    const documents = renderTicketDocuments(parsed.manifest);\n    errors.push(...validateTicketsManifest(\n      parsed.manifest,\n      schema,\n      files["resources/tickets-manifest/tickets-manifest.example.json"],\n      { candidateDocuments: documents },\n    ).map((entry) => `manifest example ${entry.json_pointer || "/"}: ${entry.code}: ${entry.message}`));',
    "design validation renderer integration",
)

validator_path.write_text(validator)

planning_validator_path = ROOT / "scripts/validate-planning-ref-design.mjs"
planning_validator = planning_validator_path.read_text()
planning_validator = replace_once(
    planning_validator,
    '''    if (schema.minLength !== undefined && Array.from(value).length < schema.minLength) {\n      errors.push(`${instancePath} must contain at least ${schema.minLength} characters`);\n    }\n    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {''',
    '''    if (schema.minLength !== undefined && Array.from(value).length < schema.minLength) {\n      errors.push(`${instancePath} must contain at least ${schema.minLength} characters`);\n    }\n    if (schema.maxLength !== undefined && Array.from(value).length > schema.maxLength) {\n      errors.push(`${instancePath} must contain at most ${schema.maxLength} characters`);\n    }\n    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {''',
    "shared JSON Schema maxLength support",
)
planning_validator_path.write_text(planning_validator)

contract_path = ROOT / "docs/contracts/tickets-manifest.md"
contract = contract_path.read_text()
contract = replace_once(
    contract,
    'each Ticket entry\nordered DAG adjacency',
    'each Ticket execution entry, excluding revision-only `lineage`\nordered DAG adjacency',
    "entry digest contract",
)
contract = replace_once(
    contract,
    'The root `topological_order` contains every Ticket exactly once and must equal iterative Kahn ordering with ASCII Ticket-ID tie-breaking among ready nodes. Validation is bounded `O(V+E)` and independent of worker count.',
    'The root `topological_order` contains every Ticket exactly once and must equal iterative Kahn ordering with ASCII Ticket-ID tie-breaking among ready nodes. Topological ordering uses a deterministic binary min-heap and is bounded `O((V+E) log V)` independently of worker count.',
    "Kahn complexity contract",
)
contract = replace_once(
    contract,
    'A new revision points to the exact previous published manifest digest. Ticket lineage is one of:',
    'A new revision receives the exact previous published canonical manifest bytes plus the prior validation identity (`manifest_digest` and ordered Ticket execution-entry digests), and `previous_manifest_digest` must match that context. Ticket lineage is one of:',
    "previous manifest context contract",
)
contract = replace_once(
    contract,
    'Predecessor IDs refer only to the immediately previous manifest. Every prior Ticket is accounted for by a current lineage entry or explicit retirement record. `carry` requires the same ID and byte-identical entry digest; no previous Ticket is silently dropped or ambiguously mapped.',
    'Predecessor IDs refer only to the immediately previous manifest. Every prior Ticket is accounted for by current lineage or an explicit retirement. `carry` requires the same ID and byte-identical execution-entry digest; `revise` keeps the ID and changes that digest; `replace` changes the ID; `split_child` maps one predecessor to at least two successors; `merge_result` maps at least two predecessors to one successor. Duplicate or mixed mappings fail closed. A matching `superseded` retirement may mirror replace/split/merge successors exactly; dropped/deferred retirements have no successors. No previous Ticket is silently dropped or ambiguously mapped.',
    "lineage semantics contract",
)
contract = replace_once(
    contract,
    'Resource limits bound manifest bytes, Tickets, edges, selectors, ACs, bindings and rendered bytes before expensive work. Very large valid sets preserve identical graph/digests with one or many workers.',
    'The host checks raw manifest bytes against an externally bound hard cap before UTF-8 decoding, duplicate-key scanning or JSON parsing, then rechecks the manifest-declared `max_manifest_bytes`. Resource limits also bound Tickets, total edges, dependencies per Ticket, selectors per Ticket, ACs per Ticket, bindings per AC and each generated Markdown document through `max_rendered_document_bytes` before graph/Panel work. Very large valid sets preserve identical graph/digests with one or many workers.',
    "resource limit contract",
)
contract_path.write_text(contract)

architecture_path = ROOT / "02-architecture.md"
architecture = architecture_path.read_text()
architecture = replace_once(
    architecture,
    'Перед Ticket Panel deterministic validator проверяет closed Schema, canonical bytes, stable Kahn DAG, path-scope overlap/order, governing/evidence refs, lineage/limits и byte-identical renderer output.',
    'Перед Ticket Panel deterministic validator проверяет closed Schema, raw/pre-parse и declared limits, canonical bytes, heap-backed stable Kahn DAG, path-scope overlap/order, governing/evidence refs, exact previous-manifest context для revision lineage и byte-identical renderer output.',
    "architecture validator summary",
)
architecture_path.write_text(architecture)

tech_path = ROOT / "03-technical-plan.md"
tech = tech_path.read_text()
tech = replace_once(
    tech,
    '| validate_tickets_manifest | canonical manifest, stable DAG/topological order, exact rendered document set and all controlling identities current | host computes manifest/DAG/document-set/Ticket-entry digests, writes/read-backs immutable `tickets_validation_receipt`, freeze_artifact |',
    '| validate_tickets_manifest | canonical manifest, all declared limits current, stable heap-backed DAG/topological order, exact rendered document set, exact previous published manifest context for revisions and all controlling identities current | host computes manifest/DAG/document-set/Ticket execution-entry digests, writes/read-backs immutable `tickets_validation_receipt`, freeze_artifact |',
    "technical transition success row",
)
tech_path.write_text(tech)

# Extend tests.
test_path = ROOT / "test/validate-tickets-manifest-design.test.mjs"
tests = test_path.read_text()
tests = replace_once(
    tests,
    '  canonicalStringify,\n  duplicateJsonKeys,',
    '  canonicalStringify,\n  compareRenderedTicketDocuments,\n  duplicateJsonKeys,',
    "test comparator import",
)
tests = replace_once(
    tests,
    '  ticketManifestDigests,\n  ticketsManifestDesignDigest,',
    '  ticketEntryDigest,\n  ticketManifestDigests,\n  ticketsManifestDesignDigest,',
    "test entry digest import",
)
tests = replace_once(
    tests,
    '''function codes(manifest, rawText = null) {\n  return validateTicketsManifest(manifest, schema, rawText).map((entry) => entry.code);\n}''',
    '''function codes(manifest, rawText = null, options = {}) {\n  return validateTicketsManifest(manifest, schema, rawText, options).map((entry) => entry.code);\n}''',
    "test codes options",
)
helper_tests = r'''
function previousManifestContext(previous) {
  const digests = ticketManifestDigests(previous);
  return {
    manifest: structuredClone(previous),
    raw_text: canonicalStringify(previous),
    manifest_digest: digests.manifest_digest,
    ticket_entry_digests: digests.ticket_entry_digests,
  };
}

function makeRevision(previous, tickets, retirements = []) {
  const manifest = structuredClone(previous);
  manifest.manifest_revision = previous.manifest_revision + 1;
  manifest.previous_manifest_digest = ticketManifestDigests(previous).manifest_digest;
  manifest.tickets = tickets;
  manifest.topological_order = stableTopologicalOrder(tickets).ordered;
  manifest.retirements = retirements;
  return manifest;
}

function oneTicketPrevious() {
  const previous = fixture();
  previous.tickets = [previous.tickets[0]];
  previous.topological_order = [previous.tickets[0].id];
  return previous;
}

function ticketWithId(source, id, slug) {
  const ticket = structuredClone(source);
  ticket.id = id;
  ticket.title = `${id} ${slug}`;
  ticket.goal = `Deliver ${slug}.`;
  ticket.document_path = `docs/autosk/epics/${example.epic_id}/tickets/${id}-${slug}.md`;
  ticket.depends_on = [];
  ticket.dependency_rationale = [];
  ticket.scope_selectors = [{ kind: "file", path: `src/${slug}.ts` }];
  ticket.acceptance_criteria = ticket.acceptance_criteria.map((criterion, index) => ({
    ...criterion,
    id: `AC-${id}-${String(index + 1).padStart(3, "0")}`,
  }));
  return ticket;
}
'''
tests = replace_once(
    tests,
    '''function sha256(value) {\n  return createHash("sha256").update(value).digest("hex");\n}\n''',
    '''function sha256(value) {\n  return createHash("sha256").update(value).digest("hex");\n}\n''' + helper_tests,
    "test lineage helpers",
)

new_tests = r'''

test("raw manifest bytes are rejected before UTF-8 decoding or JSON parsing", () => {
  const bytes = Buffer.from(exampleText, "utf8");
  const atLimit = parseTicketsManifest(bytes, { maxManifestBytes: bytes.length });
  assert.ok(atLimit.manifest);
  assert.deepEqual(atLimit.errors, []);

  const overLimit = parseTicketsManifest(bytes, { maxManifestBytes: bytes.length - 1 });
  assert.equal(overLimit.manifest, null);
  assert.deepEqual(overLimit.errors.map((entry) => entry.code), ["tickets_manifest_limits_exceeded"]);
});

test("every declared resource limit accepts the boundary and rejects one over", () => {
  const noLimitError = (manifest, raw = canonicalStringify(manifest)) =>
    assert.equal(codes(manifest, raw).includes("tickets_manifest_limits_exceeded"), false);
  const hasLimitError = (manifest, raw = canonicalStringify(manifest)) =>
    assert.ok(codes(manifest, raw).includes("tickets_manifest_limits_exceeded"));

  const manifestBytes = fixture();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const size = Buffer.byteLength(canonicalStringify(manifestBytes), "utf8");
    if (manifestBytes.policy.limits.max_manifest_bytes === size) break;
    manifestBytes.policy.limits.max_manifest_bytes = size;
  }
  assert.equal(Buffer.byteLength(canonicalStringify(manifestBytes), "utf8"), manifestBytes.policy.limits.max_manifest_bytes);
  noLimitError(manifestBytes);
  const manifestBytesOver = structuredClone(manifestBytes);
  manifestBytesOver.policy.limits.max_manifest_bytes -= 1;
  hasLimitError(manifestBytesOver);

  const ticketsAt = fixture();
  ticketsAt.policy.limits.max_tickets = ticketsAt.tickets.length;
  noLimitError(ticketsAt);
  const ticketsOver = structuredClone(ticketsAt);
  ticketsOver.policy.limits.max_tickets -= 1;
  hasLimitError(ticketsOver);

  const edgesAt = fixture();
  const edgeCount = edgesAt.tickets.reduce((sum, ticket) => sum + ticket.depends_on.length, 0);
  edgesAt.policy.limits.max_total_edges = edgeCount;
  noLimitError(edgesAt);
  const edgesOver = structuredClone(edgesAt);
  edgesOver.policy.limits.max_total_edges = edgeCount - 1;
  hasLimitError(edgesOver);

  const dependenciesAt = fixture();
  const maxDependencies = Math.max(...dependenciesAt.tickets.map((ticket) => ticket.depends_on.length));
  dependenciesAt.policy.limits.max_dependencies_per_ticket = maxDependencies;
  noLimitError(dependenciesAt);
  const dependenciesOver = structuredClone(dependenciesAt);
  dependenciesOver.policy.limits.max_dependencies_per_ticket = maxDependencies - 1;
  hasLimitError(dependenciesOver);

  const selectorsAt = fixture();
  const maxSelectors = Math.max(...selectorsAt.tickets.map((ticket) => ticket.scope_selectors.length));
  selectorsAt.policy.limits.max_selectors_per_ticket = maxSelectors;
  noLimitError(selectorsAt);
  const selectorsOver = structuredClone(selectorsAt);
  selectorsOver.policy.limits.max_selectors_per_ticket = maxSelectors - 1;
  hasLimitError(selectorsOver);

  const criteriaAt = fixture();
  const maxCriteria = Math.max(...criteriaAt.tickets.map((ticket) => ticket.acceptance_criteria.length));
  criteriaAt.policy.limits.max_acceptance_criteria_per_ticket = maxCriteria;
  noLimitError(criteriaAt);
  const criteriaOver = structuredClone(criteriaAt);
  const criterion = structuredClone(criteriaOver.tickets[0].acceptance_criteria[0]);
  criterion.id = "AC-T01-999";
  criteriaOver.tickets[0].acceptance_criteria.push(criterion);
  criteriaOver.policy.limits.max_acceptance_criteria_per_ticket = criteriaOver.tickets[0].acceptance_criteria.length - 1;
  hasLimitError(criteriaOver);

  const bindingsAt = fixture();
  const maxBindings = Math.max(...bindingsAt.tickets.flatMap((ticket) => ticket.acceptance_criteria.map((criterionEntry) => criterionEntry.verification_bindings.length)));
  bindingsAt.policy.limits.max_verification_bindings_per_criterion = maxBindings;
  noLimitError(bindingsAt);
  const bindingsOver = structuredClone(bindingsAt);
  const binding = structuredClone(bindingsOver.tickets[0].acceptance_criteria[0].verification_bindings[0]);
  binding.binding_id = "check:session-store-second";
  bindingsOver.tickets[0].acceptance_criteria[0].verification_bindings.push(binding);
  bindingsOver.policy.limits.max_verification_bindings_per_criterion = bindingsOver.tickets[0].acceptance_criteria[0].verification_bindings.length - 1;
  hasLimitError(bindingsOver);

  const renderedAt = fixture();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const size = Math.max(...[...renderTicketDocuments(renderedAt).values()].map((content) => Buffer.byteLength(content, "utf8")));
    if (renderedAt.policy.limits.max_rendered_document_bytes === size) break;
    renderedAt.policy.limits.max_rendered_document_bytes = size;
  }
  noLimitError(renderedAt);
  const renderedOver = structuredClone(renderedAt);
  renderedOver.policy.limits.max_rendered_document_bytes -= 1;
  hasLimitError(renderedOver);
});

test("candidate Markdown inventory rejects missing, extra, renamed and byte-drifted documents", () => {
  const expected = renderTicketDocuments(example);
  assert.deepEqual(compareRenderedTicketDocuments(example, expected), []);
  assert.deepEqual(validateTicketsManifest(example, schema, exampleText, { candidateDocuments: expected }), []);

  const firstPath = [...expected.keys()].sort()[0];
  const missing = new Map(expected);
  missing.delete(firstPath);
  assert.ok(compareRenderedTicketDocuments(example, missing).some((entry) => entry.code === "tickets_rendered_path_missing"));

  const extra = new Map(expected);
  extra.set(`docs/autosk/epics/${example.epic_id}/tickets/EXTRA.md`, "extra\n");
  assert.ok(compareRenderedTicketDocuments(example, extra).some((entry) => entry.code === "tickets_rendered_path_extra"));

  const renamed = new Map(expected);
  const bytes = renamed.get(firstPath);
  renamed.delete(firstPath);
  renamed.set(`${firstPath}.renamed`, bytes);
  assert.ok(compareRenderedTicketDocuments(example, renamed).some((entry) => entry.code === "tickets_rendered_path_renamed"));

  const drifted = new Map(expected);
  drifted.set(firstPath, `${drifted.get(firstPath)}x`);
  assert.ok(compareRenderedTicketDocuments(example, drifted).some((entry) => entry.code === "tickets_rendered_bytes_mismatch"));
});

test("revised manifest carry requires exact previous bytes, identity and unchanged execution entry", () => {
  const previous = fixture();
  const tickets = previous.tickets.map((ticket) => ({
    ...structuredClone(ticket),
    lineage: { kind: "carry", predecessor_ids: [ticket.id] },
  }));
  const current = makeRevision(previous, tickets);
  const context = previousManifestContext(previous);
  assert.equal(codes(current, canonicalStringify(current), { previousManifestContext: context }).includes("tickets_lineage_invalid"), false);
  assert.equal(ticketEntryDigest(current.tickets[0]), ticketEntryDigest(previous.tickets[0]));

  const changedCarry = structuredClone(current);
  changedCarry.tickets[0].goal = "Changed under carry.";
  assert.ok(codes(changedCarry, canonicalStringify(changedCarry), { previousManifestContext: context }).includes("tickets_lineage_invalid"));

  const wrongIdentity = structuredClone(context);
  wrongIdentity.manifest_digest = "0".repeat(64);
  assert.ok(codes(current, canonicalStringify(current), { previousManifestContext: wrongIdentity }).includes("tickets_lineage_invalid"));
});

test("revision lineage accepts revise, replace, split_child, merge_result and explicit retirement", () => {
  const previousForRevise = fixture();
  const revisedTickets = previousForRevise.tickets.map((ticket) => ({
    ...structuredClone(ticket),
    lineage: { kind: "carry", predecessor_ids: [ticket.id] },
  }));
  revisedTickets[0].goal = "Revised goal.";
  revisedTickets[0].lineage = { kind: "revise", predecessor_ids: ["T01"] };
  const revised = makeRevision(previousForRevise, revisedTickets);
  assert.equal(codes(revised, canonicalStringify(revised), { previousManifestContext: previousManifestContext(previousForRevise) }).includes("tickets_lineage_invalid"), false);

  const previousForReplace = oneTicketPrevious();
  const replacement = ticketWithId(previousForReplace.tickets[0], "T02", "replacement");
  replacement.lineage = { kind: "replace", predecessor_ids: ["T01"] };
  const replaced = makeRevision(previousForReplace, [replacement]);
  assert.equal(codes(replaced, canonicalStringify(replaced), { previousManifestContext: previousManifestContext(previousForReplace) }).includes("tickets_lineage_invalid"), false);

  const previousForSplit = oneTicketPrevious();
  const splitA = ticketWithId(previousForSplit.tickets[0], "T02", "split-a");
  const splitB = ticketWithId(previousForSplit.tickets[0], "T03", "split-b");
  splitA.lineage = { kind: "split_child", predecessor_ids: ["T01"] };
  splitB.lineage = { kind: "split_child", predecessor_ids: ["T01"] };
  const split = makeRevision(previousForSplit, [splitA, splitB]);
  assert.equal(codes(split, canonicalStringify(split), { previousManifestContext: previousManifestContext(previousForSplit) }).includes("tickets_lineage_invalid"), false);

  const previousForMerge = fixture();
  const mergedTicket = ticketWithId(previousForMerge.tickets[0], "T03", "merged");
  mergedTicket.lineage = { kind: "merge_result", predecessor_ids: ["T01", "T02"] };
  const merged = makeRevision(previousForMerge, [mergedTicket]);
  assert.equal(codes(merged, canonicalStringify(merged), { previousManifestContext: previousManifestContext(previousForMerge) }).includes("tickets_lineage_invalid"), false);

  const previousForRetirement = fixture();
  const carried = structuredClone(previousForRetirement.tickets[0]);
  carried.lineage = { kind: "carry", predecessor_ids: ["T01"] };
  const retired = makeRevision(previousForRetirement, [carried], [{
    decision_ref: "decision:drop-t02",
    disposition: "dropped",
    predecessor_id: "T02",
    rationale: "T02 is intentionally removed from the next revision.",
    successor_ids: [],
  }]);
  assert.equal(codes(retired, canonicalStringify(retired), { previousManifestContext: previousManifestContext(previousForRetirement) }).includes("tickets_lineage_invalid"), false);
});

test("revision lineage rejects missing predecessors, duplicate mappings and silently dropped prior Tickets", () => {
  const previous = oneTicketPrevious();
  const missingPredecessor = ticketWithId(previous.tickets[0], "T02", "missing-predecessor");
  missingPredecessor.lineage = { kind: "replace", predecessor_ids: ["T99"] };
  const missing = makeRevision(previous, [missingPredecessor]);
  assert.ok(codes(missing, canonicalStringify(missing), { previousManifestContext: previousManifestContext(previous) }).includes("tickets_lineage_invalid"));

  const duplicateA = ticketWithId(previous.tickets[0], "T02", "duplicate-a");
  const duplicateB = ticketWithId(previous.tickets[0], "T03", "duplicate-b");
  duplicateA.lineage = { kind: "replace", predecessor_ids: ["T01"] };
  duplicateB.lineage = { kind: "replace", predecessor_ids: ["T01"] };
  const duplicate = makeRevision(previous, [duplicateA, duplicateB]);
  assert.ok(codes(duplicate, canonicalStringify(duplicate), { previousManifestContext: previousManifestContext(previous) }).includes("tickets_lineage_invalid"));

  const twoPrevious = fixture();
  const carryOnly = structuredClone(twoPrevious.tickets[0]);
  carryOnly.lineage = { kind: "carry", predecessor_ids: ["T01"] };
  const silentlyDropped = makeRevision(twoPrevious, [carryOnly]);
  assert.ok(codes(silentlyDropped, canonicalStringify(silentlyDropped), { previousManifestContext: previousManifestContext(twoPrevious) }).includes("tickets_lineage_invalid"));
});

test("heap-backed stable Kahn ordering preserves deterministic order on a large ready set", () => {
  const tickets = Array.from({ length: 5000 }, (_, index) => ({
    id: `T${String(index + 1).padStart(6, "0")}`,
    depends_on: [],
  })).reverse();
  const result = stableTopologicalOrder(tickets);
  assert.equal(result.cyclic, false);
  assert.equal(result.ordered.length, tickets.length);
  assert.equal(result.ordered[0], "T000001");
  assert.equal(result.ordered.at(-1), "T005000");
});

test("shared JSON Schema validation enforces maxLength", () => {
  const manifest = fixture();
  manifest.tickets[0].title = "x".repeat(8193);
  assert.ok(validateJsonSchema(manifest, schema).some((entry) => entry.includes("at most 8192")));
});
'''
tests += new_tests

test_path.write_text(tests)

print("Applied all four blocking CodeRabbit fixes and strengthened schema parity.")
