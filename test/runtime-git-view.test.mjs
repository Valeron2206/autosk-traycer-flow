/**
 * Tests for the Git view a model step and a check run in (debt 13b, R9-1,
 * ADR-110): the handout autoskd writes for a launch, and what the launch
 * builds from it under the model account.
 *
 * Real repositories and real Git. The launch side is #18's and runs under
 * another uid, which this suite cannot; `launch` below is the procedure the
 * contract states (`docs/contracts/platform-support.md` §5b), run under the
 * suite's own uid, so what it proves is what the view holds and does, not who
 * owns it. The ownership half — the installing user's Git refusing the view —
 * is #13's probe.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const code = (name) => (error) => error.code === name;

/** A module the change adds is imported inside each test, so a run on a base without it fails at the behaviour, not at the file. */
const viewModule = () => import("../src/host/git-view.mjs");

const ENV = (home) => ({
  PATH: process.env.PATH,
  HOME: home,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "autosk test",
  GIT_AUTHOR_EMAIL: "test@autosk.invalid",
  GIT_COMMITTER_NAME: "autosk test",
  GIT_COMMITTER_EMAIL: "test@autosk.invalid",
});

/** The injected `git`: `{ code, stdout, stderr }`, with `input` written to its stdin. */
const gitIn = (root, home) => (args, { cwd, input } = {}) =>
  new Promise((resolve) => {
    const child = execFile("git", args, { cwd: cwd ?? root, env: ENV(home), encoding: "utf8", maxBuffer: 1 << 26 }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr: error && !stderr ? String(error) : stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });

/**
 * The installing user's project: three commits on `main`, a branch of another
 * line, a tag, a protected-namespace ref and a remote whose URL holds a
 * credential — everything a view must not carry.
 */
async function project(t) {
  const root = await mkdtemp(path.join(tmpdir(), "autosk-git-view-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  await mkdir(home);
  const repo = path.join(root, "project");
  await mkdir(repo);
  const git = gitIn(repo, home);
  const ok = async (args, options) => {
    const result = await git(args, options);
    assert.equal(result.code, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  await ok(["init", "--quiet", "--initial-branch=main"]);
  await writeFile(path.join(repo, "a.txt"), "one\n");
  await mkdir(path.join(repo, "sub"));
  await writeFile(path.join(repo, "sub", "b.txt"), "two\n");
  await ok(["add", "-A"]);
  await ok(["commit", "--quiet", "-m", "c1"]);
  const c1 = await ok(["rev-parse", "HEAD"]);
  await writeFile(path.join(repo, "a.txt"), "one\nthree\n");
  await ok(["commit", "--quiet", "-am", "c2"]);
  const c2 = await ok(["rev-parse", "HEAD"]);
  await ok(["checkout", "--quiet", "-b", "other"]);
  await writeFile(path.join(repo, "other-line.txt"), "another line of history\n");
  await ok(["add", "-A"]);
  await ok(["commit", "--quiet", "-m", "other line"]);
  const other = await ok(["rev-parse", "HEAD"]);
  await ok(["checkout", "--quiet", "main"]);
  await writeFile(path.join(repo, "a.txt"), "one\nthree\nfour\n");
  await ok(["commit", "--quiet", "-am", "c3"]);
  const c3 = await ok(["rev-parse", "HEAD"]);
  await ok(["tag", "v1", c2]);
  await ok(["update-ref", "refs/autosk/epics/e/planning", c2]);
  await ok(["remote", "add", "origin", "https://user:SECRET-TOKEN@example.invalid/p.git"]);
  return { root, home, repo, git, ok, c1, c2, c3, other };
}

/** What the launch does under the model account (§5b): a repository of its own at the checkout's root, from the handout. */
async function launch(manifest, handoutDir, checkout, home) {
  const env = ENV(home);
  const run = (args, input) =>
    new Promise((resolve, reject) => {
      const child = execFile("git", args, { cwd: checkout, env, encoding: "utf8" }, (error, stdout, stderr) =>
        error ? reject(new Error(`git ${args.join(" ")}: ${stderr}`)) : resolve(stdout.trimEnd()));
      child.stdin.on("error", () => {});
      child.stdin.end(input ?? "");
    });
  await rm(path.join(checkout, ".git"), { recursive: true, force: true });
  await run(["init", "--quiet", "."]);
  await run(["index-pack", "--stdin"], await readFile(path.join(handoutDir, manifest.pack)));
  await writeFile(path.join(checkout, ".git", "shallow"), `${manifest.since}\n`);
  await run(["update-ref", "--no-deref", "HEAD", manifest.commit]);
  await run(["reset", "--quiet"]);
  return { view: (args) => run(args), env };
}

async function checkout(t, p, commit = p.c3) {
  const dir = path.join(p.root, "checkout");
  await p.ok(["worktree", "add", "--detach", "--quiet", dir, commit]);
  const handoutDir = path.join(p.root, "handout");
  await mkdir(handoutDir);
  return { dir, handoutDir };
}

test("the handout holds the handed commit and the line down to the base, and the view built from it is a repository (R9-1)", async (t) => {
  const p = await project(t);
  const { handOutGitView } = await viewModule();
  const { dir, handoutDir } = await checkout(t, p);
  const manifest = await handOutGitView(p.git, { dir: handoutDir, commit: p.c3, line: [p.c3], since: p.c2 });
  assert.equal(manifest.commit, p.c3);
  assert.equal(manifest.since, p.c2);
  assert.equal(manifest.object_format, "sha1");
  const { view } = await launch(manifest, handoutDir, dir, p.home);
  // Requirement 1: HEAD names the commit handed over, and the checkout is clean on it.
  assert.equal(await view(["rev-parse", "HEAD"]), p.c3);
  assert.equal(await view(["status", "--short"]), "");
  assert.equal(await view(["ls-files"]), await p.ok(["ls-files"]));
  // The line since the base is there, and nothing below it.
  assert.deepEqual((await view(["log", "--format=%s"])).split("\n"), ["c3", "c2"]);
  assert.equal(await view(["diff", "--stat", p.c2, "HEAD"]).then((out) => out.includes("a.txt")), true);
  // Edits show as they do in any repository.
  await writeFile(path.join(dir, "a.txt"), "edited\n");
  await writeFile(path.join(dir, "new.txt"), "new\n");
  assert.deepEqual((await view(["status", "--short"])).split("\n"), [" M a.txt", "?? new.txt"]);
  assert.match(await view(["diff"]), /\+edited/u);
});

test("the view holds what was handed and no other ref, commit, reflog entry or configuration of the project (R9-1, requirement 2)", async (t) => {
  const p = await project(t);
  const { handOutGitView } = await viewModule();
  const { dir, handoutDir } = await checkout(t, p);
  const manifest = await handOutGitView(p.git, { dir: handoutDir, commit: p.c3, line: [p.c3], since: p.c2 });
  const { view } = await launch(manifest, handoutDir, dir, p.home);
  // No ref but HEAD: not the branches, the tag, the protected namespace or the remote's.
  assert.equal(await view(["for-each-ref"]), "");
  assert.equal(await view(["remote"]), "");
  assert.equal((await view(["reflog"])).split("\n").length, 1);
  // Objects of another line, and of history below the base, are absent.
  for (const absent of [p.other, p.c1]) {
    const probe = await execFileAsync("git", ["cat-file", "-e", absent], { cwd: dir, env: ENV(p.home) }).then(() => "present", () => "absent");
    assert.equal(probe, "absent", absent);
  }
  // No path into the project's Git directory, and none of its configuration.
  const gitDir = path.join(dir, ".git");
  const files = (await readdir(gitDir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.parentPath.includes(`${path.sep}objects`))
    .map((entry) => path.join(entry.parentPath, entry.name));
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => "");
    assert.equal(text.includes(p.repo), false, `${file} names the project`);
    assert.equal(text.includes("SECRET-TOKEN"), false, `${file} carries the project's remote`);
  }
  await assert.rejects(readFile(path.join(gitDir, "objects", "info", "alternates")), code("ENOENT"));
  await assert.rejects(readFile(path.join(gitDir, "commondir")), code("ENOENT"));
});

test("the view needs no Git variable: a repository a check makes elsewhere is its own (R9-1, requirement 1)", async (t) => {
  const p = await project(t);
  const { handOutGitView } = await viewModule();
  const { dir, handoutDir } = await checkout(t, p);
  const manifest = await handOutGitView(p.git, { dir: handoutDir, commit: p.c3, line: [p.c3], since: p.c2 });
  const { env } = await launch(manifest, handoutDir, dir, p.home);
  assert.equal(Object.keys(env).some((name) => name.startsWith("GIT_DIR") || name === "GIT_WORK_TREE"), false);
  const elsewhere = await mkdtemp(path.join(p.root, "temporary-"));
  await execFileAsync("git", ["init", "--quiet", "."], { cwd: elsewhere, env });
  const top = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: elsewhere, env });
  assert.equal(path.resolve(top.stdout.trim()), path.resolve(elsewhere));
  await execFileAsync("git", ["commit", "--quiet", "--allow-empty", "-m", "a check's own"], { cwd: elsewhere, env });
  // The view is untouched by it.
  assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir, env })).stdout.trim(), p.c3);
});

