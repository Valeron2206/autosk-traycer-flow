from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(relative: str, old: str, new: str, label: str) -> None:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{relative}: expected exactly one {label} fragment, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "docs/contracts/epic-planning-ref.md",
    '''It:

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
''',
    '''It first persists a complete `planning_ref_init_op` before touching Git:

```json
{
  "schema": 1,
  "operation_id": "uuid",
  "project_root_sha256": "sha256",
  "epic_id": "uuid",
  "planning_ref": "refs/autosk/epics/<uuid>/planning",
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
3. derives and validates the private ref from the immutable Epic UUID;
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
''',
    "initialization operation",
)

replace_once(
    "docs/contracts/epic-planning-ref.md",
    '''  "artifact_kind": "brief",
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
''',
    '''  "payload": {
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
  "project_instruction_digest": "sha256-or-null",
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
    "before_entry_count": 0,
    "before_prefix_sha256": "sha256-or-empty-log-domain",
    "expected_old_oid": "git-oid",
    "expected_new_oid": "git-oid",
    "expected_update_message": "autosk-flow publish <operation-id>"
  },
  "phase": "prepared",
  "terminal_reason": null,
  "created_at_utc": "whole-second UTC",
  "receipts": {
    "commit_object": null,
    "ref_cas": null,
    "reflog_after": null,
    "verification": null
  }
''',
    "publication operation JSON",
)

replace_once(
    "docs/contracts/epic-planning-ref.md",
    '''Closed phases:

```text
prepared
→ commit_created
→ ref_advanced
→ verified
```

Fields preceding `phase` are write-once. Receipts are monotonic, operation-bound and written only by deterministic host code under daemon workflow custody. A retry may advance a phase or reconstruct a missing receipt from exact Git observations; it may not change the recipe, expected parent, candidate tree, expected commit, operation type or target step.

Only one planning-ref operation may be open for an Epic. A second operation, an unknown phase, a mutable identity field, or conflicting operation ID parks with `planning_publication_invalid`.
''',
    '''Normal phases are monotonic:

```text
prepared
→ commit_created
→ ref_advanced
→ verified
```

`verified` is a successful terminal phase. `voided_before_ref` is the only unsuccessful terminal phase and is legal only while the live ref still equals the expected parent and no ref/reflog receipt proves movement. A written but unpublished commit object remains audit/cleanup evidence and cannot be silently reused by another operation.

Fields preceding `phase` are write-once. The complete canonical `commit_recipe`, including exact commit object bytes, is persisted and read back before phase=`prepared`; a digest or recomputation from mutable configuration alone is insufficient. Receipts are monotonic, operation-bound and written only by deterministic host code under daemon workflow custody. A retry may advance a phase or reconstruct a missing receipt from exact Git observations; it may not change the recipe, expected parent, candidate tree, expected commit, payload kind or target step.

For `payload.kind=anchor_invalidation`, the payload replaces artifact-pass fields with an ordered `affected_artifact_kinds`, approved impact record ID/hash, exact invalidation projection digest and recorded post-publication target step. Unknown payload fields or a payload/operation-type mismatch park `planning_publication_invalid`.

Only one non-terminal planning-ref operation may exist for an Epic. A second operation, an unknown phase, a mutable identity field, or conflicting operation ID parks with `planning_publication_invalid`.
''',
    "publication phase semantics",
)

