/**
 * One object format (debt 11d, ADR-098).
 *
 * A Git object id is 40 lowercase hex characters in a sha1 repository and 64 in
 * a sha256 one, and a repository has one format. So a record naming objects of
 * the project's repository admits either width, and every OID it names has the
 * same one. Round 7 of #39 found the IntegrationAuthorizationRecord admitting
 * only 40 while the staging record beside it admitted both (R7-8): a SHA-256
 * repository could hold a valid staging record and acceptance and never reach a
 * schema-valid authorization.
 *
 * Measured rather than listed: every schema under `resources/` is walked from
 * its root, `$ref`s followed, and each OID field is found by its pattern. A
 * pattern that admits only 40 hex is allowed only where the record's object
 * format selects it — a branch conditioned on `object_format: "sha1"`, or the
 * sha1 side of a one-format rule — or on a commit of this repository.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateJsonSchema } from "../scripts/validate-planning-ref-design.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => JSON.parse(readFileSync(path.join(ROOT, relative), "utf8"));

const HEX = "(?:\\[0-9a-f\\]|\\[a-f0-9\\])";
/** A pattern that admits exactly a sha1 OID (a walkthrough id carries one after `wt-`). */
const SHA1_ONLY = new RegExp(`^\\^(?:wt-)?${HEX}\\{40\\}\\$$`, "u");
/** Exactly 64 hex: a sha256 OID inside a format branch, a digest anywhere else. */
const SHA256_ONLY = new RegExp(`^\\^(?:wt-)?${HEX}\\{64\\}\\$$`, "u");
/** A pattern that names a sha1 OID's width, in any spelling. */
const NAMES_SHA1 = /\{40\}/u;
/** One that names it and no sha256 width beside it: a pin to SHA-1. */
const pinsSha1 = (pattern) => NAMES_SHA1.test(pattern) && !/\{(?:24|64)\}/u.test(pattern);

function schemaFiles(directory = path.join(ROOT, "resources")) {
  const found = [];
  for (const name of readdirSync(directory).sort()) {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) found.push(...schemaFiles(full));
    else if (name.endsWith(".schema.json")) found.push(path.relative(ROOT, full));
  }
  return found;
}

