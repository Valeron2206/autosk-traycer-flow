# Host-side child creation contracts — issue #11

Status: this is the first published-source prerequisite of #11/#38, not completion
of either issue. The compiler performs no filesystem, Git, provider, task-store,
network or workflow mutation. Runtime admission, persistence and child enrollment
are separate dependencies. A computed digest is never an authorization token.

## Interface and authority

`compileChildCreationIntent` validates a closed version-1 intent with canonical
project/Epic/anchor/lock identities, the actual parent task ID, operation and slot,
role/seat, candidate, target workflow/step, provider session intent and sandbox
snapshot intent. It returns a deterministic logical `creation_key` and semantic
`creation_binding_hash`.

The key depends on project, parent, operation and slot. Changing candidate, role,
seat, target step, session intent or a lock changes the binding but not that key.
The daemon must therefore report a conflict for reuse of an existing logical slot
under different controlling inputs, not silently create another child.

`compileTaskCreationGrant` accepts a bounded set of these intents and produces the
closed grant consumed by the scoped autoskd API. Slot and blocker order is
canonical. Every slot's final `creation_binding_hash` additionally binds the
canonical `blocked_by` set. Blockers are scheduling inputs, not display text.
The parent grant's `context_digest` includes these final slot identities.
Only title/description may change without changing the semantic binding.

`createGrantedChild` invokes only an already-issued SDK capability for a declared
slot. It checks the exact grant binding and returned markers. `created` must be
`new` and not enrolled; `existing_same_binding` may already have progressed, so
its mutable lifecycle fields are not mistaken for the original creation intent.
Unknown, malformed, absent or mismatched results fail with a machine error.
The result task is a closed own-data-property record containing exactly `id`,
`status`, `workflow`, `step`, `title`, `description`, `blocked_by`, `creation_key`
and `creation_binding_hash`. Inherited fields, accessors, symbols, hidden fields
and extra fields are rejected before reading task values. The result is copied
and recursively frozen before marker checks or return, so later SDK-side mutation
cannot change the validated result. This is a scoped result projection, not an
unrestricted upstream TaskView.
Title and description retain the grant's text bounds; `blocked_by` is a dense
array of at most 256 unique task IDs (not upstream TaskRef objects). Lifecycle
status is one of the upstream values `new`, `work`, `human`, `done`, `cancel`;
workflow and step are null or bounded logical identifiers. A fresh child's blocker
set must match the admitted grant. A same-binding retry may return a changed
blocker set and lifecycle, but their values must still satisfy this contract.
The supplied SDK object must originate from the trusted supervisor/Store; checking
its shape in this library does not prove that provenance.

## Encoding and limits

The runtime identity encoder is separate from the accepted Tickets canonicalizer.
It uses UTF-8 NFC strings, code-point-sorted object keys, safe integer numbers,
closed plain records, JSON encoding and one terminal LF. Hash preimages are
`<versioned-domain> + NUL + exact canonical bytes`. Undefined fields, accessors,
symbol properties, sparse arrays, cyclic data and non-JSON types are rejected.
Arrays must have the standard array prototype. Proxy records and arrays are
rejected before reflection or iteration so their traps cannot execute during
validation or canonicalization; custom inherited array methods are never used.

Limits include 64 slots, 256 unique blockers per slot, 8,192 title bytes, 65,536
description bytes and 1,048,576 serialized grant bytes. The immutable context
requires hashes of all controlling locks, including an explicit empty instruction
lock when no project instructions apply; it does not use `null` as an implicit
permission to omit a lock. Ephemeral lease expiry is checked by the daemon, not by
the pure compiler. The daemon additionally enforces its own resource limits.

## Recovery and compatibility

The public compiler contains no retry store or shadow task ledger. Autoskd owns
atomic same-key/same-binding reuse and same-key/different-binding conflict. The
caller must retry under a freshly admitted capability, not overwrite an existing
reservation or choose a new key to hide a conflict.

Older **unpublished local checkpoints** omitted scheduler blockers from the final
binding. That gap is corrected here using the versioned
`autosk-flow/scoped-child-binding/v1` domain. Old local grant outputs must be
recompiled and newly admitted; they are not migrated by rewriting existing
creation reservations. No released compiler ABI or accepted runtime state existed
before this first source publication.

## Verification

Run the focused tests:

```sh
node --test test/runtime-identities.test.mjs test/runtime-child-creation-intent.test.mjs test/runtime-scoped-child-creation.test.mjs
```

Run the repository regression suite and existing design checks:

```sh
npm test
npm run validate:migration
npm run validate:capabilities
npm run validate:planning-ref
npm run validate:tickets-manifest
git diff --check
```

The regression for changing `blocked_by` fails against the recovered local
compiler and passes after the binding correction. Tests exercise exact byte
limits, malformed records, accessors, independent namespace bindings, stale
capabilities, incorrect returned markers and mutation while awaiting a result.
SDK doubles in these focused tests are explicitly **output-validation doubles**;
they are not evidence of daemon durability, process isolation, or full fan-out.

## Remaining issue #11 acceptance work

