/**
 * Tests for the stage carrier compiler and the attribution echo (issue #19 runtime).
 *
 * A reference is not a delivery: the bytes travel with the prompt and come back
 * labelled. These check that the labels are worth something — that an echo
 * nobody sent, a fragment nobody asked for, and a bundle nobody pinned are all
 * refusals rather than details.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  HEADER_FIELDS,
  REFUSALS,
  attributionHeader,
  carrierKey,
  compileCarrier,
  coverageErrors,
  mappingFor,
  retryContext,
  serializeHeader,
  sharedBytes,
  verifyEcho,
} from "../src/host/stage-carrier.mjs";
import { ROOT } from "../scripts/validate-planning-ref-design.mjs";

const shipped = JSON.parse(
  await readFile(path.join(ROOT, "resources/stage-carriers/stage-carriers.v1.json"), "utf8"),
);

const code = (name) => (error) => error.code === name;
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** A bundle that returns deterministic bytes for anything the registry names. */
function bundle(overrides = {}) {
  return {
    read(filePath) {
      if (Object.hasOwn(overrides, filePath)) return overrides[filePath];
      return `bytes of ${filePath}\n`;
    },
  };
}

function context(overrides = {}) {
  return {
    bundle_digest: shipped.bundle_digest,
    project: "sha256:" + "a".repeat(58),
    epic: "epic-store-lock",
    task: "T-102",
    dispatch_id: "disp-1",
    round: 1,
    attempt: 1,
    serialization_version: 1,
    ...overrides,
  };
}

/** Every anchor any shipped mapping asks for, so the tests are about carriers. */
function anchorsFor(mapping) {
  return Object.fromEntries(mapping.anchors.map((anchor) => [anchor, `anchor bytes for ${anchor}\n`]));
}

function compile(role, stage, overrides = {}) {
  const mapping = mappingFor(shipped, role, stage);
  return compileCarrier(shipped, {
    role,
    stage,
    context: context(overrides.context),
    bundle: overrides.bundle ?? bundle(),
    anchors: overrides.anchors ?? anchorsFor(mapping),
  });
}

test("the shipped registry maps every key it declares, and the first one compiles", () => {
  const [role, stage] = Object.keys(shipped.carriers)[0].split(".");
  const compiled = compile(role, stage);
  assert.equal(compiled.key, carrierKey(role, stage));
  assert.ok(compiled.headers.length > 0);
  assert.match(compiled.body_sha256, /^[0-9a-f]{64}$/u);
});

test("every shipped carrier key compiles with its declared anchors", () => {
  for (const key of Object.keys(shipped.carriers)) {
    const [role, stage] = key.split(".");
    assert.doesNotThrow(() => compile(role, stage), key);
  }
});

test("an unknown mapping is fail-closed before the provider call", () => {
  // Guessing a mapping is how a role silently receives someone else's context.
  assert.throws(() => mappingFor(shipped, "author", "not_a_stage"), code("carrier_mapping_unknown"));
  assert.throws(() => compile("nobody", "nowhere"), code("carrier_mapping_unknown"));
});

test("a required file the bundle does not have is a refusal, not an empty fragment", () => {
  const [role, stage] = Object.keys(shipped.carriers)[0].split(".");
  const missing = shipped.carriers[`${role}.${stage}`].required[0];
  assert.throws(
    () => compile(role, stage, { bundle: bundle({ [missing]: undefined }) }),
    code("carrier_file_missing"),
  );
});

test("a required anchor that was not supplied is a refusal", () => {
  const key = Object.keys(shipped.carriers).find((name) => shipped.carriers[name].anchors.length > 0);
  const [role, stage] = key.split(".");
  assert.throws(() => compile(role, stage, { anchors: {} }), code("carrier_file_missing"));
});

test("the forbidden set is enforced, not decoration", () => {
  // The Judge rubric reaching an Arena candidate is the failure it exists to
  // prevent.
  const [role, stage] = Object.keys(shipped.carriers)[0].split(".");
  const mapping = shipped.carriers[`${role}.${stage}`];
  const registry = {
    ...shipped,
    carriers: {
      ...shipped.carriers,
      [`${role}.${stage}`]: { ...mapping, forbidden: [mapping.required[0]] },
    },
  };
  assert.throws(
    () =>
      compileCarrier(registry, {
        role,
        stage,
        context: context(),
        bundle: bundle(),
        anchors: anchorsFor(mapping),
      }),
    code("carrier_forbidden_fragment"),
  );
});

