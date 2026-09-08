/**
 * Tests for sweeping a real evidence root (issue #27 driver).
 *
 * The retention rules say what may be deleted. What matters here is the order:
 * a sweep that builds its inventory while deleting will delete something a
 * record it has not read yet still points at.
 */

import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { referenceInventory, sweep, walkEvidence } from "../src/host/evidence-sweeper.mjs";

const code = (name) => (error) => error.code === name;
const NOW = Date.parse("2026-09-09T10:00:00Z");

const fs = {
  readdir: (dir) => readdir(dir),
  readFile: (file) => readFile(file),
  rm: (file) => rm(file),
  lstat: async (target) => {
    const stat = await lstat(target);
    return {
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
      size: stat.size,
    };
  },
};

async function evidenceRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "autosk-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = path.join(root, "evidence");
  await mkdir(path.join(evidence, "T-1"), { recursive: true });
  await mkdir(path.join(evidence, "T-2"), { recursive: true });
  await writeFile(path.join(evidence, "T-1", "verdict.json"), "{}\n");
  await writeFile(path.join(evidence, "T-1", "run.log"), "noise\n");
  await writeFile(path.join(evidence, "T-2", "screenshot.png"), "png\n");
  return { root, evidence };
}

const records = [
  { evidence_id: "T-1/verdict.json", class: "verdict", hash: "a".repeat(64) },
  { evidence_id: "T-1/run.log", class: "temporary_log", hash: "b".repeat(64), expires_at: "2026-09-01T00:00:00Z" },
  { evidence_id: "T-2/screenshot.png", class: "screenshot", hash: "c".repeat(64), expires_at: "2026-09-01T00:00:00Z" },
];

test("the walk reports every file under the root, with its id", async (t) => {
  const { evidence } = await evidenceRoot(t);
  const walked = await walkEvidence(fs, evidence);
  assert.deepEqual(walked.map((entry) => entry.evidence_id), [
    "T-1/run.log",
    "T-1/verdict.json",
    "T-2/screenshot.png",
  ]);
  assert.deepEqual([...(await walkEvidence(fs, path.join(evidence, "nope")))], []);
});

test("the inventory is complete before anything is planned", async (t) => {
  const { root, evidence } = await evidenceRoot(t);
  const referring = path.join(root, "records.json");
  await writeFile(referring, JSON.stringify({ cites: ["evidence/T-1/verdict.json"] }));
  const inventory = await referenceInventory(fs, { referringFiles: [referring] });
  assert.equal(inventory.count, 1);
  assert.ok(inventory.references.has("T-1/verdict.json"));

  // A referring record nobody could read leaves the inventory incomplete, and
  // an incomplete inventory may not clear anything for deletion.
  await assert.rejects(
    () => referenceInventory(fs, { referringFiles: [referring, path.join(root, "gone.json")] }),
    code("evidence_referenced_deletion"),
  );
  assert.ok(evidence);
});

test("a sweep is a dry run unless it is told otherwise", async (t) => {
  const { root, evidence } = await evidenceRoot(t);
  const referring = path.join(root, "records.json");
  await writeFile(referring, "{}");
  const report = await sweep(fs, {
    root: evidence,
    records,
    referringFiles: [referring],
    nowMs: NOW,
    actor: "sweeper",
    operationId: "op-1",
  });
  assert.equal(report.dry_run, true);
  assert.deepEqual([...report.deleted], []);
  // Expired transient evidence is planned; the durable verdict is not.
  assert.deepEqual([...report.plan.delete], ["T-1/run.log", "T-2/screenshot.png"]);
  assert.ok(report.plan.keep.some((entry) => entry.evidence_id === "T-1/verdict.json"));
  // And everything is still on disk.
  assert.equal((await walkEvidence(fs, evidence)).length, 3);
  assert.equal(report.walked, 3);
});

test("referenced evidence is not deleted, whatever its class says", async (t) => {
  const { root, evidence } = await evidenceRoot(t);
  const referring = path.join(root, "records.json");
  await writeFile(referring, JSON.stringify({ cites: ["evidence/T-1/run.log"] }));
  const report = await sweep(fs, {
    root: evidence,
    records,
    referringFiles: [referring],
    nowMs: NOW,
    actor: "sweeper",
    operationId: "op-1",
    dryRun: false,
  });
  assert.deepEqual([...report.deleted], ["T-2/screenshot.png"]);
  assert.ok(report.plan.keep.some((entry) => entry.evidence_id === "T-1/run.log" && entry.reason === "referenced"));
  assert.equal(await readFile(path.join(evidence, "T-1", "run.log"), "utf8"), "noise\n");
  await assert.rejects(() => readFile(path.join(evidence, "T-2", "screenshot.png")));
});

