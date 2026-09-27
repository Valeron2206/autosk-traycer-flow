/**
 * Tests for importing and building the governance bundle (issue #37).
 *
 * One input must give one digest. Everything here is a way that could stop
 * being true — a BOM, a CRLF, a missing member, a file that appeared, a private
 * path in the prose — and each of them is refused rather than normalised,
 * because a bundle quietly normalised is not the bundle that was scanned.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { bundleDigest } from "../src/host/governance-bundle.mjs";
import { registryInventory } from "../scripts/governance-bundle.mjs";
import {
  buildBundle,
  candidateDocument,
  importMembers,
  isTextMember,
  writeCandidate,
} from "../src/host/bundle-builder.mjs";

const code = (name) => (error) => error.code === name;

const fs = {
  readFile: (file) => readFile(file),
  writeFile: (file, text) => writeFile(file, text),
};

/** Three of the thirteen governance files: members follow the one list, and the manifest is not one. */
const MEMBERS = {
  "agent-selection-guide.md": "# Guide\n",
  "protocol/principles-digest.md": "# Principles\n",
  "protocol/playbooks/feature.md": "# Feature\n",
};

/** The manifest metadata 02 §5 puts in the content digest's preimage. */
const META = Object.freeze({ bundle_id: "autosk-v1", bundle_version: "1.0.0", provenance: "autosk-native adaptation" });

/** The inventory the build is held to; in the product it is the carrier registry's governance files. */
const INVENTORY = Object.freeze(Object.keys(MEMBERS));

const manifest = (paths = Object.keys(MEMBERS)) => ({
  manifest_id: "m-1",
  ...META,
  members: paths.map((entry) => ({ path: entry })),
});

