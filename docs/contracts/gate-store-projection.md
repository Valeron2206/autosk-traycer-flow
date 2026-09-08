# Gate store projection contract

<!-- gate-store-projection-contract:v1 -->

Status: issue #15 design contract. Runtime implementation remains `required_for_v1` after design gate #39.

## 1. Authority

A read-only reviewer is protected by comparing store state before and after its run. The question is *what* to compare, and both obvious answers are wrong:

- hash the whole `task.json` and `comments.jsonl`, and one reviewer's answer is rejected as mutating because **another seat finished** while it was working, or because autoskd updated a timestamp. Four seats run in parallel; that is not an edge case, it is the normal shape of a Panel;
- hash too little, and a reviewer or a driver can change the controlling anchor, the candidate identity, its own role, a protocol lock or a sibling's verdict, and nothing notices.

So the comparison is over a declared projection — a named subset of state that must not change during a gate run — plus a provenance check on everything outside it. The closed JSON Schema is `resources/gate-store-projection/gate-store-projection.schema.json`.

## 2. Boundaries

Issue #16 owns findings and their lifecycle; #18 owns the result envelope a seat submits; #12 supplies the instruction lock; #10 the runtime identity; #14 registers this class. This contract defines what may not move during a run, what may, and how the difference is proven.

## 3. Immutable for the run

Hashed into `projection_digest`:

- canonical project binding;
- parent and child relation;
- run, round, attempt, seat and role;
- artifact and candidate identity;
- base, pathspec, tree and file hashes;
- anchor version;
- protocol, runtime and project-instruction locks;
- creation key and binding;
- provider session binding and generation;
- reviewer routing, and the author and fixer families;
- expected blocker identity;
- allowed transitions and result schema;
- previously accepted canonical findings relevant to this run.

If any of these differ before and after, the run's answer is about a different question than the one asked, and the result is a **blocking non-verdict** rather than a pass or a fail. Not a retry either: the same question has to be asked again from a known state.

## 4. Legitimately concurrent

These may change during a run, and on their own they never make a verdict invalid:

- autoskd status, step and timestamps;
- worker lease and activity;
- engine counters;
- session append progress;
- another seat's host-written result;
- a sibling child's terminal status;
- retry and heartbeat fields owned by the daemon that do not change identity.

The phrase *on their own* is doing real work. A field in this list is not a licence — it is exempt from the projection hash, and still subject to §5.

## 5. Mutation provenance

A projection hash alone answers "did the protected fields change?" It cannot answer "who changed the unprotected ones?", and a driver bug that writes an allowed-looking field is exactly the case where the two questions differ.

So every mutation outside the projection carries a journal record: actor (`daemon`, `driver`, `user`, `model`, `tool`), operation id, the permitted field set for that operation, before and after digests, sequence and timestamp, and the project binding.

Gate acceptance requires that **every** out-of-projection change maps to a permitted host operation. An unknown writer, a missing record, or a change to a field the operation was not permitted to touch is a blocking non-verdict. The default is refusal: a change nobody claims is not assumed to be the daemon's.

## 6. Comments

A sibling's `comments.jsonl` may not be compared as one hash — appends are the normal traffic of a running Panel. It is split into:

- a **frozen prefix**, up to the checkpoint that belongs to the controlling anchor, which is hashed and must not change;
- **allowed append-only host records** after it, which may grow;
- **forbidden model or sibling mutations**, which are any change to the frozen prefix or any append by an actor that is not a permitted host operation;
- **late findings**, which are not handled here at all — they have their own lifecycle in #16, and treating one as a projection violation would park the run instead of routing the finding.

An append that rewrites earlier bytes is not an append. The frozen prefix is what makes that statement checkable.

## 7. Canonical hashing

The digest is over a canonical form: object keys sorted, arrays that are sets sorted, no insignificant whitespace, and timestamps outside the projection excluded rather than normalised. Two stores that differ only in JSON key order produce the same digest; two that differ in any projected value do not.

`projection_version` is part of the runtime lock. A run started under one version is not evaluated under another — a projection that gained a field mid-run would retroactively make a legitimate change into a violation.

## 8. Cross-project isolation

Records from another project never enter the projection. The project binding is both a projected field and a filter: a record whose binding is not this project is not "extra state to hash", it is a record that should not have been visible, and its presence is itself a violation.

## 9. Park reasons

Closed set: `projection_changed`, `unknown_writer`, `missing_provenance`, `field_not_permitted`, `frozen_prefix_modified`, `projection_version_mismatch`, `cross_project_record`, `provenance_out_of_order`.

## 10. Required implementation tests

- four seats finishing in different orders, none invalidating another;
- sibling status and session updates during a run;
- the host writing another seat's verdict mid-run;
- a reviewer attempting a parent metadata or comment mutation;
- a malicious driver writing an allowed-looking field with no provenance record;
- a late comment append;
- a daemon restart mid-run;
- a schema or projection version mismatch;
- canonical key-order and timestamp variations producing the same digest.

## 11. Acceptance mapping

| #15 criterion | Where it is met |
| --- | --- |
| A parallel four-seat Panel gives no false mutation failure | §4 |
| A reviewer cannot change parent or sibling controlling identity unnoticed | §3, §5 |
| The projection is versioned and in the runtime lock | §7 |
| The canonical hash ignores key order and insignificant timestamps | §7 |
| An unknown or unverifiable mutation fails closed | §5 |
| A gate result is accepted only after the post-run check | §3, §5 |
| Cross-project records never enter the projection | §8 |
