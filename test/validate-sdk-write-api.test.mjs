/**
 * Tests for the issue #38 typed SDK write API.
 *
 * The defect is not that the CLI is slow. It is that a crash after the daemon
 * committed but before the CLI answered leaves an outcome nobody can name — so
 * most of these are about the two things that remove that ambiguity: a revision
 * the caller expected, and an idempotency key the daemon recognises.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_MARKER,
  CONTRACT_PATH,
  ERROR_CODES,
  OPERATION_EXAMPLE_PATH,
  OPERATION_SCHEMA_PATH,
  REFUSALS,
  REFUSED_EXAMPLE_PATH,
  TOKEN_EXAMPLE_PATH,
  TOKEN_SCHEMA_PATH,
  VERBS,
  loadFiles,
  sdkDesignDigest,
  validateOperation,
  validateSdkDesign,
  validateToken,
} from "../scripts/validate-sdk-write-api.mjs";

const files = loadFiles();
const tokenSchema = JSON.parse(files[TOKEN_SCHEMA_PATH]);
const operationSchema = JSON.parse(files[OPERATION_SCHEMA_PATH]);

const token = () => JSON.parse(files[TOKEN_EXAMPLE_PATH]);
const operation = () => JSON.parse(files[OPERATION_EXAMPLE_PATH]);
const refusedOperation = () => JSON.parse(files[REFUSED_EXAMPLE_PATH]);

function mutatedToken(mutate) {
  const value = token();
  mutate(value);
  return value;
}

function mutatedOperation(mutate) {
  const value = operation();
  mutate(value);
  return value;
}

function assertTokenRefuses(value, pattern, options) {
  const errors = validateToken(value, tokenSchema, options);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

function assertRefuses(value, pattern, withToken = token(), options) {
  const errors = validateOperation(value, withToken, operationSchema, options);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

test("the shipped design validates", () => {
  assert.deepEqual(validateSdkDesign(files), []);
});

test("the worked token and operation validate", () => {
  assert.deepEqual(validateToken(token(), tokenSchema), []);
  assert.deepEqual(validateOperation(operation(), token(), operationSchema), []);
});

test("a model process never holds a write capability", () => {
  // Absent, not forbidden: one that could mint writes could mint them for
  // anything the token allows.
  assertTokenRefuses(
    mutatedToken((value) => {
      value.holder.kind = "model_process";
    }),
    /sdk_model_capability/u,
  );
});

test("there is no generic mutation, in the verb set or the field set", () => {
  // An arbitrary-patch endpoint makes every other guarantee conditional on
  // nobody using it.
  // The field pattern already excludes a wildcard, so the guard is reached
  // directly rather than through the shipped schema.
  const withWildcard = mutatedToken((value) => {
    value.fields.push("metadata.*");
  });
  assert.ok(
    validateToken(withWildcard, { type: "object" }).some((message) =>
      /sdk_generic_mutation: the field set contains the wildcard/u.test(message),
    ),
  );
  assert.ok(
    validateToken(withWildcard, tokenSchema).some((message) => /does not match pattern/u.test(message)),
    "the schema should reject a wildcard field on its own",
  );
  // The enum stops this in the shipped path, so the guard is reached directly:
  // `validateToken` is exported, and a caller may arrive with a looser schema.
  const withExtraVerb = mutatedToken((value) => {
    value.verbs = [...value.verbs, "patch_json"];
  });
  assert.ok(
    validateToken(withExtraVerb, { type: "object" }).some((message) =>
      /sdk_generic_mutation: patch_json is not a primitive/u.test(message),
    ),
  );
  assert.deepEqual(tokenSchema.properties.verbs.items.enum, [...VERBS]);
});

test("a capability expires and can be revoked", () => {
  for (const state of ["expired", "revoked"]) {
    assertTokenRefuses(
      mutatedToken((value) => {
        value.state = state;
      }),
      new RegExp(`sdk_capability_${state}`, "u"),
    );
    assertRefuses(
      operation(),
      new RegExp(`sdk_capability_${state}: the token is ${state}`, "u"),
      mutatedToken((value) => {
        value.state = state;
      }),
    );
  }
  assertTokenRefuses(
    token(),
    /past its expiry and still recorded active/u,
    { nowMs: 4102444800001 },
  );
  assertRefuses(operation(), /had expired when the write was attempted/u, token(), { nowMs: 4102444800001 });
});

test("a capability cannot reach another project or another task", () => {
  assertRefuses(
    mutatedOperation((value) => {
      value.project_identity = "9".repeat(64);
    }),
    /sdk_cross_project/u,
  );
  assertRefuses(
    mutatedOperation((value) => {
      value.task_id = "T-999";
    }),
    /sdk_scope_violation: T-999 is outside the token's task/u,
  );
  assertRefuses(
    mutatedOperation((value) => {
      value.token_id = "cap-someone-else";
    }),
    /sdk_scope_violation: the operation cites cap-someone-else/u,
  );
});

test("a write outside the token's verbs or fields is denied", () => {
  assertRefuses(
    mutatedOperation((value) => {
      value.writes[0].verb = "transition";
    }),
    /sdk_scope_violation: transition is not among the token's verbs/u,
  );
  assertRefuses(
    mutatedOperation((value) => {
      value.writes[0].fields.push("metadata.secret_notes");
    }),
    /sdk_scope_violation: metadata.secret_notes is outside the token's field set/u,
  );
});

test("a metadata update is revision-aware, and a mismatch is never a silent overwrite", () => {
  assertRefuses(
    mutatedOperation((value) => {
      delete value.writes[0].expected_revision;
    }),
    /a metadata update carries the revision it expected/u,
  );
  assertRefuses(
    mutatedOperation((value) => {
      value.writes[0].observed_revision = 17;
    }),
    /sdk_revision_conflict: expected 14, observed 17/u,
  );
  // A conflict that was NOT applied is the correct outcome, not an error.
  const conflicted = mutatedOperation((value) => {
    value.writes[0].observed_revision = 17;
    for (const write of value.writes) write.applied = false;
    value.outcome = { state: "conflict", error_code: "revision_conflict", conflicting_identity: "T-102@rev-17" };
  });
  assert.deepEqual(validateOperation(conflicted, token(), operationSchema), []);
});

test("metadata that failed daemon-side validation is not applied", () => {
  assertRefuses(
    mutatedOperation((value) => {
      value.writes[0].metadata_valid = false;
    }),
    /sdk_metadata_schema_invalid/u,
  );
});

test("a create carries its creation key and binding hash", () => {
  assertRefuses(
    mutatedOperation((value) => {
      value.writes[1] = { verb: "create_task", fields: ["blockers"], applied: true };
      value.token_id = value.token_id;
    }),
    /a create carries its creation key and binding hash/u,
    mutatedToken((value) => {
      value.verbs.push("create_task");
    }),
  );
});

test("a transaction applies wholly or not at all", () => {
  // A partial batch is worse than a failed one: the caller's next decision is
  // based on a state that matches neither branch.
  assertRefuses(
    mutatedOperation((value) => {
      value.writes[1].applied = false;
    }),
    /sdk_transaction_partial: 1 of 2 writes applied/u,
  );
  const abortedWholly = mutatedOperation((value) => {
    for (const write of value.writes) write.applied = false;
    value.outcome = { state: "aborted", error_code: "transaction_aborted" };
  });
  assert.deepEqual(validateOperation(abortedWholly, token(), operationSchema), []);
  // A non-atomic operation may legitimately apply part of its writes.
  const nonAtomic = mutatedOperation((value) => {
    value.atomic = false;
    value.writes[1].applied = false;
  });
  assert.deepEqual(validateOperation(nonAtomic, token(), operationSchema), []);
});

test("a retry under the same key performs no second effect", () => {
  // A lost response is indistinguishable from a failure at the caller, so the
  // only safe retry is one the daemon can recognise.
  const replay = mutatedOperation((value) => {
    value.operation_id = "wop-0011-retry";
    value.replay_of = "wop-0011";
    for (const write of value.writes) write.applied = false;
    value.outcome = { state: "replayed" };
  });
  assert.deepEqual(validateOperation(replay, token(), operationSchema), []);
  assertRefuses(
    mutatedOperation((value) => {
      value.outcome = { state: "replayed" };
      value.replay_of = "wop-0011";
    }),
    /a replay applied a second effect/u,
  );
  assertRefuses(
    mutatedOperation((value) => {
      value.outcome = { state: "replayed" };
      for (const write of value.writes) write.applied = false;
    }),
    /a replay names the operation it repeats/u,
  );
});

test("every non-applied outcome carries a machine code", () => {
  // A caller that has to match on message text breaks when the message
  // improves.
  for (const state of ["conflict", "denied", "aborted", "unavailable"]) {
    assertRefuses(
      mutatedOperation((value) => {
        for (const write of value.writes) write.applied = false;
        value.outcome = { state };
      }),
      new RegExp(`sdk_error_code_missing: ${state} carries no machine code`, "u"),
    );
  }
  assertRefuses(
    mutatedOperation((value) => {
      for (const write of value.writes) write.applied = false;
      value.outcome = { state: "conflict", error_code: "revision_conflict" };
    }),
    /a conflict names what it conflicts with/u,
  );
  assert.deepEqual(operationSchema.properties.outcome.properties.error_code.enum, [...ERROR_CODES]);
});

test("the refused operation is refused, and names more than one thing", () => {
  const findings = validateOperation(refusedOperation(), token(), operationSchema);
  assert.ok(findings.length >= 6, findings.join("\n"));
  for (const pattern of [
    /sdk_cross_project/u,
    /sdk_scope_violation/u,
    /sdk_revision_conflict/u,
    /sdk_metadata_schema_invalid/u,
    /sdk_transaction_partial/u,
    /sdk_error_code_missing/u,
  ]) {
    assert.ok(findings.some((message) => pattern.test(message)), `${pattern} was not found`);
  }
});

test("the design checks fail when the shipped design stops satisfying them", () => {
  const broken = (path, transform) => validateSdkDesign({ ...files, [path]: transform(files[path]) });
  assert.ok(broken(CONTRACT_PATH, (text) => text.replace(CONTRACT_MARKER, "")).some((m) => /missing <!--/u.test(m)));
  for (const schemaPath of [TOKEN_SCHEMA_PATH, OPERATION_SCHEMA_PATH]) {
    assert.ok(
      broken(CONTRACT_PATH, (text) => text.replaceAll(schemaPath, "elsewhere.json")).some((m) =>
        /does not point at/u.test(m),
      ),
    );
  }
  assert.ok(
    broken(CONTRACT_PATH, (text) => text.replaceAll("sdk_transaction_partial", "partial")).some((m) =>
      /refusal sdk_transaction_partial is not documented/u.test(m),
    ),
  );
  assert.ok(
    broken(CONTRACT_PATH, (text) => text.replaceAll("precondition_failed", "precondition")).some((m) =>
      /error code precondition_failed is not documented/u.test(m),
    ),
  );
  for (const [sentence, expected] of [
    ["leaves an outcome nobody can name", /the defect the typed API closes/u],
    ["No generic JSON mutation is offered", /no arbitrary patch endpoint/u],
    ["never to model tools", /who may hold a capability/u],
    ["over the same API", /what happens to the CLI/u],
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
    return validateSdkDesign({ ...files, [relative]: JSON.stringify(draft) });
  };
  for (const relative of [TOKEN_SCHEMA_PATH, OPERATION_SCHEMA_PATH]) {
    assert.ok(
      withSchema(relative, (draft) => {
        draft.additionalProperties = true;
      }).some((m) => /root must be closed/u.test(m)),
      relative,
    );
  }
  assert.ok(
    withSchema(TOKEN_SCHEMA_PATH, (draft) => {
      draft.properties.verbs.items.enum = [...VERBS, "patch_json"];
    }).some((m) => /verb set must be exactly the primitives/u.test(m)),
  );
  assert.ok(
    withSchema(OPERATION_SCHEMA_PATH, (draft) => {
      draft.properties.writes.items.properties.verb.enum = [...VERBS, "patch_json"];
    }).some((m) => /verb set must be exactly the primitives/u.test(m)),
  );
  assert.ok(
    withSchema(OPERATION_SCHEMA_PATH, (draft) => {
      draft.properties.outcome.properties.error_code.enum = ERROR_CODES.slice(0, 3);
    }).some((m) => /machine error codes must match/u.test(m)),
  );
  for (const field of ["idempotency_key", "provenance", "token_id"]) {
    assert.ok(
      withSchema(OPERATION_SCHEMA_PATH, (draft) => {
        draft.required = draft.required.filter((name) => name !== field);
      }).some((m) => new RegExp(`${field} must be required`, "u").test(m)),
      field,
    );
  }
  assert.ok(
    withSchema(TOKEN_SCHEMA_PATH, (draft) => {
      draft.properties.fields.minItems = 0;
    }).some((m) => /never an empty or open set/u.test(m)),
  );
});

test("malformed inputs are refused rather than partially read", () => {
  assert.ok(validateSdkDesign({ ...files, [TOKEN_SCHEMA_PATH]: "{" }).some((m) => /not valid JSON/u.test(m)));
  assert.ok(validateSdkDesign({ ...files, [TOKEN_EXAMPLE_PATH]: "{" }).some((m) => /not valid JSON/u.test(m)));
  assert.ok(validateSdkDesign({ ...files, [REFUSED_EXAMPLE_PATH]: "{" }).some((m) => /not valid JSON/u.test(m)));
  assert.ok(
    validateSdkDesign({ ...files, [REFUSED_EXAMPLE_PATH]: files[OPERATION_EXAMPLE_PATH] }).some((m) =>
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
    sdkDesignDigest(files),
    sdkDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` }),
  );
});
