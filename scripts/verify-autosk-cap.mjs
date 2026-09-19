#!/usr/bin/env node

/**
 * The cap test for the boundary the declared quantity actually has.
 *
 * The workflow document declares `caps`: a counted transition, a limit, and
 * the park_reason the flow stops with at it. Ticket 16 made the count durable —
 * `metadata.transition_takings[from][to]` travels in the same atomic write as
 * the position — but a quantity nobody reads enforces nothing: before this
 * ticket, the counted edge was taken an eleventh time and the task never
 * parked with `review_cap`.
 *
 * What this measures is the cap term the factory now applies over the caller's
 * evaluator at both decision sites. The fixture is a review/fix cycle on the
 * shipped `buildWorkflow`: the counted edge `review -> fix` is drawn at the
 * lowest priority, so an unenforced cap keeps being taken — the defect is the
 * count reaching 11 — while an enforced one parks with `review_cap` at 10.
 * Nothing is seeded: the daemon drives every taking itself.
 *
 * Usage: node scripts/verify-autosk-cap.mjs <prefix>
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const prefixArg = process.argv[2];
if (!prefixArg) throw new Error("usage: node scripts/verify-autosk-cap.mjs <prefix>");

const prefix = path.resolve(prefixArg);
const bin = (name) => path.join(prefix, "bin", name);
const root = await mkdtemp(path.join(tmpdir(), "autosk-cap-"));
const taskHome = path.join(root, "home");
const project = path.join(root, "project");
const sock = path.join(root, "daemon.sock");

/** The pair the cap counts, and the limit after which it must not move again. */
const COUNTED_EDGE = { from: "review", to: "fix" };
const LIMIT = 10;