/** The object format a condition selects — its own `object_format` or a nested record's — when it selects one. */
function formatOf(condition) {
  if (!condition || typeof condition !== "object") return null;
  const direct = condition.properties?.object_format?.const;
  if (direct !== undefined) return direct;
  for (const part of [...Object.values(condition.properties ?? {}), ...(condition.allOf ?? [])]) {
    const nested = formatOf(part);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * Every string pattern reachable from `node`: the instance path it constrains
 * (`*` for any array item) and the branch it sits in — `record` (always
 * applies), `sha1` or `sha256` (applies when the record is in that format), or
 * `conditional` (another condition).
 */
function patterns(root, node, at = "", branch = "record", seen = new Set(), out = []) {
  if (!node || typeof node !== "object") return out;
  if (typeof node.$ref === "string") {
    if (seen.has(node.$ref)) return out;
    const target = node.$ref.slice(2).split("/").reduce((item, key) => item?.[key], root);
    return patterns(root, target, at, branch, new Set([...seen, node.$ref]), out);
  }
  if (typeof node.pattern === "string") out.push({ at: at || "/", pattern: node.pattern, branch });
  for (const [key, child] of Object.entries(node.properties ?? {})) patterns(root, child, `${at}/${key}`, branch, seen, out);
  if (node.items) patterns(root, node.items, `${at}/*`, branch, seen, out);
  for (const child of [...(node.oneOf ?? []), ...(node.anyOf ?? []), ...(node.allOf ?? [])]) {
    patterns(root, child, at, branch, seen, out);
  }
  if (node.if) {
    const format = formatOf(node.if);
    const other = branch === "record" ? "conditional" : branch;
    if (format === "sha1" || format === "sha256") {
      patterns(root, node.then, at, format, seen, out);
      patterns(root, node.else, at, other, seen, out);
    } else if (oneFormatRule(root, node)) {
      patterns(root, node.if, at, "sha1", seen, out);
      patterns(root, node.else, at, "sha256", seen, out);
    } else {
      for (const part of [node.if, node.then, node.else]) patterns(root, part, at, other, seen, out);
    }
  }
  return out;
}

/** An `if`/`else` whose `if` pins OIDs to 40 hex and whose `else` pins the same OIDs to 64. */
function oneFormatRule(root, node) {
  if (node.else === undefined || node.then !== undefined) return false;
  const sha1 = patterns(root, node.if);
  const sha256 = patterns(root, node.else);
  const paths = (list) => [...new Set(list.map((entry) => entry.at))].sort().join(",");
  return sha1.length > 0 && sha1.every((entry) => SHA1_ONLY.test(entry.pattern))
    && sha256.every((entry) => SHA256_ONLY.test(entry.pattern)) && paths(sha1) === paths(sha256);
}

/** The OID fields of a schema, and where its format branches pin them. */
function oidFields(schema) {
  const found = patterns(schema, schema);
  const set = (predicate) => [...new Set(found.filter(predicate).map((entry) => entry.at))].sort();
  return {
    record: set((entry) => entry.branch === "record" && NAMES_SHA1.test(entry.pattern)),
    sha1Only: set((entry) => (entry.branch === "record" || entry.branch === "conditional") && pinsSha1(entry.pattern)),
    sha1: set((entry) => entry.branch === "sha1" && pinsSha1(entry.pattern)),
    sha256: set((entry) => entry.branch === "sha256" && SHA256_ONLY.test(entry.pattern)),
  };
}

/**
 * Commits of this repository, whose object format is its own: the frozen
 * commit and the sources of the panel's anchor pack, and the `main` the
 * program's issue inventory and matrix were cut from. The repository and its
 * forge are sha1; these name no object of a project repository.
 */
const THIS_REPOSITORY = Object.freeze({
  "resources/anchor-pack/anchor-pack.schema.json": ["/frozen_commit", "/members/*/source/commit"],
  "resources/program-capabilities/issue-inventory.schema.json": ["/source_main_commit"],
  "resources/program-capabilities/matrix.schema.json": ["/source_main_commit"],
});

const PLANNING = "scripts/validate-planning-ref-design.mjs";
const TICKETS = "scripts/validate-tickets-manifest-design.mjs";
const PUBLICATION = "resources/planning-publication";

/**
 * Records whose one format the validator holds rather than the schema: each
 * names its `object_format` or is bound, OID by OID, to a record that does.
 * Each names its validator, the records that validator accepts, and how it is
 * asked; the test below holds that the validator refuses each of them with any
 * one OID in the other format (review L5).
 */
const HELD_BY_VALIDATOR = Object.freeze({
  // Widths from the record's object_format, and the typed observations bound to the base by equality.
  [`${PUBLICATION}/init-planning-ref-operation.schema.json`]: {
    validator: PLANNING,
    instances: [`${PUBLICATION}/init-planning-ref-operation.example.json`],
    validate: (module, record, schema) => module.validatePlanningRefInitOperation(record, schema),
  },
  // The commit recipe's width from object_format, and the keepalive's to the operation's.
  [`${PUBLICATION}/publish-artifact-pass-operation.schema.json`]: {
    validator: PLANNING,
    instances: [
      `${PUBLICATION}/publish-artifact-pass-operation.example.json`,
      `${PUBLICATION}/publish-artifact-pass-operation.released.example.json`,
      `${PUBLICATION}/publish-artifact-pass-operation.voided.example.json`,
      `${PUBLICATION}/publish-planning-invalidation-operation.example.json`,
    ],
    validate: (module, record, schema) => module.validatePlanningPublicationOperation(record, schema),
  },
  // Every packed object's width from object_format.
  [`${PUBLICATION}/candidate-closure-pack-operation.schema.json`]: {
    validator: PLANNING,
    instances: [
      `${PUBLICATION}/candidate-closure-pack-operation.example.json`,
      `${PUBLICATION}/candidate-closure-pack-operation.invalidation.example.json`,
    ],
    validate: (module, record, schema) => module.validateCandidateClosurePackOperation(record, schema),
  },
  // Its two OIDs are one audited commit, held equal, and the delete exchange's expected old value.
  [`${PUBLICATION}/audit-candidate-housekeeping-operation.schema.json`]: {
    validator: PLANNING,
    instances: [`${PUBLICATION}/audit-candidate-housekeeping-operation.example.json`],
    validate: (module, record, schema) => module.validateAuditHousekeepingOperation(record, schema),
  },
  // Its three OIDs are one snapshot commit, held equal.
  [`${PUBLICATION}/candidate-supersession-operation.schema.json`]: {
    validator: PLANNING,
    instances: [`${PUBLICATION}/candidate-supersession-operation.example.json`],
    validate: (module, record, schema) => module.validateCandidateSupersessionOperation(record, schema),
  },
  // Every OID equals one of the publication operation's, whose widths are its recipe's object_format.
  [`${PUBLICATION}/planning-publication-rebinding.schema.json`]: {
    validator: PLANNING,
    instances: [`${PUBLICATION}/planning-publication-rebinding.example.json`],
    validate: (module, record, schema) => module.validatePlanningPublicationRebinding(record, schema,
      read(`${PUBLICATION}/publish-artifact-pass-operation.example.json`),
      read(`${PUBLICATION}/publish-artifact-pass-operation.released.example.json`)),
  },
  // One width across each exchange's request and response.
  [`${PUBLICATION}/ref-custody-helper-wire.schema.json`]: {
    validator: PLANNING,
    instances: [
      `${PUBLICATION}/ref-custody-helper-wire.example.json`,
      `${PUBLICATION}/ref-custody-helper-wire.invalidation.example.json`,
      `${PUBLICATION}/ref-custody-helper-wire.existing-audit.example.json`,
      `${PUBLICATION}/ref-custody-helper-wire.not-applied.example.json`,
    ],
    validate: (module, record, schema) => module.validateRefCustodyHelperWireExamples(record, schema),
  },
  // Each governing artifact's commit has the manifest's object_format width.
  ["resources/tickets-manifest/tickets-manifest.schema.json"]: {
    validator: TICKETS,
    instances: ["resources/tickets-manifest/tickets-manifest.example.json"],
    // Rendered from the record it is asked about, so what refuses a flip is
    // not a document that no longer matches.
    validate: (module, record, schema) => module.validateTicketsManifest(record, schema, null, {
      candidateDocuments: module.renderTicketDocuments(record),
      previousManifestContext: { kind: "no_prior_publication", publication_history_digest: "0".repeat(64) },
    }),
  },
});

test("no schema pins an OID to SHA-1 except where the record's object format selects it, or the repository is this one (R7-8)", () => {
  const pinned = {};
  for (const file of schemaFiles()) {
    const { sha1Only } = oidFields(read(file));
    if (sha1Only.length > 0) pinned[file] = sha1Only;
  }
  assert.deepEqual(pinned, THIS_REPOSITORY);
});

test("every record that names objects of one repository keeps all of their OIDs in one object format", () => {
  const unheld = {};
  const held = [];
  for (const file of schemaFiles()) {
    const fields = oidFields(read(file));
    if (Object.hasOwn(THIS_REPOSITORY, file)) continue;
    // One OID, not in an array, cannot disagree with another.
    if (fields.record.length < 2 && !fields.record.some((at) => at.includes("*"))) continue;
    const loose = fields.record.filter((at) => !fields.sha1.includes(at) || !fields.sha256.includes(at));
    if (loose.length === 0) continue;
    if (Object.hasOwn(HELD_BY_VALIDATOR, file)) held.push(file);
    else unheld[file] = loose;
  }
  assert.deepEqual(unheld, {});
  // The exemptions are exactly the records whose validator holds the format.
  assert.deepEqual(held.sort(), Object.keys(HELD_BY_VALIDATOR).sort());
});

/** Every position inside `value` that holds a sha1 OID: in these records, every OID. */
function sha1Positions(value, keys = [], out = []) {
  if (typeof value === "string" && /^[0-9a-f]{40}$/u.test(value)) out.push(keys);
  else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) sha1Positions(child, [...keys, Array.isArray(value) ? Number(key) : key], out);
  }
  return out;
}

