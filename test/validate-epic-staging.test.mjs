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
  for (const [outcome, environment] of [["fail", "ok"], ["indeterminate", "environment_failure"]]) {
    assertRejects(
      mutated((value) => {
        value.aggregate.outcome = outcome;
        value.aggregate.environment_outcome = environment;
      }),
      new RegExp(`aggregate outcome ${outcome} cannot be accepted`, "u"),
    );
  }
});

test("a command failure and an environment failure are separately representable", () => {
  // Collapsing them makes "the tests failed" indistinguishable from "the machine
  // could not run them", and only one of those says anything about the product.
  // The names are the ones epic-staging §4, cond_428 and the aggregate driver
  // write (R6-7): a failed check is `fail`, a machine that could not run it is
  // `indeterminate` with environment_outcome=environment_failure.
  const outcomes = schema.properties.aggregate.properties.outcome.enum;
  assert.ok(outcomes.includes("fail"));
  assert.ok(outcomes.includes("indeterminate"));
  assert.ok(!outcomes.includes("command_failure") && !outcomes.includes("environment_failure"));
  assert.deepEqual(
    validateEpicStagingDesign({
      ...files,
      [SCHEMA_PATH]: files[SCHEMA_PATH].replace('"indeterminate"', '"environment_failure"'),
    }).filter((message) => /aggregate outcome/u.test(message)).length > 0,
    true,
  );
});

