/**
 * Tests for the issue #39 design candidate and attestation.
 *
 * Two things must be impossible, and they are the first two negative checks the
 * issue lists: a candidate that changed between seats, and an attestation that
 * says PASS without four real verdicts on the exact routes and efforts the owner
 * specified. Most cases here are one of those two.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CANDIDATE_PATH,
  ROOT,
  GROUP_A,
  GROUP_B,
  PANEL_BY_ROUND,
  PANEL_DIR,
  REQUIRED_PANEL,
  SCHEMA_PATH,
  candidateDigest,
  computeAttestationState,
  loadFiles,
  validateCandidate,
  validateDesignCandidate,
  validatePanelRound,
} from "../scripts/validate-design-candidate.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

function candidate() {
  return JSON.parse(files[CANDIDATE_PATH]);
}

function readRound(round) {
  return JSON.parse(readFileSync(path.join(ROOT, PANEL_DIR, `round-${round}.json`), "utf8"));
}

function mutated(mutate, { reseal = true } = {}) {
  const value = candidate();
  mutate(value);
  if (reseal) value.candidate_digest = candidateDigest(value);
  return value;
}

function assertRejects(value, pattern, options) {
  const errors = validateCandidate(value, schema, options);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

/** Four genuine-looking verdicts on the given digest. */
function fullPanel(digest) {
  return REQUIRED_PANEL.map((seat, index) => ({
    ...seat,
    candidate_digest: digest,
    verdict: "pass",
    session_id: `session-${index + 1}`,
    recorded_at: "2026-09-08T07:00:00Z",
  }));
}

test("the shipped candidate validates against the bytes on disk", () => {
  assert.deepEqual(validateDesignCandidate(files), []);
});

test("the shipped attestation is what the verdicts compute", () => {
  // These are not the bytes round 1 reviewed: those verdicts are about
  // candidate v2 and stay with it in resources/design-candidate/panel/. This
  // candidate has been changed by the fixes, carries no verdicts, and is
  // therefore pending — recording anything else would be the "administrative
  // status edit" the issue warns about.
  assert.equal(candidate().candidate_id, "design-candidate-v3");
  assert.equal(candidate().attestation.state, "pending_final_panel");
  assert.equal(computeAttestationState(candidate()), "pending_final_panel");
  assert.deepEqual(candidate().attestation.verdicts, []);
});

test("a round that ran is kept with the candidate it was about", () => {
  // A PASS — or a fail — is about bytes. Round 1's record names the digest it
  // reviewed, and that digest is not this one.
  const round = readRound(1);
  assert.equal(round.candidate_digest.length, 64);
  assert.notEqual(round.candidate_digest, candidate().candidate_digest);
  for (const seat of round.seats) assert.equal(seat.verdict, "fail");
});

test("every recorded round is checked against the roster it ran under", () => {
  // This assertion compared the recorded seats with `REQUIRED_PANEL` until the
  // roster was amended, which made a record of what happened fail because what
  // is required next had changed. The requirement is pinned per round instead —
  // and the two are genuinely different now, which is what the coupling hid.
  assert.notDeepEqual(PANEL_BY_ROUND[1], REQUIRED_PANEL);
  const recorded = readdirSync(path.join(ROOT, PANEL_DIR)).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(recorded, ["round-1.json", "round-2.json", "round-3.json", "round-4.json"]);
  for (const name of recorded) {
    const round = JSON.parse(readFileSync(path.join(ROOT, PANEL_DIR, name), "utf8"));
    assert.deepEqual(validatePanelRound(round), [], name);
  }
});

test("round 4 is the first recorded under a different roster, and the first without four verdicts", () => {
  // The pin per round exists for exactly this: round 4 sat the guide's critique
  // roster, rounds 1 to 3 sat the owner's, and both records stay valid.
  const round = readRound(4);
  assert.deepEqual(validatePanelRound(round), []);
  assert.notDeepEqual(PANEL_BY_ROUND[4], PANEL_BY_ROUND[1]);
  // The digest round 4 reviewed, spelled out. Comparing it with the candidate's
  // current digest would recouple the archive to the live state — the defect the
  // per-round pin exists to prevent, and one this test carried until a reviewer
  // reproduced it by adding a newline to a member and resealing.
  assert.equal(round.candidate_digest, "6a3a1213eb657d3aad1d2d1eb9f34f7e4a11eb7360ec61b011f08ae4ac335ea5");
  // One seat could not review and said so; the archive records that as a verdict
  // in the vocabulary rather than as a missing seat.
  assert.deepEqual(
    round.seats.map((seat) => seat.verdict).sort(),
    ["fail", "fail", "fail", "non_verdict"],
  );
  // And the anchor the round ran under carried two statements the seats falsified.
  assert.equal(round.anchor_corrections.length, 2);
});

