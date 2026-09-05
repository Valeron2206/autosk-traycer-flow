#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const moduleRoot = resolve(root, 'native/hostfs');
const [command] = process.argv.slice(2);
if (!['test', 'vet'].includes(command)) { process.stderr.write('Usage: run-native-go.mjs test|vet\n'); process.exit(2); }
const vendored = existsSync(resolve(moduleRoot, 'vendor/modules.txt'));
const args = command === 'test' ? ['test', vendored ? '-mod=vendor' : '-mod=readonly', '-race', './...']
  : ['vet', vendored ? '-mod=vendor' : '-mod=readonly', './...'];
const env = { ...process.env, GOFLAGS: '', GOENV: 'off', GOTOOLCHAIN: 'local', GOWORK: 'off' };
if (vendored) { env.GOPROXY = 'off'; env.GOSUMDB = 'off'; }
const result = spawnSync('go', args, { cwd: moduleRoot, env, stdio: 'inherit' });
if (result.error) { process.stderr.write(`${result.error.message}\n`); process.exit(1); }
process.exit(result.status ?? 1);
