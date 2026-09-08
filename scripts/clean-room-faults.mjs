#!/usr/bin/env node

/**
 * Real fault injection for the clean-room matrix (#36, groups F005-F016).
 *
 * Every case here creates the fault for real — a symlink on disk, a ref moved
 * by a second process, an inherited `GIT_DIR`, a harness that prints success
 * and exits 0, a swap interrupted between two durable writes — and then asks
 * the host module that owns that boundary what it makes of the observed state.
 *
 * Each case also runs its own control: the same guard, asked about the state
 * without the fault, has to stay silent. Without that half, a guard that
 * refuses everything would report twelve detections and prove nothing, which is
 * the artefact this program keeps finding.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath as osRealpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { collisionErrors, environmentErrors, refMovementErrors } from '../src/host/approved-delta.mjs';
import { aggregateBinding, casAdmission, postCasErrors, resumePlan } from '../src/host/epic-staging.mjs';
import { batchSufficiencyErrors } from '../src/host/work-type-gates.mjs';
import { classifyExit, dispatchOutcome, waitExceeded } from '../src/host/provider-preflight.mjs';
import { locationErrors } from '../src/host/source-snapshot.mjs';

const execFileAsync = promisify(execFile);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STAGING_REF = 'refs/autosk/epics/clean-room/staging';

const git = (cwd, ...args) =>
  execFileAsync('git', args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_AUTHOR_NAME: 'autosk clean room',
      GIT_AUTHOR_EMAIL: 'clean-room@autosk.invalid',
      GIT_COMMITTER_NAME: 'autosk clean room',
      GIT_COMMITTER_EMAIL: 'clean-room@autosk.invalid',
    },
  });

/**
 * The real path, resolved by the operating system rather than by string work.
 *
 * The directory is resolved and the last component appended, so a path whose
 * final component does not exist yet still answers where a write to it would
 * land — which is the whole question at a filesystem-write boundary.
 */
const realpath = async (target) =>
  path.join(await osRealpath(path.dirname(target)), path.basename(target));

/** A real repository with one commit, so refs and trees are real OIDs. */
async function repository(root) {
  const repo = path.join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await git(repo, 'init', '--quiet', '--initial-branch=main');
  await writeFile(path.join(repo, 'a.txt'), 'one\n');
  await git(repo, 'add', 'a.txt');
  await git(repo, 'commit', '--quiet', '-m', 'base');
  const { stdout: head } = await git(repo, 'rev-parse', 'HEAD');
  const { stdout: tree } = await git(repo, 'rev-parse', 'HEAD^{tree}');
  return { repo, head: head.trim(), tree: tree.trim() };
}

/**
 * A real staging commit, on the staging ref and off the target branch.
 *
 * Built with plumbing so the target ref never moves: the two interrupted-swap
 * cases differ only in whether the swap had happened, and that difference has
 * to come from the observed ref rather than from how the fixture was written.
 */
async function stageCommit(repo, head) {
  await writeFile(path.join(repo, 'b.txt'), 'staged\n');
  await git(repo, 'add', 'b.txt');
  const { stdout: tree } = await git(repo, 'write-tree');
  const { stdout: oid } = await git(repo, 'commit-tree', tree.trim(), '-p', head, '-m', 'staged');
  await git(repo, 'update-ref', STAGING_REF, oid.trim());
  await git(repo, 'reset', '--quiet', '--hard', head);
  return { oid: oid.trim(), tree: tree.trim() };
}

/**
 * F005 — a project subdirectory replaced by a symlink out of the project.
 *
 * The fault is a real symlink. The guard is asked the question it exists for:
 * given where this write would actually land, is that inside the project?
 */
