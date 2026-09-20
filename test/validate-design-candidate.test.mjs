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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CANDIDATE_PATH,
  ROOT,
  GROUP_A,
  GROUP_B,
  MEMBERSHIP_CORRECTION,
  MEMBERSHIP_EXCEPTIONS,
  MEMBERSHIP_RULE,
  NAMED_NO_FILE,
  PANEL_BY_ROUND,
  PANEL_DIR,
  REQUIRED_MEMBERS,
  REQUIRED_PANEL,
  SCHEMA_PATH,
  candidateDigest,
  computeAttestationState,
  loadFiles,
  membershipRuleErrors,
  validateCandidate,
  validateDesignCandidate,
  validatePanelRound,
} from "../scripts/validate-design-candidate.mjs";
import { MEASURED_PATH, measuredDigest } from "../scripts/lib/measured-inputs.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

/** The recorded measurement, read off disk like the floor does. */
function measuredInputs() {
  return JSON.parse(readFileSync(path.join(ROOT, MEASURED_PATH), "utf8"));
}

/** A readFile that serves `artifact` at MEASURED_PATH and disk for the rest. */
function withArtifact(artifact) {
  const text = `${JSON.stringify(artifact, null, 2)}\n`;
  return (relative) =>
    relative === MEASURED_PATH ? text : readFileSync(path.join(ROOT, relative), "utf8");
}

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
  // And the anchor the round ran under carried two statements the seats
  // falsified; a third correction withdraws §2's class clause and states the
  // operative membership rule.
  assert.equal(round.anchor_corrections.length, 3);
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

test("every measured design input is a member or a recorded exception", () => {
  // The set is measured by running the validators under a read instrument,
  // not copied from a list someone wrote: a path whose bytes can move a
  // verdict has to be pinned, or excused by name. Silence is the defect this
  // ticket shipped against.
  const listed = new Set(candidate().files.map((file) => file.path));
  const silent = measuredInputs().inputs.filter(
    (relative) => !listed.has(relative) && !MEMBERSHIP_EXCEPTIONS.has(relative),
  );
  assert.deepEqual(silent, []);
});

test("a candidate silent about a measured design input is refused", () => {
  const listed = new Set(candidate().files.map((file) => file.path));
  const target = measuredInputs().inputs.find((relative) => listed.has(relative));
  assert.ok(target, "the measurement found no member to remove");
  assertRejects(
    mutated((value) => {
      value.files = value.files.filter((file) => file.path !== target);
    }),
    /measured design input/u,
  );
});

test("the measured inputs artifact is itself a member", () => {
  // The floor reads the artifact, so the instrument records it and the
  // candidate must pin its bytes like every other measured input.
  const listed = new Set(candidate().files.map((file) => file.path));
  assert.ok(measuredInputs().inputs.includes(MEASURED_PATH));
  assert.ok(listed.has(MEASURED_PATH));
});

test("an unlisted input written into the artifact is refused", () => {
  // The floor trusts the artifact only as far as its digest: an input added
  // to the record and resealed, but never listed, is refused all the same.
  const artifact = measuredInputs();
  const added = { ...artifact, inputs: [...artifact.inputs, "resources/design-candidate/unlisted.json"].sort() };
  const { digest, ...body } = added;
  assertRejects(candidate(), /unlisted\.json.*measured design input/u, {
    readFile: withArtifact({ ...body, digest: measuredDigest(body) }),
  });
});

test("a measured inputs artifact whose digest does not recompute is refused", () => {
  const artifact = measuredInputs();
  assertRejects(candidate(), /digest does not recompute/u, {
    readFile: withArtifact({ ...artifact, digest: "0".repeat(64) }),
  });
});

test("a member entry that is a glob is refused", () => {
  // A glob is a promise about files, not a file: `panel/*.json` would pin
  // nothing, and a phantom path fails the same way — members name bytes.
  assertRejects(
    mutated((value) => {
      value.files.push({ path: "resources/design-candidate/panel/*.json", sha256: "0".repeat(64) });
    }),
    /not a glob/u,
  );
});

test("the candidate cannot list itself", () => {
  assertRejects(
    mutated((value) => {
      value.files.push({ path: CANDIDATE_PATH, sha256: "0".repeat(64) });
    }),
    /cannot list itself/u,
  );
});

test("a name that says example does not excuse a measured input", () => {
  // The reviewer's example-name scenario: a real operand renamed
  // `*.example.*` is still a measured member, and dropping it from the list
  // is refused exactly like dropping any other member.
  const target = measuredInputs().inputs.find((relative) => /example/u.test(relative));
  assert.ok(target, "the measurement found no member named example");
  assert.ok(
    candidate().files.some((file) => file.path === target),
    `${target}: a measured input named example must be listed like any other`,
  );
  assertRejects(
    mutated((value) => {
      value.files = value.files.filter((file) => file.path !== target);
    }),
    /measured design input/u,
  );
});

