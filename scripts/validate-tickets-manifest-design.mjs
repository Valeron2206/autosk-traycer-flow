#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readFileSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const GIT_EXECUTABLE = process.platform === "win32" ? "C:\\Program Files\\Git\\cmd\\git.exe" : "/usr/bin/git";
export const MANIFEST_SCHEMA_PATH = path.join(ROOT, "resources/tickets-manifest/tickets-manifest.schema.json");
export const MANIFEST_EXAMPLE_PATH = path.join(ROOT, "resources/tickets-manifest/tickets-manifest.example.json");
export const RECEIPT_SCHEMA_PATH = path.join(ROOT, "resources/tickets-manifest/tickets-validation-receipt.schema.json");
export const RENDERER_DISTRIBUTION_FILES = Object.freeze([
  "scripts/validate-tickets-manifest-design.mjs",
]);
export const VALIDATOR_DISTRIBUTION_FILES = Object.freeze([
  "scripts/validate-planning-ref-design.mjs",
  "scripts/validate-tickets-manifest-design.mjs",
]);
export const ABSOLUTE_MAX_MANIFEST_BYTES = 16_777_216;
export const ABSOLUTE_MAX_RENDERED_DOCUMENT_BYTES = 67_108_864;
export const ABSOLUTE_MAX_TOTAL_RENDERED_DOCUMENT_BYTES = 134_217_728;
export const ABSOLUTE_MAX_RENDERED_DOCUMENT_ENTRIES = 10_002;
export const ABSOLUTE_MAX_JSON_DEPTH = 64;
export const ABSOLUTE_MAX_SCOPE_OVERLAP_PAIRS = 1_000_000;
export const RENDERER_HEADER = "<!-- generated-by: autosk-flow/ticket-markdown/v1 -->";
export const TICKETS_RECEIPT_BINDING_FIELDS = Object.freeze([
  "alignment_identity",
  "anchor_version",
  "candidate_tree_oid",
  "canonicalizer_version",
  "dag_digest",
  "epic_id",
  "governance_mapping_set_digest",
  "limits_digest",
  "manifest_bytes_sha256",
  "manifest_digest",
  "manifest_path",
  "object_format",
  "planning_parent_commit_oid",
  "planning_parent_tree_oid",
  "project_instruction_digest",
  "project_root_sha256",
  "protocol_digest",
  "record_kind",
  "rendered_document_set_digest",
  "rendered_documents",
  "renderer_distribution_digest",
  "renderer_version",
  "runtime_lock_digest",
  "schema_id",
  "schema_sha256",
  "ticket_entry_digests",
  "ticket_set_digest",
  "validator_distribution_digest",
]);
export const EXAMPLE_CANDIDATE_ROOT_RELATIVE = "resources/tickets-manifest/example-candidate";
export const EXAMPLE_CANDIDATE_ROOT = path.join(ROOT, EXAMPLE_CANDIDATE_ROOT_RELATIVE);
export const EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH = "docs/autosk/epics/11111111-1111-4111-8111-111111111111/tickets/tickets.manifest.json";
export const EXAMPLE_CANDIDATE_CONTRACT_FILES = Object.freeze([
  `${EXAMPLE_CANDIDATE_ROOT_RELATIVE}/${EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH}`,
  `${EXAMPLE_CANDIDATE_ROOT_RELATIVE}/docs/autosk/epics/11111111-1111-4111-8111-111111111111/tickets/README.md`,
  `${EXAMPLE_CANDIDATE_ROOT_RELATIVE}/docs/autosk/epics/11111111-1111-4111-8111-111111111111/tickets/T01-session-store.md`,
  `${EXAMPLE_CANDIDATE_ROOT_RELATIVE}/docs/autosk/epics/11111111-1111-4111-8111-111111111111/tickets/T02-session-api.md`,
]);

export const CONTRACT_FILES = Object.freeze([
  "README.md",
  "01-core-flows.md",
  "02-architecture.md",
  "03-technical-plan.md",
  "04-decisions.md",
  "CONTRIBUTING.md",
  "docs/contracts/tickets-manifest.md",
  "resources/tickets-manifest/tickets-manifest.schema.json",
  "resources/tickets-manifest/tickets-manifest.example.json",
  "resources/tickets-manifest/tickets-validation-receipt.schema.json",
  "package.json",
  ".github/workflows/validate-traycer-parity.yml",
  ...EXAMPLE_CANDIDATE_CONTRACT_FILES,
]);

const REQUIRED_MARKERS = Object.freeze({
  "README.md": ["docs/contracts/tickets-manifest.md", "tickets.manifest.json", "npm run validate:tickets-manifest"],
  "01-core-flows.md": ["<!-- tickets-manifest-contract:v1 -->", "tickets.manifest.json", "TicketsValidationReceipt"],
  "02-architecture.md": ["<!-- tickets-manifest-contract:v1 -->", "Canonical Tickets manifest", "manifest-only dispatcher"],
  "03-technical-plan.md": [
    "<!-- tickets-manifest-contract:v1 -->",
    "validate_tickets_manifest",
    "tickets_validation_receipt",
    "schema-valid `record_kind=pending_validation_proof` with `candidate_tree_oid=null`",
    "`validateTicketsCandidateGitTree` reads blobs directly from the immutable minted Git tree OID",
    "`tickets_validation_receipt.candidate_tree_oid` equals that exact tree",
    "tickets_manifest_invalid",
    "tickets_manifest_stale",
  ],
  "04-decisions.md": ["ADR-027: canonical machine-readable Tickets manifest", "tickets.manifest.json"],
  "CONTRIBUTING.md": ["docs/contracts/tickets-manifest.md", "npm run validate:tickets-manifest"],
  "docs/contracts/tickets-manifest.md": [
    "<!-- tickets-manifest-contract:v1 -->",
    "autosk-flow/canonical-json/v1",
    "autosk-flow/ticket-limits/v1",
    "autosk-flow/ticket-renderer-distribution/v1",
    "autosk-flow/ticket-validator-distribution/v1",
    "TicketsValidationReceipt",
    "whose `candidate_tree_oid` equals that frozen tree",
    "`validateTicketsCandidateGitTree` re-reads blobs directly from the exact frozen Git tree OID",
    "tickets_scope_overlap_unordered",
    "dispatch_ticket_dag",
    "Issue #5",
    "Issue #7",
    "Issue #8",
    "Issue #9",
    "Issue #18",
    "Issue #23",
    "issue #24",
    "issue #25",
  ],
  "package.json": ["validate:tickets-manifest"],
  ".github/workflows/validate-traycer-parity.yml": ["npm run validate:tickets-manifest"],
});

function compareCodePoints(left, right) {
  const a = Array.from(left, (character) => character.codePointAt(0));
  const b = Array.from(right, (character) => character.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

export function canonicalStringify(value) {
  return `${canonicalSerialize(value)}\n`;
}

function canonicalSerialize(value, depth = 0, active = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("unsupported JSON value");
    return encoded;
  }
  if (Array.isArray(value)) {
    if (active.has(value)) throw new TypeError("cyclic JSON value");
    if (value.length === 0) return "[]";
    active.add(value);
    const itemIndent = " ".repeat((depth + 1) * 2);
    const closingIndent = " ".repeat(depth * 2);
    const items = value.map((item) => `${itemIndent}${canonicalSerialize(item, depth + 1, active)}`);
    active.delete(value);
    return `[\n${items.join(",\n")}\n${closingIndent}]`;
  }
  if (value && typeof value === "object") {
    if (active.has(value)) throw new TypeError("cyclic JSON value");
    const keys = Object.keys(value).sort(compareCodePoints);
    if (keys.length === 0) return "{}";
    active.add(value);
    const itemIndent = " ".repeat((depth + 1) * 2);
    const closingIndent = " ".repeat(depth * 2);
    const items = keys.map((key) => `${itemIndent}${JSON.stringify(key)}: ${canonicalSerialize(value[key], depth + 1, active)}`);
    active.delete(value);
    return `{\n${items.join(",\n")}\n${closingIndent}}`;
  }
  throw new TypeError("unsupported JSON value");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function domainDigest(domain, ...parts) {
  const hash = createHash("sha256");
  hash.update(domain, "utf8");
  hash.update(Buffer.from([0]));
  for (let index = 0; index < parts.length; index += 1) {
    if (index > 0) hash.update(Buffer.from([0]));
    hash.update(parts[index], "utf8");
  }
  return hash.digest("hex");
}

function decodeJsonString(raw) {
  return JSON.parse(raw);
}

function rawJsonDepthError(text, maxDepth) {
  let depth = 0;
  let escaped = false;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      if (depth > maxDepth) {
        return error("tickets_manifest_limits_exceeded", "", "max_json_depth exceeded before JSON parsing", {
          actual: depth,
          limit: maxDepth,
          limit_name: "max_json_depth",
        });
      }
    } else if (character === "}" || character === "]") {
      depth = Math.max(0, depth - 1);
    }
  }
  return null;
}

export function duplicateJsonKeys(text) {
  const duplicates = [];
  const stack = [];
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (character === '"') {
      const start = index;
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      let cursor = index;
      while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
      const current = stack.at(-1);
      if (text[cursor] === ":" && current?.kind === "object") {
        let key;
        try {
          key = decodeJsonString(text.slice(start, index));
        } catch {
          continue;
        }
        const pointer = `${current.path}/${escapePointer(key)}`;
        if (current.keys.has(key)) duplicates.push({ key, offset: start, pointer });
        else current.keys.add(key);
        current.pendingPath = pointer;
        index = cursor + 1;
        continue;
      }
      beginJsonValue(stack);
      continue;
    }
    if (character === "{") stack.push({ kind: "object", keys: new Set(), path: beginJsonValue(stack), pendingPath: null });
    else if (character === "[") stack.push({ kind: "array", path: beginJsonValue(stack), nextIndex: 0 });
    else if (character === "}" || character === "]") stack.pop();
    else if (!/\s|,|:/u.test(character)) {
      beginJsonValue(stack);
      while (index < text.length && !/[\s,\]}]/u.test(text[index])) index += 1;
      continue;
    }
    index += 1;
  }
  return duplicates;
}

function beginJsonValue(stack) {
  const current = stack.at(-1);
  if (!current) return "";
  if (current.kind === "object") {
    const pointer = current.pendingPath ?? current.path;
    current.pendingPath = null;
    return pointer;
  }
  const pointer = `${current.path}/${current.nextIndex}`;
  current.nextIndex += 1;
  return pointer;
}

function error(code, jsonPointer, message, evidence = {}, relatedPointers = []) {
  return { code, json_pointer: jsonPointer, message, related_pointers: relatedPointers, evidence };
}

