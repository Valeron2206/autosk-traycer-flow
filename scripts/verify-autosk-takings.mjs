#!/usr/bin/env node

/**
 * The crash test for the boundary the transition-taking counter actually has.
 *
 * `store.setPosition` bumps `metadata.transition_takings[from][to]` in the same
 * `mutateTask` write as the position and the `step_visits` bump, and
 * `taskStore.writeTask` is one `atomicWrite` of `task.json`. So the taking, the
 * visit and the position are durable together or not at all.
 *
 * What this measures against that is the alternative section 6 of
 * `docs/contracts/workflow-factory.md` weighed and refused: a cap counted in
 * the workflow's OWN state — here, a comment the workflow writes from
 * `onTransit` each time the counted edge is admitted. That write is durable,
 * but it is not the position's write. A crash after the veto admitted the move
 * and before the position committed loses the transition: the edge is admitted
 * twice and taken once, so the workflow-side count reads two takings while the
 * store's counter — inside the atomic write — reads one.
 *
 * The instrument is the same window `verify-autosk-visits.mjs` stands on: the
 * daemon is killed from inside the last workflow code that runs before the
 * write, after the graph's veto has admitted the move and before `setPosition`
 * commits it.
 *
 * Usage: node scripts/verify-autosk-takings.mjs <prefix>
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import { reapHelpers } from "./lib/autosk-daemon.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const prefixArg = process.argv[2];
if (!prefixArg) throw new Error("usage: node scripts/verify-autosk-takings.mjs <prefix>");

const prefix = path.resolve(prefixArg);
const bin = (name) => path.join(prefix, "bin", name);
const root = await mkdtemp(path.join(tmpdir(), "autosk-takings-"));
const taskHome = path.join(root, "home");
const project = path.join(root, "project");
const sock = path.join(root, "daemon.sock");
const observedPath = path.join(root, "observed.json");
const crashedPath = path.join(root, "crashed.json");

/** The step whose transition out is killed, and the step it never reaches. */
const CRASHES_AT = "work_once";
const NEVER_REACHED_FIRST_TRY = "settle";
/** The edge the fixture's workflow-side counter counts. */
const COUNTED_EDGE = { from: "work_once", to: "settle" };
const MARKER = `took ${COUNTED_EDGE.from} -> ${COUNTED_EDGE.to}`;

