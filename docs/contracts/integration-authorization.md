# Integration authorization contract

<!-- integration-authorization-contract:v1 -->

Status: issue #9 and issue #4 runtime contract. The record itself is already specified across `01-core-flows.md` §7, `02-architecture.md` §7 and `03-technical-plan.md`; what was missing is this document, a closed schema and a validator. Panel round 1 found that absence: the only token that may skip the human stop before the one irreversible step had rules in prose and nothing that could check them.

## 1. Authority

A signed `IntegrationAuthorizationRecord` for the exact run and candidate is always required for an Epic's target CAS, as §5 and `02-architecture.md` state: `integrateApproved` refuses the CAS without one on every path. It comes into being in one of two ways. By default an Epic stops at `human` before its target branch moves, and the human's acceptance decision there produces the record. Or the user signed it in advance for a pinned auto-policy, and that record is the one thing that may skip the stop: the policy then only checks that the produced identity is the one the record names (ADR-088). On the host that check is `autoPolicyAcceptance` in `src/host/staging-acceptance.mjs`, which requires the record and the `UserDecisionRecord` behind it and binds both to the identity and the one transition (`docs/contracts/epic-staging.md` §5, ADR-091); it refuses every record until the ADR-023 verifier exists.

Nothing else may skip the stop, and nothing replaces the record. A project policy may not issue one — policy covers scheduling and reversible non-product scope, and moving a user's branch is neither. A model may prepare the packet and recommend it; the authority is a signed `UserDecisionRecord`, and a record without one authorizes nothing.

## 2. Boundaries

This contract decides what the record binds, when it stops authorizing, and that it authorizes exactly one ref transition, so no partial integration is ever left for a later record to continue. It does not decide how the CAS itself is performed (`docs/contracts/epic-staging.md` §6), who may move the branch at all (`docs/contracts/delivery-profile.md` §6a), or how the decision reaches the operator (`docs/contracts/human-decision.md`).

## 3. What the record binds

The closed JSON Schema is `resources/integration-authorization/integration-authorization.schema.json`.

- `record_id` and `scope_id` — the record is resolved by scope **and** id, so a record from another scope is not found by luck;
- `project_root_sha256`, `epic_id` (or `null` with `quick_task_id` for a Quick run) and `run_id`;
- `target_ref` and `initial_target_oid` — the branch and where it was when the record was signed: the recorded base the one CAS expects to find;
- `ref_transition` — the one movement the record authorizes, with `from_oid` equal to `initial_target_oid` and `to_oid` the commit that carries the accepted identity: an Epic's accepted staging commit, built on the verified `planning_head` that descends from the recorded base (or, after a re-stage, one receipted planning replay commit on the new `recorded_target_base`), so the planning commits move with it (the `merge` and `rebase` modes), or its squash commit — one commit whose tree is the accepted staging tree and whose only parent is the recorded base, built by a deterministic recipe fixed before the record is signed (the `squash` mode; `to_oid` equals the squash commit OID the acceptance names as `target_commit_oid`, beside its `target_commit_recipe_sha256` over message, author, committer, timestamps, tree and parent, so the person accepts the exact commit that lands) — or a Quick run's integration commit, which the adapter builds from a deterministic recipe — recorded base, reviewed candidate, approved tree — fixed before the record is signed, the way `commit_on_pass` fixes its expected commit OID, so the OID the record names is the one the CAS writes. A transition, not a permission to reach a state by any route (§4);
- `ordered_ticket_commit_oids` — the reviewed commits that result is made of, in the order they were applied: the Tickets whose approved deltas the Epic's staging carries, or the Quick run's one reviewed candidate, and a Quick record naming any other number is refused;
- `final_tree_oid` — what the branch is expected to hold afterwards;
- `integration_plan_hash`, `controlling_anchor_digest`, `classifier_proof_hash`;
- `relevant_authority_projection_hash`, `dependency_head_hash`, `intent_head_hash` — the heads the signature was made against;
- `previous_authorization_head_hash` — the chain, so a record cannot be inserted behind one that already exists;
- `expires_at` and `terminal_disposition`;
- `user_decision_record_id` and `user_decision_record_hash`.

Every one of those is load-bearing: each names something that, if it changed, would make the authorization about a different integration.

## 4. Expiry is not a formality

An expired record authorizes nothing. There is no partial integration for it to strand, because the branch moves by **one** ref transition: an Epic's from the recorded target base to the accepted staging commit or, under `squash`, the squash commit the acceptance names, by the one CAS after aggregate PASS and acceptance (`docs/contracts/epic-staging.md` §6), and a Quick run's from its base to the commit that integrates its reviewed candidate. So the record names that one transition and nothing else: no ordered plan, no position inside one, no receipt for a part already done. The schema has no field that could say otherwise, and a record shaped for the per-Ticket order this contract was first written for — several transitions, a start index, a receipt for a completed part — is refused by the schema rather than read.

A record that expires before the CAS leaves the branch where it was and the acceptance it backed stale: the Epic returns to `accept_staging`, and a new record binds the same recorded base and the same accepted identity or it binds nothing. After the CAS there is nothing left to authorize. A record that authorized moving `A → B` is still not authority for moving `A → C` unless somebody signed that.

## 5. Fail-closed, and what may not substitute

A missing, changed, shortened or head-mismatched record refuses, and the target ref is not read again and not moved. For a Quick run the refusal parks at `accept` with `integration_authorization_required`. An Epic never parks with that code: its acceptance is what the record backs, so a record that is missing when acceptance is asked for is `acceptance_missing` at `accept_staging`, and one that has expired, been revoked or replaced, or no longer matches `integration_authorization_head` by the time `integrate_staging` would run the CAS is `acceptance_stale` there, resumed at `accept_staging` for a new acceptance. Recovery restores exact committed bytes; it never reconstructs a record from what the operation appears to have been doing. The host's check of a pinned auto-policy (`docs/contracts/epic-staging.md` §5) sees only the copy it is handed, so revocation, replacement or expiry after that point is enforced here, by `integrateApproved` against `integration_authorization_head`, and not by the host.

`integration-state/<operation-id>.json` stores the CAS operation and its outcome. It is not authority and may not stand in for the record: operation state is what happened, and authorization is what was permitted, and inferring the second from the first is how an interrupted CAS would authorize its own retry.

## 6. Refusal classes

Closed set: `integration_authorization_required`, `integration_authorization_expired`, `integration_authorization_scope_mismatch`, `integration_authorization_prefix_mismatch`, `integration_authorization_head_mismatch`, `integration_authorization_policy_issued`, `integration_authorization_terminal`.

`integration_authorization_prefix_mismatch` keeps the name it had under the per-Ticket order and refuses one case now: the branch is not where the record's one transition starts, so the record is about a branch state other than the one it would act on, and it does not follow the branch there.

## 7. What this contract decides, and what it defers

Decided: what the record binds, that it authorizes exactly one ref transition from the recorded base — so no partial CAS exists for a later record to continue, and the schema has no field for one — that policy cannot issue it, that expiry ends it, and that operation state is not authority.

Deferred, and named: the signer itself and the trusted client that displays the challenge — both are daemon-side and are covered by ADR-023.
