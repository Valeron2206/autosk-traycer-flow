/**
 * Tests for the runtime design-input measurement.
 *
 * The mechanism stands or falls on two things, and both are exercised here:
 * the instrument must record every fs read form a validator can use — the
 * destructured `import { readFileSync } from "node:fs"` first, because it
 * binds to a snapshot of the builtin's exports — and the runner must fail
 * closed when a validator records nothing, exits nonzero, or drifts from the
 * pinned artifact.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  collectRecordedPaths,
  isCodePath,
  MEASURED_PATH,
  measuredDigest,
  reduceToInputs,
  toRepoRelative,
} from "../scripts/lib/measured-inputs.mjs";
import { measure } from "../scripts/measure-design-inputs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTRUMENT_URL = pathToFileURL(path.join(ROOT, "scripts", "lib", "design-reads-instrument.mjs")).href;
const RUNNER = path.join(ROOT, "scripts", "measure-design-inputs.mjs");

const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), "t08-measure-"));
  scratchDirs.push(dir);
  return dir;
}

/**
 * Runs `source` as an instrumented process and returns the recorded paths.
 * The probe and its data live in a scratch directory, not the repository.
 */
function runInstrumented(source, { env = {}, cwd } = {}) {
  const dir = scratch();
  const logDir = path.join(dir, "log");
  mkdirSync(logDir);
  const probe = path.join(dir, "probe.mjs");
  writeFileSync(probe, source);
  const run = spawnSync(process.execPath, ["--import", INSTRUMENT_URL, probe], {
    cwd: cwd ?? dir,
    env: { ...process.env, ...env, DESIGN_READS_LOG: logDir },
    encoding: "utf8",
  });
  return { run, recorded: collectRecordedPaths(logDir) };
}

/**
 * One instrumented probe per wrapped entry point, each with its own target.
 * That is what makes a missing wrap visible: removing any single wrap turns
 * exactly one of these tests red, because no other call records the file.
 */
function apiProbe({ files = {}, dirs = [], source, env }) {
  const dir = scratch();
  for (const name of dirs) mkdirSync(path.join(dir, name));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  return { dir, ...runInstrumented(source, { cwd: dir, env }) };
}

// The instrument records the physical form of each path — the process's
// real cwd, on-disk case and links resolved. realpathSync.native reports
// the same physical name the instrument captures (plain realpathSync keeps
// the caller's case, which is not what the log holds).
const at = (dir, ...names) => path.join(realpathSync.native(dir), ...names);

/**
 * Copy attempts land in the log as `copy\t<physical source>\t<call site>` —
 * the measurement refuses an in-repository source rather than modelling
 * what a copy copied. The instrument never rewrites the caller's arguments.
 */
const copyMarkers = (recorded) => [...recorded].filter((line) => line.startsWith("copy\t"));
const namedCopy = (recorded, physical) =>
  copyMarkers(recorded).filter((line) => line.split("\t")[1] === physical);

/**
 * Records carry the kind the API reported: `file\t<physical>` for reads,
 * `dir\t<physical>` for listings, `conflict\t<call>\t<done>` when the name
 * moved while the operation was in flight.
 */
const kindRecords = (recorded, kind) =>
  new Set(
    [...recorded]
      .filter((line) => line.startsWith(`${kind}\t`))
      .map((line) => line.slice(kind.length + 1)),
  );
const fileReads = (recorded) => kindRecords(recorded, "file");
const dirLists = (recorded) => kindRecords(recorded, "dir");
const conflictMarks = (recorded) => [...recorded].filter((line) => line.startsWith("conflict\t"));

