import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_CHANGED_FILES,
  assertReportPath,
  computeAggregateDigest,
  computeCommandCapabilityHash,
  computeSummary,
  validateChangedFiles,
  validateDocumentation,
  validateRegistry,
  verifySourceMap,
} from "../scripts/validate-traycer-parity.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseRegistry = JSON.parse(readFileSync(path.join(ROOT, "resources/traycer-parity/registry.v1.json")));
const schema = JSON.parse(readFileSync(path.join(ROOT, "resources/traycer-parity/registry.schema.json")));
const documentation = {
  readme: readFileSync(path.join(ROOT, "README.md"), "utf8"),
  summary: readFileSync(path.join(ROOT, "docs/traycer-parity-registry.md"), "utf8"),
};

const clone = (value) => structuredClone(value);

function normalize(registry) {
  registry.sources.sort((left, right) => left.id.localeCompare(right.id));
  registry.summary = computeSummary(registry.sources);
  registry.aggregateDigest = computeAggregateDigest(registry.sources);
  return registry;
}

function mutated(change, refresh = true) {
  const registry = clone(baseRegistry);
  change(registry);
  return refresh ? normalize(registry) : registry;
}

function assertRegistryError(registry, pattern) {
  const errors = validateRegistry(registry, schema, documentation);
  assert.match(errors.join("\n"), pattern);
}

function findSource(registry, id) {
  return registry.sources.find((source) => source.id === id);
}

test("accepts the committed registry, schema, and documentation", () => {
  assert.deepEqual(validateRegistry(baseRegistry, schema, documentation), []);
});

test("rejects a registry with the wrong schema version", () => {
  assertRegistryError(mutated((registry) => { registry.schemaVersion = 2; }, false), /schemaVersion must be 1/);
});

test("rejects a missing Guide", () => {
  assertRegistryError(mutated((registry) => { registry.sources = registry.sources.filter((source) => source.kind !== "guide"); }), /guide ids must be exactly/);
});

test("rejects a missing protocol file", () => {
  assertRegistryError(mutated((registry) => { registry.sources = registry.sources.filter((source) => source.id !== "protocol.writing.unslop"); }), /protocol_file ids must be exactly/);
});

test("rejects a protocol sidecar as an extra source", () => {
  assertRegistryError(mutated((registry) => {
    const extra = clone(findSource(registry, "protocol.writing.unslop"));
    extra.id = "protocol.zz.ds-store";
    extra.sanitizedLocator = "traycer-protocol://sidecar.ds-store";
    extra.sha256 = "a".repeat(64);
    registry.sources.push(extra);
  }), /protocol_file ids must be exactly/);
});

test("rejects a missing Traycer skill", () => {
  assertRegistryError(mutated((registry) => { registry.sources = registry.sources.filter((source) => source.id !== "skill.review"); }), /traycer_skill ids must be exactly/);
});

test("rejects traycer-references as a fourteenth skill", () => {
  assertRegistryError(mutated((registry) => {
    const extra = clone(findSource(registry, "skill.review"));
    extra.id = "skill.traycer-references";
    extra.sanitizedLocator = "traycer-skill://traycer-references/SKILL.md";
    extra.sha256 = "b".repeat(64);
    registry.sources.push(extra);
  }), /traycer_skill ids must be exactly/);
});

test("rejects a command set that is not exactly six capabilities", () => {
  assertRegistryError(mutated((registry) => { registry.sources = registry.sources.filter((source) => source.id !== "command.size"); }), /traycer_protocol_command ids must be exactly/);
});

test("rejects a missing source test suite", () => {
  assertRegistryError(mutated((registry) => { registry.sources = registry.sources.filter((source) => source.id !== "test-suite.integrate-approved"); }), /traycer_test_suite ids must be exactly/);
});

test("rejects a missing validation record", () => {
  assertRegistryError(mutated((registry) => { registry.sources = registry.sources.filter((source) => source.id !== "validation.external-review-2"); }), /validation_record ids must be exactly/);
});

test("rejects malformed SHA-256", () => {
  assertRegistryError(mutated((registry) => { findSource(registry, "guide.agent-selection").sha256 = "bad"; }), /sha256 must be lowercase/);
});

