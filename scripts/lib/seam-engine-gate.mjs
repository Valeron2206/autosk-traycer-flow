/**
 * The engine-surface gate for the migration-seam driver — the only module in
 * the measurement that may `import` code under the measured source tree.
 *
 * Ordering is the property this module exists to hold: every check and the
 * byte binding run before the first engine import, inside one function, so
 * there is no order an edit can get wrong. A foreign `node_modules` member
 * that repaired the install links during its own top-level evaluation would
 * otherwise leave the guards inspecting a surface the run no longer
 * executes — identical `bound.executed` over different executed bytes. With
 * the gate, the run dies while the link is still foreign: by the time any
 * foreign module could restore anything, the guard has already read it.
 *
 * These refusals run before the engine imports. The measurer-load check is
 * the exception: the driver repeats it before the record is emitted, after
 * those imports have returned.
 *
 *  - the launch itself: a `bunfig.toml` in the caller's cwd, a second
 *    `--preload` in any alias spelling, or an env var like `BUN_OPTIONS` can
 *    all run code before the hook — so the wrapper spawns with a cwd it
 *    owns, a `--config` file it wrote (proven by a nonce it passed only
 *    through the environment), `--no-env-file`, and exactly one preload
 *    naming this hook. The gate re-reads that contract from the process's
 *    own argv — anything else, or anything extra, refuses;
 *  - the load log (`seam-module-loads.mjs`, armed by that preload) must show
 *    the entry's own `bun:main` resolution — the hook was armed before the
 *    entry, so no load escaped it — and no entry may name the measured
 *    source root or an `@autosk/*` package, since nothing but engine code
 *    resolves there;
 *  - the tracked tree: `git write-tree` names the index, `git diff --quiet`
 *    proves the working files are that index — a dirty tree names bytes the
 *    run did not execute;
 *  - the executed surface: every `node_modules` on the resolution chain of
 *    the imported roots plus the store-lock helper, hashed under logical
 *    names, with links escaping the source root and workspace packages that
 *    are not the `bun install` links refused by name. The module part has a
 *    floor of its own: every workspace package the imports resolve through
 *    must contribute bound bytes — a helper-only binding names nothing the
 *    run imported;
 *  - the measurer's own modules. Before the bind, and again in the driver
 *    before it emits the record, the load log must not name a repository
 *    file outside `MEASURER_FILES`, whoever imported it; a specifier that
 *    does not resolve to a path, unless its importer is under the measured
 *    source root; or the repository root itself.
 *
 * Three channels stay outside these refusals. The measurer's non-module reads
 * of repository files are not on the load log: today it reads only the
 * measured source root, the project directory, the run's bunfig and the
 * bound files themselves. `bindSource` hashes a module when the record is
 * sealed, not at the moment the module was loaded, so a byte that changes
 * in that window is not what the log checked. A loader reached through a
 * computed property or a built string, such as `globalThis["Wor" + "ker"]`,
 * and a module-loading API the rule does not name, such as `module._load`,
 * are not names the closure test can see. A non-literal specifier that bun
 * does not log is the same kind of gap.
 *
 * Only then are the engine modules imported and returned with the binding.
 *
 * What this is and is not: it is not a claim about defending a hostile CI —
 * a Bun this code did not choose and a filesystem it did not create are
 * outside its reach. It is that a measurement whose worth is "this is what
 * ran" cannot rest on a launch anyone can decorate; the gate proves the
 * launch it actually got was the undecorated one.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { bindSource, digestOf } from "./produced-source.mjs";
import { moduleLoads } from "./seam-module-loads.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// The measurer's own bytes — bound into every record so a record produced by
// other code is refused downstream by name. `classifySeam` requires this same
// set, and it is the relative-import closure of both entry points.
export const MEASURER_FILES = [
  "scripts/verify-autosk-migration-seam.mjs",
  "scripts/verify-autosk-migration-seam.driver.ts",
  "scripts/lib/seam-engine-gate.mjs",
  "scripts/lib/seam-module-loads.mjs",
  "scripts/lib/produced-source.mjs",
];

// The engine modules the driver exercises, as source-root-relative
// specifiers. This table is the whole importable seam surface.
const ENGINE_MODULES = {
  store: "daemon/core/src/store/store.ts",
  loader: "daemon/core/src/extensions/loader.ts",
  identity: "daemon/core/src/extensions/identity.ts",
  metadata: "daemon/core/src/store/metadata.ts",
  records: "daemon/core/src/store/records.ts",
  distributions: "daemon/core/src/store/distributions.ts",
  runtimeIdentity: "daemon/core/src/engine/runtimeIdentity.ts",
  migrationRunner: "daemon/core/src/engine/migration-runner.ts",
};

// Env vars Bun reads that can decorate the launch with module loads — the
// wrapper's whitelist already drops them; the gate asserts them absent so a
// future whitelist addition cannot smuggle one through.
const INJECTING_ENV = ["NODE_OPTIONS", "BUN_OPTIONS"];

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const note = (line) => process.stderr.write(`[seam] ${line}\n`);

const realpathOrNull = (file) => {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
};

/**
 * The launch contract, asserted from the runtime's own argv — not from the
 * log the hook wrote, because a preload ahead of the hook would already have
 * run before the log existed. The wrapper spawns the driver with exactly:
 * `--cwd=<owned launch dir> --config=<owned bunfig> --no-env-file
 * --preload=<this module's sibling hook> <driver>`; any other flag, a second
 * preload in any alias spelling (`-r`, `--require`, `--import` included), a
 * config file whose bytes are not the nonce-stamped ones the wrapper wrote,
 * or a cwd that is not the launch dir refuses before any surface is read.
 */
