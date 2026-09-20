/**
 * The migration-seam measurement, driven in-process against the patched
 * upstream source.
 *
 * Spawned by `verify-autosk-migration-seam.mjs`, which owns the isolated
 * environment; this file is the measurement itself. It runs under Bun (not
 * Node) because the engine modules it exercises are TypeScript sources that
 * import each other by `.ts` specifier.
 *
 * What it reproduces is the defect ticket 11 exists to see: a project whose
 * open task was admitted under distribution D1 — a distribution this runtime
 * identified but could not hold, because the old install tree was already
 * gone when the record was written — is opened against an install that now
 * serves D2, and `autosk migrate apply` (here its engine callee,
 * `applyProjectMigration` — the exact function the `migration.apply` RPC
 * handler invokes) moves the pin. The pinned tree's own `applyMigration`
 * rebuilds the pin as `{ workflow, digest, graph, document? }` and the
 * `helper` component does not survive.
 *
 * Why the old record carries no held bytes: `recordDistribution` with a root
 * is the only call shape production makes (engine.ts), and it holds the bytes
 * when it can. A current runtime reaches `bytes_held: false` when holding
 * honestly fails — the deployment where the old distribution's root is gone:
 * pruned, partially copied, on a volume that went away. The driver reproduces
 * exactly that: the registry identifies the real tree, the root is removed,
 * and the production call records `bytes_held: false` with the store's own
 * `not_held_reason`, read back verbatim from `.autosk/runtime/v1/index.json`.
 * The seam is reachable precisely when the old distribution is no longer
 * restorable — the state the ticket's "project on the previous runtime"
 * describes operationally.
 *
 * Every hop is the production code path, not a re-implementation:
 *
 *  - the registry is the real extension loader (`loadProjectRegistry`) over
 *    real bytes on disk, with the same `pinnedCode` wiring the daemon's
 *    project manager injects (`referencedDistributions` +
 *    `materializeDistribution`);
 *  - the enrolment pin is the intake admission decision
 *    (`runtimeIdentityDecision` in `adopt` mode) — the same object
 *    `engine.enroll` persists via `setPosition`'s `pinRuntimeIdentity`;
 *  - every pin read below goes through ONE reader — `parseTask` over the
 *    `task.json` file on disk, then `readRuntimeIdentityPin` on its
 *    metadata — never the store's in-memory view. A warm cache returns the
 *    object it was handed, so a serializer that lost the field would let a
 *    cache read certify a pin the disk does not hold; the control exists to
 *    say PRESENT only when the file says so, and it has to read the file;
 *  - the post-migration verdict is the same `runtimeIdentityDecision` call
 *    `engine.resume` makes (`refuse` mode over the served registry);
 *  - the helper digest is `helperBinaryDigest()` over the real
 *    `autosk-store-lock` binary (`AUTOSK_STORE_LOCK_BIN`).
 *
 * Why the positive controls are mandatory: this band reports a measured fact,
 * so "helper is absent after migration" is only meaningful if the same reader
 * could have reported it present. Two controls, both inside this one run:
 * the migrated task's pin is read back BEFORE the move (a pin written with
 * helper, read straight back), and a second task is admitted under the
 * post-update registry AFTER the move (the full write → read → admit chain
 * on today's code). If either reports helper absent, the instrument — not the
 * pin — is what is broken, and the wrapper fails the run on that record.
 *
 * The record binds what it ran against: the patched tree's own `git
 * write-tree` (verified clean against the index, so the bytes on disk are
 * the tree, not only the index), the sha256 of the measurer's own files
 * under the `bindSource` convention, and the executed bytes git cannot name —
 * `daemon/node_modules` is ignored and its `@autosk/*` entries are links, so
 * the same `source_tree` can stand over different executed code. That clean-
 * diff check is deliberate, not incidental: a working tree edited past its
 * index makes `write-tree` name bytes this run did not execute, and the
 * driver refuses to measure a tree it cannot name — a run that dies there
 * reported honestly rather than measured falsely. The ignored surface is
 * bound the same way the run reaches it: hashed under its logical names, with
 * two refusals — a link resolving outside the source root, and a workspace
 * package that is not the link `bun install` made (a copied directory keeps
 * every name inside the root, so only the workspace declaration in the
 * tracked `daemon/package.json` can call it out). The store-lock helper is a
 * built binary in the ignored `bin/` tree and runs under the same rule: bound
 * as bytes, refused if it resolves outside the source root.
 *
 * The binding precedes the imports by construction — all of it lives in
 * `lib/seam-engine-gate.mjs`, the only module allowed to `import` under the
 * source root, and it performs the engine imports itself after the checks.
 * A foreign module therefore cannot launder the surface during its own
 * evaluation: the guard reads the link while it is still foreign, and the
 * preloaded load log proves nothing under the source root resolved earlier.
 *
 * Emits one JSON record on stdout; narrative on stderr. A thrown error means
 * the seam could not be exercised at all (no measurement exists) — the
 * wrapper treats a non-zero exit as a broken measurer, never as data.
 */

