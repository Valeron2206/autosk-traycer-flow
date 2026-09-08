/**
 * Tests for the issue #29 Reflect pass and cost-watch registry.
 *
 * Governance grows in one direction on its own: adding a rule needs a worry,
 * removing one needs an argument. These check the three places that asymmetry
 * is held open — an observed failure per new rule, a registry that detects its
 * own edits, and a size budget that has to name what it would remove.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_MARKER,
  CONTRACT_PATH,
  FRICTION_THRESHOLD,
  LENSES,
  PASS_EXAMPLE_PATH,
  PASS_SCHEMA_PATH,
  REFUSALS,
  REFUSED_EXAMPLE_PATH,
  REGISTRY_EXAMPLE_PATH,
  REGISTRY_SCHEMA_PATH,
  canonical,
  coveredBy,
  extractDigest,
  loadFiles,
  passDecision,
  reflectDesignDigest,
  validatePass,
  validateReflectDesign,
  validateRegistry,
} from "../scripts/validate-reflect-cost-watch.mjs";

import { createHash } from "node:crypto";

const files = loadFiles();
const passSchema = JSON.parse(files[PASS_SCHEMA_PATH]);
const registrySchema = JSON.parse(files[REGISTRY_SCHEMA_PATH]);

const pass = () => JSON.parse(files[PASS_EXAMPLE_PATH]);
const refusedPass = () => JSON.parse(files[REFUSED_EXAMPLE_PATH]);
const registry = () => JSON.parse(files[REGISTRY_EXAMPLE_PATH]);

function reseal(record) {
  record.extract.clearance_digest = extractDigest(record.extract);
  return record;
}

function mutated(mutate, { reclear = true } = {}) {
  const value = pass();
  mutate(value);
  if (reclear) reseal(value);
  return value;
}

function assertRefuses(record, pattern) {
  const errors = validatePass(record, passSchema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

function assertRegistryRefuses(value, pattern) {
  const errors = validateRegistry(value, registrySchema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

/** Rebuild the checkpoints so a mutated registry is otherwise well-formed. */
function rechain(entries) {
  for (const [index, entry] of entries.entries()) {
    entry.seq = index + 1;
    const prefix = entries.slice(0, index);
    entry.checkpoint = {
      length: prefix.length,
      sha256: createHash("sha256").update(canonical(prefix), "utf8").digest("hex"),
    };
  }
  return entries;
}

test("the shipped design validates", () => {
  assert.deepEqual(validateReflectDesign(files), []);
});

test("the worked pass and the worked registry validate", () => {
  assert.deepEqual(validatePass(pass(), passSchema), []);
  assert.deepEqual(validateRegistry(registry(), registrySchema), []);
});

test("the clearance names the bytes it covered", () => {
  // A reference alone is a promise: an extract edited after the scan is a
  // different set of bytes with an older reference attached.
  assertRefuses(
    mutated((value) => {
      value.extract.items[0].summary = "a milder description of the same incident";
    }, { reclear: false }),
    /reflect_extract_uncleared/u,
  );
});

test("reviewers read the extract, and only the extract", () => {
  assertRefuses(
    mutated((value) => {
      value.lenses[0].sources_read.push("epic-store-lock/transcripts/raw.jsonl");
    }),
    /reflect_unlisted_source: the judgment lens read epic-store-lock\/transcripts\/raw.jsonl/u,
  );
  assert.equal(coveredBy(["a/b/**"], "a/b/c/d"), true);
  assert.equal(coveredBy(["a/b/**"], "a/x"), false);
  assert.equal(coveredBy(["a/b.json"], "a/b.json"), true);
  assert.equal(coveredBy(["a/b.json"], "a/b.json.bak"), false);
});

test("all three lenses run, and they are read-only by construction", () => {
  // A pass missing one is not a smaller pass; it cannot see the category it
  // dropped.
  for (const lens of LENSES) {
    assertRefuses(
      mutated((value) => {
        value.lenses = value.lenses.map((entry) =>
          entry.lens === lens ? { ...entry, lens: LENSES.find((other) => other !== lens) } : entry,
        );
      }),
      new RegExp(`reflect_lens_missing: ${lens}`, "u"),
    );
  }
  assert.equal(passSchema.properties.lenses.items.properties.read_only.const, true);
});

test("a new rule needs an observed failure with a locator", () => {
  // Refused as unproven, not as wrong.
  assertRefuses(
    mutated((value) => {
      value.findings[2].disposition = "accepted";
    }),
    /reflect_rule_without_observation: F-3/u,
  );
  const imported = mutated((value) => {
    value.findings[2].disposition = "accepted";
    value.findings[2].import = { decision_ref: "decision-0044", panel_ref: "panel-2026-09-08-import" };
  });
  assert.deepEqual(validatePass(imported, passSchema), []);
});

