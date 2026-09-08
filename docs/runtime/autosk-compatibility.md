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
| `0017-helper-refusal-classes.patch` | `0afeac0cc82901aa387c983d44ccd50346bbe749` |
| `0018-boundary-coverage.patch` | `ce701bc37238891593a4c8bee68d3b3ba41c94de` |
| `0019-trusted-write-races.patch` | `2e16ab3ccbe041f18c3b8fcae8791a7ff5c0d4b3` |
| `0020-longlived-helper.patch` | `95d024c686da179ab8d9a9c54b4ec4c76e12540c` |
| `0021-comments-through-adapter.patch` | `ae3133280f5093b40b3fff5ecf8553d6545de586` |
| `0022-session-meta-through-adapter.patch` | `033d7a28fbbeaac4c5ea7e38995c5dded35f9322` |
| `0023-grant-signature.patch` | `60b5ac3e55a7d110333417d09f1b6f740ac6c23d` |
| `0024-transcript-through-adapter.patch` | `600db19b48ac4c9cbb6d332bbea7637281cc1a93` |
| `0025-distribution-bytes.patch` | `42b705c7824f63a2d7dec85282c956d7aee61add` — the current `result_tree` |

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

### What the boundary adapter covers, and what it does not

Issue #13 forbids a safe adapter for one subsystem and plain `fs.writeFile/rm` for
other trusted state. Two readings of that were on the table for this codebase, and
they are not the same defect:

**Two writers on one file.** `task.json` is written by the helper under the project
lock during a bound creation, and by `TaskStore.writeTask` through plain `node:fs`
for every ordinary edit. This looks like a lost-update hazard and is not one today:
the creation index withholds a task from the ordinary path for exactly the window
in which the locked path may write it. Two independent attempts to construct the
race — walking `pending`, `active` and `deleted` reservations, the recovery branch,
cross-process writers, and the gap between the helper's read and its write — found
none. The exclusion is load-bearing and narrow: it protects the creation window,
not the general property, and nothing enforces that a future writer respects it.

**One writer, but not through the adapter.** This is the real gap. `comments.jsonl`,
the session meta and transcript, and the project registry each have a single writer,
and that writer was plain `node:fs`. They get none of the adapter's guarantees: no
`O_NOFOLLOW` on each traversed component, no owner check, no mode check, no device
check. (Compare-and-swap is *not* one of the things they miss — the helper offers it
on one operation only, `write_runtime_index`; `write_task` and
`write_creation_index` have none either.) Closing this needs new operations, not a
change of call site.

`comments.jsonl` is now through, in patch `0021`: `read_comments` and
`write_comments` bring the eleven-op total, and every comment byte the daemon reads
or writes crosses the adapter. What deliberately did **not** move is the cheap
`stat` that `listTaskViews` uses to decide whether anything changed — that path is
O(N) per listing and documented as such, and routing it measured 7x slower over 200
tasks (8.8 ms of stats against 61 ms of round-trips). The split is safe because the
stat is only a cache key: an unchanged signature short-circuits to bytes that were
themselves read through the adapter, and a changed one asks the adapter, which
refuses anything the daemon should not consume. A symlinked `comments.jsonl` is the
case that proves it — the stat happily follows the link, the adapter does not, and
the daemon gets a `not_regular` refusal instead of comments from outside the project.

Routing a read through the adapter turns a tolerated corruption into a refusal, and
that had to be placed rather than inherited. The store's standing rule is that one
unreadable file must not brick `open()` or `listTaskViews`; before this slice a
symlinked `comments.jsonl` was quietly *followed* and its target served, and the
first version of this slice traded that for taking `task.list` down for the whole
project over one planted link. Neither is right. The view path now reports a refused
comment file as a count of zero and warns once per reason, while a caller who asked
for that task's comments by name still gets the refusal — tolerating it on the
listing is not the same as hiding it from the caller who wanted it.

