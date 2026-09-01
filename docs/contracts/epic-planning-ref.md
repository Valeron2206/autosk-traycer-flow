# Epic planning ref and commit-on-PASS contract

<!-- planning-ref-contract:v1 -->

Status: issue #5 design contract. It becomes an accepted input to the repository-wide design candidate only after the exact tree containing it passes the required review and is merged. Runtime implementation remains a separate release-blocking obligation.

## 1. Purpose

Every approved planning artifact must become reachable, ordered Git history before the workflow may draft the next artifact or dispatch Tickets. A model verdict, waiver, task comment, detached snapshot commit, or metadata flag alone is not a published planning result.

The Planned workflow therefore owns one private, append-only Git line per Epic:

```text
refs/autosk/epics/<epic_ref_key>/planning
```

The ref is internal control-plane state. It is never the user's target branch and is never selected by a human-readable ID or slug.

`epic_ref_key = SHA-256("autosk-flow/epic-ref-key/v1\0" + canonical JSON {epic_id, project_root_sha256})`, encoded as 64 lowercase hex characters. Here and below, canonical JSON means recursively sorted object keys by Unicode code point, original array order, JSON number/string/null encoding, no insignificant whitespace, UTF-8 bytes and LF only where a field explicitly contains LF. The closed derivation prevents traversal, ref metacharacters, Unicode/case-fold ambiguity and collisions between equal display IDs in different project/Epic identities. `epic_id` is the immutable UUID stored in Epic metadata; a human display slug is a separate field and never enters this preimage. The host recomputes the key before every ref operation; metadata mismatch is `planning_ref_init_invalid`.

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

- **Planning base** — the exact commit OID recorded for the Epic before the first planning artifact. The closed v1 bootstrap delivery policy requires the trusted host at Planned intake to resolve an explicitly selected local target ref, record that ref name plus its exact current commit/tree as `planning_base_oid`/`planning_base_tree_oid`, use fixed host identity `autosk-flow <autosk@example.invalid>`, record one whole-second UTC timestamp for both author and committer with timezone `+0000`, and use signing mode `none`. Its policy digest is bound to the operation. A project requiring custom identity, another base-selection rule or signed ancestry blocks issue #5 runtime work with `planning_ref_capability_missing` until issue #17 supplies and locks that policy; mutable branch names or ambient Git identity are never substituted.
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

It first persists a complete `planning_ref_init_op` before touching Git:

```json
{
  "schema": 1,
  "operation_id": "uuid",
  "project_root_sha256": "sha256",
  "epic_id": "uuid",
  "epic_ref_key": "sha256",
  "planning_ref": "refs/autosk/epics/<epic_ref_key>/planning",
  "planning_base_oid": "git-oid",
  "planning_base_tree_oid": "git-oid",
  "object_format": "sha1-or-sha256",
  "expected_update_message": "autosk-flow init <operation-id>",
  "phase": "prepared",
  "created_at_utc": "whole-second UTC",
  "receipts": {
    "ref_create": null,
    "verification": null
  }
}
```

Initialization phases are monotonic:

```text
prepared
→ ref_created
→ verified
```

`init_planning_ref` then:

1. resolves the canonical repository and project identity;
2. validates that `planning_base_oid` is a commit in that repository and records its exact tree;
3. derives `epic_ref_key` from the immutable project/Epic identity and validates the exact private ref;
4. discovers the repository object format and uses Git's object-format-neutral missing-old-value form rather than a hard-coded 40-zero OID;
5. creates the ref with an exact missing-old-value CAS and `--create-reflog`, using the operation-specific reflog message;
6. records `phase=ref_created` only after the ref command has returned or exact ref/reflog observations prove that this operation already created it;
7. reads back the ref, commit, tree and exact reflog tail;
8. records `phase=verified`, then atomically projects `planning.base_oid`, `planning.head_oid`, `planning.head_tree_oid`, `planning.generation=0` and `planning.init_status=verified`;
9. only then transitions to `select_next`.

Retry semantics:

