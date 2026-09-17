#!/usr/bin/env node

/**
 * The register reaching the CLI, measured where the ticket placed the debt.
 *
 * The graph document declares `external_operations` — the statuses an operation
 * outside the workflow performs — but until this patch only a DIGEST of the
 * document crossed the daemon boundary, so `resume --to` restated the status
 * union (`done|cancel|human`) instead of reading the register. The drift that
 * produced: declare an operation whose status `resume.go` does not list, and
 * nothing notices — the CLI cannot name it, cannot accept it, and refuses
 * nothing, because the declaration never arrived.
 *
 * The fix carries the register on the workflow definition as `exits`: the
 * factory projects `external_operations[].status` into it, the registry refuses
 * a status outside the union at registration, the shape digest covers it, and
 * `registry.workflow.get` renders it — so the CLI's answer to `--to` is the
 * register's, not a literal's.
 *
 * Four projects against a real daemon, each measuring one clause of the fix:
 *
 *   - `declared`: a document-built workflow whose register names `cancel`. The
 *     CLI must NAME it (`workflow show` renders `exits`), ACCEPT it
 *     (`resume --to cancel` exits 0), and REFUSE what the register did not
 *     declare — both a typo (`--to typo`) and a genuine graph refusal
 *     (`--to human`, a step the recovery row does not permit) exit 2 in text
 *     AND `--json`, because a declined operation is not an internal error.
 *   - `union`: a hand-written workflow declaring no `exits` keeps the union
 *     default — every `done|cancel|human` relocation is acceptable, which is
 *     what the wire answered before the field existed.
 *   - `drift`: the same document plus a register entry naming `limbo` — a
 *     status the wire cannot carry. Pre-fix it registers silently and the CLI
 *     cannot tell it from a typo; the fix refuses the document at build
 *     (`status_unknown`) and the registry refuses a hand-written equivalent.
 *   - `hand-ok`: a hand-written workflow declaring `exits:["human"]` — the
 *     register gates: the declared `human` is accepted, `done` is refused in
 *     text and `--json` alike.
 *   - `human-declared`: a document registering `[cancel, human]` with no
 *     `human` step — a task parked at `human` is the graph's own parked
 *     state, so every legitimate move (`--to human`, `--to cancel`, a
 *     permitted step re-entry) must still land.
 *
 * Usage: node scripts/verify-autosk-exits.mjs <prefix> [factoryPath]
 *
 * <prefix> holds bin/autosk and bin/autoskd built from the tree under test.
 * `factoryPath` overrides the shipped factory — used once, to measure this
 * verifier against a pre-fix factory: the register drift was silent there too
 * (`limbo` registered as if performable), which the current factory refuses.
 * The run is isolated: HOME is a mkdtemp child of the run dir (the daemon's
 * ~/.autosk lands there, never the operator's), AUTOSK_SOCK is a private
 * socket, AUTOSK_NO_AUTO_INSTALL skips first-run bootstrap, and PATH is the
 * prefix's bin only. Verified before and after: the spawn env carries the
 * child HOME, and the operator's `~/.autosk/projects.json` is byte-identical
 * before and after the run (or still absent).
 */

import assert from "node:assert/strict";
import { constants, existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Daemon, cli as runCli, delay } from "./lib/autosk-daemon.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const prefixArg = process.argv[2];
if (!prefixArg) throw new Error("usage: node scripts/verify-autosk-exits.mjs <prefix>");

const prefix = path.resolve(prefixArg);
const bin = (name) => path.join(prefix, "bin", name);
const root = await mkdtemp(path.join(tmpdir(), "autosk-exits-"));
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
 * A minimal document — the same shape `verify-autosk-graph-digest.mjs` uses —
 * with the register the variants differ in. `evaluate` is fixed to `never` in
 * the generated extension, so `start` finds no candidate edge and the task
 * parks there with `fixture_no_exit` — the state every `resume` probe needs.
 */
const BASE = {
  workflow: "exits",
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
  caps: [],
  recovery: [
    { reason: "fixture_no_exit", parks_at: ["start", "next"], resume_targets: ["done", "next", "start"], required_state: "n/a" },
  ],
};

const extensionSource = (documentJson) => `
import { buildWorkflow } from "./workflow-factory.mjs";

const document = ${documentJson};

export default function (autosk) {
  autosk.registerWorkflow(buildWorkflow(document, { evaluate: (predicate) => predicate === "never" }));
}
`;

/** A hand-written workflow declaring `exits` directly — no document involved. */
const handSource = (name, exits) => `
export default function (autosk) {
  autosk.registerWorkflow({
    name: ${JSON.stringify(name)},
    firstStep: "review",
    ${exits === undefined ? "" : `exits: ${JSON.stringify(exits)},`}
    steps: {
      review: { status: "human" },
      finish: { status: "done" },
    },
  });
}
`;

