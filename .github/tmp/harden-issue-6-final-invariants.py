#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, replacement: str, label: str) -> str:
    compiled = re.compile(pattern, re.DOTALL)
    matches = list(compiled.finditer(text))
    if len(matches) != 1:
        raise SystemExit(f"{label}: expected one match, found {len(matches)}")
    return compiled.sub(lambda _: replacement, text, count=1)


validator_path = ROOT / "scripts/validate-tickets-manifest-design.mjs"
validator = validator_path.read_text()

schema_pointer_helper = r'''
function schemaInstancePathToJsonPointer(schemaError) {
  const match = String(schemaError).match(/^(\$(?:\.[^.[\]\s]+|\[[0-9]+\])*)/u);
  if (!match) return "";
  const segments = [];
  for (const token of match[1].matchAll(/\.([^.[\]]+)|\[([0-9]+)\]/gu)) {
    segments.push(escapePointer(token[1] ?? token[2]));
  }
  return segments.length === 0 ? "" : `/${segments.join("/")}`;
}
'''
validator = replace_once(
    validator,
    '''function errorComparator(left, right) {
  return compareCodePoints(left.json_pointer, right.json_pointer)
    || compareCodePoints(left.code, right.code)
    || compareCodePoints(canonicalStringify(left.evidence), canonicalStringify(right.evidence));
}
''',
    '''function errorComparator(left, right) {
  return compareCodePoints(left.json_pointer, right.json_pointer)
    || compareCodePoints(left.code, right.code)
    || compareCodePoints(canonicalStringify(left.evidence), canonicalStringify(right.evidence));
}
''' + schema_pointer_helper,
    "Schema JSON-pointer helper",
)

old_path_helpers = r'''function resolveInsideCandidateRoot(candidateRoot, relativePath) {
  if (typeof candidateRoot !== "string" || candidateRoot.length === 0 || !validRelativePath(relativePath)) return null;
  const absoluteRoot = path.resolve(candidateRoot);
  const absolutePath = path.resolve(absoluteRoot, ...relativePath.split("/"));
  if (!absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) return null;
  return { absoluteRoot, absolutePath };
}

function regularFileBytes(candidateRoot, relativePath, errors, pointer) {
  const resolved = resolveInsideCandidateRoot(candidateRoot, relativePath);
  if (!resolved) {
    errors.push(error("tickets_path_invalid", pointer, "candidate path escapes or is outside the closed relative-path dialect", { path: relativePath }));
    return null;
  }
  try {
    const metadata = lstatSync(resolved.absolutePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      errors.push(error("tickets_path_invalid", pointer, "candidate path is not a regular non-symlink file", { path: relativePath }));
      return null;
    }
    return readFileSync(resolved.absolutePath);
  } catch (cause) {
    errors.push(error("tickets_rendered_path_missing", pointer, "candidate file is missing or unreadable", {
      cause: String(cause),
      path: relativePath,
    }));
    return null;
  }
}
'''

new_path_helpers = r'''function resolveInsideCandidateRoot(candidateRoot, relativePath) {
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
'''
validator = replace_once(validator, old_path_helpers, new_path_helpers, "descriptor ancestry and pre-read limits")

validator = replace_once(
    validator,
    '''    const bytes = regularFileBytes(candidateRoot, relativePath, errors, pointer);
    if (bytes !== null) documents.set(relativePath, bytes);''',
    '''    const bytes = regularFileBytes(
      candidateRoot,
      relativePath,
      errors,
      pointer,
      manifest.policy?.limits?.max_rendered_document_bytes,
      "max_rendered_document_bytes",
    );
    if (bytes !== null) documents.set(relativePath, bytes);''',
    "candidate Markdown pre-read limit",
)

validator = replace_once(
    validator,
    '''  const rawBytes = regularFileBytes(candidateRoot, manifestRelativePath, errors, "/manifest_path");
  if (rawBytes === null) return errors.sort(errorComparator);
  const parsed = parseTicketsManifest(rawBytes, { maxManifestBytes: options.maxManifestBytes });''',
    '''  const requestedManifestLimit = Number.isInteger(options.maxManifestBytes)
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
  const parsed = parseTicketsManifest(rawBytes, { maxManifestBytes: requestedManifestLimit });''',
    "manifest pre-read limit",
)

