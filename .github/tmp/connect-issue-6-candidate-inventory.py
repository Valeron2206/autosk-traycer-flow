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

validator = replace_once(
    validator,
    'import { readFileSync } from "node:fs";',
    'import { lstatSync, readFileSync, readdirSync } from "node:fs";',
    "filesystem imports",
)

constants = '''export const EXAMPLE_CANDIDATE_ROOT_RELATIVE = "resources/tickets-manifest/example-candidate";
export const EXAMPLE_CANDIDATE_ROOT = path.join(ROOT, EXAMPLE_CANDIDATE_ROOT_RELATIVE);
export const EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH = "docs/autosk/epics/11111111-1111-4111-8111-111111111111/tickets/tickets.manifest.json";
export const EXAMPLE_CANDIDATE_CONTRACT_FILES = Object.freeze([
  `${EXAMPLE_CANDIDATE_ROOT_RELATIVE}/${EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH}`,
  `${EXAMPLE_CANDIDATE_ROOT_RELATIVE}/docs/autosk/epics/11111111-1111-4111-8111-111111111111/tickets/README.md`,
  `${EXAMPLE_CANDIDATE_ROOT_RELATIVE}/docs/autosk/epics/11111111-1111-4111-8111-111111111111/tickets/T01-session-store.md`,
  `${EXAMPLE_CANDIDATE_ROOT_RELATIVE}/docs/autosk/epics/11111111-1111-4111-8111-111111111111/tickets/T02-session-api.md`,
]);
'''
validator = replace_once(
    validator,
    'export const ABSOLUTE_MAX_MANIFEST_BYTES = 16_777_216;\n',
    'export const ABSOLUTE_MAX_MANIFEST_BYTES = 16_777_216;\n' + constants,
    "example candidate constants",
)
validator = replace_once(
    validator,
    '  ".github/workflows/validate-traycer-parity.yml",\n]);',
    '  ".github/workflows/validate-traycer-parity.yml",\n  ...EXAMPLE_CANDIDATE_CONTRACT_FILES,\n]);',
    "candidate fixture contract files",
)

validator = replace_once(
    validator,
    '''function canonicalText(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: true }).decode(value);
  return null;
}''',
    '''function canonicalText(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      return null;
    }
  }
  return null;
}''',
    "typed invalid previous bytes",
)

entry_point = r'''
function resolveInsideCandidateRoot(candidateRoot, relativePath) {
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
    const bytes = regularFileBytes(candidateRoot, relativePath, errors, pointer);
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

  const rawBytes = regularFileBytes(candidateRoot, manifestRelativePath, errors, "/manifest_path");
  if (rawBytes === null) return errors.sort(errorComparator);
  const parsed = parseTicketsManifest(rawBytes, { maxManifestBytes: options.maxManifestBytes });
  errors.push(...parsed.errors);
  if (!parsed.manifest) return errors.sort(errorComparator);

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
'''
validator = replace_once(
    validator,
    '\nexport function ticketManifestDigests(manifest) {',
    '\n' + entry_point + '\nexport function ticketManifestDigests(manifest) {',
    "candidate-tree entry point",
)

validator = replace_once(
    validator,
    '''    if (Object.prototype.hasOwnProperty.call(options, "candidateDocuments")) {
      errors.push(...compareRenderedTicketDocuments(manifest, options.candidateDocuments));
    }''',
    '''    if (!Object.prototype.hasOwnProperty.call(options, "candidateDocuments")) {
      errors.push(error("tickets_rendered_path_missing", "/rendered_documents", "exact candidate rendered document inventory is required"));
    } else {
      errors.push(...compareRenderedTicketDocuments(manifest, options.candidateDocuments));
    }''',
    "required candidate inventory",
)

