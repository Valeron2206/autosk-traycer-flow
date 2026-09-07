#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";

const prefixArg = process.argv[2];
if (!prefixArg) throw new Error("usage: node scripts/verify-autosk-creation.mjs <prefix>");

const prefix = path.resolve(prefixArg);
const bin = (name) => path.join(prefix, "bin", name);
const root = await mkdtemp(path.join(tmpdir(), "autosk-creation-"));
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

async function cli(args, cwd = project, expectedCode = 0) {
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
  assert.equal(result.signal, null, `CLI ${args[0]} terminated by ${result.signal}: ${stderr} ${stdout}`);
  assert.equal(result.code, expectedCode, `CLI ${args[0]}: ${stderr} ${stdout}`);
  return stdout;
}

function assertNoPathEnrichment() {
  assert.equal(
    daemonLog.includes("PATH enriched from login shell"),
    false,
    `daemon enriched PATH despite AUTOSK_SKIP_SHELL_PATH=1: ${daemonLog}`,
  );
}

for (const name of ["autosk", "autoskd", "autosk-store-lock"]) {
  await access(bin(name), constants.X_OK);
}

await mkdir(path.join(taskHome, ".autosk"), { recursive: true });
await writeFile(path.join(taskHome, ".autosk", "settings.json"), "{}\n");
await mkdir(project);
await mkdir(other);

for (const dir of env.PATH.split(":")) {
  for (const name of ["bun", "go"]) {
    let exists = true;
    try {
      await access(path.join(dir, name), constants.X_OK);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      exists = false;
    }
    assert.equal(exists, false, `${name} is available in runtime PATH`);
  }
}

let passed = 0;
const check = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => {
    passed += 1;
    console.log(`PASS ${name}`);
  });
const key = `flow:${"a".repeat(64)}`;
const hash = "b".repeat(64);
const args = ["create", "Atomic child", "--creation-key", key, "--creation-binding-hash", hash, "--json"];

try {
  startDaemon();
  await ready();
  await cli(["init"]);
  await cli(["init"], other);

  let receipt;
  await check("compiled package returns exact creation receipt", async () => {
    receipt = JSON.parse(await cli(args));
    assert.equal(receipt.outcome, "created");
    assert.deepEqual(Object.keys(receipt).sort(), ["outcome", "task"]);
    assert.deepEqual(Object.keys(receipt.task).sort(), [
      "blocked_by",
      "creation_binding_hash",
      "creation_key",
      "description",
      "id",
      "status",
      "step",
      "title",
      "workflow",
    ]);
    assert.equal(receipt.task.creation_key, key);
    assert.equal(receipt.task.creation_binding_hash, hash);
    assert.deepEqual(receipt.task.blocked_by, []);
  });

  await check("ten real CLI retries return one task", async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 10 }, () => cli(args).then(JSON.parse)));
    const failures = attempts.filter((attempt) => attempt.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `${failures.length} CLI retries failed`,
      );
    }
    const replies = attempts.map((attempt) => attempt.value);
    for (const reply of replies) assert.deepEqual(reply, { ...receipt, outcome: "existing_same_binding" });
  });

  await check("binding conflict is structured with nonzero CLI exit", async () => {
    const changed = [...args];
    changed[5] = "c".repeat(64);
    const result = JSON.parse(await cli(changed, project, 1));
    assert.equal(result.error.details.outcome, "conflict");
  });

  await check("same key in a separate project creates independently", async () => {
    assert.equal(JSON.parse(await cli(args, other)).outcome, "created");
  });

  await check("SIGKILL restart preserves creation identity", async () => {
    await stopDaemon("SIGKILL");
    startDaemon();
    await ready();
    assert.deepEqual(JSON.parse(await cli(args)), { ...receipt, outcome: "existing_same_binding" });
  });

  await check("legacy CLI output remains available", async () => {
    const legacy = JSON.parse(await cli(["create", "Legacy child", "--json"]));
    assert.equal(legacy.title, "Legacy child");
    assert.equal(legacy.creation_key, undefined);
    assert.equal(legacy.outcome, undefined);
  });

  assertNoPathEnrichment();

  console.log(JSON.stringify({
    passed,
    failed: 0,
    skipped: 0,
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