test("a measured input excused by a named exception passes", () => {
  // The exception mechanism is the recorded escape: a member the list does
  // not pin passes only while its name sits in MEMBERSHIP_EXCEPTIONS.
  const target = measuredInputs().inputs.find((relative) =>
    candidate().files.some((file) => file.path === relative),
  );
  assert.ok(target, "the measurement found no member to excuse");
  MEMBERSHIP_EXCEPTIONS.set(target, "test exception — exercised branch");
  try {
    const value = mutated((draft) => {
      draft.files = draft.files.filter((file) => file.path !== target);
    });
    assert.deepEqual(validateCandidate(value, schema), []);
  } finally {
    MEMBERSHIP_EXCEPTIONS.delete(target);
  }
});

const CANONICALIZER = "src/host/workflow-graph-canonical.mjs";

/**
 * Round 4 with `mutate` applied, written to a temp copy on disk — the member
 * pin and the digest resealed, so the candidate stays internally valid over
 * changed prose — and read back. Every membership case below runs over bytes
 * read from a file, the way the reviewer's probes did.
 */
function mutatedRoundOnDisk(mutate) {
  const tmp = mkdtempSync(path.join(tmpdir(), "t09-"));
  const round = readRound(4);
  mutate(round);
  const roundPath = `${PANEL_DIR}/round-4.json`;
  mkdirSync(path.join(tmp, PANEL_DIR), { recursive: true });
  writeFileSync(path.join(tmp, roundPath), `${JSON.stringify(round, null, 2)}\n`);
  const value = mutated((draft) => {
    draft.files.find((file) => file.path === roundPath).sha256 = createHash("sha256")
      .update(readFileSync(path.join(tmp, roundPath), "utf8"))
      .digest("hex");
  });
  writeFileSync(path.join(tmp, CANDIDATE_PATH), `${JSON.stringify(value, null, 2)}\n`);
  const read = (relative) => {
    try {
      return readFileSync(path.join(tmp, relative), "utf8");
    } catch {
      return readFileSync(path.join(ROOT, relative), "utf8");
    }
  };
  assert.deepEqual(validateCandidate(value, schema, { readFile: read }), []);
  return JSON.parse(readFileSync(path.join(tmp, roundPath), "utf8"));
}

test("the shipped record is the pinned corrections set", () => {
  // The closed form: the check declares the whole normative content of
  // anchor_corrections — the historical entries by content hash and the
  // membership correction by exact text — so the array cannot assert
  // anything the code does not declare.
  assert.equal(readRound(4).anchor_corrections[2], MEMBERSHIP_CORRECTION);
  assert.deepEqual(membershipRuleErrors(readRound(4)), []);
  assert.deepEqual(validatePanelRound(readRound(4)), []);
});

test("a withdrawn clause adopted after a harmless preamble is refused", () => {
  // The reviewer's probe, verbatim: the historical quotation, repeated after
  // "adopts the following:", reinstates the two-clause rule. There is no
  // whitelist left to strip it with — the entry is not the declared text.
  const round = mutatedRoundOnDisk((draft) => {
    draft.anchor_corrections[2] +=
      " This correction also adopts the following: a path in the candidate's `files`, or a new path whose artifact class the candidate carries, is a member.";
  });
  assert.ok(
    validatePanelRound(round).some((message) => /not the declared text/u.test(message)),
    "the adopted clause is not refused",
  );
});

test("the rule inside a negation is refused", () => {
  // One word — "is" to "is not" — turns the operative rule into its denial.
  // Exact equality reads no meaning; the entry is not the declared text.
  const round = mutatedRoundOnDisk((draft) => {
    draft.anchor_corrections[2] = draft.anchor_corrections[2].replace(
      "The operative rule is",
      "The operative rule is not",
    );
  });
  assert.ok(
    validatePanelRound(round).some((message) => /not the declared text/u.test(message)),
    "the negated rule is not refused",
  );
});

test("a membership verb the scan did not know is refused by the historical pin", () => {
  // "acquires membership" outran the predicate list in a non-carrier entry.
  // The digest pin does not read verbs at all.
  const round = mutatedRoundOnDisk((draft) => {
    draft.anchor_corrections[0] +=
      " A new path whose artifact class the candidate carries acquires membership.";
  });
  assert.ok(
    validatePanelRound(round).some((message) => /not the recorded historical text/u.test(message)),
    "the edited historical correction is not refused",
  );
});

