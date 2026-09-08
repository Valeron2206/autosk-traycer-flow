/**
 * Tests for the issue #30 Housekeeping workflow.
 *
 * Deleting is the one operation that cannot be reviewed afterwards, so most of
 * these are about the ways a safe-looking cleanup removes live work: a signal
 * that could not be read treated as one that said no, age standing in for
 * proof, and an approval that covers a report rather than objects.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLASSES,
  CONFIRM_SEPARATELY,
  CONTRACT_MARKER,
  CONTRACT_PATH,
  EXAMPLE_PATH,
  GREEN,
  IN_USE_SIGNALS,
  REFUSALS,
  REFUSED_EXAMPLE_PATH,
  SCHEMA_PATH,
  deriveClass,
  housekeepingDesignDigest,
  loadFiles,
  proposedIds,
  signalsDigest,
  validateHousekeepingDesign,
  validateReport,
} from "../scripts/validate-housekeeping.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

const report = () => JSON.parse(files[EXAMPLE_PATH]);
const refusedReport = () => JSON.parse(files[REFUSED_EXAMPLE_PATH]);

function objectNamed(value, id) {
  return value.objects.find((object) => object.object_id === id);
}

/** Re-derive the class and re-seal every digest that quotes this object. */
function resettle(value, id) {
  const object = objectNamed(value, id);
  object.classification = deriveClass(object);
  object.proposed = GREEN.includes(object.classification) && object.owner.proof === "owned_by_this_project";
  for (const approved of value.approval.approved_objects) {
    if (approved.object_id === id) approved.signals_digest = signalsDigest(object);
  }
  for (const removed of value.outcome.removed) {
    if (removed.object_id === id) removed.revalidated_signals_digest = signalsDigest(object);
  }
  return value;
}

function mutated(mutate) {
  const value = report();
  mutate(value);
  return value;
}

