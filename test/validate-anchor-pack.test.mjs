/**
 * Tests for the ticket 15 anchor pack slot.
 *
 * Before the slot, nothing named the bytes the round-4 panel was bound to:
 * `anchor_version` was a name and `scope_identity` digested a manifest of
 * absolute paths on the dispatch machine. The slot must make the pack's
 * identity durable — digest recomputable from the resource alone, one byte set
 * per anchor version, and the round record bound to the slot by name.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONTRACT_PATH,
  REFUSAL_CLASSES,
  REFUSED_PATH,
  ROOT,
  SCHEMA_PATH,
  SLOT_PATH,
  conflictErrors,
  docSection,
  loadFiles,
  memberSourceBytes,
  packDigest,
  roundBindingErrors,
  sha256,
  sourceShapeErrors,
  validateAnchorPackDesign,
  validatePack,
} from "../scripts/validate-anchor-pack.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);
const slot = () => JSON.parse(files[SLOT_PATH]);
const refused = () => JSON.parse(files[REFUSED_PATH]);
const record = () => JSON.parse(files[`resources/design-candidate/panel/round-${slot().round}.json`]);

// Byte-verifiable members rebuild through the object store, the same way the
// CLI does; this test file therefore needs a repository, like the other tests
// that shell out to git.
const catBlob = (commit, relative) => {
  try {
    return execFileSync("git", ["cat-file", "blob", `${commit}:${relative}`], { cwd: ROOT });
  } catch {
    return null;
  }
};
const ctx = { catBlob, repoFileExists: (relative) => existsSync(path.join(ROOT, relative)) };

function assertRefused(errors, refusal) {
  assert.ok(
    errors.some((message) => message.includes(refusal)),
    `expected ${refusal}, got ${JSON.stringify(errors)}`,
  );
}

test("the shipped anchor pack design validates", () => {
  assert.deepEqual(validateAnchorPackDesign(files, ctx), []);
});

test("the slot names exactly the six members the snapshot's identity.rows carried", () => {
  const expected = {
    "pack/anchor.md": "f033f46736a39f9103b6c099a306c4618bbb5e1ded2c8a52ee9c638d36c2b9b5",
    "pack/normative-technical-plan-7.md": "d6e36c64e40f6f61b7730ce8f71fce22a5fc7f945b526d804be6d4b7ed4e080c",
    "pack/normative-workflow-factory-2-8.md": "58dca37676add37d53c4a93ce6ea5fc41fdbddf4a2a18bedc9be8f425a2a8241",
    "pack/normative-workflow-graph-6-8.md": "1be532d86b125bcf2b48b6e41f4ac5f3a0c7bf34c0d6aa78ff8808220a26b843",
    "pack/panel-package.md": "22f07e1a0a3dbb5d913a2bdd24e7f3e0dfac058b293c916501009f108677474b",
    "pack/workflow-graph.v1.json": "5b02ed5de9e74e30037e3500b6bc62ec9b2ec0735f05d49504bccf8dafc1bbfe",
  };
  const named = Object.fromEntries(slot().members.map((member) => [member.path, member.sha256]));
  assert.deepEqual(named, expected);
});

test("the pack digest recomputes from the slot alone", () => {
  assert.equal(packDigest(slot().members), slot().pack_digest);
});

test("the round record carries a reference to the named slot", () => {
  const round = record();
  assert.equal(round.anchor_pack_slot, SLOT_PATH);
  assert.equal(round.anchor_pack_sha256, slot().pack_digest);
  assert.equal(round.anchor_version, slot().anchor_version);
  assert.deepEqual(roundBindingErrors(slot(), round), []);
});

test("two claims of one anchor version with different bytes are refused", () => {
  const conflicts = conflictErrors([
    { label: SLOT_PATH, pack: slot() },
    { label: REFUSED_PATH, pack: refused() },
  ]);
  assertRefused(conflicts, "anchor_pack_conflict");
  // One pack alone, or two descriptions of the same byte set, conflict with nobody.
  assert.deepEqual(conflictErrors([{ label: SLOT_PATH, pack: slot() }]), []);
  assert.deepEqual(
    conflictErrors([
      { label: SLOT_PATH, pack: slot() },
      { label: "a second epic", pack: slot() },
    ]),
    [],
  );
});

test("the refused example is internally valid and fails only as a conflicting claim", () => {
  assert.deepEqual(validatePack(refused(), schema, ctx), []);
  assert.equal(refused().anchor_version, slot().anchor_version);
  assert.notEqual(refused().pack_digest, slot().pack_digest);
});

test("a stale pack digest is refused", () => {
  const pack = slot();
  pack.pack_digest = "0".repeat(64);
  assertRefused(validatePack(pack, schema, ctx), "anchor_pack_digest_stale");
});

test("a duplicated member path is refused", () => {
  const pack = slot();
  pack.members.push({ ...pack.members[0] });
  pack.pack_digest = packDigest(pack.members);
  assertRefused(validatePack(pack, schema, ctx), "anchor_pack_member_duplicated");
});

test("a source that does not match its kind's shape is refused", () => {
  const pack = slot();
  const member = pack.members.find((entry) => entry.source.kind === "repo_file");
  delete member.source.commit;
  pack.pack_digest = packDigest(pack.members);
  assertRefused(validatePack(pack, schema, ctx), "anchor_pack_source_malformed");
});

test("a source naming a real commit that is not the frozen commit is refused", () => {
  // The reviewer's attack: re-point a member at a different real commit,
  // recompute its digest and size honestly, recompute pack_digest — internally
  // consistent, but bound to bytes the panel never froze.
  const otherCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  assert.notEqual(otherCommit, slot().frozen_commit);
  const pack = slot();
  const member = pack.members.find((entry) => entry.source.kind === "repo_file");
  member.source.commit = otherCommit;
  const bytes = catBlob(otherCommit, member.source.path);
  assert.ok(bytes !== null);
  member.sha256 = sha256(bytes);
  member.size = bytes.length;
  pack.pack_digest = packDigest(pack.members);
  const errors = validatePack(pack, schema, ctx);
  assertRefused(errors, "anchor_pack_source_unfrozen");
  assert.ok(
    !errors.some((message) => message.includes("anchor_pack_source_drifted")),
    `a consistent forgery must not be reported as drift: ${JSON.stringify(errors)}`,
  );
});

test("a byte-verifiable source that rebuilds to different bytes is refused", () => {
  const pack = slot();
  const member = pack.members.find((entry) => entry.source.kind === "doc_sections");
  member.sha256 = "0".repeat(64);
  pack.pack_digest = packDigest(pack.members);
  assertRefused(validatePack(pack, schema, ctx), "anchor_pack_source_drifted");
});

test("a byte-verifiable source that cannot be read is refused, not skipped", () => {
  const pack = slot();
  const member = pack.members.find((entry) => entry.source.kind === "repo_file");
  member.source.path = "resources/anchor-pack/no-such-file.bin";
  pack.pack_digest = packDigest(pack.members);
  assertRefused(validatePack(pack, schema, ctx), "anchor_pack_source_unverifiable");
  // With no object store at all the same members refuse rather than pass.
  const errors = validatePack(slot(), schema, {});
  assertRefused(errors, "anchor_pack_source_unverifiable");
});

test("a built member whose builder is absent is refused", () => {
  const pack = slot();
  const member = pack.members.find((entry) => entry.source.kind === "built");
  member.source.builder = "scripts/no-such-builder.mjs";
  pack.pack_digest = packDigest(pack.members);
  assertRefused(validatePack(pack, schema, ctx), "anchor_pack_source_unverifiable");
});

test("byte-verifiable members rebuild byte-exact from the frozen commit", () => {
  const verifiable = slot().members.filter((member) =>
    ["repo_file", "doc_sections"].includes(member.source.kind),
  );
  assert.equal(verifiable.length, 4);
  for (const member of verifiable) {
    const bytes = memberSourceBytes(member, ctx);
    assert.ok(bytes !== null, `${member.path}: source could not be read`);
    assert.equal(sha256(bytes), member.sha256, member.path);
    assert.equal(bytes.length, member.size, member.path);
  }
});

test("an unbound round record is refused", () => {
  const round = record();
  delete round.anchor_pack_slot;
  assertRefused(roundBindingErrors(slot(), round), "anchor_pack_round_unbound");
  const drifted = { ...record(), anchor_pack_sha256: "0".repeat(64) };
  assertRefused(roundBindingErrors(slot(), drifted), "anchor_pack_round_unbound");
});

test("the record's package_sha256 binds the panel-package member, both directions", () => {
  // The package member's bytes cannot be rebuilt, so this historical hash is
  // the only thing that pins them: a record claiming different package bytes…
  const forgedRecord = { ...record(), package_sha256: "0".repeat(64) };
  assertRefused(roundBindingErrors(slot(), forgedRecord), "anchor_pack_round_unbound");
  // …and a slot claiming a different package against the record's hash.
  const pack = slot();
  const member = pack.members.find((entry) => entry.path === "pack/panel-package.md");
  member.sha256 = "0".repeat(64);
  pack.pack_digest = packDigest(pack.members);
  assertRefused(
    roundBindingErrors(pack, { ...record(), anchor_pack_sha256: pack.pack_digest }),
    "anchor_pack_round_unbound",
  );
  // And a slot with no package member at all leaves the field bound to nothing.
  const noPackage = slot();
  noPackage.members = noPackage.members.filter((entry) => entry.path !== "pack/panel-package.md");
  noPackage.pack_digest = packDigest(noPackage.members);
  assertRefused(
    roundBindingErrors(noPackage, { ...record(), anchor_pack_sha256: noPackage.pack_digest }),
    "anchor_pack_round_unbound",
  );
});

test("the contract names every refusal class the validator can raise", () => {
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  for (const refusal of REFUSAL_CLASSES) {
    assert.ok(contract.includes(refusal), `${refusal} is not documented`);
  }
});

test("docSection slices heading-bounded text with one trailing newline", () => {
  const doc = "intro\n## 7. Errors\nbody\n\n## 8. Checks\ntail\n";
  assert.equal(docSection(doc, "## 7.", "## 8."), "## 7. Errors\nbody\n");
  assert.equal(docSection(doc, "## 9.", "## 10."), null);
  assert.equal(docSection(doc, "## 7.", "## 7."), null);
});