test("repeated friction becomes tooling, not a rule", () => {
  // A recurring manual step written down as a rule is the same manual step with
  // an obligation attached to it.
  assertRefuses(
    mutated((value) => {
      value.findings[0].proposal = "new_rule";
    }),
    /reflect_friction_not_tooled: F-1 repeats manual_friction 4 times/u,
  );
  const once = mutated((value) => {
    value.findings[0].proposal = "new_rule";
    value.findings[0].recurrence = FRICTION_THRESHOLD - 1;
  });
  assert.deepEqual(validatePass(once, passSchema), []);
});

test("accepted does not mean active", () => {
  assertRefuses(
    mutated((value) => {
      value.findings[1].activation.panel_ref = null;
    }),
    /reflect_bundle_changed_without_panel: F-2/u,
  );
  assertRefuses(
    mutated((value) => {
      value.findings[2].activation.bundle_changed = true;
    }),
    /reflect_bundle_changed_without_panel: F-3 is backlog/u,
  );
});

test("Reflect does not change the outcome of a closed Epic", () => {
  assertRefuses(
    mutated((value) => {
      value.epic.outcome_digest_after = "7".repeat(64);
    }),
    /reflect_epic_outcome_changed/u,
  );
  const unchanged = mutated((value) => {
    value.epic.outcome_digest_after = value.epic.outcome_digest;
  });
  assert.deepEqual(validatePass(unchanged, passSchema), []);
});

test("a retry is the same pass; a second pass over one Epic must cite the first", () => {
  const first = pass();
  assert.equal(passDecision(first, []), "dispatch");
  assert.equal(passDecision(first, [first]), "retry");
  const sameIdDifferentInput = mutated((value) => {
    value.extract.items.push({
      kind: "retry", locator: "epic-store-lock/tickets/T-103/run-1", summary: "a second run of the same ticket",
    });
  });
  assert.equal(passDecision(sameIdDifferentInput, [first]), "refused:reflect_pass_replay");
  const second = mutated((value) => {
    value.reflect_pass_id = "rfp-store-lock-2";
  });
  assert.equal(passDecision(second, [first]), "refused:reflect_pass_replay");
  second.follows_pass = "rfp-store-lock-1";
  assert.equal(passDecision(second, [first]), "dispatch");
  second.follows_pass = "rfp-never-happened";
  assert.equal(passDecision(second, [first]), "refused:reflect_pass_replay");
});

test("governance growth names what it would remove", () => {
  assertRefuses(
    mutated((value) => {
      delete value.governance_budget[1].replacement_candidates;
    }),
    /grows with nothing considered for replacement/u,
  );
  assertRefuses(
    mutated((value) => {
      value.governance_budget[1].form = "prose";
      delete value.governance_budget[1].growth_rationale;
    }),
    /grows with no rationale/u,
  );
  assertRefuses(
    mutated((value) => {
      value.governance_budget[0].net_delta_lines = 0;
    }),
    /records 0, computed -11/u,
  );
});

test("the registry detects a rewritten earlier entry", () => {
  // The check that makes "append-only" more than a promise: an edit changes the
  // prefix digest of every entry after it.
  assertRegistryRefuses(
    (() => {
      const value = registry();
      value.entries[0].observed_cost = "no cost after all";
      return value;
    })(),
    /costwatch_prefix_changed: entry 2 was appended onto a different prefix/u,
  );
});

test("the registry detects a truncated tail", () => {
  assertRegistryRefuses(
    (() => {
      const value = registry();
      value.entries.splice(1, 1);
      value.entries[1].seq = 2;
      return value;
    })(),
    /costwatch_truncated: entry 2 was appended onto 2 entries, 1 are here/u,
  );
});

test("two appends onto the same prefix are a lost update, not two appends", () => {
  assertRegistryRefuses(
    (() => {
      const value = registry();
      value.entries[2].checkpoint = { ...value.entries[1].checkpoint };
      return value;
    })(),
    /costwatch_lost_update: entries 2 and 3/u,
  );
  assertRegistryRefuses(
    (() => {
      const value = registry();
      value.entries[2].writer.operation_id = value.entries[1].writer.operation_id;
      return value;
    })(),
    /costwatch_lost_update: operation op-0002 appended twice/u,
  );
});

test("concurrent Epics append to one registry", () => {
  // The reason the checkpoint is not decoration: entry three comes from another
  // Epic and another writer lock.
  const entries = registry().entries;
  assert.notEqual(entries[2].epic_id, entries[1].epic_id);
  assert.notEqual(entries[2].writer.lock_id, entries[1].writer.lock_id);
  const appended = registry();
  appended.entries.push({
    ...entries[2],
    seq: 4,
    rule_id: "rule-extract-locators",
    pass_id: "rfp-other-epic-2",
    writer: { lock_id: "lock-c", operation_id: "op-0004" },
  });
  rechain(appended.entries);
  assert.deepEqual(validateRegistry(appended, registrySchema), []);
});