- ref absent + valid phase=`prepared`: perform the CAS;
- ref equals the recorded base + exact operation-specific `zero → base` reflog entry: reconstruct the missing receipt and continue idempotently;
- ref equals the base but no matching persisted operation/reflog proof exists: do not adopt it; park `planning_ref_foreign_movement`;
- ref exists at any other OID, the reflog has an unexpected entry, or an ABA move is observed: `planning_ref_foreign_movement`;
- required reflog creation/inspection is unsupported: `planning_ref_capability_missing` before the Epic drafts an artifact;
- expected base missing, not a commit, from another object store, or bound to another project/Epic: `planning_ref_init_invalid`;
- missing/corrupt operation or claimed durable receipt: `planning_ref_init_invalid`;
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

This boundary requires one daemon-owned atomic capability, `recordArtifactPassAndPreparePublication`, that writes the `ArtifactPassRecord` and immutable phase=`prepared` operation under one expected metadata head, then reads both back before transition. If the pinned autoskd/SDK lacks this capability, preflight parks `planning_ref_capability_missing` and runtime implementation of issue #5 remains blocked. Two ordinary CLI calls are not equivalent and cannot be used as a fallback.

If the process crashes after that atomic write but before transition, `record_artifact_pass` detects the byte-identical recorded PASS plus matching open phase=`prepared` operation, reads both back and transitions to `publish_artifact_pass` without creating or rewriting either record.

It does **not**:

- set the kind to completed;
- clear the current artifact;
- close Tickets remediation;
- dispatch Arena or Tickets;
- move the target branch;
- transition directly to `select_next`.

`select_next` has a recovery-first guard: any current valid recorded PASS whose publication is not verified routes to `publish_artifact_pass`. It considers a kind complete only when the operation is verified and the live planning ref still equals its published commit.

## 7. Planning publication operation

The closed machine contract is `resources/planning-publication/publish-artifact-pass-operation.schema.json`; `publish-artifact-pass-operation.example.json` is the canonical phase=`prepared` example. Prose, Schema and example are one contract. A field or enum change is behavior-defining and requires validator/test update plus a new review candidate.

The protected Epic metadata contains exactly one open operation:

```json
{
  "schema": 1,
  "operation_id": "uuid",
  "operation_type": "artifact_pass",
  "project_root_sha256": "sha256",
  "epic_id": "uuid",
  "epic_ref_key": "sha256",
  "planning_ref": "refs/autosk/epics/<epic_ref_key>/planning",
  "payload": {
    "kind": "artifact_pass",
    "artifact_kind": "brief",
    "artifact_identity": "sha256",
    "artifact_pathspec_digest": "sha256",
    "alignment_identity": "sha256",
    "verdict_or_waiver_digest": "sha256",
    "recorded_target_step": "select_next"
  },
  "anchor_version": 1,
  "protocol_digest": "sha256",
  "runtime_lock_digest": "sha256",
  "project_instruction_digest": "sha256",
  "governance_mapping_set_digest": "sha256",
  "expected_parent_oid": "git-oid",
  "expected_parent_tree_oid": "git-oid",
  "candidate_tree_oid": "git-oid",
  "commit_recipe": {
    "schema": 1,
    "object_format": "sha1-or-sha256",
    "tree_oid": "git-oid",
    "parent_oids": ["git-oid"],
    "author": {
      "name_utf8": "host identity",
      "email_ascii": "host@example.invalid",
      "timestamp_seconds": 0,
      "timezone": "+0000"
    },
    "committer": {
      "name_utf8": "host identity",
      "email_ascii": "host@example.invalid",
      "timestamp_seconds": 0,
      "timezone": "+0000"
    },
    "message_utf8_base64": "exact bytes",
    "signing": {
      "mode": "none-or-exact",
      "policy_digest": "sha256",
      "signature_header_base64": null
    },
    "commit_object_bytes_base64": "exact canonical commit bytes",
    "commit_object_bytes_sha256": "sha256"
  },
  "commit_recipe_digest": "sha256",
  "expected_commit_oid": "git-oid",
  "reflog_checkpoint": {
    "before_entry_count": 1,
    "before_prefix_sha256": "1bc6da7626a695aaec3a38a666cbd1ecb9bbf3032ba04cdb5cc47e9d09b65c42",
    "expected_old_oid": "git-oid",
    "expected_new_oid": "git-oid",
    "expected_update_message": "autosk-flow publish <operation-id>"
  },
  "phase": "prepared",
  "terminal_reason": null,
  "recovery_target_step": null,
  "created_at_utc": "whole-second UTC",
  "receipts": {
    "commit_object": null,
    "ref_cas": null,
    "reflog_after": null,
    "verification": null
  }
}
```