function errorComparator(left, right) {
  return compareCodePoints(left.json_pointer, right.json_pointer)
    || compareCodePoints(left.code, right.code)
    || compareCodePoints(canonicalStringify(left.evidence), canonicalStringify(right.evidence));
}

function schemaInstancePathToJsonPointer(schemaError, value = null, schema = null, closedPointers = null) {
  if (value !== null && schema !== null && String(schemaError).endsWith(" is not allowed")) {
    const closedPropertyPointer = closedPointers
      ? closedPointers.get(String(schemaError))?.shift() ?? null
      : closedSchemaPropertyPointer(String(schemaError), value, schema);
    if (closedPropertyPointer !== null) return closedPropertyPointer;
  }
  const match = String(schemaError).match(/^(\$(?:\.[^.[\]\s]+|\[[0-9]+\])*)/u);
  if (!match) return "";
  const segments = [];
  for (const token of match[1].matchAll(/\.([^.[\]]+)|\[([0-9]+)\]/gu)) {
    segments.push(escapePointer(token[1] ?? token[2]));
  }
  return segments.length === 0 ? "" : `/${segments.join("/")}`;
}

function resolveLocalSchemaRef(rootSchema, ref) {
  if (!ref.startsWith("#/")) throw new Error(`unsupported Schema ref ${ref}`);
  return ref.slice(2).split("/").reduce((node, token) => {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    return node?.[key];
  }, rootSchema);
}

function closedSchemaPropertyPointer(schemaError, value, schema) {
  return closedSchemaPropertyPointerMap(value, schema).get(schemaError)?.[0] ?? null;
}

function closedSchemaPropertyPointerMap(value, schema) {
  const matches = [];
  collectClosedSchemaPropertyPointers(value, schema, schema, "$", "", matches);
  const pointersByError = new Map();
  for (const entry of matches) {
    const key = `${entry.instance_path} is not allowed`;
    if (!pointersByError.has(key)) pointersByError.set(key, []);
    pointersByError.get(key).push(entry.json_pointer);
  }
  return pointersByError;
}

function collectClosedSchemaPropertyPointers(value, schema, rootSchema, instancePath, jsonPointer, output) {
  if (!schema || typeof schema !== "object") return;
  let node = schema;
  if (node.$ref) {
    try {
      node = resolveLocalSchemaRef(rootSchema, node.$ref);
    } catch {
      return;
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(node.properties ?? {}, key)) {
        collectClosedSchemaPropertyPointers(child, node.properties[key], rootSchema, `${instancePath}.${key}`, `${jsonPointer}/${escapePointer(key)}`, output);
      } else if (node.additionalProperties === false) {
        output.push({
          instance_path: `${instancePath}.${key}`,
          json_pointer: `${jsonPointer}/${escapePointer(key)}`,
        });
      }
    }
  } else if (Array.isArray(value) && node.items) {
    value.forEach((child, index) => {
      collectClosedSchemaPropertyPointers(child, node.items, rootSchema, `${instancePath}[${index}]`, `${jsonPointer}/${index}`, output);
    });
  }
  for (const branch of node.allOf ?? []) {
    collectClosedSchemaPropertyPointers(value, branch, rootSchema, instancePath, jsonPointer, output);
  }
  for (const branch of node.oneOf ?? []) {
    collectClosedSchemaPropertyPointers(value, branch, rootSchema, instancePath, jsonPointer, output);
  }
  if (node.if) collectClosedSchemaPropertyPointers(value, node.if, rootSchema, instancePath, jsonPointer, output);
  if (node.then) collectClosedSchemaPropertyPointers(value, node.then, rootSchema, instancePath, jsonPointer, output);
  if (node.else) collectClosedSchemaPropertyPointers(value, node.else, rootSchema, instancePath, jsonPointer, output);
}

function sortedUnique(values, comparator = compareCodePoints) {
  if (!Array.isArray(values)) return false;
  for (let index = 1; index < values.length; index += 1) {
    if (comparator(values[index - 1], values[index]) >= 0) return false;
  }
  return true;
}

function selectorComparator(left, right) {
  return compareCodePoints(left.path, right.path) || compareCodePoints(left.kind, right.kind);
}

export function validRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/u.test(value) || value.startsWith("//")) return false;
  if (value.includes("\\") || value.includes("\0") || value.includes("\r") || value.includes("\n")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function collisionKey(value) {
  return value.normalize("NFC").toLowerCase();
}

function selectorContains(selector, candidatePath) {
  const selectorPath = collisionKey(selector.path);
  const comparedPath = collisionKey(candidatePath);
  if (selector.kind === "file") return selectorPath === comparedPath;
  return comparedPath === selectorPath || comparedPath.startsWith(`${selectorPath}/`);
}

export function selectorsOverlap(left, right) {
  if (left.kind === "file") return selectorContains(right, left.path);
  if (right.kind === "file") return selectorContains(left, right.path);
  return selectorContains(left, right.path) || selectorContains(right, left.path);
}

class MinHeap {
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

function lowerBoundSelectorPath(entries, targetPath) {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareCodePoints(entries[middle].normalizedPath, targetPath) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function addScopeOverlapPair(pairSet, pairs, leftIndex, rightIndex, state, maxPairs) {
  state.comparisons += 1;
  if (state.comparisons > maxPairs) return false;
  if (leftIndex === rightIndex) return true;
  const first = Math.min(leftIndex, rightIndex);
  const second = Math.max(leftIndex, rightIndex);
  const key = `${first}:${second}`;
  if (pairSet.has(key)) return true;
  pairSet.add(key);
  pairs.push({ left_index: first, right_index: second });
  return true;
}

function collectScopeOverlapPairs(tickets, maxPairs) {
  const entries = [];
  for (const [ticketIndex, ticket] of tickets.entries()) {
    if (typeof ticket?.id !== "string" || !Array.isArray(ticket.scope_selectors)) continue;
    for (const [selectorIndex, selector] of ticket.scope_selectors.entries()) {
      if ((selector?.kind !== "file" && selector?.kind !== "directory") || !validRelativePath(selector?.path)) continue;
      entries.push({
        kind: selector.kind,
        normalizedPath: collisionKey(selector.path),
        selector_index: selectorIndex,
        ticket_index: ticketIndex,
      });
    }
  }
  entries.sort((left, right) =>
    compareCodePoints(left.normalizedPath, right.normalizedPath)
    || compareCodePoints(left.kind, right.kind)
    || left.ticket_index - right.ticket_index
    || left.selector_index - right.selector_index,
  );

  const pairSet = new Set();
  const pairs = [];
  const state = { comparisons: 0 };
  for (let start = 0; start < entries.length;) {
    let end = start + 1;
    while (end < entries.length && entries[end].normalizedPath === entries[start].normalizedPath) end += 1;
    for (let left = start; left < end; left += 1) {
      for (let right = left + 1; right < end; right += 1) {
        if (!addScopeOverlapPair(pairSet, pairs, entries[left].ticket_index, entries[right].ticket_index, state, maxPairs)) {
          return { comparisons: state.comparisons, exceeded: true, pairs };
        }
      }
    }
    start = end;
  }

  for (const entry of entries) {
    if (entry.kind !== "directory") continue;
    const prefix = `${entry.normalizedPath}/`;
    for (let index = lowerBoundSelectorPath(entries, prefix);
      index < entries.length && entries[index].normalizedPath.startsWith(prefix);
      index += 1) {
      if (!addScopeOverlapPair(pairSet, pairs, entry.ticket_index, entries[index].ticket_index, state, maxPairs)) {
        return { comparisons: state.comparisons, exceeded: true, pairs };
      }
    }
  }

  pairs.sort((left, right) => left.left_index - right.left_index || left.right_index - right.right_index);
  return { comparisons: state.comparisons, exceeded: false, pairs };
}

function buildReachabilityLookup(tickets, ordered, outgoing) {
  const ids = tickets.map((ticket) => ticket.id);
  const indexById = new Map(ids.map((id, index) => [id, index]));
  const words = Math.ceil(ids.length / 32);
  const bitsets = ids.map(() => new Uint32Array(words));
  for (let orderedIndex = ordered.length - 1; orderedIndex >= 0; orderedIndex -= 1) {
    const id = ordered[orderedIndex];
    const sourceIndex = indexById.get(id);
    if (sourceIndex === undefined) continue;
    const sourceBits = bitsets[sourceIndex];
    for (const child of outgoing.get(id) ?? []) {
      const childIndex = indexById.get(child);
      if (childIndex === undefined) continue;
      sourceBits[childIndex >> 5] |= 1 << (childIndex & 31);
      const childBits = bitsets[childIndex];
      for (let word = 0; word < words; word += 1) sourceBits[word] |= childBits[word];
    }
  }
  return (from, to) => {
    const fromIndex = indexById.get(from);
    const toIndex = indexById.get(to);
    if (fromIndex === undefined || toIndex === undefined) return false;
    return (bitsets[fromIndex][toIndex >> 5] & (1 << (toIndex & 31))) !== 0;
  };
}

function validateStringTree(value, pointer, errors) {
  if (typeof value === "string") {
    if (value !== value.normalize("NFC")) errors.push(error("tickets_manifest_noncanonical", pointer, "string is not NFC"));
    if (value.includes("\r") || value.includes("\0")) errors.push(error("tickets_manifest_noncanonical", pointer, "string contains a forbidden CR or NUL"));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateStringTree(entry, `${pointer}/${index}`, errors));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) validateStringTree(entry, `${pointer}/${escapePointer(key)}`, errors);
  }
}

function escapePointer(value) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function markdownFence(json) {
  const longest = Math.max(0, ...Array.from(json.matchAll(/`+/gu), (match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function oneLine(value) {
  return String(value).replace(/\s+/gu, " ").trim();
}

function markdownInlineText(value) {
  return oneLine(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;");
}

function markdownStandaloneText(value) {
  const text = markdownInlineText(value);
  if (/^[#>+\-*_`~=<]/u.test(text) || /^\d{1,9}[.)](?:\s|$)/u.test(text) || /^\[(?:\^)?[^\]]+\]:/u.test(text)) {
    const [first, ...rest] = Array.from(text);
    return `&#${first.codePointAt(0)};${rest.join("")}`;
  }
  return text;
}

function markdownTableCell(value) {
  return markdownInlineText(value).replaceAll("|", "&#124;");
}

function ticketEntryPayload(ticket) {
  const { lineage: _lineage, ...payload } = ticket;
  return payload;
}

export function ticketEntryDigest(ticket) {
  return domainDigest("autosk-flow/ticket-entry/v1", canonicalStringify(ticketEntryPayload(ticket)));
}

