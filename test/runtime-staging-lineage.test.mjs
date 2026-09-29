/**
 * Tests for staging lineage and receipt storage (issues #8 and #9).
 *
 * A staging ref at a commit says nothing about how it arrived. These are the
 * two questions that make it say something: which deltas produced it, and
 * whether the receipts recording that are the ones that were written.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import * as lineageModule from "../src/host/staging-lineage.mjs";
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
  open: (file, flags, mode) => open(file, flags, mode),
  link: (from, to) => link(from, to),
  unlink: (file) => unlink(file),
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
  assert.deepEqual(Object.keys(lineage).sort(), ["appendReceipt", "lineageFor", "loadReceipts", "receiptDigest", "recipeJournal"]);
});

// --- debt 12g: the apply recipe's journal, a file per apply key (review M1, N1-N3, N10) -------------------

const recipe = (key, overrides = {}) => ({
  schema: 1,
  apply_key: key,
  operation_id: "op-1",
  delta_digest: "d".repeat(64),
  ref: `refs/autosk/epics/${"a".repeat(64)}/staging`,
  base_commit_oid: oid("a"),
  base_tree_oid: oid("b"),
  tree_oid: oid("c"),
  message: "T-1",
  author: { name: "autosk flow", email: "flow@autosk.invalid", date: "1700000000 +0000" },
  commit_object_bytes_base64: Buffer.from("tree x\n").toString("base64"),
  expected_commit_oid: oid("e"),
  owner_operation_id: "5b0f4d1e-9c3a-4e7b-8a21-6d0c7e9f1a35",
  request_id: "c1d2e3f4-a5b6-4c7d-9e8f-0a1b2c3d4e5f",
  reflog_before: 0,
  reflog_head: "f".repeat(64),
  ...overrides,
});
const key = (name) => name.repeat(64).slice(0, 64);
/** The journal under test: one directory, one file per key. */
const journalAt = (fileSystem, directory) => lineageModule.recipeJournal(fileSystem, { directory });
async function journalDir(t) {
  const directory = path.join(path.dirname(await logFile(t)), "recipes");
  await mkdir(directory, { recursive: true });
  return directory;
}
const recipeFiles = async (directory) => (await readdir(directory)).filter((name) => name.endsWith(".recipe")).sort();
const pending = async (directory) => (await readdir(directory)).filter((name) => name.endsWith(".pending")).sort();
const problem = async (promise) => promise.then(() => null, (thrown) => thrown);

test("the recipe journal holds a recipe per key, durably, and reads back what was written", async (t) => {
  const directory = await journalDir(t);
  const journal = journalAt(fs, directory);
  assert.equal(await journal.load(key("1")), null, "nothing recorded yet");
  const first = recipe(key("1"));
  await journal.save(first);
  await journal.save(recipe(key("2"), { expected_commit_oid: oid("f") }));
  // A new journal over the same directory — the process after a crash — reads both.
  const after = journalAt(fs, directory);
  const loaded = await after.load(key("1"));
  assert.deepEqual({ ...loaded, recipe_digest: undefined }, { ...first, recipe_digest: undefined });
  assert.match(loaded.recipe_digest, /^[0-9a-f]{64}$/u);
  assert.equal((await after.load(key("2"))).expected_commit_oid, oid("f"));
  assert.equal(await after.load(key("3")), null);
  assert.equal(Object.isFrozen(loaded), true);
  assert.deepEqual(await recipeFiles(directory), [`${key("1")}.recipe`, `${key("2")}.recipe`]);
  assert.deepEqual(await pending(directory), [], "a finished save left its temporary file");
});

test("a recipe is written once: the same again is a no-op, another under the same key is refused", async (t) => {
  const directory = await journalDir(t);
  const journal = journalAt(fs, directory);
  await journal.save(recipe(key("1")));
  await journal.save(recipe(key("1")));
  assert.equal((await recipeFiles(directory)).length, 1);
  for (const other of [{ expected_commit_oid: oid("9") }, { message: "other" }]) {
    const error = await problem(journal.save(recipe(key("1"), other)));
    assert.equal(error?.code, "receipt_missing");
    assert.equal(error.details.cause, "journal");
  }
  assert.equal((await journal.load(key("1"))).message, "T-1");
  assert.deepEqual(await pending(directory), []);
});