export function assertLaunchIntegrity({ execArgv, env, cwd, entry }) {
  const hookPath = join(dirname(fileURLToPath(import.meta.url)), "seam-module-loads.mjs");
  const driverPath = join(REPO, "scripts", "verify-autosk-migration-seam.driver.ts");

  for (const name of INJECTING_ENV) {
    if (env[name] !== undefined) {
      throw new Error(`${name} is set — env-borne flags can arm a preload the launch never named`);
    }
  }
  const launchDir = env.AUTOSK_SEAM_LAUNCH_DIR;
  const bunfig = env.AUTOSK_SEAM_BUNFIG;
  const nonce = env.AUTOSK_SEAM_NONCE;
  const projectDir = env.AUTOSK_PROJECT_DIR;
  if (!launchDir || !bunfig || !nonce || !projectDir) {
    throw new Error("the seam launch contract env is incomplete — the driver runs only under the wrapper's spawn");
  }

  const flags = { preloads: [], cwd: null, config: null, noEnvFile: false };
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i];
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const take = () => inline ?? execArgv[++i];
    if (["--preload", "--require", "--import"].includes(flag)) flags.preloads.push(take());
    else if (arg.startsWith("-r") && !arg.startsWith("--")) {
      flags.preloads.push(arg === "-r" ? execArgv[++i] : arg.slice(2).replace(/^=/u, ""));
    } else if (flag === "--cwd") flags.cwd = take();
    else if (flag === "--config" || flag === "-c") flags.config = take();
    else if (arg === "--no-env-file") flags.noEnvFile = true;
    else throw new Error(`the launch carries a flag the wrapper did not pass: ${arg}`);
  }

  if (realpathOrNull(entry) !== realpathOrNull(driverPath)) {
    throw new Error(`the entry module is ${entry ?? "none"}, not the seam driver — this gate binds only its own measurement`);
  }
  if (flags.preloads.length !== 1) {
    throw new Error(
      `the launch arms ${flags.preloads.length} preloads — exactly one, the seam load log, is the contract`,
    );
  }
  if (realpathOrNull(flags.preloads[0]) !== realpathOrNull(hookPath)) {
    throw new Error(`the armed preload is ${flags.preloads[0] ?? "nothing"}, not the seam load log at ${hookPath}`);
  }
  if (flags.cwd !== launchDir || realpathOrNull(cwd) !== realpathOrNull(launchDir)) {
    throw new Error(
      `the launch cwd is ${flags.cwd ?? "absent"} (process: ${cwd}) — a caller-owned cwd lets a bunfig.toml there preload code before the hook`,
    );
  }
  const runRoot = realpathOrNull(dirname(projectDir));
  const insideRunRoot = (name) => {
    const physical = realpathOrNull(name);
    return physical !== null && runRoot !== null && physical.startsWith(`${runRoot}/`);
  };
  if (!insideRunRoot(launchDir)) {
    throw new Error(`the launch dir ${launchDir} is not inside this run's throwaway root`);
  }
  if (flags.config !== bunfig || !insideRunRoot(bunfig)) {
    throw new Error(`--config is ${flags.config ?? "absent"}, not the bunfig the wrapper wrote at ${bunfig}`);
  }
  // Exact bytes, nonce included: the file Bun read is the one the wrapper
  // wrote this run — not a caller's bunfig and not one carrying a preload
  // of its own.
  const expected = `# autosk-seam launch config\n# nonce ${nonce}\n`;
  if (readFileSync(bunfig, "utf8") !== expected) {
    throw new Error(`the bunfig at ${bunfig} is not the file the wrapper wrote this run`);
  }
  if (!flags.noEnvFile) {
    throw new Error("the launch lacks --no-env-file — an .env beside the cwd could decorate the environment");
  }
}

