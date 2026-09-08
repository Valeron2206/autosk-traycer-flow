# Approved delta integration contract

<!-- approved-delta-contract:v1 -->

Status: issue #8 design contract. Runtime implementation remains `required_for_v1` after design gate #39.

## 1. Authority

What gets integrated is a delta, not a tree.

Full-tree equality asks "does the staging tree equal the reviewed candidate tree?", and for the second independent Ticket the answer is no — not because anything is wrong, but because the first Ticket's approved work is already there. The check reports a difference that is the *presence of approved work*, which is a false negative on exactly the case the DAG exists to support.

So the reviewed unit is an immutable `approved_delta` computed between the exact Ticket base tree and the reviewed candidate tree, restricted to the declared pathspec. The closed JSON Schema is `resources/approved-delta/approved-delta.schema.json`.

## 2. Boundaries

Issue #7 supplies the base tree the delta is computed against; #9 owns private staging and the single conditional target update; #17 says which integration modes the project allows at all; #6 supplies the declared pathspec. This contract defines what a delta is, what an integration must prove, and what it must refuse.

## 3. A delta is more than a patch

Text is not identity. An entry records the path, the status — `A`, `M`, `D`, `R`, `C` — old and new blob OIDs, old and new file modes, and for a rename or copy the path it came from.

That list is not padding. Each element is a way two "identical" patches differ in effect:

- a **mode** change from `100644` to `100755` has no textual diff at all;
- a **symlink** (`120000`) and a regular file with the same bytes are different objects;
- a **binary** blob has no meaningful text form to compare;
- a **gitlink** (`160000`) points at a commit in another repository, and applying it as text is meaningless;
- a **rename** with an identical blob is a real change that a content-only view sees as nothing.

`delta_digest` covers all of it, plus the base commit, base tree, candidate tree and the pathspec, so a delta cannot be reinterpreted against a different base than the one it was reviewed on.

## 4. What an integration must prove

Not "it applied cleanly" — that is a statement about the tool. Six statements about the result:

1. every approved entry is present in full;
2. inside the Ticket's scope, the operation introduced nothing else;
3. changes already present from other Tickets are preserved;
4. conflict resolution produced no bytes that were not reviewed;
5. the resulting commit and tree are bound to the operation ID and the exact staging base;
6. branch movement satisfied the CAS and reflog invariants.

Point 4 is the one that decides whether this contract means anything. A conflict resolved by producing new content produces bytes nobody reviewed, and no amount of care in choosing them makes them reviewed. The integration refuses instead.

## 5. Revalidation immediately before apply

The delta is revalidated against the staging base *at the moment of apply*, not when it was approved. A staging base that moved between approval and apply is a different base, and a delta approved against the old one has not been approved against this one.

## 6. What is refused rather than worked around

- an ignored or untracked file colliding with an approved entry: **fail closed**, and nothing is deleted to make room. The file is someone's, and "it was in the way" is not a reason to remove it;
- foreign or indeterminate ref movement: classified separately from an ordinary error, and **not retried**. A retry against an unknown post-state is how one uncertain outcome becomes two;
- an inherited Git environment — `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and the rest — neutralised before any operation, because an inherited variable silently redirects every command that follows;
- a dirty worktree, a linked worktree, an autostash configuration: recorded and refused rather than tidied.

Explicitly not in scope: cherry-pick as a hidden fallback, history rewriting, automatic resolution of semantic conflicts, and any runtime call to `traycer-protocol`.

## 7. Durable state

Every phase is recoverable. The operation records its phase, and a crash in any of them resumes rather than restarts: the phase names are part of the schema, not an implementation detail, because "we do not know which phase it died in" is the state that produces double application.

Uncertainty never triggers destructive cleanup. A state file whose identity is reused or collides is refused, not overwritten.

## 8. Parity with the Traycer suite

The adversarial cases are adapted, not copied, and the contract carries a parity table naming each original case and where it is covered. A case that is not yet covered is listed as not covered — an absent row and a passing row must not look the same.

## 9. Park reasons

Closed set: `delta_stale`, `scope_violation`, `untracked_collision`, `ignored_collision`, `foreign_ref_movement`, `indeterminate_post_state`, `reflog_ambiguous`, `inherited_git_env`, `dirty_worktree`, `state_identity_collision`, `unreviewed_bytes`, `containment_mismatch`.

## 10. Required implementation tests

- a second and third independent Ticket integrating with no full-tree false negative;
- rename, copy, mode change, binary, symlink and submodule entries;
- an ignored file and an untracked file colliding with an approved entry;
- an inherited `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE`;
- concurrent and foreign ref movement, and an indeterminate post-state;
- reflog ambiguity;
- a dirty worktree, a linked worktree, an autostash configuration;
- a crash in every phase, and a resume from each;
- a failed merge, an abort, and the recovery path;
- containment against the recorded result OID;
- state-file identity reuse and collision.

## 11. Acceptance mapping

| #8 criterion | Where it is met |
| --- | --- |
| Independent Tickets integrate without a full-tree false negative | §1, §3 |
| The delta is revalidated immediately before apply | §5 |
| Rename, mode, binary, symlink and submodule are correct | §3 |
| Ignored and untracked collisions fail closed and destroy nothing | §6 |
| The inherited Git environment is neutralised | §6 |
| Foreign or indeterminate movement is not retried as an ordinary error | §6 |
| Durable state allows recovery at every phase | §7 |
| The adversarial suite has a parity table | §8 |
| No model moves a ref or resolves an integration conflict | §4, §6 |