old_design_block = '''  const parsed = parseTicketsManifest(files["resources/tickets-manifest/tickets-manifest.example.json"] ?? "");
  errors.push(...parsed.errors.map((entry) => `manifest example: ${entry.code}: ${entry.message}`));
  if (parsed.manifest) {
    const documents = renderTicketDocuments(parsed.manifest);
    errors.push(...validateTicketsManifest(
      parsed.manifest,
      schema,
      files["resources/tickets-manifest/tickets-manifest.example.json"],
      { candidateDocuments: documents },
    ).map((entry) => `manifest example ${entry.json_pointer || "/"}: ${entry.code}: ${entry.message}`));
    if (documents.size !== parsed.manifest.tickets.length + 1) errors.push("renderer did not produce one overview plus one document per Ticket");
    const digests = ticketManifestDigests(parsed.manifest);
    for (const value of [digests.manifest_digest, digests.dag_digest, digests.rendered_document_set_digest, digests.ticket_set_digest]) {
      if (!/^[0-9a-f]{64}$/u.test(value)) errors.push("ticket digest is not SHA-256");
    }
  }'''
new_design_block = '''  const exampleText = files["resources/tickets-manifest/tickets-manifest.example.json"] ?? "";
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
  }'''
validator = replace_once(validator, old_design_block, new_design_block, "design entry-point self-comparison")

old_cli = '''if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = loadTicketsManifestFiles();
  const errors = validateTicketsManifestDesign(files);
  if (errors.length > 0) {
    console.error(errors.join("\\n"));
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
}'''
new_cli = '''function commandLineOption(name) {
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
      console.error(errors.map((entry) => `${entry.json_pointer || "/"}: ${entry.code}: ${entry.message}`).join("\\n"));
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
      console.error(errors.sort(compareCodePoints).join("\\n"));
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
}'''
validator = replace_once(validator, old_cli, new_cli, "CLI candidate-tree validation")
validator_path.write_text(validator)

# Tests: require inventory everywhere and add real on-disk/CLI integration coverage.
test_path = ROOT / "test/validate-tickets-manifest-design.test.mjs"
tests = test_path.read_text()
tests = replace_once(
    tests,
    'import { readFileSync } from "node:fs";\nimport test from "node:test";',
    'import { spawnSync } from "node:child_process";\nimport { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport path from "node:path";\nimport test from "node:test";',
    "test filesystem imports",
)
tests = replace_once(
    tests,
    '''  MANIFEST_EXAMPLE_PATH,
  MANIFEST_SCHEMA_PATH,
  RECEIPT_SCHEMA_PATH,''',
    '''  EXAMPLE_CANDIDATE_CONTRACT_FILES,
  EXAMPLE_CANDIDATE_MANIFEST_RELATIVE_PATH,
  EXAMPLE_CANDIDATE_ROOT,
  EXAMPLE_CANDIDATE_ROOT_RELATIVE,
  MANIFEST_EXAMPLE_PATH,
  MANIFEST_SCHEMA_PATH,
  RECEIPT_SCHEMA_PATH,
  ROOT,''',
    "test candidate constants imports",
)
tests = replace_once(
    tests,
    '  loadTicketsManifestFiles,\n  parseTicketsManifest,',
    '  loadTicketsManifestFiles,\n  parseTicketsManifest,',
    "test import anchor",
)
tests = replace_once(
    tests,
    '  validateTicketsManifest,\n  validateTicketsManifestDesign,',
    '  validateTicketsCandidateTree,\n  validateTicketsManifest,\n  validateTicketsManifestDesign,',
    "test candidate validator import",
)
tests = replace_once(
    tests,
    '''function codes(manifest, rawText = null, options = {}) {
  return validateTicketsManifest(manifest, schema, rawText, options).map((entry) => entry.code);
}''',
    '''function candidateDocumentsFor(manifest) {
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
}''',
    "test default candidate documents",
)
tests = replace_once(
    tests,
    '  assert.deepEqual(validateTicketsManifest(example, schema, exampleText), []);',
    '  assert.deepEqual(validateTicketsManifest(example, schema, exampleText, { candidateDocuments: renderTicketDocuments(example) }), []);',
    "canonical example inventory",
)
tests = replace_once(
    tests,
    '  assert.ok(validateTicketsManifest(parsed, schema, reordered).some((entry) => entry.code === "tickets_manifest_noncanonical"));',
    '  assert.ok(validateTicketsManifest(parsed, schema, reordered, { candidateDocuments: renderTicketDocuments(parsed) }).some((entry) => entry.code === "tickets_manifest_noncanonical"));',
    "noncanonical inventory",
)
tests = replace_once(
    tests,
    '  const errors = validateTicketsManifest(manifest, schema);',
    '  const errors = validateTicketsManifest(manifest, schema, null, { candidateDocuments: renderTicketDocuments(manifest) });',
    "stable errors inventory",
)

