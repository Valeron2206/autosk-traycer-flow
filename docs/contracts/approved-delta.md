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

The base commit and tree, the candidate tree and every blob an entry names are objects of one repository, so OIDs of its one object format: 40 lowercase hex characters for sha1, 64 for sha256 (ADR-098). A delta that names two formats is `containment_mismatch` (`validateDelta`, and so revalidation before apply), rather than a blob the apply hands to `update-index`, which would fail as an environment failure.

## 4. What an integration must prove

Not "it applied cleanly" — that is a statement about the tool. Six statements about the result:

1. every approved entry is present in full — except a deletion, which is proven by absence: requiring a deleted path to be present would make an approved deletion impossible to integrate, and a rename is proven by the new path being present *and* the old one gone;
2. inside the Ticket's scope, the operation introduced nothing else — and removed nothing else. A removal is invisible to a check that inspects only the paths that are still there, so what the apply removed is reported rather than inferred;
3. changes already present from other Tickets are preserved;
4. conflict resolution produced no bytes that were not reviewed;
5. the resulting commit and tree are bound to the operation ID and the exact staging base;
6. branch movement satisfied the CAS and reflog invariants.

Point 4 is the one that decides whether this contract means anything. A conflict resolved by producing new content produces bytes nobody reviewed, and no amount of care in choosing them makes them reviewed. The integration refuses instead.

## 5. Revalidation immediately before apply

The delta is revalidated against the staging base *at the moment of apply*, not when it was approved. A staging base that moved between approval and apply is a different base, and a delta approved against the old one has not been approved against this one.

## 5a. How the apply is performed

The tree is assembled in a temporary index, from blobs that already exist in the repository. That is the mechanical form of point 4: `update-index --cacheinfo` refuses an object that is not there, so there is no path by which the integration could invent content. It also means the operator's worktree and index are untouched — an integration that requires a clean checkout is one that cannot run while somebody is working.

The temporary index lives outside the project. An index file left inside it is untracked state that looks like somebody's work, and the next apply would refuse on the collision it created itself.

What the apply reports is read back from the written tree and compared against the base tree, never echoed from the request: an apply that reports what it was asked to do proves nothing about what it did, and *introduced* means introduced by this apply rather than present in the base.

The staging ref is advanced with `--create-reflog`. Git keeps reflogs only for refs under `refs/heads`, `refs/remotes`, `refs/notes` and HEAD, so a private staging ref has none by default — and the movement invariant asks the reflog a question it could not answer. Setting `core.logAllRefUpdates` instead would change how the operator's whole repository behaves.

## 6. What is refused rather than worked around

