#!/usr/bin/env node

/**
 * `autosk-flow doctor` — one read-only command that checks everything the flow
 * depends on and answers in a machine-readable form.
 *
 * It writes nothing into the project. `--out` is accepted, and refused when the
 * path is inside the project tree: a diagnosis that modifies what it diagnoses
 * is the one thing this command must not do.
 *
 * `--workflow <name>` holds the report to the set the workflow preflight
 * requires of that registered workflow, by its name in the graph.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { buildReport, readiness, unverifiableCount } from '../src/host/doctor.mjs';
import { runChecks } from '../src/host/doctor-checks.mjs';
import { requiredFor } from '../src/host/workflow-preflight.mjs';
import { demand } from '../src/runtime/contracts.mjs';

const execFileAsync = promisify(execFile);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The real host, as the check registry expects to see it. */
export function hostEnv({ root = ROOT, nowMs = () => Date.now() } = {}) {
  const resolve = (relative) => path.resolve(root, relative);
  return {
    root,
    home: os.homedir(),
    processEnv: process.env,
    nowMs,
    toolVersion: process.env.npm_package_version ?? '0.0.0',
    nodeVersion: process.version,
    requiredNodeMajor: 24,
    daemonBinary: process.env.AUTOSKD_BIN ?? '',
    helperBinary: process.env.AUTOSK_STORE_LOCK_BIN ?? '',
    // Declared, never guessed: a machine that has not said where its signer
    // lives has not proven a boundary, and the check reports that rather than
    // inventing a default path to probe.
    signerEndpoint: process.env.AUTOSK_SIGNER_SOCK ?? null,
    signerIdentity: async () => {
      // The daemon is the only thing that can say whether the signer runs
      // outside the process a model runs in, and the pinned daemon does not
      // say: its `meta.capabilities` (patches 0013, 0028) names only
      // `task.creation-binding`, and no patch carries a signer (ADR-023,
      // #40). An operator variable stood in for that report until debt 10d
      // (R6-10); nothing does now, so the check cannot pass on this host.
      throw new Error('the pinned daemon reports no signer identity: meta.capabilities names no signer capability');
    },
    join: (...parts) => path.join(...parts),
    readFile: (relative) => readFile(path.isAbsolute(relative) ? relative : resolve(relative), 'utf8'),
    readFileBytes: (target) => readFile(path.isAbsolute(target) ? target : resolve(target)),
    stat: (target) => stat(path.isAbsolute(target) ? target : resolve(target)),
    async run(command, args) {
      const { stdout } = await execFileAsync(command, args, { cwd: root, timeout: 15_000 });
      return { code: 0, stdout };
    },
    // Resolved by walking PATH rather than by asking a shell: a shell would
    // apply the operator's aliases and functions, which are not what a runtime
    // would execute.
    async which(command) {
      for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
        const candidate = path.join(dir, command);
        try {
          await stat(candidate);
          return candidate;
        } catch {
          continue;
        }
      }
      return '';
    },
  };
}

/** The project identity a report is about: the pinned upstream tree it targets. */
async function projectIdentity(env) {
  try {
    const manifest = JSON.parse(await env.readFile('compat/autosk/manifest.v1.json'));
    return `autosk-flow:${manifest.result_tree}`;
  } catch {
    return 'autosk-flow:unknown';
  }
}

export async function generateReport(env) {
  const checks = await runChecks(env);
  return buildReport({
    checks,
    projectIdentity: await projectIdentity(env),
    runtimeIdentity: createHash('sha256')
      .update(`${env.nodeVersion}\n${env.daemonBinary}\n${env.helperBinary}`, 'utf8')
      .digest('hex'),
    tool: { name: 'autosk-flow-doctor', version: env.toolVersion },
    generatedAt: new Date(env.nowMs()).toISOString(),
    home: env.home,
  });
}

export function parseArgs(argv) {
  const options = { out: '', require: [], json: false };
  // An option that takes a value refuses to go without one: `--workflow` with
  // nothing after it once left the gate off while the run still exited 0.
  const value = (i, arg) => {
    const next = argv[i];
    if (next === undefined || next === '' || next.startsWith('--')) throw new Error(`${arg} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--out') options.out = value(++i, arg);
    else if (arg === '--require') {
      options.require = value(++i, arg).split(',').filter(Boolean);
      if (options.require.length === 0) throw new Error(`${arg} needs a value`);
    } else if (arg === '--workflow') options.workflow = value(++i, arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/** The graph document whose registered workflows the gate is keyed by. */
export const GRAPH_PATH = 'resources/workflow-graph/workflow-graph.v1.json';

/**
 * The checks to hold the report to: a workflow's dispatch set, asked of the
 * workflow preflight by the workflow's graph name, plus any named with
 * `--require`. Doctor does not keep a second copy of who needs what.
 */
export async function requiredSet(env, { workflow, require }) {
  if (workflow === undefined) return [...require];
  demand(typeof workflow === 'string' && workflow !== '', 'doctor_required_set_unsatisfied',
    'A workflow was named without a name', { workflow });
  const graph = JSON.parse(await env.readFile(GRAPH_PATH));
  return [...new Set([...requiredFor(graph, workflow), ...require])];
}

function human(report, required) {
  const lines = [`status: ${report.status}   unverifiable: ${unverifiableCount(report)}`];
  for (const check of report.checks) {
    lines.push(`  ${check.status.padEnd(12)} ${check.id}`);
    if (check.status === 'fail' && check.remediation) lines.push(`               ${check.remediation}`);
    if (check.status === 'unverifiable') lines.push(`               ${check.unverifiable_reason}`);
  }
  if (required.length > 0) {
    const { ready, blocking } = readiness(report, required, Date.now());
    lines.push(`required set: ${ready ? 'satisfied' : 'blocked'}`);
    for (const entry of blocking) lines.push(`  blocked      ${entry.id} (${entry.reason})`);
  }
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const env = hostEnv();
  const required = await requiredSet(env, options);
  const report = await generateReport(env);
  if (options.out) {
    const target = path.resolve(options.out);
    if (target === ROOT || target.startsWith(`${ROOT}${path.sep}`)) {
      console.error('doctor writes nothing into the project: choose an --out path outside it');
      process.exitCode = 2;
    } else {
      await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
    }
  }
  console.log(options.json ? JSON.stringify(report, null, 2) : human(report, required));
  if (process.exitCode === undefined) {
    const { ready } = required.length > 0
      ? readiness(report, required, Date.now())
      : { ready: report.status !== 'fail' };
    process.exitCode = ready ? 0 : 1;
  }
}
