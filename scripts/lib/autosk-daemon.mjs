/**
 * The bits of a real-daemon harness two verifiers both need.
 *
 * `verify-autosk-crash.mjs` and `verify-autosk-creation.mjs` predate this and
 * are left alone: they carry the qualification evidence the compatibility
 * workflow archives, and rewriting them to import from here would put that
 * evidence behind a refactor nothing in this change requires. What lives here is
 * what the two verifiers added by slice 5 would otherwise say twice.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { TextDecoder } from "node:util";

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a pid still exists, which is what the daemon's own lock asks. */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function withDeadline(promise, timeoutMs, message) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}

export function appendDecoded(stream, append) {
  const decoder = new TextDecoder();
  stream.on("data", (chunk) => append(decoder.decode(chunk, { stream: true })));
  stream.on("end", () => {
    const tail = decoder.decode();
    if (tail) append(tail);
  });
}

export function processClosed(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

export async function waitProcess(child, timeoutMs, label) {
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

/**
 * One `autosk` CLI call, asserted.
 *
 * A non-zero exit is a failure of the call and not of the daemon: a caller that
 * expects the daemon to be gone catches this and says so itself.
 */
export async function cli(bin, { cwd, env }, args, expectedCode = 0) {
  const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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

/**
 * Reaps the native store helper a killed daemon left behind.
 *
 * `autosk-store-lock` is spawned as a child of the daemon and holds the
 * project's store lock. SIGKILL to the daemon orphans it, and the replacement
 * daemon then waits for a lock the orphan still holds — which surfaces as
 * "autosk-store-lock did not report readiness before timeout" some way further
 * on, in a place that says nothing about the cause. A crash test that kills a
 * daemon has to clean up after the kill, exactly as an operator would.
 *
 * Matching is on the helper's own `--root <project>`, so this only ever touches
 * a helper belonging to the run that calls it — through `realpath`, because on
 * macOS `mkdtemp` hands back `/var/folders/…` while the helper's own argv says
 * `/private/var/folders/…` for the same directory. The first writing compared
 * the two strings, matched nothing, reported an empty list and let the run fail
 * further on with the timeout it was meant to prevent.
 */
export async function reapHelpers(projectRoot) {
  const root = realpathSync(projectRoot);
  const reaped = [];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const listing = execFileSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" });
    const alive = listing
      .split("\n")
      .filter((line) => line.includes("autosk-store-lock") && line.includes(`--root ${root}`))
      .map((line) => Number.parseInt(line.trim().split(/\s+/u)[0], 10))
      .filter((pid) => Number.isInteger(pid));
    if (alive.length === 0) return reaped;
    if (attempt === 50) {
      // Half a second of grace first: an orphan whose stdin closed usually exits
      // on its own, and waiting for that keeps the ordinary case untouched.
      for (const pid of alive) {
        try {
          process.kill(pid, "SIGKILL");
          reaped.push(pid);
        } catch {
          // Gone between the listing and the signal, which is the outcome wanted.
        }
      }
    }
    await delay(10);
  }
  throw new Error(`a store helper for ${root} outlived every attempt to reap it`);
}

/**
 * A daemon under test: started, waited for, and stopped.
 *
 * `log` accumulates everything both streams produced across every start, so a
 * failure after a restart still carries what the first one said.
 */
export class Daemon {
  constructor({ bin, sock, env }) {
    this.bin = bin;
    this.sock = sock;
    this.env = env;
    this.log = "";
    this.child = null;
    this.closed = null;
  }

  start() {
    this.child = spawn(this.bin, ["serve", "--sock", this.sock, "--tcp", "127.0.0.1:0"], {
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.closed = processClosed(this.child);
    appendDecoded(this.child.stdout, (text) => {
      this.log += text;
    });
    appendDecoded(this.child.stderr, (text) => {
      this.log += text;
    });
  }

  alive() {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  async ready() {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!this.alive()) throw new Error(`daemon exited: ${this.log}`);
      try {
        const socket = createConnection(this.sock);
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
    throw new Error(`daemon readiness timed out: ${this.log}`);
  }

  async stop() {
    if (!this.alive()) return;
    this.child.kill("SIGTERM");
    const timeout = setTimeout(() => {
      if (this.alive()) this.child.kill("SIGKILL");
    }, 5_000);
    try {
      await withDeadline(this.closed, 10_000, "daemon cleanup timed out");
    } finally {
      clearTimeout(timeout);
    }
  }
}