export function renderTicketDocuments(manifest) {
  const root = `docs/autosk/epics/${manifest.epic_id}/tickets`;
  const documents = new Map();
  const rows = manifest.tickets.map((ticket) =>
    `| ${ticket.id} | ${markdownTableCell(ticket.title)} | ${ticket.work_type} | ${ticket.depends_on.join(", ") || "—"} | ${markdownTableCell(ticket.goal)} |`,
  );
  documents.set(`${root}/README.md`, [
    RENDERER_HEADER,
    "",
    "# Tickets",
    "",
    markdownStandaloneText(manifest.goal),
    "",
    "## Stable execution order",
    "",
    manifest.topological_order.map((id, index) => `${index + 1}. ${id}`).join("\n"),
    "",
    "## Ticket set",
    "",
    "| ID | Title | Work type | Depends on | Goal |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## Exclusions",
    "",
    ...(manifest.exclusions.length > 0 ? manifest.exclusions.map((item) => `- ${markdownStandaloneText(item)}`) : ["- None."]),
    "",
  ].join("\n"));

  for (const ticket of manifest.tickets) {
    const entry = canonicalStringify(ticket).trimEnd();
    const fence = markdownFence(entry);
    documents.set(ticket.document_path, [
      RENDERER_HEADER,
      "",
      `# ${ticket.id} — ${markdownInlineText(ticket.title)}`,
      "",
      `**Work type:** ${ticket.work_type}`,
      "",
      `**Depends on:** ${ticket.depends_on.join(", ") || "none"}`,
      "",
      "## Goal",
      "",
      markdownStandaloneText(ticket.goal),
      "",
      "## Acceptance criteria",
      "",
      ...ticket.acceptance_criteria.map((criterion) => `- **${criterion.id}:** ${markdownInlineText(criterion.text)}`),
      "",
      "## Canonical manifest entry",
      "",
      `${fence}json`,
      entry,
      fence,
      "",
    ].join("\n"));
  }
  return documents;
}

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

function renderedDocumentLimitConfig(manifest) {
  const limits = manifest?.policy?.limits ?? {};
  return {
    maxEntries: ABSOLUTE_MAX_RENDERED_DOCUMENT_ENTRIES,
    maxPerDocumentBytes: activeLimit(limits.max_rendered_document_bytes, ABSOLUTE_MAX_RENDERED_DOCUMENT_BYTES),
    maxTotalBytes: activeLimit(limits.max_total_rendered_document_bytes, ABSOLUTE_MAX_TOTAL_RENDERED_DOCUMENT_BYTES),
  };
}

export function compareRenderedTicketDocuments(manifest, candidateDocuments) {
  const errors = [];
  const entries = documentInventoryEntries(candidateDocuments);
  if (!entries) {
    return [error("tickets_rendered_path_missing", "/rendered_documents", "candidate rendered document inventory is missing")];
  }
  const documentLimits = renderedDocumentLimitConfig(manifest);
  if (entries.length > documentLimits.maxEntries) {
    return [error("tickets_manifest_limits_exceeded", "/rendered_documents", "max_rendered_document_entries exceeded", {
      actual: entries.length,
      limit: documentLimits.maxEntries,
      limit_name: "max_rendered_document_entries",
    })];
  }

  const actual = new Map();
  let totalBytes = 0;
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
    pushLimitError(errors, pointer, "max_rendered_document_bytes", bytes.byteLength, documentLimits.maxPerDocumentBytes);
    totalBytes += bytes.byteLength;
    if (actual.has(documentPath)) {
      errors.push(error("tickets_rendered_path_extra", pointer, "candidate rendered document path is duplicated", { path: documentPath }));
      continue;
    }
    actual.set(documentPath, bytes);
  }
  pushLimitError(errors, "/rendered_documents", "max_total_rendered_document_bytes", totalBytes, documentLimits.maxTotalBytes);
  if (errors.some((entry) => entry.code === "tickets_manifest_limits_exceeded")) return errors.sort(errorComparator);

  const expected = renderTicketDocuments(manifest);
  const unmatchedActual = new Set(actual.keys());
  const actualDigestByPath = new Map();
  const unmatchedByDigest = new Map();
  for (const [candidatePath, bytes] of actual.entries()) {
    const digest = sha256Bytes(bytes);
    actualDigestByPath.set(candidatePath, digest);
    if (!unmatchedByDigest.has(digest)) unmatchedByDigest.set(digest, new Set());
    unmatchedByDigest.get(digest).add(candidatePath);
  }
  const consumeActual = (candidatePath) => {
    unmatchedActual.delete(candidatePath);
    unmatchedByDigest.get(actualDigestByPath.get(candidatePath))?.delete(candidatePath);
  };
  for (const [expectedPath, expectedText] of [...expected.entries()].sort(([left], [right]) => compareCodePoints(left, right))) {
    const pointer = `/rendered_documents/${escapePointer(expectedPath)}`;
    const expectedBytes = Buffer.from(expectedText, "utf8");
    if (actual.has(expectedPath)) {
      consumeActual(expectedPath);
      if (!actual.get(expectedPath).equals(expectedBytes)) {
        errors.push(error("tickets_rendered_bytes_mismatch", pointer, "candidate rendered document bytes differ from pinned renderer output", {
          actual_sha256: sha256Bytes(actual.get(expectedPath)),
          expected_sha256: sha256Bytes(expectedBytes),
          path: expectedPath,
        }));
      }
      continue;
    }

    const renamed = [...(unmatchedByDigest.get(sha256Bytes(expectedBytes)) ?? [])]
      .filter((candidatePath) => actual.get(candidatePath).equals(expectedBytes))
      .sort(compareCodePoints);
    if (renamed.length === 1) {
      consumeActual(renamed[0]);
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


function resolveInsideCandidateRoot(candidateRoot, relativePath) {
  if (typeof candidateRoot !== "string" || candidateRoot.length === 0 || !validRelativePath(relativePath)) return null;
  const absoluteRoot = path.resolve(candidateRoot);
  let rootMetadata;
  try {
    rootMetadata = lstatSync(absoluteRoot);
  } catch {
    return null;
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) return null;

  const segments = relativePath.split("/");
  let current = absoluteRoot;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = path.join(current, segments[index]);
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) return null;
    } catch (cause) {
      if (cause?.code !== "ENOENT") return null;
      break;
    }
  }
  const absolutePath = path.resolve(absoluteRoot, ...segments);
  if (!absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) return null;
  return { absoluteRoot, absolutePath };
}

function pathChainIdentity(candidateRoot, relativePath, includeLeaf) {
  const absoluteRoot = path.resolve(candidateRoot);
  const segments = relativePath.split("/");
  const last = includeLeaf ? segments.length : segments.length - 1;
  const chain = [];
  for (let index = 0; index <= last; index += 1) {
    const current = index === 0 ? absoluteRoot : path.join(absoluteRoot, ...segments.slice(0, index));
    const metadata = lstatSync(current);
    chain.push(`${metadata.dev}:${metadata.ino}:${metadata.mode}:${metadata.size}:${metadata.mtimeMs}`);
  }
  return chain.join("|");
}