test("a save writes a temporary file exclusively, syncs it, links it to its name, and syncs the directory, every time (review N10)", async (t) => {
  const directory = await journalDir(t);
  const events = [];
  const spying = {
    ...fs,
    link: async (from, to) => { events.push(`link ${path.basename(to)}`); return link(from, to); },
    unlink: async (target) => { events.push(`unlink ${path.basename(target).endsWith(".pending") ? "pending" : "other"}`); return unlink(target); },
    open: async (target, flags, mode) => {
      const handle = await open(target, flags, mode);
      const name = target === directory ? "directory" : "file";
      events.push(`open ${name} ${flags}`);
      return new Proxy(handle, {
        get(inner, property) {
          const value = inner[property];
          if (typeof value !== "function") return value;
          return (...args) => {
            if (["write", "sync", "close"].includes(property)) events.push(`${property} ${name}`);
            return value.apply(inner, args);
          };
        },
      });
    },
  };
  const journal = journalAt(spying, directory);
  await journal.save(recipe(key("1")));
  assert.deepEqual(events, [
    "open file wx", "write file", "sync file", "close file", `link ${key("1")}.recipe`, "unlink pending",
    "open directory r", "sync directory", "close directory",
  ]);
  // Not only for the save that created the directory's first file: the second is as durable, and so is a save that lost the race.
  events.length = 0;
  await journal.save(recipe(key("2")));
  assert.ok(events.includes("sync directory"), "a later save left its name undurable");
  events.length = 0;
  await journal.save(recipe(key("2")));
  // A repeat writes nothing, and it does not vouch for the directory it found: the name it read may be another save's,
  // linked and not yet durable (review F2), so it opens the directory to sync it, and opens no file.
  assert.deepEqual(events.filter((entry) => entry.startsWith("open")), ["open directory r"], "a repeat of a saved recipe opened a file, or did not sync the directory");
  assert.ok(events.includes("sync directory"));
  assert.equal(events.some((entry) => entry.startsWith("link") || entry.startsWith("write")), false);
});

test("a recipe found on disk is made durable before it is relied on: load and a repeated save sync the directory, and a sync that fails is a failure (review F2)", async (t) => {
  const directory = await journalDir(t);
  const syncs = [];
  const spying = {
    ...fs,
    open: async (target, flags, mode) => {
      const handle = await open(target, flags, mode);
      if (target !== directory) return handle;
      return new Proxy(handle, {
        get(inner, property) {
          if (property === "sync") return async () => { syncs.push(path.basename(target)); return inner.sync(); };
          const value = inner[property];
          return typeof value === "function" ? value.bind(inner) : value;
        },
      });
    },
  };
  const journal = journalAt(spying, directory);
  // Nothing on disk: nothing is relied on, so there is nothing to make durable.
  assert.equal(await journal.load(key("1")), null);
  assert.equal(syncs.length, 0, "an absent recipe synced the directory");
  // A recipe another process saved, whose save died before its directory sync: the name is there and may not be durable.
  await journalAt(fs, directory).save(recipe(key("1")));
  syncs.length = 0;
  assert.equal((await journal.load(key("1"))).apply_key, key("1"));
  assert.equal(syncs.length, 1, "a recipe was handed out before its directory was synced");
  syncs.length = 0;
  await journal.save(recipe(key("1")));
  assert.equal(syncs.length, 1, "a repeated save returned before its directory was synced");
  // The sync itself failing (EIO) is the failure of the read and of the repeat: the recipe is not vouched for.
  const failing = {
    ...fs,
    open: async (target, flags, mode) => {
      if (target === directory) throw Object.assign(new Error("EIO: the directory cannot be made durable"), { code: "EIO" });
      return open(target, flags, mode);
    },
  };
  for (const attempt of [() => journalAt(failing, directory).load(key("1")), () => journalAt(failing, directory).save(recipe(key("1")))]) {
    const error = await problem(attempt());
    assert.equal(error?.code, "environment_failure");
    assert.equal(error.details.cause, "journal_io");
    assert.equal(error.details.errno, "EIO");
  }
  // A key that has no recipe is not made to fail by it.
  assert.equal(await journalAt(failing, directory).load(key("2")), null);
});

