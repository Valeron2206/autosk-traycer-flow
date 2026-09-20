/**
 * Tests for the issue #37 governance bundle.
 *
 * Three things must be impossible: a digest that cannot be recomputed, an
 * attestation that confirms only itself, and a release that edits history
 * instead of adding to it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CANDIDATE_EXAMPLE_PATH,
  CONTRACT_PATH,
  EXAMPLE_PATH,
  PROTOCOL_FILES,
  REFUSALS,
  REQUIRED_MEMBERS,
  REQUIRED_PANEL,
  SCHEMA_PATH,
  attestationState,
  bundleDigest,
  governanceDesignDigest,
  loadFiles,
  scanMember,
  validateBundle,
  validateGovernanceBundleDesign,
} from "../scripts/validate-governance-bundle.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

const released = () => JSON.parse(files[EXAMPLE_PATH]);
const candidate = () => JSON.parse(files[CANDIDATE_EXAMPLE_PATH]);

function mutated(mutate, base = released, { reseal = true } = {}) {
  const value = base();
  mutate(value);
  if (reseal) {
    value.bundle_digest = bundleDigest(value.members);
    value.attestation.candidate_digest = value.bundle_digest;
    for (const seat of value.attestation.panel) seat.candidate_digest = value.bundle_digest;
    value.attestation.state = attestationState(value);
  }
  return value;
}

function assertRejects(value, pattern) {
  const errors = validateBundle(value, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

test("the shipped design validates", () => {
  assert.deepEqual(validateGovernanceBundleDesign(files), []);
});

test("the digest recomputes from the members alone", () => {
  const bundle = released();
  assert.equal(bundle.bundle_digest, bundleDigest(bundle.members));
  assertRejects(
    mutated(
      (value) => {
        value.members[0].sha256 = "9".repeat(64);
      },
      released,
      { reseal: false },
    ),
    /does not recompute/u,
  );
});

test("path order is by raw bytes, so a reordered manifest is the same bundle", () => {
  // One input, one digest. A build that depended on the order the filesystem
  // happened to list things in would produce two names for one bundle.
  const bundle = released();
  const shuffled = [...bundle.members].reverse();
  assert.equal(bundleDigest(shuffled), bundle.bundle_digest);
});

test("no timestamp is in the digest", () => {
  // A build that embedded the moment it ran could never be reproduced.
  const bundle = released();
  const later = JSON.parse(JSON.stringify(bundle));
  later.attestation.released_at = "2099-01-01T00:00:00.000Z";
  assert.equal(bundleDigest(later.members), bundle.bundle_digest);
  assert.ok(files[CONTRACT_PATH].includes("Timestamps are not in the digest"));
});

test("a missing protocol file and an extra member are both refusals", () => {
  assertRejects(
    mutated((value) => {
      value.members = value.members.filter((m) => m.path !== PROTOCOL_FILES[3]);
    }),
    /bundle_inventory_missing/u,
  );
  assertRejects(
    mutated((value) => {
      value.members.push({ path: "extra.md", sha256: "1".repeat(64), size: 1 });
    }),
    /bundle_inventory_extra/u,
  );
});

test("the twelve protocol files are named, not globbed", () => {
  // A glob would let one go missing without the count changing.
  assert.equal(PROTOCOL_FILES.length, 12);
  for (const file of PROTOCOL_FILES) assert.ok(REQUIRED_MEMBERS.includes(file));
});

test("an attestation about another candidate is refused", () => {
  assertRejects(
    mutated(
      (value) => {
        value.attestation.candidate_digest = "9".repeat(64);
      },
      released,
      { reseal: false },
    ),
    /names a different candidate/u,
  );
});

test("a panel fix changes the digest, and the old verdicts stop counting", () => {
  // The case most likely to be rounded up: the verdicts were about a candidate
  // that no longer exists.
  const fixed = released();
  fixed.members[0].sha256 = "7".repeat(64);
  fixed.bundle_digest = bundleDigest(fixed.members);
  fixed.attestation.candidate_digest = fixed.bundle_digest;
  assert.equal(attestationState(fixed), "pending_panel");
  assertRejects(fixed, /attestation state is attested, computed pending_panel/u);
});

test("three passes and a silence is not an attestation", () => {
  const short = mutated((value) => {
    value.attestation.panel = value.attestation.panel.slice(0, 3);
  });
  assert.equal(attestationState(short), "pending_panel");
});

test("a downgraded effort or a substituted route is a different panel", () => {
  for (const [field, wrong] of [["effort", "high"], ["route", "anthropic/claude-opus-5"]]) {
    const off = mutated((value) => {
      value.attestation.panel.find((seat) => seat.seat === "grok")[field] = wrong;
    });
    assert.equal(attestationState(off), "pending_panel");
  }
  assert.equal(REQUIRED_PANEL.length, 4);
});

test("one fail blocks", () => {
  const blocked = mutated((value) => {
    value.attestation.panel.find((seat) => seat.seat === "muse").verdict = "fail";
  });
  assert.equal(attestationState(blocked), "blocked");
});

test("a missing seat cannot hide the seats that refused", () => {
  // The cross-family review's reproduction: the opus seat is absent and the
  // three seats that reviewed refused. The walk returned pending_panel at
  // opus — first in REQUIRED_PANEL — before any fail was read, and
  // validateBundle accepted the bundle as merely incomplete: state
  // pending_panel, errors [].
  const refused = mutated((draft) => {
    draft.stage = "adaptation";
    delete draft.attestation.release_actor;
    delete draft.attestation.released_at;
    draft.attestation.panel = draft.attestation.panel
      .filter((entry) => entry.seat !== "opus")
      .map((entry) => ({ ...entry, verdict: "fail" }));
  });
  assert.equal(attestationState(refused), "blocked");
  // Recorded as "the panel has not assembled", the refusal must still be named.
  refused.attestation.state = "pending_panel";
  assertRejects(refused, /attestation state is pending_panel, computed blocked/u);
  // Recorded honestly, the same bundle is refused rather than malformed.
  refused.attestation.state = "blocked";
  assert.deepEqual(validateBundle(refused, schema), []);
});

test("the absent seat can sit anywhere in the order", () => {
  // opus is merely first in REQUIRED_PANEL; whichever seat is missing — and
  // whatever order the entries are listed in — the refusals still decide.
  for (const missing of REQUIRED_PANEL) {
    for (const reverse of [false, true]) {
      const value = mutated((draft) => {
        draft.stage = "adaptation";
        delete draft.attestation.release_actor;
        delete draft.attestation.released_at;
        const panel = draft.attestation.panel
          .filter((entry) => entry.seat !== missing.seat)
          .map((entry) => ({ ...entry, verdict: "fail" }));
        draft.attestation.panel = reverse ? panel.reverse() : panel;
      });
      assert.equal(attestationState(value), "blocked", `${missing.seat} missing, reversed=${reverse}`);
    }
  }
});

test("a seat present but not counted cannot hide a refusal either", () => {
  // A wrong route or another digest is the same hiding spot as absence: the
  // entry is not this panel's verdict, and it must not end the count before
  // the fails behind it.
  for (const spoil of [
    (opus) => {
      opus.route = "anthropic/other-route";
    },
    (opus) => {
      opus.candidate_digest = "9".repeat(64);
    },
  ]) {
    const value = mutated((draft) => {
      draft.stage = "adaptation";
      delete draft.attestation.release_actor;
      delete draft.attestation.released_at;
      for (const entry of draft.attestation.panel) {
        if (entry.seat !== "opus") entry.verdict = "fail";
      }
    });
    spoil(value.attestation.panel.find((entry) => entry.seat === "opus"));
    assert.equal(attestationState(value), "blocked");
  }
});

test("a refusal bound to another bundle's digest is not this bundle's refusal", () => {
  // A fail about other bytes is not a refusal of this bundle: the verdict
  // counts for nothing, so the panel is incomplete, not refused.
  const value = mutated((draft) => {
    for (const entry of draft.attestation.panel) entry.verdict = "fail";
  });
  for (const entry of value.attestation.panel) entry.candidate_digest = "9".repeat(64);
  assert.equal(attestationState(value), "pending_panel");
});

test("a refusal on a route the panel never required is not this panel's verdict", () => {
  // The same rule from the other side: a fail recorded on another route
  // counts for nothing — it neither blocks nor passes the seat.
  const value = mutated((draft) => {
    const opus = draft.attestation.panel.find((entry) => entry.seat === "opus");
    opus.route = "anthropic/other-route";
    opus.verdict = "fail";
  });
  assert.equal(attestationState(value), "pending_panel");
});

test("a verdict that is not pass does not count toward attested", () => {
  // The schema's pass|fail enum rejects this panel before the helper ever
  // runs — but a check that holds only because something else catches the
  // case first is not a check, so this asserts on the helper directly.
  const value = mutated((draft) => {
    draft.attestation.panel.find((entry) => entry.seat === "opus").verdict = "non_verdict";
  });
  assert.equal(attestationState(value), "pending_panel");
});

test("a seat that could not review does not hide the seats that refused", () => {
  // non_verdict cannot reach the helper through validateBundle — the schema
  // enum rejects it — but the helper's own rule is the same: a verdict that
  // is not counted contributes nothing to either side.
  const value = mutated((draft) => {
    for (const entry of draft.attestation.panel) {
      entry.verdict = entry.seat === "opus" ? "non_verdict" : "fail";
    }
  });
  assert.equal(attestationState(value), "blocked");
});

test("a panel where no seat could review is pending, not refused", () => {
  const value = mutated((draft) => {
    for (const entry of draft.attestation.panel) entry.verdict = "non_verdict";
  });
  assert.equal(attestationState(value), "pending_panel");
});

test("a duplicate seat cannot hide a refusal", () => {
  // The panel is bounded by maxItems, not by unique seats, so a second entry
  // for one seat fits the schema. Taking the first entry per seat would let
  // an early pass shadow a later fail — the same defect one level down.
  const value = mutated((draft) => {
    draft.stage = "adaptation";
    delete draft.attestation.release_actor;
    delete draft.attestation.released_at;
    const opus = draft.attestation.panel.find((entry) => entry.seat === "opus");
    draft.attestation.panel = [
      opus,
      { ...opus, verdict: "fail" },
      ...draft.attestation.panel.filter((entry) => entry.seat === "astra" || entry.seat === "grok"),
    ];
  });
  assert.equal(value.attestation.panel.length, 4);
  assert.equal(attestationState(value), "blocked");
});

test("a release needs a complete panel, an actor and a time", () => {
  assertRejects(
    mutated((value) => {
      value.attestation.panel = [];
    }),
    /bundle_panel_incomplete/u,
  );
  assertRejects(
    mutated((value) => {
      delete value.attestation.release_actor;
    }),
    /must name its actor/u,
  );
});

test("a candidate may not carry release fields", () => {
  // A candidate presenting itself as a release is the stage mixing this
  // separation exists to prevent.
  assertRejects(
    mutated(
      (value) => {
        value.attestation.release_actor = "owner";
      },
      candidate,
      { reseal: false },
    ),
    /bundle_stage_mixed/u,
  );
});

test("the candidate example is pending, not attested", () => {
  const draft = candidate();
  assert.equal(draft.stage, "adaptation");
  assert.equal(attestationState(draft), "pending_panel");
  assert.deepEqual(validateBundle(draft, schema), []);
});

test("a bundle cannot be a rollback of itself", () => {
  assertRejects(
    mutated((value) => {
      value.rollback_of = value.bundle_digest;
    }),
    /cannot be a rollback of itself/u,
  );
});

test("the scan refuses Traycer references and absolute user paths", () => {
  assert.deepEqual(scanMember("nothing to see here\n"), []);
  assert.ok(scanMember("call traycer_run_stage() here").length > 0);
  assert.ok(scanMember("see .traycer/config").length > 0);
  assert.ok(scanMember("open /Users/someone/project/file.md").length > 0);
  assert.ok(scanMember("open /home/someone/project/file.md").length > 0);
  assert.ok(scanMember("open C:\\\\Users\\\\someone").length > 0);
  // Fail-closed: a member that could not be read is failing, because "I could
  // not check it" is not "it is clean".
  assert.deepEqual(scanMember(undefined), ["bundle_scan_unreadable"]);
});

test("every refusal is documented", () => {
  const contract = files[CONTRACT_PATH];
  for (const refusal of REFUSALS) assert.ok(contract.includes(refusal), `${refusal} is not documented`);
});

test("the design digest changes when any shipped file changes", () => {
  const before = governanceDesignDigest(files);
  const after = governanceDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