function readDescriptorBounded(descriptor, maxBytes) {
  const chunks = [];
  let total = 0;
  while (total <= maxBytes) {
    const length = Math.min(65_536, maxBytes + 1 - total);
    if (length === 0) break;
    const chunk = Buffer.allocUnsafe(length);
    const bytesRead = readSync(descriptor, chunk, 0, length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return Buffer.concat(chunks, total);
}

function regularFileBytes(candidateRoot, relativePath, errors, pointer, maxBytes = null, limitName = null, additionalLimit = null) {
  const resolved = resolveInsideCandidateRoot(candidateRoot, relativePath);
  if (!resolved) {
    errors.push(error("tickets_path_invalid", pointer, "candidate path escapes, traverses a symlink/non-directory ancestor, or is outside the closed relative-path dialect", { path: relativePath }));
    return null;
  }
  let descriptor = null;
  try {
    const chainBefore = pathChainIdentity(candidateRoot, relativePath, false);
    const leafBefore = lstatSync(resolved.absolutePath);
    if (leafBefore.isSymbolicLink() || !leafBefore.isFile()) {
      errors.push(error("tickets_path_invalid", pointer, "candidate path is not a regular non-symlink file", { path: relativePath }));
      return null;
    }
    descriptor = openSync(resolved.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.dev !== leafBefore.dev || metadata.ino !== leafBefore.ino
        || metadata.mode !== leafBefore.mode || metadata.size !== leafBefore.size || metadata.mtimeMs !== leafBefore.mtimeMs) {
      errors.push(error("tickets_path_invalid", pointer, "candidate path is not a regular non-symlink file", { path: relativePath }));
      return null;
    }
    const limits = [
      { consumedBytes: 0, readLimit: maxBytes, reportLimit: maxBytes, name: limitName ?? "file byte limit" },
      additionalLimit ? {
        consumedBytes: additionalLimit.consumedBytes,
        readLimit: additionalLimit.maxBytes,
        reportLimit: additionalLimit.reportLimit,
        name: additionalLimit.limitName,
      } : null,
    ].filter((item) => Number.isInteger(item?.readLimit) && Number.isInteger(item?.reportLimit) && Number.isInteger(item?.consumedBytes));
    for (const item of limits) {
      if (metadata.size > item.readLimit) {
        errors.push(error("tickets_manifest_limits_exceeded", pointer, `${item.name} exceeded before read`, {
          actual: item.consumedBytes + metadata.size,
          limit: item.reportLimit,
          limit_name: item.name,
          path: relativePath,
        }));
        return null;
      }
    }
    const effectiveMaxBytes = limits.length > 0
      ? Math.min(...limits.map((item) => item.readLimit))
      : ABSOLUTE_MAX_RENDERED_DOCUMENT_BYTES;
    const bytes = readDescriptorBounded(descriptor, effectiveMaxBytes);
    const metadataAfter = fstatSync(descriptor);
    const chainAfter = pathChainIdentity(candidateRoot, relativePath, false);
    if (chainAfter !== chainBefore || metadataAfter.dev !== metadata.dev || metadataAfter.ino !== metadata.ino
        || metadataAfter.size !== metadata.size || metadataAfter.mtimeMs !== metadata.mtimeMs) {
      errors.push(error("tickets_path_invalid", pointer, "candidate path changed during bounded read", { path: relativePath }));
      return null;
    }
    if (bytes.byteLength > effectiveMaxBytes) {
      const item = limits.find((candidate) => candidate.readLimit === effectiveMaxBytes)
        ?? { consumedBytes: 0, reportLimit: effectiveMaxBytes, name: "file byte limit" };
      errors.push(error("tickets_manifest_limits_exceeded", pointer, `${item.name} exceeded during read`, {
        actual: item.consumedBytes + bytes.byteLength,
        limit: item.reportLimit,
        limit_name: item.name,
        path: relativePath,
      }));
      return null;
    }
    return bytes;
  } catch (cause) {
    errors.push(error("tickets_rendered_path_missing", pointer, "candidate file is missing or unreadable", {
      cause: String(cause),
      path: relativePath,
    }));
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function boundedDirectoryEntries(absolutePath, maxEntries) {
  const directory = opendirSync(absolutePath);
  const entries = [];
  let exceeded = false;
  try {
    while (entries.length < maxEntries) {
      const entry = directory.readSync();
      if (entry === null) break;
      entries.push(entry);
    }
    exceeded = entries.length === maxEntries && directory.readSync() !== null;
  } finally {
    directory.closeSync();
  }
  return { entries: entries.sort((left, right) => compareCodePoints(left.name, right.name)), exceeded };
}

export function loadCandidateTicketDocuments(candidateRoot, manifest) {
  const errors = [];
  const documents = new Map();
  const directoryPath = `docs/autosk/epics/${manifest?.epic_id}/tickets`;
  const resolved = resolveInsideCandidateRoot(candidateRoot, directoryPath);
  if (!resolved) {
    return {
      documents,
      errors: [error("tickets_path_invalid", "/rendered_documents", "candidate Tickets directory is invalid", { path: directoryPath })],
    };
  }

  let rootMetadata;
  let directoryMetadata;
  const documentLimits = renderedDocumentLimitConfig(manifest);
  let entries;
  try {
    const chainBefore = pathChainIdentity(candidateRoot, directoryPath, true);
    rootMetadata = lstatSync(resolved.absoluteRoot);
    directoryMetadata = lstatSync(resolved.absolutePath);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      throw new Error("candidate root is not a regular directory");
    }
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      throw new Error("Tickets path is not a regular directory");
    }
    const boundedEntries = boundedDirectoryEntries(resolved.absolutePath, documentLimits.maxEntries);
    entries = boundedEntries.entries;
    if (boundedEntries.exceeded) {
      return {
        documents,
        errors: [error("tickets_manifest_limits_exceeded", "/rendered_documents", "max_rendered_document_entries exceeded", {
          actual: documentLimits.maxEntries + 1,
          limit: documentLimits.maxEntries,
          limit_name: "max_rendered_document_entries",
        })],
      };
    }
    if (pathChainIdentity(candidateRoot, directoryPath, true) !== chainBefore) {
      throw new Error("candidate Tickets directory changed during enumeration");
    }
  } catch (cause) {
    return {
      documents,
      errors: [error("tickets_rendered_path_missing", "/rendered_documents", "candidate Tickets directory is missing or unreadable", {
        cause: String(cause),
        path: directoryPath,
      })],
    };
  }
  let totalBytes = 0;
  for (const [index, entry] of entries.entries()) {
    const relativePath = `${directoryPath}/${entry.name}`;
    const pointer = `/rendered_documents/${index}`;
    if (entry.name === "tickets.manifest.json") continue;
    if (entry.isSymbolicLink()) {
      errors.push(error("tickets_path_invalid", pointer, "candidate Tickets inventory contains a symlinked entry", {
        path: relativePath,
      }));
      continue;
    }
    if (!entry.isFile()) {
      errors.push(error("tickets_rendered_path_extra", pointer, "candidate Tickets inventory contains a non-regular or nested entry", {
        path: relativePath,
      }));
      continue;
    }
    const bytes = regularFileBytes(
      candidateRoot,
      relativePath,
      errors,
      pointer,
      documentLimits.maxPerDocumentBytes,
      "max_rendered_document_bytes",
      {
        consumedBytes: totalBytes,
        limitName: "max_total_rendered_document_bytes",
        maxBytes: Math.max(0, documentLimits.maxTotalBytes - totalBytes),
        reportLimit: documentLimits.maxTotalBytes,
      },
    );
    if (bytes !== null) {
      totalBytes += bytes.byteLength;
      documents.set(relativePath, bytes);
    }
  }
  return { documents, errors: errors.sort(errorComparator) };
}

export function validateTicketsCandidateTreeResult(candidateRoot, manifestRelativePath, options = {}) {
  const errors = [];
  let schema = options.schema;
  if (!schema) {
    try {
      schema = JSON.parse(readFileSync(options.schemaPath ?? MANIFEST_SCHEMA_PATH, "utf8"));
    } catch (cause) {
      return {
        candidate_documents: new Map(),
        digests: null,
        errors: [error("tickets_manifest_schema_invalid", "", "Tickets manifest Schema is missing or invalid", { cause: String(cause) })],
        manifest: null,
        raw_bytes: null,
        raw_text: null,
      };
    }
  }

  const requestedManifestLimit = Number.isInteger(options.maxManifestBytes)
    ? Math.min(Math.max(0, options.maxManifestBytes), ABSOLUTE_MAX_MANIFEST_BYTES)
    : ABSOLUTE_MAX_MANIFEST_BYTES;
  const rawBytes = regularFileBytes(
    candidateRoot,
    manifestRelativePath,
    errors,
    "/manifest_path",
    requestedManifestLimit,
    "max_manifest_bytes",
  );
  if (rawBytes === null) {
    return {
      candidate_documents: new Map(),
      digests: null,
      errors: errors.sort(errorComparator),
      manifest: null,
      raw_bytes: null,
      raw_text: null,
    };
  }
  const parsed = parseTicketsManifest(rawBytes, { maxManifestBytes: requestedManifestLimit });
  errors.push(...parsed.errors);
  if (!parsed.manifest || parsed.errors.length > 0) {
    return {
      candidate_documents: new Map(),
      digests: null,
      errors: errors.sort(errorComparator),
      manifest: parsed.manifest,
      raw_bytes: rawBytes,
      raw_text: parsed.text,
    };
  }

  const expectedManifestPath = `docs/autosk/epics/${parsed.manifest.epic_id}/tickets/tickets.manifest.json`;
  if (manifestRelativePath !== expectedManifestPath) {
    errors.push(error("tickets_rendered_path_mismatch", "/manifest_path", "manifest path does not match its exact Epic identity", {
      actual: manifestRelativePath,
      expected: expectedManifestPath,
    }));
  }
  const preflightErrors = validateTicketsManifestPreflight(parsed.manifest, schema, rawBytes);
  errors.push(...preflightErrors);
  if (errors.length > 0) {
    return {
      candidate_documents: new Map(),
      digests: null,
      errors: errors.sort(errorComparator),
      manifest: parsed.manifest,
      raw_bytes: rawBytes,
      raw_text: parsed.text,
    };
  }

  const inventory = loadCandidateTicketDocuments(candidateRoot, parsed.manifest);
  errors.push(...inventory.errors);
  errors.push(...validateTicketsManifest(parsed.manifest, schema, rawBytes, {
    candidateDocuments: inventory.documents,
    previousManifestContext: options.previousManifestContext,
  }));
  const sortedErrors = errors.sort(errorComparator);
  return {
    candidate_documents: inventory.documents,
    digests: sortedErrors.length === 0 ? ticketManifestDigests(parsed.manifest) : null,
    errors: sortedErrors,
    manifest: parsed.manifest,
    raw_bytes: rawBytes,
    raw_text: parsed.text,
  };
}

export function validateTicketsCandidateTree(candidateRoot, manifestRelativePath, options = {}) {
  return validateTicketsCandidateTreeResult(candidateRoot, manifestRelativePath, options).errors;
}

function gitBytes(repositoryRoot, args, maxBuffer) {
  const result = spawnSync(GIT_EXECUTABLE, ["-C", path.resolve(repositoryRoot), ...args], {
    encoding: null,
    env: ticketsGitEnvironment(),
    maxBuffer,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? Buffer.from(result.stderr ?? "").toString("utf8").trim();
    throw new Error(detail || `git ${args[0]} failed`);
  }
  return Buffer.from(result.stdout);
}

export function ticketsGitEnvironment() {
  return {
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    PATH: process.platform === "win32" ? "C:\\Windows\\System32;C:\\Windows" : "/usr/bin:/bin",
    TMPDIR: process.platform === "win32" ? "C:\\Windows\\Temp" : "/tmp",
    TZ: "UTC",
  };
}

function gitObjectBytes(repositoryRoot, objectOid, maxBytes) {
  const sizeText = gitBytes(repositoryRoot, ["cat-file", "-s", objectOid], 1024).toString("utf8").trim();
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Git object size is invalid");
  if (size > maxBytes) return { bytes: null, size };
  const bytes = gitBytes(repositoryRoot, ["cat-file", "blob", objectOid], maxBytes + 1);
  if (bytes.byteLength !== size) throw new Error("Git object size changed during immutable read");
  return { bytes, size };
}

export function validateTicketsCandidateGitTree(repositoryRoot, treeOid, manifestRelativePath, options = {}) {
  const empty = (errors) => ({ candidate_documents: new Map(), digests: null, errors, manifest: null, raw_bytes: null, raw_text: null, tree_oid: treeOid });
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(treeOid) || !validRelativePath(manifestRelativePath)) {
    return empty([error("tickets_path_invalid", "/candidate_tree_oid", "candidate Git tree identity or manifest path is invalid")]);
  }
  let schema = options.schema;
  try {
    if (!schema) schema = JSON.parse(readFileSync(options.schemaPath ?? MANIFEST_SCHEMA_PATH, "utf8"));
    const requestedManifestLimit = Number.isInteger(options.maxManifestBytes)
      ? Math.min(Math.max(0, options.maxManifestBytes), ABSOLUTE_MAX_MANIFEST_BYTES)
      : ABSOLUTE_MAX_MANIFEST_BYTES;
    const type = gitBytes(repositoryRoot, ["cat-file", "-t", treeOid], 1024).toString("utf8").trim();
    if (type !== "tree") return empty([error("tickets_path_invalid", "/candidate_tree_oid", "candidate Git identity is not a tree")]);
    const resolvedTreeOid = gitBytes(repositoryRoot, ["rev-parse", "--verify", `${treeOid}^{tree}`], 1024).toString("utf8").trim();
    if (resolvedTreeOid !== treeOid) {
      return empty([error("tickets_path_invalid", "/candidate_tree_oid", "candidate tree OID must be the full canonical Git object identity", {
        actual: treeOid,
        canonical: resolvedTreeOid,
      })]);
    }
    const manifestEntryText = gitBytes(repositoryRoot, ["ls-tree", resolvedTreeOid, "--", manifestRelativePath], 4096).toString("utf8").trim();
    const manifestEntry = manifestEntryText.match(/^((?:100644|100755)) blob ([0-9a-f]{40,64})\t(.+)$/u);
    if (!manifestEntry || manifestEntry[3] !== manifestRelativePath) {
      return empty([error("tickets_path_invalid", "/manifest_path", "candidate manifest must be a regular Git blob", { path: manifestRelativePath })]);
    }
    const manifestOid = manifestEntry[2];
    const manifestObject = gitObjectBytes(repositoryRoot, manifestOid, requestedManifestLimit);
    if (manifestObject.bytes === null) {
      return empty([error("tickets_manifest_limits_exceeded", "/manifest_path", "max_manifest_bytes exceeded before Git object read", {
        actual: manifestObject.size,
        limit: requestedManifestLimit,
        limit_name: "max_manifest_bytes",
      })]);
    }
    const parsed = parseTicketsManifest(manifestObject.bytes, { maxManifestBytes: requestedManifestLimit });
    if (!parsed.manifest || parsed.errors.length > 0) return { ...empty(parsed.errors), raw_bytes: manifestObject.bytes, raw_text: parsed.text };
    const repositoryObjectFormat = gitBytes(repositoryRoot, ["rev-parse", "--show-object-format"], 1024).toString("utf8").trim();
    if (parsed.manifest.object_format !== repositoryObjectFormat) {
      return { ...empty([error("tickets_governing_ref_invalid", "/object_format", "manifest object_format does not match the candidate Git repository", {
        actual: parsed.manifest.object_format,
        expected: repositoryObjectFormat,
      })]), manifest: parsed.manifest, raw_bytes: manifestObject.bytes, raw_text: parsed.text };
    }
    const expectedOidLength = parsed.manifest.object_format === "sha256" ? 64 : 40;
    if (treeOid.length !== expectedOidLength) {
      return { ...empty([error("tickets_governing_ref_invalid", "/candidate_tree_oid", "candidate tree OID length does not match manifest object_format", {
        actual_length: treeOid.length,
        expected_length: expectedOidLength,
      })]), manifest: parsed.manifest, raw_bytes: manifestObject.bytes, raw_text: parsed.text };
    }
    const expectedManifestPath = `docs/autosk/epics/${parsed.manifest.epic_id}/tickets/tickets.manifest.json`;
    if (manifestRelativePath !== expectedManifestPath) {
      return { ...empty([error("tickets_rendered_path_mismatch", "/manifest_path", "manifest path does not match its exact Epic identity", {
        actual: manifestRelativePath,
        expected: expectedManifestPath,
      })]), manifest: parsed.manifest, raw_bytes: manifestObject.bytes, raw_text: parsed.text };
    }
    const preflightErrors = validateTicketsManifestPreflight(parsed.manifest, schema, manifestObject.bytes);
    if (preflightErrors.length > 0) {
      return { ...empty(preflightErrors), manifest: parsed.manifest, raw_bytes: manifestObject.bytes, raw_text: parsed.text };
    }

    const directoryPath = path.posix.dirname(manifestRelativePath);
    const listing = gitBytes(repositoryRoot, ["ls-tree", "-z", `${resolvedTreeOid}:${directoryPath}`], ABSOLUTE_MAX_MANIFEST_BYTES);
    const records = listing.subarray(0, Math.max(0, listing.length - 1)).toString("utf8").split("\0").filter(Boolean);
    if (records.length > ABSOLUTE_MAX_RENDERED_DOCUMENT_ENTRIES) {
      return { ...empty([error("tickets_manifest_limits_exceeded", "/rendered_documents", "max_rendered_document_entries exceeded", {
        actual: records.length,
        limit: ABSOLUTE_MAX_RENDERED_DOCUMENT_ENTRIES,
        limit_name: "max_rendered_document_entries",
      })]), manifest: parsed.manifest, raw_bytes: manifestObject.bytes, raw_text: parsed.text };
    }
    const documentLimits = renderedDocumentLimitConfig(parsed.manifest);
    const candidateDocuments = new Map();
    const inventoryErrors = [];
    let totalBytes = 0;
    for (const [index, record] of records.sort(compareCodePoints).entries()) {
      const match = record.match(/^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40,64})\t([^\0]+)$/u);
      if (!match) {
        inventoryErrors.push(error("tickets_path_invalid", `/rendered_documents/${index}`, "candidate Git tree entry is malformed"));
        continue;
      }
      const [, mode, type, objectOid, name] = match;
      const relativePath = `${directoryPath}/${name}`;
      if (name === "tickets.manifest.json") continue;
      if (type !== "blob" || (mode !== "100644" && mode !== "100755") || !validRelativePath(relativePath)) {
        inventoryErrors.push(error("tickets_rendered_path_extra", `/rendered_documents/${index}`, "candidate Tickets inventory contains a non-regular or nested Git entry", { path: relativePath }));
        continue;
      }
      const remainingTotalBytes = Math.max(0, documentLimits.maxTotalBytes - totalBytes);
      const readLimit = Math.min(documentLimits.maxPerDocumentBytes, remainingTotalBytes);
      const object = gitObjectBytes(repositoryRoot, objectOid, readLimit);
      if (object.bytes === null) {
        const limitName = object.size > documentLimits.maxPerDocumentBytes
          ? "max_rendered_document_bytes"
          : "max_total_rendered_document_bytes";
        const limit = limitName === "max_rendered_document_bytes" ? documentLimits.maxPerDocumentBytes : documentLimits.maxTotalBytes;
        inventoryErrors.push(error("tickets_manifest_limits_exceeded", `/rendered_documents/${index}`, `${limitName} exceeded before Git object read`, {
          actual: limitName === "max_total_rendered_document_bytes" ? totalBytes + object.size : object.size,
          limit,
          limit_name: limitName,
          path: relativePath,
        }));
        if (limitName === "max_total_rendered_document_bytes") break;
        continue;
      }
      totalBytes += object.size;
      if (totalBytes > documentLimits.maxTotalBytes) {
        inventoryErrors.push(error("tickets_manifest_limits_exceeded", "/rendered_documents", "max_total_rendered_document_bytes exceeded before Git object retention", {
          actual: totalBytes,
          limit: documentLimits.maxTotalBytes,
          limit_name: "max_total_rendered_document_bytes",
        }));
        break;
      }
      candidateDocuments.set(relativePath, object.bytes);
    }
    const errors = [...inventoryErrors, ...validateTicketsManifest(parsed.manifest, schema, manifestObject.bytes, {
      candidateDocuments,
      previousManifestContext: options.previousManifestContext,
    })].sort(errorComparator);
    return {
      candidate_documents: candidateDocuments,
      digests: errors.length === 0 ? ticketManifestDigests(parsed.manifest) : null,
      errors,
      manifest: parsed.manifest,
      raw_bytes: manifestObject.bytes,
      raw_text: parsed.text,
      tree_oid: treeOid,
    };
  } catch (cause) {
    return empty([error("tickets_path_invalid", "/candidate_tree_oid", "candidate Git tree is missing, unreadable, or exceeds host bounds", { cause: String(cause) })]);
  }
}

