# Ticket execution base contract

<!-- execution-base-contract:v1 -->

Status: issue #7 design contract. Runtime implementation remains `required_for_v1` after design gate #39.

## 1. Authority

A dependency edge in the Tickets manifest schedules work. It does not carry the predecessor's code into the dependent Ticket's Git base — and until this contract, nothing did:

```text
P  = planning_head
T1 (base = P) → approved commit C1
T2 depends_on T1
```

The scheduler may start `T2` once `T1` finishes, and `T2`'s fresh worktree is still built from `P`, where `C1` does not exist. The DAG is a schedule, not a build of state, and the implementer of `T2` discovers this by finding that the API the plan told them to use is not there.

So every Ticket has a recorded `execution_base_oid`, and its worktree is created only after that exact commit and tree are verified. The closed JSON Schema is `resources/execution-base/execution-base.schema.json`.

## 2. Boundaries

Issue #6 owns the frozen manifest the transitive closure is computed from; #5 supplies `planning_head`; #8 owns what an approved delta *is*; #9 owns private staging and the single target update; #17 says whether the host may move a ref at all. This contract composes bases. It never moves the user's target branch, and it stores no task status.

## 3. Definition

```text
execution_base(T) = planning_head + approved deltas of every transitive
                    predecessor of T, in stable topological order
```

- no dependencies: the base **is** `planning_head`;
- one predecessor: the verified predecessor state;
- several predecessors: a composition commit whose parents are recorded, built without moving any user-visible ref.

The closure is computed from the frozen manifest, not from the live graph, so two runs of the same Epic compute the same closure.

## 4. Stable order

`composition_order` is the manifest's `topological_order` restricted to the closure. It is recorded, not recomputed at use, because a diamond DAG applied in two orders can produce two trees, and then "the same base" would mean two different things on a retry.

Recording it is what makes the criterion *diamond DAG yields the same composition tree on retry and restart* checkable rather than hoped for.

## 5. Identity

`execution_base.digest` is SHA-256 over the canonical serialisation of: `planning_head`, the predecessor Ticket IDs **in composition order**, their commit OIDs, their delta digests, and the resulting `tree_oid`.

Order matters here and is deliberately not sorted away — unlike the set-valued fields elsewhere in this repository's contracts. Two bases built from the same predecessors in different orders are different bases, and a digest that hid that would be claiming a determinism the composition does not have.

The base digest is part of the Ticket's candidate and review identity.

## 6. What must hold before a worktree exists

- every predecessor has a valid PASS, a commit binding and a delta binding;
- the composition commit and tree exist and match the recorded OIDs;
- `dispatch_ticket_dag` and `resume_repaired_tickets` verify the base binding **before** enroll — not after the agent has started and produced work against the wrong tree.

A missing binding, a stale PASS, or deltas that overlap incompatibly goes to `human`. There is no silent resolution: a semantic conflict between two predecessors is a decision, and a model choosing one is a decision made by something that was not asked to make it.

## 7. Invalidation

A predecessor that changes voids every descendant base that included it. This is transitive, and it is computed from the same closure — a base is not "probably still fine" because the change looked small.

A retry uses the same base, or explicitly voids the old candidate when the DAG or the anchor has moved. The one thing it may not do is silently rebuild a different base under the same identity.

## 8. Recovery

Creating a composition base is idempotent. A crash after the commit object exists but before the metadata is written must not produce a second base or lose the object: the next attempt recomputes the same identity, finds the object, and records it.

Composition objects stay reachable until the end of the Epic's audit retention. Foreign movement of the private ref or the cache path is classified separately from a normal failure — it is not a race to retry through.

## 9. Park reasons

Closed set: `missing_predecessor_binding`, `stale_predecessor_pass`, `incompatible_overlapping_deltas`, `composition_failed`, `base_mismatch`, `dag_changed`, `anchor_changed`, `foreign_ref_movement`, `unreachable_composition_object`.

## 10. Required implementation tests

- a linear DAG, a diamond DAG, and several independent roots;
- overlapping compatible deltas, and overlapping incompatible ones;
- a predecessor superseded after an anchor rebuild;
- a missing predecessor PASS, and a stale one;
- a crash after the composition commit is created but before the metadata is written;
- a duplicate retry producing the same base rather than a second one;
- `workers=1` and `workers>=4` producing identical trees and outcomes;
- the user's target ref unmoved throughout.

## 11. Acceptance mapping

| #7 criterion | Where it is met |
| --- | --- |
| A dependent Ticket sees every transitive predecessor's approved code | §3 |
| Independent Tickets in one layer start from the same base in parallel | §3, §4 |
| A diamond DAG yields the same tree and OID on retry and restart | §4, §5, §8 |
| A changed predecessor voids affected descendant bases | §7 |
| The user's target ref does not move | §2, §3 |
| A semantic conflict is not resolved by a model | §6 |
| Dispatch and resume verify the base binding before enroll | §6 |
