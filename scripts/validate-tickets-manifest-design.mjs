#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_SCHEMA_PATH = path.join(ROOT, "resources/tickets-manifest/tickets-manifest.schema.json");
export const MANIFEST_EXAMPLE_PATH = path.join(ROOT, "resources/tickets-manifest/tickets-manifest.example.json");
export const RECEIPT_SCHEMA_PATH = path.join(ROOT, "resources/tickets-manifest/tickets-validation-receipt.schema.json");
export const ABSOLUTE_MAX_MANIFEST_BYTES = 16_777_216;
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
    "tickets_manifest_invalid",
    "tickets_manifest_stale",
  ],
  "04-decisions.md": ["ADR-027: canonical machine-readable Tickets manifest", "tickets.manifest.json"],
  "CONTRIBUTING.md": ["docs/contracts/tickets-manifest.md", "npm run validate:tickets-manifest"],
  "docs/contracts/tickets-manifest.md": [
    "<!-- tickets-manifest-contract:v1 -->",
    "autosk-flow/canonical-json/v1",
    "TicketsValidationReceipt",
    "tickets_scope_overlap_unordered",
    "dispatch_ticket_dag",
    "Issue #7",
    "Issue #8",
    "Issue #9",
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

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value && typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort(compareCodePoints)) output[key] = sortCanonical(value[key]);
    return output;
  }
  return value;
}

export function canonicalStringify(value) {
  return `${JSON.stringify(sortCanonical(value), null, 2)}\n`;
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
        if (current.keys.has(key)) duplicates.push({ key, offset: start });
        else current.keys.add(key);
      }
      continue;
    }
    if (character === "{") stack.push({ kind: "object", keys: new Set() });
    else if (character === "[") stack.push({ kind: "array" });
    else if (character === "}" || character === "]") stack.pop();
    index += 1;
  }
  return duplicates;
}

function error(code, jsonPointer, message, evidence = {}, relatedPointers = []) {
  return { code, json_pointer: jsonPointer, message, related_pointers: relatedPointers, evidence };
}

function errorComparator(left, right) {
  return compareCodePoints(left.json_pointer, right.json_pointer)
    || compareCodePoints(left.code, right.code)
    || compareCodePoints(canonicalStringify(left.evidence), canonicalStringify(right.evidence));
}