const resolvedLoad = (name, importer) => {
  if (typeof name !== "string") return null;
  if (name.startsWith("/")) return name;
  if (name.startsWith(".") && typeof importer === "string" && importer.startsWith("/")) {
    return resolve(dirname(importer), name);
  }
  return null;
};

const resolvesUnder = (roots, name, importer) => {
  const candidate = resolvedLoad(name, importer);
  return candidate !== null && roots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
};

/**
 * The ordering property as a runtime assertion: the load log proves the hook
 * was armed before the entry resolved (its `bun:main` entry is present), and
 * nothing under the measured source root — or an `@autosk/*` workspace name,
 * which only engine code imports — resolved before the guard. Both roots are
 * checked because the driver spells the source path as passed while a log
 * entry may carry it realpathed.
 */
export function assertNoEngineLoad(loads, logicalRoot, physicalRoot) {
  if (!Array.isArray(loads) || !loads.some((entry) => entry?.importer === "bun:main")) {
    throw new Error(
      "the module-load log names no entry resolution — the driver was not spawned under --preload, " +
        "so nothing proves the engine surface was untouched when the guard ran",
    );
  }
  const roots = [logicalRoot, physicalRoot].filter((root) => typeof root === "string" && root !== "");
  const early = loads.filter(
    (entry) =>
      resolvesUnder(roots, entry?.specifier, entry?.importer) ||
      resolvesUnder(roots, entry?.importer) ||
      // bun 1.4.0 does not log a static bare import without a dot, so this
      // clause never sees one of those. It does log a dotted `@autosk/...`
      // subpath as written. The closure test reads one acorn parse. It
      // refuses any name `require`, `createRequire`, `Worker` or `dlopen`,
      // alias included, and every import, export-from, `import()` or
      // `require()` source that is a string and is not relative or `node:`.
      // It does not refuse every bare specifier.
      (typeof entry?.specifier === "string" && entry.specifier.startsWith("@autosk/")),
  );
  if (early.length > 0) {
    throw new Error(
      `engine code was resolved before the surface guard ran: ${JSON.stringify(early[0])} — ` +
        "a load that early could repair the surface before the binding reads it",
    );
  }
}

