import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateJsonSchema } from "../scripts/validate-planning-ref-design.mjs";
import {
  EXAMPLE_CANDIDATE_CONTRACT_FILES,
  EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH,
  EXAMPLE_CANDIDATE_ROOT,
  EXAMPLE_CANDIDATE_ROOT_RELATIVE,
  MANIFEST_EXAMPLE_PATH,
  MANIFEST_SCHEMA_PATH,
  RECEIPT_SCHEMA_PATH,
  ROOT,
  canonicalStringify,
  compareRenderedTicketDocuments,
  duplicateJsonKeys,
  loadTicketsManifestFiles,
  parseTicketsManifest,
  renderTicketDocuments,
  selectorsOverlap,
  stableTopologicalOrder,
  ticketEntryDigest,
  ticketManifestDigests,
  ticketsManifestDesignDigest,
  validRelativePath,
  validateTicketsCandidateTree,
  validateTicketsManifest,
  validateTicketsManifestDesign,
} from "../scripts/validate-tickets-manifest-design.mjs";

const schema = JSON.parse(readFileSync(MANIFEST_SCHEMA_PATH, "utf8"));
const receiptSchema = JSON.parse(readFileSync(RECEIPT_SCHEMA_PATH, "utf8"));
const exampleText = readFileSync(MANIFEST_EXAMPLE_PATH, "utf8");
const example = JSON.parse(exampleText);

function fixture() {
  return structuredClone(example);
}

function candidateDocumentsFor(manifest) {
  try {
    return renderTicketDocuments(manifest);
  } catch {
    return new Map();
  }
}

