/**
 * Tests for the governance bundle build and release (issue #37 runtime).
 *
 * One input must give one digest, so most of these are about the canonical
 * form and about what a candidate has to prove before it can be the bundle the
 * runtime uses.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { digest } from "../src/runtime/contracts.mjs";

import {
  REFUSALS,
  REQUIRED_SEATS,
  STAGES,
  attestationErrors,
  BUNDLE_DIGEST_DOMAIN,
  bundleDigest,
  bundleDigestPreimage,
  bundleForEpic,
  canonicalJson,
  canonicalTextErrors,
  compareMembersByPath,
  declaredInventoryErrors,
  epicMigrationErrors,
  inventoryErrors,
  releaseAdmission,
  releasePointer,
  rollbackPlan,
  scanErrors,
  stageErrors,
} from "../src/host/governance-bundle.mjs";

const code = (name) => (error) => error.code === name;

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** The manifest metadata 02 §5 puts in the content digest's preimage. */
const META = Object.freeze({ bundle_id: "autosk-v1", bundle_version: "1.0.0", provenance: "autosk-native adaptation" });
const digestOf = (members, meta = META) => bundleDigest({ ...meta, members });

function member(path, text = `contents of ${path}\n`, overrides = {}) {
  return { path, text, sha256: sha(text), readable: true, ...overrides };
}

function candidate(overrides = {}) {
  const members = overrides.members ?? [
    member("agent-selection-guide.md"),
    member("protocol/playbooks/feature.md"),
    member("bundle-manifest.json", canonicalJson({ members: [] })),
  ];
  return {
    stage: "release",
    members,
    manifest: overrides.manifest ?? { ...META, members: members.map((entry) => ({ path: entry.path })) },
    ...overrides,
    ...(overrides.members ? { members: overrides.members } : {}),
  };
}

function attestation(digest, overrides = {}) {
  return {
    candidate_digest: digest,
    release_actor: "owner",
    verdicts: REQUIRED_SEATS.map((seat) => ({
      ...seat,
      candidate_digest: digest,
      verdict: "pass",
    })),
    ...overrides,
  };
}

test("a complete candidate is admitted", () => {
  const value = candidate();
  const outcome = releaseAdmission(value, attestation(digestOf(value.members)));
  assert.deepEqual(outcome.errors.slice(), []);
  assert.equal(outcome.admitted, true);
});

test("the digest is over the ordered path and hash map, and does not depend on member order", () => {
  const members = [member("b.md"), member("a.md")];
  assert.equal(digestOf(members), digestOf([...members].reverse()));
  assert.notEqual(digestOf(members), digestOf([member("a.md"), member("b.md", "different\n")]));
  // The comparator's tie branch is unreachable while member paths are unique,
  // and the inventory refuses a repeated member path — so the property tested
  // is the one the sort exists for, and the tie itself never arises.
  const paths = [member("a.md"), member("b.md"), member("c.md")].map((entry) => entry.path);
  assert.equal(new Set(paths).size, paths.length);
});

test("the member order is a comparator contract, not a property of one engine's sort", () => {
  // Equal paths must answer 0: a comparator that returns 1 for a tie is
  // observably wrong to anything that calls it, whatever a given sort does
  // with the answer. Smaller gives -1, larger gives 1.
  assert.equal(compareMembersByPath(member("a.md"), member("b.md")), -1);
  assert.equal(compareMembersByPath(member("b.md"), member("a.md")), 1);
  assert.equal(compareMembersByPath(member("a.md"), member("a.md")), 0);
});

test("only Markdown members with real text are held to the canonical text form", () => {
  // `typeof text === 'string' && path.endsWith('.md')` — an `||` there would
  // hand a Buffer to a text check, and a `!==` would exempt exactly the files
  // the rule is for. Each half is asked on its own.
  const canonical = (path, text) => releaseAdmission(
    { manifest: { ...META, members: [{ path, sha256: "0".repeat(64) }] }, members: [{ path, sha256: "0".repeat(64), text }] },
    attestation("x"),
  ).errors.filter((error) => error.reason === "bundle_not_canonical");

  // A Markdown member with no trailing newline is refused.
  assert.ok(canonical("a.md", "line").length > 0);
  // The same bytes in a file that is not Markdown are not this rule's business.
  assert.deepEqual(canonical("a.txt", "line"), []);
  // And a Markdown member whose text is not a string is left to the scan, which
  // owns "unreadable", rather than being decoded here.
  assert.deepEqual(canonical("a.md", Buffer.from("line")), []);
});

