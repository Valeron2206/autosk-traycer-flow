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

- **Planning base** — the exact commit OID recorded for the Epic before the first planning artifact. The closed v1 bootstrap delivery policy requires the trusted host at Planned intake to resolve an explicitly selected local target ref, record its daemon workflow-intake request ID/hash plus ref name and exact current commit/tree, use fixed host identity `autosk-flow <autosk@example.invalid>`, and signing mode `none`. Init records one whole-second UTC producer timestamp at init-operation creation. Each later publication records its own immutable whole-second UTC author/committer/reflog-producer timestamp before prepared; retries replay that operation timestamp. The policy digest is bound to the operation. A project requiring custom identity, another base-selection rule or signed ancestry blocks issue #5 runtime work with `planning_ref_capability_missing` until issue #17 supplies and locks that policy; mutable branch names or ambient Git identity are never substituted.
- **Planning ref** — the private ref above.
- **Planning head** — the commit currently referenced by the verified planning ref.
- **Artifact candidate** — an exact tree built from the current verified planning head plus only the declared artifact pathspec.
- **Candidate keepalive** — the private candidate-identity ref that makes the frozen snapshot commit and its complete tree/blob closure reachable from freeze until verified planning publication or explicit audited supersession.
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

The closed machine contract is `resources/planning-publication/init-planning-ref-operation.schema.json`; `init-planning-ref-operation.example.json` is the verified golden vector. The Schema, example and prose are one behavior contract and are included in the planning design digest.

It first persists a complete `planning_ref_init_op` before touching Git:

```json
{
  "schema": 1,
  "operation_id": "uuid",
  "project_root_sha256": "sha256",
  "epic_id": "uuid",
  "epic_ref_key": "sha256",
  "planning_ref": "refs/autosk/epics/<epic_ref_key>/planning",
  "selected_base_ref": "refs/heads/main",
  "base_selection_policy": "closed object",
  "base_selection_authority": "workflow intake request ID/hash",
  "planning_base_oid": "git-oid",
  "planning_base_tree_oid": "git-oid",
  "object_format": "sha1-or-sha256",
  "bootstrap_policy_digest": "sha256",
  "ref_storage_format": "files",
  "ref_custody_generation": 1,
  "ref_custody_policy_digest": "sha256",
  "reflog_producer": "closed exact Git environment",
  "expected_update_message": "autosk-flow init <operation-id>",
  "phase": "prepared",
  "created_at_utc": "whole-second UTC",
  "receipts": {
    "ref_create": "closed receipt-or-null",
    "verification": "closed receipt-or-null"
  }
}
```

Initialization phases are monotonic:

```text
prepared
→ ref_created
→ verified
```

`bootstrap_policy_digest = SHA-256("autosk-flow/planning-ref-init-policy/v1\0" + canonical JSON {base_selection_authority,base_selection_policy,planning_base_oid,planning_base_tree_oid,selected_base_ref})`. Init receipts use the same self-contained envelope and observation/receipt domains as publication. `ref_create.observation` binds exact planning ref, null missing-old semantic, base new OID, message, empty-prefix digest and one appended raw entry; the raw reflog entry still carries the object-format zero OID; `verification.observation` binds planning ref, base commit/tree and the ref-create receipt hash. Receipt prefixes are closed: prepared has none, ref_created only ref_create, verified both.

`init_planning_ref` then:

1. resolves the canonical repository and project identity;
2. validates that the daemon-attributed workflow intake request selected one explicit local `refs/heads/...` base, stores its request ID/hash, selected ref, exact commit/tree and closed bootstrap policy digest; current branch/CWD and ambient config are not authority;
3. derives `epic_ref_key` from the immutable project/Epic identity and validates the exact private ref;
4. discovers the repository object format and uses Git's object-format-neutral missing-old-value form rather than a hard-coded 40-zero OID;
5. creates the ref with an exact missing-old-value CAS and `--create-reflog`, using the operation-specific reflog message;
6. records `phase=ref_created` only after the ref command has returned or exact ref/reflog observations prove that this operation already created it;
7. reads back the ref, commit, tree and exact reflog tail;
8. records `phase=verified`, then atomically projects `planning.base_oid`, `planning.head_oid`, `planning.head_tree_oid`, `planning.generation=0`, `planning.init_status=verified` and the exact `planning.last_verified_reflog_tail`;
9. only then transitions to `select_next`.

Retry semantics:

- ref absent + valid phase=`prepared`: perform the CAS;
- ref equals the recorded base + exact operation-specific `zero → base` reflog entry: reconstruct the missing receipt and continue idempotently;
- phase=`verified` with exact receipts/ref/tree but incomplete archive/projection: read back only, archive if needed and transition `select_next` with zero Git writes;
- `planning.init_status=verified` with the init operation already archived: validate the archived receipts plus `last_verified_reflog_tail`, then transition `select_next` with zero Git writes;
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

Protected metadata also stores `planning.last_verified_reflog_tail={head_oid,entry_count,prefix_sha256,receipt_hash}`. Verified init and every verified publication atomically replace it with the exact live tail they proved. This check runs before every planning gate and before minting a new operation: host code compares the live ref, entry count and raw-prefix digest to that record. Unknown entries, truncation or move-away-and-back, including same-OID ABA between closed operations, park `planning_ref_foreign_movement`; the next operation may not adopt the changed tail as its checkpoint.

