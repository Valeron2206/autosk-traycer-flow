#!/usr/bin/env node

/**
 * The clean-room run for issue #36.
 *
 * One command that prepares the pinned upstream source, builds the three
 * binaries, and exercises the daemon in an isolated HOME with no Traycer
 * anywhere in the environment — then reports how each fault-matrix group was
 * covered: by the designed fault on the product path, without a control, by a
 * substitute for the designed fault, by a host function, by a written
 * observation, with a control that failed, or not at all
 * (`scripts/lib/clean-room-coverage.mjs`).
 *
 * Three daemon harnesses run: creation (F002's restart), crash (F001, F003)
 * and identity (F004); the fault harness covers the rest.
 *
 * The report distinguishes those on purpose. A run that listed sixteen
 * groups and exercised four would be the artefact this whole program keeps
 * finding: a confident sentence nobody can check.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { runFaults } from './clean-room-faults.mjs';
import { coverageReport, faultCoverage, harnessCoverage } from './lib/clean-room-coverage.mjs';

/**
 * The coverage rule and the report built on it live in the shared lib, so the
 * panel package recomputes a run's coverage with the run's own functions
 * (review of 11f, M1); they are re-exported here for the run's callers.
 */
export { COVERAGE, coverageReport, faultCoverage, harnessCoverage } from './lib/clean-room-coverage.mjs';

const execFileAsync = promisify(execFile);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MATRIX_PATH = 'resources/clean-room-e2e/fault-matrix.v1.json';

/**
 * The per-case records the report carries: the result, its control, and the
 * ref-writing git commands the case ran itself, fixture setup apart from the
 * fault step (debt 10h). The package reads which groups touch Git directly
 * from here rather than from a sentence.
 */
export function faultRecords(report) {
  return Object.freeze(report.results.map((entry) => Object.freeze({
    id: entry.id,
    detected: entry.detected,
    control: entry.control,
    detail: entry.detail,
    git_ref_writes: entry.git_ref_writes,
  })));
}

/** Environment variables that would make the run not a clean room. */
export const FORBIDDEN_ENV = Object.freeze(['TRAYCER_HOME', 'TRAYCER_CONFIG', 'TRAYCER_TOKEN']);

/** The build tools the run needs, resolved from the operator's PATH by name. */
export const TOOLCHAIN = Object.freeze(['bun', 'go', 'make', 'git', 'node']);

/**
 * The environment a clean-room child runs in.
 *
 * A fresh HOME, no Traycer variables, and a PATH built from the pinned
 * binaries, the system directories and the declared toolchain — nothing else.
 *
 * The toolchain is admitted by name rather than by inheriting the operator's
 * PATH, because inheriting it would let anything on that path answer for one of
 * these tools. The admitted directories are reported, so the run says what it
 * let in rather than implying it let in nothing.
 */
export function cleanRoomEnv({
  home,
  sourceDir,
  toolchainDirs = [],
  moduleCache,
  systemPath = '/usr/bin:/bin:/usr/sbin:/sbin',
}) {
  const parts = [path.join(sourceDir, 'bin'), ...toolchainDirs, ...systemPath.split(':')];
  const env = {
    HOME: home,
    PATH: [...new Set(parts.filter(Boolean))].join(':'),
    AUTOSK_NO_AUTO_INSTALL: '1',
    AUTOSK_SKIP_SHELL_PATH: '1',
    // Declared, and deliberately outside the ephemeral HOME. The clean room
    // isolates autosk state, not Go's package cache, and burying the cache in a
    // directory that is deleted after every run would make each run re-download
    // its dependencies while proving nothing extra.
    ...(moduleCache ? { GOMODCACHE: moduleCache } : {}),
  };
  for (const name of FORBIDDEN_ENV) delete env[name];
  return env;
}

/** Where each declared tool actually is, walking the operator's PATH by hand. */
export async function resolveToolchain(searchPath = process.env.PATH ?? '') {
  const dirs = searchPath.split(path.delimiter).filter(Boolean);
  const found = {};
  for (const tool of TOOLCHAIN) {
    for (const dir of dirs) {
      const candidate = path.join(dir, tool);
      try {
        await stat(candidate);
        found[tool] = dir;
        break;
      } catch {
        continue;
      }
    }
  }
  return found;
}

/** What the environment must not carry for the run to mean anything. */
export function environmentErrors(env) {
  const errors = [];
  for (const name of FORBIDDEN_ENV) {
    if (env[name] !== undefined) errors.push({ reason: 'clean_room_traycer_present', detail: name });
  }
  for (const [name, value] of Object.entries(env)) {
    if (/traycer/iu.test(name) || (typeof value === 'string' && /\.traycer/iu.test(value))) {
      errors.push({ reason: 'clean_room_traycer_present', detail: name });
    }
  }
  return errors;
}

async function run(command, args, options) {
  const started = Date.now();
  try {
    const { stdout } = await execFileAsync(command, args, { maxBuffer: 64 * 1024 * 1024, ...options });
    return { ok: true, stdout, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error), ms: Date.now() - started };
  }
}