test("a quarantined key refuses by name, whether or not its file is still there, and no other key is stopped (review F3)", async (t) => {
  const directory = await journalDir(t);
  const journal = journalAt(fs, directory);
  await journal.save(recipe(key("1")));
  await journal.save(recipe(key("2")));
  // The person's step: the recipe that could not vouch is moved aside, under its own name and a suffix.
  await rename(path.join(directory, `${key("1")}.recipe`), path.join(directory, `${key("1")}.recipe.quarantined`));
  for (const attempt of [() => journalAt(fs, directory).load(key("1")), () => journalAt(fs, directory).save(recipe(key("1")))]) {
    const error = await problem(attempt());
    assert.equal(error?.code, "receipt_missing");
    assert.equal(error.details.cause, "journal");
    assert.equal(error.details.apply_key, key("1"));
    assert.equal(error.details.detail, "the recipe of this apply was quarantined: a fresh operation re-applies it");
  }
  assert.deepEqual(await recipeFiles(directory), [`${key("2")}.recipe`], "a refused save wrote a recipe under a quarantined key");
  assert.deepEqual(await pending(directory), []);
  // Another key, and a key saved after, are as before.
  assert.equal((await journalAt(fs, directory).load(key("2"))).apply_key, key("2"));
  await journalAt(fs, directory).save(recipe(key("3")));
  assert.equal((await journalAt(fs, directory).load(key("3"))).apply_key, key("3"));
  // The marker is what refuses: a recipe file put back beside it does not lift it.
  await writeFile(path.join(directory, `${key("1")}.recipe`), await readFile(path.join(directory, `${key("2")}.recipe`)));
  assert.equal((await problem(journalAt(fs, directory).load(key("1"))))?.code, "receipt_missing");
  // A marker that cannot be read for a reason other than its absence is an environment failure, and no recipe is handed out.
  const unreadable = { ...fs, readFile: async (target) => { if (String(target).endsWith(".quarantined")) throw Object.assign(new Error("EACCES: no"), { code: "EACCES" }); return readFile(target); } };
  const error = await problem(journalAt(unreadable, directory).load(key("2")));
  assert.equal(error?.code, "environment_failure");
  assert.equal(error.details.errno, "EACCES");
});

test("a save that dies before its name exists leaves no recipe, and after it leaves a whole one (review N1)", async (t) => {
  const died = () => new Error("SIGKILL");
  for (const at of ["write", "sync", "link", "afterLink"]) {
    const directory = await journalDir(t);
    const dying = {
      ...fs,
      link: async (from, to) => {
        if (at === "link") throw died();
        await link(from, to);
        if (at === "afterLink") throw died();
      },
      open: async (target, flags, mode) => {
        const handle = await open(target, flags, mode);
        return new Proxy(handle, {
          get(inner, property) {
            if (property === "write" && at === "write") return async (buffer, offset = 0, length = buffer.length - offset) => { await inner.write(buffer, offset, Math.floor(length / 2)); throw died(); };
            if (property === "sync" && at === "sync" && target !== directory) return async () => { throw died(); };
            const value = inner[property];
            return typeof value === "function" ? value.bind(inner) : value;
          },
        });
      },
    };
    await assert.rejects(() => journalAt(dying, directory).save(recipe(key("1"))), /SIGKILL/u, at);
    const held = await journalAt(fs, directory).load(key("1"));
    assert.equal(held === null, at !== "afterLink", `${at}: a recipe is either absent or whole`);
    if (held !== null) assert.equal(held.message, "T-1");
    // Whatever the crash left, the same recipe is saved after it, and other keys were never in its way.
    await journalAt(fs, directory).save(recipe(key("1")));
    await journalAt(fs, directory).save(recipe(key("2")));
    assert.deepEqual(await recipeFiles(directory), [`${key("1")}.recipe`, `${key("2")}.recipe`], at);
  }
});

