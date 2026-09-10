/**
 * Tests for the issue #10 declarative workflow graph validator.
 *
 * The failure the contract closes is that the workflow is code, so a digest has
 * nothing to cover and a global update can change the flow an Epic runs without
 * changing anything the Epic pinned. Each case here is a way a document could
 * fail to be the graph it claims: an edge that lands nowhere, a guard on a
 * predicate that does not exist, a step that offers two candidate edges the
 * data cannot order, a resume the graph never declared as an edge.
 *
 * The last group is about the serialization rather than the graph, because the
 * digest is over the canonical bytes: if two implementations disagree about
 * what those bytes are, everything above is checking a number nobody shares.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_PATH,
  EXAMPLE_PATH,
  GRAPH_PARK_REASONS,
  REFERENCE_PATH,
  REFUSALS,
  REFUSED_PATH,
  SCHEMA_PATH,
  canonicalBytes,
  canonicalText,
  encodeName,
  exactInteger,
  graphDigest,
  parkReasons,
  loadFiles,
  parseStrict,
  validateGraph,
  validateReference,
  validateWorkflowGraphDesign,
} from "../scripts/validate-workflow-graph.mjs";

const files = loadFiles();
const schema = parseStrict(files[SCHEMA_PATH]);

const example = () => parseStrict(files[EXAMPLE_PATH]);

function mutated(mutate, { reseal = true } = {}) {
  const document = example();
  mutate(document);
  if (reseal) document.canonical_digest = graphDigest(document);
  return document;
}

function assertRefuses(document, code) {
  const errors = validateGraph(document, schema);
  assert.ok(
    errors.some((message) => message.includes(code)),
    `expected ${code}, got:\n${errors.join("\n") || "(no findings)"}`,
  );
}

// --- the shipped set -------------------------------------------------------

test("the shipped design validates", () => {
  assert.deepEqual(validateWorkflowGraphDesign(files), []);
});

test("the working example is accepted", () => {
  assert.deepEqual(validateGraph(example(), schema), []);
});

test("the refused example is refused, by the five defects it advertises", () => {
  const errors = validateGraph(parseStrict(files[REFUSED_PATH]), schema);
  const codes = errors.map((message) => message.split(":")[0]).sort();
  assert.deepEqual(codes, [
    "graph_cap_transition_unknown",
    "graph_predicate_unknown",
    "graph_priority_ambiguous",
    "graph_step_unknown",
    "resume_target_not_permitted",
  ]);
});

test("the contract closes every refusal this validator can produce", () => {
  for (const refusal of REFUSALS) {
    assert.ok(files[CONTRACT_PATH].includes(`\`${refusal}\``), `${refusal} is not closed by ${CONTRACT_PATH}`);
  }
});

// --- the graph refers to something -----------------------------------------

test("graph_first_step_unknown: the flow starts at a step that does not exist", () => {
  assertRefuses(mutated((document) => { document.first_step = "nowhere"; }), "graph_first_step_unknown");
});

test("graph_duplicate_name: two steps answer to one name", () => {
  assertRefuses(mutated((document) => { document.steps[1].name = "intake"; }), "graph_duplicate_name");
});

test("graph_step_unknown: an edge arrives nowhere", () => {
  assertRefuses(mutated((document) => { document.transitions[0].to = "nowhere"; }), "graph_step_unknown");
});

test("graph_predicate_unknown: a guard tests something the document never declared", () => {
  assertRefuses(mutated((document) => { document.guards[0].predicate = "never_declared"; }), "graph_predicate_unknown");
});

test("graph_guard_unknown: an edge is bound to a guard that does not exist", () => {
  assertRefuses(mutated((document) => { document.transitions[1].guards = ["never_declared"]; }), "graph_guard_unknown");
});

test("graph_priority_ambiguous: two edges leave one step at one priority", () => {
  assertRefuses(mutated((document) => { document.transitions[2].priority = 0; }), "graph_priority_ambiguous");
});

test("graph_cap_transition_unknown: a cap counts an edge that does not exist", () => {
  assertRefuses(mutated((document) => { document.caps[0].counted_transition = "never_declared"; }), "graph_cap_transition_unknown");
});

test("graph_step_unreachable: a step no edge can reach", () => {
  assertRefuses(
    mutated((document) => {
      document.steps.push({
        name: "orphan",
        kind: "agent",
        hooks: ["onRun"],
        no_transition_reason: "quick_classification_invalid",
      });
    }),
    "graph_step_unreachable",
  );
});

test("graph_terminal_step_leaves: a step that ends the flow and continues it", () => {
  assertRefuses(
    mutated((document) => {
      document.transitions.push({ id: "done_to_intake", from: "done", to: "intake", priority: 0, guards: [] });
    }),
    "graph_terminal_step_leaves",
  );
});

// --- parking and resuming --------------------------------------------------

test("graph_recovery_missing: a reason the graph can park with and nothing says how to leave", () => {
  assertRefuses(mutated((document) => { document.steps[0].no_transition_reason = "brand_new_reason"; }), "graph_recovery_missing");
});

test("graph_recovery_reason_unknown: a row for a reason nothing produces", () => {
  assertRefuses(
    mutated((document) => {
      document.recovery.push({
        reason: "never_produced_reason",
        parks_at: ["intake"],
        resume_targets: ["await_alignment"],
        required_state: "a row nothing can reach",
      });
    }),
    "graph_recovery_reason_unknown",
  );
});

test("resume_target_not_permitted: a resume the graph never declared as an edge", () => {
  assertRefuses(mutated((document) => { document.recovery[0].resume_targets = ["done"]; }), "resume_target_not_permitted");
});

/**
 * The two codes a valid document must never produce.
 *
 * Closing them in the contract and then never producing them would be an
 * enumeration nobody checks, so what is tested is the mechanism that makes them
 * unreachable rather than their absence.
 */
