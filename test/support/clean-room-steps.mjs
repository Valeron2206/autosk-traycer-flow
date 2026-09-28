/**
 * A test-only stand-in for the clean-room run's steps (review of 11g, C1).
 *
 * `cleanRoomRun` takes its steps from its caller — `CLEAN_ROOM_IO` by default:
 * the commands it spawns, the extension identity it reads, the toolchain it
 * resolves, the binaries it checks and the fault harness. The tests hand it
 * this stand-in instead, so every return of the run — each early failure, the
 * thrown one and the success — is driven without preparing or building
 * anything. The first version of the start-and-end identity read shadowed its
 * own variable and broke both paths, and tests that called the identity
 * functions alone could not see it.
 *
 * A command answers what `answers[step]` says, keyed by the step name the
 * report records, and succeeds otherwise; `prepare` answers a receipt by
 * default. The identity is read from `identities` in order, the last one
 * repeating. `calls` records the order: the step names and each `identity`
 * read.
 */
import path from "node:path";

import { CLEAN_ROOM_IO, TOOLCHAIN } from "../../scripts/clean-room-e2e.mjs";

/** The step name the report records for one command the run spawns. */
export function stepName(command, args, options = {}) {
  const script = args.find((arg) => String(arg).endsWith(".mjs"));
  if (script) {
    const name = path.basename(script, ".mjs");
    return name === "prepare-autosk" ? "prepare" : `harness:${name.replace(/^verify-autosk-/u, "")}`;
  }
  if (command === "bun" && args[0] === "install") return `deps:${path.basename(options.cwd ?? "")}`;
  if (command === "bun" && args[0] === "build") return "build:daemon";
  if (command === "make") return "build:go";
  return `${command} ${args.join(" ")}`;
}

export function stubbedSteps({
  answers = {},
  identities,
  receipt = { source_tree: "s".repeat(40), upstream_commit: "u".repeat(40) },
  faults = { ok: true, detected: 0, controlled: 0, total: 0, results: [] },
  missingTools = [],
  statError = null,
} = {}) {
  const calls = [];
  const queue = [...identities];
  const io = {
    async run(command, args, options) {
      const step = stepName(command, args, options);
      calls.push(step);
      if (answers[step]) return answers[step];
      return { ok: true, stdout: step === "prepare" ? JSON.stringify(receipt) : "", ms: 1 };
    },
    async identity() {
      calls.push("identity");
      return queue.length > 1 ? queue.shift() : queue[0];
    },
    async resolveToolchain() {
      return Object.fromEntries(TOOLCHAIN.filter((tool) => !missingTools.includes(tool)).map((tool) => [tool, "/stub/bin"]));
    },
    async stat(target) {
      if (statError) throw statError;
      return { target };
    },
    async runFaults() {
      calls.push("harness:faults");
      return faults;
    },
  };
  // `cleanRoomRun` does not fall back to the real step for one the stand-in
  // leaves out, so an unanswered step would fail as a TypeError deep inside
  // the run; refuse it here, by name, before anything is built.
  const unanswered = Object.keys(CLEAN_ROOM_IO).filter((step) => !Object.hasOwn(io, step));
  if (unanswered.length > 0) throw new Error(`the stand-in does not answer ${unanswered.join(", ")}`);
  return { io, calls };
}
