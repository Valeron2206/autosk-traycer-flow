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
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CANDIDATE_PATH,
  ROOT,
  GROUP_A,
  GROUP_B,
  REQUIRED_PANEL,
  SCHEMA_PATH,
  candidateDigest,
  computeAttestationState,
  loadFiles,
  validateCandidate,
  validateDesignCandidate,
} from "../scripts/validate-design-candidate.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

function candidate() {
  return JSON.parse(files[CANDIDATE_PATH]);
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
  const round = JSON.parse(readFileSync(path.join(ROOT, "resources/design-candidate/panel/round-1.json"), "utf8"));
  assert.equal(round.candidate_digest.length, 64);
  assert.notEqual(round.candidate_digest, candidate().candidate_digest);
  assert.equal(round.seats.length, 4);
  for (const required of REQUIRED_PANEL) {
    const seat = round.seats.find((entry) => entry.seat === required.seat);
    assert.equal(seat.route, required.route);
    assert.equal(seat.effort, required.effort);
    assert.equal(seat.verdict, "fail");
    assert.ok(seat.session_id.length > 0, required.seat);
    assert.ok(seat.findings.length > 0, required.seat);
  }
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
      value.required_panel.find((entry) => entry.seat === "opus").effort = "high";
    }),
    /is not anthropic\/claude-opus-5\/max/u,
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