import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadVerifiedEngine } from "./lib/seam-engine-gate.mjs";

const SRC = process.env.AUTOSK_SOURCE_DIR;
const PROJECT = process.env.AUTOSK_PROJECT_DIR;
if (!SRC || !PROJECT) {
  throw new Error("usage: AUTOSK_SOURCE_DIR=<patched source> AUTOSK_PROJECT_DIR=<empty dir> bun <driver>");
}

const note = (line: string) => process.stderr.write(`[seam] ${line}\n`);

// Every engine module this run executes arrives through the gate, and only
// through it: `loadVerifiedEngine` has already run the ordering assertion,
// the tree proof, and the surface binding by the time it returns — nothing
// under the source root can be imported earlier, so `bound` names exactly
// the bytes the modules below were loaded from.
const { modules, bound } = await loadVerifiedEngine(SRC, {
  storeLockBin: process.env.AUTOSK_STORE_LOCK_BIN,
});
const { Store } = modules.store;
const { loadProjectRegistry } = modules.loader;
const { canonicalDistribution } = modules.identity;
const { readRuntimeIdentityPin } = modules.metadata;
const { parseTask } = modules.records;
const { parseDistributionIndex } = modules.distributions;
const { runtimeIdentityDecision } = modules.runtimeIdentity;
const { planProjectMigration, applyProjectMigration } = modules.migrationRunner;

/**
 * The only way this file ever reads a pin: the `task.json` bytes on disk,
 * through the store's own deserializer, into the production pin reader. The
 * store's `taskView` would answer from its warm cache — which is the object
 * the write was handed, not the file — so every read that feeds evidence or
 * a decision goes here, and the record names the file each read opened.
 */
const readPinFromDisk = (taskId: string) => {
  const file = `.autosk/tasks/${taskId}/task.json`;
  const task = parseTask(readFileSync(join(PROJECT, file), "utf8"));
  return { file, pin: readRuntimeIdentityPin(task.metadata) };
};

/**
 * Two builds of one extension: identical workflow shape and document digest,
 * one byte different in the source marker. The shape stays fixed so the only
 * thing the migration has to move is the distribution pin itself — a defect
 * that only shows up when the move happens at all.
 */
const DOCUMENT_DIGEST = "5".repeat(64);
const extension = (marker: string) => `
export default (api) => {
  api.registerWorkflow({
    name: "seam-flow",
    firstStep: "intake",
    graphDigest: "${DOCUMENT_DIGEST}",
    steps: { intake: { status: "human" }, review: { status: "human" } },
  });
};
// seam-marker: ${marker}
`;

const extDir = join(PROJECT, ".autosk", "extensions");
mkdirSync(join(extDir, "seam-flow"), { recursive: true });
writeFileSync(join(extDir, "seam-flow", "index.js"), extension("v1"));

const store = new Store(PROJECT, { watch: false });
await store.open();

// The same wiring ProjectManager.envFor(store) builds for the daemon: the
// loader asks this project's own store which distributions open tasks are
// pinned to and where a held copy can be put back.
const pinnedCode = {
  pinned: () => store.referencedDistributions(),
  restore: (digest: string) => store.materializeDistribution(digest),
};

