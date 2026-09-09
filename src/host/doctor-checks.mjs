/** The checks themselves: read-only probes of the things `autosk-flow` needs.
 *
 * Discovering a broken capability through a runtime failure is expensive and
 * opaque — the operator learns one broken thing at a time, in the order the
 * workflow happened to touch them. These run all of them at once.
 *
 * Every probe is injected, so the same registry runs against the real host and
 * against a fixture. Nothing here writes to the project: doctor makes no change
 * to what it is diagnosing.
 */
import { createHash } from 'node:crypto';

import { demand } from '../runtime/contracts.mjs';

/** How long a result stays meaningful. A daemon can be replaced in a minute; a
 * manifest on disk cannot change without the tree changing. */
export const TTL_MS = Object.freeze({
  fast: 5 * 60 * 1000,
  slow: 60 * 60 * 1000,
});

const provenance = (tool, version, nowMs, ttl) => ({
  tool,
  version,
  checked_at: new Date(nowMs).toISOString(),
  expires_at: new Date(nowMs + ttl).toISOString(),
});

/** Turns a thrown probe error into evidence rather than losing the run.
 *
 * A probe that throws has told us something — we could not look — and that is
 * `unverifiable` or `fail` depending on whether looking was possible at all,
 * never a silent absence.
 */
async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: error?.code ?? error?.message ?? 'unknown_error' };
  }
}

/**
 * The check registry.
 *
 * `env` supplies: `readFile(path)`, `stat(path)`, `run(cmd, args)` returning
 * `{ code, stdout }`, `which(cmd)`, `nowMs()`, `home`, `root`, `toolVersion`.
 */
