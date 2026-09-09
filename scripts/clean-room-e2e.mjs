#!/usr/bin/env node

/**
 * The clean-room run for issue #36.
 *
 * One command that prepares the pinned upstream source, builds the three
 * binaries, and exercises the daemon in an isolated HOME with no Traycer
 * anywhere in the environment — then reports which fault-matrix groups were
 * covered by a real fault and which were not.
 *
 * The report distinguishes those two on purpose. A run that listed sixteen
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

const execFileAsync = promisify(execFile);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MATRIX_PATH = 'resources/clean-room-e2e/fault-matrix.v1.json';

/**
 * Which harness covers which fault-matrix group, and with what.
 *
 * `real_fault` means a process was actually killed or a state actually
 * corrupted during the run; anything else is named as what it is.
 *
 * F005-F016 are absent here on purpose: they are covered by the fault harness,
 * and their entries are derived from what that run actually detected rather
 * than declared in advance. A table is a claim; a run is evidence.
 */
export const COVERAGE = Object.freeze({
  F001: { harness: 'crash', evidence: 'reservation.before / reservation.after', real_fault: true },
  F002: { harness: 'crash', evidence: 'task.before / task.after', real_fault: true },
  F003: { harness: 'crash', evidence: 'activation.before / activation.after', real_fault: true },
  F004: {
    harness: 'identity',
    evidence: 'the admitted task keeps its pin across a real swap; a later admission gets the new one',
    real_fault: true,
  },
  F005: { harness: null, evidence: null, real_fault: false },
  F006: { harness: null, evidence: null, real_fault: false },
  F007: { harness: null, evidence: null, real_fault: false },
  F008: { harness: null, evidence: null, real_fault: false },
  F009: { harness: null, evidence: null, real_fault: false },
  F010: { harness: null, evidence: null, real_fault: false },
  F011: { harness: null, evidence: null, real_fault: false },
  F012: { harness: null, evidence: null, real_fault: false },
  F013: { harness: null, evidence: null, real_fault: false },
  F014: { harness: null, evidence: null, real_fault: false },
  F015: { harness: null, evidence: null, real_fault: false },
  F016: { harness: null, evidence: null, real_fault: false },
  F017: { harness: null, evidence: null, real_fault: false },
  F018: { harness: null, evidence: null, real_fault: false },
  F019: { harness: null, evidence: null, real_fault: false },
  F020: { harness: null, evidence: null, real_fault: false },
});

/**
 * Coverage entries derived from a fault-harness run.
 *
 * A group counts as covered by a real fault only when the fault was detected
 * *and* the case's control stayed silent. A guard that refuses everything
 * detects every fault and means nothing by it, so a failed control demotes the
 * row rather than being reported alongside it.
 */
