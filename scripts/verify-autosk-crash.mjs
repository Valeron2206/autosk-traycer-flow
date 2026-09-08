#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";

const prefixArg = process.argv[2];
if (!prefixArg) throw new Error("usage: node scripts/verify-autosk-crash.mjs <prefix>");

const prefix = path.resolve(prefixArg);
const bin = (name) => path.join(prefix, "bin", name);
const root = await mkdtemp(path.join(tmpdir(), "autosk-crash-"));
const taskHome = path.join(root, "home");
const sock = path.join(root, "daemon.sock");
const planPath = path.join(root, "fault.json");
const proxyPath = path.join(root, "fault-helper.mjs");
const runtimePath = path.join(prefix, "bin");
const env = {
  HOME: taskHome,
  PATH: runtimePath,
  AUTOSK_SOCK: sock,
  AUTOSK_STORE_LOCK_BIN: proxyPath,
  AUTOSK_NO_AUTO_INSTALL: "1",
  AUTOSK_SKIP_SHELL_PATH: "1",
  // Read by the evidence extension inside the daemon, which inherits this env.
  AUTOSK_EVIDENCE_PLAN: path.join(root, "evidence-plan.json"),
  AUTOSK_EVIDENCE_OUT: path.join(root, "evidence-results.json"),
  AUTOSK_FAULT_PLAN: planPath,
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

for (const name of ["autosk", "autoskd", "autosk-store-lock"]) {
  await access(bin(name), constants.X_OK);
}

await mkdir(path.join(taskHome, ".autosk"), { recursive: true });
await writeFile(path.join(taskHome, ".autosk", "settings.json"), "{}\n");
await writeFile(planPath, "{}\n");
await writeFile(proxyPath, `#!${process.execPath}
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { TextDecoder } from "node:util";

const path = ${JSON.stringify(planPath)};
const child = spawn(${JSON.stringify(bin("autosk-store-lock"))}, process.argv.slice(2), {
  stdio: ["pipe", "pipe", "pipe"],
});
const requestDecoder = new TextDecoder();
const responseDecoder = new TextDecoder();
let requestBuffer = "";
let responseBuffer = "";
let current = null;
let indexWrites = 0;
let injecting = false;
let failed = false;
let faultHit = null;

const watchdog = setTimeout(() => {
  fail(new Error("fault helper timed out"));
}, 15_000);

function readPlan() {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(error) {
  if (failed) return;
  failed = true;
  process.stderr.write(String(error?.stack ?? error) + "\\n");
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function inject(edge, response) {
  const point = current?.point ? current.point + "." + edge : null;
  if (point !== readPlan().point) return false;
  injecting = true;
  faultHit = {
    hit: point,
    request: current.request,
    response,
    nativePid: child.pid,
    requestedSignal: "SIGKILL",
  };
  faultHit.killReturned = child.kill("SIGKILL");
  writeFileSync(path, JSON.stringify(faultHit), { mode: 0o600 });
  return true;
}

function parseLine(line, channel) {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(\`invalid \${channel} JSON: \${error.message}: \${line.slice(0, 200)}\`);
  }
}

function handleRequestText(text) {
  requestBuffer += text;
  let end;
  while ((end = requestBuffer.indexOf("\\n")) >= 0) {
    const line = requestBuffer.slice(0, end);
    requestBuffer = requestBuffer.slice(end + 1);
    if (!line) continue;
    const request = parseLine(line, "request");
    let point;
    if (request.op === "write_creation_index") point = ++indexWrites === 1 ? "reservation" : "activation";
    if (request.op === "write_task") point = "task";
    current = { request, point };
    if (!inject("before")) child.stdin.write(line + "\\n");
  }
}

function handleResponseText(text) {
  responseBuffer += text;
  let end;
  while ((end = responseBuffer.indexOf("\\n")) >= 0) {
    const line = responseBuffer.slice(0, end);
    responseBuffer = responseBuffer.slice(end + 1);
    if (!line) continue;
    const response = parseLine(line, "response");
    if (current && response.id === current.request.id && response.ok === true && inject("after", response)) continue;
    process.stdout.write(line + "\\n");
  }
}

child.on("error", fail);
child.stdin.on("error", (error) => {
  if (!injecting || error.code !== "EPIPE") fail(error);
});
child.stderr.pipe(process.stderr);
process.stdin.on("data", (chunk) => {
  try {
    handleRequestText(requestDecoder.decode(chunk, { stream: true }));
  } catch (error) {
    fail(error);
  }
});
process.stdin.on("end", () => {
  try {
    const tail = requestDecoder.decode();
    if (tail) handleRequestText(tail);
    child.stdin.end();
  } catch (error) {
    fail(error);
  }
});
process.stdin.on("error", fail);
child.stdout.on("data", (chunk) => {
  try {
    handleResponseText(responseDecoder.decode(chunk, { stream: true }));
  } catch (error) {
    fail(error);
  }
});
child.stdout.on("end", () => {
  try {
    const tail = responseDecoder.decode();
    if (tail) handleResponseText(tail);
  } catch (error) {
    fail(error);
  }
});
child.on("close", (code, signal) => {
  clearTimeout(watchdog);
  if (faultHit) {
    faultHit.nativeCloseCode = code;
    faultHit.nativeCloseSignal = signal;
    faultHit.proxyFailed = failed;
    writeFileSync(path, JSON.stringify(faultHit), { mode: 0o600 });
  }
  process.exit(failed ? 88 : injecting ? 86 : code ?? 1);
});
`);
await chmod(proxyPath, 0o755);

let daemonLog = "";
const daemon = spawn(bin("autoskd"), ["serve", "--sock", sock, "--tcp", "127.0.0.1:0"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
const daemonClosed = processClosed(daemon);
appendDecoded(daemon.stdout, (text) => {
  daemonLog += text;
});
appendDecoded(daemon.stderr, (text) => {
  daemonLog += text;
});

async function ready() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
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

async function stopDaemon() {
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

async function cli(cwd, args, expectedCode = 0) {
  const child = spawn(bin("autosk"), args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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
  assert.equal(result.code, expectedCode, `CLI ${args[0]}: ${stdout} ${stderr}`);
  return stdout;
}

/**
 * The extension this evidence drives each fault point through.
 *
 * A bound create must name the session it came from (issue #10, criterion 7), so
 * the CLI calls have to be made by an agent with the token in the child
 * environment. Arming and disarming the fault happens INSIDE the agent for a
 * reason that is not convenience: the session's own writes — creating the
 * evidence task, enrolling it — are `write_task` calls, and a fault armed before
 * them would fire on the wrong one. Between the arm and the disarm the only
 * store writes are the bound create's.
 */
const EVIDENCE_EXTENSION = `
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export default function (autosk) {
  autosk.registerWorkflow({
    name: "evidence",
    firstStep: "run",
    steps: {
      run: {
        onRun: async (ctx) => {
          const plan = JSON.parse(await readFile(process.env.AUTOSK_EVIDENCE_PLAN, "utf8"));
          const results = [];
          const record = async (value) => {
            results.push(value);
            await writeFile(process.env.AUTOSK_EVIDENCE_OUT, JSON.stringify(results));
          };
          for (const step of plan) {
            if (step.arm !== undefined) {
              await writeFile(process.env.AUTOSK_FAULT_PLAN, JSON.stringify(step.arm));
              await record({ armed: step.arm });
              continue;
            }
            if (step.read !== undefined) {
              try {
                await record({ read: JSON.parse(await readFile(step.read, "utf8")) });
              } catch (error) {
                await record({ read: null, code: error.code });
              }
              continue;
            }
            const r = await ctx.exec(["autosk", ...step.args], {
              cwd: step.cwd,
              env: {
                ...process.env,
                AUTOSK_CWD: step.cwd,
                AUTOSK_AGENT: ctx.workflows.current.step,
                AUTOSK_SESSION_TOKEN: ctx.sessionToken,
              },
            });
            await record({ code: r.code, stdout: r.stdout, stderr: r.stderr });
          }
          await ctx.transit({ status: "done" });
        },
      },
    },
  });
}
`;

async function installEvidenceExtension(cwd) {
  await mkdir(path.join(cwd, ".autosk", "extensions"), { recursive: true });
  await writeFile(path.join(cwd, ".autosk", "extensions", "evidence.js"), EVIDENCE_EXTENSION);
}

/** Runs a plan inside one real session and returns what each step produced. */
async function runInSession(cwd, plan) {
  await writeFile(path.join(root, "evidence-plan.json"), JSON.stringify(plan));
  await writeFile(path.join(root, "evidence-results.json"), "[]");
  const task = JSON.parse(await cli(cwd, ["create", "Evidence run", "--json"]));
  await cli(cwd, ["enroll", task.id, "--workflow", "evidence", "--json"]);
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const view = JSON.parse(await cli(cwd, ["show", task.id, "--json"]));
    if (view.status === "done") break;
    if (view.status === "human" || view.status === "cancel") {
      throw new Error(`evidence session ended as ${view.status}: ${await readFile(path.join(root, "evidence-results.json"), "utf8")}`);
    }
    await delay(100);
  }
  const results = JSON.parse(await readFile(path.join(root, "evidence-results.json"), "utf8"));
  assert.equal(results.length, plan.length, `evidence session ran ${results.length} of ${plan.length} steps`);
  return { results, taskId: task.id };
}

/** One CLI result from inside a session, asserted the way `cli` asserts one outside. */
function fromSession(result, args, expectedCode = 0) {
  assert.equal(result.code, expectedCode, `CLI ${args[0]}: ${result.stdout} ${result.stderr}`);
  return result.stdout;
}

const evidence = [];

try {
  await ready();
  for (const point of [
    "reservation.before",
    "reservation.after",
    "task.before",
    "task.after",
    "activation.before",
    "activation.after",
  ]) {
    const cwd = path.join(root, point);
    await mkdir(cwd);
    // Written before `init`, because `init` opens the project and the registry
    // is built once at open.
    await installEvidenceExtension(cwd);
    await cli(cwd, ["init"]);

    const key = `flow:${createHash("sha256").update(point).digest("hex")}`;
    const hash = createHash("sha256").update(`${point}:binding`).digest("hex");
    const args = ["create", "Crash child", "--creation-key", key, "--creation-binding-hash", hash, "--json"];
    const indexPath = path.join(cwd, ".autosk", "creation", "v1", "index.json");

    const session = await runInSession(cwd, [
      { arm: { point } },
      { args, cwd },
      { read: planPath },
      { read: indexPath },
      { arm: {} },
      { args, cwd },
    ]);
    const [, faulted, hitStep, indexStep, , recovered] = session.results;

    assert(JSON.parse(fromSession(faulted, args, 1)).error, "fault must surface as an error");

    const hit = hitStep.read;
    assert.equal(hit.hit, point, "the selected native persistence boundary must be reached");
    assert.equal(hit.requestedSignal, "SIGKILL", "fault helper must request SIGKILL");
    assert.equal(hit.killReturned, true, "native writer must receive the requested signal");
    assert.equal(hit.nativeCloseSignal, "SIGKILL", "native writer must actually close from SIGKILL");
    assert.equal(hit.nativeCloseCode, null, "native writer must not exit normally");
    assert.equal(hit.proxyFailed, false, "fault proxy must complete without an unrelated error");
    if (point.endsWith(".after")) assert.equal(hit.response.ok, true, "native write must acknowledge fsync before injection");

    const previousId = indexStep.read
      ? Object.values(indexStep.read.reservations)[0]?.task_id
      : undefined;

    const result = JSON.parse(fromSession(recovered, args));
    if (previousId) assert.equal(result.task.id, previousId);
    const expectedOutcome = ["task.after", "activation.before", "activation.after"].includes(point)
      ? "existing_same_binding"
      : "created";
    assert.equal(result.outcome, expectedOutcome);
    assert.equal(result.task.creation_key, key);
    assert.equal(result.task.creation_binding_hash, hash);

    // Two tasks, both accounted for: the child this point is about, and the
    // evidence session's own task — which exists because a bound create must now
    // come from a session. Anything else is an orphan, which is what this checks.
    const tasks = await readdir(path.join(cwd, ".autosk", "tasks"));
    assert.deepEqual(tasks.sort(), [result.task.id, session.taskId].sort());
    const onDisk = JSON.parse(await readFile(path.join(cwd, ".autosk", "tasks", result.task.id, "task.json"), "utf8"));
    assert.equal(onDisk.creation_key, key);
    assert.equal(onDisk.creation_binding_hash, hash);
    assert.throws(() => process.kill(hit.nativePid, 0), { code: "ESRCH" }, "injected native writer must be reaped");

    evidence.push({
      point,
      previousId,
      taskId: result.task.id,
      outcome: result.outcome,
      nativeAcknowledged: hit.response?.ok === true,
      nativeCloseCode: hit.nativeCloseCode,
      nativeCloseSignal: hit.nativeCloseSignal,
      killReturned: hit.killReturned,
    });
    console.log(`PASS ${point}`);
  }

  console.log(JSON.stringify({
    passed: evidence.length,
    failed: 0,
    skipped: 0,
    runtime: process.version,
    platform: process.platform,
    arch: process.arch,
    cases: evidence,
  }));
} finally {
  try {
    await stopDaemon();
  } finally {
    await writeFile(path.join(root, "daemon.log"), daemonLog);
    await writeFile(path.join(root, "results.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`Evidence retained: ${root}`);
  }
}
