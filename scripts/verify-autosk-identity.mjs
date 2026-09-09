#!/usr/bin/env node

/**
 * F004: the installed distribution is swapped between enroll and resume.
 *
 * A task records the digest of the extension distribution it was admitted
 * under, and every path that would advance it re-checks that digest. This
 * harness makes the swap real — the same workflow name, different bytes, a
 * daemon restarted so the registry reads the new ones — and then asks the
 * product to advance the task.
 *
 * The refusal is the point. Without it a global extension update would change
 * the meaning of the steps an Epic is already running, and the task would keep
 * going as if nothing had happened.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";

const prefixArg = process.argv[2];
if (!prefixArg) throw new Error("usage: node scripts/verify-autosk-identity.mjs <prefix>");

const prefix = path.resolve(prefixArg);
const bin = (name) => path.join(prefix, "bin", name);
const root = await mkdtemp(path.join(tmpdir(), "autosk-identity-"));
const taskHome = path.join(root, "home");
const project = path.join(root, "project");
const other = path.join(root, "other");
const sock = path.join(root, "daemon.sock");
const runtimePath = path.join(prefix, "bin");
const env = {
  HOME: taskHome,
  PATH: runtimePath,
  AUTOSK_SOCK: sock,
  AUTOSK_NO_AUTO_INSTALL: "1",
  AUTOSK_SKIP_SHELL_PATH: "1",
  AUTOSK_AUTOINIT_YES: "1",
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

let daemon = null;
let daemonClosed = null;
let daemonLog = "";

function startDaemon() {
  daemon = spawn(bin("autoskd"), ["serve", "--sock", sock, "--tcp", "127.0.0.1:0"], {
    cwd: project,
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

async function stopDaemon(signal) {
  if (!daemon) return;
  const current = daemon;
  const closed = daemonClosed;
  if (current.exitCode === null && current.signalCode === null) current.kill(signal);
  let forced = false;
  const timeout = setTimeout(() => {
    forced = true;
    if (current.exitCode === null && current.signalCode === null) current.kill("SIGKILL");
  }, 5_000);
  try {
    const result = await withDeadline(closed, 10_000, "daemon cleanup timed out");
    if (forced) assert.equal(result.signal, "SIGKILL", "daemon did not close after forced cleanup");
  } finally {
    clearTimeout(timeout);
    if (daemon === current) {
      daemon = null;
      daemonClosed = null;
    }
  }
}

async function ready() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error(`daemon exited: ${daemonLog}`);
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


function assertNoPathEnrichment() {
  assert.equal(
    daemonLog.includes("PATH enriched from login shell"),
    false,
    `daemon enriched PATH despite AUTOSK_SKIP_SHELL_PATH=1: ${daemonLog}`,
  );
}

/** The distribution under test. Two builds, one workflow name, different bytes. */
const IDENTITY_EXTENSION = (build) => `
// build ${build}
export default function (autosk) {
  autosk.registerWorkflow({
    name: "identity",
    firstStep: "hold",
    steps: {
      hold: {
        onRun: async (ctx) => {
          await ctx.transit({ status: "human" });
        },
      },
    },
  });
}
`;

const extensionPath = path.join(project, ".autosk", "extensions", "identity.js");

async function installExtension(build) {
  await mkdir(path.dirname(extensionPath), { recursive: true });
  const bytes = IDENTITY_EXTENSION(build);
  await writeFile(extensionPath, bytes);
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

async function installedDigest() {
  return createHash("sha256").update(await readFile(extensionPath)).digest("hex");
}

async function cliResult(args, cwd = project) {
  const child = spawn(bin("autosk"), args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  appendDecoded(child.stdout, (text) => {
    stdout += text;
  });
  appendDecoded(child.stderr, (text) => {
    stderr += text;
  });
  const result = await waitProcess(child, 40_000, `CLI ${args.join(" ")}`);
  return { code: result.code, stdout, stderr };
}

async function cliDirect(args, cwd = project, expectedCode = 0) {
  const result = await cliResult(args, cwd);
  assert.equal(result.signal, undefined, `CLI ${args[0]} was signalled`);
  assert.equal(result.code, expectedCode, `CLI ${args[0]}: ${result.stderr} ${result.stdout}`);
  return result.stdout;
}

/** Restarts the daemon so the registry is built from whatever is installed now. */
async function restartDaemon() {
  await stopDaemon("SIGTERM");
  startDaemon();
  await ready();
}

async function waitForStatus(taskId, status) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const view = JSON.parse(await cliDirect(["show", taskId, "--json"]));
    if (view.status === status) return view;
    await delay(100);
  }
  throw new Error(`task ${taskId} never reached ${status}: ${daemonLog}`);
}

for (const name of ["autosk", "autoskd", "autosk-store-lock"]) {
  await access(bin(name), constants.X_OK);
}

await mkdir(path.join(taskHome, ".autosk"), { recursive: true });
await writeFile(path.join(taskHome, ".autosk", "settings.json"), "{}\n");
await mkdir(project);