export function checkRegistry(env) {
  const tool = 'autosk-flow-doctor';
  const version = env.toolVersion;
  const fast = () => provenance(tool, version, env.nowMs(), TTL_MS.fast);
  const slow = () => provenance(tool, version, env.nowMs(), TTL_MS.slow);

  return [
    {
      id: 'project_identity.git_worktree',
      category: 'project_identity',
      async run() {
        const head = await attempt(() => env.run('git', ['rev-parse', 'HEAD']));
        if (!head.ok || head.value.code !== 0) {
          return {
            status: 'fail',
            evidence: { error: String(head.ok ? head.value.code : head.error) },
            remediation: 'Run doctor inside the project git worktree, or initialise one with `git init`.',
            provenance: fast(),
          };
        }
        const status = await attempt(() => env.run('git', ['status', '--porcelain']));
        const dirty = status.ok && status.value.stdout.trim().length > 0;
        return {
          // A dirty tree is not broken; it is a fact the operator should see
          // before a run that pins a tree identity.
          status: dirty ? 'warn' : 'pass',
          evidence: { head: head.value.stdout.trim(), dirty },
          remediation: dirty ? 'Commit or stash local changes before a run that pins a tree identity.' : undefined,
          provenance: fast(),
        };
      },
    },
    {
      id: 'project_identity.compat_manifest',
      category: 'project_identity',
      async run() {
        const read = await attempt(() => env.readFile('compat/autosk/manifest.v1.json'));
        if (!read.ok) {
          return {
            status: 'fail',
            evidence: { error: String(read.error) },
            remediation: 'The pinned upstream manifest is missing; restore compat/autosk/manifest.v1.json.',
            provenance: slow(),
          };
        }
        const parsed = await attempt(async () => JSON.parse(read.value));
        if (!parsed.ok) {
          return {
            status: 'fail',
            evidence: { error: String(parsed.error) },
            remediation: 'The pinned upstream manifest does not parse; restore it from the last good commit.',
            provenance: slow(),
          };
        }
        const manifest = parsed.value;
        return {
          status: 'pass',
          evidence: {
            upstream: String(manifest.upstream?.commit ?? ''),
            patches: Array.isArray(manifest.patches) ? manifest.patches.length : 0,
            result_tree: String(manifest.result_tree ?? ''),
          },
          provenance: slow(),
        };
      },
    },
    {
      id: 'daemon.binary_present',
      category: 'daemon',
      async run() {
        const path = env.daemonBinary;
        const found = path ? await attempt(() => env.stat(path)) : { ok: false, error: 'not_configured' };
        if (!found.ok) {
          return {
            status: 'fail',
            evidence: { configured: Boolean(path), error: String(found.error) },
            remediation: 'Build the pinned daemon with scripts/prepare-autosk.mjs and set AUTOSKD_BIN to it.',
            provenance: fast(),
          };
        }
        return { status: 'pass', evidence: { path: String(path) }, provenance: fast() };
      },
    },
    {
      id: 'daemon.store_lock_helper',
      category: 'daemon',
      async run() {
        const path = env.helperBinary;
        const bytes = path ? await attempt(() => env.readFileBytes(path)) : { ok: false, error: 'not_configured' };
        if (!bytes.ok) {
          return {
            status: 'fail',
            evidence: { configured: Boolean(path), error: String(bytes.error) },
            remediation: 'Build the store-lock helper and set AUTOSK_STORE_LOCK_BIN to it.',
            provenance: fast(),
          };
        }
        // The helper's digest is half of the runtime identity, so the report
        // states it rather than that the file exists.
        return {
          status: 'pass',
          evidence: {
            path: String(path),
            sha256: createHash('sha256').update(bytes.value).digest('hex'),
          },
          provenance: fast(),
        };
      },
    },
    {
      id: 'daemon.reachable',
      category: 'daemon',
      async run() {
        // Establishing this means starting or contacting a daemon, which is a
        // change to the machine's state. A check that cannot be run read-only
        // has not passed.
        return {
          status: 'unverifiable',
          evidence: { probe: 'none' },
          unverifiable_reason:
            'Reaching the daemon requires starting or contacting it, which doctor does not do; a workflow that requires it starts it itself.',
          provenance: fast(),
        };
      },
    },
    {
      id: 'governance.contracts_present',
      category: 'governance',
      async run() {
        const registry = await attempt(async () =>
          JSON.parse(await env.readFile('resources/artifact-registry/artifact-registry.v1.json')));
        if (!registry.ok) {
          return {
            status: 'fail',
            evidence: { error: String(registry.error) },
            remediation: 'Restore resources/artifact-registry/artifact-registry.v1.json.',
            provenance: slow(),
          };
        }
        const contractClass = registry.value.classes.find((entry) => entry.class === 'contract_document');
        const paths = contractClass?.paths ?? [];
        const missing = [];
        for (const path of paths) {
          const found = await attempt(() => env.stat(path));
          if (!found.ok) missing.push(path);
        }
        return {
          status: missing.length === 0 ? 'pass' : 'fail',
          evidence: { declared: paths.length, missing: missing.length, first_missing: missing[0] ?? '' },
          remediation: missing.length === 0
            ? undefined
            : 'A contract listed in the artifact registry is absent; restore it or remove its registry entry.',
          provenance: slow(),
        };
      },
    },
    {
      id: 'providers.panel_routes_declared',
      category: 'providers',
      async run() {
        const candidate = await attempt(async () =>
          JSON.parse(await env.readFile('resources/design-candidate/design-candidate.v1.json')));
        if (!candidate.ok) {
          return {
            status: 'fail',
            evidence: { error: String(candidate.error) },
            remediation: 'Restore resources/design-candidate/design-candidate.v1.json.',
            provenance: slow(),
          };
        }
        const panel = candidate.value.required_panel ?? [];
        return {
          status: panel.length === 4 ? 'pass' : 'fail',
          evidence: { seats: panel.length, routes: panel.map((seat) => seat.route).join(' ') },
          remediation: panel.length === 4 ? undefined : 'The required panel must declare four seats.',
          provenance: slow(),
        };
      },
    },
    {
      id: 'providers.routes_live',
      category: 'providers',
      async run() {
        // A route is available when a call on it succeeds. Anything short of
        // that is a claim about configuration, not about availability.
        return {
          status: 'unverifiable',
          evidence: { probe: 'none' },
          unverifiable_reason:
            'Provider availability can only be established by a real dispatch, which spends budget and is not read-only.',
          provenance: fast(),
        };
      },
    },
    {
      id: 'git_delivery.git_available',
      category: 'git_delivery',
      async run() {
        const result = await attempt(() => env.run('git', ['--version']));
        if (!result.ok || result.value.code !== 0) {
          return {
            status: 'fail',
            evidence: { error: String(result.ok ? result.value.code : result.error) },
            remediation: 'Install git; every delivery path in this flow is a Git operation.',
            provenance: slow(),
          };
        }
        return { status: 'pass', evidence: { version: result.value.stdout.trim() }, provenance: slow() };
      },
    },
    {
      id: 'git_delivery.origin_configured',
      category: 'git_delivery',
      async run() {
        const result = await attempt(() => env.run('git', ['remote']));
        const remotes = result.ok ? result.value.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : [];
        return {
          // A missing remote does not break a local run, and it does break
          // delivery, so it is a warning rather than a failure.
          status: remotes.includes('origin') ? 'pass' : 'warn',
          evidence: { remotes: remotes.join(' ') },
          remediation: remotes.includes('origin') ? undefined : 'Add an `origin` remote before a delivery run.',
          provenance: slow(),
        };
      },
    },
    {
      id: 'security.no_traycer',
      category: 'security',
      async run() {
        // What must be absent is a DEPENDENCY, not an installation. Traycer
        // sitting in the operator's home says nothing about this flow; failing
        // on it would block a healthy project and teach the operator to ignore
        // the status. So this checks the inputs this run would actually consume:
        // environment variables it reads, and the binary paths it was given.
        const envKeys = Object.keys(env.processEnv ?? {}).filter((key) => /traycer/iu.test(key));
        const configured = [env.daemonBinary, env.helperBinary]
          .filter((value) => typeof value === 'string' && /traycer/iu.test(value));
        const installed = await attempt(() => env.stat(env.join(env.home, '.traycer')));
        const depends = envKeys.length > 0 || configured.length > 0;
        return {
          status: depends ? 'fail' : 'pass',
          evidence: {
            env_keys: envKeys.join(' '),
            configured_paths: configured.length,
            // Reported because it explains a surprising pass, and because the
            // clean-room run in #36 needs a HOME where this is false.
            installed_in_home: installed.ok,
          },
          remediation: depends
            ? 'This run consumes Traycer configuration; remove it — the autonomous flow must not depend on a Traycer installation.'
            : undefined,
          provenance: slow(),
        };
      },
    },
    {
      id: 'security.signer_boundary',
      category: 'security',
      async run() {
        // The flow asserts that signer and secure state live behind a boundary
        // the model cannot reach. An assertion nobody evaluates is the thing
        // this whole doctor exists to remove, so this asks the two questions a
        // read-only probe can answer honestly.
        //
        // It does NOT claim to prove isolation. A pass means the declared
        // endpoint was not reachable from here and the daemon reports a
        // distinct signer identity; it does not mean no path exists. Saying
        // more than that would be the overclaim the boundary is meant to
        // prevent.
        const endpoint = env.signerEndpoint;
        if (!endpoint) {
          return {
            // Not a pass: a boundary nobody declared is a boundary nobody can
            // check, and a model workflow may not start on one.
            status: 'unverifiable',
            unverifiable_reason: 'no signer endpoint is declared, so there is nothing to probe',
            evidence: { declared: false },
            remediation: 'Declare the signer endpoint so the boundary can be checked before a model workflow starts.',
            provenance: fast(),
          };
        }
        const reachable = await attempt(() => env.stat(endpoint));
        const identity = await attempt(() => env.signerIdentity());
        const distinct = identity.ok && identity.value?.same_process === false;
        return {
          status: !reachable.ok && distinct ? 'pass' : reachable.ok ? 'fail' : 'unverifiable',
          ...(!reachable.ok && !distinct
            ? { unverifiable_reason: 'the daemon reported no signer identity, so the boundary could not be confirmed' }
            : {}),
          evidence: {
            declared: true,
            reachable_from_here: reachable.ok,
            signer_identity_distinct: distinct,
          },
          remediation: reachable.ok
            ? 'The signer endpoint is reachable from the process a model runs in; move it behind a separate OS boundary.'
            : distinct
              ? undefined
              : 'The daemon did not report a signer identity distinct from this process.',
          provenance: fast(),
        };
      },
    },
    {
      id: 'scheduler.node_version',
      category: 'scheduler',
      async run() {
        const required = env.requiredNodeMajor;
        const actual = Number.parseInt(String(env.nodeVersion).replace(/^v/u, ''), 10);
        return {
          status: Number.isFinite(actual) && actual >= required ? 'pass' : 'fail',
          evidence: { required: `>=${required}`, actual: String(env.nodeVersion) },
          remediation: Number.isFinite(actual) && actual >= required
            ? undefined
            : `Install Node ${required} or newer; the runtime uses APIs older versions do not have.`,
          provenance: slow(),
        };
      },
    },
  ];
}

/** Runs the registry. A probe that throws becomes a failing check, never a gap. */
export async function runChecks(env, registry = checkRegistry(env)) {
  const results = [];
  for (const check of registry) {
    const outcome = await attempt(() => check.run());
    if (outcome.ok) {
      results.push({ id: check.id, category: check.category, ...outcome.value });
      continue;
    }
    results.push({
      id: check.id,
      category: check.category,
      status: 'fail',
      evidence: { error: String(outcome.error) },
      remediation: 'The check itself failed to run; report this with the error above.',
      provenance: provenance('autosk-flow-doctor', env.toolVersion, env.nowMs(), TTL_MS.fast),
    });
  }
  // Every registered check produces a result, including one whose probe threw:
  // the loop pushes exactly once per entry. Asserting it here could not fail,
  // so the property is a test rather than a guard that reads like one.
  return results;
}