function schemaInstancePathToJsonPointer(schemaError) {
  const match = String(schemaError).match(/^(\$(?:\.[^.[\]\s]+|\[[0-9]+\])*)/u);
  if (!match) return "";
  const segments = [];
  for (const token of match[1].matchAll(/\.([^.[\]]+)|\[([0-9]+)\]/gu)) {
    segments.push(escapePointer(token[1] ?? token[2]));
  }
  return segments.length === 0 ? "" : `/${segments.join("/")}`;
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

function markdownTableCell(value) {
  return oneLine(value).replaceAll("|", "&#124;");
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
    "<!-- generated-by: autosk-flow/ticket-markdown/v1 -->",
    "",
    "# Tickets",
    "",
    manifest.goal,
    "",
    "## Stable execution order",
    "",
    manifest.topological_order.map((id, index) => `${index + 1}. ${id}`).join("\n"),
    "",
    "## Ticket set",
    "",
    "| ID | Work type | Work type | Depends on | Goal |".replace("| Work type | Work type |", "| Title | Work type |"),
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## Exclusions",
    "",
    ...(manifest.exclusions.length > 0 ? manifest.exclusions.map((item) => `- ${oneLine(item)}`) : ["- None."]),
    "",
  ].join("\n"));

  for (const ticket of manifest.tickets) {
    const entry = canonicalStringify(ticket).trimEnd();
    const fence = markdownFence(entry);
    documents.set(ticket.document_path, [
      "<!-- generated-by: autosk-flow/ticket-markdown/v1 -->",
      "",
      `# ${ticket.id} — ${oneLine(ticket.title)}`,
      "",
      `**Work type:** ${ticket.work_type}`,
      "",
      `**Depends on:** ${ticket.depends_on.join(", ") || "none"}`,
      "",
      "## Goal",
      "",
      ticket.goal,
      "",
      "## Acceptance criteria",
      "",
      ...ticket.acceptance_criteria.map((criterion) => `- **${criterion.id}:** ${oneLine(criterion.text)}`),
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

function regularFileBytes(candidateRoot, relativePath, errors, pointer, maxBytes = null, limitName = null) {
  const resolved = resolveInsideCandidateRoot(candidateRoot, relativePath);
  if (!resolved) {
    errors.push(error("tickets_path_invalid", pointer, "candidate path escapes, traverses a symlink/non-directory ancestor, or is outside the closed relative-path dialect", { path: relativePath }));
    return null;
  }
  try {
    const metadata = lstatSync(resolved.absolutePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      errors.push(error("tickets_path_invalid", pointer, "candidate path is not a regular non-symlink file", { path: relativePath }));
      return null;
    }
    if (Number.isInteger(maxBytes) && metadata.size > maxBytes) {
      errors.push(error("tickets_manifest_limits_exceeded", pointer, `${limitName ?? "file byte limit"} exceeded before read`, {
        actual: metadata.size,
        limit: maxBytes,
        limit_name: limitName,
        path: relativePath,
      }));
      return null;
    }
    const bytes = readFileSync(resolved.absolutePath);
    if (Number.isInteger(maxBytes) && bytes.byteLength > maxBytes) {
      errors.push(error("tickets_manifest_limits_exceeded", pointer, `${limitName ?? "file byte limit"} exceeded during read`, {
        actual: bytes.byteLength,
        limit: maxBytes,
        limit_name: limitName,
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
  }
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
  let entries;
  try {
    rootMetadata = lstatSync(resolved.absoluteRoot);
    directoryMetadata = lstatSync(resolved.absolutePath);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      throw new Error("candidate root is not a regular directory");
    }
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      throw new Error("Tickets path is not a regular directory");
    }
    entries = readdirSync(resolved.absolutePath, { withFileTypes: true })
      .sort((left, right) => compareCodePoints(left.name, right.name));
  } catch (cause) {
    return {
      documents,
      errors: [error("tickets_rendered_path_missing", "/rendered_documents", "candidate Tickets directory is missing or unreadable", {
        cause: String(cause),
        path: directoryPath,
      })],
    };
  }

  for (const [index, entry] of entries.entries()) {
    const relativePath = `${directoryPath}/${entry.name}`;
    const pointer = `/rendered_documents/${index}`;
    if (entry.name === "tickets.manifest.json") continue;
    if (entry.isSymbolicLink() || !entry.isFile()) {
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
      manifest.policy?.limits?.max_rendered_document_bytes,
      "max_rendered_document_bytes",
    );
    if (bytes !== null) documents.set(relativePath, bytes);
  }
  return { documents, errors: errors.sort(errorComparator) };
}

export function validateTicketsCandidateTree(candidateRoot, manifestRelativePath, options = {}) {
  const errors = [];
  let schema = options.schema;
  if (!schema) {
    try {
      schema = JSON.parse(readFileSync(options.schemaPath ?? MANIFEST_SCHEMA_PATH, "utf8"));
    } catch (cause) {
      return [error("tickets_manifest_schema_invalid", "", "Tickets manifest Schema is missing or invalid", { cause: String(cause) })];
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
  if (rawBytes === null) return errors.sort(errorComparator);
  const parsed = parseTicketsManifest(rawBytes, { maxManifestBytes: requestedManifestLimit });
  errors.push(...parsed.errors);
  if (!parsed.manifest || parsed.errors.length > 0) return errors.sort(errorComparator);

  const expectedManifestPath = `docs/autosk/epics/${parsed.manifest.epic_id}/tickets/tickets.manifest.json`;
  if (manifestRelativePath !== expectedManifestPath) {
    errors.push(error("tickets_rendered_path_mismatch", "/manifest_path", "manifest path does not match its exact Epic identity", {
      actual: manifestRelativePath,
      expected: expectedManifestPath,
    }));
  }

  const inventory = loadCandidateTicketDocuments(candidateRoot, parsed.manifest);
  errors.push(...inventory.errors);
  errors.push(...validateTicketsManifest(parsed.manifest, schema, rawBytes, {
    candidateDocuments: inventory.documents,
    previousManifestContext: options.previousManifestContext,
  }));
  return errors.sort(errorComparator);
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
  if (manifest.previous_manifest_digest === null) {
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
    return;
  }

  if (!context || typeof context !== "object") {
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

export function validateTicketsManifest(manifest, schema, rawText = null, options = {}) {
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

  const countErrors = countLimitErrors(manifest);
  if (countErrors.length > 0) return [...errors, ...countErrors].sort(errorComparator);

  const schemaErrors = validateJsonSchema(manifest, schema);
  for (const schemaError of schemaErrors) {
    errors.push(error(
      "tickets_manifest_schema_invalid",
      schemaInstancePathToJsonPointer(schemaError),
      String(schemaError),
    ));
  }
  validateStringTree(manifest, "", errors);
  const rawTextValue = rawText === null ? null : canonicalText(rawText);
  if (rawText !== null && (rawTextValue === null || canonicalStringify(manifest) !== rawTextValue)) {
    errors.push(error("tickets_manifest_noncanonical", "", "manifest bytes do not equal canonical serialization"));
  }
  if (schemaErrors.length > 0) return errors.sort(errorComparator);

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
  if (parsed.manifest) {
    const documents = candidateDocumentsFromContractFiles(files);
    errors.push(...validateTicketsManifest(
      parsed.manifest,
      schema,
      fixtureManifestText,
      { candidateDocuments: documents },
    ).map((entry) => `manifest example ${entry.json_pointer || "/"}: ${entry.code}: ${entry.message}`));
    if (documents.size !== parsed.manifest.tickets.length + 1) errors.push("candidate fixture does not contain one overview plus one document per Ticket");
    const digests = ticketManifestDigests(parsed.manifest);
    for (const value of [digests.manifest_digest, digests.dag_digest, digests.rendered_document_set_digest, digests.ticket_set_digest]) {
      if (!/^[0-9a-f]{64}$/u.test(value)) errors.push("ticket digest is not SHA-256");
    }
  }
  const tech = files["03-technical-plan.md"] ?? "";
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

function commandLineOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const candidateRoot = commandLineOption("--candidate-root");
  const manifestPath = commandLineOption("--manifest-path");
  if (candidateRoot !== null || manifestPath !== null) {
    const errors = candidateRoot && manifestPath
      ? validateTicketsCandidateTree(candidateRoot, manifestPath)
      : [error("tickets_path_invalid", "/manifest_path", "--candidate-root and --manifest-path are both required")];
    if (errors.length > 0) {
      console.error(errors.map((entry) => `${entry.json_pointer || "/"}: ${entry.code}: ${entry.message}`).join("\n"));
      process.exitCode = 1;
    } else {
      const raw = readFileSync(path.join(path.resolve(candidateRoot), ...manifestPath.split("/")));
      const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      const digests = ticketManifestDigests(manifest);
      console.log("Tickets candidate-tree validation PASS");
      console.log(`manifest_digest=${digests.manifest_digest}`);
      console.log(`dag_digest=${digests.dag_digest}`);
      console.log(`rendered_document_set_digest=${digests.rendered_document_set_digest}`);
      console.log(`ticket_set_digest=${digests.ticket_set_digest}`);
    }
  } else {
    const files = loadTicketsManifestFiles();
    const errors = validateTicketsManifestDesign(files);
    const candidateErrors = validateTicketsCandidateTree(EXAMPLE_CANDIDATE_ROOT, EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH);
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
