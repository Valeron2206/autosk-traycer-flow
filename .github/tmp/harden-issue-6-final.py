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
    '''function selectorContains(selector, candidatePath) {
  if (selector.kind === "file") return selector.path === candidatePath;
  return candidatePath === selector.path || candidatePath.startsWith(`${selector.path}/`);
}

export function selectorsOverlap(left, right) {
  if (left.kind === "file" && right.kind === "file") return left.path === right.path;
''',
    '''function selectorContains(selector, candidatePath) {
  const selectorPath = collisionKey(selector.path);
  const comparedPath = collisionKey(candidatePath);
  if (selector.kind === "file") return selectorPath === comparedPath;
  return comparedPath === selectorPath || comparedPath.startsWith(`${selectorPath}/`);
}

export function selectorsOverlap(left, right) {
  if (left.kind === "file" && right.kind === "file") return collisionKey(left.path) === collisionKey(right.path);
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
    "Markdown table-cell encoder",
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
    "safe overview rows",
)

replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    '''      `# ${ticket.id} — ${ticket.title}`,
''',
    '''      `# ${ticket.id} — ${oneLine(ticket.title)}`,
''',
    "single-line Ticket heading",
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
  validateStringTree(manifest, "", errors);
  const rawTextValue = rawText === null ? null : canonicalText(rawText);
  if (rawText !== null && (rawTextValue === null || canonicalStringify(manifest) !== rawTextValue)) {
    errors.push(error("tickets_manifest_noncanonical", "", "manifest bytes do not equal canonical serialization"));
  }

  const tickets = Array.isArray(manifest.tickets) ? manifest.tickets : [];
''',
    '''  const schemaErrors = validateJsonSchema(manifest, schema);
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

  try {
  const tickets = Array.isArray(manifest.tickets) ? manifest.tickets : [];
''',
    "schema-aware semantic boundary start",
)

replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    '''  validateRevisionLineage(manifest, schema, options.previousManifestContext, errors);
  return errors.sort(errorComparator);
}
''',
    '''  validateRevisionLineage(manifest, schema, options.previousManifestContext, errors);
  } catch {
    errors.push(error(
      "tickets_manifest_schema_invalid",
      "",
      "schema-invalid shape cannot enter semantic validation",
      { phase: "semantic_validation" },
    ));
  }
  return errors.sort(errorComparator);
}
''',
    "schema-aware semantic boundary end",
)

replace_once(
    "docs/contracts/tickets-manifest.md",
    '''Two Tickets overlap when their selectors can address the same path. In v1, overlapping Tickets must be ordered by a transitive dependency in one direction. Incomparable overlap is `tickets_scope_overlap_unordered`.
''',
    '''Two Tickets overlap when their selectors can address the same path under the conservative v1 case/Unicode collision key, even when path bytes differ only by case. In v1, overlapping Tickets must be ordered by a transitive dependency in one direction. Incomparable overlap is `tickets_scope_overlap_unordered`.
''',
    "case-collision overlap contract",
)

replace_once(
    "docs/contracts/tickets-manifest.md",
    '''A missing, extra, renamed or one-byte-different document is invalid. The host entry point `validateTicketsCandidateTree` reads the manifest as raw bytes from the exact candidate/publication tree, walks every existing path ancestor without following symlinks, size-checks regular files before reading them, enumerates the sibling Tickets directory, rejects symlinks/non-regular/nested entries, and passes that external inventory to the semantic validator. A caller cannot omit the inventory or substitute freshly rendered bytes for the candidate files. Formatters may not rewrite generated files after validation. Human edits begin by changing the manifest model, then rerendering and minting a new identity.
''',
    '''A missing, extra, renamed or one-byte-different document is invalid. The host entry point `validateTicketsCandidateTree` reads the manifest as raw bytes from the exact candidate/publication tree, walks every existing path ancestor without following symlinks, size-checks regular files before reading them, enumerates the sibling Tickets directory, rejects symlinks/non-regular/nested entries, and passes that external inventory to the semantic validator. Schema-invalid nested shapes return typed validation errors and never escape as host exceptions; safe semantic-specific errors may still be emitted alongside Schema errors. A caller cannot omit the inventory or substitute freshly rendered bytes for the candidate files. The renderer normalizes headings to one line and escapes Markdown table delimiters so manifest strings cannot forge overview columns. Formatters may not rewrite generated files after validation. Human edits begin by changing the manifest model, then rerendering and minting a new identity.
''',
    "candidate rendering and malformed-input contract",
)

replace_once(
    "docs/contracts/tickets-manifest.md",
    '''- absolute/traversal/backslash/NUL/dot/collision paths;
- ordered versus unordered scope overlap;
''',
    '''- absolute/traversal/backslash/NUL/dot/collision paths;
- ordered versus unordered scope overlap, including case-only collisions;
''',
    "scope test contract",
)

replace_once(
    "docs/contracts/tickets-manifest.md",
    '''- key order, CRLF, BOM, non-NFC, duplicate JSON keys and extra fields;
''',
    '''- key order, CRLF, BOM, non-NFC, duplicate JSON keys, malformed nested shapes, Markdown delimiter injection and extra fields;
''',
    "malformed/rendering test contract",
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
      result = validateTicketsManifest(manifest, schema, canonicalStringify(manifest), {
        candidateDocuments: new Map(),
      });
    });
    assert.ok(result.some((entry) => entry.code === "tickets_manifest_schema_invalid"));
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

print("Applied final issue #6 semantic and renderer hardening.")
