/**
 * Tests for the artifact classifier (issue #14 runtime).
 *
 * The registry decides; the classifier only reads it. So these check the two
 * ways that goes wrong — a path nobody registered being given the cheapest
 * lifecycle, and two classes disagreeing about what a change means — plus the
 * one property that makes the registry worth having: it covers the repository
 * it claims to govern. A path the classifier cannot route parks as one stop,
 * the workflow graph's `artifact_mapping_required`, and the park says why
 * (debt 12d, R8-6).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CATEGORIES,
  PARK_CAUSES,
  PARK_REASON,
  PARK_REASONS,
  UNGOVERNED,
  classify,
  classifyChangeset,
  impactClosure,
  matchesPattern,
  matchingClasses,
} from "../src/host/artifact-classifier.mjs";
import { index, permitsResume } from "../src/host/workflow-factory.mjs";
import { REMEDIES, ROOT, changedPaths, loadRegistry, parkKind, render } from "../scripts/classify-changeset.mjs";

const registry = loadRegistry();

const code = (name) => (error) => error.code === name;

/**
 * A tiny registry, so a test about ambiguity is not a test about this project.
 * Every class says v1 governs it (debt 11g): a class that does not say so is
 * refused, which is its own test below.
 */
const toy = {
  classes: [
    {
      class: "alpha",
      lifecycle: "required_for_v1",
      category: "behavior_defining",
      paths: ["docs/a/*.md"],
      review: { mode: "full_panel" },
      human_approval: "required",
      publication: "planning_ref",
      impacts: ["beta"],
    },
    {
      class: "beta",
      lifecycle: "required_for_v1",
      category: "behavior_defining",
      paths: ["docs/a/exact.md", "docs/b/**"],
      review: { mode: "narrow_review", condition: "x" },
      human_approval: "not_required",
      publication: "none",
      impacts: ["gamma"],
    },
    {
      class: "gamma",
      lifecycle: "required_for_v1",
      category: "explanatory",
      paths: ["docs/c/*.md"],
      review: { mode: "narrow_review", condition: "y" },
      human_approval: "not_required",
      publication: "none",
      impacts: [],
    },
    {
      class: "delta",
      lifecycle: "required_for_v1",
      category: "runtime_evidence",
      paths: ["docs/c/*.md"],
      review: { mode: "none" },
      human_approval: "not_required",
      publication: "none",
      impacts: [],
    },
  ],
};

/** A path a registry pattern covers: `**` and `*` filled in, nothing else changed. */
const instanceOf = (pattern) => pattern.replaceAll("**", "deep/er").replaceAll("*", "x");

/** The fields a classified path carries that route it to a review, an approval or a publication. */
const ROUTING = ["class", "category", "review", "human_approval", "publication"];

const AUTOBUILD_RUN = "docs/autosk/epics/e1/autobuild/r1/run.json";

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
  assert.equal(parked.park_reason, "artifact_mapping_required");
  assert.equal(parked.cause, "unknown_class");
  assert.ok(PARK_REASONS.includes(parked.park_reason));
});

test("two classes with different categories park rather than one being picked", () => {
  const parked = classify(toy, "docs/c/thing.md");
  assert.equal(parked.status, "parked");
  assert.equal(parked.park_reason, "artifact_mapping_required");
  assert.equal(parked.cause, "ambiguous_class");
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
  assert.deepEqual(outcome.parked.map((entry) => [entry.park_reason, entry.cause]), [["artifact_mapping_required", "unknown_class"]]);
  assert.equal(classifyChangeset(toy, ["docs/b/x.json"]).admits, true);
});

test("the changeset reports the classes a change reaches", () => {
  const outcome = classifyChangeset(toy, ["docs/a/other.md"]);
  assert.deepEqual(outcome.impacted_classes, ["alpha", "beta", "gamma"]);
});

test("the Autobuild run record is refused by name, not routed to publication", () => {
  // Round 7 of #39 (R7-12): this path was classified `autobuild_run` and sent
  // to planning-ref publication with human approval, for a capability whose
  // workflow v1 does not register.
  const refused = classify(registry, AUTOBUILD_RUN);
  assert.deepEqual(refused, {
    status: "parked",
    path: AUTOBUILD_RUN,
    park_reason: "artifact_mapping_required",
    cause: "class_not_v1",
    candidates: ["autobuild_run"],
    lifecycle: "planned_after_v1",
    decided_by: "#28",
  });
  assert.ok(PARK_REASONS.includes(refused.park_reason));
  for (const field of ROUTING) assert.equal(Object.hasOwn(refused, field), false, `${field} routes the path`);
});

