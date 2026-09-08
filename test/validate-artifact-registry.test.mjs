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
  PARK_REASONS,
  REGISTRY_PATH,
  ROOT,
  SCHEMA_PATH,
  artifactRegistryDesignDigest,
  findImpactCycle,
  loadFiles,
  registryDigest,
  validateArtifactRegistryDesign,
  validateRegistry,
} from "../scripts/validate-artifact-registry.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

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

test("the design digest changes when any of the three files changes", () => {
  const before = artifactRegistryDesignDigest(files);
  const after = artifactRegistryDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
