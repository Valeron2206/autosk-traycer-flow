from __future__ import annotations

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
    'import { lstatSync, readFileSync, readdirSync } from "node:fs";',
    'import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";',
    "filesystem imports",
)

replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    '''function selectorContains(selector, candidatePath) {
  if (selector.kind === "file") return selector.path === candidatePath;
  return candidatePath === selector.path || candidatePath.startsWith(`${selector.path}/`);
}
''',
    '''function selectorContains(selector, candidatePath) {
  const selectorPath = collisionKey(selector.path);
  const comparedPath = collisionKey(candidatePath);
  if (selector.kind === "file") return selectorPath === comparedPath;
  return comparedPath === selectorPath || comparedPath.startsWith(`${selectorPath}/`);
}
''',
    "case-stable selector overlap",
)

replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    '''function oneLine(value) {
  return String(value).replace(/\\s+/gu, " ").trim();
}
''',
    '''function oneLine(value) {
  return String(value).replace(/\\s+/gu, " ").trim();
}

function markdownTableCell(value) {
  return oneLine(value).replaceAll("|", "&#124;");
}
''',
    "Markdown cell helper",
)

replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    '''  const rows = manifest.tickets.map((ticket) =>
    `| ${ticket.id} | ${oneLine(ticket.title)} | ${ticket.work_type} | ${ticket.depends_on.join(", ") || "—"} | ${oneLine(ticket.goal)} |`,
  );
''',
    '''  const rows = manifest.tickets.map((ticket) =>
    `| ${ticket.id} | ${markdownTableCell(ticket.title)} | ${ticket.work_type} | ${ticket.depends_on.join(", ") || "—"} | ${markdownTableCell(ticket.goal)} |`,
  );
''',
    "Markdown overview rows",
)

replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    '''      `# ${ticket.id} — ${ticket.title}`,
''',
    '''      `# ${ticket.id} — ${oneLine(ticket.title)}`,
''',
    "one-line Ticket heading",
)

replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    '''function resolveInsideCandidateRoot(candidateRoot, relativePath) {
  if (typeof candidateRoot !== "string" || candidateRoot.length === 0 || !validRelativePath(relativePath)) return null;
  const absoluteRoot = path.resolve(candidateRoot);
  const absolutePath = path.resolve(absoluteRoot, ...relativePath.split("/"));
  if (!absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) return null;
  return { absoluteRoot, absolutePath };
}
''',
    '''function resolveInsideCandidateRoot(candidateRoot, relativePath) {
  if (typeof candidateRoot !== "string" || candidateRoot.length === 0 || !validRelativePath(relativePath)) return null;
  let absoluteRoot;
  try {
    absoluteRoot = realpathSync.native(path.resolve(candidateRoot));
  } catch {
    return null;
  }
  const absolutePath = path.resolve(absoluteRoot, ...relativePath.split("/"));
  if (!absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) return null;
  return { absoluteRoot, absolutePath };
}
''',
    "canonical candidate root resolution",
)

replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    '''    const metadata = lstatSync(resolved.absolutePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      errors.push(error("tickets_path_invalid", pointer, "candidate path is not a regular non-symlink file", { path: relativePath }));
      return null;
    }
    return readFileSync(resolved.absolutePath);
''',
    '''    const metadata = lstatSync(resolved.absolutePath);
    const canonicalPath = realpathSync.native(resolved.absolutePath);
    if (canonicalPath !== resolved.absolutePath || metadata.isSymbolicLink() || !metadata.isFile()) {
      errors.push(error("tickets_path_invalid", pointer, "candidate path or one of its components is not a regular non-symlink path", { path: relativePath }));
      return null;
    }
    return readFileSync(resolved.absolutePath);
''',
    "candidate file symlink closure",
)

replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    '''    rootMetadata = lstatSync(resolved.absoluteRoot);
    directoryMetadata = lstatSync(resolved.absolutePath);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      throw new Error("candidate root is not a regular directory");
    }
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      throw new Error("Tickets path is not a regular directory");
    }
''',
    '''    rootMetadata = lstatSync(resolved.absoluteRoot);
    directoryMetadata = lstatSync(resolved.absolutePath);
    const canonicalDirectoryPath = realpathSync.native(resolved.absolutePath);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      throw new Error("candidate root is not a regular directory");
    }
    if (canonicalDirectoryPath !== resolved.absolutePath || directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      throw new Error("Tickets path or one of its components is not a regular non-symlink directory");
    }
''',
    "candidate directory symlink closure",
)

replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    '''    if (lineage.kind === "new") {
      if (predecessors.length !== 0 || previousById.has(ticket.id)) {
        errors.push(error("tickets_lineage_invalid", pointer, "new lineage cannot reuse a prior Ticket or name predecessors"));
      }
      continue;
    }
    for (const predecessorId of predecessors) {
''',
    '''    if (lineage.kind === "new") {
      if (predecessors.length !== 0 || previousById.has(ticket.id)) {
        errors.push(error("tickets_lineage_invalid", pointer, "new lineage cannot reuse a prior Ticket or name predecessors"));
      }
      continue;
    }
    if (previousById.has(ticket.id) && lineage.kind !== "carry" && lineage.kind !== "revise") {
      errors.push(error("tickets_lineage_invalid", pointer, "a prior Ticket ID may be retained only by carry or revise of that same predecessor", {
        reused_ticket_id: ticket.id,
      }));
    }
    for (const predecessorId of predecessors) {
''',
    "Ticket ID non-reuse lineage guard",
)

replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    '''  for (const schemaError of validateJsonSchema(manifest, schema)) {
    errors.push(error("tickets_manifest_schema_invalid", "", String(schemaError)));
  }
  validateStringTree(manifest, "", errors);
  const rawTextValue = rawText === null ? null : canonicalText(rawText);
  if (rawText !== null && (rawTextValue === null || canonicalStringify(manifest) !== rawTextValue)) {
    errors.push(error("tickets_manifest_noncanonical", "", "manifest bytes do not equal canonical serialization"));
  }

  const countErrors = countLimitErrors(manifest);
''',
    '''  const schemaErrors = validateJsonSchema(manifest, schema);
  for (const schemaError of schemaErrors) {
    errors.push(error("tickets_manifest_schema_invalid", "", String(schemaError)));
  }
  validateStringTree(manifest, "", errors);
  const rawTextValue = rawText === null ? null : canonicalText(rawText);
  if (rawText !== null && (rawTextValue === null || canonicalStringify(manifest) !== rawTextValue)) {
    errors.push(error("tickets_manifest_noncanonical", "", "manifest bytes do not equal canonical serialization"));
  }
  if (schemaErrors.length > 0) return errors.sort(errorComparator);

  const countErrors = countLimitErrors(manifest);
''',
    "schema-first fail-closed semantic boundary",
)

replace_once(
    "docs/contracts/tickets-manifest.md",
    '''Ticket IDs match `T[0-9]{2,6}`, are ASCII and unique, and are never reused for unrelated work in one Epic history. Acceptance IDs match `AC-<ticket-id>-<nnn>`. Every Ticket has exactly one Markdown path beginning with its ID. Path uniqueness is checked bytewise and under the supported filesystem case/Unicode collision policy.
''',
    '''Ticket IDs match `T[0-9]{2,6}`, are ASCII and unique, and are never reused for unrelated work in one Epic history. Across revisions, an existing ID may appear only as `carry` or `revise` of that exact predecessor; `new`, `replace`, `split_child` and `merge_result` must use IDs absent from the immediately previous manifest. Acceptance IDs match `AC-<ticket-id>-<nnn>`. Every Ticket has exactly one Markdown path beginning with its ID. Path uniqueness is checked bytewise and under the supported filesystem case/Unicode collision policy.
''',
    "stable ID contract",
)

replace_once(
    "docs/contracts/tickets-manifest.md",
    '''Two Tickets overlap when their selectors can address the same path. In v1, overlapping Tickets must be ordered by a transitive dependency in one direction. Incomparable overlap is `tickets_scope_overlap_unordered`.
''',
    '''Two Tickets overlap when their selectors can address the same path under the conservative v1 case/Unicode collision key, even when their path bytes differ only by case. In v1, overlapping Tickets must be ordered by a transitive dependency in one direction. Incomparable overlap is `tickets_scope_overlap_unordered`.
''',
    "case-collision overlap contract",
)

