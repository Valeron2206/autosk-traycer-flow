# Project instruction lock contract

<!-- project-instructions-lock-contract:v1 -->

Status: issue #12 design contract. Runtime implementation remains `required_for_v1` after design gate #39.

## 1. Authority

Every Epic pins the repository instructions it ran under, once, at Epic start:

```text
docs/autosk/epics/<epic-id>/instructions/project-instructions.lock.json
```

The validated lock from the exact verified publication commit is the only authority for what a model invocation is told about this repository. A file that a provider would load on its own — `CLAUDE.md` because the client is Claude Code, `.cursorrules` because the client is Cursor, a nested `AGENTS.md` because the agent happened to start in that directory — is **not** part of correctness. Provider auto-context is either disabled for the invocation or fully enumerated by the lock; there is no third state.

The reason is not tidiness. Three families reading three different sets of rules produce three different answers to the same question, and the disagreement is invisible: nothing in the transcript says which file the model had. A PASS that cannot name the instruction bytes it was given is not a PASS about this repository.

## 2. Boundaries

Issue #4 owns human alignment gates and the user-authority primitive; the lock consumes decisions, it does not record them. Issue #14 owns the artifact registry that this lock is registered in. Issue #19 compiles the stage carrier that delivers the slice; this contract defines what may be in it, not how it is serialised. Issue #20 owns clearance of the exact outbound body. Issue #26 owns provider capability and the flag that disables auto-context. Issue #17 owns the delivery profile. Issue #25 owns propagation of a late requirement change to work already done.

This contract does not store session state, model output, review verdicts, or the instructions of any other project.

## 3. Discovery

The closed JSON Schema is `resources/project-instructions/project-instructions-lock.schema.json`.

Discovery is a pure function of one Git tree OID and one closed file list. It never reads the working tree, never reads `$HOME`, and never follows a symlink.

1. Start at the canonical project root recorded in the lock. The root is the project identity of issue #10, not `process.cwd()`.
2. Walk the tree in sorted path order. For each directory, test each `supported_filenames` entry in the recorded order.
3. A candidate is admitted only when the tree entry is a regular blob. A symlink, a submodule (`gitlink`), a directory, or any other mode is **recorded as excluded with its mode**, never followed and never silently dropped.
4. A path outside the root, or reachable only through a `..` segment, is not a candidate. There is no lexical prefix test: the tree walk cannot leave the tree, which is why the walk is the mechanism.
5. Discovery stops at `max_discovered_files` and at `max_total_instruction_bytes`. Reaching either is a **park**, not a truncation.

`supported_filenames` is closed. An unsupported instruction-bearing file that exists in the tree is recorded in `excluded` with reason `unsupported_filename`, so the audit shows the repository had it and the run did not use it. Silence would be indistinguishable from absence.

## 4. Scope and applicability

Each admitted file carries the directory it governs — its own parent — and applies to a Ticket when the Ticket's path scope intersects that directory subtree. Applicability is computed against the Ticket's closed path selectors from #6, not against the agent's working directory.

Nested scopes compose from root to leaf: a deeper file does not replace a shallower one, it is appended after it, so the more specific instruction is read last. Two files at the **same** depth with different content and overlapping scope are a `same_depth_conflict`: they have no defined order, and the run parks rather than picking one by directory-entry order.

`applicability` also records role, stage and pathspec bindings, so a compiled slice for a review role can legitimately differ from the one for an implementation role — but only in ways the lock states in advance.

## 5. Recorded bytes and identity

For every admitted file the lock records `path`, `blob_oid`, `mode`, `size_bytes`, `sha256` of the exact bytes, the governed directory, and its ordinal in precedence order. It records `source_commit_oid`, `source_tree_oid` and `object_format`.

`combined_digest` is SHA-256 over the canonical serialisation of the admitted list — ordinal, path, mode, size, sha256 — plus the discovery-algorithm identifier and `supported_filenames`. Two locks with the same `combined_digest` gave every model the same rules; two with different digests did not, whatever their prose says.

`combined_digest` is a binding field of artifact identity, candidate identity and review identity. A verdict recorded under one digest does not transfer to another.

## 6. Precedence

Highest wins, and the order is fixed. The identifiers are the schema's, so prose
and bytes cannot drift apart:

| Rank | Identifier | What it is |
| --- | --- | --- |
| 1 | `user_corrections` | current explicit user corrections and decisions, daemon-attributed (issue #4) |
| 2 | `approved_epic_artifacts` | approved Epic artifacts |
| 3 | `pinned_project_instructions` | the pinned project instruction set — this lock |
| 4 | `governance_protocol` | the autosk governance protocol |
| 5 | `role_stage_contract` | the task-specific role and stage contract |

A conflict between two ranks is resolved by rank. A **material** conflict — one where following the lower rank would change what is built, not merely how it is worded — is recorded in the Decision Log and parks the task to `human`. Load order never decides anything: if two sources of the same rank disagree materially, the run parks.

## 7. Drift

The lock is immutable for the Epic. A change to any admitted file's bytes during the Epic is an **anchor correction**: it creates a pending impact, and every candidate, verdict and PASS whose scope intersects the changed file's governed directory is invalidated. A change to a file the lock excluded, or to one whose governed directory does not intersect the affected scope, may be re-bound — but only by recomputing discovery and showing the new `combined_digest` differs in exactly the excluded entry.

Deleting an admitted file mid-review is drift, not absence: the lock still names it, and the recompute shows it gone.

## 8. Cross-project isolation

The lock records the canonical project root and its identity. A compiled slice is rejected when its lock's project identity is not the identity of the project the invocation belongs to — the same repository checked out at two canonical roots produces two locks and they do not substitute for each other.

Home-level and user-level instruction files are never admitted. `$HOME` is not walked. A file inside the tree that carries a secret is not a special case of admission: `secret_scan_policy` names the scanner and the disposition, and a hit is `excluded` with reason `clearance_required`, so it is visible without being sent.

## 9. Park reasons

Closed set, each carrying the file, the rank and what a human must decide:
`unsupported_filename`, `same_depth_conflict`, `material_conflict`,
`limit_exceeded`, `not_a_regular_blob`, `clearance_required`, `outside_root`,
`identity_mismatch`, `drift_detected`, `discovery_failed`. "Instructions could
not be resolved" is not one of them.

Five of these are also *recordable* in the lock itself, as an `excluded` entry
rather than only as a park: `unsupported_filename`, `not_a_regular_blob`,
`clearance_required`, `limit_exceeded`, `outside_root`. The distinction is
deliberate — a file the discovery skipped is a fact about the tree and belongs in
the lock; `same_depth_conflict`, `material_conflict`, `identity_mismatch`,
`drift_detected` and `discovery_failed` are facts about a run and belong to the
run that parked. Every recordable reason is a park reason; the reverse is not
true, and a validator asserts it.

## 10. Audit

For every invocation the compiled slice is retrievable with, for each included fragment, the source path, blob OID, ordinal, and the rank that placed it. This is what makes the claim in §1 checkable rather than asserted: an auditor can reconstruct exactly what the model was told, and confirm that nothing else was.

## 11. Required implementation tests

- root and nested `AGENTS.md`, composed root-to-leaf;
- two conflicting nested scopes at the same depth park rather than choose;
- `CLAUDE.md` that only one provider would load by default is either admitted for all or admitted for none;
- an admitted file changed, and one deleted, mid-review invalidates the affected PASS;
- a symlinked instruction file and a `..` traversal candidate are excluded with a recorded reason, not followed;
- the same repository at two canonical roots produces two locks that do not substitute;
- provider auto-context enabled versus disabled produces the same compiled slice;
- a secret-bearing tracked file is excluded with `clearance_required` and its bytes never reach a carrier;
- an unsupported instruction file is reported in `excluded`, not silently applied;
- `combined_digest` changes when any admitted byte changes, and does not change when an unrelated file changes.

## 12. Acceptance mapping

| #12 criterion | Where it is met |
| --- | --- |
| Discovery deterministic and documented | §3, plus the schema's closed `discovery_algorithm` and `supported_filenames` |
| Nested scopes applied to Ticket pathspec | §4 |
| No hidden per-provider differences | §1, §8, and the auto-context test in §11 |
| Lock digest in artifact/candidate/review identity | §5 |
| A changed applicable file invalidates the PASS | §7 |
| Cross-project leakage impossible | §8 |
| Unsupported/conflicting source gives a clear park reason | §3, §6, §9 |
| Exact slice and attribution auditable | §10 |