test("a record whose validator holds its one object format is refused by that validator with any one OID in the other format (review L5)", async () => {
  // Measured, not asserted from the validator's source: each record its
  // validator accepts, and the same record with one OID widened to 64 hex,
  // for every OID it names. Whether the width check, an equality with a
  // width-bound OID or a digest over it refuses the flip, a record of two
  // formats does not pass.
  let flipped = 0;
  for (const [schemaFile, { validator, instances, validate }] of Object.entries(HELD_BY_VALIDATOR)) {
    const module = await import(pathToFileURL(path.join(ROOT, validator)).href);
    const schema = read(schemaFile);
    for (const instanceFile of instances) {
      const instance = read(instanceFile);
      assert.deepEqual(validate(module, structuredClone(instance), schema), [], instanceFile);
      const positions = sha1Positions(instance);
      assert.ok(positions.length > 0, `${instanceFile} names no OID`);
      for (const keys of positions) {
        flipped += 1;
        assert.notDeepEqual(validate(module, rewritten(instance, [keys]), schema), [], `${instanceFile}: /${keys.join("/")}`);
      }
    }
  }
  assert.ok(flipped >= Object.keys(HELD_BY_VALIDATOR).length);
});

/** Every concrete path inside `value` that an OID field's path names and that holds a sha1 OID. */
function locate(value, pointer) {
  const walk = (node, parts, keys) => {
    if (parts.length === 0) return typeof node === "string" && /^(?:wt-)?[0-9a-f]{40}$/u.test(node) ? [keys] : [];
    if (node === null || typeof node !== "object") return [];
    const [head, ...rest] = parts;
    if (head === "*") return Array.isArray(node) ? node.flatMap((item, index) => walk(item, rest, [...keys, index])) : [];
    return Object.hasOwn(node, head) ? walk(node[head], rest, [...keys, head]) : [];
  };
  return walk(value, pointer.split("/").filter(Boolean), []);
}