test("what a crash leaves behind is a temporary file no read looks at, and only its age says it is abandoned (review F-e)", async (t) => {
  const directory = await journalDir(t);
  // A live save's temporary file has the very shape of a leftover: the name cannot tell them apart, so nothing here removes one.
  const seen = [];
  const watching = { ...fs, open: async (target, flags, mode) => { if (flags === "wx") seen.push(path.basename(target)); return open(target, flags, mode); } };
  await journalAt(watching, directory).save(recipe(key("9")));
  assert.equal(seen.length, 1);
  assert.match(seen[0], new RegExp(`^\\.${key("9")}\\.[0-9a-f]{16}\\.pending$`, "u"));
  assert.match(`.${key("1")}.0123456789abcdef.pending`, new RegExp(`^\\.${key("1")}\\.[0-9a-f]{16}\\.pending$`, "u"));
  await writeFile(path.join(directory, `.${key("1")}.0123456789abcdef.pending`), "{half a rec");
  const journal = journalAt(fs, directory);
  assert.equal(await journal.load(key("1")), null, "a temporary file was read as a recipe");
  await journal.save(recipe(key("1")));
  assert.equal((await journal.load(key("1"))).apply_key, key("1"));
  assert.deepEqual(await pending(directory), [`.${key("1")}.0123456789abcdef.pending`], "another save's temporary file was touched");
});

test("a recipe file that cannot be vouched for stops its own key and no other", async (t) => {
  const directory = await journalDir(t);
  const journal = journalAt(fs, directory);
  await journal.save(recipe(key("1")));
  await journal.save(recipe(key("2")));
  const target = path.join(directory, `${key("1")}.recipe`);
  const text = await readFile(target, "utf8");
  const cases = [
    ["an edited value", text.replace('"message":"T-1"', '"message":"T-9"'), "a line is not the one that was written"],
    ["not JSON", "{not json}\n", "a line is not a record"],
    ["empty", "", "a line is not a record"],
    ["a scalar", "7\n", "a line is not a record"],
    ["another key's recipe", text.replace(key("1"), key("3")), "a line is not the one that was written"],
    ["a truncated file", text.slice(0, 40), "a line is not a record"],
  ];
  for (const [label, content, detail] of cases) {
    await writeFile(target, content);
    const error = await problem(journalAt(fs, directory).load(key("1")));
    assert.equal(error?.code, "receipt_missing", label);
    assert.equal(error.details.cause, "journal", label);
    assert.equal(error.details.detail, detail, label);
    // Saving over it is refused too, and the other key is untouched.
    assert.equal((await problem(journalAt(fs, directory).save(recipe(key("1")))))?.code, "receipt_missing", label);
    assert.equal((await journalAt(fs, directory).load(key("2"))).apply_key, key("2"), label);
  }
  // A recipe whose digest is right but whose key is another's is another key's recipe under this name.
  const stolen = JSON.stringify({ ...JSON.parse(text), apply_key: key("3") });
  await writeFile(target, `${stolen}\n`);
  assert.equal((await problem(journalAt(fs, directory).load(key("1"))))?.code, "receipt_missing");
});

test("saves made at once are all kept: many keys, and one key from two savers", async (t) => {
  const directory = await journalDir(t);
  const one = journalAt(fs, directory);
  const two = journalAt(fs, directory);
  const keys = Array.from({ length: 12 }, (_, index) => key(index.toString(16)));
  await Promise.all(keys.map((wanted, index) => (index % 2 === 0 ? one : two).save(recipe(wanted, { expected_commit_oid: oid((index % 10).toString()) }))));
  for (const wanted of keys) assert.equal((await journalAt(fs, directory).load(wanted))?.apply_key, wanted, wanted);
  assert.equal((await recipeFiles(directory)).length, keys.length);
  assert.deepEqual(await pending(directory), []);
  // One key from two savers: the same recipe twice is one file, and two that disagree are one file and one refusal.
  const both = await Promise.all([one.save(recipe(key("c"))), two.save(recipe(key("c")))]);
  assert.deepEqual(both, [undefined, undefined]);
  const raced = await Promise.all([one.save(recipe(key("d"), { message: "first" })), two.save(recipe(key("d"), { message: "second" }))].map(problem));
  assert.equal(raced.filter((error) => error === null).length, 1, "both disagreeing savers returned");
  assert.equal(raced.find((error) => error !== null).code, "receipt_missing");
  const kept = await journalAt(fs, directory).load(key("d"));
  assert.ok(["first", "second"].includes(kept.message));
  assert.deepEqual(await pending(directory), []);
});

