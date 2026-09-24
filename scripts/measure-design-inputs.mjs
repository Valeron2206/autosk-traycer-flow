#!/usr/bin/env node

/**
 * Measures the design inputs by running the validators, not by parsing them.
 *
 * Every `validate:*` script in package.json is spawned under the fs read
 * instrument (scripts/lib/design-reads-instrument.mjs, inherited through
 * NODE_OPTIONS so instrumented child processes count too). Each must exit 0
 * and must record at least one read — every validator reads something, so an
 * empty record means the instrument did not take, and the measurement fails
 * rather than ship an empty set.
 *
 * The recorded paths are reduced to the measured set: repository-relative,
 * code dropped by extension (`.patch` included — see measured-inputs.mjs),
 * the candidate itself dropped, directories dropped (the files a reader
 * opened beneath them are recorded individually).
 *
 * The result is pinned in resources/design-candidate/measured-inputs.v1.json
 * — the readers that ran, the sorted inputs, and a digest over both. The
 * artifact is deterministic: sorted arrays, no absolute paths, no
 * timestamps. Because the reader list is part of it, adding a validator
 * makes the artifact stale. `--check` re-measures and exits 1 on any drift,
 * naming what was added and what was removed.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  collectRecordedPaths,
  diffArtifact,
  measuredDigest,
  MEASURED_PATH,
  reduceToInputs,
} from "./lib/measured-inputs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTRUMENT_URL = pathToFileURL(path.join(HERE, "lib", "design-reads-instrument.mjs")).href;

function validateScripts(root) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  return Object.entries(pkg.scripts ?? {})
    .filter(([name]) => name.startsWith("validate:"))
    .map(([name, command]) => {
      const match = /^node\s+(\S+\.mjs)(.*)$/u.exec(command.trim());
      if (!match) throw new Error(`${name}: "${command}" is not a plain node script run`);
      const args = match[2].trim();
      return { name, argv: [match[1], ...(args === "" ? [] : args.split(/\s+/u))] };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

export function measure(root, { spawn = spawnSync } = {}) {
  // Records carry the physical name of what was read — links and the
  // on-disk spelling folded. The root is canonicalized to the same physical
  // form (native realpath returns the case on disk, which plain realpathSync
  // does not) so both sides compare as physical names.
  const rootPath = realpathSync.native(root);
  const readers = validateScripts(root);
  const scratch = mkdtempSync(path.join(tmpdir(), "design-reads-"));
  const failures = [];
  const recorded = new Set();
  try {
    for (const { name, argv } of readers) {
      const logDir = path.join(scratch, name);
      mkdirSync(logDir);
      const run = spawn(process.execPath, argv, {
        cwd: rootPath,
        env: {
          ...process.env,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${INSTRUMENT_URL}`.trim(),
          DESIGN_READS_LOG: logDir,
        },
        encoding: "utf8",
      });
      if (run.status !== 0) {
        failures.push(`${name}: exited ${run.status}\n${run.stderr.trim()}`);
        continue;
      }
      const reads = collectRecordedPaths(logDir);
      if (reads.size === 0) {
        // Fail closed: a validator that recorded nothing did not run under
        // the instrument — silence must not pass for a measurement.
        failures.push(`${name}: recorded no reads — the instrument did not take`);
        continue;
      }
      for (const entry of reads) recorded.add(entry);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    throw new Error(`the measurement cannot be taken:\n${failures.join("\n")}`);
  }
  const inputs = reduceToInputs(recorded, rootPath);
  const body = { schema_version: 1, readers: readers.map(({ name }) => name), inputs };
  return { ...body, digest: measuredDigest(body) };
}

function main(argv) {
  const check = argv.includes("--check");
  const rootFlag = argv.indexOf("--root");
  const root = path.resolve(rootFlag === -1 ? path.resolve(HERE, "..") : argv[rootFlag + 1]);
  const artifactPath = path.join(root, MEASURED_PATH);

  if (check && !existsSync(artifactPath)) {
    console.error(`${MEASURED_PATH}: not on disk — run scripts/measure-design-inputs.mjs first`);
    return 1;
  }
  // Bootstrap: the candidate validator reads the artifact during its own
  // measured run, so the file must exist before the first measurement is
  // taken. An empty skeleton is honest — its inputs list claims nothing.
  if (!check && !existsSync(artifactPath)) {
    const skeleton = { schema_version: 1, readers: [], inputs: [] };
    writeFileSync(artifactPath, `${JSON.stringify({ ...skeleton, digest: measuredDigest(skeleton) }, null, 2)}\n`);
  }

  const measured = measure(root);
  const text = `${JSON.stringify(measured, null, 2)}\n`;

  if (!check) {
    writeFileSync(artifactPath, text);
    console.log(`${MEASURED_PATH}: ${measured.readers.length} readers, ${measured.inputs.length} inputs, digest ${measured.digest}`);
    return 0;
  }

  const recorded = JSON.parse(readFileSync(artifactPath, "utf8"));
  const problems = [];
  const { schema_version, readers, inputs, digest: recordedDigest } = recorded;
  if (recordedDigest !== measuredDigest({ schema_version, readers, inputs })) {
    problems.push(`recorded digest ${recordedDigest} does not recompute over its readers and inputs`);
  }
  const diff = diffArtifact(recorded, measured);
  for (const input of diff.inputsAdded) problems.push(`measured input not in the artifact: ${input}`);
  for (const input of diff.inputsRemoved) problems.push(`artifact input no longer measured: ${input}`);
  for (const reader of diff.readersAdded) problems.push(`reader not in the artifact: ${reader}`);
  for (const reader of diff.readersRemoved) problems.push(`artifact reader no longer run: ${reader}`);
  if (problems.length > 0) {
    console.error(`${MEASURED_PATH}: stale\n${problems.sort().join("\n")}`);
    return 1;
  }
  console.log(`${MEASURED_PATH}: up to date (${measured.inputs.length} inputs)`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
