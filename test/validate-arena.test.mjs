/**
 * Tests for the `autosk-arena` block (#4).
 *
 * Arena is the branch that changes a Tech Plan, and it had neither a contract
 * nor a schema while Debate — the path it is chosen instead of — had both.
 * These check the three ways the arrangement becomes theatre: candidates that
 * saw each other, a judge that approves rather than ranks, and a winner that
 * never re-entered the plan.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CONTRACT_MARKER,
  CONTRACT_PATH,
  EXAMPLE_PATH,
  REFUSALS,
  REFUSED_CANDIDATE_START,
  REFUSED_PATH,
  ROOT,
  SCHEMA_PATH,
  blockErrors,
  candidateErrors,
  framingErrors,
  judgmentErrors,
  reexpressionErrors,
  validateDesign,
} from "../scripts/validate-arena.mjs";

const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");
const files = Object.fromEntries(
  [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, REFUSED_PATH].map((relative) => [relative, read(relative)]),
);
const block = () => JSON.parse(files[EXAMPLE_PATH]);
const reasons = (list) => [...new Set(list.map((entry) => entry.reason))].sort();

test("the shipped design validates", () => {
  assert.deepEqual(validateDesign(files), []);
  assert.deepEqual(blockErrors(block()), []);
});

test("three to six criteria, and none added after a candidate started", () => {
  // Fewer than three is not a comparison; more than six lets the judge choose
  // which axes to weigh, which is a decision nobody delegated.
  const two = block();
  two.framing.criteria = two.framing.criteria.slice(0, 2);
  assert.deepEqual(reasons(framingErrors(two)), ["arena_framing_changed"]);

  const seven = block();
  const extra = (id) => ({ id, statement: "s", measurement: "m" });
  seven.framing.criteria = [...seven.framing.criteria, extra("d"), extra("e"), extra("f"), extra("g")];
  assert.deepEqual(reasons(framingErrors(seven)), ["arena_framing_changed"]);

  const duplicated = block();
  duplicated.framing.criteria.push({ ...duplicated.framing.criteria[0] });
  assert.ok(reasons(framingErrors(duplicated)).includes("arena_framing_changed"));

  // A criterion written once the work exists is a criterion written to fit it.
  assert.deepEqual(framingErrors(block(), { candidateStartedAt: "2026-09-09T01:00:00Z" }), []);
  assert.deepEqual(
    reasons(framingErrors(block(), { candidateStartedAt: "2026-09-08T00:00:00Z" })),
    ["arena_framing_changed"],
  );
});

test("two candidates that saw each other are one candidate with extra steps", () => {
  assert.deepEqual(candidateErrors(block()), []);
  assert.deepEqual(reasons(candidateErrors(block(), { contamination: ["B"] })), ["arena_candidate_contaminated"]);
});

test("fewer than two live candidates from distinct families ends the Arena", () => {
  const withdrawn = block();
  withdrawn.candidates[1].state = "withdrawn";
  assert.deepEqual(reasons(candidateErrors(withdrawn)), ["arena_fallback_required"]);

  // Two live candidates from the same family are one family's answer twice.
  const sameFamily = block();
  sameFamily.candidates[1].family = sameFamily.candidates[0].family;
  assert.deepEqual(reasons(candidateErrors(sameFamily)), ["arena_fallback_required"]);

  const third = block();
  third.candidates.push({ slot: "C", family: "kimi", worktree_digest: "9".repeat(64), state: "live" });
  assert.deepEqual(reasons(candidateErrors(third)), ["arena_framing_changed"]);
  third.candidates[2].reason_for_third = "a third framing nobody else covered";
  assert.deepEqual(candidateErrors(third), []);
});

test("the judge is from a family outside the candidate set", () => {
  const conflicted = block();
  conflicted.judgment.judge_family = conflicted.candidates[0].family;
  assert.ok(reasons(judgmentErrors(conflicted)).includes("arena_judge_family_conflict"));
});

test("a winner named without scoring every criterion is not a ranking", () => {
  const partial = block();
  partial.judgment.scores = partial.judgment.scores.slice(0, 2);
  assert.ok(reasons(judgmentErrors(partial)).includes("arena_judgment_incomplete"));
  // A withdrawn candidate is not scored, and that is not a gap.
  const withdrawn = block();
  withdrawn.candidates[1].state = "withdrawn";
  withdrawn.judgment.scores = withdrawn.judgment.scores.filter((entry) => entry.slot === "A");
  assert.ok(!reasons(judgmentErrors(withdrawn)).includes("arena_judgment_incomplete"));
});

test("ranking is not approving", () => {
  // A role that both produced the ranking and closed the decision would be the
  // model approving its own material choice.
  const selfApproved = block();
  selfApproved.decision.decided_by = "judge";
  assert.ok(reasons(judgmentErrors(selfApproved)).includes("arena_judgment_is_not_approval"));
});

test("a decision that is not re-expressed did not happen", () => {
  assert.deepEqual(reexpressionErrors(block()), []);
  const unchanged = block();
  unchanged.reexpression.post_arena_identity = unchanged.reexpression.pre_arena_identity;
  assert.deepEqual(reasons(reexpressionErrors(unchanged)), ["arena_reexpression_missing"]);
});

test("an Arena result never takes the narrow path", () => {
  // The narrow path fixes confirmed findings without changing scope, and an
  // Arena result is a scope change by construction.
  const narrow = block();
  narrow.reexpression.narrow = true;
  assert.deepEqual(reasons(reexpressionErrors(narrow)), ["arena_narrow_exemption_claimed"]);
});

test("a block that is not a block is refused as one thing", () => {
  assert.deepEqual(reasons(blockErrors(undefined)), ["arena_contract_invalid"]);
  assert.deepEqual(reasons(blockErrors("an autosk-arena block")), ["arena_contract_invalid"]);
});

test("the design self-check can fail, so its passing means something", () => {
  const broken = (changes) => validateDesign({ ...files, ...changes });
  assert.ok(
    broken({ [CONTRACT_PATH]: files[CONTRACT_PATH].replace(CONTRACT_MARKER, "") })
      .some((error) => /contract marker is missing/u.test(error)),
  );
  assert.ok(
    broken({ [CONTRACT_PATH]: files[CONTRACT_PATH].replaceAll("`arena_framing_changed`", "framing changed") })
      .some((error) => /arena_framing_changed is not named/u.test(error)),
  );
  const open = JSON.parse(files[SCHEMA_PATH]);
  open.additionalProperties = true;
  assert.ok(broken({ [SCHEMA_PATH]: JSON.stringify(open) }).some((error) => /schema is not closed/u.test(error)));
  assert.ok(
    broken({ [EXAMPLE_PATH]: files[REFUSED_PATH] }).some((error) => /the worked example is refused/u.test(error)),
  );
  assert.ok(
    broken({ [REFUSED_PATH]: files[EXAMPLE_PATH] })
      .some((error) => /produces only \d refusal classes/u.test(error)),
  );
});

test("every refusal class the contract closes can be produced", () => {
  const produced = new Set(
    blockErrors(JSON.parse(files[REFUSED_PATH]), { contamination: ["B"], candidateStartedAt: REFUSED_CANDIDATE_START })
      .map((entry) => entry.reason),
  );
  const narrow = block();
  narrow.reexpression.narrow = true;
  for (const entry of reexpressionErrors(narrow)) produced.add(entry.reason);
  const selfApproved = block();
  selfApproved.decision.decided_by = "judge";
  for (const entry of judgmentErrors(selfApproved)) produced.add(entry.reason);
  for (const entry of blockErrors(undefined)) produced.add(entry.reason);
  for (const refusal of REFUSALS) {
    assert.ok(produced.has(refusal), `${refusal} is documented and never produced`);
  }
});