replace_once(
    "docs/contracts/epic-planning-ref.md",
    '''Before writing a commit object, phase `prepared` stores the complete recipe:

- repository object format discovered from Git; OIDs are not assumed to be 40 hex;
- tree = exact candidate tree;
- one parent = exact expected planning head;
- author/committer identity = host identity pinned for the Epic by project/delivery configuration, never the model process;
- author/committer timestamps = the operation's persisted whole-second timestamp and persisted timezone;
- UTF-8 commit message with fixed line endings;
- sorted, closed trailers containing project hash, Epic ID, artifact kind, artifact identity, anchor version, protocol/runtime/instruction digests, verdict-or-waiver digest and operation ID.

The host constructs canonical commit bytes and asks the repository's Git implementation to calculate the expected OID. The expected OID is persisted before object publication. Writing the same bytes after a crash yields the same object.

The commit has no merge parent and cannot include changes outside the candidate tree. Model output may supply a human summary, but that text is normalized and cannot change the closed identity trailers after `prepared`.
''',
    '''Before phase=`prepared`, trusted host code materializes and read-back verifies the complete recipe:

- repository object format discovered from Git; OIDs are not assumed to be 40 hex;
- tree = exact candidate tree;
- exactly one parent = exact expected planning head;
- author/committer identities = host identities pinned for the Epic by project/delivery configuration, never the model process;
- author/committer seconds and timezone = exact persisted values;
- UTF-8 commit message with fixed line endings and sorted, closed trailers containing project hash, Epic ID, payload kind, artifact/impact identity, anchor version, protocol/runtime/instruction digests, verdict/waiver/impact digest and operation ID;
- delivery/signing policy digest;
- exact signature header bytes when signing is required;
- exact final commit object bytes and their SHA-256.

The host asks the repository's Git implementation to calculate `expected_commit_oid` from the persisted exact bytes without writing, verifies the parsed tree/parent/message/signature fields against the structured recipe, and only then records phase=`prepared`. Publication writes those same bytes as a `commit` object and requires Git to return the recorded OID. No post-crash call may regenerate author data, timestamps, message text or signatures from latest configuration.

If the delivery profile requires signed ancestry, the trusted signer must produce the exact replayable signature header before `prepared`; its public signature bytes are stored in the recipe. If this cannot be done without an unrecorded re-sign after a crash, publication parks `planning_signing_unavailable` before a Git object or ref side effect. Issue #17 owns which signing policy applies.

The commit has no merge parent and cannot include changes outside the candidate tree. Model output may propose a human summary only before recipe mint; its exact normalized bytes then become immutable recipe input. A digest without the complete exact bytes is not a recovery record.
''',
    "deterministic commit recipe",
)

replace_once(
    "docs/contracts/epic-planning-ref.md",
    '''| phase=`commit_created`, ref=expected parent | CAS ref from parent to expected commit; record `ref_advanced` |
| phase=`prepared|commit_created`, ref=expected commit | reconstruct a successful CAS receipt only after exact commit verification; record `ref_advanced` |
| phase=`ref_advanced`, ref=expected commit | verify ref, commit, parent, tree, trailers and all current controlling bindings; record `verified` |
| phase=`verified`, metadata finalization incomplete | repeat only read-back/finalization; never create another commit or move the ref |
| ref is neither expected parent nor expected commit | park `planning_ref_foreign_movement` |
| expected object exists with impossible recipe mismatch, required object is corrupt/missing after a claimed durable phase, or observation is indeterminate | park `planning_publication_corrupt` |
| candidate/alignment/anchor/protocol/runtime/instruction/verdict binding changed before CAS | void recorded PASS, keep audit history and route through the appropriate correction/alignment cycle |
| a new correction appears after CAS | do not rewind; complete verification, then process it as a new anchor impact and descendant invalidation |
''',
    '''| phase=`commit_created`, ref=expected parent and reflog prefix equals the persisted checkpoint | CAS ref from parent to expected commit with `--create-reflog` and the operation-specific message; record `ref_advanced` only after ref/reflog observation |
| phase=`prepared|commit_created`, ref=expected commit and exactly one new matching reflog entry follows the checkpoint | reconstruct a successful CAS receipt only after exact commit verification; record `ref_advanced` |
| phase=`ref_advanced`, ref=expected commit | verify ref, commit, parent, tree, exact commit bytes, trailers, reflog transition and all current controlling bindings; record `verified` |
| phase=`verified`, metadata finalization incomplete | repeat only read-back/finalization; never create another commit or move the ref |
| ref=expected parent but reflog prefix/count changed since the checkpoint | park `planning_ref_foreign_movement`; this detects move-away-and-back/ABA instead of repeating CAS |
| ref is neither expected parent nor expected commit, or the reflog contains an unknown transition | park `planning_ref_foreign_movement` |
| expected object exists with recipe/byte mismatch, required object/reflog is corrupt or missing after a claimed durable phase, or observation is indeterminate | park `planning_publication_corrupt` |
| candidate/alignment/anchor/protocol/runtime/instruction/verdict binding changed before any ref movement and ref/reflog remain at the checkpoint | atomically phase=`voided_before_ref`, artifact PASS=`void`, preserve audit/object evidence and route through the appropriate correction/alignment cycle |
| controlling binding changes when ref/reflog prove expected commit was already published | do not void or rewind; complete verification, then process the change as a new anchor impact and descendant invalidation before any downstream draft/dispatch |
| a new correction appears after CAS | do not rewind; complete verification, then process it as a new anchor impact and descendant invalidation |
''',
    "CAS recovery table",
)

