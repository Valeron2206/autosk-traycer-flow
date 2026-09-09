/**
 * Tests for verified artifact writes (issue #22 driver).
 *
 * A write that returned is not an artifact that exists. Every case here is one
 * of the things that sit between those two: a path that resolves elsewhere, a
 * previous version that was not what the write assumed, a filesystem that
 * stored other bytes, and an artifact that should not have been published.
 */

import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { isVerified } from "../src/host/write-reconciliation.mjs";
import {
  carryOutDisposition,
  completeReceipt,
  observeDestination,
  resolveDestination,
  resumeFromReceipts,
  verifiedWrite,
} from "../src/host/write-driver.mjs";

const code = (name) => (error) => error.code === name;
const digest = (text) => createHash("sha256").update(text).digest("hex");

const fs = {
  readFile: (file) => readFile(file),
  writeFile: (file, bytes) => writeFile(file, bytes),
  mkdir: (dir) => mkdir(dir, { recursive: true }),
  realpath: (target) => realpath(target),
  lstat: async (target) => {
    const stat = await lstat(target);
    return {
      isFile: stat.isFile(),
      isSymbolicLink: stat.isSymbolicLink(),
      size: stat.size,
      nlink: stat.nlink,
    };
  },
};

async function workspace(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "autosk-write-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactRoot = path.join(root, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  await mkdir(path.join(root, "outside"), { recursive: true });
  await mkdir(path.join(root, "quarantine"), { recursive: true });
  return { root, artifactRoot, quarantinePath: path.join(root, "quarantine", "held.json") };
}

test("a write is verified by reading it back, and the receipt says both digests", async (t) => {
  const { root, artifactRoot } = await workspace(t);
  const destination = path.join(artifactRoot, "brief.md");
  const bytes = Buffer.from("# Brief\n");

  const receipt = await verifiedWrite(fs, {
    destination,
    bytes,
    artifactRoot,
    klass: "brief",
    operationId: "op-1",
    quarantinePath: path.join(root, "quarantine", "held.md"),
  });
  assert.equal(receipt.phase, "written");
  assert.equal(receipt.published, true);
  assert.equal(receipt.observed_sha256, receipt.intended_sha256);
  assert.equal(await readFile(destination, "utf8"), "# Brief\n");

  const complete = await completeReceipt(fs, receipt, {
    taskMetadataDigest: receipt.intended_sha256,
    modelOutputDigest: receipt.intended_sha256,
  });
  assert.equal(complete.phase, "verified");
  assert.equal(isVerified(complete), true);
  assert.equal(complete.reconciliation.state, "agreed");
});

test("four sources are named, including the ones nobody read", async (t) => {
  const { root, artifactRoot } = await workspace(t);
  const receipt = await verifiedWrite(fs, {
    destination: path.join(artifactRoot, "brief.md"),
    bytes: Buffer.from("x\n"),
    artifactRoot,
    klass: "brief",
    operationId: "op-1",
    quarantinePath: path.join(root, "quarantine", "held.md"),
  });
  // A source that could not be read is `unknown` rather than absent: the
  // difference is whether the flow knows it did not look.
  const partial = await completeReceipt(fs, receipt, {});
  assert.equal(partial.phase, "diverged");
  assert.equal(partial.reconciliation.state, "unreconciled");
  const unknown = partial.reconciliation.report.filter((entry) => entry.state === "unknown");
  assert.deepEqual(unknown.map((entry) => entry.source).sort(), ["model_output", "task_metadata"]);

  // And a source that disagrees is divergence, not a rounding difference.
  const diverged = await completeReceipt(fs, receipt, {
    taskMetadataDigest: digest("something else"),
    modelOutputDigest: receipt.intended_sha256,
  });
  assert.equal(diverged.reconciliation.state, "diverged");
  assert.equal(isVerified(diverged), false);

  // The canonical bytes are read at reconcile time, not carried from the
  // write: somebody who changed the file in between is exactly what this
  // source is here to notice.
  await writeFile(receipt.path, "somebody else was here\n");
  const changed = await completeReceipt(fs, receipt, {
    taskMetadataDigest: receipt.intended_sha256,
    modelOutputDigest: receipt.intended_sha256,
  });
  assert.equal(changed.reconciliation.state, "diverged");
  const canonical = changed.reconciliation.report.find((entry) => entry.source === "canonical_bytes");
  assert.equal(canonical.digest, digest("somebody else was here\n"));
});

