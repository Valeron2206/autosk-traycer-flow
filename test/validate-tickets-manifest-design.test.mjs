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
  TICKETS_RECEIPT_BINDING_FIELDS,
  canonicalStringify,
  compareRenderedTicketDocuments,
  duplicateJsonKeys,
  loadTicketsManifestFiles,
  loadCandidateTicketDocuments,
  parseTicketsManifest,
  renderTicketDocuments,
  selectorsOverlap,
  stableTopologicalOrder,
  ticketEntryDigest,
  ticketLimitsDigest,
  ticketManifestDigests,
  ticketsManifestDesignDigest,
  validRelativePath,
  validateTicketsCandidateTree as validateTicketsCandidateTreeRaw,
  validateTicketsCandidateGitTree as validateTicketsCandidateGitTreeRaw,
  validateTicketsCandidateTreeResult as validateTicketsCandidateTreeResultRaw,
  validateTicketsManifest as validateTicketsManifestRaw,
  validateTicketsManifestDesign,
  validateTicketsValidationReceipt,
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
  const previousManifestContextValue = Object.hasOwn(options, "previousManifestContext")
    ? options.previousManifestContext
    : noPriorPublicationContext();
  return validateTicketsManifest(manifest, schema, rawText, {
    ...options,
    candidateDocuments,
    previousManifestContext: previousManifestContextValue,
  }).map((entry) => entry.code);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runGit(repositoryRoot, args) {
  const result = spawnSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      TZ: "UTC",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function previousManifestContext(previous) {
  const digests = ticketManifestDigests(previous);
  return {
    kind: "previous_manifest",
    manifest: structuredClone(previous),
    raw_text: canonicalStringify(previous),
    manifest_digest: digests.manifest_digest,
    ticket_entry_digests: digests.ticket_entry_digests,
  };
}

function noPriorPublicationContext() {
  return {
    kind: "no_prior_publication",
    publication_history_digest: "0".repeat(64),
  };
}

function validateTicketsManifest(manifest, schemaValue, rawText = null, options = {}) {
  return validateTicketsManifestRaw(manifest, schemaValue, rawText, {
    ...options,
    previousManifestContext: Object.hasOwn(options, "previousManifestContext")
      ? options.previousManifestContext
      : noPriorPublicationContext(),
  });
}

function validateTicketsCandidateTree(candidateRoot, manifestRelativePath, options = {}) {
  return validateTicketsCandidateTreeRaw(candidateRoot, manifestRelativePath, {
    ...options,
    previousManifestContext: Object.hasOwn(options, "previousManifestContext")
      ? options.previousManifestContext
      : noPriorPublicationContext(),
  });
}

function validateTicketsCandidateTreeResult(candidateRoot, manifestRelativePath, options = {}) {
  return validateTicketsCandidateTreeResultRaw(candidateRoot, manifestRelativePath, {
    ...options,
    previousManifestContext: Object.hasOwn(options, "previousManifestContext")
      ? options.previousManifestContext
      : noPriorPublicationContext(),
  });
}

function validateTicketsCandidateGitTree(repositoryRoot, treeOid, manifestRelativePath, options = {}) {
  return validateTicketsCandidateGitTreeRaw(repositoryRoot, treeOid, manifestRelativePath, {
    ...options,
    previousManifestContext: Object.hasOwn(options, "previousManifestContext")
      ? options.previousManifestContext
      : noPriorPublicationContext(),
  });
}

function makeRevision(previous, tickets, retirements = []) {
  const manifest = structuredClone(previous);
  manifest.manifest_revision = previous.manifest_revision + 1;
  manifest.previous_manifest_digest = ticketManifestDigests(previous).manifest_digest;
  manifest.tickets = tickets;
  manifest.reserved_ticket_ids = [...new Set([
    ...previous.reserved_ticket_ids,
    ...tickets.map((ticket) => ticket.id),
  ])].sort();
  manifest.topological_order = stableTopologicalOrder(tickets).ordered;
  manifest.retirements = retirements;
  for (const retirement of retirements) {
    if (!manifest.governing_artifacts.some((artifact) => artifact.ref_id === retirement.decision_ref)) {
      manifest.governing_artifacts.push({
        content_sha256: sha256(retirement.decision_ref),
        kind: "decision",
        path: `docs/decisions/${retirement.decision_ref.replaceAll(":", "-")}.md`,
        published_commit_oid: sha256(retirement.decision_ref).slice(0, manifest.object_format === "sha256" ? 64 : 40),
        ref_id: retirement.decision_ref,
      });
    }
  }
  manifest.governing_artifacts.sort((left, right) => left.ref_id < right.ref_id ? -1 : left.ref_id > right.ref_id ? 1 : 0);
  return manifest;
}

function oneTicketPrevious() {
  const previous = fixture();
  previous.tickets = [previous.tickets[0]];
  previous.topological_order = [previous.tickets[0].id];
  previous.reserved_ticket_ids = [previous.tickets[0].id];
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

test("strict parser rejects every non-object JSON root with a typed error", () => {
  for (const text of ["null\n", "false\n", "0\n", "[]\n", '"text"\n']) {
    const parsed = parseTicketsManifest(text);
    assert.ok(parsed.errors.some((entry) => entry.code === "tickets_manifest_schema_invalid"), text.trim());
  }
});

test("raw JSON depth is bounded before duplicate-key scanning and parsing", () => {
  const depth = 65;
  const text = `${'{"x":'.repeat(depth)}null${"}".repeat(depth)}\n`;
  const parsed = parseTicketsManifest(text);
  assert.equal(parsed.manifest, null);
  assert.ok(parsed.errors.some((entry) => entry.code === "tickets_manifest_limits_exceeded" && entry.evidence.limit_name === "max_json_depth"));
});

test("design validation returns errors instead of crashing on a truthy non-object fixture root", () => {
  for (const invalidRoot of ["[]\n", '"text"\n', "{}\n"]) {
    const files = loadTicketsManifestFiles();
    files[`resources/tickets-manifest/example-candidate/${EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH}`] = invalidRoot;
    assert.doesNotThrow(() => validateTicketsManifestDesign(files), invalidRoot.trim());
    assert.ok(validateTicketsManifestDesign(files).some((entry) => entry.includes("tickets_manifest_schema_invalid")), invalidRoot.trim());
  }
});

test("duplicate JSON keys expose the smallest available RFC 6901 pointer", () => {
  const text = '{"outer":{"a/b ~ key":1,"a/b ~ key":2}}\n';
  const parsed = parseTicketsManifest(text);
  const duplicate = parsed.errors.find((entry) => entry.code === "tickets_manifest_json_invalid");
  assert.equal(duplicate?.json_pointer, "/outer/a~1b ~0 key");

  for (const primitive of ["123", "true", "null", "-1.25e+3"]) {
    const afterPrimitive = parseTicketsManifest(`{"arr":[${primitive},{"x":1,"x":2}]}\n`);
    const nestedDuplicate = afterPrimitive.errors.find((entry) => entry.code === "tickets_manifest_json_invalid");
    assert.equal(nestedDuplicate?.json_pointer, "/arr/1/x", primitive);
  }
});

test("canonical JSON sorts integer-like object keys by code point", () => {
  assert.equal(canonicalStringify({
    "1": "one",
    "10": "ten",
    "2": "two",
    a: "letter",
  }), `{\n  "1": "one",\n  "10": "ten",\n  "2": "two",\n  "a": "letter"\n}\n`);
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

  const deepCycle = fixture();
  const third = ticketWithId(deepCycle.tickets[1], "T03", "third");
  deepCycle.tickets.push(third);
  deepCycle.tickets[0].depends_on = ["T03"];
  deepCycle.tickets[0].dependency_rationale = [{ dependency_id: "T03", kind: "semantic", reason: "Closes a deep cycle." }];
  deepCycle.tickets[1].depends_on = ["T01"];
  deepCycle.tickets[1].dependency_rationale = [{ dependency_id: "T01", kind: "semantic", reason: "Middle cycle edge." }];
  deepCycle.tickets[2].depends_on = ["T02"];
  deepCycle.tickets[2].dependency_rationale = [{ dependency_id: "T02", kind: "semantic", reason: "Final cycle edge." }];
  deepCycle.topological_order = ["T01", "T02", "T03"];
  assert.ok(codes(deepCycle).includes("tickets_dependency_cycle"));
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

test("policy, decision, work, approval and retirement refs resolve by governing kind", () => {
  const policy = fixture();
  policy.policy.review_policy_ref = "review:missing";
  assert.ok(codes(policy).includes("tickets_governing_ref_invalid"));

  const ticketRefs = fixture();
  ticketRefs.tickets[0].material_decision_refs = ["decision:missing"];
  ticketRefs.tickets[0].work_contract_refs = ["work:missing"];
  ticketRefs.tickets[0].risk_and_rollback.approval_refs = ["decision:approval-missing"];
  assert.ok(codes(ticketRefs).includes("tickets_governing_ref_invalid"));

  const retirement = fixture();
  retirement.retirements = [{
    decision_ref: "decision:missing",
    disposition: "dropped",
    predecessor_id: "T99",
    rationale: "Invalid unresolved retirement authority.",
    successor_ids: [],
  }];
  assert.ok(codes(retirement).includes("tickets_governing_ref_invalid"));
});

test("verification binding kinds require pinned governing authority", () => {
  for (const kind of ["recipe", "verification_batch", "deterministic_check", "manual_acceptance"]) {
    const missing = fixture();
    missing.tickets[0].acceptance_criteria[0].verification_bindings[0] = {
      binding_id: `check:${kind}`,
      expected_evidence: [kind === "manual_acceptance" ? "manual_acceptance" : "test_result"],
      kind,
      source_ref: null,
    };
    assert.ok(codes(missing).includes("tickets_manifest_schema_invalid"), kind);
  }

  const manual = fixture();
  manual.tickets[0].acceptance_criteria[0].verification_bindings[0] = {
    binding_id: "manual:approval",
    expected_evidence: ["manual_acceptance"],
    kind: "manual_acceptance",
    source_ref: "verification:current",
  };
  assert.ok(codes(manual).includes("tickets_verification_binding_invalid"));

  const authorizedManual = fixture();
  authorizedManual.governing_artifacts.push({
    content_sha256: "9".repeat(64),
    kind: "decision",
    path: "docs/decisions/manual-acceptance.md",
    published_commit_oid: "9".repeat(40),
    ref_id: "decision:manual-acceptance",
  });
  authorizedManual.governing_artifacts.sort((left, right) => left.ref_id < right.ref_id ? -1 : left.ref_id > right.ref_id ? 1 : 0);
  authorizedManual.tickets[0].acceptance_criteria[0].verification_bindings[0] = {
    binding_id: "manual:approval",
    expected_evidence: ["manual_acceptance"],
    kind: "manual_acceptance",
    source_ref: "decision:manual-acceptance",
  };
  assert.equal(codes(authorizedManual).includes("tickets_verification_binding_invalid"), false);
});

test("Planned Tickets must retain Tech Plan authority", () => {
  const manifest = fixture();
  manifest.tickets[0].governing_refs = manifest.tickets[0].governing_refs.filter((entry) => !entry.startsWith("tech_plan:"));
  assert.ok(codes(manifest).includes("tickets_governing_ref_invalid"));
});

test("Tech Plan authority resolves the root artifact kind rather than the ref prefix", () => {
  const manifest = fixture();
  const techPlan = manifest.governing_artifacts.find((entry) => entry.ref_id === "tech_plan:current");
  techPlan.kind = "brief";
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

test("impact conditions and irreversible rollback approval are enforced directly", () => {
  const missingImpactPaths = fixture();
  missingImpactPaths.tickets[0].impacts.documentation.paths = [];
  assert.ok(codes(missingImpactPaths).includes("tickets_manifest_schema_invalid"));

  const forbiddenImpactPaths = fixture();
  forbiddenImpactPaths.tickets[0].impacts.migration.paths = [{ kind: "file", path: "migrations/001.sql" }];
  assert.ok(codes(forbiddenImpactPaths).includes("tickets_manifest_schema_invalid"));

  const irreversible = fixture();
  irreversible.tickets[0].risk_and_rollback.irreversible = true;
  irreversible.tickets[0].risk_and_rollback.rollback_mode = "manual";
  irreversible.tickets[0].risk_and_rollback.approval_refs = [];
  assert.ok(codes(irreversible).includes("tickets_manifest_schema_invalid"));

  const contradictory = fixture();
  contradictory.tickets[0].risk_and_rollback.rollback_mode = "irreversible";
  contradictory.tickets[0].risk_and_rollback.irreversible = false;
  contradictory.tickets[0].risk_and_rollback.approval_refs = [];
  assert.ok(codes(contradictory).includes("tickets_manifest_schema_invalid"));
});

test("stable ordering is enforced for policy-adjacent arrays and impact path sets", () => {
  const manifest = fixture();
  manifest.exclusions = ["z later exclusion", "a earlier exclusion"];
  manifest.tickets[0].material_decision_refs = ["decision:z", "decision:a"];
  manifest.tickets[0].work_contract_refs = ["work:z", "work:a"];
  manifest.tickets[0].risk_and_rollback.approval_refs = ["approval:z", "approval:a"];
  manifest.tickets[0].impacts.documentation.paths = [
    { kind: "file", path: "docs/z.md" },
    { kind: "file", path: "docs/a.md" },
  ];

  const result = validateTicketsManifest(manifest, schema, canonicalStringify(manifest), {
    candidateDocuments: renderTicketDocuments(manifest),
  });
  assert.ok(result.some((entry) => entry.json_pointer === "/exclusions" && entry.code === "tickets_manifest_noncanonical"));
  assert.ok(result.some((entry) => entry.json_pointer === "/tickets/0/material_decision_refs"));
  assert.ok(result.some((entry) => entry.json_pointer === "/tickets/0/work_contract_refs"));
  assert.ok(result.some((entry) => entry.json_pointer === "/tickets/0/risk_and_rollback/approval_refs"));
  assert.ok(result.some((entry) => entry.json_pointer === "/tickets/0/impacts/documentation/paths"));
});

test("renderer produces one overview and one deterministic document per Ticket", () => {
  const first = renderTicketDocuments(example);
  const second = renderTicketDocuments(structuredClone(example));
  assert.deepEqual([...first], [...second]);
  assert.equal(first.size, example.tickets.length + 1);
  assert.ok(first.has(`docs/autosk/epics/${example.epic_id}/tickets/README.md`));
  assert.ok([...first.values()].every((content) => content.startsWith("<!-- generated-by: autosk-flow/ticket-markdown/v1 -->\n\n")));
  assert.match(first.get(`docs/autosk/epics/${example.epic_id}/tickets/README.md`), /^\| ID \| Title \| Work type \| Depends on \| Goal \|$/mu);
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

test("canonical example digests are pinned vectors", () => {
  const digests = ticketManifestDigests(example);
  assert.equal(digests.manifest_bytes_sha256, "b856840f3315b497e2788e1715462145ddd9290950ae4d8690f5a1cd2251cb9b");
  assert.equal(digests.manifest_digest, "749d702080d9773cdfae6ad845aabc8e7a3c083c48f349424a65dd493a47b999");
  assert.equal(digests.ticket_entry_digests[0].digest, "f8fc6c0202589cb99e44555a8c92923734231f0c350be12a5c8fc9020c084a3d");
  assert.equal(digests.ticket_entry_digests[1].digest, "588182b97f7f1ab62e55d97107c64c7cbb5291ecb3e2d44bf7854fe7234e91c6");
  assert.equal(digests.dag_digest, "8650fb0f6e13f53845b73fdf0f60c021536247efa0cb5a9fde7842c73f41c72f");
  assert.equal(digests.rendered_document_set_digest, "46332c943897f9c5c370a8d5894744fadc27f418b86b4d505f1ba8d4ff4d4c31");
  assert.equal(digests.ticket_set_digest, "589cbd283ab3b022b15482dc684396c5d74bc82985ce0ce5a9c966f9b3250aa1");
  assert.equal(ticketLimitsDigest(example.policy.limits), "f04813ceb45982c8f9fe3d89e4cca1f137183a8a3fd78fc5bd6c2ee4cdcc72b7");
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
    limits_digest: ticketLimitsDigest(example.policy.limits),
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
    record_kind: "final_validation_receipt",
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
  const expectedBindings = Object.fromEntries(TICKETS_RECEIPT_BINDING_FIELDS.map((field) => [field, structuredClone(receipt[field])]));
  assert.deepEqual(validateTicketsValidationReceipt(receipt, receiptSchema, expectedBindings), []);
  assert.ok(validateTicketsValidationReceipt(receipt, receiptSchema)
    .some((entry) => entry.code === "tickets_receipt_stale"));
  const wrongProject = structuredClone(expectedBindings);
  wrongProject.project_root_sha256 = "9".repeat(64);
  assert.ok(validateTicketsValidationReceipt(receipt, receiptSchema, wrongProject)
    .some((entry) => entry.code === "tickets_receipt_stale" && entry.json_pointer === "/project_root_sha256"));
  const wrongTree = structuredClone(expectedBindings);
  wrongTree.candidate_tree_oid = "a".repeat(40);
  assert.ok(validateTicketsValidationReceipt(receipt, receiptSchema, wrongTree)
    .some((entry) => entry.code === "tickets_receipt_stale" && entry.json_pointer === "/candidate_tree_oid"));
  const incompleteReceipt = structuredClone(receipt);
  incompleteReceipt.rendered_documents.pop();
  assert.ok(validateTicketsValidationReceipt(incompleteReceipt, receiptSchema, expectedBindings)
    .some((entry) => entry.code === "tickets_receipt_stale" && entry.json_pointer === "/rendered_documents"));
  const corruptDigest = structuredClone(receipt);
  corruptDigest.ticket_entry_digests[0].digest = "f".repeat(64);
  assert.ok(validateTicketsValidationReceipt(corruptDigest, receiptSchema, expectedBindings)
    .some((entry) => entry.code === "tickets_receipt_stale" && entry.json_pointer === "/ticket_entry_digests"));
  const pendingProof = structuredClone(receipt);
  pendingProof.record_kind = "pending_validation_proof";
  pendingProof.candidate_tree_oid = null;
  assert.deepEqual(validateJsonSchema(pendingProof, receiptSchema), []);
  assert.ok(validateTicketsValidationReceipt(pendingProof, receiptSchema, expectedBindings)
    .some((entry) => entry.code === "tickets_receipt_stale"));
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

  const totalRenderedAt = fixture();
  const totalRenderedBytes = [...renderTicketDocuments(totalRenderedAt).values()]
    .reduce((sum, content) => sum + Buffer.byteLength(content, "utf8"), 0);
  totalRenderedAt.policy.limits.max_total_rendered_document_bytes = totalRenderedBytes;
  noLimitError(totalRenderedAt);
  const totalRenderedOver = structuredClone(totalRenderedAt);
  totalRenderedOver.policy.limits.max_total_rendered_document_bytes -= 1;
  hasLimitError(totalRenderedOver);

  const overlapAt = fixture();
  overlapAt.tickets[1].scope_selectors[1] = { kind: "directory", path: "src/session" };
  overlapAt.tickets[1].scope_selectors.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : 1);
  overlapAt.policy.limits.max_scope_overlap_pairs = 1;
  noLimitError(overlapAt);
  const overlapOver = structuredClone(overlapAt);
  overlapOver.policy.limits.max_scope_overlap_pairs = 0;
  hasLimitError(overlapOver);

  const reservedAt = fixture();
  reservedAt.policy.limits.max_reserved_ticket_ids = reservedAt.reserved_ticket_ids.length;
  noLimitError(reservedAt);
  const reservedOver = structuredClone(reservedAt);
  reservedOver.policy.limits.max_reserved_ticket_ids -= 1;
  hasLimitError(reservedOver);
});

test("candidate rendered inventories enforce host entry and aggregate-byte caps", () => {
  const tooMany = Array.from({ length: 10_003 }, (_, index) => [
    `docs/autosk/epics/${example.epic_id}/tickets/EXTRA-${String(index).padStart(5, "0")}.md`,
    "x\n",
  ]);
  assert.ok(compareRenderedTicketDocuments(example, new Map(tooMany)).some((entry) => entry.code === "tickets_manifest_limits_exceeded"));

  const aggregate = fixture();
  aggregate.policy.limits.max_total_rendered_document_bytes = 2048;
  assert.ok(codes(aggregate).includes("tickets_manifest_limits_exceeded"));

  const onDiskAggregate = fixture();
  onDiskAggregate.policy.limits.max_total_rendered_document_bytes = 2048;
  const inventory = loadCandidateTicketDocuments(EXAMPLE_CANDIDATE_ROOT, onDiskAggregate);
  assert.ok(inventory.errors.some((entry) => entry.code === "tickets_manifest_limits_exceeded"));
  assert.equal(inventory.documents.has(onDiskAggregate.tickets[0].document_path), false);
});

test("scope overlap pair cap bounds repeated and same-Ticket selector work", () => {
  const manifest = fixture();
  manifest.tickets[0].scope_selectors = [
    { kind: "directory", path: "src/session" },
    { kind: "file", path: "src/session/store.ts" },
  ];
  manifest.policy.limits.max_scope_overlap_pairs = 0;
  assert.ok(codes(manifest).includes("tickets_manifest_limits_exceeded"));
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

test("candidate rename detection scales through one digest index", () => {
  const manifest = fixture();
  manifest.tickets = Array.from({ length: 1000 }, (_, index) => {
    const number = String(index + 1).padStart(4, "0");
    return ticketWithId(example.tickets[0], `T${number}`, `ticket-${number}`);
  });
  manifest.topological_order = manifest.tickets.map((ticket) => ticket.id);
  manifest.reserved_ticket_ids = [...manifest.topological_order];
  const renamed = new Map([...renderTicketDocuments(manifest)].map(([documentPath, bytes]) => [`${documentPath}.renamed`, bytes]));
  const errors = compareRenderedTicketDocuments(manifest, renamed);
  assert.equal(errors.filter((entry) => entry.code === "tickets_rendered_path_renamed").length, renamed.size);
  assert.equal(errors.some((entry) => entry.code === "tickets_rendered_path_missing"), false);
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
      "--no-prior-publication-digest",
      "0".repeat(64),
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tickets_rendered_bytes_mismatch/u);
  } finally {
    rmSync(temporaryParent, { force: true, recursive: true });
  }
});

test("candidate-tree inventory rejects renamed, extra and directory-at-expected-path entries", () => {
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

    rmSync(renamed);
    const expectedTicket = path.join(temporaryRoot, ...`${directoryRelative}/T01-session-store.md`.split("/"));
    rmSync(expectedTicket);
    mkdirSync(expectedTicket);
    const directoryErrors = validateTicketsCandidateTree(temporaryRoot, EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH);
    assert.ok(directoryErrors.some((entry) => entry.code === "tickets_rendered_path_extra" && entry.evidence.path?.endsWith("/T01-session-store.md")));
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

test("Schema errors escape exotic unknown keys in RFC 6901 pointers", () => {
  const manifest = fixture();
  manifest.tickets[0]["strange/key ~ [x]"] = true;
  const errors = validateTicketsManifest(manifest, schema, null, { candidateDocuments: renderTicketDocuments(manifest) });
  const schemaError = errors.find((entry) => entry.code === "tickets_manifest_schema_invalid" && entry.message.includes("strange/key"));
  assert.equal(schemaError?.json_pointer, "/tickets/0/strange~1key ~0 [x]");

  const ambiguous = fixture();
  ambiguous.policy.limits.extra = 1;
  ambiguous["policy.limits.extra"] = 2;
  const ambiguousPointers = validateTicketsManifest(ambiguous, schema, null, { candidateDocuments: new Map() })
    .filter((entry) => entry.code === "tickets_manifest_schema_invalid" && entry.message === "$.policy.limits.extra is not allowed")
    .map((entry) => entry.json_pointer)
    .sort();
  assert.deepEqual(ambiguousPointers, ["/policy.limits.extra", "/policy/limits/extra"]);
});

test("closed Schemas reject unknown keys inherited by Object.prototype", () => {
  for (const key of ["__proto__", "constructor", "toString"]) {
    const manifest = fixture();
    Object.defineProperty(manifest, key, { configurable: true, enumerable: true, value: {}, writable: true });
    const errors = validateTicketsManifest(manifest, schema, null, { candidateDocuments: new Map() });
    assert.ok(errors.some((entry) => entry.code === "tickets_manifest_schema_invalid" && entry.json_pointer === `/${key}`), key);
  }
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

test("revision lineage never reuses an ID retired before the previous revision", () => {
  const first = oneTicketPrevious();
  const replacement = ticketWithId(first.tickets[0], "T02", "replacement");
  replacement.lineage = { kind: "replace", predecessor_ids: ["T01"] };
  const second = makeRevision(first, [replacement], [{
    decision_ref: "decision:replace-t01",
    disposition: "superseded",
    predecessor_id: "T01",
    rationale: "Replace the original Ticket while retaining its ID reservation.",
    successor_ids: ["T02"],
  }]);
  assert.equal(codes(second, canonicalStringify(second), {
    previousManifestContext: previousManifestContext(first),
  }).includes("tickets_lineage_invalid"), false);

  const reused = ticketWithId(second.tickets[0], "T01", "reused");
  reused.lineage = { kind: "new", predecessor_ids: [] };
  const carried = structuredClone(second.tickets[0]);
  carried.lineage = { kind: "carry", predecessor_ids: ["T02"] };
  const third = makeRevision(second, [reused, carried]);
  assert.ok(codes(third, canonicalStringify(third), {
    previousManifestContext: previousManifestContext(second),
  }).includes("tickets_lineage_invalid"));
});

test("a candidate cannot reset lineage while exact previous context exists", () => {
  const previous = fixture();
  const reset = fixture();
  reset.goal = "A different first revision claim.";
  assert.ok(codes(reset, canonicalStringify(reset), {
    previousManifestContext: previousManifestContext(previous),
  }).includes("tickets_lineage_invalid"));
  assert.ok(validateTicketsManifestRaw(reset, schema, canonicalStringify(reset), {
    candidateDocuments: renderTicketDocuments(reset),
  }).some((entry) => entry.code === "tickets_lineage_invalid" && entry.message.includes("host lineage context is required")));
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

test("cyclic or too-deep manifest objects fail before recursive validation routines", () => {
  const cyclic = fixture();
  cyclic.tickets[0].cycle = cyclic;
  assert.doesNotThrow(() => {
    assert.ok(validateTicketsManifest(cyclic, schema, null, { candidateDocuments: new Map() })
      .some((entry) => entry.code === "tickets_manifest_limits_exceeded"));
  });

  const tooDeep = fixture();
  let cursor = tooDeep.tickets[0];
  for (let index = 0; index < 70; index += 1) {
    cursor.nested = {};
    cursor = cursor.nested;
  }
  assert.ok(validateTicketsManifest(tooDeep, schema, null, { candidateDocuments: new Map() })
    .some((entry) => entry.code === "tickets_manifest_limits_exceeded"));
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

test("renderer neutralizes leading Markdown block markers in standalone prose", () => {
  const cases = ["# forged heading", "> forged quote", "```json", "~~~json", "- forged item", "+ forged item", "* forged item", "1. forged item", "---", "===", "<details>", "[ref]: https://example.invalid", "[^note]: forged footnote"];
  for (const injected of cases) {
    const manifest = fixture();
    manifest.goal = injected;
    manifest.exclusions = [injected];
    manifest.tickets[0].goal = injected;
    const documents = renderTicketDocuments(manifest);
    const overview = documents.get(`docs/autosk/epics/${manifest.epic_id}/tickets/README.md`);
    const ticket = documents.get(manifest.tickets[0].document_path);
    assert.doesNotMatch(overview, new RegExp(`^${injected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"), injected);
    assert.doesNotMatch(ticket, new RegExp(`^${injected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"), injected);
  }
});

test("renderer escapes raw HTML in every human-authored Markdown context", () => {
  const injected = 'safe <img src=x onerror="alert(1)"> & [click](javascript:alert(1))';
  const manifest = fixture();
  manifest.goal = injected;
  manifest.exclusions = [injected];
  manifest.tickets[0].title = injected;
  manifest.tickets[0].goal = injected;
  manifest.tickets[0].acceptance_criteria[0].text = injected;
  const documents = renderTicketDocuments(manifest);
  const overview = documents.get(`docs/autosk/epics/${manifest.epic_id}/tickets/README.md`);
  const ticket = documents.get(manifest.tickets[0].document_path);
  const humanTicket = ticket.split("## Canonical manifest entry")[0];
  assert.doesNotMatch(overview, /<img\b/iu);
  assert.doesNotMatch(humanTicket, /<img\b/iu);
  assert.match(overview, /&lt;img src=x onerror="alert\(1\)"&gt; &amp; &#91;click&#93;\(javascript:alert\(1\)\)/u);
  assert.match(humanTicket, /&lt;img src=x onerror="alert\(1\)"&gt; &amp; &#91;click&#93;\(javascript:alert\(1\)\)/u);
  assert.doesNotMatch(overview, /\[click\]\(javascript:/u);
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

test("candidate-tree schema preflight rejects unknown versions before Markdown inventory", () => {
  const temporaryParent = mkdtempSync(path.join(tmpdir(), "autosk-ticket-preflight-"));
  const candidateRoot = path.join(temporaryParent, "candidate");
  try {
    cpSync(EXAMPLE_CANDIDATE_ROOT, candidateRoot, { recursive: true });
    const manifestPath = path.join(candidateRoot, ...EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH.split("/"));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.schema_version = 2;
    writeFileSync(manifestPath, canonicalStringify(manifest));
    mkdirSync(path.join(candidateRoot, ...path.posix.join(path.posix.dirname(EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH), "nested").split("/")));
    const errors = validateTicketsCandidateTree(candidateRoot, EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH);
    assert.ok(errors.some((entry) => entry.code === "tickets_manifest_schema_invalid"));
    assert.equal(errors.some((entry) => entry.code.startsWith("tickets_rendered_") || entry.code === "tickets_path_invalid"), false);
  } finally {
    rmSync(temporaryParent, { force: true, recursive: true });
  }
});

test("candidate-tree result API returns validated manifest and digests", () => {
  const result = validateTicketsCandidateTreeResult(EXAMPLE_CANDIDATE_ROOT, EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH);
  assert.deepEqual(result.errors, []);
  assert.equal(result.manifest.epic_id, example.epic_id);
  assert.equal(result.raw_text, exampleText);
  assert.equal(result.digests.manifest_digest, ticketManifestDigests(example).manifest_digest);
});

test("authoritative candidate validation reads immutable Git tree bytes", () => {
  const temporaryParent = mkdtempSync(path.join(tmpdir(), "autosk-ticket-git-tree-"));
  const repositoryRoot = path.join(temporaryParent, "repository");
  try {
    cpSync(EXAMPLE_CANDIDATE_ROOT, repositoryRoot, { recursive: true });
    runGit(repositoryRoot, ["init", "--quiet"]);
    runGit(repositoryRoot, ["add", "."]);
    runGit(repositoryRoot, ["-c", "user.name=autosk-test", "-c", "user.email=autosk-test@example.invalid", "commit", "--quiet", "-m", "candidate"]);
    const treeOid = runGit(repositoryRoot, ["rev-parse", "HEAD^{tree}"]);
    const readmeRelativePath = path.posix.join(path.posix.dirname(EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH), "README.md");
    const readmePath = path.join(repositoryRoot, ...readmeRelativePath.split("/"));
    const result = validateTicketsCandidateGitTree(repositoryRoot, treeOid, EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH);
    assert.deepEqual(result.errors, []);
    assert.equal(result.tree_oid, treeOid);
    assert.equal(result.digests.manifest_digest, ticketManifestDigests(example).manifest_digest);

    const previousGitDir = process.env.GIT_DIR;
    const previousPath = process.env.PATH;
    process.env.GIT_DIR = path.join(temporaryParent, "foreign.git");
    process.env.PATH = temporaryParent;
    try {
      assert.deepEqual(validateTicketsCandidateGitTree(repositoryRoot, treeOid, EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH).errors, []);
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    const originalReadmeOid = runGit(repositoryRoot, ["rev-parse", `${treeOid}:${readmeRelativePath}`]);
    const replacementPath = path.join(temporaryParent, "replacement.md");
    writeFileSync(replacementPath, "replacement ref content\n");
    const replacementOid = runGit(repositoryRoot, ["hash-object", "-w", replacementPath]);
    runGit(repositoryRoot, ["replace", originalReadmeOid, replacementOid]);
    assert.deepEqual(
      validateTicketsCandidateGitTree(repositoryRoot, treeOid, EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH).errors,
      [],
    );

    const strictLimit = validateTicketsCandidateGitTree(repositoryRoot, treeOid, EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH, {
      maxManifestBytes: Buffer.byteLength(exampleText, "utf8") - 1,
    });
    assert.ok(strictLimit.errors.some((entry) => entry.code === "tickets_manifest_limits_exceeded"));

    writeFileSync(readmePath, "mutable worktree drift\n");
    const repeated = validateTicketsCandidateGitTree(repositoryRoot, treeOid, EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH);
    assert.deepEqual(repeated.errors, []);
    assert.equal(repeated.digests.manifest_digest, result.digests.manifest_digest);

    const aggregateLimited = fixture();
    aggregateLimited.policy.limits.max_total_rendered_document_bytes = 2048;
    const manifestPath = path.join(repositoryRoot, ...EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH.split("/"));
    writeFileSync(manifestPath, canonicalStringify(aggregateLimited));
    for (const [relativePath, content] of renderTicketDocuments(aggregateLimited)) {
      writeFileSync(path.join(repositoryRoot, ...relativePath.split("/")), content);
    }
    runGit(repositoryRoot, ["add", "."]);
    runGit(repositoryRoot, ["-c", "user.name=autosk-test", "-c", "user.email=autosk-test@example.invalid", "commit", "--quiet", "-m", "aggregate-limit"]);
    const aggregateTreeOid = runGit(repositoryRoot, ["rev-parse", "HEAD^{tree}"]);
    const aggregateResult = validateTicketsCandidateGitTree(repositoryRoot, aggregateTreeOid, EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH);
    assert.ok(aggregateResult.errors.some((entry) => entry.code === "tickets_manifest_limits_exceeded"
      && entry.evidence.limit_name === "max_total_rendered_document_bytes"
      && entry.message.includes("before Git object read")
      && entry.evidence.actual > entry.evidence.limit));
    assert.equal(aggregateResult.candidate_documents.has(aggregateLimited.tickets[0].document_path), false);

    const mismatchedFormat = fixture();
    mismatchedFormat.object_format = "sha256";
    for (const governing of mismatchedFormat.governing_artifacts) governing.published_commit_oid = governing.published_commit_oid.repeat(2).slice(0, 64);
    writeFileSync(manifestPath, canonicalStringify(mismatchedFormat));
    for (const [relativePath, content] of renderTicketDocuments(mismatchedFormat)) {
      writeFileSync(path.join(repositoryRoot, ...relativePath.split("/")), content);
    }
    runGit(repositoryRoot, ["add", "."]);
    runGit(repositoryRoot, ["-c", "user.name=autosk-test", "-c", "user.email=autosk-test@example.invalid", "commit", "--quiet", "-m", "mismatched-format"]);
    const mismatchedTreeOid = runGit(repositoryRoot, ["rev-parse", "HEAD^{tree}"]);
    const mismatchedResult = validateTicketsCandidateGitTree(repositoryRoot, mismatchedTreeOid, EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH);
    assert.ok(mismatchedResult.errors.some((entry) => entry.code === "tickets_governing_ref_invalid" && entry.json_pointer === "/object_format"));
    assert.equal(mismatchedResult.digests, null);
  } finally {
    rmSync(temporaryParent, { force: true, recursive: true });
  }
});

test("authoritative Git-tree validation rejects a symlink-mode manifest", () => {
  const temporaryParent = mkdtempSync(path.join(tmpdir(), "autosk-ticket-git-symlink-"));
  const repositoryRoot = path.join(temporaryParent, "repository");
  try {
    cpSync(EXAMPLE_CANDIDATE_ROOT, repositoryRoot, { recursive: true });
    const manifestPath = path.join(repositoryRoot, ...EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH.split("/"));
    rmSync(manifestPath);
    symlinkSync("README.md", manifestPath);
    runGit(repositoryRoot, ["init", "--quiet"]);
    runGit(repositoryRoot, ["add", "."]);
    runGit(repositoryRoot, ["-c", "user.name=autosk-test", "-c", "user.email=autosk-test@example.invalid", "commit", "--quiet", "-m", "symlink-manifest"]);
    const treeOid = runGit(repositoryRoot, ["rev-parse", "HEAD^{tree}"]);
    const result = validateTicketsCandidateGitTree(repositoryRoot, treeOid, EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH);
    assert.ok(result.errors.some((entry) => entry.code === "tickets_path_invalid" && entry.json_pointer === "/manifest_path"));
  } finally {
    rmSync(temporaryParent, { force: true, recursive: true });
  }
});

test("authoritative Git-tree inventory rejects missing, extra, renamed, drifted and nested rendered entries", () => {
  const temporaryParent = mkdtempSync(path.join(tmpdir(), "autosk-ticket-git-inventory-"));
  const ticketDirectory = path.posix.dirname(EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH);
  const readmeRelative = `${ticketDirectory}/README.md`;
  const ticketRelative = `${ticketDirectory}/T01-session-store.md`;
  const cases = [
    {
      code: "tickets_rendered_path_missing",
      mutate(root) { rmSync(path.join(root, ...ticketRelative.split("/"))); },
      name: "missing",
    },
    {
      code: "tickets_rendered_path_extra",
      mutate(root) { writeFileSync(path.join(root, ...`${ticketDirectory}/EXTRA.md`.split("/")), "extra\n"); },
      name: "extra",
    },
    {
      code: "tickets_rendered_path_renamed",
      mutate(root) {
        const readme = path.join(root, ...readmeRelative.split("/"));
        const bytes = readFileSync(readme);
        rmSync(readme);
        writeFileSync(path.join(root, ...`${ticketDirectory}/RENAMED.md`.split("/")), bytes);
      },
      name: "renamed",
    },
    {
      code: "tickets_rendered_bytes_mismatch",
      mutate(root) {
        const ticket = path.join(root, ...ticketRelative.split("/"));
        writeFileSync(ticket, Buffer.concat([readFileSync(ticket), Buffer.from("drift")]));
      },
      name: "drifted",
    },
    {
      code: "tickets_rendered_path_extra",
      mutate(root) {
        const ticket = path.join(root, ...ticketRelative.split("/"));
        rmSync(ticket);
        mkdirSync(ticket);
        writeFileSync(path.join(ticket, "nested.md"), "nested\n");
      },
      name: "nested",
    },
  ];
  try {
    for (const testCase of cases) {
      const repositoryRoot = path.join(temporaryParent, testCase.name);
      cpSync(EXAMPLE_CANDIDATE_ROOT, repositoryRoot, { recursive: true });
      testCase.mutate(repositoryRoot);
      runGit(repositoryRoot, ["init", "--quiet"]);
      runGit(repositoryRoot, ["add", "."]);
      runGit(repositoryRoot, ["-c", "user.name=autosk-test", "-c", "user.email=autosk-test@example.invalid", "commit", "--quiet", "-m", testCase.name]);
      const treeOid = runGit(repositoryRoot, ["rev-parse", "HEAD^{tree}"]);
      const result = validateTicketsCandidateGitTree(repositoryRoot, treeOid, EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH);
      assert.ok(result.errors.some((entry) => entry.code === testCase.code), testCase.name);
      assert.equal(result.digests, null, testCase.name);
    }
  } finally {
    rmSync(temporaryParent, { force: true, recursive: true });
  }
});

test("authoritative Git-tree validation rejects abbreviated OIDs and repository format mismatch", () => {
  const temporaryParent = mkdtempSync(path.join(tmpdir(), "autosk-ticket-sha256-tree-"));
  const repositoryRoot = path.join(temporaryParent, "repository");
  try {
    cpSync(EXAMPLE_CANDIDATE_ROOT, repositoryRoot, { recursive: true });
    runGit(repositoryRoot, ["init", "--quiet", "--object-format=sha256"]);
    runGit(repositoryRoot, ["add", "."]);
    runGit(repositoryRoot, ["-c", "user.name=autosk-test", "-c", "user.email=autosk-test@example.invalid", "commit", "--quiet", "-m", "sha256-candidate"]);
    const fullTreeOid = runGit(repositoryRoot, ["rev-parse", "HEAD^{tree}"]);
    assert.equal(fullTreeOid.length, 64);

    const abbreviated = validateTicketsCandidateGitTree(repositoryRoot, fullTreeOid.slice(0, 40), EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH);
    assert.ok(abbreviated.errors.some((entry) => entry.code === "tickets_path_invalid" && entry.json_pointer === "/candidate_tree_oid"));

    const formatMismatch = validateTicketsCandidateGitTree(repositoryRoot, fullTreeOid, EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH);
    assert.ok(formatMismatch.errors.some((entry) => entry.code === "tickets_governing_ref_invalid" && entry.json_pointer === "/object_format"));
  } finally {
    rmSync(temporaryParent, { force: true, recursive: true });
  }
});

test("candidate-tree CLI runs when invoked through a symlink", () => {
  const temporaryParent = mkdtempSync(path.join(tmpdir(), "autosk-ticket-cli-link-"));
  try {
    const scriptLink = path.join(temporaryParent, "validate-tickets-link.mjs");
    symlinkSync(path.join(ROOT, "scripts/validate-tickets-manifest-design.mjs"), scriptLink);
    const result = spawnSync(process.execPath, [
      scriptLink,
      "--candidate-root",
      EXAMPLE_CANDIDATE_ROOT,
      "--manifest-path",
      EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH,
      "--no-prior-publication-digest",
      "0".repeat(64),
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Tickets candidate-tree validation PASS/u);
  } finally {
    rmSync(temporaryParent, { force: true, recursive: true });
  }
});

test("candidate-tree CLI rejects unknown, repeated and incomplete arguments", () => {
  const script = path.join(ROOT, "scripts/validate-tickets-manifest-design.mjs");
  for (const args of [
    ["--unknown", "value"],
    ["--candidate-root", EXAMPLE_CANDIDATE_ROOT, "--candidate-root", EXAMPLE_CANDIDATE_ROOT],
    ["--manifest-path"],
    ["--candidate-root", EXAMPLE_CANDIDATE_ROOT, "--manifest-path", EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH],
    ["unexpected-positional"],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0, args.join(" "));
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

test("design validation guards Tickets pending proof and final receipt lifecycle rows", () => {
  const files = loadTicketsManifestFiles();
  const stalePendingProof = structuredClone(files);
  stalePendingProof["03-technical-plan.md"] = stalePendingProof["03-technical-plan.md"]
    .replace("schema-valid `record_kind=pending_validation_proof` with `candidate_tree_oid=null`", "pending validation proof");
  assert.ok(validateTicketsManifestDesign(stalePendingProof)
    .some((entry) => entry.includes("record_kind=pending_validation_proof")));

  const staleFinalReceipt = structuredClone(files);
  staleFinalReceipt["03-technical-plan.md"] = staleFinalReceipt["03-technical-plan.md"]
    .replace("`tickets_validation_receipt.candidate_tree_oid` equals that exact tree", "`tickets_validation_receipt.candidate_tree_oid` exists");
  assert.ok(validateTicketsManifestDesign(staleFinalReceipt)
    .some((entry) => entry.includes("tickets_validation_receipt.candidate_tree_oid")));

  for (const file of ["01-core-flows.md", "03-technical-plan.md"]) {
    const missingResume = structuredClone(files);
    missingResume[file] = missingResume[file].replace("| tickets_manifest_invalid |", "| removed_tickets_manifest_invalid |");
    assert.ok(validateTicketsManifestDesign(missingResume)
      .some((entry) => entry.includes(`${file}: missing resume contract for tickets_manifest_invalid`)));
    const invalidRow = files[file].split("\n").find((line) => line.startsWith("| tickets_manifest_invalid |"));
    const staleRow = files[file].split("\n").find((line) => line.startsWith("| tickets_manifest_stale |"));
    assert.match(invalidRow, /present_tickets_breakdown/u);
    assert.match(staleRow, /present_tickets_breakdown/u);
    assert.doesNotMatch(staleRow, /rebound|повторно привязан/u);
    assert.match(staleRow, /new immutable receipt|новый immutable receipt/u);
  }

  const earlyReceipt = structuredClone(files);
  earlyReceipt["03-technical-plan.md"] = earlyReceipt["03-technical-plan.md"]
    .replace("atomically stores schema-valid `record_kind=pending_validation_proof` with `candidate_tree_oid=null`", "writes/read-backs immutable `tickets_validation_receipt`");
  assert.ok(validateTicketsManifestDesign(earlyReceipt)
    .some((entry) => entry.includes("record_kind=pending_validation_proof")));

  const bypassedValidation = structuredClone(files);
  bypassedValidation["03-technical-plan.md"] = bypassedValidation["03-technical-plan.md"]
    .replace("| validate_tickets_manifest; freeze_artifact напрямую запрещён |", "| freeze_artifact |");
  assert.ok(validateTicketsManifestDesign(bypassedValidation)
    .some((entry) => entry.includes("present_tickets_breakdown must not bypass validate_tickets_manifest")));
});