test("without a base the handout is the handed commit alone", async (t) => {
  const p = await project(t);
  const { handOutGitView } = await viewModule();
  const { dir, handoutDir } = await checkout(t, p);
  const manifest = await handOutGitView(p.git, { dir: handoutDir, commit: p.c3, line: [p.c3] });
  assert.equal(manifest.since, p.c3);
  const { view } = await launch(manifest, handoutDir, dir, p.home);
  assert.deepEqual((await view(["log", "--format=%s"])).split("\n"), ["c3"]);
  assert.equal(await view(["status", "--short"]), "");
  assert.equal(await view(["fsck", "--no-dangling"]).catch((error) => error.message), "");
});

test("a commit outside the line is refused, and nothing is written (R9-1)", async (t) => {
  const p = await project(t);
  const { handOutGitView } = await viewModule();
  const { handoutDir } = await checkout(t, p);
  // `other` is a line the staging line does not contain: handing it would hand another line's history.
  await assert.rejects(handOutGitView(p.git, { dir: handoutDir, commit: p.other, line: [p.c3] }), code("git_view_commit_outside_line"));
  // A commit above the line's tip is outside it too.
  await assert.rejects(handOutGitView(p.git, { dir: handoutDir, commit: p.c3, line: [p.c2] }), code("git_view_commit_outside_line"));
  assert.deepEqual(await readdir(handoutDir), []);
  // Any of the line's tips admits it.
  const manifest = await handOutGitView(p.git, { dir: handoutDir, commit: p.c2, line: [p.other, p.c3] });
  assert.equal(manifest.commit, p.c2);
});

