# Project delivery profile contract

<!-- delivery-profile-contract:v1 -->

Status: issue #17 design contract. Runtime implementation remains `required_for_v1` after design gate #39.

## 1. Authority

Every Epic resolves, once and before its first implementation dispatch, how its work will reach the target ref:

```text
docs/autosk/epics/<epic-id>/delivery/delivery-profile.lock.json
```

The profile is answered before the first Ticket is implemented, not discovered when the first push fails. A repository that requires pull requests, signed commits or a merge queue does not become discoverable by trying: by then there are approved commits that cannot be delivered without rewriting history or asking for the review again.

The lock is the only authority for what the host may do with refs. An adapter that finds the recorded mode unsupported **stops the Epic** at that point. There is no hidden fallback to a local fast-forward because the configured path did not work.

## 2. Boundaries

Issue #9 owns private staging and the single conditional target update; this contract says which of those operations are permitted at all. Issue #5 owns the planning ref, #6 the Tickets manifest, #8 approved deltas. Issue #26 owns provider capability and credentials — the profile records *that* a credential class is required, never a credential. Issue #37 owns governance release lifecycle. Deployment to real users is out of scope here and everywhere in v1.

## 3. Sources and provenance

Three sources, in this order, and every recorded field names the one it came from:

1. `project_config` — committed in the tree, so it has a blob OID;
2. `remote_discovery` — read from the forge, so it has an observation time and an expiry;
3. `human_decision` — a recorded decision, so it has a decision id and a scope.

A field with no source is not defaulted. `unknown` is a value, and an Epic with an `unknown` field that its integration mode depends on parks with a decision packet rather than guessing.

Discovery is *evidence with a shelf life*. Branch protection read an hour ago may not hold now, so every `remote_discovery` field records `observed_at` and `expires_at`, and a profile whose relevant discovery has expired is re-resolved before the operation that depends on it — not trusted because it was true once.

## 4. What the profile records

The closed JSON Schema is `resources/delivery-profile/delivery-profile.schema.json`.

- canonical `target_ref` and the `base_oid` recorded when the Epic started;
- `integration_modes` — the closed set the project allows, from `merge`, `squash`, `rebase`, `pull_request`, `merge_queue`, `fork_pull_request`;
- `direct_push_allowed` — explicitly, because "we did not see a protection rule" is not the same as "direct push is allowed";
- responsibilities for local staging, final push and PR creation;
- authorship, signing and DCO requirements, each with how the host reproduces them;
- commit-message policy;
- a branch-protection/ruleset snapshot with its provenance and expiry;
- required checks, each with provenance;
- CI command and config digest;
- review and merge-queue requirements;
- remotes and fork strategy;
- an explicit release/deploy exclusion;
- the completion predicate — what "delivered" means for this project;
- the supported rollback and recovery path.

Unknown fields and unknown versions fail closed.

## 5. Identity

`profile_digest` is SHA-256 over the canonical serialisation of every field that can change what the host does — not over the whole document, because prose fields such as a human decision's rationale must be editable without invalidating a candidate that never depended on them. The profile marks which fields are binding; the digest covers exactly those, and the validator recomputes it.

The serialisation is content, not writing order. Every array here is a set — allowed modes, required checks, a decision's scope — so serialising positionally would make a re-resolution that returned the same permissions in a different order look like drift, and drift invalidates approvals. Arrays are sorted and object keys are sorted before hashing. The file is still required to be *written* in that order, so two profiles with the same content are the same bytes and a diff shows a real change rather than a reshuffle.

`profile_digest` binds planning and Ticket candidate identity wherever the profile changes how commits are structured, staging and aggregate evidence, human acceptance, and the final integration operation.

## 6. Drift

Branch protection, required checks and rulesets are the forge's state, not ours, and they change under a running Epic. Any change to a binding field is a correction: it creates an impact and invalidates the approvals whose evidence depended on that field.

Silently switching `merge` to `squash`, or a pull-request profile to a local update, is not a repair — it is a different delivery with the same name. Both are refused.

A required check appearing mid-run invalidates a staging result that never ran it. A required check disappearing does **not** retroactively validate a run that failed it.

## 7. Fail-closed

The Epic stops before its first implementation dispatch when: the integration mode is unsupported by the adapter; a binding field is `unknown`; discovery is unavailable and no `project_config` or `human_decision` covers the field; the remote is unreachable or refuses permission; or the recorded profile's digest no longer matches what the forge reports.

Stopping produces a decision packet: the field, its source, what was observed, and the choices a human has. "Delivery is not configured" is not a decision packet.

## 8. Credentials

The profile records that a credential class is required and where the host expects it, never a credential. Nothing under `evidence` or in any project artifact contains a token, a key or a password; the schema has no field that could hold one, which is a stronger statement than a policy that says not to.

## 9. Park reasons

Closed set: `unsupported_integration_mode`, `unknown_binding_field`, `discovery_unavailable`, `discovery_expired`, `remote_unreachable`, `permission_denied`, `profile_drift`, `credential_missing`, `completion_predicate_unmet`.

Four are also recordable in the lock itself as an `unresolved` entry — `unknown_binding_field`, `discovery_unavailable`, `discovery_expired`, `credential_missing` — because they are facts about resolution. The rest are facts about a run.

## 10. Required implementation tests

- a local unprotected branch, and a GitHub protected pull-request-only branch;
- merge-only, squash-only and rebase-only projects, each refusing the other two;
- a merge queue;
- signed commits and DCO sign-off, each reproduced host-side;
- a required check added mid-run, and one removed mid-run;
- the remote unreachable, and permission denied;
- ruleset discovery unavailable;
- a fork-based contribution flow;
- a human override with a scope that does not cover the field it was applied to;
- expired discovery re-resolved before the operation that depends on it.

## 11. Acceptance mapping

| #17 criterion | Where it is met |
| --- | --- |
| Integration mode known before the first Ticket implementation | §1, §7 |
| Direct target movement forbidden under a pull-request-only profile | §4 `direct_push_allowed`, §6 |
| Signing/DCO reproducible host-side | §4 |
| Required CI results bound to the exact final staging/PR commit | §4, §5 |
| Protected branch/ruleset discovery has provenance and expiry | §3 |
| Unsupported delivery policy fails closed with a decision packet | §7 |
| Provider credentials never in project artifacts or evidence | §8 |
| A profile change mid-Epic invalidates affected approvals | §6 |
