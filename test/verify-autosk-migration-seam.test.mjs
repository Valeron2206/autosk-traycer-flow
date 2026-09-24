import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import test, { after } from "node:test";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

import { digestOf } from "../scripts/lib/produced-source.mjs";
import { assertExecutedSurface, assertLaunchIntegrity, assertNoEngineLoad, MEASURER_FILES } from "../scripts/lib/seam-engine-gate.mjs";
import { classifySeam, pinHelperState } from "../scripts/verify-autosk-migration-seam.mjs";

const D_OLD = "a".repeat(64);
const D_NEW = "b".repeat(64);
const GRAPH = "c".repeat(64);
const DOCUMENT = "d".repeat(64);
const HELPER = "e".repeat(64);
const RECEIPT = "f".repeat(64);
const SOURCE_TREE = "0".repeat(40);
const SCRIPT_SHA = "9".repeat(64);

const pin = (over = {}) => ({
  state: "pinned",
  pin: { workflow: "seam-flow", digest: D_OLD, graph: GRAPH, document: DOCUMENT, helper: HELPER, ...over },
});

const taskFile = (id) => `.autosk/tasks/${id}/task.json`;
const diskRead = (id, pinRead) => ({ file: taskFile(id), pin: pinRead });

/**
 * The record the driver emits on the defective tree today: helper present
 * before the move, absent after it, resume refused. Every test mutates a copy
 * of this rather than building records by hand, so a field the classification
 * depends on cannot quietly go missing.
 */
const EXECUTED_FILES = [
  { path: "bin/autosk-store-lock", sha256: HELPER },
  { path: "daemon/node_modules/@autosk/sdk/src/index.ts", sha256: SCRIPT_SHA },
];

function record(over = {}) {
  return {
    band: "migration-seam",
    project_dir: "/tmp/autosk-migration-seam-test/project",
    project_dir_physical: "/private/tmp/autosk-migration-seam-test/project",
    bound: {
      source_tree: SOURCE_TREE,
      source: {
        files: MEASURER_FILES.map((name) => ({ path: name, sha256: SCRIPT_SHA })),
        listings: [],
        digest: SCRIPT_SHA,
      },
      executed: {
        files: EXECUTED_FILES.map((file) => ({ ...file })),
        listings: [],
        digest: digestOf(EXECUTED_FILES, []),
      },
    },
    served: {
      before: { digest: D_OLD, graph: GRAPH, document: DOCUMENT },
      after: { digest: D_NEW, graph: GRAPH, document: DOCUMENT },
    },
    old_distribution: {
      bytes_held: false,
      not_held_reason: "root cannot be read: ENOENT: no such file or directory",
      index_file: ".autosk/runtime/v1/index.json",
      restorable_after_update: false,
    },
    migrated_task: {
      id: "ask-migrated",
      pin_before: diskRead("ask-migrated", pin()),
      pin_after: diskRead("ask-migrated", pin({ digest: D_NEW, helper: undefined })),
      resume_decision: {
        ok: false,
        reason: "extension_version_mismatch: seam-flow has no recorded store helper for this task",
      },
    },
    migration: {
      plan: { supported: true, from: D_OLD, to: D_NEW, workflow: "seam-flow", impact: [] },
      apply: { ok: true, receipt: { id: RECEIPT, from: D_OLD, to: D_NEW, completed_at: "2026-01-01T00:00:00Z" } },
    },
    control: {
      read_back_before_migration: { task: "ask-migrated", ...diskRead("ask-migrated", pin()) },
      fresh_admission_after_migration: {
        task: "ask-witness",
        ...diskRead("ask-witness", pin({ digest: D_NEW })),
        resume_decision: { ok: true, admitted: pin({ digest: D_NEW }).pin },
      },
    },
    ...over,
  };
}

test("the defective state is a valid measurement, not a failure", () => {
  const verdict = classifySeam(record());
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.measured, {
    helper: "absent",
    resume: "refused",
    refusal: "extension_version_mismatch",
  });
  assert.equal(verdict.control.read_back_before_migration, "present");
  assert.equal(verdict.control.fresh_admission_helper, "present");
});

test("the fixed state keeps the band green and changes only the value", () => {
  const verdict = classifySeam(
    record({
      migrated_task: {
        ...record().migrated_task,
        pin_after: diskRead("ask-migrated", pin({ digest: D_NEW })),
        resume_decision: { ok: true, admitted: pin({ digest: D_NEW }).pin },
      },
    }),
  );
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.measured, { helper: "present", resume: "admitted", refusal: null });
});

test("a control that cannot report PRESENT fails the run — ABSENT is only meaningful beside it", () => {
  const noPreRead = record();
  noPreRead.migrated_task.pin_before = diskRead("ask-migrated", pin({ helper: undefined }));
  const verdict = classifySeam(noPreRead);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((f) => f.includes("pre-migration read-back")));
});

test("a fresh admission without helper fails the run the same way", () => {
  const broken = record();
  broken.control.fresh_admission_after_migration.pin = pin({ digest: D_NEW, helper: undefined });
  const verdict = classifySeam(broken);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((f) => f.includes("fresh admission")));
});

test("a witness the gate refuses fails the control even with helper present", () => {
  const broken = record();
  broken.control.fresh_admission_after_migration.resume_decision = { ok: false, reason: "refused" };
  const verdict = classifySeam(broken);
  assert.equal(verdict.ok, false);
});