const env = {
  HOME: taskHome,
  PATH: path.join(prefix, "bin"),
  AUTOSK_SOCK: sock,
  AUTOSK_NO_AUTO_INSTALL: "1",
  AUTOSK_SKIP_SHELL_PATH: "1",
  AUTOSK_TAKINGS_OUT: observedPath,
  AUTOSK_TAKINGS_CRASHED: crashedPath,
  AUTOSK_TAKINGS_CRASH_AT: CRASHES_AT,
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a pid still exists, which is what the daemon's own lock asks. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function withDeadline(promise, timeoutMs, message) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}

function appendDecoded(stream, append) {
  const decoder = new TextDecoder();
  stream.on("data", (chunk) => append(decoder.decode(chunk, { stream: true })));
  stream.on("end", () => {
    const tail = decoder.decode();
    if (tail) append(tail);
  });
}

function processClosed(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function waitProcess(child, timeoutMs, label) {
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const result = await withDeadline(processClosed(child), timeoutMs + 5_000, `${label} cleanup timed out`);
    if (timedOut) throw new Error(`${label} timed out`);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

for (const name of ["autosk", "autoskd"]) {
  await access(bin(name), constants.X_OK);
}

await mkdir(path.join(taskHome, ".autosk"), { recursive: true });
await writeFile(path.join(taskHome, ".autosk", "settings.json"), "{}\n");
await mkdir(project, { recursive: true });
await writeFile(observedPath, "[]\n");

/**
 * The extension under test: a workflow the shipped factory builds from a graph
 * document, installed as a directory so the factory's own bytes are inside the
 * distribution the daemon identifies.
 *
 * The graph is the same line `verify-autosk-visits.mjs` drives, and the crash
 * is injected at the same place: around the built `onTransit`, after the veto
 * admits the move and before the position commits. What differs is the
 * workflow-side counter: every admission of `work_once -> settle` writes a
 * comment — the SDK-named place a workflow keeps state — BEFORE the kill
 * check, because a counter outside the position's write cannot know the commit
 * is about to be lost. The daemon dies once; the edge is admitted twice.
 */
const EXTENSION = `
import { readFile, writeFile } from "node:fs/promises";

import { buildWorkflow } from "./workflow-factory.mjs";

const CRASH_AT = process.env.AUTOSK_TAKINGS_CRASH_AT;
const COUNTED = { from: "work_once", to: "settle" };
const MARKER = "took work_once -> settle";

const document = {
  workflow: "takings",
  first_step: "start",
  predicates: [{ id: "always", reads: ["task_record"], description: "holds" }],
  steps: [
    { name: "start", kind: "agent", no_transition_reason: "fixture_no_exit" },
    { name: "work_once", kind: "agent", no_transition_reason: "fixture_no_exit" },
    { name: "settle", kind: "agent", no_transition_reason: "fixture_no_exit" },
    { name: "done", kind: "status", status: "done" },
    { name: "human", kind: "status", status: "human" },
  ],
  guards: [{ id: "g_always", predicate: "always", authority: { actor: "agent" }, park_reason: "fixture_no_exit" }],
  transitions: [
    { id: "t_start", from: "start", to: "work_once", priority: 0, guards: ["g_always"] },
    { id: "t_settle", from: "work_once", to: "settle", priority: 0, guards: ["g_always"] },
    { id: "t_done", from: "settle", to: "done", priority: 0, guards: ["g_always"] },
  ],
  caps: [],
  recovery: [
    { reason: "fixture_no_exit", parks_at: ["work_once"], resume_targets: ["settle", "work_once"], required_state: "n/a" },
  ],
};

const evaluate = (predicate) => {
  if (predicate === "always") return true;
  throw new Error(\`the test document declares no predicate \${predicate}\`);
};

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
};

/** What one run of a step saw before it decided. */
const observing = (name) => async (ctx) => {
  const task = await ctx.tasks.current();
  const seen = await readJson(process.env.AUTOSK_TAKINGS_OUT, []);
  seen.push({
    run: seen.length + 1,
    ran: name,
    step: task.step,
    status: task.status,
    visits: task.metadata?.step_visits ?? {},
    takings: task.metadata?.transition_takings ?? {},
  });
  await writeFile(process.env.AUTOSK_TAKINGS_OUT, JSON.stringify(seen));
};

export default function (autosk) {
  // This document carries no canonical digest on purpose: the factory computes
  // one and refuses a document whose own digest describes different bytes, so a
  // fixture either carries the right one or carries none.
  const workflow = buildWorkflow(document, {
    evaluate,
    agents: { start: observing("start"), work_once: observing("work_once"), settle: observing("settle") },
  });
  autosk.registerWorkflow({
    ...workflow,
    onTransit: async (ctx, to) => {
      await workflow.onTransit(ctx, to);
      // The workflow-side counter: every admitted taking of the counted edge is
      // recorded in the workflow's own state, which is durable — but not in the
      // position's write. Recorded for every admission, because a counter
      // outside the write cannot know this admission is the one a crash loses.
      if ("step" in to && ctx.step === COUNTED.from && to.step === COUNTED.to) {
        await ctx.comment(MARKER);
      }
      const already = await readJson(process.env.AUTOSK_TAKINGS_CRASHED, null);
      if (already || ctx.step !== CRASH_AT) return;
      const seen = await readJson(process.env.AUTOSK_TAKINGS_OUT, []);
      // Recorded before the kill, because after it there is no chance to.
      await writeFile(
        process.env.AUTOSK_TAKINGS_CRASHED,
        JSON.stringify({
          run: seen.length,
          leaving: ctx.step,
          to,
          pid: process.pid,
          visits_seen: seen.at(-1).visits,
          takings_seen: seen.at(-1).takings,
        }),
      );
      process.kill(process.pid, "SIGKILL");
    },
  });
}
`;

const extensionDir = path.join(project, ".autosk", "extensions", "takings");
await mkdir(extensionDir, { recursive: true });
await writeFile(path.join(extensionDir, "index.js"), EXTENSION);
// Both files: the factory imports the canonical form, and an extension missing
// one of them does not load at all.
await copyFile(path.join(ROOT, "src/host/workflow-factory.mjs"), path.join(extensionDir, "workflow-factory.mjs"));
await copyFile(
  path.join(ROOT, "src/host/workflow-graph-canonical.mjs"),
  path.join(extensionDir, "workflow-graph-canonical.mjs"),
);

let daemon;
let daemonClosed;
let daemonLog = "";

function startDaemon() {
  daemon = spawn(bin("autoskd"), ["serve", "--sock", sock, "--tcp", "127.0.0.1:0"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemonClosed = processClosed(daemon);
  appendDecoded(daemon.stdout, (text) => {
    daemonLog += text;
  });
  appendDecoded(daemon.stderr, (text) => {
    daemonLog += text;
  });
}

async function ready() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (daemon && (daemon.exitCode !== null || daemon.signalCode !== null)) throw new Error(`daemon exited: ${daemonLog}`);
    try {
      const socket = createConnection(sock);
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.destroy();
      return;
    } catch (error) {
      if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
    }
    await delay(50);
  }
  throw new Error(`daemon readiness timed out: ${daemonLog}`);
}

async function stopDaemon() {
  if (daemon && (daemon.exitCode === null || daemon.signalCode === null)) {
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGTERM");
    const timeout = setTimeout(() => {
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
    }, 5_000);
    try {
      await withDeadline(daemonClosed, 10_000, "daemon cleanup timed out");
    } finally {
      clearTimeout(timeout);
    }
  }
  // A daemon the CLI auto-spawned after the crash is detached and is not this
  // process's child, so it is stopped through the pid its own lock records.
  const adopted = await lockedPid();
  if (adopted !== undefined && pidAlive(adopted)) {
    process.kill(adopted, "SIGTERM");
    for (let attempt = 0; attempt < 300 && pidAlive(adopted); attempt += 1) await delay(10);
    if (pidAlive(adopted)) process.kill(adopted, "SIGKILL");
  }
}

/** The pid holding the daemon's single-instance lock, if one is held. */
async function lockedPid() {
  try {
    const pid = Number.parseInt(await readFile(`${sock}.lock`, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function cli(args, expectedCode = 0) {
  const child = spawn(bin("autosk"), args, { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  appendDecoded(child.stdout, (text) => {
    stdout += text;
  });
  appendDecoded(child.stderr, (text) => {
    stderr += text;
  });
  const result = await waitProcess(child, 20_000, `CLI ${args.join(" ")}`);
  assert.equal(result.signal, null, `CLI ${args[0]} terminated by ${result.signal}: ${stdout} ${stderr}`);
  assert.equal(result.code, expectedCode, `CLI ${args.join(" ")}: ${stdout} ${stderr}`);
  return stdout;
}

const readObserved = async () => JSON.parse(await readFile(observedPath, "utf8"));
const readTask = async (id) => JSON.parse(await readFile(path.join(project, ".autosk", "tasks", id, "task.json"), "utf8"));
const visitsOf = (task) => task.metadata?.step_visits ?? {};
const takingsOf = (task) => task.metadata?.transition_takings ?? {};
const takingsCount = (task, from, to) => task.metadata?.transition_takings?.[from]?.[to] ?? 0;

/** The workflow-side counter: marker comments in `comments.jsonl`. */
async function markerCount(id) {
  let text = "";
  try {
    text = await readFile(path.join(project, ".autosk", "tasks", id, "comments.jsonl"), "utf8");
  } catch {
    return 0;
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter((comment) => comment.text === MARKER).length;
}

const evidence = { restarts: [], resumes: [], observed: [] };

try {
  startDaemon();
  await ready();
  await cli(["init"]);

  const task = JSON.parse(await cli(["create", "Takings durability", "--json"]));
  await cli(["enroll", task.id, "--workflow", "takings", "--json"]);

  /** What the record on disk said the moment the daemon was gone. */
  let afterCrash = null;
  const alive = () => daemon !== null && daemon.exitCode === null && daemon.signalCode === null;

  /**
   * Reads the daemon's dying and brings it back.
   *
   * The record is read from disk before the replacement starts, because what is
   * being measured is what the crash left behind and a running daemon is free to
   * write to it.
   */
  async function recover() {
    const dead = daemon.pid;
    const closed = await daemonClosed;
    evidence.restarts.push({ signal: closed.signal, code: closed.code, at: await readFile(crashedPath, "utf8") });
    if (evidence.restarts.length > 1) throw new Error("the daemon died more than once");
    // The single-instance lock holds a pid and treats a live one as a running
    // daemon, and a killed child stays a zombie until it is reaped — which can
    // land after its streams close. So wait for the pid itself to go, rather
    // than for the event that usually means it has.
    for (let attempt = 0; attempt < 300 && pidAlive(dead); attempt += 1) await delay(10);
    if (pidAlive(dead)) throw new Error(`the killed daemon ${dead} was never reaped`);
    // And the native helper it left holding the store lock. Without this the
    // replacement daemon waits for a lock nobody will release and the run dies
    // with a readiness timeout that names neither the crash nor the orphan.
    evidence.reapedHelpers = await reapHelpers(project);
    // The socket and the single-instance lock outlive a SIGKILL. The daemon
    // reclaims a lock whose holder is dead, and the CLI would auto-spawn one to
    // do it — but then two daemons race for the same lock and the loser's exit
    // reaches the CLI as a broken pipe. The holder is provably dead by here, so
    // the replacement is started from one place with the leftovers cleared.
    for (const leftover of [sock, `${sock}.lock`, `${sock}.lock.break`]) {
      await rm(leftover, { force: true });
    }
    startDaemon();
    await ready();
  }

  /**
   * The flow is watched on disk, not through the CLI.
   *
   * `autosk` auto-spawns a detached daemon whenever it finds the socket dead
   * (`internal/daemon/rpcclient/connector.go`), so polling with `show` was
   * itself starting the replacement — and the replacement finished the flow
   * before the harness had read what the crash left behind. The record on disk
   * is the thing under test anyway; reading it wakes nobody. The only CLI call
   * left in the loop is the resume, and it is made only while a daemon is up.
   */
  let record = await readTask(task.id);
  for (let attempt = 0; attempt < 900; attempt += 1) {
    record = await readTask(task.id);
    if (!alive()) {
      afterCrash ??= { ...record, closed: await daemonClosed, markers: await markerCount(task.id) };
      await recover();
      // One call, to make the replacement adopt the project. A daemon opens a
      // project when something asks it to, and disk polling asks nothing — so
      // without this the restarted daemon sits idle and the task waits at the
      // step the crash left it on. Safe here in a way the polling was not: the
      // daemon is up, so this cannot be the call that spawns one.
      await cli(["show", task.id, "--json"]);
      continue;
    }
    if (record.status === "done" || record.status === "cancel") break;
    if (record.status === "human") {
      evidence.resumes.push({ step: record.step, visits: visitsOf(record), takings: takingsOf(record) });
      if (evidence.resumes.length > 3) throw new Error(`parked repeatedly: ${JSON.stringify(evidence.resumes)}`);
      await cli(["resume", task.id, "--json"]);
    }
    await delay(50);
  }
  const view = record;

  const observed = await readObserved();
  const onDisk = await readTask(task.id);
  const crashed = JSON.parse(await readFile(crashedPath, "utf8"));
  evidence.observed = observed;
  const markers = await markerCount(task.id);

  // The kill landed where it was aimed: leaving the chosen step, with the daemon
  // dying from the signal rather than exiting.
  assert.equal(crashed.leaving, CRASHES_AT);
  assert.deepEqual(crashed.to, { step: NEVER_REACHED_FIRST_TRY }, "the lost transition must be one the graph admitted");
  assert.equal(evidence.restarts.length, 1, "the daemon must have died exactly once");
  assert.equal(afterCrash.closed.signal, "SIGKILL", "the daemon must die from the signal, not exit");
  assert.equal(afterCrash.closed.code, null);

  // Neither half of the write landed. The decision to leave had been taken and
  // admitted; the record on disk knows nothing about it — same position, same
  // counters, and no entry at all for the edge it was about to take.
  assert.equal(afterCrash.step, CRASHES_AT, "the position must not have moved");
  assert.deepEqual(
    afterCrash.metadata?.step_visits ?? {},
    crashed.visits_seen,
    "the visit counter must not have moved — it travels in the same write",
  );
  assert.deepEqual(
    afterCrash.metadata?.transition_takings ?? {},
    crashed.takings_seen,
    "the taking counter must not have moved either — same write, same boundary",
  );
  assert.equal(
    takingsCount(afterCrash, COUNTED_EDGE.from, COUNTED_EDGE.to),
    0,
    "a transition that did not land must not be counted as taken",
  );
  // But the workflow-side counter already moved: one durable marker for a taking
  // the store never recorded. The asymmetry a cap counted this way would have.
  assert.equal(afterCrash.markers, 1, "the workflow-side count must already stand at 1 for a taking that did not land");

  assert.equal(view.status, "done", `the flow must finish: ${JSON.stringify(view)}`);

  // At-least-once execution: the step whose transition was lost did its work
  // again, while the flow left it exactly once.
  const runsOf = (name) => observed.filter((entry) => entry.ran === name).length;
  assert.equal(runsOf(CRASHES_AT), 2, `${CRASHES_AT} must have run twice: ${JSON.stringify(observed)}`);
  assert.equal(runsOf(NEVER_REACHED_FIRST_TRY), 1, `${NEVER_REACHED_FIRST_TRY} must have run once`);

  // What the crash proved. The counted edge was ADMITTED twice — once before the
  // kill, once on the re-run — and COMMITTED once. The store counter reads the
  // committed truth; the workflow-side counter read admissions.
  const takings = takingsOf(onDisk);
  assert.equal(
    takingsCount(onDisk, COUNTED_EDGE.from, COUNTED_EDGE.to),
    1,
    `the store must count exactly one durable taking of ${COUNTED_EDGE.from} -> ${COUNTED_EDGE.to}: ${JSON.stringify(takings)}`,
  );
  assert.equal(
    markers,
    2,
    `the workflow-side counter must double-count the lost-and-retried edge (admitted twice, taken once): ${markers} markers`,
  );

  // And the whole map is exact: every edge the flow committed is counted once —
  // the enroll entry counted a visit but no taking, and no other edge exists.
  // One entry is conditional on how the crash settled: if the task parked and
  // the harness's bare resume re-entered the step it stood at, that resume is
  // itself a committed work_once -> work_once taking — a self-edge the store
  // counts like any other. The visits script records the settlement rather
  // than demanding it, and so does this one.
  const expected = {
    start: { work_once: 1 },
    work_once: { settle: 1 },
    settle: { done: 1 },
  };
  const selfResumes = evidence.resumes.filter((entry) => entry.step === CRASHES_AT).length;
  if (selfResumes > 0) expected.work_once.work_once = selfResumes;
  assert.deepEqual(takings, expected);

  // The visit counter's boundary is unchanged: a step is entered once per landed
  // transition, never more often than it runs.
  const visits = onDisk.metadata?.step_visits ?? {};
  for (const name of ["start", CRASHES_AT, NEVER_REACHED_FIRST_TRY]) {
    const entries = visits[name] ?? 0;
    assert.ok(entries >= 1, `${name}: never entered`);
    assert.ok(entries <= runsOf(name), `${name}: ${entries} durable entries against ${runsOf(name)} runs`);
  }
  for (const name of ["start", NEVER_REACHED_FIRST_TRY]) {
    assert.equal(visits[name], runsOf(name), `${name} is outside the crash window and must agree exactly`);
  }
  assert.equal(onDisk.status, "done");

  // And no counter ever fell between one run and the next. A count that went
  // backwards would mean a write landed with a stale metadata bag, which is the
  // other way "durable together" could be false.
  for (let i = 1; i < observed.length; i += 1) {
    for (const [name, count] of Object.entries(observed[i - 1].visits)) {
      assert.ok(
        (observed[i].visits[name] ?? 0) >= count,
        `run ${i + 1} saw ${name} fall from ${count}: ${JSON.stringify(observed)}`,
      );
    }
    for (const [from, inner] of Object.entries(observed[i - 1].takings)) {
      for (const [to, count] of Object.entries(inner)) {
        assert.ok(
          (observed[i].takings[from]?.[to] ?? 0) >= count,
          `run ${i + 1} saw ${from} -> ${to} fall from ${count}: ${JSON.stringify(observed)}`,
        );
      }
    }
  }

  console.log(
    JSON.stringify({
      passed: 1,
      failed: 0,
      skipped: 0,
      runtime: process.version,
      platform: process.platform,
      arch: process.arch,
      durable_takings: takings,
      durable_entries: visits,
      workflow_side_markers: markers,
      counted_edge: `${COUNTED_EDGE.from} -> ${COUNTED_EDGE.to}`,
      step_runs: observed.length,
      crash: crashed,
      after_crash: {
        step: afterCrash.step,
        status: afterCrash.status,
        visits: afterCrash.metadata?.step_visits ?? {},
        takings: afterCrash.metadata?.transition_takings ?? {},
        workflow_side_markers: afterCrash.markers,
      },
      parked_and_resumed: evidence.resumes,
      observed,
    }),
  );
  console.log("PASS transition-taking counter durability");
} finally {
  try {
    await stopDaemon();
  } finally {
    await writeFile(path.join(root, "daemon.log"), daemonLog);
    await writeFile(path.join(root, "results.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`Evidence retained: ${root}`);
  }
}
