# Epic staging and final target CAS contract

<!-- epic-staging-contract:v1 -->

Status: issue #9 design contract. Runtime implementation remains `required_for_v1` after design gate #39.

## 1. Authority

Approved Tickets accumulate on a private per-Epic ref, and the user's target branch moves once:

```text
refs/autosk/epics/<epic_ref_key>/staging
```

`epic_ref_key` is the same domain-separated SHA-256 of `{epic_id, project_root_sha256}` that keys every other ref under this helper-owned prefix — not a display id and not a user slug. The staging record carries `project_root_sha256` beside `epic_id` so the name can be derived and checked rather than asserted, and `epicRefKey` in `src/host/staging-driver.mjs` is the one derivation the driver and the validator use (ADR-087). One namespace with two naming conventions would leave the integration-critical ref with no project binding and no guarantee that the name is a legal ref at all.

```text
planning_head (verified; descends from the recorded target base)
  (or, after a re-stage, one receipted planning replay commit on the new `recorded_target_base`)
  → apply approved Ticket deltas to private staging
  → verify each integration receipt
  → aggregate verification on the exact staging OID and tree
  → optional integration-fix Tickets against staging
  → acceptance, backed by an IntegrationAuthorizationRecord
  → one final CAS of the target ref by the daemon's integrateApproved, or delivery through a PR or merge queue
  → post-CAS verification, or the delivery completion predicate
  → cleanup
```

Staging is first created at the verified `planning_head`, which descends from `planning.base_oid`, the target commit the planning ref was created from; the staging record's own `recorded_target_base` starts equal to it. So the final staging tree holds the planning artifacts plus the approved code. `planning.base_oid` and `planning_head` never change during an Epic, and the planning artifact PASSes stay published on the untouched planning ref. The lineage check runs from `recorded_target_base` to the staging head: first either the planning-ref commits up to the verified `planning_head` (while `recorded_target_base` equals `planning.base_oid`) or exactly one receipted planning replay commit (after a re-stage), then receipted delta commits only; anything else is `receipt_missing`. The expected old value of the one target CAS is `recorded_target_base` (ADR-088).

Re-staging — after `target_moved`, after `foreign_target_movement`, or after a PR or merge-queue delivery that is not merged while the target moved (`completion_predicate_unmet`) — rebuilds the line on the moved target. The staging record's `recorded_target_base` is re-recorded as the new target; the staging ref is rebuilt: `cleanupStaging` deletes it with the recorded staging OID as its expected value, and `createStaging` creates it at the new base. Its first commit is exactly one planning replay commit: its tree is the planning change (`planning.base_oid` → `planning_head`) applied onto the new base with pre-image revalidation, its single parent is the new `recorded_target_base`, and a durable planning-replay receipt binds it — `planning.base_oid`, `planning_head`, the change digest, the new base, and the replay commit and tree. Then every approved delta is re-applied with revalidation, and the prior aggregate PASS and acceptance are void. A planning change that does not apply to the new base parks `delta_stale`, and in v1 the only exits are cancel (a separate status operation) or a new Epic plan. The receipt's closed schema is implementation work under #9; the staging record carries `planning_base_oid` and, once re-staged, the receipt's digest as `planning_replay_receipt_sha256`, which the validator requires exactly when `recorded_target_base` differs from `planning_base_oid` (ADR-089). A re-stage is subject to `crossEpicErrors` (`src/host/staging-lineage.mjs`) like any staging line, and re-stages are serialized per target: when two unintegrated Epics on one target would re-record the same new base, the second waits until the first lands and then re-stages onto its result, so no two open lines share a `recorded_target_base` and none is staged from inside another's unintegrated lineage.

The ref-custody helper writes every ref under `refs/autosk/**`, the staging ref included; the host only asks it, and the daemon's `integrateApproved` alone moves the target ref. The staging ref has three actions in the helper's closed protocol (`docs/contracts/epic-planning-ref.md`, ADR-095): `create_staging` creates it at an expected-absent ref, `advance_staging` moves it from an expected old commit to a new one, and `delete_staging` removes it by expected OID. The host forms each request through `askCustody` (`src/host/ref-custody.mjs`): `createStaging`, `applyDelta` and `cleanupStaging` hand it the one ref update their action carries, and `applyDelta` refuses any ref but the staging ref before it asks. The daemon's `integrateApproved` is the only writer of the target ref; the host's `swapTarget` stays the expected-old CAS mechanics that adapter carries, and no host code calls it. A product host with no helper refuses every such request (`planning_ref_capability_missing`) rather than write the ref itself.