/**
 * The steps the run takes: the commands it spawns, the extension identity it
 * reads, the toolchain it resolves, the binaries it checks and the fault
 * harness. `cleanRoomRun` takes them from its caller, these by default, so a
 * test can drive each of its returns without preparing or building anything
 * (review of 11g, C1: the first start-and-end identity read broke every
 * return, and no test drove one).
 */
export const CLEAN_ROOM_IO = Object.freeze({
  run,
  identity: extensionIdentity,
  resolveToolchain,
  stat,
  runFaults,
});

/**
 * Runs the whole thing and returns the report.
 *
 * The extension's identity is read before the first step and again at the
 * end (CodeRabbit on #271): the steps read the extension's bytes over
 * minutes, and the report may claim only an identity that held throughout.
 * Every return, early or not, goes through `close`, so each carries the
 * identity the run started on.
 */
export async function cleanRoomRun({
  keep = false,
  moduleCache = path.join(tmpdir(), 'autosk-clean-room-modcache'),
  io = CLEAN_ROOM_IO,
} = {}) {
  const identityAtStart = await io.identity();
  const workspace = await mkdtemp(path.join(tmpdir(), 'autosk-clean-room-'));
  const sourceDir = path.join(workspace, 'source');
  const home = path.join(workspace, 'home');
  const steps = [];
  let receipt;
  const close = (outcome) => finish({ workspace, steps, receipt, keep, identityAtStart, io, ...outcome });

  try {
    const prepare = await io.run('node', [path.join(ROOT, 'scripts/prepare-autosk.mjs'), sourceDir], { cwd: ROOT });
    steps.push({ step: 'prepare', ok: prepare.ok, ms: prepare.ms });
    if (!prepare.ok) return close({ error: prepare.stderr });
    receipt = JSON.parse(prepare.stdout);

    const toolchain = await io.resolveToolchain();
    const missing = TOOLCHAIN.filter((tool) => !toolchain[tool]);
    const env = {
      ...cleanRoomEnv({
        home,
        sourceDir,
        toolchainDirs: [...new Set(Object.values(toolchain))],
        moduleCache,
      }),
      GOTOOLCHAIN: 'local',
    };
    const envErrors = [
      ...environmentErrors(env),
      ...missing.map((tool) => ({ reason: 'clean_room_toolchain_missing', detail: tool })),
    ];
    steps.push({
      step: 'environment',
      ok: envErrors.length === 0,
      errors: envErrors,
      // Reported, not implied: these are the directories the run admitted.
      toolchain,
      module_cache: moduleCache,
    });
    if (envErrors.length > 0) return close({ error: 'environment' });

    for (const [name, args, cwd] of [
      ['deps:daemon', ['install', '--frozen-lockfile'], path.join(sourceDir, 'daemon')],
      ['deps:pi-tools', ['install', '--frozen-lockfile'], path.join(sourceDir, 'pi-tools')],
    ]) {
      const result = await io.run('bun', args, { cwd, env });
      steps.push({ step: name, ok: result.ok, ms: result.ms });
      if (!result.ok) return close({ error: result.stderr });
    }

    const make = await io.run('make', ['-C', sourceDir, 'build', 'build-store-lock'], { env });
    steps.push({ step: 'build:go', ok: make.ok, ms: make.ms });
    if (!make.ok) return close({ error: make.stderr });

    const compile = await io.run(
      'bun',
      ['build', '--compile', 'core/src/index.ts', '--outfile', '../bin/autoskd'],
      { cwd: path.join(sourceDir, 'daemon'), env },
    );
    steps.push({ step: 'build:daemon', ok: compile.ok, ms: compile.ms });
    if (!compile.ok) return close({ error: compile.stderr });

    for (const binary of ['autosk', 'autosk-store-lock', 'autoskd']) {
      await io.stat(path.join(sourceDir, 'bin', binary));
    }

    for (const [name, script] of [
      ['creation', 'scripts/verify-autosk-creation.mjs'],
      ['crash', 'scripts/verify-autosk-crash.mjs'],
      ['identity', 'scripts/verify-autosk-identity.mjs'],
    ]) {
      const result = await io.run('node', [path.join(ROOT, script), sourceDir], { cwd: ROOT, env });
      const summary = lastJsonLine(result.stdout);
      steps.push({ step: `harness:${name}`, ok: result.ok, ms: result.ms, summary });
    }

    // The fault harness runs in its own temporary repositories, so it needs
    // neither the built binaries nor the pinned source — but it belongs to this
    // run, because its results are what the coverage table is derived from.
    const faultsStarted = Date.now();
    const faults = await io.runFaults();
    steps.push({
      step: 'harness:faults',
      ok: faults.ok,
      ms: Date.now() - faultsStarted,
      summary: { detected: faults.detected, controlled: faults.controlled, total: faults.total },
    });

    return close({ faults });
  } catch (error) {
    return close({ error: String(error) });
  }
}