/** The same OID in a sha256 repository: 64 hex, keeping which OIDs are equal. */
const widen = (oid) => oid.replace(/^(wt-)?([0-9a-f]{40})$/u, (_, prefix = "", hex) => `${prefix}${hex}${hex.slice(0, 24)}`);

function rewritten(value, paths) {
  const copy = structuredClone(value);
  for (const keys of paths) {
    const parent = keys.slice(0, -1).reduce((node, key) => node[key], copy);
    parent[keys.at(-1)] = widen(parent[keys.at(-1)]);
  }
  return copy;
}

/**
 * The records this debt governs, each with an instance of it: every schema
 * above whose OIDs name objects of the project's repository.
 */
const RECORDS = [
  ["resources/integration-authorization/integration-authorization.schema.json", [
    "resources/integration-authorization/integration-authorization.example.json",
    "resources/integration-authorization/integration-authorization.refused.example.json",
  ]],
  ["resources/epic-staging/epic-staging.schema.json", ["resources/epic-staging/epic-staging.example.json"]],
  ["resources/approved-delta/approved-delta.schema.json", ["resources/approved-delta/approved-delta.example.json"]],
  ["resources/execution-base/execution-base.schema.json", [
    "resources/execution-base/execution-base.example.json",
    "resources/execution-base/execution-base.root.example.json",
  ]],
  ["resources/delivery-profile/delivery-profile.schema.json", ["resources/delivery-profile/delivery-profile.example.json"]],
  ["resources/artifact-write-receipt/artifact-write-receipt.schema.json", [
    "resources/artifact-write-receipt/artifact-write-receipt.example.json",
    "resources/artifact-write-receipt/artifact-write-receipt.quarantined.example.json",
  ]],
  ["resources/autobuild-run/run-record.schema.json", [
    "resources/autobuild-run/run-record.example.json",
    "resources/autobuild-run/run-record.refused.example.json",
  ]],
  ["resources/evidence-manifest/evidence-manifest.schema.json", [
    "resources/evidence-manifest/evidence-manifest.example.json",
    "resources/evidence-manifest/evidence-manifest.tombstoned.example.json",
  ]],
  ["resources/human-decision/project-status.schema.json", ["resources/human-decision/project-status.example.json"]],
  ["resources/iteration-result/iteration-result.schema.json", [
    "resources/iteration-result/iteration-result.example.json",
    "resources/iteration-result/iteration-result.escalated.example.json",
  ]],
  ["resources/static-analysis/static-analysis-result.schema.json", [
    "resources/static-analysis/static-analysis-result.example.json",
    "resources/static-analysis/static-analysis-result.refused.example.json",
  ]],
  ["resources/verification-batch/verification-batch.schema.json", ["resources/verification-batch/verification-batch.example.json"]],
  ["resources/verify-doc/feature-map.schema.json", ["resources/verify-doc/feature-map.example.json"]],
  ["resources/walkthrough/walkthrough.schema.json", [
    "resources/walkthrough/walkthrough.example.json",
    "resources/walkthrough/walkthrough.refused.example.json",
  ]],
  ["resources/project-instructions/project-instructions-lock.schema.json", [
    "resources/project-instructions/project-instructions-lock.example.json",
  ]],
];