replace_once(
    "docs/contracts/epic-planning-ref.md",
    '''Before redrafting an affected planning artifact, `rebuild_anchor` prepares a `planning_publication_op` with:

```text
operation_type=anchor_invalidation
recorded_target_step=clarify_alignment | present_tickets_breakdown | draft_artifact
```
''',
    '''Before redrafting an affected planning artifact, `rebuild_anchor` prepares a `planning_publication_op` with:

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
''',
    "anchor invalidation payload",
)

replace_once(
    "docs/contracts/epic-planning-ref.md",
    '''7. crash before/after operation persist, object write, phase write, CAS, CAS receipt, verification and metadata finalization;
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
''',
    '''7. crash before/after init-operation persist, ref create, init receipt and init metadata finalization;
8. crash before/after publication-operation persist, exact recipe read-back, object write, phase write, CAS, reflog receipt, verification and metadata finalization;
9. recover when ref advanced but phase/receipt did not;
10. reject foreign movement before and after object creation, including ABA move-away-and-back with the same final OID;
11. reject wrong parent/tree/message/signature/exact object bytes/operation trailers;
12. terminally void a stale pre-CAS operation and prove that a post-CAS correction requires descendant invalidation;
13. detect candidate, protocol, runtime, instruction, alignment, impact or verdict drift;
14. preserve objects through Git GC while the private ref exists;
15. publish a typed descendant invalidation and later replacement without ref rewind;
16. isolate two Epics in one repository and equal Epic slugs in two project roots;
17. cover unsigned and policy-required exact-signed recipes;
18. cover SHA-1 and SHA-256 object formats where the supported Git matrix permits;
19. reject invalid ref components, case/Unicode collisions, symlinked repository boundaries and inherited Git environment;
20. fail before side effects when reflog or signing capabilities required by the locked policy are unavailable;
21. produce identical outcome with one or many retries.
''',
    "runtime test expansion",
)

replace_once(
    "01-core-flows.md",
    '''Если process падает между object write, phase write, CAS, receipt или metadata finalization, retry продолжает ту же operation и тот же expected commit OID. Ref, отличный от expected parent и expected commit, считается foreign movement и паркует Epic с `planning_ref_foreign_movement`; rebase/reset/force/adopt-current запрещены. Candidate, созданный не от current verified head, получает `planning_candidate_base_stale` до panel.
''',
    '''Если process падает между exact recipe persist/read-back, object write, phase write, CAS, reflog receipt или metadata finalization, retry продолжает ту же operation, те же commit bytes и тот же expected commit OID. Ref/reflog, отличные от expected checkpoint/transition, включая move-away-and-back, считаются foreign movement и паркуют Epic с `planning_ref_foreign_movement`; rebase/reset/force/adopt-current запрещены. Candidate, созданный не от current verified head, получает `planning_candidate_base_stale` до panel. Drift до ref movement терминально закрывает operation как `voided_before_ref`; drift после доказанного CAS требует descendant invalidation.
''',
    "core recovery paragraph",
)

replace_once(
    "02-architecture.md",
    '''Общий adapter обслуживает `init_planning_ref`, `publish_artifact_pass` и `publish_planning_invalidation`. Он строит object-format-aware deterministic commit recipe, пишет exact commit object, выполняет expected-old CAS private ref, читает ref/commit/tree обратно и монотонно продвигает `planning_publication_op` через `prepared -> commit_created -> ref_advanced -> verified`. Model process не получает ref capability. Foreign/indeterminate movement не ретраится как обычная ошибка и не разрешается rebase/reset/force fallback.
''',
    '''Общий adapter обслуживает `init_planning_ref`, `publish_artifact_pass` и `publish_planning_invalidation`. До side effect он сохраняет и read-back проверяет полный object-format-aware recipe с exact commit bytes, expected OID, signing-policy binding и reflog checkpoint. Затем пишет только эти bytes, выполняет expected-old CAS private ref с operation-specific reflog entry, читает ref/commit/tree/reflog обратно и монотонно продвигает `planning_publication_op` через `prepared -> commit_created -> ref_advanced -> verified` либо terminal `voided_before_ref`. Model process не получает ref capability. Foreign/ABA/indeterminate movement не ретраится как обычная ошибка и не разрешается rebase/reset/force fallback.
''',
    "architecture adapter hardening",
)