function assertRefuses(value, pattern) {
  const errors = validateReport(value, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

test("the shipped design validates", () => {
  assert.deepEqual(validateHousekeepingDesign(files), []);
});

test("the worked report validates and proposes only green objects", () => {
  assert.deepEqual(validateReport(report(), schema), []);
  for (const id of proposedIds(report())) {
    assert.ok(GREEN.includes(objectNamed(report(), id).classification), id);
  }
});

test("housekeeping is a command, not a side effect", () => {
  assertRefuses(
    mutated((value) => {
      value.invocation = { kind: "side_effect", reference: "end of epic-store-lock" };
    }),
    /housekeeping_hidden_side_effect/u,
  );
});

test("an in-use object is never proposed, whatever holds it", () => {
  for (const signal of IN_USE_SIGNALS) {
    const value = mutated((draft) => {
      const object = objectNamed(draft, "wt-at-base");
      object.signals[signal] = "yes";
    });
    assert.equal(deriveClass(objectNamed(value, "wt-at-base")), "in_use");
    assertRefuses(value, /housekeeping_in_use_proposed: wt-at-base/u);
  }
});

test("an unavailable signal is not a signal that said no", () => {
  // Git metadata missing, a PR host unreachable and an unreadable lock all mean
  // we do not know, and not knowing is not a reason to delete.
  for (const signal of ["in_canonical_line", "unique_work", "held_lock", "open_or_unmerged_pr"]) {
    const value = mutated((draft) => {
      objectNamed(draft, "wt-at-base").signals[signal] = "unavailable";
    });
    assert.equal(deriveClass(objectNamed(value, "wt-at-base")), "unknown");
    assertRefuses(value, /housekeeping_unavailable_signal_treated_as_safe: wt-at-base/u);
  }
});

test("age never classifies", () => {
  // The abandoned worktree and the one held by a three-week-old lease look
  // identical by age, and only one of them is safe to remove.
  const old = mutated((value) => {
    objectNamed(value, "wt-live").last_activity_ms = 999999999999;
  });
  assert.equal(deriveClass(objectNamed(old, "wt-live")), "in_use");
  assert.deepEqual(validateReport(old, schema), []);
  const fresh = mutated((value) => {
    objectNamed(value, "snap-unref").last_activity_ms = 1;
  });
  assert.deepEqual(validateReport(fresh, schema), []);
});

test("submodule work blocks a green class", () => {
  // A clean superproject is exactly how submodule-only work presents.
  const value = mutated((draft) => {
    const object = objectNamed(draft, "wt-at-base");
    object.signals.submodule_work = "yes";
  });
  assert.equal(deriveClass(objectNamed(value, "wt-at-base")), "review");
  assertRefuses(value, /housekeeping_submodule_work_lost: wt-at-base/u);
});

test("a dirty tree or a detached head is not green either", () => {
  for (const [signal, expected] of [
    ["dirty_tracked", "review"],
    ["dirty_untracked", "review"],
    ["detached_or_null_branch", "orphaned"],
  ]) {
    const value = mutated((draft) => {
      objectNamed(draft, "wt-at-base").signals[signal] = "yes";
    });
    assert.equal(deriveClass(objectNamed(value, "wt-at-base")), expected, signal);
  }
  // An ignored file alone does not block: it is the case that would otherwise
  // keep every build directory forever.
  const ignored = mutated((value) => {
    resettle(value, "wt-at-base");
    objectNamed(value, "wt-at-base").signals.dirty_ignored = "yes";
    resettle(value, "wt-at-base");
  });
  assert.equal(deriveClass(objectNamed(ignored, "wt-at-base")), "at_base");
});

test("ownership is proved per object", () => {
  // A shared host is the normal case, and "it is under our root" is a statement
  // about a path.
  assert.equal(objectNamed(report(), "wt-other").owner.proof, "owned_by_other_project");
  assert.equal(objectNamed(report(), "wt-other").proposed, false);
  assertRefuses(
    mutated((value) => {
      objectNamed(value, "wt-other").proposed = true;
    }),
    /housekeeping_ownership_unproven: wt-other/u,
  );
});

test("review, orphaned and unknown are confirmed one at a time", () => {
  for (const id of ["wt-submodule", "dir-unknown", "op-orphan"]) {
    assert.ok(CONFIRM_SEPARATELY.includes(objectNamed(report(), id).classification));
    assertRefuses(
      mutated((value) => {
        objectNamed(value, id).proposed = true;
      }),
      new RegExp(`housekeeping_unknown_deleted: ${id} is`, "u"),
    );
    assertRefuses(
      mutated((value) => {
        value.approval.approved_objects.push({
          object_id: id,
          path: objectNamed(value, id).path,
          signals_digest: signalsDigest(objectNamed(value, id)),
        });
      }),
      new RegExp(`housekeeping_unknown_deleted: ${id} .*separate confirmation`, "u"),
    );
  }
});

test("a reclaimed size is measured, not estimated", () => {
  assertRefuses(
    mutated((value) => {
      objectNamed(value, "wt-at-base").reclaimed_bytes.source = "estimated";
    }),
    /housekeeping_size_unmeasured: wt-at-base/u,
  );
});

test("approval names objects, not a report", () => {
  assertRefuses(
    mutated((value) => {
      value.approval.approved_objects[0].object_id = "wt-never-inventoried";
    }),
    /housekeeping_approval_not_exact: wt-never-inventoried is not in the report/u,
  );
  assertRefuses(
    mutated((value) => {
      value.approval.approved_objects[0].path = "worktrees/somewhere-else";
    }),
    /was approved at another path/u,
  );
  assertRefuses(
    mutated((value) => {
      value.outcome.removed.push({
        object_id: "wt-submodule",
        adapter: "safe_git",
        operation_id: "op-hk-9",
        revalidated_signals_digest: signalsDigest(objectNamed(value, "wt-submodule")),
      });
    }),
    /wt-submodule was removed without being approved/u,
  );
});

test("a task that starts between the report and the approval keeps its worktree", () => {
  // The object is revalidated immediately before its delete, so a change makes
  // it skipped and reported rather than deleted.
  assertRefuses(
    mutated((value) => {
      objectNamed(value, "wt-landed").signals.active_reference = "yes";
    }),
    /housekeeping_stale_approval: wt-landed changed after it was approved/u,
  );
  assertRefuses(
    mutated((value) => {
      value.outcome.removed[0].revalidated_signals_digest = "4".repeat(64);
    }),
    /was deleted on stale signals/u,
  );
});

test("deleting goes through the adapter, never a model shell", () => {
  assertRefuses(
    mutated((value) => {
      value.outcome.removed[0].adapter = "model_shell";
    }),
    /housekeeping_untrusted_delete: wt-landed/u,
  );
});

test("a failure is recoverable and exactly reported", () => {
  assertRefuses(
    mutated((value) => {
      value.outcome.failed[0].recoverable = false;
    }),
    /housekeeping_unrecoverable_failure: wt-at-base/u,
  );
  assertRefuses(
    mutated((value) => {
      value.outcome.relisted = false;
    }),
    /the inventory was not re-listed/u,
  );
  assertRefuses(
    mutated((value) => {
      value.outcome.kept = value.outcome.kept.filter((entry) => entry.object_id !== "wt-live");
    }),
    /wt-live appears in no outcome list/u,
  );
});

test("a second run over an unchanged host proposes nothing", () => {
  // What makes it safe to run often, and a property of the classification being
  // derived rather than accumulated.
  const second = report();
  for (const id of proposedIds(second)) {
    const object = objectNamed(second, id);
    object.signals.canonical_parent = "no";
    object.classification = deriveClass(object);
    object.proposed = false;
  }
  second.approval.approved_objects = [];
  second.outcome.removed = [];
  second.outcome.failed = [];
  second.outcome.kept = second.objects.map((object) => ({
    object_id: object.object_id,
    reason:
      object.classification === "in_use"
        ? "in_use"
        : object.owner.proof !== "owned_by_this_project"
          ? "ownership_unproven"
          : "classification_not_green",
  }));
  assert.deepEqual(proposedIds(second), []);
  assert.deepEqual(validateReport(second, schema), []);
});

test("the refused report is refused, and names more than one thing", () => {
  const findings = validateReport(refusedReport(), schema);
  assert.ok(findings.length >= 6, findings.join("\n"));
  for (const pattern of [
    /housekeeping_hidden_side_effect/u,
    /housekeeping_in_use_proposed/u,
    /housekeeping_unavailable_signal_treated_as_safe/u,
    /housekeeping_submodule_work_lost/u,
    /housekeeping_size_unmeasured/u,
    /housekeeping_untrusted_delete/u,
    /housekeeping_unrecoverable_failure/u,
  ]) {
    assert.ok(findings.some((message) => pattern.test(message)), `${pattern} was not found`);
  }
});

test("the design checks fail when the shipped design stops satisfying them", () => {
  const broken = (path, transform) => validateHousekeepingDesign({ ...files, [path]: transform(files[path]) });
  assert.ok(broken(CONTRACT_PATH, (text) => text.replace(CONTRACT_MARKER, "")).some((m) => /missing <!--/u.test(m)));
  assert.ok(
    broken(CONTRACT_PATH, (text) => text.replaceAll(SCHEMA_PATH, "elsewhere.json")).some((m) =>
      /does not point at/u.test(m),
    ),
  );
  assert.ok(
    broken(CONTRACT_PATH, (text) => text.replaceAll("housekeeping_stale_approval", "stale")).some((m) =>
      /refusal housekeeping_stale_approval is not documented/u.test(m),
    ),
  );
  assert.ok(
    broken(CONTRACT_PATH, (text) => text.replaceAll("orphaned", "parentless")).some((m) =>
      /class orphaned is not documented/u.test(m),
    ),
  );
  for (const [sentence, expected] of [
    ["not a signal that says no", /what an unavailable signal means/u],
    ["Age is never proof of safety", /age is not proof/u],
    ["Approval names objects, not a report", /what is approved/u],
    ["revalidated immediately before its delete", /when an object is revalidated/u],
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
    return validateHousekeepingDesign({ ...files, [SCHEMA_PATH]: JSON.stringify(draft) });
  };
  assert.ok(
    withSchema((draft) => {
      draft.additionalProperties = true;
    }).some((m) => /root must be closed/u.test(m)),
  );
  assert.ok(
    withSchema((draft) => {
      draft.$defs.signal.enum = ["yes", "no"];
    }).some((m) => /three states, including unavailable/u.test(m)),
  );
  assert.ok(
    withSchema((draft) => {
      draft.properties.objects.items.properties.classification.enum = CLASSES.slice(0, 4);
    }).some((m) => /seven classes must match/u.test(m)),
  );
  for (const field of ["object_id", "path", "signals_digest"]) {
    assert.ok(
      withSchema((draft) => {
        const items = draft.properties.approval.properties.approved_objects.items;
        items.required = items.required.filter((name) => name !== field);
      }).some((m) => new RegExp(`approval entry must name ${field}`, "u").test(m)),
      field,
    );
  }
  assert.ok(
    withSchema((draft) => {
      const size = draft.properties.objects.items.properties.reclaimed_bytes;
      size.required = size.required.filter((name) => name !== "source");
    }).some((m) => /must say whether it was measured/u.test(m)),
  );
});

test("malformed inputs are refused rather than partially read", () => {
  assert.ok(validateHousekeepingDesign({ ...files, [SCHEMA_PATH]: "{" }).some((m) => /not valid JSON/u.test(m)));
  assert.ok(
    validateHousekeepingDesign({ ...files, [REFUSED_EXAMPLE_PATH]: "{" }).some((m) => /not valid JSON/u.test(m)),
  );
  assert.ok(
    validateHousekeepingDesign({ ...files, [REFUSED_EXAMPLE_PATH]: files[EXAMPLE_PATH] }).some((m) =>
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
    housekeepingDesignDigest(files),
    housekeepingDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` }),
  );
});