test("the typed SDK write record is refused by name: #38 is after v1", () => {
  // Review of 11g (H1): matrix v1 puts six issues after v1, and #38 is one;
  // its class stayed `required_for_v1`, so this path was still classified,
  // `narrow_review`, for a write API v1 does not implement.
  const path = ".autosk-evidence/e1/sdk-writes/op.json";
  assert.deepEqual(classify(registry, path), {
    status: "parked",
    path,
    park_reason: "artifact_mapping_required",
    cause: "class_not_v1",
    candidates: ["sdk_write_operation"],
    lifecycle: "planned_after_v1",
    decided_by: "#38",
  });
});

test("every path of a class v1 governs classifies, and every path of one it does not is refused", () => {
  // Coverage counts v1 classes only: a class planned after v1, or waiting for
  // a successor matrix, is registered so its paths are known and refused so
  // that registering it governs nothing.
  const refused = [];
  for (const entry of registry.classes) {
    for (const pattern of entry.paths) {
      const result = classify(registry, instanceOf(pattern));
      if (entry.lifecycle === "required_for_v1") {
        assert.equal(result.status, "classified", `${entry.class}: ${pattern}`);
        assert.equal(result.class, entry.class, `${entry.class}: ${pattern}`);
      } else {
        assert.equal(result.status, "parked", `${entry.class}: ${pattern}`);
        assert.equal(result.park_reason, "artifact_mapping_required", `${entry.class}: ${pattern}`);
        assert.equal(result.cause, "class_not_v1", `${entry.class}: ${pattern}`);
        assert.deepEqual(result.candidates, [entry.class], `${entry.class}: ${pattern}`);
        assert.equal(result.lifecycle, entry.lifecycle, `${entry.class}: ${pattern}`);
        assert.equal(result.decided_by, entry.decided_by, `${entry.class}: ${pattern}`);
        for (const field of ROUTING) assert.equal(Object.hasOwn(result, field), false, `${entry.class}: ${field}`);
        refused.push(entry.class);
      }
    }
  }
  assert.deepEqual([...new Set(refused)].sort(), [
    "autobuild_run", "changeset_walkthrough", "cost_watch_registry", "debate_manifest",
    "housekeeping_report", "reflect_pass", "sdk_write_operation", "static_analysis_policy", "static_analysis_result",
  ]);
});

test("a v1 class still classifies and keeps its route", () => {
  const tickets = classify(registry, "docs/autosk/epics/e1/tickets/tickets.manifest.json");
  assert.equal(tickets.status, "classified");
  assert.equal(tickets.class, "tickets");
  assert.equal(tickets.publication, "planning_ref");
  assert.equal(tickets.human_approval, "required");
  assert.equal(Object.hasOwn(tickets, "lifecycle"), false, "a classified path needs no lifecycle: it is v1's");
});

test("a class that does not say v1 governs it is not governed", () => {
  // The carrier rule mirrored (ADR-093): a mapping that does not say it is
  // dispatched in v1 is not dispatched, and a class that does not say it is
  // governed in v1 is not governed.
  const unmarked = { classes: [{ ...toy.classes[0], lifecycle: undefined }] };
  assert.deepEqual(classify(unmarked, "docs/a/one.md"), {
    status: "parked",
    path: "docs/a/one.md",
    park_reason: "artifact_mapping_required",
    cause: "class_not_v1",
    candidates: ["alpha"],
    lifecycle: null,
    decided_by: null,
  });
});

test("the owner is chosen before its lifecycle is read, so a v1 class never takes a refused path", () => {
  // Never a class chosen because it was the only one left: dropping the
  // post-v1 class before matching would hand its most specific path to the
  // generic v1 class beside it.
  const later = { lifecycle: "planned_after_v1", decided_by: "#28" };
  const nested = {
    classes: [
      { ...toy.classes[0], class: "general", paths: ["docs/p/**"] },
      { ...toy.classes[0], ...later, class: "specific", paths: ["docs/p/exact.md"] },
    ],
  };
  assert.equal(classify(nested, "docs/p/other.md").class, "general");
  const refused = classify(nested, "docs/p/exact.md");
  assert.equal(refused.status, "parked");
  assert.deepEqual(refused.candidates, ["specific"]);
  // And the other way round: the specific v1 class keeps its own path.
  const inverted = {
    classes: [
      { ...toy.classes[0], ...later, class: "general", paths: ["docs/p/**"] },
      { ...toy.classes[0], class: "specific", paths: ["docs/p/exact.md"] },
    ],
  };
  assert.equal(classify(inverted, "docs/p/exact.md").class, "specific");
  assert.deepEqual(classify(inverted, "docs/p/other.md").candidates, ["general"]);
});

