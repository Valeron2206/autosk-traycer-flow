/**
 * Tests for the delivery profile at runtime (issue #17).
 *
 * The profile exists so that "this project does not allow that" is discovered
 * before commits are produced against the assumption that it does. These cases
 * are the delivery policies a real project imposes, read through the profile at
 * the operation that cannot be undone.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  DIRECT_MODES,
  INTEGRATION_MODES,
  PARK_REASONS,
  canonicalValue,
  credentialErrors,
  directMovementAdmission,
  discoveryOutcome,
  driftErrors,
  finalIntegrationPlan,
  profileDigest,
  requiredCheckErrors,
  resolutionErrors,
  valueAt,
} from "../src/host/delivery-profile.mjs";
import { ROOT } from "../scripts/validate-delivery-profile.mjs";

const code = (name) => (error) => error.code === name;
const NOW = Date.parse("2026-09-08T06:30:00Z");
const LATER = Date.parse("2026-09-08T08:00:00Z");
const COMMIT = "b".repeat(40);

const example = JSON.parse(
  await readFile(path.join(ROOT, "resources/delivery-profile/delivery-profile.example.json"), "utf8"),
);

/** The shipped example is the PR-only profile; the variants are built from it. */
function profile(overrides = {}) {
  const merged = structuredClone(example);
  for (const [section, value] of Object.entries(overrides)) {
    merged[section] = value && typeof value === "object" && !Array.isArray(value)
      ? { ...merged[section], ...value }
      : value;
  }
  merged.profile_digest = profileDigest(merged);
  return merged;
}

const unprotected = () => profile({
  target: { direct_push_allowed: true },
  integration: { allowed_modes: ["merge", "squash"], final_push: "host", merge_queue_required: false },
});

test("a pull-request-only profile refuses direct target movement", () => {
  // The whole point: approved commits produced against the assumption that a
  // local CAS is allowed would be undeliverable without rewriting history.
  const admission = directMovementAdmission(example, { mode: "squash", nowMs: NOW });
  assert.equal(admission.decision, "refused");
  assert.ok(admission.reasons.some((reason) => /direct push is not allowed/u.test(reason.detail)));
  assert.equal(finalIntegrationPlan(example, { mode: "pull_request", nowMs: NOW }).action, "open_pull_request");
  assert.equal(finalIntegrationPlan(example, { mode: "squash", nowMs: NOW }).action, "park");
});

test("a local unprotected branch admits the movement it allows, and only that", () => {
  const local = unprotected();
  assert.equal(directMovementAdmission(local, { mode: "merge", nowMs: NOW }).decision, "may_move_target");
  assert.equal(finalIntegrationPlan(local, { mode: "merge", nowMs: NOW }).action, "move_target");
  // Rebase is a mode this project did not allow, and "it would work" is not
  // permission.
  const rebase = directMovementAdmission(local, { mode: "rebase", nowMs: NOW });
  assert.equal(rebase.decision, "refused");
  assert.deepEqual([...rebase.reasons.map((reason) => reason.reason)], ["unsupported_integration_mode"]);
  assert.deepEqual(DIRECT_MODES.slice(), ["merge", "squash", "rebase"]);
  assert.equal(INTEGRATION_MODES.length, 6);
});

test("a merge queue owns the final movement, whatever else the profile allows", () => {
  const queued = profile({
    target: { direct_push_allowed: true },
    integration: {
      allowed_modes: ["merge", "merge_queue"],
      final_push: "host",
      merge_queue_required: true,
    },
  });
  const admission = directMovementAdmission(queued, { mode: "merge", nowMs: NOW });
  assert.equal(admission.decision, "refused");
  assert.ok(admission.reasons.some((reason) => /merge queue/u.test(reason.detail)));
  assert.equal(finalIntegrationPlan(queued, { mode: "merge_queue", nowMs: NOW }).action, "enqueue");
});