test("an indeterminate outcome and an environment failure are one fact, stated twice", () => {
  for (const [outcome, environment] of [["indeterminate", "ok"], ["fail", "environment_failure"], ["pass", "environment_failure"]]) {
    assertRejects(
      mutated((value) => {
        value.aggregate.outcome = outcome;
        value.aggregate.environment_outcome = environment;
      }),
      /outcome indeterminate is exactly an environment failure/u,
    );
  }
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
    value.acceptance.policy_ref = "policy-4";
  });
  assert.deepEqual(validateStaging(auto, schema), []);

  assertRejects(
    mutated((value) => {
      value.acceptance.kind = "pinned_auto_policy";
      delete value.acceptance.decision_id;
      value.acceptance.policy_ref = "policy-4";
      value.acceptance.staging_commit_oid = "9".repeat(40);
    }),
    /acceptance_stale/u,
  );
  // And it names the policy that pinned it, as a person names the decision.
  assertRejects(
    mutated((value) => {
      value.acceptance.kind = "pinned_auto_policy";
      delete value.acceptance.decision_id;
    }),
    /pinned auto-policy acceptance must name the policy that pinned it/u,
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

test("the staging ref belongs to this Epic", async () => {
  const { epicRefKey } = await import("../src/host/staging-driver.mjs");
  // Another Epic's key, and this Epic's key in another project: both are
  // well-formed names, and neither is this record's.
  for (const key of [epicRefKey("0".repeat(64), "epic-0002"), epicRefKey("1".repeat(64), "epic-0001")]) {
    assertRejects(
      mutated((value) => {
        value.staging_ref = `refs/autosk/epics/${key}/staging`;
      }),
      /staging_ref is not this Epic's/u,
    );
  }
});

test("a Ticket has one integration receipt", () => {
  assertRejects(
    mutated((value) => {
      value.receipts.push({ ...value.receipts[0] });
    }),
    /more than one integration receipt/u,
  );
});

test("a repeated receipt is refused once, by name, and is not also another Ticket set (review L3)", () => {
  // Review of 11e, L3: the Ticket set is a set everywhere. The receipts were
  // refused for the repeat and then compared with the aggregate's and the
  // acceptance's sets as multisets, so one fact came back three times, twice
  // as a Ticket set that differs when it does not.
  const errors = validateStaging(mutated((value) => { value.receipts.push({ ...value.receipts[0] }); }), schema);
  assert.ok(errors.some((message) => /more than one integration receipt/u.test(message)), errors.join("\n"));
  assert.deepEqual(errors.filter((message) => /different Ticket set/u.test(message)), []);
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

test("the staging ref in a record is named by a 64-hex epic_ref_key, never a display id", async () => {
  const { readFileSync } = await import("node:fs");
  const schema = JSON.parse(readFileSync(new URL("../resources/epic-staging/epic-staging.schema.json", import.meta.url), "utf8"));
  const pattern = new RegExp(schema.properties.staging_ref.pattern, "u");
  assert.equal(pattern.test("refs/autosk/epics/epic-0001/staging"), false);
  assert.equal(pattern.test(`refs/autosk/epics/${"a".repeat(64)}/staging`), true);
  const example = JSON.parse(readFileSync(new URL("../resources/epic-staging/epic-staging.example.json", import.meta.url), "utf8"));
  assert.equal(pattern.test(example.staging_ref), true);
});

test("under squash the acceptance names the commit that lands (debt 10b)", () => {
  // The example is a squash delivery: the target moves to one commit whose
  // tree is the accepted staging tree, and the acceptance names that commit.
  assert.equal(example().acceptance.delivery_mode, "squash");
  for (const field of ["target_commit_oid", "target_commit_recipe_sha256"]) {
    assertRejects(
      mutated((value) => {
        delete value.acceptance[field];
      }),
      new RegExp(`acceptance\\.${field} is required`, "u"),
    );
  }
  // The squash fields are the squash mode's: a fast-forward names no second commit.
  for (const mode of ["merge", "rebase"]) {
    assertRejects(
      mutated((value) => {
        value.acceptance.delivery_mode = mode;
        value.post_cas.target_oid = value.staging_commit_oid;
      }),
      new RegExp(`a ${mode} delivery names no target commit`, "u"),
    );
  }
  assertRejects(
    mutated((value) => {
      delete value.acceptance.delivery_mode;
    }),
    /acceptance\.delivery_mode is required/u,
  );
});

test("the target holds the commit the delivery mode moves it to", () => {
  // Under squash, the squash commit the acceptance named; under merge or
  // rebase, the accepted staging commit itself.
  assertRejects(
    mutated((value) => {
      value.post_cas.target_oid = value.staging_commit_oid;
    }),
    /the target does not hold the commit the squash acceptance named \(post_cas_mismatch\)/u,
  );
  const merge = mutated((value) => {
    value.acceptance.delivery_mode = "merge";
    delete value.acceptance.target_commit_oid;
    delete value.acceptance.target_commit_recipe_sha256;
    value.post_cas.target_oid = value.staging_commit_oid;
  });
  assert.deepEqual(validateStaging(merge, schema), []);
  assertRejects(
    { ...merge, post_cas: { ...merge.post_cas, target_oid: "9".repeat(40) } },
    /the target does not hold the accepted staging commit \(post_cas_mismatch\)/u,
  );
  // A PR or merge-queue delivery never runs the target CAS.
  for (const mode of ["pull_request", "merge_queue", "fork_pull_request"]) {
    assertRejects(
      { ...merge, acceptance: { ...merge.acceptance, delivery_mode: mode } },
      new RegExp(`a ${mode} delivery never runs the target CAS`, "u"),
    );
  }
});

test("the recorded base is the planning base on a first stage, and a receipted replay otherwise", () => {
  // ADR-088: recorded_target_base starts equal to planning.base_oid; a
  // re-stage re-records it, and its first commit is bound by a planning
  // replay receipt the record names.
  const first = example();
  assert.equal(first.recorded_target_base, first.planning_base_oid);
  assertRejects(
    mutated((value) => {
      value.planning_replay_receipt_sha256 = "7".repeat(64);
    }),
    /a first stage has no planning replay receipt/u,
  );
  const restaged = (mutate) => mutated((value) => {
    const base = "8".repeat(40);
    value.recorded_target_base = base;
    value.acceptance.recorded_target_base = base;
    value.planning_replay_receipt_sha256 = "7".repeat(64);
    // A re-stage creates the ref again: the record is in a later generation (review F-c).
    value.generation = 1;
    mutate?.(value);
  });
  assert.deepEqual(validateStaging(restaged(), schema), []);
  assertRejects(
    restaged((value) => {
      delete value.planning_replay_receipt_sha256;
    }),
    /a re-staged record names the planning replay receipt that binds its first commit/u,
  );
  assertRejects(
    mutated((value) => {
      delete value.planning_base_oid;
    }),
    /planning_base_oid is required/u,
  );
});

test("the record keeps the generation createStaging and cleanupStaging ask under, and a re-staged record is in a later one (review F-c)", () => {
  // epic-staging.md section 7 speaks of "the staging record's generation": a closed record that cannot hold it would
  // leave a host that reloads after a crash with nothing to derive its request pair from.
  assert.ok(schema.properties.generation, "the closed schema has no generation");
  assert.equal(schema.properties.generation.type, "integer");
  assert.equal(schema.properties.generation.minimum, 0);
  assert.equal(example().generation, 0);
  assert.deepEqual(validateStaging(example(), schema), []);
  // Absent on a record that has only ever staged once.
  assert.deepEqual(validateStaging(mutated((value) => { delete value.generation; }), schema), []);
  for (const bad of [-1, 1.5, "1", null]) {
    assertRejects(mutated((value) => { value.generation = bad; }), /generation/u);
  }
  const restaged = (mutate) => mutated((value) => {
    const base = "8".repeat(40);
    value.recorded_target_base = base;
    value.acceptance.recorded_target_base = base;
    value.planning_replay_receipt_sha256 = "7".repeat(64);
    mutate(value);
  });
  assertRejects(restaged((value) => { delete value.generation; }), /a re-staged record is in generation 1 or later/u);
  assertRejects(restaged((value) => { value.generation = 0; }), /a re-staged record is in generation 1 or later/u);
  assert.deepEqual(validateStaging(restaged((value) => { value.generation = 2; }), schema), []);
  // The contract says where the generation lives.
  const contract = readFileSync(path.join(ROOT, "docs/contracts/epic-staging.md"), "utf8");
  assert.match(contract, /The record keeps a `generation`/u);
});

// --- debt 11e (R7-16, R7-17, ADR-099) ---

test("the closed park set is the one-CAS set: nothing parks target_moved (R7-16)", () => {
  // Under the one CAS every movement of the target off the recorded base that
  // is not this Epic's own result is foreign_target_movement.
  assert.deepEqual([...PARK_REASONS].sort(), [
    "acceptance_missing",
    "acceptance_stale",
    "aggregate_binding_void",
    "aggregate_failed",
    "cas_conflict",
    "environment_failure",
    "foreign_target_movement",
    "post_cas_mismatch",
    "receipt_missing",
    "staging_moved_after_pass",
  ]);
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  assert.ok(!contract.includes("target_moved"), "the contract still names target_moved");
});

test("the aggregate's record_hash is the digest of its record, which the acceptance binds (R7-17)", async () => {
  // The acceptance's aggregate_record_hash binds what the hash covers, so a
  // hash that left out the tree, the configuration and the lock bound none of
  // them. The host's function is the one both sides use.
  const { aggregateRecordHash } = await import("../src/host/epic-staging.mjs");
  const value = example();
  const owner = { project_identity: `sha256:${value.project_root_sha256}`, epic_id: value.epic_id };
  assert.equal(value.aggregate.record_hash, aggregateRecordHash(owner, value.aggregate));
  assert.equal(value.acceptance.aggregate_record_hash, value.aggregate.record_hash);
  for (const [field, other] of [
    ["verification_config_digest", "e".repeat(64)],
    ["instruction_lock_digest", "f".repeat(64)],
    ["outcome", "fail"],
  ]) {
    assertRejects(
      mutated((record) => {
        record.aggregate[field] = other;
      }),
      /aggregate record_hash is not the digest of its record \(aggregate_binding_void\)/u,
    );
  }
  // One that recomputes is accepted, however it was reached.
  const rehashed = mutated((record) => {
    record.aggregate.instruction_lock_digest = "f".repeat(64);
    record.aggregate.record_hash = aggregateRecordHash(owner, record.aggregate);
    record.acceptance.aggregate_record_hash = record.aggregate.record_hash;
  });
  assert.deepEqual(validateStaging(rehashed, schema), []);
});