const registryBefore = await loadProjectRegistry(PROJECT, { pinnedCode });
const servedBefore = registryBefore.workflowAdmission("seam-flow");
if (!servedBefore) {
  throw new Error(
    `extension v1 did not register seam-flow; diagnostics: ${JSON.stringify(registryBefore.diagnostics)}`,
  );
}
note(`installed v1: served distribution ${servedBefore.distribution.digest}, shape ${servedBefore.graph}`);

// The old package's install tree goes away — pruned, replaced, a volume that
// did not come back — before this runtime records the distribution. The
// production call shape with the real root then fails to hold: the store's
// own record says `bytes_held: false` with its `not_held_reason`, which is
// read back from the runtime index verbatim below.
const oldRoot = servedBefore.distribution.root;
rmSync(oldRoot, { recursive: true, force: true });
await store.recordDistribution(
  servedBefore.distribution.digest,
  canonicalDistribution(servedBefore.distribution.entries),
  oldRoot,
);

const indexFile = ".autosk/runtime/v1/index.json";
const oldRecord = parseDistributionIndex(readFileSync(join(PROJECT, indexFile), "utf8")).distributions.find(
  (entry: { digest: string }) => entry.digest === servedBefore.distribution.digest,
);
if (oldRecord?.bytes_held !== false || typeof oldRecord?.not_held_reason !== "string") {
  throw new Error(`holding did not fail as constructed — the record is ${JSON.stringify(oldRecord)}`);
}
note(`recorded v1: bytes_held=false — ${oldRecord.not_held_reason} (from ${indexFile})`);

const task = await store.createTask({ title: "seam: migrated task" });
const admission = runtimeIdentityDecision(registryBefore, { state: "absent" }, "seam-flow", "adopt");
if (!admission.ok || !admission.admitted) {
  throw new Error(`intake admission refused: ${JSON.stringify(admission)}`);
}
await store.setPosition(
  task.id,
  { status: "human", workflow: "seam-flow", step: "review" },
  { pinRuntimeIdentity: admission.admitted },
);
const pinBefore = readPinFromDisk(task.id);
note(`task ${task.id} admitted; pin at ${pinBefore.file}: ${JSON.stringify(pinBefore.pin)}`);

// The extension update lands: the old package is gone (removed above), the
// new one is installed under its own name (a package manager's versioned
// directory — also what keeps Bun's module cache from serving the old bytes
// by path).
mkdirSync(join(extDir, "seam-flow-v2"), { recursive: true });
writeFileSync(join(extDir, "seam-flow-v2", "index.js"), extension("v2"));

const registryAfter = await loadProjectRegistry(PROJECT, { pinnedCode });
const servedAfter = registryAfter.workflowAdmission("seam-flow");
if (!servedAfter) {
  throw new Error(
    `extension v2 did not register seam-flow; diagnostics: ${JSON.stringify(registryAfter.diagnostics)}`,
  );
}
const restoreOld = await store.materializeDistribution(servedBefore.distribution.digest);
note(
  `installed v2: served distribution ${servedAfter.distribution.digest}, shape ${servedAfter.graph}; ` +
    `held copy of ${servedBefore.distribution.digest}: ${restoreOld ?? "none — the store cannot restore it"}`,
);
if (servedAfter.distribution.digest === servedBefore.distribution.digest) {
  throw new Error("the registry still serves the old distribution — the migration seam was never reached");
}

// The current runtime records the distribution it serves, held bytes
// included — the asymmetric counterpart of the unrestorable old record.
await store.recordDistribution(
  servedAfter.distribution.digest,
  canonicalDistribution(servedAfter.distribution.entries),
  servedAfter.distribution.root,
);

const plan = await planProjectMigration(store, registryAfter, "seam-flow");
note(`migrate plan: ${JSON.stringify(plan)}`);
if (!plan.supported) {
  throw new Error(`migrate plan refused — the seam state was not constructed: ${plan.reason}`);
}