function candidateDocumentsFromContractFiles(files) {
  const prefix = `${EXAMPLE_CANDIDATE_ROOT_RELATIVE}/`;
  return new Map(EXAMPLE_CANDIDATE_CONTRACT_FILES
    .filter((relative) => relative.endsWith(".md"))
    .map((relative) => [relative.slice(prefix.length), files[relative]]));
}

export function ticketManifestDigests(manifest) {
  const canonicalManifest = canonicalStringify(manifest);
  const manifestDigest = domainDigest("autosk-flow/tickets-manifest/v1", canonicalManifest);
  const ticketEntryDigests = manifest.tickets.map((ticket) => ({
    ticket_id: ticket.id,
    digest: ticketEntryDigest(ticket),
  }));
  const adjacency = manifest.tickets.map((ticket) => ({ id: ticket.id, depends_on: ticket.depends_on }));
  const dagDigest = domainDigest("autosk-flow/ticket-dag/v1", canonicalStringify({
    adjacency,
    topological_order: manifest.topological_order,
  }));
  const documents = renderTicketDocuments(manifest);
  const documentEntries = [...documents.entries()]
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([documentPath, bytes]) => ({ path: documentPath, content_sha256: sha256Bytes(bytes), size_bytes: Buffer.byteLength(bytes) }));
  const documentPreimage = documentEntries.map((entry) => `${entry.path}\0${entry.content_sha256}\0`).join("");
  const renderedDocumentSetDigest = domainDigest("autosk-flow/ticket-doc-set/v1", documentPreimage);
  const ticketSetDigest = domainDigest(
    "autosk-flow/ticket-set/v1",
    manifestDigest,
    dagDigest,
    renderedDocumentSetDigest,
  );
  return {
    canonical_manifest: canonicalManifest,
    manifest_bytes_sha256: sha256Bytes(canonicalManifest),
    manifest_digest: manifestDigest,
    ticket_entry_digests: ticketEntryDigests,
    dag_digest: dagDigest,
    rendered_documents: documentEntries,
    rendered_document_set_digest: renderedDocumentSetDigest,
    ticket_set_digest: ticketSetDigest,
  };
}

export function ticketLimitsDigest(limits) {
  return domainDigest("autosk-flow/ticket-limits/v1", canonicalStringify(limits));
}

export function ticketDistributionDigest(domain, files) {
  if (typeof domain !== "string" || domain.length === 0 || !Array.isArray(files)) {
    throw new TypeError("distribution digest requires a domain and file array");
  }
  const seen = new Set();
  const entries = files.map((entry) => {
    if (!entry || typeof entry !== "object" || !validRelativePath(entry.path)) {
      throw new TypeError("distribution file path is invalid");
    }
    if (seen.has(entry.path)) throw new TypeError(`duplicate distribution file path ${entry.path}`);
    seen.add(entry.path);
    if (!(typeof entry.bytes === "string" || Buffer.isBuffer(entry.bytes) || entry.bytes instanceof Uint8Array)) {
      throw new TypeError(`distribution file bytes are invalid for ${entry.path}`);
    }
    return { path: entry.path, blob_sha256: sha256Bytes(entry.bytes) };
  }).sort((left, right) => compareCodePoints(left.path, right.path));
  const preimage = entries.map((entry) => `${entry.path}\0${entry.blob_sha256}\0`).join("");
  return domainDigest(domain, preimage);
}