validator = replace_once(
    validator,
    '''  const tickets = Array.isArray(manifest.tickets) ? manifest.tickets : [];
  if (manifest.previous_manifest_digest === null) {
    for (const [index, ticket] of tickets.entries()) {''',
    '''  const tickets = Array.isArray(manifest.tickets) ? manifest.tickets : [];
  if (manifest.previous_manifest_digest === null) {
    if (manifest.manifest_revision !== 1) {
      errors.push(error("tickets_lineage_invalid", "/manifest_revision", "initial manifest revision must be exactly 1"));
    }
    for (const [index, ticket] of tickets.entries()) {''',
    "initial revision one",
)

old_previous_context = r'''  const previous = context.manifest;
  const previousRaw = canonicalText(context.raw_text);
  if (!previous || typeof previous !== "object" || Array.isArray(previous) || previousRaw === null) {
    errors.push(error("tickets_lineage_invalid", "/previous_manifest_digest", "previous manifest context is malformed"));
    return;
  }
  if (validateJsonSchema(previous, schema).length > 0 || canonicalStringify(previous) !== previousRaw) {
    errors.push(error("tickets_lineage_invalid", "/previous_manifest_digest", "previous manifest bytes are not the exact canonical published manifest"));
    return;
  }

  let previousDigests;'''

new_previous_context = r'''  const suppliedPrevious = context.manifest;
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

  let previousDigests;'''
validator = replace_once(validator, old_previous_context, new_previous_context, "canonical previous manifest context")

validator = replace_once(
    validator,
    '''    if (!sortedUnique(predecessors)) {
      errors.push(error("tickets_lineage_invalid", `${pointer}/predecessor_ids`, "predecessor IDs must be unique and sorted"));
    }
    if (lineage.kind === "new") {''',
    '''    if (!sortedUnique(predecessors)) {
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
    if (lineage.kind === "new") {''',
    "historical Ticket ID non-reuse",
)

old_validation_order = '''  for (const schemaError of validateJsonSchema(manifest, schema)) {
    errors.push(error("tickets_manifest_schema_invalid", "", String(schemaError)));
  }
  validateStringTree(manifest, "", errors);
  const rawTextValue = rawText === null ? null : canonicalText(rawText);
  if (rawText !== null && (rawTextValue === null || canonicalStringify(manifest) !== rawTextValue)) {
    errors.push(error("tickets_manifest_noncanonical", "", "manifest bytes do not equal canonical serialization"));
  }

  const countErrors = countLimitErrors(manifest);
  if (countErrors.length > 0) return [...errors, ...countErrors].sort(errorComparator);
'''
new_validation_order = '''  const countErrors = countLimitErrors(manifest);
  if (countErrors.length > 0) return [...errors, ...countErrors].sort(errorComparator);

  for (const schemaError of validateJsonSchema(manifest, schema)) {
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
'''
validator = replace_once(validator, old_validation_order, new_validation_order, "limits before Schema and exact Schema pointers")
validator_path.write_text(validator)

# Extend tests.
test_path = ROOT / "test/validate-tickets-manifest-design.test.mjs"
tests = test_path.read_text()
tests = replace_once(
    tests,
    'import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";',
    'import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";',
    "test fs imports",
)

extra_tests = r'''

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
'''
tests += extra_tests
test_path.write_text(tests)