Normal phases are monotonic:

```text
prepared
→ commit_created
→ ref_advanced
→ verified
```

`verified` is a successful terminal phase. `voided_before_ref` is the only unsuccessful terminal phase and is legal only while the live ref still equals the expected parent and no ref/reflog receipt proves movement. For every non-void phase `terminal_reason` and `recovery_target_step` are null. A void operation records non-empty `terminal_reason` and exact `recovery_target_step=prepare_anchor_impact`; retry transitions there without moving the ref. A written but unpublished commit object remains operation-bound audit evidence and cannot be silently reused by another operation.

Fields preceding `phase` are write-once. The complete canonical `commit_recipe`, including exact commit object bytes, is persisted and read back before phase=`prepared`; a digest or recomputation from mutable configuration alone is insufficient. Receipts are monotonic, operation-bound and written only by deterministic host code under daemon workflow custody. A retry may advance a phase or reconstruct a missing receipt from exact Git observations; it may not change the recipe, expected parent, candidate tree, expected commit, payload kind or target step.

`project_instruction_digest` is never null in a runtime publication. Issue #12 supplies the current immutable instruction-lock digest, including the deterministic digest of an empty applicable set. Until that capability exists, issue #5 runtime implementation parks `planning_ref_capability_missing` before `record_artifact_pass`; a nullable placeholder is not a fallback.

Each non-null receipt uses the self-contained closed envelope `{schema,operation_id,receipt_kind,observation,observation_sha256,receipt_hash}`. `observation` is the exact typed object retained by the journal, not a mutable external pointer. `receipt_kind` is exactly `commit_object|ref_cas|reflog_after|verification` and must match its slot. `operation_id` must equal the containing operation. Receipt prefixes are phase-closed: `prepared` has none; `commit_created` has only `commit_object`; `ref_advanced` has `commit_object`, `ref_cas` and `reflog_after`; `verified` has all four; `voided_before_ref` has no ref/verification receipt and may retain only a prior `commit_object` receipt. A receipt from another operation or slot is invalid.

All load-bearing digests use the canonical JSON rule from section 1 and exact domain-separated UTF-8 preimages:

- `commit_recipe_digest = SHA-256("autosk-flow/planning-commit-recipe/v1\0" + canonical JSON commit_recipe)`;
- `before_prefix_sha256 = SHA-256("autosk-flow/reflog-prefix/v1\0" || uint64be(before_entry_count) || exact raw LF-terminated reflog prefix bytes)`. The empty-log value hashes the domain plus eight zero bytes and no reflog bytes. Host code resolves the common Git directory, rejects non-regular/symlinked log storage and reads the first exact entry count without newline normalization;
- `appended_entry_sha256 = SHA-256("autosk-flow/reflog-entry/v1\0" || exact raw LF-terminated entry bytes)`, where the entry is exactly `old_oid SP new_oid SP committer_name SP <committer_email> SP timestamp_seconds SP timezone TAB expected_update_message LF` from the persisted operation;
- `observation_sha256 = SHA-256("autosk-flow/planning-observation/v1\0" + receipt_kind + "\0" + canonical JSON typed_observation)`;
- `receipt_hash = SHA-256("autosk-flow/planning-receipt/v1\0" + canonical JSON {observation_sha256, operation_id, receipt_kind, schema})`.