for (const name of ["autosk", "autoskd"]) {
  await access(bin(name), constants.X_OK);
}

// Isolation verified BEFORE the daemon is spawned: the env handed to every
// spawn names the child HOME, and the operator's own projects.json is
// snapshotted so the run can prove it wrote nothing there.
const realHome = process.env.HOME;
assert.notEqual(taskHome, realHome, "the isolated HOME must differ from the operator's");
assert.equal(env.HOME, taskHome, "the spawn env must carry the child HOME");
const realProjectsFile = path.join(realHome ?? "", ".autosk", "projects.json");
const realProjectsBefore = existsSync(realProjectsFile)
  ? await readFile(realProjectsFile, "utf8")
  : null;

await mkdir(path.join(taskHome, ".autosk"), { recursive: true });
await writeFile(path.join(taskHome, ".autosk", "settings.json"), "{}\n");

const { graphDigest } = await import(path.join(ROOT, "scripts/validate-workflow-graph.mjs"));
// The factory imports the canonical form; both ship, as the digest verifier
// learned when a moved module left the extension unloadable.
const factoryPath = process.argv[3] ?? path.join(ROOT, "src/host/workflow-factory.mjs");
const factory = await readFile(factoryPath, "utf8");
const canonical = await readFile(path.join(ROOT, "src/host/workflow-graph-canonical.mjs"), "utf8");

const daemon = new Daemon({ bin: bin("autoskd"), sock, env });
const failures = [];

/**
 * One project with one extension: the factory + canonical beside it when the
 * extension needs them, the index.js always. `init` triggers the load that the
 * register checks run inside.
 */
async function projectWithExtension(project, extName, indexJs) {
  const extensionDir = path.join(project, ".autosk", "extensions", extName);
  await mkdir(extensionDir, { recursive: true });
  if (indexJs.includes("workflow-factory")) {
    await writeFile(path.join(extensionDir, "workflow-factory.mjs"), factory);
    await writeFile(path.join(extensionDir, "workflow-graph-canonical.mjs"), canonical);
  }
  await writeFile(path.join(extensionDir, "index.js"), indexJs);
  await runCli(bin("autosk"), { cwd: project, env }, ["init"]);
}

/** Like {@link runCli} but returns the code and stderr for refusal assertions. */
async function cliProbe(cwd, args) {
  const { spawn } = await import("node:child_process");
  const child = spawn(bin("autosk"), args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { code, stdout, stderr };
}

/** Parks a task in `workflow` and returns its id, waiting for the park to land. */
async function parkTask(project, workflow) {
  const cli = (args) => runCli(bin("autosk"), { cwd: project, env }, args);
  const created = JSON.parse(await cli(["create", "exits probe", "--json"]));
  await cli(["enroll", created.id, "--workflow", workflow, "--json"]);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const view = JSON.parse(await cli(["show", created.id, "--json"]));
    if (view.status === "human") return created.id;
    await delay(50);
  }
  throw new Error(`${workflow}: task ${created.id} never parked`);
}