/**
 * The load log against the measurer's own binding.
 *
 * `assertNoEngineLoad` refuses engine code that resolved before the guard.
 * This refuses the other direction: a module under this repository, and
 * outside the measured source root, that the log shows resolved and
 * `MEASURER_FILES` does not name. Those bytes ran, and the record cannot
 * name them. `node:` and `bun:` built-ins are not files of this repository.
 * A load whose path is under the measured source root is engine code: by
 * the time the gate calls this, `git write-tree` has named the tracked tree
 * and the executed surface is already bound. Every other resolved path is
 * classified by that path, whoever imported it: inside this repository it
 * must be in `MEASURER_FILES`, and outside both trees it is skipped.
 *
 * Only an entry that does not resolve to a path is skipped because its
 * importer is under the source root. bun 1.4.0 logs a dotted bare specifier
 * (`dotted.pkg`) as written; one imported by the engine is not a measurer
 * file, and one imported by the measurer is refused by name. A load that
 * resolves to the repository root itself is refused too.
 *
 * Resolution is the same rule as `resolvesUnder`: an absolute specifier is
 * the path, a relative one is resolved against its importer. Both spellings
 * of the repository root count, because a log entry may carry either.
 */
export function assertMeasurerLoads(loads, logicalRepo, physicalRepo, logicalSource, physicalSource) {
  if (!Array.isArray(loads)) {
    throw new Error("the module-load log is missing — nothing proves which measurer modules ran");
  }
  const repoRoots = [logicalRepo, physicalRepo].filter((root) => typeof root === "string" && root !== "");
  const sourceRoots = [logicalSource, physicalSource].filter((root) => typeof root === "string" && root !== "");
  for (const entry of loads) {
    const specifier = entry?.specifier;
    if (typeof specifier !== "string") continue;
    if (specifier.startsWith("node:") || specifier.startsWith("bun:")) continue;
    const importer = typeof entry?.importer === "string" ? entry.importer : "";
    const from = importer === "" ? "no importer" : importer;
    const candidate = resolvedLoad(specifier, importer);
    if (candidate === null) {
      if (resolvesUnder(sourceRoots, importer)) continue;
      throw new Error(
        `${specifier} (imported from ${from}) is not in the measurer binding — the load log names a specifier that does not resolve to a path`,
      );
    }
    if (sourceRoots.some((root) => candidate === root || candidate.startsWith(`${root}/`))) continue;
    let relativePath = null;
    for (const root of repoRoots) {
      if (candidate === root) {
        relativePath = "";
        break;
      }
      const prefix = `${root}/`;
      if (candidate.startsWith(prefix)) {
        relativePath = candidate.slice(prefix.length);
        break;
      }
    }
    if (relativePath === "") {
      throw new Error(
        `${specifier} (imported from ${from}) resolves to the repository root — the load log names the repository itself`,
      );
    }
    if (relativePath === null) continue;
    if (!MEASURER_FILES.includes(relativePath)) {
      throw new Error(
        `${relativePath} is not in the measurer binding — the load log names a repository module the record does not bind`,
      );
    }
  }
}

// The driver's repeat of the check, on the gate's own repository and on the
// log the preload recorded. `sourceDir` is the measured source root.
export function assertMeasurerLoadsBeforeEmit(sourceDir) {
  assertMeasurerLoads(moduleLoads, REPO, realpathSync(REPO), resolve(sourceDir), realpathSync(sourceDir));
}

/**
 * The floor the executed binding must meet in its own right, separately from
 * the helper's presence: every workspace package the engine imports resolve
 * through must contribute bound bytes under `daemon/node_modules/<name>/` —
 * a verified link that yields no member means the package the run imported
 * was walked but never bound — and the module part cannot be empty. A
 * helper-only member list still recomputes and still carries the helper, so
 * an empty module part is a check, not a consequence of the other checks.
 */
export function assertExecutedSurface(executedFiles, workspacePackages) {
  for (const name of workspacePackages) {
    if (!executedFiles.some((file) => file.path.startsWith(`daemon/node_modules/${name}/`))) {
      throw new Error(
        `the executed surface binds nothing under daemon/node_modules/${name} — ` +
          "the workspace package the engine imports through that link was not bound",
      );
    }
  }
  if (!executedFiles.some((file) => file.path.includes("node_modules/"))) {
    throw new Error(
      "the executed surface bound no installed module — a binding of the helper alone names nothing the run imported",
    );
  }
}