function codes(manifest, rawText = null, options = {}) {
  const candidateDocuments = Object.prototype.hasOwnProperty.call(options, "candidateDocuments")
    ? options.candidateDocuments
    : candidateDocumentsFor(manifest);
  return validateTicketsManifest(manifest, schema, rawText, { ...options, candidateDocuments }).map((entry) => entry.code);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

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

test("current Tickets manifest design is internally connected", () => {
  const files = loadTicketsManifestFiles();
  assert.deepEqual(validateTicketsManifestDesign(files), []);
  assert.match(ticketsManifestDesignDigest(files), /^[0-9a-f]{64}$/u);
});

test("canonical example is schema-valid and semantically valid", () => {
  assert.deepEqual(validateJsonSchema(example, schema), []);
  assert.deepEqual(validateTicketsManifest(example, schema, exampleText, { candidateDocuments: renderTicketDocuments(example) }), []);
  assert.equal(canonicalStringify(example), exampleText);
});

test("strict parser detects duplicate JSON keys", () => {
  const text = '{"schema_version":1,"schema_version":1}\n';
  assert.equal(duplicateJsonKeys(text).length, 1);
  assert.deepEqual(parseTicketsManifest(text).errors.map((entry) => entry.code), ["tickets_manifest_json_invalid"]);
});

test("BOM, CRLF and noncanonical key ordering fail closed", () => {
  assert.ok(parseTicketsManifest(`\uFEFF${exampleText}`).errors.some((entry) => entry.code === "tickets_manifest_noncanonical"));
  assert.ok(parseTicketsManifest(exampleText.replaceAll("\n", "\r\n")).errors.some((entry) => entry.code === "tickets_manifest_noncanonical"));
  const parsed = JSON.parse(exampleText);
  const reordered = `{\n  "schema_version": 1,\n${exampleText.slice(2).replace(/^  "schema_version": 1,?\n?/mu, "")}`;
  assert.ok(validateTicketsManifest(parsed, schema, reordered, { candidateDocuments: renderTicketDocuments(parsed) }).some((entry) => entry.code === "tickets_manifest_noncanonical"));
});

test("Ticket IDs must be unique and sorted", () => {
  const duplicate = fixture();
  duplicate.tickets[1].id = "T01";
  assert.ok(codes(duplicate).includes("tickets_id_duplicate"));

  const unsorted = fixture();
  unsorted.tickets.reverse();
  assert.ok(codes(unsorted).includes("tickets_id_duplicate"));
});

test("dangling, self and cyclic dependencies are rejected", () => {
  const dangling = fixture();
  dangling.tickets[1].depends_on = ["T99"];
  dangling.tickets[1].dependency_rationale[0].dependency_id = "T99";
  assert.ok(codes(dangling).includes("tickets_dependency_missing"));

  const self = fixture();
  self.tickets[0].depends_on = ["T01"];
  self.tickets[0].dependency_rationale = [{ dependency_id: "T01", kind: "semantic", reason: "Invalid self edge." }];
  assert.ok(codes(self).includes("tickets_dependency_self"));

  const cycle = fixture();
  cycle.tickets[0].depends_on = ["T02"];
  cycle.tickets[0].dependency_rationale = [{ dependency_id: "T02", kind: "semantic", reason: "Creates a cycle." }];
  assert.ok(codes(cycle).includes("tickets_dependency_cycle"));
});

test("dependency rationale set must exactly match depends_on", () => {
  const manifest = fixture();
  manifest.tickets[1].dependency_rationale = [];
  assert.ok(codes(manifest).includes("tickets_dependency_rationale_mismatch"));
});

test("stable Kahn order uses Ticket ID tie-breaking", () => {
  const manifest = fixture();
  manifest.tickets[1].depends_on = [];
  manifest.tickets[1].dependency_rationale = [];
  assert.deepEqual(stableTopologicalOrder(manifest.tickets).ordered, ["T01", "T02"]);
  manifest.topological_order = ["T02", "T01"];
  assert.ok(codes(manifest).includes("tickets_topological_order_invalid"));
});

test("closed relative path dialect rejects traversal and platform syntax", () => {
  for (const bad of ["../secret", "/absolute", "C:/drive", "src\\file", "src//file", "src/./file", "src/../file", "src\0file"] ) {
    assert.equal(validRelativePath(bad), false, bad);
  }
  assert.equal(validRelativePath("src/session/store.ts"), true);
});

test("scope selector overlap is segment-aware", () => {
  assert.equal(selectorsOverlap({ kind: "directory", path: "src/api" }, { kind: "file", path: "src/api/x.ts" }), true);
  assert.equal(selectorsOverlap({ kind: "directory", path: "src/api" }, { kind: "file", path: "src/apix.ts" }), false);
  assert.equal(selectorsOverlap({ kind: "file", path: "src/a.ts" }, { kind: "file", path: "src/a.ts" }), true);
});

test("incomparable overlapping Tickets are rejected but ordered overlap is valid", () => {
  const unordered = fixture();
  unordered.tickets[1].depends_on = [];
  unordered.tickets[1].dependency_rationale = [];
  unordered.tickets[1].scope_selectors[1] = { kind: "directory", path: "src/session" };
  unordered.tickets[1].scope_selectors.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : 1);
  assert.ok(codes(unordered).includes("tickets_scope_overlap_unordered"));

  const ordered = fixture();
  ordered.tickets[1].scope_selectors[1] = { kind: "directory", path: "src/session" };
  ordered.tickets[1].scope_selectors.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : 1);
  assert.equal(codes(ordered).includes("tickets_scope_overlap_unordered"), false);
});

test("document paths detect wrong Epic, slug and case collisions", () => {
  const wrong = fixture();
  wrong.tickets[0].document_path = "docs/autosk/epics/other/tickets/T01-x.md";
  assert.ok(codes(wrong).includes("tickets_rendered_path_mismatch"));

  const collision = fixture();
  collision.tickets[1].document_path = collision.tickets[0].document_path.toUpperCase();
  assert.ok(codes(collision).includes("tickets_path_collision"));
});

test("acceptance criteria require Ticket namespace and evidence binding", () => {
  const wrongNamespace = fixture();
  wrongNamespace.tickets[0].acceptance_criteria[0].id = "AC-T02-001";
  assert.ok(codes(wrongNamespace).includes("tickets_acceptance_invalid"));

  const missing = fixture();
  missing.tickets[0].acceptance_criteria[0].verification_bindings = [];
  assert.ok(codes(missing).includes("tickets_manifest_schema_invalid"));
});

test("verification and governing references must resolve", () => {
  const manifest = fixture();
  manifest.tickets[0].governing_refs[0] = "brief:missing";
  manifest.tickets[0].acceptance_criteria[0].verification_bindings[0].source_ref = "verification:missing";
  const result = codes(manifest);
  assert.ok(result.includes("tickets_governing_ref_invalid"));
  assert.ok(result.includes("tickets_verification_binding_invalid"));
});

