#!/usr/bin/env node

/**
 * The migration-seam measurer: what `autosk migrate apply` does to a task's
 * runtime identity pin.
 *
 * The state under test is the one the ticket describes operationally: a
 * project whose open task is pinned to a distribution the store recorded but
 * could not hold — the old install tree was gone when the current runtime
 * went to keep its bytes, so the record carries `bytes_held: false` with the
 * store's own `not_held_reason`. With the old code unrestorable, an extension
 * update serves the new distribution and `migrate` is the path that moves
 * the pins. This script exercises exactly that seam against the pinned,
 * patched upstream source and records what lands in the pin: today
 * `applyMigration` rewrites it as `{ workflow, digest, graph, document? }`
 * and the `helper` component is lost, after which resume refuses with
 * `extension_version_mismatch`. When the `apply-migration-drops-helper` fix
 * lands, the same run records `helper` preserved and resume admitted — the
 * band changes its value, not its colour: it fails only when the measurement
 * itself cannot be trusted.
 *
 * The measurement runs in-process under Bun (`verify-autosk-migration-seam
 * .driver.ts`), because the seam lives in the engine — `applyProjectMigration`
 * is the function the `migration.apply` RPC handler calls — and the managed
 * update path can never reach it: while the store can still restore the old
 * distribution's bytes, the loader serves them and `migrate plan` refuses
 * with "already serves". The seam is reachable exactly when the old
 * distribution is not restorable, which the driver produces the way the
 * product does — `recordDistribution` with the real root, holding genuinely
 * failing because the tree is already gone.
 *
 * The positive control is what makes "absent" a measurement rather than a
 * default: an instrument that always reports ABSENT would pass while proving
 * nothing. Two controls ride the same run — the migrated task's pin is read
 * back before the move, and a second task is admitted under the post-update
 * registry after it — and this script FAILS if either does not report
 * `helper` present, because then the reader is broken and the post-migration
 * read means nothing. Both controls read the `task.json` file on disk — a
 * store view would answer from its warm cache, and a serializer that dropped
 * the field would make a cache read certify a pin the disk does not hold.
 *
 * Everything daemon-adjacent runs under a throwaway HOME with a whitelist
 * environment and an explicit AUTOSK_SOCK, the way the family does it; no
 * daemon is started and none may be auto-spawned into the real home.
 *
 * `--record <file>` writes the bound measurement record — the verdict inputs
 * plus what it ran against — for `scripts/build-panel-package.mjs` to render
 * under section 5, which refuses a record bound to other bytes by name.
 *
 * Usage: node scripts/verify-autosk-migration-seam.mjs <prefix> [--record <file>]
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import { digestOf } from "./lib/produced-source.mjs";
import { MEASURER_FILES } from "./lib/seam-engine-gate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRIVER = path.join(ROOT, "scripts", "verify-autosk-migration-seam.driver.ts");
const PRELOAD = path.join(ROOT, "scripts", "lib", "seam-module-loads.mjs");

const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const GIT_OID = /^[0-9a-f]{40}$/;
const TASK_FILE = /^\.autosk\/tasks\/[^/]+\/task\.json$/;
// The executed binding covers the installed module surface and the built
// store-lock helper — the bytes the run executes that the source tree cannot
// name. A member anywhere else is a claim outside that scope.
const EXECUTED_MEMBER = /(?:^|\/)node_modules\/\S/u;
const STORE_LOCK_MEMBER = "bin/autosk-store-lock";

/**
 * Reads the `helper` leg of a pin the store's own reader returned, as a
 * three-state value: the field being present, absent, or the pin not being
 * readable at all are three different facts, and a measurer that cannot tell
 * them apart would call a corrupted record "helper dropped".
 */
export function pinHelperState(pinRead) {
  if (pinRead?.state !== "pinned") return `pin_${pinRead?.state ?? "missing"}`;
  return LOWERCASE_SHA256.test(pinRead.pin.helper) ? "present" : "absent";
}

/**
 * The verdict over one driver's measurement record. `ok` means the record may
 * be read as evidence; the measured fields are always reported, never judged —
 * `helper: "absent"` is a fact the band exists to record, not a failure.
 */