test("a round recorded with a roster nobody required is refused", () => {
  // Decoupling the archive from today's constant is right; leaving it checked
  // against nothing is not. Replacing all four of round 1's seats with a roster
  // that never sat went unnoticed once the comparison was dropped, and nothing
  // else in the tree reads these files.
  const substituted = readRound(1);
  substituted.seats = substituted.seats.map((seat) => ({
    ...seat,
    seat: "never-required",
    route: "invented/model",
    effort: "arbitrary",
  }));
  assert.notDeepEqual(validatePanelRound(substituted), []);

  // One seat standing in for another is the same defect, one quarter the size.
  const swapped = readRound(1);
  swapped.seats[3] = { ...swapped.seats[3], route: "meta/muse-spark-1.3-lead", effort: "max" };
  assert.deepEqual(validatePanelRound(swapped), [
    "round 1 muse: meta/muse-spark-1.3-lead/max is not meta/muse-spark-1.3-contributor/max",
  ]);
});

test("a round that records one seat twice is refused", () => {
  // Four entries is not four seats. Duplicating one hides the omission of
  // another, and the count alone would still read as a full panel.
  const duplicated = readRound(1);
  duplicated.seats[3] = { ...duplicated.seats[0] };
  assert.deepEqual(validatePanelRound(duplicated), [
    "round 1: seat opus is recorded twice",
    "round 1: omits muse",
  ]);
});

test("a panel that found nothing can still be recorded", () => {
  // Requiring findings from every seat made a clean PASS unrecordable: the
  // archive check would have refused the very result the panel exists to reach,
  // or forced somebody to invent findings to get it archived. A refusal still
  // has to say why; a pass does not.
  const seats = REQUIRED_PANEL.map((seat, index) => ({
    ...seat,
    verdict: "pass",
    session_id: `session-${index + 1}`,
    findings: [],
  }));
  assert.deepEqual(validatePanelRound({ round: 4, seats }, REQUIRED_PANEL), []);

  const refused = seats.map((seat) => ({ ...seat, verdict: "fail" }));
  assert.deepEqual(
    validatePanelRound({ round: 4, seats: refused }, REQUIRED_PANEL),
    REQUIRED_PANEL.map((seat) => `round 4 ${seat.seat}: records a fail with no findings`),
  );

  // The field itself is still required: a seat with no findings array recorded
  // nothing about findings, which is not the same as having found nothing.
  const absent = seats.map(({ findings, ...seat }) => seat);
  assert.deepEqual(
    validatePanelRound({ round: 4, seats: absent }, REQUIRED_PANEL),
    REQUIRED_PANEL.map((seat) => `round 4 ${seat.seat}: records no findings array`),
  );
});

test("a round that records no decision is refused", () => {
  // The record exists to preserve a decision, and the verdict was only looked at
  // when findings were empty — so a seat with no verdict at all, or a verdict
  // misspelled `paas` alongside real findings, validated. The vocabulary is the
  // schema's: a round's verdict and an attestation's verdict are the same thing.
  const absent = readRound(2);
  absent.seats = absent.seats.map(({ verdict, ...seat }) => seat);
  assert.deepEqual(
    validatePanelRound(absent),
    PANEL_BY_ROUND[2].map((seat) => `round 2 ${seat.seat}: records no verdict`),
  );

  const misspelled = readRound(2);
  misspelled.seats = misspelled.seats.map((seat) => ({ ...seat, verdict: "paas" }));
  assert.deepEqual(
    validatePanelRound(misspelled),
    PANEL_BY_ROUND[2].map((seat) => `round 2 ${seat.seat}: records paas, which is not a verdict`),
  );
});

test("a round with no pinned roster cannot be validated", () => {
  // A round file can only be checked against what was required when it ran, so a
  // round whose requirement was never pinned is refused rather than waved
  // through. Recording round 4 meant pinning the roster it ran under; round 5 is
  // not pinned because it has not run.
  assert.deepEqual(validatePanelRound({ round: 5, seats: [] }), [
    "round 5: no roster is pinned for it, so what it ran under is unknown",
  ]);
});

test("a candidate that drifted from disk is refused", () => {
  // "Candidate changed between seats", caught by recomputing rather than by a
  // reviewer noticing.
  assertRejects(
    mutated((value) => {
      value.files[0].sha256 = "9".repeat(64);
    }),
    /the candidate has drifted/u,
  );
});

test("a file listed but unreadable is refused", () => {
  assertRejects(
    mutated((value) => {
      value.files.push({ path: "docs/contracts/does-not-exist.md", sha256: "0".repeat(64) });
    }),
    /cannot be read/u,
  );
});

test("the candidate digest must recompute", () => {
  assertRejects(
    mutated(
      (value) => {
        value.files.pop();
      },
      { reseal: false },
    ),
    /candidate_digest does not recompute/u,
  );
});

