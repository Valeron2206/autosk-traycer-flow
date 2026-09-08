/**
 * Tests for the issue #22 artifact write receipt.
 *
 * Two things must be impossible, and they are the two ways a receipt quietly
 * stops being evidence: a phase asserted rather than earned, and a receipt that
 * has drifted into being a second task-status ledger. Most cases here are one of
 * those two.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_PATH,
  EXAMPLE_PATH,
  QUARANTINED_EXAMPLE_PATH,
  RECONCILIATION_SOURCES,
  REFUSALS,
  SCHEMA_PATH,
  computePhase,
  loadFiles,
  receiptDesignDigest,
  validateArtifactWriteReceiptDesign,
  validateReceipt,
} from "../scripts/validate-artifact-write-receipt.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

function example() {
  return JSON.parse(files[EXAMPLE_PATH]);
}

function quarantined() {
  return JSON.parse(files[QUARANTINED_EXAMPLE_PATH]);
}

function mutated(mutate, base = example) {
  const value = base();
  mutate(value);
  return value;
}

function assertRejects(value, pattern) {
  const errors = validateReceipt(value, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

test("the shipped design validates", () => {
  assert.deepEqual(validateArtifactWriteReceiptDesign(files), []);
});

test("a read-back that does not match the intent is not verified", () => {
  // The case the receipt exists for. Asserting `verified` here would report the
  // exact failure it was built to catch as a success.
  const drifted = mutated((value) => {
    value.observed_sha256 = "9".repeat(64);
  });
  assert.equal(computePhase(drifted), "pending");
  assertRejects(drifted, /phase is verified, computed pending/u);
});

test("a size that does not match the intent is not verified either", () => {
  // A file with the right digest and the wrong length cannot exist, so this
  // catches a receipt that recorded one of the two and guessed the other.
  const drifted = mutated((value) => {
    value.observed_size = value.intended_size + 1;
  });
  assert.equal(computePhase(drifted), "pending");
});

test("a write with nothing observed yet is pending, not verified", () => {
  const pending = mutated((value) => {
    delete value.observed_sha256;
    delete value.observed_size;
    delete value.observed_mode;
    value.phase = "pending";
  });
  assert.equal(computePhase(pending), "pending");
  assert.deepEqual(validateReceipt(pending, schema), []);
});

test("a divergence is never verified, however good the bytes look", () => {
  // Reconciliation is not a formality: the bytes can be exactly right while the
  // task metadata says something else, and that disagreement is the finding.
  const diverged = mutated((value) => {
    value.reconciliation = {
      state: "diverged",
      report: {
        canonical_bytes: "matches the intent",
        task_metadata: "records a different artifact",
        receipt: "verified read-back",
        model_output: "retained",
      },
    };
  });
  assert.equal(computePhase(diverged), "pending");
});

test("a divergence report must name all four sources, including the ones that agreed", () => {
  // A report listing only the odd source out cannot be checked by a reader who
  // does not already know the answer. Found by what the branch says, not by
  // where it sits: this set has already grown once.
  const diverged = schema.properties.reconciliation.oneOf.find(
    (branch) => branch.properties.state.const === "diverged",
  );
  const report = diverged.properties.report;
  assert.deepEqual(Object.keys(report.properties).sort(), [...RECONCILIATION_SOURCES].sort());
  assert.deepEqual(report.required.slice().sort(), [...RECONCILIATION_SOURCES].sort());
  assert.equal(report.additionalProperties, false);
});

test("a held artifact is quarantined whatever its bytes say", () => {
  assert.equal(computePhase(quarantined()), "quarantined");
  assert.deepEqual(validateReceipt(quarantined(), schema), []);
});

test("an oversized write that is not quarantined is refused", () => {
  assertRejects(
    mutated((value) => {
      value.intended_size = value.policy.max_bytes + 1;
    }),
    /exceeds the pinned policy but the receipt is not quarantined/u,
  );
});

test("a mode outside the pinned policy is refused", () => {
  assertRejects(
    mutated((value) => {
      value.observed_mode = 511;
    }),
    /is not in the pinned policy/u,
  );
});

test("a write whose expected previous bytes are the intended ones changes nothing", () => {
  assertRejects(
    mutated((value) => {
      value.expected_previous = { state: "file", sha256: value.intended_sha256, mode: 420 };
    }),
    /this write changes nothing/u,
  );
});

test("a destination that escapes the project is not even shape-valid", () => {
  for (const destination of ["/etc/passwd", "../outside.md", "docs/../../outside.md", "a/../../b"]) {
    const escaping = mutated((value) => {
      value.destination = destination;
    });
    assert.ok(
      validateReceipt(escaping, schema).some((message) => /schema:/u.test(message)),
      `${destination} was accepted as a destination`,
    );
  }
});

test("a receipt carries no task status, and the schema is what says so", () => {
  // Criterion 6 of #22. Checked against the schema rather than the examples: an
  // example without a field says nothing about the next receipt.
  for (const field of ["status", "task_status", "step", "workflow_position", "task_id"]) {
    assert.ok(!(field in schema.properties), `the schema admits ${field}`);
  }
  assert.equal(schema.additionalProperties, false);
});

test("the refusal set is closed and matches the contract", () => {
  assert.deepEqual(schema.properties.refusal.enum, [...REFUSALS]);
  const contract = files[CONTRACT_PATH];
  for (const refusal of REFUSALS) assert.ok(contract.includes(refusal), `${refusal} is not documented`);
});

test("quarantine keeps the source and asks a human", () => {
  const held = quarantined();
  assert.equal(held.quarantine.state, "held");
  // A quarantine path that could be mistaken for the artifact would defeat it.
  assert.notEqual(held.quarantine.path, held.destination);
  assert.equal(held.quarantine.disposition, "pending");
  const contract = files[CONTRACT_PATH];
  for (const disposition of ["inspect", "transform", "reject", "restore"]) {
    assert.ok(contract.includes(disposition), `${disposition} is not documented`);
  }
  assert.ok(contract.includes("the source is not destroyed"));
});

test("a receipt names the code that wrote the file", () => {
  // #10 and #13: a receipt that cannot say which extension, shape and store
  // helper produced a file proves less than it appears to.
  const identity = schema.properties.runtime_identity;
  assert.deepEqual(identity.required.slice().sort(), ["digest", "graph", "helper", "workflow"]);
  assert.equal(identity.additionalProperties, false);
});

test("the design digest changes when any shipped file changes", () => {
  const before = receiptDesignDigest(files);
  const after = receiptDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});

test("a receipt that has not been reconciled says so, and is not verified", () => {
  // The two-state shape this contract shipped with had no way to say "not
  // compared yet", which would have forced a freshly written receipt to claim
  // `agreed` — a comparison nobody had made.
  const states = schema.properties.reconciliation.oneOf.map((branch) => branch.properties.state.const);
  assert.deepEqual(states.slice().sort(), ["agreed", "diverged", "unreconciled"]);

  const fresh = mutated((value) => {
    value.reconciliation = { state: "unreconciled" };
    value.phase = "pending";
  });
  assert.equal(computePhase(fresh), "pending");
  assert.deepEqual(validateReceipt(fresh, schema), []);
});