test("a changeset touching a path v1 does not govern is not admitted, and asks for nothing", () => {
  const outcome = classifyChangeset(registry, [AUTOBUILD_RUN]);
  assert.equal(outcome.admits, false);
  assert.deepEqual(outcome.parked.map((entry) => entry.candidates), [["autobuild_run"]]);
  // No review, no approval and no impact: nothing is routed for a class v1
  // does not govern.
  assert.equal(outcome.review_mode, "none");
  assert.equal(outcome.human_approval, "not_required");
  assert.deepEqual(outcome.impacted_classes, []);
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
  // Tracked *and* untracked-but-not-ignored. Reading only the index meant a new
  // file's governance went unchecked until it was committed — which is after
  // the point where adding a registry entry is cheap. This check found its own
  // gap: `resources/arena/*.json` collided with two classes, and only CI saw it,
  // because locally the files were not in the index yet.
  const tracked = execFileSync("git", ["ls-files", "-c", "-o", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const outcome = classifyChangeset(registry, tracked);
  assert.deepEqual(
    outcome.parked.map((entry) => `${entry.path} (${entry.park_reason}: ${entry.cause})`),
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
  const nowhere = render(classifyChangeset(registry, ["nowhere/at/all.txt"]));
  assert.match(nowhere, /PARKED artifact_mapping_required \(unknown_class\)\s+nowhere\/at\/all\.txt/u);
  assert.match(nowhere, /1 path\(s\) are governed by no class/u);
  assert.doesNotMatch(nowhere, /does not govern/u);
  assert.doesNotMatch(text, /does not govern|governed by no class/u, "an admitted changeset has no remedy line");
  // A class v1 does not govern is named with its lifecycle and its issue, and
  // the remedy is not "add a registry entry": it is registered already.
  const later = render(classifyChangeset(registry, [AUTOBUILD_RUN]));
  assert.match(later, /PARKED artifact_mapping_required \(class_not_v1\)\s+autobuild_run \(planned_after_v1, #28\)\s+docs\/autosk\/epics\/e1\/autobuild\/r1\/run\.json/u);
  assert.match(later, /1 path\(s\) belong to a class v1 does not govern/u);
  assert.doesNotMatch(later, /governed by no class/u);
});

test("each parked path is given the remedy of its own reason", () => {
  // Review of 11g (L1, L4): a class with no lifecycle printed `(null, null)`
  // and was told a registry entry would not help, when giving the class its
  // lifecycle is the remedy; and an ambiguous path was told no class governs
  // it, when two do.
  const unmarked = { classes: [{ ...toy.classes[0], lifecycle: undefined }] };
  const bare = render(classifyChangeset(unmarked, ["docs/a/one.md"]));
  assert.match(bare, /PARKED artifact_mapping_required \(class_not_v1\)\s+alpha \(no lifecycle\)\s+docs\/a\/one\.md/u);
  assert.match(bare, /1 path\(s\) belong to a class that does not say whether v1 governs it; give the class its lifecycle in the registry\./u);
  assert.doesNotMatch(bare, /null|activates it|governed by no class/u);
  const ambiguous = render(classifyChangeset(toy, ["docs/c/thing.md"]));
  assert.match(ambiguous, /PARKED artifact_mapping_required \(ambiguous_class\)\s+delta,gamma\s+docs\/c\/thing\.md/u);
  assert.match(ambiguous, /1 path\(s\) are claimed by classes of different categories; narrow the patterns so that one class owns each path\./u);
  assert.doesNotMatch(ambiguous, /governed by no class|does not govern/u);
  // Parks of the four kinds are counted apart, one line each.
  const four = {
    classes: [
      ...toy.classes,
      { ...toy.classes[0], class: "later", lifecycle: "planned_after_v1", decided_by: "#28", paths: ["docs/later/*.md"] },
      { ...toy.classes[0], class: "bare", lifecycle: undefined, paths: ["docs/bare/*.md"] },
    ],
  };
  const mixed = render(classifyChangeset(four, ["docs/z/one.md", "docs/c/two.md", "docs/later/three.md", "docs/bare/four.md", "docs/z/five.md"]));
  assert.match(mixed, /^2 path\(s\) are governed by no class; add a registry entry rather than guessing the review\.$/mu);
  assert.match(mixed, /^1 path\(s\) are claimed by classes of different categories; /mu);
  assert.match(mixed, /^1 path\(s\) belong to a class v1 does not govern; /mu);
  assert.match(mixed, /^1 path\(s\) belong to a class that does not say whether v1 governs it; /mu);
});

test("a class a successor matrix decides is told it waits for one, not for its issue", () => {
  // Narrow re-review of 11g: #47 is outside matrix v1, so no issue of it
  // activates its classes; a successor matrix has to classify #47 first.
  const successor = render(classifyChangeset(registry, ["resources/static-analysis/static-analysis-policy.v1.json"]));
  assert.match(successor, /PARKED artifact_mapping_required \(class_not_v1\)\s+static_analysis_policy \(successor_matrix_candidate, #47\)/u);
  assert.match(successor, /1 path\(s\) belong to a class that waits for a successor matrix; v1 governs it only once a successor matrix classifies its issue\./u);
  assert.doesNotMatch(successor, /activates it|governed by no class/u);
});

// Debt 12d (R8-6): a path the classifier cannot route parks as one stop, the
// workflow graph's `artifact_mapping_required`, whose recovery row says where
// the task resumes; what stopped it is the park's cause.

/** The workflow graph, whose recovery rows say where a stop resumes. */
const graph = JSON.parse(readFileSync(path.join(ROOT, "resources/workflow-graph/workflow-graph.v1.json"), "utf8"));

test("every park is the graph's artifact_mapping_required stop, which has a recovery row, and the park says why it stopped (R8-6)", () => {
  // Round 8 of #39, R8-6: the classifier parked a path as `unknown_class` —
  // no class governs it, or, since ADR-101, its class is not v1's — or as
  // `ambiguous_class`, and neither is a reason the workflow graph's recovery
  // rows or the refusal vocabulary carry, so a task stopped there had no row
  // and no resume target: the factory refused every resume ("has no recovery
  // row"). The park is the graph's stop for an artifact no lifecycle governs,
  // and what stopped it is the park's cause.
  const unmarked = { classes: [...toy.classes, { ...toy.classes[0], class: "bare", lifecycle: undefined, paths: ["docs/bare/*.md"] }] };
  const parks = [
    [classify(toy, "docs/z/unknown.md"), "unknown_class"],
    [classify(registry, "nowhere/at/all.txt"), "unknown_class"],
    [classify(toy, "docs/c/thing.md"), "ambiguous_class"],
    [classify(registry, AUTOBUILD_RUN), "class_not_v1"],
    [classify(registry, "resources/static-analysis/static-analysis-policy.v1.json"), "class_not_v1"],
    [classify(unmarked, "docs/bare/one.md"), "class_not_v1"],
  ];
  // Every park is one stop, so the row that recovers it is one row. Where a
  // task resumes depends on the step it stood at, which the park records as
  // its origin (the row is scoped to its origin's edges, review M1): a Quick
  // or a Ticket stopped at freeze re-freezes once the registry names the path
  // and is never lent the Epic's draft_artifact; the Epic stopped at
  // freeze_artifact re-freezes or redrafts.
  const state = index(graph);
  for (const [park] of parks) assert.equal(park.status, "parked", park.path);
  assert.deepEqual([...new Set(parks.map(([park]) => park.park_reason))], [PARK_REASON]);
  const admittedFrom = (origin) => graph.recovery.find((row) => row.reason === PARK_REASON).resume_targets.filter((target) => {
    try {
      return permitsResume(state, PARK_REASON, target, { origin });
    } catch {
      return false;
    }
  });
  assert.deepEqual(admittedFrom("freeze"), ["freeze", "human"], "a Quick or Ticket stop");
  assert.deepEqual(
    admittedFrom("freeze_artifact"),
    ["clarify_alignment", "draft_artifact", "freeze_artifact", "human", "present_tickets_breakdown"],
    "an Epic stop",
  );
  const rows = new Map(graph.recovery.map((row) => [row.reason, row]));
  for (const [park, cause] of parks) {
    assert.equal(park.park_reason, "artifact_mapping_required", park.path);
    assert.equal(park.park_reason, PARK_REASON, park.path);
    assert.equal(park.cause, cause, park.path);
    assert.ok(PARK_REASONS.includes(park.park_reason), park.path);
  }
  // A cause is not a park reason: it has no row of its own and is not in the
  // closed set of park reasons.
  assert.deepEqual([...PARK_CAUSES], ["unknown_class", "ambiguous_class", "class_not_v1"]);
  for (const cause of PARK_CAUSES) {
    assert.equal(rows.has(cause), false, `${cause} has a recovery row of its own`);
    assert.equal(PARK_REASONS.includes(cause), false, `${cause} is listed as a park reason`);
  }
  // The row parks where a candidate is routed by its classes: a Quick's or a
  // Ticket's code at `freeze`, a planning artifact at `freeze_artifact`.
  assert.deepEqual([...rows.get(PARK_REASON).parks_at].sort(), ["freeze", "freeze_artifact"]);
});

test("a Quick or Ticket parked at freeze resumes at freeze once the registry routes the path, and is lent no Epic step (review M1)", () => {
  // The common park: ordinary code or config no class governs
  // (`unknown_class`), which lands at the freeze a Quick's or a Ticket's code
  // is routed at. Its only ways out were a person's stop and the Epic's
  // draft_artifact, so after the remedy nothing re-ran the freeze.
  const state = index(graph);
  for (const path of ["lib/util.js", "Makefile", "migrations/001.sql", "config/app.yaml"]) {
    const parked = classify(registry, path);
    assert.equal(parked.status, "parked", path);
    assert.equal(parked.cause, "unknown_class", path);
    assert.equal(parked.park_reason, PARK_REASON, path);
  }
  const parked = classify(toy, "docs/z/unknown.md");
  assert.equal(parked.status, "parked");
  // The remedy: a registry entry the path matches.
  const remedied = { classes: [...toy.classes, { ...toy.classes[0], class: "z", paths: ["docs/z/*.md"] }] };
  assert.equal(classify(remedied, "docs/z/unknown.md").status, "classified");
  assert.equal(permitsResume(state, parked.park_reason, "freeze", { origin: "freeze" }), true);
  for (const target of ["draft_artifact", "clarify_alignment", "present_tickets_breakdown", "freeze_artifact"]) {
    assert.throws(
      () => permitsResume(state, parked.park_reason, target, { origin: "freeze" }),
      (error) => error.reason === "resume_target_not_permitted",
      target,
    );
  }
});

test("the CLI reads a park's cause, not the shape of the result, and every cause has its remedy (R8-6)", () => {
  // `parkKind` inferred the kind from the result: a park not named
  // `ambiguous_class` that carried no `lifecycle` read as a path no class
  // governs. Every park now has one name, so the kind is the cause's.
  const park = (cause, extra = {}) => ({ status: "parked", path: "p", park_reason: PARK_REASON, cause, candidates: [], ...extra });
  assert.equal(parkKind(park("unknown_class")), "unregistered");
  assert.equal(parkKind(park("ambiguous_class", { candidates: ["a", "b"] })), "ambiguous");
  assert.equal(parkKind(park("class_not_v1", { lifecycle: "planned_after_v1", decided_by: "#28" })), "later");
  assert.equal(parkKind(park("class_not_v1", { lifecycle: "successor_matrix_candidate", decided_by: "#47" })), "successor");
  assert.equal(parkKind(park("class_not_v1", { lifecycle: null, decided_by: null })), "unmarked");
  // A cause the CLI does not know is refused, not told the remedy of the last
  // kind (review, nit): a new cause owes its remedy.
  for (const cause of [undefined, "no_such_cause", "unregistered_artifact"]) {
    assert.throws(() => parkKind(park(cause)), /park cause/u, String(cause));
  }
  // One vocabulary: the kinds the causes give are exactly the remedies the
  // CLI prints, and each parked line names the stop and its cause.
  const kinds = new Set([
    parkKind(park("unknown_class")),
    parkKind(park("ambiguous_class")),
    ...[null, "planned_after_v1", "successor_matrix_candidate"].map((lifecycle) => parkKind(park("class_not_v1", { lifecycle }))),
  ]);
  assert.deepEqual([...kinds].sort(), Object.keys(REMEDIES).sort());
  const four = {
    classes: [...toy.classes, { ...toy.classes[0], class: "later", lifecycle: "planned_after_v1", decided_by: "#28", paths: ["docs/later/*.md"] }],
  };
  const text = render(classifyChangeset(four, ["docs/z/one.md", "docs/c/two.md", "docs/later/three.md"]));
  for (const cause of PARK_CAUSES) {
    assert.match(text, new RegExp(`^  PARKED artifact_mapping_required \\(${cause}\\) `, "mu"), cause);
  }
});