export function ticketToolDistributionDigests(root = ROOT) {
  const entries = (relativePaths) => relativePaths.map((relative) => ({
    path: relative,
    bytes: readFileSync(path.join(root, relative)),
  }));
  return {
    renderer_distribution_digest: ticketDistributionDigest(
      "autosk-flow/ticket-renderer-distribution/v1",
      entries(RENDERER_DISTRIBUTION_FILES),
    ),
    validator_distribution_digest: ticketDistributionDigest(
      "autosk-flow/ticket-validator-distribution/v1",
      entries(VALIDATOR_DISTRIBUTION_FILES),
    ),
  };
}


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

function activeLimit(declared, absoluteLimit) {
  return Number.isInteger(declared) ? Math.min(Math.max(0, declared), absoluteLimit) : absoluteLimit;
}

function jsonShapeLimitErrors(value, maxDepth = ABSOLUTE_MAX_JSON_DEPTH) {
  const errors = [];
  const active = new WeakSet();
  const stack = [{ value, pointer: "", depth: 1, exit: false }];
  while (stack.length > 0) {
    const current = stack.pop();
    const item = current.value;
    if (!item || typeof item !== "object") continue;
    if (current.exit) {
      active.delete(item);
      continue;
    }
    if (active.has(item)) {
      errors.push(error("tickets_manifest_limits_exceeded", current.pointer, "manifest contains a JSON cycle", {
        limit_name: "max_json_depth",
      }));
      continue;
    }
    if (current.depth > maxDepth) {
      errors.push(error("tickets_manifest_limits_exceeded", current.pointer, "max_json_depth exceeded", {
        actual: current.depth,
        limit: maxDepth,
        limit_name: "max_json_depth",
      }));
      continue;
    }
    active.add(item);
    stack.push({ value: item, pointer: current.pointer, depth: current.depth, exit: true });
    if (Array.isArray(item)) {
      for (let index = item.length - 1; index >= 0; index -= 1) {
        stack.push({ value: item[index], pointer: `${current.pointer}/${index}`, depth: current.depth + 1, exit: false });
      }
    } else {
      for (const key of Object.keys(item).sort(compareCodePoints).reverse()) {
        stack.push({ value: item[key], pointer: `${current.pointer}/${escapePointer(key)}`, depth: current.depth + 1, exit: false });
      }
    }
  }
  return errors.sort(errorComparator);
}

function countLimitErrors(manifest) {
  const errors = [];
  const limits = manifest.policy?.limits ?? {};
  const tickets = Array.isArray(manifest.tickets) ? manifest.tickets : [];
  pushLimitError(errors, "/tickets", "max_tickets", tickets.length, limits.max_tickets);
  const reservedTicketIds = Array.isArray(manifest.reserved_ticket_ids) ? manifest.reserved_ticket_ids : [];
  pushLimitError(errors, "/reserved_ticket_ids", "max_reserved_ticket_ids", reservedTicketIds.length, limits.max_reserved_ticket_ids);
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
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      return null;
    }
  }
  return null;
}