async function f005(root) {
  const project = path.join(root, 'f005', 'project');
  const outside = path.join(root, 'f005', 'outside');
  await mkdir(path.join(project, '.autosk', 'evidence'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, path.join(project, '.autosk', 'sessions'));

  const projectRoot = await osRealpath(project);
  const where = { transientRoots: [], worktreeRoots: [], projectRoot };
  // Resolved, not concatenated: the string path is inside the project and the
  // write is not, which is the entire fault.
  const escaped = await realpath(path.join(project, '.autosk', 'sessions', 'escaped.json'));
  const ordinary = await realpath(path.join(project, '.autosk', 'evidence', 'record.json'));
  return {
    detected: locationErrors(escaped, where).some((error) => error.reason === 'snapshot_out_of_project'),
    // The same resolution on a directory nobody replaced stays in the project.
    control: locationErrors(ordinary, where).length === 0,
    detail: `resolves to ${escaped}`,
  };
}

/** F006 — a restore that returns the branch name but the wrong tree. */
async function f006(root) {
  const { repo, head, tree } = await repository(path.join(root, 'f006'));
  await writeFile(path.join(repo, 'a.txt'), 'two\n');
  await git(repo, 'commit', '--quiet', '-am', 'drift');
  const { stdout: newTree } = await git(repo, 'rev-parse', 'HEAD^{tree}');
  const state = { post_cas: { expected_new_oid: head }, staging_tree_oid: tree };
  // The branch is back by name; the tree is not the one that was recorded.
  const errors = postCasErrors(state, {
    oid: head,
    tree_oid: newTree.trim(),
    contains_recorded_result: true,
    reflog_entries: 1,
  });
  return {
    detected: errors.length > 0,
    control: postCasErrors(state, { oid: head, tree_oid: tree, contains_recorded_result: true, reflog_entries: 1 })
      .length === 0,
    detail: 'the target tree is not the accepted one',
  };
}

/** F007 — the target advances from another process inside the CAS window. */
async function f007(root) {
  const { repo, head } = await repository(path.join(root, 'f007'));
  // A second process moves the ref while the operation holds the old value.
  await writeFile(path.join(repo, 'b.txt'), 'foreign\n');
  await git(repo, 'add', 'b.txt');
  await git(repo, 'commit', '--quiet', '-m', 'foreign');
  const { stdout: moved } = await git(repo, 'rev-parse', 'HEAD');
  const observation = { ref: 'refs/heads/main', expected_old_oid: head, post_state: 'known', reflog_entries: 1 };
  const errors = refMovementErrors({ ...observation, observed_old_oid: moved.trim() });
  return {
    detected: errors.some((error) => error.reason === 'foreign_ref_movement'),
    control: refMovementErrors({ ...observation, observed_old_oid: head }).length === 0,
    detail: `expected ${head.slice(0, 8)}, observed ${moved.trim().slice(0, 8)}`,
  };
}

/** F008 — the ref moves away and back to the recorded OID during recovery. */
async function f008(root) {
  const { repo, head } = await repository(path.join(root, 'f008'));
  const { stdout: quiet } = await git(repo, 'reflog', '--format=%H');
  const before = quiet.trim().split('\n').filter(Boolean).length;
  await writeFile(path.join(repo, 'b.txt'), 'away\n');
  await git(repo, 'add', 'b.txt');
  await git(repo, 'commit', '--quiet', '-m', 'away');
  await git(repo, 'reset', '--quiet', '--hard', head);
  const { stdout: back } = await git(repo, 'rev-parse', 'HEAD');
  const { stdout: reflog } = await git(repo, 'reflog', '--format=%H');
  const entries = reflog.trim().split('\n').filter(Boolean).length;
  // The ref reads as expected. The reflog says it did not stay there, which is
  // the only reason the ABA is visible at all.
  const observation = {
    ref: 'refs/heads/main',
    expected_old_oid: head,
    observed_old_oid: back.trim(),
    post_state: 'known',
  };
  const errors = refMovementErrors({ ...observation, reflog_entries: entries });
  return {
    detected: back.trim() === head && errors.some((error) => error.reason === 'reflog_ambiguous'),
    // The same ref, with the reflog it had before anything moved, is admitted.
    control: refMovementErrors({ ...observation, reflog_entries: before }).length === 0,
    detail: `ref is back at ${head.slice(0, 8)} with ${entries} reflog entries, was ${before}`,
  };
}

/** F009 — an untracked file sitting at an approved entry's path. */
async function f009(root) {
  const { repo } = await repository(path.join(root, 'f009'));
  const collided = 'src/store.ts';
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, collided), "someone's uncommitted work\n");
  const { stdout } = await git(repo, 'status', '--porcelain', '--untracked-files=all');
  const untracked = stdout
    .split('\n')
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3).trim());
  const delta = { entries: [{ path: collided }], pathspec: ['src/**'] };
  return {
    detected: collisionErrors(delta, { untracked }).some((error) => error.reason === 'untracked_collision'),
    // Nothing in the way is not a collision, whatever else the tree holds.
    control: collisionErrors(delta, { untracked: [] }).length === 0,
    detail: `${untracked.join(', ')} is in the way and is not deleted`,
  };
}