replace_once(
    "docs/contracts/tickets-manifest.md",
    '''A missing, extra, renamed or one-byte-different document is invalid. The host entry point `validateTicketsCandidateTree` reads the manifest as raw bytes from the exact candidate/publication tree, enumerates the sibling Tickets directory, rejects symlinks/non-regular/nested entries, and passes that external inventory to the semantic validator. A caller cannot omit the inventory or substitute freshly rendered bytes for the candidate files. Formatters may not rewrite generated files after validation. Human edits begin by changing the manifest model, then rerendering and minting a new identity.
''',
    '''A missing, extra, renamed or one-byte-different document is invalid. The host entry point `validateTicketsCandidateTree` reads the manifest as raw bytes from the exact candidate/publication tree, enumerates the sibling Tickets directory, rejects symlinks in any path component plus non-regular/nested entries, and passes that external inventory to the semantic validator. Schema-invalid shapes return typed validation errors before semantic graph/renderer routines and never crash the host. A caller cannot omit the inventory or substitute freshly rendered bytes for the candidate files. The renderer normalizes headings to one line and escapes Markdown table delimiters so a manifest string cannot forge overview columns. Formatters may not rewrite generated files after validation. Human edits begin by changing the manifest model, then rerendering and minting a new identity.
''',
    "candidate rendering and malformed-input contract",
)

replace_once(
    "docs/contracts/tickets-manifest.md",
    '''- missing/extra/renamed/one-byte-drift rendered docs;
- key order, CRLF, BOM, non-NFC, duplicate JSON keys and extra fields;
''',
    '''- missing/extra/renamed/one-byte-drift rendered docs and intermediate-component symlink escape;
- key order, CRLF, BOM, non-NFC, duplicate JSON keys, malformed nested shapes and extra fields;
''',
    "required path/schema tests",
)

replace_once(
    "docs/contracts/tickets-manifest.md",
    '''- initial/revised carry/revise/replace/split/merge/retirement lineage;
''',
    '''- initial/revised carry/revise/replace/split/merge/retirement lineage, including forbidden reuse of another prior Ticket ID;
''',
    "required ID-reuse test",
)

replace_once(
    "test/validate-tickets-manifest-design.test.mjs",
    'import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";',
    'import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";',
    "test filesystem imports",
)

append = r'''

test("schema-invalid nested shapes fail closed without semantic exceptions", () => {
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
  }
});

test("revision lineage forbids reuse of another prior Ticket ID", () => {
  const previous = fixture();
  const replacement = ticketWithId(previous.tickets[0], "T02", "reused-prior-id");
  replacement.lineage = { kind: "replace", predecessor_ids: ["T01"] };
  const current = makeRevision(previous, [replacement], [{
    decision_ref: "decision:retire-old-t02",
    disposition: "dropped",
    predecessor_id: "T02",
    rationale: "The old T02 is retired so only the cross-lineage ID reuse remains under test.",
    successor_ids: [],
  }]);
  assert.ok(codes(
    current,
    canonicalStringify(current),
    { previousManifestContext: previousManifestContext(previous) },
  ).includes("tickets_lineage_invalid"));
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

test("candidate-tree rejects a symlink in an intermediate path component", () => {
  const temporaryParent = mkdtempSync(path.join(tmpdir(), "autosk-ticket-symlink-"));
  const candidateRoot = path.join(temporaryParent, "candidate");
  const outsideRoot = path.join(temporaryParent, "outside");
  try {
    cpSync(EXAMPLE_CANDIDATE_ROOT, outsideRoot, { recursive: true });
    mkdirSync(candidateRoot, { recursive: true });
    symlinkSync(path.join(outsideRoot, "docs"), path.join(candidateRoot, "docs"), "dir");
    const errors = validateTicketsCandidateTree(candidateRoot, EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH);
    assert.ok(errors.some((entry) => entry.code === "tickets_path_invalid"));
  } finally {
    rmSync(temporaryParent, { force: true, recursive: true });
  }
});

test("renderer prevents title and table-cell structure injection", () => {
  const manifest = fixture();
  manifest.tickets[0].title = "Left | Right\ncontinued";
  manifest.tickets[0].goal = "Goal | second column";
  const documents = renderTicketDocuments(manifest);
  const overview = documents.get(`docs/autosk/epics/${manifest.epic_id}/tickets/README.md`);
  const ticket = documents.get(manifest.tickets[0].document_path);
  assert.match(overview, /Left &#124; Right continued/u);
  assert.match(overview, /Goal &#124; second column/u);
  assert.match(ticket, /^# T01 — Left \| Right continued$/mu);
  assert.doesNotMatch(ticket, /^continued$/mu);
});
'''

test_path = ROOT / "test/validate-tickets-manifest-design.test.mjs"
test_text = test_path.read_text(encoding="utf-8")
marker = 'schema-invalid nested shapes fail closed without semantic exceptions'
if marker in test_text:
    raise SystemExit("new hardening tests already present")
test_path.write_text(test_text + append, encoding="utf-8")

print("Applied final issue #6 integrity hardening.")
