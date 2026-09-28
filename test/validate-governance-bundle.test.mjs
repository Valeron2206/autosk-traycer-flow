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
  REGISTRY_PATH,
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
    value.bundle_digest = bundleDigest(value);
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

test("the digest recomputes from the members and the metadata alone", () => {
  const bundle = released();
  assert.equal(bundle.bundle_digest, bundleDigest(bundle));
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
  assert.equal(bundleDigest({ ...bundle, members: shuffled }), bundle.bundle_digest);
});

test("no timestamp is in the digest", () => {
  // A build that embedded the moment it ran could never be reproduced.
  const bundle = released();
  const later = JSON.parse(JSON.stringify(bundle));
  later.attestation.released_at = "2099-01-01T00:00:00.000Z";
  assert.equal(bundleDigest(later), bundle.bundle_digest);
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
  fixed.bundle_digest = bundleDigest(fixed);
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

// Debt 10g (R6-17): the bundle's members are the carrier registry's governance files.

test("the required members are the carrier registry's governance files, and nothing else", () => {
  const registry = JSON.parse(files[REGISTRY_PATH]);
  assert.deepEqual([...REQUIRED_MEMBERS], registry.governance_files.map((file) => file.path));
  assert.equal(REQUIRED_MEMBERS.length, 13);
  assert.deepEqual([...PROTOCOL_FILES], REQUIRED_MEMBERS.filter((file) => file.startsWith("protocol/")));
  // The manifest and the attestation record the digest, so they cannot be in its preimage;
  // the carrier registry pins the bundle digest, so it cannot be a member either.
  for (const outside of ["bundle-manifest.json", "bundle-attestation.json", "stage-carriers.json", "role/author.md"]) {
    assert.ok(!REQUIRED_MEMBERS.includes(outside), outside);
    assertRejects(
      mutated((value) => {
        value.members.push({ path: outside, sha256: "1".repeat(64), size: 1 });
      }),
      new RegExp(`${outside.replace(/[.]/gu, "\\.")} is not part of the inventory`, "u"),
    );
  }
  for (const example of [released(), candidate()]) {
    assert.deepEqual(example.members.map((member) => member.path).sort(), [...REQUIRED_MEMBERS].sort());
  }
});

test("the design check takes the members from the registry it is given", () => {
  const registry = JSON.parse(files[REGISTRY_PATH]);
  registry.governance_files = registry.governance_files.filter((file) => file.path !== "protocol/playbooks/perf.md");
  const errors = validateGovernanceBundleDesign({ ...files, [REGISTRY_PATH]: `${JSON.stringify(registry, null, 2)}\n` });
  assert.ok(errors.some((message) => /protocol\/playbooks\/perf\.md is not part of the inventory/u.test(message)), errors.join("\n"));
});

// Debt 10g review H1: the validator hashes with the runtime's formula, over the manifest metadata.

test("the design validator uses the runtime's content digest, over id, version and provenance", async () => {
  const runtime = await import("../src/host/governance-bundle.mjs");
  const bundle = released();
  assert.equal(
    bundleDigest(bundle),
    runtime.bundleDigest({
      bundle_id: bundle.bundle_id, bundle_version: bundle.version, provenance: bundle.provenance, members: bundle.members,
    }),
  );
  for (const [field, value] of [["bundle_id", "autosk-v2"], ["version", "1.0.1"], ["provenance", "other"]]) {
    assertRejects(mutated((v) => { v[field] = value; }, released, { reseal: false }), /does not recompute/u);
  }
  for (const example of [released(), candidate()]) {
    assert.equal(example.bundle_id, "autosk-v1");
    assert.equal(typeof example.provenance, "string");
  }
  assert.ok(files[CONTRACT_PATH].includes("autosk-flow/governance-bundle-content/v1"));
});

// Debt 11f (R7-21, round 7 of #39): §4 said the build CLI holds the manifest
// to the inventory while §9 deferred the CLI, the importer, the builder and
// the panel runner — and the CLI, the builder and the runner exist. The
// contract now describes what exists where it lives, by path, and §9 defers
// only what has no code; each claim is read from the tree here.

test("the contract describes the build command, the builder and the panel runner where they live, and defers only what does not exist", async () => {
  const { existsSync } = await import("node:fs");
  const path = await import("node:path");
  const { ROOT } = await import("../scripts/validate-governance-bundle.mjs");
  const { filesUsing } = await import("../scripts/lib/code-references.mjs");
  const contract = files[CONTRACT_PATH];
  const section = (number) => {
    const start = contract.indexOf(`## ${number}.`);
    const end = contract.indexOf(`## ${number + 1}.`);
    return contract.slice(start, end === -1 ? undefined : end);
  };
  // The build command and the builder, in §4, by path.
  for (const file of ["scripts/governance-bundle.mjs", "src/host/bundle-builder.mjs"]) {
    assert.ok(section(4).includes(`\`${file}\``), `§4 does not name ${file}`);
  }
  assert.ok(section(4).includes("`npm run bundle:build`"));
  // The panel runner and the attestation check, in §6; the release rules, in §7.
  assert.ok(section(6).includes("`src/host/bundle-panel.mjs`"));
  assert.ok(section(7).includes("`src/host/governance-bundle.mjs`"));
  // Every code path the contract names exists.
  const named = [...contract.matchAll(/`((?:scripts|src)\/[\w./-]+\.mjs)`/gu)].map((match) => match[1]);
  assert.ok(named.length >= 4);
  for (const file of named) assert.ok(existsSync(path.join(ROOT, file)), file);
  // §9 defers what has no code: not the CLI or the builder wholesale.
  const deferred = section(9).slice(section(9).indexOf("Deferred"));
  assert.doesNotMatch(deferred, /the CLI, the importer, the builder and the panel runner/u);
  // The importer 03 §3 names is not in the tree.
  assert.match(deferred, /`import-traycer-baseline`/u);
  const users = await filesUsing({ root: ROOT, dirs: ["src", "scripts"], identifier: "importTraycerBaseline" });
  assert.deepEqual(users, []);
  // The manifest the build command reads by default does not exist yet, and §9 says so.
  assert.equal(existsSync(path.join(ROOT, "resources/governance-bundle/bundle-manifest.v1.json")), false);
  assert.match(deferred, /`resources\/governance-bundle\/bundle-manifest\.v1\.json`/u);
  // The panel runner and the release rules have no caller outside tests, and §9 defers their use.
  for (const [identifier, owner] of [
    ["runBundlePanel", "src/host/bundle-panel.mjs"],
    ["releaseAdmission", "src/host/governance-bundle.mjs"],
    ["releasePointer", "src/host/governance-bundle.mjs"],
  ]) {
    assert.deepEqual(await filesUsing({ root: ROOT, dirs: ["src", "scripts"], identifier, exclude: [owner] }), [], identifier);
  }
  assert.match(deferred, /a panel run over a real candidate/u);
  assert.match(deferred, /content-addressed release store/u);
});

// Review of 11f (L5): the test above read only part of §9 from the tree. Each
// deferral is now held to the tree: the importer 03 §3 places at
// `tools/import-traycer-baseline.ts`, the import, review and release commands,
// the thirteen members, the default manifest, a panel run over a real
// candidate, and a release store — no code imports §7's functions from the
// module that defines them. The module-naming nit of the same review: §6
// names the module `attestationErrors` lives in.

test("each deferral of §9 is read from the tree, and §6 names the module of the attestation check", async () => {
  const { existsSync, readFileSync, readdirSync } = await import("node:fs");
  const path = await import("node:path");
  const { ROOT } = await import("../scripts/validate-governance-bundle.mjs");
  const { filesUsing, CODE_EXTENSIONS } = await import("../scripts/lib/code-references.mjs");
  const contract = files[CONTRACT_PATH];
  const section = (number) => {
    const start = contract.indexOf(`## ${number}.`);
    const end = contract.indexOf(`## ${number + 1}.`);
    return contract.slice(start, end === -1 ? undefined : end);
  };
  assert.ok(section(6).includes("`attestationErrors` in `src/host/governance-bundle.mjs`"), section(6));
  const deferred = section(9).slice(section(9).indexOf("Deferred"));
  const phrase = (words) => new RegExp(words.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/ /gu, "\\s+"), "u");
  // Every file of the repository but the installed modules and git's own.
  const tracked = [];
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(ROOT, relative), { withFileTypes: true })) {
      if (relative === "" && (entry.name === "node_modules" || entry.name === ".git")) continue;
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else tracked.push(child);
    }
  };
  walk("");
  assert.ok(tracked.includes("docs/contracts/governance-bundle.md"));

  // The importer: no file of that name anywhere, and no code that names it.
  assert.match(deferred, phrase("the importer — `import-traycer-baseline` of 03 §3"));
  assert.match(readFileSync(path.join(ROOT, "03-technical-plan.md"), "utf8"), /tools\/\n\s+import-traycer-baseline\.ts/u);
  assert.deepEqual(tracked.filter((file) => path.basename(file).startsWith("import-traycer-baseline")), []);
  assert.deepEqual(await filesUsing({ root: ROOT, dirs: ["src", "scripts"], identifier: "importTraycerBaseline" }), []);

  // The commands: the package's one bundle script is the build, and the build
  // command reads no subcommand, only its four options.
  assert.match(deferred, phrase("the import, review and release commands"));
  const scripts = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
  // A bundle command is a `bundle:` script or anything that runs the bundle CLI;
  // `validate:governance-bundle` is the design validator, not a command of the bundle.
  const bundleScripts = Object.entries(scripts).filter(([name, command]) => name.startsWith("bundle:") || /scripts\/governance-bundle\.mjs/u.test(command));
  assert.deepEqual(bundleScripts, [["bundle:build", "node scripts/governance-bundle.mjs"]]);
  assert.deepEqual(tracked.filter((file) => file.startsWith("scripts/") && /(?:import|review|release)/u.test(path.basename(file)) && /bundle/u.test(file)), []);
  const cli = readFileSync(path.join(ROOT, "scripts/governance-bundle.mjs"), "utf8");
  assert.deepEqual([...cli.matchAll(/argument\('([a-z-]+)'/gu)].map((match) => match[1]).sort(), ["manifest", "out", "root", "stage"]);

  // The thirteen members: none is in the tree, where 03 §3 places them or anywhere else.
  assert.match(deferred, phrase("the thirteen members themselves"));
  const members = JSON.parse(readFileSync(path.join(ROOT, "resources/stage-carriers/stage-carriers.v1.json"), "utf8")).governance_files.map((file) => file.path);
  assert.equal(members.length, 13);
  for (const member of members) {
    assert.equal(existsSync(path.join(ROOT, "resources/governance/bundles/autosk-v1", member)), false, member);
    assert.deepEqual(tracked.filter((file) => file === member || file.endsWith(`/${member}`)), [], member);
  }

  // A panel run over a real candidate: the runner and its seats have no caller outside tests.
  assert.match(deferred, phrase("a panel run over a real candidate"));
  for (const identifier of ["runBundlePanel", "seatsFor"]) {
    assert.deepEqual(await filesUsing({ root: ROOT, dirs: ["src", "scripts"], identifier, exclude: ["src/host/bundle-panel.mjs"] }), [], identifier);
  }

  // A release store: no code imports §7's functions from the module that
  // defines them, or the module whole (`rollbackPlan` is also the name of the
  // distribution registry's own function, so the import is what is read).
  assert.match(deferred, phrase("the content-addressed release store, the `current` pointer and the retention of a version while a lock references it"));
  const RELEASE = ["releaseAdmission", "releasePointer", "rollbackPlan", "bundleForEpic", "epicMigrationErrors"];
  const importers = [];
  for (const file of tracked.filter((name) => /^(?:src|scripts)\//u.test(name) && CODE_EXTENSIONS.test(name))) {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    for (const match of text.matchAll(/import\s*(\{[^}]*\}|\*\s*as\s+\w+)\s*from\s*['"]([^'"]+)['"]/gu)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[2]));
      if (target === "src/host/governance-bundle.mjs") importers.push({ file, clause: match[1] });
    }
  }
  assert.ok(importers.length > 0, "the module has importers, so the check reads something");
  for (const { file, clause } of importers) {
    assert.ok(!clause.startsWith("*"), `${file} imports the whole module`);
    for (const name of RELEASE) assert.doesNotMatch(clause, new RegExp(`\\b${name}\\b`, "u"), `${file} imports ${name}`);
  }
});
