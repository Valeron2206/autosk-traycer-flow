# Scoped creation grant contract

<!-- creation-grant-contract:v1 -->

Status: issue #11 design contract, deciding the two things its remaining criteria are blocked on. Runtime implementation stays `required_for_v1` after design gate #39.

## 1. What is actually missing

Criteria 1, 2, 3, 4 and 7 of #11 are delivered. Five and six are not, and each is blocked on a decision rather than on effort:

- **Criterion 5.** `ctx.scopedCreation(grant)` exists and is typed, and the daemon validates the grant it is handed. But the grant is **not signed**, so the daemon cannot distinguish one the host compiled from one the caller wrote — and every field it validates is a field the caller knows about itself. The check reads like a check and admits anything well-formed.
- **Criterion 6.** `requireDaemonCapabilities` exists and refuses a daemon that is missing, older, or differently-shaped. It has **no caller** outside its own test, because the extension entry point it would run from does not exist yet.

This contract decides both. The closed JSON Schema is `resources/creation-grant/creation-grant.schema.json`.

## 2. Boundaries

Issue #38 owns the scoped SDK this grant is handed through; #10 owns runtime identity, whose digest is part of what a grant is bound to; #13 owns the trusted-write boundary the creation crosses. This contract defines what makes a grant unforgeable and where the preflight runs. It does not implement either.

## 3. Why validation alone is not enough

A grant names a project, a parent task, a session, a workflow, a step, a step visit, an operation, a context digest and an expiry. The daemon can check every one of those against its own state — and a caller inside that session knows all of them, because they describe the session it is running in.

So a hand-written grant with correct values passes. What the daemon cannot tell is *who produced it*, and that is exactly the question the capability turns on: holding a grant must mean the host decided to issue one, not that the caller could fill in a form.

## 4. The decision: a host-held key, over the binding

The host signs the canonical serialisation of the grant's binding **and** the slots with a key the model side never holds. The daemon verifies before admitting.

- **Key**: an Ed25519 keypair generated at daemon start, private key held in daemon memory only, never written to the project, never in an environment variable, never passed to a child process. A model process that could read the key could mint grants, so the key never crosses that boundary — the same reasoning that made the mutation tools absent rather than forbidden in ADR-033.
- **What is signed**: the binding fields **and** the slots. Signing the binding alone would leave the slot list malleable, and a slot list is what a grant permits — an attacker who could append a slot could create a child the host never authorised while presenting a valid signature.
- **Lifetime**: the signature is valid only until `expires_at_ms`, and only for the `operation_id` it names. A grant is single-purpose, so replay of a valid signature at a later step is refused by the binding, not by the signature.
- **Rotation**: the key is per daemon run. A grant does not survive a daemon restart, which is correct — the session it was issued to does not either.

Alternatives considered and rejected: an HMAC with a shared secret (the model side would need the secret to verify, and it does not need to verify); a nonce table (state to keep and to expire, and a lost table becomes a refused-everything outage); trusting the transport (there is no transport boundary between the SDK and the caller — that is the whole problem).

## 5. The decision: where the preflight runs

`requireDaemonCapabilities` runs at **extension load**, before the registry is built and before any workflow is registered. Not at first use.

The reason is the same one that puts the platform check at project open: a capability check that runs at first use runs after the extension has been accepted, and the failure is then a report about work already dispatched rather than a refusal to start. An extension that needs `task.create_bound` and finds a daemon without it must not be loaded at all.

Until the extension entry point exists, this is a decision waiting for its call site, and the issue says so rather than the code pretending the check is wired.

## 6. What a refusal looks like

A grant that fails verification is refused with the reason, and the refusal is not retried: an unsigned or wrongly-signed grant is not a transient condition. A daemon missing a capability parks the extension load with the capability name, the version found and the version required.

## 7. Park reasons

Closed set: `grant_unsigned`, `grant_signature_invalid`, `grant_expired`, `grant_operation_mismatch`, `grant_slot_tampered`, `grant_binding_mismatch`, `daemon_capability_missing`, `daemon_capability_version_mismatch`, `daemon_capability_method_mismatch`.

## 8. Required implementation tests

- a hand-written grant with entirely correct fields and no signature is refused;
- a valid signature over a grant whose slot list was appended to afterwards is refused;
- a valid signature replayed at a later step, and after expiry;
- a grant signed by a previous daemon run;
- the key never appears in the project, the environment, or a child process's arguments or environment;
- extension load refused when the daemon lacks the capability, has an older version, or exposes different methods;
- the preflight running before the registry is built, not at first use.

## 9. Acceptance mapping

| #11 criterion | State |
| --- | --- |
| 1 concurrent create yields one task | delivered |
| 2 hash mismatch never returns existing as success | delivered |
| 3 fields immutable through ordinary update or reconcile | delivered |
| 4 backward compatibility for callers without the fields | delivered |
| 5 typed fields and outcome, and a grant the caller cannot forge | §3, §4 decide it; runtime remains |
| 6 preflight refuses to start without the capability | §5 decides the call site; the entry point remains |
| 7 upstream patch, PR and commit pin recorded | delivered |
