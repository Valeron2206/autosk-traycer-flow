/**
 * Tests for the issue #25 requirement revision path.
 *
 * The issue lists eleven mandatory scenarios, and they are all one question:
 * did the change reach the product layer before it reached the Tickets and the
 * code, and did a person decide the fate of work that already exists.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CONTRACT_MARKER,
  CONTRACT_PATH,
  DECISION_REQUIRED_STATES,
  EXAMPLE_PATH,
  KINDS,
  MATERIAL_KINDS,
  REFUSALS,
  REFUSED_EXAMPLE_PATH,
  SCHEMA_PATH,
  USER_DISPOSITIONS,
  loadFiles,
  orderErrors,
  rebindProved,
  revisionDecision,
  revisionDesignDigest,
  validateRequirementRevisionDesign,
  validateRevision,
} from "../scripts/validate-requirement-revision.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

const record = () => JSON.parse(files[EXAMPLE_PATH]);
const refusedRecord = () => JSON.parse(files[REFUSED_EXAMPLE_PATH]);

function mutated(mutate, base = record) {
  const value = base();
  mutate(value);
  return value;
}

function assertRefuses(value, pattern) {
  const errors = validateRevision(value, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

function stage(value, number) {
  return value.stages.find((entry) => entry.stage === number);
}

test("the shipped design validates", () => {
  assert.deepEqual(validateRequirementRevisionDesign(files), []);
});

test("the worked example is a complete, approved round", () => {
  assert.deepEqual(validateRevision(record(), schema), []);
  assert.equal(revisionDecision(record(), [], schema), "proceed");
});

test("a product requirement change takes the full path", () => {
  // The first mandatory scenario: nothing may be skipped because the change
  // looks small from the code end.
  const value = record();
  assert.equal(value.classification.kind, "product_behavior");
  assert.equal(value.stages.length, 12);
  assert.ok(value.stages.every((entry) => entry.state === "complete"));
});

test("a clarification that edits the product layer is refused, not reviewed leniently", () => {
  // Calling a product change a clarification removes every panel from it in one
  // word, which is why this is the cheapest thing to get wrong.
  assertRefuses(
    mutated((value) => {
      value.classification = { kind: "evidence_clarification", material: false, rationale: "wording only, allegedly" };
    }),
    /revision_class_mismatch: evidence_clarification touches/u,
  );
});

test("materiality is derived, not declared", () => {
  for (const kind of KINDS) {
    const wrong = mutated((value) => {
      value.classification = { kind, material: !MATERIAL_KINDS.includes(kind), rationale: "a rationale long enough" };
    });
    assertRefuses(wrong, /revision_class_mismatch: /u);
  }
});

test("a technical-constraint-only change is material and still panels", () => {
  const value = mutated((draft) => {
    draft.classification = {
      kind: "technical_constraint",
      material: true,
      rationale: "the platform constraint changes, the user-visible behaviour does not",
    };
    draft.artifacts = draft.artifacts.filter((artifact) => artifact.layer !== "product");
  });
  assert.deepEqual(validateRevision(value, schema), []);
});

test("a security or delivery change is material", () => {
  const value = mutated((draft) => {
    draft.classification = {
      kind: "delivery_operations_security_data",
      material: true,
      rationale: "the delivery profile and the data handling both move",
    };
  });
  assert.deepEqual(validateRevision(value, schema), []);
});

test("the Tickets manifest is regenerated last", () => {
  // Not an ordering preference: a manifest regenerated before the technical
  // layer settles is a manifest of the previous plan, and it looks current.
  assertRefuses(
    mutated((value) => {
      stage(value, 3).side_effect = "tickets_manifest";
    }),
    /revision_manifest_early: tickets_manifest at stage 3/u,
  );
});

test("no code side effect precedes the approved impact plan", () => {
  assertRefuses(
    mutated((value) => {
      stage(value, 5).side_effect = "code";
    }),
    /revision_out_of_order: code at stage 5/u,
  );
});

test("a change during the panel does not proceed past the open stage", () => {
  // The fourth mandatory scenario: the panel is still running, so the stages
  // after it have nothing settled to work from.
  assertRefuses(
    mutated((value) => {
      stage(value, 4).state = "pending";
    }),
    /revision_out_of_order: tickets_manifest at stage 7 while stage 4 has not closed/u,
  );
});

test("a live Ticket is paused before its manifest entry is superseded", () => {
  // Otherwise a model keeps working from a plan that no longer exists, and its
  // output is reviewed against criteria it never saw.
  assertRefuses(
    mutated((value) => {
      value.ticket_dispositions.find((entry) => entry.ticket_id === "T-102").disposition = "regenerated";
    }),
    /T-102 is live and is paused/u,
  );
});

test("the fate of staged and integrated work is the user's decision", () => {
  for (const state of DECISION_REQUIRED_STATES) {
    assertRefuses(
      mutated((value) => {
        const entry = value.ticket_dispositions.find((item) => item.state === state);
        entry.disposition = "unchanged";
        delete entry.decision_ref;
      }),
      new RegExp(`revision_decision_missing: ${state === "staged" ? "T-104" : "T-105"}`, "u"),
    );
  }
});

test("intentional_defer is a choice, not an observation", () => {
  // The option most likely to be recorded by the model on the user's behalf.
  assertRefuses(
    mutated((value) => {
      delete value.ticket_dispositions.find((entry) => entry.state === "integrated").decision_ref;
    }),
    /revision_decision_missing: T-105 \(intentional_defer\) names no decision record/u,
  );
});

test("the four options are exactly the ones offered, and only for implemented work", () => {
  for (const disposition of USER_DISPOSITIONS) {
    const value = mutated((draft) => {
      const entry = draft.ticket_dispositions.find((item) => item.state === "staged");
      entry.disposition = disposition;
    });
    assert.deepEqual(validateRevision(value, schema), [], disposition);
  }
  assertRefuses(
    mutated((value) => {
      value.ticket_dispositions.find((entry) => entry.state === "new").disposition = "new_epic";
    }),
    /T-101 is new, not implemented work/u,
  );
});

test("a rebind needs identity and dependency proof", () => {
  // "It looks unrelated" is a description of a reading, not evidence about a
  // dependency graph.
  const artifact = record().artifacts.find((entry) => entry.review === "rebound_unaffected");
  assert.equal(rebindProved(artifact), true);
  assert.equal(rebindProved({ ...artifact, content_digest: "9".repeat(64) }), false);
  assertRefuses(
    mutated((value) => {
      const rebound = value.artifacts.find((entry) => entry.review === "rebound_unaffected");
      rebound.dependencies[0].digest = "9".repeat(64);
    }),
    /revision_rebind_unproven/u,
  );
});

test("an artifact that did not pass its panel is refused", () => {
  assertRefuses(
    mutated((value) => {
      value.artifacts[0].verdict = "pending";
    }),
    /revision_panel_missing: 01-core-flows.md/u,
  );
});

test("a Ticket artifact takes the Ticket panel, not the artifact panel", () => {
  assertRefuses(
    mutated((value) => {
      value.artifacts.find((entry) => entry.layer === "tickets").review = "full_panel";
    }),
    /revision_panel_missing: .* takes the Ticket panel/u,
  );
});

test("a surviving Ticket may not reference a superseded criterion", () => {
  assertRefuses(
    mutated((value) => {
      value.sweep.superseded_references.push("ADR-041");
    }),
    /revision_stale_reference: T-103 still references superseded ADR-041/u,
  );
});

test("a sweep that resolved nothing cannot report a clean result", () => {
  assertRefuses(
    mutated((value) => {
      value.sweep.searched_references = 0;
    }),
    /the sweep resolved nothing/u,
  );
});

test("two rapid corrections claiming the same predecessor are a fork", () => {
  // The second quietly reverts the first, and both look applied.
  const first = record();
  const second = mutated((value) => {
    value.round_id = "rev-0008";
  });
  assert.equal(revisionDecision(second, [first], schema), "refused:revision_supersession_forked");
  const chained = mutated((value) => {
    value.round_id = "rev-0008";
    value.supersedes = "rev-0007";
    value.anchor = { before: 7, after: 8, bumped_by_round: "rev-0008" };
  });
  assert.equal(revisionDecision(chained, [first], schema), "proceed");
});

test("a replayed round is recognised, and the anchor is bumped once", () => {
  assert.equal(revisionDecision(record(), [record()], schema), "refused:revision_round_replay");
  assertRefuses(
    mutated((value) => {
      value.anchor.bumped_by_round = "rev-0006";
    }),
    /revision_round_replay: the anchor was bumped by rev-0006/u,
  );
});

test("the recorded instruction is bound to its digest", () => {
  // The normalized record is the interpretation; an interpretation that can
  // silently replace its source cannot be checked against it.
  assertRefuses(
    mutated((value) => {
      value.original_instruction.text = `${value.original_instruction.text} и ещё одно требование`;
    }),
    /revision_instruction_rewritten/u,
  );
  const rehashed = mutated((value) => {
    value.original_instruction.text = "другой текст";
    value.original_instruction.digest = createHash("sha256").update("другой текст", "utf8").digest("hex");
  });
  assert.deepEqual(validateRevision(rehashed, schema), []);
});

test("a released epic is not rewritten", () => {
  // Both directions: proposing a material change to one, and writing into one.
  assertRefuses(
    mutated((value) => {
      value.epic.state = "released";
    }),
    /revision_closed_epic: a released epic is not rewritten/u,
  );
  const findings = validateRevision(refusedRecord(), schema);
  assert.ok(findings.some((message) => /was written at stage 3 of a released epic/u.test(message)));
});

test("an approved impact plan names the decision that approved it", () => {
  assertRefuses(
    mutated((value) => {
      delete value.impact_plan.decision_ref;
    }),
    /revision_decision_missing: an approved impact plan/u,
  );
  assertRefuses(
    mutated((value) => {
      stage(value, 11).state = "pending";
      stage(value, 12).side_effect = "none";
    }),
    /the impact plan is approved with stage 11 still open/u,
  );
});

test("orderErrors sees a stage recorded out of position", () => {
  const scrambled = mutated((value) => {
    [value.stages[3], value.stages[4]] = [value.stages[4], value.stages[3]];
  });
  assert.ok(orderErrors(scrambled).some((message) => /is recorded in position/u.test(message)));
});

test("the refused example is refused, and names more than one thing", () => {
  const findings = validateRevision(refusedRecord(), schema);
  assert.ok(findings.length >= 4, findings.join("\n"));
  assert.equal(revisionDecision(refusedRecord(), [], schema), "refused:revision_class_mismatch");
});

test("a staged Ticket with a decision but the wrong kind of disposition is refused", () => {
  // A decision record does not make "unchanged" one of the options the user was
  // given: the disposition itself has to be one of the four.
  assertRefuses(
    mutated((value) => {
      value.ticket_dispositions.find((entry) => entry.state === "staged").disposition = "unchanged";
    }),
    /revision_decision_missing: T-104 is staged and takes one of the user options/u,
  );
});

test("a stale reference found by the sweep is a refusal on its own", () => {
  assertRefuses(
    mutated((value) => {
      value.sweep.stale_references.push("T-103 -> AC-3");
    }),
    /revision_stale_reference: T-103 -> AC-3/u,
  );
});

test("the design checks fail when the shipped design stops satisfying them", () => {
  // Without these the design-level guards are never evaluated: the shipped
  // files satisfy them, so only a broken variant can show the check exists.
  const broken = (path, transform) =>
    validateRequirementRevisionDesign({ ...files, [path]: transform(files[path]) });

  assert.ok(
    broken(CONTRACT_PATH, (text) => text.replace(CONTRACT_MARKER, "")).some((message) =>
      /missing <!-- requirement-revision-contract:v1 -->/u.test(message),
    ),
  );
  assert.ok(
    broken(CONTRACT_PATH, (text) => text.replace(SCHEMA_PATH, "somewhere/else.json")).some((message) =>
      /does not point at/u.test(message),
    ),
  );
  assert.ok(
    broken(CONTRACT_PATH, (text) => text.replaceAll("revision_rebind_unproven", "rebind_bad")).some((message) =>
      /refusal revision_rebind_unproven is not documented/u.test(message),
    ),
  );
  assert.ok(
    broken(CONTRACT_PATH, (text) => text.replaceAll("non_material_correction", "trivial")).some((message) =>
      /kind non_material_correction is not documented/u.test(message),
    ),
  );
  assert.ok(
    broken(CONTRACT_PATH, (text) => text.replaceAll("correction_ticket", "patch_ticket")).some((message) =>
      /option correction_ticket is not documented/u.test(message),
    ),
  );
  for (const [sentence, expected] of [
    ["A product change is not applied to code or Tickets first", /the invariant the order exists for/u],
    ["The order is the content", /the sequence is the decision/u],
    ["does not choose among them", /who decides the fate of implemented work/u],
    ["a proof, not an impression", /what an unaffected rebind needs/u],
  ]) {
    assert.ok(
      broken(CONTRACT_PATH, (text) => text.replace(sentence, "")).some((message) => expected.test(message)),
      sentence,
    );
  }
});

test("the design checks fail when the schema stops closing what it must", () => {
  const withSchema = (transform) => {
    const draft = JSON.parse(files[SCHEMA_PATH]);
    transform(draft);
    return validateRequirementRevisionDesign({ ...files, [SCHEMA_PATH]: JSON.stringify(draft) });
  };
  assert.ok(
    withSchema((draft) => {
      draft.additionalProperties = true;
    }).some((message) => /root must be closed/u.test(message)),
  );
  assert.ok(
    withSchema((draft) => {
      draft.properties.classification.properties.kind.enum = KINDS.slice(0, 4);
    }).some((message) => /the five kinds must match/u.test(message)),
  );
  assert.ok(
    withSchema((draft) => {
      draft.properties.stages.minItems = 1;
    }).some((message) => /all twelve stages must be present/u.test(message)),
  );
  assert.ok(
    withSchema((draft) => {
      draft.required = draft.required.filter((field) => field !== "original_instruction");
    }).some((message) => /original instruction must be required/u.test(message)),
  );
});

test("the design checks fail on an unparsable or an accepted refused example", () => {
  assert.ok(
    validateRequirementRevisionDesign({ ...files, [REFUSED_EXAMPLE_PATH]: "{" }).some((message) =>
      /not valid JSON/u.test(message),
    ),
  );
  // The refused example earns its place by being refused; if it ever validates,
  // the file has drifted into a second happy path.
  assert.ok(
    validateRequirementRevisionDesign({ ...files, [REFUSED_EXAMPLE_PATH]: files[EXAMPLE_PATH] }).some((message) =>
      /the refused example is accepted/u.test(message),
    ),
  );
});

test("every refusal class is documented", () => {
  const contract = files[CONTRACT_PATH];
  for (const refusal of REFUSALS) assert.ok(contract.includes(refusal), `${refusal} is not documented`);
});

test("the design digest changes when any shipped file changes", () => {
  const before = revisionDesignDigest(files);
  const after = revisionDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