- an ignored or untracked file colliding with an approved entry: **fail closed**, and nothing is deleted to make room. The file is someone's, and "it was in the way" is not a reason to remove it;
- foreign or indeterminate ref movement: classified separately from an ordinary error, and **not retried**. A retry against an unknown post-state is how one uncertain outcome becomes two;
- an inherited Git environment — `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and the rest — neutralised before any operation, because an inherited variable silently redirects every command that follows;
- a dirty worktree, a linked worktree, an autostash configuration: not the apply's concern, and so not refused by it. The apply runs in a temporary index and neither reads nor writes the operator's worktree or its index; a collision is checked against the worktree because the delta names its paths, so a file of the operator's at an approved path is a conflict with this delta, while a tracked change elsewhere, a linked worktree or an autostash setting is a fact about no approved path. `worktreeErrors` reports them for a caller that must refuse on them, and none does on this path (§9). A caller that tidied them would delete work nobody reviewed, which is the reason none is tidied.

Explicitly not in scope: cherry-pick as a hidden fallback, history rewriting, automatic resolution of semantic conflicts, and any runtime call to `traycer-protocol`.

## 7. Durable state

Every phase is recoverable. The operation records its phase, and a crash in any of them resumes rather than restarts: the phase names are part of the schema, not an implementation detail, because "we do not know which phase it died in" is the state that produces double application.

Uncertainty never triggers destructive cleanup. A state file whose identity is reused or collides is refused, not overwritten.

The apply keeps its identity across a crash (ADR-108). Before the helper is asked to advance the staging ref, the driver records an **apply recipe** in a durable journal, a file per scoped key written atomically and exclusively (temporary file, fsync, `link`, directory fsync: a crash leaves no recipe or a whole one), once per scoped key (the staging ref, the operation id, the base commit and the delta digest — the operation id alone is a free string): the delta digest, the base commit and tree, the composed tree, the commit message, the host identity and dates of the commit, its exact bytes, the identity the request is asked under and the reflog depth and newest entry the apply starts from — and so the OID of the commit, which the fixed identity, dates and encoding make a function of the tree, the parent and the message. A retry that finds the staging ref at that commit, under the helper's own reflog entry, finds its own apply done and completes the result and the receipt from the recipe, asking the helper nothing; at the recorded base with the reflog where the recipe left it, it asks again under the same identity; anywhere else — a ref that moved, or one moved back after the helper committed — it refuses (`epic-staging.md` §7). Where the staging ref went is recorded in the refusal, not guessed: `behind` the base, `beyond` it, or `unrelated`. At `apply_staging` that refusal is `receipt_missing` of `epic-staging.md` §8, not `foreign_ref_movement`: the driver's name for it is not a stop of the graph, which parks the staging line and the receipts no longer agreeing under the one name it has; a recipe or journal that cannot vouch for the apply is the same stop. A rebuild or a re-stage re-applies under a fresh operation, or on a new base, with a recipe and a request pair of its own. `foreign_ref_movement` stays this contract's code for the movement the receipt's own proof finds — the helper refused the swap and observed a ref other than the base — where the result is returned, not thrown; the receipt records it as `prepared`, and the graph's stop for it is `receipt_missing` with `foreign_ref_movement` as its cause, as it is for `indeterminate_post_state` and `reflog_ambiguous` (§9).

## 8. Parity with the Traycer suite

The adversarial cases are adapted, not copied, and the contract carries a parity table naming each original case and where it is covered. A case that is not yet covered is listed as not covered — an absent row and a passing row must not look the same.

## 9. Park reasons

Closed set: `delta_stale`, `scope_violation`, `untracked_collision`, `ignored_collision`, `foreign_ref_movement`, `indeterminate_post_state`, `reflog_ambiguous`, `inherited_git_env`, `dirty_worktree`, `state_identity_collision`, `unreviewed_bytes`, `containment_mismatch`.

These twelve are this contract's names, and the workflow graph does not carry them as park reasons of their own. At `apply_staging` the graph carries four stops an apply can report — `delta_stale`, `receipt_missing`, `environment_failure` (both in `epic-staging.md` §8) and `planning_ref_capability_missing` (`epic-planning-ref.md`) — and every refusal of an apply becomes one of them, the contract's name as its `cause` (debt 13a, R9-3, ADR-109). A name is raised in one of two phases: before the staging ref moves, when `applyDelta` throws the stop, and after the helper was asked, when the result the apply returns fails its proof and the receipt stays `prepared` (`applyOutcome`). The name a step body reports to the graph is the stop, as the fact `apply_outcome` that the predicates of the `apply_staging` edges read; a refusal thrown out of the step instead would fail it, and the daemon would park with no reason, which the factory lets re-enter the same step — a retry, which §6 forbids for foreign or indeterminate movement.

| name | before the ref moves | after the helper was asked | a resume of the stop |
| --- | --- | --- | --- |
| `delta_stale` | `delta_stale`: the base moved, or the digest does not recompute | — | re-enters `apply_staging` and revalidates again; refused until the delta is replaced or approved again |
| `scope_violation` | `delta_stale`: an entry outside the delta's pathspec | `receipt_missing`: the result introduced or removed a path inside the pathspec that the delta did not approve (paths beyond the pathspec are not looked at) | before: re-enters and is refused again; after: re-enters, the result is recovered from the recipe (`recovered_from_recipe`), the proof fails again and the helper is not asked |
| `containment_mismatch` | `delta_stale`: the delta does not assemble as approved (a path twice, a rename with no origin, an unknown status, no new mode, a blob that is not in the repository, blobs of two object formats) | `receipt_missing`: the result does not contain what was approved, or lost another Ticket's work | before: re-enters and is refused again; after: re-enters, the result is recovered from the recipe (`recovered_from_recipe`), the proof fails again and the helper is not asked |
| `unreviewed_bytes` | — (not raised before the ref moves) | `receipt_missing`: the applied bytes are not the approved ones | re-enters; the result is recovered from the recipe (`recovered_from_recipe`), the proof fails again and the helper is not asked |
| `untracked_collision` | `environment_failure`: a file of the operator's at an approved path, nothing deleted | — | re-enters and applies again once the person has moved the file |
| `ignored_collision` | `environment_failure`: as above, an ignored file | — | re-enters and applies again once the person has moved the file |
| `inherited_git_env` | `environment_failure`: a Git variable in the environment | — | re-enters and applies again once the environment is clean |
| `state_identity_collision` | `environment_failure`: the temporary index would sit inside the project | — | re-enters and applies again once the index is placed outside it |
| `dirty_worktree` | — (not raised: the apply runs in a temporary index and `worktreeErrors` has no caller on this path; §6) | — | not raised |
| `foreign_ref_movement` | — (a ref that is not where the apply left it is refused as `receipt_missing` `movement`, §7) | `receipt_missing`: the helper refused the swap and observed a ref other than the base | re-enters; the ref is not at the base or the recipe's commit, so it is refused as `movement` and the helper is not asked |
| `indeterminate_post_state` | — | `receipt_missing`: the ref is absent after the swap (a read of it that fails is `environment_failure`, not this) | re-enters; the ref is not at the base or the recipe's commit, so it is refused as `movement` and the helper is not asked |
| `reflog_ambiguous` | — | `receipt_missing`: the reflog moved by other than one entry, also when the apply is recovered from its recipe | re-enters and reaches the same result from the recipe, asking nothing; the person restores the line (`epic-staging.md` §7) |

A cause names the contract's name whichever stop it rides on, so the person reads `receipt_missing` with `cause: reflog_ambiguous` and the contract says what that is. `custody_request_invalid` is not among the names: it is a host invariant, a request the host cannot form, and no state of any task (`epic-staging.md` §1); it can follow the recipe's save, so it is not "before anything is written". A refusal before the ref moves is not "before anything is asked" either: a resume after a crash finds the helper's commit already made and recovers it from the recipe, and a stop raised on that resume (a file of the operator's now at an approved path) leaves the commit in place.

## 10. Required implementation tests

- a second and third independent Ticket integrating with no full-tree false negative;
- rename, copy, mode change, binary, symlink and submodule entries;
- an ignored file and an untracked file colliding with an approved entry;
- an inherited `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE`;
- concurrent and foreign ref movement, and an indeterminate post-state;
- reflog ambiguity;
- a dirty worktree, a linked worktree, an autostash configuration: reported by `worktreeErrors` and not refused by the apply, which still integrates;
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
