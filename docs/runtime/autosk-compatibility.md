# Reproducible autosk compatibility source

Status: Store prerequisite for issue #11, with CLI/RPC compatibility tests. This
does not complete #11, the scoped SDK in #38, the runtime lock in #10, or release
acceptance. These development bundles do not contain the full autosk-flow extension.

## Owner-approved distribution method

On 2026-09-07 the owner authorized storing and distributing the necessary autosk
compatibility changes as a versioned patch series in `Valeron2206/autosk-traycer-flow`,
with pinned upstream commits, verified patch/source identities and CI-built
binaries. This authorization also covers later necessary patches using the same
method; it does not require another distribution-method approval for each patch.
Each change still goes through the normal repository PR, review and CI gates.
It does not authorize production deployment, purchases, force updates, or writes
to the foreign upstream repository.

`compat/autosk/manifest.v1.json` is the build input. It pins upstream commit
`5163f00dd25005480dc7f3e40a0c40d18248857a`, its tree, the ordered patch hashes,
the resulting tree, the original MIT license, and the build toolchains. Patches
apply in the listed order: `0001-atomic-task-creation.patch` produces tree
`f0916e4f430e1ae4e1e46d08fb6337077bb601a6`, `0002-runtime-snapshot-store.patch`
produces `3868362cace85f3f3cc51cdcb55d8b1115a4ddab`, and
`0003-runtime-identity-admission.patch` produces the current `result_tree`
`3a57dc7ed3aef6b741ce116a227bc049979a7456`.
Earlier patches are never edited in place; a new change is a new numbered patch.
The license is retained in the source and each development bundle.

## Prepare and build

Use Node.js 24, Git, Bun 1.4.0 and Go 1.25.0. The destination must not already
exist; its parent must exist. The preparer refuses an existing destination,
including a failed earlier attempt, so it never overwrites a checkout.

```sh
node scripts/prepare-autosk.mjs /tmp/autosk-source > /tmp/autosk-source-receipt.json
cd /tmp/autosk-source/daemon
bun install --frozen-lockfile
cd ..
make build build-store-lock
cd daemon
bun build --compile core/src/index.ts --outfile ../bin/autoskd
```

The optional second preparer argument is an existing source repository for an
offline build. It changes only where Git retrieves objects: the pinned commit,
base tree, patch hashes and resulting tree must still match. Patch bytes are
checked before creating the destination and applied from the verified in-memory
copy. A failed check returns a nonzero exit code and no successful source receipt.

The three executables must remain together in `bin`: `autosk`, `autoskd` and
`autosk-store-lock`. This is a compiled layout; Bun and Go are build dependencies.
The helper holds the project creation lock and performs file operations for
autoskd. It is not another daemon or scheduler.

## Verify the supplied layout

From this repository, after building the source above:

```sh
node scripts/verify-autosk-creation.mjs /tmp/autosk-source
node scripts/verify-autosk-crash.mjs /tmp/autosk-source
```

The first command exercises the real Go CLI and compiled daemon: an exact
creation receipt, ten same-key retries, a binding conflict, another project,
daemon restart and legacy creation. The second stops the actual native writer
before and after each reservation/task/activation write, then checks recovery,
the original reserved ID, exactly one task and process cleanup. It establishes
process-crash behavior, not durability after a physical power failure.

Both commands use temporary projects, a separate child-process home, a seeded
settings file, disabled first-run installation and an explicit loopback listener.
Their temporary paths and logs are diagnostic data, not runtime dependencies.

The compatibility workflow runs on Ubuntu x64 and macOS arm64, using
[GitHub's standard runner labels](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job).
It builds all three binaries, runs these scenarios, full upstream Go/Bun and Pi
tests, checks types and native races, then verifies the source tree again. The
archive contains the license, compatibility manifest and a build receipt with
source identity, CI commit/run, actual toolchain versions, validated test counts,
log hashes and hashes of the distributed files. The archive has a separate SHA-256 file. Binary identity is
recorded for each build; bit-identical builds across platforms are not claimed.

Only successful jobs upload a binary bundle. Logs are retained even when a job
fails. An uploaded development artifact is not a GitHub Release or final product
acceptance.

## Remaining boundaries

### Runtime snapshot storage prerequisite

The native writer also provides four internal operations for issue #10. They
share the existing project lock with task creation; no additional state owner or
scheduler is introduced. The daemon uses the same supervised stdio connection.

| Operation | Behavior |
| --- | --- |
| `read_runtime_blob` | Read a snapshot by its lowercase SHA-256 digest and verify its bytes. |
| `write_runtime_blob` | Install bytes under their digest; an identical retry succeeds, while different or corrupt existing bytes fail. |
| `read_runtime_index` | Read the current runtime index bytes, distinguishing an absent file from an empty file. |
| `write_runtime_index` | Replace the index only when `expected_digest` matches the existing bytes; `null` requires an absent index. |

Snapshots live at `.autosk/runtime/v1/blobs/<digest>.blob`; the index lives at
`.autosk/runtime/v1/index.json`. Names are fixed or hexadecimal, and each UTF-8 text
payload is limited to 8 MiB. The JSON transport permits up to 64 MiB per line to
cover escaping of every allowed payload. These operations use directory handles, reject symbolic
links and hard-linked files, refuse any snapshot or index that is not owned by the
current user or that is group- or world-accessible, and use the native flushed
temporary-write/rename path. They expose no arbitrary-path operation and no deletion operation. Old
snapshots therefore remain available when a new snapshot is installed.

This layer stores bytes and compares their identities. It does not validate a
workflow manifest, decide whether an installation is authorized, or pin a running
task. Loader provenance, engine preflight, session identity and approved migration
are separate remaining parts of issue #10. Retaining files without a deletion
operation is not yet a complete installer, upgrade or rollback workflow. The
complete filesystem threat model, including helper replacement, remains in #13.

The Store patch includes write-once markers, project-scoped uniqueness,
same-binding retry, conflict reporting, pending recovery, deletion tombstones,
closed model-tool projections and CLI/RPC types. It does not issue trusted
extension capabilities, enroll children, implement runtime-version admission or
complete filesystem isolation. The compiler in `creation-contracts.md` must still
be wired to the production scoped SDK and preflight before model fan-out runs.

Local qualification observed a pre-existing cold-start readiness timeout in the
upstream Go auto-spawn harness on macOS. The focused retry and subsequent full
suite passed; the timeout was retained as an unresolved upstream behavior, not
reported as a fix. CI does not turn timeouts or skipped tests into success.
GUI sidecar/cask delivery is outside this three-binary development bundle.