const env = {
  HOME: taskHome,
  PATH: path.join(prefix, "bin"),
  AUTOSK_SOCK: sock,
  AUTOSK_NO_AUTO_INSTALL: "1",
  AUTOSK_SKIP_SHELL_PATH: "1",
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * The extension under test: a review/fix cycle the shipped factory builds,
 * installed as a directory so the factory's own bytes are inside the
 * distribution the daemon identifies.
 *
 * The counted edge `review -> fix` sits at the lowest priority — the order the
 * shipped document does NOT draw, where the park edge would win first at any
 * count — because the defect being measured is the cap never consulted. Each
 * edge carries its own guard, all answered true, so the only thing that can
 * separate the counted edge from the parking one is the cap term itself.
 */
const EXTENSION = `
import { buildWorkflow } from "./workflow-factory.mjs";

const document = {
  workflow: "cap",
  first_step: "start",
  predicates: [{ id: "findings", reads: ["task_record"], description: "findings present" }],
  steps: [
    { name: "start", kind: "agent", no_transition_reason: "fixture_no_exit" },
    { name: "review", kind: "agent", no_transition_reason: "fixture_no_exit" },
    { name: "fix", kind: "agent", no_transition_reason: "fixture_no_exit" },
    { name: "human", kind: "status", status: "human" },
  ],
  guards: [
    { id: "g_start", predicate: "findings", authority: { actor: "agent" }, park_reason: "fixture_no_exit" },
    { id: "g_round", predicate: "findings", authority: { actor: "agent" }, park_reason: "fixture_no_exit" },
    { id: "g_cap", predicate: "findings", authority: { actor: "agent" }, park_reason: "review_cap" },
    { id: "g_back", predicate: "findings", authority: { actor: "agent" }, park_reason: "fixture_no_exit" },
  ],
  transitions: [
    { id: "t_start", from: "start", to: "review", priority: 0, guards: ["g_start"] },
    { id: "t_round", from: "review", to: "fix", priority: 0, guards: ["g_round"] },
    { id: "t_cap", from: "review", to: "human", priority: 1, guards: ["g_cap"] },
    { id: "t_back", from: "fix", to: "review", priority: 0, guards: ["g_back"] },
  ],
  caps: [{ cycle: "review_round", counted_transition: "t_round", limit: 10, park_reason: "review_cap" }],
  recovery: [
    { reason: "fixture_no_exit", parks_at: ["start", "review", "fix"], resume_targets: ["start", "review", "fix"], required_state: "n/a" },
    { reason: "review_cap", parks_at: ["review"], resume_targets: ["review", "fix"], required_state: "n/a" },
  ],
};

const evaluate = (predicate) => {
  if (predicate === "findings") return true;
  throw new Error(\`the test document declares no predicate \${predicate}\`);
};

export default function (autosk) {
  // This document carries no canonical digest on purpose: the factory computes
  // one and refuses a document whose own digest describes different bytes, so a
  // fixture either carries the right one or carries none.
  autosk.registerWorkflow(buildWorkflow(document, { evaluate }));
}
`;

const extensionDir = path.join(project, ".autosk", "extensions", "cap");
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

const readTask = async (id) => JSON.parse(await readFile(path.join(project, ".autosk", "tasks", id, "task.json"), "utf8"));
const takingsCount = (task, from, to) => task.metadata?.transition_takings?.[from]?.[to] ?? 0;

const evidence = { polls: [] };

try {
  startDaemon();
  await ready();
  await cli(["init"]);

  const task = JSON.parse(await cli(["create", "Cap enforcement", "--json"]));
  await cli(["enroll", task.id, "--workflow", "cap", "--json"]);

  /**
   * The flow is watched on disk, not through the CLI — `autosk` auto-spawns a
   * detached daemon whenever it finds the socket dead, and the record is the
   * thing under test anyway. The defect is the count passing the limit: on a
   * factory with no cap evaluator the cycle has no stop, and `review -> fix`
   * is taken an eleventh time without the task ever parking `review_cap`.
   */
  let record = await readTask(task.id);
  for (let attempt = 0; attempt < 2400; attempt += 1) {
    record = await readTask(task.id);
    if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error(`daemon exited: ${daemonLog}`);
    const takings = takingsCount(record, COUNTED_EDGE.from, COUNTED_EDGE.to);
    if (takings > LIMIT) {
      assert.fail(
        `the counted edge ${COUNTED_EDGE.from} -> ${COUNTED_EDGE.to} was taken ${takings} times ` +
          `against a declared limit of ${LIMIT}, and the task stands at ${record.step} ` +
          `(${record.status}) with park.reason ${record.metadata?.park?.reason ?? "none"} — ` +
          `the declared cap has no evaluator`,
      );
    }
    if (record.status === "human") break;
    await delay(50);
  }
  const onDisk = await readTask(task.id);
  const takings = takingsCount(onDisk, COUNTED_EDGE.from, COUNTED_EDGE.to);
  evidence.final = { step: onDisk.step, status: onDisk.status, park: onDisk.metadata?.park, takings: onDisk.metadata?.transition_takings };

  // The enforced shape: the decision at the limit parks with the cap's own
  // reason — a step move into the human status step, recorded before the
  // position moves — and the eleventh taking is never committed.
  assert.equal(onDisk.status, "human", `the flow must have parked at the cap: ${JSON.stringify(evidence.final)}`);
  assert.equal(
    onDisk.metadata?.park?.reason,
    "review_cap",
    `the park must name the cap's own reason: ${JSON.stringify(onDisk.metadata?.park)}`,
  );
  assert.equal(
    takings,
    LIMIT,
    `the counted edge must be taken exactly ${LIMIT} times, never ${LIMIT + 1}: ${JSON.stringify(onDisk.metadata?.transition_takings)}`,
  );

  console.log(
    JSON.stringify({
      passed: 1,
      failed: 0,
      skipped: 0,
      runtime: process.version,
      platform: process.platform,
      arch: process.arch,
      counted_edge: `${COUNTED_EDGE.from} -> ${COUNTED_EDGE.to}`,
      declared_limit: LIMIT,
      durable_takings: takings,
      final: evidence.final,
    }),
  );
  console.log("PASS cap evaluator parks the counted edge at the declared limit");
} finally {
  try {
    await stopDaemon();
  } finally {
    await writeFile(path.join(root, "daemon.log"), daemonLog);
    await writeFile(path.join(root, "results.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`Evidence retained: ${root}`);
  }
}