Typed observations are closed by kind: `commit_object={object_format,object_oid,object_bytes_sha256}`; `ref_cas={planning_ref,expected_old_oid,observed_new_oid,expected_update_message}`; `reflog_after={before_entry_count,after_entry_count,before_prefix_sha256,appended_entry_sha256}`; `verification={planning_ref,commit_oid,tree_oid,reflog_after_receipt_hash}`. Before recovery or phase advance, deterministic host code must run the generic operation semantic validator over every non-null receipt, recompute both digests from the embedded observation, and compare every observation field to the containing operation: recipe format/OID/byte hash; planning ref/checkpoint old/new/message; checkpoint count/prefix plus exactly one appended entry; and final ref/commit/tree plus the sibling reflog receipt hash. Foreign operation IDs, slot mismatch, extra/missing observation fields, self-consistent substituted observations and phase-prefix mismatches are rejected. The example, its reflog prefix vector and validator tests are golden vectors for these formulas; implementations may not substitute parsed/locale-formatted reflog text.

The phase=`prepared` example uses `before_entry_count=1`. Its exact raw reflog-prefix bytes are Base64 `MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCAzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzIGF1dG9zay1mbG93IDxhdXRvc2tAZXhhbXBsZS5pbnZhbGlkPiAwICswMDAwCWF1dG9zay1mbG93IGluaXQgMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAwCg==`; the formula above yields `1bc6da7626a695aaec3a38a666cbd1ecb9bbf3032ba04cdb5cc47e9d09b65c42`. The same example pins commit-recipe digest `bfe115216f174b19244a91601ac8719b609ac6ecb243380f4b8e05d498df4cc8`, exact commit OID `220f8a42d7897c5c45fd8a773966e8c2cde33994` and exact commit-bytes SHA-256 `fffa1a2b18a241c35f468507bf3dca39cd010bc825dcc1b4e479ec68267803a7`.

For the example operation, typed `commit_object` observation `{object_bytes_sha256:"fffa1a2b18a241c35f468507bf3dca39cd010bc825dcc1b4e479ec68267803a7",object_format:"sha1",object_oid:"220f8a42d7897c5c45fd8a773966e8c2cde33994"}` yields `observation_sha256=863bbbe1ea26dbbc3f6d1eb7e837151b3a47c3248f5b9566bb42fe62f79ef319`; its receipt preimage yields `receipt_hash=0900511622fb2ffb35b35f985dae50ef3ca12362d44ef152f72cfaedcd68147e`.

For `payload.kind=anchor_invalidation`, the payload replaces artifact-pass fields with an ordered `affected_artifact_kinds`, approved impact record ID/hash, exact invalidation projection digest and recorded post-publication target step. Unknown payload fields or a payload/operation-type mismatch park `planning_publication_invalid`.

Only one non-terminal planning-ref operation may exist for an Epic. A second operation, an unknown phase, a mutable identity field, or conflicting operation ID parks with `planning_publication_invalid`.

## 8. Deterministic commit recipe

Before phase=`prepared`, trusted host code materializes and read-back verifies the complete recipe:

- repository object format discovered from Git; OIDs are not assumed to be 40 hex;
- tree = exact candidate tree;
- exactly one parent = exact expected planning head;
- author/committer identities = host identities pinned for the Epic by the locked delivery policy, never the model process; the closed v1 bootstrap values are defined in section 3;
- author/committer seconds and timezone = exact persisted values;
- UTF-8 commit message with LF endings, subject `autosk-flow planning publication`, one blank line and exactly these case-sensitive trailers sorted by trailer name: `Autosk-Anchor-Version`, `Autosk-Artifact-Identity` or `Autosk-Impact-Identity`, `Autosk-Epic-ID`, `Autosk-Operation-ID`, `Autosk-Payload-Kind`, `Autosk-Project-Instruction-Digest`, `Autosk-Project-Root-SHA256`, `Autosk-Protocol-Digest`, `Autosk-Runtime-Lock-Digest`, `Autosk-Verdict-Or-Waiver-Digest` or `Autosk-Impact-Digest`; duplicate/unknown/missing trailers are invalid;
- delivery/signing policy digest;
- exact signature header bytes when signing is required;
- exact final commit object bytes and their SHA-256.

The host asks the repository's Git implementation to calculate `expected_commit_oid` from the persisted exact bytes without writing, verifies the parsed tree/parent/message/signature fields against the structured recipe, and only then records phase=`prepared`. Publication writes those same bytes as a `commit` object and requires Git to return the recorded OID. No post-crash call may regenerate author data, timestamps, message text or signatures from latest configuration.

