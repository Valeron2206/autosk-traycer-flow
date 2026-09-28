/**
 * Tests for staging lineage and receipt storage (issues #8 and #9).
 *
 * A staging ref at a commit says nothing about how it arrived. These are the
 * two questions that make it say something: which deltas produced it, and
 * whether the receipts recording that are the ones that were written.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendReceipt,
  lineageFor,
  loadReceipts,
  receiptDigest,
} from "../src/host/staging-lineage.mjs";

const code = (name) => (error) => error.code === name;
const oid = (char) => char.repeat(40);

const fs = {
  readFile: (file) => readFile(file),
  writeFile: (file, text) => writeFile(file, text),
};

const receipt = (from, to, overrides = {}) => ({
  operation_id: `op-${to[0]}`,
  base_commit_oid: from,
  staging_commit_oid: to,
  staging_tree_oid: oid("t"),
  delta_digest: `d-${to[0]}`,
  phase: "ref_advanced",
  ...overrides,
});

async function logFile(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "autosk-lineage-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "receipts"), { recursive: true });
  return path.join(root, "receipts", "staging.jsonl");
}

test("the lineage is the chain of deltas that produced the head", () => {
  const chain = lineageFor(
    [receipt(oid("a"), oid("b")), receipt(oid("b"), oid("c"))],
    { base: oid("a"), head: oid("c") },
  );
  assert.equal(chain.complete, true);
  assert.equal(chain.gap_at, null);
  assert.deepEqual(chain.chain.map((link) => link.staging_commit_oid), [oid("b"), oid("c")]);
  assert.deepEqual([...chain.unused], []);
});

test("a commit nobody holds a receipt for is a gap, not a skipped step", () => {
  // An unaccounted commit on a staging ref is precisely what the aggregate is
  // about to verify.
  const chain = lineageFor([receipt(oid("a"), oid("b"))], { base: oid("a"), head: oid("z") });
  assert.equal(chain.complete, false);
  assert.equal(chain.gap_at, oid("b"));
  const orphan = lineageFor(
    [receipt(oid("a"), oid("b")), receipt(oid("x"), oid("y"))],
    { base: oid("a"), head: oid("b") },
  );
  assert.equal(orphan.complete, true);
  // A receipt that connects to nothing is named rather than counted.
  assert.deepEqual([...orphan.unused], [oid("y")]);
});

test("a lineage that loops back on itself is refused", () => {
  assert.throws(
    () => lineageFor(
      [receipt(oid("a"), oid("b")), receipt(oid("b"), oid("a"))],
      { base: oid("a"), head: oid("z") },
    ),
    code("containment_mismatch"),
  );
});

test("receipts are appended, and the log reads back as what was written", async (t) => {
  const file = await logFile(t);
  const first = await appendReceipt(fs, { path: file, receipt: receipt(oid("a"), oid("b")) });
  const second = await appendReceipt(fs, {
    path: file,
    receipt: receipt(oid("b"), oid("c")),
    previous: first.digest,
  });
  assert.equal(second.previous_digest, first.digest);

  const loaded = await loadReceipts(fs, { path: file });
  assert.equal(loaded.intact, true);
  assert.equal(loaded.receipts.length, 2);
  assert.equal(loaded.receipts[1].previous_digest, first.digest);
  // And the lineage can be built from what was read back.
  const chain = lineageFor(loaded.receipts, { base: oid("a"), head: oid("c") });
  assert.equal(chain.complete, true);
});

test("a line edited afterwards breaks the chain rather than looking original", async (t) => {
  const file = await logFile(t);
  const first = await appendReceipt(fs, { path: file, receipt: receipt(oid("a"), oid("b")) });
  await appendReceipt(fs, { path: file, receipt: receipt(oid("b"), oid("c")), previous: first.digest });

  const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
  const tampered = JSON.parse(lines[0]);
  tampered.delta_digest = "d-something-else";
  await writeFile(file, `${JSON.stringify(tampered)}\n${lines[1]}\n`);

  const loaded = await loadReceipts(fs, { path: file });
  assert.equal(loaded.intact, false);
  assert.equal(loaded.broken_at, 0);
  // The receipts are still returned: a reader that needs them can see both what
  // is there and that it is not what was written.
  assert.equal(loaded.receipts.length, 2);
});

test("an empty or absent log is intact and empty, not an error", async (t) => {
  const file = await logFile(t);
  const missing = await loadReceipts(fs, { path: file });
  assert.deepEqual([...missing.receipts], []);
  assert.equal(missing.intact, true);
  assert.equal(receiptDigest(receipt(oid("a"), oid("b"))).length, 64);
  assert.notEqual(
    receiptDigest(receipt(oid("a"), oid("b"))),
    receiptDigest(receipt(oid("a"), oid("b"), { phase: "prepared" })),
  );
});

test("the lineage module carries the chain and the receipts, and no cross-Epic rule: the one CAS serializes Epics (R7-5)", async () => {
  // Round 7 of #39, R7-5: crossEpicErrors had no caller outside its tests.
  // Its first rule refused two open Epics with one recorded base, which two
  // Epics planned from one target head always are (a first stage records
  // recorded_target_base = planning.base_oid), although its own comment said
  // they may run at once; its second named a base inside another Epic's
  // unlanded line, which a stage records only if the target held it. The one
  // CAS refuses a base that no longer describes the target
  // (foreign_target_movement), and that is the serialization (ADR-099).
  const lineage = await import("../src/host/staging-lineage.mjs");
  assert.deepEqual(Object.keys(lineage).sort(), ["appendReceipt", "lineageFor", "loadReceipts", "receiptDigest"]);
});
