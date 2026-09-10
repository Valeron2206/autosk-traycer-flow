#!/usr/bin/env node

/**
 * Criterion 2 of issue #10, measured where it is decided.
 *
 * The criterion is that `workflow_graph_digest` covers steps, transitions,
 * guards, caps and recovery targets. That digest is the daemon's: it is computed
 * by `workflowGraphDigest` over `canonicalWorkflowGraph`, and the daemon pins it
 * onto a task as `metadata.runtime_identity.graph` when the task is enrolled.
 *
 * Everything else this slice can say about the criterion is a composition — the
 * document's digest moves, the factory puts it on the definition, patch `0032`
 * puts that field in the canonical shape, and the lock holds that line in place
 * across the series. Each leg is checked by a command, and a composition of four
 * checks is still an argument. This is the measurement: six projects, six
 * documents differing from a base by exactly one component, one real daemon, and
 * the six digests it pinned read back off disk.
 *
 * Usage: node scripts/verify-autosk-graph-digest.mjs <prefix>
 */

import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Daemon, cli as runCli, delay } from "./lib/autosk-daemon.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const prefixArg = process.argv[2];
if (!prefixArg) throw new Error("usage: node scripts/verify-autosk-graph-digest.mjs <prefix>");

const prefix = path.resolve(prefixArg);
const bin = (name) => path.join(prefix, "bin", name);
const root = await mkdtemp(path.join(tmpdir(), "autosk-graph-digest-"));
const taskHome = path.join(root, "home");
const sock = path.join(root, "daemon.sock");

const env = {
  HOME: taskHome,
  PATH: path.join(prefix, "bin"),
  AUTOSK_SOCK: sock,
  AUTOSK_NO_AUTO_INSTALL: "1",
  AUTOSK_SKIP_SHELL_PATH: "1",
};

/**
 * The base document, and one mutation per component of criterion 2.
 *
 * Each mutation changes exactly one component and nothing else — the workflow
 * name, the first step and the step set are identical across all six except
 * where `steps` is the component under test, so a digest that moves can only
 * have moved because of the component named.
 *
 * The document is written into the extension rather than read from
 * `resources/`: what is being measured is that a change to a component reaches
 * the daemon's digest, and a small document makes the one change visible.
 */
