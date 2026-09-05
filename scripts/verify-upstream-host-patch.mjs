/** Read-only source verification for the local upstream patch and integration tests.
 * This is build/test tooling, not a runtime capability or an approval receipt. */
import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('../patches/autoskd/', import.meta.url));
const sum = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function verifyUpstreamHostPatch(root, { applied = false } = {}) {
  const lock = JSON.parse(readFileSync(resolve(directory, 'host-projections.lock.json'), 'utf8'));
  if (lock.schema_version !== 1 || lock.production_ready !== false || lock.patch_file !== 'host-projections.patch'
    || !Array.isArray(lock.files) || lock.files.length === 0) throw new Error('Invalid upstream patch inventory');
  if (sum(readFileSync(resolve(directory, lock.patch_file))) !== lock.patch_sha256) throw new Error('Upstream patch hash mismatch');
  const seen = new Set();
  for (const file of lock.files) {
    if (!/^daemon\/(?:core|sdk)\/src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ts$/u.test(file.path)
      || seen.has(file.path)) throw new Error('Invalid or duplicate upstream source path');
    seen.add(file.path);
    const expected = applied ? file.after_sha256 : file.before_sha256;
    const path = resolve(root, file.path);
    if (expected === null) {
      // lstat as well as existence is important: a dangling symlink is not absent.
      try { lstatSync(path); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      throw new Error(`Unexpected upstream file: ${file.path}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(expected) || !existsSync(path) || !lstatSync(path).isFile()
      || sum(readFileSync(path)) !== expected) throw new Error(`Upstream source hash mismatch: ${file.path}`);
  }
  return { schema_version: 1, mode: applied ? 'applied' : 'baseline', files_verified: seen.size,
    patch_sha256: lock.patch_sha256, production_ready: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || !['--baseline', '--applied'].includes(args[0])) {
    console.error('Usage: node scripts/verify-upstream-host-patch.mjs --baseline|--applied CHECKOUT'); process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(verifyUpstreamHostPatch(resolve(args[1]), { applied: args[0] === '--applied' }))); }
    catch (e) { console.error(e.message); process.exitCode = 1; }
  }
}