The candidate tree must equal the planning-head tree plus only declared pathspec changes. Dirty, ignored-new, untracked, submodule, mode, symlink, case-normalization, or out-of-scope changes are handled by the existing fail-closed freeze rules.

Mismatch before candidate mint parks with `planning_candidate_base_stale`; no panel child or PASS record is created. If the ref changes after mint, the candidate and every verdict bound to it are stale.

### 5.1 Frozen candidate keepalive

Every artifact and anchor-invalidation candidate is protected before panel dispatch, waiver consumption or publication-operation creation by:

```text
refs/autosk/epics/<epic_ref_key>/candidates/<candidate_identity>
```

Audit retention uses `refs/autosk/epics/<epic_ref_key>/audit/candidates/<candidate_identity>`. A helper transaction transfers the snapshot commit from the live candidate ref to this audit ref on panel/narrow NOT_PASS, terminal void or successful publication release. Candidate/verdict retention therefore keeps the distinct reviewed snapshot commit reachable even after the planning commit owns the accepted tree.

`candidate_identity = SHA-256("autosk-flow/planning-candidate/v1\0" + canonical JSON {anchor_version,candidate_tree_oid,epic_id,kind,pathspec_or_projection_digest,project_root_sha256,snapshot_commit_oid})`. The host recomputes the identity and ref; model text and display IDs never enter either value.

The snapshot commit recipe is deterministic and persisted before the first Git write: exact tree, a single parent equal to the recorded planning head, fixed host author/committer identities, one recorded whole-second timestamp/timezone, fixed message bytes, signing policy, object format, complete commit bytes, byte hash and expected OID. The closed `snapshot_commit_recipe` is required by the authoritative standalone and embedded keepalive Schemas; their validators reconstruct the bytes and Git object hash. The artifact golden vector pins snapshot commit OID `264029a5827e5674dc038091abea2c6df347bd2b` and byte SHA-256 `f98f6871a033cf372824ef4c7d0ec76c60bd969985913baad0654431e12010b1`. Freeze re-entry reads and reuses this recipe and the existing keepalive operation; it never re-mints a timestamp, snapshot commit or candidate identity. A byte/OID mismatch parks `artifact_freeze_invalid` before another ref can be created.

Freeze first persists one closed `candidate_keepalive_op` in protected candidate metadata, before any Git side effect. `resources/planning-publication/candidate-keepalive-operation.schema.json` and its examples are the authoritative machine contract. The publication operation embeds the exact active record; after terminal transfer the same complete record is appended to `planning.candidate_history`, and the publication operation stores the matching full release/audit receipts. The operation binds its UUID, candidate identity/ref, audit ref, object format, snapshot commit/tree, exact sanitized reflog producer/message, empty-ref checkpoint, custody generation/policy and closed receipts. Its active phases are `prepared -> ref_created -> verified`; terminal transitions are `verified -> audit_retained` for rejected/void/superseded candidates and `verified -> released` after verified publication, with both terminal states retaining the snapshot through the audit ref. A released record contains both the full publication release receipt and an audit receipt with `reason=publication_verified`; the two receipts bind the same audit ref/OID and custody generation/policy. From `prepared`, host performs a missing-old CAS that creates the keepalive ref at the snapshot commit using message `autosk-flow keepalive <operation_id>`. A lost response is accepted only when the ref, exact operation-specific create entry and stored producer prove that operation created it. Before `verified`, host parses the snapshot commit, requires its tree to equal `candidate_tree_oid`, enumerates the reachable commit/tree/blob closure and performs connectivity verification. A pre-existing, moved, deleted or move-away-and-back ref is `planning_candidate_keepalive_invalid`; it is never reset or adopted.

The closed create observation is `{after_entry_count:1,appended_entry_sha256,before_entry_count:0,before_prefix_sha256,candidate_identity,expected_update_message,observed_new_oid:snapshot_commit_oid,observed_old_oid:null,operation_id,ref,snapshot_tree_oid}`. `observation_sha256 = SHA-256("autosk-flow/candidate-keepalive-create/v1\0" + canonical JSON observation)` and `receipt_hash = SHA-256("autosk-flow/candidate-keepalive-receipt/v1\0" + canonical JSON {candidate_identity,operation_id,observation_sha256})`. The release receipt is the closed object `{schema,operation_id,candidate_identity,ref,expected_old_oid,planning_ref,verified_commit_oid,planning_reflog_after_receipt_hash,planning_reflog_tail_observation_sha256,transaction_observation_sha256,audit_candidate_ref,audit_candidate_oid,ref_custody_generation,ref_custody_policy_digest,closure_verified:true,receipt_hash}`. `planning_reflog_tail_observation_sha256 = SHA-256("autosk-flow/candidate-keepalive-release-tail/v1\0" + canonical JSON {after_entry_count,appended_entry_sha256,before_prefix_sha256,planning_reflog_after_receipt_hash})`. `transaction_observation_sha256 = SHA-256("autosk-flow/candidate-keepalive-release-transaction/v1\0" + canonical JSON {audit_candidate_oid,audit_candidate_ref,candidate_keepalive_oid,candidate_keepalive_ref,planning_ref,planning_ref_expected_oid,planning_reflog_tail_observation_sha256,ref_custody_generation,ref_custody_policy_digest})`. The receipt hash uses `SHA-256("autosk-flow/candidate-keepalive-release/v1\0" + canonical JSON receipt-without-receipt_hash)`.

