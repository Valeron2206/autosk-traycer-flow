/**
 * Tests for the issue #14 artifact-registry validator.
 *
 * Each case mutates the shipped registry in exactly one way. The registry's
 * claim is that adding a class is one entry rather than a new value in several
 * `switch` statements — so the checks that matter most are the ones that make
 * an unregistered artifact, an ambiguous path or an arbitrary impact closure
 * impossible rather than merely discouraged.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CATEGORIES,
  CONTRACTS_DIR,
  CONTRACT_CLASS,
  CONTRACT_PATH,
  GRAPH_PATH,
  LIFECYCLES,
  MATRIX_PATH,
  PARK_REASONS,
  REGISTRY_PATH,
  ROOT,
  SCHEMA_PATH,
  artifactRegistryDesignDigest,
  findImpactCycle,
  graphClassErrors,
  graphClasses,
  lifecycleCounts,
  lifecycleErrors,
  loadFiles,
  registryDigest,
  validateArtifactRegistryDesign,
  validateRegistry,
} from "../scripts/validate-artifact-registry.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);
const matrix = JSON.parse(files[MATRIX_PATH]);
const graph = JSON.parse(files[GRAPH_PATH]);

/** The classes v1 does not govern, with the lifecycle and the issue each names (R7-12). */
const NOT_V1 = Object.freeze({
  autobuild_run: ["planned_after_v1", "#28"],
  changeset_walkthrough: ["planned_after_v1", "#33"],
  cost_watch_registry: ["planned_after_v1", "#29"],
  debate_manifest: ["planned_after_v1", "#31"],
  housekeeping_report: ["planned_after_v1", "#30"],
  reflect_pass: ["planned_after_v1", "#29"],
  // Review of 11g (H1): #38 is the sixth issue matrix v1 puts after v1.
  sdk_write_operation: ["planned_after_v1", "#38"],
  static_analysis_policy: ["successor_matrix_candidate", "#47"],
  static_analysis_result: ["successor_matrix_candidate", "#47"],
});

function registry() {
  return JSON.parse(files[REGISTRY_PATH]);
}

function mutated(mutate, { reseal = true } = {}) {
  const value = registry();
  mutate(value);
  value.classes.sort((a, b) => (a.class < b.class ? -1 : a.class > b.class ? 1 : 0));
  if (reseal) value.registry_digest = registryDigest(value);
  return value;
}

