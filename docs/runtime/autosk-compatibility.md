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
apply in the listed order, each producing the tree beside it:

| Patch | Tree after it |
| --- | --- |
| `0001-atomic-task-creation.patch` | `f0916e4f430e1ae4e1e46d08fb6337077bb601a6` |
| `0002-runtime-snapshot-store.patch` | `3868362cace85f3f3cc51cdcb55d8b1115a4ddab` |
| `0003-runtime-identity-admission.patch` | `9362d712d8785ec8fd8558a539abfa0ebc3efaf2` |
| `0004-creation-stress-budget.patch` | `3b46806c4e11609272c066ec6f6be9f0ec023a59` |
| `0005-workflow-shape-identity.patch` | `1211acbe4ebcdf3516b266702123391f1fa8005a` |
| `0006-distribution-reference-accounting.patch` | `5c6657f1d11c0036972637fa3f0a41efd26cf9c0` |
| `0007-migration-planning.patch` | `89a47c9166c1ab45192a4d40179a4b57fd0ad620` |
| `0008-migration-apply.patch` | `74c05ee7f39a4d8669ad04cf3c26035129d7dda0` |
| `0009-migration-rollback.patch` | `c45f47eb3895072ffccf72c8456cd3a26f4ad281` |
| `0010-session-candidate-identity.patch` | `9242baec104cfa14df183edd55bcfda2fb50a29f` |
| `0011-concurrent-epics.patch` | `eda6fbcb67759d349777827e4ecb2b29c90e9937` |
| `0012-reload-and-missing-version.patch` | `5a16304e20883870375cefc7816b4875c581d354` |
| `0013-daemon-capability-report.patch` | `3eb7758f59b9793f5162b0a79a5803c33e2b4a8f` |
| `0014-creation-scenarios.patch` | `726fe5a99b01e719c95e35cb0b41510fbebf7183` |
| `0015-scoped-child-creation.patch` | `8ef375d6549fa9ea6e13c543a2ff4bb95f846fe7` |
| `0016-helper-protocol-handshake.patch` | `eabf757e05350ccbe12c29d0756b5c49ac175667` |
| `0017-helper-refusal-classes.patch` | `c838735cbbfd327f29889bea73b85ef0b9f137db` — the current `result_tree` |

A patch that has reached `main` is never edited in place; a new change is a new
numbered patch. The tip patch of an open PR is still being written and may be
regenerated, provided its SHA-256, the `result_tree`, this table and the pinned
expectation in `test/prepare-autosk.test.mjs` move together.
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

### Helper protocol handshake

The helper is the only writer of trusted state under the project lock, and its
readiness line is the single point at which it can be identified before it writes
anything. It now announces `protocol`, and the daemon compares it **exactly** —
a different revision is a different contract, and deciding which half of it still
holds is not something either side can do honestly. A helper that announces no
protocol, or another one, is refused before any operation runs.

This is fail-closed in both directions, and deliberately so: an installation whose
`autosk` and `autosk-store-lock` come from different builds stops rather than
guessing. The two constants are `protocolVersion` in
`cmd/autosk-store-lock/main.go` and `HELPER_PROTOCOL_VERSION` in
`daemon/core/src/store/creation.ts`; both are shipped by the same release.

### Refusal classes

Every refusal used to reach the daemon as prose, and the TypeScript side told them
apart by matching substrings — which turns a reworded message into a silent
behaviour change. The helper now names the class of a refusal it can classify:

| Code | Meaning |
| --- | --- |
| `timeout` | the project lock was not acquired in time |
| `not_regular` | not a single-linked regular file — a directory, FIFO, socket, device, or extra hard links |
| `not_dir` | a component that must be a directory is not one |
| `ownership` | the file is not private to the current user (uid or mode) |
| `cross_device` | the path leaves the device the project root lives on |
| `digest_mismatch` | content does not hash to the digest it is filed under |
| `cas_mismatch` | the expected-existing identity did not hold |
| `too_large` | the payload exceeds the helper's limit |
| `not_utf8` | the payload is not valid UTF-8 |

The set is deliberately not exhaustive, and the contract is exact: **a code, when
present, is authoritative; its absence means unclassified — never "fine" and never
"some other class"**. A catch-all code would let a caller branch on a class nobody
assigned, so unclassified refusals carry none. On the daemon side they surface as
`HelperRefusal`, which keeps the message for a human and the class for the code.

Adding the field changed the contract, so the protocol went to **2**. That is the
handshake above doing its job: bumping it immediately failed every fixture still
speaking revision 1, which is what a mismatched installation would have done
silently before.

This closes the **version** half of issue #13's criterion 5. The **digest** half —
the helper's bytes entering the extension runtime identity — is not done: the
binary is resolved at runtime from `AUTOSK_STORE_LOCK_BIN` or beside the
executable, outside any extension distribution root, so swapping it changes no
task pin. `daemon/core/src/extensions/identity.ts` already states that boundary;
closing it needs a decision about what a helper upgrade should do to open tasks,
which the distribution migration machinery does not yet cover.

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
are separate parts of issue #10, carried by the later patches in this series. Retaining files without a deletion
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