test("a refused plan is a broken measurer, not a measurement", () => {
  const verdict = classifySeam(record({ migration: { plan: { supported: false, reason: "already serves" }, apply: { ok: false } } }));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((f) => f.includes("migrate plan")));
  assert.ok(verdict.failures.some((f) => f.includes("migrate apply")));
});

test("a registry still serving the old digest means the seam was never reached", () => {
  const verdict = classifySeam(
    record({ served: { before: { digest: D_OLD, graph: GRAPH }, after: { digest: D_OLD, graph: GRAPH } } }),
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((f) => f.includes("changed nothing")));
});

test("a restorable old distribution means the loader would have served it", () => {
  const verdict = classifySeam(record({ old_distribution: { ...record().old_distribution, restorable_after_update: true } }));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((f) => f.includes("restorable")));
});

test("a record that says bytes were held exercised no holding failure", () => {
  const verdict = classifySeam(record({ old_distribution: { ...record().old_distribution, bytes_held: true } }));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((f) => f.includes("bytes_held")));
});

test("the reason the store composes for a rootless record names the regression it is", () => {
  // `recordDistribution` called without a root is the construction nothing in
  // production makes; the store's own words for it must not pass as a real
  // holding failure.
  const verdict = classifySeam(
    record({
      old_distribution: { ...record().old_distribution, not_held_reason: "no distribution root was given" },
    }),
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((f) => f.includes("without a root")));
});

test("a pin read that names no file could have come from the cache, so it fails", () => {
  const broken = record();
  broken.migrated_task.pin_after = { pin: pin({ digest: D_NEW }) };
  const verdict = classifySeam(broken);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((f) => f.includes("task.json")));
});

test("a pin read naming another task's file is not the read it claims to be", () => {
  const broken = record();
  broken.migrated_task.pin_before = diskRead("ask-other", pin());
  const verdict = classifySeam(broken);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((f) => f.includes("not the file of task ask-migrated")));
});

test("a record that does not bind the measured tree cannot be verified downstream", () => {
  const verdict = classifySeam(record({ bound: { ...record().bound, source_tree: "not-an-oid" } }));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((f) => f.includes("patched source tree")));
});

test("a record that does not bind the measurer's own bytes cannot be verified downstream", () => {
  const verdict = classifySeam(
    record({ bound: { ...record().bound, source: { files: [], listings: [], digest: SCRIPT_SHA } } }),
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((f) => f.includes("measurer's own script bytes")));
});

test("a record that binds only the tracked tree leaves the executed surface unverifiable", () => {
  // `daemon/node_modules` is git-ignored: `source_tree` cannot see a repointed
  // workspace link or a copied directory there, so a record without the
  // executed binding could be describing bytes nobody named.
  const verdict = classifySeam(record({ bound: { ...record().bound, executed: undefined } }));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((f) => f.includes("executed surface")));
});

test("an executed binding without the store-lock helper leaves executed bytes unnamed", () => {
  // The helper is a built binary in the ignored bin/ tree and it runs during
  // the measurement; a binding that lists installed modules but not it is
  // decoration.
  const files = EXECUTED_FILES.filter((file) => file.path !== "bin/autosk-store-lock");
  const verdict = classifySeam(
    record({ bound: { ...record().bound, executed: { files, listings: [], digest: digestOf(files, []) } } }),
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((f) => f.includes("store-lock helper")));
});

test("an executed digest that does not recompute over its members fails the run", () => {
  const executed = { files: [...EXECUTED_FILES], listings: [], digest: "0".repeat(64) };
  const verdict = classifySeam(record({ bound: { ...record().bound, executed } }));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((f) => f.includes("does not recompute")));
});

test("an executed member outside the install roots is a claim outside the binding's scope", () => {
  const files = [...EXECUTED_FILES, { path: "docs/contracts/x.md", sha256: SCRIPT_SHA }];
  const verdict = classifySeam(
    record({ bound: { ...record().bound, executed: { files, listings: [], digest: digestOf(files, []) } } }),
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((f) => f.includes("not an installed module")));
});

test("a helper-only executed binding is not a measurement of the module surface", () => {
  // Every other check a helper-only record passes — it recomputes, it names
  // the helper, every member is in scope — which is exactly why the module
  // part needs a floor of its own.
  const files = EXECUTED_FILES.filter((file) => !file.path.includes("node_modules/"));
  const verdict = classifySeam(
    record({ bound: { ...record().bound, executed: { files, listings: [], digest: digestOf(files, []) } } }),
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((f) => f.includes("no installed module member")));
});

test("the measure-time floor refuses a walk that bound no module", () => {
  // The same floor the consumer checks is asserted over the walk's own
  // output at measure time — before the helper is even added — so a walker
  // that found nothing cannot produce a binding at all.
  assert.throws(
    () => assertExecutedSurface([{ path: "bin/autosk-store-lock", sha256: HELPER }], []),
    /bound no installed module/u,
  );
  // And each workspace package the imports resolve through must contribute:
  // a verified link that yielded no bound bytes names an unbound import.
  assert.throws(
    () =>
      assertExecutedSurface(
        [
          { path: "daemon/node_modules/some-dep/index.js", sha256: SCRIPT_SHA },
          { path: "bin/autosk-store-lock", sha256: HELPER },
        ],
        ["@autosk/sdk"],
      ),
    /daemon\/node_modules\/@autosk\/sdk/u,
  );
  assertExecutedSurface(EXECUTED_FILES, ["@autosk/sdk"]);
});