export function faultCoverage(report) {
  const entries = report.results.map((entry) => [
    entry.id,
    {
      harness: 'faults',
      evidence: entry.detail,
      real_fault: entry.detected === true && entry.control === true,
    },
  ]);
  return Object.freeze(Object.fromEntries(entries));
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

/** The coverage report: covered by a real fault, covered otherwise, or not covered. */
export function coverageReport(matrix, coverage = COVERAGE) {
  const rows = matrix.groups.map((group) => {
    const entry = coverage[group.id] ?? { harness: null, evidence: null, real_fault: false };
    return Object.freeze({
      id: group.id,
      boundary: group.boundary,
      state: entry.harness ? (entry.real_fault ? 'covered_by_real_fault' : 'covered_indirectly') : 'not_covered',
      harness: entry.harness,
      evidence: entry.evidence,
    });
  });
  const counts = rows.reduce((totals, row) => ({ ...totals, [row.state]: (totals[row.state] ?? 0) + 1 }), {});
  return Object.freeze({
    rows: Object.freeze(rows),
    counts: Object.freeze(counts),
    // Stated rather than rounded up: a run that claimed the whole matrix while
    // exercising part of it would be the artefact this program keeps finding.
    complete: rows.every((row) => row.state === 'covered_by_real_fault'),
  });
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

/** Runs the whole thing and returns the report. */
export async function cleanRoomRun({ keep = false, moduleCache = path.join(tmpdir(), 'autosk-clean-room-modcache') } = {}) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'autosk-clean-room-'));
  const sourceDir = path.join(workspace, 'source');
  const home = path.join(workspace, 'home');
  const steps = [];
  let receipt;

  try {
    const prepare = await run('node', [path.join(ROOT, 'scripts/prepare-autosk.mjs'), sourceDir], { cwd: ROOT });
    steps.push({ step: 'prepare', ok: prepare.ok, ms: prepare.ms });
    if (!prepare.ok) return finish({ workspace, steps, receipt, keep, error: prepare.stderr });
    receipt = JSON.parse(prepare.stdout);

    const toolchain = await resolveToolchain();
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
    if (envErrors.length > 0) return finish({ workspace, steps, receipt, keep, error: 'environment' });

    for (const [name, args, cwd] of [
      ['deps:daemon', ['install', '--frozen-lockfile'], path.join(sourceDir, 'daemon')],
      ['deps:pi-tools', ['install', '--frozen-lockfile'], path.join(sourceDir, 'pi-tools')],
    ]) {
      const result = await run('bun', args, { cwd, env });
      steps.push({ step: name, ok: result.ok, ms: result.ms });
      if (!result.ok) return finish({ workspace, steps, receipt, keep, error: result.stderr });
    }

    const make = await run('make', ['-C', sourceDir, 'build', 'build-store-lock'], { env });
    steps.push({ step: 'build:go', ok: make.ok, ms: make.ms });
    if (!make.ok) return finish({ workspace, steps, receipt, keep, error: make.stderr });

    const compile = await run(
      'bun',
      ['build', '--compile', 'core/src/index.ts', '--outfile', '../bin/autoskd'],
      { cwd: path.join(sourceDir, 'daemon'), env },
    );
    steps.push({ step: 'build:daemon', ok: compile.ok, ms: compile.ms });
    if (!compile.ok) return finish({ workspace, steps, receipt, keep, error: compile.stderr });

    for (const binary of ['autosk', 'autosk-store-lock', 'autoskd']) {
      await stat(path.join(sourceDir, 'bin', binary));
    }

    for (const [name, script] of [
      ['creation', 'scripts/verify-autosk-creation.mjs'],
      ['crash', 'scripts/verify-autosk-crash.mjs'],
      ['identity', 'scripts/verify-autosk-identity.mjs'],
    ]) {
      const result = await run('node', [path.join(ROOT, script), sourceDir], { cwd: ROOT, env });
      const summary = lastJsonLine(result.stdout);
      steps.push({ step: `harness:${name}`, ok: result.ok, ms: result.ms, summary });
    }

    // The fault harness runs in its own temporary repositories, so it needs
    // neither the built binaries nor the pinned source — but it belongs to this
    // run, because its results are what the coverage table is derived from.
    const started = Date.now();
    const faults = await runFaults();
    steps.push({
      step: 'harness:faults',
      ok: faults.ok,
      ms: Date.now() - started,
      summary: { detected: faults.detected, controlled: faults.controlled, total: faults.total },
    });

    return finish({ workspace, steps, receipt, keep, faults });
  } catch (error) {
    return finish({ workspace, steps, receipt, keep, error: String(error) });
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
 * about bytes that are in no commit.
 */
export async function extensionIdentity(git = (args) => execFileAsync('git', args, { cwd: ROOT })) {
  try {
    const tree = (await git(['rev-parse', 'HEAD^{tree}'])).stdout.trim();
    const commit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const status = (await git(['status', '--porcelain'])).stdout.trim();
    return Object.freeze({ commit, tree, dirty: status.length > 0 });
  } catch (error) {
    return Object.freeze({ commit: null, tree: null, dirty: null, error: String(error) });
  }
}

async function finish({ workspace, steps, receipt, keep, error, faults }) {
  // Go leaves its module cache read-only, so an ordinary recursive remove
  // fails on a tree it wrote. Making it writable first is the difference
  // between a workspace that is cleaned up and one that accumulates.
  if (!keep) {
    await execFileAsync('chmod', ['-R', 'u+w', workspace]).catch(() => {});
    await rm(workspace, { recursive: true, force: true });
  }
  const matrix = JSON.parse(await readFile(path.join(ROOT, MATRIX_PATH), 'utf8'));
  const coverage = coverageReport(matrix, faults ? { ...COVERAGE, ...faultCoverage(faults) } : COVERAGE);
  return Object.freeze({
    schema_version: 1,
    workspace: keep ? workspace : null,
    source_tree: receipt?.source_tree ?? null,
    upstream_commit: receipt?.upstream_commit ?? null,
    extension: await extensionIdentity(),
    // The per-case results, not only the counts they roll up into. A reviewer
    // holding counts cannot tell a discriminating guard from one that refuses
    // everything, and that distinction is the whole reason each case runs a
    // control.
    faults: faults ? Object.freeze(faults.results.map((entry) => Object.freeze({
      id: entry.id, detected: entry.detected, control: entry.control, detail: entry.detail,
    }))) : null,
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
  console.log(`extension_tree=${report.extension.tree}${report.extension.dirty ? ' (dirty)' : ''}`);
  for (const [state, count] of Object.entries(report.coverage.counts)) console.log(`${state}: ${count}`);
  if (report.error) console.error(report.error);
  process.exitCode = report.ok ? 0 : 1;
}