test("a base that is not on the handed commit's history is refused, and nothing is written (R9-1)", async (t) => {
  const p = await project(t);
  const { handOutGitView } = await viewModule();
  const { handoutDir } = await checkout(t, p);
  await assert.rejects(handOutGitView(p.git, { dir: handoutDir, commit: p.c3, line: [p.c3], since: p.other }), code("git_view_boundary_invalid"));
  await assert.rejects(handOutGitView(p.git, { dir: handoutDir, commit: p.c2, line: [p.c3], since: p.c3 }), code("git_view_boundary_invalid"));
  assert.deepEqual(await readdir(handoutDir), []);
});

test("what is not a full object id is refused before any Git command runs (R9-1)", async (t) => {
  const { handOutGitView } = await viewModule();
  const calls = [];
  const git = async (args) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };
  const good = "a".repeat(40);
  for (const bad of ["HEAD", "--upload-pack=x", "A".repeat(40), "a".repeat(39), "", null, undefined, 7]) {
    await assert.rejects(handOutGitView(git, { dir: "/tmp/x", commit: bad, line: [good] }), code("git_view_oid_invalid"), String(bad));
    await assert.rejects(handOutGitView(git, { dir: "/tmp/x", commit: good, line: [bad] }), code("git_view_oid_invalid"), String(bad));
    // An absent boundary is the default, the commit alone; any other value is one to be checked.
    if (bad !== null && bad !== undefined) {
      await assert.rejects(handOutGitView(git, { dir: "/tmp/x", commit: good, line: [good], since: bad }), code("git_view_oid_invalid"), String(bad));
    }
  }
  // A line names a tip, at least; and two object formats are objects no repository holds together.
  await assert.rejects(handOutGitView(git, { dir: "/tmp/x", commit: good, line: [] }), code("git_view_oid_invalid"));
  await assert.rejects(handOutGitView(git, { dir: "/tmp/x", commit: good, line: ["b".repeat(64)] }), code("git_view_oid_invalid"));
  await assert.rejects(handOutGitView(git, { dir: "relative", commit: good, line: [good] }), code("git_view_dir_invalid"));
  assert.deepEqual(calls, []);
});

