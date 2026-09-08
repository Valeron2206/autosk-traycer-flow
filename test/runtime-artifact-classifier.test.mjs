/**
 * Tests for the artifact classifier (issue #14 runtime).
 *
 * The registry decides; the classifier only reads it. So these check the two
 * ways that goes wrong — a path nobody registered being given the cheapest
 * lifecycle, and two classes disagreeing about what a change means — plus the
 * one property that makes the registry worth having: it covers the repository
 * it claims to govern.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  CATEGORIES,
  PARK_REASONS,
  UNGOVERNED,
  classify,
  classifyChangeset,
  impactClosure,
  matchesPattern,
  matchingClasses,
} from "../src/host/artifact-classifier.mjs";
import { ROOT, changedPaths, loadRegistry, render } from "../scripts/classify-changeset.mjs";

const registry = loadRegistry();

const code = (name) => (error) => error.code === name;

/** A tiny registry, so a test about ambiguity is not a test about this project. */
const toy = {
  classes: [
    {
      class: "alpha",
      category: "behavior_defining",
      paths: ["docs/a/*.md"],
      review: { mode: "full_panel" },
      human_approval: "required",
      publication: "planning_ref",
      impacts: ["beta"],
    },
    {
      class: "beta",
      category: "behavior_defining",
      paths: ["docs/a/exact.md", "docs/b/**"],
      review: { mode: "narrow_review", condition: "x" },
      human_approval: "not_required",
      publication: "none",
      impacts: ["gamma"],
    },
    {
      class: "gamma",
      category: "explanatory",
      paths: ["docs/c/*.md"],
      review: { mode: "narrow_review", condition: "y" },
      human_approval: "not_required",
      publication: "none",
      impacts: [],
    },
    {
      class: "delta",
      category: "runtime_evidence",
      paths: ["docs/c/*.md"],
      review: { mode: "none" },
      human_approval: "not_required",
      publication: "none",
      impacts: [],
    },
  ],
};

test("the pattern language is exactly two metacharacters", () => {
  // A larger one would let a class quietly widen its own scope.
  assert.equal(matchesPattern("a/*.md", "a/b.md"), true);
  assert.equal(matchesPattern("a/*.md", "a/b/c.md"), false);
  assert.equal(matchesPattern("a/**", "a/b/c.md"), true);
  assert.equal(matchesPattern("a/**", "ab/c.md"), false);
  assert.equal(matchesPattern("a.md", "a.md"), true);
  assert.equal(matchesPattern("a.md", "aXmd"), false, "a dot is a dot");
  assert.equal(matchesPattern("resources/**/*.schema.json", "resources/x/y.schema.json"), true);
  assert.equal(matchesPattern("resources/**/*.schema.json", "resources/x/y.example.json"), false);
});

test("a path no class covers parks, and is not called explanatory", () => {
  // Being classified as explanatory because nothing else fit is how an artifact
  // acquires the cheapest lifecycle by accident.
  const parked = classify(toy, "docs/z/unknown.md");
  assert.equal(parked.status, "parked");
  assert.equal(parked.park_reason, "unknown_class");
  assert.ok(PARK_REASONS.includes(parked.park_reason));
});

test("two classes with different categories park rather than one being picked", () => {
  const parked = classify(toy, "docs/c/thing.md");
  assert.equal(parked.status, "parked");
  assert.equal(parked.park_reason, "ambiguous_class");
  assert.deepEqual(parked.candidates, ["delta", "gamma"]);
});

test("several classes of one category are not ambiguous, and the exact path owns it", () => {
  // The category decides the lifecycle; the most specific pattern decides who
  // owns the file.
  assert.equal(matchingClasses(toy, "docs/a/exact.md").length, 2);
  const owned = classify(toy, "docs/a/exact.md");
  assert.equal(owned.status, "classified");
  assert.equal(owned.class, "beta");
  assert.equal(classify(toy, "docs/a/other.md").class, "alpha");
});

test("git internals are ungoverned rather than parked", () => {
  for (const prefix of UNGOVERNED) {
    assert.equal(classify(registry, `${prefix}whatever`).status, "ungoverned");
  }
});

test("the impact closure is walked, not listed", () => {
  assert.deepEqual(impactClosure(toy, "alpha"), ["beta", "gamma"]);
  assert.deepEqual(impactClosure(toy, "gamma"), []);
  assert.throws(() => impactClosure(toy, "nothing"), code("unknown_class"));
});

test("a class impacting one that is not registered is drift, not an empty closure", () => {
  const drifted = { classes: [{ ...toy.classes[0], impacts: ["nowhere"] }] };
  assert.throws(() => impactClosure(drifted, "alpha"), code("registry_drift"));
});

test("a changeset takes the strictest review any of its files needs", () => {
  // Taking the gentlest would let one narrow-review file carry a
  // panel-reviewed one through.
  const mixed = classifyChangeset(toy, ["docs/a/other.md", "docs/b/x.json"]);
  assert.equal(mixed.review_mode, "full_panel");
  assert.equal(mixed.human_approval, "required");
  const narrow = classifyChangeset(toy, ["docs/b/x.json"]);
  assert.equal(narrow.review_mode, "narrow_review");
  assert.equal(narrow.human_approval, "not_required");
});

test("one parked path stops the whole changeset", () => {
  const outcome = classifyChangeset(toy, ["docs/b/x.json", "docs/z/unknown.md"]);
  assert.equal(outcome.admits, false);
  assert.equal(outcome.parked.length, 1);
  assert.equal(classifyChangeset(toy, ["docs/b/x.json"]).admits, true);
});

test("the changeset reports the classes a change reaches", () => {
  const outcome = classifyChangeset(toy, ["docs/a/other.md"]);
  assert.deepEqual(outcome.impacted_classes, ["alpha", "beta", "gamma"]);
});

test("every category the registry uses is one the classifier knows", () => {
  for (const entry of registry.classes) {
    assert.ok(CATEGORIES.includes(entry.category), `${entry.class}: ${entry.category}`);
  }
});

test("the registry covers the repository it claims to govern", () => {
  // §7: this repository governs itself. A file governed by nothing is not an
  // oversight to be argued about later — it is a missing registry entry, and
  // this is the check that makes adding one unavoidable.
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const outcome = classifyChangeset(registry, tracked);
  assert.deepEqual(
    outcome.parked.map((entry) => `${entry.path} (${entry.park_reason})`),
    [],
  );
  assert.ok(tracked.length > 100, "the tracked list looks too short to be the repository");
});

test("the CLI reads the same paths git would give a review", () => {
  const everything = changedPaths("");
  assert.ok(everything.includes("package.json"));
  const outcome = classifyChangeset(registry, ["docs/contracts/debate.md"]);
  const text = render(outcome);
  assert.match(text, /governance_defining\s+contract_document\s+docs\/contracts\/debate.md/u);
  assert.match(text, /review: full_panel/u);
  assert.match(render(classifyChangeset(registry, ["nowhere/at/all.txt"])), /PARKED unknown_class/u);
});
