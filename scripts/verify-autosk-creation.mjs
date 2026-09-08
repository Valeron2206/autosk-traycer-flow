#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  // Read by the evidence extension inside the daemon, which inherits this env.
  AUTOSK_EVIDENCE_PLAN: path.join(root, "evidence-plan.json"),
  AUTOSK_EVIDENCE_OUT: path.join(root, "evidence-results.json"),
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

/**
 * The extension this evidence runs its bound creates through.
 *
 * A bound create must name the session it came from (issue #10, criterion 7), and
 * the only place a session token exists is inside a running agent. So the CLI
 * calls this file exercises are made BY an agent, with the token in the child
 * environment — which is the supported path, and the one a model actually uses.
 * Driving the CLI directly from here would prove that an unbound create is
 * refused, which is a different fact and is checked separately below.
 */
const EVIDENCE_EXTENSION = `
import { readFile, writeFile } from "node:fs/promises";

export default function (autosk) {
  autosk.registerWorkflow({
    name: "evidence",
    firstStep: "run",
    steps: {
      run: {
        onRun: async (ctx) => {
          const plan = JSON.parse(await readFile(process.env.AUTOSK_EVIDENCE_PLAN, "utf8"));
          const results = [];
          for (const call of plan) {
            const r = await ctx.exec(["autosk", ...call.args], {
              cwd: call.cwd,
              env: {
                ...process.env,
                AUTOSK_CWD: call.cwd,
                AUTOSK_AGENT: ctx.workflows.current.step,
                AUTOSK_SESSION_TOKEN: ctx.sessionToken,
              },
            });
            results.push({ code: r.code, stdout: r.stdout, stderr: r.stderr });
            await writeFile(process.env.AUTOSK_EVIDENCE_OUT, JSON.stringify(results));
          }
          await ctx.transit({ status: "done" });
        },
      },
    },
  });
}
`;

const planPath = path.join(root, "evidence-plan.json");
const resultsPath = path.join(root, "evidence-results.json");

async function installEvidenceExtension(cwd) {
  await mkdir(path.join(cwd, ".autosk", "extensions"), { recursive: true });
  await writeFile(path.join(cwd, ".autosk", "extensions", "evidence.js"), EVIDENCE_EXTENSION);
}

/**
 * Runs a list of CLI calls inside one real session and returns their results.
 *
 * One session per batch rather than one per call: a session is what carries the
 * token, and re-enrolling for every call would prove nothing extra while making
 * the evidence slower and the failure modes harder to read.
 */
async function runInSession(calls, cwd = project) {
  await writeFile(planPath, JSON.stringify(calls));
  await writeFile(resultsPath, "[]");
  const task = JSON.parse(await cliDirect(["create", "Evidence run", "--json"], cwd));
  await cliDirect(["enroll", task.id, "--workflow", "evidence", "--json"], cwd);
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const view = JSON.parse(await cliDirect(["show", task.id, "--json"], cwd));
    if (view.status === "done") break;
    if (view.status === "human" || view.status === "cancel") {
      throw new Error(`evidence session ended as ${view.status}: ${await readFile(resultsPath, "utf8")}`);
    }
    await delay(100);
  }
  const results = JSON.parse(await readFile(resultsPath, "utf8"));
  assert.equal(results.length, calls.length, `evidence session ran ${results.length} of ${calls.length} calls`);
  return results;
}

/** One CLI call inside a session, asserted the way `cliDirect` asserts one outside. */
function fromSession(result, args, expectedCode = 0) {
  assert.equal(result.code, expectedCode, `CLI ${args[0]}: ${result.stderr} ${result.stdout}`);
  return result.stdout;
}

async function cliDirect(args, cwd = project, expectedCode = 0) {
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
  // Written before `init`, because `init` is what opens the project and the
  // registry is built once at open: an extension that appears afterwards is not
  // registered until a reload.
  await installEvidenceExtension(project);
  await installEvidenceExtension(other);
  await cliDirect(["init"]);
  await cliDirect(["init"], other);

  await check("a bound create with no session behind it is refused", async () => {
    // The direct CLI call, which is what a model shelling out would make if the
    // daemon could not tell where a create came from. It is the whole reason the
    // rest of this evidence runs inside a session.
    const refused = JSON.parse(await cliDirect(args, project, 1));
    assert.equal(refused.error.details.reason, "creation_unbound_call");
    assert.equal(refused.error.details.outcome, "invalid");
  });

  let receipt;
  const firstBatch = await runInSession([
    { args, cwd: project },
    ...Array.from({ length: 10 }, () => ({ args, cwd: project })),
    { args: [...args.slice(0, 5), "c".repeat(64), ...args.slice(6)], cwd: project },
    // Same session, other project: a token names a session in ONE project.
    { args, cwd: other },
  ]);

  await check("compiled package returns exact creation receipt", async () => {
    receipt = JSON.parse(fromSession(firstBatch[0], args));
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
    for (const result of firstBatch.slice(1, 11)) {
      assert.deepEqual(JSON.parse(fromSession(result, args)), { ...receipt, outcome: "existing_same_binding" });
    }
  });

  await check("binding conflict is structured with nonzero CLI exit", async () => {
    const result = JSON.parse(fromSession(firstBatch[11], args, 1));
    assert.equal(result.error.details.outcome, "conflict");
  });

  await check("a session's token does not open another project", async () => {
    const refused = JSON.parse(fromSession(firstBatch[12], args, 1));
    assert.equal(refused.error.details.reason, "creation_unbound_call");
  });

  await check("same key in a separate project creates independently", async () => {
    const [inOther] = await runInSession([{ args, cwd: other }], other);
    assert.equal(JSON.parse(fromSession(inOther, args)).outcome, "created");
  });

  await check("SIGKILL restart preserves creation identity", async () => {
    await stopDaemon("SIGKILL");
    startDaemon();
    await ready();
    // A new session, because the old one died with the daemon — which is the
    // point of the token dying with it too.
    const [afterRestart] = await runInSession([{ args, cwd: project }]);
    assert.deepEqual(JSON.parse(fromSession(afterRestart, args)), { ...receipt, outcome: "existing_same_binding" });
  });

  await check("legacy CLI output remains available", async () => {
    // Unbound, and still allowed: only the BOUND verb needs a session, because
    // only it writes an identity a session has to be able to vouch for.
    const legacy = JSON.parse(await cliDirect(["create", "Legacy child", "--json"]));
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
