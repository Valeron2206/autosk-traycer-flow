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
  ARCHITECTURE_PATH,
  BUNDLE_COMPANIONS,
  CONTRACT_PATH,
  DISPATCH_EXAMPLE_PATH,
  MATRIX_PATH,
  PANEL_KEYS,
  PARITY_PATH,
  PLAN_PATH,
  REFUSALS,
  REGISTRY_PATH,
  REQUIRED_KEYS,
  SCHEMA_PATH,
  bundleTreeFiles,
  carrierDesignDigest,
  compareEcho,
  implementerKey,
  lifecycleErrors,
  loadFiles,
  memberListErrors,
  validateRegistry,
  validateStageCarriersDesign,
} from "../scripts/validate-stage-carriers.mjs";
import { WORK_TYPES } from "../src/host/work-type-gates.mjs";

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
      value.carriers["invented.role"] = {
        lifecycle: "required_for_v1", required: ["agent-selection-guide.md"], anchors: [], forbidden: [],
      };
    }),
    /is not a registered role\/stage/u,
  );
});

/** Takes a file out of every carrier that reads it. */
function unconsumed(value, file) {
  for (const carrier of Object.values(value.carriers)) {
    carrier.required = carrier.required.filter((entry) => entry !== file);
  }
}

test("every governance file has a consumer or says why it has none", () => {
  // A file with neither is a file nobody can say why we ship.
  const unslop = "protocol/writing/unslop.md";
  assertRejects(mutated((value) => unconsumed(value, unslop)), /protocol\/writing\/unslop\.md has no v1 consumer/u);
  const explained = mutated((value) => {
    unconsumed(value, unslop);
    const file = value.governance_files.find((f) => f.path === unslop);
    file.status = "inactive_in_v1";
    file.decided_by = "ADR-054";
  });
  assert.deepEqual(validateRegistry(explained, schema), []);
});

test("inactive_in_v1 must name who decided it", () => {
  assertRejects(
    mutated((value) => {
      unconsumed(value, "protocol/writing/unslop.md");
      value.governance_files.find((f) => f.path === "protocol/writing/unslop.md").status = "inactive_in_v1";
    }),
    /must name the issue or ADR/u,
  );
});

test("the Judge brief never reaches an Arena candidate", () => {
  // The failure `forbidden` exists to prevent.
  const value = registry();
  assert.ok(value.carriers["arena.candidate"].forbidden.includes("protocol/arena/judge-brief.md"));
  assert.ok(!value.carriers["arena.candidate"].required.includes("protocol/arena/judge-brief.md"));
  assertRejects(
    mutated((v) => {
      v.carriers["arena.candidate"].forbidden = [];
    }),
    /must forbid protocol\/arena\/judge-brief\.md/u,
  );
  assertRejects(
    mutated((v) => {
      v.carriers["arena.judge"].required = v.carriers["arena.judge"].required.filter((f) => !f.includes("judge-brief"));
    }),
    /arena\.judge must carry protocol\/arena\/judge-brief\.md/u,
  );
});