test("Planned Tickets must retain Tech Plan authority", () => {
  const manifest = fixture();
  manifest.tickets[0].governing_refs = manifest.tickets[0].governing_refs.filter((entry) => !entry.startsWith("tech_plan:"));
  assert.ok(codes(manifest).includes("tickets_governing_ref_invalid"));
});

test("initial manifest cannot claim prior lineage or retirements", () => {
  const lineage = fixture();
  lineage.tickets[0].lineage = { kind: "revise", predecessor_ids: ["T01"] };
  assert.ok(codes(lineage).includes("tickets_lineage_invalid"));

  const retirement = fixture();
  retirement.retirements = [{
    decision_ref: "decision:drop",
    disposition: "dropped",
    predecessor_id: "T99",
    rationale: "Invalid on an initial manifest.",
    successor_ids: [],
  }];
  assert.ok(codes(retirement).includes("tickets_lineage_invalid"));
});

test("Git OID width must match declared object format", () => {
  const manifest = fixture();
  manifest.object_format = "sha256";
  assert.ok(codes(manifest).includes("tickets_governing_ref_invalid"));
});

test("resource limits fail before an oversized graph can be accepted", () => {
  const manifest = fixture();
  manifest.policy.limits.max_tickets = 1;
  assert.ok(codes(manifest).includes("tickets_manifest_limits_exceeded"));
});

test("renderer produces one overview and one deterministic document per Ticket", () => {
  const first = renderTicketDocuments(example);
  const second = renderTicketDocuments(structuredClone(example));
  assert.deepEqual([...first], [...second]);
  assert.equal(first.size, example.tickets.length + 1);
  assert.ok(first.has(`docs/autosk/epics/${example.epic_id}/tickets/README.md`));
  assert.match(first.get(example.tickets[0].document_path), /Canonical manifest entry/u);
});

test("domain-separated digests change with manifest, DAG and rendering inputs", () => {
  const baseline = ticketManifestDigests(example);
  const changed = fixture();
  changed.tickets[0].title = "Changed title";
  const next = ticketManifestDigests(changed);
  assert.notEqual(next.manifest_digest, baseline.manifest_digest);
  assert.notEqual(next.rendered_document_set_digest, baseline.rendered_document_set_digest);
  assert.notEqual(next.ticket_set_digest, baseline.ticket_set_digest);
  assert.match(baseline.dag_digest, /^[0-9a-f]{64}$/u);
  assert.equal(baseline.ticket_entry_digests.length, example.tickets.length);
});

test("validation errors have stable pointers and canonical ordering", () => {
  const manifest = fixture();
  manifest.tickets[0].depends_on = ["T99"];
  manifest.tickets[0].dependency_rationale = [];
  const errors = validateTicketsManifest(manifest, schema, null, { candidateDocuments: renderTicketDocuments(manifest) });
  assert.ok(errors.every((entry) => typeof entry.code === "string" && typeof entry.json_pointer === "string"));
  const sorted = [...errors].sort((a, b) => a.json_pointer < b.json_pointer ? -1 : a.json_pointer > b.json_pointer ? 1 : a.code < b.code ? -1 : 1);
  assert.deepEqual(errors.map((entry) => [entry.json_pointer, entry.code]), sorted.map((entry) => [entry.json_pointer, entry.code]));
});

test("validation receipt schema binds exact candidate and tool identities", () => {
  const digests = ticketManifestDigests(example);
  const receipt = {
    alignment_identity: "1".repeat(64),
    anchor_version: 1,
    candidate_tree_oid: "e".repeat(40),
    canonicalizer_version: "autosk-flow/canonical-json/v1",
    dag_digest: digests.dag_digest,
    epic_id: example.epic_id,
    errors: [],
    governance_mapping_set_digest: "2".repeat(64),
    limits_digest: sha256(canonicalStringify(example.policy.limits)),
    manifest_bytes_sha256: digests.manifest_bytes_sha256,
    manifest_digest: digests.manifest_digest,
    manifest_path: `docs/autosk/epics/${example.epic_id}/tickets/tickets.manifest.json`,
    object_format: "sha1",
    operation_id: "22222222-2222-4222-8222-222222222222",
    outcome: "valid",
    planning_parent_commit_oid: "c".repeat(40),
    planning_parent_tree_oid: "d".repeat(40),
    project_instruction_digest: "3".repeat(64),
    project_root_sha256: "4".repeat(64),
    protocol_digest: "5".repeat(64),
    rendered_document_set_digest: digests.rendered_document_set_digest,
    rendered_documents: digests.rendered_documents,
    renderer_distribution_digest: "6".repeat(64),
    renderer_version: "autosk-flow/ticket-markdown/v1",
    runtime_lock_digest: "7".repeat(64),
    schema_id: "https://autosk-flow.invalid/schemas/tickets-manifest.v1.json",
    schema_sha256: sha256(readFileSync(MANIFEST_SCHEMA_PATH)),
    schema_version: 1,
    ticket_entry_digests: digests.ticket_entry_digests,
    ticket_set_digest: digests.ticket_set_digest,
    validated_at_utc: "2026-09-03T12:00:00Z",
    validator_distribution_digest: "8".repeat(64),
  };
  assert.deepEqual(validateJsonSchema(receipt, receiptSchema), []);
  receipt.candidate_tree_oid = "e".repeat(64);
  assert.notDeepEqual(validateJsonSchema(receipt, receiptSchema), []);
});


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


