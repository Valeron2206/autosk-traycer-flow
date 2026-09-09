/**
 * Tests for the governance bundle build and release (issue #37 runtime).
 *
 * One input must give one digest, so most of these are about the canonical
 * form and about what a candidate has to prove before it can be the bundle the
 * runtime uses.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  REFUSALS,
  REQUIRED_SEATS,
  STAGES,
  attestationErrors,
  bundleDigest,
  bundleForEpic,
  canonicalJson,
  canonicalTextErrors,
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
    manifest: overrides.manifest ?? { members: members.map((entry) => ({ path: entry.path })) },
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
  const outcome = releaseAdmission(value, attestation(bundleDigest(value.members)));
  assert.deepEqual(outcome.errors.slice(), []);
  assert.equal(outcome.admitted, true);
});

test("the digest is over path and hash in path order, and does not depend on member order", () => {
  const members = [member("b.md"), member("a.md")];
  assert.equal(bundleDigest(members), bundleDigest([...members].reverse()));
  assert.notEqual(bundleDigest(members), bundleDigest([member("a.md"), member("b.md", "different\n")]));
  // The comparator's tie branch is unreachable while member paths are unique,
  // and the inventory refuses a repeated path — so the property tested is the
  // one the sort exists for, and the tie itself never arises.
  const paths = [member("a.md"), member("b.md"), member("c.md")].map((entry) => entry.path);
  assert.equal(new Set(paths).size, paths.length);
});

test("only Markdown members with real text are held to the canonical text form", () => {
  // `typeof text === 'string' && path.endsWith('.md')` — an `||` there would
  // hand a Buffer to a text check, and a `!==` would exempt exactly the files
  // the rule is for. Each half is asked on its own.
  const canonical = (path, text) => releaseAdmission(
    { manifest: { members: [{ path, sha256: "0".repeat(64) }] }, members: [{ path, sha256: "0".repeat(64), text }] },
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
  const first = bundleDigest(members);
  const second = bundleDigest(members.map((entry) => ({ ...entry, built_at: "2026-09-09T00:00:00Z" })));
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
  const outcome = releaseAdmission(value, attestation(bundleDigest(value.members)));
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
  const digest = bundleDigest(before.members);
  const verdicts = attestation(digest);
  // The fix: one member changes.
  const after = candidate({
    members: [
      member("agent-selection-guide.md", "fixed after the panel\n"),
      before.members[1],
      before.members[2],
    ],
  });
  after.manifest = { members: after.members.map((entry) => ({ path: entry.path })) };
  const outcome = releaseAdmission(after, verdicts);
  assert.notEqual(bundleDigest(after.members), digest);
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