replace_once(
    "03-technical-plan.md",
    '''| init_planning_ref | prepared init operation отсутствует, exact planning base/ref/project binding невалидны | human с park.reason=planning_ref_init_invalid; Git side effects отсутствуют |
| init_planning_ref | ref отсутствует либо уже равен recorded planning base и init operation binding валиден | persist exact operation before side effect; CAS create from zero OID when absent; read-back commit/tree/ref; atomically planning.init_status=verified/head=base/generation=0; select_next |
| init_planning_ref | ref существует на OID, отличном от recorded base | human с park.reason=planning_ref_foreign_movement; reset/delete/adopt запрещены |
''',
    '''| init_planning_ref | prepared init operation отсутствует, exact planning base/ref/project binding невалидны | human с park.reason=planning_ref_init_invalid; Git side effects отсутствуют |
| init_planning_ref | required object-format-neutral create/reflog capability unavailable | human с park.reason=planning_ref_capability_missing; draft/provider side effects отсутствуют |
| init_planning_ref | phase=prepared, ref отсутствует | exact missing-old-value CAS with operation-specific `--create-reflog` message; read ref/reflog; atomically phase=ref_created; init_planning_ref |
| init_planning_ref | phase=prepared|ref_created, ref=recorded base and exact operation-specific zero→base reflog entry exists | reconstruct receipt if needed; read-back commit/tree/ref/reflog; atomically phase=verified and planning.init_status=verified/head=base/generation=0; select_next |
| init_planning_ref | ref=base without matching persisted operation/reflog proof, ref differs, reflog has unknown/ABA entry | human с park.reason=planning_ref_foreign_movement; reset/delete/adopt запрещены |
| init_planning_ref | operation/receipt/claimed durable state corrupt or indeterminate | human с park.reason=planning_ref_init_invalid; no destructive recovery |
''',
    "technical init rows",
)

