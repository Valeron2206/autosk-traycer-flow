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
| Preflight refuses absent capability | Consumer fails when capability is missing | Production admission/doctor integration |
| Upstream distribution and platform qualification | Not included in this PR | CI on the fully wired source |

Do not close #11, #38, #36 or any other roadmap issue from this prerequisite alone.
