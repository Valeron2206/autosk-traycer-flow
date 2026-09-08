/**
 * Tests for the issue #33 changeset walkthrough.
 *
 * The whole value of a walkthrough is that a person believes it without
 * re-deriving it, which is also why a confident sentence with a wrong commit id
 * does the most damage here. These check consent, staleness, the fact
 * validation and what may never be counted as done.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ABSOLUTE_PATH_PREFIXES,
  CONTRACT_MARKER,
  CONTRACT_PATH,
  EXAMPLE_PATH,
  REFUSALS,
  REFUSED_EXAMPLE_PATH,
  RISK_ORDER,
  SCHEMA_PATH,
  loadFiles,
  readableStrings,
  semanticDigest,
  validateWalkthrough,
  validateWalkthroughDesign,
  walkthroughDesignDigest,
} from "../scripts/validate-walkthrough.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

const walkthrough = () => JSON.parse(files[EXAMPLE_PATH]);
const refusedWalkthrough = () => JSON.parse(files[REFUSED_EXAMPLE_PATH]);

/** Re-seal both digests so only the intended defect is under test. */
function reseal(value) {
  value.semantic_digest = semanticDigest(value);
  if (value.staging.target_oid) value.staging.semantic_digest_before_binding = value.semantic_digest;
  return value;
}

function mutated(mutate, { reseal: doReseal = true } = {}) {
  const value = walkthrough();
  mutate(value);
  return doReseal ? reseal(value) : value;
}

