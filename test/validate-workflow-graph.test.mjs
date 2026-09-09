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
  REFERENCE_PATH,
  REFUSALS,
  REFUSED_PATH,
  SCHEMA_PATH,
  canonicalBytes,
  canonicalText,
  encodeName,
  graphDigest,
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
