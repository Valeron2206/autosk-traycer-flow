/**
 * Tests for the issue #31 Debate workflow.
 *
 * A Debate is cheaper to start than a prototype and produces something that
 * reads like an answer. Most of these are about that: the wrong question, a
 * roster that is one position wearing four names, a synthesis that tidied a
 * real disagreement away, and a recommendation recorded as a decision.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_MARKER,
  CONTRACT_PATH,
  EXAMPLE_PATH,
  GATE_COVERAGE,
  REFUSALS,
  REFUSED_EXAMPLE_PATH,
  SCHEMA_PATH,
  consensusHeld,
  debateDesignDigest,
  loadFiles,
  rosterDigest,
  validateDebate,
  validateDebateDesign,
} from "../scripts/validate-debate.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

const manifest = () => JSON.parse(files[EXAMPLE_PATH]);
const refusedManifest = () => JSON.parse(files[REFUSED_EXAMPLE_PATH]);

function mutated(mutate, { reseal = true } = {}) {
  const value = manifest();
  mutate(value);
  if (reseal && value.restart) value.restart.roster_digest = rosterDigest(value.roster);
  return value;
}

function assertRefuses(value, pattern) {
  const errors = validateDebate(value, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

test("the shipped design validates", () => {
  assert.deepEqual(validateDebateDesign(files), []);
});

test("the worked debate validates", () => {
  assert.deepEqual(validateDebate(manifest(), schema), []);
});

test("a question an artifact could answer goes to Arena", () => {
  assertRefuses(
    mutated((value) => {
      value.classifier.empirical_artifact_test_exists = true;
    }),
    /debate_empirical_question/u,
  );
});

test("the orchestrator may propose a Debate and may not start one", () => {
  for (const kind of ["orchestrator_proposal", "orchestrator_started"]) {
    assertRefuses(
      mutated((value) => {
        value.start.kind = kind;
      }),
      new RegExp(`debate_started_without_request: started as ${kind}`, "u"),
    );
  }
});

test("both gates are required, and cover different things", () => {
  for (const [index, fields] of GATE_COVERAGE.entries()) {
    for (const field of fields) {
      assertRefuses(
        mutated((value) => {
          const gate = value.gates.find((entry) => entry.gate === index + 1);
          gate.covers = gate.covers.filter((name) => name !== field);
        }),
        new RegExp(`debate_gate_missing: gate ${index + 1} does not cover ${field}`, "u"),
      );
    }
  }
});

test("the second gate cannot precede the first", () => {
  // Answering both at once means answering the second without having settled
  // the first.
  assertRefuses(
    mutated((value) => {
      value.gates.find((entry) => entry.gate === 2).approved_at = "2026-09-08T09:00:00Z";
    }),
    /the second gate was approved before the first/u,
  );
});

test("a roster is distinct positions in distinct sessions on approved routes", () => {
  assertRefuses(
    mutated((value) => {
      value.roster[2].stance = value.roster[1].stance;
    }),
    /debate_roster_not_diverse: maintainer restates another seat's stance/u,
  );
  assertRefuses(
    mutated((value) => {
      value.roster[2].session_id = value.roster[1].session_id;
    }),
    /shares a session with another seat/u,
  );
  assertRefuses(
    mutated((value) => {
      value.roster[2].route = "some/other-route";
    }),
    /which the second gate did not approve/u,
  );
  // Three is the floor and five the ceiling, and the schema is what holds it.
  assert.equal(schema.properties.roster.minItems, 3);
  assert.equal(schema.properties.roster.maxItems, 5);
});

test("an unavailable or degraded participant gets a user-visible disposition", () => {
  // A debate that quietly continued with three of five seats answered a
  // question nobody asked.
  for (const availability of ["unavailable", "degraded"]) {
    assertRefuses(
      mutated((value) => {
        value.roster[0].availability = availability;
      }),
      new RegExp(`debate_unavailability_undisclosed: operator is ${availability}`, "u"),
    );
  }
  const disclosed = mutated((value) => {
    value.roster[0].availability = "unavailable";
    value.roster[0].disposition_ref = "decision-0062";
  });
  assert.deepEqual(validateDebate(disclosed, schema), []);
});

test("round 1 positions are written without seeing the others", () => {
  // The first thing a model does with a visible position is agree with it.
  assertRefuses(
    mutated((value) => {
      value.rounds[0].positions[1].read_other_positions = true;
    }),
    /debate_round_one_contaminated: auditor/u,
  );
  // Later rounds are expected to have read them.
  const later = mutated((value) => {
    for (const position of value.rounds[1].positions) position.read_other_positions = true;
  });
  assert.deepEqual(validateDebate(later, schema), []);
});

test("later rounds cross-examine claims that were actually raised", () => {
  // Without this, round two is round one repeated more confidently.
  assertRefuses(
    mutated((value) => {
      delete value.rounds[1].positions[0].examines;
    }),
    /debate_no_cross_examination: operator in round 2/u,
  );
  assertRefuses(
    mutated((value) => {
      value.rounds[1].positions[0].examines = ["c99"];
    }),
    /examines c99, which no earlier round raised/u,
  );
});

test("a synthesis may not clean up a real disagreement", () => {
  assert.equal(consensusHeld(manifest().rounds[0]), false);
  assertRefuses(
    mutated((value) => {
      value.rounds[0].synthesis.state = "consensus";
    }),
    /debate_false_consensus: round 1 claims consensus over a live disagreement/u,
  );
  const genuine = mutated((value) => {
    const round = value.rounds[1];
    for (const position of round.positions) {
      for (const claim of position.claims) claim.position = "agree";
    }
    round.synthesis.state = "consensus";
    round.synthesis.disputed = [];
    round.synthesis.minority_views = [];
  });
  assert.equal(consensusHeld(genuine.rounds[1]), true);
  assert.deepEqual(validateDebate(genuine, schema), []);
});

test("minority views survive the rounds", () => {
  assertRefuses(
    mutated((value) => {
      value.rounds[1].synthesis.minority_views = [];
    }),
    /debate_minority_dropped: round 2/u,
  );
  assert.ok(schema.properties.rounds.items.properties.synthesis.required.includes("unresolved_assumptions"));
});

test("rounds and budget are host-enforced caps, not suggestions", () => {
  assert.equal(schema.properties.enforcement.properties.caps_enforced_by.const, "host");
  // The const stops this in the shipped path, so without reaching the guard
  // directly it would never be evaluated — and `validateDebate` is exported.
  const asked = mutated((value) => {
    value.enforcement.caps_enforced_by = "participants";
  });
  assert.ok(
    validateDebate(asked, { type: "object" }).some((message) => /debate_cap_not_host_enforced/u.test(message)),
  );
  assertRefuses(
    mutated((value) => {
      value.spent.rounds = 9;
    }),
    /debate_cap_exceeded: 9 rounds over 4/u,
  );
  assertRefuses(
    mutated((value) => {
      value.spent.cost_units = 500;
    }),
    /debate_cap_exceeded: 500 cost units over 120/u,
  );
});

test("a Debate produces no code PASS and replaces no review", () => {
  assert.equal(schema.properties.final.properties.produces_code_pass.const, false);
  for (const surface of ["panel", "review", "contest"]) {
    assertRefuses(
      mutated((value) => {
        value.final.substitutes_for = [surface];
      }),
      new RegExp(`debate_used_as_review_bypass: recorded as substituting for ${surface}`, "u"),
    );
  }
});

test("accepted requires the user's decision, and a material one enters the revision path", () => {
  assertRefuses(
    mutated((value) => {
      delete value.final.decision_ref;
    }),
    /debate_accepted_without_user/u,
  );
  assertRefuses(
    mutated((value) => {
      delete value.final.revision_ref;
    }),
    /debate_impact_not_revised/u,
  );
  const reversible = mutated((value) => {
    value.final.impact = "reversible";
    delete value.final.revision_ref;
  });
  assert.deepEqual(validateDebate(reversible, schema), []);
  const pending = mutated((value) => {
    value.final.disposition = "pending_user";
    delete value.final.decision_ref;
    delete value.final.revision_ref;
  });
  assert.deepEqual(validateDebate(pending, schema), []);
});

test("a restart continues the exact roster", () => {
  // A debate resumed with a different roster is a new debate that would inherit
  // the earlier rounds' authority.
  assertRefuses(
    mutated(
      (value) => {
        value.roster[3].route = value.caps.approved_routes[0];
      },
      { reseal: false },
    ),
    /debate_restart_identity_changed/u,
  );
});

test("inputs and outputs carry a clearance", () => {
  assert.ok(schema.required.includes("clearance_ref"));
  assert.ok(
    validateDebateDesign({
      ...files,
      [SCHEMA_PATH]: JSON.stringify({
        ...schema,
        required: schema.required.filter((field) => field !== "clearance_ref"),
      }),
    }).some((message) => /debate_input_uncleared/u.test(message)),
  );
});

test("the refused debate is refused, and names more than one thing", () => {
  const findings = validateDebate(refusedManifest(), schema);
  assert.ok(findings.length >= 8, findings.join("\n"));
  for (const pattern of [
    /debate_empirical_question/u,
    /debate_started_without_request/u,
    /debate_gate_missing/u,
    /debate_roster_not_diverse/u,
    /debate_unavailability_undisclosed/u,
    /debate_round_one_contaminated/u,
    /debate_no_cross_examination/u,
    /debate_false_consensus/u,
    /debate_minority_dropped/u,
    /debate_cap_exceeded/u,
    /debate_used_as_review_bypass/u,
    /debate_accepted_without_user/u,
    /debate_impact_not_revised/u,
    /debate_restart_identity_changed/u,
  ]) {
    assert.ok(findings.some((message) => pattern.test(message)), `${pattern} was not found`);
  }
});

test("the design checks fail when the shipped design stops satisfying them", () => {
  const broken = (path, transform) => validateDebateDesign({ ...files, [path]: transform(files[path]) });
  assert.ok(broken(CONTRACT_PATH, (text) => text.replace(CONTRACT_MARKER, "")).some((m) => /missing <!--/u.test(m)));
  assert.ok(
    broken(CONTRACT_PATH, (text) => text.replaceAll(SCHEMA_PATH, "elsewhere.json")).some((m) =>
      /does not point at/u.test(m),
    ),
  );
  assert.ok(
    broken(CONTRACT_PATH, (text) => text.replaceAll("debate_false_consensus", "consensus_bad")).some((m) =>
      /refusal debate_false_consensus is not documented/u.test(m),
    ),
  );
  for (const [sentence, expected] of [
    ["Is there an artifact whose construction would answer this?", /Arena\/Debate classifier/u],
    ["are not substitutes", /why Panel and contest do not replace/u],
    ["agree with it", /why round 1 is independent/u],
    ["a clean summary of a real disagreement is a false one", /mediator's failure mode/u],
  ]) {
    assert.ok(
      broken(CONTRACT_PATH, (text) => text.replaceAll(sentence, "")).some((m) => expected.test(m)),
      sentence,
    );
  }
});

test("the design checks fail when the schema stops closing what it must", () => {
  const withSchema = (transform) => {
    const draft = JSON.parse(files[SCHEMA_PATH]);
    transform(draft);
    return validateDebateDesign({ ...files, [SCHEMA_PATH]: JSON.stringify(draft) });
  };
  assert.ok(
    withSchema((draft) => {
      draft.additionalProperties = true;
    }).some((m) => /root must be closed/u.test(m)),
  );
  assert.ok(
    withSchema((draft) => {
      draft.properties.roster.maxItems = 9;
    }).some((m) => /three to five positions/u.test(m)),
  );
  assert.ok(
    withSchema((draft) => {
      draft.properties.gates.minItems = 1;
    }).some((m) => /both gates are required/u.test(m)),
  );
  assert.ok(
    withSchema((draft) => {
      draft.properties.enforcement.properties.caps_enforced_by = { type: "string" };
    }).some((m) => /must be a const, not a preference/u.test(m)),
  );
  assert.ok(
    withSchema((draft) => {
      draft.properties.final.properties.produces_code_pass = { type: "boolean" };
    }).some((m) => /must not be able to record a code PASS/u.test(m)),
  );
  for (const field of ["minority_views", "unresolved_assumptions"]) {
    assert.ok(
      withSchema((draft) => {
        const synthesis = draft.properties.rounds.items.properties.synthesis;
        synthesis.required = synthesis.required.filter((name) => name !== field);
      }).some((m) => new RegExp(`synthesis must record ${field}`, "u").test(m)),
      field,
    );
  }
});

test("malformed inputs are refused rather than partially read", () => {
  assert.ok(validateDebateDesign({ ...files, [SCHEMA_PATH]: "{" }).some((m) => /not valid JSON/u.test(m)));
  assert.ok(validateDebateDesign({ ...files, [REFUSED_EXAMPLE_PATH]: "{" }).some((m) => /not valid JSON/u.test(m)));
  assert.ok(
    validateDebateDesign({ ...files, [REFUSED_EXAMPLE_PATH]: files[EXAMPLE_PATH] }).some((m) =>
      /the refused example is accepted/u.test(m),
    ),
  );
});

test("every refusal class is documented", () => {
  for (const refusal of REFUSALS) {
    assert.ok(files[CONTRACT_PATH].includes(refusal), `${refusal} is not documented`);
  }
});

test("the design digest changes when any shipped file changes", () => {
  assert.notEqual(
    debateDesignDigest(files),
    debateDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` }),
  );
});