function assertRefuses(value, pattern) {
  const errors = validateWalkthrough(value, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

test("the shipped design validates", () => {
  assert.deepEqual(validateWalkthroughDesign(files), []);
});

test("the worked walkthrough validates", () => {
  assert.deepEqual(validateWalkthrough(walkthrough(), schema), []);
});

test("a walkthrough exists only with consent", () => {
  // Drift in an explanation is worse than absence, because a reader trusts it.
  for (const state of ["declined", "not_offered", "generated_without_consent"]) {
    assertRefuses(
      mutated((value) => {
        value.consent.state = state;
      }),
      new RegExp(`walkthrough_without_consent: consent is ${state}`, "u"),
    );
  }
});

test("declining blocks nothing and the artifact records no PASS", () => {
  assertRefuses(
    mutated((value) => {
      value.blocks_epic_when_declined = true;
    }),
    /walkthrough_decline_blocked/u,
  );
  assert.equal(schema.properties.creates_pass.const, false);
  const errors = validateWalkthrough(
    mutated((value) => {
      value.creates_pass = true;
    }),
    { type: "object" },
  );
  assert.ok(errors.some((message) => /walkthrough_creates_pass/u.test(message)));
});

test("the artifact names the staging commit it explains", () => {
  assertRefuses(
    mutated((value) => {
      value.walkthrough_id = "wt-" + "9".repeat(40);
    }),
    /walkthrough_not_bound_to_staging/u,
  );
});

test("a semantic change to staging makes it stale", () => {
  // An explanation of a tree that no longer exists reads exactly like an
  // explanation of the tree that does.
  assertRefuses(
    mutated((value) => {
      value.staging.current_tree_oid = "7".repeat(40);
    }),
    /walkthrough_stale: staged/u,
  );
});

test("binding the final target may not change a semantic claim", () => {
  // Adding the target identity is bookkeeping; changing what the document says
  // is not.
  assertRefuses(
    mutated(
      (value) => {
        value.areas[0].summary = "a different account of the same change";
        value.semantic_digest = semanticDigest(value);
      },
      { reseal: false },
    ),
    /walkthrough_claims_changed_by_binding/u,
  );
  // ...and without a target bound, there is nothing to compare against.
  const unbound = mutated((value) => {
    delete value.staging.target_oid;
    delete value.staging.target_bound_at;
    delete value.staging.semantic_digest_before_binding;
    value.areas[0].summary = "a different account of the same change";
  });
  assert.deepEqual(validateWalkthrough(unbound, schema), []);
});

test("the semantic digest recomputes from what the document says", () => {
  assertRefuses(
    mutated(
      (value) => {
        value.links.debt.push("one more thing to fix later");
      },
      { reseal: false },
    ),
    /the semantic digest does not recompute/u,
  );
});

test("mechanical detail is read last", () => {
  assertRefuses(
    mutated((value) => {
      value.areas = [value.areas[3], ...value.areas.slice(0, 3)];
    }),
    /walkthrough_order_not_risk_based: transcript-reads \(correctness\) is read after mechanical detail/u,
  );
  // The four risk kinds are not ranked against each other: any order among them
  // is allowed, because which to read first depends on the change.
  const reordered = mutated((value) => {
    value.areas = [value.areas[2], value.areas[1], value.areas[0], value.areas[3]];
  });
  assert.deepEqual(validateWalkthrough(reordered, schema), []);
  assert.deepEqual(schema.properties.areas.items.properties.risk.enum, [...RISK_ORDER]);
});

test("performed and remaining checks stay separate", () => {
  // The two lists answer different questions, and merging them loses the
  // second.
  assertRefuses(
    mutated((value) => {
      value.checks.remaining[0].evidence_ref = "evidence/epic-store-lock/T-102/daemon.json";
    }),
    /walkthrough_checks_not_separated/u,
  );
});

test("a performed check cites the staged tree, not another one", () => {
  assertRefuses(
    mutated((value) => {
      value.checks.performed[0].at_tree_oid = "8".repeat(40);
    }),
    /a performed check cites tree 8{40}, not the staged one/u,
  );
});

test("every fact is checked against the canonical record", () => {
  for (const [index, kind] of [
    [0, "oid"],
    [2, "ticket"],
    [3, "command"],
    [4, "evidence_link"],
    [5, "status"],
  ]) {
    assertRefuses(
      mutated((value) => {
        value.facts[index].claimed = "something the records do not say";
      }),
      new RegExp(`walkthrough_fact_mismatch: ${kind} something the records do not say`, "u"),
    );
  }
  assertRefuses(
    mutated((value) => {
      value.facts[1].canonical = null;
      value.facts[1].matches = false;
    }),
    /walkthrough_fact_mismatch: oid/u,
  );
});

test("a failed fact check keeps the artifact from being current", () => {
  assertRefuses(
    mutated((value) => {
      value.facts[1].matches = false;
    }),
    /walkthrough_published_with_mismatch/u,
  );
  const withheld = mutated((value) => {
    value.facts[1].matches = false;
    value.publication = "withheld";
  });
  assert.ok(
    !validateWalkthrough(withheld, schema).some((message) => /published_with_mismatch/u.test(message)),
  );
});

test("no absolute user path appears anywhere in the document", () => {
  // The leak that survives review: it looks like context rather than data, and
  // it carries a username.
  for (const prefix of ABSOLUTE_PATH_PREFIXES) {
    assertRefuses(
      mutated((value) => {
        value.links.rollback_notes = `see ${prefix}someone/notes.md for the operator steps`;
      }),
      /walkthrough_absolute_path/u,
    );
  }
  // ...and the scan reaches nested strings, not only the top level.
  assert.ok(readableStrings(walkthrough()).includes("T-102"));
  assertRefuses(
    mutated((value) => {
      value.areas[0].gotchas.push("reproduced under /Users/someone/tmp");
    }),
    /walkthrough_absolute_path: \/Users\//u,
  );
});

test("the refused walkthrough is refused, and names more than one thing", () => {
  const findings = validateWalkthrough(refusedWalkthrough(), schema);
  assert.ok(findings.length >= 6, findings.join("\n"));
  for (const pattern of [
    /walkthrough_without_consent/u,
    /walkthrough_not_bound_to_staging/u,
    /walkthrough_stale/u,
    /walkthrough_claims_changed_by_binding/u,
    /walkthrough_order_not_risk_based/u,
    /walkthrough_checks_not_separated/u,
    /walkthrough_fact_mismatch/u,
    /walkthrough_published_with_mismatch/u,
    /walkthrough_absolute_path/u,
    /walkthrough_decline_blocked/u,
  ]) {
    assert.ok(findings.some((message) => pattern.test(message)), `${pattern} was not found`);
  }
});

test("the design checks fail when the shipped design stops satisfying them", () => {
  const broken = (path, transform) => validateWalkthroughDesign({ ...files, [path]: transform(files[path]) });
  assert.ok(broken(CONTRACT_PATH, (text) => text.replace(CONTRACT_MARKER, "")).some((m) => /missing <!--/u.test(m)));
  assert.ok(
    broken(CONTRACT_PATH, (text) => text.replaceAll(SCHEMA_PATH, "elsewhere.json")).some((m) =>
      /does not point at/u.test(m),
    ),
  );
  assert.ok(
    broken(CONTRACT_PATH, (text) => text.replaceAll("walkthrough_stale", "stale")).some((m) =>
      /refusal walkthrough_stale is not documented/u.test(m),
    ),
  );
  for (const [sentence, expected] of [
    ["explanatory and never behavior-defining", /what a walkthrough is not/u],
    ["drift in an explanation is worse than absence", /offered rather than produced/u],
    ["risk-based, not alphabetical", /how the review order is chosen/u],
    ["believes it without re-deriving it", /why facts are validated deterministically/u],
    ["walkthroughs/<final-staging-oid>.md", /where the artifact lives/u],
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
    return validateWalkthroughDesign({ ...files, [SCHEMA_PATH]: JSON.stringify(draft) });
  };
  assert.ok(
    withSchema((draft) => {
      draft.additionalProperties = true;
    }).some((m) => /root must be closed/u.test(m)),
  );
  assert.ok(
    withSchema((draft) => {
      draft.properties.creates_pass = { type: "boolean" };
    }).some((m) => /must not be able to record a PASS/u.test(m)),
  );
  assert.ok(
    withSchema((draft) => {
      draft.properties.areas.items.properties.risk.enum = ["mechanical", "product"];
    }).some((m) => /risk ranks must match/u.test(m)),
  );
  for (const field of ["performed", "remaining"]) {
    assert.ok(
      withSchema((draft) => {
        draft.properties.checks.required = draft.properties.checks.required.filter((name) => name !== field);
      }).some((m) => new RegExp(`${field} checks must be their own list`, "u").test(m)),
      field,
    );
  }
  for (const field of ["evidence_ref", "at_tree_oid"]) {
    assert.ok(
      withSchema((draft) => {
        const performed = draft.properties.checks.properties.performed.items;
        performed.required = performed.required.filter((name) => name !== field);
      }).some((m) => new RegExp(`performed check must name ${field}`, "u").test(m)),
      field,
    );
  }
  assert.ok(
    withSchema((draft) => {
      draft.required = draft.required.filter((field) => field !== "consent");
    }).some((m) => /consent must be recorded/u.test(m)),
  );
});

test("malformed inputs are refused rather than partially read", () => {
  assert.ok(validateWalkthroughDesign({ ...files, [SCHEMA_PATH]: "{" }).some((m) => /not valid JSON/u.test(m)));
  assert.ok(
    validateWalkthroughDesign({ ...files, [REFUSED_EXAMPLE_PATH]: "{" }).some((m) => /not valid JSON/u.test(m)),
  );
  assert.ok(
    validateWalkthroughDesign({ ...files, [REFUSED_EXAMPLE_PATH]: files[EXAMPLE_PATH] }).some((m) =>
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
    walkthroughDesignDigest(files),
    walkthroughDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` }),
  );
});