try {
  daemon.start();
  await daemon.ready();

  // -- declared: the register names `cancel`; the CLI must answer to it ------
  const declared = path.join(root, "declared");
  const declaredDoc = {
    ...BASE,
    external_operations: [{ status: "cancel", executor: "autosk resume <id> --to cancel" }],
  };
  declaredDoc.canonical_digest = graphDigest(declaredDoc);
  await projectWithExtension(declared, "exits", extensionSource(JSON.stringify(declaredDoc)));

  const cliD = (args, expected = 0) => runCli(bin("autosk"), { cwd: declared, env }, args, expected);

  // Named: the register renders on the wire, in JSON and in text.
  try {
    const shown = JSON.parse(await cliD(["workflow", "show", "exits", "--json"]));
    assert.ok(
      Array.isArray(shown.exits) && shown.exits.includes("cancel"),
      `exits=${JSON.stringify(shown.exits)}`,
    );
  } catch (e) {
    failures.push(`named-json: ${e.message}`);
  }
  try {
    const shownText = await cliD(["workflow", "show", "exits"]);
    assert.match(shownText, /^exits:\s+cancel$/mu);
  } catch (e) {
    failures.push(`named-text: ${e.message}`);
  }

  // Accepted: the declared status is sent as a status and the move lands.
  try {
    const id = await parkTask(declared, "exits");
    const out = await cliD(["resume", id, "--to", "cancel", "--json"]);
    assert.equal(JSON.parse(out).status, "cancel", `resume --to cancel did not relocate: ${out}`);
  } catch (e) {
    failures.push(`accepted: ${e.message}`);
  }

  // Refused deliberately, in text AND --json: a name the register does not
  // carry is sent as a step and the daemon declines it — exit 2, not a crash
  // (1) and not silence (0). A refusal the graph itself issues — `human` is a
  // step the recovery row does not permit — answers the same code in both
  // modes, because a declined operation is not an internal error.
  try {
    const id = await parkTask(declared, "exits");
    for (const flags of [[], ["--json"]]) {
      await runCli(bin("autosk"), { cwd: declared, env }, ["resume", id, "--to", "typo", ...flags], 2);
      const refused = await cliProbe(declared, ["resume", id, "--to", "human", ...flags]);
      assert.equal(refused.code, 2, `resume --to human ${flags.join(" ") || "(text)"}: exit ${refused.code}: ${refused.stderr}`);
      assert.match(refused.stderr, /resume_target_not_permitted/u);
    }
  } catch (e) {
    failures.push(`refused-undeclared: ${e.message}`);
  }

  // `done` is not an exit of this workflow, so it is sent as a step target —
  // and the park reason's row permits that step, so the move lands as a step
  // entry rather than a status flip. Same word, the register decides which.
  try {
    const id = await parkTask(declared, "exits");
    const out = await cliD(["resume", id, "--to", "done", "--json"]);
    assert.equal(JSON.parse(out).status, "done", `resume --to done as a step target did not land: ${out}`);
  } catch (e) {
    failures.push(`register-scoped: ${e.message}`);
  }

  // -- union: no register declared; the union default answers ---------------
  const union = path.join(root, "union");
  await projectWithExtension(union, "plain", handSource("plain", undefined));
  try {
    const shown = JSON.parse(
      await runCli(bin("autosk"), { cwd: union, env }, ["workflow", "show", "plain", "--json"]),
    );
    assert.deepEqual(
      shown.exits,
      ["done", "cancel", "human"],
      `a workflow declaring no register must render the union, got ${JSON.stringify(shown.exits)}`,
    );
    const id = await parkTask(union, "plain");
    const out = await runCli(bin("autosk"), { cwd: union, env }, ["resume", id, "--to", "done", "--json"]);
    assert.equal(JSON.parse(out).status, "done", `union workflow refused --to done: ${out}`);
  } catch (e) {
    failures.push(`union-default: ${e.message}`);
  }

  // -- drift: a register entry the wire cannot carry -------------------------
  //
  // `limbo` is outside `done|cancel|human`. Pre-fix this registered silently:
  // the workflow listed, the CLI never named `limbo`, `--to limbo` read as a
  // step and was refused exactly like `typo` — indistinguishable from a
  // declaration that never happened. The fix refuses it at build.
  const drift = path.join(root, "drift");
  const driftDoc = {
    ...BASE,
    workflow: "drifted",
    external_operations: [{ status: "limbo", executor: "autosk resume <id> --to limbo" }],
  };
  driftDoc.canonical_digest = graphDigest(driftDoc);
  await projectWithExtension(drift, "drift", extensionSource(JSON.stringify(driftDoc)));

  try {
    const driftList = JSON.parse(
      await runCli(bin("autosk"), { cwd: drift, env }, ["workflow", "list", "--json"]),
    );
    assert.ok(
      !driftList.some((wf) => wf.name === "drifted"),
      `a document declaring an unperformable status registered: ${JSON.stringify(driftList)}`,
    );
    const driftDiag = JSON.parse(
      await runCli(bin("autosk"), { cwd: drift, env }, ["project", "diagnostics", "--json"]),
    );
    assert.ok(
      (driftDiag.extensions ?? []).some((e) => /limbo|status_unknown/u.test(e.error)),
      `no diagnostic names the refused register entry: ${JSON.stringify(driftDiag)}`,
    );
  } catch (e) {
    failures.push(`drift: ${e.message}`);
  }

  // The same refusal for a hand-written definition: the registry checks the
  // subset itself, because the field is writeable by code no document produced.
  const handBad = path.join(root, "hand-bad");
  await projectWithExtension(handBad, "bad", handSource("bad", ["limbo"]));
  try {
    const handBadList = JSON.parse(
      await runCli(bin("autosk"), { cwd: handBad, env }, ["workflow", "list", "--json"]),
    );
    assert.ok(
      !handBadList.some((wf) => wf.name === "bad"),
      `a definition declaring exits:[limbo] registered: ${JSON.stringify(handBadList)}`,
    );
    const handBadDiag = JSON.parse(
      await runCli(bin("autosk"), { cwd: handBad, env }, ["project", "diagnostics", "--json"]),
    );
    assert.ok(
      (handBadDiag.extensions ?? []).some((e) => /exits/u.test(e.error)),
      `no diagnostic names the refused exits: ${JSON.stringify(handBadDiag)}`,
    );
  } catch (e) {
    failures.push(`hand-refused: ${e.message}`);
  }

  // And the symmetric hand-written declaration that IS a subset: `human`
  // declared is accepted, `done` not declared is refused — the register gates
  // what the union alone would have admitted.
  const handOk = path.join(root, "hand-ok");
  await projectWithExtension(handOk, "gated", handSource("gated", ["human"]));
  try {
    const id = await parkTask(handOk, "gated");
    await runCli(bin("autosk"), { cwd: handOk, env }, ["resume", id, "--to", "human", "--json"]);
    const id2 = await parkTask(handOk, "gated");
    for (const flags of [[], ["--json"]]) {
      await runCli(bin("autosk"), { cwd: handOk, env }, ["resume", id2, "--to", "done", ...flags], 2);
    }
  } catch (e) {
    failures.push(`hand-gated: ${e.message}`);
  }

  // -- human-declared: `human` carried by the register, not by a status step --
  //
  // A task parked at `human` is the graph's own parked state, not evidence
  // that an external exit already ran — so `admit` must not read a parked
  // task standing at a registered status as outside the graph. The document
  // registers `[cancel, human]` and carries no `human` step: parked, every
  // legitimate move must still land — the declared `human` (a no-op resume),
  // the declared `cancel`, and a step re-entry the recovery row permits.
  const humanDeclared = path.join(root, "human-declared");
  const humanDoc = {
    ...BASE,
    workflow: "humane",
    steps: BASE.steps.filter((step) => step.name !== "human"),
    transitions: BASE.transitions.filter((t) => t.to !== "human"),
    external_operations: [
      { status: "cancel", executor: "autosk resume <id> --to cancel" },
      { status: "human", executor: "autosk resume <id> --to human" },
    ],
  };
  humanDoc.canonical_digest = graphDigest(humanDoc);
  await projectWithExtension(humanDeclared, "humane", extensionSource(JSON.stringify(humanDoc)));
  try {
    const shown = JSON.parse(
      await runCli(bin("autosk"), { cwd: humanDeclared, env }, ["workflow", "show", "humane", "--json"]),
    );
    assert.deepEqual(
      shown.exits,
      ["cancel", "human"],
      `the declared register must render as declared, got ${JSON.stringify(shown.exits)}`,
    );
    const statusOf = (out) => JSON.parse(out).status;
    const idHuman = await parkTask(humanDeclared, "humane");
    const toHuman = await runCli(
      bin("autosk"), { cwd: humanDeclared, env }, ["resume", idHuman, "--to", "human", "--json"],
    );
    assert.equal(statusOf(toHuman), "human", `--to human on a parked task did not land: ${toHuman}`);
    const idNext = await parkTask(humanDeclared, "humane");
    const toNext = await runCli(
      bin("autosk"), { cwd: humanDeclared, env }, ["resume", idNext, "--to", "next", "--json"],
    );
    assert.equal(statusOf(toNext), "work", `step re-entry the row permits did not land: ${toNext}`);
    const idCancel = await parkTask(humanDeclared, "humane");
    const toCancel = await runCli(
      bin("autosk"), { cwd: humanDeclared, env }, ["resume", idCancel, "--to", "cancel", "--json"],
    );
    assert.equal(statusOf(toCancel), "cancel", `the declared cancel did not land: ${toCancel}`);
  } catch (e) {
    failures.push(`human-declared: ${e.message}`);
  }

  // The real $HOME gained nothing: the whole run ran under the child HOME.
  try {
    const realProjectsAfter = existsSync(realProjectsFile)
      ? await readFile(realProjectsFile, "utf8")
      : null;
    assert.equal(
      realProjectsAfter,
      realProjectsBefore,
      `the run touched ${realProjectsFile} outside the isolated HOME`,
    );
  } catch (e) {
    failures.push(`home-isolation: ${e.message}`);
  }

  if (failures.length > 0) {
    console.log(JSON.stringify({ passed: false, failures }, null, 2));
    console.log(`FAIL ${failures.length} check(s) — the register does not reach the CLI`);
    process.exitCode = 1;
  } else {
    console.log(
      JSON.stringify({
        passed: true,
        runtime: process.version,
        platform: process.platform,
        arch: process.arch,
        checks: [
          "named-json", "named-text", "accepted", "refused-undeclared", "register-scoped",
          "union-default", "drift", "hand-refused", "hand-gated", "human-declared",
          "home-isolation",
        ],
      }),
    );
    console.log("PASS the register reaches the CLI and answers for it");
  }
} finally {
  try {
    await daemon.stop();
  } finally {
    await writeFile(path.join(root, "daemon.log"), daemon.log);
    console.log(`Evidence retained: ${root}`);
  }
}
