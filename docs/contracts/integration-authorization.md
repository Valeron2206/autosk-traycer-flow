# Integration authorization contract

<!-- integration-authorization-contract:v1 -->

Status: issue #9 and issue #4 runtime contract. The record itself is already specified across `01-core-flows.md` §7, `02-architecture.md` §7 and `03-technical-plan.md`; what was missing is this document, a closed schema and a validator. Panel round 1 found that absence: the only token that may skip the human stop before the one irreversible step had rules in prose and nothing that could check them.

## 1. Authority

By default an Epic stops at `human` before its target branch moves. One thing may skip that stop: a signed `IntegrationAuthorizationRecord` for the exact run and candidate.

Nothing else may. A project policy may not issue one — policy covers scheduling and reversible non-product scope, and moving a user's branch is neither. A model may prepare the packet and recommend it; the authority is a signed `UserDecisionRecord`, and a record without one authorizes nothing.

## 2. Boundaries

This contract decides what the record binds, when it stops authorizing, and what a partial integration may do next. It does not decide how the CAS itself is performed (`docs/contracts/epic-staging.md` §6), who may move the branch at all (`docs/contracts/delivery-profile.md` §6a), or how the decision reaches the operator (`docs/contracts/human-decision.md`).

## 3. What the record binds

The closed JSON Schema is `resources/integration-authorization/integration-authorization.schema.json`.

- `record_id` and `scope_id` — the record is resolved by scope **and** id, so a record from another scope is not found by luck;
- `project_root_sha256`, `epic_id` (or `null` with `quick_task_id` for a Quick run) and `run_id`;
- `target_ref` and `initial_target_oid` — the branch and where it was when the record was signed;
- `ordered_ticket_commit_oids` and `ordered_ref_transitions` — the plan, in order, not a permission to reach a state by any route;
- `final_tree_oid` — what the branch is expected to hold afterwards;
- `remaining_start_index` and `completed_prefix_receipt_hash` — where this record starts in that plan, and the proof of what a previous record already did;
- `integration_plan_hash`, `controlling_anchor_digest`, `classifier_proof_hash`;
- `relevant_authority_projection_hash`, `dependency_head_hash`, `intent_head_hash` — the heads the signature was made against;
- `previous_authorization_head_hash` — the chain, so a record cannot be inserted behind one that already exists;
- `expires_at` and `terminal_disposition`;
- `user_decision_record_id` and `user_decision_record_hash`.

Every one of those is load-bearing: each names something that, if it changed, would make the authorization about a different integration.

## 4. Expiry is not a formality

An expired record authorizes nothing, including the transitions it already authorized. This matters most in the case it is written for: expiry **after** a partial CAS.

The workflow then keeps the exact completed prefix, returns to `accept`, and a new record starts from the **current** target OID and covers only the remaining transitions. It does not resume the old plan from where it stopped, because the branch is no longer where the old record said it was — and a record that authorized moving `A → B → C` is not authority for moving `B → C` unless somebody signed that.

## 5. Fail-closed, and what may not substitute

A missing, changed, shortened or head-mismatched record refuses with `integration_authorization_required` and the target ref is not read again and not moved. Recovery restores exact committed bytes; it never reconstructs a record from what the operation appears to have been doing.

`integration-state/<operation-id>.json` stores the CAS operation, its prefix and its outcome. It is not authority and may not stand in for the record: operation state is what happened, and authorization is what was permitted, and inferring the second from the first is how an interrupted integration authorizes its own continuation.

## 6. Refusal classes

Closed set: `integration_authorization_required`, `integration_authorization_expired`, `integration_authorization_scope_mismatch`, `integration_authorization_prefix_mismatch`, `integration_authorization_head_mismatch`, `integration_authorization_policy_issued`, `integration_authorization_terminal`.

## 7. What this contract decides, and what it defers

Decided: what the record binds, that policy cannot issue it, that expiry ends it including mid-plan, that a new record after a partial CAS starts from the current target OID, and that operation state is not authority.

Deferred, and named: the signer itself and the trusted client that displays the challenge — both are daemon-side and are covered by ADR-023.