test("the destination is resolved, so an escaping path is refused before any write", async (t) => {
  const { root, artifactRoot } = await workspace(t);
  const escaping = path.join(artifactRoot, "sessions");
  await symlink(path.join(root, "outside"), escaping);

  await assert.rejects(
    () => resolveDestination(fs, path.join(escaping, "brief.md"), { artifactRoot }),
    code("write_destination_invalid"),
  );
  await assert.rejects(
    () => verifiedWrite(fs, {
      destination: path.join(escaping, "brief.md"),
      bytes: Buffer.from("x\n"),
      artifactRoot,
      klass: "brief",
      operationId: "op-1",
      quarantinePath: path.join(root, "quarantine", "held.md"),
    }),
    code("write_destination_invalid"),
  );
  await assert.rejects(() => readFile(path.join(root, "outside", "brief.md")));
});

test("a hard-linked or special destination is not a place to publish", async (t) => {
  const { root, artifactRoot } = await workspace(t);
  const destination = path.join(artifactRoot, "brief.md");
  await writeFile(destination, "original\n");
  // Writing through a link changes something nobody named.
  await link(destination, path.join(root, "outside", "hardlink.md"));
  const observed = await observeDestination(fs, destination);
  assert.equal(observed.regular_single_linked, false);
  // A hard link is still a regular file, so the bytes are read and compared;
  // what makes it unpublishable is the link count, not the read. A symlink is
  // the other case, and its bytes are deliberately not read at all — following
  // it would read whatever it points at and call that the destination.
  // The digest is present because a hard link is still a regular file whose
  // bytes are the destination's bytes.
  assert.equal(observed.sha256, digest("original\n"));
  // A symlink is the other case, and its bytes are deliberately not read:
  // following it would hash whatever it points at and call that the
  // destination, which is the substitution the check exists to refuse.
  const symlinkPath = path.join(artifactRoot, "linked.md");
  await symlink(destination, symlinkPath);
  const viaSymlink = await observeDestination(fs, symlinkPath);
  assert.equal(viaSymlink.sha256, null);
  assert.equal(viaSymlink.regular_single_linked, false);
  // A directory standing where the artifact should be exists and is not a
  // place to publish. Reading it would throw and the observation would report
  // "nothing is there", which is the one answer that would let a write proceed.
  const occupied = path.join(artifactRoot, "occupied.md");
  await mkdir(occupied, { recursive: true });
  const viaDirectory = await observeDestination(fs, occupied);
  assert.equal(viaDirectory.exists, true);
  assert.equal(viaDirectory.regular_single_linked, false);
  assert.equal(viaDirectory.sha256, null);
  await assert.rejects(
    () => verifiedWrite(fs, {
      destination,
      bytes: Buffer.from("new\n"),
      expectedPrevious: digest("original\n"),
      artifactRoot,
      klass: "brief",
      operationId: "op-1",
      quarantinePath: path.join(root, "quarantine", "held.md"),
    }),
    code("write_not_regular"),
  );
  assert.equal(await readFile(destination, "utf8"), "original\n");
});

test("the previous version is compared before anything is written", async (t) => {
  const { root, artifactRoot } = await workspace(t);
  const destination = path.join(artifactRoot, "brief.md");
  await writeFile(destination, "current\n");
  // "The file changed under us", discovered afterwards, is a fact about a file
  // that has already been overwritten.
  await assert.rejects(
    () => verifiedWrite(fs, {
      destination,
      bytes: Buffer.from("new\n"),
      expectedPrevious: digest("what we thought\n"),
      artifactRoot,
      klass: "brief",
      operationId: "op-1",
      quarantinePath: path.join(root, "quarantine", "held.md"),
    }),
    code("write_previous_mismatch"),
  );
  assert.equal(await readFile(destination, "utf8"), "current\n");
  // A first write expects nothing, and a write over a known version says which.
  const first = await verifiedWrite(fs, {
    destination: path.join(artifactRoot, "new.md"),
    bytes: Buffer.from("a\n"),
    artifactRoot,
    klass: "brief",
    operationId: "op-1",
    quarantinePath: path.join(root, "quarantine", "held.md"),
  });
  assert.equal(first.phase, "written");
});