/** F010 — the integration runs with `GIT_DIR` pointing at another repository. */
async function f010(root) {
  const { repo: other } = await repository(path.join(root, 'f010-other'));
  const clean = { PATH: process.env.PATH };
  const inherited = { ...clean, GIT_DIR: path.join(other, '.git') };
  // Proof the variable really redirects: git run with it answers about the
  // other repository rather than about the directory it was run in. Compared
  // through realpath, because on macOS `/var` is a symlink to `/private/var`
  // and a raw prefix check would report a redirect that happened as one that
  // did not.
  const { stdout } = await execFileAsync('git', ['rev-parse', '--absolute-git-dir'], { cwd: ROOT, env: inherited });
  const redirected = stdout.trim() === (await realpath(path.join(other, '.git')));
  return {
    detected: environmentErrors(inherited).some((error) => error.reason === 'inherited_git_env') && redirected,
    control: environmentErrors(clean).length === 0,
    detail: `GIT_DIR redirected git to ${stdout.trim()}`,
  };
}

/** F011 — a harness that prints success and exits 0 with nothing structured. */
async function f011(root) {
  const dir = path.join(root, 'f011');
  await mkdir(dir, { recursive: true });
  const script = path.join(dir, 'harness.sh');
  await writeFile(script, '#!/bin/sh\necho "all checks passed"\nexit 0\n', { mode: 0o755 });
  const { stdout } = await execFileAsync('/bin/sh', [script]);
  const structured = /<<<autosk-result/u.test(stdout);
  return {
    detected: dispatchOutcome(classifyExit({ exit_code: 0, structured_result: structured })) === 'route_result_missing',
    // A run that did emit its result is not refused for the same reason.
    control: dispatchOutcome(classifyExit({ exit_code: 0, structured_result: true })) !== 'route_result_missing',
    detail: `the harness printed "${stdout.trim()}" and exited 0`,
  };
}

/** F012 — a no-op injector that reports the mutation was applied. */
async function f012(root) {
  const { repo, tree } = await repository(path.join(root, 'f012'));
  // The injector claims success and changes nothing, so the tree is unmoved.
  const { stdout: after } = await git(repo, 'rev-parse', 'HEAD^{tree}');
  const applied = after.trim() !== tree;
  const batch = (mutation) => ({
    batch_id: 'f012',
    purpose: 'prove the injector applied something',
    candidate_identity: { tree },
    acceptance_rule: 'every mutation killed',
    failure_taxonomy: 'closed',
    mutations: [{ id: 'm-1', expected_killer: 'T', observed_red_signature: 'r', ...mutation }],
    green_control: 'passed',
    harness_self_test: 'self-test',
    repository_tests_final_run: 'run',
    restore_verified: true,
  });
  return {
    detected: batchSufficiencyErrors(batch(applied ? { application_proof: 'p' } : {}))
      .some((error) => error.reason === 'batch_mutation_not_applied'),
    control: batchSufficiencyErrors(batch({ application_proof: 'the tree moved' })).length === 0,
    detail: 'the injector reported success and the tree did not move',
  };
}

/**
 * F013 — the control run fails on the unmutated candidate.
 *
 * Run for real: a test file that fails is executed, and its exit status is what
 * the batch record carries. A batch whose own controls are red says nothing
 * about the mutants it reports killing.
 */