export function classifySeam(record) {
  const failures = [];

  const servedBefore = record?.served?.before?.digest;
  const servedAfter = record?.served?.after?.digest;
  if (!LOWERCASE_SHA256.test(servedBefore ?? "") || !LOWERCASE_SHA256.test(servedAfter ?? "")) {
    failures.push("the served distribution was not identified before and after the update");
  } else if (servedBefore === servedAfter) {
    failures.push("the update changed nothing the registry serves — no migration seam was exercised");
  }

  const oldDistribution = record?.old_distribution;
  if (oldDistribution?.bytes_held !== false) {
    failures.push("the old distribution's record does not say bytes_held: false — no holding failure was exercised");
  }
  const reason = oldDistribution?.not_held_reason;
  if (typeof reason !== "string" || reason.length === 0) {
    failures.push("the old distribution carries no store-composed not_held_reason");
  } else if (reason === "no distribution root was given") {
    // The store composes that string only for the two-argument call nothing in
    // production makes; seeing it means the record was written without a root,
    // not that holding of a real tree failed.
    failures.push("the old distribution was recorded without a root — no real holding failure produced this record");
  }
  if (oldDistribution?.restorable_after_update !== false) {
    failures.push(
      "the previous distribution is still restorable — the registry would serve it, not the update",
    );
  }

  const plan = record?.migration?.plan;
  const apply = record?.migration?.apply;
  if (plan?.supported !== true) {
    failures.push(`migrate plan did not support the move: ${plan?.reason ?? "no plan in the record"}`);
  }
  if (apply?.ok !== true || !LOWERCASE_SHA256.test(apply?.receipt?.id ?? "")) {
    failures.push("migrate apply did not seal a receipt — there is no post-migration state to measure");
  }

  // The record binds what it ran on, or nothing downstream can refuse a value
  // produced elsewhere: the patched tree as git names it and the measurer's
  // own files under the produced-source convention.
  const bound = record?.bound;
  if (!GIT_OID.test(bound?.source_tree ?? "")) {
    failures.push("the record does not bind the patched source tree it measured");
  }
  const boundFiles = bound?.source?.files ?? [];
  if (
    !LOWERCASE_SHA256.test(bound?.source?.digest ?? "") ||
    !MEASURER_FILES.every((name) =>
      boundFiles.some((file) => file.path === name && LOWERCASE_SHA256.test(file.sha256)),
    )
  ) {
    failures.push("the record does not bind the measurer's own script bytes");
  }

  // The tracked tree is not the whole story: `daemon/node_modules` is
  // git-ignored, so a repointed link or a copied directory would run foreign
  // bytes under the same source_tree. The executed binding is what the record
  // has to carry — every member hashed under its logical name, the store-lock
  // helper among them, and a digest that recomputes over exactly those
  // members.
  const executed = bound?.executed;
  const executedFiles = executed?.files;
  if (!LOWERCASE_SHA256.test(executed?.digest ?? "") || !Array.isArray(executedFiles) || executedFiles.length === 0) {
    failures.push(
      "the record does not bind the executed surface — installed modules and the helper — that the source tree cannot name",
    );
  } else {
    if (
      executedFiles.some(
        (file) =>
          !LOWERCASE_SHA256.test(file?.sha256 ?? "") ||
          (file?.path !== STORE_LOCK_MEMBER && !EXECUTED_MEMBER.test(file?.path ?? "")),
      )
    ) {
      failures.push("the executed binding names a member that is not an installed module or the store-lock helper");
    }
    // The module part has a floor of its own: a helper-only member list
    // recomputes and carries the helper, yet names nothing the run imported.
    if (!executedFiles.some((file) => EXECUTED_MEMBER.test(file?.path ?? ""))) {
      failures.push("the executed binding carries no installed module member — the module part of the surface is empty");
    }
    if (!executedFiles.some((file) => file?.path === STORE_LOCK_MEMBER)) {
      failures.push("the record does not bind the store-lock helper binary the run executed");
    }
    if (digestOf(executedFiles.map((file) => ({ path: file?.path, sha256: file?.sha256 })), []) !== executed.digest) {
      failures.push("the executed-surface digest does not recompute over the recorded members");
    }
  }

  // The store's reason embeds the machine-local project path in whichever
  // namespace composed it — as passed, or realpathed by the loader — so the
  // record must name both for a renderer to substitute verbatim.
  if (typeof record?.project_dir !== "string" || !path.isAbsolute(record.project_dir)) {
    failures.push("the record does not name the project root it measured under");
  }
  if (typeof record?.project_dir_physical !== "string" || !path.isAbsolute(record.project_dir_physical)) {
    failures.push("the record does not name the physical project root the store composes paths under");
  }

  // Every pin read must name the task.json file it opened, and the file must
  // belong to the task the read is claimed to be about — a read that names no
  // file could have come from anywhere, including the warm cache.
  const pinReads = [
    ["migrated_task.pin_before", record?.migrated_task?.id, record?.migrated_task?.pin_before],
    ["migrated_task.pin_after", record?.migrated_task?.id, record?.migrated_task?.pin_after],
    [
      "control.fresh_admission_after_migration.pin",
      record?.control?.fresh_admission_after_migration?.task,
      record?.control?.fresh_admission_after_migration,
    ],
    [
      "control.read_back_before_migration.pin",
      record?.control?.read_back_before_migration?.task,
      record?.control?.read_back_before_migration,
    ],
  ];
  for (const [label, taskId, read] of pinReads) {
    if (typeof taskId !== "string" || !TASK_FILE.test(read?.file ?? "")) {
      failures.push(`${label} does not name the task.json file it was read from`);
    } else if (read.file !== `.autosk/tasks/${taskId}/task.json`) {
      failures.push(`${label} names ${read.file}, which is not the file of task ${taskId}`);
    }
  }

  // The controls, re-derived from the raw pin reads — not from the driver's
  // own summary of them, so a broken reader cannot satisfy its own check.
  const pinBefore = record?.migrated_task?.pin_before?.pin;
  const pinAfter = record?.migrated_task?.pin_after?.pin;
  const witnessPin = record?.control?.fresh_admission_after_migration?.pin;
  const witnessDecision = record?.control?.fresh_admission_after_migration?.resume_decision;

  // The rendered "pinned" cells quote the pin's own digest — so a read that
  // claims state "pinned" must carry one, or the package would print a field
  // that is not there. Other states ("absent", "malformed") are measured
  // facts in their own right and carry no pin to quote.
  if (pinBefore?.state === "pinned" && !LOWERCASE_SHA256.test(pinBefore.pin?.digest ?? "")) {
    failures.push("the pre-migration pin reads as pinned but carries no distribution digest");
  }
  if (pinAfter?.state === "pinned" && !LOWERCASE_SHA256.test(pinAfter.pin?.digest ?? "")) {
    failures.push("the post-migration pin reads as pinned but carries no distribution digest");
  }

  if (pinHelperState(pinBefore) !== "present") {
    failures.push(
      "control failed: the pre-migration read-back does not show helper — " +
        "an ABSENT answer after the move would say nothing about the pin",
    );
  }
  if (pinHelperState(witnessPin) !== "present" || witnessDecision?.ok !== true) {
    failures.push(
      "control failed: a fresh admission under the served distribution did not carry a readable helper",
    );
  }

  const helper = pinHelperState(pinAfter);

  // The answer must be an answer: `ok` is a boolean, and a refusal carries
  // the reason the decision gave. A record with no decision field, or a
  // refusal with no reason, is incomplete — it is not a measured "refused".
  const resumeDecision = record?.migrated_task?.resume_decision;
  if (typeof resumeDecision?.ok !== "boolean") {
    failures.push("the record carries no resume answer for the migrated task — an absent answer is not a refusal");
  } else if (
    resumeDecision.ok === false &&
    (typeof resumeDecision.reason !== "string" || resumeDecision.reason.length === 0)
  ) {
    failures.push("the migrated task's resume was refused but the record carries no refusal reason");
  }
  const resume = resumeDecision?.ok === true ? "admitted" : resumeDecision?.ok === false ? "refused" : "absent";
  const refusal =
    resumeDecision?.ok === false && typeof resumeDecision?.reason === "string"
      ? resumeDecision.reason.split(":")[0]
      : null;

  return {
    ok: failures.length === 0,
    failures,
    measured: { helper, resume, refusal },
    migration: {
      from: plan?.from ?? null,
      to: plan?.to ?? null,
      receipt: apply?.receipt?.id ?? null,
      sealed_at: apply?.receipt?.completed_at ?? null,
    },
    control: {
      read_back_before_migration: pinHelperState(pinBefore),
      fresh_admission_helper: pinHelperState(witnessPin),
      fresh_admission_resume: witnessDecision?.ok === true ? "admitted" : "refused",
    },
  };
}