test("a journal that cannot write or read is an environment failure with its errno, and leaves nothing half done (review N3)", async (t) => {
  for (const [what, errno] of [["write", "ENOSPC"], ["write", "EDQUOT"], ["read", "EACCES"], ["open", "EMFILE"], ["link", "EPERM"], ["mkdirless", "ENOENT"]]) {
    const directory = await journalDir(t);
    const error = () => Object.assign(new Error(`${errno}: no`), { code: errno });
    const failing = {
      ...fs,
      readFile: async (target) => { if (what === "read") throw error(); return readFile(target); },
      link: async (from, to) => { if (what === "link") throw error(); return link(from, to); },
      open: async (target, flags, mode) => {
        if (what === "open" && flags === "wx") throw error();
        const handle = await open(what === "mkdirless" ? path.join(directory, "absent", path.basename(target)) : target, flags, mode);
        return new Proxy(handle, {
          get(inner, property) {
            if (property === "write" && what === "write") return async () => { throw error(); };
            const value = inner[property];
            return typeof value === "function" ? value.bind(inner) : value;
          },
        });
      },
    };
    const raised = await problem(journalAt(failing, directory).save(recipe(key("1"))));
    assert.equal(raised?.code, "environment_failure", `${what} ${errno}`);
    assert.equal(raised.details.cause, "journal_io", `${what} ${errno}`);
    assert.equal(raised.details.errno, errno, `${what} ${errno}`);
    assert.deepEqual(await recipeFiles(directory), [], `${what} ${errno}: a recipe was left half saved`);
    assert.deepEqual(await pending(directory), [], `${what} ${errno}: the temporary file was left behind`);
    // The load of a failing read is the same failure; and once the disk answers, the same save succeeds.
    if (what === "read") assert.equal((await problem(journalAt(failing, directory).load(key("1"))))?.code, "environment_failure");
    await journalAt(fs, directory).save(recipe(key("1")));
    assert.equal((await journalAt(fs, directory).load(key("1"))).apply_key, key("1"));
  }
});

test("a write that takes the line in pieces is finished, and one that makes no progress is an environment failure (review N3)", async (t) => {
  const directory = await journalDir(t);
  const pieces = {
    ...fs,
    open: async (target, flags, mode) => {
      const handle = await open(target, flags, mode);
      return new Proxy(handle, {
        get(inner, property) {
          if (property === "write") return (buffer, offset = 0, length = buffer.length - offset) => inner.write(buffer, offset, Math.min(length, 7));
          const value = inner[property];
          return typeof value === "function" ? value.bind(inner) : value;
        },
      });
    },
  };
  await journalAt(pieces, directory).save(recipe(key("1")));
  assert.equal((await journalAt(fs, directory).load(key("1"))).message, "T-1");
  let stalls = 0;
  const stalled = {
    ...fs,
    open: async (target, flags, mode) => {
      const handle = await open(target, flags, mode);
      return new Proxy(handle, {
        get(inner, property) {
          // Only the first call stalls; a journal that goes on after a write that made no progress would finish the line here and not loop for ever.
          if (property === "write") return async (...args) => (stalls++ === 0 ? { bytesWritten: 0 } : inner.write(...args));
          const value = inner[property];
          return typeof value === "function" ? value.bind(inner) : value;
        },
      });
    },
  };
  const error = await problem(journalAt(stalled, directory).save(recipe(key("2"))));
  assert.equal(error?.code, "environment_failure");
  assert.equal(error.details.cause, "journal_io");
  assert.equal(stalls, 1, "the journal wrote again after a write that made no progress");
  assert.deepEqual(await recipeFiles(directory), [`${key("1")}.recipe`]);
  assert.deepEqual(await pending(directory), []);
});