test("a clause appended to the carrier is refused", () => {
  // The attempt-1 probe: the withdrawn clause returns as a sentence after
  // the rule.
  const round = mutatedRoundOnDisk((draft) => {
    draft.anchor_corrections[2] = draft.anchor_corrections[2].replace(
      `${MEMBERSHIP_RULE}.`,
      `${MEMBERSHIP_RULE}. A new path whose \`artifact_class\` the candidate carries is also a member.`,
    );
  });
  assert.ok(
    membershipRuleErrors(round).some((message) => /not the declared text/u.test(message)),
    "the appended clause is not refused",
  );
});

test("an unknown mechanism inside or beside the token is refused", () => {
  // `ghost[]` corrupting the token leaves the entry not the declared text;
  // named beside it, the same.
  const inside = mutatedRoundOnDisk((draft) => {
    draft.anchor_corrections[2] = draft.anchor_corrections[2].replaceAll(
      MEMBERSHIP_RULE,
      "`membership: a member is a path listed in files[] or ghost[]`",
    );
  });
  assert.ok(
    membershipRuleErrors(inside).some((message) => /not the declared text/u.test(message)),
    "the corrupted token is not refused",
  );
  const beside = mutatedRoundOnDisk((draft) => {
    draft.anchor_corrections[2] += " A path in `ghost[]` is carried.";
  });
  assert.ok(
    membershipRuleErrors(beside).some((message) => /not the declared text/u.test(message)),
    "the named unknown mechanism is not refused",
  );
});

test("a repeated mechanism name is refused like every other deviation", () => {
  // Naming `files[]` twice added no clause, and the counting model refused
  // it falsely. Under the closed form there is no legitimate prose edit at
  // all — the carrier is a frozen record and any addition fails by
  // inequality, which is correct now rather than a false refusal.
  const round = mutatedRoundOnDisk((draft) => {
    draft.anchor_corrections[2] += " The list `files[]` is where it is recorded.";
  });
  assert.ok(
    membershipRuleErrors(round).some((message) => /not the declared text/u.test(message)),
    "the prose addition is not refused",
  );
});

test("membership asserted in a correction that is not the carrier is refused", () => {
  const round = mutatedRoundOnDisk((draft) => {
    draft.anchor_corrections[1] += " The canonicalizer is also a member.";
  });
  assert.ok(
    membershipRuleErrors(round).some((message) => /not the recorded historical text/u.test(message)),
    "the out-of-carrier assertion is not refused",
  );
});

test("a duplicated carrier is refused", () => {
  const round = mutatedRoundOnDisk((draft) => {
    draft.anchor_corrections.push(draft.anchor_corrections[2]);
  });
  assert.ok(
    membershipRuleErrors(round).some((message) => /4 anchor corrections, 3 pinned/u.test(message)),
    "the duplicated carrier is not refused",
  );
});

test("a record that drops the membership correction is refused", () => {
  const round = mutatedRoundOnDisk((draft) => {
    draft.anchor_corrections = draft.anchor_corrections.filter(
      (entry) => !entry.includes(MEMBERSHIP_RULE),
    );
  });
  assert.ok(
    membershipRuleErrors(round).some((message) => /2 anchor corrections, 3 pinned/u.test(message)),
    "the dropped carrier is not refused",
  );
});

test("the rule removed from its carrier is refused", () => {
  const round = mutatedRoundOnDisk((draft) => {
    draft.anchor_corrections[2] = draft.anchor_corrections[2].replace(`${MEMBERSHIP_RULE}. `, "");
  });
  assert.ok(
    membershipRuleErrors(round).some((message) => /not the declared text/u.test(message)),
    "the missing rule is not refused",
  );
});

test("one word changed anywhere in the carrier is refused", () => {
  const round = mutatedRoundOnDisk((draft) => {
    draft.anchor_corrections[2] = draft.anchor_corrections[2].replace("withdrawn", "kept");
  });
  assert.ok(
    membershipRuleErrors(round).some((message) => /not the declared text/u.test(message)),
    "the changed word is not refused",
  );
});

test("a fourth correction appended is refused", () => {
  const round = mutatedRoundOnDisk((draft) => {
    draft.anchor_corrections.push("A harmless note.");
  });
  assert.ok(
    membershipRuleErrors(round).some((message) => /4 anchor corrections, 3 pinned/u.test(message)),
    "the appended correction is not refused",
  );
});

test("a historical correction edited by one character is refused", () => {
  const round = mutatedRoundOnDisk((draft) => {
    draft.anchor_corrections[0] = `${draft.anchor_corrections[0]} `;
  });
  assert.ok(
    membershipRuleErrors(round).some((message) => /not the recorded historical text/u.test(message)),
    "the edited historical correction is not refused",
  );
});

