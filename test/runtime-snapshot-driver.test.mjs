/**
 * Tests for minting external source snapshots (issue #21 driver).
 *
 * Real files, real symlinks, real reads. The two facts a snapshot exists to
 * establish are both about bytes that were actually read: the source was a
 * regular file when it was read, and what landed is what came back out.
 */

import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { mintErrors } from "../src/host/source-snapshot.mjs";
import {
  assertSnapshotLocation,
  digestBytes,
  gateHook,
  mintSnapshot,
  observeDrift,
  observeSource,
} from "../src/host/snapshot-driver.mjs";

const code = (name) => (error) => error.code === name;

/** The injected filesystem: the real one, with lstat reduced to what is asked. */
const fs = {
  readFile: (file) => readFile(file),
  writeFile: (file, bytes) => writeFile(file, bytes),
  mkdir: (dir) => mkdir(dir, { recursive: true }),
  realpath: (target) => realpath(target),
  lstat: async (target) => {
    const stat = await lstat(target);
    return { isFile: stat.isFile(), isSymbolicLink: stat.isSymbolicLink(), size: stat.size };
  },
};

async function project(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "autosk-snapshot-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await mkdir(path.join(projectRoot, ".autosk", "snapshots"), { recursive: true });
  await mkdir(path.join(root, "outside"), { recursive: true });
  const location = { projectRoot, transientRoots: [], worktreeRoots: [] };
  return { root, projectRoot, location };
}

test("a snapshot is minted, read back, and admitted by the contract's own check", async (t) => {
  const { root, projectRoot, location } = await project(t);
  const source = path.join(root, "spec.md");
  await writeFile(source, "the external spec\n");

  const record = await mintSnapshot(fs, {
    locator: source,
    snapshotPath: path.join(projectRoot, ".autosk", "snapshots", "spec.md"),
    mediaType: "text/markdown",
    location,
  });
  assert.equal(record.hashing_mode, "utf8_exact");
  assert.equal(record.read_back_sha256, record.snapshot_sha256);
  assert.equal(await readFile(record.snapshot_path, "utf8"), "the external spec\n");

  // The record the contract checks, assembled from what actually happened.
  const errors = mintErrors(
    {
      ...record,
      source_kind: "file",
      clearance: "cleared",
      provenance: { origin: "external", owner_project: null },
    },
    { source: { available: true, regular_file: true }, worktree: {}, location },
  );
  assert.deepEqual(errors, []);
});

test("a symlink where a file was expected is not a regular file", async (t) => {
  const { root } = await project(t);
  const real = path.join(root, "real.md");
  await writeFile(real, "x\n");
  const link = path.join(root, "link.md");
  await symlink(real, link);

  // `stat` would answer about the target and call this a file. `lstat` answers
  // about the thing named.
  const observed = await observeSource(fs, link);
  assert.equal(observed.available, true);
  assert.equal(observed.regular_file, false);
  assert.deepEqual({ ...(await observeSource(fs, path.join(root, "gone.md"))) }, {
    available: false,
    regular_file: false,
    size: null,
  });
});

test("a source that is not a regular file, or not there, refuses the mint", async (t) => {
  const { root, projectRoot, location } = await project(t);
  const link = path.join(root, "link.md");
  await symlink(path.join(root, "outside"), link);
  const snapshotPath = path.join(projectRoot, ".autosk", "snapshots", "x.md");
  await assert.rejects(
    () => mintSnapshot(fs, { locator: link, snapshotPath, mediaType: "text/markdown", location }),
    code("snapshot_source_not_regular"),
  );
  await assert.rejects(
    () => mintSnapshot(fs, { locator: path.join(root, "nope.md"), snapshotPath, mediaType: "text/markdown", location }),
    code("snapshot_source_unavailable"),
  );
});

test("a snapshot directory replaced by a symlink does not become an out-of-project write", async (t) => {
  const { root, projectRoot, location } = await project(t);
  const source = path.join(root, "spec.md");
  await writeFile(source, "x\n");
  // The path still looks like it is inside the project.
  const escaping = path.join(projectRoot, ".autosk", "sessions");
  await symlink(path.join(root, "outside"), escaping);

  await assert.rejects(
    () => assertSnapshotLocation(fs, path.join(escaping, "spec.md"), location),
    code("snapshot_out_of_project"),
  );
  await assert.rejects(
    () => mintSnapshot(fs, {
      locator: source,
      snapshotPath: path.join(escaping, "spec.md"),
      mediaType: "text/markdown",
      location,
    }),
    code("snapshot_out_of_project"),
  );
  // And nothing was written through the link.
  await assert.rejects(() => readFile(path.join(root, "outside", "spec.md")));
});