One more thing had to move with the write, and it is easy to miss: **permissions**.
The daemon's own writer creates an ordinary project file with the mode the
operator's umask allows; the helper sets modes explicitly, on purpose, because
several of its files must be private no matter what the umask says. Routing
comments through it therefore widened `comments.jsonl` from `0600` to `0644` on a
machine with `umask 077` — silently, while `task.json` beside it stayed `0600`.
The helper now applies the process umask (read in `init`, before any goroutine of
ours exists) to the *ordinary* project files, `task.json` and `comments.jsonl`,
and to nothing else: the `0600` of the creation index and the runtime store is a
requirement, not a default, and must hold whatever the umask is.

The read limit is new to this path too — the daemon used to read comments with
plain `readFile`, which has none — so `write_comments` refuses a payload the
helper would then refuse to read back. Publishing a file that can never be read
again would be bad on its own; with the view path now tolerating refusals it
would also show as an empty comment list, which is the worst of both.

The session **meta** followed in patch `0022`, with `read_session_meta`,
`write_session_meta` and `list_session_ids` — fourteen ops. What routing the write
buys beyond replacing a file is worth naming, because a plain atomic write already
replaces a symlinked file rather than following it: the adapter opens every
*component* with `O_NOFOLLOW`, so a swapped `sessions/` directory is refused
instead of sending the meta outside the project while reporting success.