function lastJsonLine(text) {
  const lines = text.split('\n').filter((line) => line.trim().startsWith('{'));
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

/**
 * The identity of the extension the run actually exercised.
 *
 * The report already pins the daemon source. Without this it does not pin the
 * other half: a green run says nothing about which extension bytes produced it,
 * and a reviewer holding a frozen tree cannot tell whether the run was about
 * that tree. `dirty` is part of the answer — a run from a modified worktree is
 * about bytes that are in no commit. Every identity carries `error`: `null`
 * when it was read, and why not when it could not be.
 */
export async function extensionIdentity(git = (args) => execFileAsync('git', args, { cwd: ROOT })) {
  try {
    const tree = (await git(['rev-parse', 'HEAD^{tree}'])).stdout.trim();
    const commit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const status = (await git(['status', '--porcelain'])).stdout.trim();
    return Object.freeze({ commit, tree, dirty: status.length > 0, error: null });
  } catch (error) {
    return Object.freeze({ commit: null, tree: null, dirty: null, error: String(error) });
  }
}

/** One identity as a report line names it: commit, tree, and whether the worktree was clean. */
function describeIdentity(identity) {
  return `${identity.commit} (tree ${identity.tree}, ${identity.dirty ? 'dirty' : 'clean'})`;
}

/**
 * The extension identity a whole run may claim (CodeRabbit on #271).
 *
 * The harness steps read the extension's bytes over minutes, so the identity
 * read at the end says what they read only if nothing moved in between. A
 * commit, a branch switch, a revert or an edit during the run — tree, commit
 * or `dirty` differing — means the steps may have read bytes of two trees: the
 * run claims neither clean (`dirty: null`) and names both. An identity that
 * could not be read at either end is returned as read, with `dirty: null`.
 * The identity is sampled twice, not watched: an edit made and reverted
 * between the two reads is not seen.
 */
export function identityAcrossRun(start, end) {
  if (start.error) return start;
  if (end.error) return end;
  if (start.commit === end.commit && start.tree === end.tree && start.dirty === end.dirty) return end;
  return Object.freeze({
    commit: start.commit,
    tree: start.tree,
    dirty: null,
    error: `extension moved during the run: ${describeIdentity(start)} -> ${describeIdentity(end)}`,
  });
}

/**
 * The line the command prints for the extension: its tree, marked when the
 * worktree was dirty, and — when the run cannot call it clean or dirty — the
 * reason `identityAcrossRun` recorded.
 */
export function extensionSummary(extension) {
  if (extension.dirty === false) return `extension_tree=${extension.tree}`;
  return `extension_tree=${extension.tree} (${extension.dirty === true ? 'dirty' : extension.error})`;
}

/**
 * Closes the run and builds its report.
 *
 * Removes the workspace unless it is kept, derives the coverage from the
 * run's own steps and fault cases, and records the extension identity that
 * held from `identityAtStart` to now (`identityAcrossRun`, read again through
 * `io`). `ok` says only whether every step ran; whether the coverage is
 * complete is the report's own field.
 */
async function finish({ workspace, steps, receipt, keep, identityAtStart, io, error, faults }) {
  // Go leaves its module cache read-only, so an ordinary recursive remove
  // fails on a tree it wrote. Making it writable first is the difference
  // between a workspace that is cleaned up and one that accumulates.
  if (!keep) {
    await execFileAsync('chmod', ['-R', 'u+w', workspace]).catch(() => {});
    await rm(workspace, { recursive: true, force: true });
  }
  const matrix = JSON.parse(await readFile(path.join(ROOT, MATRIX_PATH), 'utf8'));
  // Every entry is the run's: the daemon harnesses' steps and the fault
  // harness's cases. A group neither reported is not covered.
  const coverage = coverageReport(matrix, { ...harnessCoverage(steps), ...(faults ? faultCoverage(faults) : {}) });
  return Object.freeze({
    schema_version: 1,
    workspace: keep ? workspace : null,
    source_tree: receipt?.source_tree ?? null,
    upstream_commit: receipt?.upstream_commit ?? null,
    extension: identityAcrossRun(identityAtStart, await io.identity()),
    // The per-case results, not only the counts they roll up into. A reviewer
    // holding counts cannot tell a discriminating guard from one that refuses
    // everything, and that distinction is the whole reason each case runs a
    // control.
    faults: faults ? faultRecords(faults) : null,
    steps: Object.freeze(steps),
    coverage,
    ok: !error && steps.every((step) => step.ok !== false),
    error: error ?? null,
    report_digest: createHash('sha256').update(JSON.stringify({ steps, coverage }), 'utf8').digest('hex'),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const keep = process.argv.includes('--keep');
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
  const report = await cleanRoomRun({ keep });
  if (out) await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  for (const step of report.steps) {
    console.log(`${step.ok === false ? 'FAIL' : 'ok  '} ${step.step}${step.ms ? ` (${step.ms}ms)` : ''}`);
  }
  console.log(`source_tree=${report.source_tree}`);
  console.log(extensionSummary(report.extension));
  for (const [state, count] of Object.entries(report.coverage.counts)) console.log(`${state}: ${count}`);
  // The exit status says whether every step ran; completeness is its own line.
  console.log(`complete=${report.coverage.complete}`);
  if (report.error) console.error(report.error);
  process.exitCode = report.ok ? 0 : 1;
}