test("an fs that answers about the target, not the link, is still caught", async (t) => {
  const { root } = await project(t);
  const real = path.join(root, "real.md");
  await writeFile(real, "x\n");
  const link = path.join(root, "link.md");
  await symlink(real, link);
  // A wrapper built on `stat` reports a symlink to a file as a file. The
  // second clause is what keeps that from becoming a snapshot of whatever the
  // link points at.
  const followingFs = {
    ...fs,
    lstat: async (target) => {
      const stat = await fs.lstat(target);
      return { ...stat, isFile: stat.isFile || stat.isSymbolicLink };
    },
  };
  assert.equal((await observeSource(followingFs, link)).regular_file, false);
  assert.equal((await observeSource(followingFs, real)).regular_file, true);
});

test("a write that returned is not evidence that the bytes are there", async (t) => {
  const { root, projectRoot, location } = await project(t);
  const source = path.join(root, "spec.md");
  await writeFile(source, "the whole spec\n");
  // A filesystem that truncates. The write returns; the bytes are not there.
  const lyingFs = {
    ...fs,
    writeFile: (file, bytes) => fs.writeFile(file, bytes.slice(0, 4)),
  };
  const record = await mintSnapshot(lyingFs, {
    locator: source,
    snapshotPath: path.join(projectRoot, ".autosk", "snapshots", "spec.md"),
    mediaType: "text/markdown",
    location,
  });
  // Two fields, and this is the case they are two for.
  assert.notEqual(record.read_back_sha256, record.snapshot_sha256);
  const errors = mintErrors(
    { ...record, source_kind: "file", clearance: "cleared", provenance: { origin: "external" } },
    { source: { available: true, regular_file: true }, worktree: {}, location },
  );
  assert.ok(errors.some((error) => error.reason === "snapshot_read_back_mismatch"), JSON.stringify(errors));
});

test("the hashing mode follows the media type, and both are recorded", async (t) => {
  const { root, projectRoot, location } = await project(t);
  const binary = path.join(root, "image.png");
  await writeFile(binary, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x0a]));
  const record = await mintSnapshot(fs, {
    locator: binary,
    snapshotPath: path.join(projectRoot, ".autosk", "snapshots", "image.png"),
    mediaType: "image/png",
    location,
  });
  // A digest that depends on line endings is not an identity for a PNG.
  assert.equal(record.hashing_mode, "binary_exact");
  assert.equal(record.bytes, 8);
  assert.equal(digestBytes(Buffer.from("a\r\n"), "text/plain").mode, "utf8_exact");
  assert.equal(digestBytes(Buffer.from("a\r\n"), "application/json").mode, "utf8_exact");
  assert.equal(digestBytes(Buffer.from("a"), "application/pdf").mode, "binary_exact");
});

test("drift is observed against the recorded digest, and uncertainty is its own answer", async (t) => {
  const { root, projectRoot, location } = await project(t);
  const source = path.join(root, "spec.md");
  await writeFile(source, "one\n");
  const record = await mintSnapshot(fs, {
    locator: source,
    snapshotPath: path.join(projectRoot, ".autosk", "snapshots", "spec.md"),
    mediaType: "text/markdown",
    location,
  });

  assert.equal((await observeDrift(fs, record)).state, "unchanged");
  await writeFile(source, "two\n");
  const changed = await observeDrift(fs, record);
  assert.equal(changed.state, "changed");
  assert.notEqual(changed.observed_sha256, record.source_sha256);
  // Whether the drift is normative decides whether it blocks. A record that
  // does not say is normative — silence is not permission — and one that says
  // `false` is the only non-normative case. Reading it the other way round
  // would let every unmarked source drift silently.
  assert.equal(changed.normative, true);
  const explicit = await observeDrift(fs, { ...record, normative: false });
  assert.equal(explicit.normative, false);
  const stated = await observeDrift(fs, { ...record, normative: true });
  assert.equal(stated.normative, true);

  await rm(source);
  assert.equal((await observeDrift(fs, record)).state, "unavailable");
  // There, but no longer the same kind of thing: neither unchanged nor changed.
  await symlink(path.join(root, "outside"), source);
  assert.equal((await observeDrift(fs, record)).state, "identity_uncertain");
});

test("the gate re-observes every snapshot, and says what it checked", async (t) => {
  const { root, projectRoot, location } = await project(t);
  const records = [];
  for (const name of ["a.md", "b.md"]) {
    const source = path.join(root, name);
    await writeFile(source, `${name}\n`);
    records.push(await mintSnapshot(fs, {
      locator: source,
      snapshotPath: path.join(projectRoot, ".autosk", "snapshots", name),
      mediaType: "text/markdown",
      location,
    }));
  }
  const clean = await gateHook(fs, { records });
  assert.equal(clean.decision, "proceed");
  assert.equal(clean.checked, 2);

  // A gate that trusts a digest recorded an hour ago is a gate about an hour
  // ago.
  await writeFile(path.join(root, "b.md"), "changed\n");
  const drifted = await gateHook(fs, { records });
  assert.equal(drifted.decision, "park");
  assert.deepEqual([...drifted.blocking], [path.join(root, "b.md")]);
  assert.equal(drifted.checked, 2);
});