const BASE = {
  workflow: "digest",
  first_step: "start",
  predicates: [
    { id: "always", reads: ["task_record"], description: "holds" },
    { id: "never", reads: ["task_record"], description: "does not hold" },
  ],
  steps: [
    { name: "start", kind: "agent", no_transition_reason: "fixture_no_exit" },
    { name: "next", kind: "agent", no_transition_reason: "fixture_no_exit" },
    { name: "done", kind: "status", status: "done" },
    { name: "human", kind: "status", status: "human" },
  ],
  guards: [
    { id: "g_always", predicate: "always", authority: { actor: "agent" }, park_reason: "fixture_no_exit" },
    { id: "g_never", predicate: "never", authority: { actor: "agent" }, park_reason: "fixture_no_exit" },
  ],
  transitions: [
    { id: "t_next", from: "start", to: "next", priority: 0, guards: ["g_always"] },
    { id: "t_done", from: "next", to: "done", priority: 0, guards: ["g_always"] },
    { id: "t_park", from: "next", to: "human", priority: 1, guards: ["g_never"] },
  ],
  caps: [{ cycle: "round", counted_transition: "t_next", limit: 3, park_reason: "fixture_no_exit" }],
  recovery: [
    { reason: "fixture_no_exit", parks_at: ["next"], resume_targets: ["done", "next"], required_state: "n/a" },
  ],
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const VARIANTS = {
  base: (document) => document,
  steps: (document) => {
    document.steps.find((step) => step.name === "next").no_transition_reason = "fixture_other";
    return document;
  },
  transitions: (document) => {
    document.transitions.find((edge) => edge.id === "t_park").priority = 2;
    return document;
  },
  guards: (document) => {
    document.guards.find((guard) => guard.id === "g_never").park_reason = "fixture_other";
    return document;
  },
  caps: (document) => {
    document.caps[0].limit = 4;
    return document;
  },
  recovery: (document) => {
    document.recovery[0].resume_targets = ["next"];
    return document;
  },
};

/**
 * The extension for one variant: the shipped factory, the variant's document,
 * and the document's own digest as the factory computes nothing and carries
 * everything.
 *
 * The digest is computed here with the canonical serializer this repository
 * pins, so the document reaching the daemon is sealed the way a shipped one is.
 */
const extensionSource = (documentJson, digest) => `
import { buildWorkflow } from "./workflow-factory.mjs";

const document = ${documentJson};
document.canonical_digest = ${JSON.stringify(digest)};

export default function (autosk) {
  autosk.registerWorkflow(buildWorkflow(document, { evaluate: (predicate) => predicate === "always" }));
}
`;

for (const name of ["autosk", "autoskd"]) {
  await access(bin(name), constants.X_OK);
}
await mkdir(path.join(taskHome, ".autosk"), { recursive: true });
await writeFile(path.join(taskHome, ".autosk", "settings.json"), "{}\n");

const { graphDigest } = await import(path.join(ROOT, "scripts/validate-workflow-graph.mjs"));
// Both files, because the factory imports the canonical form: shipping one of
// them leaves the extension unloadable with ERR_MODULE_NOT_FOUND, which is how
// round 1 attempt 2 found this — the module moved and neither verifier was run
// again against the tree that moved it.
const factory = await readFile(path.join(ROOT, "src/host/workflow-factory.mjs"), "utf8");
const canonical = await readFile(path.join(ROOT, "src/host/workflow-graph-canonical.mjs"), "utf8");

const daemon = new Daemon({ bin: bin("autoskd"), sock, env });
const pinned = {};
const documentDigests = {};

try {
  daemon.start();
  await daemon.ready();

  for (const [variant, mutate] of Object.entries(VARIANTS)) {
    const document = mutate(clone(BASE));
    const digest = graphDigest(document);
    documentDigests[variant] = digest;

    const project = path.join(root, variant);
    const extensionDir = path.join(project, ".autosk", "extensions", "digest");
    await mkdir(extensionDir, { recursive: true });
    await writeFile(path.join(extensionDir, "workflow-factory.mjs"), factory);
    await writeFile(path.join(extensionDir, "workflow-graph-canonical.mjs"), canonical);
    await writeFile(path.join(extensionDir, "index.js"), extensionSource(JSON.stringify(document), digest));

    const cli = (args, expected) => runCli(bin("autosk"), { cwd: project, env }, args, expected);
    await cli(["init"]);
    const task = JSON.parse(await cli(["create", `Digest ${variant}`, "--json"]));
    await cli(["enroll", task.id, "--workflow", "digest", "--json"]);

    // Read the pin off disk rather than out of a CLI view: what the criterion is
    // about is the identity the task carries, which is what a later mismatch is
    // compared against.
    const record = JSON.parse(
      await readFile(path.join(project, ".autosk", "tasks", task.id, "task.json"), "utf8"),
    );
    const identity = record.metadata?.runtime_identity;
    assert.ok(identity, `${variant}: the task carries no runtime identity pin`);
    assert.equal(identity.workflow, "digest");
    pinned[variant] = identity.graph;
    await delay(10);
  }

  // Every variant differs from the base, and no two agree: five components, five
  // distinct digests, none of them the base's.
  for (const [variant, digest] of Object.entries(pinned)) {
    assert.ok(typeof digest === "string" && digest.length === 64, `${variant}: ${digest} is not a digest`);
    if (variant === "base") continue;
    assert.notEqual(digest, pinned.base, `${variant} changed and workflow_graph_digest did not`);
  }
  assert.equal(new Set(Object.values(pinned)).size, 6, `two variants share a digest: ${JSON.stringify(pinned)}`);

  // And the document digests moved too, which is what makes the shape digest
  // move: a variant whose document digest had not changed would be measuring
  // something other than the component it names.
  assert.equal(new Set(Object.values(documentDigests)).size, 6);

  // The control, and the reason patch 0032 exists. What a declaration can
  // express — the step names, their kinds, the statuses they drive and the hooks
  // they carry — is identical in all six. So the digest did not move six ways
  // because the declaration differed; it moved because the document's digest is
  // in the shape, and none of these five components is otherwise in it.
  const declared = (document) =>
    JSON.stringify(
      document.steps
        .map((step) => [step.name, step.kind, step.status ?? null, (step.hooks ?? ["onRun"]).join(",")])
        .sort(),
    );
  const shapes = new Set(Object.values(VARIANTS).map((mutate) => declared(mutate(clone(BASE)))));
  assert.equal(shapes.size, 1, "a variant changed what the declaration itself expresses, so this proves less");

  console.log(
    JSON.stringify({
      passed: Object.keys(pinned).length,
      failed: 0,
      skipped: 0,
      runtime: process.version,
      platform: process.platform,
      arch: process.arch,
      workflow_graph_digest: pinned,
      document_digest: documentDigests,
    }),
  );
  console.log("PASS every component of criterion 2 moves the digest the daemon pins");
} finally {
  try {
    await daemon.stop();
  } finally {
    await writeFile(path.join(root, "daemon.log"), daemon.log);
    console.log(`Evidence retained: ${root}`);
  }
}