test("manifest validation requires an exact candidate document inventory", () => {
  const errors = validateTicketsManifest(example, schema, exampleText);
  assert.ok(errors.some((entry) => entry.code === "tickets_rendered_path_missing"));
});

test("design validation consumes committed candidate files rather than renderer self-output", () => {
  const files = loadTicketsManifestFiles();
  const readme = EXAMPLE_CANDIDATE_CONTRACT_FILES.find((relative) => relative.endsWith("/README.md"));
  files[readme] = `${files[readme]}drift`;
  assert.ok(validateTicketsManifestDesign(files).some((entry) => entry.includes("tickets_rendered_bytes_mismatch")));
});

test("candidate-tree API and CLI reject on-disk Markdown drift", () => {
  assert.deepEqual(validateTicketsCandidateTree(EXAMPLE_CANDIDATE_ROOT, EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH), []);
  const temporaryParent = mkdtempSync(path.join(tmpdir(), "autosk-ticket-candidate-"));
  const temporaryRoot = path.join(temporaryParent, "candidate");
  try {
    cpSync(EXAMPLE_CANDIDATE_ROOT, temporaryRoot, { recursive: true });
    const readmeRelative = path.posix.join(path.posix.dirname(EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH), "README.md");
    const readmePath = path.join(temporaryRoot, ...readmeRelative.split("/"));
    writeFileSync(readmePath, `${readFileSync(readmePath, "utf8")}one-byte-drift`);

    const directErrors = validateTicketsCandidateTree(temporaryRoot, EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH);
    assert.ok(directErrors.some((entry) => entry.code === "tickets_rendered_bytes_mismatch"));

    const result = spawnSync(process.execPath, [
      path.join(ROOT, "scripts/validate-tickets-manifest-design.mjs"),
      "--candidate-root",
      temporaryRoot,
      "--manifest-path",
      EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH,
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tickets_rendered_bytes_mismatch/u);
  } finally {
    rmSync(temporaryParent, { force: true, recursive: true });
  }
});

test("candidate-tree inventory rejects missing, extra, renamed and non-regular files on disk", () => {
  const temporaryParent = mkdtempSync(path.join(tmpdir(), "autosk-ticket-inventory-"));
  const temporaryRoot = path.join(temporaryParent, "candidate");
  const directoryRelative = path.posix.dirname(EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH);
  try {
    cpSync(EXAMPLE_CANDIDATE_ROOT, temporaryRoot, { recursive: true });
    const readme = path.join(temporaryRoot, ...`${directoryRelative}/README.md`.split("/"));
    const renamed = path.join(temporaryRoot, ...`${directoryRelative}/RENAMED.md`.split("/"));
    const original = readFileSync(readme);
    rmSync(readme);
    writeFileSync(renamed, original);
    writeFileSync(path.join(temporaryRoot, ...`${directoryRelative}/EXTRA.md`.split("/")), "extra\n");
    const errors = validateTicketsCandidateTree(temporaryRoot, EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH);
    const errorCodes = errors.map((entry) => entry.code);
    assert.ok(errorCodes.includes("tickets_rendered_path_renamed"));
    assert.ok(errorCodes.includes("tickets_rendered_path_extra"));
  } finally {
    rmSync(temporaryParent, { force: true, recursive: true });
  }
});


test("Schema errors expose the smallest RFC 6901 instance pointer", () => {
  const manifest = fixture();
  manifest.tickets[0].unexpected_field = true;
  const errors = validateTicketsManifest(manifest, schema, null, { candidateDocuments: renderTicketDocuments(manifest) });
  const schemaError = errors.find((entry) => entry.code === "tickets_manifest_schema_invalid" && entry.message.includes("unexpected_field"));
  assert.equal(schemaError?.json_pointer, "/tickets/0/unexpected_field");
});

test("initial manifest revision is exactly one", () => {
  const manifest = fixture();
  manifest.manifest_revision = 2;
  assert.ok(codes(manifest).includes("tickets_lineage_invalid"));
});

test("revision lineage never reuses another prior Ticket ID", () => {
  const previous = fixture();
  const replacement = structuredClone(previous.tickets[1]);
  replacement.id = "T01";
  replacement.document_path = `docs/autosk/epics/${previous.epic_id}/tickets/T01-reused.md`;
  replacement.depends_on = [];
  replacement.dependency_rationale = [];
  replacement.acceptance_criteria = replacement.acceptance_criteria.map((criterion, index) => ({
    ...criterion,
    id: `AC-T01-${String(index + 1).padStart(3, "0")}`,
  }));
  replacement.lineage = { kind: "replace", predecessor_ids: ["T02"] };
  const current = makeRevision(previous, [replacement], [{
    decision_ref: "decision:retire-original-t01",
    disposition: "dropped",
    predecessor_id: "T01",
    rationale: "Attempt to retire the original T01 while reusing its ID.",
    successor_ids: [],
  }]);
  assert.ok(codes(current, canonicalStringify(current), {
    previousManifestContext: previousManifestContext(previous),
  }).includes("tickets_lineage_invalid"));
});

test("previous manifest context rejects BOM and non-NFC bytes", () => {
  const previous = fixture();
  const tickets = previous.tickets.map((ticket) => ({
    ...structuredClone(ticket),
    lineage: { kind: "carry", predecessor_ids: [ticket.id] },
  }));
  const current = makeRevision(previous, tickets);

  const bomContext = previousManifestContext(previous);
  bomContext.raw_text = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(bomContext.raw_text)]);
  assert.ok(codes(current, canonicalStringify(current), { previousManifestContext: bomContext }).includes("tickets_lineage_invalid"));

  const nonNfcPrevious = structuredClone(previous);
  nonNfcPrevious.goal = "Cafe\u0301 session delivery";
  const nonNfcContext = previousManifestContext(nonNfcPrevious);
  const nonNfcCurrentTickets = nonNfcPrevious.tickets.map((ticket) => ({
    ...structuredClone(ticket),
    lineage: { kind: "carry", predecessor_ids: [ticket.id] },
  }));
  const nonNfcCurrent = makeRevision(nonNfcPrevious, nonNfcCurrentTickets);
  assert.ok(codes(nonNfcCurrent, canonicalStringify(nonNfcCurrent), {
    previousManifestContext: nonNfcContext,
  }).includes("tickets_lineage_invalid"));
});

