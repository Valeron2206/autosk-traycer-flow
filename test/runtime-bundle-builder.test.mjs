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

const MEMBERS = {
  "protocol/00-index.md": "# Index\n",
  "protocol/01-roles.md": "# Roles\n",
  "bundle-manifest.json": '{\n  "schema_version": 1\n}\n',
};

const manifest = (paths = Object.keys(MEMBERS)) => ({
  manifest_id: "m-1",
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
  const built = await buildBundle(fs, { root, manifest: manifest() });
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  assert.equal(built.members.length, 3);

  // Built twice from the same bytes: the same digest, with no timestamp in it.
  const again = await buildBundle(fs, { root, manifest: manifest() });
  assert.equal(again.digest, built.digest);
  // And the declaration order does not change it, because the digest sorts.
  const reordered = await buildBundle(fs, {
    root,
    manifest: manifest(["bundle-manifest.json", "protocol/01-roles.md", "protocol/00-index.md"]),
  });
  assert.equal(reordered.digest, built.digest);
  assert.equal(built.digest, bundleDigest(built.members));
});

test("a member that is not in canonical form is refused, not normalised", async (t) => {
  // Normalising quietly would mean the bundle that was scanned is not the
  // bundle that was written.
  for (const [name, content] of [
    ["bom", "﻿# Index\n"],
    ["crlf", "# Index\r\n"],
    ["no-trailing-newline", "# Index"],
  ]) {
    const root = await bundleRoot(t, { ...MEMBERS, "protocol/00-index.md": content });
    const built = await buildBundle(fs, { root, manifest: manifest() });
    assert.equal(built.ok, false, name);
    assert.ok(built.errors.length > 0, name);
  }
});

test("a member that is missing, and a file that appeared, are both refused", async (t) => {
  const root = await bundleRoot(t);
  const declaredButAbsent = await buildBundle(fs, {
    root,
    manifest: manifest([...Object.keys(MEMBERS), "protocol/99-gone.md"]),
  });
  assert.equal(declaredButAbsent.ok, false);
  assert.ok(declaredButAbsent.errors.some((error) => error.reason === "bundle_scan_unreadable"));
  assert.ok(declaredButAbsent.errors.some((error) => error.reason === "bundle_inventory_missing"));

  // A directory walk would make an accidentally-added file part of the bundle;
  // the manifest decides, so an undeclared file is simply not read.
  await writeFile(path.join(root, "protocol/02-stray.md"), "# Stray\n");
  const stray = await buildBundle(fs, { root, manifest: manifest() });
  assert.equal(stray.ok, true, JSON.stringify(stray.errors));
  assert.ok(!stray.members.some((member) => member.path.endsWith("02-stray.md")));
});

test("nothing Traycer-specific and nothing private gets into the bundle", async (t) => {
  const leaking = await bundleRoot(t, {
    ...MEMBERS,
    "protocol/01-roles.md": "# Roles\nSee /Users/somebody/notes.md and TRAYCER_HOME.\n",
  });
  const built = await buildBundle(fs, { root: leaking, manifest: manifest() });
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
  });
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  assert.equal(isTextMember("assets/logo.png"), false);
  assert.equal(isTextMember("protocol/00-index.md"), true);
  const png = built.members.find((member) => member.path === "assets/logo.png");
  assert.equal(png.readable, true);
  assert.ok(png.sha256);
});

test("no digest is written for a bundle that did not build", async (t) => {
  const root = await bundleRoot(t, { ...MEMBERS, "protocol/00-index.md": "# Index" });
  const built = await buildBundle(fs, { root, manifest: manifest() });
  assert.equal(built.ok, false);
  // A digest printed beside a list of errors is a number that reads like a
  // result.
  assert.throws(() => candidateDocument(built, manifest()), code(built.errors[0].reason));
});

test("the candidate is written in the canonical JSON the contract fixes", async (t) => {
  const root = await bundleRoot(t);
  const built = await buildBundle(fs, { root, manifest: manifest() });
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
  const built = await buildBundle(fs, { root, manifest: manifest(), stage: "whenever" });
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