test("timestamps are not in the digest, because a digest nobody can recompute is a name", () => {
  // The same members built at two times give one digest; the build time lives
  // in the attestation, where it describes the event rather than the content.
  const members = [member("a.md")];
  const first = digestOf(members);
  const second = digestOf(members.map((entry) => ({ ...entry, built_at: "2026-09-09T00:00:00Z" })));
  assert.equal(first, second);
});

test("the canonical text form is stated, not assumed", () => {
  assert.deepEqual(canonicalTextErrors("a.md", "line\n"), []);
  assert.ok(canonicalTextErrors("a.md", "\uFEFFline\n").some((error) => /BOM/u.test(error.detail)));
  assert.ok(canonicalTextErrors("a.md", "line\r\n").some((error) => /CR/u.test(error.detail)));
  assert.ok(canonicalTextErrors("a.md", "line").some((error) => /trailing newline/u.test(error.detail)));
  // An empty file has no trailing newline to be missing. Without this case the
  // guard could have been `bytes.length >= 0` and nothing would have noticed.
  assert.deepEqual(canonicalTextErrors("a.md", ""), []);
});

test("a member that cannot be read and one that is not text are the same refusal, separately reached", () => {
  // `readable === false || typeof text !== 'string'` — testing only the first
  // half leaves the second unasked, and an `&&` there would let a member with
  // no text through the scan entirely.
  assert.deepEqual(scanErrors([{ path: "a.md", text: "clean" }]), []);
  assert.ok(
    scanErrors([{ path: "a.md", readable: false, text: "clean" }])
      .some((error) => error.reason === "bundle_scan_unreadable"),
  );
  assert.ok(
    scanErrors([{ path: "a.md" }]).some((error) => error.reason === "bundle_scan_unreadable"),
  );
  assert.ok(
    scanErrors([{ path: "a.bin", text: Buffer.from("bytes") }])
      .some((error) => error.reason === "bundle_scan_unreadable"),
  );
});

test("JSON is serialised with sorted keys, two-space indent and a trailing newline", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n');
});

test("a missing member and an extra member are both refusals", () => {
  // A bundle that carries a file nobody declared is a bundle whose contents
  // nobody can vouch for.
  const members = [member("a.md")];
  const missing = inventoryErrors({ members: [{ path: "a.md" }, { path: "b.md" }] }, members);
  assert.ok(missing.some((error) => error.reason === "bundle_inventory_missing"));
  const extra = inventoryErrors({ members: [] }, members);
  assert.ok(extra.some((error) => error.reason === "bundle_inventory_extra"));
});

test("a repeated member path refuses in either order: one manifest cannot yield two digests", () => {
  // Two members under one declared path sort equal, so the digest keeps their
  // input order — ddf3ffcc… and b736c704… (the domain-separated preimage of ADR-093)
  // are one manifest attested as two.
  const manifest = { ...META, members: [{ path: "a.md" }] };
  const forward = candidate({
    manifest,
    members: [member("a.md", "clean\n"), member("a.md", "different\n")],
  });
  const backward = candidate({ manifest, members: [...forward.members].reverse() });
  assert.deepEqual([digestOf(forward.members), digestOf(backward.members)], [
    "ddf3ffcc1cdcc3e980a3e695d0ebf23e92715c9b0f078a3d6fc7f20643d2b660",
    "b736c70409b22cad23ae3c375e28bcf61cf72f2ec506ae71fc08a7082c605ecd",
  ]);
  const outcomes = [forward, backward].map((value) =>
    releaseAdmission(value, attestation(digestOf(value.members))));
  assert.deepEqual(outcomes.map((outcome) => outcome.admitted), [false, false]);
  for (const outcome of outcomes) {
    assert.ok(
      outcome.errors.some(
        (error) => error.reason === "bundle_inventory_duplicate" && error.detail === "a.md",
      ),
    );
  }
});

