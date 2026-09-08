# Epic staging and final target CAS contract

<!-- epic-staging-contract:v1 -->

Status: issue #9 design contract. Runtime implementation remains `required_for_v1` after design gate #39.

## 1. Authority

Approved Tickets accumulate on a private per-Epic ref, and the user's target branch moves once:

```text
refs/autosk/epics/<epic-id>/staging
```

```text
planning_head
  → apply approved Ticket deltas to private staging
  → verify each integration receipt
  → aggregate verification on the exact staging OID and tree
  → optional integration-fix Tickets against staging
  → human acceptance, or a pinned auto-policy
  → one final CAS of the target ref
  → post-CAS verification
  → cleanup
```

Moving the target once per Ticket looks simpler and is not: two Tickets that are individually green can regress together, and by the time the second one is integrated the first is already on the user's branch. Aggregate verification exists because *individually green* is not a property of the set.

The closed JSON Schema is `resources/epic-staging/epic-staging.schema.json`.

## 2. Boundaries

Issue #7 supplies the execution base, #8 the approved delta and its integration receipts, #17 says whether the target may be moved directly at all and by whom, #5 supplies `planning_head`, #6 the Tickets. This contract owns the staging ref, the aggregate binding, the acceptance record and the single final CAS.

## 3. Invariants

- the user's target branch does not change before aggregate PASS **and** acceptance;
- staging is created from the exact recorded target base or planning head, per the delivery profile's model;
- every apply produces a durable integration receipt;
- aggregate evidence is bound to the exact staging commit and tree, the verification config digest, and the project instruction lock;
- **any change to staging after aggregate PASS voids the aggregate binding** — a PASS is about a tree, not about an intention;
- an integration-fix Ticket gets its own ID, a manifest overlay or revision, acceptance criteria, and the ordinary verify, freeze and review. It is not a patch applied under someone else's approval;
- the final CAS is permitted only while the target is still at the recorded base;
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

A **command failure** and an **environment failure** are different outcomes and are recorded as different outcomes. Collapsing them makes "the tests failed" indistinguishable from "the machine could not run them", and only one of those is a statement about the product.

## 5. Acceptance

A human acceptance record — or a pinned auto-policy, which is held to the same binding — names the project and Epic identity, the final staging commit and tree, the aggregate verification record hash, the included Ticket and delta set, the target ref and base, and the delivery profile digest.

Acceptance is of an *identity*, not of a plan to produce one. If the staging tree changes afterwards, the acceptance no longer applies to what would be pushed, and the CAS is refused.

## 6. The final CAS, and what follows it

One compare-and-swap, expected-old being the recorded base. If the target has moved, the operation goes to `human` and the ref is not touched: a foreign movement means someone else acted on that branch, and overwriting it is the one outcome that cannot be undone by retrying.

After the swap: the target OID and tree are read back, containment of the recorded result is checked, and the reflog entry is confirmed. A CAS that reported success is not evidence that the ref holds what was intended.

The compare-and-swap is git's own. `update-ref <ref> <new> <old>` fails if the ref does not hold `<old>` at write time; reading the ref and then writing it leaves exactly the window this contract exists to close, and passes every test that does not race. The driver therefore never reads to decide whether to write — it writes with the expected old value and reports what happened. The same holds for creating the staging ref (an old value of the empty string means *must not exist*) and for deleting it (an expected OID, so cleanup cannot destroy a staging ref that moved after the aggregate passed).

The reflog check is a delta, not a total. A long-lived branch has a long reflog and that says nothing about this operation; what the invariant asks is whether the ref moved once during the window, which is the depth now minus the depth before.

## 7. Recovery

A crash after aggregate PASS and before the CAS resumes **without another model run**. Everything needed is recorded: the staging identity, the aggregate record, the acceptance. Re-running a model at that point would produce different bytes and quietly discard an approval that was about the old ones.

A retry of the final CAS is idempotent: if the target already holds the recorded result, the operation is complete rather than in conflict.

## 8. Park reasons

Closed set: `aggregate_failed`, `aggregate_binding_void`, `staging_moved_after_pass`, `target_moved`, `foreign_target_movement`, `acceptance_missing`, `acceptance_stale`, `cas_conflict`, `post_cas_mismatch`, `environment_failure`, `receipt_missing`.

## 9. Required implementation tests

- two individually green Tickets that regress in aggregate;
- an aggregate command failure and an environment failure, recorded distinctly;
- staging moved after PASS, and the target moved before the CAS;
- a crash before and after each staging apply;
- a crash after aggregate PASS, resumed without a model run;
- a retried final CAS;
- an integration-fix Ticket that succeeds, and one that fails;
- cleanup before and after retention;
- planning artifacts and approved code both present in the final staging tree.

## 10. Acceptance mapping

| #9 criterion | Where it is met |
| --- | --- |
| Aggregate failure leaves the target ref and bytes untouched | §3, §6 |
| A human accepts an exact aggregate-verified staging identity | §5 |
| An auto-policy is bound to the same identity | §5 |
| Final target movement is one CAS | §6 |
| An integration fix passes the same gates as a code Ticket | §3 |
| A crash after aggregate PASS recovers without a model run | §7 |
| Foreign target movement goes to `human` and moves nothing | §6 |
| Planning artifacts and approved code are in the final staging tree | §9 |