test("rejects a stale aggregate digest", () => {
  assertRegistryError(mutated((registry) => { registry.aggregateDigest = "0".repeat(64); }, false), /aggregateDigest mismatch/);
});

test("rejects duplicate source ids", () => {
  assertRegistryError(mutated((registry) => { registry.sources[1].id = registry.sources[0].id; }), /duplicate id/);
});

test("rejects duplicate sanitized locators", () => {
  assertRegistryError(mutated((registry) => { registry.sources[1].sanitizedLocator = registry.sources[0].sanitizedLocator; }), /duplicate locator/);
});

test("rejects undeclared record properties", () => {
  assertRegistryError(mutated((registry) => { findSource(registry, "guide.agent-selection").extra = true; }), /undeclared properties: extra/);
});

test("rejects placeholder targets", () => {
  assertRegistryError(mutated((registry) => { findSource(registry, "guide.agent-selection").autoskTarget.component = "unmapped"; }), /contains a placeholder/);
});

test("rejects compound placeholder phrases", () => {
  for (const value of ["TODO: determine behavior", "unknown implementation target", "still unmapped here"]) {
    assertRegistryError(mutated((registry) => { findSource(registry, "guide.agent-selection").notes = value; }), /contains a placeholder/);
  }
});

test("rejects a missing classification", () => {
  assertRegistryError(mutated((registry) => { delete findSource(registry, "guide.agent-selection").classification; }), /classification must be non-empty/);
});

test("rejects a classification outside the closed enum", () => {
  assertRegistryError(mutated((registry) => { findSource(registry, "guide.agent-selection").classification = "later"; }), /classification is not allowed/);
});

test("rejects a private absolute path", () => {
  assertRegistryError(mutated((registry) => { findSource(registry, "guide.agent-selection").notes = "/Users/private-user/source"; }), /contains private material/);
});

test("rejects an implementation parity claim", () => {
  assertRegistryError(mutated((registry) => { findSource(registry, "guide.agent-selection").parityClaim = "implemented"; }), /parityClaim must be mapping_only/);
});

test("rejects a missing autosk-native target", () => {
  assertRegistryError(mutated((registry) => { findSource(registry, "guide.agent-selection").autoskTarget.component = ""; }), /component must be non-empty/);
});

test("rejects a missing disposition", () => {
  assertRegistryError(mutated((registry) => { delete findSource(registry, "guide.agent-selection").disposition; }), /disposition must be non-empty/);
});

for (const field of ["reason", "risk", "owner", "returnTrigger", "notImplementedProof"]) {
  test(`rejects a deferred record without ${field}`, () => {
    assertRegistryError(mutated((registry) => { delete findSource(registry, "skill.autobuild").defer[field]; }), new RegExp(`defer\\.${field} must be non-empty`));
  });
}

test("rejects a deferred record classified for v1", () => {
  assertRegistryError(mutated((registry) => { findSource(registry, "skill.autobuild").classification = "v1"; }), /deferred records must be post_v1/);
});

test("rejects defer metadata on a non-deferred record", () => {
  assertRegistryError(mutated((registry) => { findSource(registry, "guide.agent-selection").defer = clone(findSource(registry, "skill.autobuild").defer); }), /defer is allowed only/);
});

test("rejects an implemented flag on a deferred record", () => {
  assertRegistryError(mutated((registry) => { findSource(registry, "skill.autobuild").implemented = true; }), /undeclared properties: implemented/);
});

test("rejects missing archive evidence", () => {
  assertRegistryError(mutated((registry) => { registry.sourceEvidence.archives.pop(); }, false), /expected 4 archive evidence/);
});

test("rejects extra archive evidence", () => {
  assertRegistryError(mutated((registry) => { registry.sourceEvidence.archives.push(clone(registry.sourceEvidence.archives[0])); }, false), /expected 4 archive evidence/);
});

test("rejects a wrong archive hash", () => {
  assertRegistryError(mutated((registry) => { registry.sourceEvidence.archives[0].sha256 = "0".repeat(64); }, false), /archive archive.agents sha256 mismatch/);
});