test("a filesystem that stored other bytes fails the receipt rather than the write", async (t) => {
  const { root, artifactRoot } = await workspace(t);
  const lyingFs = { ...fs, writeFile: (file, bytes) => fs.writeFile(file, bytes.slice(0, 2)) };
  const receipt = await verifiedWrite(lyingFs, {
    destination: path.join(artifactRoot, "brief.md"),
    bytes: Buffer.from("the whole thing\n"),
    artifactRoot,
    klass: "brief",
    operationId: "op-1",
    quarantinePath: path.join(root, "quarantine", "held.md"),
  });
  assert.equal(receipt.phase, "failed");
  assert.equal(receipt.reason, "write_readback_mismatch");
  assert.equal(receipt.published, false);
  await assert.rejects(() => completeReceipt(fs, receipt, {}), code("write_readback_mismatch"));
});

test("an artifact that may not be published is held, and the bytes are not destroyed", async (t) => {
  const { root, artifactRoot, quarantinePath } = await workspace(t);
  const destination = path.join(artifactRoot, "huge.json");
  const receipt = await verifiedWrite(fs, {
    destination,
    bytes: Buffer.from("x".repeat(64)),
    artifactRoot,
    policy: { max_bytes: 16 },
    klass: "evidence",
    operationId: "op-1",
    quarantinePath,
  });
  assert.equal(receipt.phase, "quarantined");
  assert.equal(receipt.published, false);
  assert.equal(receipt.quarantine.reason, "oversized");
  // Pending until a human records one: every automatic release is a policy
  // decision made without the person who owns the consequence.
  assert.equal(receipt.quarantine.disposition, "pending");
  // The source is not destroyed, and the canonical path was never written.
  assert.equal((await readFile(quarantinePath)).length, 64);
  await assert.rejects(() => readFile(destination));
});

test("a malformed artifact, and one whose policy nobody could determine, are held too", async (t) => {
  const { root, artifactRoot, quarantinePath } = await workspace(t);
  for (const [field, reason] of [["classValid", "malformed_for_class"], ["policyKnown", "policy_undetermined"]]) {
    const receipt = await verifiedWrite(fs, {
      destination: path.join(artifactRoot, `${reason}.json`),
      bytes: Buffer.from("{}"),
      artifactRoot,
      klass: "evidence",
      operationId: "op-1",
      quarantinePath,
      [field]: false,
    });
    assert.equal(receipt.phase, "quarantined", reason);
    assert.equal(receipt.quarantine.reason, reason);
  }
  assert.ok(root);
});

test("receipts are durable enough to tell a resume which half happened", async (t) => {
  const { root, artifactRoot } = await workspace(t);
  const written = await verifiedWrite(fs, {
    destination: path.join(artifactRoot, "a.md"),
    bytes: Buffer.from("a\n"),
    artifactRoot,
    klass: "brief",
    operationId: "op-1",
    quarantinePath: path.join(root, "quarantine", "held.md"),
  });
  const verified = await completeReceipt(fs, written, {
    taskMetadataDigest: written.intended_sha256,
    modelOutputDigest: written.intended_sha256,
  });
  // A crash between the write and the read-back leaves `written`, which the
  // resume can tell from `verified`.
  const resume = resumeFromReceipts([verified, written], { runId: "op-1" });
  assert.equal(resume.total, 2);
  assert.deepEqual([...resume.unfinished], [{ path: written.path, phase: "written" }]);
  assert.equal(resume.next, "resume written");
  assert.equal(resumeFromReceipts([verified], { runId: "op-1" }).next, "complete");
  assert.equal(resumeFromReceipts([verified], { runId: "op-2" }).total, 0);
  // Quarantined and failed are finished too: each is a recorded outcome, and a
  // resume that reopened them would write over a decision.
  const settled = resumeFromReceipts(
    [
      verified,
      { ...written, phase: "quarantined", operation_id: "op-1" },
      { ...written, phase: "failed", operation_id: "op-1" },
    ],
    { runId: "op-1" },
  );
  assert.deepEqual([...settled.unfinished], []);
  assert.equal(settled.next, "complete");
});

