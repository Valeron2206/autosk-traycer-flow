# Epic planning ref and commit-on-PASS contract

<!-- planning-ref-contract:v1 -->

Status: issue #5 design contract. It becomes an accepted input to the repository-wide design candidate only after the exact tree containing it passes the required review and is merged. Runtime implementation remains a separate release-blocking obligation.

## 1. Purpose

Every approved planning artifact must become reachable, ordered Git history before the workflow may draft the next artifact or dispatch Tickets. A model verdict, waiver, task comment, detached snapshot commit, or metadata flag alone is not a published planning result.

The Planned workflow therefore owns one private, append-only Git line per Epic:

```text
refs/autosk/epics/<epic-uuid>/planning
```

The ref is internal control-plane state. It is never the user's target branch and is never selected by a human-readable slug. `<epic-uuid>` is the canonical immutable Epic identifier already bound to `project_root_sha256`; the ref name is derived by a closed encoder and rejects traversal, ref metacharacters, Unicode ambiguity, case-fold collisions, or user-provided path fragments.

## 2. Non-goals

This contract does not:

- define the machine-readable Tickets schema; issue #6 owns it;
- define dependency composition; issue #7 owns it;
- define approved-delta application; issue #8 owns it;
- define private staging and final target promotion; issue #9 owns them;
- authorize a model to move refs;
- move, merge, rebase, reset, or force-update the user's target branch;
- turn Git into a second task-status ledger.

## 3. Terms

- **Planning base** — the exact commit OID recorded for the Epic before the first planning artifact. Issue #17 later defines how delivery policy selects and validates that target/base; until then the value is still immutable input, not the current branch name.
- **Planning ref** — the private ref above.
- **Planning head** — the commit currently referenced by the verified planning ref.
- **Artifact candidate** — an exact tree built from the current verified planning head plus only the declared artifact pathspec.
- **Recorded PASS** — a valid panel or waiver disposition stored by `record_artifact_pass`, but not yet published.
- **Published PASS** — a recorded PASS whose exact candidate tree is the tree of a verified descendant commit at the planning ref.
- **Planning publication** — the host-owned operation that creates the approved commit, advances the private ref with compare-and-swap, reads it back, and marks publication verified.
- **Planning invalidation** — a descendant commit that removes or replaces the current projection of artifacts invalidated by an approved anchor-impact decision while preserving their prior accepted bytes in ancestry.

Every use of “artifact passed” or “planning kind completed” in the Planned state machine means **Published PASS**, not merely a reviewer verdict.

## 4. Initialization

Planned intake executes:

```text
intake
→ init_planning_ref
→ select_next
```

`init_planning_ref` is deterministic host code.

It:

1. resolves the canonical repository and project identity;
2. validates that `planning_base_oid` is a commit in that repository;
3. derives the exact private ref from the immutable Epic UUID;
4. persists a `planning_ref_init_op` before a Git side effect;
5. creates the ref only with CAS from the all-zero OID to `planning_base_oid`;
6. reads back the ref, commit and tree;
7. records `planning.base_oid`, `planning.head_oid`, `planning.head_tree_oid`, `planning.generation=0` and `planning.init_status=verified`;
8. only then transitions to `select_next`.

Retry semantics:

- ref absent + valid prepared operation: perform the CAS;
- ref already equals the recorded base: verify and finish idempotently;
- ref exists at any other OID: `planning_ref_foreign_movement`;
- expected base missing, not a commit, from another object store, or bound to another project/Epic: `planning_ref_init_invalid`;
- no delete/recreate, reset, force update, or “adopt current ref” fallback is allowed.

Quick-flow does not create a planning ref. Quick→Planned replacement creates a new Planned Epic and initializes its ref from the replacement's recorded original base.

## 5. Authoring and freeze base

Each Brief, Core Flow, Tech Plan, Tickets, and later registered behavior-defining artifact author worktree is created from the current verified planning head.

Before author dispatch and again before freeze, host code proves:

```text
candidate.base_commit_oid == planning.head_oid
candidate.base_tree_oid   == planning.head_tree_oid
current planning ref      == planning.head_oid
```

The candidate tree must equal the planning-head tree plus only declared pathspec changes. Dirty, ignored-new, untracked, submodule, mode, symlink, case-normalization, or out-of-scope changes are handled by the existing fail-closed freeze rules.

Mismatch before candidate mint parks with `planning_candidate_base_stale`; no panel child or PASS record is created. If the ref changes after mint, the candidate and every verdict bound to it are stale.

## 6. State-machine boundary

The successful artifact cycle is:

```text
draft_artifact
→ freeze_artifact
→ full panel or permitted narrow review
→ record_artifact_pass
→ publish_artifact_pass
→ select_next
```

`record_artifact_pass` remains responsible for model/waiver validation and Arena/Tickets-specific semantic checks. On success it atomically:

1. writes `artifact_pass[kind]` with `publication_status=recorded_unpublished`;
2. binds the disposition to the exact candidate, alignment, anchor, protocol, runtime and verdict/waiver identity;
3. creates one immutable `planning_publication_op` in phase `prepared`;
4. records the deterministic commit recipe and expected commit OID;
5. transitions only to `publish_artifact_pass`.

It does **not**:

- set the kind to completed;
- clear the current artifact;
- close Tickets remediation;
- dispatch Arena or Tickets;
- move the target branch;
- transition directly to `select_next`.

`select_next` has a recovery-first guard: any current valid recorded PASS whose publication is not verified routes to `publish_artifact_pass`. It considers a kind complete only when the operation is verified and the live planning ref still equals its published commit.

## 7. Planning publication operation

The protected Epic metadata contains exactly one open operation:

```json
{
  "schema": 1,
  "operation_id": "uuid",
  "operation_type": "artifact_pass",
  "project_root_sha256": "sha256",
  "epic_id": "uuid",
  "planning_ref": "refs/autosk/epics/<uuid>/planning",
  "artifact_kind": "brief",
  "artifact_identity": "sha256",
  "artifact_pathspec_digest": "sha256",
  "anchor_version": 1,
  "protocol_digest": "sha256",
  "runtime_lock_digest": "sha256",
  "project_instruction_digest": "sha256-or-null",
  "alignment_identity": "sha256",
  "governance_mapping_set_digest": "sha256",
  "verdict_or_waiver_digest": "sha256",
  "expected_parent_oid": "git-oid",
  "expected_parent_tree_oid": "git-oid",
  "candidate_tree_oid": "git-oid",
  "commit_recipe_digest": "sha256",
  "expected_commit_oid": "git-oid",
  "phase": "prepared",
  "recorded_target_step": "select_next",
  "created_at_utc": "whole-second UTC",
  "receipts": {
    "commit_object": null,
    "ref_cas": null,
    "verification": null
  }
}
```

Closed phases:

```text
prepared
→ commit_created
→ ref_advanced
→ verified
```

Fields preceding `phase` are write-once. Receipts are monotonic, operation-bound and written only by deterministic host code under daemon workflow custody. A retry may advance a phase or reconstruct a missing receipt from exact Git observations; it may not change the recipe, expected parent, candidate tree, expected commit, operation type or target step.

Only one planning-ref operation may be open for an Epic. A second operation, an unknown phase, a mutable identity field, or conflicting operation ID parks with `planning_publication_invalid`.

## 8. Deterministic commit recipe

Before writing a commit object, phase `prepared` stores the complete recipe:

- repository object format discovered from Git; OIDs are not assumed to be 40 hex;
- tree = exact candidate tree;
- one parent = exact expected planning head;
- author/committer identity = host identity pinned for the Epic by project/delivery configuration, never the model process;
- author/committer timestamps = the operation's persisted whole-second timestamp and persisted timezone;
- UTF-8 commit message with fixed line endings;
- sorted, closed trailers containing project hash, Epic ID, artifact kind, artifact identity, anchor version, protocol/runtime/instruction digests, verdict-or-waiver digest and operation ID.

The host constructs canonical commit bytes and asks the repository's Git implementation to calculate the expected OID. The expected OID is persisted before object publication. Writing the same bytes after a crash yields the same object.

The commit has no merge parent and cannot include changes outside the candidate tree. Model output may supply a human summary, but that text is normalized and cannot change the closed identity trailers after `prepared`.

## 9. CAS and verification

`publish_artifact_pass` executes the following idempotent state machine.

| Observation | Action |
| --- | --- |
| phase=`prepared`, object absent, ref=expected parent | write exact commit object; verify OID; record `commit_created` |
| phase=`prepared`, expected object already exists | verify bytes/tree/parent/message; record `commit_created` |
| phase=`commit_created`, ref=expected parent | CAS ref from parent to expected commit; record `ref_advanced` |
| phase=`prepared|commit_created`, ref=expected commit | reconstruct a successful CAS receipt only after exact commit verification; record `ref_advanced` |
| phase=`ref_advanced`, ref=expected commit | verify ref, commit, parent, tree, trailers and all current controlling bindings; record `verified` |
| phase=`verified`, metadata finalization incomplete | repeat only read-back/finalization; never create another commit or move the ref |
| ref is neither expected parent nor expected commit | park `planning_ref_foreign_movement` |
| expected object exists with impossible recipe mismatch, required object is corrupt/missing after a claimed durable phase, or observation is indeterminate | park `planning_publication_corrupt` |
| candidate/alignment/anchor/protocol/runtime/instruction/verdict binding changed before CAS | void recorded PASS, keep audit history and route through the appropriate correction/alignment cycle |
| a new correction appears after CAS | do not rewind; complete verification, then process it as a new anchor impact and descendant invalidation |

The CAS uses an exact expected-old value. No fetch-and-retry against a new parent, force update, rebase, merge, cherry-pick, or branch-name inference is allowed.

After phase `verified`, host atomically records:

- `planning.head_oid=expected_commit_oid`;
- `planning.head_tree_oid=candidate_tree_oid`;
- `planning.generation += 1`;
- `artifact_pass[kind].publication_status=verified`;
- `artifact_pass[kind].published_commit_oid`;
- `artifact_pass[kind].publication_operation_id`;
- Tickets remediation closure only when the verified publication is the current approved Tickets set;
- `current_artifact=null`;
- next step `select_next`.

## 10. Anchor invalidation without history rewrite

An approved anchor-impact decision never resets the planning ref.

Before redrafting an affected planning artifact, `rebuild_anchor` prepares a `planning_publication_op` with:

```text
operation_type=anchor_invalidation
recorded_target_step=clarify_alignment | present_tickets_breakdown | draft_artifact
```

The candidate invalidation tree is based on the current verified planning head and removes or replaces only the exact current projections declared affected by the approved impact map. For the four v1 named artifacts, stale canonical files are removed from the current tree; their accepted bytes remain reachable in earlier planning commits. Issue #14 generalizes the per-artifact projection rule.

`publish_planning_invalidation` uses the same deterministic recipe, CAS and verification adapter. Only after its descendant commit is verified may redrafting begin. The private ref is never rewound or force-updated.

A new accepted version later publishes another descendant commit. History therefore shows:

```text
base
→ Brief v1 PASS
→ Core Flow v1 PASS
→ Tech Plan v1 PASS
→ approved invalidation of Core Flow/Tech Plan
→ Core Flow v2 PASS
→ Tech Plan v2 PASS
→ Tickets PASS
```

## 11. Relationship to downstream issues

- **Issue #6:** the verified Tickets publication commit contains the frozen human-readable Tickets and canonical manifest. Its OID becomes the final `planning_head` for that Tickets version.
- **Issue #7:** every Ticket execution base starts from that exact verified `planning_head`, then composes approved transitive predecessor deltas.
- **Issue #8:** Ticket code is later represented as an approved delta relative to its execution base; planning publication never uses Ticket delta integration.
- **Issue #9:** the private staging line starts from the verified planning head and applies approved Ticket deltas. The target branch remains unchanged until aggregate PASS and final authorization.
- **Issue #10:** runtime/workflow/schema/helper identity used by this operation is pinned and included in the operation binding.
- **Issue #14:** Artifact Registry supplies pathspec, invalidation projection and publication policy for additional behavior artifacts.
- **Issue #17:** delivery profile supplies the trusted target/base and host commit identity policy.
- **Issue #25:** requirement revision supplies the approved semantic impact map; this contract performs only the crash-safe Git publication.

## 12. Retention and cleanup

The planning ref and every commit/object referenced by:

- an active Epic;
- current planning head;
- artifact PASS;
- candidate/verdict;
- Ticket execution base;
- staging/integration operation;
- release/design attestation;
- unexpired audit policy

are retained and protected from cleanup.

Normal Ticket or Epic worktree cleanup does not delete the planning ref. Deletion is a separate operator-approved Housekeeping action after reference inventory and retention expiry. It leaves a tombstone with project/Epic/ref/final-head identity. Git GC must not make current or audit-required planning objects unreachable.

## 13. Required runtime tests

Implementation of issue #5 is release-blocking and must include at least:

1. initialize from an absent ref;
2. retry when the ref already equals the recorded base;
3. reject a pre-existing mismatched ref;
4. publish Brief → Core Flow → Tech Plan → Tickets as a strict first-parent chain;
5. prove each author/freeze base equals current planning head;
6. prove target ref is unchanged;
7. crash before/after operation persist, object write, phase write, CAS, CAS receipt, verification and metadata finalization;
8. recover when ref advanced but phase/receipt did not;
9. reject foreign movement before and after object creation;
10. reject wrong parent/tree/message/operation trailers;
11. detect candidate, protocol, runtime, instruction, alignment or verdict drift;
12. preserve objects through Git GC while the private ref exists;
13. publish a descendant invalidation and later replacement without ref rewind;
14. isolate two Epics in one repository and equal Epic slugs in two project roots;
15. cover SHA-1 and SHA-256 object formats where the supported Git matrix permits;
16. reject invalid ref components, case/Unicode collisions, symlinked repository boundaries and inherited Git environment;
17. produce identical outcome with one or many retries.

## 14. Acceptance mapping for issue #5

- one private ref per Planned Epic: sections 1, 4;
- reachable commit after each artifact PASS: sections 6–9;
- next artifact based on current ref: section 5;
- final verified planning head before Tickets: sections 9, 11;
- no target movement: sections 2, 9, 11;
- planning documents included in final staging: section 11;
- cleanup retention: section 12;
- crash, retry, CAS, foreign movement, rebuild and GC tests: sections 9, 10, 13.

This contract is normative together with the state machine in `03-technical-plan.md`. If a summary or diagram differs, this document and the canonical transition table govern until the repository-wide issue #39 candidate consolidates them.