`scan()` deliberately stays on plain `fs`, and that is a decision rather than an
omission. It runs on `open()`, so routing it would make the helper a precondition
of OPENING a project and would take the project lock for a project that only ever
gets read — exactly what ADR-028 declined ("A project that never writes trusted
state should not hold a lock"). Changing that is a change to ADR-028, not a change
of call site, so it is recorded as the remaining half.

The session **transcript** followed in patch `0024`, with
`read_session_transcript`, `write_session_transcript` and
`append_session_transcript` — seventeen ops. It closes #13 criterion 4 ("failures
leave no partial trusted state") at the place that criterion was actually open:
against a symlinked `sessions/` directory, `create` used to write the transcript
header into the target and only then have the meta refused. Two slices ago BOTH
files landed there and `create` **succeeded**; after `0022` exactly one escaped;
now the transcript write is the one that refuses first and nothing is left behind.
The test that counted the escaped file now asserts the target is empty.

The transcript is read in bounded windows rather than in one call, and that is the
design rather than an implementation detail. A transcript is appended for as long
as its session runs, so a whole-file op would need a size limit — and a limit on
an append-only file is a ceiling a long session eventually hits, after which its
own history stops being readable. So the append carries no limit, the read is
chunked, and `readTranscript` joins the windows so its callers see the same whole
file they always did.

Chunking has one consequence that is not obvious and that a test now pins. The
wire is JSON, and `encoding/json` does not carry invalid UTF-8: it substitutes
U+FFFD. A window ends wherever the byte count runs out, so the ordinary case is a
character cut in half — which would arrive at the daemon silently corrupted. The
helper therefore stops each window on a character boundary and refuses anything
else invalid, including an offset that starts inside a character. The same rule
was missing on the whole-file reads that already crossed this wire, so a stored
document with a bad byte was reaching the daemon with that byte replaced; those
reads refuse now too, with the existing `not_utf8` class.

The new ops make this a different contract, so the protocol revision is `3`. It is
compared exactly on the readiness line, and the daemon's constant is the single
place the number is written: the tests read it out of the source rather than
repeating it, because a fake helper announcing a stale revision fails at readiness
for a reason that has nothing to do with what those tests are about.

The project registry remains outside the adapter by ADR-028 — it lives in `$HOME`,
not in the project — and `scan()` remains on plain `fs` for the reason above.

## The bytes a project keeps

Patch `0025` adds a fourth area to the store: `runtime/v1/dist/`, holding the
exact files of an extension distribution keyed by the digest of each file's own
bytes. It is separate from the runtime blobs beside it for two reasons that are
properties of the data rather than of the code. A distribution contains
arbitrary files — images, compiled artefacts, `.wasm` — so these bytes are not
required to be text, and the runtime blobs are. And a source file is routinely
larger than the runtime store's 8 MiB record, so the limit is its own.

Because they are not text, they cross the wire base64-encoded in a distinct
`data_b64` field. That is not decoration: every other payload on this wire is a
document the daemon itself wrote, and a JSON string cannot hold anything else —
`encoding/json` substitutes U+FFFD for bytes that are not valid UTF-8, which is
the corruption patch `0024` had to close for the transcript. Four new ops make
the protocol revision `4`.

The name of a blob IS its digest, so a blob that does not hash to its own name is
refused on read as well as on write. That is what makes the held bytes usable as
evidence: a distribution can be put back together and shown to be the one a task
was admitted under, rather than merely described.

**Why a record was not enough.** The index already remembered what a digest
*meant* — the canonical listing it was taken over. That does not let an Epic keep
running. One globally installed extension has exactly one copy on disk, so
updating it takes the old code away from every project at once, and a project
pinned to the old digest is then pinned to something nobody has. The record now
says plainly whether the project holds the files, and an absent flag means NOT
held rather than unknown.

Holding is all-or-nothing as a claim. A distribution missing one file is not that
distribution, so a failure records `bytes_held: false` with the reason instead of
a record that says held and is not — and a later open tries again, because the
blobs are content-addressed and re-holding is idempotent.

What is dropped is decided by reachability, not by counting. A blob is kept when
some remaining record's listing names it, which is the same rule the reference
set already uses for tasks and for the same reason: a stored count would be a
second structure obliged to agree with the listings, and two structures obliged
to agree eventually disagree. A listing this build cannot read keeps everything —
"I cannot tell what this distribution contains" is not permission to delete its
files.

Two members of that list need naming separately, because calling them
single-writer would be wrong:

- `~/.autosk/settings.json` has **two** writers — first-run bootstrap and the
  extension add/remove path — and they were not serialised against each other.
  Bootstrap decided to write from an `existsSync` taken *before* a network
  `npm install`, then wrote unconditionally, so an `ext add` landing in that
  window was replaced by the default list and the operator's extension vanished.
  **Fixed**: the decision and the write are one exclusive create, and a file that
  appeared during the install is left as written.
- The RPC token was written with a truncating `openSync(path, "w")`, so two
  daemons starting at once each minted and each clobbered — every loser left
  holding a secret the file no longer contained — and a reader in between could
  observe it empty, which `ensureToken` itself reads as "absent". **Fixed**, and
  the first fix was not enough to say so: an exclusive `open(…, "wx")` creates a
  0-byte file and the write is a separate syscall, so the same clobber survived
  through that gap, seven times rarer. The token is now published with `link`,
  which is atomic — the name appears already pointing at a file holding the token
  — and an existing but empty file is **refused** rather than replaced, because a
  read-back after a lossy replace can always be overtaken. Measured over 300
  rounds × 24 concurrent starters: the previous version still produced
  mismatches, this one produces none.

Neither statement is a plan to leave any of this alone; they are the honest
starting point for the slices that close it.

### How long the helper lives, and what happens when it dies

Until patch `0020` the helper was a process per call: `withCreationLock` spawned
`autosk-store-lock`, took the project lock, ran one callback and shut it down.
Measured over 20 calls that is 8.9 ms each, nearly all of it spawn and lock
acquisition. ADR-028 replaces it with one long-lived helper per **open** project,
holding the project lock for as long as the daemon holds the project open, and
`withCreationLock` becomes a use of that connection rather than a process
lifetime. The name is unchanged because the guarantee is unchanged: the callback
still runs while this process holds the project's cross-process lock, and no
other caller in this process interleaves with it.

The price is stated in ADR-028 and is real: a second daemon cannot open a project
the first one holds. Today that is not a new exclusion in practice — single
instance is already enforced at the socket — and nothing outside `daemon/core`
opens a project store: the Go CLI reaches the store only over RPC.

What a per-call process gave away for free was recovery. A connection that
outlives the call also carries its damage forward, so three failure modes needed
explicit answers rather than an implicit fresh start:

| The connection | What happens | Why |
| --- | --- | --- |
| answered with a **refusal** | kept | A refusal is a well-formed answer; the stream is still in step, and retiring on it would pay a spawn and a lock handoff for every "no". |
| **lost sync** (an unmatched or unparseable answer) | retired, and no further request is written to it — including from inside the same callback | Once answers cannot be matched to requests, a write issued over that stream lands somewhere we cannot verify. Rejecting it is the only safe outcome; ADR-028 requires that a trusted write be refused, never routed around the adapter. |
| **died** between calls | replaced before the next call, not after it fails | The caller did nothing wrong; a process the OS took away should cost a reconnect, not a failed operation. |

The daemon releases the connection when the store closes (`Store.close` →
`releaseCreationLock`), which is what returns the project lock. A helper that
ignores stdin close is killed and reaped there, and the failure is reported
rather than swallowed.

Release waits for work already queued. An operation that is running must not
have its helper taken away mid-write, and one still waiting its turn has not
opened a connection yet — closing before it does would leave the helper it goes
on to open holding the project lock with nothing pointing at it. Neither hazard
existed while a call owned its own process; both are created by sharing one.

### The grant a caller cannot write

`ctx.scopedCreation(grant)` validated every field of the grant it was handed —
and every one of those fields is something the caller knows about its own
session: the project, the parent task, the session id, the workflow, the step,
the visit, the operation. A hand-written grant with correct values passed every
check there was. What the daemon could not tell was *who produced it*, which is
the question the capability turns on.

Since patch `0023` the host signs, and `mintScopedCreation` verifies before it
looks at any field. Ed25519, one keypair per daemon run, private half in daemon
memory only — never written to the project, never in an environment variable,
never passed to a child. A model process that could read the key could mint
grants, so it does not cross that boundary; the same reason the mutation tools
are absent rather than forbidden.

The signature covers the binding **and every slot in full**, including titles and
blockers. The slot list is what a grant permits, so an appended slot would create
a child the host never authorised while presenting a signature that verifies over
the binding; and a retitled child is a different child to the human reading the
queue. Verification runs over what the daemon *parsed*, not over the bytes it was
handed, so a grant cannot be signed in one shape and presented in another.

What is still missing is named rather than implied: nothing calls
`GrantSigner.sign` yet, because the extension entry point that would ask for a
grant does not exist. The capability is unforgeable and currently unreachable —
which is the honest state, and not the same as a signature that exists and is
skipped.

### Refusal classes

Every refusal used to reach the daemon as prose, and the helper's own Go tests told
them apart by matching substrings — which makes a reworded message a silent
behaviour change. (The TypeScript side never matched on message text; the claim
that it did was wrong and is corrected here.) The helper now names the class of a
refusal it can classify:

| Code | Meaning | Reaches a `HelperRefusal`? |
| --- | --- | --- |
| `not_regular` | not a single-linked regular file — directory, FIFO, socket, device, extra hard links, **or a symlink at the leaf** | yes |
| `not_dir` | a component that must be a directory is not one (usually `ENOTDIR`, since every open is `O_DIRECTORY`) | yes |
| `ownership` | the file is not private to the current user (uid or mode) | yes |
| `cross_device` | the path leaves the device the project root lives on | yes |
| `path_changed` | a directory or file the lock is anchored to was replaced while the lock was held — the directory-swap case | yes |
| `digest_mismatch` | content does not hash to the digest it is filed under, on write **or** on read of a corrupted store | yes |
| `cas_mismatch` | the expected-existing identity did not hold | yes |
| `too_large` | the payload exceeds the helper's limit | on read; on write the daemon pre-checks the identical limit, so it does not reach the wire today |
| `not_utf8` | the payload is not valid UTF-8 | on read; on write, same pre-check |
| `timeout` | the project lock was not acquired in time | **no** — `Acquire` fails before the readiness line, so this is a spawn failure, never a response |

A symlink at the leaf was the last security-relevant refusal still travelling as
prose. `O_NOFOLLOW` reports it as `ELOOP`, which `Code` did not recognise, so
"symlink leaf" — named in #13's own adversarial list — arrived unclassified: not
"fine" and not "some other class", but nothing a caller could branch on. It is
`not_regular` now, which is what it is: a symlink is not a single-linked regular
file. Patch `0021`.

The last column matters: a class that cannot reach a caller is a dead branch, and
advertising one is the same false confidence this table exists to remove.

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