replace_once(
    "03-technical-plan.md",
    '''| publish_artifact_pass | open operation absent/multiple, identity/recipe/expected parent/tree/OID changed, unknown phase or another planning operation open | human с park.reason=planning_publication_invalid; ref movement отсутствует |
| publish_artifact_pass | phase=prepared and ref=expected parent | write/verify exact deterministic commit object; atomically phase=commit_created; publish_artifact_pass |
| publish_artifact_pass | phase=prepared|commit_created and ref=expected commit with exact object bytes | reconstruct monotonic receipt, atomically phase=ref_advanced; publish_artifact_pass |
| publish_artifact_pass | phase=commit_created and ref=expected parent | expected-old CAS to expected commit; read ref; atomically phase=ref_advanced; publish_artifact_pass |
| publish_artifact_pass | ref neither expected parent nor expected commit | human с park.reason=planning_ref_foreign_movement; no reset/rebase/force/adopt fallback |
| publish_artifact_pass | claimed durable object/ref phase missing, corrupt or indeterminate | human с park.reason=planning_publication_corrupt; operation remains open for explicit recovery |
| publish_artifact_pass | phase=ref_advanced and ref/commit/parent/tree/trailers/current bindings exact | atomically phase=verified, planning head/tree/generation, artifact_pass publication_status=verified/published_commit_oid/op_id; close current Tickets remediation only here; current_artifact=null; select_next |
| publish_artifact_pass | phase=verified and final metadata/transition incomplete | read-back same commit/ref, finalize only missing monotonic projection, select_next |
''',
    '''| publish_artifact_pass | open operation absent/multiple, payload/identity/full recipe/expected parent/tree/OID changed, unknown phase or another non-terminal planning operation open | human с park.reason=planning_publication_invalid; ref movement отсутствует |
| publish_artifact_pass | locked delivery policy requires exact signed recipe but trusted signer/replayable signature bytes unavailable before prepared | human с park.reason=planning_signing_unavailable; object/ref side effects absent |
| publish_artifact_pass | phase=prepared and ref=expected parent and reflog prefix=checkpoint | write persisted exact commit_object_bytes; verify Git returns expected OID; atomically phase=commit_created; publish_artifact_pass |
| publish_artifact_pass | phase=prepared|commit_created and ref=expected commit with exact object bytes and one matching reflog transition | reconstruct monotonic receipts, atomically phase=ref_advanced; publish_artifact_pass |
| publish_artifact_pass | phase=commit_created and ref=expected parent and reflog prefix=checkpoint | expected-old CAS with operation message/create-reflog; read ref/reflog; atomically phase=ref_advanced; publish_artifact_pass |
| publish_artifact_pass | current binding drift before ref movement, ref=expected parent and reflog prefix=checkpoint | atomically phase=voided_before_ref, artifact_pass=void, preserve audit/object evidence; route correction/alignment cycle |
| publish_artifact_pass | current binding drift after expected ref transition is proven | finish exact publication verification; ensure pending_anchor; no downstream draft/dispatch before descendant invalidation |
| publish_artifact_pass | ref neither expected parent nor expected commit, reflog prefix changed while ref returned to parent, or unknown reflog transition exists | human с park.reason=planning_ref_foreign_movement; no reset/rebase/force/adopt fallback |
| publish_artifact_pass | claimed durable recipe/object/ref/reflog phase missing, corrupt or indeterminate | human с park.reason=planning_publication_corrupt; operation remains open for explicit recovery |
| publish_artifact_pass | phase=ref_advanced and ref/commit/exact bytes/parent/tree/signature/trailers/reflog/current bindings exact | atomically phase=verified, planning head/tree/generation, artifact_pass publication_status=verified/published_commit_oid/op_id; close current Tickets remediation only here; current_artifact=null; select_next |
| publish_artifact_pass | phase=verified and final metadata/transition incomplete | read-back same commit/ref/reflog, finalize only missing monotonic projection, select_next |
| publish_artifact_pass | phase=voided_before_ref | idempotently retain void disposition and recorded recovery target; operation is terminal and cannot move ref |
''',
    "technical publication rows",
)

replace_once(
    "03-technical-plan.md",
    '''| rebuild_anchor | affected planning kinds не пусты | bump anchor, re-bind unchanged unaffected passes/alignments только по exact daemon-attributed impact approval, void affected bindings/alignment records; prepare descendant planning_publication_op type=anchor_invalidation from current verified head with exact affected projection and recorded next target; publish_planning_invalidation |
| publish_planning_invalidation | operation invalid, ref foreign, object/receipt corrupt or affected projection differs from approved impact | human с planning_publication_invalid, planning_ref_foreign_movement или planning_publication_corrupt; no rewind/force |
| publish_planning_invalidation | same object/CAS/read-back phases verified | atomically planning head/tree/generation updated, invalidation op closed, current kind=earliest affected/current_cycle full required; recorded target clarify_alignment либо present_tickets_breakdown |
''',
    '''| rebuild_anchor | affected planning kinds не пусты | bump anchor, re-bind unchanged unaffected passes/alignments only by approved impact; void affected bindings; prepare typed descendant planning_publication_op payload.kind=anchor_invalidation with ordered affected kinds, approved impact ID/hash, invalidation projection digest and recorded next target; publish_planning_invalidation |
| publish_planning_invalidation | payload/impact/projection/full recipe invalid, ref/reflog foreign, exact object/receipt corrupt or affected projection differs from approved impact | human с planning_publication_invalid, planning_ref_foreign_movement или planning_publication_corrupt; no rewind/force |
| publish_planning_invalidation | pre-CAS impact/anchor drift and ref/reflog still at checkpoint | terminal phase=voided_before_ref; prepare_anchor_impact; no ref movement |
| publish_planning_invalidation | same exact-byte/object/CAS/reflog/read-back phases verified | atomically planning head/tree/generation updated, invalidation op closed, current kind=earliest affected/current_cycle full required; recorded target clarify_alignment либо present_tickets_breakdown |
''',
    "technical invalidation rows",
)

