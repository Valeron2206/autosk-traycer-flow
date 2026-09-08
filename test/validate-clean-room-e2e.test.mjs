/**
 * Tests for the issue #36 clean-room fault-matrix validator.
 *
 * A fault group that reports success has proved nothing on its own. Each case
 * here removes one of the four proofs, or one of the coverage guarantees, and
 * checks the matrix stops being acceptable — because a gate that accepts a
 * matrix proving nothing is a gate in name only.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  BOUNDARIES,
  CONTRACT_PATH,
  GATE_FAILING_OUTCOMES,
  MATRIX_PATH,
  PARK_REASONS,
  PROOF_KINDS,
  ROOT,
  SCHEMA_PATH,
  cleanRoomDesignDigest,
  gatePasses,
  loadFiles,
  validateCleanRoomDesign,
  validateMatrix,
} from "../scripts/validate-clean-room-e2e.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

function matrix() {
  return JSON.parse(files[MATRIX_PATH]);
}

function mutated(mutate) {
  const value = matrix();
  mutate(value);
  return value;
}

function assertRejects(value, pattern) {
  const errors = validateMatrix(value, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

test("the shipped design validates", () => {
  assert.deepEqual(validateCleanRoomDesign(files), []);
});

test("the shipped matrix validates", () => {
  assert.deepEqual(validateMatrix(matrix(), schema), []);
});

test("every fault group carries all four proofs", () => {
  // Each rules out a different way of proving nothing: never applied, not
  // observable, not specific, or the room left dirty for the next fault.
  for (const group of matrix().groups) {
    const kinds = group.proofs.map((proof) => proof.kind).sort();
    assert.deepEqual(kinds, [...PROOF_KINDS].sort(), `${group.id} does not carry all four`);
  }
});

test("a group missing any single proof is refused", () => {
  for (const kind of PROOF_KINDS) {
    assertRejects(
      mutated((value) => {
        const group = value.groups[0];
        const remaining = group.proofs.filter((proof) => proof.kind !== kind);
        // Duplicate one of the survivors to keep the count at four, so the
        // schema does not reject the shape first and leave the missing-proof
        // check unobserved.
        group.proofs = [...remaining, { ...remaining[0], note: "duplicated to keep the count" }];
      }),
      new RegExp(`has no ${kind}$`, "u"),
    );
  }
});

test("a group with the same proof twice is refused", () => {
  // The other half of the same rule: four entries that are not four kinds.
  assertRejects(
    mutated((value) => {
      const group = value.groups[0];
      group.proofs = [group.proofs[0], { ...group.proofs[0] }, group.proofs[1], group.proofs[2]];
    }),
    /has 2 application_proof entries/u,
  );
});

test("a proof with no locator proves nothing", () => {
  assertRejects(
    mutated((value) => {
      value.groups[0].proofs[0].locator = "   ";
    }),
    /has no locator, so nothing can be checked against it/u,
  );
});

test("every boundary the flow crosses has a fault group", () => {
  // A boundary with no group is a boundary nobody attacked.
  const covered = new Set(matrix().groups.map((group) => group.boundary));
  for (const boundary of BOUNDARIES) {
    assert.ok(covered.has(boundary), `${boundary} has no fault group`);
  }
  assertRejects(
    mutated((value) => {
      value.groups = value.groups.filter((group) => group.boundary !== "final_cas");
    }),
    /final_cas: no fault group crosses this boundary/u,
  );
});

test("every outcome the gate must refuse is demonstrated by a group", () => {
  // Otherwise the refusal is a rule with nothing behind it.
  const outcomes = new Set(matrix().groups.map((group) => group.expected_gate_outcome));
  for (const outcome of GATE_FAILING_OUTCOMES) {
    assert.ok(outcomes.has(outcome), `${outcome} is not demonstrated`);
  }
  assertRejects(
    mutated((value) => {
      for (const group of value.groups) {
        if (group.expected_gate_outcome === "timeout") group.expected_gate_outcome = "pass";
      }
    }),
    /timeout: the gate must refuse it, and no group demonstrates it/u,
  );
});

test("a passing run is demonstrated too", () => {
  assertRejects(
    mutated((value) => {
      for (const group of value.groups) {
        if (group.expected_gate_outcome === "pass") group.expected_gate_outcome = "timeout";
      }
    }),
    /no group is expected to pass/u,
  );
});

test("the gate refuses exactly the five named outcomes", () => {
  for (const outcome of GATE_FAILING_OUTCOMES) {
    assert.equal(gatePasses(outcome), false, `${outcome} should fail the gate`);
  }
  assert.equal(gatePasses("pass"), true);
  assertRejects(
    mutated((value) => {
      value.gate_failing_outcomes = value.gate_failing_outcomes.filter((entry) => entry !== "indeterminate");
    }),
    /gate_failing_outcomes omits indeterminate/u,
  );
});

test("a duplicate group id is refused", () => {
  assertRejects(
    mutated((value) => {
      value.groups[1].id = value.groups[0].id;
    }),
    /id declared twice/u,
  );
});

test("the matrix covers the restore failure the issue names by hand", () => {
  // "The same branch name with a different ref, tree, blob, mode or task
  // metadata is not a restore" — the proof most easily faked.
  const restore = matrix().groups.find((group) => group.expected_gate_outcome === "restore_failed");
  assert.ok(restore, "no group demonstrates a failed restore");
  assert.match(restore.description, /wrong tree|wrong ref|branch name/u);
});

test("the matrix covers a no-op injector reporting success", () => {
  const noop = matrix().groups.find((group) => group.expected_gate_outcome === "mutation_not_applied");
  assert.ok(noop, "no group demonstrates a mutation that was not applied");
  assert.match(noop.fault, /no-op/u);
});

test("the schema fixes the proof count, so five proofs are not shape-valid", () => {
  const proofs = schema.properties.groups.items.properties.proofs;
  assert.equal(proofs.minItems, 4);
  assert.equal(proofs.maxItems, 4);
});

test("the contract states what the room must not contain", () => {
  // The room is defined by absence as much as by what is installed.
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  for (const absence of [".traycer", "no network", "temporary HOME"]) {
    assert.ok(contract.includes(absence), `the contract does not state "${absence}"`);
  }
});

test("every park reason is documented in the contract", () => {
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  for (const reason of PARK_REASONS) {
    assert.ok(contract.includes(reason), `${reason} is not documented`);
  }
});

test("the design digest changes when any shipped file changes", () => {
  const before = cleanRoomDesignDigest(files);
  const after = cleanRoomDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