test("a Git command that fails is reported as the handout's, not as a refusal of the commit (R9-1)", async (t) => {
  const p = await project(t);
  const { handOutGitView } = await viewModule();
  const { handoutDir } = await checkout(t, p);
  // An object the repository does not have: Git answers 128, which is neither ancestor nor not.
  await assert.rejects(handOutGitView(p.git, { dir: handoutDir, commit: "e".repeat(40), line: [p.c3] }), code("git_view_git_failed"));
  // A handout directory that is not there.
  await assert.rejects(handOutGitView(p.git, { dir: path.join(p.root, "missing", "deeper"), commit: p.c3, line: [p.c3] }), code("git_view_git_failed"));
});

test("the handout writes no ref into the project, only the pack and its index into the directory it was given (R9-1, requirement 2)", async (t) => {
  const p = await project(t);
  const { handOutGitView } = await viewModule();
  const { handoutDir } = await checkout(t, p);
  const refsBefore = await p.ok(["for-each-ref"]);
  const reflogBefore = await p.ok(["reflog", "show", "--all"]);
  const manifest = await handOutGitView(p.git, { dir: handoutDir, commit: p.c3, line: [p.c3], since: p.c2 });
  assert.equal(await p.ok(["for-each-ref"]), refsBefore);
  assert.equal(await p.ok(["reflog", "show", "--all"]), reflogBefore);
  assert.deepEqual((await readdir(handoutDir)).sort(), [manifest.idx, manifest.pack].sort());
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(manifest.format, "autosk-git-view/v1");
});

test("a replace ref the user wrote changes nothing that is handed (R9-1, §5a's --no-replace-objects)", async (t) => {
  const p = await project(t);
  const { handOutGitView } = await viewModule();
  const { dir, handoutDir } = await checkout(t, p);
  // The user replaces c2 by c1. A Git command that honours it walks c3's history as c3, c2(=c1) and stops, so c1 is no ancestor of c3 to it.
  await p.ok(["replace", p.c2, p.c1]);
  assert.equal((await p.git(["merge-base", "--is-ancestor", p.c1, p.c3])).code, 1);
  const manifest = await handOutGitView(p.git, { dir: handoutDir, commit: p.c3, line: [p.c3], since: p.c1 });
  const { view } = await launch(manifest, handoutDir, dir, p.home);
  // The history and the content handed are the true ones.
  assert.deepEqual((await view(["log", "--format=%s"])).split("\n"), ["c3", "c2", "c1"]);
  assert.equal(await view(["show", `${p.c2}:a.txt`]), "one\nthree");
});

test("the view of a repository in the sha256 format is one too (R9-1, ADR-098)", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "autosk-git-view-256-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  await mkdir(home);
  const repo = path.join(root, "project");
  await mkdir(repo);
  const git = gitIn(repo, home);
  const init = await git(["init", "--quiet", "--object-format=sha256", "--initial-branch=main"]);
  if (init.code !== 0) return t.skip("this Git has no sha256 repositories");
  await writeFile(path.join(repo, "a.txt"), "one\n");
  await git(["add", "-A"]);
  await git(["commit", "--quiet", "-m", "c1"]);
  const commit = (await git(["rev-parse", "HEAD"])).stdout.trim();
  assert.equal(commit.length, 64);
  const { handOutGitView } = await viewModule();
  const handoutDir = path.join(root, "handout");
  await mkdir(handoutDir);
  const manifest = await handOutGitView(git, { dir: handoutDir, commit, line: [commit] });
  assert.equal(manifest.object_format, "sha256");
  const dir = path.join(root, "checkout");
  await mkdir(dir);
  await cp(path.join(repo, "a.txt"), path.join(dir, "a.txt"));
  const env = ENV(home);
  const run = (args, input) => new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd: dir, env, encoding: "utf8" }, (error, stdout, stderr) => (error ? reject(new Error(stderr)) : resolve(stdout.trimEnd())));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
  await run(["init", "--quiet", "--object-format=sha256", "."]);
  await run(["index-pack", "--stdin"], await readFile(path.join(handoutDir, manifest.pack)));
  await writeFile(path.join(dir, ".git", "shallow"), `${manifest.since}\n`);
  await run(["update-ref", "--no-deref", "HEAD", commit]);
  await run(["reset", "--quiet"]);
  assert.equal(await run(["rev-parse", "HEAD"]), commit);
  assert.equal(await run(["status", "--short"]), "");
});