test("no_transition_reason is unreachable: an agent step must say why it did not leave", () => {
  assertRefuses(mutated((document) => { delete document.steps[0].no_transition_reason; }), "graph_schema");
});

test("no_transition_reason is unreachable: only a human status step may park without one", () => {
  const document = example();
  for (const step of document.steps) {
    assert.ok(
      step.kind === "agent" ? Boolean(step.no_transition_reason) : step.status === "human" || step.status === "done",
      `${step.name} could park with nothing to say`,
    );
  }
});

test("transition_not_declared is unreachable: every graph carries the code", () => {
  assertRefuses(mutated((document) => { delete document.graph_reasons.transition_not_declared; }), "graph_schema");
});

// --- the digest ------------------------------------------------------------

test("graph_digest_stale: a recorded digest that does not recompute", () => {
  assertRefuses(mutated((document) => { document.caps[0].limit = 9; }, { reseal: false }), "graph_digest_stale");
});

test("the digest ignores how the document was written", () => {
  const reordered = example();
  reordered.steps = [...reordered.steps].reverse();
  reordered.guards = [...reordered.guards].reverse();
  assert.equal(graphDigest(reordered), example().canonical_digest);
});

test("the digest notices the order that carries meaning", () => {
  const reordered = example();
  reordered.transitions = [...reordered.transitions].reverse();
  assert.notEqual(graphDigest(reordered), example().canonical_digest);
});

// --- the canonical serialization -------------------------------------------

test("graph_duplicate_key is refused by the parse, because the schema cannot see it", () => {
  const text = '{"schema_version":1,"schema_version":2}';
  assert.throws(() => parseStrict(text), /graph_duplicate_key/u);
  // What any schema would be handed: one entry, and no evidence there were two.
  assert.deepEqual(JSON.parse(text), { schema_version: 2 });
  assert.equal(Object.keys(JSON.parse(text)).length, 1);
});

test("graph_number_not_canonical: a number the graph does not write", () => {
  assert.throws(() => canonicalText(1.5), /graph_number_not_canonical/u);
  assert.throws(() => canonicalText(-0), /graph_number_not_canonical/u);
});

test("graph_lone_surrogate: a string with no UTF-8 spelling", () => {
  assert.throws(() => canonicalText("\ud800"), /graph_lone_surrogate/u);
});

test("keys are ordered and no whitespace is significant", () => {
  assert.equal(canonicalText({ b: 1, a: [2, 3] }), '{"a":[2,3],"b":1}');
});

test("two writings of one integer converge", () => {
  assert.equal(canonicalText(parseStrict("1e0")), canonicalText(parseStrict("1")));
});

test("two writings of one string converge", () => {
  assert.equal(canonicalText(parseStrict('"\\u0073"')), canonicalText(parseStrict('"s"')));
});

