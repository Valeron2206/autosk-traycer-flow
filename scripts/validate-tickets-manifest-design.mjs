#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_SCHEMA_PATH = path.join(ROOT, "resources/tickets-manifest/tickets-manifest.schema.json");
export const MANIFEST_EXAMPLE_PATH = path.join(ROOT, "resources/tickets-manifest/tickets-manifest.example.json");
export const RECEIPT_SCHEMA_PATH = path.join(ROOT, "resources/tickets-manifest/tickets-validation-receipt.schema.json");

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
  if (selector.kind === "file") return selector.path === candidatePath;
  return candidatePath === selector.path || candidatePath.startsWith(`${selector.path}/`);
}

export function selectorsOverlap(left, right) {
  if (left.kind === "file" && right.kind === "file") return left.path === right.path;
  if (left.kind === "file") return selectorContains(right, left.path);
  if (right.kind === "file") return selectorContains(left, right.path);
  return selectorContains(left, right.path) || selectorContains(right, left.path);
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

export function renderTicketDocuments(manifest) {
  const root = `docs/autosk/epics/${manifest.epic_id}/tickets`;
  const documents = new Map();
  const rows = manifest.tickets.map((ticket) =>
    `| ${ticket.id} | ${oneLine(ticket.title)} | ${ticket.work_type} | ${ticket.depends_on.join(", ") || "—"} | ${oneLine(ticket.goal)} |`,
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
      `# ${ticket.id} — ${ticket.title}`,
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

export function ticketManifestDigests(manifest) {
  const canonicalManifest = canonicalStringify(manifest);
  const manifestDigest = domainDigest("autosk-flow/tickets-manifest/v1", canonicalManifest);
  const ticketEntryDigests = manifest.tickets.map((ticket) => ({
    ticket_id: ticket.id,
    digest: domainDigest("autosk-flow/ticket-entry/v1", canonicalStringify(ticket)),
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

export function validateTicketsManifest(manifest, schema, rawText = null) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [error("tickets_manifest_schema_invalid", "", "manifest root must be an object")];
  }
  for (const schemaError of validateJsonSchema(manifest, schema)) {
    errors.push(error("tickets_manifest_schema_invalid", "", String(schemaError)));
  }
  validateStringTree(manifest, "", errors);
  if (rawText !== null && canonicalStringify(manifest) !== rawText) {
    errors.push(error("tickets_manifest_noncanonical", "", "manifest bytes do not equal canonical serialization"));
  }

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
  let totalEdges = 0;
  for (const [index, ticket] of tickets.entries()) {
    const pointer = `/tickets/${index}`;
    if (!ticket || typeof ticket !== "object") continue;
    const dependencies = Array.isArray(ticket.depends_on) ? ticket.depends_on : [];
    totalEdges += dependencies.length;
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

    if (manifest.previous_manifest_digest === null) {
      if (ticket.lineage?.kind !== "new" || (ticket.lineage?.predecessor_ids?.length ?? 0) !== 0) {
        errors.push(error("tickets_lineage_invalid", `${pointer}/lineage`, "initial manifest Tickets must use new lineage without predecessors"));
      }
    }
  }

  const limits = manifest.policy?.limits ?? {};
  if (tickets.length > (limits.max_tickets ?? Number.MAX_SAFE_INTEGER)
      || totalEdges > (limits.max_total_edges ?? Number.MAX_SAFE_INTEGER)) {
    errors.push(error("tickets_manifest_limits_exceeded", "/tickets", "Ticket or edge limit exceeded"));
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

  if (manifest.previous_manifest_digest === null && (manifest.retirements?.length ?? 0) > 0) {
    errors.push(error("tickets_lineage_invalid", "/retirements", "initial manifest cannot retire prior Tickets"));
  }

  return errors.sort(errorComparator);
}

export function parseTicketsManifest(text) {
  const errors = [];
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
  return { manifest, errors: errors.sort(errorComparator) };
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
  const parsed = parseTicketsManifest(files["resources/tickets-manifest/tickets-manifest.example.json"] ?? "");
  errors.push(...parsed.errors.map((entry) => `manifest example: ${entry.code}: ${entry.message}`));
  if (parsed.manifest) {
    errors.push(...validateTicketsManifest(parsed.manifest, schema, files["resources/tickets-manifest/tickets-manifest.example.json"])
      .map((entry) => `manifest example ${entry.json_pointer || "/"}: ${entry.code}: ${entry.message}`));
    const documents = renderTicketDocuments(parsed.manifest);
    if (documents.size !== parsed.manifest.tickets.length + 1) errors.push("renderer did not produce one overview plus one document per Ticket");
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = loadTicketsManifestFiles();
  const errors = validateTicketsManifestDesign(files);
  if (errors.length > 0) {
    console.error(errors.join("\n"));
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