test("every deletion leaves a tombstone that says who, why and which operation", async (t) => {
  const { root, evidence } = await evidenceRoot(t);
  await writeFile(path.join(root, "records.json"), "{}");
  const report = await sweep(fs, {
    root: evidence,
    records,
    referringFiles: [path.join(root, "records.json")],
    nowMs: NOW,
    actor: "sweeper",
    operationId: "op-1",
    dryRun: false,
  });
  assert.equal(report.tombstones.length, 2);
  for (const tombstone of report.tombstones) {
    assert.equal(tombstone.actor, "sweeper");
    assert.equal(tombstone.operation_id, "op-1");
    assert.equal(tombstone.deleted_at, new Date(NOW).toISOString());
    assert.ok(/^retention: expirable$/u.test(tombstone.reason), tombstone.reason);
    assert.ok(tombstone.hash);
  }
});

test("a symlink in the evidence root is not deleted as if it were the evidence", async (t) => {
  const { root, evidence } = await evidenceRoot(t);
  const target = path.join(root, "elsewhere.log");
  await writeFile(target, "somebody else's bytes\n");
  await rm(path.join(evidence, "T-1", "run.log"));
  await symlink(target, path.join(evidence, "T-1", "run.log"));
  await writeFile(path.join(root, "records.json"), "{}");

  await assert.rejects(
    () => sweep(fs, {
      root: evidence,
      records,
      referringFiles: [path.join(root, "records.json")],
      nowMs: NOW,
      actor: "sweeper",
      operationId: "op-1",
      dryRun: false,
    }),
    code("evidence_referenced_deletion"),
  );
  // Deleting the link is not deleting what it names, and the bytes are still
  // there.
  assert.equal(await readFile(target, "utf8"), "somebody else's bytes\n");
});

test("the sweep reports what it found that nobody recorded, and what it could not find", async (t) => {
  const { root, evidence } = await evidenceRoot(t);
  await writeFile(path.join(evidence, "T-2", "stray.log"), "nobody recorded this\n");
  await writeFile(path.join(root, "records.json"), "{}");
  const report = await sweep(fs, {
    root: evidence,
    records: [...records, { evidence_id: "T-9/gone.json", class: "verdict", hash: "d".repeat(64) }],
    referringFiles: [path.join(root, "records.json")],
    nowMs: NOW,
    actor: "sweeper",
    operationId: "op-1",
  });
  // Deleting what is already gone would hide that something else removed it.
  assert.deepEqual([...report.missing], ["T-9/gone.json"]);
  assert.deepEqual([...report.orphans], ["T-2/stray.log"]);
  assert.ok(!report.plan.delete.includes("T-9/gone.json"));
  assert.ok(!report.plan.delete.includes("T-2/stray.log"));
});

test("evidence that is already gone is reported, never planned for deletion", async (t) => {
  const { root, evidence } = await evidenceRoot(t);
  await writeFile(path.join(root, "records.json"), "{}");
  // Expired and deletable by class, but something else removed it first.
  // Planning it would hide that, and deleting it would fail on a path that is
  // not there.
  await rm(path.join(evidence, "T-1", "run.log"));
  const report = await sweep(fs, {
    root: evidence,
    records,
    referringFiles: [path.join(root, "records.json")],
    nowMs: NOW,
    actor: "sweeper",
    operationId: "op-1",
    dryRun: false,
  });
  assert.deepEqual([...report.missing], ["T-1/run.log"]);
  assert.ok(!report.plan.delete.includes("T-1/run.log"));
  assert.deepEqual([...report.deleted], ["T-2/screenshot.png"]);
});

test("an unverified harness restore keeps its evidence, expired or not", async (t) => {
  const { root, evidence } = await evidenceRoot(t);
  await writeFile(path.join(evidence, "T-1", "harness.mjs"), "throwaway\n");
  await writeFile(path.join(root, "records.json"), "{}");
  const harness = {
    evidence_id: "T-1/harness.mjs",
    class: "temporary_harness_source",
    hash: "e".repeat(64),
    expires_at: "2026-09-01T00:00:00Z",
  };
  const held = await sweep(fs, {
    root: evidence,
    records: [harness],
    referringFiles: [path.join(root, "records.json")],
    nowMs: NOW,
    actor: "sweeper",
    operationId: "op-1",
  });
  assert.ok(held.plan.keep.some((entry) => entry.reason === "restore_unverified"));
  const cleared = await sweep(fs, {
    root: evidence,
    records: [{ ...harness, restore_verified: true, restore_receipt_id: "r-1" }],
    referringFiles: [path.join(root, "records.json")],
    nowMs: NOW,
    actor: "sweeper",
    operationId: "op-1",
  });
  assert.deepEqual([...cleared.plan.delete], ["T-1/harness.mjs"]);
});