test("a record without a resume answer is incomplete, not refused", () => {
  // Deleting the field must not print as the refusal the defective state
  // produces — an absent answer is a broken record, not a measured value.
  const seam = record();
  delete seam.migrated_task.resume_decision;
  const verdict = classifySeam(seam);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((f) => f.includes("no resume answer")));
  assert.equal(verdict.measured.resume, "absent");
});

test("a refusal without a reason is incomplete, not a refusal", () => {
  const seam = record();
  seam.migrated_task.resume_decision = { ok: false };
  const verdict = classifySeam(seam);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((f) => f.includes("no refusal reason")));
});

test("a pin read that does not carry its distribution digest is incomplete", () => {
  // The rendered cells quote the pin's own digest — a pin read without one
  // has nothing to render.
  const seam = record();
  delete seam.migrated_task.pin_after.pin.pin.digest;
  const verdict = classifySeam(seam);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((f) => f.includes("post-migration pin read")));
});

test("a record that does not name its project root cannot render its store reason safely", () => {
  const verdict = classifySeam(record({ project_dir: undefined }));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((f) => f.includes("project root")));

  // The loader realpaths distribution roots, so the store's reason may embed
  // the physical form even when the logical one is recorded — without it the
  // renderer would classify the measured path as outside the project.
  const noPhysical = classifySeam(record({ project_dir_physical: undefined }));
  assert.equal(noPhysical.ok, false);
  assert.ok(noPhysical.failures.some((f) => f.includes("physical project root")));
});

test("a malformed post-migration pin is reported as unreadable, not as helper absent", () => {
  const verdict = classifySeam(
    record({
      migrated_task: {
        ...record().migrated_task,
        pin_after: diskRead("ask-migrated", { state: "malformed", reason: "runtime identity pin has unexpected keys: x" }),
      },
    }),
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.measured.helper, "pin_malformed");
  assert.notEqual(verdict.measured.helper, "absent");
});

test("pinHelperState distinguishes present, absent, and unreadable", () => {
  assert.equal(pinHelperState(pin()), "present");
  assert.equal(pinHelperState(pin({ helper: undefined })), "absent");
  assert.equal(pinHelperState(pin({ helper: "not-a-digest" })), "absent");
  assert.equal(pinHelperState({ state: "absent" }), "pin_absent");
  assert.equal(pinHelperState({ state: "malformed", reason: "x" }), "pin_malformed");
  assert.equal(pinHelperState(undefined), "pin_missing");
});

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const driverSource = readFileSync(`${REPO_ROOT}scripts/verify-autosk-migration-seam.driver.ts`, "utf8");
const gateSource = readFileSync(`${REPO_ROOT}scripts/lib/seam-engine-gate.mjs`, "utf8");
const wrapperSource = readFileSync(`${REPO_ROOT}scripts/verify-autosk-migration-seam.mjs`, "utf8");

test("the driver reaches engine modules only through the gate", () => {
  // The ordering guarantee is structural: the driver holds no import
  // expression for the measured tree at all, so nothing can be loaded before
  // the gate's checks — not by reordering, only by adding an import, which
  // this test refuses.
  assert.equal(driverSource.includes("await import"), false);
  const specifiers = [...driverSource.matchAll(/from\s+["']([^"']+)["']/gu)].map((match) => match[1]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith("node:") || specifier.endsWith("seam-engine-gate.mjs"),
      `driver imports ${specifier} directly — engine access belongs to the gate alone`,
    );
  }
  // And the spawn arms the load log under a launch the wrapper owns.
  assert.match(wrapperSource, /--preload=\$\{PRELOAD\}/u);
  assert.match(wrapperSource, /--cwd=\$\{launch\}/u);
  assert.match(wrapperSource, /--config=\$\{seamBunfig\}/u);
  assert.match(wrapperSource, /--no-env-file/u);
});

