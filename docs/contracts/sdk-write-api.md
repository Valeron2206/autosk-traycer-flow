# Typed SDK write API contract

<!-- sdk-write-api-contract:v1 -->

Status: issue #38 design contract. The upstream primitives, the migration of correctness-critical call sites and the fault-injection suite remain open; this pins the write surface, what a capability may reach, and the outcomes a caller must be able to tell apart.

## 1. Authority

Upstream `TasksAPI` is effectively read-only, so the project calls the autosk CLI from extension runners. That is acceptable in a prototype and wrong in a correctness-critical path: it adds a process, a shell and a parser between the intent and the daemon.

Each of those is a way to be wrong. String arguments get escaped incorrectly; the binary resolved from `PATH` is a different version than the one tested; human-oriented output changes shape and the parser keeps working until it does not; related writes cannot be made atomic; and — the one that matters most — a crash after the daemon committed but before the CLI answered leaves an outcome nobody can name. The closed JSON Schemas are `resources/sdk-write-api/capability-token.schema.json` and `resources/sdk-write-api/write-operation.schema.json`.

## 2. Boundaries

The signed creation grant is #11's and this contract does not re-specify it; the helper protocol and store adapter are #13's and #22's; the runtime lock and doctor are #10's and #34's. This contract owns the write surface, the capability, the idempotency and the error codes.

## 3. The primitives, and why they are typed

Create a task with its `creation_key` and `creation_binding_hash`; update extension-owned metadata against an expected revision; add or remove a blocker under an idempotency key; enroll, park, resume or cancel a child; append a typed host comment or event; perform an exact transition for a trusted deterministic step; read the task graph and its revisions; and group writes into a transaction where an invariant spans them.

**No generic JSON mutation is offered** (`sdk_generic_mutation`). An arbitrary-patch endpoint is a way to write fields nobody designed a validator for, and its existence makes every other guarantee here conditional on nobody using it. Extension-owned metadata is validated daemon-side against a versioned schema (`sdk_metadata_schema_invalid`).

## 4. Every write is revision-aware and idempotent

A metadata update carries the revision it expected; a mismatch is a typed conflict naming both revisions (`sdk_revision_conflict`), never a silent overwrite. Every write carries an operation and idempotency key, and a retry under the same key returns the same outcome and performs no second effect (`sdk_idempotency_violated`).

This is what the CLI could not give: a lost response is indistinguishable from a failure at the caller, so the only safe retry is one the daemon can recognise. **The ambiguity is removed at the protocol level rather than described in a runbook.**

A transaction either applies wholly or not at all (`sdk_transaction_partial`). A partial batch is worse than a failed one, because the caller's next decision is based on a state that matches neither branch.

## 5. Capabilities are scoped, and models do not hold them

A capability token names the project, the task, the operation and the exact field set it may write. It cannot reach another project or another task by construction (`sdk_scope_violation`, `sdk_cross_project`), and it expires (`sdk_capability_expired`) and can be revoked (`sdk_capability_revoked`).

**The write API is available to trusted installed extension code, never to model tools** (`sdk_model_capability`). This is the same boundary the mutation tools already respect: a model process that could mint writes could mint them for anything the token allows, so it does not hold one. Absent, not forbidden.

Every write records its provenance: which extension, which session, which operation.

## 6. Machine error codes, not prose

Outcomes a caller must tell apart get stable codes: `revision_conflict`, `idempotency_replay`, `scope_denied`, `capability_expired`, `capability_revoked`, `schema_invalid`, `transaction_aborted`, `not_found`, `precondition_failed`, `unavailable`.

A caller that has to match on message text is a caller that breaks when the message improves (`sdk_error_code_missing`). A conflict additionally carries the conflicting identity, because "conflict" without saying with what leaves the caller to guess or to retry blindly.

## 7. Migration, in this order

Identify the exact CLI uses in autosk-flow; add the SDK primitives upstream; prove semantic parity with dual-path tests; switch the correctness-critical code to the typed API; keep the CLI for operator and debug use **over the same API** (`sdk_cli_diverged`); and remove the shell and parsing assumptions from the runtime lock and the doctor.

The CLI staying is deliberate. It is a good operator surface and a bad correctness dependency, and keeping it over the same API means it cannot drift into a second semantics — which is the failure the migration exists to prevent, not the CLI itself.

## 8. Refusal classes

- `sdk_generic_mutation`;
- `sdk_metadata_schema_invalid`;
- `sdk_revision_conflict`;
- `sdk_idempotency_violated`;
- `sdk_transaction_partial`;
- `sdk_scope_violation`;
- `sdk_cross_project`;
- `sdk_capability_expired`;
- `sdk_capability_revoked`;
- `sdk_model_capability`;
- `sdk_error_code_missing`;
- `sdk_cli_diverged`.

## 9. What this contract decides, and what it defers

Decided: the primitive set and that no generic mutation exists; that every write is revision-aware, idempotent under an operation key and provenance-bearing; that a transaction is all-or-nothing; that a capability names project, task, operation and field set, expires, can be revoked and is never held by a model process; the stable error codes and that a conflict names the conflicting identity; and the migration order with the CLI kept over the same API.

Deferred and named: the upstream primitives themselves, the call-site migration, the dual-path parity tests and the fault-injection suite. This issue is P2; individual primitives rise to release-blocking if the CLI cannot provide the atomic guarantees a correctness-critical path has already accepted.