# Tighten normative wording.
contract_path = ROOT / "docs/contracts/tickets-manifest.md"
contract = contract_path.read_text()
contract = replace_once(
    contract,
    '''Ticket IDs match `T[0-9]{2,6}`, are ASCII and unique, and are never reused for unrelated work in one Epic history.''',
    '''Ticket IDs match `T[0-9]{2,6}`, are ASCII and unique, and are never reused for unrelated work in one Epic history. A current ID present in the immediately previous manifest is valid only as `carry` or `revise` of that same predecessor; `new`, `replace`, `split_child` and `merge_result` cannot recycle any prior ID.''',
    "Ticket ID reservation contract",
)
contract = replace_once(
    contract,
    '''A new revision receives the exact previous published canonical manifest bytes plus the prior validation identity (`manifest_digest` and ordered Ticket execution-entry digests), and `previous_manifest_digest` must match that context.''',
    '''The initial manifest has `manifest_revision=1` and no previous digest. A new revision receives the exact previous published canonical manifest bytes plus the prior validation identity (`manifest_digest` and ordered Ticket execution-entry digests), and `previous_manifest_digest` must match that context. The same strict byte parser rejects BOM, CRLF, duplicate keys and non-NFC strings in previous context before lineage is evaluated.''',
    "initial and previous canonical revision contract",
)
contract = replace_once(
    contract,
    '''A missing, extra, renamed or one-byte-different document is invalid. The host entry point `validateTicketsCandidateTree` reads the manifest as raw bytes from the exact candidate/publication tree, enumerates the sibling Tickets directory, rejects symlinks/non-regular/nested entries, and passes that external inventory to the semantic validator.''',
    '''A missing, extra, renamed or one-byte-different document is invalid. The host entry point `validateTicketsCandidateTree` reads the manifest as raw bytes from the exact candidate/publication tree, walks every existing path ancestor without following symlinks, size-checks regular files before reading them, enumerates the sibling Tickets directory, rejects symlinks/non-regular/nested entries, and passes that external inventory to the semantic validator.''',
    "ancestor and pre-read boundary contract",
)
contract = replace_once(
    contract,
    '''Every error contains stable `code`, RFC 6901 `json_pointer`, message, related pointers and canonical evidence.''',
    '''Every error contains stable `code`, the smallest available RFC 6901 instance `json_pointer`, message, related pointers and canonical evidence. JSON Schema failures translate the validator instance path into that pointer rather than storing it only in free-form message text.''',
    "Schema error pointer contract",
)
contract = replace_once(
    contract,
    '''- initial/revised carry/revise/replace/split/merge/retirement lineage;''',
    '''- initial revision numbering, prior-ID reservation and revised carry/revise/replace/split/merge/retirement lineage;''',
    "lineage tests contract",
)
contract = replace_once(
    contract,
    '''- missing/extra/renamed/one-byte-drift rendered docs;''',
    '''- missing/extra/renamed/one-byte-drift rendered docs, symlinked ancestors and pre-read byte limits;''',
    "filesystem tests contract",
)
contract_path.write_text(contract)

architecture_path = ROOT / "02-architecture.md"
architecture = architecture_path.read_text()
architecture = replace_once(
    architecture,
    '''Перед Ticket Panel host-only `validateTicketsCandidateTree` читает raw manifest и внешнюю file inventory из exact candidate tree; omission/self-render substitution запрещены.''',
    '''Перед Ticket Panel host-only `validateTicketsCandidateTree` без следования symlink ancestors и с pre-read size guards читает raw manifest и внешнюю file inventory из exact candidate tree; omission/self-render substitution запрещены.''',
    "architecture filesystem guard",
)
architecture_path.write_text(architecture)

tech_path = ROOT / "03-technical-plan.md"
tech = tech_path.read_text()
tech = replace_once(
    tech,
    '''| validate_tickets_manifest | kind!=tickets либо manifest/path set отсутствует, unsupported/noncanonical/schema-invalid, semantic/DAG/path-overlap/lineage/limit/ref validation fails, rendered path/bytes drift, or alignment/planning/runtime/protocol/instruction identity stale | human с park.reason=tickets_manifest_invalid либо tickets_manifest_stale; no candidate/Panel/task/blocker side effects |''',
    '''| validate_tickets_manifest | kind!=tickets либо manifest/path set отсутствует, path ancestor is symlink/non-directory, pre-read byte bound exceeded, unsupported/noncanonical/schema-invalid, semantic/DAG/path-overlap/lineage/prior-ID/limit/ref validation fails, rendered path/bytes drift, or alignment/planning/runtime/protocol/instruction identity stale | human с park.reason=tickets_manifest_invalid либо tickets_manifest_stale; no candidate/Panel/task/blocker side effects |''',
    "technical invalid path and lineage guards",
)
tech_path.write_text(tech)

print("Applied final independent hardening for Ticket history, previous bytes, filesystem ancestry, size guards and Schema pointers.")
