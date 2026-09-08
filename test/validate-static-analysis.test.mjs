/**
 * Tests for the issue #47 static-analysis gate.
 *
 * A deterministic analyzer is cheap to trust wrongly: the tree changes, the
 * analysis id does not, and a green check from twenty minutes ago is still on
 * the page. Most of these are about identity, about which conditions were
 * actually evaluated, and about the states a run may not quietly slide between.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONDITIONS,
  CONTRACT_MARKER,
  CONTRACT_PATH,
  ENFORCEMENT,
  POLICY_EXAMPLE_PATH,
  POLICY_SCHEMA_PATH,
  REFUSALS,
  REFUSED_EXAMPLE_PATH,
  RESULT_EXAMPLE_PATH,
  RESULT_SCHEMA_PATH,
  expectedConditions,
  loadFiles,
  policyDigest,
  staticAnalysisDesignDigest,
  validatePolicy,
  validateResult,
  validateStaticAnalysisDesign,
} from "../scripts/validate-static-analysis.mjs";

const files = loadFiles();
const policySchema = JSON.parse(files[POLICY_SCHEMA_PATH]);
const resultSchema = JSON.parse(files[RESULT_SCHEMA_PATH]);

const policy = () => JSON.parse(files[POLICY_EXAMPLE_PATH]);
const result = () => JSON.parse(files[RESULT_EXAMPLE_PATH]);
const refusedResult = () => JSON.parse(files[REFUSED_EXAMPLE_PATH]);

function sealed(draft) {
  draft.digest = policyDigest(draft);
  return draft;
}

function mutatedPolicy(mutate, { reseal = true } = {}) {
  const value = policy();
  mutate(value);
  return reseal ? sealed(value) : value;
}

function mutatedResult(mutate) {
  const value = result();
  mutate(value);
  return value;
}

function assertPolicyRefuses(value, pattern) {
  const errors = validatePolicy(value, policySchema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

function assertResultRefuses(value, pattern, withPolicy = policy()) {
  const errors = validateResult(value, withPolicy, resultSchema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

test("the shipped design validates", () => {
  assert.deepEqual(validateStaticAnalysisDesign(files), []);
});

test("the worked policy and result validate", () => {
  assert.deepEqual(validatePolicy(policy(), policySchema), []);
  assert.deepEqual(validateResult(result(), policy(), resultSchema), []);
});

test("the analyzer replaces no review", () => {
  assert.equal(resultSchema.properties.replaces_review.const, false);
  const errors = validateResult(
    mutatedResult((value) => {
      value.replaces_review = true;
    }),
    policy(),
    { type: "object" },
  );
  assert.ok(errors.some((message) => /sonar_gate_replaces_review/u.test(message)));
});

test("the policy is the seven conditions, exactly", () => {
  assertPolicyRefuses(
    mutatedPolicy((value) => {
      value.conditions[6].id = "reliability-rating-relaxed";
    }),
    /sonar_policy_not_exact/u,
  );
  assertPolicyRefuses(
    mutatedPolicy((value) => {
      value.conditions[4].scope = "new_code";
    }),
    /security-rating is new_code, not overall_code/u,
  );
  assert.equal(policySchema.properties.conditions.minItems, 7);
  assert.equal(policySchema.properties.conditions.maxItems, 7);
});

test("a pull request applies four conditions and main applies seven", () => {
  assert.deepEqual(expectedConditions("pull_request"), [
    "no-new-issues",
    "new-hotspots-reviewed",
    "new-coverage",
    "new-duplication",
  ]);
  assert.equal(expectedConditions("main_branch").length, 7);
  assert.deepEqual(expectedConditions("unavailable"), []);
  // Computing the wrong set is an answer about a different question.
  assertResultRefuses(
    mutatedResult((value) => {
      value.conditions_evaluated = CONDITIONS.map((entry) => entry.id);
    }),
    /sonar_mode_mismatch: pull_request evaluated 7 conditions, expected 4/u,
  );
  const main = mutatedResult((value) => {
    value.mode = "main_branch";
    value.conditions_evaluated = CONDITIONS.map((entry) => entry.id);
  });
  assert.deepEqual(validateResult(main, policy(), resultSchema), []);
  assertResultRefuses(
    mutatedResult((value) => {
      value.mode = "main_branch";
    }),
    /main_branch evaluated 4 conditions, expected 7/u,
  );
  assertPolicyRefuses(
    mutatedPolicy((value) => {
      value.conditions[0].applies_to_pull_request = false;
    }),
    /sonar_mode_mismatch: no-new-issues pull-request applicability is wrong/u,
  );
});

test("the small-change fudge factor does not become a coverage bypass", () => {
  // A stream of small agent edits would otherwise pass a requirement none of
  // them met.
  assertPolicyRefuses(
    mutatedPolicy((value) => {
      value.small_change.provider_fudge_factor = "enabled_unsupported_by_provider";
      value.small_change.host_compensates = false;
    }),
    /sonar_small_change_bypass/u,
  );
  const compensated = mutatedPolicy((value) => {
    value.small_change.provider_fudge_factor = "enabled_unsupported_by_provider";
    value.small_change.host_compensates = true;
  });
  assert.deepEqual(validatePolicy(compensated, policySchema), []);
});

test("a hosted analyzer needs a recorded delivery decision", () => {
  assertPolicyRefuses(
    mutatedPolicy((value) => {
      value.delivery.decision_ref = null;
    }),
    /sonar_delivery_undecided/u,
  );
  const local = mutatedPolicy((value) => {
    value.delivery = { hosted: false, decision_ref: null };
  });
  assert.deepEqual(validatePolicy(local, policySchema), []);
});

test("the policy digest recomputes, so a mid-run change is visible", () => {
  assertPolicyRefuses(
    mutatedPolicy(
      (value) => {
        value.conditions[2].threshold = 40;
      },
      { reseal: false },
    ),
    /sonar_identity_stale: the policy digest does not recompute/u,
  );
  assertResultRefuses(
    mutatedResult((value) => {
      value.policy_digest = "3".repeat(64);
    }),
    /sonar_identity_stale: the result cites policy/u,
  );
});

test("a moved tree invalidates the result", () => {
  // Where a stale PASS gets accepted in practice.
  assertResultRefuses(
    mutatedResult((value) => {
      value.candidate.current_tree_oid = "5".repeat(40);
    }),
    /sonar_identity_stale: analysed/u,
  );
});

test("an unsupported mode is absent, not a PASS", () => {
  assertResultRefuses(
    mutatedResult((value) => {
      value.provider.unsupported_modes = ["pull_request"];
    }),
    /sonar_pass_without_analysis: pull_request is unsupported/u,
  );
  for (const state of ["pending", "failed", "canceled", "not_run"]) {
    assertResultRefuses(
      mutatedResult((value) => {
        value.analysis.state = state;
      }),
      new RegExp(`sonar_pass_without_analysis: the analysis is ${state}`, "u"),
    );
  }
  assertResultRefuses(
    mutatedResult((value) => {
      value.mode = "unavailable";
      value.conditions_evaluated = [];
    }),
    /sonar_pass_without_analysis: the gate did not run/u,
  );
});

test("a run never slides quietly down the enforcement ladder", () => {
  // An unavailable required gate is not an advisory gate.
  assertResultRefuses(result(), /sonar_silent_downgrade: a disabled gate recorded a PASS/u, {
    ...policy(),
    enforcement: "disabled",
  });
  assertResultRefuses(
    mutatedResult((value) => {
      value.outcome = "not_run";
    }),
    /a required gate that did not run must block/u,
  );
  assert.deepEqual(policySchema.properties.enforcement.enum, [...ENFORCEMENT]);
});

test("every input report carries its provenance", () => {
  // "Coverage 84%" is a number with no subject.
  assertResultRefuses(
    mutatedResult((value) => {
      delete value.input_reports[0].producer;
    }),
    /sonar_report_provenance_missing: coverage\/lcov.info names no producer/u,
  );
  assertResultRefuses(
    mutatedResult((value) => {
      value.input_reports[1].produced_from_tree_oid = "6".repeat(40);
    }),
    /was produced from another tree/u,
  );
});

test("a result for an unrecorded operation is ignored", () => {
  assertResultRefuses(
    mutatedResult((value) => {
      value.analysis.receipt_recorded = false;
    }),
    /sonar_result_without_receipt/u,
  );
});

test("the webhook is authenticated, matched and idempotent", () => {
  assertResultRefuses(
    mutatedResult((value) => {
      value.webhook.authenticated = false;
    }),
    /sonar_webhook_unauthenticated/u,
  );
  assertResultRefuses(
    mutatedResult((value) => {
      value.webhook.analysis_id = "AZ-analysis-other";
    }),
    /sonar_webhook_foreign/u,
  );
  assertResultRefuses(
    mutatedResult((value) => {
      value.webhook.project_key = "someone_else_project";
    }),
    /sonar_webhook_foreign/u,
  );
  assertResultRefuses(
    mutatedResult((value) => {
      value.webhook.seen_delivery_ids = ["whk-1", "whk-1"];
    }),
    /sonar_webhook_replay/u,
  );
});

test("the implementer does not dispose of its own findings", () => {
  // It has the strongest reason to believe its own code is safe, and this is
  // where that belief would be recorded as a fact about the code.
  for (const kind of ["security_hotspot", "issue"]) {
    assertResultRefuses(
      mutatedResult((value) => {
        value.findings[0].kind = kind;
        value.findings[0].disposed_by = "implementer";
      }),
      /sonar_disposition_by_implementer: S3776-1/u,
    );
  }
  assertResultRefuses(
    mutatedResult((value) => {
      delete value.findings[0].triage_ref;
    }),
    /disposed outside the canonical triage/u,
  );
});

test("the interface names no cloud, plan or edition", () => {
  // SonarQube is the first adapter, not the interface.
  for (const word of ["sonarcloud", "sonarqube", "enterprise"]) {
    const broken = {
      ...files,
      [RESULT_SCHEMA_PATH]: files[RESULT_SCHEMA_PATH].replace('"title": "Static analysis result"', `"title": "${word} result"`),
    };
    assert.ok(
      validateStaticAnalysisDesign(broken).some((message) => /not provider-neutral/u.test(message)),
      word,
    );
  }
});

test("the refused result is refused, and names more than one thing", () => {
  const findings = validateResult(refusedResult(), policy(), resultSchema);
  assert.ok(findings.length >= 6, findings.join("\n"));
  for (const pattern of [
    /sonar_identity_stale/u,
    /sonar_mode_mismatch/u,
    /sonar_pass_without_analysis/u,
    /sonar_report_provenance_missing/u,
    /sonar_result_without_receipt/u,
    /sonar_webhook_unauthenticated/u,
    /sonar_webhook_foreign/u,
    /sonar_webhook_replay/u,
    /sonar_disposition_by_implementer/u,
  ]) {
    assert.ok(findings.some((message) => pattern.test(message)), `${pattern} was not found`);
  }
});

test("the design checks fail when the shipped design stops satisfying them", () => {
  const broken = (path, transform) => validateStaticAnalysisDesign({ ...files, [path]: transform(files[path]) });
  assert.ok(broken(CONTRACT_PATH, (text) => text.replace(CONTRACT_MARKER, "")).some((m) => /missing <!--/u.test(m)));
  for (const schemaPath of [POLICY_SCHEMA_PATH, RESULT_SCHEMA_PATH]) {
    assert.ok(
      broken(CONTRACT_PATH, (text) => text.replaceAll(schemaPath, "elsewhere.json")).some((m) =>
        /does not point at/u.test(m),
      ),
    );
  }
  assert.ok(
    broken(CONTRACT_PATH, (text) => text.replaceAll("sonar_webhook_replay", "replay")).some((m) =>
      /refusal sonar_webhook_replay is not documented/u.test(m),
    ),
  );
  assert.ok(
    broken(CONTRACT_PATH, (text) => text.replaceAll("`advisory`", "advisory")).some((m) =>
      /enforcement state advisory is not documented/u.test(m),
    ),
  );
  for (const [sentence, expected] of [
    ["not a fifth model", /what the analyzer is not/u],
    ["absent, not approximated", /what an unsupported capability is/u],
    ["a gate that did not run", /what an unavailable required gate is/u],
    ["off by default", /the small-change policy/u],
    ["No account, plan or purchase is created by this contract", /authorises no purchase/u],
  ]) {
    assert.ok(
      broken(CONTRACT_PATH, (text) => text.replaceAll(sentence, "")).some((m) => expected.test(m)),
      sentence,
    );
  }
});

test("the design checks fail when a schema stops closing what it must", () => {
  const withSchema = (relative, transform) => {
    const draft = JSON.parse(files[relative]);
    transform(draft);
    return validateStaticAnalysisDesign({ ...files, [relative]: JSON.stringify(draft) });
  };
  for (const relative of [POLICY_SCHEMA_PATH, RESULT_SCHEMA_PATH]) {
    assert.ok(
      withSchema(relative, (draft) => {
        draft.additionalProperties = true;
      }).some((m) => /root must be closed/u.test(m)),
      relative,
    );
  }
  assert.ok(
    withSchema(POLICY_SCHEMA_PATH, (draft) => {
      draft.properties.conditions.maxItems = 9;
    }).some((m) => /exactly seven conditions/u.test(m)),
  );
  assert.ok(
    withSchema(POLICY_SCHEMA_PATH, (draft) => {
      draft.properties.enforcement.enum = ["advisory", "required"];
    }).some((m) => /exactly disabled, advisory, required/u.test(m)),
  );
  assert.ok(
    withSchema(RESULT_SCHEMA_PATH, (draft) => {
      draft.properties.replaces_review = { type: "boolean" };
    }).some((m) => /must not be able to claim it replaces a review/u.test(m)),
  );
  for (const field of ["server_identity", "scanner_identity", "analyzers"]) {
    assert.ok(
      withSchema(RESULT_SCHEMA_PATH, (draft) => {
        draft.properties.provider.required = draft.properties.provider.required.filter((name) => name !== field);
      }).some((m) => new RegExp(`provider identity must include ${field}`, "u").test(m)),
      field,
    );
  }
  for (const field of ["sha256", "produced_from_tree_oid"]) {
    assert.ok(
      withSchema(RESULT_SCHEMA_PATH, (draft) => {
        const items = draft.properties.input_reports.items;
        items.required = items.required.filter((name) => name !== field);
      }).some((m) => new RegExp(`input report must carry ${field}`, "u").test(m)),
      field,
    );
  }
});

test("malformed inputs are refused rather than partially read", () => {
  assert.ok(validateStaticAnalysisDesign({ ...files, [POLICY_SCHEMA_PATH]: "{" }).some((m) => /not valid JSON/u.test(m)));
  assert.ok(
    validateStaticAnalysisDesign({ ...files, [POLICY_EXAMPLE_PATH]: "{" }).some((m) => /not valid JSON/u.test(m)),
  );
  assert.ok(
    validateStaticAnalysisDesign({ ...files, [REFUSED_EXAMPLE_PATH]: "{" }).some((m) => /not valid JSON/u.test(m)),
  );
  assert.ok(
    validateStaticAnalysisDesign({ ...files, [REFUSED_EXAMPLE_PATH]: files[RESULT_EXAMPLE_PATH] }).some((m) =>
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
    staticAnalysisDesignDigest(files),
    staticAnalysisDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` }),
  );
});