function validateRevisionLineage(manifest, schema, context, errors) {
  const tickets = Array.isArray(manifest.tickets) ? manifest.tickets : [];
  const currentTicketIds = tickets.map((ticket) => ticket?.id).filter((id) => typeof id === "string");
  const reservedTicketIds = Array.isArray(manifest.reserved_ticket_ids) ? manifest.reserved_ticket_ids : [];
  if (!sortedUnique(reservedTicketIds)) {
    errors.push(error("tickets_lineage_invalid", "/reserved_ticket_ids", "reserved Ticket IDs must be unique and sorted"));
  }
  if (context === undefined) {
    errors.push(error("tickets_lineage_invalid", "/previous_manifest_digest", "host lineage context is required"));
    return;
  }
  if (manifest.previous_manifest_digest === null) {
    if (!context || context.kind !== "no_prior_publication"
        || !/^[0-9a-f]{64}$/u.test(context.publication_history_digest ?? "")) {
      errors.push(error("tickets_lineage_invalid", "/previous_manifest_digest", "initial lineage requires host proof that no prior Tickets publication exists"));
    }
    if (manifest.manifest_revision !== 1) {
      errors.push(error("tickets_lineage_invalid", "/manifest_revision", "initial manifest revision must be exactly 1"));
    }
    for (const [index, ticket] of tickets.entries()) {
      if (ticket?.lineage?.kind !== "new" || (ticket?.lineage?.predecessor_ids?.length ?? 0) !== 0) {
        errors.push(error("tickets_lineage_invalid", `/tickets/${index}/lineage`, "initial manifest Tickets must use new lineage without predecessors"));
      }
    }
    if ((manifest.retirements?.length ?? 0) > 0) {
      errors.push(error("tickets_lineage_invalid", "/retirements", "initial manifest cannot retire prior Tickets"));
    }
    if (canonicalStringify(reservedTicketIds) !== canonicalStringify(currentTicketIds)) {
      errors.push(error("tickets_lineage_invalid", "/reserved_ticket_ids", "initial reserved Ticket IDs must equal the current Ticket set"));
    }
    return;
  }

  if (!context || typeof context !== "object" || context.kind !== "previous_manifest") {
    errors.push(error("tickets_lineage_invalid", "/previous_manifest_digest", "revised manifest requires exact previous published manifest context"));
    return;
  }
  const suppliedPrevious = context.manifest;
  const parsedPrevious = parseTicketsManifest(context.raw_text);
  const previousRaw = canonicalText(context.raw_text);
  if (!suppliedPrevious || typeof suppliedPrevious !== "object" || Array.isArray(suppliedPrevious)
      || previousRaw === null || !parsedPrevious.manifest || parsedPrevious.errors.length > 0) {
    errors.push(error("tickets_lineage_invalid", "/previous_manifest_digest", "previous manifest context is malformed or non-canonical", {
      parser_errors: parsedPrevious.errors.map((entry) => entry.code),
    }));
    return;
  }
  const previous = parsedPrevious.manifest;
  const previousStringErrors = [];
  validateStringTree(previous, "", previousStringErrors);
  if (validateJsonSchema(previous, schema).length > 0
      || previousStringErrors.length > 0
      || canonicalStringify(previous) !== previousRaw
      || canonicalStringify(previous) !== canonicalStringify(suppliedPrevious)) {
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
  const previousReservedTicketIds = Array.isArray(previous.reserved_ticket_ids) ? previous.reserved_ticket_ids : [];
  const previousReservedTicketIdSet = new Set(previousReservedTicketIds);
  const expectedReservedTicketIds = [...new Set([...previousReservedTicketIds, ...currentTicketIds])].sort(compareCodePoints);
  if (canonicalStringify(reservedTicketIds) !== canonicalStringify(expectedReservedTicketIds)) {
    errors.push(error("tickets_lineage_invalid", "/reserved_ticket_ids", "reserved Ticket IDs must be the cumulative published history plus current IDs", {
      expected: expectedReservedTicketIds,
    }));
  }
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
    const preservesExistingId = ["carry", "revise"].includes(lineage.kind)
      && predecessors.length === 1
      && predecessors[0] === ticket.id;
    if (previousReservedTicketIdSet.has(ticket.id) && !previousById.has(ticket.id)) {
      errors.push(error("tickets_lineage_invalid", `${pointer}/kind`, "a Ticket ID reserved by earlier Epic history cannot be reused", {
        reused_ticket_id: ticket.id,
      }));
    }
    if (previousById.has(ticket.id) && !preservesExistingId) {
      errors.push(error("tickets_lineage_invalid", `${pointer}/kind`, "a prior Ticket ID may only continue through carry or revise of that same Ticket", {
        reused_ticket_id: ticket.id,
      }));
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

function validateTicketsManifestPreflight(manifest, schema, rawText = null) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [error("tickets_manifest_schema_invalid", "", "manifest root must be an object")];
  }
  const shapeErrors = jsonShapeLimitErrors(manifest);
  if (shapeErrors.length > 0) return shapeErrors;

  const schemaErrors = validateJsonSchema(manifest, schema);
  const closedPointers = schemaErrors.some((schemaError) => String(schemaError).endsWith(" is not allowed"))
    ? closedSchemaPropertyPointerMap(manifest, schema)
    : null;
  for (const schemaError of schemaErrors) {
    errors.push(error(
      "tickets_manifest_schema_invalid",
      schemaInstancePathToJsonPointer(schemaError, manifest, schema, closedPointers),
      String(schemaError),
    ));
  }
  validateStringTree(manifest, "", errors);
  const rawTextValue = rawText === null ? null : canonicalText(rawText);
  if (rawText !== null && (rawTextValue === null || canonicalStringify(manifest) !== rawTextValue)) {
    errors.push(error("tickets_manifest_noncanonical", "", "manifest bytes do not equal canonical serialization"));
  }
  if (schemaErrors.length > 0) return errors.sort(errorComparator);

  const rawBytes = rawText === null ? Buffer.byteLength(canonicalStringify(manifest), "utf8") : inputByteLength(rawText);
  const declaredManifestLimit = manifest.policy.limits.max_manifest_bytes;
  if (rawBytes !== null && rawBytes > declaredManifestLimit) {
    errors.push(error("tickets_manifest_limits_exceeded", "", "max_manifest_bytes exceeded", {
      actual: rawBytes,
      limit: declaredManifestLimit,
      limit_name: "max_manifest_bytes",
    }));
  }
  errors.push(...countLimitErrors(manifest));
  return errors.sort(errorComparator);
}

export function validateTicketsManifest(manifest, schema, rawText = null, options = {}) {
  const preflightErrors = validateTicketsManifestPreflight(manifest, schema, rawText);
  if (preflightErrors.some((entry) => entry.code !== "tickets_manifest_noncanonical")) return preflightErrors;
  const errors = [...preflightErrors];

  const tickets = Array.isArray(manifest.tickets) ? manifest.tickets : [];
  const ticketIds = tickets.map((ticket) => ticket?.id).filter((id) => typeof id === "string");
  if (!sortedUnique(ticketIds)) errors.push(error("tickets_id_duplicate", "/tickets", "Ticket IDs must be unique and sorted"));
  const idSet = new Set(ticketIds);
  if (!sortedUnique(Array.isArray(manifest.exclusions) ? manifest.exclusions : [])) {
    errors.push(error("tickets_manifest_noncanonical", "/exclusions", "exclusions must be unique and sorted"));
  }
  const rootRefs = Array.isArray(manifest.governing_artifacts) ? manifest.governing_artifacts.map((entry) => entry.ref_id) : [];
  if (!sortedUnique(rootRefs)) errors.push(error("tickets_governing_ref_invalid", "/governing_artifacts", "governing refs must be unique and sorted"));
  const rootRefSet = new Set(rootRefs);
  const rootArtifactByRef = new Map(Array.isArray(manifest.governing_artifacts)
    ? manifest.governing_artifacts.map((entry) => [entry.ref_id, entry])
    : []);
  for (const [pointer, reference, expectedKind] of [
    ["/policy/review_policy_ref", manifest.policy?.review_policy_ref, "review_policy"],
    ["/policy/verification_policy_ref", manifest.policy?.verification_policy_ref, "verification"],
  ]) {
    if (rootArtifactByRef.get(reference)?.kind !== expectedKind) {
      errors.push(error("tickets_governing_ref_invalid", pointer, `policy ref must resolve to governing kind ${expectedKind}`));
    }
  }
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
    if (!governingRefs.some((reference) => rootArtifactByRef.get(reference)?.kind === "tech_plan")) {
      errors.push(error("tickets_governing_ref_invalid", `${pointer}/governing_refs`, "Planned Ticket must reference Tech Plan authority"));
    }
    if (ticket.review_policy_ref !== manifest.policy?.review_policy_ref) {
      errors.push(error("tickets_governing_ref_invalid", `${pointer}/review_policy_ref`, "Ticket review policy must equal the manifest review policy"));
    }
    const materialDecisionRefs = Array.isArray(ticket.material_decision_refs) ? ticket.material_decision_refs : [];
    if (!sortedUnique(materialDecisionRefs)) {
      errors.push(error("tickets_governing_ref_invalid", `${pointer}/material_decision_refs`, "material decision refs must be unique and sorted"));
    }
    for (const [referenceIndex, reference] of materialDecisionRefs.entries()) {
      if (rootArtifactByRef.get(reference)?.kind !== "decision") {
        errors.push(error("tickets_governing_ref_invalid", `${pointer}/material_decision_refs/${referenceIndex}`, "material decision ref must resolve to governing kind decision"));
      }
    }
    const workContractRefs = Array.isArray(ticket.work_contract_refs) ? ticket.work_contract_refs : [];
    if (!sortedUnique(workContractRefs)) {
      errors.push(error("tickets_governing_ref_invalid", `${pointer}/work_contract_refs`, "work contract refs must be unique and sorted"));
    }
    for (const [referenceIndex, reference] of workContractRefs.entries()) {
      if (rootArtifactByRef.get(reference)?.kind !== "work_contract") {
        errors.push(error("tickets_governing_ref_invalid", `${pointer}/work_contract_refs/${referenceIndex}`, "work contract ref must resolve to governing kind work_contract"));
      }
    }
    const approvalRefs = Array.isArray(ticket.risk_and_rollback?.approval_refs) ? ticket.risk_and_rollback.approval_refs : [];
    if (!sortedUnique(approvalRefs)) {
      errors.push(error("tickets_governing_ref_invalid", `${pointer}/risk_and_rollback/approval_refs`, "approval refs must be unique and sorted"));
    }
    for (const [referenceIndex, reference] of approvalRefs.entries()) {
      if (rootArtifactByRef.get(reference)?.kind !== "decision") {
        errors.push(error("tickets_governing_ref_invalid", `${pointer}/risk_and_rollback/approval_refs/${referenceIndex}`, "approval ref must resolve to governing kind decision"));
      }
    }
    for (const [impactName, impact] of Object.entries(ticket.impacts ?? {}).sort(([left], [right]) => compareCodePoints(left, right))) {
      const impactPaths = Array.isArray(impact?.paths) ? impact.paths : [];
      if (!sortedUnique(impactPaths, selectorComparator)) {
        errors.push(error("tickets_path_invalid", `${pointer}/impacts/${escapePointer(impactName)}/paths`, "impact paths must be unique and sorted by path then kind"));
      }
      const impactPathKeys = new Set();
      for (const [impactPathIndex, impactPath] of impactPaths.entries()) {
        if (!validRelativePath(impactPath?.path)) errors.push(error("tickets_path_invalid", `${pointer}/impacts/${escapePointer(impactName)}/paths/${impactPathIndex}/path`, "invalid impact path"));
        const key = impactPath?.path ? `${collisionKey(impactPath.path)}\0${impactPath.kind}` : `invalid-${impactPathIndex}`;
        if (impactPathKeys.has(key)) errors.push(error("tickets_path_collision", `${pointer}/impacts/${escapePointer(impactName)}/paths/${impactPathIndex}`, "duplicate/colliding impact path"));
        impactPathKeys.add(key);
      }
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
        const bindingPointer = `${criterionPointer}/verification_bindings/${bindingIndex}`;
        const sourceArtifact = rootArtifactByRef.get(binding.source_ref);
        if (!sourceArtifact) {
          errors.push(error("tickets_verification_binding_invalid", `${criterionPointer}/verification_bindings/${bindingIndex}/source_ref`, "verification source ref is not declared"));
        } else if (binding.kind === "manual_acceptance" && sourceArtifact.kind !== "decision") {
          errors.push(error("tickets_verification_binding_invalid", `${bindingPointer}/source_ref`, "manual acceptance must resolve to exact user decision authority"));
        } else if (binding.kind !== "manual_acceptance" && sourceArtifact.kind !== "verification") {
          errors.push(error("tickets_verification_binding_invalid", `${bindingPointer}/source_ref`, "automatable verification binding must resolve to pinned verification authority"));
        }
        if (!sortedUnique(binding.expected_evidence ?? [])) {
          errors.push(error("tickets_verification_binding_invalid", `${criterionPointer}/verification_bindings/${bindingIndex}/expected_evidence`, "evidence classes must be unique and sorted"));
        }
      }
    }
  }

  for (const [retirementIndex, retirement] of (manifest.retirements ?? []).entries()) {
    if (rootArtifactByRef.get(retirement?.decision_ref)?.kind !== "decision") {
      errors.push(error("tickets_governing_ref_invalid", `/retirements/${retirementIndex}/decision_ref`, "retirement decision ref must resolve to governing kind decision"));
    }
  }

  let renderedDocuments = null;
  try {
    renderedDocuments = renderTicketDocuments(manifest);
  } catch (cause) {
    errors.push(error("tickets_rendered_bytes_mismatch", "/rendered_documents", "pinned renderer could not produce the document set", { cause: String(cause) }));
  }
  if (renderedDocuments) {
    const renderedLimits = renderedDocumentLimitConfig(manifest);
    const renderedLimitErrors = [];
    let totalRenderedBytes = 0;
    for (const [documentPath, content] of renderedDocuments.entries()) {
      const renderedBytes = Buffer.byteLength(content, "utf8");
      totalRenderedBytes += renderedBytes;
      pushLimitError(
        renderedLimitErrors,
        `/rendered_documents/${escapePointer(documentPath)}`,
        "max_rendered_document_bytes",
        renderedBytes,
        renderedLimits.maxPerDocumentBytes,
      );
    }
    pushLimitError(
      renderedLimitErrors,
      "/rendered_documents",
      "max_total_rendered_document_bytes",
      totalRenderedBytes,
      renderedLimits.maxTotalBytes,
    );
    if (renderedLimitErrors.length > 0) return [...errors, ...renderedLimitErrors].sort(errorComparator);
    if (!Object.prototype.hasOwnProperty.call(options, "candidateDocuments")) {
      errors.push(error("tickets_rendered_path_missing", "/rendered_documents", "exact candidate rendered document inventory is required"));
    } else {
      errors.push(...compareRenderedTicketDocuments(manifest, options.candidateDocuments));
    }
  }

  const { ordered, cyclic, outgoing } = stableTopologicalOrder(tickets);
  if (cyclic) errors.push(error("tickets_dependency_cycle", "/tickets", "dependency graph contains a cycle"));
  if (canonicalStringify(ordered) !== canonicalStringify(manifest.topological_order ?? [])) {
    errors.push(error("tickets_topological_order_invalid", "/topological_order", "topological_order does not match stable Kahn order", { expected: ordered }));
  }

  const maxOverlapPairs = activeLimit(manifest.policy?.limits?.max_scope_overlap_pairs, ABSOLUTE_MAX_SCOPE_OVERLAP_PAIRS);
  const overlapPairs = collectScopeOverlapPairs(tickets, maxOverlapPairs);
  if (overlapPairs.exceeded) {
    errors.push(error("tickets_manifest_limits_exceeded", "/tickets", "max_scope_overlap_pairs exceeded", {
      actual: overlapPairs.comparisons,
      limit: maxOverlapPairs,
      limit_name: "max_scope_overlap_pairs",
    }));
  } else {
    const isReachable = buildReachabilityLookup(tickets, ordered, outgoing);
    for (const pair of overlapPairs.pairs) {
      const left = tickets[pair.left_index];
      const right = tickets[pair.right_index];
      if (!isReachable(left.id, right.id) && !isReachable(right.id, left.id)) {
        errors.push(error("tickets_scope_overlap_unordered", `/tickets/${pair.right_index}/scope_selectors`, "overlapping Tickets are not transitively ordered", { left: left.id, right: right.id }, [`/tickets/${pair.left_index}/scope_selectors`]));
      }
    }
  }

  validateRevisionLineage(manifest, schema, options.previousManifestContext, errors);
  return errors.sort(errorComparator);
}

export function validateTicketsValidationReceipt(receipt, schema, expectedBindings) {
  const schemaErrors = validateJsonSchema(receipt, schema);
  const closedPointers = schemaErrors.some((schemaError) => String(schemaError).endsWith(" is not allowed"))
    ? closedSchemaPropertyPointerMap(receipt, schema)
    : null;
  const errors = schemaErrors.map((schemaError) => error(
    "tickets_receipt_schema_invalid",
    schemaInstancePathToJsonPointer(schemaError, receipt, schema, closedPointers),
    String(schemaError),
  ));
  if (errors.length > 0) return errors.sort(errorComparator);
  if (!expectedBindings || typeof expectedBindings !== "object" || Array.isArray(expectedBindings)) {
    return [error("tickets_receipt_stale", "", "complete expected receipt bindings are required")];
  }
  if (receipt.record_kind !== "final_validation_receipt") {
    errors.push(error("tickets_receipt_stale", "/record_kind", "final receipt validation cannot accept a pending validation proof"));
  }
  for (const field of TICKETS_RECEIPT_BINDING_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(expectedBindings, field)) {
      errors.push(error("tickets_receipt_stale", `/${escapePointer(field)}`, "expected receipt binding is missing"));
    }
  }
  if (errors.length > 0) return errors.sort(errorComparator);
  const entryIds = receipt.ticket_entry_digests.map((entry) => entry.ticket_id);
  if (!sortedUnique(entryIds)) {
    errors.push(error("tickets_receipt_stale", "/ticket_entry_digests", "receipt Ticket entry digests must be unique and sorted"));
  }
  if (receipt.rendered_documents.length !== receipt.ticket_entry_digests.length + 1) {
    errors.push(error("tickets_receipt_stale", "/rendered_documents", "receipt must contain one overview plus one document per Ticket", {
      rendered_document_count: receipt.rendered_documents.length,
      ticket_entry_count: receipt.ticket_entry_digests.length,
    }));
  }
  for (const field of TICKETS_RECEIPT_BINDING_FIELDS) {
    const expected = expectedBindings[field];
    if (!Object.prototype.hasOwnProperty.call(receipt, field) || canonicalStringify(receipt[field]) !== canonicalStringify(expected)) {
      errors.push(error("tickets_receipt_stale", `/${escapePointer(field)}`, "receipt binding does not match the expected candidate context", {
        actual: receipt[field] ?? null,
        expected,
      }));
    }
  }
  return errors.sort(errorComparator);
}