test("rejects a wrong archive count", () => {
  assertRegistryError(mutated((registry) => { registry.sourceEvidence.archives[1].inventory.entries += 1; }, false), /inventory.entries must be 40/);
});

test("rejects invented unavailable archive counts", () => {
  assertRegistryError(mutated((registry) => { registry.sourceEvidence.archives[0].inventory.regularFiles = 1; }, false), /inventory fields differ/);
});

test("rejects a missing source evidence gap", () => {
  assertRegistryError(mutated((registry) => { registry.sourceEvidence.gaps.pop(); }, false), /expected 2 source evidence gaps/);
});

test("rejects an extra source evidence gap", () => {
  assertRegistryError(mutated((registry) => { registry.sourceEvidence.gaps.push(clone(registry.sourceEvidence.gaps[0])); }, false), /expected 2 source evidence gaps/);
});

test("rejects a gap falsely marked resolved", () => {
  assertRegistryError(mutated((registry) => { registry.sourceEvidence.gaps[0].status = "resolved"; }, false), /must remain not_found/);
});

test("documentation allows explicit no-runtime statements but rejects private paths", () => {
  assert.deepEqual(validateDocumentation(`${documentation.readme}\nruntime does not read ~/.traycer or call traycer_*`, documentation.summary, baseRegistry), []);
  assert.match(validateDocumentation(`${documentation.readme}\nsource /Users/private-user/file`, documentation.summary, baseRegistry).join("\n"), /private material/);
});

test("documentation rejects an actionable Traycer runtime dependency", () => {
  const errors = validateDocumentation(`${documentation.readme}\nRuntime reads ~/.traycer and calls traycer_do_work`, documentation.summary, baseRegistry);
  assert.match(errors.join("\n"), /actionable Traycer runtime dependency/);
});

test("documentation rejects a positive Traycer call hidden behind a separate negation", () => {
  for (const statement of [
    "Runtime does not read ~/.traycer but calls traycer_do_work",
    "Runtime не читает ~/.traycer, но вызывает traycer_get_context",
  ]) {
    const errors = validateDocumentation(`${documentation.readme}\n${statement}`, documentation.summary, baseRegistry);
    assert.match(errors.join("\n"), /actionable Traycer runtime dependency/);
  }
});

test("documentation may describe declared registry kind tokens", () => {
  const readme = `${documentation.readme}\nThe registry uses \`traycer_skill\` and \`traycer_protocol_command\` records.`;
  assert.deepEqual(validateDocumentation(readme, documentation.summary, baseRegistry), []);
});

test("declared registry kind tokens are still rejected as runtime dependencies", () => {
  for (const token of ["traycer_skill", "traycer_protocol_binary", "traycer_protocol_command", "traycer_test_suite"]) {
    for (const statement of [`Runtime loads ${token}`, `The registry records require production to load ${token}`]) {
      const readme = `${documentation.readme}\n${statement}`;
      assert.match(validateDocumentation(readme, documentation.summary, baseRegistry).join("\n"), /actionable Traycer runtime dependency/);
    }
  }
});

test("registry rejects private and session-derived strings outside sanitized negative statements", () => {
  for (const value of [
    "responseId abc123",
    "$HOME/project",
    "~/.agents/private",
    "Desktop/TraycerRules/private",
    "transcript copied",
    "session copied",
  ]) {
    assertRegistryError(mutated((registry) => { findSource(registry, "guide.agent-selection").notes = value; }), /contains private material/);
  }
});

test("documentation rejects false completed-parity claims", () => {
  const readme = documentation.readme.replace("Implemented parity: 0% (0/37)", "Implemented parity: 100% (37/37)");
  assert.match(validateDocumentation(readme, documentation.summary, baseRegistry).join("\n"), /Implemented parity/);
});

test("each document independently rejects any non-zero delivery claim", () => {
  const readme = documentation.readme.replace("Implemented parity: 0% (0/37)", "Implemented parity: 1% (1/37)");
  const summary = documentation.summary.replace("Verified parity: 0% (0/37)", "Verified parity: 95% (35/37)");
  assert.match(validateDocumentation(readme, documentation.summary, baseRegistry).join("\n"), /Implemented parity/);
  assert.match(validateDocumentation(documentation.readme, summary, baseRegistry).join("\n"), /Verified parity/);
});

