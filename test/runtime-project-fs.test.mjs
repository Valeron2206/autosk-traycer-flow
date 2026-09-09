/**
 * Tests for the safe project filesystem adapter (issue #22).
 *
 * Every other module takes a filesystem by injection and says what it needs
 * from it. This is the one the product uses, and these are the properties those
 * modules assume — checked against a real filesystem with real symlinks.
 */

import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { REFUSALS, projectFs } from "../src/host/project-fs.mjs";

const code = (name) => (error) => error.code === name;

const node = { lstat, readFile, writeFile, mkdir: (dir) => mkdir(dir, { recursive: true }), unlink, realpath, rename };

async function project(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "autosk-fs-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "project");
  await mkdir(root, { recursive: true });
  await mkdir(path.join(base, "outside"), { recursive: true });
  return { base, root, fs: await projectFs(node, { root }) };
}

test("the filesystem root is not a project", async () => {
  // Every containment check is "inside `<root>/`". With `<root>` at `/` that
  // reads as "inside anything", which is the one answer this adapter exists
  // never to give — so it is refused where the adapter is built, not where a
  // path is checked.
  await assert.rejects(projectFs(node, { root: "/" }), (error) => error.code === "fs_outside_project");
});

test("a path at the filesystem root is refused rather than read as a bare name", async (t) => {
  // `/a.txt` has its only separator at position zero. Reading the parent as the
  // empty string instead of `/` would resolve the target against the process's
  // working directory — which, for a check whose whole job is "is this inside
  // the project", is the one answer that must never be produced by accident.
  const { fs } = await project(t);
  await assert.rejects(fs.readFile("/a.txt"), (error) => error.code === "fs_outside_project");
  await assert.rejects(fs.writeFile("/a.txt", Buffer.from("x")), (error) => error.code === "fs_outside_project");
});

test("a write lands inside the project, and is read back from there", async (t) => {
  const { root, fs } = await project(t);
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/a.txt"), Buffer.from("one\n"));
  assert.equal((await fs.readFile(path.join(root, "src/a.txt"))).toString("utf8"), "one\n");
  assert.equal(fs.adapter, "safe_project_fs");
  assert.equal(fs.root, root);
});

test("a path outside the project is refused, however it got there", async (t) => {
  const { base, root, fs } = await project(t);
  await assert.rejects(
    () => fs.writeFile(path.join(base, "outside", "a.txt"), Buffer.from("x")),
    code("fs_outside_project"),
  );
  // Through a symlinked directory the string still looks right.
  await symlink(path.join(base, "outside"), path.join(root, "escape"));
  await assert.rejects(
    () => fs.writeFile(path.join(root, "escape", "a.txt"), Buffer.from("x")),
    code("fs_outside_project"),
  );
  await assert.rejects(() => fs.readFile(path.join(base, "outside", "a.txt")), code("fs_outside_project"));
  await assert.rejects(() => readFile(path.join(base, "outside", "a.txt")));
});

test("a symlink is never written through, even inside the project", async (t) => {
  const { root, fs } = await project(t);
  const real = path.join(root, "real.txt");
  await writeFile(real, "original\n");
  await symlink(real, path.join(root, "link.txt"));
  await assert.rejects(() => fs.writeFile(path.join(root, "link.txt"), Buffer.from("new\n")), code("fs_symlink_refused"));
  await assert.rejects(() => fs.readFile(path.join(root, "link.txt")), code("fs_symlink_refused"));
  // Writing through it would change something nobody named.
  assert.equal(await readFile(real, "utf8"), "original\n");
});

test("a removal takes one named file, never a directory or a link", async (t) => {
  const { root, fs } = await project(t);
  await fs.mkdir(path.join(root, "evidence"));
  await fs.writeFile(path.join(root, "evidence/a.log"), Buffer.from("noise\n"));
  await symlink(path.join(root, "evidence/a.log"), path.join(root, "evidence/link.log"));

  await assert.rejects(() => fs.rm(path.join(root, "evidence")), code("fs_not_regular"));
  await assert.rejects(() => fs.rm(path.join(root, "evidence/link.log")), code("fs_symlink_refused"));
  await assert.rejects(() => fs.rm(path.join(root, "evidence/gone.log")), code("fs_not_regular"));
  await fs.rm(path.join(root, "evidence/a.log"));
  await assert.rejects(() => readFile(path.join(root, "evidence/a.log")));
  // The link is still there: removing it was refused, not performed quietly.
  assert.ok(await lstat(path.join(root, "evidence/link.log")));
});

test("recursive deletion is not offered, and the refusal says so", async (t) => {
  const { fs } = await project(t);
  // The operation that cannot be undone, and no caller here needs it.
  await assert.rejects(() => fs.rmrf("anything"), code("fs_recursive_refused"));
  assert.deepEqual([...REFUSALS], [
    "fs_outside_project",
    "fs_not_regular",
    "fs_symlink_refused",
    "fs_recursive_refused",
  ]);
});

test("the root is resolved once, so a symlinked root still admits its own files", async (t) => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "autosk-fs-root-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const real = path.join(base, "real-project");
  await mkdir(real, { recursive: true });
  const linked = path.join(base, "project");
  await symlink(real, linked);

  // Constructed on the link, resolved to what it points at: otherwise every
  // resolved write path would fail to start with the unresolved root, and the
  // project's own files would read as outside it.
  const fs = await projectFs(node, { root: linked });
  assert.equal(fs.root, real);
  await fs.writeFile(path.join(real, "a.txt"), Buffer.from("x\n"));
  assert.equal(await readFile(path.join(real, "a.txt"), "utf8"), "x\n");
});

test("a removal is resolved before anything is unlinked", async (t) => {
  const { base, root, fs } = await project(t);
  const victim = path.join(base, "outside", "victim.txt");
  await writeFile(victim, "somebody else's file\n");
  await symlink(path.join(base, "outside"), path.join(root, "escape"));
  // The path is inside the project as a string and outside it as a location.
  await assert.rejects(() => fs.rm(path.join(root, "escape", "victim.txt")), code("fs_outside_project"));
  assert.equal(await readFile(victim, "utf8"), "somebody else's file\n");
});

test("lstat answers about the thing named, not about its target", async (t) => {
  const { root, fs } = await project(t);
  const real = path.join(root, "real.txt");
  await writeFile(real, "x\n");
  await symlink(real, path.join(root, "link.txt"));
  const link = await fs.lstat(path.join(root, "link.txt"));
  assert.equal(link.isSymbolicLink, true);
  assert.equal(link.isFile, false);
  const file = await fs.lstat(real);
  assert.equal(file.isFile, true);
  assert.equal(file.isSymbolicLink, false);
});