const contains = (parent, child) => {
  const rel = relative(parent, child);
  const escapes = rel === ".." || rel.startsWith(`..${sep}`);
  return rel === "" || (!escapes && !isAbsolute(rel));
};

/**
 * The measured source and the run's project directory must sit beside the
 * repository, not inside it and not around it. An engine import can then
 * resolve into this repository's `node_modules`, and the run's own scratch
 * files can be mistaken for measurer modules. Both the path as given and
 * its native realpath are compared with both spellings of the repository root.
 */
export function assertSeamTreesOutsideRepository(logicalRepo, physicalRepo, sourceDir, projectDir) {
  const repos = [logicalRepo, physicalRepo].filter((root) => typeof root === "string" && root !== "");
  for (const candidate of [sourceDir, projectDir]) {
    if (typeof candidate !== "string" || candidate === "") continue;
    const forms = [resolve(candidate)];
    try {
      forms.push(realpathSync.native(candidate));
    } catch {
      // a path that is not on disk yet is compared as given
    }
    for (const form of forms) {
      for (const repo of repos) {
        if (contains(repo, form)) {
          throw new Error(`${form} is inside the repository; the measured source and the run's scratch must lie outside it`);
        }
        if (contains(form, repo)) {
          throw new Error(`${form} contains the repository; the measured source and the run's scratch must lie outside it`);
        }
      }
    }
  }
}

/**
 * Verify the executed surface, bind it, and only then import the engine
 * modules. Returns `{ modules, bound }` — `modules` keyed by the
 * ENGINE_MODULES table, `bound` the record's provenance block.
 */