const applied = await applyProjectMigration(store, registryAfter, "seam-flow");
note(`migrate apply: ${JSON.stringify(applied)}`);
if (!applied.ok) {
  throw new Error(`migrate apply failed — no post-migration state exists to measure: ${applied.reason}`);
}

const pinAfter = readPinFromDisk(task.id);
note(`post-migration pin at ${pinAfter.file}: ${JSON.stringify(pinAfter.pin)}`);

// What `engine.resume` would answer for the migrated task, verbatim: the
// pin as the file holds it, the same decision function, the same `refuse`
// policy the resume path uses.
const resumeDecision = runtimeIdentityDecision(registryAfter, pinAfter.pin, "seam-flow", "refuse");
note(`resume decision for migrated task: ${JSON.stringify(resumeDecision)}`);

// Control 2: a task admitted under today's registry, after the move — the
// entire write/read/admit chain on the current code, in the same run.
const witnessAdmission = runtimeIdentityDecision(registryAfter, { state: "absent" }, "seam-flow", "adopt");
if (!witnessAdmission.ok || !witnessAdmission.admitted) {
  throw new Error(`witness admission refused: ${JSON.stringify(witnessAdmission)}`);
}
const witness = await store.createTask({ title: "seam: control task" });
await store.setPosition(
  witness.id,
  { status: "human", workflow: "seam-flow", step: "review" },
  { pinRuntimeIdentity: witnessAdmission.admitted },
);
const witnessPin = readPinFromDisk(witness.id);
const witnessDecision = runtimeIdentityDecision(registryAfter, witnessPin.pin, "seam-flow", "refuse");
note(`control task ${witness.id}: pin at ${witnessPin.file} ${JSON.stringify(witnessPin.pin)}; decision ${JSON.stringify(witnessDecision)}`);

await store.close();

process.stdout.write(
  `${JSON.stringify(
    {
      band: "migration-seam",
      schema: "autosk-migration-seam/v1",
      source_dir: SRC,
      // The store's not_held_reason embeds the project path in whichever
      // namespace composed it — the loader realpaths distribution roots, so
      // the physical form is what reaches the string; the record carries both
      // so a renderer can substitute verbatim without parsing.
      project_dir: PROJECT,
      project_dir_physical: realpathSync(PROJECT),
      workflow: "seam-flow",
      // What this record was measured on, as the gate computed it before the
      // first engine import: the patched source tree as git names it
      // (worktree verified equal to the index), the measurer's own files
      // under the produced-source convention, and the executed bytes git
      // cannot name — the installed module surface and the store-lock
      // helper, hashed under their logical names. The package build refuses
      // a record bound to other bytes rather than rendering a value produced
      // elsewhere.
      bound,
      served: {
        before: {
          digest: servedBefore.distribution.digest,
          graph: servedBefore.graph,
          document: servedBefore.document ?? null,
        },
        after: {
          digest: servedAfter.distribution.digest,
          graph: servedAfter.graph,
          document: servedAfter.document ?? null,
        },
      },
      old_distribution: {
        record:
          "digest+listing recorded by this runtime with the real root; holding failed — bytes_held=false with the store's own reason",
        bytes_held: oldRecord.bytes_held,
        not_held_reason: oldRecord.not_held_reason,
        index_file: indexFile,
        restorable_after_update: restoreOld !== null,
      },
      migrated_task: {
        id: task.id,
        pin_before: pinBefore,
        pin_after: pinAfter,
        resume_decision: resumeDecision,
      },
      migration: {
        plan,
        apply: applied,
      },
      // Raw reader/decision outputs only — every verdict is re-derived by the
      // wrapper, so a control cannot be satisfied by a field this file computed.
      control: {
        read_back_before_migration: {
          task: task.id,
          file: pinBefore.file,
          pin: pinBefore.pin,
        },
        fresh_admission_after_migration: {
          task: witness.id,
          file: witnessPin.file,
          pin: witnessPin.pin,
          resume_decision: witnessDecision,
        },
      },
    },
    null,
    2,
  )}\n`,
);
