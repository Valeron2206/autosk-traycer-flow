/**
 * Tests for the issue #7 execution-base validator.
 *
 * The failure the contract closes is that a dependency edge schedules work
 * without carrying the predecessor's code, so a Ticket is implemented against a
 * tree the plan does not describe. Each case here is a way a recorded base could
 * fail to be the base it claims to be.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CONTRACT_PATH,
  EXAMPLE_PATH,
  PARK_REASONS,
  ROOT,
  ROOT_EXAMPLE_PATH,
  SCHEMA_PATH,
  baseDigest,
  executionBaseDesignDigest,
  loadFiles,
  validateBase,
  validateExecutionBaseDesign,
} from "../scripts/validate-execution-base.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

function example(which = EXAMPLE_PATH) {
  return JSON.parse(files[which]);
}

function mutated(mutate, { which = EXAMPLE_PATH, reseal = true } = {}) {
  const value = example(which);
  mutate(value);
  if (reseal) value.digest = baseDigest(value);
  return value;
}

function assertRejects(value, pattern) {
  const errors = validateBase(value, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

test("the shipped design validates", () => {
  assert.deepEqual(validateExecutionBaseDesign(files), []);
});

test("both examples validate and their digests recompute", () => {
  for (const which of [EXAMPLE_PATH, ROOT_EXAMPLE_PATH]) {
    const value = example(which);
    assert.deepEqual(validateBase(value, schema), []);
    assert.equal(value.digest, baseDigest(value));
  }
});

test("composition order is part of identity, not sorted away", () => {
  // Unlike the set-valued fields in the other contracts here. A diamond applied
  // in two orders can produce two trees, so two orders are two bases — a digest
  // that hid that would claim a determinism the composition does not have.
  const before = baseDigest(example());
  const after = baseDigest(
    mutated(
      (value) => {
        value.composition_order = ["T02", "T01", "T03"];
      },
      { reseal: false },
    ),
  );
  assert.notEqual(before, after);
});

test("the same order gives the same base, so a retry reproduces it", () => {
  assert.equal(baseDigest(example()), baseDigest(example()));
});

test("a predecessor with a binding must appear in the composition order", () => {
  // Otherwise its approved code is silently left out of the tree the implementer
  // is given, which is the original defect wearing different clothes.
  assertRejects(
    mutated((value) => {
      value.composition_order = ["T01", "T02"];
    }),
    /T03: has a binding but is not in composition_order/u,
  );
});

test("the composition order may not name a Ticket with no binding", () => {
  assertRejects(
    mutated((value) => {
      value.composition_order = ["T01", "T02", "T03", "T09"];
    }),
    /T09: is in composition_order but has no predecessor binding/u,
  );
});

test("a Ticket cannot be its own predecessor", () => {
  assertRejects(
    mutated((value) => {
      value.predecessors[0].ticket_id = "T04";
      value.composition_order = ["T04", "T02", "T03"];
    }),
    /is its own predecessor/u,
  );
});

test("a predecessor declared twice is refused", () => {
  assertRejects(
    mutated((value) => {
      value.predecessors[1].ticket_id = "T01";
      value.composition_order = ["T01", "T01", "T03"];
    }),
    /declared as a predecessor twice/u,
  );
});

test("a Ticket with no dependencies is based on planning_head itself", () => {
  assertRejects(
    mutated(
      (value) => {
        value.tree_oid = "9".repeat(40);
      },
      { which: ROOT_EXAMPLE_PATH },
    ),
    /must be based on planning_head itself/u,
  );
});

test("a Ticket with no dependencies has nothing to compose", () => {
  assertRejects(
    mutated(
      (value) => {
        value.composition_commit_oid = "9".repeat(40);
      },
      { which: ROOT_EXAMPLE_PATH },
    ),
    /has nothing to compose/u,
  );
});

test("several predecessors require a recorded composition commit", () => {
  // Recorded so the object can be found again after a crash rather than rebuilt
  // into a second base with the same identity.
  assertRejects(
    mutated((value) => {
      delete value.composition_commit_oid;
    }),
    /require a composition commit, recorded so it can be found again/u,
  );
});

test("every predecessor carries the PASS and delta binding that approved it", () => {
  for (const field of ["pass_receipt", "delta_digest", "commit_oid"]) {
    assertRejects(
      mutated((value) => {
        delete value.predecessors[0][field];
      }),
      /schema:/u,
    );
  }
});

test("a changed predecessor changes the base, so descendants can be voided", () => {
  // This is what makes "a changed predecessor voids affected descendant bases"
  // mechanical: the identity moves, so the old one cannot be mistaken for current.
  const before = baseDigest(example());
  const after = baseDigest(
    mutated(
      (value) => {
        value.predecessors[1].delta_digest = "e".repeat(64);
      },
      { reseal: false },
    ),
  );
  assert.notEqual(before, after);
});

test("a base whose digest does not recompute is refused", () => {
  assertRejects(
    mutated(
      (value) => {
        value.tree_oid = "9".repeat(40);
      },
      { reseal: false },
    ),
    /digest does not recompute/u,
  );
});

test("every park reason is documented in the contract", () => {
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  for (const reason of PARK_REASONS) {
    assert.ok(contract.includes(reason), `${reason} is not documented`);
  }
});

test("the design digest changes when any shipped file changes", () => {
  const before = executionBaseDesignDigest(files);
  const after = executionBaseDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