integration_tests = r'''

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
'''
tests += integration_tests
test_path.write_text(tests)

# Tighten the normative and state-machine wording around the mandatory host entry point.
contract_path = ROOT / "docs/contracts/tickets-manifest.md"
contract = contract_path.read_text()
contract = replace_once(
    contract,
    '''A missing, extra, renamed or one-byte-different document is invalid. Formatters may not rewrite generated files after validation. Human edits begin by changing the manifest model, then rerendering and minting a new identity.''',
    '''A missing, extra, renamed or one-byte-different document is invalid. The host entry point `validateTicketsCandidateTree` reads the manifest as raw bytes from the exact candidate/publication tree, enumerates the sibling Tickets directory, rejects symlinks/non-regular/nested entries, and passes that external inventory to the semantic validator. A caller cannot omit the inventory or substitute freshly rendered bytes for the candidate files. Formatters may not rewrite generated files after validation. Human edits begin by changing the manifest model, then rerendering and minting a new identity.''',
    "renderer host entry point contract",
)
contract = replace_once(
    contract,
    '7. exact deterministic rendering comparison;',
    '7. exact candidate-tree file enumeration and deterministic rendering comparison;',
    "validation lifecycle inventory",
)
contract_path.write_text(contract)

architecture_path = ROOT / "02-architecture.md"
architecture = architecture_path.read_text()
architecture = replace_once(
    architecture,
    '''Перед Ticket Panel deterministic validator проверяет closed Schema, raw/pre-parse и declared limits, canonical bytes, heap-backed stable Kahn DAG, path-scope overlap/order, governing/evidence refs, exact previous-manifest context для revision lineage и byte-identical renderer output.''',
    '''Перед Ticket Panel host-only `validateTicketsCandidateTree` читает raw manifest и внешнюю file inventory из exact candidate tree; omission/self-render substitution запрещены. Затем deterministic validator проверяет closed Schema, raw/pre-parse и declared limits, canonical bytes, heap-backed stable Kahn DAG, path-scope overlap/order, governing/evidence refs, exact previous-manifest context для revision lineage и byte-identical renderer output.''',
    "architecture host inventory",
)
architecture_path.write_text(architecture)

tech_path = ROOT / "03-technical-plan.md"
tech = tech_path.read_text()
tech = replace_once(
    tech,
    '''| validate_tickets_manifest | canonical manifest, all declared limits current, stable heap-backed DAG/topological order, exact rendered document set, exact previous published manifest context for revisions and all controlling identities current | host computes manifest/DAG/document-set/Ticket execution-entry digests, writes/read-backs immutable `tickets_validation_receipt`, freeze_artifact |''',
    '''| validate_tickets_manifest | host `validateTicketsCandidateTree` loaded raw manifest plus exact external candidate-tree inventory; canonical manifest, all declared limits current, stable heap-backed DAG/topological order, exact rendered document set, exact previous published manifest context for revisions and all controlling identities current | host computes manifest/DAG/document-set/Ticket execution-entry digests, writes/read-backs immutable `tickets_validation_receipt`, freeze_artifact |''',
    "state-machine external inventory",
)
tech_path.write_text(tech)

readme_path = ROOT / "README.md"
readme = readme_path.read_text()
readme = replace_once(
    readme,
    '''```text
npm run validate:tickets-manifest
```''',
    '''```text
npm run validate:tickets-manifest
npm run validate:tickets-manifest -- --candidate-root <tree-root> --manifest-path docs/autosk/epics/<epic-id>/tickets/tickets.manifest.json
```

The candidate-tree form reads and compares the actual on-disk Markdown inventory; it does not compare renderer output with itself.''',
    "README candidate validation command",
)
readme_path.write_text(readme)

print("Connected the Tickets renderer comparison to an external candidate-tree entry point and added on-disk integration coverage.")
