#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(relative: str, old: str, new: str, label: str) -> None:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{relative}: expected exactly one {label} fragment, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    '''function selectorContains(selector, candidatePath) {
  if (selector.kind === "file") return selector.path === candidatePath;
  return candidatePath === selector.path || candidatePath.startsWith(`${selector.path}/`);
}

export function selectorsOverlap(left, right) {
  if (left.kind === "file" && right.kind === "file") return left.path === right.path;
  if (left.kind === "file") return selectorContains(right, left.path);
  if (right.kind === "file") return selectorContains(left, right.path);
  return selectorContains(left, right.path) || selectorContains(right, left.path);
}
''',
    '''function selectorContains(selector, candidatePath) {
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
''',
    "case-collision overlap implementation",
)

replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    '''function oneLine(value) {
  return String(value).replace(/\\s+/gu, " ").trim();
}

function ticketEntryPayload(ticket) {''',
    '''function oneLine(value) {
  return String(value).replace(/\\s+/gu, " ").trim();
}

function markdownTableCell(value) {
  return oneLine(value).replaceAll("|", "&#124;");
}

function ticketEntryPayload(ticket) {''',
    "Markdown table cell escaping helper",
)

replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    '''  const rows = manifest.tickets.map((ticket) =>
    `| ${ticket.id} | ${oneLine(ticket.title)} | ${ticket.work_type} | ${ticket.depends_on.join(", ") || "—"} | ${oneLine(ticket.goal)} |`,
  );''',
    '''  const rows = manifest.tickets.map((ticket) =>
    `| ${ticket.id} | ${markdownTableCell(ticket.title)} | ${ticket.work_type} | ${ticket.depends_on.join(", ") || "—"} | ${markdownTableCell(ticket.goal)} |`,
  );''',
    "escaped Markdown overview row",
)

replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    '''      `# ${ticket.id} — ${ticket.title}`,''',
    '''      `# ${ticket.id} — ${oneLine(ticket.title)}`,''',
    "single-line generated Ticket heading",
)

replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    '''  for (const schemaError of validateJsonSchema(manifest, schema)) {
    errors.push(error(
      "tickets_manifest_schema_invalid",
      schemaInstancePathToJsonPointer(schemaError),
      String(schemaError),
    ));
  }
  validateStringTree(manifest, "", errors);''',
    '''  const schemaErrors = validateJsonSchema(manifest, schema);
  for (const schemaError of schemaErrors) {
    errors.push(error(
      "tickets_manifest_schema_invalid",
      schemaInstancePathToJsonPointer(schemaError),
      String(schemaError),
    ));
  }
  validateStringTree(manifest, "", errors);''',
    "Schema error collection",
)

replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    '''  if (rawText !== null && (rawTextValue === null || canonicalStringify(manifest) !== rawTextValue)) {
    errors.push(error("tickets_manifest_noncanonical", "", "manifest bytes do not equal canonical serialization"));
  }

  const tickets = Array.isArray(manifest.tickets) ? manifest.tickets : [];''',
    '''  if (rawText !== null && (rawTextValue === null || canonicalStringify(manifest) !== rawTextValue)) {
    errors.push(error("tickets_manifest_noncanonical", "", "manifest bytes do not equal canonical serialization"));
  }
  if (schemaErrors.length > 0) return errors.sort(errorComparator);

  const tickets = Array.isArray(manifest.tickets) ? manifest.tickets : [];''',
    "Schema-first semantic boundary",
)

replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    '''  const parsed = parseTicketsManifest(rawBytes, { maxManifestBytes: requestedManifestLimit });
  errors.push(...parsed.errors);
  if (!parsed.manifest) return errors.sort(errorComparator);
''',
    '''  const parsed = parseTicketsManifest(rawBytes, { maxManifestBytes: requestedManifestLimit });
  errors.push(...parsed.errors);
  if (!parsed.manifest || parsed.errors.length > 0) return errors.sort(errorComparator);
''',
    "strict parser boundary before candidate inventory",
)

replace_once(
    "test/validate-tickets-manifest-design.test.mjs",
    '''  const missing = fixture();
  missing.tickets[0].acceptance_criteria[0].verification_bindings = [];
  assert.ok(codes(missing).includes("tickets_verification_binding_invalid"));''',
    '''  const missing = fixture();
  missing.tickets[0].acceptance_criteria[0].verification_bindings = [];
  assert.ok(codes(missing).includes("tickets_manifest_schema_invalid"));''',
    "Schema-owned empty verification binding expectation",
)

replace_once(
    "test/validate-tickets-manifest-design.test.mjs",
    '''test("candidate files are size-checked before normal validation", () => {''',
    '''test("schema-invalid nested shapes fail closed before semantic routines", () => {
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
  manifest.tickets[0].title = "Left | Right\\ncontinued";
  manifest.tickets[0].goal = "Goal | second column";
  const documents = renderTicketDocuments(manifest);
  const overview = documents.get(`docs/autosk/epics/${manifest.epic_id}/tickets/README.md`);
  const ticket = documents.get(manifest.tickets[0].document_path);
  assert.match(overview, /Left &#124; Right continued/u);
  assert.match(overview, /Goal &#124; second column/u);
  assert.match(ticket, /^# T01 — Left \| Right continued$/mu);
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

test("candidate files are size-checked before normal validation", () => {''',
    "final independent hardening tests",
)

replace_once(
    "docs/contracts/tickets-manifest.md",
    '''Two Tickets overlap when their selectors can address the same path. In v1, overlapping Tickets must be ordered by a transitive dependency in one direction. Incomparable overlap is `tickets_scope_overlap_unordered`.''',
    '''Two Tickets overlap when their selectors can address the same path under the conservative v1 NFC/lowercase collision key, including paths whose bytes differ only by case. In v1, overlapping Tickets must be ordered by a transitive dependency in one direction. Incomparable overlap is `tickets_scope_overlap_unordered`.''',
    "case-collision overlap contract",
)

replace_once(
    "docs/contracts/tickets-manifest.md",
    '''A missing, extra, renamed or one-byte-different document is invalid. The host entry point `validateTicketsCandidateTree` reads the manifest as raw bytes from the exact candidate/publication tree, walks every existing path ancestor without following symlinks, size-checks regular files before reading them, enumerates the sibling Tickets directory, rejects symlinks/non-regular/nested entries, and passes that external inventory to the semantic validator. A caller cannot omit the inventory or substitute freshly rendered bytes for the candidate files. Formatters may not rewrite generated files after validation. Human edits begin by changing the manifest model, then rerendering and minting a new identity.''',
    '''A missing, extra, renamed or one-byte-different document is invalid. The host entry point `validateTicketsCandidateTree` reads the manifest as raw bytes from the exact candidate/publication tree, walks every existing path ancestor without following symlinks, size-checks regular files before reading them, enumerates the sibling Tickets directory, rejects symlinks/non-regular/nested entries, and passes that external inventory to the semantic validator. Schema-invalid nested shapes return typed errors before graph, lineage or renderer code and cannot crash the host. A caller cannot omit the inventory or substitute freshly rendered bytes for the candidate files. The renderer normalizes headings to one line and escapes Markdown table delimiters so manifest text cannot forge overview rows or columns. Formatters may not rewrite generated files after validation. Human edits begin by changing the manifest model, then rerendering and minting a new identity.''',
    "malformed input and renderer structure contract",
)

replace_once(
    "docs/contracts/tickets-manifest.md",
    '''- ordered versus unordered scope overlap;''',
    '''- ordered versus unordered scope overlap, including case-collision aliases;''',
    "scope overlap test matrix",
)

replace_once(
    "docs/contracts/tickets-manifest.md",
    '''- key order, CRLF, BOM, non-NFC, duplicate JSON keys and extra fields;''',
    '''- key order, CRLF, BOM, non-NFC, duplicate JSON keys, malformed nested shapes and extra fields;''',
    "malformed shape test matrix",
)

replace_once(
    "docs/contracts/tickets-manifest.md",
    '''- proof that operational fields are never read from Markdown;''',
    '''- proof that operational fields are never read from Markdown;
- renderer resistance to heading/table structural injection;''',
    "renderer injection test matrix",
)

replace_once(
    "02-architecture.md",
    '''Перед Ticket Panel host-only `validateTicketsCandidateTree` без следования symlink ancestors и с pre-read size guards читает raw manifest и внешнюю file inventory из exact candidate tree; omission/self-render substitution запрещены. Затем deterministic validator проверяет closed Schema, raw/pre-parse и declared limits, canonical bytes, heap-backed stable Kahn DAG, path-scope overlap/order, governing/evidence refs, exact previous-manifest context для revision lineage и byte-identical renderer output.''',
    '''Перед Ticket Panel host-only `validateTicketsCandidateTree` без следования symlink ancestors и с pre-read size guards читает raw manifest и внешнюю file inventory из exact candidate tree; omission/self-render substitution запрещены. Затем deterministic validator fail-closed останавливается на Schema-invalid nested shapes до graph/renderer, проверяет closed Schema, raw/pre-parse и declared limits, canonical bytes, heap-backed stable Kahn DAG, conservative case-collision path-scope overlap/order, governing/evidence refs, exact previous-manifest context для revision lineage и byte-identical injection-safe renderer output.''',
    "architecture malformed/collision/rendering boundary",
)

replace_once(
    "03-technical-plan.md",
    '''| validate_tickets_manifest | kind!=tickets либо manifest/path set отсутствует, path ancestor is symlink/non-directory, pre-read byte bound exceeded, unsupported/noncanonical/schema-invalid, semantic/DAG/path-overlap/lineage/prior-ID/limit/ref validation fails, rendered path/bytes drift, or alignment/planning/runtime/protocol/instruction identity stale | human с park.reason=tickets_manifest_invalid либо tickets_manifest_stale; no candidate/Panel/task/blocker side effects |''',
    '''| validate_tickets_manifest | kind!=tickets либо manifest/path set отсутствует, path ancestor is symlink/non-directory, pre-read byte bound exceeded, unsupported/noncanonical/schema-invalid (including malformed nested shapes), semantic/DAG/case-collision path-overlap/lineage/prior-ID/limit/ref validation fails, rendered path/bytes/structure drift, or alignment/planning/runtime/protocol/instruction identity stale | human с park.reason=tickets_manifest_invalid либо tickets_manifest_stale; no graph/renderer exception and no candidate/Panel/task/blocker side effects |''',
    "technical malformed/collision/rendering boundary",
)

print("Applied final clean issue #6 hardening.")
