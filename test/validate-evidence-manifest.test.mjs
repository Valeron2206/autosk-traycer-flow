/**
 * Tests for the issue #27 evidence manifest.
 *
 * Three things must be impossible: a durability a producer asserted rather than
 * inherited from its class, a truncated diagnostic that reads as complete, and a
 * harness outcome that was not a product pass being recorded as one.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLASS_DURABILITY,
  CONTRACT_PATH,
  EXAMPLE_PATH,
  NON_PRODUCT_OUTCOMES,
  REFUSALS,
  SCHEMA_PATH,
  TOMBSTONED_EXAMPLE_PATH,
  evidenceDesignDigest,
  loadFiles,
  validateEvidenceManifestDesign,
  validateEvidenceRecord,
} from "../scripts/validate-evidence-manifest.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

const run = () => JSON.parse(files[EXAMPLE_PATH]);
const tombstoned = () => JSON.parse(files[TOMBSTONED_EXAMPLE_PATH]);

function mutated(mutate, base = run) {
  const value = base();
  mutate(value);
  return value;
}

function assertRejects(value, pattern) {
  const errors = validateEvidenceRecord(value, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

test("the shipped design validates", () => {
  assert.deepEqual(validateEvidenceManifestDesign(files), []);
});

test("durability comes from the class, not from the record", () => {
  // Otherwise "this one is durable" becomes something a producer can assert
  // about a class the policy calls transient.
  assertRejects(
    mutated((value) => {
      value.durability = "transient";
    }),
    /evidence_class_durability_conflict/u,
  );
  assertRejects(
    mutated((value) => {
      value.durability = "durable";
      delete value.expires_at;
    }, tombstoned),
    /evidence_class_durability_conflict/u,
  );
});

test("durable evidence has no expiry, and expirable evidence must have one", () => {
  assertRejects(
    mutated((value) => {
      value.expires_at = "2026-10-08T12:00:00.000Z";
    }),
    /durable evidence must not carry an expiry/u,
  );
  assertRejects(
    mutated((value) => {
      delete value.expires_at;
    }, tombstoned),
    /expirable evidence must say when it expires/u,
  );
});

test("evidence something still depends on is not deleted", () => {
  assertRejects(
    mutated((value) => {
      value.dependents = ["9".repeat(64)];
    }, tombstoned),
    /evidence_referenced_deletion/u,
  );
});

test("a tombstone stands for the record it replaced", () => {
  // Evidence may go away; it may not go away silently, and it may not go away
  // pointing at bytes that were never there.
  const stone = tombstoned();
  assert.equal(stone.deletion.sha256, stone.sha256);
  assert.ok(stone.deletion.reason && stone.deletion.at && stone.deletion.actor && stone.deletion.operation_id);
  assertRejects(
    mutated((value) => {
      value.deletion.sha256 = "9".repeat(64);
    }, tombstoned),
    /names a different digest/u,
  );
});

test("a truncated record says it was cut, and by how much", () => {
  // A record cut to fit that does not say so is a diagnostic reading as
  // complete, which is worse than a missing one.
  const cut = tombstoned();
  assert.equal(cut.truncation.state, "truncated");
  assert.ok(cut.truncation.original_size > cut.truncation.policy_limit);
  assertRejects(
    mutated((value) => {
      value.truncation = { state: "truncated", original_size: 10, policy_limit: 100 };
    }, tombstoned),
    /must have been larger than the limit/u,
  );
  assertRejects(
    mutated((value) => {
      value.truncation = { state: "truncated", original_size: 999_999, policy_limit: 10 };
    }, tombstoned),
    /must not exceed the limit it was cut to/u,
  );
});

test("a harness run that carries only its outcome is refused", () => {
  assertRejects(
    mutated((value) => {
      delete value.batch;
    }),
    /must carry its batch proof/u,
  );
});

test("a product pass needs the mutation applied, the killer fired and the controls green", () => {
  assertRejects(
    mutated((value) => {
      value.batch.green_controls = [{ control_id: "suite-unmutated", outcome: "red" }];
    }),
    /every green control to be green/u,
  );
  assertRejects(
    mutated((value) => {
      value.batch.restore = { state: "failed", receipt_sequence: 11 };
    }),
    /cannot stand on a failed restore/u,
  );
});

test("a product pass cannot leave the product mutated", () => {
  assertRejects(
    mutated((value) => {
      value.batch.after_tree = "9".repeat(40);
    }),
    /was not restored to what it was before/u,
  );
});

test("a batch that changed the tree cannot claim no restore was required", () => {
  assertRejects(
    mutated((value) => {
      value.batch.restore = { state: "not_required", receipt_sequence: 1 };
      value.batch.after_tree = "9".repeat(40);
    }),
    /cannot say a restore was not required/u,
  );
});

test("every outcome that is not a product pass can be said", () => {
  // The rule most likely to be violated with good intentions: a harness that
  // could not run is not a product that passed.
  const outcomes = schema.properties.batch.properties.outcome.enum;
  for (const outcome of NON_PRODUCT_OUTCOMES) {
    assert.ok(outcomes.includes(outcome), `${outcome} cannot be expressed`);
    const record = mutated((value) => {
      value.batch.outcome = outcome;
    });
    // Expressible and not silently upgraded: the pass-only checks do not run.
    assert.deepEqual(validateEvidenceRecord(record, schema), []);
  }
});

test("a failed restore forbids ordinary cleanup", () => {
  assertRejects(
    mutated((value) => {
      value.batch.outcome = "restore_failed";
      value.batch.restore = { state: "failed", receipt_sequence: 11 };
      value.deletion = {
        state: "tombstoned", sha256: value.sha256, reason: "expired",
        at: "2026-10-08T12:00:00.000Z", actor: "daemon", operation_id: "cleanup-1",
      };
      value.dependents = [];
    }),
    /evidence_restore_unverified/u,
  );
});

test("ephemeral state is not cleaned up before the restore is verified", () => {
  assertRejects(
    mutated((value) => {
      value.batch.restore = { state: "not_required", receipt_sequence: 1 };
      value.deletion = {
        state: "tombstoned", sha256: value.sha256, reason: "expired",
        at: "2026-10-08T12:00:00.000Z", actor: "daemon", operation_id: "cleanup-1",
      };
      value.dependents = [];
    }),
    /before the restore was verified/u,
  );
});

test("a record stored under another project is a cross-project path", () => {
  assertRejects(
    mutated((value) => {
      value.storage.owner_project_identity = `sha256:${"9".repeat(64)}`;
    }),
    /evidence_cross_project_path/u,
  );
});

test("retention is pinned per Epic and carries the decision that set it", () => {
  // A shorter retention must not be applied to evidence produced under a longer
  // one, and the only way to notice is for the record to say which decision it
  // was written under.
  const record = run();
  assert.ok(/^[0-9a-f]{64}$/u.test(record.retention_pin.epic_policy_digest));
  assert.ok(record.retention_pin.decision_version >= 1);
  assert.ok(schema.required.includes("retention_pin"));
  const contract = files[CONTRACT_PATH];
  assert.ok(contract.includes("Changing it requires a versioned decision"));
});

test("every class is documented and every refusal is named", () => {
  const contract = files[CONTRACT_PATH];
  for (const klass of Object.keys(CLASS_DURABILITY)) {
    assert.ok(contract.includes(klass), `${klass} is not documented`);
  }
  for (const refusal of REFUSALS) assert.ok(contract.includes(refusal), `${refusal} is not documented`);
});

test("the design digest changes when any shipped file changes", () => {
  const before = evidenceDesignDigest(files);
  const after = evidenceDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