/** The record in a sha256 repository: every OID widened, and the format it names with them. */
function inSha256(value, fields) {
  const copy = rewritten(value, fields.flatMap((pointer) => locate(value, pointer)));
  if (copy.object_format === "sha1") copy.object_format = "sha256";
  return copy;
}

test("a record of either object format validates, and one that mixes them does not (R7-8)", () => {
  for (const [schemaFile, instances] of RECORDS) {
    const schema = read(schemaFile);
    const fields = oidFields(schema).record;
    assert.ok(fields.length > 0, `${schemaFile} names no OID`);
    let mixed = 0;
    for (const instanceFile of instances) {
      const instance = read(instanceFile);
      assert.deepEqual(validateJsonSchema(instance, schema), [], instanceFile);
      assert.deepEqual(validateJsonSchema(inSha256(instance, fields), schema), [], `${instanceFile} in a sha256 repository`);
      const positions = fields.flatMap((pointer) => locate(instance, pointer));
      if (positions.length < 2) continue;
      for (const keys of positions) {
        mixed += 1;
        assert.notDeepEqual(validateJsonSchema(rewritten(instance, [keys]), schema), [],
          `${instanceFile}: /${keys.join("/")} alone in the other format`);
      }
    }
    // A record with one OID field has nothing to mix; every other is shown mixed.
    if (fields.length > 1 || fields.some((at) => at.includes("*"))) assert.ok(mixed > 0, `${schemaFile}: no instance mixes formats`);
  }
});

test("the presented draft of the record takes either format, one per record, like the record (R7-8)", () => {
  const request = read("resources/human-decision/human-decision-request.schema.json");
  const draft = request.$defs.integrationAuthorizationDraft;
  const { user_decision_record_id: _id, user_decision_record_hash: _hash, ...composed } =
    read("resources/integration-authorization/integration-authorization.example.json");
  const fields = oidFields(read("resources/integration-authorization/integration-authorization.schema.json")).record;
  assert.deepEqual(validateJsonSchema(composed, draft, request), []);
  assert.deepEqual(validateJsonSchema(inSha256(composed, fields), draft, request), []);
  for (const keys of fields.flatMap((pointer) => locate(composed, pointer))) {
    assert.notDeepEqual(validateJsonSchema(rewritten(composed, [keys]), draft, request), [], `/${keys.join("/")}`);
  }
});

test("a helper intent's observations are of one object format, the one its request is in", () => {
  const schema = read("resources/planning-publication/ref-custody-helper-intents.schema.json");
  const example = read("resources/planning-publication/ref-custody-helper-intents.example.json");
  const fields = oidFields(schema).record;
  assert.deepEqual(fields, ["/records/*/pre_execution_observation/*/oid"]);
  assert.deepEqual(validateJsonSchema(inSha256(example, fields), schema), []);
  // One intent is one operation on one repository: its observations may not
  // mix formats.
  const index = example.records.findIndex((record) => (record.pre_execution_observation ?? []).filter((item) => item.oid !== null).length >= 2);
  assert.ok(index >= 0, "no intent observes two refs");
  const observed = example.records[index].pre_execution_observation.findIndex((item) => item.oid !== null);
  const mixed = rewritten(example, [["records", index, "pre_execution_observation", observed, "oid"]]);
  assert.notDeepEqual(validateJsonSchema(mixed, schema), []);
});