test("only what JSON requires is escaped", () => {
  assert.equal(canonicalText("a\tb\u001fcé"), '"a\\tb\\u001fcé"');
});

test("a name keeps an unpaired surrogate apart from the replacement character", () => {
  assert.notEqual(encodeName("step_\ud800"), encodeName("step_�"));
});

test("the canonical bytes are UTF-8 and carry no BOM", () => {
  const bytes = canonicalBytes(example());
  assert.equal(bytes[0], "{".charCodeAt(0));
  assert.ok(!bytes.includes(0xef) || bytes.indexOf(0xef) !== 0);
});

// --- the reference ---------------------------------------------------------

test("the canonicalization reference reproduces", () => {
  assert.deepEqual(validateReference(parseStrict(files[REFERENCE_PATH])), []);
});

test("the reference pins the digest the shipped example carries", () => {
  const reference = parseStrict(files[REFERENCE_PATH]);
  assert.equal(reference.document.canonical_digest, example().canonical_digest);
});

test("the reference exercises all four forks the plan names", () => {
  const reference = parseStrict(files[REFERENCE_PATH]);
  assert.deepEqual(
    reference.forks.map((fork) => fork.fork).sort(),
    ["duplicate_key", "integer_two_spellings", "lone_surrogate_name", "string_two_spellings"],
  );
});

test("a reference that records the wrong bytes is caught", () => {
  const reference = parseStrict(files[REFERENCE_PATH]);
  reference.document.canonical_digest = "0".repeat(64);
  assert.ok(validateReference(reference).some((message) => message.includes("digest does not reproduce")));
});

test("a reference that drops a fork is caught", () => {
  const reference = parseStrict(files[REFERENCE_PATH]);
  reference.forks = reference.forks.filter((fork) => fork.fork !== "duplicate_key");
  assert.ok(validateReference(reference).some((message) => message.includes("fork duplicate_key is not exercised")));
});

// --- findings from the slice 1 cross-family review --------------------------

/**
 * A JSON key named `__proto__` is not an ordinary key.
 *
 * Assigning it with `value[key] = ...` moves the parsed object's prototype
 * instead of creating an own property, so the closed-document rule never sees
 * it: `additionalProperties: false` reads own properties, and there are none.
 * The document then passes and the canonical bytes silently drop what it said.
 */
test("ASTRA-S1-01: __proto__ parses as an own property, not as the prototype", () => {
  const parsed = parseStrict('{"__proto__":{"unexpected":true},"schema_version":1}');
  assert.ok(Object.hasOwn(parsed, "__proto__"), "__proto__ must be an own property");
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype, "the prototype must not have moved");
  assert.equal(parsed.unexpected, undefined, "nothing may be inherited from the parsed value");
});