test("the compiler refuses a dispatch that is not pinned to the registry bundle", () => {
  // An Epic that silently upgraded its rules mid-flight has changed the
  // question it is answering.
  assert.throws(
    () => compile("author", "brief", { context: { bundle_digest: "9".repeat(64) } }),
    code("carrier_bundle_unpinned"),
  );
});

test("the budget is fixed, and exceeding it is refused rather than truncated", () => {
  const [role, stage] = Object.keys(shipped.carriers)[0].split(".");
  const mapping = shipped.carriers[`${role}.${stage}`];
  const huge = bundle(Object.fromEntries(mapping.required.map((file) => [file, "x".repeat(200_000)])));
  assert.throws(() => compile(role, stage, { bundle: huge }), code("carrier_budget_exceeded"));
});

test("the same inputs serialise to the same bytes", () => {
  const first = compile("author", "brief");
  const second = compile("author", "brief");
  assert.equal(first.body, second.body);
  assert.equal(first.body_sha256, second.body_sha256);
  // ...and a different dispatch identity changes them, because the headers
  // carry it.
  const other = compile("author", "brief", { context: { dispatch_id: "disp-2" } });
  assert.notEqual(other.body_sha256, first.body_sha256);
});

test("the header carries both the file digest and the bundle digest", () => {
  // The file digest says which bytes; the bundle digest says which release they
  // came from, and the same bytes can appear in two releases whose surrounding
  // rules differ.
  const header = attributionHeader(
    { logical_id: "protocol/x.md", file_sha256: sha256("x") },
    { ...context(), role: "author", stage: "brief" },
  );
  assert.equal(header.file_sha256, sha256("x"));
  assert.equal(header.bundle_digest, shipped.bundle_digest);
  assert.equal(header.range_digest, null, "a whole file needs no range");
  assert.equal(serializeHeader(header).split("\n").length, HEADER_FIELDS.length);
});

test("every governance file has a consumer, or says who decided it has none", () => {
  // A file with neither is a file nobody can say why we ship.
  assert.deepEqual(coverageErrors(shipped), []);
  const orphaned = {
    ...shipped,
    governance_files: [...shipped.governance_files, { path: "protocol/orphan.md", status: "active" }],
  };
  assert.deepEqual(coverageErrors(orphaned), [
    { reason: "carrier_coverage_incomplete", path: "protocol/orphan.md", detail: "no consumer" },
  ]);
  const undecided = {
    ...shipped,
    governance_files: [...shipped.governance_files, { path: "protocol/later.md", status: "inactive_in_v1" }],
  };
  assert.equal(coverageErrors(undecided)[0].detail, "inactive without the decision that made it so");
  const decided = {
    ...shipped,
    governance_files: [
      ...shipped.governance_files,
      { path: "protocol/later.md", status: "inactive_in_v1", decided_by: "ADR-054" },
    ],
  };
  assert.deepEqual(coverageErrors(decided), []);
});

test("a correct echo verifies", () => {
  const compiled = compile("author", "brief");
  assert.deepEqual(verifyEcho(compiled.headers, compiled.headers.map((header) => ({ ...header }))), []);
});

test("a missing echo is a refusal, and so is no echo at all", () => {
  // The child answered a question the host cannot confirm it was asked.
  const compiled = compile("author", "brief");
  assert.deepEqual(verifyEcho(compiled.headers, []), [
    { reason: "carrier_echo_missing", detail: "no attributions were echoed" },
  ]);
  const partial = compiled.headers.slice(0, compiled.headers.length - 1).map((header) => ({ ...header }));
  const reasons = verifyEcho(compiled.headers, partial);
  assert.ok(reasons.some((entry) => entry.reason === "carrier_echo_missing"));
});

test("a mismatched field is named, field by field", () => {
  const compiled = compile("author", "brief");
  for (const field of ["file_sha256", "bundle_digest", "dispatch_id", "attempt", "role"]) {
    const echoed = compiled.headers.map((header) => ({ ...header }));
    echoed[0][field] = "something else";
    const reasons = verifyEcho(compiled.headers, echoed);
    assert.ok(
      reasons.some((entry) => entry.reason === "carrier_echo_mismatch" && entry.detail.endsWith(`.${field}`)),
      field,
    );
  }
});