test("the directory made durable is the journal's own, and a platform that will not sync it is no durable journal (#280 carry C)", async (t) => {
  for (const directory of ["/", "/some/where", "relative/dir", "."]) {
    const opened = [];
    const fake = {
      readFile: async () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); },
      open: async (name, flags) => {
        opened.push(`${name}:${flags}`);
        return { write: async (buffer, offset, length) => ({ bytesWritten: length }), sync: async () => {}, close: async () => {} };
      },
      link: async () => {},
      unlink: async () => {},
    };
    await lineageModule.recipeJournal(fake, { directory }).save(recipe(key("1")));
    assert.equal(opened.at(-1), `${directory}:r`, directory);
  }
  const refusing = (errno) => ({
    readFile: async () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); },
    open: async (name) => {
      if (name === "/d") throw Object.assign(new Error("no"), { code: errno });
      return { write: async (buffer, offset, length) => ({ bytesWritten: length }), sync: async () => {}, close: async () => {} };
    },
    link: async () => {},
    unlink: async () => {},
  });
  // A refused directory sync is not durability, whatever the errno: the journal says the entry may be lost, and the apply stops.
  for (const errno of ["EISDIR", "EPERM", "EINVAL", "ENOTSUP"]) {
    const refused = await problem(lineageModule.recipeJournal(refusing(errno), { directory: "/d" }).save(recipe(key("1"))));
    assert.equal(refused?.code, "environment_failure", errno);
    assert.equal(refused.details.cause, "journal_io", errno);
    assert.equal(refused.details.errno, errno);
  }
  const failed = await problem(lineageModule.recipeJournal(refusing("EIO"), { directory: "/d" }).save(recipe(key("1"))));
  assert.equal(failed?.code, "environment_failure");
  assert.equal(failed.details.errno, "EIO");
});

test("a recipe names a key that is a file name, or it is no recipe", async (t) => {
  const directory = await journalDir(t);
  const journal = journalAt(fs, directory);
  for (const bad of ["", "../x", "a".repeat(63), "A".repeat(64), `${"a".repeat(63)}/`, undefined, 7]) {
    await assert.rejects(() => journal.save(recipe(bad)), (error) => error.code === "invalid_record", String(bad));
    await assert.rejects(() => journal.load(bad), (error) => error.code === "invalid_record", String(bad));
  }
  assert.deepEqual(await readdir(directory), []);
});

test("a directory whose sync is refused leaves no recipe relied on: a save and a load both fail, at the open and at the sync (#280 carry C)", async (t) => {
  const directory = await journalDir(t);
  const honest = journalAt(fs, directory);
  await honest.save(recipe(key("1")));
  for (const errno of ["EISDIR", "EPERM", "EINVAL", "ENOTSUP"]) {
    for (const at of ["open", "sync"]) {
      const refusing = {
        ...fs,
        open: async (file, flags, mode) => {
          const error = Object.assign(new Error(`${errno} on the directory`), { code: errno });
          if (file === directory && at === "open") throw error;
          const handle = await fs.open(file, flags, mode);
          if (file !== directory) return handle;
          return new Proxy(handle, { get(target, name) {
            if (name === "sync") return async () => { throw error; };
            const value = target[name];
            return typeof value === "function" ? value.bind(target) : value;
          } });
        },
      };
      const journal = journalAt(refusing, directory);
      const loaded = await problem(journal.load(key("1")));
      assert.equal(loaded?.code, "environment_failure", `load ${errno} ${at}`);
      assert.equal(loaded.details.cause, "journal_io");
      assert.equal(loaded.details.errno, errno);
      const saved = await problem(journal.save(recipe(key("2"))));
      assert.equal(saved?.code, "environment_failure", `save ${errno} ${at}`);
      assert.equal(saved.details.errno, errno);
    }
  }
});

