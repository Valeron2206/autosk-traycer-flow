#!/usr/bin/env node

/**
 * The governance bundle CLI (#37).
 *
 * `build` reads the manifest's members, checks everything that decides whether
 * these bytes may be a bundle, and prints the digest only when they may. A
 * digest printed beside a list of errors is the artefact this program keeps
 * finding: a number that reads like a result.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildBundle, writeCandidate } from '../src/host/bundle-builder.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const fs = { readFile: (file) => readFile(file), writeFile: (file, text) => writeFile(file, text) };

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifestPath = argument('manifest', 'resources/governance-bundle/bundle-manifest.v1.json');
  const root = argument('root', ROOT);
  const stage = argument('stage', 'baseline');
  const out = argument('out', null);

  const manifest = JSON.parse(await readFile(path.resolve(ROOT, manifestPath), 'utf8'));
  const built = await buildBundle(fs, { root, manifest, stage });

  for (const error of built.errors) console.error(`${error.reason}: ${error.detail}`);
  if (!built.ok) {
    console.error(`refused: ${built.errors.length} problems; no digest is printed for a bundle that did not build`);
    process.exitCode = 1;
  } else {
    console.log(`members=${built.members.length}`);
    console.log(`bundle_digest=${built.digest}`);
    if (out) {
      const written = await writeCandidate(fs, { path: path.resolve(ROOT, out), built, manifest });
      console.log(`candidate=${written.path} bytes=${written.bytes}`);
    }
  }
}