For signing mode `exact`, `signature_header_base64` decodes to the exact LF-terminated `gpgsig ...` header bytes inserted between the committer header and the blank separator. For mode `none` it is null and no signature header exists. The host constructs the complete commit bytes from structured fields and requires byte-for-byte equality with `commit_object_bytes_base64` before `prepared`.

If the delivery profile requires signed ancestry, the trusted signer must produce the exact replayable signature header before the atomic PASS+operation write; its public signature bytes are stored in the recipe. If this cannot be done without an unrecorded re-sign after a crash, `record_artifact_pass` parks `planning_signing_unavailable` before PASS, operation, Git object or ref side effects. Issue #17 may replace the section 3 bootstrap policy only through a locked exact policy binding.

The commit has no merge parent and cannot include changes outside the candidate tree. Model output may propose a human summary only before recipe mint; its exact normalized bytes then become immutable recipe input. A digest without the complete exact bytes is not a recovery record.

## 9. CAS and verification

`publish_artifact_pass` executes the following idempotent state machine.

| Observation | Action |
| --- | --- |
| current controlling binding changed before ref movement, ref=expected parent and reflog prefix/count equal checkpoint | atomically set phase=`voided_before_ref`, terminal reason `binding_drift`, recovery target `prepare_anchor_impact`, artifact PASS=`void` and pending anchor; transition `prepare_anchor_impact` before any object/ref side effect |
| phase=`prepared`, object absent, ref=expected parent | write exact commit object; verify OID; record `commit_created` |
| phase=`prepared`, expected object already exists | verify bytes/tree/parent/message; record `commit_created` |
| phase=`commit_created`, expected object was pruned, ref=expected parent and reflog prefix/count equal checkpoint | rewrite the persisted exact commit object bytes, require the same expected OID, retain `commit_created` and continue; this is reconstruction, not a new logical commit |
| phase=`commit_created`, ref=expected parent and reflog prefix equals the persisted checkpoint | CAS ref from parent to expected commit with `--create-reflog` and the operation-specific message; record `ref_advanced` only after ref/reflog observation |
| phase=`prepared` or phase=`commit_created`, ref=expected commit and exactly one new matching reflog entry follows the checkpoint | reconstruct a successful CAS receipt only after exact commit verification; record `ref_advanced` |
| phase=`ref_advanced`, expected commit/ref/reflog match the recorded operation but current controlling binding changed | verify against the recorded binding, atomically record historical publication `verified`, update planning head/tree/generation, ensure pending anchor and transition `prepare_anchor_impact`; no downstream draft/dispatch |
| phase=`ref_advanced`, ref=expected commit and current controlling bindings exact | verify ref, commit, parent, tree, exact commit bytes, trailers and reflog transition; record `verified` |
| phase=`verified` with publication-drift pending anchor and metadata finalization incomplete | repeat exact read-back/finalization and transition `prepare_anchor_impact` |
| phase=`verified`, metadata finalization incomplete | repeat only read-back/finalization; never create another commit or move the ref |
| phase=`voided_before_ref`, recovery target=`prepare_anchor_impact` | retain terminal void and transition idempotently to `prepare_anchor_impact`; never create an object or move the ref |
| ref=expected parent but reflog prefix/count changed since the checkpoint | park `planning_ref_foreign_movement`; this detects move-away-and-back/ABA instead of repeating CAS |
| ref is neither expected parent nor expected commit, or the reflog contains an unknown transition | park `planning_ref_foreign_movement` |
| expected object exists with recipe/byte mismatch, a post-CAS required object/reflog is corrupt or missing, or observation is indeterminate | park `planning_publication_corrupt`; the recoverable pre-CAS pruned-object row above takes precedence |
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
- next step `prepare_anchor_impact` when publication completed against recorded bindings after post-CAS drift, otherwise `select_next`.

## 10. Anchor invalidation without history rewrite

An approved anchor-impact decision never resets the planning ref.

Before redrafting an affected planning artifact, `rebuild_anchor` prepares a `planning_publication_op` with:

```json
{
  "operation_type": "anchor_invalidation",
  "payload": {
    "kind": "anchor_invalidation",
    "affected_artifact_kinds": ["core_flow", "tech_plan", "tickets"],
    "approved_impact_record_id": "uuid",
    "approved_impact_record_hash": "sha256",
    "invalidation_projection_digest": "sha256",
    "recorded_target_step": "clarify_alignment"
  }
}
```

The common parent/tree/recipe/reflog fields and phases are identical to artifact publication. The payload kind is immutable and cannot be reinterpreted as an artifact PASS after recovery.

The candidate invalidation tree is based on the current verified planning head and removes or replaces only the exact current projections declared affected by the approved impact map. For the four v1 named artifacts, stale canonical files are removed from the current tree; their accepted bytes remain reachable in earlier planning commits. Issue #14 generalizes the per-artifact projection rule.

`rebuild_anchor` creates the phase=`prepared` invalidation operation and atomically records `anchor_rebuild_op.phase=ready_to_transit`, the publication operation ID and target `publish_planning_invalidation`. A crash before transition therefore re-enters `rebuild_anchor`, reads back the matching open operation and repeats only that target; it never mints a second operation.

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
- **Issue #12:** the immutable project-instruction lock supplies the required current `project_instruction_digest`; absence of the capability blocks runtime publication rather than producing null.
- **Issue #13:** all operation-journal, object, ref and reflog filesystem access uses the canonical safeProjectFs boundary and its verified-write rules; issue #5 adds no direct path bypass.
- **Issue #14:** Artifact Registry supplies pathspec, invalidation projection and publication policy for additional behavior artifacts.
- **Issue #17:** delivery profile may replace the closed v1 bootstrap target/base, host identity and signing policy from section 3; a stricter project blocks until that exact policy is available.
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
- an open planning publication operation whose exact bytes may need pre-CAS reconstruction;
- unexpired audit policy

are retained and protected from cleanup.

Normal Ticket or Epic worktree cleanup does not delete the planning ref. Deletion is a separate operator-approved Housekeeping action after reference inventory and retention expiry. It leaves a tombstone with project/Epic/ref/final-head identity. Git GC may prune the pre-CAS object because exact bytes remain in the protected operation, but retry must rewrite those bytes to the same OID before CAS. Git GC must not make current or post-CAS audit-required planning objects unreachable.

## 13. Required runtime tests

Implementation of issue #5 is release-blocking and must include at least:

1. initialize from an absent ref;
2. retry when the ref already equals the recorded base;
3. reject a pre-existing mismatched ref;
4. publish Brief → Core Flow → Tech Plan → Tickets as a strict first-parent chain;
5. prove each author/freeze base equals current planning head;
6. prove target ref is unchanged;
7. crash before/after init-operation persist, ref create, init receipt and init metadata finalization;
8. crash before/after publication-operation persist, exact recipe read-back, object write, phase write, CAS, reflog receipt, verification and metadata finalization;
9. recover when ref advanced but phase/receipt did not;
10. reject foreign movement before and after object creation, including ABA move-away-and-back with the same final OID;
11. reject wrong parent/tree/message/signature/exact object bytes/operation trailers;
12. terminally void a stale pre-CAS operation and prove that a post-CAS correction requires descendant invalidation;
13. detect candidate, protocol, runtime, instruction, alignment, impact or verdict drift;
14. run Git GC before CAS and reconstruct a pruned object from persisted exact bytes, then preserve objects while the private ref exists;
15. publish a typed descendant invalidation and later replacement without ref rewind;
16. isolate two Epics in one repository and equal Epic slugs in two project roots;
17. cover unsigned and policy-required exact-signed recipes;
18. cover SHA-1 and SHA-256 object formats where the supported Git matrix permits;
19. reject invalid ref components, case/Unicode collisions, symlinked repository boundaries and inherited Git environment;
20. fail before side effects when reflog or signing capabilities required by the locked policy are unavailable;
21. produce identical outcome with one or many retries;
22. resume every planning park reason only through its registered target and required evidence;
23. verify receipt slot/operation/phase prefixes and every published digest golden vector;
24. retry after atomic PASS+prepared-operation write and after invalidation-operation write without minting a second operation.

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