`publish-artifact-pass-operation.released.example.json` and `candidate-keepalive-operation.released.example.json` are the literal released-state golden vectors. They pin `planning_reflog_tail_observation_sha256=2a62fc213614230da0e98be3d06e32f4a57373dbbbd30468d88a7db9d4ae2e04`, `transaction_observation_sha256=b52a5b032d82a01975a1665e82c5fef351e2d3de4e7be0259c4723f2dc2bab32` and release `receipt_hash=22974e47283579946191982d83a1195b36352acd0973f7db593f9df6ba5fea67`; tests assert these literal values without calling the digest helpers.

Audit transfer uses `observation_sha256 = SHA-256("autosk-flow/candidate-keepalive-audit-observation/v1\0" + canonical JSON {audit_ref,candidate_identity,live_ref,operation_id,reason,ref_custody_generation,ref_custody_policy_digest,snapshot_commit_oid})` and `receipt_hash = SHA-256("autosk-flow/candidate-keepalive-audit/v1\0" + canonical JSON receipt-without-receipt_hash)`. `candidate-keepalive-operation.audit-retained.example.json` pins observation `0087d4d0fcabdf872c5ba08cd1570ea8bd2cac56a3a1f777b2200f653a500c42` and receipt `d80a5e894090b21ef9803d553af4b91a667adb44d243f1c769ae45312a4fdbdb`.

The candidate ref uses the same files-ref custody and scoped reflog-retention rules as the planning ref. `gc."refs/autosk/epics/*/candidates/*".reflogExpire=never`, `gc."refs/autosk/epics/*/candidates/*".reflogExpireUnreachable=never`, `gc."refs/autosk/epics/*/audit/candidates/*".reflogExpire=never` and `gc."refs/autosk/epics/*/audit/candidates/*".reflogExpireUnreachable=never` are pinned and included in the custody policy digest. Because the verified keepalive points to the snapshot commit, Git GC cannot prune the complete candidate object closure even if every review worktree and pseudoref disappears. Panel/waiver dispatch and `recordArtifactPassAndPreparePublication` require phase=`verified`; the atomic PASS write copies the exact verified keepalive record into the publication operation.

The supported deployment has one enforceable writer boundary for this namespace. Issue #5 owns and packages `autosk-flow-ref-custody` with a closed Unix-socket request/receipt protocol. Only autoskd's non-inheritable daemon capability can authorize a request; model and extension subprocesses cannot. Requests bind operation/candidate/project/Epic, custody generation, nonce, expected refs/OIDs and exact action. A helper-owned OS `flock` serializes each transaction and releases on process death, so stale-lock recovery replays the journaled request rather than deleting a guessed lock. A separate OS account owns `refs/autosk/**`, `logs/refs/autosk/**` and the helper transaction lock; only the pinned helper running as that account can create/update/delete/rename those refs. Extension/model/author/reviewer and ordinary project accounts receive permission denied even if they invoke Git directly, so an uncoordinated writer cannot enter the release race in a supported deployment. Preflight verifies helper binary identity, owner/mode/ACL, files-ref backend, custody generation and an unauthorized-write denial probe. `ref_custody_policy_digest = SHA-256("autosk-flow/ref-custody-policy/v1\0" + canonical JSON {custody_generation,helper_binary_sha256,helper_identity,lock_protocol,logs_namespace,namespace,owner_identity,packed_refs_policy_hash,parent_topology_hash,permission_probe_hash})`; init, keepalive and publication records bind it. Drift retains the keepalive and parks `planning_ref_capability_missing`. A host-local mutex without this separate-account boundary is not a supported implementation and cannot justify release.

The helper protocol is action-discriminated. Its common closed request envelope is `{schema:1,request_id,action:init|create_keepalive|advance_planning|retain_audit|release_to_audit|delete_expired_audit,project_root_sha256,epic_ref_key,operation_id,candidate_identity?,custody_generation,policy_digest,nonce,daemon_capability_receipt_hash,packed_refs_sha256,reflog_producer,reflog_checkpoint,expected_update_message,expected_refs,new_refs}`. `reflog_producer` carries the complete persisted sanitized Git environment and timestamp; `reflog_checkpoint` carries exact before-entry count/prefix digest. Each action has a closed variant that permits only its required ref/OID fields. The common response is `{schema:1,request_id,action,status:committed|not_applied,before_entry_count,after_entry_count,before_prefix_sha256,raw_appended_entry_base64?,appended_entry_sha256?,transaction_observation_sha256,receipt_hash}` and therefore exposes the raw appended entry plus its digest. The helper, never the extension host, executes every `update-ref` touching `refs/autosk/**`; host-side Git recipes below specify helper-side execution.

