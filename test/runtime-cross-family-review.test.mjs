/**
 * Tests for the single cross-family code review.
 *
 * The property being defended is independence: the reviewer's family did not
 * write any of what it is reading. Everything else here is a way that could
 * quietly stop being true — a fixer from the reviewer's family, a review that
 * did not happen because no family was left, an exemption argued rather than
 * classified, or a panel verdict standing in for a reading of the code.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { ROOT } from "../scripts/validate-artifact-registry.mjs";
import {
  NEVER_EXEMPT,
  REVIEWER_ORDER,
  ROUND_LIMIT,
  assertNotSubstitute,
  editorialExemption,
  narrowRereviewScope,
  normalizeFamily,
  reviewAdmission,
  reviewGate,
  reviewerRoute,
} from "../src/host/cross-family-review.mjs";

const code = (name) => (error) => error.code === name;
const CANDIDATE = "a".repeat(64);

const registry = JSON.parse(
  await readFile(path.join(ROOT, "resources/artifact-registry/artifact-registry.v1.json"), "utf8"),
);

test("the reviewer route is the design's table, read from the actual families", () => {
  // Author set -> reviewer order, exactly as section 6 states it.
  assert.deepEqual([...reviewerRoute({ authors: ["claude"] })], ["gpt", "kimi", "grok"]);
  assert.deepEqual([...reviewerRoute({ authors: ["codex"] })], ["kimi", "grok"]);
  assert.deepEqual([...reviewerRoute({ authors: ["grok"] })], ["gpt", "kimi"]);
  assert.deepEqual([...reviewerRoute({ authors: ["kimi"] })], ["gpt", "grok"]);
  assert.deepEqual([...reviewerRoute({ authors: ["human"] })], ["gpt", "kimi", "grok"]);
  // Mixed: the master order minus every family in the author/fixer set.
  assert.deepEqual([...reviewerRoute({ authors: ["claude", "kimi"] })], ["gpt", "grok"]);
  assert.deepEqual([...REVIEWER_ORDER], ["gpt", "kimi", "grok"]);
});

test("a fixer's family is excluded as firmly as an author's", () => {
  // A fixer from the reviewer's family makes the reviewer the author of part of
  // what they are reviewing.
  assert.deepEqual([...reviewerRoute({ authors: ["claude"], fixers: ["gpt"] })], ["kimi", "grok"]);
  assert.deepEqual([...reviewerRoute({ authors: ["claude"], fixers: ["codex"] })], ["kimi", "grok"]);
  assert.equal(normalizeFamily("codex"), "gpt");
  assert.equal(normalizeFamily("anthropic"), "claude");
  // A family with no name is not a family: the empty string would collapse two
  // participants into one and make a cross-family review look satisfied.
  assert.throws(() => normalizeFamily(""), (error) => error.code === "review_family_collision");
  assert.throws(() => normalizeFamily(undefined), (error) => error.code === "review_family_collision");
  assert.throws(() => normalizeFamily(undefined), code("review_family_collision"));
});

test("with no external family the review does not quietly not happen", () => {
  const admission = reviewAdmission({ authors: ["gpt", "kimi"], fixers: ["grok"] });
  assert.equal(admission.decision, "park");
  assert.equal(admission.reason, "review_no_external_family");
  // The three things a person can actually do about it.
  assert.deepEqual([...admission.options], ["human_review", "re_express_candidate", "exact_waiver"]);
  assert.ok(/gpt, grok, kimi/u.test(admission.detail), admission.detail);
});

test("the reviewer session is never one of the author sessions", () => {
  assert.equal(
    reviewAdmission({ authors: ["claude"], reviewerSession: "s-2", authorSessions: ["s-1"] }).decision,
    "review",
  );
  assert.throws(
    () => reviewAdmission({ authors: ["claude"], reviewerSession: "s-1", authorSessions: ["s-1", "s-3"] }),
    code("review_session_reused"),
  );
});

test("the full cycle has a limit, after which it is a person's", () => {
  assert.equal(reviewAdmission({ authors: ["claude"], round: ROUND_LIMIT }).decision, "review");
  const exhausted = reviewAdmission({ authors: ["claude"], round: ROUND_LIMIT + 1 });
  assert.equal(exhausted.decision, "park");
  assert.equal(exhausted.reason, "review_round_limit");
  assert.deepEqual([...exhausted.options], ["human_review", "re_express_candidate", "exact_waiver"]);
});

test("an editorial exemption is classified, not argued", () => {
  // A behaviour-defining file is never exempt, whatever the change is called.
  // An exemption with no candidate names nothing: it would cover whatever
  // candidate happened to be current when somebody read it.
  for (const identity of ["", undefined]) {
    assert.throws(
      () => editorialExemption(registry, { paths: ["a.md"], candidateIdentity: identity, declaredEditorial: true }),
      (error) => error.code === "review_exemption_not_permitted",
    );
  }
  const behaviour = editorialExemption(registry, {
    paths: ["src/host/panel.mjs"],
    candidateIdentity: CANDIDATE,
    declaredEditorial: true,
  });
  assert.equal(behaviour.exempt, false);
  assert.ok(/behavior_defining/u.test(behaviour.detail), behaviour.detail);

  // Nor is a governance document.
  const governance = editorialExemption(registry, {
    paths: ["04-decisions.md"],
    candidateIdentity: CANDIDATE,
    declaredEditorial: true,
  });
  assert.equal(governance.exempt, false);
  assert.deepEqual([...NEVER_EXEMPT], ["behavior_defining", "governance_defining"]);
});

test("an exemption names the exact candidate and the changed paths", () => {
  assert.throws(
    () => editorialExemption(registry, { paths: ["README.md"], declaredEditorial: true }),
    code("review_exemption_not_permitted"),
  );
  assert.throws(
    () => editorialExemption(registry, { paths: [], candidateIdentity: CANDIDATE, declaredEditorial: true }),
    code("review_exemption_not_permitted"),
  );
  // And a file nobody can classify cannot carry one either.
  const unknown = editorialExemption(registry, {
    paths: ["some/unregistered/file.txt"],
    candidateIdentity: CANDIDATE,
    declaredEditorial: true,
  });
  assert.equal(unknown.exempt, false);
  assert.ok(/parked/u.test(unknown.detail), unknown.detail);
});

test("an exemption that is not declared editorial is not one", () => {
  const undeclared = editorialExemption(registry, { paths: ["README.md"], candidateIdentity: CANDIDATE });
  assert.equal(undeclared.exempt, false);
  assert.equal(undeclared.reason, "review_exemption_not_permitted");
});

test("a narrow re-review covers the findings, the diff and what they touch", () => {
  const scope = narrowRereviewScope({
    openFindings: [{ id: "F-2", paths: ["src/a.mjs"] }, { id: "F-1", paths: ["src/b.mjs"] }],
    changedPaths: ["src/b.mjs", "src/c.mjs"],
    relatedPaths: ["test/b.test.mjs"],
  });
  assert.deepEqual([...scope.findings], ["F-1", "F-2"]);
  assert.deepEqual([...scope.paths], ["src/a.mjs", "src/b.mjs", "src/c.mjs", "test/b.test.mjs"]);
});

test("a panel verdict is not a code review", () => {
  // They answer different questions about different artifacts.
  assert.throws(() => assertNotSubstitute({ kind: "panel_verdict", outcome: "pass" }), code("review_not_a_panel"));
  assert.throws(
    () => assertNotSubstitute({ kind: "cross_family_review", seats: ["a", "b", "c", "d"] }),
    code("review_not_a_panel"),
  );
  assert.ok(assertNotSubstitute({ kind: "cross_family_review", outcome: "pass" }));
});

test("a candidate advances on a review of its exact bytes", () => {
  const review = { kind: "cross_family_review", outcome: "pass", family: "gpt", candidate_identity: CANDIDATE };
  assert.equal(reviewGate({ candidateIdentity: CANDIDATE, review }).decision, "proceed");
  // A PASS carried from an earlier candidate is a PASS about other bytes.
  const carried = reviewGate({ candidateIdentity: "b".repeat(64), review });
  assert.equal(carried.decision, "park");
  assert.ok(/is of/u.test(carried.detail));
  assert.equal(reviewGate({ candidateIdentity: CANDIDATE, review: null }).decision, "park");
  // And the gate itself refuses a panel verdict handed to it in place of one,
  // even when it is a PASS about this exact candidate.
  assert.throws(
    () => reviewGate({
      candidateIdentity: CANDIDATE,
      review: { kind: "panel_verdict", outcome: "pass", candidate_identity: CANDIDATE },
    }),
    code("review_not_a_panel"),
  );
  const failed = reviewGate({
    candidateIdentity: CANDIDATE,
    review: { ...review, outcome: "findings", findings: ["F-1"] },
  });
  assert.equal(failed.decision, "fix");
  assert.deepEqual([...failed.findings], ["F-1"]);
});