test("a disposition is carried out, and the four are not symmetric", async (t) => {
  const { root, artifactRoot, quarantinePath } = await workspace(t);
  const destination = path.join(artifactRoot, "held.json");
  const held = async () => verifiedWrite(fs, {
    destination,
    bytes: Buffer.from("x".repeat(64)),
    artifactRoot,
    policy: { max_bytes: 16 },
    klass: "evidence",
    operationId: "op-1",
    quarantinePath,
  });

  // Looking at something is not deciding about it.
  const inspected = await carryOutDisposition(fs, { receipt: await held(), disposition: "inspect", by: "owner" });
  assert.equal(inspected.published, false);
  assert.equal(inspected.quarantine.disposed_by, "owner");
  await assert.rejects(() => readFile(destination));

  // A rejected artifact keeps its bytes: deleting them would destroy the only
  // copy of what a person just declined.
  const rejected = await carryOutDisposition(fs, { receipt: await held(), disposition: "reject", by: "owner" });
  assert.equal(rejected.published, false);
  assert.equal(rejected.held_bytes_retained, true);
  assert.equal((await readFile(quarantinePath)).length, 64);

  // Restore publishes the held bytes unchanged, through the same verified
  // write as anything else.
  const restored = await carryOutDisposition(fs, {
    receipt: await held(),
    disposition: "restore",
    by: "owner",
    artifactRoot,
  });
  assert.equal(restored.phase, "written");
  assert.equal(restored.published, true);
  assert.equal((await readFile(destination)).length, 64);
  assert.equal(restored.from_disposition, "restore");
  assert.ok(root);
});

test("a transform names the bytes it publishes, and they are verified like any others", async (t) => {
  const { artifactRoot, quarantinePath } = await workspace(t);
  const destination = path.join(artifactRoot, "held.json");
  const receipt = await verifiedWrite(fs, {
    destination,
    bytes: Buffer.from("y".repeat(64)),
    artifactRoot,
    policy: { max_bytes: 16 },
    klass: "evidence",
    operationId: "op-1",
    quarantinePath,
  });
  await assert.rejects(
    () => carryOutDisposition(fs, { receipt, disposition: "transform", by: "owner", artifactRoot }),
    code("write_destination_invalid"),
  );
  const transformed = await carryOutDisposition(fs, {
    receipt,
    disposition: "transform",
    by: "owner",
    transformedBytes: "redacted\n",
    artifactRoot,
  });
  assert.equal(transformed.phase, "written");
  assert.equal(await readFile(destination, "utf8"), "redacted\n");
  // The held bytes are still there: the transform published different ones, it
  // did not replace what was quarantined.
  assert.equal((await readFile(quarantinePath)).length, 64);
});

test("a receipt that was never quarantined takes no disposition", async (t) => {
  const { root, artifactRoot } = await workspace(t);
  const written = await verifiedWrite(fs, {
    destination: path.join(artifactRoot, "ok.md"),
    bytes: Buffer.from("a\n"),
    artifactRoot,
    klass: "brief",
    operationId: "op-1",
    quarantinePath: path.join(root, "quarantine", "held.md"),
  });
  await assert.rejects(
    () => carryOutDisposition(fs, { receipt: written, disposition: "restore", by: "owner", artifactRoot }),
    code("write_destination_invalid"),
  );
  // And `pending` is not a disposition somebody made.
  const quarantined = await verifiedWrite(fs, {
    destination: path.join(artifactRoot, "big.json"),
    bytes: Buffer.from("z".repeat(64)),
    artifactRoot,
    policy: { max_bytes: 16 },
    klass: "evidence",
    operationId: "op-1",
    quarantinePath: path.join(root, "quarantine", "big.json"),
  });
  await assert.rejects(
    () => carryOutDisposition(fs, { receipt: quarantined, disposition: "pending", by: "owner", artifactRoot }),
    code("write_destination_invalid"),
  );
  await assert.rejects(
    () => carryOutDisposition(fs, { receipt: quarantined, disposition: "restore", by: "", artifactRoot }),
    code("write_destination_invalid"),
  );
});