test("ASTRA-S1-01: a graph carrying __proto__ is refused rather than quietly dropped", () => {
  const carried = parseStrict(canonicalText(example()).replace(/^\{/u, '{"__proto__":{"unexpected":true},'));
  const errors = validateGraph(carried, schema);
  assert.ok(
    errors.some((message) => message.includes("__proto__")),
    `expected a refusal naming __proto__, got:\n${errors.join("\n") || "(no findings)"}`,
  );
});

/**
 * Integrality is a property of the written number, not of the float it becomes.
 *
 * `1.00000000000000001` rounds to exactly 1 and `1e-4000` underflows to 0, so a
 * check made after the conversion accepts two fractions as integers. An
 * implementation with exact decimal arithmetic would refuse both, which makes
 * the reference stop proving that two implementations agree.
 */
test("ASTRA-S1-02: a fraction that rounds to an integer is refused", () => {
  assert.throws(() => parseStrict("1.00000000000000001"), /graph_number_not_canonical/u);
});

test("ASTRA-S1-02: an exponent that underflows to zero is refused", () => {
  assert.throws(() => parseStrict("1e-4000"), /graph_number_not_canonical/u);
});

test("ASTRA-S1-02: minus zero is refused where its sign still exists", () => {
  assert.throws(() => parseStrict("-0"), /graph_number_not_canonical/u);
  assert.throws(() => parseStrict("-0.0e7"), /graph_number_not_canonical/u);
});

test("ASTRA-S1-02: an integer larger than the exactly representable range is refused", () => {
  assert.throws(() => parseStrict("9007199254740993"), /graph_number_not_canonical/u);
});

test("ASTRA-S1-02: the writings that mean one integer still converge", () => {
  for (const text of ["1", "1.0", "1e0", "10e-1", "0", "-7"]) {
    assert.equal(parseStrict(text), Number(text), `${text} must survive as its integer`);
  }
});

/**
 * The schema promises that a code outside the vocabulary is refused by the
 * validator. Until this test, only the spelling was checked.
 */
test("ASTRA-S1-03: a park reason no vocabulary owns is refused", () => {
  assertRefuses(
    mutated((document) => {
      document.guards[0].park_reason = "totally_unknown_reason";
      document.recovery.find((row) => row.reason === "core_flow_decision_required").reason = "totally_unknown_reason";
    }),
    "graph_park_reason_unknown",
  );
});

test("ASTRA-S1-03: the graph-level reasons cannot be renamed to something else", () => {
  assertRefuses(
    mutated((document) => { document.graph_reasons.transition_not_declared = "totally_unknown_reason"; }),
    "graph_schema",
  );
});

/**
 * The closed set is checked against what the validator actually emits.
 *
 * Reading a hand-kept list back to itself cannot notice a code that is reachable
 * and undeclared, which is how `graph_schema` stayed out of the contract.
 */
test("ASTRA-S1-04: every refusal reachable from a real input is declared", () => {
  const produced = new Set();
  const code = (message) => message.split(":")[0];

  const mutations = [
    (document) => { document.first_step = "nowhere"; },
    (document) => { document.steps[1].name = "intake"; },
    (document) => { document.transitions[0].to = "nowhere"; },
    (document) => { document.guards[0].predicate = "never_declared"; },
    (document) => { document.transitions[1].guards = ["never_declared"]; },
    (document) => { document.transitions[2].priority = 0; },
    (document) => { document.caps[0].counted_transition = "never_declared"; },
    (document) => { document.transitions.push({ id: "done_to_intake", from: "done", to: "intake", priority: 0, guards: [] }); },
    (document) => { document.steps[0].no_transition_reason = "quick_classification_invalid"; document.steps.push({ name: "orphan", kind: "agent", hooks: ["onRun"], no_transition_reason: "quick_classification_invalid" }); },
    (document) => { document.recovery[0].resume_targets = ["done"]; },
    (document) => { delete document.steps[0].no_transition_reason; },
    (document) => { document.unexpected = true; },
    (document) => { document.guards[0].park_reason = "totally_unknown_reason"; document.recovery.find((row) => row.reason === "core_flow_decision_required").reason = "totally_unknown_reason"; },
    (document) => { document.guards[0].park_reason = "no_transition_reason"; document.recovery.find((row) => row.reason === "core_flow_decision_required").reason = "no_transition_reason"; },
  ];
  for (const mutate of mutations) {
    for (const message of validateGraph(mutated(mutate), schema)) produced.add(code(message));
  }
  for (const message of validateGraph(mutated((document) => { document.caps[0].limit = 9; }, { reseal: false }), schema)) {
    produced.add(code(message));
  }
  for (const text of ['{"a":1,"a":2}', "{", '{"a" 1}', "1.5", "-0", '{"a":1} trailing']) {
    try {
      parseStrict(text);
    } catch (error) {
      produced.add(code(error.message));
    }
  }

  assert.ok(produced.size >= 12, `the battery produced only ${produced.size} codes`);
  assert.deepEqual(
    [...produced].filter((entry) => !REFUSALS.includes(entry)).sort(),
    [],
    `reachable and undeclared: ${[...produced].filter((entry) => !REFUSALS.includes(entry)).join(", ")}`,
  );
});

// --- findings the fixes themselves introduced -------------------------------

/**
 * An exponent is a number in the input, not a length.
 *
 * Reading integrality from the digits meant shifting the decimal point, and
 * shifting it by padding a string costs the value of the exponent rather than
 * the size of the token: `1e1000000000` is twelve characters and asked for a
 * billion. `Number` never did that, so this was a regression the earlier fix
 * introduced, not a hole it failed to close.
 */
test("ASTRA-S1-05: a large exponent costs the length of the input, not its value", () => {
  assert.throws(() => parseStrict("1e1000000000"), /graph_number_not_canonical/u);
  assert.throws(() => parseStrict("1e999999999999999999999999"), /graph_number_not_canonical/u);
  assert.throws(() => parseStrict("1e309"), /graph_number_not_canonical/u);
});

test("ASTRA-S1-05: zero is zero at any exponent", () => {
  assert.equal(parseStrict("0e1000000000"), 0);
  assert.equal(parseStrict("0e-1000000000"), 0);
  assert.equal(parseStrict("0.000e309"), 0);
  assert.throws(() => parseStrict("-0e1000000000"), /graph_number_not_canonical/u);
});

test("ASTRA-S1-05: the exactly representable boundary is where it says it is", () => {
  assert.equal(parseStrict("9007199254740991"), 9007199254740991);
  assert.equal(parseStrict("-9007199254740991"), -9007199254740991);
  assert.throws(() => parseStrict("9007199254740992"), /graph_number_not_canonical/u);
  assert.equal(parseStrict("9e15"), 9e15);
  assert.equal(parseStrict("0.001e3"), 1);
});

test("ASTRA-S1-05: exactInteger holds the JSON grammar on its own, not only through the scanner", () => {
  const refuse = (message) => {
    throw new SyntaxError(message);
  };
  for (const token of ["01", "00", "-01"]) {
    assert.throws(() => exactInteger(token, refuse), /is not a number the graph writes/u, token);
  }
});

/**
 * The authoritative set is read, not remembered.
 *
 * One module-global Set, handed out to every caller, is shared mutable state:
 * a caller that adds to it widens what every later check will accept, and a
 * second root silently gets the first root's vocabulary.
 */
test("ASTRA-S1-06: the park-reason set is not shared mutable state", () => {
  const first = parkReasons();
  first.add("totally_unknown_reason");
  const second = parkReasons();
  assert.equal(second.has("totally_unknown_reason"), false, "a caller must not be able to widen the authoritative set");
  assert.notEqual(first, second, "each call must hand out its own set");
});

test("ASTRA-S1-06: a widened set cannot leak into the next validation", () => {
  parkReasons().add("totally_unknown_reason");
  assertRefuses(
    mutated((document) => {
      document.guards[0].park_reason = "totally_unknown_reason";
      document.recovery.find((row) => row.reason === "core_flow_decision_required").reason = "totally_unknown_reason";
    }),
    "graph_park_reason_unknown",
  );
});

// --- round 2 -----------------------------------------------------------------

/**
 * Owning a code and being allowed to name it are different questions.
 *
 * The three graph-level reasons belong to the graph itself: an undeclared pair
 * has no edge and therefore no guard to hang a reason on. Merging them into one
 * allowed set let an ordinary guard carry `no_transition_reason` — a code the
 * contract says no valid document can produce.
 */
test("ASTRA-R2-01: a guard cannot carry a reason the graph issues about itself", () => {
  for (const reserved of GRAPH_PARK_REASONS) {
    assertRefuses(
      mutated((document) => {
        const previous = document.guards[0].park_reason;
        document.guards[0].park_reason = reserved;
        document.recovery.find((row) => row.reason === previous).reason = reserved;
      }),
      "graph_park_reason_reserved",
    );
  }
});

test("ASTRA-R2-01: a step cannot carry one either", () => {
  for (const reserved of GRAPH_PARK_REASONS) {
    assertRefuses(
      mutated((document) => {
        const previous = document.steps[0].no_transition_reason;
        document.steps[0].no_transition_reason = reserved;
        document.recovery.find((row) => row.reason === previous).reason = reserved;
      }),
      "graph_park_reason_reserved",
    );
  }
});

test("ASTRA-R2-01: a cap cannot carry one either", () => {
  assertRefuses(
    mutated((document) => {
      const previous = document.caps[0].park_reason;
      document.caps[0].park_reason = "no_transition_reason";
      document.recovery.find((row) => row.reason === previous).reason = "no_transition_reason";
    }),
    "graph_park_reason_reserved",
  );
});

test("ASTRA-R2-01: the workflow vocabulary is what an ordinary field may name", () => {
  assert.equal(parkReasons().has("no_transition_reason"), false, "a reserved code is not a workflow park reason");
  assert.equal(parkReasons().has("core_flow_decision_required"), true, "the workflow vocabulary is still the source");
});