test("four real verdicts on this digest are a pass", () => {
  const value = mutated((draft) => {
    draft.attestation.verdicts = fullPanel(candidateDigest(draft));
    draft.attestation.state = "pass";
  });
  // The digest the seats cite is the one the candidate has, so recompute after.
  value.attestation.verdicts = fullPanel(value.candidate_digest);
  assert.equal(computeAttestationState(value), "pass");
  assert.deepEqual(validateCandidate(value, schema), []);
});

test("three passes and a silence is not a pass", () => {
  // The case most likely to be rounded up.
  const value = mutated((draft) => {
    draft.attestation.verdicts = fullPanel(draft.candidate_digest).slice(0, 3);
    draft.attestation.state = "pending_final_panel";
  });
  value.attestation.verdicts = fullPanel(value.candidate_digest).slice(0, 3);
  assert.equal(computeAttestationState(value), "pending_final_panel");
});

test("a downgraded effort is not a smaller panel, it is a different one", () => {
  const value = mutated((draft) => {
    draft.attestation.state = "pending_final_panel";
  });
  const verdicts = fullPanel(value.candidate_digest);
  verdicts.find((entry) => entry.seat === "grok").effort = "high";
  value.attestation.verdicts = verdicts;
  assert.equal(computeAttestationState(value), "pending_final_panel");
});

test("a substituted route is not the panel either", () => {
  const value = mutated((draft) => {
    draft.attestation.state = "pending_final_panel";
  });
  const verdicts = fullPanel(value.candidate_digest);
  verdicts.find((entry) => entry.seat === "astra").route = "anthropic/claude-opus-5";
  value.attestation.verdicts = verdicts;
  assert.equal(computeAttestationState(value), "pending_final_panel");
});

test("verdicts about another candidate do not carry over", () => {
  // A PASS is about bytes. Four passes on a previous candidate say nothing about
  // this one.
  const value = mutated((draft) => {
    draft.attestation.state = "pending_final_panel";
  });
  value.attestation.verdicts = fullPanel(createHash("sha256").update("another candidate").digest("hex"));
  assert.equal(computeAttestationState(value), "pending_final_panel");
});

test("one fail blocks, and blocking must say why", () => {
  const value = mutated((draft) => {
    draft.attestation.state = "blocked";
    delete draft.attestation.blocked_reason;
  });
  const verdicts = fullPanel(value.candidate_digest);
  verdicts.find((entry) => entry.seat === "muse").verdict = "fail";
  value.attestation.verdicts = verdicts;
  assert.equal(computeAttestationState(value), "blocked");
  assert.ok(validateCandidate(value, schema).some((message) => /must record why/u.test(message)));
});

test("an asserted state must match the computed one", () => {
  assertRejects(
    mutated((value) => {
      value.attestation.state = "pass";
    }),
    /attestation state is pass, computed pending_final_panel/u,
  );
});

test("every group A and B issue has a closed disposition", () => {
  const declared = new Set(candidate().dispositions.map((entry) => entry.issue));
  for (const issue of [...GROUP_A, ...GROUP_B]) {
    assert.ok(declared.has(issue), `#${issue} has no disposition`);
  }
  assertRejects(
    mutated((value) => {
      value.dispositions = value.dispositions.filter((entry) => entry.issue !== 14);
    }),
    /#14: has no design disposition/u,
  );
});

test("a rejection or a deferral must be justified", () => {
  // "We will do it later" without a current safe semantics is not a closed
  // disposition, which the issue says in as many words.
  assertRejects(
    mutated((value) => {
      const entry = value.dispositions.find((item) => item.issue === 15);
      entry.disposition = "rejected";
      delete entry.rationale;
    }),
    /requires a citable rationale/u,
  );
  assertRejects(
    mutated((value) => {
      const entry = value.dispositions.find((item) => item.issue === 15);
      entry.disposition = "deferred_after_v1";
      entry.rationale = "not needed for v1";
    }),
    /requires a follow-up issue/u,
  );
});

test("the declared panel is the owner's, exactly", () => {
  assertRejects(
    mutated((value) => {
      value.required_panel.find((entry) => entry.seat === "astra").effort = "high";
    }),
    /is not openai-codex\/gpt-6-astra\/low/u,
  );
});

test("the design pack is in the candidate", () => {
  // A contract outside the candidate is a contract the panel does not review.
  const listed = new Set(candidate().files.map((file) => file.path));
  for (const required of [
    "01-core-flows.md",
    "02-architecture.md",
    "03-technical-plan.md",
    "04-decisions.md",
    "docs/contracts/artifact-registry.md",
    "docs/contracts/creation-grant.md",
    "docs/contracts/platform-support.md",
  ]) {
    assert.ok(listed.has(required), `${required} is not in the candidate`);
  }
});