async function f013(root) {
  const dir = path.join(root, 'f013');
  await mkdir(dir, { recursive: true });
  const control = async (body, name) => {
    const file = path.join(dir, name);
    await writeFile(file, body);
    // A deliberately clean environment. Inheriting this process's would carry
    // `NODE_TEST_CONTEXT` into the child when the harness itself runs under the
    // test runner, and a failing child would then report through the parent's
    // reporter and exit 0 — making the red control read as green depending on
    // who invoked the harness.
    return execFileAsync('node', ['--test', file], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir },
    }).then(() => 'passed', () => 'failed');
  };
  const red = await control(
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('control', () => assert.equal(1, 2));\n",
    'red.test.mjs',
  );
  const green = await control(
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('control', () => assert.equal(1, 1));\n",
    'green.test.mjs',
  );
  const batch = (green_control) => ({
    batch_id: 'f013',
    purpose: 'control',
    candidate_identity: { dir },
    acceptance_rule: 'every mutation killed',
    failure_taxonomy: 'closed',
    mutations: [],
    green_control,
    harness_self_test: 'self-test',
    repository_tests_final_run: 'run',
    restore_verified: true,
  });
  return {
    detected: red === 'failed'
      && batchSufficiencyErrors(batch(red)).some((error) => error.reason === 'batch_green_control_failed'),
    control: green === 'passed' && batchSufficiencyErrors(batch(green)).length === 0,
    detail: `the unmutated candidate's own control run ${red}, so a red result would say nothing`,
  };
}

