/**
 * Tests for the issue #19 stage carrier matrix and attribution echo.
 *
 * Three things must be impossible: a role with no mapping, a forbidden fragment
 * reaching the role it was forbidden for, and an echo the host accepted without
 * comparing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_PATH,
  DISPATCH_EXAMPLE_PATH,
  PANEL_KEYS,
  REFUSALS,
  REGISTRY_PATH,
  REQUIRED_KEYS,
  SCHEMA_PATH,
  carrierDesignDigest,
  compareEcho,
  loadFiles,
  validateRegistry,
  validateStageCarriersDesign,
} from "../scripts/validate-stage-carriers.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

const registry = () => JSON.parse(files[REGISTRY_PATH]);
const dispatch = () => JSON.parse(files[DISPATCH_EXAMPLE_PATH]);

function mutated(mutate) {
  const value = registry();
  mutate(value);
  return value;
}

function assertRejects(value, pattern) {
  const errors = validateRegistry(value, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

test("the shipped design validates", () => {
  assert.deepEqual(validateStageCarriersDesign(files), []);
});

test("every consumer the issue names has a mapping, and nothing else does", () => {
  const keys = Object.keys(registry().carriers);
  assert.deepEqual(keys.slice().sort(), [...REQUIRED_KEYS].sort());
  assertRejects(
    mutated((value) => {
      delete value.carriers["arena.judge"];
    }),
    /arena\.judge has no mapping/u,
  );
  assertRejects(
    mutated((value) => {
      value.carriers["invented.role"] = { required: ["roles/author.md"], anchors: [], forbidden: [] };
    }),
    /is not a registered role\/stage/u,
  );
});

test("every governance file has a consumer or says why it has none", () => {
  // A file with neither is a file nobody can say why we ship.
  assertRejects(
    mutated((value) => {
      value.carriers["debate.mediator"].required = ["protocol/contracts/contest.md"];
    }),
    /roles\/mediator\.md has no consumer/u,
  );
  const explained = mutated((value) => {
    value.carriers["debate.mediator"].required = ["protocol/contracts/contest.md"];
    const file = value.governance_files.find((f) => f.path === "roles/mediator.md");
    file.status = "inactive_in_v1";
    file.decided_by = "ADR-054";
  });
  assert.deepEqual(validateRegistry(explained, schema), []);
});

test("inactive_in_v1 must name who decided it", () => {
  assertRejects(
    mutated((value) => {
      value.carriers["debate.mediator"].required = ["protocol/contracts/contest.md"];
      value.governance_files.find((f) => f.path === "roles/mediator.md").status = "inactive_in_v1";
    }),
    /must name the issue or ADR/u,
  );
});

test("the Judge rubric never reaches an Arena candidate", () => {
  // The failure `forbidden` exists to prevent.
  const value = registry();
  assert.ok(value.carriers["arena.candidate"].forbidden.includes("protocol/rubrics/judge.md"));
  assert.ok(!value.carriers["arena.candidate"].required.includes("protocol/rubrics/judge.md"));
  assertRejects(
    mutated((v) => {
      v.carriers["arena.candidate"].forbidden = [];
    }),
    /must forbid protocol\/rubrics\/judge\.md/u,
  );
});

test("a fragment cannot be both required and forbidden for one key", () => {
  assertRejects(
    mutated((value) => {
      value.carriers["arena.judge"].forbidden = ["protocol/rubrics/judge.md"];
    }),
    /both requires and forbids/u,
  );
});

test("the four panel seats are carried the same bytes and the same anchors", () => {
  // A disagreement between seats has to be about the lens, not about what they
  // were shown.
  const value = registry();
  const sets = PANEL_KEYS.map((key) => JSON.stringify(value.carriers[key].required));
  assert.equal(new Set(sets).size, 1);
  assertRejects(
    mutated((v) => {
      v.carriers["panel.grok"].required = [...v.carriers["panel.grok"].required, "roles/author.md"];
    }),
    /not carried the same bytes/u,
  );
  assertRejects(
    mutated((v) => {
      v.carriers["panel.muse"].anchors = [];
    }),
    /not carried the same anchors/u,
  );
});

test("a carrier that carries nothing is refused", () => {
  assertRejects(
    mutated((value) => {
      value.carriers["reflect.reviewer"].required = [];
    }),
    /carries nothing/u,
  );
});

test("an echo that matches every field is accepted", () => {
  const sent = dispatch().attributions;
  assert.equal(compareEcho(sent, sent), "matched");
});

test("a missing, absent or short echo is not a verdict", () => {
  const sent = dispatch().attributions;
  assert.equal(compareEcho(sent, undefined), "carrier_echo_missing");
  assert.equal(compareEcho(sent, []), "carrier_echo_missing");
  assert.equal(compareEcho(sent, [sent[0]]), "carrier_echo_missing");
  assert.ok(files[CONTRACT_PATH].includes("blocking non-verdict"));
});

test("the right file from the wrong bundle, round or attempt is not the right echo", () => {
  // An echo compared on the path alone would accept all three.
  const sent = dispatch().attributions;
  for (const [field, wrong, expected] of [
    ["source_sha256", "9".repeat(64), "carrier_echo_mismatch"],
    ["bundle_digest", "9".repeat(64), "carrier_echo_mismatch"],
    ["serialization_version", 2, "carrier_echo_mismatch"],
    ["round", 2, "carrier_echo_wrong_scope"],
    ["attempt", 2, "carrier_echo_wrong_scope"],
    ["dispatch_id", "dispatch-other", "carrier_echo_wrong_scope"],
    ["task_id", "ask-other", "carrier_echo_wrong_scope"],
  ]) {
    const echoed = JSON.parse(JSON.stringify(sent));
    echoed[0][field] = wrong;
    assert.equal(compareEcho(sent, echoed), expected, `${field} was not compared`);
  }
});

test("a duplicated echo entry is refused", () => {
  const sent = dispatch().attributions;
  const echoed = [sent[0], sent[0]];
  assert.equal(compareEcho(sent, echoed), "carrier_echo_duplicate");
});

test("an extract carries its section digest, and the whole file does not", () => {
  const sent = dispatch().attributions;
  assert.ok(sent.some((item) => item.section_sha256 !== undefined));
  assert.ok(sent.some((item) => item.section_sha256 === undefined));
  // Dropping the section digest from an extract is a mismatch, not a detail.
  const echoed = JSON.parse(JSON.stringify(sent));
  delete echoed.find((item) => item.section_sha256 !== undefined).section_sha256;
  assert.equal(compareEcho(sent, echoed), "carrier_echo_mismatch");
});

test("every refusal is documented", () => {
  const contract = files[CONTRACT_PATH];
  for (const refusal of REFUSALS) assert.ok(contract.includes(refusal), `${refusal} is not documented`);
});

test("the design digest changes when any shipped file changes", () => {
  const before = carrierDesignDigest(files);
  const after = carrierDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
