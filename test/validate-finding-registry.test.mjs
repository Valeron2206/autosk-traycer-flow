/**
 * Tests for the issue #16 finding-registry validator.
 *
 * The point of this registry is that four answers become one decision by
 * computation rather than by summary, so each case here attacks a way the
 * summary could have crept back in: a dropped reviewer, an averaged severity, a
 * rejection with nothing behind it, a contest that skipped someone, a verdict
 * that does not follow from its own findings.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CONTRACT_PATH,
  EXAMPLE_PATH,
  PARK_REASONS,
  REJECTION_REASONS,
  ROOT,
  SCHEMA_PATH,
  SEVERITY,
  computeGate,
  effectiveSeverity,
  findingRegistryDesignDigest,
  loadFiles,
  registryDigest,
  validateFindingRegistryDesign,
  validateRegistry,
} from "../scripts/validate-finding-registry.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

function example() {
  return JSON.parse(files[EXAMPLE_PATH]);
}

function mutated(mutate, { reseal = true, regate = true } = {}) {
  const value = example();
  mutate(value);
  if (regate) value.gate = computeGate(value);
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

function findingNamed(value, id) {
  return value.canonical_findings.find((entry) => entry.canonical_id === id);
}

test("the shipped design validates", () => {
  assert.deepEqual(validateFindingRegistryDesign(files), []);
});

test("the example validates, its gate follows from its findings, and its digest recomputes", () => {
  const value = example();
  assert.deepEqual(validateRegistry(value, schema), []);
  assert.deepEqual(value.gate, computeGate(value));
  assert.equal(value.registry_digest, registryDigest(value));
});

test("a raw finding left out of every canonical finding is refused", () => {
  // Dropping a reviewer's answer is exactly what a prose synthesis can do
  // without anyone noticing.
  // Dropping the canonical finding, not emptying it: an empty originator list is
  // refused by the schema first, which would leave this check unobserved.
  assertRejects(
    mutated((value) => {
      value.canonical_findings = value.canonical_findings.filter((entry) => entry.canonical_id !== "C002");
    }),
    /grok:A7: raw finding is in no canonical finding/u,
  );
});

test("one raw finding cannot be merged into two canonical findings", () => {
  assertRejects(
    mutated((value) => {
      findingNamed(value, "C002").originators = ["grok:A7", "muse:M5"];
    }),
    /already merged into another canonical finding/u,
  );
});

test("an originator that names no raw finding is refused", () => {
  assertRejects(
    mutated((value) => {
      findingNamed(value, "C002").originators = ["grok:NOPE"];
    }),
    /names no raw finding \(originator_unknown\)/u,
  );
});

test("the pre-triage severity is the highest any seat reported", () => {
  // Two seats disagreeing must not average their way to a milder finding than
  // either of them reported.
  assertRejects(
    mutated((value) => {
      findingNamed(value, "C001").reported_severity = "high";
    }),
    /the highest any seat reported is critical/u,
  );
});

test("a rejection needs both a reason and a citable basis", () => {
  assertRejects(
    mutated((value) => {
      delete findingNamed(value, "C004").triage.basis;
    }),
    /a rejection needs a citable basis/u,
  );
  assertRejects(
    mutated((value) => {
      delete findingNamed(value, "C004").triage.rejection_reason;
    }),
    new RegExp(`a rejection must name one of ${REJECTION_REASONS.join(", ")}`, "u"),
  );
});

test("a downgrade needs a citable basis and must actually lower the severity", () => {
  assertRejects(
    mutated((value) => {
      findingNamed(value, "C002").triage = { decision: "confirmed_lower_severity", severity: "low" };
    }),
    /a downgrade needs a citable basis/u,
  );
  assertRejects(
    mutated((value) => {
      findingNamed(value, "C002").triage = {
        decision: "confirmed_lower_severity",
        severity: "critical",
        basis: { kind: "anchor", reference: "tech_plan#scope" },
      };
    }),
    /does not lower medium/u,
  );
});

test("raising severity must state a reason and must actually raise it", () => {
  assertRejects(
    mutated((value) => {
      delete findingNamed(value, "C003").triage.reason;
    }),
    /raising severity must state a reason/u,
  );
  assertRejects(
    mutated((value) => {
      findingNamed(value, "C003").triage.severity = "low";
    }),
    /does not raise medium/u,
  );
});

test("a plain confirmation cannot change the severity", () => {
  assertRejects(
    mutated((value) => {
      findingNamed(value, "C002").triage = { decision: "confirmed", severity: "low" };
    }),
    /a plain confirmation cannot change the severity/u,
  );
});

test("the contest must reach every originating seat", () => {
  // Not only the loudest one: a finding two seats raised is contested with both.
  assertRejects(
    mutated((value) => {
      findingNamed(value, "C001").contest = [{ seat: "astra", outcome: "upheld" }];
    }),
    /opus originated it and has no outcome \(contest_incomplete\)/u,
  );
});

test("a seat gets one attempt, and only where it originated", () => {
  assertRejects(
    mutated((value) => {
      findingNamed(value, "C002").contest = [
        { seat: "grok", outcome: "upheld" },
        { seat: "grok", outcome: "withdrawn" },
      ];
    }),
    /contested twice; each originator has one attempt/u,
  );
  assertRejects(
    mutated((value) => {
      findingNamed(value, "C002").contest = [
        { seat: "grok", outcome: "upheld" },
        { seat: "opus", outcome: "withdrawn" },
      ];
    }),
    /did not originate this finding, so it has no contest window/u,
  );
});

test("a forfeited contest does not close a confirmed finding", () => {
  // Absence is not agreement. The finding stays open and keeps blocking.
  const value = mutated((draft) => {
    const finding = findingNamed(draft, "C001");
    finding.contest = [
      { seat: "astra", outcome: "upheld" },
      { seat: "opus", outcome: "forfeited" },
    ];
    finding.state = "open";
    delete finding.disposition;
  });
  assert.deepEqual(validateRegistry(value, schema), []);
  assert.equal(value.gate.blocking_open, 1);
  assert.equal(value.gate.verdict, "blocked");
});

test("an undispositioned medium blocks the pass", () => {
  const value = mutated((draft) => {
    const finding = findingNamed(draft, "C002");
    delete finding.disposition;
    delete finding.debt_ticket;
  });
  assert.deepEqual(validateRegistry(value, schema), []);
  assert.equal(value.gate.undispositioned_medium, 1);
  assert.equal(value.gate.verdict, "blocked");
});

test("a deferred finding must create a tracked debt Ticket", () => {
  assertRejects(
    mutated((value) => {
      delete findingNamed(value, "C002").debt_ticket;
    }),
    /must create a tracked debt Ticket \(missing_debt_ticket\)/u,
  );
});

test("a finding closes on a disposition, not on an edit having been made", () => {
  assertRejects(
    mutated((value) => {
      delete findingNamed(value, "C001").disposition;
      findingNamed(value, "C001").state = "resolved";
    }),
    /closes on a re-review disposition/u,
  );
});

test("a finding bound to another candidate must be marked stale", () => {
  assertRejects(
    mutated((value) => {
      findingNamed(value, "C002").candidate_identity = "cand-older";
    }),
    /bound to another candidate but not marked stale/u,
  );
});

test("a stale finding does not block the current candidate", () => {
  const value = mutated((draft) => {
    const finding = findingNamed(draft, "C002");
    finding.state = "stale";
    finding.candidate_identity = "cand-older";
    delete finding.disposition;
    delete finding.debt_ticket;
  });
  assert.deepEqual(validateRegistry(value, schema), []);
  assert.equal(value.gate.verdict, "pass");
});

test("a rejected finding does not block, whatever its severity was", () => {
  const value = mutated((draft) => {
    const finding = findingNamed(draft, "C001");
    finding.state = "open";
    delete finding.disposition;
    finding.triage = {
      decision: "rejected",
      rejection_reason: "intended_behavior",
      basis: { kind: "accepted_decision", reference: "ADR-028" },
    };
  });
  assert.deepEqual(validateRegistry(value, schema), []);
  assert.equal(value.gate.verdict, "pass");
});

test("the gate must be computed, not asserted", () => {
  assertRejects(
    mutated(
      (value) => {
        value.gate = { blocking_open: 0, undispositioned_medium: 0, verdict: "pass" };
        delete findingNamed(value, "C002").disposition;
        delete findingNamed(value, "C002").debt_ticket;
      },
      { regate: false },
    ),
    /gate\.(undispositioned_medium|verdict) is/u,
  );
});

test("effective severity follows triage, and the scale is closed", () => {
  assert.equal(effectiveSeverity(findingNamed(example(), "C003")), "high");
  assert.equal(effectiveSeverity(findingNamed(example(), "C002")), "medium");
  assert.deepEqual(schema.properties.raw_findings.items.properties.severity.enum, [...SEVERITY]);
});

test("a digest that does not recompute is refused", () => {
  assertRejects(
    mutated(
      (value) => {
        value.raw_findings[0].claim = "reworded after the fact";
      },
      { reseal: false },
    ),
    /registry_digest does not recompute/u,
  );
});

test("every park reason is documented in the contract", () => {
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  for (const reason of PARK_REASONS) {
    assert.ok(contract.includes(reason), `${reason} is not documented`);
  }
});

test("the design digest changes when any of the three files changes", () => {
  const before = findingRegistryDesignDigest(files);
  const after = findingRegistryDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