test("an entry with no writer identity cannot be attributed", () => {
  // The schema stops this in the shipped path, so without a direct test the
  // guard would never be evaluated — and `validateRegistry` is exported.
  const errors = validateRegistry(
    { schema_version: 1, entries: [{ ...registry().entries[0], writer: { lock_id: "", operation_id: "" } }] },
    { type: "object" },
  );
  assert.ok(errors.some((message) => /costwatch_lock_missing: entry 1/u.test(message)));
});

test("a reordered registry is refused before its digests are read", () => {
  assertRegistryRefuses(
    (() => {
      const value = registry();
      [value.entries[0], value.entries[1]] = [value.entries[1], value.entries[0]];
      return value;
    })(),
    /costwatch_prefix_changed: entry 2 is in position 1/u,
  );
});

test("the refused pass is refused, and names more than one thing", () => {
  const findings = validatePass(refusedPass(), passSchema);
  assert.ok(findings.length >= 3, findings.join("\n"));
  for (const pattern of [
    /reflect_unlisted_source/u,
    /reflect_rule_without_observation/u,
    /reflect_friction_not_tooled/u,
    /reflect_epic_outcome_changed/u,
  ]) {
    assert.ok(findings.some((message) => pattern.test(message)), `${pattern} was not found`);
  }
});

test("the design checks fail when the shipped design stops satisfying them", () => {
  const broken = (path, transform) => validateReflectDesign({ ...files, [path]: transform(files[path]) });
  assert.ok(broken(CONTRACT_PATH, (text) => text.replace(CONTRACT_MARKER, "")).some((m) => /missing <!--/u.test(m)));
  for (const schemaPath of [PASS_SCHEMA_PATH, REGISTRY_SCHEMA_PATH]) {
    assert.ok(
      broken(CONTRACT_PATH, (text) => text.replaceAll(schemaPath, "elsewhere.json")).some((m) =>
        /does not point at/u.test(m),
      ),
    );
  }
  assert.ok(
    broken(CONTRACT_PATH, (text) => text.replaceAll("costwatch_lost_update", "lost")).some((m) =>
      /refusal costwatch_lost_update is not documented/u.test(m),
    ),
  );
  for (const [sentence, expected] of [
    ["refused as unproven", /what happens to a theoretical gap/u],
    ["not prose", /what repeated friction becomes/u],
    ["Accepted does not mean active", /still takes the panel/u],
    ["bytes nobody scanned", /why a clearance reference is required/u],
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
    return validateReflectDesign({ ...files, [relative]: JSON.stringify(draft) });
  };
  for (const relative of [PASS_SCHEMA_PATH, REGISTRY_SCHEMA_PATH]) {
    assert.ok(
      withSchema(relative, (draft) => {
        draft.additionalProperties = true;
      }).some((m) => /root must be closed/u.test(m)),
      relative,
    );
  }
  assert.ok(
    withSchema(PASS_SCHEMA_PATH, (draft) => {
      draft.properties.lenses.maxItems = 9;
    }).some((m) => /all three lenses must run/u.test(m)),
  );
  assert.ok(
    withSchema(PASS_SCHEMA_PATH, (draft) => {
      draft.properties.lenses.items.properties.read_only = { type: "boolean" };
    }).some((m) => /read-only by construction/u.test(m)),
  );
  assert.ok(
    withSchema(PASS_SCHEMA_PATH, (draft) => {
      draft.properties.extract.required = draft.properties.extract.required.filter(
        (field) => field !== "clearance_digest",
      );
    }).some((m) => /must name the bytes it covered/u.test(m)),
  );
  for (const field of ["checkpoint", "writer", "evidence_locators"]) {
    assert.ok(
      withSchema(REGISTRY_SCHEMA_PATH, (draft) => {
        draft.properties.entries.items.required = draft.properties.entries.items.required.filter(
          (name) => name !== field,
        );
      }).some((m) => new RegExp(`${field} must be required`, "u").test(m)),
      field,
    );
  }
});

test("malformed inputs are refused rather than partially read", () => {
  assert.ok(
    validateReflectDesign({ ...files, [REGISTRY_SCHEMA_PATH]: "{" }).some((m) => /costwatch_malformed/u.test(m)),
  );
  assert.ok(
    validateReflectDesign({ ...files, [REGISTRY_EXAMPLE_PATH]: "{" }).some((m) => /costwatch_malformed/u.test(m)),
  );
  assert.ok(
    validateReflectDesign({ ...files, [REFUSED_EXAMPLE_PATH]: "{" }).some((m) => /not valid JSON/u.test(m)),
  );
  assert.ok(
    validateReflectDesign({ ...files, [REFUSED_EXAMPLE_PATH]: files[PASS_EXAMPLE_PATH] }).some((m) =>
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
    reflectDesignDigest(files),
    reflectDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` }),
  );
});