test("an echo for something that was never sent is out of scope, not a mismatch", () => {
  const compiled = compile("author", "brief");
  const echoed = [...compiled.headers.map((header) => ({ ...header })), { logical_id: "protocol/never-sent.md" }];
  const reasons = verifyEcho(compiled.headers, echoed);
  assert.ok(reasons.some((entry) => entry.reason === "carrier_echo_wrong_scope"));
});

test("a duplicated echo is refused", () => {
  const compiled = compile("author", "brief");
  const echoed = compiled.headers.map((header) => ({ ...header }));
  const reasons = verifyEcho(compiled.headers, [...echoed, { ...echoed[0] }]);
  assert.ok(reasons.some((entry) => entry.reason === "carrier_echo_duplicate"));
});

test("a retry mints a new dispatch identity and fresh headers", () => {
  // Reusing it would make the second attempt indistinguishable from the first
  // in the record, which is what the echo exists to make distinguishable.
  const first = context();
  const second = retryContext(first, "disp-2");
  assert.equal(second.attempt, first.attempt + 1);
  assert.throws(() => retryContext(first, first.dispatch_id), code("carrier_echo_wrong_scope"));
  const before = compile("author", "brief");
  const after = compile("author", "brief", { context: { dispatch_id: "disp-2", attempt: 2 } });
  assert.notEqual(before.body_sha256, after.body_sha256);
  // The candidate does not change: only the dispatch identity does.
  assert.equal(second.epic, first.epic);
  assert.equal(second.task, first.task);
});

test("panel seats are shown byte-identical common fragments", () => {
  // A disagreement between seats is about the lens, not about what they were
  // shown.
  const keys = Object.keys(shipped.carriers).filter((key) => key.startsWith("gate."));
  if (keys.length >= 2) {
    const [aRole, aStage] = keys[0].split(".");
    const [bRole, bStage] = keys[1].split(".");
    const a = compile(aRole, aStage);
    const b = compile(bRole, bStage);
    for (const id of sharedBytes(a, b)) {
      const headerA = a.headers.find((header) => header.logical_id === id);
      const headerB = b.headers.find((header) => header.logical_id === id);
      assert.equal(headerA.file_sha256, headerB.file_sha256, id);
    }
  }
  // The property itself, independent of what the shipped registry happens to
  // contain: two compilations of the same key share every fragment digest.
  const one = compile("author", "brief");
  const two = compile("author", "brief");
  assert.deepEqual(sharedBytes(one, two), one.headers.map((header) => header.logical_id).sort());
});

test("every refusal class the contract closes can be produced", () => {
  const produced = new Set();
  const compiled = compile("author", "brief");
  for (const entry of verifyEcho(compiled.headers, [])) produced.add(entry.reason);
  for (const entry of verifyEcho(compiled.headers, [{ logical_id: "never-sent" }])) produced.add(entry.reason);
  const echoed = compiled.headers.map((header) => ({ ...header }));
  echoed[0].file_sha256 = "x";
  for (const entry of verifyEcho(compiled.headers, [...echoed, { ...echoed[0] }])) produced.add(entry.reason);
  for (const entry of coverageErrors({
    ...shipped,
    governance_files: [...shipped.governance_files, { path: "protocol/orphan.md", status: "active" }],
  })) {
    produced.add(entry.reason);
  }
  const attempts = [
    () => mappingFor(shipped, "nobody", "nowhere"),
    () => compile("author", "brief", { bundle: { read: () => undefined } }),
    () => compile("author", "brief", { context: { bundle_digest: "9".repeat(64) } }),
    () =>
      compile("author", "brief", {
        bundle: bundle(
          Object.fromEntries(shipped.carriers["author.brief"].required.map((file) => [file, "x".repeat(300_000)])),
        ),
      }),
    () => {
      const mapping = shipped.carriers["author.brief"];
      return compileCarrier(
        { ...shipped, carriers: { ...shipped.carriers, "author.brief": { ...mapping, forbidden: mapping.required } } },
        { role: "author", stage: "brief", context: context(), bundle: bundle(), anchors: anchorsFor(mapping) },
      );
    },
  ];
  for (const attempt of attempts) {
    try {
      attempt();
    } catch (error) {
      produced.add(error.code);
    }
  }
  for (const refusal of REFUSALS) {
    assert.ok(produced.has(refusal), `${refusal} is documented and never produced`);
  }
});