export async function loadVerifiedEngine(SRC, { storeLockBin }) {
  assertSeamTreesOutsideRepository(REPO, realpathSync.native(REPO), resolve(SRC), process.env.AUTOSK_PROJECT_DIR ?? "");
  const realSRC = realpathSync(SRC);
  assertLaunchIntegrity({
    execArgv: process.execArgv,
    env: process.env,
    cwd: process.cwd(),
    entry: process.argv[1],
  });
  assertNoEngineLoad(moduleLoads, resolve(SRC), realSRC);

  // `write-tree` names the index — the patched tree `prepare-autosk` built —
  // and `diff --quiet` proves the working files are that index.
  const sourceTree = execFileSync("git", ["-C", SRC, "write-tree"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", SRC, "diff", "--quiet"], { encoding: "utf8" });

  const assertInsideSource = (logical) => {
    const parts = logical.split("/");
    for (let depth = 1; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth).join("/");
      let resolved = null;
      try {
        resolved = realpathSync(join(SRC, prefix));
      } catch {
        resolved = null;
      }
      if (resolved === null) continue; // a missing name is reported by the byte binding
      if (resolved !== realSRC && !resolved.startsWith(`${realSRC}/`)) {
        throw new Error(
          `cannot bind ${logical}: ${prefix === logical ? "it" : prefix} resolves to ${resolved}, ` +
            `outside the measured source root — the run would execute bytes the record cannot name`,
        );
      }
    }
  };

  // `bun install` links each workspace into daemon/node_modules; the
  // workspace set is declared in the tracked daemon/package.json. A package
  // that is not that link — a directory copy keeps every name inside the
  // root — is the importable surface modified after install.
  const workspacePatterns = JSON.parse(readFileSync(join(SRC, "daemon/package.json"), "utf8")).workspaces ?? [];
  const workspacePackages = [];
  for (const pattern of workspacePatterns) {
    const star = pattern.indexOf("*");
    const dirs =
      star === -1
        ? [pattern]
        : readdirSync(join(SRC, "daemon", pattern.slice(0, star)), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => `${pattern.slice(0, star)}${entry.name}`);
    for (const dir of dirs) {
      const name = JSON.parse(readFileSync(join(SRC, "daemon", dir, "package.json"), "utf8")).name;
      workspacePackages.push(name);
      const link = join(SRC, "daemon/node_modules", name);
      const status = lstatSync(link, { throwIfNoEntry: false });
      let resolved = null;
      if (status?.isSymbolicLink()) {
        try {
          resolved = realpathSync(link);
        } catch {
          resolved = null;
        }
      }
      if (resolved !== realpathSync(join(SRC, "daemon", dir))) {
        const detail =
          status == null
            ? "it is missing"
            : !status.isSymbolicLink()
              ? "it is a directory of its own"
              : resolved === null
                ? "the link resolves to nothing"
                : `it resolves to ${resolved}`;
        throw new Error(
          `daemon/node_modules/${name} is not the workspace link \`bun install\` made — ` +
            `${detail}; the importable surface was modified after install`,
        );
      }
    }
  }

  // Every node_modules on the resolution chain of the imported roots:
  // daemon/core/src directly and daemon/sdk/src through the @autosk/sdk link.
  const executedFiles = [];
  const moduleRoots = new Set();
  for (const imported of ["daemon/core/src", "daemon/sdk/src"]) {
    for (let dir = imported; ; dir = dirname(dir)) {
      moduleRoots.add(dir === "." ? "node_modules" : `${dir}/node_modules`);
      if (dir === ".") break;
    }
  }
  const walkExecuted = (logical, ancestors) => {
    const physical = realpathSync(join(SRC, logical));
    if (ancestors.has(physical)) {
      throw new Error(`cannot bind ${logical}: the directory links back into itself — a cyclic install cannot be named`);
    }
    const deeper = new Set(ancestors).add(physical);
    for (const entry of readdirSync(join(SRC, logical), { withFileTypes: true })) {
      const next = `${logical}/${entry.name}`;
      assertInsideSource(next);
      if (entry.isSymbolicLink()) {
        try {
          statSync(join(SRC, next));
        } catch {
          throw new Error(`cannot bind ${next}: the link resolves to nothing — the importable surface is broken`);
        }
      }
      if (statSync(join(SRC, next)).isDirectory()) walkExecuted(next, deeper);
      else executedFiles.push({ path: next, sha256: sha256(join(SRC, next)) });
    }
  };
  for (const root of [...moduleRoots].sort()) {
    if (!existsSync(join(SRC, root))) continue;
    assertInsideSource(root);
    walkExecuted(root, new Set());
  }
  assertExecutedSurface(executedFiles, workspacePackages);

  // The store-lock helper is a built binary in the ignored bin/ tree and runs
  // under the same rule: bound as bytes, and a helper outside the measured
  // source root refuses.
  if (typeof storeLockBin !== "string" || storeLockBin === "") {
    throw new Error("AUTOSK_STORE_LOCK_BIN is not set — the helper this run executes cannot be bound");
  }
  const storeLockResolved = realpathSync(storeLockBin);
  if (storeLockResolved !== realSRC && !storeLockResolved.startsWith(`${realSRC}/`)) {
    throw new Error(`the store-lock helper resolves to ${storeLockResolved}, outside the measured source root`);
  }
  executedFiles.push({ path: relative(realSRC, storeLockResolved), sha256: sha256(storeLockResolved) });
  executedFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const executed = { files: executedFiles, listings: [], digest: digestOf(executedFiles, []) };
  note(`bound ${executedFiles.length} executed files outside the tracked tree (digest ${executed.digest})`);

  // What this call sees: loads resolved before it. That is the driver's
  // entry, the static imports that evaluated to reach this function, and any
  // dynamic import that already ran. It does not see a dynamic import after
  // this line, a bare specifier bun 1.4.0 does not log (no dot, or a
  // require of one), or a module only the wrapper loads. The driver repeats
  // the check on the whole log before it emits the record.
  assertMeasurerLoads(moduleLoads, REPO, realpathSync(REPO), resolve(SRC), realSRC);

  const bound = {
    source_tree: sourceTree,
    source: bindSource(REPO, MEASURER_FILES),
    executed,
  };

  // The surface is bound; only now may engine bytes load.
  const modules = {};
  for (const [key, specifier] of Object.entries(ENGINE_MODULES)) {
    modules[key] = await import(join(SRC, specifier));
  }
  return { modules, bound };
}