test("candidate-tree validation rejects a symlinked ancestor inside the candidate root", () => {
  const temporaryParent = mkdtempSync(path.join(tmpdir(), "autosk-ticket-ancestor-"));
  const outsideRoot = path.join(temporaryParent, "outside");
  const candidateRoot = path.join(temporaryParent, "candidate");
  try {
    cpSync(EXAMPLE_CANDIDATE_ROOT, outsideRoot, { recursive: true });
    mkdirSync(candidateRoot);
    symlinkSync(path.join(outsideRoot, "docs"), path.join(candidateRoot, "docs"), "dir");
    const errors = validateTicketsCandidateTree(candidateRoot, EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH);
    assert.ok(errors.some((entry) => entry.code === "tickets_path_invalid"));
  } finally {
    rmSync(temporaryParent, { force: true, recursive: true });
  }
});

test("schema-invalid nested shapes fail closed before semantic routines", () => {
  for (const mutate of [
    (manifest) => { manifest.governing_artifacts = {}; },
    (manifest) => { manifest.tickets = [null]; },
    (manifest) => { manifest.tickets[0].acceptance_criteria[0].verification_bindings = {}; },
  ]) {
    const manifest = fixture();
    mutate(manifest);
    let result;
    assert.doesNotThrow(() => {
      result = validateTicketsManifest(manifest, schema, canonicalStringify(manifest), { candidateDocuments: new Map() });
    });
    assert.ok(result.some((entry) => entry.code === "tickets_manifest_schema_invalid"));
    assert.equal(result.some((entry) => entry.code.startsWith("tickets_rendered_")), false);
  }
});