function assertRejects(value, pattern) {
  const errors = validateRegistry(value, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

function classNamed(value, name) {
  return value.classes.find((entry) => entry.class === name);
}

test("the shipped design validates", () => {
  assert.deepEqual(validateArtifactRegistryDesign(files), []);
});

test("the shipped registry validates and its digest recomputes", () => {
  const value = registry();
  assert.deepEqual(validateRegistry(value, schema), []);
  assert.equal(value.registry_digest, registryDigest(value));
});

test("every contract in the repository is listed, one by one", () => {
  // The load-bearing check. A contract added without a registry entry is exactly
  // the drift this issue describes.
  const listed = new Set(classNamed(registry(), CONTRACT_CLASS).paths);
  for (const name of readdirSync(path.join(ROOT, CONTRACTS_DIR))) {
    if (!name.endsWith(".md")) continue;
    assert.ok(listed.has(`${CONTRACTS_DIR}/${name}`), `${name} is not listed by ${CONTRACT_CLASS}`);
  }
});

test("a contract dropped from the list fails the design", () => {
  const value = mutated((draft) => {
    const governing = classNamed(draft, CONTRACT_CLASS);
    governing.paths = governing.paths.filter((entry) => !entry.endsWith("delivery-profile.md"));
  });
  const errors = validateArtifactRegistryDesign({
    ...files,
    [REGISTRY_PATH]: `${JSON.stringify(value, null, 2)}\n`,
  });
  assert.ok(
    errors.some((message) => /delivery-profile\.md: not listed/u.test(message)),
    `expected an unregistered-artifact error, got:\n${errors.join("\n") || "(none)"}`,
  );
});

test("contracts may not be listed by pattern", () => {
  // A glob would match a new contract automatically, and then "registered" would
  // stop meaning anything.
  const value = mutated((draft) => {
    classNamed(draft, CONTRACT_CLASS).paths = ["docs/contracts/*.md"];
  });
  const errors = validateArtifactRegistryDesign({
    ...files,
    [REGISTRY_PATH]: `${JSON.stringify(value, null, 2)}\n`,
  });
  assert.ok(
    errors.some((message) => /is a pattern; contracts must be listed one by one/u.test(message)),
    `expected a pattern error, got:\n${errors.join("\n") || "(none)"}`,
  );
});

test("two classes may not claim one path", () => {
  // A path claimed twice has no defined lifecycle: the entries can disagree on
  // review mode and on impact closure, and nothing decides which applies.
  assertRejects(
    mutated((value) => {
      classNamed(value, "adr").paths = [...classNamed(value, "decision_log").paths];
    }),
    /claimed by adr and decision_log; a path has one lifecycle/u,
  );
});

test("a behaviour-defining class cannot go unreviewed", () => {
  assertRejects(
    mutated((value) => {
      classNamed(value, "migration_plan").review = { mode: "none" };
    }),
    /behavior_defining cannot have review mode none/u,
  );
});

test("a governance-defining class cannot go unreviewed either", () => {
  assertRejects(
    mutated((value) => {
      classNamed(value, "adr").review = { mode: "none" };
    }),
    /governance_defining cannot have review mode none/u,
  );
});

test("narrow review must say what it is narrow under", () => {
  assertRejects(
    mutated((value) => {
      classNamed(value, "migration_plan").review = { mode: "narrow_review" };
    }),
    /must state the condition it is narrow under/u,
  );
});

test("an explanatory class that impacts behaviour is not explanatory", () => {
  assertRejects(
    mutated((value) => {
      classNamed(value, "explanatory_doc").impacts = ["tech_plan"];
    }),
    /explanatory artifacts cannot impact other classes/u,
  );
});

test("a cycle in the impact graph is refused", () => {
  // The closure would be infinite or arbitrary, and arbitrary means some
  // approvals survive a change they depended on.
  const value = mutated((draft) => {
    classNamed(draft, "tickets").impacts = ["brief"];
  });
  const cycle = findImpactCycle(value);
  // Which node the search enters the cycle from depends on visit order, which is
  // not the property under test. That it found a closed walk is.
  assert.ok(cycle, "expected a cycle to be found");
  assert.equal(cycle[0], cycle[cycle.length - 1], `not a closed walk: ${cycle.join(" -> ")}`);
  assert.ok(cycle.includes("tickets"), `the added edge is not in the cycle: ${cycle.join(" -> ")}`);
  assertRejects(value, /impact graph has a cycle/u);
});

test("the shipped graph is acyclic", () => {
  assert.equal(findImpactCycle(registry()), null);
});

test("a class cannot impact itself", () => {
  assertRejects(
    mutated((value) => {
      classNamed(value, "migration_plan").impacts = ["migration_plan"];
    }),
    /impacts itself/u,
  );
});

test("requires and impacts must name declared classes", () => {
  assertRejects(
    mutated((value) => {
      classNamed(value, "tickets").requires = ["no_such_class"];
    }),
    /requires unknown class no_such_class/u,
  );
  assertRejects(
    mutated((value) => {
      classNamed(value, "tickets").impacts = ["no_such_class"];
    }),
    /impacts unknown class no_such_class/u,
  );
});

test("classes must be written sorted, so a diff shows a real change", () => {
  const value = registry();
  value.classes.reverse();
  value.registry_digest = registryDigest(value);
  assertRejects(value, /classes must be written sorted/u);
});

test("identity follows content, not writing order", () => {
  const before = registryDigest(registry());
  const shuffled = registry();
  shuffled.classes.reverse();
  assert.equal(registryDigest(shuffled), before);
});

test("changing a class entry moves the registry digest", () => {
  const before = registryDigest(registry());
  const after = registryDigest(
    mutated(
      (value) => {
        classNamed(value, "migration_plan").human_approval = "not_required";
      },
      { reseal: false },
    ),
  );
  assert.notEqual(before, after);
});

test("a digest that does not recompute is refused", () => {
  assertRejects(
    mutated(
      (value) => {
        classNamed(value, "tickets").retention = "transient";
      },
      { reseal: false },
    ),
    /registry_digest does not recompute/u,
  );
});

test("the schema's categories are exactly the classifier's four", () => {
  assert.deepEqual(schema.properties.classes.items.properties.category.enum, [...CATEGORIES]);
});

test("every park reason is documented in the contract", () => {
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  for (const reason of PARK_REASONS) {
    assert.ok(contract.includes(reason), `${reason} is not documented`);
  }
});

test("the design digest changes when any of its files changes", () => {
  // Debt 11g: the validator reads the program matrix and the workflow graph
  // too, so the digest covers the five files it reads, not three.
  assert.deepEqual(Object.keys(files).sort(), [CONTRACT_PATH, GRAPH_PATH, MATRIX_PATH, REGISTRY_PATH, SCHEMA_PATH].sort());
  const before = artifactRegistryDesignDigest(files);
  for (const relative of Object.keys(files)) {
    const after = artifactRegistryDesignDigest({ ...files, [relative]: `${files[relative]}\n` });
    assert.notEqual(before, after, relative);
  }
});

// Debt 11g (R7-12, and R6-28's successor-matrix marker): an artifact class
// carries a lifecycle, as a carrier key does since debt 10g (ADR-093).

test("every class carries a lifecycle, and exactly the classes v1 does not govern name an issue", () => {
  for (const entry of registry().classes) {
    assert.ok(LIFECYCLES.includes(entry.lifecycle), `${entry.class}: ${entry.lifecycle}`);
    assert.deepEqual([entry.lifecycle, entry.decided_by], NOT_V1[entry.class] ?? ["required_for_v1", undefined], entry.class);
  }
  // #14's obligation covers the v1 classes, counted apart from the others.
  assert.deepEqual(lifecycleCounts(registry()), { required_for_v1: 61, planned_after_v1: 7, successor_matrix_candidate: 2 });
  // Each of the six issues matrix v1 puts after v1 owns a class it
  // registered — #28, #29, #30, #31, #33 and #38 — and none is left `v1`.
  const owners = new Set(Object.values(NOT_V1).map(([, issue]) => issue));
  const later = matrix.records.filter((record) => record.lifecycle === "planned_after_v1").map((record) => `#${record.issue_number}`);
  assert.deepEqual(later, ["#28", "#29", "#30", "#31", "#33", "#38"]);
  assert.deepEqual(later.filter((issue) => !owners.has(issue)), []);
  assert.deepEqual(lifecycleCounts({ classes: [] }), { required_for_v1: 0, planned_after_v1: 0, successor_matrix_candidate: 0 });
});

test("the lifecycles are closed: the matrix's two, and the marker for an issue outside it", () => {
  assert.deepEqual([...LIFECYCLES], ["required_for_v1", "planned_after_v1", "successor_matrix_candidate"]);
  assert.deepEqual(schema.properties.classes.items.properties.lifecycle.enum, [...LIFECYCLES]);
  assertRejects(mutated((value) => {
    classNamed(value, "adr").lifecycle = "intentionally_deferred";
  }), /\.lifecycle is outside enum/u);
  const unmarked = validateRegistry(mutated((value) => {
    delete classNamed(value, "adr").lifecycle;
  }), schema);
  assert.deepEqual(unmarked, ["schema: $.classes[0].lifecycle is required"], "a missing lifecycle is not also a missing issue");
  const widened = JSON.parse(files[SCHEMA_PATH]);
  widened.properties.classes.items.properties.lifecycle.enum.push("intentionally_deferred");
  const errors = validateArtifactRegistryDesign({ ...files, [SCHEMA_PATH]: JSON.stringify(widened) });
  assert.ok(errors.includes(`${SCHEMA_PATH}: lifecycles must be exactly ${LIFECYCLES.join(", ")}`), errors.join("\n"));
});

test("a class v1 does not govern and names no issue fails the validator", () => {
  for (const name of ["autobuild_run", "static_analysis_result"]) {
    assertRejects(mutated((value) => {
      delete classNamed(value, name).decided_by;
    }), /\.decided_by is required/u);
  }
  assertRejects(mutated((value) => {
    classNamed(value, "autobuild_run").decided_by = "ADR-062";
  }), /\.decided_by does not match pattern/u);
  // The design reports it once, from the schema; the matrix check reads no
  // issue that is not there, rather than throwing on it.
  const unnamed = mutated((value) => {
    delete classNamed(value, "reflect_pass").decided_by;
  });
  assert.deepEqual(lifecycleErrors(unnamed, matrix), []);
  const errors = validateArtifactRegistryDesign({ ...files, [REGISTRY_PATH]: JSON.stringify(unnamed) });
  assert.ok(errors.some((message) => /^resources\/artifact-registry\/artifact-registry\.v1\.json: schema: \$\.classes\[\d+\]\.decided_by is required$/u.test(message)), errors.join("\n"));
});

test("a v1 class names no deciding issue", () => {
  assertRejects(mutated((value) => {
    classNamed(value, "adr").decided_by = "#28";
  }), /^adr: a required_for_v1 class names no deciding issue$/u);
});

test("a decided_by the matrix calls v1 fails", () => {
  const value = mutated((draft) => {
    classNamed(draft, "autobuild_run").decided_by = "#19";
  });
  assert.deepEqual(validateRegistry(value, schema), [], "the shape holds; only the matrix can say #19 is v1");
  assert.deepEqual(lifecycleErrors(value, matrix), [
    `autobuild_run: #19 is required_for_v1 in ${MATRIX_PATH}, not planned_after_v1`,
  ]);
});

test("a post-v1 class names an issue of the matrix", () => {
  const value = mutated((draft) => {
    classNamed(draft, "reflect_pass").decided_by = "#47";
  });
  assert.deepEqual(lifecycleErrors(value, matrix), [
    `reflect_pass: #47 is not an issue of ${MATRIX_PATH}, so the matrix does not put it after v1`,
  ]);
});

test("a successor-matrix candidate names an issue the matrix does not classify", () => {
  // #47 is outside the #3–#39 inventory (its contract, ADR-067): claiming a
  // lifecycle of matrix v1 for it is what debt 9d refused in the contracts.
  assert.deepEqual(lifecycleErrors(registry(), matrix), []);
  const value = mutated((draft) => {
    classNamed(draft, "static_analysis_policy").decided_by = "#28";
  });
  assert.deepEqual(lifecycleErrors(value, matrix), [
    `static_analysis_policy: #28 is planned_after_v1 in ${MATRIX_PATH}; a successor_matrix_candidate names an issue the matrix does not classify`,
  ]);
});

test("the design holds the registry to the matrix it reads", () => {
  const moved = JSON.parse(files[MATRIX_PATH]);
  moved.records.find((record) => record.issue_number === 28).lifecycle = "required_for_v1";
  const errors = validateArtifactRegistryDesign({ ...files, [MATRIX_PATH]: JSON.stringify(moved) });
  assert.ok(
    errors.includes(`${REGISTRY_PATH}: autobuild_run: #28 is required_for_v1 in ${MATRIX_PATH}, not planned_after_v1`),
    errors.join("\n"),
  );
});

test("a v1 class cannot require a class v1 does not govern", () => {
  // Its predecessor would never be approved in v1, so the v1 class would park
  // on `missing_predecessor` for ever.
  assertRejects(mutated((value) => {
    classNamed(value, "tickets").requires = ["tech_plan", "autobuild_run"];
  }), /^tickets: a required_for_v1 class requires autobuild_run, which is planned_after_v1$/u);
  // A class v1 does not govern may stand on v1 classes.
  assert.ok(classNamed(registry(), "autobuild_run").requires.includes("human_decision"));
  assert.ok(classNamed(registry(), "static_analysis_policy").requires.includes("delivery_profile"));
});

test("a class the workflow graph reads is produced by a v1 workflow, so it is required_for_v1", () => {
  // Every workflow the graph registers is v1's (matrix `graph.workflow-registration`,
  // #18). The graph records no producer per class; what it names are the facts
  // its predicates read, and four of them are registry classes.
  const read = graphClasses(registry(), graph);
  assert.deepEqual([...read.keys()], ["core_flow", "integration_authorization", "tech_plan", "tickets"]);
  for (const ids of read.values()) assert.ok(ids.length > 0 && ids.every((id) => /^cond_\d+$/u.test(id)));
  assert.deepEqual(graphClassErrors(registry(), graph), []);
  // #28 is after v1, so the matrix alone lets this marking through.
  const hidden = mutated((value) => {
    Object.assign(classNamed(value, "tickets"), { lifecycle: "planned_after_v1", decided_by: "#28" });
  });
  assert.deepEqual(lifecycleErrors(hidden, matrix), []);
  const errors = graphClassErrors(hidden, graph);
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(errors[0], /^tickets: the workflow graph reads it \(cond_\d+(, cond_\d+)*\), so a v1 workflow produces it; it must be required_for_v1, not planned_after_v1$/u);
  // `brief` is not read by name; `core_flow` requires it, which holds it too.
  assertRejects(mutated((value) => {
    Object.assign(classNamed(value, "brief"), { lifecycle: "planned_after_v1", decided_by: "#28" });
  }), /^core_flow: a required_for_v1 class requires brief, which is planned_after_v1$/u);
});

test("a graph that reads no registry class fails closed", () => {
  const blind = { ...graph, predicates: graph.predicates.map((predicate) => ({ ...predicate, reads: [] })) };
  const blindness = `no class is read by the predicates of ${GRAPH_PATH}, so nothing holds a class its workflows produce to v1`;
  assert.deepEqual(graphClassErrors(registry(), blind), [blindness]);
  const errors = validateArtifactRegistryDesign({ ...files, [GRAPH_PATH]: JSON.stringify(blind) });
  assert.ok(errors.includes(`${REGISTRY_PATH}: ${blindness}`), errors.join("\n"));
});

test("every lifecycle is documented in the contract", () => {
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  for (const lifecycle of LIFECYCLES) assert.ok(contract.includes(lifecycle), `${lifecycle} is not documented`);
  const errors = validateArtifactRegistryDesign({
    ...files,
    [CONTRACT_PATH]: files[CONTRACT_PATH].replaceAll("successor_matrix_candidate", "a later matrix"),
  });
  assert.ok(errors.includes(`${CONTRACT_PATH}: lifecycle successor_matrix_candidate is not documented`), errors.join("\n"));
});