async function findOnPath(name, pathEnv) {
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not in this directory — keep looking
    }
  }
  return null;
}

function appendDecoded(stream, append) {
  const decoder = new TextDecoder();
  stream.on("data", (chunk) => append(decoder.decode(chunk, { stream: true })));
  stream.on("end", () => {
    const tail = decoder.decode();
    if (tail) append(tail);
  });
}

export async function runCli(argv) {
  const prefixArg = argv[0];
  if (!prefixArg) {
    console.log("usage: node scripts/verify-autosk-migration-seam.mjs <prefix> [--record <file>]");
    return 1;
  }
  const recordAt = argv.includes("--record") ? argv[argv.indexOf("--record") + 1] : null;
  const prefix = path.resolve(prefixArg);
  const storeLockBin = path.join(prefix, "bin", "autosk-store-lock");
  await access(storeLockBin, constants.X_OK);
  await access(DRIVER, constants.R_OK);
  await access(PRELOAD, constants.R_OK);

  const bun = await findOnPath("bun", process.env.PATH);
  assert.ok(bun, "bun is required to run the engine-level driver and is not on PATH");

  const root = await mkdtemp(path.join(tmpdir(), "autosk-migration-seam-"));
  const taskHome = path.join(root, "home");
  const project = path.join(root, "project");
  const scratch = path.join(root, "tmp");
  const launch = path.join(root, "launch");
  await mkdir(taskHome, { recursive: true });
  await mkdir(path.join(taskHome, ".autosk"), { recursive: true });
  await writeFile(path.join(taskHome, ".autosk", "settings.json"), "{}\n");
  await mkdir(project, { recursive: true });
  await mkdir(scratch, { recursive: true });
  await mkdir(launch, { recursive: true });

  // The launch the driver runs under is part of the measurement: Bun reads
  // $cwd/bunfig.toml on its own, and --config/-c, --cwd, --no-env-file pin
  // all of that to files this process owns. The bunfig carries a nonce only
  // this run knows, so the gate can prove the file Bun read is the file the
  // wrapper wrote — not a caller's config and not one carrying a preload.
  const seamNonce = randomBytes(16).toString("hex");
  const seamBunfig = path.join(root, "seam.bunfig.toml");
  await writeFile(seamBunfig, `# autosk-seam launch config\n# nonce ${seamNonce}\n`);

  // The whitelist env, the way the family builds it: a HOME that is not the
  // real one, a socket path that exists only inside the sandbox (nothing may
  // auto-spawn a daemon elsewhere), and the helper binary pinned by path.
  const env = {
    HOME: taskHome,
    PATH: `${path.join(prefix, "bin")}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    TMPDIR: scratch,
    AUTOSK_SOCK: path.join(root, "daemon.sock"),
    AUTOSK_STORE_LOCK_BIN: storeLockBin,
    AUTOSK_NO_AUTO_INSTALL: "1",
    AUTOSK_SKIP_SHELL_PATH: "1",
    AUTOSK_SOURCE_DIR: prefix,
    AUTOSK_PROJECT_DIR: project,
    AUTOSK_SEAM_LAUNCH_DIR: launch,
    AUTOSK_SEAM_BUNFIG: seamBunfig,
    AUTOSK_SEAM_NONCE: seamNonce,
  };

  // --preload arms the module-load log before the entry module resolves, so
  // the driver's gate can prove no engine code loaded before its surface
  // checks — a load that early could repair the surface the guard then reads.
  // The gate re-verifies this whole launch line from the process's own argv.
  let driverLog = "";
  const child = spawn(
    bun,
    [`--cwd=${launch}`, `--config=${seamBunfig}`, "--no-env-file", `--preload=${PRELOAD}`, DRIVER],
    { env, cwd: launch, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  appendDecoded(child.stdout, (text) => {
    stdout += text;
  });
  appendDecoded(child.stderr, (text) => {
    driverLog += text;
    process.stderr.write(text);
  });
  const deadline = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 60_000);
  const closed = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(deadline));

  await writeFile(path.join(root, "driver.stderr.log"), driverLog);
  await writeFile(path.join(root, "measurement.json"), stdout);

  let record = null;
  try {
    record = JSON.parse(stdout);
  } catch {
    // handled below: a driver that printed no record produced no measurement
  }

  const verdict = record ? classifySeam(record) : null;
  const results = { driver_exit: closed, record, verdict };
  await writeFile(path.join(root, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  // A refused run writes no record: a file containing null looks like a
  // record to whatever picks it up, and the builder's missing-measurement
  // refusal is clearer than a record-shaped nothing.
  if (recordAt && record !== null) {
    await mkdir(path.dirname(path.resolve(recordAt)), { recursive: true });
    await writeFile(recordAt, `${JSON.stringify(record, null, 2)}\n`);
  }

  if (closed.signal !== null || closed.code !== 0 || record === null) {
    assert.fail(
      `the migration-seam driver produced no measurement (exit ${closed.code ?? closed.signal}); ` +
        `its log is at ${root}/driver.stderr.log`,
    );
  }

  const measured = verdict.measured;
  console.log(
    `migration seam: ${verdict.migration.from} -> ${verdict.migration.to} ` +
      `(receipt ${verdict.migration.receipt}); ` +
      `helper ${measured.helper} after apply; resume ${measured.resume}` +
      (measured.refusal ? ` (${measured.refusal})` : ""),
  );
  for (const failure of verdict.failures) {
    console.log(`INVALID: ${failure}`);
  }
  assert.ok(
    verdict.ok,
    `the measurement cannot be trusted: ${verdict.failures.join("; ")} — the record is at ${root}/measurement.json`,
  );

  console.log(
    JSON.stringify({
      passed: 1,
      failed: 0,
      skipped: 0,
      runtime: process.version,
      platform: process.platform,
      arch: process.arch,
      band: "migration-seam",
      measured,
      migration: verdict.migration,
      control: verdict.control,
    }),
  );
  console.log(
    `PASS migration seam measured (helper=${measured.helper}, resume=${measured.resume}` +
      `${measured.refusal ? `, ${measured.refusal}` : ""})`,
  );
  console.log(`Evidence retained: ${root}`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