How the helper's answers are read:

- `create_staging` refused with `expected_old_mismatch`: the ref exists; at the same base it is the retry of a create that already happened, at another commit it is `cas_conflict`, and nothing is overwritten;
- `advance_staging` refused with `expected_old_mismatch`: the apply did not happen, `applied` is false and its receipt stays `prepared`, and the result reports what the ref held; a staging ref not at the recorded base before the apply asks is `foreign_ref_movement`;
- `delete_staging` refused with `expected_old_mismatch`: cleanup keeps the ref and reports `staging_moved_after_pass` with what it holds;
- any refusal for a capability reason (`packed_refs_drift`, `authorization_invalid`), no helper for the action, or an answer that does not answer the request — an observed OID in another object format than the request's among them (ADR-098): `planning_ref_capability_missing`, as for the helper's other actions. The flow parks it at `apply_staging` or `cleanup` and resumes into the same step; a project with no proven custody install parks `ref_custody_unavailable` at project open first (`platform-support.md` §5a, #13's obligation).

A request the host cannot form — a ref outside the action's grammar, a missing keepalive, an absent or present value the action does not allow, an advance to the commit the ref already holds, two Epics or two object formats in one request — is refused before the helper is asked, as `cas_conflict`: like a staging ref not named by the Epic ref key (ADR-087), it is a request on which no expected-old CAS can be made, and no other code of this contract says that.

Moving the target once per Ticket looks simpler and is not: two Tickets that are individually green can regress together, and by the time the second one is integrated the first is already on the user's branch. Aggregate verification exists because *individually green* is not a property of the set.

The closed JSON Schema is `resources/epic-staging/epic-staging.schema.json`.

## 2. Boundaries

Issue #7 supplies the execution base, #8 the approved delta and its integration receipts, #17 says whether the target may be moved directly at all and by whom, #5 supplies `planning_head` and the ref-custody helper that writes the staging ref, #6 the Tickets. This contract owns the staging ref's lifecycle, the aggregate binding, the acceptance record and the single final CAS.

## 3. Invariants

- the user's target branch does not change before aggregate PASS **and** acceptance;
- staging is created at the exact verified `planning_head` on the first stage, and at the re-recorded `recorded_target_base` with one receipted planning replay commit on a re-stage (§1);
- every apply produces a durable integration receipt;
- aggregate evidence is bound to the exact staging commit and tree, the verification config digest, and the project instruction lock;
- **any change to staging after aggregate PASS voids the aggregate binding** — a PASS is about a tree, not about an intention;
- an integration-fix Ticket gets its own ID, a manifest overlay or revision, acceptance criteria, and the ordinary verify, freeze and review. It is not a patch applied under someone else's approval;
- the final CAS is permitted only while the target is still at `recorded_target_base`, and only with an `IntegrationAuthorizationRecord` that backs the acceptance;
- after the CAS, the target OID, tree, containment and reflog are verified;
- the staging ref is kept until audit retention ends;
- there is no per-Ticket intermediate movement of the target. Not as an optimisation, not as a fallback.

## 4. Aggregate verification

Run against the exact staging OID, and its record binds:

- project and Epic identity;
- the staging commit and tree;
- the verification configuration digest;
- the instruction-lock digest (issue #12);
- the included Ticket and delta set.

A **command failure** and an **environment failure** are different outcomes and are recorded as different outcomes. Collapsing them makes "the tests failed" indistinguishable from "the machine could not run them", and only one of those is a statement about the product. A command that could not start did not fail: the two are separated where the run happens, not at the end, where the difference is already lost. An environment failure ends the run, because the checks after it would report on a machine already known not to be running them, and the aggregate outcome is `indeterminate`, with `environment_outcome` `environment_failure`, rather than a verdict; a check that ran and failed is `fail`. The schema's outcome enum is exactly `pass`, `fail` and `indeterminate`.

The checks run in a throwaway worktree checked out at the exact staging commit, detached — a branch there would be a second name for the staging commit that could then move independently of it. The checkout is read back before anything runs: a verification of the wrong tree is worse than no verification, because it produces a PASS. The worktree is removed on every path, refusals included, and a removal that did not happen is reported rather than swallowed by a cleanup that always succeeds.

## 5. Acceptance

A human acceptance record names the project and Epic identity, the final staging commit and tree, the aggregate verification record hash, the included Ticket and delta set, the target ref and base, the delivery profile digest, and the signed `IntegrationAuthorizationRecord` it stands on.

In the `squash` mode the accepted identity also names the commit the target will move to: the squash commit OID and the digest of its recipe — message, author, committer and their timestamps, the accepted staging tree and the recorded base as its only parent — as `target_commit_oid` and `target_commit_recipe_sha256`. The decision packet shows both, and the `IntegrationAuthorizationRecord`'s `ref_transition.to_oid` must equal that OID; a person accepts the exact commit that lands, not only its tree. The acceptance records its `delivery_mode`, and the schema requires both fields when that mode is `squash`; the validator refuses them under any other mode and, after the CAS, requires the target to hold the squash commit under `squash` and the accepted staging commit under `merge` or `rebase` (ADR-089).

A pinned auto-policy is held to the same binding, and it does one thing: it checks that the produced identity is the one the user's signed `IntegrationAuthorizationRecord` already named. It does not accept an identity on the user's behalf. The record binds the final tree, so by the time the policy runs the decision has been made and what is left is a comparison — `integration_authorization_policy_issued` refuses a record the policy itself issued, which is the same rule read from the other side. "Signed in advance" means before this acceptance step, for this exact identity: the identity binds the aggregate record, so it exists only after aggregate verification, and a record signed before staging exists names no identity at all (ADR-096).

Acceptance is of an *identity*, not of a plan to produce one. If the staging tree changes afterwards, the acceptance no longer applies to what would be pushed, and the CAS is refused.

The acceptance record is the one the schema closes, and the host writes that record: `kind` is `human` (with the `decision_id` of the decision record it came from) or `pinned_auto_policy` (with the `policy_ref` that pinned it), beside the staging commit and tree, the aggregate record hash, `included_tickets`, the target ref and base, the delivery profile digest and the delivery mode, and — for both kinds — `integration_authorization_id` and `integration_authorization_sha256`, the id and domain-separated digest of the completed `IntegrationAuthorizationRecord` it stands on (debt 11b). The accepted identity (`stagingIdentity` in `src/host/staging-acceptance.mjs`) is the domain-separated canonical digest of every fact the packet shows — the delivery profile digest, the delivery mode and the outstanding debt included, the controlling anchor digest and the authority projection, dependency and intent head hashes the acceptance is asked under (the same four the record binds, ADR-096), and under `squash` the target commit — so a profile or debt that changes after the answer makes it an answer to another question, and the CAS refuses an acceptance given under a profile other than the one in force (ADR-089).

Every OID the staging record names — the recorded base, the planning head and base, each applied commit, the staging commit and tree in the record, its aggregate and its acceptance, the squash commit, and the post-CAS target and tree — is a full OID of the project repository's object format: 40 lowercase hex characters for sha1, 64 for sha256, and one format for the whole record, because a repository has one (ADR-098); the schema refuses a record that mixes them. The host holds the identity to the same rule: a staging state whose base, staging commit or tree, or applied commits are of two formats, or a squash commit of another format than the base, is no identity to present, sign or accept (`acceptanceFacts`, `acceptance_missing`), and the CAS admission holds the same OIDs of the state it is asked about, and under `squash` the commit that lands, to one format (`acceptanceErrors`, `acceptance_missing`), as the delivery predicate refuses a delivered commit that is not of the base's format (`delivery-profile.md` §6a, `completion_predicate_unmet`).

The question reaches the operator through the decision queue of issue #35, and the two contracts meet at one point: the packet binds the exact staging identity as its candidate, so an answer that arrives after the tree moved is refused by the queue as an answer to a different question rather than applied to something nobody looked at. Every load-bearing field is inside that identity, which makes "the approval is stale" and "something it was about has changed" the same statement.

The packet parks with the graph's `acceptance_missing` and names its resume target as a graph step: `accept_staging` of `autosk-planned`, the one step that reason's recovery row permits.

The packet offers two options with their consequences. "Approve?" with one button is not a decision, and a refusal is a recorded outcome rather than the absence of an approval — a declined Epic is a state, not a silence.

A pinned auto-policy names the identity it was pinned to and the debt it tolerates. One that accepted an identity nobody signed for is not a policy, it is a default; debt outside what it names is not something it agreed to.

The host checks the record an acceptance stands on, on both paths, by one rule (`assertAuthorized`; debt 10e, ADR-091; debt 11b, ADR-096). A pinned auto-policy is checked on it, not only on its pin (`autoPolicyAcceptance`): the policy carries the signed `IntegrationAuthorizationRecord` and the `UserDecisionRecord` that signed it. The authorization must say it was issued by a user decision (`issued_by: user_decision_record`, which the host requires although the schema leaves it optional) and name that record by id and digest; the record must verify (as `human-decision.md` §3), must have signed exactly this authorization (its `payload_hash` is the domain-separated digest of every authorization field but the two that name it) and exactly this identity (its `subject_hash` is `stagingIdentity`); the record must name this Epic and the anchor version the acceptance is asked at; and the authorization must be the one composed for this identity (`composeAuthorization`, `integration-authorization.md` §1): for this project, Epic, scope and target ref, start at the recorded base (`initial_target_oid` and `ref_transition.from_oid`), end at the commit that lands (the staging commit, or under `squash` the squash commit), name the accepted tree and the applied commits in the receipts' order, name the controlling anchor digest and the three heads the identity binds, have been signed as `active`, and not have expired by now. A missing or unsigned record is `acceptance_missing` — including one whose `terminal_disposition` changed after signing, since its bytes are no longer the signed ones; one that is about something else, was signed as terminal, or has expired is `acceptance_stale` (`integration-authorization.md` §5). The host sees only the copy it is handed: a revocation it does not see is enforced by `integrateApproved`'s check of the authorization head before the CAS, not by this check. The signature needs the ADR-023 verifier, which the host is handed and does not have, so today every acceptance, on either path, is refused.

On the person's path the record is composed before the question and presented by the packet (`integration_authorization`), whose `accept` option signs its payload (`signed_payload_hash`; `human-decision.md` §3), so an answer that signed the answer object, or another record, is `decision_approver_mismatch`. `acceptanceFromDecision` completes the presented record with the verified decision's id and digest, runs the same check, writes the acceptance naming it, and returns the completed record for the daemon to store and chain. A refusal signs no record. `acceptanceErrors` (and so `casAdmission`) refuses an acceptance of either kind that does not name a record by id and 64-hex digest, a CAS asked without the record (`current.authorization`), under a record with another id, or without naming the instant it is asked at (`current.nowMs`) — `acceptance_missing` — and, as `integration-authorization.md` §5 says, the named record revoked, replaced or otherwise rewritten since (same id, other digest), or one that is for another project, Epic, scope, target, transition, tree or applied commits, is terminal, or has expired — `acceptance_stale`. That the decision behind it signed it is checked when the acceptance is made; that the record is the daemon's current one, and the heads it names are in force, is `integrateApproved`'s check.

## 6. The final CAS, and what follows it

One compare-and-swap by the daemon's `integrateApproved`, expected-old being the recorded base. If the target has moved, the operation goes to `human` and the ref is not touched: a foreign movement means someone else acted on that branch, and overwriting it is the one outcome that cannot be undone by retrying.

A foreign movement is not a dead end. After investigation the user may record a decision to re-stage onto the moved target: the flow resumes into `apply_staging` and re-stages as §1 describes — `recorded_target_base` re-recorded, the staging ref rebuilt at the new base with one receipted planning replay commit, every approved delta re-applied with the pre-image check `applyDelta` already makes (a change that no longer applies parks `delta_stale`), and the prior aggregate PASS and acceptance void. The same re-stage is open from `deliver_staging` when the PR or queue entry is not merged and the target moved; the delivery step then voids the old delivery receipt and closes or withdraws the old PR or queue entry before it opens a new one for the new staging identity. A delivery that merged a tree other than the accepted one is not re-staged: the target holds an unaccepted tree, and like `post_cas_mismatch` it parks `completion_predicate_unmet` for an explicit human decision, with no history rewrite. A target busy enough to move again during each human-gated re-stage can still keep an Epic from landing; that is named as a remaining risk in `04-decisions.md` (ADR-088). Without that decision nothing moves. Cancel stays a separate status operation.

What the CAS writes is set by the mode (`docs/contracts/delivery-profile.md` §6a). `merge` and `rebase` fast-forward the target to the accepted staging commit, planning commits (or the one planning replay commit) included: the base did not move, so rebasing onto it is the identity. `squash` moves it to one commit whose tree is the accepted staging tree and whose only parent is the recorded base. PR and merge-queue delivery never runs the CAS; it completes when the commit the delivery receipt names is on the target, its tree is the accepted staging tree and the recorded base is its ancestor — a squash or rebase merge never puts the exact staging commit there, so requiring it would leave such an Epic undelivered forever.

After the swap: the target OID is read back and must be the move's commit (the staging commit or the squash commit), its tree must be the accepted tree, containment of the recorded result is checked, and the reflog entry is confirmed. A CAS that reported success is not evidence that the ref holds what was intended.

The compare-and-swap is git's own. `update-ref <ref> <new> <old>` fails if the ref does not hold `<old>` at write time; reading the ref and then writing it leaves exactly the window this contract exists to close, and passes every test that does not race. The writer therefore never reads to decide whether to write — it writes with the expected old value and reports what happened. That holds for the daemon's target CAS and for the helper's staging actions alike: creating the staging ref is an update at an expected-absent ref, advancing it carries the recorded base as expected old, and deleting it carries an expected OID, so cleanup cannot destroy a staging ref that moved after the aggregate passed.

The reflog check is a delta, not a total. A long-lived branch has a long reflog and that says nothing about this operation; what the invariant asks is whether the ref moved once during the window, which is the depth now minus the depth before.

## 7. Recovery

A crash after aggregate PASS and before the CAS resumes **without another model run**. Everything needed is recorded: the staging identity, the aggregate record, the acceptance. Re-running a model at that point would produce different bytes and quietly discard an approval that was about the old ones.

A retry of the final CAS is idempotent: if the target already holds the recorded result, the operation is complete rather than in conflict.

## 8. Park reasons

Closed set: `aggregate_failed`, `aggregate_binding_void`, `staging_moved_after_pass`, `target_moved`, `foreign_target_movement`, `acceptance_missing`, `acceptance_stale`, `cas_conflict`, `post_cas_mismatch`, `environment_failure`, `receipt_missing`.

In the workflow graph, `aggregate_failed` is the one class with no park reason of its own: a failed aggregate stops at `aggregate_verify` as `aggregate_verify_failed`, the reason the resume contract in `03-technical-plan.md` §7 already owns and whose recovery opens the remediation choice, so a second name for the same stop would give a caller two codes to branch on for one condition. The other ten are park reasons of the graph under the names above, each with its recovery row: `apply_staging` stops with `receipt_missing` (and with `approved-delta.md`'s `delta_stale`), `aggregate_verify` with `environment_failure`, `aggregate_binding_void` and `staging_moved_after_pass`, `accept_staging` with `staging_moved_after_pass`, `aggregate_binding_void`, `acceptance_stale` and `acceptance_missing`, `integrate_staging` — the one target CAS — with `acceptance_stale`, `target_moved`, `foreign_target_movement` and `cas_conflict`, and `verify_target`, the read-back after it, with `post_cas_mismatch`.

## 9. Required implementation tests

- two individually green Tickets that regress in aggregate;
- an aggregate command failure and an environment failure, recorded distinctly;
- staging moved after PASS, and the target moved before the CAS;
- a crash before and after each staging apply;
- a crash after aggregate PASS, resumed without a model run;
- a retried final CAS;
- an integration-fix Ticket that succeeds, and one that fails;
- cleanup before and after retention;
- a squash-merged and a rebase-merged PR each complete delivery, and a delivered tree other than the accepted one does not;
- a target movement re-staged onto the moved target, with a planning change or a delta that no longer applies parking `delta_stale`;
- planning artifacts and approved code both present in the final staging tree;
- a direct write to the staging ref from the extension, model or project account fails, and every create, advance and delete goes through the helper's staging actions (`epic-planning-ref.md` obligation 39).

## 10. Acceptance mapping

| #9 criterion | Where it is met |
| --- | --- |
| Aggregate failure leaves the target ref and bytes untouched | §3, §6 |
| A human accepts an exact aggregate-verified staging identity | §5 |
| An auto-policy is bound to the same identity, and checks rather than decides | §5 |
| Final target movement is one CAS | §6 |
| An integration fix passes the same gates as a code Ticket | §3 |
| A crash after aggregate PASS recovers without a model run | §7 |
| Foreign target movement goes to `human` and moves nothing | §6 |
| Planning artifacts and approved code are in the final staging tree | §9 |