`resources/planning-publication/ref-custody-helper-contract.schema.json` and `ref-custody-helper-contract.example.json` close the six action variants and pin their literal contract vectors. For action `<action>`, the domains are `autosk-flow/ref-custody/<action>/request/v1\0`, `.../observation/v1\0` and `.../receipt/v1\0`; the canonical request/response required-field sets enter the first two preimages, while the receipt preimage is `{action,request_sha256,transaction_observation_sha256}`. Every action (`init`, `create_keepalive`, `advance_planning`, `retain_audit`, `release_to_audit`, `delete_expired_audit`) therefore has a separately domain-bound request, observation, receipt and literal golden vector. The response returns enough raw appended entry and before/after evidence to recompute transaction values without trusting the helper summary. The daemon capability is a non-inheritable, single-request proof bound to the exact request hash, helper identity and nonce; same-UID processes without that proof are rejected. Lost response recovery reads the fsynced journal using the same nonce and byte-identical request. The helper consumes the nonce and fsyncs the request journal before ref prepare, fsyncs the committed observation/receipt before response, and records `not_applied` durably when validation fails. The journal and Git observations return the one committed receipt or complete the prepared transaction; reused IDs with different bytes, consumed nonce with another request, or an unjournaled stale-lock retry are rejected. Process death releases `flock`; recovery reads the same journaled request and Git observations and never removes a lock file manually.

Protected refs remain loose. Privileged bootstrap migrates existing packed refs to loose refs, pins `gc.packRefs=false`, makes `.git/packed-refs` helper-owned and records its digest, and establishes sticky/ACL parent-directory protection for the `autosk` child names. Before every helper request, preflight scans packed-refs and fails `planning_ref_capability_missing` if any `refs/autosk/**` entry exists. A loose ref absent with packed entry present is planning_ref_capability_missing, never absence/release reconstruction. Ordinary project `git gc` continues with ref packing disabled; direct project-account `git pack-refs` is permission denied. Packed membership, parent topology, maintenance config and denial probes enter the custody policy digest.

Every pre-CAS publication retry revalidates the keepalive ref, creation receipt, snapshot commit/tree and connectivity before object or planning-ref side effects. After phase=`verified`, host proves the published commit/candidate tree complete closure from the planning ref and verifies the recorded planning reflog tail immediately before release under the same ref-custody mutex. Release uses one `git update-ref --stdin` transaction containing `verify <planning_ref> <expected_commit_oid>`, `update <audit_candidate_ref> <snapshot_commit_oid> <zero-oid>` and `delete <candidate_keepalive_ref> <snapshot_commit_oid>`. The release receipt binds both live ref expected values, audit ref/OID, the exact `planning_reflog_after` receipt hash, a domain-separated tail-observation digest and the transaction-observation digest. If planning verification fails, the keepalive remains and the task parks `planning_ref_foreign_movement`. If the response is lost, reconstruction requires the live ref absent, exact audit ref present and the same planning-ref/tail/closure proofs. A packed protected entry is capability failure, never absence. A candidate or audit ref at another OID is foreign movement. A `voided_before_ref` or rejected candidate follows the same atomic live-to-audit transfer and records phase=`audit_retained`; ordinary cleanup preserves that audit ref. The publication transition reaches `select_next` or `prepare_anchor_impact` only after the release receipt is read back.

The release transaction creates the audit ref and deletes the candidate keepalive in the same atomic ref update. Candidate or verdict retention is therefore satisfied by the audit ref until its operator-approved retention expiry; normal cleanup never removes that ref.

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

This boundary requires one daemon-owned atomic capability, `recordArtifactPassAndPreparePublication`, that writes the `ArtifactPassRecord` and immutable phase=`prepared` operation with the exact verified candidate-keepalive binding under one expected metadata head, then reads all three bindings back before transition. If the pinned autoskd/SDK lacks this capability, preflight parks `planning_ref_capability_missing` and runtime implementation of issue #5 remains blocked. Two ordinary CLI calls are not equivalent and cannot be used as a fallback.

If the process crashes after that atomic write but before transition, `record_artifact_pass` detects the byte-identical recorded PASS plus matching open phase=`prepared` operation, reads both back and transitions to `publish_artifact_pass` without creating or rewriting either record.

It does **not**:

- set the kind to completed;
- clear the current artifact;
- close Tickets remediation;
- dispatch Arena or Tickets;
- move the target branch;
- transition directly to `select_next`.

`select_next` has a recovery-first guard: any current valid recorded PASS whose publication is not verified routes to `publish_artifact_pass`. It considers a kind complete only when the operation is verified, `published_commit_oid` remains reachable on the live planning ref first-parent chain, the commit tree equals the recorded candidate tree and current bindings remain exact. Only the newest verified publication must equal `planning.head_oid`; publishing Core Flow therefore does not make the earlier Brief incomplete.

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
    "ref_storage_format": "files",
    "reflog_producer": "closed exact Git environment",
    "candidate_keepalive": "closed verified keepalive record and optional release receipt",
  "payload": {
    "kind": "artifact_pass",
    "artifact_kind": "brief",
    "artifact_identity": "sha256",
    "artifact_pathspec": ["normalized/repository-relative/path"],
    "artifact_pathspec_digest": "sha256",
    "alignment_identity": "sha256",
    "verdict_or_waiver_binding": "closed exact verdict-or-waiver record",
    "verdict_or_waiver_digest": "sha256",
    "recorded_target_step": "select_next"
  },
  "anchor_version": 1,
  "protocol_digest": "sha256",
  "runtime_lock_digest": "sha256",
    "project_instruction_digest": "sha256",
    "governance_mapping_set_digest": "sha256",
    "ref_custody_generation": 1,
    "ref_custody_policy_digest": "sha256",
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
  "effective_target_step": null,
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