test("members are named individually, because a glob hides a missing file", () => {
  const errors = inventoryErrors({ members: [{ path: "protocol/**" }] }, []);
  assert.ok(errors.some((error) => /is a glob, not a member/u.test(error.detail)));
});

test("the scan is fail-closed: unreadable is failing", () => {
  // "I could not check it" is not "it is clean".
  const errors = scanErrors([member("a.md", undefined, { readable: false, text: undefined })]);
  assert.deepEqual(errors, [{ reason: "bundle_scan_unreadable", detail: "a.md" }]);
});

test("nothing Traycer-specific and nothing private survives the scan", () => {
  assert.ok(
    scanErrors([member("a.md", "call traycer_dispatch here\n")])
      .some((error) => error.reason === "bundle_traycer_reference"),
  );
  assert.ok(
    scanErrors([member("a.md", "read ~/.traycer/config\n")])
      .some((error) => error.reason === "bundle_traycer_reference"),
  );
  for (const prefix of ["/Users/", "/home/", "/root/", "C:\\"]) {
    assert.ok(
      scanErrors([member("a.md", `see ${prefix}someone/notes.md\n`)])
        .some((error) => error.reason === "bundle_private_path"),
      prefix,
    );
  }
  assert.ok(
    scanErrors([member("a.md", "clean\n", { private_session_file: true })])
      .some((error) => error.reason === "bundle_private_path"),
  );
});

test("the three stages are kept apart", () => {
  // Mixing any two is the failure the separation exists to prevent.
  assert.deepEqual(STAGES.slice(), ["baseline", "adaptation", "release"]);
  assert.deepEqual(stageErrors({ stage: "release", members: [] }), []);
  assert.ok(stageErrors({ stage: "published", members: [] }).some((error) => error.reason === "bundle_stage_mixed"));
  const mixed = stageErrors({
    stage: "release",
    members: [{ path: "a.md", stage: "baseline" }],
  });
  assert.ok(mixed.some((error) => /is baseline inside a release bundle/u.test(error.detail)));
});

test("only a release-stage candidate is released", () => {
  const value = candidate({ stage: "adaptation" });
  const outcome = releaseAdmission(value, attestation(digestOf(value.members)));
  assert.ok(outcome.errors.some((error) => /only a release-stage candidate/u.test(error.detail)));
});

test("an attestation about another candidate is refused", () => {
  // The shape of a forged or stale attestation.
  const value = candidate();
  const outcome = releaseAdmission(value, attestation("0".repeat(64)));
  assert.ok(outcome.errors.some((error) => error.reason === "bundle_attestation_mismatch"));
});

test("a panel fix changes the digest, so the earlier verdicts do not carry", () => {
  const before = candidate();
  const digest = digestOf(before.members);
  const verdicts = attestation(digest);
  // The fix: one member changes.
  const after = candidate({
    members: [
      member("agent-selection-guide.md", "fixed after the panel\n"),
      before.members[1],
      before.members[2],
    ],
  });
  after.manifest = { ...META, members: after.members.map((entry) => ({ path: entry.path })) };
  const outcome = releaseAdmission(after, verdicts);
  assert.notEqual(digestOf(after.members), digest);
  assert.ok(outcome.errors.some((error) => error.reason === "bundle_attestation_mismatch"));
});

test("the panel is the owner's four seats, at their exact efforts", () => {
  const digest = "a".repeat(64);
  assert.deepEqual(attestationErrors(attestation(digest), digest), []);
  const missing = attestation(digest, { verdicts: attestation(digest).verdicts.slice(0, 3) });
  assert.ok(attestationErrors(missing, digest).some((error) => error.reason === "bundle_panel_incomplete"));
  const downgraded = attestation(digest);
  downgraded.verdicts.find((entry) => entry.seat === "grok").effort = "high";
  assert.ok(
    attestationErrors(downgraded, digest).some((error) => /is not cursor\/cursor-grok-4.6\/xhigh/u.test(error.detail)),
  );
  const failed = attestation(digest);
  failed.verdicts.find((entry) => entry.seat === "muse").verdict = "fail";
  assert.ok(attestationErrors(failed, digest).some((error) => error.reason === "bundle_panel_incomplete"));
  const anonymous = attestation(digest, { release_actor: undefined });
  assert.ok(attestationErrors(anonymous, digest).some((error) => /no release actor/u.test(error.detail)));
});