test("the gate's checks precede its imports in program order", () => {
  // Inside one function body the textual order is the execution order; pin it
  // so a later edit cannot slip an import above the guard. Landmarks are
  // sought inside loadVerifiedEngine's body — after its declaration — so a
  // helper defined earlier in the file cannot satisfy the ordering vacuously.
  const body = gateSource.indexOf("export async function loadVerifiedEngine");
  const order = [
    "assertLaunchIntegrity({",
    "assertNoEngineLoad(moduleLoads",
    'execFileSync("git"',
    "walkExecuted(root",
    "assertMeasurerLoads(moduleLoads",
    "bindSource(REPO",
    "await import(",
  ].map((landmark) => gateSource.indexOf(landmark, body));
  assert.ok(order.every((index) => index !== -1), "the gate's guard and import landmarks must all be present");
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("the load log proves the guard ran before any engine load", () => {
  const entry = { specifier: "/repo/scripts/verify-autosk-migration-seam.driver.ts", importer: "bun:main" };
  const repoLoads = [
    entry,
    { specifier: "node:fs", importer: "/repo/scripts/verify-autosk-migration-seam.driver.ts" },
    { specifier: "./lib/seam-engine-gate.mjs", importer: "/repo/scripts/verify-autosk-migration-seam.driver.ts" },
  ];
  assertNoEngineLoad(repoLoads, "/src", "/private/src");

  // Without a bun:main entry nothing proves the hook was armed early — a
  // spawn that skipped --preload must refuse rather than pass vacuously.
  assert.throws(() => assertNoEngineLoad(repoLoads.slice(1), "/src", "/private/src"), /--preload/u);

  for (const early of [
    { specifier: "/src/daemon/core/src/store/store.ts", importer: "/repo/scripts/x.ts" },
    { specifier: "/private/src/daemon/sdk/src/index.ts", importer: "/repo/scripts/x.ts" },
    { specifier: "./dep.ts", importer: "/src/daemon/core/src/a.ts" },
    { specifier: "@autosk/sdk", importer: "/repo/scripts/x.ts" },
    { specifier: "node:fs", importer: "/src/daemon/core/src/a.ts" },
  ]) {
    assert.throws(
      () => assertNoEngineLoad([entry, early], "/src", "/private/src"),
      /before the surface guard ran/u,
      `${JSON.stringify(early)} must refuse`,
    );
  }
});

const launchDirs = [];
after(() => {
  for (const dir of launchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const launchFixture = () => {
  const runRoot = mkdtempSync(join(tmpdir(), "seam-launch-"));
  launchDirs.push(runRoot);
  const launch = join(runRoot, "launch");
  const project = join(runRoot, "project");
  mkdirSync(launch, { recursive: true });
  mkdirSync(project, { recursive: true });
  const nonce = "abc123nonce";
  const bunfig = join(runRoot, "seam.bunfig.toml");
  writeFileSync(bunfig, `# autosk-seam launch config\n# nonce ${nonce}\n`);
  return {
    execArgv: [
      `--cwd=${launch}`,
      `--config=${bunfig}`,
      "--no-env-file",
      `--preload=${join(REPO_ROOT, "scripts/lib/seam-module-loads.mjs")}`,
    ],
    env: {
      AUTOSK_SEAM_LAUNCH_DIR: launch,
      AUTOSK_SEAM_BUNFIG: bunfig,
      AUTOSK_SEAM_NONCE: nonce,
      AUTOSK_PROJECT_DIR: project,
    },
    cwd: launch,
    entry: join(REPO_ROOT, "scripts/verify-autosk-migration-seam.driver.ts"),
    paths: { runRoot, launch, project, bunfig },
  };
};

test("the launch the wrapper spawns passes the gate's argv assertion", () => {
  assert.doesNotThrow(() => assertLaunchIntegrity(launchFixture()));
});

test("a second preload in any alias spelling refuses the launch", () => {
  const hook = join(REPO_ROOT, "scripts/lib/seam-module-loads.mjs");
  for (const second of [
    "--preload=/tmp/evil.mjs",
    "-r /tmp/evil.mjs",
    "-r/tmp/evil.mjs",
    "--require=/tmp/evil.mjs",
    "--import=/tmp/evil.mjs",
  ]) {
    const fixture = launchFixture();
    fixture.execArgv.splice(1, 0, ...second.split(" "));
    assert.throws(() => assertLaunchIntegrity(fixture), /preloads/u, `second preload ${second} must refuse`);
  }
  // An alias spelling of the hook itself still arms the same bytes.
  const aliased = launchFixture();
  aliased.execArgv[3] = `--require=${hook}`;
  assert.doesNotThrow(() => assertLaunchIntegrity(aliased));
});

test("a launch decorated past the contract refuses — bunfig, cwd, env, entry", () => {
  // A bunfig.toml the wrapper did not write — here a config carrying its own
  // preload — must fail even though the path and nonce line up.
  const foreignConfig = launchFixture();
  writeFileSync(foreignConfig.paths.bunfig, `preload = ["/tmp/evil.mjs"]\n# nonce abc123nonce\n`);
  assert.throws(() => assertLaunchIntegrity(foreignConfig), /not the file the wrapper wrote/u);

  const callerCwd = launchFixture();
  callerCwd.execArgv[0] = "--cwd=/tmp";
  assert.throws(() => assertLaunchIntegrity(callerCwd), /cwd/u);

  const processCwd = launchFixture();
  processCwd.cwd = "/tmp";
  assert.throws(() => assertLaunchIntegrity(processCwd), /cwd/u);

  const noEnvFile = launchFixture();
  noEnvFile.execArgv = noEnvFile.execArgv.filter((arg) => arg !== "--no-env-file");
  assert.throws(() => assertLaunchIntegrity(noEnvFile), /--no-env-file/u);

  const extraFlag = launchFixture();
  extraFlag.execArgv.push("--smol");
  assert.throws(() => assertLaunchIntegrity(extraFlag), /did not pass/u);

  const wrongEntry = launchFixture();
  wrongEntry.entry = "/tmp/evil-entry.ts";
  assert.throws(() => assertLaunchIntegrity(wrongEntry), /entry module/u);

  const nodeOptions = launchFixture();
  nodeOptions.env = { ...nodeOptions.env, NODE_OPTIONS: "--preload=/tmp/evil.mjs" };
  assert.throws(() => assertLaunchIntegrity(nodeOptions), /NODE_OPTIONS/u);

  const bunOptions = launchFixture();
  bunOptions.env = { ...bunOptions.env, BUN_OPTIONS: "--preload=/tmp/evil.mjs" };
  assert.throws(() => assertLaunchIntegrity(bunOptions), /BUN_OPTIONS/u);
});

// Every walked file is either a JSON text or parsed. JSON.parse decides the
// text: a JSON text has no call and no import, so it is recorded and not
// parsed, and it still has to be in MEASURER_FILES. Anything else is parsed
// as JavaScript, whatever its extension and with none. An extension that
// lower-cases to .ts, .mts, .cts or .tsx is transformed first. A file that
// neither JSON.parse nor the parse accepts, or that the transform rejects,
// is a violation that names the file and says it did not parse. A path the
// walk cannot read is a violation that names the file and says it could not
// be read: a missing file, or a directory, each of which bun may resolve to
// another file. Name tokens carry no comments and keep strings whole. Any
// name `require`, `createRequire`, `Worker` or `dlopen` refuses. A literal
// import, export-from, `import()` or `require()` source must be relative or
// `node:`; a relative one is walked. A non-literal import, such as the
// gate's engine import, is not this rule.
const acorn = createRequire(fileURLToPath(new URL("../package.json", import.meta.url)))("acorn");
const LOADER_NAMES = new Set(["require", "createRequire", "Worker", "dlopen"]);

function visitAst(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) visitAst(item, visit);
    } else visitAst(child, visit);
  }
}

function measurerClosure(repo, entries) {
  const seen = new Set();
  const violations = [];
  const stack = entries.map((name) => resolve(repo, name));
  while (stack.length > 0) {
    const file = stack.pop();
    const name = relative(repo, file).split(sep).join("/");
    if (seen.has(name)) continue;
    seen.add(name);
    const noted = new Set();
    const note = (specifier) => {
      const key = `${name} ${specifier}`;
      if (noted.has(key)) return;
      noted.add(key);
      violations.push({ file: name, specifier });
    };
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      note("the file could not be read");
      continue;
    }
    try {
      JSON.parse(raw);
      continue;
    } catch {
      // not a JSON text; parse it as JavaScript
    }
    const extension = extname(name).toLowerCase();
    const typescript = extension === ".ts" || extension === ".mts" || extension === ".cts" || extension === ".tsx";
    let js = raw;
    if (typescript) {
      try {
        js = stripTypeScriptTypes(raw, { mode: "transform" });
      } catch {
        note("the file did not parse");
        continue;
      }
    }
    let ast;
    try {
      ast = acorn.parse(js, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
    } catch {
      note("the file did not parse");
      continue;
    }
    visitAst(ast, (node) => {
      if (node.type === "Identifier" && LOADER_NAMES.has(node.name)) note(node.name);
      let spec = null;
      if (
        (node.type === "ImportDeclaration" ||
          node.type === "ExportAllDeclaration" ||
          node.type === "ExportNamedDeclaration") &&
        node.source?.type === "Literal" &&
        typeof node.source.value === "string"
      ) {
        spec = node.source.value;
      } else if (node.type === "ImportExpression" && node.source?.type === "Literal" && typeof node.source.value === "string") {
        spec = node.source.value;
      } else if (
        node.type === "CallExpression" &&
        node.callee?.type === "Identifier" &&
        node.callee.name === "require" &&
        node.arguments?.[0]?.type === "Literal" &&
        typeof node.arguments[0].value === "string"
      ) {
        spec = node.arguments[0].value;
      }
      if (spec === null) return;
      if (spec.startsWith(".")) stack.push(resolve(dirname(file), spec));
      else if (!spec.startsWith("node:")) note(spec);
    });
  }
  return { files: seen, violations };
}

const repoRoot = REPO_ROOT.endsWith("/") ? REPO_ROOT.slice(0, -1) : REPO_ROOT;

test("the measurer's relative-import closure is inside MEASURER_FILES and its literals are relative or node:", () => {
  const { files, violations } = measurerClosure(repoRoot, [
    "scripts/verify-autosk-migration-seam.mjs",
    "scripts/verify-autosk-migration-seam.driver.ts",
  ]);
  assert.deepEqual(
    violations.map((entry) => `${entry.file} ${entry.specifier}`),
    [],
  );
  const missing = [...files].filter((name) => !MEASURER_FILES.includes(name)).sort();
  assert.deepEqual(missing, []);
});

test("the load log refuses a repository module MEASURER_FILES omits and accepts the driver's log", async () => {
  const gate = await import("../scripts/lib/seam-engine-gate.mjs");
  assert.equal(typeof gate.assertMeasurerLoads, "function");
  const repo = repoRoot;
  const physical = realpathSync(repo);
  const driver = join(repo, "scripts/verify-autosk-migration-seam.driver.ts");
  const gateFile = join(repo, "scripts/lib/seam-engine-gate.mjs");
  const source = "/var/empty/autosk-measured-source";
  // bun 1.4.0: the entry is absolute with importer bun:main, and each
  // relative import is logged twice. node: and bun: specifiers are not logged.
  const driverLog = [
    { specifier: driver, importer: "bun:main" },
    { specifier: "./lib/seam-engine-gate.mjs", importer: driver },
    { specifier: "./lib/seam-engine-gate.mjs", importer: driver },
    { specifier: "./produced-source.mjs", importer: gateFile },
    { specifier: "./produced-source.mjs", importer: gateFile },
    { specifier: "./seam-module-loads.mjs", importer: gateFile },
    { specifier: "./seam-module-loads.mjs", importer: gateFile },
  ];
  assert.doesNotThrow(() => gate.assertMeasurerLoads(driverLog, repo, physical, source, source));
  assert.throws(
    () =>
      gate.assertMeasurerLoads(
        [...driverLog, { specifier: "./measured-inputs.mjs", importer: gateFile }],
        repo,
        physical,
        source,
        source,
      ),
    /scripts\/lib\/measured-inputs\.mjs/u,
  );
  const engineFile = join(source, "daemon/core/src/store/store.ts");
  assert.doesNotThrow(() =>
    gate.assertMeasurerLoads(
      [
        ...driverLog,
        { specifier: join(source, "daemon/core/src/store/store.ts"), importer: gateFile },
        { specifier: "lodash.merge", importer: engineFile },
        { specifier: "node:fs", importer: driver },
        { specifier: "bun:ffi", importer: gateFile },
        { specifier: "/usr/lib/outside-the-repo.mjs", importer: "bun:main" },
      ],
      repo,
      physical,
      source,
      source,
    ),
  );
  assert.throws(
    () =>
      gate.assertMeasurerLoads(
        [...driverLog, { specifier: "./zz-unbound.mjs", importer: gateFile }],
        repo,
        physical,
        source,
        source,
      ),
    /scripts\/lib\/zz-unbound\.mjs/u,
  );
});

test("a dotted bare specifier from a measurer module refuses, and one from the engine does not", async () => {
  const gate = await import("../scripts/lib/seam-engine-gate.mjs");
  const repo = repoRoot;
  const physical = realpathSync(repo);
  const gateFile = join(repo, "scripts/lib/seam-engine-gate.mjs");
  const source = "/var/empty/autosk-measured-source";
  const engineFile = join(source, "daemon/core/src/store/store.ts");
  assert.throws(
    () => gate.assertMeasurerLoads([{ specifier: "dotted.pkg", importer: gateFile }], repo, physical, source, source),
    (error) => error instanceof Error && error.message.includes("dotted.pkg") && error.message.includes(gateFile),
  );
  assert.doesNotThrow(() =>
    gate.assertMeasurerLoads([{ specifier: "dotted.pkg", importer: engineFile }], repo, physical, source, source),
  );
  assert.throws(
    () => gate.assertMeasurerLoads([{ specifier: repo, importer: "bun:main" }], repo, physical, source, source),
    /repository root/u,
  );
});

test("a bare literal specifier is named with its file", () => {
  const scratch = mkdtempSync(join(tmpdir(), "measurer-literals-"));
  try {
    mkdirSync(join(scratch, "scripts/lib"), { recursive: true });
    writeFileSync(
      join(scratch, "scripts/lib/seam-engine-gate.mjs"),
      'import { moduleLoads } from "./seam-module-loads.mjs";\nimport "acorn";\n',
    );
    writeFileSync(join(scratch, "scripts/lib/seam-module-loads.mjs"), "export const moduleLoads = [];\n");
    writeFileSync(
      join(scratch, "scripts/verify-autosk-migration-seam.driver.ts"),
      'import { loadVerifiedEngine } from "./lib/seam-engine-gate.mjs";\nimport "acorn";\n',
    );
    const { violations } = measurerClosure(scratch, [
      "scripts/lib/seam-engine-gate.mjs",
      "scripts/verify-autosk-migration-seam.driver.ts",
    ]);
    assert.deepEqual(
      violations.map((entry) => `${entry.file} ${entry.specifier}`).sort(),
      [
        "scripts/lib/seam-engine-gate.mjs acorn",
        "scripts/verify-autosk-migration-seam.driver.ts acorn",
      ],
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the driver checks the load log again before it emits the record", () => {
  const emit = driverSource.lastIndexOf("process.stdout.write");
  const check = driverSource.lastIndexOf("assertMeasurerLoadsBeforeEmit(", emit);
  assert.ok(emit !== -1 && check !== -1 && check < emit);
});

test("the measured source and the run scratch must lie outside the repository", async () => {
  const gate = await import("../scripts/lib/seam-engine-gate.mjs");
  assert.equal(typeof gate.assertSeamTreesOutsideRepository, "function");
  const repo = repoRoot;
  const physical = realpathSync(repo);
  const sourceInside = join(repo, "zz-measured-source");
  const projectInside = join(repo, ".probe-tmp");
  const outside = "/var/empty/autosk-measured-source";
  const projectOutside = "/var/empty/seam-project";
  assert.throws(
    () => gate.assertSeamTreesOutsideRepository(repo, physical, sourceInside, projectOutside),
    (error) =>
      error instanceof Error &&
      error.message.includes(sourceInside) &&
      error.message.includes("is inside the repository") &&
      !error.message.includes("measurer binding"),
  );
  assert.throws(
    () => gate.assertSeamTreesOutsideRepository(repo, physical, outside, projectInside),
    (error) =>
      error instanceof Error &&
      error.message.includes(projectInside) &&
      error.message.includes("is inside the repository") &&
      !error.message.includes("measurer binding"),
  );
  assert.doesNotThrow(() => gate.assertSeamTreesOutsideRepository(repo, physical, outside, projectOutside));
  assert.throws(
    () => gate.assertSeamTreesOutsideRepository(repo, physical, "/", projectOutside),
    (error) => error instanceof Error && error.message.includes("contains the repository"),
  );
  const folded = physical.replace("/Users/", "/users/");
  if (folded !== physical) {
    try {
      if (realpathSync.native(folded) === physical) {
        assert.throws(
          () => gate.assertSeamTreesOutsideRepository(repo, physical, folded, projectOutside),
          (error) => error instanceof Error && error.message.includes("is inside the repository"),
        );
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
});

test("the loader rule names aliases and calls beside strings", () => {
  const scratch = mkdtempSync(join(tmpdir(), "measurer-loaders-"));
  const sources = {
    "scripts/direct.mjs": [
      'import { createRequire } from "node:module";',
      'import { Worker } from "node:worker_threads";',
      'createRequire(import.meta.url)("acorn");',
      'new Worker("./w.mjs");',
      'process.dlopen({ exports: {} }, "/nonexistent.node");',
      'require("node:fs");',
      'import.meta.require("node:fs");',
    ].join("\n"),
    "scripts/v12.mjs": 'import { createRequire as zzLoad } from "node:module";\nzzLoad(import.meta.url)("acorn");\n',
    "scripts/v13.mjs": 'const zzRequire = require;\nzzRequire("acorn");\n',
    "scripts/v14.mjs": 'import { Worker as ZzThread } from "node:worker_threads";\nvoid ZzThread;\n',
    "scripts/v15.mjs": 'import { createRequire } from "node:module";\nconst zzNote = "a//b"; createRequire(import.meta.url)("acorn");\n',
    "scripts/v16.mjs": 'import { createRequire } from "node:module";\nconst zzGlob = "extensions/*";\ncreateRequire(import.meta.url)("acorn");\nconst zzEnd = "*/";\n',
    "scripts/v20.mjs": "const { require: zzReq } = import.meta;\nvoid zzReq;\n",
    "scripts/typed.ts": 'import { createRequire } from "node:module";\nconst label: string = "kept";\ncreateRequire(import.meta.url)(label);\n',
    "scripts/clean.mjs": 'import { readFileSync } from "node:fs";\nconst marker = `// seam-marker: ${"x"}`;\nexport const ok = readFileSync;\nvoid marker;\n',
  };
  const expected = {
    "scripts/direct.mjs": ["Worker", "createRequire", "dlopen", "require"],
    "scripts/v12.mjs": ["createRequire"],
    "scripts/v13.mjs": ["require"],
    "scripts/v14.mjs": ["Worker"],
    "scripts/v15.mjs": ["createRequire"],
    "scripts/v16.mjs": ["createRequire"],
    "scripts/v20.mjs": ["require"],
    "scripts/typed.ts": ["createRequire"],
    "scripts/clean.mjs": [],
  };
  try {
    mkdirSync(join(scratch, "scripts"), { recursive: true });
    for (const [file, source] of Object.entries(sources)) writeFileSync(join(scratch, file), source);
    const actual = {};
    for (const file of Object.keys(sources)) {
      const { violations } = measurerClosure(scratch, [file]);
      actual[file] = [...new Set(violations.filter((entry) => entry.file === file).map((entry) => entry.specifier))].sort();
    }
    assert.deepEqual(actual, expected);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a TypeScript enum is parsed and its loader names are still found", () => {
  const scratch = mkdtempSync(join(tmpdir(), "measurer-enum-"));
  try {
    mkdirSync(join(scratch, "scripts"), { recursive: true });
    writeFileSync(
      join(scratch, "scripts/typed-enum.ts"),
      [
        'import { createRequire } from "node:module";',
        "enum ZzMode { Measure }",
        "void ZzMode.Measure;",
        'createRequire(import.meta.url)("node:fs");',
        "",
      ].join("\n"),
    );
    const { violations } = measurerClosure(scratch, ["scripts/typed-enum.ts"]);
    assert.deepEqual(
      violations.map((entry) => `${entry.file} ${entry.specifier}`).sort(),
      ["scripts/typed-enum.ts createRequire"],
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a relative JSON import is a closure file and is not parsed", () => {
  const scratch = mkdtempSync(join(tmpdir(), "measurer-json-"));
  try {
    mkdirSync(join(scratch, "scripts/lib"), { recursive: true });
    writeFileSync(
      join(scratch, "scripts/lib/seam-engine-gate.mjs"),
      'import zzData from "./zz-data.json" with { type: "json" };\nvoid zzData;\n',
    );
    writeFileSync(join(scratch, "scripts/lib/zz-data.json"), '{"note": "a data file the gate imports"}\n');
    const { files, violations } = measurerClosure(scratch, ["scripts/lib/seam-engine-gate.mjs"]);
    assert.deepEqual(violations, []);
    assert.deepEqual([...files].sort(), ["scripts/lib/seam-engine-gate.mjs", "scripts/lib/zz-data.json"]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

const createRequireHelper = [
  'import { createRequire } from "node:module";',
  'createRequire(import.meta.url)("acorn");',
  "export const helper = true;",
  "",
].join("\n");

test("a helper that calls createRequire is named with no extension, .jsx, or .MJS", () => {
  const scratch = mkdtempSync(join(tmpdir(), "measurer-ext-"));
  const files = ["scripts/zz-helper", "scripts/zz-helper.jsx", "scripts/zz-helper.MJS"];
  try {
    mkdirSync(join(scratch, "scripts"), { recursive: true });
    const actual = {};
    for (const file of files) {
      writeFileSync(join(scratch, file), createRequireHelper);
      const { violations } = measurerClosure(scratch, [file]);
      actual[file] = violations.map((entry) => `${entry.file} ${entry.specifier}`).sort();
    }
    assert.deepEqual(actual, {
      "scripts/zz-helper": ["scripts/zz-helper createRequire"],
      "scripts/zz-helper.jsx": ["scripts/zz-helper.jsx createRequire"],
      "scripts/zz-helper.MJS": ["scripts/zz-helper.MJS createRequire"],
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a .TS file with a type annotation that calls createRequire is named", () => {
  const scratch = mkdtempSync(join(tmpdir(), "measurer-ts-case-"));
  try {
    mkdirSync(join(scratch, "scripts"), { recursive: true });
    writeFileSync(
      join(scratch, "scripts/typed.TS"),
      [
        'import { createRequire } from "node:module";',
        'const label: string = "kept";',
        'createRequire(import.meta.url)("acorn");',
        "void label;",
        "",
      ].join("\n"),
    );
    const { violations } = measurerClosure(scratch, ["scripts/typed.TS"]);
    assert.deepEqual(
      violations.map((entry) => `${entry.file} ${entry.specifier}`).sort(),
      ["scripts/typed.TS createRequire"],
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("JavaScript text in a .json file imported as js is named", () => {
  const scratch = mkdtempSync(join(tmpdir(), "measurer-json-js-"));
  try {
    mkdirSync(join(scratch, "scripts"), { recursive: true });
    writeFileSync(
      join(scratch, "scripts/driver.mjs"),
      'import zzCode from "./zz-code.json" with { type: "js" };\nvoid zzCode;\n',
    );
    writeFileSync(join(scratch, "scripts/zz-code.json"), createRequireHelper);
    const { violations } = measurerClosure(scratch, ["scripts/driver.mjs"]);
    assert.deepEqual(
      violations.map((entry) => `${entry.file} ${entry.specifier}`).sort(),
      ["scripts/zz-code.json createRequire"],
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a walked file that is neither JSON nor JavaScript is named as not parsed", () => {
  const scratch = mkdtempSync(join(tmpdir(), "measurer-binary-"));
  try {
    mkdirSync(join(scratch, "scripts"), { recursive: true });
    writeFileSync(join(scratch, "scripts/driver.mjs"), 'import "./native.node";\n');
    writeFileSync(join(scratch, "scripts/native.node"), Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x7b]));
    const { violations } = measurerClosure(scratch, ["scripts/driver.mjs"]);
    assert.deepEqual(
      violations.map((entry) => `${entry.file} ${entry.specifier}`).sort(),
      ["scripts/native.node the file did not parse"],
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a path the walk cannot read is named as unreadable", () => {
  const scratch = mkdtempSync(join(tmpdir(), "measurer-unreadable-"));
  try {
    mkdirSync(join(scratch, "scripts/lib/zz-pkg"), { recursive: true });
    writeFileSync(join(scratch, "scripts/driver.mjs"), 'import "./lib/zz-sib.js";\nimport "./lib/zz-pkg";\n');
    writeFileSync(join(scratch, "scripts/lib/zz-sib.ts"), "export const sibling = true;\n");
    writeFileSync(join(scratch, "scripts/lib/zz-pkg/index.mjs"), "export const indexed = true;\n");
    const { violations } = measurerClosure(scratch, ["scripts/driver.mjs"]);
    assert.deepEqual(
      violations.map((entry) => `${entry.file} ${entry.specifier}`).sort(),
      ["scripts/lib/zz-pkg the file could not be read", "scripts/lib/zz-sib.js the file could not be read"],
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a child directory whose name starts with '..' is inside the repository", async () => {
  const gate = await import("../scripts/lib/seam-engine-gate.mjs");
  const repo = repoRoot;
  const physical = realpathSync(repo);
  const child = join(repo, "..zz-cache");
  assert.throws(
    () => gate.assertSeamTreesOutsideRepository(repo, physical, child, "/var/empty/seam-project"),
    (error) =>
      error instanceof Error &&
      error.message.includes(resolve(child)) &&
      error.message.includes("is inside the repository"),
  );
});

test("a repository module imported from the engine refuses by name", async () => {
  const gate = await import("../scripts/lib/seam-engine-gate.mjs");
  const repo = repoRoot;
  const physical = realpathSync(repo);
  const source = "/var/empty/autosk-measured-source";
  const engineFile = join(source, "daemon/core/src/store/store.ts");
  assert.throws(
    () =>
      gate.assertMeasurerLoads(
        [{ specifier: join(repo, "scripts/lib/measured-inputs.mjs"), importer: engineFile }],
        repo,
        physical,
        source,
        source,
      ),
    /scripts\/lib\/measured-inputs\.mjs/u,
  );
  assert.doesNotThrow(() =>
    gate.assertMeasurerLoads(
      [{ specifier: join(repo, "scripts/lib/seam-module-loads.mjs"), importer: engineFile }],
      repo,
      physical,
      source,
      source,
    ),
  );
});
