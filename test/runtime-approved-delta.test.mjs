/**
 * Tests for the approved delta and its integration proof (issue #8 runtime).
 *
 * The contract exists because full-tree equality reports the presence of
 * approved work as a difference. So the first test is the second Ticket, and
 * the rest are the ways an integration can look clean while producing bytes
 * nobody reviewed.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  INHERITED_GIT_ENV,
  MODES,
  PARK_REASONS,
  PHASES,
  collisionErrors,
  deltaDigest,
  environmentErrors,
  integrationProof,
  refMovementErrors,
  resumeFrom,
  retryable,
  revalidate,
  validateDelta,
  withinPathspec,
  worktreeErrors,
} from "../src/host/approved-delta.mjs";

const code = (name) => (error) => error.code === name;

const oid = (char) => char.repeat(40);

function entry(overrides = {}) {
  return {
    path: "src/store/creation.ts",
    status: "M",
    old_blob: oid("1"),
    new_blob: oid("2"),
    old_mode: "100644",
    new_mode: "100644",
    ...overrides,
  };
}

function delta(overrides = {}) {
  const value = {
    schema_version: 1,
    operation_id: "op-1",
    ticket_id: "T-102",
    base_commit_oid: oid("a"),
    base_tree_oid: oid("b"),
    candidate_tree_oid: oid("c"),
    pathspec: ["src/**"],
    entries: [entry()],
    phase: "prepared",
    ...overrides,
  };
  value.delta_digest = overrides.delta_digest ?? deltaDigest(value);
  return value;
}

function result(overrides = {}) {
  return {
    operation_id: "op-1",
    base_commit_oid: oid("a"),
    applied_entries: [{ path: "src/store/creation.ts", new_blob: oid("2"), new_mode: "100644" }],
    preserved_from_other_tickets: [],
    conflicts_resolved_by_new_content: false,
    ref_movement: {
      ref: "refs/heads/staging",
      expected_old_oid: oid("a"),
      observed_old_oid: oid("a"),
      new_oid: oid("d"),
      post_state: "known",
      reflog_entries: 1,
    },
    ...overrides,
  };
}

test("the second independent Ticket integrates with no full-tree false negative", () => {
  // The presence of the first Ticket's approved work is not a difference this
  // check reports, because the reviewed unit is the delta and not the tree.
  const second = delta({ entries: [entry({ path: "src/engine/tokens.ts" })] });
  const applied = result({
    applied_entries: [{ path: "src/engine/tokens.ts", new_blob: oid("2"), new_mode: "100644" }],
    preserved_from_other_tickets: [{ path: "src/store/creation.ts", present: true }],
  });
  assert.deepEqual(validateDelta(second), []);
  assert.deepEqual(integrationProof(second, applied), []);
});

test("another Ticket's work going missing is a containment failure", () => {
  const applied = result({ preserved_from_other_tickets: [{ path: "src/store/other.ts", present: false }] });
  const errors = integrationProof(delta(), applied);
  assert.ok(errors.some((error) => error.reason === "containment_mismatch"));
});

test("an entry records mode and blob on both sides, because text is not identity", () => {
  // A mode change has no textual diff at all.
  const modeOnly = delta({
    entries: [entry({ old_blob: oid("1"), new_blob: oid("1"), old_mode: "100644", new_mode: "100755" })],
  });
  assert.deepEqual(validateDelta(modeOnly), []);
  // A symlink and a regular file with the same bytes are different objects.
  const symlink = delta({ entries: [entry({ new_mode: "120000" })] });
  assert.deepEqual(validateDelta(symlink), []);
  // A gitlink points at a commit in another repository.
  const gitlink = delta({ entries: [entry({ old_mode: "160000", new_mode: "160000" })] });
  assert.deepEqual(validateDelta(gitlink), []);
  assert.deepEqual(MODES.slice(), ["100644", "100755", "120000", "160000"]);
});

test("a modification that changed neither bytes nor mode is not a modification", () => {
  const nothing = delta({ entries: [entry({ new_blob: oid("1") })] });
  assert.ok(validateDelta(nothing).some((error) => /changes nothing/u.test(error.detail)));
});

test("a rename and a copy name where they came from", () => {
  // A rename with an identical blob is a real change that a content-only view
  // sees as nothing.
  const rename = delta({
    entries: [entry({ status: "R", from_path: "src/store/old.ts", new_blob: oid("1") })],
  });
  assert.deepEqual(validateDelta(rename), []);
  const anonymous = delta({ entries: [entry({ status: "R" })] });
  assert.ok(anonymous.entries.length === 1 && validateDelta(anonymous).some((error) => /came from/u.test(error.detail)));
  const copy = delta({ entries: [entry({ status: "C", old_blob: undefined })] });
  assert.ok(validateDelta(copy).some((error) => /came from/u.test(error.detail)));
});

test("a rename out of scope moves a file the Ticket was not allowed to touch", () => {
  const escaping = delta({
    entries: [entry({ status: "R", from_path: "docs/notes.md", new_blob: oid("1") })],
  });
  assert.ok(validateDelta(escaping).some((error) => error.reason === "scope_violation"));
});

test("an entry outside the pathspec is a scope violation", () => {
  const outside = delta({ entries: [entry({ path: "docs/leak.md" })] });
  assert.ok(validateDelta(outside).some((error) => error.reason === "scope_violation"));
  assert.equal(withinPathspec(["src/**"], "src/a/b.ts"), true);
  assert.equal(withinPathspec(["src/*.ts"], "src/a/b.ts"), false);
});

test("the digest covers the bases, so a delta cannot be reinterpreted against another one", () => {
  const original = delta();
  const rebased = { ...original, base_tree_oid: oid("9") };
  assert.notEqual(deltaDigest(rebased), original.delta_digest);
  assert.ok(validateDelta(rebased).some((error) => error.reason === "delta_stale"));
  // ...and it does not depend on the order the entries were written in.
  const two = delta({ entries: [entry(), entry({ path: "src/b.ts" })] });
  const reversed = { ...two, entries: [...two.entries].reverse() };
  assert.equal(deltaDigest(reversed), two.delta_digest);
});

test("a staging base that moved between approval and apply is a different base", () => {
  const approved = delta();
  assert.deepEqual(revalidate(approved, { commit_oid: oid("a"), tree_oid: oid("b") }), []);
  const errors = revalidate(approved, { commit_oid: oid("e"), tree_oid: oid("b") });
  assert.ok(errors.some((error) => error.reason === "delta_stale"));
});

test("an inherited Git environment is refused, not cleaned in place", () => {
  // An inherited variable silently redirects every command that follows.
  for (const name of INHERITED_GIT_ENV) {
    const errors = environmentErrors({ [name]: "/somewhere/else" });
    assert.deepEqual(errors, [{ reason: "inherited_git_env", detail: name }]);
  }
  assert.deepEqual(environmentErrors({ PATH: "/usr/bin" }), []);
});

test("a dirty, linked or autostashed worktree is recorded and refused rather than tidied", () => {
  assert.deepEqual(worktreeErrors({}), []);
  assert.equal(worktreeErrors({ dirty: true }).length, 1);
  assert.equal(worktreeErrors({ linked: true }).length, 1);
  assert.equal(worktreeErrors({ autostash: true }).length, 1);
  assert.equal(worktreeErrors({ dirty: true, linked: true, autostash: true }).length, 3);
});

test("an untracked or ignored file in the way stops the integration, and nothing is deleted", () => {
  // The file is someone's, and "it was in the way" is not a reason to remove it.
  const untracked = collisionErrors(delta(), { untracked: ["src/store/creation.ts"] });
  assert.deepEqual(untracked, [{ reason: "untracked_collision", detail: "src/store/creation.ts" }]);
  const ignored = collisionErrors(delta(), { ignored: ["src/store/creation.ts"] });
  assert.deepEqual(ignored, [{ reason: "ignored_collision", detail: "src/store/creation.ts" }]);
  assert.deepEqual(collisionErrors(delta(), { untracked: ["src/elsewhere.ts"] }), []);
});

test("a conflict resolved by writing new content is refused", () => {
  // The point that decides whether this contract means anything: no amount of
  // care in choosing the bytes makes them reviewed.
  const errors = integrationProof(delta(), result({ conflicts_resolved_by_new_content: true }));
  assert.ok(errors.some((error) => error.reason === "unreviewed_bytes"));
});

test("applied bytes that are not the approved ones are unreviewed bytes", () => {
  const errors = integrationProof(
    delta(),
    result({ applied_entries: [{ path: "src/store/creation.ts", new_blob: oid("9"), new_mode: "100644" }] }),
  );
  assert.ok(errors.some((error) => error.reason === "unreviewed_bytes"));
  // ...and a mode that differs is the same failure, with no textual diff to see.
  const mode = integrationProof(
    delta(),
    result({ applied_entries: [{ path: "src/store/creation.ts", new_blob: oid("2"), new_mode: "100755" }] }),
  );
  assert.ok(mode.some((error) => error.reason === "unreviewed_bytes"));
});

test("an approved entry that is not present, and an unapproved one that is", () => {
  const missing = integrationProof(delta(), result({ applied_entries: [] }));
  assert.ok(missing.some((error) => error.reason === "containment_mismatch"));
  const extra = integrationProof(
    delta(),
    result({
      applied_entries: [
        { path: "src/store/creation.ts", new_blob: oid("2"), new_mode: "100644" },
        { path: "src/store/sneaked.ts", new_blob: oid("7"), new_mode: "100644" },
      ],
    }),
  );
  assert.ok(extra.some((error) => error.reason === "scope_violation"));
});

test("an approved deletion is proven by absence, not by presence", () => {
  // Requiring the path to be present would make an approved deletion
  // impossible to integrate: the guard could never be satisfied.
  const deletion = delta({
    entries: [entry({ status: "D", new_blob: undefined, new_mode: undefined })],
  });
  assert.deepEqual(
    integrationProof(deletion, result({ applied_entries: [], removed_paths: ["src/store/creation.ts"] })),
    [],
  );
  const stillThere = integrationProof(deletion, result({ removed_paths: [] }));
  assert.ok(stillThere.some((error) => /approved deletion is still present/u.test(error.detail)));
});

test("a rename that leaves the old path in place is two files where there was one", () => {
  const renamed = delta({
    entries: [entry({ path: "src/store/moved.ts", from_path: "src/store/creation.ts", status: "R" })],
  });
  const applied = { path: "src/store/moved.ts", new_blob: oid("2"), new_mode: "100644" };
  assert.deepEqual(
    integrationProof(renamed, result({ applied_entries: [applied], removed_paths: ["src/store/creation.ts"] })),
    [],
  );
  const copied = integrationProof(renamed, result({ applied_entries: [applied], removed_paths: [] }));
  assert.ok(copied.some((error) => /the rename left it in place/u.test(error.detail)));
});

test("a removal nobody approved is a scope violation, not an absence", () => {
  // A check that only inspects the paths still there cannot see a removal at
  // all, which is what makes this worth stating separately.
  const errors = integrationProof(delta(), result({ removed_paths: ["src/store/other.ts"] }));
  assert.ok(errors.some((error) => /removed and not approved/u.test(error.detail)), JSON.stringify(errors));
  // Outside the Ticket's scope it is not this delta's business.
  assert.deepEqual(integrationProof(delta(), result({ removed_paths: ["docs/readme.md"] })), []);
});

test("a result not bound to this operation and base is refused", () => {
  const errors = integrationProof(delta(), result({ operation_id: "op-2" }));
  assert.ok(errors.some((error) => /not bound to this operation/u.test(error.detail)));
});

test("foreign, indeterminate and ambiguous ref movement are each their own reason", () => {
  assert.deepEqual(refMovementErrors(result().ref_movement), []);
  assert.ok(
    refMovementErrors({ ...result().ref_movement, observed_old_oid: oid("f") })
      .some((error) => error.reason === "foreign_ref_movement"),
  );
  assert.ok(
    refMovementErrors({ ...result().ref_movement, post_state: "unknown" })
      .some((error) => error.reason === "indeterminate_post_state"),
  );
  for (const entries of [0, 2]) {
    // Zero says the move did not happen; more than one says something else
    // moved it too.
    assert.ok(
      refMovementErrors({ ...result().ref_movement, reflog_entries: entries })
        .some((error) => error.reason === "reflog_ambiguous"),
      String(entries),
    );
  }
  assert.ok(refMovementErrors(undefined).some((error) => error.reason === "indeterminate_post_state"));
});

test("an uncertain outcome is not retried", () => {
  // A retry against an unknown post-state is how one uncertain outcome becomes
  // two.
  assert.equal(retryable("foreign_ref_movement"), false);
  assert.equal(retryable("indeterminate_post_state"), false);
  assert.equal(retryable("reflog_ambiguous"), false);
  assert.equal(retryable("dirty_worktree"), true);
});

test("a crash resumes from the phase after the one recorded", () => {
  // "We do not know which phase it died in" is the state that produces double
  // application, which is why the phases are in the schema.
  for (const [index, phase] of PHASES.entries()) {
    const next = resumeFrom({ phase, operation_id: "op-1" }, "op-1");
    assert.equal(next, index === PHASES.length - 1 ? "complete" : PHASES[index + 1]);
  }
  assert.throws(() => resumeFrom({ phase: "halfway", operation_id: "op-1" }, "op-1"), code("indeterminate_post_state"));
});

test("a state file belonging to another operation is refused, never overwritten", () => {
  assert.throws(
    () => resumeFrom({ phase: "applied", operation_id: "op-9" }, "op-1"),
    code("state_identity_collision"),
  );
});

test("every park reason the contract closes can be produced", () => {
  const produced = new Set();
  const collect = (errors) => {
    for (const error of errors) produced.add(error.reason);
  };
  collect(validateDelta(delta({ entries: [entry({ path: "docs/x.md" })] })));
  collect(validateDelta({ ...delta(), delta_digest: "0".repeat(64) }));
  collect(validateDelta(delta({ entries: [entry({ status: "R" })] })));
  collect(environmentErrors({ GIT_DIR: "/x" }));
  collect(worktreeErrors({ dirty: true }));
  collect(collisionErrors(delta(), { untracked: ["src/store/creation.ts"] }));
  collect(collisionErrors(delta(), { ignored: ["src/store/creation.ts"] }));
  collect(integrationProof(delta(), result({ conflicts_resolved_by_new_content: true })));
  collect(refMovementErrors({ ...result().ref_movement, observed_old_oid: oid("f"), post_state: "unknown", reflog_entries: 2 }));
  try {
    resumeFrom({ phase: "applied", operation_id: "op-9" }, "op-1");
  } catch (error) {
    produced.add(error.code);
  }
  for (const reason of PARK_REASONS) {
    assert.ok(produced.has(reason), `${reason} is documented and never produced`);
  }
});