test("a seat that answered about another candidate does not count", () => {
  const digest = "a".repeat(64);
  const stale = attestation(digest);
  stale.verdicts.find((entry) => entry.seat === "astra").candidate_digest = "9".repeat(64);
  assert.ok(
    attestationErrors(stale, digest).some((error) => /answered about another candidate/u.test(error.detail)),
  );
  // The attestation's own binding is a separate claim from any seat's: an
  // attestation about another candidate is wrong even when all four seats agree
  // with each other.
  const elsewhere = attestation("9".repeat(64));
  assert.ok(
    attestationErrors(elsewhere, digest)
      .some((error) => error.reason === "bundle_attestation_mismatch" && error.detail === "9".repeat(64)),
  );
});

test("a duplicate seat cannot hide a refusal, in either order", () => {
  // The schema admits more entries than seats, so the same five verdicts must
  // give the same admission whether the refusal trails or leads its seat's pass.
  const value = candidate();
  const digest = digestOf(value.members);
  const verdicts = attestation(digest).verdicts;
  const refusal = {
    seat: "opus",
    route: "anthropic/claude-opus-5",
    effort: "max",
    candidate_digest: digest,
    verdict: "fail",
  };
  const trailing = releaseAdmission(value, attestation(digest, { verdicts: [...verdicts, refusal] }));
  const leading = releaseAdmission(value, attestation(digest, { verdicts: [refusal, ...verdicts] }));
  assert.equal(trailing.admitted, leading.admitted);
  assert.equal(trailing.admitted, false);
  assert.ok(trailing.errors.some((error) => error.detail === "opus: fail"));
});

test("a duplicate entry is checked itself, not just for its verdict", () => {
  // A second entry for a seat carries its own route and digest too: a stale
  // answer behind a valid pass is still an answer about another candidate.
  const value = candidate();
  const digest = digestOf(value.members);
  const verdicts = attestation(digest).verdicts;
  const stale = { ...verdicts[0], candidate_digest: "9".repeat(64) };
  const trailing = releaseAdmission(value, attestation(digest, { verdicts: [...verdicts, stale] }));
  const leading = releaseAdmission(value, attestation(digest, { verdicts: [stale, ...verdicts] }));
  assert.equal(trailing.admitted, leading.admitted);
  assert.equal(trailing.admitted, false);
  assert.ok(trailing.errors.some((error) => /answered about another candidate/u.test(error.detail)));
});

test("a duplicate seat that agrees changes nothing", () => {
  // Duplicates are allowed and counted rather than refused at the door: a seat
  // saying the same thing twice adds no error.
  const value = candidate();
  const digest = digestOf(value.members);
  const verdicts = [...attestation(digest).verdicts, attestation(digest).verdicts[0]];
  const outcome = releaseAdmission(value, attestation(digest, { verdicts }));
  assert.deepEqual(outcome.errors.slice(), []);
  assert.equal(outcome.admitted, true);
});

test("the current pointer moves by compare-and-swap, and re-releasing is idempotent", () => {
  assert.deepEqual(releasePointer("digest-a", { digest: "digest-a", expectedCurrent: "digest-a" }), {
    action: "already_current",
    digest: "digest-a",
  });
  assert.deepEqual(releasePointer("digest-a", { digest: "digest-b", expectedCurrent: "digest-a" }), {
    action: "advance",
    from: "digest-a",
    to: "digest-b",
  });
  // Two concurrent releases cannot both win.
  assert.throws(
    () => releasePointer("digest-c", { digest: "digest-b", expectedCurrent: "digest-a" }),
    code("bundle_release_conflict"),
  );
});