Typed observations are closed by kind: `commit_object={object_format,object_oid,object_bytes_sha256}`; `ref_cas={planning_ref,expected_old_oid,observed_new_oid,expected_update_message,candidate_keepalive_ref,candidate_keepalive_oid}`; `reflog_after={before_entry_count,after_entry_count,before_prefix_sha256,appended_entry_sha256}`; `verification={planning_ref,commit_oid,tree_oid,reflog_after_receipt_hash}`. Before recovery or phase advance, deterministic host code must run the generic operation semantic validator over every non-null receipt, recompute both digests from the embedded observation, and compare every observation field to the containing operation: recipe format/OID/byte hash; planning ref/checkpoint old/new/message plus the atomic keepalive verification; checkpoint count/prefix plus exactly one appended entry; and final ref/commit/tree plus the sibling reflog receipt hash. Foreign operation IDs, slot mismatch, extra/missing observation fields, self-consistent substituted observations and phase-prefix mismatches are rejected. The example, its reflog prefix vector and validator tests are golden vectors for these formulas; implementations may not substitute parsed/locale-formatted reflog text.

Every init/publication operation persists a closed `reflog_producer`. Host code launches Git with an empty inherited Git environment and exact `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`, `GIT_COMMITTER_DATE=@<timestamp_seconds> +0000`, `LC_ALL=C`, `TZ=UTC`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_CONFIG_GLOBAL=/dev/null`; the verified common Git directory is supplied explicitly through `--git-dir`, never `GIT_DIR`, `GIT_WORK_TREE` or `GIT_INDEX_FILE`. It passes `-c core.hooksPath=/dev/null` and object-format-neutral expected-old values to Git. Init/keepalive creation uses exact missing-old `update-ref --create-reflog`. Planning publication uses one `git update-ref --stdin --create-reflog -m <expected_update_message>` transaction containing both `verify <candidate_keepalive_ref> <snapshot_commit_oid>` and `update <planning_ref> <new_oid> <old_oid>` before prepare/commit; keepalive movement therefore cannot race between validation and planning CAS. The producer timestamp is recorded once per operation before phase prepared and is replayed unchanged after arbitrary delay. Ambient identity/date/config/hooks are rejected. Phase advance requires exact raw appended-entry bytes to match `planningReflogEntryDigest` or the init equivalent. Golden vectors use epoch zero only for reproducibility; runtime operations use their recorded operation timestamp.

Raw reflog-byte v1 supports only Git `files` ref storage. Preflight records `ref_storage_format=files`; reftable or an unprovable backend parks `planning_ref_capability_missing` before any Git side effect. The repository must pin `gc."refs/autosk/epics/*/planning".reflogExpire=never` and `gc."refs/autosk/epics/*/planning".reflogExpireUnreachable=never`; missing/unprovable retention also parks capability-missing. Unexpected prefix truncation remains foreign/corrupt evidence and is never silently adopted.

The phase=`prepared` example uses `before_entry_count=1`. Its exact raw reflog-prefix bytes are Base64 `MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCAzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzIGF1dG9zay1mbG93IDxhdXRvc2tAZXhhbXBsZS5pbnZhbGlkPiAwICswMDAwCWF1dG9zay1mbG93IGluaXQgMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAwCg==`; the formula above yields `1bc6da7626a695aaec3a38a666cbd1ecb9bbf3032ba04cdb5cc47e9d09b65c42`. The same example pins commit-recipe digest `fb78e2c0d41ba07c70c1d93d9dbc08a548d4a69b765825af33d365a0ca59c46e`, exact commit OID `cc745247722ff2fe151303f31113281e0fcd9c70` and exact commit-bytes SHA-256 `bc6c070b2858aa1ae8f8b3650b8633620a82e0644cc76af9c3e0506df734508f`.

For the example operation, typed `commit_object` observation `{object_bytes_sha256:"bc6c070b2858aa1ae8f8b3650b8633620a82e0644cc76af9c3e0506df734508f",object_format:"sha1",object_oid:"cc745247722ff2fe151303f31113281e0fcd9c70"}` yields `observation_sha256=9167690cbff40fecf1eede9e31f6b06583b61cb9da78032b23fa36bf710946c1`; its receipt preimage yields `receipt_hash=cf2af4b4d98e8d4c228a8058e1013d5181d66248238fe67da4f36f8b660ee29e`.

For artifact PASS, `artifact_pathspec` is a non-empty code-point-sorted unique array of normalized repository-relative POSIX paths: no absolute path, `.` or `..` component, trailing/repeated separator, Git pathspec magic, `.lock` suffix, symlink or implicit glob. `artifact_pathspec_digest = SHA-256("autosk-flow/artifact-pathspec/v1\0" + canonical JSON {artifact_kind,pathspec})`. `verdict_or_waiver_binding` is a closed object with `disposition=pass|waived` and an exact closed `record`: pass stores `{kind:"verdict",verdict_hash}`, waiver stores `{kind:"waiver",waiver_record_id,waiver_record_hash}`. `verdict_or_waiver_digest = SHA-256("autosk-flow/verdict-or-waiver/v1\0" + canonical JSON {artifact_identity,artifact_kind,disposition,record})`; the generic validator recomputes it and host code matches the binding to the retained ArtifactPassRecord before phase advance.

For `payload.kind=anchor_invalidation`, the payload replaces artifact-pass fields with `affected_artifact_kinds` in canonical ArtifactKind order `brief, core_flow, tech_plan, tickets`, a non-empty ordered `projection_mutations` array, approved impact record ID/hash, exact invalidation projection digest and recorded post-publication target step. Each mutation binds artifact kind, remove/replace action, previous projection digest and pathspec digest. `previous_projection_digest = SHA-256("autosk-flow/previous-projection/v1\0" + canonical JSON {artifact_kind,expected_parent_tree_oid,pathspec,pathspec_digest})`; the parent tree plus closed pathspec identifies the exact pre-invalidation bytes, and the generic validator recomputes the digest. `invalidation_projection_digest = SHA-256("autosk-flow/invalidation-projection/v1\0" + canonical JSON {affected_artifact_kinds,projection_mutations})`. The mutation kinds must equal the affected-kind array, and the invalidation candidate tree must differ from its parent. An empty/no-op projection is rejected before operation creation and follows the approved no-bindings/redraft disposition. Unknown payload fields or a payload/operation-type mismatch park `planning_publication_invalid`.

`recorded_target_step` is the nominal success target written with the payload. `effective_target_step` is null before a terminal phase and is atomically recorded as nominal target on ordinary verification or `prepare_anchor_impact` on drift/void. Recovery after a terminal phase follows only this stored effective target; it never re-derives drift or target from mutable metadata.

Only one non-terminal planning-ref operation may exist for an Epic. A second operation, an unknown phase, a mutable identity field, conflicting operation ID or keepalive binding mismatch parks with `planning_publication_invalid`; missing/moved/corrupt keepalive custody parks `planning_candidate_keepalive_invalid` before a planning-ref side effect.

## 8. Deterministic commit recipe

Before phase=`prepared`, trusted host code materializes and read-back verifies the complete recipe:

- repository object format discovered from Git; OIDs are not assumed to be 40 hex;
- tree = exact candidate tree;
- exactly one parent = exact expected planning head;
- author/committer identities = host identities pinned for the Epic by the locked delivery policy, never the model process; the closed v1 bootstrap values are defined in section 3;
- author/committer seconds and timezone = exact persisted values;
- UTF-8 commit message with LF endings, subject `autosk-flow planning publication`, one blank line and a closed trailer set sorted lexicographically by Unicode code point of the complete trailer name. The set is `Autosk-Anchor-Version`, `Autosk-Epic-ID`, `Autosk-Operation-ID`, `Autosk-Payload-Kind`, `Autosk-Project-Instruction-Digest`, `Autosk-Project-Root-SHA256`, `Autosk-Protocol-Digest`, `Autosk-Runtime-Lock-Digest` plus artifact fields `Autosk-Artifact-Identity=artifact_identity`, `Autosk-Verdict-Or-Waiver-Digest=verdict_or_waiver_digest`, or invalidation fields `Autosk-Impact-Digest=approved_impact_record_hash`, `Autosk-Impact-Identity=invalidation_projection_digest`. The listed set is not positional; the sort rule alone determines bytes. Duplicate/unknown/missing trailers are invalid;
- delivery/signing policy digest;
- exact signature header bytes when signing is required;
- exact final commit object bytes and their SHA-256.

The host asks the repository's Git implementation to calculate `expected_commit_oid` from the persisted exact bytes without writing, verifies the parsed tree, parent, author, committer, message and signature fields against the structured recipe, and only then records phase=`prepared`. Actor names/emails forbid CR/LF and Git ident delimiters; email has exactly one `@`. Publication writes those same bytes as a `commit` object and requires Git to return the recorded OID. No post-crash call may regenerate author data, timestamps, message text or signatures from latest configuration.

For signing mode `exact`, `signature_header_base64` decodes to the exact LF-terminated `gpgsig ...` header bytes inserted between the committer header and the blank separator. For mode `none` it is null and no signature header exists. The host constructs the complete commit bytes from structured fields and requires byte-for-byte equality with `commit_object_bytes_base64` before `prepared`.

If the delivery profile requires signed ancestry, the trusted signer must produce the exact replayable signature header before the atomic PASS+operation write; its public signature bytes are stored in the recipe. If this cannot be done without an unrecorded re-sign after a crash, `record_artifact_pass` parks `planning_signing_unavailable` before PASS, operation, Git object or ref side effects. Issue #17 may replace the section 3 bootstrap policy only through a locked exact policy binding.

The commit has no merge parent and cannot include changes outside the candidate tree. No model-authored bytes enter the v1 commit object: its message is exactly the fixed subject, blank line and closed sorted trailers above. `governance_mapping_set_digest` is intentionally operation-only rather than a commit trailer: it remains bound by the immutable operation and retained operation history, is recomputed before every phase advance, and is recoverable with the commit through that typed history. A digest without the complete exact bytes is not a recovery record.

## 9. CAS and verification

`publish_artifact_pass` executes the following idempotent state machine.

| Observation | Action |
| --- | --- |
| phase=`prepared` or phase=`commit_created`, current controlling binding changed before ref movement, ref=expected parent and reflog prefix/count equal checkpoint | atomically set phase=`voided_before_ref`, terminal reason `binding_drift`, recovery target `prepare_anchor_impact`; keep original ArtifactPassRecord disposition/identity, set `publication_status=voided_before_ref`, keep the operation current and ensure pending anchor; repeat publication finalization before any object/ref side effect |
| phase=`prepared`, keepalive ref/receipt/complete snapshot closure exact, publication object absent, ref=expected parent | write exact commit object; verify OID; record `commit_created` |
| phase=`prepared`, keepalive ref/receipt/complete snapshot closure exact, expected publication object already exists, ref=expected parent and reflog prefix equals checkpoint | verify bytes/tree/parent/message; record `commit_created` |
| phase=`commit_created`, expected object was pruned, ref=expected parent and reflog prefix/count equal checkpoint | rewrite the persisted exact commit object bytes, require the same expected OID, retain `commit_created` and continue; this is reconstruction, not a new logical commit |
| phase=`commit_created`, ref=expected parent, keepalive ref=snapshot commit and reflog prefix equals checkpoint | atomically verify the keepalive ref and CAS planning ref from parent to expected commit in one update-ref transaction with `--create-reflog` and the operation-specific message; record `ref_advanced` only after ref/reflog observation |
| phase=`prepared` or phase=`commit_created`, ref=expected commit and exactly one new matching reflog entry follows the checkpoint | reconstruct a successful CAS receipt only after exact commit verification; record `ref_advanced` |
| phase=`ref_advanced`, expected commit/ref/reflog match the recorded operation but current controlling binding changed | verify against the recorded binding, atomically record historical publication `verified`, update planning head/tree/generation and `last_verified_reflog_tail`, ensure pending anchor and transition `prepare_anchor_impact`; no downstream draft/dispatch |
| phase=`ref_advanced`, ref=expected commit and current controlling bindings exact | verify ref, commit, parent, tree, exact commit bytes, trailers and reflog transition; record `verified` |
| phase=`verified`, keepalive still verified | prove the complete closure from the planning ref; in one atomic helper transaction verify the planning ref, create the audit candidate ref at the snapshot commit and delete the live candidate ref by exact old OID; record/reconstruct full release plus audit receipts and remain in publication finalization |
| phase=`verified` with released keepalive and publication-drift pending anchor | repeat exact read-back/finalization and transition `prepare_anchor_impact` |
| phase=`verified` with released keepalive, metadata finalization incomplete | repeat only read-back/finalization and transition to the stored target; never create another commit or move the planning ref |
| phase=`voided_before_ref`, candidate keepalive operation phase=`verified` | atomically transfer live candidate ref to audit ref, record audit receipt and phase=`audit_retained`; never create a publication object or move planning ref |
| phase=`voided_before_ref`, candidate keepalive operation phase=`audit_retained`, recovery target=`prepare_anchor_impact` | archive immutable terminal publication/rebuild records and transition idempotently to `prepare_anchor_impact`; never move planning ref |
| ref=expected parent but reflog prefix/count changed since the checkpoint | park `planning_ref_foreign_movement`; this detects move-away-and-back/ABA instead of repeating CAS |
| ref is neither expected parent nor expected commit, or the reflog contains an unknown transition | park `planning_ref_foreign_movement` |
| expected object exists with recipe/byte mismatch, a post-CAS required object/reflog is corrupt or missing, or observation is indeterminate | park `planning_publication_corrupt`; the recoverable pre-CAS pruned-object row above takes precedence |
| a new correction appears after CAS | do not rewind; complete verification, then process it as a new anchor impact and descendant invalidation |

The CAS uses an exact expected-old value. No fetch-and-retry against a new parent, force update, rebase, merge, cherry-pick, or branch-name inference is allowed.

After phase `verified`, host atomically records:

- `planning.head_oid=expected_commit_oid`;
- `planning.head_tree_oid=candidate_tree_oid`;
- `planning.generation += 1`;
- `planning.last_verified_reflog_tail` from the exact verification receipt;
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

`resources/planning-publication/publish-planning-invalidation-operation.example.json` is the canonical invalidation golden vector. It pins projection mutations, sorted impact trailers, exact message/commit bytes, recipe digest and expected commit OID; the common semantic validator verifies it against the same Schema.

The candidate invalidation tree is based on the current verified planning head and removes or replaces only the exact current projections declared affected by the approved impact map. For the four v1 named artifacts, stale canonical files are removed from the current tree; their accepted bytes remain reachable in earlier planning commits. Issue #14 generalizes the per-artifact projection rule.

`rebuild_anchor` creates the phase=`prepared` invalidation operation and atomically records `anchor_rebuild_op.phase=ready_to_transit`, the publication operation ID and stored post-publication target. A crash before transition therefore re-enters `rebuild_anchor`, reads back the matching open operation and repeats only `publish_planning_invalidation`; it never mints a second operation.

Invalidation executes the full section 9 phase machine, with explicit rows in the canonical transition table. Pre-CAS drift atomically terminalizes the publication operation and rebuild operation as `voided_before_ref`, preserves/creates a bound pending anchor, then transfers the keepalive to `audit_retained`; only then, after the durable audit receipt, does it archive both records and transition to `prepare_anchor_impact`. Post-CAS drift verifies the historical descendant against recorded bindings, updates planning head/tree/generation and sets the rebuild operation to `release_pending`; it keeps both operations current until the verified keepalive is atomically transferred to the audit ref and the durable release/audit receipts exist, only then closing as `closed_with_pending_anchor`, archiving and transitioning to `prepare_anchor_impact`. Ordinary verification follows the same `release_pending -> released -> archive` order, closes as `closed` and follows only the stored effective target. Foreign/ABA recovery resumes through `publish_planning_invalidation` only for operation type anchor_invalidation after signed investigation; unresolved movement permits only cancel. A voided operation never later writes/ref-advances, and a post-CAS operation is never voided or rewound.

If an affected binding is only `recorded_unpublished` or `voided_before_ref`, it is an unpublished affected binding, not a published projection. `prepare_anchor_impact` and `rebuild_anchor` deterministically close it through the no-bindings/redraft path; a first-ever publication void therefore returns to `clarify_alignment` without an `anchor_impact_invalid` loop. If a claimed current published projection mutation is malformed, or the candidate tree equals its parent despite a claimed mutation, no invalidation operation is created and the state parks `anchor_impact_invalid`. v1 does not publish an empty audit-only descendant.

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
- append-only terminal planning publication/init/rebuild history and any voided pre-CAS object during its audit period;
- unexpired audit policy

are retained and protected from cleanup.

Normal Ticket or Epic worktree cleanup does not delete the planning ref, a live candidate keepalive, audit candidate ref or typed append-only operation histories: `planning.init_history` retains terminal init operation/receipts, `planning.candidate_history` retains every released/audit-retained keepalive and its exact audit/release receipts, `planning.publication_history` retains artifact and invalidation operations/recipes/receipts, and `planning.rebuild_history` retains terminal anchor-rebuild dispositions and publication bindings. Cleanup first enumerates the live candidate ref namespace and requires an exact current/history operation for every ref; an orphan ref parks `planning_candidate_keepalive_invalid`. Deletion is a separate operator-approved Housekeeping action after reference inventory and retention expiry. It leaves a tombstone with project/Epic/ref/final-head identity. Git GC may prune the separate unreferenced publication commit object because its exact bytes remain in the protected operation, so retry rewrites those bytes to the same OID before CAS; it may not prune the candidate snapshot commit/tree/blob closure protected by the live or audit ref. Git GC must not make current or post-CAS audit-required planning objects unreachable. Planning, live candidate and audit candidate reflogs retain both scoped expiry values `never`; ordinary maintenance must not truncate their load-bearing prefixes. Unexpected truncation is explicit foreign/corrupt evidence, never normal adoption.

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
14. run Git GC before CAS, reconstruct a pruned publication commit object from persisted exact bytes, and prove the verified candidate keepalive preserves the complete snapshot commit/tree/blob closure after review-worktree cleanup; release it only after verified planning-ref connectivity;
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
25. validate the closed init Schema/example, receipt prefixes, selected-base authority and SHA-1/SHA-256 zero-old proof;
26. delay init/publication CAS and poison ambient Git identity/config while the persisted reflog producer still yields the golden raw entry;
27. retain the planning reflog across ordinary expiry/GC and fail closed on forced truncation;
28. execute every invalidation phase, pre/post-CAS drift, void retry, foreign/ABA resume and rebuild-op closure;
29. reject empty invalidation projection and replay the stored effective target;
30. reject Git ident delimiter emails and verify parsed author/committer;
31. accept files ref storage and fail before side effects for reftable/unprovable backend;
32. keep Brief complete after publishing a later Core Flow descendant by first-parent reachability and exact recorded tree;
33. reject same-OID ABA inserted after one verified operation and before the next operation is minted;
34. re-enter both current phase=`verified` and archived `init_status=verified` with zero Git writes;
35. accept a non-epoch persisted init timestamp while keeping epoch zero exclusive to the golden vector;
36. reject another operation ID or control byte in `expected_update_message`, substituted verdict/waiver bindings and substituted previous-projection digests;
37. route a first-ever `voided_before_ref` publication to deterministic redraft without an `anchor_impact_invalid` loop;
38. move the planning ref and perform same-OID ABA after post-CAS verification but before keepalive release; tail verification or the atomic planning-ref verify must fail, retain the keepalive and park foreign movement;
39. prove direct writes to `refs/autosk/**` and `logs/refs/autosk/**` fail from extension/model/project accounts; owner/mode/helper/generation drift must retain keepalive and park capability-missing before release;
40. migrate or inject protected packed-refs entries and run ordinary `git gc`; packed membership must fail closed, while `gc.packRefs=false` keeps supported maintenance non-breaking;
41. execute panel NOT_PASS -> audit-retained candidate -> replacement PASS -> cleanup/done while both snapshot commits remain reachable through audit refs;
42. crash the ref-custody helper before/after lock, journal, ref prepare and commit; process-death unlock and nonce-bound retry must produce one transaction and one receipt;
43. crash invalidation after phase=verified before release and after release before archive; current operations remain release_pending and archive only after the release receipt.
44. crash artifact publication after live-to-audit transfer but before metadata transition; terminal `released|audit_retained` recovery must run before any active-phase missing-live-ref guard;
45. substitute a self-consistent keepalive create receipt with a forged raw reflog-entry digest; standalone and embedded validators must reject it;
46. abandon a candidate through anchor rebuild, stale alignment, invalid PASS and replacement freeze; each path must transfer it once with `reason=superseded`, leave no orphan live ref and remain discoverable in `planning.candidate_history`;
47. validate all six action-discriminated ref-custody request/response field sets, domains and literal contract vectors; unauthorized same-UID and lost-response retries must yield no second transaction;
48. crash freeze before and after snapshot-object write and keepalive preparation; deterministic snapshot recipe replay must preserve the same commit OID, candidate identity, operation ID and ref.

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