test("scope overlap uses the conservative case-collision policy", () => {
  const manifest = fixture();
  manifest.tickets[0].scope_selectors = [{ kind: "file", path: "src/CaseSensitive.ts" }];
  manifest.tickets[1].scope_selectors = [{ kind: "file", path: "src/casesensitive.ts" }];
  manifest.tickets[1].depends_on = [];
  manifest.tickets[1].dependency_rationale = [];
  manifest.topological_order = stableTopologicalOrder(manifest.tickets).ordered;
  assert.ok(codes(manifest).includes("tickets_scope_overlap_unordered"));
});

test("renderer prevents heading and table-cell structure injection", () => {
  const manifest = fixture();
  manifest.goal = "Project goal.\n## Forged overview heading";
  manifest.tickets[0].title = "Left | Right\ncontinued";
  manifest.tickets[0].goal = "Goal | second column\n## Forged Ticket heading";
  const documents = renderTicketDocuments(manifest);
  const overview = documents.get(`docs/autosk/epics/${manifest.epic_id}/tickets/README.md`);
  const ticket = documents.get(manifest.tickets[0].document_path);
  assert.match(overview, /Project goal\. ## Forged overview heading/u);
  assert.match(overview, /Left &#124; Right continued/u);
  assert.match(overview, /Goal &#124; second column ## Forged Ticket heading/u);
  assert.match(ticket, /^# T01 — Left \| Right continued$/mu);
  assert.match(ticket, /^Goal \| second column ## Forged Ticket heading$/mu);
  assert.doesNotMatch(overview, /^## Forged overview heading$/mu);
  assert.doesNotMatch(ticket, /^## Forged Ticket heading$/mu);
  assert.doesNotMatch(ticket, /^continued$/mu);
});

test("candidate-tree stops after strict parser errors", () => {
  const temporaryParent = mkdtempSync(path.join(tmpdir(), "autosk-ticket-parser-"));
  const candidateRoot = path.join(temporaryParent, "candidate");
  try {
    cpSync(EXAMPLE_CANDIDATE_ROOT, candidateRoot, { recursive: true });
    const manifestPath = path.join(candidateRoot, ...EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH.split("/"));
    const bytes = readFileSync(manifestPath);
    writeFileSync(manifestPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]));
    const errors = validateTicketsCandidateTree(candidateRoot, EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH);
    assert.ok(errors.some((entry) => entry.code === "tickets_manifest_noncanonical"));
    assert.equal(errors.some((entry) => entry.code.startsWith("tickets_rendered_")), false);
  } finally {
    rmSync(temporaryParent, { force: true, recursive: true });
  }
});

test("candidate files are size-checked before normal validation", () => {
  const manifestBytes = readFileSync(path.join(EXAMPLE_CANDIDATE_ROOT, ...EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH.split("/")));
  const manifestErrors = validateTicketsCandidateTree(
    EXAMPLE_CANDIDATE_ROOT,
    EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH,
    { maxManifestBytes: manifestBytes.byteLength - 1 },
  );
  assert.ok(manifestErrors.some((entry) => entry.code === "tickets_manifest_limits_exceeded"));

  const temporaryParent = mkdtempSync(path.join(tmpdir(), "autosk-ticket-size-"));
  const candidateRoot = path.join(temporaryParent, "candidate");
  try {
    cpSync(EXAMPLE_CANDIDATE_ROOT, candidateRoot, { recursive: true });
    const manifestPath = path.join(candidateRoot, ...EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH.split("/"));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.policy.limits.max_rendered_document_bytes = 1024;
    writeFileSync(manifestPath, canonicalStringify(manifest));
    const readmePath = path.join(candidateRoot, ...path.posix.join(path.posix.dirname(EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH), "README.md").split("/"));
    writeFileSync(readmePath, "x".repeat(1025));
    const errors = validateTicketsCandidateTree(candidateRoot, EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH);
    assert.ok(errors.some((entry) => entry.code === "tickets_manifest_limits_exceeded"));
  } finally {
    rmSync(temporaryParent, { force: true, recursive: true });
  }
});
