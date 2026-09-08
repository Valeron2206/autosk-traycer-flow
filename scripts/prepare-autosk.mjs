#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MANIFEST = fileURLToPath(new URL("../compat/autosk/manifest.v1.json", import.meta.url));
const OID = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function closedRecord(value, keys, label) {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), `${label}: expected object`);
  requireValue(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label}: unexpected fields`);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readRegularFile(file, maxBytes) {
  const stat = lstatSync(file);
  requireValue(stat.isFile() && stat.size <= maxBytes, `${path.basename(file)}: expected bounded regular file`);
  return readFileSync(file);
}

export function loadAutoskManifest(manifestPath = DEFAULT_MANIFEST) {
  const bytes = readRegularFile(manifestPath, 16_384);
  const manifest = JSON.parse(bytes.toString("utf8"));
  closedRecord(manifest, ["schema_version", "upstream", "result_tree", "patches", "license", "toolchains"], "manifest");
  requireValue(manifest.schema_version === 1, "unsupported manifest version");
  closedRecord(manifest.upstream, ["repository", "commit", "tree"], "upstream");
  requireValue(manifest.upstream.repository === "https://github.com/wierdbytes/autosk.git", "unexpected upstream repository");
  for (const value of [manifest.upstream.commit, manifest.upstream.tree, manifest.result_tree]) {
    requireValue(typeof value === "string" && OID.test(value), "invalid pinned Git identity");
  }
  closedRecord(manifest.toolchains, ["node", "bun", "go"], "toolchains");
  requireValue(manifest.toolchains.node === "24", "Node.js 24 is required");
  for (const key of ["bun", "go"]) {
    requireValue(typeof manifest.toolchains[key] === "string" && /^\d+\.\d+\.\d+$/.test(manifest.toolchains[key]), `${key}: exact patch version required`);
  }
  closedRecord(manifest.license, ["file", "sha256"], "license");
  requireValue(manifest.license.file === "LICENSE" && SHA256.test(manifest.license.sha256), "invalid license declaration");
  // The cap keeps a malformed or runaway manifest bounded; it was never meant to
  // cap the project at sixteen changes. It was chosen when the series had one
  // patch, and the series is append-only by policy, so it grows with every
  // delivery. Raised deliberately rather than worked around by squashing history.
  requireValue(Array.isArray(manifest.patches) && manifest.patches.length > 0 && manifest.patches.length <= 64, "expected bounded nonempty patch series");
  const directory = path.dirname(path.resolve(manifestPath));
  const names = new Set();
  const patches = manifest.patches.map((patch) => {
    closedRecord(patch, ["file", "sha256"], "patch");
    requireValue(typeof patch.file === "string" && /^patches\/\d{4}-[a-z0-9-]+\.patch$/.test(patch.file), "invalid patch path");
    requireValue(typeof patch.sha256 === "string" && SHA256.test(patch.sha256), "invalid patch hash");
    requireValue(!names.has(patch.file), "duplicate patch path");
    names.add(patch.file);
    const content = readRegularFile(path.join(directory, patch.file), 8_388_608);
    requireValue(digest(content) === patch.sha256, `patch hash mismatch: ${patch.file}`);
    return { ...patch, content };
  });
  const license = readRegularFile(path.join(directory, manifest.license.file), 65_536);
  requireValue(digest(license) === manifest.license.sha256, "license hash mismatch");
  return { manifest, manifestSha256: digest(bytes), patches };
}

function git(directory, args, input) {
  try {
    return execFileSync("git", args, {
      cwd: directory,
      input,
      encoding: "utf8",
      maxBuffer: 16_777_216,
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(`git ${args[0]} failed: ${error.stderr || error.message}`, { cause: error });
  }
}

export function prepareAutosk({ outputDir, sourceRepo, manifestPath = DEFAULT_MANIFEST }) {
  requireValue(typeof outputDir === "string" && outputDir.length > 0, "output directory is required");
  const { manifest, manifestSha256, patches } = loadAutoskManifest(manifestPath);
  const source = sourceRepo ?? manifest.upstream.repository;
  requireValue(typeof source === "string" && source.length > 0, "source repository is required");
  const output = path.resolve(outputDir);
  // A failed or existing checkout is never overwritten. Retry into a fresh path.
  mkdirSync(output);
  git(output, ["init", "--quiet"]);
  git(output, ["fetch", "--quiet", "--depth=1", "--no-tags", "--", source, manifest.upstream.commit]);
  requireValue(git(output, ["rev-parse", `${manifest.upstream.commit}^{commit}`]) === manifest.upstream.commit, "upstream commit mismatch");
  requireValue(git(output, ["rev-parse", `${manifest.upstream.commit}^{tree}`]) === manifest.upstream.tree, "upstream tree mismatch");
  git(output, ["checkout", "--quiet", "--detach", manifest.upstream.commit]);
  for (const patch of patches) {
    git(output, ["apply", "--check", "--index", "-"], patch.content);
    git(output, ["apply", "--index", "-"], patch.content);
  }
  requireValue(git(output, ["write-tree"]) === manifest.result_tree, "patched source tree mismatch");
  git(output, ["diff", "--quiet"]);
  git(output, ["diff", "--cached", "--check"]);
  requireValue(digest(readRegularFile(path.join(output, "LICENSE"), 65_536)) === manifest.license.sha256, "upstream license mismatch");
  return {
    schema_version: 1,
    manifest_sha256: manifestSha256,
    upstream_commit: manifest.upstream.commit,
    source_tree: manifest.result_tree,
    patches: manifest.patches,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireValue(process.argv.length >= 3 && process.argv.length <= 4, "usage: node scripts/prepare-autosk.mjs <new-output-directory> [source-repository]");
    const receipt = prepareAutosk({ outputDir: process.argv[2], sourceRepo: process.argv[3] });
    console.log(JSON.stringify(receipt, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