/** F014 — the observation hangs past its budget. */
async function f014(root) {
  const dir = path.join(root, 'f014');
  await mkdir(dir, { recursive: true });
  const script = path.join(dir, 'hang.sh');
  await writeFile(script, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  const started = Date.now();
  const timeouts = { idle_ms: 400, wall_clock_ms: 400 };
  const child = execFileAsync('/bin/sh', [script], { timeout: 500, killSignal: 'SIGKILL' });
  let timedOut = false;
  try {
    await child;
  } catch (error) {
    timedOut = error.killed === true || error.signal === 'SIGKILL';
  }
  const elapsed = Date.now() - started;
  return {
    detected: timedOut && waitExceeded({ idleMs: elapsed, elapsedMs: elapsed }, timeouts) !== null,
    // A run inside the budget is not reported as one that exceeded it.
    control: waitExceeded({ idleMs: 0, elapsedMs: 1 }, timeouts) === null,
    detail: `the observation was killed after ${elapsed}ms, over the ${timeouts.wall_clock_ms}ms budget`,
  };
}

/** F015 — interrupted between the acceptance record and the ref update. */
async function f015(root) {
  const { repo, head } = await repository(path.join(root, 'f015'));
  const staging = await stageCommit(repo, head);
  const state = acceptedState({ head, staging });
  // The acceptance is durable and the target ref never moved, so the swap is
  // the step that remains: the resume continues without another model run.
  const { stdout: observed } = await git(repo, 'rev-parse', 'refs/heads/main');
  const plan = resumePlan({ ...state, phase: 'accepted' });
  const admission = casAdmission(state, { oid: observed.trim() }, ['T-1']);
  // The control is that this admission is not unconditional: a target holding
  // something nobody can attribute to this Epic is refused from the same state.
  const foreign = casAdmission(state, { oid: 'f'.repeat(40) }, ['T-1']);
  await rm(repo, { recursive: true, force: true });
  return {
    detected: plan.requires_model_run === false && admission.decision === 'may_swap',
    control: foreign.decision === 'refused'
      && foreign.reasons.some((reason) => reason.reason === 'foreign_target_movement'),
    detail: `the target is still at ${observed.trim().slice(0, 8)}; the swap is what remains`,
  };
}

/** F016 — interrupted between the ref update and the read-back. */
async function f016(root) {
  const { repo, head } = await repository(path.join(root, 'f016'));
  const staging = await stageCommit(repo, head);
  const state = acceptedState({ head, staging });
  // The same durable record as F015, and here the swap did happen: the ref
  // holds the recorded result, so the retry is complete rather than in conflict.
  await git(repo, 'update-ref', 'refs/heads/main', staging.oid, head);
  const { stdout: observed } = await git(repo, 'rev-parse', 'refs/heads/main');
  const admission = casAdmission(state, { oid: observed.trim() }, ['T-1']);
  const plan = resumePlan({ ...state, phase: 'target_advanced' });
  // The control is the world where the swap had not happened yet: the same
  // state and guard then answer `may_swap`, not `already_complete`.
  const unswapped = casAdmission(state, { oid: head }, ['T-1']);
  await rm(repo, { recursive: true, force: true });
  return {
    detected: admission.decision === 'already_complete' && plan.next_phase === 'post_cas_verified',
    control: unswapped.decision === 'may_swap',
    detail: 'the ref holds the recorded result; the read-back is the remaining step',
  };
}

/** The durable record an interrupted swap leaves behind. */
function acceptedState({ head, staging }) {
  const base = {
    project_identity: `sha256:${'0'.repeat(58)}`,
    epic_id: 'clean-room',
    staging_ref: STAGING_REF,
    target_ref: 'refs/heads/main',
    recorded_target_base: head,
    planning_head: head,
    receipts: [{ ticket_id: 'T-1' }],
    phase: 'accepted',
    staging_commit_oid: staging.oid,
    staging_tree_oid: staging.tree,
    post_cas: { expected_new_oid: staging.oid },
  };
  const aggregate = {
    outcome: 'pass',
    environment_outcome: 'ok',
    verification_config_digest: 'c'.repeat(64),
    instruction_lock_digest: 'd'.repeat(64),
    staging_commit_oid: base.staging_commit_oid,
    record_hash: 'e'.repeat(64),
  };
  // The binding is computed the way the host computes it: a hand-written one
  // would make every case here pass for the wrong reason.
  base.aggregate = { ...aggregate, binding: aggregateBinding({ ...base, aggregate }) };
  base.acceptance = {
    kind: 'human',
    approver: 'owner',
    staging_commit_oid: base.staging_commit_oid,
    staging_tree_oid: base.staging_tree_oid,
    aggregate_record_hash: aggregate.record_hash,
    tickets: ['T-1'],
  };
  return base;
}

export const CASES = Object.freeze({
  F005: f005,
  F006: f006,
  F007: f007,
  F008: f008,
  F009: f009,
  F010: f010,
  F011: f011,
  F012: f012,
  F013: f013,
  F014: f014,
  F015: f015,
  F016: f016,
});

/** Runs every case, with its control, against a real workspace. */
export async function runFaults({ keep = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'autosk-faults-'));
  const results = [];
  try {
    for (const [id, run] of Object.entries(CASES)) {
      const started = Date.now();
      try {
        const outcome = await run(root);
        results.push({ id, ...outcome, ms: Date.now() - started });
      } catch (error) {
        results.push({ id, detected: false, control: false, detail: `case failed: ${error.message}`, ms: Date.now() - started });
      }
    }
  } finally {
    if (!keep) {
      await execFileAsync('chmod', ['-R', 'u+w', root]).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }
  return Object.freeze({
    results: Object.freeze(results.map(Object.freeze)),
    detected: results.filter((entry) => entry.detected).length,
    // Counted separately, because a guard that refuses everything would detect
    // twelve faults and mean nothing by it.
    controlled: results.filter((entry) => entry.control).length,
    total: results.length,
    ok: results.every((entry) => entry.detected && entry.control),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runFaults({ keep: process.argv.includes('--keep') });
  for (const entry of report.results) {
    const state = entry.detected && entry.control ? 'ok  ' : 'FAIL';
    console.log(`${state} ${entry.id} (${entry.ms}ms)${entry.control ? '' : ' [control failed]'} ${entry.detail}`);
  }
  console.log(`${report.detected}/${report.total} faults detected, ${report.controlled}/${report.total} controls silent`);
  process.exitCode = report.ok ? 0 : 1;
}