test("a receipt log that cannot be read is an environment failure, and a transient read error never rewrites the log as one line (P3)", async (t) => {
  const file = await logFile(t);
  const directory = path.dirname(file);
  await appendReceipt(fs, { path: file, receipt: receipt(oid("a"), oid("b")) });
  await appendReceipt(fs, { path: file, receipt: receipt(oid("b"), oid("c")), previous: null });
  const before = (await fs.readFile(file)).toString("utf8");
  for (const errno of ["EIO", "EACCES", "EMFILE"]) {
    let wrote = 0;
    const flaky = {
      readFile: async () => { throw Object.assign(new Error(`${errno}: transient`), { code: errno }); },
      writeFile: async (...rest) => { wrote += 1; return fs.writeFile(...rest); },
    };
    const appended = await problem(appendReceipt(flaky, { path: file, receipt: receipt(oid("c"), oid("d")) }));
    assert.equal(appended?.code, "environment_failure", errno);
    assert.equal(appended.details.cause, "journal_io", errno);
    assert.equal(appended.details.errno, errno, errno);
    assert.equal(wrote, 0, `${errno}: the log was written after a failed read`);
    const loaded = await problem(loadReceipts(flaky, { path: file }));
    assert.equal(loaded?.code, "environment_failure", errno);
    assert.equal(loaded.details.errno, errno);
  }
  assert.equal((await fs.readFile(file)).toString("utf8"), before);
  // A log that is not there is empty: the first receipt creates it.
  const missing = path.join(directory, "nothing.log");
  assert.deepEqual([...(await loadReceipts(fs, { path: missing })).receipts], []);
  await appendReceipt(fs, { path: missing, receipt: receipt(oid("a"), oid("b")) });
  assert.equal((await loadReceipts(fs, { path: missing })).receipts.length, 1);
});

test("a receipt log that cannot be read says so by message and errno, and a failure with no errno has none (P3)", async (t) => {
  const file = await logFile(t);
  const failing = (error) => ({ readFile: async () => { throw error; }, writeFile: async () => {} });
  const named = await problem(loadReceipts(failing(Object.assign(new Error("disk said no"), { code: "EIO" })), { path: file }));
  assert.equal(named.message, "The receipt log could not be read: disk said no");
  assert.deepEqual(named.details, { cause: "journal_io", errno: "EIO" });
  const bare = await problem(loadReceipts(failing({}), { path: file }));
  assert.equal(bare.message, "The receipt log could not be read");
  assert.deepEqual(bare.details, { cause: "journal_io", errno: null });
});

test("a receipt log with a torn last line is refused by name, on load and on append, and a failed write is the journal's I/O (N10)", async (t) => {
  const file = await logFile(t);
  await appendReceipt(fs, { path: file, receipt: receipt(oid("a"), oid("b")) });
  const whole = (await fs.readFile(file)).toString("utf8");
  // A crash in the middle of the last line leaves a fragment with no newline.
  await writeFile(file, `${whole}{"operation_id":"op-c","base_comm`);
  const loaded = await problem(loadReceipts(fs, { path: file }));
  assert.equal(loaded?.code, "receipt_missing");
  assert.equal(loaded.details.cause, "receipt_log");
  assert.equal(loaded.details.line, 1);
  const before = (await fs.readFile(file)).toString("utf8");
  const appended = await problem(appendReceipt(fs, { path: file, receipt: receipt(oid("b"), oid("c")) }));
  assert.equal(appended?.code, "receipt_missing");
  assert.equal(appended.details.cause, "receipt_log");
  assert.equal((await fs.readFile(file)).toString("utf8"), before, "the append went onto the torn line");
  // A complete line that is not a record is refused the same way.
  await writeFile(file, `${whole}not json\n`);
  assert.equal((await problem(loadReceipts(fs, { path: file })))?.details.cause, "receipt_log");
  // A write that fails is the environment's, with the errno, not a raw error.
  await writeFile(file, whole);
  const full = { readFile: (name) => fs.readFile(name), writeFile: async () => { throw Object.assign(new Error("no space"), { code: "ENOSPC" }); } };
  const failed = await problem(appendReceipt(full, { path: file, receipt: receipt(oid("b"), oid("c")) }));
  assert.equal(failed?.code, "environment_failure");
  assert.deepEqual({ ...failed.details }, { cause: "journal_io", errno: "ENOSPC" });
  assert.equal((await fs.readFile(file)).toString("utf8"), whole);
});

test("a recipe that is not NFC is loaded as it was written (N3)", async (t) => {
  const directory = await journalDir(t);
  const journal = journalAt(fs, directory);
  const noted = { ...recipe(key("1")), message: "café", author: { name: "café", email: "flow@autosk.invalid", date: "1700000000 +0000" } };
  await journal.save(noted);
  const loaded = await journal.load(key("1"));
  assert.equal(loaded.message, "café");
  assert.equal(loaded.author.name, "café");
  assert.ok(Object.isFrozen(loaded));
  assert.ok(Object.isFrozen(loaded.author));
});