async function bundleRoot(t, files = MEMBERS) {
  const root = await mkdtemp(path.join(tmpdir(), "autosk-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.join(root, path.dirname(name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}

test("one input gives one digest, and the digest is over the members in path order", async (t) => {
  const root = await bundleRoot(t);
  const built = await buildBundle(fs, { root, manifest: manifest(), inventory: INVENTORY });
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  assert.equal(built.members.length, 3);

  // Built twice from the same bytes: the same digest, with no timestamp in it.
  const again = await buildBundle(fs, { root, manifest: manifest(), inventory: INVENTORY });
  assert.equal(again.digest, built.digest);
  // And the declaration order does not change it, because the digest sorts.
  const reordered = await buildBundle(fs, {
    root,
    manifest: manifest(["protocol/playbooks/feature.md", "protocol/principles-digest.md", "agent-selection-guide.md"]),
    inventory: INVENTORY,
  });
  assert.equal(reordered.digest, built.digest);
  assert.equal(built.digest, bundleDigest({ ...META, members: built.members }));
});

test("a member that is not in canonical form is refused, not normalised", async (t) => {
  // Normalising quietly would mean the bundle that was scanned is not the
  // bundle that was written.
  for (const [name, content] of [
    ["bom", "﻿# Index\n"],
    ["crlf", "# Index\r\n"],
    ["no-trailing-newline", "# Index"],
  ]) {
    const root = await bundleRoot(t, { ...MEMBERS, "protocol/principles-digest.md": content });
    const built = await buildBundle(fs, { root, manifest: manifest(), inventory: INVENTORY });
    assert.equal(built.ok, false, name);
    assert.ok(built.errors.length > 0, name);
  }
});

test("a member that is missing, and a file that appeared, are both refused", async (t) => {
  const root = await bundleRoot(t);
  const declaredButAbsent = await buildBundle(fs, {
    root,
    manifest: manifest([...Object.keys(MEMBERS), "protocol/99-gone.md"]),
    inventory: [...INVENTORY, "protocol/99-gone.md"],
  });
  assert.equal(declaredButAbsent.ok, false);
  assert.ok(declaredButAbsent.errors.some((error) => error.reason === "bundle_scan_unreadable"));
  assert.ok(declaredButAbsent.errors.some((error) => error.reason === "bundle_inventory_missing"));

  // A directory walk would make an accidentally-added file part of the bundle;
  // the manifest decides, so an undeclared file is simply not read.
  await writeFile(path.join(root, "protocol/stray.md"), "# Stray\n");
  const stray = await buildBundle(fs, { root, manifest: manifest(), inventory: INVENTORY });
  assert.equal(stray.ok, true, JSON.stringify(stray.errors));
  assert.ok(!stray.members.some((member) => member.path.endsWith("stray.md")));
});

test("nothing Traycer-specific and nothing private gets into the bundle", async (t) => {
  const leaking = await bundleRoot(t, {
    ...MEMBERS,
    "protocol/principles-digest.md": "# Principles\nSee /Users/somebody/notes.md and TRAYCER_HOME.\n",
  });
  const built = await buildBundle(fs, { root: leaking, manifest: manifest(), inventory: INVENTORY });
  assert.equal(built.ok, false);
  assert.ok(built.errors.some((error) => error.reason === "bundle_private_path"));
  assert.ok(built.errors.some((error) => error.reason === "bundle_traycer_reference"));
});

test("a member with no text is carried by digest, not held to the text rules", async (t) => {
  // Real PNG bytes: a CR inside them and no trailing newline. Decoded as text
  // they would fail the canonical form, which is why the media type decides
  // whether prose rules apply at all.
  const root = await bundleRoot(t, {
    ...MEMBERS,
    "assets/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  });
  const built = await buildBundle(fs, {
    root,
    manifest: manifest([...Object.keys(MEMBERS), "assets/logo.png"]),
    inventory: [...INVENTORY, "assets/logo.png"],
  });
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  assert.equal(isTextMember("assets/logo.png"), false);
  assert.equal(isTextMember("protocol/principles-digest.md"), true);
  const png = built.members.find((member) => member.path === "assets/logo.png");
  assert.equal(png.readable, true);
  assert.ok(png.sha256);
});

test("no digest is written for a bundle that did not build", async (t) => {
  const root = await bundleRoot(t, { ...MEMBERS, "protocol/principles-digest.md": "# Principles" });
  const built = await buildBundle(fs, { root, manifest: manifest(), inventory: INVENTORY });
  assert.equal(built.ok, false);
  // A digest printed beside a list of errors is a number that reads like a
  // result.
  assert.throws(() => candidateDocument(built, manifest()), code(built.errors[0].reason));
});

test("the candidate is written in the canonical JSON the contract fixes", async (t) => {
  const root = await bundleRoot(t);
  const built = await buildBundle(fs, { root, manifest: manifest(), inventory: INVENTORY });
  const out = path.join(root, "candidate.json");
  const written = await writeCandidate(fs, { path: out, built, manifest: manifest() });
  assert.equal(written.digest, built.digest);

  const text = await readFile(out, "utf8");
  assert.equal(text.endsWith("\n"), true);
  assert.equal(text.includes('  "bundle_digest"'), true);
  const parsed = JSON.parse(text);
  assert.equal(parsed.bundle_digest, built.digest);
  // Timestamps are not in the digest and not in the candidate.
  assert.ok(!/\d{4}-\d{2}-\d{2}T/u.test(text), text.slice(0, 200));
  assert.deepEqual(Object.keys(parsed), [...Object.keys(parsed)].sort());
});

test("an unknown stage is refused before anything is digested", async (t) => {
  const root = await bundleRoot(t);
  const built = await buildBundle(fs, { root, manifest: manifest(), inventory: INVENTORY, stage: "whenever" });
  assert.equal(built.ok, false);
  assert.ok(built.errors.some((error) => error.reason === "bundle_stage_mixed"));
});

test("importMembers reads the declared members and reports what it could not read", async (t) => {
  const root = await bundleRoot(t);
  const members = await importMembers(fs, { root, manifest: manifest([...Object.keys(MEMBERS), "nope.md"]) });
  assert.equal(members.length, 4);
  const missing = members.find((member) => member.path === "nope.md");
  assert.equal(missing.readable, false);
  assert.equal(missing.detail, "ENOENT");
});

// Debt 10g (R6-17): the build is held to one member list, the carrier registry's governance files.

test("a build without an inventory is refused, and so is a manifest that is not the inventory", async (t) => {
  const root = await bundleRoot(t);
  const without = await buildBundle(fs, { root, manifest: manifest() });
  assert.equal(without.ok, false);
  assert.deepEqual(without.errors.filter((error) => /inventory/u.test(error.detail)), [
    { reason: "bundle_inventory_missing", detail: "no inventory: the carrier registry's governance files were not supplied" },
  ]);
  // Declared but not in the inventory: extra. In the inventory but not declared: missing.
  const short = await buildBundle(fs, { root, manifest: manifest(), inventory: INVENTORY.slice(1) });
  assert.equal(short.ok, false);
  assert.ok(short.errors.some((error) => error.reason === "bundle_inventory_extra" && error.detail.includes(INVENTORY[0])));
  const long = await buildBundle(fs, { root, manifest: manifest(), inventory: [...INVENTORY, "protocol/02-more.md"] });
  assert.equal(long.ok, false);
  assert.ok(long.errors.some((error) => error.reason === "bundle_inventory_missing" && error.detail.includes("protocol/02-more.md")));
});

test("the CLI takes the inventory from the carrier registry", async () => {
  const registry = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../resources/stage-carriers/stage-carriers.v1.json"), "utf8"));
  assert.deepEqual(await registryInventory(), registry.governance_files.map((file) => file.path));
});

// Debt 10g review: the manifest carries the digest's metadata, and a repeat is reported once.

test("the build takes the digest's metadata from the manifest, and refuses a manifest without it", async (t) => {
  const root = await bundleRoot(t);
  const built = await buildBundle(fs, { root, manifest: manifest(), inventory: INVENTORY });
  const moved = await buildBundle(fs, { root, manifest: { ...manifest(), bundle_version: "1.0.1" }, inventory: INVENTORY });
  assert.equal(moved.ok, true, JSON.stringify(moved.errors));
  assert.notEqual(moved.digest, built.digest);
  const bare = manifest();
  delete bare.provenance;
  const refused = await buildBundle(fs, { root, manifest: bare, inventory: INVENTORY });
  assert.equal(refused.ok, false);
  assert.equal(refused.digest, null);
  assert.ok(refused.errors.some((error) => error.reason === "bundle_not_canonical" && /provenance/u.test(error.detail)));
  // The candidate carries the metadata, so its digest recomputes from the document alone.
  const parsed = JSON.parse(candidateDocument(built, manifest()));
  assert.equal(bundleDigest({ ...parsed, members: parsed.members }), built.digest);
});

test("a path the manifest declares twice is reported once", async (t) => {
  const root = await bundleRoot(t);
  const paths = [...INVENTORY, INVENTORY[0]];
  const built = await buildBundle(fs, { root, manifest: manifest(paths), inventory: INVENTORY });
  assert.equal(built.ok, false);
  assert.deepEqual(built.errors.filter((error) => error.reason === "bundle_inventory_duplicate"), [
    { reason: "bundle_inventory_duplicate", detail: INVENTORY[0] },
  ]);
});
