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
import { UNPINNED_DAEMON_PRIMITIVES, requireDaemonCapabilities } from './daemon-preflight.mjs';

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

/**
 * The account model processes run under: the one the platform install record
 * names (`install.model_account` of platform-support.v1.json, ADR-102), held
 * equal to it by a test.
 */
export const MODEL_ACCOUNT = 'autosk-model';

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

/** What `stat` of a signer endpoint says when there is nothing at the path. */
const SIGNER_ENDPOINT_MISSING = new Set(['ENOENT', 'ENOTDIR']);

/** What it says when the path is refused to this process: observed separation. */
const SIGNER_ENDPOINT_DENIED = new Set(['EACCES', 'EPERM']);

/**
 * What to do about a daemon whose capability report the preflight refused.
 *
 * The primitives no report can satisfy are read from the preflight, so the
 * advice names exactly the ones still unpinned; once none is, it names none
 * rather than an empty list (review of 11c, L3).
 */
export function capabilityRemediation(unpinned) {
  const base = 'Run a daemon whose meta.capabilities carries every capability this flow requires, at the pinned revision and methods.';
  if (unpinned.length === 0) return base;
  const names = unpinned.map(({ name, adr }) => `${name} (${adr})`).join(' and ');
  return `${base} ${names} ${unpinned.length === 1 ? 'has' : 'have'} no pinned revision yet, so no daemon report satisfies this check until ${unpinned.length === 1 ? 'it is' : 'they are'} specified.`;
}

/**
 * The check registry.
 *
 * `env` supplies: `readFile(path)`, `stat(path)`, `run(cmd, args)` returning
 * `{ code, stdout }`, `which(cmd)`, `nowMs()`, `home`, `root`, `toolVersion`;
 * and, where the caller holds one, `daemonCapabilities()` returning the
 * daemon's `meta.capabilities` report — the doctor on a real host holds none.
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
      id: 'daemon.capabilities_pinned',
      category: 'daemon',
      async run() {
        // The daemon's `meta.capabilities` report against what this flow
        // requires, decided by `requireDaemonCapabilities` and by nothing here:
        // two readings of one requirement agree until they do not (ADR-097).
        // The report is the daemon's; doctor does not start or contact a
        // daemon, so it is handed one or has none, and none is not a pass.
        if (typeof env.daemonCapabilities !== 'function') {
          return {
            status: 'unverifiable',
            unverifiable_reason: "no report of the daemon's capabilities was supplied, so there is nothing to compare",
            evidence: { reported: false },
            provenance: fast(),
          };
        }
        const report = await attempt(() => env.daemonCapabilities());
        if (!report.ok) {
          return {
            status: 'unverifiable',
            unverifiable_reason: `reading the daemon's capabilities failed with ${report.error}, which says nothing about them`,
            evidence: { reported: false, probe_error: String(report.error) },
            provenance: fast(),
          };
        }
        try {
          requireDaemonCapabilities(report.value);
        } catch (error) {
          const details = error?.details ?? {};
          const listed = details.missing ?? details.mismatched;
          return {
            status: 'fail',
            evidence: {
              reported: true,
              refusal: String(error?.code ?? 'unknown_error'),
              ...(Array.isArray(listed) ? { [details.missing ? 'missing' : 'mismatched']: listed.join(', ') } : {}),
            },
            remediation: capabilityRemediation(UNPINNED_DAEMON_PRIMITIVES),
            provenance: fast(),
          };
        }
        // Unreachable while a required primitive is unpinned, because every
        // report is refused above; it is the answer once each is pinned.
        return { status: 'pass', evidence: { reported: true }, provenance: fast() };
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
        // endpoint was refused to this process and the daemon reports a
        // distinct signer identity; it does not mean no path exists, and the
        // probe runs in the doctor's process, not in the model's sandbox.
        // Saying more than that would be the overclaim the boundary is meant
        // to prevent.
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
        const probe = await attempt(() => env.stat(endpoint));
        const probeError = probe.ok ? '' : String(probe.error);
        // Only a refusal is an observation of separation. A path that is not
        // there separates nothing — a mistyped endpoint used to pass here — and
        // any other error says nothing either way (debt 10d, R6-12).
        const missing = SIGNER_ENDPOINT_MISSING.has(probeError);
        const denied = SIGNER_ENDPOINT_DENIED.has(probeError);
        const identity = await attempt(() => env.signerIdentity());
        const distinct = identity.ok && identity.value?.same_process === false;
        const evidence = {
          declared: true,
          reachable_from_here: probe.ok,
          probe_error: probeError,
          signer_identity_distinct: distinct,
        };
        if (probe.ok || missing) {
          return {
            status: 'fail',
            evidence,
            remediation: probe.ok
              ? 'The signer endpoint is reachable from the process a model runs in; move it behind a separate OS boundary.'
              : 'The declared signer endpoint does not exist; a missing endpoint is not a boundary. Declare the endpoint the signer actually serves.',
            provenance: fast(),
          };
        }
        if (!denied) {
          return {
            status: 'unverifiable',
            unverifiable_reason: `probing the declared endpoint failed with ${probeError}, which neither shows nor rules out a boundary`,
            evidence,
            provenance: fast(),
          };
        }
        return {
          status: distinct ? 'pass' : 'unverifiable',
          ...(distinct
            ? {}
            : { unverifiable_reason: 'the daemon reported no signer identity, so the boundary could not be confirmed' }),
          evidence,
          remediation: distinct ? undefined : 'The daemon did not report a signer identity distinct from this process.',
          provenance: fast(),
        };
      },
    },
    {
      id: 'security.model_account',
      category: 'security',
      async run() {
        // Model processes run under the model account the privileged install
        // creates, started through the mechanism it sets up — never a setuid
        // binary of this project — and that account writes no Git directory of
        // the project and reaches no signer, secure store or keychain
        // (platform-support.md §5b, ADR-102). Proving that means looking as
        // that account, and no probe that does exists in this repository: the
        // account, its launch and the probe are #13's. Until the probe exists
        // the check says it could not look, which blocks every workflow that
        // runs a model step, rather than passing on a boundary nobody checked.
        return {
          status: 'unverifiable',
          evidence: { probe: 'none', account: MODEL_ACCOUNT },
          unverifiable_reason:
            `no probe of the model account ${MODEL_ACCOUNT} exists yet: the privileged install that creates it and the mechanism model processes are started through, and the probe that proves them, are #13's`,
          provenance: fast(),
        };
      },
    },
    {
      id: 'security.ref_custody',
      category: 'security',
      async run() {
        // The ref-custody helper of platform-support.md §5a: a process of the
        // installing user with its own socket, intents and journal, and the
        // pins its bootstrap sets on the installing user's repository —
        // gc.packRefs=false, loose protected refs, reflog retention, the Git
        // directory closed to other accounts (ADR-095, ADR-102). The probe
        // that proves them, and parks `ref_custody_unavailable` at project
        // open when it cannot, is #13's with #5, and none exists here; this
        // check is where that probe's answer goes, so a helper or pins it
        // cannot prove are a `fail` carrying that park reason once it exists.
        // Until then no workflow that reaches a step asking the helper starts.
        return {
          status: 'unverifiable',
          evidence: { probe: 'none' },
          unverifiable_reason:
            "no probe of the ref-custody helper exists yet: the probe of its process, its socket and journal and the repository's pins, and the park of ref_custody_unavailable at project open when they are not proven, are #13's with #5",
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