test("summary document counts must match the registry summary", () => {
  const drifted = documentation.summary.replace("`v1`: 31", "`v1`: 30");
  assert.match(validateDocumentation(documentation.readme, drifted, baseRegistry).join("\n"), /v1 count/);
});

test("changed-file scope accepts only the exact issue #3 set", () => {
  assert.deepEqual(validateChangedFiles(ALLOWED_CHANGED_FILES), []);
  assert.match(validateChangedFiles([...ALLOWED_CHANGED_FILES, "03-technical-plan.md"]).join("\n"), /outside scope/);
  assert.match(validateChangedFiles(ALLOWED_CHANGED_FILES.slice(1)).join("\n"), /required changed files missing/);
});

test("issue #3 scope gate is skipped after the registry exists in the base", () => {
  assert.deepEqual(validateChangedFiles(["src/future-work.ts"], { baseContainsRegistry: true }), []);
});

test("push validation does not require a branch diff while pull requests keep the scope gate", () => {
  const packageJson = JSON.parse(readFileSync(path.join(ROOT, "package.json")));
  const workflow = readFileSync(path.join(ROOT, ".github/workflows/validate-traycer-parity.yml"), "utf8");
  assert.equal(packageJson.scripts["validate:migration"], "node scripts/validate-traycer-parity.mjs");
  assert.equal(packageJson.scripts["validate:scope"], "node scripts/validate-traycer-parity.mjs --check-file-scope");
  assert.match(workflow, /if: github\.event_name == 'pull_request'/);
  assert.match(workflow, /run: npm run validate:scope -- "\$\{\{ github\.event\.pull_request\.base\.sha \}\}"/);
});

test("workflow actions are immutable and checkout does not persist credentials", () => {
  const workflow = readFileSync(path.join(ROOT, ".github/workflows/validate-traycer-parity.yml"), "utf8");
  assert.match(workflow, /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /actions\/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5/);
});

test("source report output is rejected inside the worktree", () => {
  assert.match(assertReportPath(path.join(ROOT, "report.json")).join("\n"), /outside the worktree/);
  assert.match(assertReportPath(ROOT).join("\n"), /outside the worktree/);
  assert.deepEqual(assertReportPath(path.join(os.tmpdir(), "autosk-issue3-report.json")), []);
});

test("source report output rejects a symlink that resolves into the worktree", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "autosk-parity-report-"));
  const link = path.join(directory, "report.json");
  symlinkSync(path.join(ROOT, "README.md"), link);
  assert.match(assertReportPath(link).join("\n"), /symlink|outside the worktree/);
});

test("source report output rejects a dangling symlink into the worktree", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "autosk-parity-dangling-report-"));
  const link = path.join(directory, "report.json");
  symlinkSync(path.join(ROOT, "inside-report.json"), link);
  assert.match(assertReportPath(link).join("\n"), /symlink|outside the worktree/);
});

function syntheticSources() {
  const registry = clone(baseRegistry);
  const directory = mkdtempSync(path.join(os.tmpdir(), "autosk-parity-sources-"));
  const sourceMap = { schemaVersion: 1, sources: {} };
  for (const source of registry.sources.filter((entry) => entry.kind !== "traycer_protocol_command")) {
    const filePath = path.join(directory, source.id.replaceAll("/", "_"));
    const bytes = `source:${source.id}\n`;
    writeFileSync(filePath, bytes);
    source.sha256 = createHash("sha256").update(bytes).digest("hex");
    sourceMap.sources[source.id] = filePath;
  }
  const binary = findSource(registry, "executable.traycer-protocol");
  for (const source of registry.sources.filter((entry) => entry.kind === "traycer_protocol_command")) {
    source.sha256 = computeCommandCapabilityHash(source.id.slice(8), binary.sha256);
  }
  normalize(registry);
  return { registry, sourceMap, directory };
}