test("a destructured ESM import of node:fs is recorded", () => {
  // The case the mechanism exists for: named imports from a builtin bind to
  // a snapshot of the CJS exports, so only a patch landed before the facade
  // links can see this read.
  const { dir, run, recorded } = apiProbe({
    files: { "destructured.txt": "x" },
    source: `import { readFileSync } from "node:fs";\nreadFileSync("destructured.txt", "utf8");\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fileReads(recorded).has(at(dir, "destructured.txt")), [...recorded].join("\n"));
});

test("default and namespace imports of node:fs are recorded", () => {
  const { dir, run, recorded } = apiProbe({
    files: { "default.txt": "x", "namespace.txt": "x" },
    source: `import fs from "node:fs";
import * as fsns from "node:fs";
fs.readFileSync("default.txt", "utf8");
fsns.readFileSync("namespace.txt", "utf8");
`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fileReads(recorded).has(at(dir, "default.txt")));
  assert.ok(fileReads(recorded).has(at(dir, "namespace.txt")));
});

test("fs.readFile (callback) is recorded", () => {
  const { dir, run, recorded } = apiProbe({
    files: { "cb-readfile.txt": "x" },
    source: `import fs from "node:fs";\nawait new Promise((resolve, reject) => fs.readFile("cb-readfile.txt", "utf8", (e) => e ? reject(e) : resolve()));\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fileReads(recorded).has(at(dir, "cb-readfile.txt")));
});

test("fs.open (callback) is recorded", () => {
  const { dir, run, recorded } = apiProbe({
    files: { "cb-open.txt": "x" },
    source: `import fs from "node:fs";\nawait new Promise((resolve, reject) => fs.open("cb-open.txt", (e, fd) => e ? reject(e) : fs.close(fd, resolve)));\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fileReads(recorded).has(at(dir, "cb-open.txt")));
});

test("fs.readdir (callback) is recorded", () => {
  const { dir, run, recorded } = apiProbe({
    dirs: ["cb-dir"],
    source: `import fs from "node:fs";\nawait new Promise((resolve, reject) => fs.readdir("cb-dir", (e) => e ? reject(e) : resolve()));\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(dirLists(recorded).has(at(dir, "cb-dir")));
});

test("fs.opendir (callback) is recorded", () => {
  const { dir, run, recorded } = apiProbe({
    dirs: ["cb-odir"],
    source: `import fs from "node:fs";\nconst d = await new Promise((resolve, reject) => fs.opendir("cb-odir", (e, r) => e ? reject(e) : resolve(r)));\nawait d.close();\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(dirLists(recorded).has(at(dir, "cb-odir")));
});

test("fs.openSync is recorded — a read through its descriptor lands at the open", () => {
  const { dir, run, recorded } = apiProbe({
    files: { "fd.txt": "x" },
    source: `import { openSync, readSync, closeSync } from "node:fs";
const fd = openSync("fd.txt");
const buffer = Buffer.alloc(1);
readSync(fd, buffer, 0, 1, 0);
closeSync(fd);
`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fileReads(recorded).has(at(dir, "fd.txt")));
});

test("fs.createReadStream is recorded", () => {
  const { dir, run, recorded } = apiProbe({
    files: { "stream.txt": "x" },
    source: `import { createReadStream } from "node:fs";\nawait new Promise((resolve, reject) => { const s = createReadStream("stream.txt"); s.on("data", () => {}); s.on("end", resolve); s.on("error", reject); });\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fileReads(recorded).has(at(dir, "stream.txt")));
});

test("fs.readdirSync is recorded", () => {
  const { dir, run, recorded } = apiProbe({
    dirs: ["sync-dir"],
    source: `import { readdirSync } from "node:fs";\nreaddirSync("sync-dir");\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(dirLists(recorded).has(at(dir, "sync-dir")));
});

test("fs.opendirSync is recorded", () => {
  const { dir, run, recorded } = apiProbe({
    dirs: ["sync-odir"],
    source: `import { opendirSync } from "node:fs";\nopendirSync("sync-odir").closeSync();\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(dirLists(recorded).has(at(dir, "sync-odir")));
});

test("fs.copyFileSync marks the copy, naming the source", () => {
  const { dir, run, recorded } = apiProbe({
    files: { "copy-src.txt": "x" },
    source: `import { copyFileSync } from "node:fs";\ncopyFileSync("copy-src.txt", "copy-dst.txt");\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(namedCopy(recorded, at(dir, "copy-src.txt")).length, 1, [...recorded].join("\n"));
});

test("fs.copyFile (callback) marks the copy, naming the source", () => {
  const { dir, run, recorded } = apiProbe({
    files: { "cbcopy-src.txt": "x" },
    source: `import fs from "node:fs";\nawait new Promise((resolve, reject) => fs.copyFile("cbcopy-src.txt", "cbcopy-dst.txt", (e) => e ? reject(e) : resolve()));\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(namedCopy(recorded, at(dir, "cbcopy-src.txt")).length, 1, [...recorded].join("\n"));
});

test("fs.cpSync on a file marks the copy, naming the source", () => {
  const { dir, run, recorded } = apiProbe({
    files: { "cps-src.txt": "x" },
    source: `import { cpSync } from "node:fs";\ncpSync("cps-src.txt", "cps-dst.txt");\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(namedCopy(recorded, at(dir, "cps-src.txt")).length >= 1, [...recorded].join("\n"));
});

test("fs.cpSync on a directory marks the copy, naming the source", () => {
  const { dir, run, recorded } = apiProbe({
    files: { "cp-src/a.txt": "x", "cp-src/deep/b.txt": "x" },
    source: `import { cpSync } from "node:fs";\ncpSync("cp-src", "cp-dst", { recursive: true });\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(namedCopy(recorded, at(dir, "cp-src")).length >= 1, [...recorded].join("\n"));
});

test("fs.cp (callback) marks the copy, naming the source", () => {
  const { dir, run, recorded } = apiProbe({
    files: { "cbcp-src.txt": "x" },
    source: `import fs from "node:fs";\nawait new Promise((resolve, reject) => fs.cp("cbcp-src.txt", "cbcp-dst.txt", (e) => e ? reject(e) : resolve()));\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(namedCopy(recorded, at(dir, "cbcp-src.txt")).length >= 1, [...recorded].join("\n"));
});

test("fs.openAsBlob records the path it opens", () => {
  const { dir, run, recorded } = apiProbe({
    files: { "blob-src.txt": "x" },
    source: `import { openAsBlob } from "node:fs";\nawait (await openAsBlob("blob-src.txt")).text();\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fileReads(recorded).has(at(dir, "blob-src.txt")));
});

test("new fs.ReadStream surfaces through the wrapped open", () => {
  // The class is classified "ignored" in the boundary because its read flows
  // through the wrapped open — this test is what keeps that claim honest.
  const { dir, run, recorded } = apiProbe({
    files: { "rs.txt": "x" },
    source: `import { ReadStream } from "node:fs";\nawait new Promise((resolve, reject) => { const s = new ReadStream("rs.txt"); s.on("data", () => {}); s.on("end", resolve); s.on("error", reject); });\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fileReads(recorded).has(at(dir, "rs.txt")));
});

test("node:fs/promises readFile is recorded", () => {
  const { dir, run, recorded } = apiProbe({
    files: { "p-readfile.txt": "x" },
    source: `import { readFile } from "node:fs/promises";\nawait readFile("p-readfile.txt", "utf8");\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fileReads(recorded).has(at(dir, "p-readfile.txt")));
});

test("node:fs/promises open is recorded", () => {
  const { dir, run, recorded } = apiProbe({
    files: { "p-open.txt": "x" },
    source: `import { open } from "node:fs/promises";\nawait (await open("p-open.txt")).readFile();\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fileReads(recorded).has(at(dir, "p-open.txt")));
});

test("node:fs/promises readdir is recorded", () => {
  const { dir, run, recorded } = apiProbe({
    dirs: ["p-dir"],
    source: `import { readdir } from "node:fs/promises";\nawait readdir("p-dir");\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(dirLists(recorded).has(at(dir, "p-dir")));
});

test("node:fs/promises opendir is recorded", () => {
  const { dir, run, recorded } = apiProbe({
    dirs: ["p-odir"],
    source: `import { opendir } from "node:fs/promises";\nawait (await opendir("p-odir")).close();\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(dirLists(recorded).has(at(dir, "p-odir")));
});

test("node:fs/promises copyFile marks the copy, naming the source", () => {
  const { dir, run, recorded } = apiProbe({
    files: { "p-copy-src.txt": "x" },
    source: `import { copyFile } from "node:fs/promises";\nawait copyFile("p-copy-src.txt", "p-copy-dst.txt");\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(namedCopy(recorded, at(dir, "p-copy-src.txt")).length, 1, [...recorded].join("\n"));
});

test("node:fs/promises cp marks the copy, naming the source", () => {
  const { dir, run, recorded } = apiProbe({
    files: { "p-cp-src.txt": "x" },
    source: `import { cp } from "node:fs/promises";\nawait cp("p-cp-src.txt", "p-cp-dst.txt");\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(namedCopy(recorded, at(dir, "p-cp-src.txt")).length >= 1, [...recorded].join("\n"));
});

test("a relative read after process.chdir resolves against the new cwd", () => {
  const { dir, run, recorded } = apiProbe({
    files: { "sub/inside.txt": "x" },
    source: `import { readFileSync } from "node:fs";
process.chdir("sub");
readFileSync("inside.txt", "utf8");
`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fileReads(recorded).has(at(dir, "sub", "inside.txt")), [...recorded].join("\n"));
});

test("a child process resolves relative reads against its own cwd", () => {
  const dir = scratch();
  mkdirSync(path.join(dir, "sub"));
  writeFileSync(path.join(dir, "sub", "inside.txt"), "x");
  const logDir = path.join(dir, "log");
  mkdirSync(logDir);
  writeFileSync(
    path.join(dir, "sub", "child.mjs"),
    `import { readFileSync } from "node:fs";\nreadFileSync("inside.txt", "utf8");\n`,
  );
  writeFileSync(
    path.join(dir, "parent.mjs"),
    `import { spawnSync } from "node:child_process";
const run = spawnSync(process.execPath, ["child.mjs"], { cwd: "sub", stdio: "inherit" });
process.exit(run.status ?? 1);
`,
  );
  const run = spawnSync(process.execPath, ["--import", INSTRUMENT_URL, "parent.mjs"], {
    cwd: dir,
    env: {
      ...process.env,
      NODE_OPTIONS: `--import ${INSTRUMENT_URL}`,
      DESIGN_READS_LOG: logDir,
    },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fileReads(collectRecordedPaths(logDir)).has(at(dir, "sub", "inside.txt")), [...collectRecordedPaths(logDir)].join("\n"));
});

test("a read by an instrumented child process is recorded in its own log", () => {
  const dir = scratch();
  writeFileSync(path.join(dir, "child-target.txt"), "x");
  const logDir = path.join(dir, "log");
  mkdirSync(logDir);
  writeFileSync(
    path.join(dir, "child.mjs"),
    `import { readFileSync } from "node:fs";\nreadFileSync("child-target.txt", "utf8");\n`,
  );
  writeFileSync(
    path.join(dir, "parent.mjs"),
    `import { spawnSync } from "node:child_process";
const run = spawnSync(process.execPath, ["child.mjs"], { stdio: "inherit" });
process.exit(run.status ?? 1);
`,
  );
  const run = spawnSync(process.execPath, ["--import", INSTRUMENT_URL, "parent.mjs"], {
    cwd: dir,
    env: {
      ...process.env,
      NODE_OPTIONS: `--import ${INSTRUMENT_URL}`,
      DESIGN_READS_LOG: logDir,
    },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const logs = readdirSync(logDir);
  assert.ok(logs.length >= 2, "the child wrote its own per-pid log");
  assert.ok(fileReads(collectRecordedPaths(logDir)).has(at(dir, "child-target.txt")));
});

test("existence and metadata probes are not recorded as reads", () => {
  const { dir, run, recorded } = apiProbe({
    files: { "probed.txt": "x" },
    source: `import { existsSync, statSync, accessSync, realpathSync, globSync } from "node:fs";
existsSync("probed.txt");
statSync("probed.txt");
accessSync("probed.txt");
realpathSync("probed.txt");
globSync("pro*.txt");
`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!fileReads(recorded).has(at(dir, "probed.txt")), "a probe must not become a member");
});

test("write-only opens are not recorded — string, numeric, callback and promise flags", () => {
  const { dir, run, recorded } = apiProbe({
    // rw.txt/rw2.txt exist beforehand: a w+/a+ open on a name with nothing
    // behind it creates the file, and a created file carries no bytes that
    // were ever read — the record stays unresolved and is dropped.
    files: { "rw.txt": "x", "rw2.txt": "x" },
    source: `import fs from "node:fs";
import { open as popen } from "node:fs/promises";
const fd = fs.openSync("wo-sync.txt", "w");
fs.writeSync(fd, "x");
fs.closeSync(fd);
const fa = fs.openSync("wo-append.txt", "a");
fs.writeSync(fa, "x");
fs.closeSync(fa);
const fn = fs.openSync("wo-num.txt", fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC);
fs.writeSync(fn, "x");
fs.closeSync(fn);
await new Promise((resolve, reject) => fs.open("wo-cb.txt", "w", (e, fd2) => e ? reject(e) : fs.close(fd2, resolve)));
await (await popen("wo-p.txt", "w")).close();
const fr = fs.openSync("rw.txt", "w+");
fs.closeSync(fr);
const fa2 = fs.openSync("rw2.txt", "a+");
fs.closeSync(fa2);
`,
  });
  assert.equal(run.status, 0, run.stderr);
  for (const skipped of ["wo-sync.txt", "wo-append.txt", "wo-num.txt", "wo-cb.txt", "wo-p.txt"]) {
    assert.ok(!fileReads(recorded).has(at(dir, skipped)), `${skipped}: a write-only open must not be recorded`);
  }
  // Read-capable opens still record — w+ and a+ can read through the fd.
  assert.ok(fileReads(recorded).has(at(dir, "rw.txt")), [...recorded].join("\n"));
  assert.ok(fileReads(recorded).has(at(dir, "rw2.txt")));
});

test("a copy names its source at call time, not at completion", () => {
  // The async forms finish after the caller may have moved cwd; the marker
  // must name the file the call was made against. The spin wait below holds
  // the event loop until both copies have physically completed — their
  // callbacks cannot run before the chdir — so on a wrapper that resolves
  // the source at completion the marker deterministically lands under sub/.
  const { dir, run, recorded } = apiProbe({
    files: { "cb-src.txt": "x", "p-src.txt": "x", "sub/placeholder.txt": "x" },
    source: `import fs from "node:fs";
import { copyFile as pcopyFile } from "node:fs/promises";
const before = process.cwd();
const pending = pcopyFile("p-src.txt", "p-dst.txt");
fs.copyFile("cb-src.txt", "cb-dst.txt", () => {});
while (!fs.existsSync("p-dst.txt") || !fs.existsSync("cb-dst.txt")) {}
process.chdir("sub");
await pending;
process.chdir(before);
`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(namedCopy(recorded, at(dir, "cb-src.txt")).length >= 1, [...recorded].join("\n"));
  assert.ok(namedCopy(recorded, at(dir, "p-src.txt")).length >= 1);
  assert.ok(!fileReads(recorded).has(at(dir, "sub", "cb-src.txt")));
  assert.ok(!fileReads(recorded).has(at(dir, "sub", "p-src.txt")));
});

test("a read that opens a name created mid-flight is a conflict, not a drop", () => {
  // UV_THREADPOOL_SIZE=1 plus a fifo-blocked single worker makes the order
  // deterministic: readFile is queued while alias.json does not exist, the
  // alias is created pointing at input.json, and the deferred open reads
  // the real bytes. A call-time miss is not proof that nothing was read —
  // the record must be a conflict naming both observations.
  const { dir, run, recorded } = apiProbe({
    env: { UV_THREADPOOL_SIZE: "1" },
    files: { "input.json": "{}" },
    source: `import fs from "node:fs";
import { spawnSync } from "node:child_process";
const r = spawnSync("mkfifo", ["gate.fifo"]);
if (r.status !== 0) throw new Error("mkfifo failed: " + r.stderr);
const fd = fs.openSync("gate.fifo", fs.constants.O_RDWR);
const gate = new Promise((resolve, reject) => fs.read(fd, Buffer.alloc(1), 0, 1, null, (e) => e ? reject(e) : resolve()));
const read = new Promise((resolve, reject) => fs.readFile("alias.json", "utf8", (e, d) => e ? reject(e) : resolve(d)));
fs.symlinkSync("input.json", "alias.json");
fs.writeSync(fd, "x");
await gate;
await read;
fs.closeSync(fd);
`,
  });
  assert.equal(run.status, 0, run.stderr);
  const conflicts = conflictMarks(recorded);
  assert.equal(conflicts.length, 1, [...recorded].join("\n"));
  const [, left, right] = conflicts[0].split("\t");
  assert.equal(left, `?${at(dir, "alias.json")}`);
  assert.equal(right, at(dir, "input.json"));
});

test("a target swapped from outside to inside before the deferred open is a conflict", () => {
  // The name resolved outside when the call was made and inside by the
  // time the open ran — neither observation alone says what was read, so
  // the record refuses rather than keep the stale outside name.
  const { dir, run, recorded } = apiProbe({
    env: { UV_THREADPOOL_SIZE: "1" },
    files: { "input.json": "{}" },
    source: `import fs from "node:fs";
import { spawnSync } from "node:child_process";
const r = spawnSync("mkfifo", ["gate.fifo"]);
if (r.status !== 0) throw new Error("mkfifo failed: " + r.stderr);
fs.symlinkSync("/etc/hosts", "alias.json");
const fd = fs.openSync("gate.fifo", fs.constants.O_RDWR);
const gate = new Promise((resolve, reject) => fs.read(fd, Buffer.alloc(1), 0, 1, null, (e) => e ? reject(e) : resolve()));
const read = new Promise((resolve, reject) => fs.readFile("alias.json", "utf8", (e, d) => e ? reject(e) : resolve(d)));
fs.unlinkSync("alias.json");
fs.symlinkSync("input.json", "alias.json");
fs.writeSync(fd, "x");
await gate;
await read;
fs.closeSync(fd);
`,
  });
  assert.equal(run.status, 0, run.stderr);
  const conflicts = conflictMarks(recorded);
  assert.equal(conflicts.length, 1, [...recorded].join("\n"));
  const [, left, right] = conflicts[0].split("\t");
  assert.equal(left, realpathSync.native("/etc/hosts"));
  assert.equal(right, at(dir, "input.json"));
});

test("a copy whose source moved between call and completion carries both names", () => {
  // The same blocked-pool ordering as the read cases: copyFile is queued
  // while alias-src.json points outside, the alias is moved onto a
  // repository file, and the deferred copy reads its bytes. The marker
  // names both resolutions — outside at the call, inside at completion —
  // so the reduce refuses instead of trusting the stale outside name.
  const { dir, run, recorded } = apiProbe({
    env: { UV_THREADPOOL_SIZE: "1" },
    files: { "input.json": "{}" },
    source: `import fs from "node:fs";
import { spawnSync } from "node:child_process";
const r = spawnSync("mkfifo", ["gate.fifo"]);
if (r.status !== 0) throw new Error("mkfifo failed: " + r.stderr);
fs.symlinkSync("/etc/hosts", "alias-src.json");
const fd = fs.openSync("gate.fifo", fs.constants.O_RDWR);
const gate = new Promise((resolve, reject) => fs.read(fd, Buffer.alloc(1), 0, 1, null, (e) => e ? reject(e) : resolve()));
const copy = new Promise((resolve, reject) => fs.copyFile("alias-src.json", "dst.json", (e) => e ? reject(e) : resolve()));
fs.unlinkSync("alias-src.json");
fs.symlinkSync("input.json", "alias-src.json");
fs.writeSync(fd, "x");
await gate;
await copy;
fs.closeSync(fd);
`,
  });
  assert.equal(run.status, 0, run.stderr);
  const copies = copyMarkers(recorded);
  assert.equal(copies.length, 1, [...recorded].join("\n"));
  const [, call, done] = copies[0].split("\t");
  assert.equal(call, realpathSync.native("/etc/hosts"));
  assert.equal(done, at(dir, "input.json"));
});

test("a copy that throws after copying part of its source still marks", () => {
  // cpSync recursive with force:false, errorOnExist:true copies
  // 00-kept.json into the destination, then throws on the existing
  // zz-block.json. The partial copy already read repository bytes — the
  // mark must exist even though the call failed, and the caller's error
  // arrives unchanged.
  const { dir, run, recorded } = apiProbe({
    files: {
      "cpdir-src/00-kept.json": "{}",
      "cpdir-src/zz-block.json": "{}",
      "cpdir-dst/zz-block.json": "x",
    },
    source: `import fs from "node:fs";
let thrown;
try {
  fs.cpSync("cpdir-src", "cpdir-dst", { recursive: true, force: false, errorOnExist: true });
} catch (error) {
  thrown = error;
}
if (thrown?.code !== "ERR_FS_CP_EEXIST") throw new Error("copy did not fail as arranged: " + thrown);
JSON.parse(fs.readFileSync("cpdir-dst/00-kept.json", "utf8"));
`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(namedCopy(recorded, at(dir, "cpdir-src")).length >= 1, [...recorded].join("\n"));
});

test("a copy that fails before reading anything still marks the attempt", () => {
  // copyFileSync of a missing source throws ENOENT — nothing was copied,
  // but the instrument cannot tell a failure before the first byte from
  // one after the last, so the attempt is marked with both names
  // unresolved and the caller's error passes through.
  const { dir, run, recorded } = apiProbe({
    source: `import fs from "node:fs";
let thrown;
try {
  fs.copyFileSync("missing-src.json", "dst.json");
} catch (error) {
  thrown = error;
}
if (thrown?.code !== "ENOENT") throw new Error("copy did not fail as arranged: " + thrown);
`,
  });
  assert.equal(run.status, 0, run.stderr);
  const copies = copyMarkers(recorded);
  assert.equal(copies.length, 1, [...recorded].join("\n"));
  const [, call, done] = copies[0].split("\t");
  assert.equal(call, `?${at(dir, "missing-src.json")}`);
  assert.equal(done, `?${at(dir, "missing-src.json")}`);
});

test("a failed promise copy still marks and rejects with the caller's error", () => {
  const { dir, run, recorded } = apiProbe({
    source: `import { copyFile } from "node:fs/promises";
let reason;
try {
  await copyFile("p-missing-src.json", "p-fail-dst.json");
} catch (error) {
  reason = error;
}
if (reason?.code !== "ENOENT") throw new Error("copy did not reject as arranged: " + reason);
`,
  });
  assert.equal(run.status, 0, run.stderr);
  const copies = copyMarkers(recorded);
  assert.equal(copies.length, 1, [...recorded].join("\n"));
  const [, call, done] = copies[0].split("\t");
  assert.equal(call, `?${at(dir, "p-missing-src.json")}`);
  assert.equal(done, `?${at(dir, "p-missing-src.json")}`);
});

test("an open of a directory is a directory record, not a file", () => {
  // open succeeds on a directory — the kind comes from the descriptor the
  // operation produced, not from the API's name.
  const { dir, run, recorded } = apiProbe({
    files: { "a-dir/inside.txt": "x" },
    source: `import fs from "node:fs";
const fd = fs.openSync("a-dir", "r");
fs.closeSync(fd);
`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(dirLists(recorded).has(at(dir, "a-dir")), [...recorded].join("\n"));
  assert.ok(!fileReads(recorded).has(at(dir, "a-dir")));
});

test("a read through a link to the target's directory records the real file", () => {
  const { dir, run, recorded } = apiProbe({
    files: { "real/inside.txt": "x" },
    source: `import { readFileSync, symlinkSync } from "node:fs";
symlinkSync("real", "alias");
readFileSync("alias/inside.txt", "utf8");
`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fileReads(recorded).has(at(dir, "real", "inside.txt")), [...recorded].join("\n"));
  assert.ok(!fileReads(recorded).has(at(dir, "alias", "inside.txt")));
});

test("a copy passes the caller's arguments untouched — relative filter", () => {
  // Rewriting the caller's source/destination into absolute paths changed
  // what the caller's own filter received and made cp copy a different set
  // than an uninstrumented run. The instrument must not alter a single
  // value the program passes to fs: this probe copies only when its filter
  // sees the relative name it was written against.
  const { dir, run, recorded } = apiProbe({
    files: { "rel-src.txt": "x" },
    source: `import { cpSync, existsSync } from "node:fs";
cpSync("rel-src.txt", "rel-dst.txt", { filter: (src) => src === "rel-src.txt" });
if (!existsSync("rel-dst.txt")) process.exit(3);
`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(namedCopy(recorded, at(dir, "rel-src.txt")).length >= 1, [...recorded].join("\n"));
});

test("a copy marker names the source argument, not the copied set", () => {
  // What a copy copied is not modelled: one marker names the source the
  // caller passed, whatever filter or force would have done.
  const { dir, run, recorded } = apiProbe({
    files: { "cpf-src/kept.txt": "x", "cpf-src/excluded.txt": "x" },
    source: `import { cpSync } from "node:fs";
cpSync("cpf-src", "cpf-dst", { recursive: true, filter: (src) => !src.endsWith("excluded.txt") });
`,
  });
  assert.equal(run.status, 0, run.stderr);
  // cp walks the tree itself and its inner copyFile calls mark too — the
  // marker count is an implementation detail; the named source is not.
  assert.ok(namedCopy(recorded, at(dir, "cpf-src")).length >= 1, [...recorded].join("\n"));
});

test("a write-only flag inside options is not recorded — readFile and createReadStream", () => {
  const { dir, run, recorded } = apiProbe({
    files: { "r-opt.txt": "x", "r-def.txt": "x", "r-stream.txt": "x", "wo-num.txt": "x" },
    source: `import { readFileSync, createReadStream, constants } from "node:fs";
try { readFileSync("wo-opt.txt", { flag: "w" }); } catch {}
try { readFileSync("wo-num.txt", { flag: constants.O_WRONLY }); } catch {}
const s = createReadStream("wo-stream.txt", { flags: "a" });
await new Promise((resolve) => { s.on("error", resolve); s.on("data", () => {}); });
readFileSync("r-opt.txt", { flag: "r", encoding: "utf8" });
readFileSync("r-def.txt", "utf8");
await new Promise((resolve, reject) => { const ok = createReadStream("r-stream.txt"); ok.on("data", () => {}); ok.on("end", resolve); ok.on("error", reject); });
`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!fileReads(recorded).has(at(dir, "wo-opt.txt")), "options.flag 'w' must not record");
  assert.ok(!fileReads(recorded).has(at(dir, "wo-num.txt")), "a numeric write-only options.flag must not record");
  assert.ok(!fileReads(recorded).has(at(dir, "wo-stream.txt")), "options.flags 'a' must not record");
  assert.ok(fileReads(recorded).has(at(dir, "r-opt.txt")));
  assert.ok(fileReads(recorded).has(at(dir, "r-def.txt")));
  assert.ok(fileReads(recorded).has(at(dir, "r-stream.txt")));
});

test("an option field the API ignores never suppresses the record", () => {
  // Option semantics are per-API: readFile honors flag, createReadStream
  // honors flags, and openAsBlob has no open flag at all. A field the API
  // ignores must not be read by the instrument either.
  const { dir, run, recorded } = apiProbe({
    files: { "rf-flags.txt": "x", "crs-flag.txt": "x", "blob-flag.txt": "x", "rd-dir/inside.txt": "x" },
    source: `import { readFileSync, createReadStream, openAsBlob, readdirSync } from "node:fs";
readFileSync("rf-flags.txt", { encoding: "utf8", flags: "w" });
await new Promise((resolve, reject) => { const s = createReadStream("crs-flag.txt", { flag: "w", flags: "r" }); s.on("data", () => {}); s.on("end", resolve); s.on("error", reject); });
await (await openAsBlob("blob-flag.txt", { flag: "w" })).text();
readdirSync("rd-dir", { flag: "w" });
`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fileReads(recorded).has(at(dir, "rf-flags.txt")), "readFileSync ignores options.flags — the read is real");
  assert.ok(fileReads(recorded).has(at(dir, "crs-flag.txt")), "createReadStream ignores options.flag — the read is real");
  assert.ok(fileReads(recorded).has(at(dir, "blob-flag.txt")), "openAsBlob has no flag semantics — the read is real");
  assert.ok(dirLists(recorded).has(at(dir, "rd-dir")), "readdir has no flag semantics — the read is real");
});

test("every fs export is classified — wrapped content read or declared ignore", async () => {
  // The boundary is checkable, not hand-waved: a Node upgrade that adds an
  // export lands in neither list and fails here until someone classifies it.
  const instrument = await import("../scripts/lib/design-reads-instrument.mjs");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const fs = require("node:fs");
  const fsp = require("node:fs/promises");
  const cases = [
    ["node:fs", fs, instrument.FS_CONTENT_READS, instrument.FS_IGNORED],
    ["node:fs/promises", fsp, instrument.FSP_CONTENT_READS, instrument.FSP_IGNORED],
  ];
  for (const [label, module, reads, ignored] of cases) {
    const ignoredSet = new Set(Object.values(ignored).flat());
    assert.ok(reads.length > 0, `${label}: no content reads declared`);
    for (const name of Object.keys(module)) {
      const isRead = reads.includes(name);
      const isIgnored = ignoredSet.has(name);
      assert.ok(isRead !== isIgnored, `${label}.${name} must sit in exactly one of the two lists`);
    }
    for (const name of [...reads, ...ignoredSet]) {
      assert.ok(name in module, `${label}.${name}: declared but not exported`);
    }
  }
});

test("a process without the instrument records nothing — the canary", () => {
  // The instrument must fail closed: a validator that records no reads did
  // not run under it. This is what that failure looks like from the outside.
  const dir = scratch();
  const logDir = path.join(dir, "log");
  mkdirSync(logDir);
  writeFileSync(path.join(dir, "probe.mjs"), `import { readFileSync } from "node:fs";\nreadFileSync("x", "utf8");\n`);
  writeFileSync(path.join(dir, "x"), "x");
  spawnSync(process.execPath, ["probe.mjs"], { cwd: dir, env: { ...process.env, DESIGN_READS_LOG: logDir } });
  assert.equal(collectRecordedPaths(logDir).size, 0);
});

/** A minimal repository: one package.json plus scripts the runner spawns. */
function sandbox(scripts) {
  const root = scratch();
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "resources", "design-candidate"), { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "sandbox", scripts }, null, 2),
  );
  for (const [file, content] of Object.entries(scripts.files ?? {})) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
}

function runMeasurement(root, args = [], env = {}) {
  return spawnSync(process.execPath, [RUNNER, "--root", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("the runner records what a validator actually opened", () => {
  const root = sandbox({
    "validate:tiny": "node scripts/validate-tiny.mjs",
    files: {
      "scripts/validate-tiny.mjs": `import { readFileSync } from "node:fs";\nJSON.parse(readFileSync("data/inputs.json", "utf8"));\nreadFileSync("resources/design-candidate/measured-inputs.v1.json", "utf8");\n`,
      "data/inputs.json": "{}",
    },
  });
  const run = runMeasurement(root);
  assert.equal(run.status, 0, run.stderr);
  const artifact = JSON.parse(readFileSync(path.join(root, MEASURED_PATH), "utf8"));
  assert.deepEqual(artifact.readers, ["validate:tiny"]);
  assert.deepEqual(artifact.inputs.sort(), ["data/inputs.json", MEASURED_PATH].sort());
  const { digest, ...body } = artifact;
  assert.equal(digest, measuredDigest(body));
});

test("code is dropped by extension, .patch included; directories are not members", () => {
  const root = sandbox({
    "validate:kinds": "node scripts/validate-kinds.mjs",
    files: {
      "scripts/validate-kinds.mjs": `import { readFileSync, readdirSync } from "node:fs";
readFileSync("data/code.mjs", "utf8");
readFileSync("data/series.patch", "utf8");
readFileSync("data/input.json", "utf8");
readdirSync("data");
`,
      "data/code.mjs": "",
      "data/series.patch": "",
      "data/input.json": "{}",
    },
  });
  const run = runMeasurement(root);
  assert.equal(run.status, 0, run.stderr);
  const artifact = JSON.parse(readFileSync(path.join(root, MEASURED_PATH), "utf8"));
  assert.deepEqual(artifact.inputs, ["data/input.json"]);
  assert.ok(isCodePath("data/code.mjs"));
  assert.ok(isCodePath("compat/autosk/patches/0001-x.patch"));
});

test("a validator that exits nonzero fails the measurement", () => {
  const root = sandbox({
    "validate:fails": "node scripts/validate-fails.mjs",
    files: { "scripts/validate-fails.mjs": `process.exit(1);\n` },
  });
  const run = runMeasurement(root);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /exited 1/u);
});

test("a validator that records no reads fails the measurement", () => {
  // Fail closed: an empty record means the instrument did not take — a real
  // validator cannot read nothing. A process under a working instrument
  // records at least its own entry read, so the guard is exercised through a
  // spawn that takes the instrument's place and writes nothing.
  const root = sandbox({
    "validate:empty": "node scripts/validate-empty.mjs",
    files: { "scripts/validate-empty.mjs": `process.exit(0);\n` },
  });
  assert.throws(
    () => measure(root, { spawn: () => ({ status: 0, stderr: "" }) }),
    /recorded no reads — the instrument did not take/u,
  );
});

test("a validate entry that is not a plain node run refuses and leaves no scratch behind", () => {
  // The refusal happens before any reader runs; the scratch directory the
  // measurer made must still be removed — the child's own TMPDIR witnesses it.
  const root = sandbox({ "validate:bad": "bun scripts/validate-bad.ts" });
  const childTmp = scratch();
  const run = runMeasurement(root, [], { TMPDIR: childTmp, NODE_DISABLE_COMPILE_CACHE: "1" });
  assert.equal(run.status, 1);
  assert.match(run.stderr + run.stdout, /validate:bad: "bun scripts\/validate-bad\.ts" is not a plain node script run/u);
  assert.deepEqual(readdirSync(childTmp), []);
});

test("--check passes on a fresh artifact and fails on added, removed and stale input", () => {
  const root = sandbox({
    "validate:tiny": "node scripts/validate-tiny.mjs",
    files: {
      "scripts/validate-tiny.mjs": `import { readFileSync, existsSync } from "node:fs";
JSON.parse(readFileSync("data/inputs.json", "utf8"));
if (existsSync("data/added.json")) JSON.parse(readFileSync("data/added.json", "utf8"));
`,
      "data/inputs.json": "{}",
    },
  });
  assert.equal(runMeasurement(root).status, 0);
  assert.equal(runMeasurement(root, ["--check"]).status, 0, "freshly measured artifact must pass");

  // An input the shipped artifact does not name is added drift.
  writeFileSync(path.join(root, "data", "added.json"), "{}");
  const added = runMeasurement(root, ["--check"]);
  assert.equal(added.status, 1);
  assert.match(added.stderr, /measured input not in the artifact: data\/added\.json/u);

  assert.equal(runMeasurement(root).status, 0);
  rmSync(path.join(root, "data", "added.json"));
  const removed = runMeasurement(root, ["--check"]);
  assert.equal(removed.status, 1);
  assert.match(removed.stderr, /artifact input no longer measured: data\/added\.json/u);

  // A digest that does not recompute is drift even with the same inputs.
  const artifactPath = path.join(root, MEASURED_PATH);
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  writeFileSync(artifactPath, `${JSON.stringify({ ...artifact, digest: "0".repeat(64) }, null, 2)}\n`);
  const stale = runMeasurement(root, ["--check"]);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /does not recompute/u);
});

test("a new validator makes the artifact stale through the reader list", () => {
  const root = sandbox({
    "validate:tiny": "node scripts/validate-tiny.mjs",
    files: {
      "scripts/validate-tiny.mjs": `import { readFileSync } from "node:fs";\nreadFileSync("data/inputs.json", "utf8");\n`,
      "data/inputs.json": "{}",
      "scripts/validate-new.mjs": `import { readFileSync } from "node:fs";\nreadFileSync("data/inputs.json", "utf8");\n`,
    },
  });
  assert.equal(runMeasurement(root).status, 0);
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  pkg.scripts["validate:new"] = "node scripts/validate-new.mjs";
  writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg, null, 2));
  const drift = runMeasurement(root, ["--check"]);
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /reader not in the artifact: validate:new/u);
});

test("a path-shaped string that is never opened is not measured", () => {
  // R1-03 disappears by construction: options objects and labels are not
  // reads because nothing opens them.
  const root = sandbox({
    "validate:labels": "node scripts/validate-labels.mjs",
    files: {
      "scripts/validate-labels.mjs": `import { readFileSync } from "node:fs";
const LABELS = ["data/label-only.json"];
for (const label of LABELS) {
  readFileSync("data/inputs.json", { encoding: "utf8", reviewLabel: label });
}
`,
      "data/inputs.json": "{}",
    },
  });
  const run = runMeasurement(root);
  assert.equal(run.status, 0, run.stderr);
  const artifact = JSON.parse(readFileSync(path.join(root, MEASURED_PATH), "utf8"));
  assert.ok(!artifact.inputs.includes("data/label-only.json"));
  assert.ok(artifact.inputs.includes("data/inputs.json"));
});

test("a file a validator only writes is not a measured input", () => {
  // A write-only open records nothing: the earlier bytes of an output can
  // change no verdict, so pinning it would be a false member.
  const root = sandbox({
    "validate:writes": "node scripts/validate-writes.mjs",
    files: {
      "scripts/validate-writes.mjs": `import { openSync, writeSync, closeSync, readFileSync } from "node:fs";
JSON.parse(readFileSync("data/inputs.json", "utf8"));
const fd = openSync("data/output.json", "w");
writeSync(fd, "{}");
closeSync(fd);
`,
      "data/inputs.json": "{}",
    },
  });
  const run = runMeasurement(root);
  assert.equal(run.status, 0, run.stderr);
  const artifact = JSON.parse(readFileSync(path.join(root, MEASURED_PATH), "utf8"));
  assert.ok(artifact.inputs.includes("data/inputs.json"));
  assert.ok(!artifact.inputs.includes("data/output.json"), "a write-only target must not become a member");
});

test("a copy of a repository file refuses the measurement by name", () => {
  // Copies are a way of reading bytes the measurement does not model — a
  // source inside the repository is refused loudly rather than guessed.
  const root = sandbox({
    "validate:copies": "node scripts/validate-copies.mjs",
    files: {
      "scripts/validate-copies.mjs": `import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const work = mkdtempSync(join(tmpdir(), "t08-copy-"));
try {
  JSON.parse(readFileSync("data/inputs.json", "utf8"));
  copyFileSync("data/inputs.json", join(work, "copied.json"));
} finally {
  rmSync(work, { recursive: true, force: true });
}
`,
      "data/inputs.json": "{}",
    },
  });
  const run = runMeasurement(root);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr + run.stdout, /data\/inputs\.json/u);
});

test("a copy of an external file is ignored", () => {
  const root = sandbox({
    "validate:external": "node scripts/validate-external.mjs",
    files: {
      "scripts/validate-external.mjs": `import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const work = mkdtempSync(join(tmpdir(), "t08-ext-"));
try {
  JSON.parse(readFileSync("data/inputs.json", "utf8"));
  copyFileSync("/etc/hosts", join(work, "ext.txt"));
} finally {
  rmSync(work, { recursive: true, force: true });
}
`,
      "data/inputs.json": "{}",
    },
  });
  const run = runMeasurement(root);
  assert.equal(run.status, 0, run.stderr);
  const artifact = JSON.parse(readFileSync(path.join(root, MEASURED_PATH), "utf8"));
  assert.deepEqual(artifact.inputs, ["data/inputs.json"]);
});

test("a read that is gone by reduce time refuses the measurement by name", () => {
  // The record proves the read; a missing file can no longer be pinned, so
  // the measurement refuses instead of calling it unread.
  const root = sandbox({
    "validate:unlink": "node scripts/validate-unlink.mjs",
    files: {
      "scripts/validate-unlink.mjs": `import { readFileSync, unlinkSync } from "node:fs";
JSON.parse(readFileSync("data/inputs.json", "utf8"));
unlinkSync("data/inputs.json");
`,
      "data/inputs.json": "{}",
    },
  });
  const run = runMeasurement(root);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr + run.stdout, /data\/inputs\.json/u);
});

test("a read made unreachable by chmod refuses the measurement by name", () => {
  const root = sandbox({
    "validate:chmod": "node scripts/validate-chmod.mjs",
    files: {
      "scripts/validate-chmod.mjs": `import { readFileSync, chmodSync } from "node:fs";
JSON.parse(readFileSync("data/inputs.json", "utf8"));
chmodSync("data", 0);
`,
      "data/inputs.json": "{}",
    },
  });
  try {
    const run = runMeasurement(root);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr + run.stdout, /data\/inputs\.json/u);
  } finally {
    chmodSync(path.join(root, "data"), 0o755);
  }
});

test("a read replaced by a directory refuses the measurement by name", () => {
  // The file was provably read; a directory on the same path at reduce
  // time is a type change, not a walk root — refuse by name.
  const root = sandbox({
    "validate:replaced": "node scripts/validate-replaced.mjs",
    files: {
      "scripts/validate-replaced.mjs": `import { readFileSync, unlinkSync, mkdirSync } from "node:fs";
JSON.parse(readFileSync("data/inputs.json", "utf8"));
unlinkSync("data/inputs.json");
mkdirSync("data/inputs.json");
`,
      "data/inputs.json": "{}",
    },
  });
  const run = runMeasurement(root);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr + run.stdout, /data\/inputs\.json/u);
});

test("a copy whose source moved onto a repository file refuses by name", () => {
  // copyFile is queued while its source name points outside; before the
  // deferred operation runs the name is moved onto a repository input.
  // The marker carries both resolutions and the measurement refuses.
  const root = sandbox({
    "validate:copy-move": "node scripts/validate-copy-move.mjs",
    files: {
      "scripts/validate-copy-move.mjs": `import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
JSON.parse(fs.readFileSync("data/inputs.json", "utf8"));
const work = fs.mkdtempSync(join(tmpdir(), "t08-gate-"));
try {
  const fifo = join(work, "gate.fifo");
  const r = spawnSync("mkfifo", [fifo]);
  if (r.status !== 0) throw new Error("mkfifo failed: " + r.stderr);
  fs.symlinkSync("/etc/hosts", "data/late-src.json");
  const fd = fs.openSync(fifo, fs.constants.O_RDWR);
  const gate = new Promise((resolve, reject) => fs.read(fd, Buffer.alloc(1), 0, 1, null, (e) => e ? reject(e) : resolve()));
  const copy = new Promise((resolve, reject) => fs.copyFile("data/late-src.json", join(work, "c.json"), (e) => e ? reject(e) : resolve()));
  fs.unlinkSync("data/late-src.json");
  fs.symlinkSync("inputs.json", "data/late-src.json");
  fs.writeSync(fd, "x");
  await gate;
  await copy;
  fs.closeSync(fd);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
`,
      "data/inputs.json": "{}",
    },
  });
  const run = runMeasurement(root, [], { UV_THREADPOOL_SIZE: "1" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr + run.stdout, /late-src\.json|inputs\.json/u);
});

test("a copy that throws after a partial copy refuses the measurement", () => {
  // cpSync recursive copies 00-kept.json into the destination, then fails
  // on the existing zz-block.json. The validator handles the error and
  // uses the bytes that did get copied — the measurement must refuse.
  const root = sandbox({
    "validate:partial-cp": "node scripts/validate-partial-cp.mjs",
    files: {
      "scripts/validate-partial-cp.mjs": `import { cpSync, readFileSync } from "node:fs";
try {
  cpSync("data", "external-dst", { recursive: true, force: false, errorOnExist: true });
} catch {}
JSON.parse(readFileSync("external-dst/00-kept.json", "utf8"));
`,
      "data/00-kept.json": "{}",
      "data/zz-block.json": "{}",
      "external-dst/zz-block.json": "x",
    },
  });
  const run = runMeasurement(root);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr + run.stdout, /copy.*data/su);
});

test("a read of a ..-prefixed name inside the root is a member", () => {
  // `..review-input.json` is a filename inside the root, not a parent
  // reference — the membership check compares path components.
  const root = sandbox({
    "validate:dotprefix": "node scripts/validate-dotprefix.mjs",
    files: {
      "scripts/validate-dotprefix.mjs": `import { readFileSync } from "node:fs";
JSON.parse(readFileSync("..review-input.json", "utf8"));
JSON.parse(readFileSync("data/inputs.json", "utf8"));
`,
      "..review-input.json": "{}",
      "data/inputs.json": "{}",
    },
  });
  const run = runMeasurement(root);
  assert.equal(run.status, 0, run.stderr);
  const artifact = JSON.parse(readFileSync(path.join(root, MEASURED_PATH), "utf8"));
  assert.ok(artifact.inputs.includes("..review-input.json"), artifact.inputs.join("\n"));
  assert.ok(artifact.inputs.includes("data/inputs.json"));
});

test("a validator that opens a directory does not trip the pin check", () => {
  // open succeeds on a directory; the record says dir and the directory
  // stays a non-member — no false refusal.
  const root = sandbox({
    "validate:opendir": "node scripts/validate-opendir.mjs",
    files: {
      "scripts/validate-opendir.mjs": `import { openSync, closeSync, readFileSync } from "node:fs";
JSON.parse(readFileSync("data/inputs.json", "utf8"));
closeSync(openSync("data", "r"));
`,
      "data/inputs.json": "{}",
    },
  });
  const run = runMeasurement(root);
  assert.equal(run.status, 0, run.stderr);
  const artifact = JSON.parse(readFileSync(path.join(root, MEASURED_PATH), "utf8"));
  assert.deepEqual(artifact.inputs, ["data/inputs.json"]);
});

test("a deferred open past a mid-flight rename refuses the measurement by name", () => {
  // One pool thread is blocked on a fifo; readFile is queued while
  // data/late.json does not exist; the symlink is created and the gate
  // released — the deferred open reads real repository bytes. The record
  // is a conflict and the measurement refuses, naming the path.
  const root = sandbox({
    "validate:deferred": "node scripts/validate-deferred.mjs",
    files: {
      "scripts/validate-deferred.mjs": `import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
JSON.parse(fs.readFileSync("data/inputs.json", "utf8"));
const work = fs.mkdtempSync(join(tmpdir(), "t08-gate-"));
try {
  const fifo = join(work, "gate.fifo");
  const r = spawnSync("mkfifo", [fifo]);
  if (r.status !== 0) throw new Error("mkfifo failed: " + r.stderr);
  const fd = fs.openSync(fifo, fs.constants.O_RDWR);
  const gate = new Promise((resolve, reject) => fs.read(fd, Buffer.alloc(1), 0, 1, null, (e) => e ? reject(e) : resolve()));
  const read = new Promise((resolve, reject) => fs.readFile("data/late.json", "utf8", (e, d) => e ? reject(e) : resolve(d)));
  fs.symlinkSync("inputs.json", "data/late.json");
  fs.writeSync(fd, "x");
  await gate;
  JSON.parse(await read);
  fs.closeSync(fd);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
`,
      "data/inputs.json": "{}",
    },
  });
  const run = runMeasurement(root, [], { UV_THREADPOOL_SIZE: "1" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr + run.stdout, /late\.json/u);
});

test("a relative read after process.chdir measures the real file", () => {
  const root = sandbox({
    "validate:chdir": "node scripts/validate-chdir.mjs",
    files: {
      "scripts/validate-chdir.mjs": `import { readFileSync } from "node:fs";
const before = process.cwd();
process.chdir("data");
try {
  JSON.parse(readFileSync("inputs.json", "utf8"));
} finally {
  process.chdir(before);
}
`,
      "data/inputs.json": "{}",
    },
  });
  const run = runMeasurement(root);
  assert.equal(run.status, 0, run.stderr);
  const artifact = JSON.parse(readFileSync(path.join(root, MEASURED_PATH), "utf8"));
  assert.ok(artifact.inputs.includes("data/inputs.json"), [...artifact.inputs].join("\n"));
});

test("a read through a symlinked name of the repository is a member", () => {
  // The validator opens the input by an absolute path through a link to the
  // repository root — the file is inside, and the measurement must see it.
  const root = sandbox({
    "validate:alias": "node scripts/validate-alias.mjs",
    files: {
      "scripts/validate-alias.mjs": `import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const aliasParent = mkdtempSync(join(tmpdir(), "t08-alias-"));
const alias = join(aliasParent, "link");
symlinkSync(process.cwd(), alias);
try {
  JSON.parse(readFileSync(join(alias, "data/inputs.json"), "utf8"));
  readFileSync("/etc/hosts", "utf8");
} finally {
  rmSync(aliasParent, { recursive: true, force: true });
}
`,
      "data/inputs.json": "{}",
    },
  });
  const run = runMeasurement(root);
  assert.equal(run.status, 0, run.stderr);
  const artifact = JSON.parse(readFileSync(path.join(root, MEASURED_PATH), "utf8"));
  assert.ok(artifact.inputs.includes("data/inputs.json"), [...artifact.inputs].join("\n"));
  assert.ok(!artifact.inputs.some((i) => i.includes("hosts")), "a genuinely external read is still dropped");
});

test("a read through a case-shifted name of the repository is a member", (t) => {
  // Only meaningful where the filesystem folds case; on a case-sensitive
  // filesystem the shifted path cannot be opened and there is nothing to test.
  const root = sandbox({
    "validate:cased": "node scripts/validate-cased.mjs",
    files: { "scripts/validate-cased.mjs": "process.exit(0);\n", "data/inputs.json": "{}" },
  });
  const physical = realpathSync.native(root);
  const shifted = physical.replace("private", "PRIVATE");
  if (shifted === physical || !existsSync(shifted)) {
    t.skip("filesystem does not fold case");
    return;
  }
  writeFileSync(
    path.join(root, "scripts", "validate-cased.mjs"),
    `import { readFileSync } from "node:fs";\nJSON.parse(readFileSync(${JSON.stringify(path.join(shifted, "data", "inputs.json"))}, "utf8"));\n`,
  );
  const run = runMeasurement(root);
  assert.equal(run.status, 0, run.stderr);
  const artifact = JSON.parse(readFileSync(path.join(root, MEASURED_PATH), "utf8"));
  assert.ok(artifact.inputs.includes("data/inputs.json"), [...artifact.inputs].join("\n"));
});

test("the reduce trusts the kind the record carries", () => {
  // The instrument resolves the physical name when the operation has
  // happened — that is the proof of the read. The reduce classifies inside
  // or outside by comparing names and never re-resolves against the
  // repository.
  const file = { statSync: () => ({ isFile: () => true }) };
  const missing = {
    statSync: () => {
      throw new Error("ENOENT");
    },
  };

  // A proven file read inside the repository, still a file, is a member.
  assert.deepEqual(
    reduceToInputs([`file\t${path.join(ROOT, "resources", "kept.json")}`], ROOT, file),
    ["resources/kept.json"],
  );
  // A proven file read inside that can no longer be pinned refuses by
  // name — the read happened, so it must not disappear quietly.
  assert.throws(
    () => reduceToInputs([`file\t${path.join(ROOT, "resources", "gone.json")}`], ROOT, missing),
    /cannot be pinned.*resources\/gone\.json/su,
  );
  // The same for a file replaced by a directory after the read.
  assert.throws(
    () =>
      reduceToInputs([`file\t${path.join(ROOT, "resources", "replaced.json")}`], ROOT, {
        statSync: () => ({ isFile: () => false }),
      }),
    /no longer a file.*resources\/replaced\.json/su,
  );
  // A proven read outside the repository is ignored — even a name that
  // cannot be re-resolved, since membership was never in question.
  assert.deepEqual(reduceToInputs(["file\t/outside/whatever.json"], ROOT, missing), []);
  // A proven directory listing inside the repository is not a member —
  // without any stat check: the record already says what it was.
  assert.deepEqual(
    reduceToInputs([`dir\t${path.join(ROOT, "resources", "subdir")}`], ROOT, missing),
    [],
  );
  // A name that moved while the operation was in flight refuses by name —
  // either side possibly inside is enough.
  assert.throws(
    () =>
      reduceToInputs(
        [`conflict\t?${path.join(ROOT, "resources", "late.json")}\t${path.join(ROOT, "resources", "late.json")}`],
        ROOT,
        file,
      ),
    /name moved.*resources\/late\.json/su,
  );
  assert.throws(
    () =>
      reduceToInputs(
        [`conflict\t/outside/before.json\t${path.join(ROOT, "resources", "swapped.json")}`],
        ROOT,
        file,
      ),
    /name moved.*swapped\.json/su,
  );
  // Both sides physically outside — ignored.
  assert.deepEqual(
    reduceToInputs(["conflict\t/outside/a.json\t/outside/b.json"], ROOT, missing),
    [],
  );
});

test("a copy marker on an in-repository source refuses by name; outside is ignored", () => {
  // The marker carries the source name twice — as resolved at the call and
  // at completion. It refuses when either could be inside or the two
  // differ; only a name outside at both observations is ignored.
  const fsx = { statSync: () => ({ isFile: () => true }) };
  const inside = path.join(ROOT, "resources", "a.json");
  const check = (call, done = call) =>
    reduceToInputs([`copy\t${call}\t${done}\tvalidate-x.mjs:12:5`], ROOT, fsx);
  assert.throws(() => check(inside), /copy.*resources\/a\.json.*validate-x\.mjs:12:5/su);
  assert.throws(() => check(`?${inside}`), /copy.*a\.json/su);
  assert.throws(() => check("/tmp/external.json", inside), /copy.*a\.json/su);
  assert.throws(() => check(inside, "/tmp/external.json"), /copy.*a\.json/su);
  assert.throws(() => check("/tmp/a.json", "/tmp/b.json"), /copy.*a\.json.*b\.json/su);
  assert.deepEqual(check("/tmp/external.json"), []);
  assert.deepEqual(check("?/tmp/missing.json"), []);
});

test("an open that produced neither a file nor a directory cannot be pinned", () => {
  // A fifo or socket opened inside the repository is a proven read whose
  // bytes cannot be replayed — refuse inside, ignore outside.
  const fsx = { statSync: () => ({ isFile: () => true }) };
  assert.throws(
    () =>
      reduceToInputs([`other\t${path.join(ROOT, "resources", "pipe")}`], ROOT, fsx),
    /neither a file nor a directory.*resources\/pipe/su,
  );
  assert.deepEqual(reduceToInputs(["other\t/tmp/pipe"], ROOT, fsx), []);
});

test("toRepoRelative keeps repository paths and drops outside ones", () => {
  assert.equal(toRepoRelative("resources/x.json", ROOT), "resources/x.json");
  assert.equal(toRepoRelative(path.join(ROOT, "resources", "x.json"), ROOT), "resources/x.json");
  // A `..`-prefixed name inside the root is a file, not a parent
  // reference: the check compares components, not string prefixes.
  assert.equal(toRepoRelative(path.join(ROOT, "..input.json"), ROOT), "..input.json");
  assert.equal(toRepoRelative(path.join(ROOT, "..dir", "x.json"), ROOT), "..dir/x.json");
  assert.equal(toRepoRelative("/etc/hostname", ROOT), null);
  assert.equal(toRepoRelative(path.join(ROOT, ".."), ROOT), null);
  assert.equal(toRepoRelative(path.join(ROOT, "..", "outside"), ROOT), null);
});

test("a file read of a ..-prefixed name inside the root reduces to a member", () => {
  const file = { statSync: () => ({ isFile: () => true }) };
  assert.deepEqual(reduceToInputs([`file\t${path.join(ROOT, "..input.json")}`], ROOT, file), [
    "..input.json",
  ]);
});