test("rollback adds a pointer decision and deletes nothing", () => {
  // History is added to, so the record of what was current when a verdict was
  // taken survives the rollback.
  const plan = rollbackPlan("digest-b", {
    toDigest: "digest-a",
    releases: ["digest-a", "digest-b"],
    decisionRef: "decision-12",
  });
  assert.equal(plan.action, "new_pointer_decision");
  assert.deepEqual(plan.deletes.slice(), []);
  assert.throws(
    () => rollbackPlan("digest-b", { toDigest: "digest-z", releases: ["digest-a"], decisionRef: "d" }),
    code("bundle_release_conflict"),
  );
  assert.throws(
    () => rollbackPlan("digest-b", { toDigest: "digest-a", releases: ["digest-a"] }),
    code("bundle_release_conflict"),
  );
});

test("a pinned Epic keeps its bundle, and moving an active one is its own workflow", () => {
  assert.deepEqual(bundleForEpic({ pinned_bundle: "digest-a" }, { current: "digest-b" }), {
    bundle: "digest-a",
    reason: "pinned",
    retained: true,
  });
  assert.equal(bundleForEpic({}, { current: "digest-b" }).bundle, "digest-b");
  assert.ok(
    epicMigrationErrors({ state: "active", pinned_bundle: "digest-a" }, { toBundle: "digest-b" })
      .some((error) => /approved workflow/u.test(error.detail)),
  );
  assert.deepEqual(
    epicMigrationErrors({ state: "active", pinned_bundle: "digest-a" }, {
      toBundle: "digest-b",
      approvalRef: "decision-13",
    }),
    [],
  );
  // Migrating to the bundle it is already on is not a no-op to wave through: an
  // approval was asked for a move that is not happening, so the request is
  // about something other than what it says.
  assert.ok(
    epicMigrationErrors({ state: "active", pinned_bundle: "digest-a" }, {
      toBundle: "digest-a",
      approvalRef: "decision-13",
    }).some((error) => /already on that bundle/u.test(error.detail)),
  );
});

test("every refusal class the contract closes can be produced", () => {
  const produced = new Set();
  const collect = (errors) => {
    for (const error of errors) produced.add(error.reason);
  };
  const value = candidate();
  collect(releaseAdmission(candidate({ stage: "adaptation" }), attestation("0".repeat(64))).errors);
  collect(inventoryErrors({ members: [{ path: "missing.md" }] }, value.members));
  collect(inventoryErrors({ members: [] }, value.members));
  collect(inventoryErrors({ members: [{ path: "a.md" }] }, [member("a.md"), member("a.md")]));
  collect(canonicalTextErrors("a.md", "no newline"));
  collect(scanErrors([member("a.md", "traycer_call()\n")]));
  collect(scanErrors([member("a.md", "/Users/x\n")]));
  collect(scanErrors([member("a.md", undefined, { readable: false, text: undefined })]));
  collect(attestationErrors(attestation("a".repeat(64), { verdicts: [] }), "a".repeat(64)));
  try {
    releasePointer("c", { digest: "b", expectedCurrent: "a" });
  } catch (error) {
    produced.add(error.code);
  }
  for (const refusal of REFUSALS) {
    assert.ok(produced.has(refusal), `${refusal} is documented and never produced`);
  }
});

// Debt 10g (R6-17): the manifest is held to the carrier registry's governance files.

test("declaredInventoryErrors compares the manifest with the inventory, both ways and by count", () => {
  const declared = (paths) => ({ members: paths.map((entry) => ({ path: entry })) });
  assert.deepEqual(declaredInventoryErrors(["a.md", "b.md"], declared(["b.md", "a.md"])), []);
  assert.deepEqual(declaredInventoryErrors(["a.md", "b.md"], declared(["a.md"])), [
    { reason: "bundle_inventory_missing", detail: "b.md is in the inventory but not declared by the manifest" },
  ]);
  assert.deepEqual(declaredInventoryErrors(["a.md"], declared(["a.md", "c.md"])), [
    { reason: "bundle_inventory_extra", detail: "c.md is declared by the manifest but not in the inventory" },
  ]);
  // A path declared twice is the inventory check's to report (once, as `bundle_inventory_duplicate`
  // over the members read); reporting it here too would give one fault two errors.
  assert.deepEqual(declaredInventoryErrors(["a.md"], declared(["a.md", "a.md"])), []);
  assert.deepEqual(declaredInventoryErrors(undefined, declared(["a.md"])), [
    { reason: "bundle_inventory_missing", detail: "no inventory: the carrier registry's governance files were not supplied" },
  ]);
  assert.deepEqual(declaredInventoryErrors([], declared([])), [
    { reason: "bundle_inventory_missing", detail: "no inventory: the carrier registry's governance files were not supplied" },
  ]);
});