test("source verification accepts exact regular-file bytes without writing", () => {
  const fixture = syntheticSources();
  const before = readdirSync(fixture.directory);
  const result = verifySourceMap(fixture.registry, fixture.sourceMap);
  const after = readdirSync(fixture.directory);
  assert.deepEqual(result.errors, []);
  assert.equal(result.report.records.length, 31);
  assert.ok(result.report.records.every((record) => record.status === "pass"));
  assert.deepEqual(after, before);
});

test("source verification rejects missing, extra, and mismatched sources", () => {
  const missing = syntheticSources();
  delete missing.sourceMap.sources[Object.keys(missing.sourceMap.sources)[0]];
  assert.match(verifySourceMap(missing.registry, missing.sourceMap).errors.join("\n"), /missing ids/);

  const extra = syntheticSources();
  extra.sourceMap.sources.extra = path.join(extra.directory, "extra");
  assert.match(verifySourceMap(extra.registry, extra.sourceMap).errors.join("\n"), /extra ids/);

  const mismatch = syntheticSources();
  const firstPath = Object.values(mismatch.sourceMap.sources)[0];
  writeFileSync(firstPath, "changed\n");
  assert.match(verifySourceMap(mismatch.registry, mismatch.sourceMap).errors.join("\n"), /source hash mismatch/);
});

test("source verification rejects empty, null, and non-string path values", () => {
  for (const value of ["", "   ", null, 42]) {
    const fixture = syntheticSources();
    fixture.sourceMap.sources[Object.keys(fixture.sourceMap.sources)[0]] = value;
    assert.match(verifySourceMap(fixture.registry, fixture.sourceMap).errors.join("\n"), /source path must be non-empty/);
  }
});

test("source verification rejects a directory in place of a regular file", () => {
  const fixture = syntheticSources();
  const id = Object.keys(fixture.sourceMap.sources)[0];
  const directory = path.join(fixture.directory, "not-a-file");
  mkdirSync(directory);
  fixture.sourceMap.sources[id] = directory;
  assert.match(verifySourceMap(fixture.registry, fixture.sourceMap).errors.join("\n"), /not a regular file/);
});

test("registry schema pointer is mandatory", () => {
  assertRegistryError(mutated((registry) => { delete registry.$schema; }), /registry\.\$schema/);
});

test("verification evidence references must contain non-empty strings", () => {
  for (const value of [null, ""]) {
    assertRegistryError(mutated((registry) => { findSource(registry, "guide.agent-selection").verification.evidenceRefs = [value]; }), /evidenceRefs/);
  }
});

test("schema locator grammar and deferred condition are load-bearing", () => {
  const driftedPattern = clone(schema);
  driftedPattern.properties.sources.items.properties.sanitizedLocator.pattern = "^anything";
  assert.match(validateRegistry(baseRegistry, driftedPattern, documentation).join("\n"), /schema locator pattern/);

  const missingCondition = clone(schema);
  missingCondition.properties.sources.items.allOf = [];
  assert.match(validateRegistry(baseRegistry, missingCondition, documentation).join("\n"), /schema (?:deferred|sourceRef) condition/);
});

test("schema top-level required fields and deferred then.required are exact", () => {
  const missingTopRequired = clone(schema);
  missingTopRequired.required = missingTopRequired.required.filter((key) => key !== "$schema");
  assert.match(validateRegistry(baseRegistry, missingTopRequired, documentation).join("\n"), /schema top-level required fields/);

  const missingDeferRequired = clone(schema);
  missingDeferRequired.properties.sources.items.allOf[0].then.required = [];
  assert.match(validateRegistry(baseRegistry, missingDeferRequired, documentation).join("\n"), /schema deferred condition/);
});

test("locator grammar rejects invalid schemes and spaces consistently", () => {
  assert.equal(schema.properties.sources.items.properties.sanitizedLocator.pattern, "^[a-z][a-z0-9-]*://[A-Za-z0-9._/-]+$");
  assertRegistryError(mutated((registry) => { findSource(registry, "guide.agent-selection").sanitizedLocator = "9x://abc"; }), /sanitizedLocator is invalid/);
  assertRegistryError(mutated((registry) => { findSource(registry, "guide.agent-selection").sanitizedLocator = "traycer-guide://a b"; }), /sanitizedLocator is invalid/);
});