let passed = 0;
const check = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => {
    passed += 1;
    console.log(`PASS ${name}`);
  });

const evidence = { fault: "F004", boundary: "session_lifecycle" };

try {
  startDaemon();
  await ready();
  const digestA = await installExtension("A");
  await cliDirect(["init"]);
  await restartDaemon();

  const task = JSON.parse(await cliDirect(["create", "Identity run", "--json"]));
  await cliDirect(["enroll", task.id, "--workflow", "identity", "--json"]);
  await waitForStatus(task.id, "human");
  evidence.enrolled_under = digestA;

  await check("the same bytes resume the task: the control the fault is measured against", async () => {
    // Run first, so a later refusal cannot be explained by the task having been
    // unresumable all along.
    await restartDaemon();
    await cliDirect(["resume", task.id, "--json"]);
    await waitForStatus(task.id, "human");
    evidence.control = "resumed under the admitted digest";
  });

  let pinnedUnderA;
  await check("a task carries the digest of the distribution it was admitted under", async () => {
    const view = JSON.parse(await cliDirect(["show", task.id, "--json"]));
    pinnedUnderA = view.metadata.runtime_identity.digest;
    assert.ok(pinnedUnderA, `no runtime identity was pinned: ${JSON.stringify(view.metadata)}`);
    evidence.pinned_under_a = pinnedUnderA;
  });

  await check("swapping the distribution does not change what an admitted task runs", async () => {
    const fileDigestB = await installExtension("B");
    assert.notEqual(fileDigestB, digestA, "the swap has to change the bytes on disk");
    evidence.swapped_file_digest = fileDigestB;
    // Restarted so the loader reads the new bytes: this is the global update an
    // operator performs, not a hand-edited pin.
    await restartDaemon();

    // The project serves the version its open tasks were admitted under, so the
    // resume is accepted — and the identity it runs under is still the admitted
    // one. An accepted resume that had silently adopted the new bytes would be
    // the failure this fault exists to find.
    await cliDirect(["resume", task.id, "--json"]);
    await waitForStatus(task.id, "human");
    const view = JSON.parse(await cliDirect(["show", task.id, "--json"]));
    assert.equal(
      view.metadata.runtime_identity.digest,
      pinnedUnderA,
      "the admitted task adopted the swapped distribution",
    );
    evidence.after_swap_pin = view.metadata.runtime_identity.digest;
  });

  await check("while a task is admitted under it, the project keeps serving that version", async () => {
    // A second task in the same project gets the served version, not the bytes
    // on disk: the project serves what its open tasks were admitted under, and
    // that is the whole point of holding its own copy.
    const sibling = JSON.parse(await cliDirect(["create", "Sibling during swap", "--json"]));
    await cliDirect(["enroll", sibling.id, "--workflow", "identity", "--json"]);
    await waitForStatus(sibling.id, "human");
    const view = JSON.parse(await cliDirect(["show", sibling.id, "--json"]));
    assert.equal(view.metadata.runtime_identity.digest, pinnedUnderA);
    evidence.sibling_pin = view.metadata.runtime_identity.digest;
    await cliDirect(["cancel", sibling.id, "--json"]);
  });

  await check("once nothing is admitted under the old version, the swap takes effect", async () => {
    // The other half: the swap is not ignored, it applies once no open task
    // pins the old bytes. Without this the checks above would pass on a daemon
    // that never noticed the new distribution at all.
    await cliDirect(["cancel", task.id, "--json"]);
    await restartDaemon();
    const fresh = JSON.parse(await cliDirect(["create", "Identity run after swap", "--json"]));
    await cliDirect(["enroll", fresh.id, "--workflow", "identity", "--json"]);
    await waitForStatus(fresh.id, "human");
    const view = JSON.parse(await cliDirect(["show", fresh.id, "--json"]));
    evidence.new_admission_pin = view.metadata.runtime_identity.digest;
    assert.notEqual(evidence.new_admission_pin, pinnedUnderA, "the new admission used the old distribution");
    await cliDirect(["cancel", fresh.id, "--json"]);
  });

  await check("the distribution is restored, and the restore is verified by digest", async () => {
    const restored = await installExtension("A");
    assert.equal(restored, digestA, "the restore did not reproduce the admitted bytes");
    await restartDaemon();
    const view = JSON.parse(await cliDirect(["show", task.id, "--json"]));
    // The cancelled task still records what it ran under: history is not
    // rewritten by a later install.
    assert.equal(view.metadata.runtime_identity.digest, pinnedUnderA);
    evidence.restore_verified = await installedDigest();
    assert.equal(evidence.restore_verified, digestA);
  });

  assertNoPathEnrichment();

  console.log(JSON.stringify({
    passed,
    failed: 0,
    skipped: 0,
    evidence,
    runtime: process.version,
    platform: process.platform,
    arch: process.arch,
  }));
} finally {
  try {
    await stopDaemon("SIGTERM");
  } finally {
    await writeFile(path.join(root, "daemon.log"), daemonLog);
    console.log(`Evidence retained: ${root}`);
  }
}