replace_once(
    "03-technical-plan.md",
    '''`planning_publication_op` имеет operation_type=`artifact_pass|anchor_invalidation`, write-once identity/recipe, phases `prepared -> commit_created -> ref_advanced -> verified`, exact expected parent/tree/commit and monotonic receipts. Ref at expected commit after crash is accepted only after full object verification; any other movement parks `planning_ref_foreign_movement`. Missing/corrupt claimed durable state parks `planning_publication_corrupt`. No rebase/reset/force/cherry-pick/adopt-current recovery exists.
''',
    '''`planning_ref_init_op` имеет phases `prepared -> ref_created -> verified` и требует operation-specific reflog proof before adopting a ref already at base. `planning_publication_op` имеет typed payload=`artifact_pass|anchor_invalidation`, full persisted/read-back exact commit recipe and object bytes, phases `prepared -> commit_created -> ref_advanced -> verified`, terminal `voided_before_ref`, exact expected parent/tree/commit, reflog checkpoint and monotonic receipts. Ref at expected commit after crash is accepted only after full object+reflog verification; changed prefix/ABA/other movement parks `planning_ref_foreign_movement`. Missing/corrupt claimed durable state parks `planning_publication_corrupt`. No re-sign/recompute-from-latest, rebase/reset/force/cherry-pick/adopt-current recovery exists.
''',
    "technical planning summary",
)

replace_once(
    "04-decisions.md",
    '''- Решение: каждый Planned Epic создаёт private append-only `refs/autosk/epics/<epic-uuid>/planning` от immutable planning base. Artifact verdict/waiver сначала получает status recorded_unpublished. Host-only `publish_artifact_pass` строит object-format-aware deterministic single-parent commit, expected-old CAS-продвигает ref и read-back проверяет exact parent/tree/trailers/current bindings; только phase=verified завершает kind и разрешает select_next. Anchor invalidation также публикуется descendant commit через тот же adapter; rewind/reset/force/rebase/adopt-current запрещены.
''',
    '''- Решение: каждый Planned Epic создаёт private append-only `refs/autosk/epics/<epic-uuid>/planning` от immutable planning base, принимая already-at-base только по matching init operation + reflog proof. Artifact verdict/waiver сначала получает status recorded_unpublished. Host-only `publish_artifact_pass` сохраняет полный object-format-aware recipe с exact commit bytes/signing binding/reflog checkpoint, пишет эти bytes, expected-old CAS-продвигает ref и read-back проверяет exact object/parent/tree/signature/trailers/reflog/current bindings; только phase=verified завершает kind и разрешает select_next. Pre-CAS drift терминально `voided_before_ref`; post-CAS drift требует descendant invalidation. Anchor invalidation публикуется typed descendant commit через тот же adapter; rewind/reset/force/rebase/adopt-current запрещены.
''',
    "ADR decision hardening",
)

replace_once(
    "04-decisions.md",
    '''- Recovery: protected `planning_publication_op` имеет write-once recipe и phases `prepared -> commit_created -> ref_advanced -> verified`. Ref at expected commit after crash принимается только после byte/tree/parent verification; иной OID — `planning_ref_foreign_movement`, corrupt/indeterminate durable state — `planning_publication_corrupt`.
''',
    '''- Recovery: protected `planning_ref_init_op` имеет phases `prepared -> ref_created -> verified`; protected `planning_publication_op` имеет typed payload, complete write-once recipe/exact object bytes, reflog checkpoint and phases `prepared -> commit_created -> ref_advanced -> verified` or terminal `voided_before_ref`. Ref at expected commit after crash принимается only after byte/tree/parent/signature/reflog verification; changed reflog prefix catches ABA, иной transition — `planning_ref_foreign_movement`, corrupt/indeterminate durable state — `planning_publication_corrupt`.
''',
    "ADR recovery hardening",
)

