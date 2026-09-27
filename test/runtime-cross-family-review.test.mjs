/**
 * Tests for the single cross-family code review.
 *
 * The property being defended is independence: the reviewer's family did not
 * write any of what it is reading. Everything else here is a way that could
 * quietly stop being true — a fixer from the reviewer's family, a review that
 * did not happen because no family was left, a label that names no family, an
 * exemption argued rather than classified, or a panel verdict standing in for a
 * reading of the code.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { ROOT } from "../scripts/validate-artifact-registry.mjs";
import { REQUIRED_PANEL } from "../scripts/validate-provider-preflight.mjs";
import * as review from "../src/host/cross-family-review.mjs";
import {
  NEVER_EXEMPT,
  PARK_REASONS,
  ROUND_LIMIT,
  assertNotSubstitute,
  editorialExemption,
  excludedFamilies,
  familyOf,
  modelOf,
  narrowRereviewScope,
  participantFamily,
  reviewAdmission,
  reviewGate,
  reviewerRoute,
} from "../src/host/cross-family-review.mjs";

const code = (name) => (error) => error.code === name;
const CANDIDATE = "a".repeat(64);

const registry = JSON.parse(
  await readFile(path.join(ROOT, "resources/artifact-registry/artifact-registry.v1.json"), "utf8"),
);
const partition = JSON.parse(
  await readFile(path.join(ROOT, "resources/panel-roster/family-partition.v1.json"), "utf8"),
);

// Participants are named by what they ran — a route or a model id — and the
// partition answers the family. These are the live roster's routes plus the
// Kimi route the unavailable-route example of provider preflight names.
const OPUS = "anthropic/claude-opus-5";
const CODEX = "openai-codex/gpt-6-astra";
const GROK = "cursor/cursor-grok-4.6";
const KIMI = "cursor/cursor-kimi-2.5";
const MUSE = "meta/muse-spark-1.3-contributor";

// The exact reviewer routes available: the live product roster. `REQUIRED_PANEL`
// is the set of routes the owner specified and provider preflight admits
// (decision 8b), and through the partition it is gpt, muse, grok and opus.
// Kimi has no route in it — `cursor-kimi-2.5` is the unavailable-route example
// — so a code review can never be dispatched to Kimi today.
const LIVE = REQUIRED_PANEL.map((seat) => seat.route_id);

const route = (participants) => [...reviewerRoute({ partition, ...participants })];

test("the reviewer route is the partition's master order minus every author family", () => {
  // Author set -> reviewer order, exactly as 01 §6 states it.
  assert.deepEqual(route({ authors: [OPUS] }), ["gpt", "kimi", "muse", "grok"]);
  assert.deepEqual(route({ authors: [CODEX] }), ["kimi", "muse", "grok", "opus"]);
  assert.deepEqual(route({ authors: [GROK] }), ["gpt", "kimi", "muse", "opus"]);
  assert.deepEqual(route({ authors: [KIMI] }), ["gpt", "muse", "grok", "opus"]);
  assert.deepEqual(route({ authors: [MUSE] }), ["gpt", "kimi", "grok", "opus"]);
  // A person is outside every model family and excludes no reviewer: Opus is
  // offered, which the three-family order this replaced never did (R5-16).
  assert.deepEqual(route({ authors: ["human"] }), ["gpt", "kimi", "muse", "grok", "opus"]);
  assert.deepEqual(route({ authors: ["human"] }), partition.master_order);
  // Mixed: the master order minus every family in the author/fixer set.
  assert.deepEqual(route({ authors: [OPUS, KIMI] }), ["gpt", "muse", "grok"]);
  assert.deepEqual(route({ authors: ["human", GROK] }), ["gpt", "kimi", "muse", "opus"]);
  // A model id resolves as its route does: the harness is not the family.
  assert.deepEqual(route({ authors: ["claude-opus-5"] }), route({ authors: [OPUS] }));
});

test("the order is read from the partition, not kept beside it", () => {
  // Two orders would mean one author set has two lawful reviewers depending
  // on which list was read.
  const reversed = { ...partition, master_order: [...partition.master_order].reverse() };
  assert.deepEqual([...reviewerRoute({ partition: reversed, authors: [OPUS] })], ["grok", "muse", "kimi", "gpt"]);
  assert.equal(review.REVIEWER_ORDER, undefined);
  assert.equal(review.FAMILY_ALIASES, undefined);
  assert.equal(review.normalizeFamily, undefined);
  // And without a partition there is nothing to read a family from.
  for (const missing of [undefined, {}, { families: partition.families }]) {
    assert.throws(() => reviewerRoute({ partition: missing, authors: [OPUS] }), code("review_family_unknown"));
  }
  assert.throws(() => participantFamily(OPUS, undefined), code("review_family_unknown"));
});

test("a fixer's family is excluded as firmly as an author's", () => {
  // A fixer from the reviewer's family makes the reviewer the author of part of
  // what they are reviewing.
  assert.deepEqual(route({ authors: [OPUS], fixers: [CODEX] }), ["kimi", "muse", "grok"]);
  assert.deepEqual(route({ authors: [OPUS], fixers: ["gpt-6-astra"] }), ["kimi", "muse", "grok"]);
  assert.deepEqual([...excludedFamilies({ partition, authors: [OPUS, "human"], fixers: [CODEX, "claude-opus-5"] })], ["gpt", "opus"]);
  assert.deepEqual([...excludedFamilies({ partition, authors: ["human"] })], []);
});

test("a label is not a family: what the partition does not name is refused by name", () => {
  // Panel round 5 (R5-16): `cursor` or `meta` as an author label excluded no
  // reviewer, and `anthropic` became `claude` where the partition says `opus`.
  // A harness, a vendor or a tool name is not a model, and a model the
  // partition does not name belongs to no family — so none of them is external.
  for (const label of ["cursor", "meta", "claude", "anthropic", "codex", "openai", "xai/grok-9.9-unlisted", "", undefined, 7]) {
    assert.throws(() => reviewerRoute({ partition, authors: [label] }), code("review_family_unknown"), String(label));
    assert.throws(() => reviewerRoute({ partition, authors: ["human"], fixers: [label] }), code("review_family_unknown"), String(label));
    assert.throws(() => reviewAdmission({ partition, reviewers: LIVE, authors: [label] }), code("review_family_unknown"), String(label));
  }
  // An author set nobody named excludes nobody, which is the same hole.
  for (const authors of [[], undefined, "human"]) {
    assert.throws(() => reviewerRoute({ partition, authors }), code("review_family_unknown"));
  }
  assert.ok(PARK_REASONS.includes("review_family_unknown"));
  assert.equal(PARK_REASONS.includes("review_family_collision"), false);
});

test("a family is the model's: Meta's Muse excludes Muse, not Kimi", () => {
  assert.equal(modelOf(OPUS), "claude-opus-5");
  assert.equal(modelOf("claude-opus-5"), "claude-opus-5");
  assert.equal(familyOf(OPUS, partition), "opus");
  assert.equal(familyOf(CODEX, partition), "gpt");
  assert.equal(familyOf(GROK, partition), "grok");
  assert.equal(familyOf(KIMI, partition), "kimi");
  assert.equal(familyOf(MUSE, partition), "muse");
  assert.equal(familyOf("cursor/muse-spark-1.3", partition), "muse");
  assert.equal(familyOf("cursor", partition), null);
  assert.equal(participantFamily("human", partition), null);
  assert.equal(participantFamily("cursor/muse-spark-1.3", partition), "muse");
  assert.deepEqual(route({ authors: ["cursor/muse-spark-1.3"] }), ["gpt", "kimi", "grok", "opus"]);
  assert.deepEqual(route({ authors: [KIMI] }).includes("muse"), true);
});

test("with no external family the review does not quietly not happen", () => {
  const admission = reviewAdmission({ partition, reviewers: LIVE, authors: [CODEX, KIMI, MUSE], fixers: [GROK, OPUS] });
  assert.equal(admission.decision, "park");
  assert.equal(admission.reason, "no_external_reviewer");
  // The three things a person can actually do about it.
  assert.deepEqual([...admission.options], ["human_review", "re_express_candidate", "exact_waiver"]);
  assert.equal(admission.detail, "every reviewer family also authored or fixed: gpt, grok, kimi, muse, opus");
  // A person among the authors changes nothing about which families are left.
  assert.equal(
    reviewAdmission({ partition, reviewers: LIVE, authors: ["human", CODEX, KIMI, MUSE], fixers: [GROK, OPUS] }).detail,
    admission.detail,
  );
  const open = reviewAdmission({ partition, reviewers: LIVE, authors: [CODEX, KIMI, MUSE], fixers: [GROK] });
  assert.equal(open.decision, "review");
  assert.equal(open.family, "opus");
});

test("a family with no exact reviewer route is skipped, and with none left the task parks", () => {
  // The 9f review (R9f-1): 01 §6 skips a family with no available exact
  // route, so Muse is first for Codex. The ranking alone said Kimi, which has
  // no route; and with Kimi the only family outside the set it admitted a
  // review nobody could run.
  assert.deepEqual([...reviewAdmission({ partition, reviewers: LIVE, authors: [CODEX] }).route], ["muse", "grok", "opus"]);
  assert.equal(reviewAdmission({ partition, reviewers: LIVE, authors: [CODEX] }).family, "muse");
  // A Kimi route that is available is offered in its master-order place.
  assert.equal(reviewAdmission({ partition, reviewers: [...LIVE, KIMI], authors: [CODEX] }).family, "kimi");
  const stranded = reviewAdmission({ partition, reviewers: LIVE, authors: [CODEX, MUSE, GROK, OPUS] });
  assert.equal(stranded.decision, "park");
  assert.equal(stranded.reason, "no_external_reviewer");
  assert.equal(stranded.detail, "no exact reviewer route for a family outside the authors and fixers: kimi");
  assert.deepEqual([...stranded.options], ["human_review", "re_express_candidate", "exact_waiver"]);
  assert.equal(reviewAdmission({ partition, reviewers: [], authors: [OPUS] }).decision, "park");
  // Availability is named, never assumed: without it the ranking would be
  // admitted unfiltered, which is the defect itself.
  assert.throws(() => reviewAdmission({ partition, authors: [CODEX] }), code("review_family_unknown"));
  assert.throws(() => reviewAdmission({ partition, reviewers: "gpt", authors: [CODEX] }), code("review_family_unknown"));
  assert.throws(() => reviewAdmission({ partition, reviewers: ["cursor"], authors: [CODEX] }), code("review_family_unknown"));
});

test("the admission names the exact route it admitted: the first listed route of the chosen family", () => {
  // The 9f re-review (R9f-7): a family can have more than one route — Muse is
  // served as meta/ and as cursor/ — and a family alone does not say which one
  // is dispatched. "The first available exact route" is the first one listed.
  assert.equal(reviewAdmission({ partition, reviewers: LIVE, authors: [CODEX] }).reviewer_route, MUSE);
  assert.equal(reviewAdmission({ partition, reviewers: LIVE, authors: [OPUS] }).reviewer_route, CODEX);
  const both = [OPUS, "cursor/muse-spark-1.3", GROK, MUSE];
  const first = reviewAdmission({ partition, reviewers: both, authors: [CODEX] });
  assert.equal(first.family, "muse");
  assert.equal(first.reviewer_route, "cursor/muse-spark-1.3");
  assert.equal(
    reviewAdmission({ partition, reviewers: [MUSE, OPUS, "cursor/muse-spark-1.3"], authors: [CODEX] }).reviewer_route,
    MUSE,
  );
  // A route of a family the order ranks lower is not the one admitted.
  assert.equal(reviewAdmission({ partition, reviewers: [OPUS, GROK], authors: [CODEX] }).reviewer_route, GROK);
  // A park admits no route.
  assert.equal(reviewAdmission({ partition, reviewers: LIVE, authors: [CODEX, MUSE, GROK, OPUS] }).reviewer_route, undefined);
});

test("the reviewer session is never one of the author sessions", () => {
  assert.equal(
    reviewAdmission({ partition, reviewers: LIVE, authors: [OPUS], reviewerSession: "s-2", authorSessions: ["s-1"] }).decision,
    "review",
  );
  assert.throws(
    () => reviewAdmission({ partition, reviewers: LIVE, authors: [OPUS], reviewerSession: "s-1", authorSessions: ["s-1", "s-3"] }),
    code("review_session_reused"),
  );
});

test("the full cycle has a limit, after which it is a person's", () => {
  assert.equal(reviewAdmission({ partition, reviewers: LIVE, authors: [OPUS], round: ROUND_LIMIT }).decision, "review");
  assert.equal(reviewAdmission({ partition, reviewers: LIVE, authors: [OPUS], round: ROUND_LIMIT }).family, "gpt");
  const exhausted = reviewAdmission({ partition, reviewers: LIVE, authors: [OPUS], round: ROUND_LIMIT + 1 });
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

test("the host parks a missing external reviewer or Lead with the graph's names", async () => {
  // R6-25: review_no_external_family and panel_lead_not_external stood beside
  // the graph's no_external_reviewer and no_external_panel_lead, two names for
  // one stop. The retired names appear in no runtime file and no design text
  // but the decision log.
  const { readFileSync, readdirSync } = await import("node:fs");
  const at = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
  const texts = [
    ...readdirSync(new URL("../src/host/", import.meta.url)).filter((name) => name.endsWith(".mjs")).map((name) => `src/host/${name}`),
    ...readdirSync(new URL("../docs/contracts/", import.meta.url)).filter((name) => name.endsWith(".md")).map((name) => `docs/contracts/${name}`),
    "01-core-flows.md", "02-architecture.md", "03-technical-plan.md", "scripts/validate-finding-registry.mjs",
  ];
  for (const relative of texts) {
    assert.doesNotMatch(at(relative), /review_no_external_family|panel_lead_not_external/u, relative);
  }
  const vocabulary = JSON.parse(at("resources/refusal-vocabulary/refusal-vocabulary.v1.json"));
  for (const [reason, file] of [["no_external_reviewer", "src/host/cross-family-review.mjs"], ["no_external_panel_lead", "src/host/panel.mjs"]]) {
    const entry = vocabulary.park_reasons.find((item) => item.code === reason);
    assert.equal(entry.producer, "host", reason);
    assert.ok(entry.producer_files.includes(file), reason);
  }
});
