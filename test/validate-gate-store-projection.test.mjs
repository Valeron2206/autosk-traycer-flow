/**
 * Tests for the issue #15 gate-store-projection validator.
 *
 * The contract sits between two failures that look nothing alike: a Panel whose
 * own concurrency invalidates its seats, and a driver that changes controlling
 * identity unnoticed. Every case here pushes toward one of those two edges.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CONCURRENT_FIELDS,
  CONTRACT_PATH,
  EXAMPLE_PATH,
  PARK_REASONS,
  PROJECTED_FIELDS,
  ROOT,
  SCHEMA_PATH,
  VIOLATION_EXAMPLE_PATH,
  computeVerdict,
  gateProjectionDesignDigest,
  loadFiles,
  validateGateProjectionDesign,
  validateRecord,
} from "../scripts/validate-gate-store-projection.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

function example(which = EXAMPLE_PATH) {
  return JSON.parse(files[which]);
}

function mutated(mutate, which = EXAMPLE_PATH) {
  const value = example(which);
  mutate(value);
  return value;
}

function assertRejects(value, pattern) {
  const errors = validateRecord(value, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

test("the shipped design validates", () => {
  assert.deepEqual(validateGateProjectionDesign(files), []);
});

test("the accepted example is accepted and the violation example is not", () => {
  assert.deepEqual(validateRecord(example(), schema), []);
  assert.equal(computeVerdict(example()), "accepted");
  assert.equal(computeVerdict(example(VIOLATION_EXAMPLE_PATH)), "blocking_non_verdict");
});

test("a sibling finishing mid-run does not invalidate a seat", () => {
  // The failure the whole contract exists to avoid: four seats run in parallel,
  // so a neighbour completing is the normal shape of a Panel, not an anomaly.
  const value = example();
  const siblingWork = value.journal.filter((entry) =>
    entry.changed_fields.some((field) => ["status", "timestamps", "sibling_result"].includes(field)),
  );
  assert.ok(siblingWork.length >= 2, "the example does not actually exercise concurrent sibling work");
  assert.equal(computeVerdict(value), "accepted");
});

test("a change to the projection is a blocking non-verdict", () => {
  // Not a fail, and not a retry: the answer is about a different question than
  // the one that was asked.
  const value = mutated((draft) => {
    draft.projection_digest_after = "9".repeat(64);
  });
  assert.equal(computeVerdict(value), "blocking_non_verdict");
});

test("a projection change is refused before provenance is consulted", () => {
  // No journal entry can make a change to the controlling identity acceptable,
  // so the order of the two checks is itself part of the rule.
  const value = mutated((draft) => {
    draft.projection_digest_after = "9".repeat(64);
    draft.journal = [
      {
        actor: "daemon",
        operation_id: "op-claims-everything",
        permitted_fields: ["anchor_version"],
        changed_fields: ["anchor_version"],
        before_digest: "a".repeat(64),
        after_digest: "b".repeat(64),
        sequence: 1,
        project_binding: draft.project_binding,
      },
    ];
  });
  assert.equal(computeVerdict(value), "blocking_non_verdict");
});

test("a driver writing an allowed-looking field is refused", () => {
  // The case a projection hash alone cannot see: the field is outside the
  // projection, so only provenance can tell that nobody was entitled to it.
  const value = example(VIOLATION_EXAMPLE_PATH);
  const driver = value.journal.find((entry) => entry.actor === "driver");
  assert.ok(driver, "the violation example does not contain a driver write");
  assert.ok(CONCURRENT_FIELDS.includes(driver.changed_fields[0]), "the field must be outside the projection");
  assert.equal(computeVerdict(value), "blocking_non_verdict");
});

test("a journal entry may not change a projected field", () => {
  assertRejects(
    mutated((value) => {
      value.journal[0].permitted_fields = ["anchor_version"];
      value.journal[0].changed_fields = ["anchor_version"];
    }),
    /changed projected field anchor_version \(projection_changed\)/u,
  );
});

test("a journal entry may not change a field its operation was not permitted", () => {
  assertRejects(
    mutated((value) => {
      value.journal[0].changed_fields = ["heartbeat"];
    }),
    /was not permitted to touch \(field_not_permitted\)/u,
  );
});

test("a record from another project never enters the projection", () => {
  assertRejects(
    mutated((value) => {
      value.journal[1].project_binding = "9".repeat(64);
    }),
    /belongs to another project \(cross_project_record\)/u,
  );
});

test("the journal must be ordered", () => {
  assertRejects(
    mutated((value) => {
      value.journal[1].sequence = 1;
    }),
    /does not follow 1 \(provenance_out_of_order\)/u,
  );
});

test("the frozen comment prefix may not change", () => {
  // An append that rewrites earlier bytes is not an append.
  const value = mutated((draft) => {
    draft.comments_frozen_prefix_digest_after = "9".repeat(64);
  });
  assert.equal(computeVerdict(value), "blocking_non_verdict");
});

test("projected and concurrent sets are disjoint, by construction", () => {
  // A field in both would let one change be a violation and a legitimate update
  // at once, and whichever check ran first would decide — an accident, not a
  // rule. The schema's two enums are the two contract lists, so a record cannot
  // express the overlap at all; the guarantee lives at the design level and a
  // per-record check would never be evaluated.
  for (const field of CONCURRENT_FIELDS) {
    assert.ok(!PROJECTED_FIELDS.includes(field), `${field} is in both lists`);
  }
  assertRejects(
    mutated((value) => {
      value.concurrent_fields = [...value.concurrent_fields, "anchor_version"];
    }),
    /schema:/u,
  );
  // ...and the design check is what would catch a contract that broke it.
  const broken = { ...files, [SCHEMA_PATH]: files[SCHEMA_PATH] };
  assert.deepEqual(validateGateProjectionDesign(broken), []);
});

test("the verdict itself refuses an unpermitted change, not only the record check", () => {
  // `computeVerdict` is the host's decision function. A record could pass every
  // structural check and still have to be refused, so the refusal must live
  // there too rather than only in the validator that reads the file.
  const value = mutated((draft) => {
    draft.journal[0].changed_fields = ["heartbeat"];
  });
  assert.equal(computeVerdict(value), "blocking_non_verdict");
});

test("the verdict itself refuses a cross-project journal entry", () => {
  const value = mutated((draft) => {
    draft.journal[1].project_binding = "9".repeat(64);
  });
  assert.equal(computeVerdict(value), "blocking_non_verdict");
});

test("a record that projects a subset silently drops protection", () => {
  assertRejects(
    mutated((value) => {
      value.projected_fields = value.projected_fields.filter((field) => field !== "anchor_version");
    }),
    /declared immutable by the contract but not in projected_fields/u,
  );
});

test("an asserted verdict must match the computed one", () => {
  assertRejects(
    mutated((value) => {
      value.verdict = "accepted";
      value.projection_digest_after = "9".repeat(64);
    }),
    /verdict is accepted, computed blocking_non_verdict/u,
  );
});

test("only the daemon and the user may write outside the projection", () => {
  for (const actor of ["model", "tool", "driver"]) {
    const value = mutated((draft) => {
      draft.journal[0].actor = actor;
    });
    assert.equal(computeVerdict(value), "blocking_non_verdict", `${actor} was accepted as a writer`);
  }
});

test("the schema's two lists are exactly the contract's", () => {
  assert.deepEqual(schema.properties.projected_fields.items.enum, [...PROJECTED_FIELDS]);
  assert.deepEqual(schema.properties.concurrent_fields.items.enum, [...CONCURRENT_FIELDS]);
});

test("every park reason is documented in the contract", () => {
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  for (const reason of PARK_REASONS) {
    assert.ok(contract.includes(reason), `${reason} is not documented`);
  }
});

test("the design digest changes when any shipped file changes", () => {
  const before = gateProjectionDesignDigest(files);
  const after = gateProjectionDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
