#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_PATH = path.join(ROOT, "resources/traycer-parity/registry.v1.json");
const SCHEMA_PATH = path.join(ROOT, "resources/traycer-parity/registry.schema.json");
const SUMMARY_PATH = path.join(ROOT, "docs/traycer-parity-registry.md");
const README_PATH = path.join(ROOT, "README.md");

export const ALLOWED_CHANGED_FILES = [
  ".github/workflows/validate-traycer-parity.yml",
  "README.md",
  "docs/traycer-parity-registry.md",
  "package.json",
  "resources/traycer-parity/registry.schema.json",
  "resources/traycer-parity/registry.v1.json",
  "scripts/validate-traycer-parity.mjs",
  "test/validate-traycer-parity.test.mjs",
];

const EXPECTED_BY_KIND = {
  guide: ["guide.agent-selection"],
  protocol_file: [
    "protocol.arena.arena-stage",
    "protocol.arena.judge-brief",
    "protocol.autobuild.run-contract",
    "protocol.playbooks.bug-fix",
    "protocol.playbooks.feature",
    "protocol.playbooks.perf",
    "protocol.playbooks.refactoring",
    "protocol.principles-digest",
    "protocol.reflect.reviewer-brief",
    "protocol.verification.template",
    "protocol.writing.technical-writing",
    "protocol.writing.unslop",
  ],
  traycer_skill: [
    "skill.artifact-critique",
    "skill.autobuild",
    "skill.changeset-walkthrough",
    "skill.core-flows",
    "skill.debate",
    "skill.epic-brief",
    "skill.execute",
    "skill.housekeeping",
    "skill.implement",
    "skill.review",
    "skill.revise-requirements",
    "skill.tech-plan",
    "skill.ticket-breakdown",
  ],
  traycer_protocol_binary: ["executable.traycer-protocol"],
  traycer_protocol_command: [
    "command.digest",
    "command.identity-check",
    "command.identity-mint",
    "command.integrate-approved",
    "command.size",
    "command.write-verify",
  ],
  traycer_test_suite: [
    "test-suite.integrate-approved",
    "test-suite.traycer-protocol",
  ],
  validation_record: [
    "validation.external-review",
    "validation.external-review-2",
  ],
};

const EXPECTED_ARCHIVES = {
  "archive.agents": {
    sha256: "18e9f6b0f874c5459482137e34aaac2d0a2230a43de620e959def23d1e246dc8",
    inventory: { entries: 102, symlinks: 0 },
  },
  "archive.protocol": {
    sha256: "d8a7907e0de5a7e2ae0019d3e901144a22538159c446b3a02c59d531dd84bcbd",
    inventory: { entries: 40, regularFiles: 33, directories: 7, symlinks: 0, other: 0 },
  },
  "archive.skills": {
    sha256: "5dde22dc3dcd942b8cb8fa960900bd4f7d66857155514ac364e410fb557d67e1",
    inventory: { entries: 102, regularFiles: 85, directories: 17, symlinks: 0, other: 0 },
  },
  "archive.traycer-rules": {
    sha256: "b5fff796c0f47f76b9c7bc8592254eb7c1f83f27a356837058a6d38cc8fb0bfd",
    inventory: { entries: 2924, regularFiles: 2750, directories: 174, symlinks: 0, other: 0 },
  },
};

const EXPECTED_GAPS = ["gap.bin-2-archive", "gap.protocol-3-archive"];
const DISPOSITIONS = ["ported", "adapted", "superseded", "intentionally_deferred", "rejected"];
const CLASSIFICATIONS = ["v1", "post_v1"];
const PLACEHOLDER_RE = /(^|[^a-z0-9])(?:unknown|unmapped|tbd|todo|n\/a)(?=$|[^a-z0-9])/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const LOCATOR_PATTERN_SOURCE = "^[a-z][a-z0-9-]*://[A-Za-z0-9._/-]+$";
const LOCATOR_RE = new RegExp(LOCATOR_PATTERN_SOURCE);
const TOP_KEYS = ["$schema", "aggregateDigest", "parityClaim", "registryVersion", "schemaVersion", "sourceEvidence", "sources", "summary"];
const SOURCE_KEYS = ["autoskTarget", "classification", "defer", "disposition", "hashKind", "id", "invariants", "kind", "notes", "parityClaim", "purpose", "sanitizedLocator", "sha256", "sourceRef", "targetVersion", "verification"];

const canonicalCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (values) => [...values].sort(canonicalCompare);
const sameArray = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const parseJson = (filePath) => JSON.parse(readFileSync(filePath, "utf8"));

function closedKeys(value, allowed, label, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) errors.push(`${label} has undeclared properties: ${sorted(extras).join(", ")}`);
}

function requiredKeys(value, required, label, errors) {
  for (const key of required) if (!Object.hasOwn(value ?? {}, key)) errors.push(`${label}.${key} is required`);
}

function hasPlaceholder(value) {
  if (typeof value === "string") return PLACEHOLDER_RE.test(value);
  if (Array.isArray(value)) return value.some(hasPlaceholder);
  return Boolean(value && typeof value === "object" && Object.values(value).some(hasPlaceholder));
}

function hasPrivateData(value) {
  const text = JSON.stringify(value);
  return (
    /\/Users\/[^/"\\]+\//.test(text) ||
    /\/home\/[^/"\\]+\//.test(text) ||
    /\/root(?:[\/"\\])/.test(text) ||
    /[A-Za-z]:\\\\Users\\\\[^\\"/]+/.test(text) ||
    /gho_[A-Za-z0-9_]+/.test(text) ||
    /(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*[^\s",}]+/i.test(text) ||
    /responseId/i.test(text) ||
    /\$HOME(?:[\\/]|\b)/.test(text) ||
    /~\/\.agents(?:[\\/]|\b)/.test(text) ||
    /Desktop\/TraycerRules(?:[\\/]|\b)/.test(text) ||
    /\b(?:raw\s+)?(?:transcript|session)\s+(?:body|content|copied|data|dump)\b/i.test(text)
  );
}

function hasActionableTraycerDependency(text) {
  const dependency = /(?:~\/\.traycer(?:\/[A-Za-z0-9._/-]*)?|traycer_(?:[A-Za-z0-9_]+|\*))/gi;
  for (const match of text.matchAll(dependency)) {
    const prefix = text.slice(0, match.index);
    let start = Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf(";"), prefix.lastIndexOf("!"), prefix.lastIndexOf("?"), prefix.lastIndexOf(",")) + 1;
    for (const sentence of prefix.matchAll(/[.!?](?=\s+[A-ZА-Я])/gu)) start = Math.max(start, sentence.index + sentence[0].length);
    for (const contrast of prefix.matchAll(/\bbut\b|(?:^|\s)но(?:\s|$)/giu)) start = Math.max(start, contrast.index + contrast[0].length);
    const clause = text.slice(start, match.index + match[0].length);
    const hasAction = /\b(?:reads?|loads?|opens?|uses?|calls?|invokes?|requires?)\b/i.test(clause) || /(?:читает|загружает|открывает|использует|вызывает|требует)/iu.test(clause);
    const isNegative = /\b(?:does?\s+not|must\s+not|never|cannot|can't|without|forbids?|prohibits?)\b/i.test(clause) || /не\s+(?:читает|вызывает|использует|требует)/iu.test(clause);
    if (hasAction && !isNegative) return true;
  }
  return false;
}

export function computeAggregateDigest(sources) {
  return createHash("sha256")
    .update("autosk-flow.traycer-parity.v1\n")
    .update(JSON.stringify(sources))
    .update("\n")
    .digest("hex");
}

export function computeCommandCapabilityHash(command, binarySha256) {
  return createHash("sha256")
    .update("autosk-flow.traycer-protocol-command.v1\n")
    .update(`${command}\n${binarySha256}\n`)
    .digest("hex");
}

export function computeSummary(sources) {
  const dispositions = Object.fromEntries(DISPOSITIONS.map((value) => [value, 0]));
  for (const source of sources) if (Object.hasOwn(dispositions, source.disposition)) dispositions[source.disposition] += 1;
  return {
    mappedRecords: sources.length,
    implementedRecords: 0,
    verifiedRecords: 0,
    v1Records: sources.filter((source) => source.classification === "v1").length,
    postV1Records: sources.filter((source) => source.classification === "post_v1").length,
    dispositions,
  };
}

function validateSchema(schema, errors) {
  const item = schema?.properties?.sources?.items;
  const sourceProperties = item?.properties ?? {};
  const sameSet = (actual, expected) => sameArray(sorted(actual ?? []), sorted(expected));
  const expectedSourceRequired = ["id", "kind", "sanitizedLocator", "sha256", "hashKind", "purpose", "invariants", "autoskTarget", "disposition", "classification", "parityClaim", "targetVersion", "verification", "notes"];
  if (schema?.additionalProperties !== false) errors.push("schema top level must be closed");
  if (item?.additionalProperties !== false) errors.push("schema source records must be closed");
  if (!sameSet(schema?.required, TOP_KEYS)) errors.push("schema top-level required fields differ from contract");
  if (!sameSet(item?.required, expectedSourceRequired)) errors.push("schema source required fields differ from contract");
  if (!sameArray(item?.properties?.disposition?.enum ?? [], DISPOSITIONS)) errors.push("schema disposition enum differs from contract");
  if (!sameArray(item?.properties?.classification?.enum ?? [], CLASSIFICATIONS)) errors.push("schema classification enum differs from contract");
  if (schema?.properties?.$schema?.const !== "./registry.schema.json") errors.push("schema registry pointer const differs from contract");
  if (sourceProperties.sanitizedLocator?.pattern !== LOCATOR_PATTERN_SOURCE) errors.push("schema locator pattern differs from contract");
  if (schema?.$defs?.sha256?.pattern !== SHA256_RE.source) errors.push("schema sha256 pattern differs from contract");
  if (schema?.properties?.sources?.minItems !== 37 || schema?.properties?.sources?.maxItems !== 37) errors.push("schema source count differs from contract");
  if (schema?.properties?.sourceEvidence?.properties?.archives?.minItems !== 4 || schema?.properties?.sourceEvidence?.properties?.archives?.maxItems !== 4) errors.push("schema archive count differs from contract");
  if (schema?.properties?.sourceEvidence?.properties?.gaps?.minItems !== 2 || schema?.properties?.sourceEvidence?.properties?.gaps?.maxItems !== 2) errors.push("schema gap count differs from contract");
  if (schema?.properties?.summary?.properties?.mappedRecords?.const !== 37 || schema?.properties?.summary?.properties?.implementedRecords?.const !== 0 || schema?.properties?.summary?.properties?.verifiedRecords?.const !== 0) errors.push("schema delivery summary consts differ from contract");
  if (sourceProperties.verification?.properties?.evidenceRefs?.items?.minLength !== 1) errors.push("schema evidenceRefs item constraint differs from contract");
  if (!sameArray(sourceProperties.hashKind?.enum ?? [], ["source_bytes", "derived_capability"])) errors.push("schema hashKind enum differs from contract");
  if (!sameSet(schema?.properties?.sourceEvidence?.required, ["archives", "gaps"])) errors.push("schema sourceEvidence required fields differ from contract");
  if (!sameSet(schema?.properties?.summary?.required, ["mappedRecords", "implementedRecords", "verifiedRecords", "v1Records", "postV1Records", "dispositions"])) errors.push("schema summary required fields differ from contract");
  if (!sameSet(sourceProperties.autoskTarget?.required, ["component", "issueRefs"])) errors.push("schema autoskTarget required fields differ from contract");
  if (!sameSet(sourceProperties.verification?.required, ["status", "evidenceRefs"])) errors.push("schema verification required fields differ from contract");
  if (!sameSet(sourceProperties.defer?.required, ["reason", "risk", "owner", "returnTrigger", "notImplementedProof"])) errors.push("schema defer required fields differ from contract");
  const [deferCondition, commandCondition] = item?.allOf ?? [];
  const deferConditionValid =
    deferCondition?.if?.properties?.disposition?.const === "intentionally_deferred" &&
    sameSet(deferCondition?.if?.required, ["disposition"]) &&
    sameSet(deferCondition?.then?.required, ["defer"]) &&
    deferCondition?.then?.properties?.classification?.const === "post_v1" &&
    sameSet(deferCondition?.else?.not?.required, ["defer"]);
  if (!deferConditionValid) errors.push("schema deferred condition differs from contract");
  const commandConditionValid =
    commandCondition?.if?.properties?.kind?.const === "traycer_protocol_command" &&
    sameSet(commandCondition?.if?.required, ["kind"]) &&
    sameSet(commandCondition?.then?.required, ["sourceRef"]) &&
    commandCondition?.then?.properties?.hashKind?.const === "derived_capability" &&
    sameSet(commandCondition?.else?.not?.required, ["sourceRef"]) &&
    commandCondition?.else?.properties?.hashKind?.const === "source_bytes";
  if (!commandConditionValid) errors.push("schema sourceRef condition differs from contract");
}

function validateEvidence(evidence, errors) {
  closedKeys(evidence, ["archives", "gaps"], "sourceEvidence", errors);
  const archives = Array.isArray(evidence?.archives) ? evidence.archives : [];
  const gaps = Array.isArray(evidence?.gaps) ? evidence.gaps : [];
  if (archives.length !== 4) errors.push(`expected 4 archive evidence records, found ${archives.length}`);
  const archiveIds = archives.map((archive) => archive?.id);
  if (!sameArray(archiveIds, sorted(archiveIds))) errors.push("archive evidence must be sorted by id");
  for (const archive of archives) {
    closedKeys(archive, ["id", "inventory", "sanitizedLocator", "sha256"], `archive ${archive?.id}`, errors);
    const expected = EXPECTED_ARCHIVES[archive?.id];
    if (!expected) {
      errors.push(`unexpected archive evidence id: ${archive?.id}`);
      continue;
    }
    if (archive.sha256 !== expected.sha256) errors.push(`archive ${archive.id} sha256 mismatch`);
    if (!archive.sanitizedLocator?.startsWith("migration-archive://")) errors.push(`archive ${archive.id} locator is not sanitized`);
    const actualKeys = sorted(Object.keys(archive.inventory ?? {}));
    const expectedKeys = sorted(Object.keys(expected.inventory));
    if (!sameArray(actualKeys, expectedKeys)) errors.push(`archive ${archive.id} inventory fields differ from observed evidence`);
    for (const [key, value] of Object.entries(expected.inventory)) if (archive.inventory?.[key] !== value) errors.push(`archive ${archive.id} inventory.${key} must be ${value}`);
  }
  if (gaps.length !== 2) errors.push(`expected 2 source evidence gaps, found ${gaps.length}`);
  const gapIds = gaps.map((gap) => gap?.id);
  if (!sameArray(gapIds, EXPECTED_GAPS)) errors.push(`gap ids must be ${EXPECTED_GAPS.join(", ")}`);
  for (const gap of gaps) {
    closedKeys(gap, ["id", "impact", "requestedLocator", "searchedScope", "status"], `gap ${gap?.id}`, errors);
    if (gap?.status !== "not_found") errors.push(`gap ${gap?.id} must remain not_found`);
    if (!gap?.requestedLocator?.startsWith("requested-archive://")) errors.push(`gap ${gap?.id} locator is not sanitized`);
    if (!nonEmpty(gap?.searchedScope) || !nonEmpty(gap?.impact)) errors.push(`gap ${gap?.id} must explain search scope and impact`);
  }
  if (hasPrivateData(evidence)) errors.push("sourceEvidence contains private material");
}

function validateSource(source, index, errors) {
  const label = `sources[${index}]`;
  closedKeys(source, SOURCE_KEYS, label, errors);
  for (const key of ["id", "kind", "sanitizedLocator", "sha256", "hashKind", "purpose", "disposition", "classification", "parityClaim", "targetVersion", "notes"]) {
    if (!nonEmpty(source?.[key])) errors.push(`${label}.${key} must be non-empty`);
  }
  if (!Object.hasOwn(EXPECTED_BY_KIND, source?.kind)) errors.push(`${label}.kind is not allowed`);
  if (!SHA256_RE.test(source?.sha256 ?? "")) errors.push(`${label}.sha256 must be lowercase SHA-256 hex`);
  if (!LOCATOR_RE.test(source?.sanitizedLocator ?? "")) errors.push(`${label}.sanitizedLocator is invalid`);
  if (!DISPOSITIONS.includes(source?.disposition)) errors.push(`${label}.disposition is not allowed`);
  if (!CLASSIFICATIONS.includes(source?.classification)) errors.push(`${label}.classification is not allowed`);
  if (source?.parityClaim !== "mapping_only") errors.push(`${label}.parityClaim must be mapping_only`);
  if (source?.targetVersion !== "unreleased") errors.push(`${label}.targetVersion must be unreleased`);
  if (!Array.isArray(source?.invariants) || !source.invariants.length || source.invariants.some((value) => !nonEmpty(value))) errors.push(`${label}.invariants must be non-empty`);
  closedKeys(source?.autoskTarget, ["component", "issueRefs"], `${label}.autoskTarget`, errors);
  if (!nonEmpty(source?.autoskTarget?.component)) errors.push(`${label}.autoskTarget.component must be non-empty`);
  if (!Array.isArray(source?.autoskTarget?.issueRefs) || !source.autoskTarget.issueRefs.length || source.autoskTarget.issueRefs.some((issue) => !Number.isInteger(issue) || issue < 3 || issue > 39)) errors.push(`${label}.autoskTarget.issueRefs is invalid`);
  closedKeys(source?.verification, ["evidenceRefs", "status"], `${label}.verification`, errors);
  if (source?.verification?.status !== "planned") errors.push(`${label}.verification.status must be planned`);
  if (!Array.isArray(source?.verification?.evidenceRefs) || !source.verification.evidenceRefs.length || source.verification.evidenceRefs.some((value) => !nonEmpty(value))) errors.push(`${label}.verification.evidenceRefs must contain non-empty strings`);
  if (hasPlaceholder(source)) errors.push(`${label} contains a placeholder`);
  if (hasPrivateData(source)) errors.push(`${label} contains private material`);
  const semanticText = [
    source?.purpose,
    ...(Array.isArray(source?.invariants) ? source.invariants : []),
    source?.autoskTarget?.component,
    source?.notes,
    ...Object.values(source?.defer ?? {}),
  ].filter(nonEmpty).join("\n");
  if (hasActionableTraycerDependency(semanticText)) errors.push(`${label} contains an actionable Traycer runtime dependency`);
  if (source?.disposition === "intentionally_deferred") {
    if (source.classification !== "post_v1") errors.push(`${label} deferred records must be post_v1`);
    closedKeys(source.defer, ["notImplementedProof", "owner", "reason", "returnTrigger", "risk"], `${label}.defer`, errors);
    for (const key of ["reason", "risk", "owner", "returnTrigger", "notImplementedProof"]) if (!nonEmpty(source?.defer?.[key])) errors.push(`${label}.defer.${key} must be non-empty`);
  } else if (Object.hasOwn(source ?? {}, "defer")) {
    errors.push(`${label}.defer is allowed only for intentionally_deferred records`);
  }
  if (source?.kind === "traycer_protocol_command") {
    if (source.sourceRef !== "executable.traycer-protocol") errors.push(`${label}.sourceRef must bind the executable`);
    if (source.hashKind !== "derived_capability") errors.push(`${label}.hashKind must be derived_capability`);
  } else if (Object.hasOwn(source ?? {}, "sourceRef")) {
    errors.push(`${label}.sourceRef is allowed only for commands`);
  } else if (source?.hashKind !== "source_bytes") {
    errors.push(`${label}.hashKind must be source_bytes`);
  }
}

export function validateRegistry(registry, schema = {}, documentation = {}) {
  const errors = [];
  closedKeys(registry, TOP_KEYS, "registry", errors);
  requiredKeys(registry, TOP_KEYS, "registry", errors);
  if (registry?.$schema !== "./registry.schema.json") errors.push("registry.$schema must be ./registry.schema.json");
  if (registry?.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (registry?.registryVersion !== "traycer-parity-registry.v1") errors.push("registryVersion must be traycer-parity-registry.v1");
  if (registry?.parityClaim !== "mapping_only") errors.push("registry parityClaim must be mapping_only");
  validateSchema(schema, errors);
  validateEvidence(registry?.sourceEvidence, errors);
  const sources = Array.isArray(registry?.sources) ? registry.sources : [];
  if (sources.length !== 37) errors.push(`expected 37 parity records, found ${sources.length}`);
  sources.forEach((source, index) => validateSource(source, index, errors));
  const ids = sources.map((source) => source?.id);
  const locators = sources.map((source) => source?.sanitizedLocator);
  const hashes = sources.map((source) => source?.sha256);
  if (!sameArray(ids, sorted(ids))) errors.push("sources must be sorted by id");
  for (const [label, values] of [["id", ids], ["locator", locators], ["source identity", hashes]]) if (new Set(values).size !== values.length) errors.push(`duplicate ${label} is not allowed`);
  for (const [kind, expectedIds] of Object.entries(EXPECTED_BY_KIND)) {
    const actualIds = sources.filter((source) => source?.kind === kind).map((source) => source.id);
    if (!sameArray(actualIds, expectedIds)) errors.push(`${kind} ids must be exactly: ${expectedIds.join(", ")}`);
  }
  const binary = sources.find((source) => source.id === "executable.traycer-protocol");
  for (const source of sources.filter((candidate) => candidate.kind === "traycer_protocol_command")) {
    const expected = binary ? computeCommandCapabilityHash(source.id.slice(8), binary.sha256) : null;
    if (source.sha256 !== expected) errors.push(`${source.id} capability hash does not bind the executable`);
  }
  const expectedDigest = computeAggregateDigest(sources);
  if (registry?.aggregateDigest !== expectedDigest) errors.push(`aggregateDigest mismatch: expected ${expectedDigest}`);
  if (JSON.stringify(registry?.summary) !== JSON.stringify(computeSummary(sources))) errors.push("summary does not match sources");
  if (documentation.readme !== undefined || documentation.summary !== undefined) errors.push(...validateDocumentation(documentation.readme ?? "", documentation.summary ?? "", registry));
  return errors;
}

export function validateDocumentation(readme, summary, registry) {
  const errors = [];
  for (const [label, text] of [["README", readme], ["summary", summary]]) {
    if (hasPrivateData(text)) errors.push(`${label} contains private material`);
    if (hasActionableTraycerDependency(text)) errors.push(`${label} contains an actionable Traycer runtime dependency`);
  }
  const metrics = [
    ["Mapping coverage", "Mapping coverage: 100% (37/37)"],
    ["Implemented parity", "Implemented parity: 0% (0/37)"],
    ["Verified parity", "Verified parity: 0% (0/37)"],
  ];
  for (const [documentLabel, text] of [["README", readme], ["summary", summary]]) {
    const lines = text.split(/\r?\n/).map((line) => line.trim().replace(/^[-*]\s+/, ""));
    for (const [metricLabel, expected] of metrics) {
      const matches = lines.filter((line) => line.startsWith(`${metricLabel}:`));
      if (matches.length !== 1 || matches[0] !== expected) errors.push(`${documentLabel} ${metricLabel} must be exactly ${expected}`);
    }
  }
  const currentSummary = computeSummary(registry.sources);
  if (!summary.includes(`\`v1\`: ${currentSummary.v1Records}`)) errors.push("summary v1 count does not match registry");
  if (!summary.includes(`\`post_v1\`: ${currentSummary.postV1Records}`)) errors.push("summary post_v1 count does not match registry");
  for (const [disposition, count] of Object.entries(currentSummary.dispositions)) {
    if (!summary.includes(`| \`${disposition}\` | ${count} |`)) errors.push(`summary ${disposition} count does not match registry`);
  }
  if (!summary.includes(registry.aggregateDigest)) errors.push("summary is missing aggregateDigest");
  return errors;
}

function gitLines(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).split("\n").map((value) => value.trim()).filter(Boolean);
}

export function collectChangedFiles(base = "origin/main", cwd = ROOT) {
  return sorted(new Set([
    ...gitLines(["diff", "--name-only", `${base}...HEAD`], cwd),
    ...gitLines(["diff", "--name-only"], cwd),
    ...gitLines(["diff", "--cached", "--name-only"], cwd),
    ...gitLines(["ls-files", "--others", "--exclude-standard"], cwd),
  ]));
}

export function validateChangedFiles(changedFiles, { baseContainsRegistry = false } = {}) {
  if (baseContainsRegistry) return [];
  const actual = sorted(new Set(changedFiles));
  const expected = sorted(ALLOWED_CHANGED_FILES);
  const unexpected = actual.filter((value) => !expected.includes(value));
  const missing = expected.filter((value) => !actual.includes(value));
  return [
    ...(unexpected.length ? [`changed files outside scope: ${unexpected.join(", ")}`] : []),
    ...(missing.length ? [`required changed files missing: ${missing.join(", ")}`] : []),
  ];
}

function refContainsRegistry(ref, cwd = ROOT) {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}:resources/traycer-parity/registry.v1.json`], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function assertReportPath(reportPath, root = ROOT) {
  const absolute = path.resolve(reportPath);
  let outputEntry = null;
  try {
    outputEntry = lstatSync(absolute);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (outputEntry?.isSymbolicLink()) return ["source report output must not be a symlink"];
  let existingParent = outputEntry ? absolute : path.dirname(absolute);
  while (!existsSync(existingParent)) existingParent = path.dirname(existingParent);
  const resolvedBase = realpathSync(existingParent);
  const resolvedCandidate = outputEntry
    ? realpathSync(absolute)
    : path.join(resolvedBase, path.relative(existingParent, absolute));
  const relative = path.relative(realpathSync(root), resolvedCandidate);
  const outside = relative === ".." || relative.startsWith(`..${path.sep}`);
  return outside ? [] : ["source report output must be outside the worktree"];
}

export function verifySourceMap(registry, sourceMap) {
  const sources = registry.sources.filter((source) => source.kind !== "traycer_protocol_command");
  const expectedIds = sources.map((source) => source.id);
  const mapIds = sorted(Object.keys(sourceMap?.sources ?? {}));
  const errors = [];
  if (sourceMap?.schemaVersion !== 1) errors.push("source map schemaVersion must be 1");
  const missing = expectedIds.filter((id) => !mapIds.includes(id));
  const extra = mapIds.filter((id) => !expectedIds.includes(id));
  if (missing.length) errors.push(`source map missing ids: ${missing.join(", ")}`);
  if (extra.length) errors.push(`source map extra ids: ${extra.join(", ")}`);
  const records = sources.map((source) => {
    let actualSha256 = null;
    let status = "fail";
    const sourcePath = sourceMap?.sources?.[source.id];
    if (!nonEmpty(sourcePath)) {
      errors.push(`${source.id} source path must be non-empty`);
    } else {
      try {
        const resolved = realpathSync(sourcePath);
        if (!statSync(resolved).isFile()) errors.push(`${source.id} is not a regular file`);
        else {
          actualSha256 = createHash("sha256").update(readFileSync(resolved)).digest("hex");
          if (actualSha256 === source.sha256) status = "pass";
          else errors.push(`${source.id} source hash mismatch`);
        }
      } catch (error) {
        errors.push(`${source.id} source read failed: ${error.code ?? "ERROR"}`);
      }
    }
    return { id: source.id, sanitizedLocator: source.sanitizedLocator, expectedSha256: source.sha256, actualSha256, status };
  });
  if (records.some((record) => record.status !== "pass")) errors.push("source verification did not pass for every record");
  return { errors, report: { schemaVersion: 1, records } };
}

function committedInputs(registryPath = REGISTRY_PATH) {
  return {
    registry: parseJson(registryPath),
    schema: parseJson(SCHEMA_PATH),
    documentation: { readme: readFileSync(README_PATH, "utf8"), summary: readFileSync(SUMMARY_PATH, "utf8") },
  };
}

function fail(errors) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  return 1;
}

function run(argv) {
  if (argv[0] === "--check-file-scope") {
    const base = argv[1] ?? "origin/main";
    const files = collectChangedFiles(base);
    const baseContainsRegistry = refContainsRegistry(base);
    const errors = validateChangedFiles(files, { baseContainsRegistry });
    if (errors.length) return fail(errors);
    console.log(baseContainsRegistry ? "OK: issue #3 scope already integrated; exact scope gate skipped" : `OK: issue #3 file scope (${files.length} files)`);
    return 0;
  }
  if (argv[0] === "--verify-sources") {
    if (!argv[1]) return fail(["--verify-sources requires a source map"]);
    const registry = parseJson(REGISTRY_PATH);
    const sourceMap = parseJson(path.resolve(argv[1]));
    const result = verifySourceMap(registry, sourceMap);
    console.log(JSON.stringify(result.report, null, 2));
    const reportIndex = argv.indexOf("--source-report-out");
    if (reportIndex >= 0) {
      const output = argv[reportIndex + 1];
      if (!output) result.errors.push("--source-report-out requires a path");
      else {
        const pathErrors = assertReportPath(output);
        result.errors.push(...pathErrors);
        if (!pathErrors.length) writeFileSync(path.resolve(output), `${JSON.stringify(result.report, null, 2)}\n`);
      }
    }
    if (result.errors.length) return fail(result.errors);
    console.log(`OK: verified ${result.report.records.length} local source hashes`);
    return 0;
  }
  const registryPath = argv[0] ? path.resolve(argv[0]) : REGISTRY_PATH;
  const input = committedInputs(registryPath);
  const errors = validateRegistry(input.registry, input.schema, input.documentation);
  if (errors.length) return fail(errors);
  console.log(`OK: ${input.registry.summary.mappedRecords} mapped records; digest ${input.registry.aggregateDigest}`);
  return 0;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    process.exitCode = fail([error.message]);
  }
}