| Requirement | This source change | Remaining evidence |
| --- | --- | --- |
| Immutable, project-scoped creation intent | Implemented and unit tested | Link to admitted production caller |
| Changed binding cannot masquerade as same intent | Compiler detects identity change | Actual Store conflict/SDK/RPC/CLI checks |
| Atomic concurrent task creation and recovery | Not provided by this compiler | Publish and qualify existing Store/native patches |
| Write-once daemon markers and legacy compatibility | Not provided by this compiler | Real Store tests and supported upstream pin |
| TaskView, SDK, CLI typed outcomes | Grant consumer validates SDK outcomes | Supervisor wiring and operator RPC/CLI |
| Preflight refuses absent capability | `requireDaemonCapabilities` decides admission from `meta.capabilities`, which the daemon derives from its live handler table | Wiring it into the extension entry point, which does not exist yet |
| Upstream distribution and platform qualification | Not included in this PR | CI on the fully wired source |

## The eleven mandatory scenarios

Issue #11 names eleven scenarios that must be tested. Where each is exercised, and
what is deliberately still open:

| Scenario | Where |
| --- | --- |
| 2/10/100 concurrent creates | `store.creation.test.ts` in-process at 2, 10 and 100; ten separate Bun processes; the Go suite races 96 real processes for the lock file |
| fault injection before and after persistence | before: a helper that dies inside the critical section before any write. After: a helper that performs the real writes and then dies immediately after the reservation is persisted, and again after the task file is written. Both leave the on-disk state a real crash leaves, and the retry converges on the reserved id |
| rename/description/metadata mutation after create | title and description; `metadata` merged onto a keyed task, with the markers asserted intact afterwards |
| delete/recreate | the task file removed under an active reservation retires the key rather than allocating another id |
| malformed/oversized key | empty key, and one byte over `MAX_CREATION_KEY_BYTES` |
| malformed hash | non-hex, hex of the wrong length (63 and 65), absent, and a hash with no key |
| cross-project same key | two roots, same key, independent ids |
| import/reconcile attempt | a forged marker with no reservation is refused and its bytes are not stripped |
| legacy task/database files | an unkeyed create writes marker-free bytes; separately, a task file in the pre-marker shape that this process did not write is read, listed, updated, and does not disturb the keyed task beside it |
| corrupted duplicate index state | corrupt index and duplicate markers both fail closed |
| daemon restart between create and caller retry | two separate processes: the first creates and exits, the second retries the same key and gets the same task. The reservation index on disk is the only thing that carries the identity across |

The last row was previously satisfied by a second `Store` object inside one
process. That is a different claim, and the test that made it has been renamed to
say what it does.

## Daemon capability preflight

`autosk-flow` cannot run its child fan-out on a daemon without write-once creation
identity: it would have to find a partially-created child by its editable title,
which is the duplicate/orphan hazard #11 exists to remove. So it asks first.

The daemon answers over `meta.capabilities`, and the answer is **derived from its
live handler table**: a capability is declared beside the exact methods that
implement it, and only those whose methods are all registered are reported. A
build that lost the implementation cannot keep claiming the guarantee — which is
the only reason asking is worth anything. A hand-written "yes" would pass on the
very daemon the preflight exists to reject.

`requireDaemonCapabilities` decides admission from that report. Every rejection
stops the flow rather than downgrading it, because an unreadable report says
nothing about the daemon and nothing is not evidence:

| Observation | Outcome |
| --- | --- |
| required capability absent | `daemon_capability_missing` |
| present at another revision | `daemon_capability_version_mismatch` |
| present but implemented by different methods | `daemon_capability_method_mismatch` |
| duplicated, oversized, naming no method, naming one twice, or two capabilities sharing a method | `daemon_capability_invalid` |
| not a closed record — wrong shape, extra or missing field, getter, proxy | `invalid_record` |
| a method name that is not canonical text | `invalid_identity` |

The last two come from the shared record and identity primitives rather than from
this module; they are listed because a caller sees them and they are refusals like
any other, not because this module raises them.

The revision is compared **exactly**, not as a minimum. It is incremented when the
guarantee changes in a way a client must notice, so accepting a later one would
accept the change the increment exists to warn about.

Only guarantees a method carries are declared. Runtime identity admission (#10) is
enforced inside `enroll`/`resume`/`dispatch`, whose methods exist in an unpatched
daemon too, so declaring it through this mechanism would be a claim the mechanism
cannot check. It is deliberately absent rather than reported optimistically.

The required set pins the **methods** too, not only the name and revision. Refusing
an empty method list because it could not have been derived, and then never looking
at the one non-empty list the daemon hands over, would let a renamed method through
the check written to notice it.

What remains: the required set and the daemon's declaration live in two
repositories. A test rebuilds `capabilities.ts` from the shipped patch series —
which the manifest pins by SHA-256 — and compares the declaration in that source.
Reading the patch text instead would not work: patches are append-only, so the
lines that introduced the declaration keep matching for ever, and a rename, bump,
reformat or deletion in a *later* patch would pass unnoticed. Calling the preflight
at extension startup is still pending — the extension entry point does not exist
yet.

Do not close #11, #38, #36 or any other roadmap issue from this prerequisite alone.