// Debt 10g review H1: one content digest formula, the one 02 §5 and 03 §3 state.

test("the content digest hashes exactly the preimage 02 §5 and 03 §3 state, under its own domain", () => {
  const architecture = readFileSync(new URL("../02-architecture.md", import.meta.url), "utf8");
  const plan = readFileSync(new URL("../03-technical-plan.md", import.meta.url), "utf8");
  // 02 §5: domain separator, bundle id/version/provenance and the ordered {relative_path, file_sha256} map.
  assert.ok(architecture.includes("SHA-256 от domain separator, bundle id/version/provenance и ordered `{relative_path, file_sha256}`"));
  // 03 §3: the manifest's metadata fields and "domain separator + canonical metadata + ordered file map".
  assert.ok(plan.includes("`schemaVersion`, `bundleId`, `bundleVersion`, provenance без личных paths"));
  assert.ok(plan.includes("Preimage digest — domain separator + canonical metadata + ordered file map"));
  assert.equal(BUNDLE_DIGEST_DOMAIN, "autosk-flow/governance-bundle-content/v1");

  const members = [member("b.md"), member("a.md")];
  const preimage = bundleDigestPreimage({ ...META, members });
  assert.deepEqual(Object.keys(preimage).sort(), ["bundle_id", "bundle_version", "files", "provenance"]);
  assert.deepEqual(preimage.files, [
    { relative_path: "a.md", file_sha256: members[1].sha256 },
    { relative_path: "b.md", file_sha256: members[0].sha256 },
  ]);
  assert.equal(digestOf(members), digest(BUNDLE_DIGEST_DOMAIN, preimage));

  // Each field moves the digest; nothing else does.
  const base = digestOf(members);
  for (const [field, value] of [["bundle_id", "autosk-v2"], ["bundle_version", "1.0.1"], ["provenance", "other"]]) {
    assert.notEqual(digestOf(members, { ...META, [field]: value }), base, field);
  }
  assert.notEqual(digestOf([member("a.md"), member("b.md", "changed\n")]), base);
  assert.notEqual(digestOf([member("a.md"), member("c.md", "contents of b.md\n")]), base);
  assert.equal(bundleDigest({ ...META, members, manifest_hash: "f".repeat(64), attestation: {} }), base);
});

test("a content digest without its metadata or with a malformed member is refused, not guessed", () => {
  const members = [member("a.md")];
  for (const [field, value] of [
    ["bundle_id", undefined], ["bundle_id", ""], ["bundle_version", "1.0"], ["bundle_version", undefined],
    ["provenance", ""], ["provenance", 7],
  ]) {
    assert.throws(() => bundleDigest({ ...META, [field]: value, members }), code("bundle_not_canonical"), `${field}=${value}`);
  }
  assert.throws(() => bundleDigest({ ...META, members: "a.md" }), code("bundle_not_canonical"));
  // Not a list at all — nothing to iterate — is the same refusal, not a TypeError.
  assert.throws(() => bundleDigest({ ...META, members: 7 }), code("bundle_not_canonical"));
  assert.throws(() => bundleDigest({ ...META, members: { path: "a.md", sha256: "0".repeat(64) } }), code("bundle_not_canonical"));
  assert.throws(() => bundleDigest({ ...META, members: [{ path: "a.md", sha256: "nothex" }] }), code("bundle_not_canonical"));
  assert.throws(() => bundleDigest({ ...META, members: [{ path: "", sha256: "0".repeat(64) }] }), code("bundle_not_canonical"));
  // A release admission over a manifest without metadata is refused the same way.
  const bare = candidate();
  bare.manifest = { members: bare.manifest.members };
  assert.throws(() => releaseAdmission(bare, attestation("a".repeat(64))), code("bundle_not_canonical"));
});
