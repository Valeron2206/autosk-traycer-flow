import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadAutoskManifest, prepareAutosk } from "../scripts/prepare-autosk.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "autosk-patch-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRepo = path.join(root, "source");
  const definitions = path.join(root, "definitions");
  mkdirSync(sourceRepo);
  mkdirSync(path.join(definitions, "patches"), { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: sourceRepo, encoding: "utf8" }).trim();
  git("init", "--quiet");
  writeFileSync(path.join(sourceRepo, "LICENSE"), "Fixture license\n");
  writeFileSync(path.join(sourceRepo, "store.txt"), "legacy\n");
  git("add", "LICENSE", "store.txt");
  git("-c", "user.name=Autosk Test", "-c", "user.email=test@autosk.invalid", "commit", "--quiet", "-m", "test: baseline");
  const commit = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  writeFileSync(path.join(sourceRepo, "store.txt"), "atomic creation\n");
  const patch = execFileSync("git", ["diff", "--binary", "--full-index"], { cwd: sourceRepo });
  git("add", "store.txt");
  const resultTree = git("write-tree");
  const patchPath = path.join(definitions, "patches/0001-store.patch");
  writeFileSync(patchPath, patch);
  writeFileSync(path.join(definitions, "LICENSE"), "Fixture license\n");
  const manifest = {
    schema_version: 1,
    upstream: { repository: "https://github.com/wierdbytes/autosk.git", commit, tree },
    result_tree: resultTree,
    patches: [{ file: "patches/0001-store.patch", sha256: hash(patch) }],
    license: { file: "LICENSE", sha256: hash("Fixture license\n") },
    toolchains: { node: "24", bun: "1.4.0", go: "1.25.0" },
  };
  const manifestPath = path.join(definitions, "manifest.v1.json");
  const save = () => writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  save();
  return { manifest, manifestPath, patchPath, definitions, sourceRepo, save, outputDir: path.join(root, "prepared") };
}

test("preparer reconstructs the pinned result using real Git and exact patch bytes", (t) => {
  const f = fixture(t);
  const receipt = prepareAutosk(f);
  assert.equal(receipt.source_tree, f.manifest.result_tree);
  assert.equal(receipt.upstream_commit, f.manifest.upstream.commit);
  assert.equal(receipt.manifest_sha256, hash(readFileSync(f.manifestPath)));
  assert.equal(readFileSync(path.join(f.outputDir, "store.txt"), "utf8"), "atomic creation\n");
  assert.equal(execFileSync("git", ["write-tree"], { cwd: f.outputDir, encoding: "utf8" }).trim(), receipt.source_tree);
});

for (const [name, mutate, error] of [
  ["unknown manifest fields", (f) => { f.manifest.extra = true; }, /unexpected fields/],
  ["unknown schema version", (f) => { f.manifest.schema_version = 2; }, /unsupported manifest/],
  ["untrusted upstream URL", (f) => { f.manifest.upstream.repository = "https://example.invalid/autosk.git"; }, /upstream repository/],
  ["moving commit name", (f) => { f.manifest.upstream.commit = "main"; }, /Git identity/],
  ["path traversal", (f) => { f.manifest.patches[0].file = "../outside.patch"; }, /patch path/],
  ["duplicate patch", (f) => { f.manifest.patches.push({ ...f.manifest.patches[0] }); }, /duplicate patch/],
  ["empty patch series", (f) => { f.manifest.patches = []; }, /nonempty patch/],
  ["floating toolchain", (f) => { f.manifest.toolchains.bun = "latest"; }, /patch version/],
  ["modified patch", (f) => { writeFileSync(f.patchPath, "changed\n"); }, /patch hash mismatch/],
  ["modified license", (f) => { writeFileSync(path.join(f.definitions, "LICENSE"), "changed\n"); }, /license hash mismatch/],
]) {
  test(`preparer rejects ${name} before creating the destination`, (t) => {
    const f = fixture(t);
    mutate(f);
    f.save();
    assert.throws(() => prepareAutosk(f), error);
    assert.equal(existsSync(f.outputDir), false);
  });
}

test("preparer rejects a symlink patch even when the target has the expected bytes", (t) => {
  const f = fixture(t);
  const content = readFileSync(f.patchPath);
  const target = path.join(f.definitions, "outside.patch");
  writeFileSync(target, content);
  rmSync(f.patchPath);
  symlinkSync(target, f.patchPath);
  assert.throws(() => prepareAutosk(f), /regular file/);
  assert.equal(existsSync(f.outputDir), false);
});

test("preparer never overwrites an existing output directory", (t) => {
  const f = fixture(t);
  mkdirSync(f.outputDir);
  const marker = path.join(f.outputDir, "keep.txt");
  writeFileSync(marker, "keep\n");
  assert.throws(() => prepareAutosk(f), { code: "EEXIST" });
  assert.equal(readFileSync(marker, "utf8"), "keep\n");
});

for (const [name, mutate, error] of [
  ["base tree mismatch", (f) => { f.manifest.upstream.tree = "0".repeat(40); }, /upstream tree mismatch/],
  ["result tree mismatch", (f) => { f.manifest.result_tree = "0".repeat(40); }, /patched source tree mismatch/],
]) {
  test(`preparer refuses ${name} instead of returning a build receipt`, (t) => {
    const f = fixture(t);
    mutate(f);
    f.save();
    assert.throws(() => prepareAutosk(f), error);
  });
}

test("distributed patches are excluded from line-ending conversion", () => {
  // Patch bytes are pinned by SHA-256, so a checkout that rewrites line endings
  // (core.autocrlf=true) would break every hash in the series.
  const { manifest } = loadAutoskManifest();
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const paths = manifest.patches.map((patch) => path.posix.join("compat/autosk", patch.file));
  const output = execFileSync("git", ["check-attr", "text", "--", ...paths], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const lines = output.trim().split("\n");
  assert.equal(lines.length, manifest.patches.length);
  for (const line of lines) assert.match(line, /: text: unset$/);
});

test("committed manifest and license match the exact distributed patch", () => {
  const { manifest } = loadAutoskManifest();
  assert.equal(manifest.result_tree, "774811879a1e407311cf240c6fd91eb754e91fa7");
  assert.deepEqual(
    manifest.patches.map((patch) => patch.file),
    [
      "patches/0001-atomic-task-creation.patch",
      "patches/0002-runtime-snapshot-store.patch",
      "patches/0003-runtime-identity-admission.patch",
      "patches/0004-creation-stress-budget.patch",
      "patches/0005-workflow-shape-identity.patch",
      "patches/0006-distribution-reference-accounting.patch",
    ],
  );
});