test("a reordered corrections array is refused", () => {
  const round = mutatedRoundOnDisk((draft) => {
    const [first, second, third] = draft.anchor_corrections;
    draft.anchor_corrections = [second, first, third];
  });
  assert.ok(
    membershipRuleErrors(round).some((message) => /not the recorded historical text/u.test(message)),
    "the reordered array is not refused",
  );
});

test("the declared correction answers for a named path with no file behind it", () => {
  // 02-architecture.md names NAMED_NO_FILE for the planned
  // autosk-flow-ref-custody component and no file exists there. The declared
  // text denies it membership until it is listed — asserted in code, so the
  // answer cannot be edited out without the validator refusing.
  assert.ok(MEMBERSHIP_CORRECTION.includes(NAMED_NO_FILE));
  assert.ok(MEMBERSHIP_CORRECTION.includes("only by being listed"));
  const round = mutatedRoundOnDisk((draft) => {
    draft.anchor_corrections[2] = draft.anchor_corrections[2].replaceAll(
      NAMED_NO_FILE,
      "src/git/other-helper.ts",
    );
  });
  assert.ok(
    membershipRuleErrors(round).some((message) => /not the declared text/u.test(message)),
    "the renamed path is not refused",
  );
});

test("a member the operative rule names by name cannot be dropped", () => {
  // The canonicalizer is listed because §7 of the factory contract rests
  // criterion 2 on the canonical form it implements and the task identity
  // digest depends on it. Dropping it is refused — the pin cannot lapse
  // silently.
  const listed = new Set(candidate().files.map((file) => file.path));
  for (const required of REQUIRED_MEMBERS) {
    assert.ok(listed.has(required), `${required} is named a member but is not listed`);
    assertRejects(
      mutated((value) => {
        value.files = value.files.filter((file) => file.path !== required);
      }),
      new RegExp(`${required.replace(/[.[\]]/gu, "\\$&")}.*does not list it`, "u"),
    );
  }
});

test("editing the canonicalizer is caught by its pin, and a PASS does not survive it", () => {
  // Member bytes are pinned bytes: serve different bytes under the same path
  // and the recorded sha256 goes stale, which is a refusal.
  const tampered = `${readFileSync(path.join(ROOT, CANONICALIZER), "utf8")}// edited\n`;
  const read = (relative) =>
    relative === CANONICALIZER ? tampered : readFileSync(path.join(ROOT, relative), "utf8");
  assertRejects(candidate(), /workflow-graph-canonical\.mjs.*has drifted/u, { readFile: read });

  // Resealing over the new bytes moves the digest, and a verdict bound to the
  // old one stays bound to the old one — that is the annulment the failure
  // scenario was missing.
  const edited = mutated((value) => {
    value.files.find((file) => file.path === CANONICALIZER).sha256 =
      createHash("sha256").update(tampered).digest("hex");
  });
  assert.notEqual(edited.candidate_digest, candidate().candidate_digest);
  edited.attestation.verdicts = fullPanel(candidate().candidate_digest);
  assert.equal(computeAttestationState(edited), "pending_final_panel");
});

test("a file appearing at a path the text only names is not a member", () => {
  // The operative rule's answer: membership is the list, and a file that
  // appears at a named-but-unlisted path binds nothing and moves no digest.
  const bytes = "export {};\n";
  const read = (relative) =>
    relative === NAMED_NO_FILE ? bytes : readFileSync(path.join(ROOT, relative), "utf8");
  const value = candidate();
  assert.deepEqual(validateCandidate(value, schema, { readFile: read }), []);
  assert.equal(candidateDigest(value), value.candidate_digest);

  // Only listing makes it a member — and listing moves the digest.
  const listed = mutated((draft) => {
    draft.files.push({
      path: NAMED_NO_FILE,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });
  assert.notEqual(candidateDigest(listed), value.candidate_digest);
  assert.deepEqual(validateCandidate(listed, schema, { readFile: read }), []);
});

test("a lock rewritten with a higher baseline is refused by its pin", () => {
  // The raisedBaseline scenario's other half: the lock validator does not
  // verify where previous_approved came from — what holds the baseline is
  // that the lock file is a member. Rewritten bytes are different bytes, and
  // the candidate refuses the stale pin until the lock is resealed.
  const lockPath = "resources/runtime-identity-lock/runtime-identity-lock.v1.json";
  const tampered = JSON.parse(readFileSync(path.join(ROOT, lockPath), "utf8"));
  tampered.requirement_growth.previous_approved += 1;
  const read = (relative) =>
    relative === lockPath
      ? JSON.stringify(tampered, null, 2) + "\n"
      : readFileSync(path.join(ROOT, relative), "utf8");
  assertRejects(candidate(), /has drifted/u, { readFile: read });
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