test("source evidence rejects private paths and transcript material", () => {
  for (const value of ["/home/alice/private", "/root/private", "C:\\Users\\alice\\private", "$HOME/private", "raw transcript copied"]) {
    assertRegistryError(mutated((registry) => { registry.sourceEvidence.gaps[0].searchedScope = value; }, false), /sourceEvidence contains private material/);
  }
});

test("registry rejects actionable Traycer dependencies in English and Russian", () => {
  for (const value of [
    "Runtime reads ~/.traycer/config",
    "Runtime calls traycer_do_work",
    "Runtime читает ~/.traycer и вызывает traycer_get_context",
    "Runtime does not read ~/.traycer but calls traycer_do_work",
    "Runtime не читает ~/.traycer, но вызывает traycer_get_context",
  ]) {
    assertRegistryError(mutated((registry) => { findSource(registry, "guide.agent-selection").notes = value; }), /actionable Traycer runtime dependency/);
  }
});

test("command hashes are explicitly distinguished from source-byte hashes", () => {
  for (const source of baseRegistry.sources) {
    const expected = source.kind === "traycer_protocol_command" ? "derived_capability" : "source_bytes";
    assert.equal(source.hashKind, expected, source.id);
  }
});

test("aggregate digest binds rationale and invariant fields", () => {
  const registry = clone(baseRegistry);
  findSource(registry, "guide.agent-selection").notes = "Changed rationale";
  assert.match(validateRegistry(registry, schema, documentation).join("\n"), /aggregateDigest mismatch/);
});

test("aggregate digest and summary comparison ignore object key insertion order", () => {
  const reorderedSources = baseRegistry.sources.map((source) => Object.fromEntries(Object.entries(source).reverse()));
  assert.equal(computeAggregateDigest(reorderedSources), baseRegistry.aggregateDigest);

  const registry = clone(baseRegistry);
  registry.summary = Object.fromEntries(Object.entries(registry.summary).reverse());
  assert.deepEqual(validateRegistry(registry, schema, documentation), []);
});

test("malformed registries without sources return errors instead of throwing", () => {
  const registry = clone(baseRegistry);
  delete registry.sources;
  assert.doesNotThrow(() => validateRegistry(registry, schema, documentation));
  assert.match(validateRegistry(registry, schema, documentation).join("\n"), /expected 37 parity records/);
  assert.doesNotThrow(() => verifySourceMap(registry, { schemaVersion: 1, sources: {} }));
  assert.match(verifySourceMap(registry, { schemaVersion: 1, sources: {} }).errors.join("\n"), /registry\.sources must be an array/);
});

test("empty and malformed source arrays fail closed without throwing", () => {
  for (const sources of [[], [null]]) {
    const registry = clone(baseRegistry);
    registry.sources = sources;
    assert.doesNotThrow(() => validateRegistry(registry, schema, documentation));
    assert.match(validateRegistry(registry, schema, documentation).join("\n"), /expected 37 parity records/);
    assert.doesNotThrow(() => verifySourceMap(registry, { schemaVersion: 1, sources: {} }));
    assert.match(verifySourceMap(registry, { schemaVersion: 1, sources: {} }).errors.join("\n"), /expected 37 registry source records/);
  }
});

test("CLI executes when invoked through a symlink", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "autosk-parity-cli-link-"));
  const link = path.join(directory, "validate-traycer-parity.mjs");
  symlinkSync(path.join(ROOT, "scripts/validate-traycer-parity.mjs"), link);
  const output = execFileSync(process.execPath, [link, path.join(ROOT, "resources/traycer-parity/registry.v1.json")], { cwd: ROOT, encoding: "utf8" });
  assert.match(output, /OK: 37 mapped records/);
});

test("deferred protocol bytes explicitly remain in the v1 bundle", () => {
  for (const id of ["protocol.autobuild.run-contract", "protocol.reflect.reviewer-brief"]) {
    assert.match(findSource(baseRegistry, id).notes, /bytes ship in the exact 12-file v1 governance bundle/);
  }
});