test("a fragment cannot be both required and forbidden for one key", () => {
  assertRejects(
    mutated((value) => {
      value.carriers["arena.judge"].forbidden = ["protocol/arena/judge-brief.md"];
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
      v.carriers["panel.grok"].required = [...v.carriers["panel.grok"].required, "protocol/writing/unslop.md"];
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

// Debt 10g (R6-17, R6-18, R6-19, a1): one governance bundle member list.

const sources = () => ({
  architecture: files[ARCHITECTURE_PATH],
  plan: files[PLAN_PATH],
  parity: JSON.parse(files[PARITY_PATH]),
});
const matrix = () => JSON.parse(files[MATRIX_PATH]);
const governancePaths = (value) => value.governance_files.map((file) => file.path);

test("the governance files are the bundle's thirteen normative files, as 02 §5 and 03 §3 list them", () => {
  const paths = governancePaths(registry());
  assert.equal(paths.length, 13);
  assert.equal(paths[0], "agent-selection-guide.md");
  assert.equal(paths.filter((file) => file.startsWith("protocol/")).length, 12);
  for (const markdown of [files[ARCHITECTURE_PATH], files[PLAN_PATH]]) {
    const listed = bundleTreeFiles(markdown);
    assert.deepEqual(listed.filter((file) => !BUNDLE_COMPANIONS.includes(file)), paths);
    assert.deepEqual(listed.filter((file) => BUNDLE_COMPANIONS.includes(file)), [...BUNDLE_COMPANIONS]);
  }
  assert.deepEqual(memberListErrors(registry(), sources()), []);
});

test("a divergence between the registry and 02, 03 or the parity registry is refused", () => {
  const renamed = (text) => text.replace("      bug-fix.md\n", "      bugfix.md\n");
  for (const [field, text] of [["architecture", files[ARCHITECTURE_PATH]], ["plan", files[PLAN_PATH]]]) {
    assert.notEqual(renamed(text), text, `${field} has no bug-fix.md line to rename`);
    const errors = memberListErrors(registry(), { ...sources(), [field]: renamed(text) });
    assert.ok(errors.some((message) => /protocol\/playbooks\/bug-fix\.md/u.test(message)), errors.join("\n"));
    assert.ok(errors.some((message) => /protocol\/playbooks\/bugfix\.md/u.test(message)), errors.join("\n"));
  }
  const dropped = mutated((value) => {
    value.governance_files = value.governance_files.filter((file) => file.path !== "protocol/playbooks/perf.md");
  });
  assert.ok(memberListErrors(dropped, sources()).some((message) => /perf\.md/u.test(message)));
  const parity = sources().parity;
  parity.sources = parity.sources.filter((source) => source.id !== "protocol.writing.unslop");
  assert.ok(
    memberListErrors(registry(), { ...sources(), parity }).some((message) => /writing\/unslop\.md/u.test(message)),
  );
  // A 02 without the bundle tree lists nothing, and that is a divergence, not a pass.
  assert.ok(memberListErrors(registry(), { ...sources(), architecture: "# 02\n" }).length > 0);
});

test("the inactive governance files are exactly the parity registry's post-v1 protocol files", () => {
  const inactive = registry().governance_files.filter((file) => file.status === "inactive_in_v1");
  assert.deepEqual(
    inactive.map((file) => [file.path, file.decided_by]),
    [["protocol/autobuild/run-contract.md", "#28"], ["protocol/reflect/reviewer-brief.md", "#29"]],
  );
  const activated = mutated((value) => {
    const file = value.governance_files.find((entry) => entry.path === "protocol/reflect/reviewer-brief.md");
    file.status = "active";
    delete file.decided_by;
  });
  assert.ok(memberListErrors(activated, sources()).some((message) => /reviewer-brief\.md/u.test(message)));
  const deactivated = mutated((value) => {
    const file = value.governance_files.find((entry) => entry.path === "protocol/writing/unslop.md");
    file.status = "inactive_in_v1";
    file.decided_by = "#19";
  });
  assert.ok(memberListErrors(deactivated, sources()).some((message) => /unslop\.md/u.test(message)));
});

test("every v1 work type has an implementer carrier, and it carries that work type's playbook", () => {
  assert.deepEqual(WORK_TYPES.map(implementerKey), [
    "implementer.feature", "implementer.bug_fix", "implementer.refactoring", "implementer.perf",
  ]);
  for (const type of WORK_TYPES) {
    const key = implementerKey(type);
    assert.ok(REQUIRED_KEYS.includes(key), `${key} is not required`);
    const carrier = registry().carriers[key];
    assert.equal(carrier.lifecycle, "required_for_v1", key);
    assert.ok(carrier.required.includes(`protocol/playbooks/${type}.md`), key);
  }
  // The implementer keys come from the work types, not from a second list.
  assert.deepEqual(REQUIRED_KEYS.filter((key) => key.startsWith("implementer.")), WORK_TYPES.map(implementerKey));
  assertRejects(mutated((value) => { delete value.carriers["implementer.perf"]; }), /implementer\.perf has no mapping/u);
  assertRejects(
    mutated((value) => {
      value.carriers["implementer.perf"].required = ["protocol/principles-digest.md", "protocol/playbooks/feature.md"];
    }),
    /implementer\.perf must carry protocol\/playbooks\/perf\.md/u,
  );
});

test("every carrier key says whether v1 dispatches it, and a post-v1 key names its issue", () => {
  const value = registry();
  const planned = Object.entries(value.carriers)
    .filter(([, carrier]) => carrier.lifecycle === "planned_after_v1")
    .map(([key, carrier]) => [key, carrier.decided_by]);
  assert.deepEqual(planned, [
    ["autobuild.generator", "#28"], ["autobuild.evaluator", "#28"],
    ["reflect.reviewer", "#29"],
    ["debate.participant", "#31"], ["debate.mediator", "#31"],
    ["walkthrough.author", "#33"], ["walkthrough.fact_validator", "#33"],
  ]);
  for (const [key, carrier] of Object.entries(value.carriers)) {
    if (carrier.lifecycle === "required_for_v1") assert.equal(carrier.decided_by, undefined, key);
  }
  assert.deepEqual(lifecycleErrors(value, matrix()), []);
  // Checked here rather than by the schema: the repository's schema reader does not apply an
  // `additionalProperties` schema, so the carrier entries' shape is the validator's to hold.
  assertRejects(
    mutated((v) => { delete v.carriers["reflect.reviewer"].lifecycle; }),
    /reflect\.reviewer: lifecycle must be required_for_v1 or planned_after_v1/u,
  );
  assertRejects(
    mutated((v) => { v.carriers["reflect.reviewer"].lifecycle = "someday"; }),
    /reflect\.reviewer: lifecycle must be required_for_v1 or planned_after_v1/u,
  );
  assertRejects(
    mutated((v) => { v.carriers["reflect.reviewer"].decided_by = "issue 29"; }),
    /reflect\.reviewer: decided_by must name an issue as #N/u,
  );
  assertRejects(
    mutated((v) => { delete v.carriers["reflect.reviewer"].decided_by; }),
    /reflect\.reviewer: planned_after_v1 must name the issue that decided it/u,
  );
  assertRejects(
    mutated((v) => { v.carriers["reviewer.code"].decided_by = "#16"; }),
    /reviewer\.code: a v1 carrier names no deciding issue/u,
  );
  // The issue must be one the matrix itself puts after v1.
  const wrongIssue = mutated((v) => { v.carriers["reflect.reviewer"].decided_by = "#19"; });
  assert.ok(lifecycleErrors(wrongIssue, matrix()).some((message) => /reflect\.reviewer.*#19/u.test(message)));
  const unknownIssue = mutated((v) => { v.carriers["reflect.reviewer"].decided_by = "#999"; });
  assert.ok(lifecycleErrors(unknownIssue, matrix()).some((message) => /#999/u.test(message)));
});

test("a v1 carrier never carries an inactive file, and an active file needs a v1 consumer", () => {
  assertRejects(
    mutated((v) => {
      v.carriers["reviewer.code"].required = [...v.carriers["reviewer.code"].required, "protocol/reflect/reviewer-brief.md"];
    }),
    /reviewer\.code is dispatched in v1 but carries protocol\/reflect\/reviewer-brief\.md, which is inactive_in_v1/u,
  );
  // Consumed only by a post-v1 key is not consumed in v1.
  assertRejects(
    mutated((v) => {
      for (const [key, carrier] of Object.entries(v.carriers)) {
        if (carrier.lifecycle === "required_for_v1") {
          carrier.required = carrier.required.filter((file) => file !== "protocol/verification/template.md");
          if (carrier.required.length === 0) throw new Error(key);
        }
      }
    }),
    /protocol\/verification\/template\.md has no v1 consumer \(carrier_coverage_incomplete\)/u,
  );
});

test("the design check reads 02, 03, the parity registry and the matrix", () => {
  const broken = { ...files, [ARCHITECTURE_PATH]: files[ARCHITECTURE_PATH].replace("      perf.md\n", "") };
  assert.ok(validateStageCarriersDesign(broken).some((message) => /perf\.md/u.test(message)));
  const matrixText = files[MATRIX_PATH].replace('"issue_number": 29,', '"issue_number": 2900,');
  assert.notEqual(matrixText, files[MATRIX_PATH]);
  assert.ok(validateStageCarriersDesign({ ...files, [MATRIX_PATH]: matrixText }).some((message) => /#29/u.test(message)));
});

// Debt 10g review: L1, L2 and M1.

test("the Judge brief is forbidden to every key but the Judge", () => {
  const value = registry();
  for (const [key, carrier] of Object.entries(value.carriers)) {
    if (key === "arena.judge") assert.ok(!carrier.forbidden.includes("protocol/arena/judge-brief.md"));
    else assert.ok(carrier.forbidden.includes("protocol/arena/judge-brief.md"), key);
  }
  for (const key of ["contest.reviewer", "author.brief", "debate.mediator", "verifier.deterministic"]) {
    assertRejects(
      mutated((v) => {
        v.carriers[key].forbidden = v.carriers[key].forbidden.filter((file) => file !== "protocol/arena/judge-brief.md");
      }),
      new RegExp(`${key.replace(".", "\\.")} must forbid protocol/arena/judge-brief\\.md`, "u"),
    );
  }
});

test("an inactive governance file names an issue the matrix puts after v1", () => {
  assert.deepEqual(lifecycleErrors(registry(), matrix()), []);
  const byAdr = mutated((v) => {
    v.governance_files.find((f) => f.path === "protocol/reflect/reviewer-brief.md").decided_by = "ADR-054";
  });
  assert.ok(lifecycleErrors(byAdr, matrix()).some((m) => /reviewer-brief\.md: ADR-054 is not an issue as #N/u.test(m)));
  const v1Issue = mutated((v) => {
    v.governance_files.find((f) => f.path === "protocol/reflect/reviewer-brief.md").decided_by = "#19";
  });
  assert.ok(lifecycleErrors(v1Issue, matrix()).some((m) => /reviewer-brief\.md: #19 is required_for_v1/u.test(m)));
  const unknown = mutated((v) => {
    v.governance_files.find((f) => f.path === "protocol/autobuild/run-contract.md").decided_by = "#999";
  });
  assert.ok(lifecycleErrors(unknown, matrix()).some((m) => /run-contract\.md: #999 is not an issue/u.test(m)));
});

test("the contract and 02 say the Epic's protocol lock pins the carrier registry", () => {
  assert.ok(files[CONTRACT_PATH].includes("carrier_registry_digest"));
  assert.ok(files[ARCHITECTURE_PATH].includes("carrier_registry_digest"));
  const errors = validateStageCarriersDesign({ ...files, [CONTRACT_PATH]: files[CONTRACT_PATH].replaceAll("carrier_registry_digest", "x") });
  assert.ok(errors.some((m) => /carrier_registry_digest/u.test(m)));
});
