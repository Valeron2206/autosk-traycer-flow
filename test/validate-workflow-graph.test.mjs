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
  DOCUMENT_PATH,
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

test("the refused example is refused, by the six defects it advertises", () => {
  const errors = validateGraph(parseStrict(files[REFUSED_PATH]), schema);
  const codes = errors.map((message) => message.split(":")[0]).sort();
  // The sixth is a cascade and the example says so: the cap counts a transition
  // that does not exist, so nothing can attribute the cap's reason to a step, and
  // the row naming that step is then a row the graph does not park there.
  assert.deepEqual(codes, [
    "graph_cap_transition_unknown",
    "graph_predicate_unknown",
    "graph_priority_ambiguous",
    "graph_recovery_parks_at_unproduced",
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
    // The parks_at checks belong in the battery and not only in their own tests:
    // this is the list that notices a code reachable and undeclared, and a code it
    // never provokes is one it cannot speak for. Both directions are provoked, so
    // neither can be deleted without this list going quiet about it.
    (document) => { document.steps.find((step) => step.name === "freeze_artifact").no_transition_reason = "alignment_record_stale"; },
    (document) => { document.recovery.find((row) => row.reason === "artifact_freeze_invalid").parks_at = ["freeze_artifact", "record_artifact_pass"]; },
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

// --- the shipped document --------------------------------------------------
//
// Slice 2 put the real autosk-flow graph at DOCUMENT_PATH. These check the four
// properties its ticket makes observable, plus the one the document forced into
// the contract: a graph is entered at more than one step, and measuring
// reachability from `first_step` alone called seven registered workflows dead.

const document = () => parseStrict(files[DOCUMENT_PATH]);

test("the shipped document validates against the shipped schema", () => {
  assert.deepEqual(validateGraph(document(), schema), []);
});

test("the shipped document's digest recomputes from its own bytes", () => {
  const { canonical_digest: recorded, ...rest } = document();
  assert.equal(graphDigest(rest), recorded);
});

test("every park reason the document declares has a resume target that is a declared step", () => {
  const graph = document();
  const steps = new Set(graph.steps.map((step) => step.name));
  const missing = [];
  for (const row of graph.recovery) {
    if (row.resume_targets.length === 0) missing.push(`${row.reason}: no resume target`);
    for (const target of row.resume_targets) {
      if (!steps.has(target)) missing.push(`${row.reason}: ${target} is not a declared step`);
    }
  }
  assert.deepEqual(missing, []);
});

test("every resume target is reachable by a declared edge from a step its own row names", () => {
  const graph = document();
  const outgoing = new Map();
  for (const edge of graph.transitions) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const unreachable = [];
  for (const row of graph.recovery) {
    const named = [...row.parks_at, ...(row.handled_at ?? [])];
    const declared = new Set(named.flatMap((step) => outgoing.get(step) ?? []));
    for (const target of row.resume_targets) {
      if (!declared.has(target)) unreachable.push(`${row.reason}: ${target} leaves none of the steps its row names`);
    }
  }
  assert.deepEqual(unreachable, []);
});

test("no two edges out of one step share a priority", () => {
  const graph = document();
  const seen = new Map();
  const clashes = [];
  for (const edge of graph.transitions) {
    const key = `${edge.from}@${edge.priority}`;
    if (seen.has(key)) clashes.push(`${key}: ${seen.get(key)} and ${edge.id}`);
    seen.set(key, edge.id);
  }
  assert.deepEqual(clashes, []);
});

test("every cap counts the transition that spends a round, not merely one that exists", () => {
  const graph = document();
  const transitions = new Map(graph.transitions.map((edge) => [edge.id, edge]));
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  const predicates = new Map(graph.predicates.map((entry) => [entry.id, entry.description]));
  const vocabulary = parkReasons();
  assert.ok(graph.caps.length > 0, "the document declares at least one cap");
  for (const cap of graph.caps) {
    assert.ok(cap.cycle.length > 0, "a cap names its cycle");
    assert.ok(Number.isInteger(cap.limit) && cap.limit >= 1, `${cap.cycle} carries a limit`);
    assert.ok(vocabulary.has(cap.park_reason), `${cap.cycle} parks with a workflow reason`);

    const counted = transitions.get(cap.counted_transition);
    assert.ok(counted, `${cap.cycle} counts a transition that exists`);
    // Endpoints alone let a cap latch onto a repair edge that happens to share
    // them, which is what it did: the counter then never moved on a real round
    // and moved on something else. The condition is what makes it the round.
    const says = counted.guards.map((id) => predicates.get(guards.get(id).predicate) ?? "");
    assert.ok(
      says.some((description) => /round\s*<\s*cap/u.test(description)),
      `${cap.cycle} counts ${counted.id} (${counted.from} -> ${counted.to}), whose conditions are:\n${says.join("\n")}`,
    );
  }
});

test("a step name used as a word does not become an edge to that step", () => {
  const graph = document();
  // Eleven step names are also ordinary words, and section 2 uses them as words.
  // Each pair below was built once from a sentence that mentions the step without
  // sending the flow there: a prohibition (`cleanup side effects absent`,
  // `freeze_artifact напрямую запрещён`), a verb (`or verify identical ref`), and
  // a hyphenated verb whose tail passed the end-of-clause test (`final-verify;`).
  const notEdges = [
    ["init_planning_ref", "cleanup"],
    ["present_tickets_breakdown", "freeze_artifact"],
    ["narrow_review_join", "verify"],
    ["rebuild_anchor", "verify"],
    ["record_artifact_pass", "verify"],
    ["freeze_artifact", "verify"],
  ];
  const built = notEdges
    .filter(([from, to]) => graph.transitions.some((edge) => edge.from === from && edge.to === to))
    .map(([from, to]) => `${from} -> ${to}`);
  assert.deepEqual(built, [], "these names are used as words, not as destinations");

  // The rule must not have cost the real ones: `implement -> verify` is the code
  // flow, and section 2 writes `transit verify` for the anchor rebuild.
  for (const [from, to] of [
    ["implement", "verify"],
    ["rebuild_code_anchor", "verify"],
  ]) {
    assert.ok(
      graph.transitions.some((edge) => edge.from === from && edge.to === to),
      `${from} -> ${to} is a real edge and must survive the rule`,
    );
  }
});

test("every step the tables leave without an exit is given the one its chain draws", () => {
  const graph = document();
  const leaves = new Set(graph.transitions.map((edge) => edge.from));
  const terminal = new Set(["done", "ticket_done", "human"]);
  const stranded = graph.steps
    .map((step) => step.name)
    .filter((name) => !leaves.has(name) && !terminal.has(name));
  assert.deepEqual(stranded, [], "a step that can only ever park is a flow with nowhere to go");
});

test("a step section 2 calls a human status step is a status step, and its exits are told apart", () => {
  const graph = document();
  const steps = new Map(graph.steps.map((step) => [step.name, step]));
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  for (const name of ["await_alignment", "await_anchor_impact_approval"]) {
    const step = steps.get(name);
    assert.equal(step.kind, "status", `${name} drives a task status rather than running`);
    assert.equal(step.status, "human", `${name} is the human status`);
    assert.equal(step.no_transition_reason, undefined, `${name} carries no reason to fail to leave`);
  }

  // Exits to different steps sharing one condition are candidates at once, and
  // priority then decides every time — so all but the first are unreachable
  // however the flow arrived. Two edges to the SAME step under one condition are
  // fine and expected: that is how one clause offering two authorities is drawn.
  const exits = graph.transitions.filter((edge) => edge.from === "await_alignment");
  assert.ok(exits.length >= 3, "await_alignment offers the alternatives section 2 lists");
  const targetsByCondition = new Map();
  for (const edge of exits) {
    const condition = guards.get(edge.guards[0]).predicate;
    targetsByCondition.set(condition, (targetsByCondition.get(condition) ?? new Set()).add(edge.to));
  }
  const ambiguous = [...targetsByCondition]
    .filter(([, targets]) => targets.size > 1)
    .map(([condition, targets]) => `${condition} -> ${[...targets].join(", ")}`);
  assert.deepEqual(ambiguous, [], "one condition offering several destinations makes all but the first unreachable");

  // Distinct ids are not distinct conditions. Section 2 hangs both branches off
  // one premise — a subject or scope change — and separates them by artifact
  // kind, so each branch must carry the premise and the kind must exclude the
  // other. Without that, a Tickets subject change satisfied both and the lower
  // priority won, sending Tickets to a step section 2 says never takes them.
  const predicates = new Map(graph.predicates.map((entry) => [entry.id, entry.description]));
  const branch = (to) =>
    predicates.get(guards.get(exits.find((edge) => edge.to === to).guards[0]).predicate) ?? "";
  const clarify = branch("clarify_alignment");
  const tickets = branch("present_tickets_breakdown");
  assert.match(clarify, /subject\/scope/u, "the clarify branch keeps the shared premise");
  assert.match(tickets, /subject\/scope/u, "the tickets branch keeps the shared premise");
  assert.match(clarify, /kind\s*!=\s*tickets/u, "the clarify branch excludes the kind the other branch claims");
  assert.match(tickets, /kind=tickets/u, "the tickets branch names the kind it claims");
});

test("an alternative offering either a signed decision or a policy is two edges, not one", () => {
  const graph = document();
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  const toRecord = graph.transitions.filter(
    (edge) => edge.from === "await_alignment" && edge.to === "record_alignment",
  );
  const actors = new Set(toRecord.map((edge) => guards.get(edge.guards[0]).authority.actor));
  assert.deepEqual(
    [...actors].sort(),
    ["human", "policy"],
    "section 2 allows a new daemon decision or a current policy; collapsing them left a signed decision unable to satisfy the guard",
  );
});

test("entry_steps is what makes the other registered workflows reachable", () => {
  const graph = document();
  assert.ok(graph.entry_steps.length > 0, "the document declares entries beyond first_step");
  const withoutEntries = { ...graph, entry_steps: [] };
  withoutEntries.canonical_digest = graphDigest(withoutEntries);
  const errors = validateGraph(withoutEntries, schema);
  assert.ok(
    errors.some((message) => message.startsWith("graph_step_unreachable")),
    `dropping the entries should orphan steps, got:\n${errors.join("\n") || "(no findings)"}`,
  );
  for (const entry of graph.entry_steps) {
    assert.ok(entry.reason.length > 0, `${entry.step} says why it is entered`);
  }
});

test("an entry naming a step the document never declares is refused", () => {
  assertRefuses(
    mutated((graph) => {
      graph.entry_steps = [{ step: "not_a_step", reason: "an entry the graph cannot be at" }];
    }),
    "graph_entry_step_unknown",
  );
});

test("a reason may name a whole step class without exceeding the schema's bound", () => {
  const graph = document();
  // The bound is on each field, and what has to fit is how many steps one reason
  // names between them: the split moved 46 of `project_boundary_invalid`'s 68 into
  // `handled_at` without any of them ceasing to be a step the row is about.
  const width = (row) => row.parks_at.length + (row.handled_at?.length ?? 0);
  const widest = graph.recovery.reduce((a, b) => (width(a) >= width(b) ? a : b));
  assert.ok(
    width(widest) > 32,
    `expected a class-wide reason above the previous bound, widest was ${widest.reason} at ${width(widest)}`,
  );
  assert.deepEqual(validateGraph(graph, schema), []);
});

test("a phase sequence that works and stays put is carried as a self-loop", () => {
  const graph = document();
  const descriptions = graph.predicates.map((entry) => entry.description);
  // Section 2 gives the candidate audit transfer a phase per row, each doing its
  // work and repeating. It says "repeat" three of those times with the bare word,
  // and matching only the longer phrasings dropped the rows entirely — the step
  // could reach the phase and never act on it.
  for (const phase of ["phase=prepared", "phase=audit_ref_verified", "phase=live_ref_deleted"]) {
    assert.ok(
      descriptions.some((text) => text.includes(`candidate_audit_transfer_op ${phase}`)),
      `no predicate carries the audit transfer's ${phase}`,
    );
  }
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  const predicates = new Map(graph.predicates.map((entry) => [entry.id, entry.description]));
  const staysPut = graph.transitions.filter(
    (edge) =>
      edge.from === edge.to &&
      edge.guards.some((id) => (predicates.get(guards.get(id).predicate) ?? "").includes("candidate_audit_transfer_op")),
  );
  assert.ok(staysPut.length > 0, "the phases advance in place rather than moving the flow");
});

test("an exit taken from a chain names the workflow whose chain draws it", () => {
  const graph = document();
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  const predicates = new Map(graph.predicates.map((entry) => [entry.id, entry.description]));
  const exits = graph.transitions.filter((edge) => edge.from === "emit_blocked_anchor");
  assert.ok(exits.length > 1, "the step leaves to a different validation in each workflow");

  // One shared condition over several destinations lets priority decide for every
  // workflow at once: a contest seat would have gone to `done` rather than to
  // `validate_disposition`, skipping the validation it exists for.
  const named = exits.map((edge) => {
    const description = predicates.get(guards.get(edge.guards[0]).predicate) ?? "";
    return { to: edge.to, workflow: /registered workflow (\S+)/u.exec(description)?.[1] ?? null };
  });
  assert.deepEqual(
    named.filter((entry) => entry.workflow === null),
    [],
    "every chain-derived exit states which workflow's chain draws it",
  );

  // Distinct workflow strings are not the property that matters. Two registered
  // workflows draw `emit_blocked_anchor -> validate_verdict`, and a chain reader
  // keyed on the pair alone kept only the later one — so autosk-code-review had
  // no exit from this step at all while the graph still looked consistent. What
  // must hold is that every workflow/destination pair section 2 draws is present.
  assert.deepEqual(
    named.map((entry) => `${entry.workflow} -> ${entry.to}`).sort(),
    [
      "autosk-arena-candidate -> done",
      "autosk-arena-judge -> validate_judgment",
      "autosk-code-review -> validate_verdict",
      "autosk-contest-seat -> validate_disposition",
      "autosk-panel-seat -> validate_verdict",
    ],
    "section 2 draws one exit per registered workflow whose chain leaves this step",
  );
});

test("what a predicate reads is state, never a destination or a refusal code", () => {
  const graph = document();
  const steps = new Set(graph.steps.map((step) => step.name));
  const codes = parkReasons();
  // `reads` exists so a guard cannot quietly widen what it looks at. Deriving it
  // from the outcome put destination names in it — `clarify_alignment` as an
  // input to the condition that sends the flow there — which both misstates the
  // inputs and hides how many conditions have no named state at all.
  const wrong = [];
  for (const entry of graph.predicates) {
    for (const name of entry.reads) {
      if (steps.has(name)) wrong.push(`${entry.id} reads step ${name}`);
      if (codes.has(name)) wrong.push(`${entry.id} reads refusal code ${name}`);
    }
  }
  assert.deepEqual(wrong, []);
});

// --- the document says why it parks, and where the reason comes from --------

/**
 * Two checks the runtime already made and the design did not.
 *
 * Slice 5 built the workflow from this document and refused one whose park
 * could not say why — but only at build, which is after the document has been
 * shipped, pinned and digested. The example in this very directory is the proof
 * that design-time silence is not harmless: the validator accepts it and the
 * factory refuses it, so the file the contract offers as a well-formed graph
 * cannot be built.
 */

test("graph_park_reason_ambiguous: a parking edge whose guards name two reasons", () => {
  assertRefuses(
    mutated((graph) => {
      graph.transitions.find((edge) => edge.id === "intake_to_await").guards = [
        "alignment_closed_by_user",
        "readiness_closed_by_policy",
      ];
    }),
    "graph_park_reason_ambiguous",
  );
});

test("graph_park_reason_ambiguous: a parking edge no guard gives a reason", () => {
  // The example ships in exactly this state, which is why the factory refuses
  // it. The mutation is the repair removed again.
  assertRefuses(
    mutated((graph) => {
      graph.transitions.find((edge) => edge.id === "intake_to_await").guards = [];
    }),
    "graph_park_reason_ambiguous",
  );
});

/**
 * The union is the rule, and this pins it.
 *
 * `resume_targets` is bound to the edges leaving ANY of a reason's `parks_at`
 * steps, which the contract states deliberately: a flow parked at one of them
 * may resume into a step reachable only from another. All 538 targets are an
 * edge out of at least one such step, which is what the validator enforces;
 * 207 are an edge out of every one of them and 331 are not, and a live daemon
 * was observed taking one of the 331. Narrowing the check to the step the flow
 * is at would strip them, so it is not a tightening anyone may do quietly — it
 * is a rewrite of the recovery table, and this test is what makes it loud.
 *
 * The union now spans both of a row's lists, so the mutation spells it that way:
 * `record_alignment` is where the reason is handled, not where the graph parks it,
 * and putting it back in `parks_at` is refused by a different check entirely.
 */
test("the union is deliberate: a target reachable from one named step and not another is accepted", () => {
  const graph = mutated((entry) => {
    const row = entry.recovery.find((candidate) => candidate.reason === "quick_classification_invalid");
    row.parks_at = ["intake"];
    row.handled_at = ["record_alignment"];
  });
  // await_alignment leaves intake and does not leave record_alignment.
  const leaving = (name) => graph.transitions.filter((edge) => edge.from === name).map((edge) => edge.to);
  assert.ok(leaving("intake").includes("await_alignment"));
  assert.ok(!leaving("record_alignment").includes("await_alignment"));
  assert.deepEqual(validateGraph(graph, schema), []);
});

test("no edge in the working example parks without saying why", async () => {
  // The example shipped with `intake_to_await` carrying no guard at all, so the
  // factory refused it — the file this contract offers as a well-formed graph
  // could not be built. It is still not buildable by THIS factory, for an
  // unrelated and deliberate reason: `record_alignment` declares `onAbort`,
  // which the factory does not build. So what is asserted is the defect that
  // was fixed, not a property the example was never meant to have.
  const { index, nameable, parks } = await import("../src/host/workflow-factory.mjs");
  const state = index(example());
  const silent = [...state.outgoing.values()].flat().filter((edge) => parks(state, edge.to) && !nameable(state, edge));
  assert.deepEqual(silent.map((edge) => edge.id), []);
});

/**
 * Every parking edge whose row names a reason names the one its guard carries.
 *
 * The predicate descriptions are the rows of section 2 as extracted, so a guard
 * whose reason the description does not name is a reason nobody wrote down.
 * Seven edges are named here because their rows name no reason at all: two are
 * drawn by a chain the tables give no condition for, four state a destination
 * chosen "by classification" without saying what the stop is called, and
 * `t_456` is a SUCCESS path — row 504 ends "park human" and names nothing —
 * carrying `anchor_resume_intent_invalid`, which row 510 gives to a different
 * condition. That one is the open question this ticket does not close; it is
 * named here so it stays visible rather than passing as silence.
 */
const PARKS_WITHOUT_A_NAMED_REASON = Object.freeze([
  "t_366", "t_367", "t_456", "t_478", "t_481", "t_511", "t_517",
]);

/**
 * Whether a row names this code as the reason, rather than reading the field of
 * the same name.
 *
 * Several codes are also metadata field names: `cond_346` says
 * `waiting_parent_anchor=false`, which is a condition on state and not a stop
 * called `waiting_parent_anchor`. A bare substring match read it as the latter
 * and reported a row that says nothing of the kind.
 */
const namesReason = (described, code) =>
  new RegExp(`\`?${code}\`?(?![\\w=])`, "u").test(described.replace(new RegExp(`${code}\\s*=`, "gu"), ""));

test("a parking edge carries the reason its own row names", () => {
  const graph = document();
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  const predicates = new Map(graph.predicates.map((entry) => [entry.id, entry]));
  const steps = new Map(graph.steps.map((step) => [step.name, step]));
  const codes = parkReasons();
  const parks = (name) => steps.get(name)?.kind === "status" && steps.get(name).status === "human";

  const silent = [];
  const wrong = [];
  for (const edge of graph.transitions) {
    if (!parks(edge.to)) continue;
    for (const id of edge.guards) {
      const guard = guards.get(id);
      const described = predicates.get(guard.predicate).description;
      const named = [...codes].filter((code) => namesReason(described, code));
      if (named.length === 0) silent.push(edge.id);
      else if (!named.includes(guard.park_reason)) wrong.push(`${edge.id} carries ${guard.park_reason}, its row names ${named.join(" or ")}`);
    }
  }
  assert.deepEqual(wrong, [], `parking edges carrying a reason their row does not name:\n${wrong.join("\n")}`);
  assert.deepEqual([...new Set(silent)].sort(), [...PARKS_WITHOUT_A_NAMED_REASON].sort());
});

// --- parks_at is checked against where the graph actually parks -------------

/**
 * `resume_targets` is bound to the edges leaving a reason's `parks_at` and
 * `handled_at` steps, and until these checks nothing defended that set. A row
 * could omit the very step whose guard names the reason, and the union would
 * then be computed over steps the flow never stops at.
 *
 * The check used to be ONE directional, and the test below it used to pin that:
 * a row could list more than the graph produces, because `parks_at` was doing
 * two jobs at once. `project_boundary_invalid` listed 68 steps while the graph
 * parks it at 18, and demanding equality would have called that a defect. The
 * fifty extra were not parks — they are where the reason is handled and where
 * resume leaves from, which is now `handled_at`. With the two jobs named apart
 * the check closes in both directions, and the pin is deliberately inverted:
 * what was accepted is now refused, with the surplus moved rather than deleted.
 *
 * One structural exemption survives, and it is not a list of names: a status step
 * is a place a parked task STANDS, and standing there is exactly what `parks_at`
 * records. A park into a human status step moves the task onto it, measured on a
 * running daemon, so `human` in a `parks_at` is that fact and not a stale entry.
 * The graph cannot say it for them — what it produces is the step an edge LEAVES,
 * and a step is only ever named there as a park's origin, never as its landing.
 */

test("graph_recovery_parks_at_incomplete: a guard names a reason at a step its row omits", () => {
  assertRefuses(
    mutated((graph) => {
      graph.guards.push({
        id: "stale_at_freeze",
        predicate: "alignment_recorded",
        authority: { actor: "agent" },
        park_reason: "alignment_record_stale",
      });
      // freeze_artifact, because alignment_record_stale's row lists only
      // record_alignment: a park at a step the row DOES list is exactly what
      // this check must not refuse.
      graph.transitions.push({
        id: "freeze_to_await",
        from: "freeze_artifact",
        to: "await_alignment",
        priority: 2,
        guards: ["stale_at_freeze"],
      });
    }),
    "graph_recovery_parks_at_incomplete",
  );
});

test("graph_recovery_parks_at_incomplete: a step's own no_transition_reason counts as parking there", () => {
  assertRefuses(
    mutated((graph) => {
      graph.steps.find((step) => step.name === "freeze_artifact").no_transition_reason = "alignment_record_stale";
    }),
    "graph_recovery_parks_at_incomplete",
  );
});

test("graph_recovery_parks_at_unproduced: a parks_at wider than the graph produces is refused", () => {
  assertRefuses(
    mutated((entry) => {
      entry.recovery.find((row) => row.reason === "artifact_freeze_invalid").parks_at = ["freeze_artifact", "record_artifact_pass"];
    }),
    "graph_recovery_parks_at_unproduced",
  );
});

test("the same step in handled_at is accepted: the check offers a place to move to, not only a refusal", () => {
  const graph = mutated((entry) => {
    const row = entry.recovery.find((r) => r.reason === "artifact_freeze_invalid");
    row.parks_at = ["freeze_artifact"];
    row.handled_at = ["record_artifact_pass"];
  });
  // Nothing in this document parks artifact_freeze_invalid at record_artifact_pass.
  const produced = graph.guards.filter((guard) => guard.park_reason === "artifact_freeze_invalid");
  assert.ok(produced.length > 0 && !graph.steps.some((step) => step.no_transition_reason === "artifact_freeze_invalid" && step.name === "record_artifact_pass"));
  assert.deepEqual(validateGraph(graph, schema), []);
});

test("a status step in parks_at is accepted: it is where a parked task stands", () => {
  const graph = mutated((entry) => {
    entry.recovery.find((row) => row.reason === "artifact_freeze_invalid").parks_at = ["freeze_artifact", "await_alignment"];
  });
  // The exemption is keyed on the kind and nothing else. `await_alignment` has
  // outgoing edges, so "a status step has none" would be the wrong reason to give:
  // what makes it exempt is that a parked task stands on it, which is a landing and
  // the graph only ever names origins.
  assert.equal(graph.steps.find((step) => step.name === "await_alignment").kind, "status");
  assert.ok(graph.transitions.some((edge) => edge.from === "await_alignment"));
  assert.deepEqual(validateGraph(graph, schema), []);
});

test("handled_at is checked for unknown step names the same way parks_at is", () => {
  assertRefuses(
    mutated((entry) => {
      entry.recovery.find((row) => row.reason === "artifact_freeze_invalid").handled_at = ["no_such_step"];
    }),
    "graph_step_unknown",
  );
});

test("resume is permitted out of a handled_at step, not only out of a parks_at step", () => {
  const graph = mutated((entry) => {
    const row = entry.recovery.find((r) => r.reason === "artifact_freeze_invalid");
    row.handled_at = ["record_artifact_pass"];
    // An edge leaving record_artifact_pass and nothing else: without the union the
    // target is unreachable and `resume_target_not_permitted` fires.
    const edge = entry.transitions.find((t) => t.from === "record_artifact_pass");
    row.resume_targets = [edge.to];
  });
  assert.deepEqual(validateGraph(graph, schema), []);
});

test("the shipped document lists every step the graph parks a reason at", () => {
  const graph = document();
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  const steps = new Map(graph.steps.map((step) => [step.name, step]));
  const parks = (name) => steps.get(name)?.kind === "status" && steps.get(name).status === "human";
  const where = new Map();
  const add = (reason, name) => {
    if (!where.has(reason)) where.set(reason, new Set());
    where.get(reason).add(name);
  };
  for (const edge of graph.transitions) {
    if (!parks(edge.to)) continue;
    for (const id of edge.guards) add(guards.get(id).park_reason, edge.from);
  }
  for (const step of graph.steps) if (step.no_transition_reason) add(step.no_transition_reason, step.name);
  for (const cap of graph.caps) {
    const counted = graph.transitions.find((edge) => edge.id === cap.counted_transition);
    if (counted) add(cap.park_reason, counted.from);
  }
  const missing = [];
  for (const row of graph.recovery) {
    for (const name of [...(where.get(row.reason) ?? [])].sort()) {
      if (!row.parks_at.includes(name)) missing.push(`${row.reason} parks at ${name}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("graph_recovery_parks_at_incomplete: a cap counts an edge whose reason its row does not list there", () => {
  // The third producer. Deleting the cap loop from `producedAt` left every test
  // in this file green, which is the shape this epic keeps producing: a branch
  // whose absence nothing notices. The example's own cap already parks
  // `review_cap` at `freeze_artifact`, which its row lists — so the case is
  // built from a second cap on the same counted transition with a reason whose
  // row names a different step.
  assertRefuses(
    mutated((graph) => {
      graph.caps.push({
        cycle: "isolated_cap",
        counted_transition: "freeze_retry",
        limit: 3,
        park_reason: "alignment_record_stale",
      });
    }),
    "graph_recovery_parks_at_incomplete",
  );
});
