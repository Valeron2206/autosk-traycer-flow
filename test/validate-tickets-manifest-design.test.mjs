import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateJsonSchema } from "../scripts/validate-planning-ref-design.mjs";
import {
  MANIFEST_EXAMPLE_PATH,
  MANIFEST_SCHEMA_PATH,
  RECEIPT_SCHEMA_PATH,
  canonicalStringify,
  duplicateJsonKeys,
  loadTicketsManifestFiles,
  parseTicketsManifest,
  renderTicketDocuments,
  selectorsOverlap,
  stableTopologicalOrder,
  ticketManifestDigests,
  ticketsManifestDesignDigest,
  validRelativePath,
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

function codes(manifest, rawText = null) {
  return validateTicketsManifest(manifest, schema, rawText).map((entry) => entry.code);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("current Tickets manifest design is internally connected", () => {
  const files = loadTicketsManifestFiles();
  assert.deepEqual(validateTicketsManifestDesign(files), []);
  assert.match(ticketsManifestDesignDigest(files), /^[0-9a-f]{64}$/u);
});

test("canonical example is schema-valid and semantically valid", () => {
  assert.deepEqual(validateJsonSchema(example, schema), []);
  assert.deepEqual(validateTicketsManifest(example, schema, exampleText), []);
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
  assert.ok(validateTicketsManifest(parsed, schema, reordered).some((entry) => entry.code === "tickets_manifest_noncanonical"));
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
  assert.ok(codes(missing).includes("tickets_verification_binding_invalid"));
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
  const errors = validateTicketsManifest(manifest, schema);
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
