/**
 * A test-only stand-in for the ref-custody helper (#5, `src/git/ref-custody-helper.ts`).
 *
 * The product has no helper: `src/host/ref-custody.mjs` asks the client it is
 * handed, and its default client answers no action, so on a real host today
 * every write under `refs/autosk/**` is refused (ADR-095). These tests hand the
 * drivers a client built here instead. It does what the helper's closed
 * protocol says the helper does, against a real repository: one
 * `git update-ref --stdin` transaction per request, every update carrying its
 * expected old value (`create` for an expected-absent ref), and a reflog
 * created for every protected ref. It answers with the wire response's
 * `ref_observations`, and a refused transaction is `not_applied` with
 * `expected_old_mismatch` and what each ref holds now.
 *
 * It refuses, like the helper, a ref outside the helper's grammar. Nothing in
 * `src/` can reach this file; the inventory test in
 * `test/runtime-delta-driver.test.mjs` keeps every `update-ref` in `src/` inside
 * `swapTarget`, the target-CAS mechanics the daemon's adapter carries.
 */
import { execFile } from "node:child_process";

import { PROTECTED_REF } from "../../src/host/ref-custody.mjs";

const ENV = (cwd) => ({
  PATH: process.env.PATH,
  HOME: cwd,
  GIT_AUTHOR_NAME: "autosk test",
  GIT_AUTHOR_EMAIL: "test@autosk.invalid",
  GIT_COMMITTER_NAME: "autosk test",
  GIT_COMMITTER_EMAIL: "test@autosk.invalid",
});

function run(cwd, args, stdin) {
  return new Promise((resolve) => {
    const child = execFile("git", args, { cwd, env: ENV(cwd) }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    if (stdin !== undefined) child.stdin.end(stdin);
  });
}

async function held(cwd, ref) {
  const result = await run(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const oid = result.stdout.trim();
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid) ? oid : null;
}

function line({ operation, ref, expected_old_oid: old, new_oid: next }) {
  if (operation === "verify") return `verify ${ref} ${old}`;
  if (operation === "delete") return `delete ${ref} ${old}`;
  return old === null ? `create ${ref} ${next}` : `update ${ref} ${next} ${old}`;
}

/**
 * A git-backed ref-custody client for the repository at `cwd`.
 *
 * `requests` records every request it was asked, in order, so a test can say
 * what the host asked for as well as what the ref holds.
 */
export function gitRefCustody(cwd) {
  const requests = [];
  async function answer(request) {
    requests.push(request);
    for (const update of request.ref_updates) {
      if (!PROTECTED_REF.test(update.ref)) throw new Error(`the helper writes no ref outside its grammar: ${update.ref}`);
    }
    const stdin = `${request.ref_updates.map(line).join("\n")}\n`;
    const result = await run(cwd, ["update-ref", "--create-reflog", "--stdin"], stdin);
    if (result.code === 0) {
      return {
        action: request.action,
        status: "committed",
        not_applied_reason: null,
        ref_observations: request.ref_updates.map((update) => ({
          operation: update.operation,
          ref: update.ref,
          expected_old_oid: update.expected_old_oid,
          requested_new_oid: update.new_oid,
          observed_old_oid: update.expected_old_oid,
          observed_new_oid: update.operation === "delete" ? null : update.new_oid,
        })),
      };
    }
    const observations = [];
    for (const update of request.ref_updates) {
      const now = await held(cwd, update.ref);
      observations.push({
        operation: update.operation,
        ref: update.ref,
        expected_old_oid: update.expected_old_oid,
        requested_new_oid: update.new_oid,
        observed_old_oid: now,
        observed_new_oid: now,
      });
    }
    return {
      action: request.action,
      status: "not_applied",
      not_applied_reason: "expected_old_mismatch",
      ref_observations: observations,
    };
  }
  return Object.freeze({
    requests,
    init: answer,
    advance_planning: answer,
    create_staging: answer,
    advance_staging: answer,
    delete_staging: answer,
  });
}