test("a target the host is allowed to move, but is not the one who pushes", () => {
  // Direct push is permitted here and the final push is somebody else's step.
  // "Allowed" and "ours to do" are two different facts.
  const delegated = profile({
    target: { direct_push_allowed: true },
    integration: { allowed_modes: ["merge"], final_push: "external", merge_queue_required: false },
  });
  const admission = directMovementAdmission(delegated, { mode: "merge", nowMs: NOW });
  assert.equal(admission.decision, "refused");
  assert.ok(admission.reasons.some((reason) => /not the host's to make/u.test(reason.detail)));
  assert.equal(finalIntegrationPlan(delegated, { mode: "merge", nowMs: NOW }).action, "park");
});

test("a fork workflow is a pull request from somewhere the host does not push", () => {
  const forked = profile({
    integration: {
      allowed_modes: ["fork_pull_request"],
      final_push: "external",
      pull_request: "host",
    },
    remotes: { strategy: "fork" },
  });
  const plan = finalIntegrationPlan(forked, { mode: "fork_pull_request", nowMs: NOW });
  assert.equal(plan.action, "open_pull_request");
  assert.equal(plan.responsibility, "host");
  assert.equal(directMovementAdmission(forked, { mode: "merge", nowMs: NOW }).decision, "refused");
});

test("signing and DCO are recorded with how the host reproduces them", () => {
  // A requirement nobody can reproduce is a requirement that will be discovered
  // at the push.
  assert.equal(example.authorship.signing, "ssh");
  assert.ok(example.authorship.signing_reproduction.length > 0);
  assert.equal(example.authorship.dco, "required");
  assert.ok(example.binding_fields.includes("authorship/signing"));
  assert.ok(example.binding_fields.includes("authorship/dco"));
  // And changing either is drift, not a detail.
  const unsigned = profile({ authorship: { signing: "none", dco: "not_required" } });
  const drift = driftErrors(example, unsigned);
  assert.ok(drift.some((error) => /authorship\/signing/u.test(error.detail)));
  assert.ok(drift.some((error) => /authorship\/dco/u.test(error.detail)));
});

test("a required check is bound to the exact commit it ran on", () => {
  const results = example.checks.required.map((check) => ({
    name: check.name,
    commit_oid: COMMIT,
    conclusion: "success",
  }));
  assert.deepEqual(requiredCheckErrors(example, { results, commitOid: COMMIT }), []);
  // A green check on another commit is a fact about another commit.
  const elsewhere = results.map((result) => ({ ...result, commit_oid: "c".repeat(40) }));
  const wrongCommit = requiredCheckErrors(example, { results: elsewhere, commitOid: COMMIT });
  assert.equal(wrongCommit.length, example.checks.required.length);
  assert.ok(wrongCommit.every((error) => /ran on/u.test(error.detail)));
  assert.equal(requiredCheckErrors(example, { results: [], commitOid: COMMIT }).length, 2);
  // And a required check that ran here and failed is a failure, not a result.
  const failedHere = [{ ...results[0], conclusion: "failure" }, results[1]];
  const failures = requiredCheckErrors(example, { results: failedHere, commitOid: COMMIT });
  assert.equal(failures.length, 1);
  assert.ok(/validate: failure/u.test(failures[0].detail), failures[0].detail);
});

test("a check added mid-run invalidates a result that never ran it; one removed validates nothing", () => {
  const results = example.checks.required.map((check) => ({
    name: check.name,
    commit_oid: COMMIT,
    conclusion: "success",
  }));
  const added = profile({
    checks: {
      ...example.checks,
      required: [...example.checks.required, { name: "security", provenance: example.checks.required[0].provenance }],
    },
  });
  assert.ok(
    requiredCheckErrors(added, { results, commitOid: COMMIT }).some((error) => /security: no result/u.test(error.detail)),
  );
  // The asymmetry: dropping the requirement does not turn a failure into a pass.
  const failed = [...results, { name: "security", commit_oid: COMMIT, conclusion: "failure" }];
  assert.ok(
    requiredCheckErrors(example, { results: failed, commitOid: COMMIT })
      .some((error) => /no longer required/u.test(error.detail)),
  );
});

test("discovery is evidence with a shelf life", () => {
  // Branch protection read an hour ago may not hold now.
  assert.deepEqual(resolutionErrors(example, { nowMs: NOW }), []);
  const expired = resolutionErrors(example, { nowMs: LATER });
  assert.ok(expired.some((error) => error.reason === "discovery_expired"));
  assert.equal(directMovementAdmission(unprotected(), { mode: "merge", nowMs: LATER }).decision, "refused");
});

test("an unresolved field is not a field with a convenient default", () => {
  const unknown = profile({
    unresolved: [{ field: "target/direct_push_allowed", reason: "discovery_unavailable" }],
  });
  const errors = resolutionErrors(unknown, { nowMs: NOW });
  assert.ok(errors.some((error) => error.reason === "discovery_unavailable"));
  // A reason that is not a fact about resolution has no business in the lock.
  const wrong = profile({ unresolved: [{ field: "target/direct_push_allowed", reason: "profile_drift" }] });
  assert.throws(() => resolutionErrors(wrong, { nowMs: NOW }), code("unknown_binding_field"));
  // A binding field with no value at all is unknown, not false.
  const missing = structuredClone(example);
  delete missing.target.direct_push_allowed;
  assert.ok(
    resolutionErrors(missing, { nowMs: NOW })
      .some((error) => error.reason === "unknown_binding_field" && error.detail.includes("direct_push_allowed")),
  );
});

test("a forge that could not be reached and a token that may not read are different problems", () => {
  assert.equal(discoveryOutcome({ reachable: false }).reason, "remote_unreachable");
  assert.equal(discoveryOutcome({ reachable: true, permitted: false }).reason, "permission_denied");
  assert.equal(discoveryOutcome({ reachable: true, permitted: true, available: false }).reason, "discovery_unavailable");
  assert.equal(discoveryOutcome({ reachable: true, permitted: true, available: true }).ok, true);
  for (const outcome of ["remote_unreachable", "permission_denied", "discovery_unavailable"]) {
    assert.ok(PARK_REASONS.includes(outcome));
  }
});

test("a human override is bound to the field it decided, and nothing else", () => {
  // The example's remotes strategy is a human decision with an exact scope.
  assert.equal(example.provenance.remotes.source, "human_decision");
  assert.deepEqual(example.provenance.remotes.decision_scope, ["remotes.strategy"]);
  assert.deepEqual(resolutionErrors(example, { nowMs: NOW, fields: ["remotes/strategy"] }), []);
  // Changing the decided field is drift like any other binding change.
  assert.ok(
    driftErrors(example, profile({ remotes: { strategy: "fork" } }))
      .some((error) => /remotes\/strategy/u.test(error.detail)),
  );
});

test("drift is content, not the order the profile was written in", () => {
  const reordered = structuredClone(example);
  reordered.integration.allowed_modes = [...example.integration.allowed_modes].reverse();
  reordered.profile_digest = profileDigest(reordered);
  // A re-resolution that returned the same permissions in another order is not
  // a different delivery.
  assert.deepEqual(driftErrors(example, reordered), []);
  assert.equal(reordered.profile_digest, example.profile_digest);
  assert.equal(canonicalValue(["b", "a"]), canonicalValue(["a", "b"]));
  assert.equal(valueAt(example, "integration/local_staging"), "host");
});

test("a digest that does not recompute is drift on its own", () => {
  const tampered = structuredClone(example);
  tampered.integration.allowed_modes = ["merge"];
  assert.ok(driftErrors(tampered, tampered).some((error) => /does not recompute/u.test(error.detail)));
});

test("a credential in a project artifact is refused wherever it is nested", () => {
  assert.deepEqual(credentialErrors(example), []);
  const leaked = profile({ remotes: { credential_location: `ghp_${"A".repeat(36)}` } });
  assert.ok(credentialErrors(leaked).some((error) => error.reason === "credential_missing"));
  assert.ok(
    credentialErrors({ evidence: [{ note: "-----BEGIN OPENSSH PRIVATE KEY-----" }] })
      .some((error) => error.detail.startsWith("/evidence/0/note")),
  );
});
