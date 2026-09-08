/**
 * Tests for the issue #9 Epic staging validator.
 *
 * The chain is aggregate → acceptance → CAS → post-CAS, and each link is about
 * a tree. Almost every case here breaks one link's binding to that tree and
 * checks it is caught, because a chain where each link is about a slightly
 * different tree delivers something nobody verified.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CONTRACT_PATH,
  EXAMPLE_PATH,
  PARK_REASONS,
  PHASES,
  ROOT,
  SCHEMA_PATH,
  epicStagingDesignDigest,
  loadFiles,
  validateEpicStagingDesign,
  validateStaging,
} from "../scripts/validate-epic-staging.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

function example() {
  return JSON.parse(files[EXAMPLE_PATH]);
}

function mutated(mutate) {
  const value = example();
  mutate(value);
  return value;
}

function assertRejects(value, pattern) {
  const errors = validateStaging(value, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

test("the shipped design validates", () => {
  assert.deepEqual(validateEpicStagingDesign(files), []);
});

test("the example validates", () => {
  assert.deepEqual(validateStaging(example(), schema), []);
});

test("staging moved after the aggregate voids the binding", () => {
  // A PASS is about a tree, not about an intention. The tree moving afterwards
  // means the PASS is now about something that is not being delivered.
  assertRejects(
    mutated((value) => {
      value.staging_tree_oid = "9".repeat(40);
    }),
    /aggregate is bound to a different staging identity \(aggregate_binding_void\)/u,
  );
});

test("the aggregate must cover exactly the Tickets that were applied", () => {
  assertRejects(
    mutated((value) => {
      value.aggregate.included_tickets = ["T01", "T02"];
    }),
    /aggregate covers a different Ticket set/u,
  );
  assertRejects(
    mutated((value) => {
      value.receipts.push({
        ticket_id: "T09",
        delta_digest: "a".repeat(64),
        applied_commit_oid: "9".repeat(40),
      });
    }),
    /aggregate covers a different Ticket set/u,
  );
});

test("a failing aggregate cannot be accepted", () => {
  for (const outcome of ["fail", "command_failure", "environment_failure"]) {
    assertRejects(
      mutated((value) => {
        value.aggregate.outcome = outcome;
      }),
      new RegExp(`aggregate outcome ${outcome} cannot be accepted`, "u"),
    );
  }
});

test("a command failure and an environment failure are separately representable", () => {
  // Collapsing them makes "the tests failed" indistinguishable from "the machine
  // could not run them", and only one of those says anything about the product.
  const outcomes = schema.properties.aggregate.properties.outcome.enum;
  assert.ok(outcomes.includes("command_failure"));
  assert.ok(outcomes.includes("environment_failure"));
  assert.notEqual(
    outcomes.indexOf("command_failure"),
    outcomes.indexOf("environment_failure"),
  );
});

test("acceptance is of an identity, not of a plan to produce one", () => {
  assertRejects(
    mutated((value) => {
      value.acceptance.staging_tree_oid = "9".repeat(40);
    }),
    /acceptance names a staging identity that is no longer current \(acceptance_stale\)/u,
  );
});

test("acceptance must cite the aggregate that actually ran", () => {
  assertRejects(
    mutated((value) => {
      value.acceptance.aggregate_record_hash = "b".repeat(64);
    }),
    /cites a different aggregate record/u,
  );
});

test("acceptance is against a specific target ref and base", () => {
  assertRejects(
    mutated((value) => {
      value.acceptance.target_ref = "refs/heads/release";
    }),
    /names a different target ref/u,
  );
  assertRejects(
    mutated((value) => {
      value.acceptance.recorded_target_base = "9".repeat(40);
    }),
    /given against a different target base/u,
  );
});

test("acceptance must cover exactly the Tickets that were applied", () => {
  assertRejects(
    mutated((value) => {
      value.acceptance.included_tickets = ["T01"];
    }),
    /acceptance covers a different Ticket set/u,
  );
});

test("a pinned auto-policy is held to the same binding as a human", () => {
  // The point is the binding, not who supplied it — so an auto-policy that names
  // a stale tree is refused the same way.
  const auto = mutated((value) => {
    value.acceptance.kind = "pinned_auto_policy";
    delete value.acceptance.decision_id;
  });
  assert.deepEqual(validateStaging(auto, schema), []);

  assertRejects(
    mutated((value) => {
      value.acceptance.kind = "pinned_auto_policy";
      delete value.acceptance.decision_id;
      value.acceptance.staging_commit_oid = "9".repeat(40);
    }),
    /acceptance_stale/u,
  );
});

test("a human acceptance records the decision it came from", () => {
  assertRejects(
    mutated((value) => {
      delete value.acceptance.decision_id;
    }),
    /human acceptance must record the decision/u,
  );
});

test("the target must hold the tree that was accepted", () => {
  // A CAS that reported success is not evidence that the ref holds what was
  // intended.
  assertRejects(
    mutated((value) => {
      value.post_cas.target_tree_oid = "9".repeat(40);
    }),
    /does not hold the staging tree that was accepted \(post_cas_mismatch\)/u,
  );
});

test("post-CAS verification must confirm containment and the reflog", () => {
  for (const field of ["containment_verified", "reflog_verified"]) {
    assertRejects(
      mutated((value) => {
        value.post_cas[field] = false;
      }),
      /must confirm containment and the reflog entry/u,
    );
  }
});

test("a record cannot describe a phase that has not happened", () => {
  assertRejects(
    mutated((value) => {
      value.phase = "deltas_applied";
    }),
    /records an aggregate that has not run/u,
  );
  assertRejects(
    mutated((value) => {
      value.phase = "aggregate_verified";
    }),
    /records an acceptance that has not been given/u,
  );
  assertRejects(
    mutated((value) => {
      value.phase = "accepted";
    }),
    /records a post-CAS check for a swap that has not happened/u,
  );
});

test("a later phase requires the records the earlier ones produced", () => {
  assertRejects(
    mutated((value) => {
      delete value.aggregate;
    }),
    /requires an aggregate verification record/u,
  );
  assertRejects(
    mutated((value) => {
      delete value.acceptance;
    }),
    /requires an acceptance record \(acceptance_missing\)/u,
  );
  assertRejects(
    mutated((value) => {
      delete value.post_cas;
    }),
    /requires post-CAS verification/u,
  );
  assertRejects(
    mutated((value) => {
      value.receipts = [];
      value.aggregate.included_tickets = ["T01"];
      value.acceptance.included_tickets = ["T01"];
    }),
    /has no integration receipts \(receipt_missing\)/u,
  );
});

test("the staging ref belongs to this Epic", () => {
  assertRejects(
    mutated((value) => {
      value.staging_ref = "refs/autosk/epics/epic-0002/staging";
    }),
    /staging_ref is not this Epic's/u,
  );
});

test("a Ticket has one integration receipt", () => {
  assertRejects(
    mutated((value) => {
      value.receipts.push({ ...value.receipts[0] });
    }),
    /more than one integration receipt/u,
  );
});

test("every phase and park reason is documented", () => {
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  for (const reason of PARK_REASONS) {
    assert.ok(contract.includes(reason), `${reason} is not documented`);
  }
  assert.deepEqual(schema.properties.phase.enum, [...PHASES]);
});

test("the design digest changes when any shipped file changes", () => {
  const before = epicStagingDesignDigest(files);
  const after = epicStagingDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