export function parseTicketsManifest(input, options = {}) {
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

  const hasUtf8Bom = bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    return { manifest: null, text: null, errors: [error("tickets_manifest_noncanonical", "", "manifest is not valid UTF-8", { cause: String(cause) })] };
  }
  if (hasUtf8Bom || text.startsWith("\uFEFF")) errors.push(error("tickets_manifest_noncanonical", "", "UTF-8 BOM is forbidden"));
  if (text.includes("\r")) errors.push(error("tickets_manifest_noncanonical", "", "CR/CRLF is forbidden"));
  const depthError = rawJsonDepthError(text, options.maxJsonDepth ?? ABSOLUTE_MAX_JSON_DEPTH);
  if (depthError) return { manifest: null, text, errors: [...errors, depthError].sort(errorComparator) };
  for (const duplicate of duplicateJsonKeys(text)) {
    errors.push(error("tickets_manifest_json_invalid", duplicate.pointer ?? "", `duplicate JSON key ${duplicate.key}`, { offset: duplicate.offset }));
  }
  let manifest = null;
  let parsedRoot = false;
  try {
    manifest = JSON.parse(text);
    parsedRoot = true;
  } catch (cause) {
    errors.push(error("tickets_manifest_json_invalid", "", "invalid JSON", { cause: String(cause) }));
  }
  if (parsedRoot && (!manifest || typeof manifest !== "object" || Array.isArray(manifest))) {
    errors.push(error("tickets_manifest_schema_invalid", "", "manifest root must be an object"));
    manifest = null;
  } else if (manifest !== null) {
    errors.push(...jsonShapeLimitErrors(manifest, options.maxJsonDepth ?? ABSOLUTE_MAX_JSON_DEPTH));
  }
  return { manifest, text, errors: errors.sort(errorComparator) };
}

export function loadTicketsManifestFiles(root = ROOT) {
  return Object.fromEntries(CONTRACT_FILES.map((relative) => [relative, readFileSync(path.join(root, relative), "utf8")]));
}

export function validateTicketsManifestDesign(files) {
  const errors = [];
  for (const relative of CONTRACT_FILES) {
    if (typeof files[relative] !== "string") errors.push(`${relative}: missing`);
  }
  for (const [relative, markers] of Object.entries(REQUIRED_MARKERS)) {
    const content = files[relative] ?? "";
    for (const marker of markers) if (!content.includes(marker)) errors.push(`${relative}: missing ${marker}`);
  }
  let schema;
  let receiptSchema;
  try {
    schema = JSON.parse(files["resources/tickets-manifest/tickets-manifest.schema.json"]);
    receiptSchema = JSON.parse(files["resources/tickets-manifest/tickets-validation-receipt.schema.json"]);
  } catch (cause) {
    errors.push(`tickets schemas: invalid JSON: ${cause}`);
    return errors.sort(compareCodePoints);
  }
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema" || schema.additionalProperties !== false) {
    errors.push("tickets manifest schema must be closed Draft 2020-12");
  }
  if (receiptSchema.$schema !== "https://json-schema.org/draft/2020-12/schema" || receiptSchema.additionalProperties !== false) {
    errors.push("tickets validation receipt schema must be closed Draft 2020-12");
  }
  const exampleText = files["resources/tickets-manifest/tickets-manifest.example.json"] ?? "";
  const fixtureManifestKey = `${EXAMPLE_CANDIDATE_ROOT_RELATIVE}/${EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH}`;
  const fixtureManifestText = files[fixtureManifestKey] ?? "";
  if (fixtureManifestText !== exampleText) errors.push("example candidate manifest must be byte-identical to the canonical manifest example");
  const parsed = parseTicketsManifest(fixtureManifestText);
  errors.push(...parsed.errors.map((entry) => `manifest example: ${entry.code}: ${entry.message}`));
  if (parsed.manifest && parsed.errors.length === 0) {
    const documents = candidateDocumentsFromContractFiles(files);
    const manifestErrors = validateTicketsManifest(
      parsed.manifest,
      schema,
      fixtureManifestText,
      {
        candidateDocuments: documents,
        previousManifestContext: { kind: "no_prior_publication", publication_history_digest: "0".repeat(64) },
      },
    );
    errors.push(...manifestErrors.map((entry) => `manifest example ${entry.json_pointer || "/"}: ${entry.code}: ${entry.message}`));
    if (manifestErrors.length === 0) {
      if (documents.size !== parsed.manifest.tickets.length + 1) errors.push("candidate fixture does not contain one overview plus one document per Ticket");
      const digests = ticketManifestDigests(parsed.manifest);
      for (const value of [digests.manifest_digest, digests.dag_digest, digests.rendered_document_set_digest, digests.ticket_set_digest]) {
        if (!/^[0-9a-f]{64}$/u.test(value)) errors.push("ticket digest is not SHA-256");
      }
    }
  }
  const tech = files["03-technical-plan.md"] ?? "";
  const core = files["01-core-flows.md"] ?? "";
  for (const reason of ["tickets_manifest_invalid", "tickets_manifest_stale"]) {
    const resumeRow = `| ${reason} |`;
    if (!core.includes(resumeRow)) errors.push(`01-core-flows.md: missing resume contract for ${reason}`);
    if (!tech.includes(resumeRow)) errors.push(`03-technical-plan.md: missing resume contract for ${reason}`);
  }
  if (tech.includes("writes/read-backs immutable `tickets_validation_receipt`, freeze_artifact")) {
    errors.push("03-technical-plan.md: validate_tickets_manifest must not mint the final receipt before freeze");
  }
  if (tech.split("\n").some((line) => line.startsWith("| present_tickets_breakdown |") && line.endsWith("| freeze_artifact |"))) {
    errors.push("03-technical-plan.md: present_tickets_breakdown must not bypass validate_tickets_manifest");
  }
  if (!tech.includes("it never parses rendered Markdown for operational values")) {
    errors.push("03-technical-plan.md: manifest-only dispatcher prohibition is missing");
  }
  return errors.sort(compareCodePoints);
}

export function ticketsManifestDesignDigest(files) {
  const preimage = CONTRACT_FILES
    .slice()
    .sort(compareCodePoints)
    .map((relative) => `${relative}\0${sha256Bytes(files[relative] ?? "")}\0`)
    .join("");
  return domainDigest("autosk-flow/tickets-manifest-design/v1", preimage);
}

function commandLineOptions(argv) {
  const options = { candidateRoot: null, manifestPath: null, noPriorPublicationDigest: null };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name !== "--candidate-root" && name !== "--manifest-path" && name !== "--no-prior-publication-digest") {
      return { error: `unknown command-line argument ${name ?? "<missing>"}`, options };
    }
    if (seen.has(name)) return { error: `duplicate command-line argument ${name}`, options };
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      return { error: `missing value for ${name}`, options };
    }
    seen.add(name);
    if (name === "--candidate-root") options.candidateRoot = value;
    else if (name === "--manifest-path") options.manifestPath = value;
    else options.noPriorPublicationDigest = value;
  }
  return { error: null, options };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMainModule()) {
  const cli = commandLineOptions(process.argv.slice(2));
  if (cli.error !== null) {
    console.error(cli.error);
    process.exitCode = 1;
  } else if (cli.options.candidateRoot !== null || cli.options.manifestPath !== null || cli.options.noPriorPublicationDigest !== null) {
    const { candidateRoot, manifestPath, noPriorPublicationDigest } = cli.options;
    const result = candidateRoot && manifestPath && /^[0-9a-f]{64}$/u.test(noPriorPublicationDigest ?? "")
      ? validateTicketsCandidateTreeResult(candidateRoot, manifestPath, {
        previousManifestContext: { kind: "no_prior_publication", publication_history_digest: noPriorPublicationDigest },
      })
      : { digests: null, errors: [error("tickets_lineage_invalid", "/previous_manifest_digest", "--candidate-root, --manifest-path and a 64-hex --no-prior-publication-digest are required")] };
    const errors = result.errors;
    if (errors.length > 0) {
      console.error(errors.map((entry) => `${entry.json_pointer || "/"}: ${entry.code}: ${entry.message}`).join("\n"));
      process.exitCode = 1;
    } else if (result.digests === null) {
      console.error("/: tickets_manifest_schema_invalid: successful validation did not produce bound digests");
      process.exitCode = 1;
    } else {
      const digests = result.digests;
      console.log("Tickets candidate-tree validation PASS");
      console.log(`manifest_digest=${digests.manifest_digest}`);
      console.log(`dag_digest=${digests.dag_digest}`);
      console.log(`rendered_document_set_digest=${digests.rendered_document_set_digest}`);
      console.log(`ticket_set_digest=${digests.ticket_set_digest}`);
    }
  } else {
    const files = loadTicketsManifestFiles();
    const errors = validateTicketsManifestDesign(files);
    const candidateErrors = validateTicketsCandidateTree(EXAMPLE_CANDIDATE_ROOT, EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH, {
      previousManifestContext: { kind: "no_prior_publication", publication_history_digest: "0".repeat(64) },
    });
    errors.push(...candidateErrors.map((entry) => `example candidate ${entry.json_pointer || "/"}: ${entry.code}: ${entry.message}`));
    if (errors.length > 0) {
      console.error(errors.sort(compareCodePoints).join("\n"));
      process.exitCode = 1;
    } else {
      const manifest = JSON.parse(files["resources/tickets-manifest/tickets-manifest.example.json"]);
      const digests = ticketManifestDigests(manifest);
      console.log("Tickets manifest design validation PASS");
      console.log(`design_digest=${ticketsManifestDesignDigest(files)}`);
      console.log(`manifest_digest=${digests.manifest_digest}`);
      console.log(`dag_digest=${digests.dag_digest}`);
      console.log(`rendered_document_set_digest=${digests.rendered_document_set_digest}`);
      console.log(`ticket_set_digest=${digests.ticket_set_digest}`);
    }
  }
}