replace_once(
    "scripts/validate-planning-ref-design.mjs",
    '''    "planning_publication_op",
    "recorded_unpublished",
    "planning_candidate_base_stale",
    "planning_ref_foreign_movement",
    "planning_publication_corrupt",
''',
    '''    "planning_ref_init_op",
    "ref_created",
    "planning_publication_op",
    "commit_object_bytes_base64",
    "reflog_checkpoint",
    "voided_before_ref",
    "recorded_unpublished",
    "planning_candidate_base_stale",
    "planning_ref_capability_missing",
    "planning_ref_foreign_movement",
    "planning_publication_corrupt",
    "planning_signing_unavailable",
''',
    "validator technical fragments",
)

replace_once(
    "scripts/validate-planning-ref-design.mjs",
    '''    "prepared",
    "commit_created",
    "ref_advanced",
    "verified",
    "planning_ref_foreign_movement",
''',
    '''    "planning_ref_init_op",
    "ref_created",
    "prepared",
    "commit_created",
    "ref_advanced",
    "verified",
    "commit_object_bytes_base64",
    "reflog_checkpoint",
    "voided_before_ref",
    "anchor_invalidation",
    "planning_ref_foreign_movement",
''',
    "validator contract fragments",
)

replace_once(
    "scripts/validate-planning-ref-design.mjs",
    '''  const canonicalPhaseSequence = "prepared\\n→ commit_created\\n→ ref_advanced\\n→ verified";
  if (!contract.includes(canonicalPhaseSequence)) {
    errors.push("planning publication phases are missing or not documented in monotonic order");
  }
''',
    '''  const initPhaseSequence = "prepared\\n→ ref_created\\n→ verified";
  if (!contract.includes(initPhaseSequence)) {
    errors.push("planning-ref initialization phases are missing or not documented in monotonic order");
  }
  const canonicalPhaseSequence = "prepared\\n→ commit_created\\n→ ref_advanced\\n→ verified";
  if (!contract.includes(canonicalPhaseSequence)) {
    errors.push("planning publication phases are missing or not documented in monotonic order");
  }
  if (!contract.includes("complete canonical `commit_recipe`") || !contract.includes("exact commit object bytes")) {
    errors.push("planning publication recovery must persist the complete exact commit recipe, not only a digest");
  }
  if (!contract.includes("`voided_before_ref` is the only unsuccessful terminal phase")) {
    errors.push("planning publication pre-CAS drift must have a terminal void phase");
  }
''',
    "validator semantic guards",
)

replace_once(
    "test/validate-planning-ref-design.test.mjs",
    '''test("publication phase documentation is monotonic", () => {
  const files = fixture();
  files["docs/contracts/epic-planning-ref.md"] = files["docs/contracts/epic-planning-ref.md"].replace(
    "prepared\\n→ commit_created\\n→ ref_advanced\\n→ verified",
    "verified\\n→ ref_advanced\\n→ commit_created\\n→ prepared",
  );
  assert.match(validatePlanningRefDesign(files).join("\\n"), /monotonic order/u);
});
''',
    '''test("initialization and publication phase documentation is monotonic", () => {
  const files = fixture();
  files["docs/contracts/epic-planning-ref.md"] = files["docs/contracts/epic-planning-ref.md"]
    .replace("prepared\\n→ ref_created\\n→ verified", "verified\\n→ ref_created\\n→ prepared")
    .replace("prepared\\n→ commit_created\\n→ ref_advanced\\n→ verified", "verified\\n→ ref_advanced\\n→ commit_created\\n→ prepared");
  const result = validatePlanningRefDesign(files).join("\\n");
  assert.match(result, /initialization phases/u);
  assert.match(result, /publication phases/u);
});

test("digest-only recipe and missing terminal void are rejected", () => {
  const files = fixture();
  files["docs/contracts/epic-planning-ref.md"] = files["docs/contracts/epic-planning-ref.md"]
    .replace("complete canonical `commit_recipe`", "recipe digest")
    .replace("exact commit object bytes", "recomputed commit")
    .replace("`voided_before_ref` is the only unsuccessful terminal phase", "pre-CAS drift is retried");
  const result = validatePlanningRefDesign(files).join("\\n");
  assert.match(result, /complete exact commit recipe/u);
  assert.match(result, /terminal void phase/u);
});
''',
    "validator tests hardening",
)

print("Hardened issue #5 planning-ref contract.")
