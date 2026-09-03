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

Every use of “artifact passed” or “planning kind completed” means **Published PASS**: verified planning publication plus candidate keepalive phase=`released`, candidate audit transfer phase=`verified`, and immutable publication history record. A reviewer verdict or verified-but-unreleased operation is incomplete.

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

The complete object above is persisted verbatim as `candidate_identity_preimage` in standalone and embedded keepalive records and is recomputed before every object/ref/review/history side effect. An identical preimage may deliberately reuse the same candidate identity: if its audit ref already retains the exact snapshot, a new keepalive operation creates only the live ref and later release verifies, rather than overwrites, the existing audit ref; prior verdicts are never reused.

The snapshot commit recipe is deterministic and persisted before the first Git write: it binds the exact tree, single parent, fixed identities/timestamp/message/signing policy, complete commit bytes and expected OID. Before snapshot-object write, the daemon builds a complete commit/tree/blob quarantine pack and persists `candidate_closure_pack_op` under `candidate-closure-pack-operation.schema.json`. Its verified receipt binds the sorted object manifest, real Git pack/index bytes, content-addressed locator, exact `git pack-objects <content-addressed-pack-prefix>` producer, fsync/rename order and successful `git verify-pack`. Recovery runs `git index-pack --stdin` against the verified canonical common ODB, then `git cat-file` verifies every manifest object's type, size and exact-byte SHA-256 before any keepalive ref creation; a detached quarantine path is never treated as already installed. The pack remains until a canonical live or audit ref is verified. Freeze retry reuses the recipe, closure pack and candidate identity. A byte/OID/pack mismatch parks `artifact_freeze_invalid`. The real-Git harness also creates linked worktrees and proves that they share the common ODB while their per-worktree Git directories, `HEAD` and indexes remain distinct.

Closure-pack digests are: `object_oid_set_sha256 = SHA-256("autosk-flow/candidate-closure-pack/object-set/v1\0" + canonical JSON sorted_object_oids)`; `object_manifest_sha256 = SHA-256("autosk-flow/candidate-closure-pack/manifest/v1\0" + canonical JSON {objects})`; `write_receipt.receipt_hash = SHA-256("autosk-flow/candidate-closure-pack/write/v1\0" + canonical JSON {operation_id,candidate_identity,object_manifest_sha256,pack_bytes_sha256,index_bytes_sha256,content_addressed_locator,git_producer,write_order})`; `verification_receipt.receipt_hash = SHA-256("autosk-flow/candidate-closure-pack/verify/v1\0" + canonical JSON {operation_id,candidate_identity,object_manifest_sha256,pack_bytes_sha256,index_bytes_sha256,write_receipt_hash,git_verify_pack,recovery_phases})`.

Snapshot commits and their audit refs are deliberately unsigned internal control-plane custody objects (`snapshot_signing.mode=none`). Issue #17 signed-ancestry profiles apply to the published planning commit chain, not to detached candidate/audit snapshots; snapshot integrity instead comes from the exact recipe/OID, protected ref custody and reviewed candidate binding. A profile that requires signatures on every retained snapshot is a future successor policy and cannot silently reinterpret v1.

`snapshot_object_receipt.receipt_hash = SHA-256("autosk-flow/candidate-snapshot-object/v1\0" + canonical JSON receipt-without-receipt_hash)`. `candidate_supersession_op.helper_transaction_receipt.receipt_hash = SHA-256("autosk-flow/candidate-supersession-helper/v1\0" + canonical JSON receipt-without-receipt_hash)`. The latter preimage includes the supersession operation ID, replacement intent digest, live/audit refs, snapshot OID and audit receipt hash.

Before a supersession helper call, the prepared operation persists `helper_request_binding={schema,supersession_operation_id,replacement_intent_digest,keepalive_operation_id,helper_request_id,helper_nonce,helper_request_body_sha256,binding_hash}`. `binding_hash = SHA-256("autosk-flow/candidate-supersession-request/v1\0" + canonical JSON binding-without-binding_hash)`. The signed helper request continues to use the keepalive operation ID because it owns the live/audit ref transition, while this outer binding makes the supersession operation and replacement intent the unique recovery lookup. A response is accepted only when its journal request ID, nonce and body hash equal this prepared binding and the resulting helper evidence equals the helper transaction receipt.

Freeze first persists one closed `candidate_keepalive_op` in protected candidate metadata, before any Git side effect. `resources/planning-publication/candidate-keepalive-operation.schema.json` and its examples are the authoritative machine contract. The standalone candidate operation is authoritative for prepared -> object_written -> ref_created -> verified. A publication operation may be created only from verified and embeds the same terminal-capable projection restricted to verified, audit_retained or released; identity and recipe fields never change while terminal phase and receipt slots advance monotonically. After terminal transfer the complete record is appended to `planning.candidate_history`. Released publication embeds both full release and `publication_verified` audit receipts; a voided/rejected/superseded publication uses the authoritative `audit_retained` record and its reason-specific audit receipt. The operation binds its UUID, candidate identity/ref, audit ref, object format, snapshot commit/tree, exact sanitized reflog producer/message, empty-ref checkpoint, custody generation/policy and closed receipts. Its active phases are `prepared -> object_written -> ref_created -> verified`; terminal transitions are `verified -> audit_retained` for rejected/void/superseded candidates and `verified -> released` after verified publication, with both terminal states retaining the snapshot through the audit ref. From `prepared`, host writes only the persisted snapshot commit bytes, reads back exact bytes/tree/parent/OID and records `snapshot_object_receipt`; an already exact object reconstructs that receipt with zero writes, while mismatch parks before any ref. Only phase `object_written` may perform the missing-old CAS that creates the keepalive ref using message `autosk-flow keepalive <operation_id>`. A lost response is accepted only when the ref, exact operation-specific create entry and stored producer prove that operation created it. Before `verified`, host parses the snapshot commit, requires its tree to equal `candidate_tree_oid`, enumerates the reachable commit/tree/blob closure and performs connectivity verification. A pre-existing, moved, deleted or move-away-and-back ref is `planning_candidate_keepalive_invalid`; it is never reset or adopted.

The closed create observation is `{after_entry_count:1,appended_entry_sha256,before_entry_count:0,before_prefix_sha256,candidate_identity,expected_update_message,observed_new_oid:snapshot_commit_oid,observed_old_oid:null,operation_id,ref,snapshot_tree_oid}`. `observation_sha256 = SHA-256("autosk-flow/candidate-keepalive-create/v1\0" + canonical JSON observation)` and `receipt_hash = SHA-256("autosk-flow/candidate-keepalive-receipt/v1\0" + canonical JSON {candidate_identity,operation_id,observation_sha256})`. The release receipt is the closed object `{schema,operation_id,candidate_identity,ref,expected_old_oid,planning_ref,verified_commit_oid,planning_reflog_after_receipt_hash,planning_reflog_tail_observation_sha256,transaction_observation_sha256,audit_candidate_ref,audit_candidate_oid,ref_custody_generation,ref_custody_policy_digest,closure_verified:true,receipt_hash}`. `planning_reflog_tail_observation_sha256 = SHA-256("autosk-flow/candidate-keepalive-release-tail/v1\0" + canonical JSON {after_entry_count,appended_entry_sha256,before_prefix_sha256,planning_reflog_after_receipt_hash})`. `transaction_observation_sha256 = SHA-256("autosk-flow/candidate-keepalive-release-transaction/v1\0" + canonical JSON {audit_candidate_oid,audit_candidate_ref,candidate_keepalive_oid,candidate_keepalive_ref,planning_ref,planning_ref_expected_oid,planning_reflog_tail_observation_sha256,ref_custody_generation,ref_custody_policy_digest})`. The receipt hash uses `SHA-256("autosk-flow/candidate-keepalive-release/v1\0" + canonical JSON receipt-without-receipt_hash)`.

`verification_receipt.receipt_hash = SHA-256("autosk-flow/candidate-keepalive-verification/v1\0" + canonical JSON {operation_id,ref,observed_oid,reflog_tail_observation_sha256,helper_evidence})`. The ref equals the operation ref, observed OID equals snapshot commit OID, the tail observation equals the create receipt observation hash, and helper evidence equals the create receipt evidence.

`publish-artifact-pass-operation.released.example.json` and `candidate-keepalive-operation.released.example.json` contain the identical authoritative released keepalive bytes. They pin `planning_reflog_tail_observation_sha256=27be28cc5847c20cc5acad8897b5e964d574d8de4102fd509f33959db06885ad`, `transaction_observation_sha256=301d0f72ea98218cabf0e9840799a190737c01ecc831c877e77005f0c92ef371` and release `receipt_hash=49f6f9d8a282509d9400f1c518165de76ea5c9cefa7cd669dd74d5d8cb35369d`; tests assert these literal values and reject standalone/embedded divergence.

Audit transfer uses `observation_sha256 = SHA-256("autosk-flow/candidate-keepalive-audit-observation/v1\0" + canonical JSON {audit_ref,candidate_identity,live_ref,operation_id,reason,ref_custody_generation,ref_custody_policy_digest,snapshot_commit_oid})` and `receipt_hash = SHA-256("autosk-flow/candidate-keepalive-audit/v1\0" + canonical JSON receipt-without-receipt_hash)`. `candidate-keepalive-operation.audit-retained.example.json` pins observation `10b07279df5a3115180825eb6ab6ffaedf7942addc6093b4bbde1d2b234a0d55` and receipt `53272670b800cce3e568cf720a91c48c41ea2ced0b51ec2c1396e8cd20051e7a`.

The candidate ref uses the same files-ref custody and scoped reflog-retention rules as the planning ref. `gc."refs/autosk/epics/*/candidates/*".reflogExpire=never`, `gc."refs/autosk/epics/*/candidates/*".reflogExpireUnreachable=never`, `gc."refs/autosk/epics/*/audit/candidates/*".reflogExpire=never` and `gc."refs/autosk/epics/*/audit/candidates/*".reflogExpireUnreachable=never` are pinned and included in the custody policy digest. Because the verified keepalive points to the snapshot commit, Git GC cannot prune the complete candidate object closure even if every review worktree and pseudoref disappears. Panel/waiver dispatch and `recordArtifactPassAndPreparePublication` require phase=`verified`; the atomic PASS write copies the exact verified keepalive record into the publication operation.

The supported deployment has one service-owned canonical project common Git directory and object database for target, planning, candidate and audit refs. It is not an alternate repository and never relies on alternates to user-owned objects. Each model/author worktree has its own service-managed per-worktree Git directory for `HEAD`, index and worktree state; its read-only gitfile points there, and that directory has a read-only `commondir` binding to the one common ODB. Worktrees therefore never share mutable `HEAD` or index files. autoskd mediates allowed normal Git operations, while only `autosk-flow-ref-custody` writes `refs/autosk/**`. Thus any verified planning/live/audit ref protects objects in the same ODB that helper-owned GC traverses. Ancestors are descriptor-pinned and non-writable by project/model accounts; direct mutation receives permission denied. Linux/macOS bootstrap proves topology and peer credentials; other layouts fail closed.

Issue #5 owns the packaged ref-custody helper, its client, install policy, signed wire protocol and recovery journal; later runtime issues consume this contract rather than defining another writer.

The machine policy is `ref-custody-policy.schema.json`. Its subhashes are `parent_topology_hash = SHA-256("autosk-flow/ref-custody-policy-parent-topology/v1\0" + canonical JSON parent_topology)`, `permission_probe_hash = SHA-256("autosk-flow/ref-custody-policy-permission-probes/v1\0" + canonical JSON permission_probes)` and `packed_refs_policy_hash = SHA-256("autosk-flow/ref-custody-policy-packed-refs/v1\0" + canonical JSON packed_refs_policy)`. Its exact top-level binding is `policy_digest = SHA-256("autosk-flow/ref-custody-policy/v1\0" + canonical JSON policy-without-policy_digest)`. The policy contains the macOS/launchd/`getpeereid` and Linux/systemd/`SO_PEERCRED` profiles, the single common-ODB identity, packaging signature, parent topology, denied mutation probes, protected packed-ref policy, bootstrap receipt and generation-bound upgrade/rollback rules. Every helper request carries this exact digest; mismatch parks `planning_ref_capability_missing` before any Git write.

The helper protocol is action-discriminated. `resources/planning-publication/ref-custody-helper-contract.schema.json` and its example are only the protocol-shape/version pin; their field-set digests are named contract vectors and are never runtime transaction evidence. Every `request-shape`, `response-shape` and `receipt-shape` domain ends in one actual NUL byte; JSON renders that byte as `\u0000`, never as the two literal characters backslash and zero. Actual messages are governed by `resources/planning-publication/ref-custody-helper-wire.schema.json` and eight concrete independent exchanges covering six action types in `ref-custody-helper-wire.example.json`. A request body closes `{schema,request_id,action,project_root_sha256,epic_id,epic_ref_key,operation_id,candidate_identity,custody_generation,policy_digest,object_format,transfer_mode,nonce,packed_refs_sha256,expected_update_message,reflog_producer,reflog_checkpoints,ref_updates}`. `body_sha256 = SHA-256("autosk-flow/ref-custody/request-body/v1\0" + canonical JSON body)` excludes its own digest and authorization. Retain/release is never an aggregate multi-ref helper request: `ensure_audit_ref` first verifies live and creates or verifies audit, its signed journal receipt is committed, then a different request ID and nonce authorize `delete_live_ref` to verify audit and delete live by expected-old. The signed OID set is object-format closed: every non-null OID in updates and observations, and both OIDs in every raw reflog entry, must have one common width. Mixed-width requests are invalid before Git execution; the enclosing operation declares the same object format.

The closed action roster is `init`, `create_keepalive`, `advance_planning`, `ensure_audit_ref`, `delete_live_ref`, `delete_expired_audit`; the contract example carries a literal golden vector for each action. `delete_expired_audit` uses exact update message `autosk-flow housekeeping <operation_id>`. Transfer uses two separately signed and journaled requests: `ensure_audit_ref` must verify the live ref while it creates or verifies the audit ref, and only its committed receipt authorizes the later `delete_live_ref` expected-old deletion.

`init`, `create_keepalive`, `advance_planning`, `ensure_audit_ref`, `delete_live_ref` and `delete_expired_audit` each have a concrete value-bound golden vector. Retain and release modes each contribute their own `ensure_audit_ref` and `delete_live_ref` exchanges. The wire files declare `composition=independent_golden_exchanges`: entries are byte-level action examples with their own pre-state, not one sequential repository transcript, so no exchange consumes a prior example's post-state. The test harness separately executes create, verify, update and delete transactions in one temporary real `files` repository for SHA-1 and, when supported by the installed Git, SHA-256; it verifies sequential ref/reflog continuity, raw reflog structure, unchanged verification and physical reflog removal after ref deletion.

Authorization is a closed Ed25519 record `{scheme:"ed25519",key_id,public_key_sha256,request_body_sha256,nonce,signature_base64}`. The pinned helper verifies the signature over exact bytes `"autosk-flow/ref-custody-authorization/v1\0" + request_body_sha256 + "\0" + nonce` with the autoskd public key bound into `ref_custody_policy_digest`; autoskd's private key is held in non-inheritable memory/secure store and is unavailable to same-UID siblings, extension and models. A nonce is consumed at durable request-journal commit and cannot authorize another body.

Before every socket call, autoskd atomically persists a `ref_custody_helper_intent` governed by `ref-custody-helper-intents.schema.json`. Its immutable identity is `intent_key = SHA-256("autosk-flow/ref-custody-intent-key/v1\0" + canonical JSON {action,transfer_mode,owner_operation_id,request_body_sha256,wire_request_sha256,authorization_sha256})`. `topology_digest = SHA-256("autosk-flow/ref-custody-intent-topology/v1\0" + canonical JSON {ref_updates,reflog_checkpoints})`; each checkpoint binding is `SHA-256("autosk-flow/ref-custody-intent-checkpoint/v1\0" + canonical JSON checkpoint)`; `pre_execution_observation_sha256 = SHA-256("autosk-flow/ref-custody-intent-precondition/v1\0" + canonical JSON pre_execution_observation)`; and `persist_receipt_hash = SHA-256("autosk-flow/ref-custody-intent-persist/v1\0" + canonical JSON intent-without-persist_receipt_hash)`. The record advances monotonically through `prepared -> precondition_committed -> delivered -> receipt_committed`: `prepared` contains exact canonical request/authorization/wire bytes but no helper journal or precondition; under the helper lock, `precondition_committed` adds the exact refs/OIDs, packed absence, reflog checkpoints and request journal before Git; later prefixes only append evidence. Atomic PASS may embed future helper intents only in `prepared`; an already completed create_keepalive is verified evidence in the candidate projection, not a future intent. Retry uses the same key/body/nonce and never predicts a future receipt.

The response contains actual `ref_observations[]` for every requested ref and `reflog_observations[]` with per-ref counts, prefix digest, every raw appended entry and its digest. `transaction_value_observation_sha256` uses `autosk-flow/ref-custody/<action>/value-observation/v1\0` over exact action/request/status/body/custody/policy/nonce/ref/reflog values. `receipt_hash` uses the distinct `.../<action>/value-receipt/v1\0` domain over `{action,request_id,request_body_sha256,status,not_applied_reason,transaction_value_observation_sha256}`; `not_applied_reason` is `null` for a committed response. It is intentionally distinct from the higher-level candidate release receipt digest.

`reflog_checkpoints[]` is ordered per requested ref and carries exact prefix bytes, count and `reflogPrefixDigest`. A ref update reports `appended`; a verify reports `unchanged`; deleting a loose ref on the files backend reports `log_removed`, `after_entry_count=null` and no fabricated appended entry. Release verifies the planning-ref tail and any pre-existing audit ref under the same helper lock.

Every durable planning record that claims a protected-ref side effect stores `helper_evidence={request_id,nonce,request_body_sha256,transaction_value_observation_sha256,helper_receipt_hash,helper_journal_hash}` copied from the journaled committed response. This binding is required on init ref-create, keepalive create, planning CAS, audit retain, release and supersession receipts; host-computed receipt hashes without the exact signed request and durable journal binding are invalid recovery evidence.

The helper journal has closed phases `request_committed -> refs_committed -> receipt_committed`. It fsyncs the exact request and consumed nonce before preparing refs. After Git commits, `refs_committed` stores and fsyncs the complete ref/reflog observation payload plus its digest; the closed prefix is sufficient to reconstruct the exact response without any mutable side store. It then records and fsyncs the response before return. The wire Schema represents every prefix; final golden exchanges pin `fsync_order=[request,refs,receipt]` and all phase receipt hashes.

Recovery from `request_committed` is observe-before-execute under the same helper `flock`: if every ref and reflog still equals the signed expected-old/checkpoint, execute the transaction once; if exact post-state and operation-specific raw reflog bytes prove that this request already committed, persist `refs_committed` directly and construct the one committed receipt without a second `update-ref`; otherwise fail closed. For `delete_expired_audit`, which deliberately removes the reflog file, the committed post-state proof is the matching journaled request body and nonce, absent audit ref, absent reflog path and absent packed-refs entry for that ref. Only that complete delete-specific proof permits direct `refs_committed` persistence and receipt reconstruction without a second delete; any mismatch parks the operation. `ref-custody-helper-journal-crash.example.json` binds those crash windows to the exact request, committed observation digest, response receipt and recovered journal hash with zero recovery ref transactions. A replay may write `not_applied` only when its observations prove that every ref remained at the observed pre-state and every reflog is unchanged. `refs_committed` reconstructs from its persisted complete observations, and `receipt_committed` performs zero ref writes. A changed body under the same ID/nonce is rejected. Process death releases `flock`; recovery never removes a guessed lock file. The helper, never the extension host, executes every protected `update-ref`.

Pre-commit rejection uses terminal journal phase `not_applied` with `fsync_order=[request,receipt]`, no refs-commit hash and a value-bound response. Reasons are closed: `expected_old_mismatch` maps to `planning_ref_foreign_movement`; `packed_refs_drift` and `authorization_invalid` map to `planning_ref_capability_missing`. Every `ref_observation` must report `observed_new_oid=observed_old_oid`, and every requested reflog must match its checkpoint with `outcome=unchanged`, equal before/after counts and no appended bytes. `not_applied` therefore proves zero ref/reflog side effects and cannot be consumed as a committed helper receipt.

Protected refs remain loose inside the service-owned canonical common Git directory. Privileged bootstrap migrates its protected packed refs to loose form, pins `gc.packRefs=false`, owns `packed-refs` and the entire ancestor chain, and records their digests. Before every helper request, preflight rejects any protected packed entry: a loose ref absent with packed entry present is `planning_ref_capability_missing`, never absence. Project/model accounts cannot run maintenance against the common directory; only helper-owned maintenance runs under the custody lock over the same ODB. Packed membership, descriptor-bound topology and denial probes enter the custody policy digest.

Every pre-CAS publication retry revalidates keepalive, closure pack and planning tail. Release creates `candidate_audit_transfer_op` governed by `candidate-audit-transfer-operation.schema.json`; it never claims crash-atomic persistence across loose-ref files. Phases are `prepared -> audit_ref_verified -> live_ref_deleted -> verified`: first create or verify and fsync/read-back audit while live remains, then separately delete live by expected-old, then verify audit-present/live-absent. A crash before audit creation leaves live custody; between CAS operations both refs exist; after deletion audit custody exists. Each prefix resumes the same helper intent. Only transfer phase=`verified` permits outer `released|audit_retained` and the next workflow step. Audit custody remains until approved retention expiry.

Audit-transfer receipt hashes use canonical base `{operation_id,keepalive_operation_id,object_format,ensure_audit_intent_key,delete_live_intent_key}` plus the receipt without `receipt_hash`. `audit_ref_receipt` additionally injects `helper_intent_key=ensure_audit_intent_key` under domain `autosk-flow/audit-transfer/audit-ref/v1\0`; `live_delete_receipt` injects `helper_intent_key=delete_live_intent_key` under `autosk-flow/audit-transfer/live-delete/v1\0`; final verification uses `autosk-flow/audit-transfer/verification/v1\0` and binds both earlier receipt hashes. The runtime semantic validator rejects any nested ref/OID, planning binding, intent, helper evidence or receipt that differs from the containing transfer.

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

This boundary requires daemon capability `autosk.record-pass-prepare-publication` version 1, governed by `record-pass-prepare-publication.schema.json` and owned by runtime issue `Valeron2206/autosk-traycer-flow#5`. Its request binds expected metadata head, PASS digest, candidate identity, publication preimage/operation, helper intent keys and idempotency key; one metadata CAS writes PASS, phase=`prepared` operation, verified candidate binding and prepared intents. Missing version, head mismatch or non-identical replay parks `planning_ref_capability_missing`; two CLI calls are not a fallback.

The exact API identities are `idempotency_key = SHA-256("autosk-flow/record-pass-idempotency/v1\0" + canonical JSON {request_id,expected_metadata_head,metadata_cas_payload_sha256})` and `response.receipt_hash = SHA-256("autosk-flow/record-pass-prepare-publication/v1\0" + canonical JSON {capability,request,response-without-receipt_hash})`. `metadata_cas_payload_base64` is canonical JSON containing the ArtifactPassRecord, phase=`prepared` publication operation, verified candidate projection bytes/hash and phase=`prepared` future helper intents. Its SHA-256 is recomputed from exact bytes before the expected-head CAS.

The host API method name is `recordArtifactPassAndPreparePublication`; two ordinary CLI calls are not equivalent.

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
    "before_prefix_sha256": "c69fb4cc6024c700bb4b14435bb8ffbdc6f57700cea07ef0bf1fd6a3d16cf03a",
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

Identity, recipe, expected-ref and payload fields preceding `phase` are write-once. Nested keepalive phase, terminal disposition and receipt slots are the sole monotonic exception and must remain byte-identical to the authoritative candidate operation/history record. The complete canonical `commit_recipe`, including exact commit object bytes, is persisted and read back before phase=`prepared`; a digest or recomputation from mutable configuration alone is insufficient. Receipts are monotonic, operation-bound and written only by deterministic host code under daemon workflow custody. A retry may advance a phase or reconstruct a missing receipt from exact Git observations; it may not change the recipe, expected parent, candidate tree, expected commit, payload kind or target step.

`project_instruction_digest` is never null in a runtime publication. Issue #12 supplies the current immutable instruction-lock digest, including the deterministic digest of an empty applicable set. Until that capability exists, issue #5 runtime implementation parks `planning_ref_capability_missing` before `record_artifact_pass`; a nullable placeholder is not a fallback.

Each non-null receipt uses the self-contained closed envelope `{schema,operation_id,receipt_kind,observation,observation_sha256,helper_evidence,receipt_hash}`. `helper_evidence` is null only when the receipt has no helper side effect; it is non-null for init ref-create, keepalive create/verification, planning ref_cas, audit retain, release and supersession receipts. `observation` is the exact typed object retained by the journal, not a mutable external pointer. `receipt_kind` matches its slot and `operation_id` matches the containing operation. Receipt prefixes remain phase-closed.

All load-bearing digests use the canonical JSON rule from section 1 and exact domain-separated UTF-8 preimages:

- `commit_recipe_digest = SHA-256("autosk-flow/planning-commit-recipe/v1\0" + canonical JSON commit_recipe)`;
- `before_prefix_sha256 = SHA-256("autosk-flow/reflog-prefix/v1\0" || uint64be(before_entry_count) || exact raw LF-terminated reflog prefix bytes)`. The empty-log value hashes the domain plus eight zero bytes and no reflog bytes. Host code resolves the common Git directory, rejects non-regular/symlinked log storage and reads the first exact entry count without newline normalization;
- `appended_entry_sha256 = SHA-256("autosk-flow/reflog-entry/v1\0" || exact raw LF-terminated entry bytes)`, where the entry is exactly `old_oid SP new_oid SP committer_name SP <committer_email> SP timestamp_seconds SP timezone TAB expected_update_message LF` from the persisted operation;
- `observation_sha256 = SHA-256("autosk-flow/planning-observation/v1\0" + receipt_kind + "\0" + canonical JSON typed_observation)`;
- `receipt_hash = SHA-256("autosk-flow/planning-receipt/v1\0" + canonical JSON {observation_sha256, operation_id, receipt_kind, schema, helper_evidence?})`, where the `helper_evidence` key is present exactly when its value is non-null, matching `planningReceiptHash`.

Typed observations are closed by kind: `commit_object={object_format,object_oid,object_bytes_sha256}`; `ref_cas={planning_ref,expected_old_oid,observed_new_oid,expected_update_message,candidate_keepalive_ref,candidate_keepalive_oid}`; `reflog_after={before_entry_count,after_entry_count,before_prefix_sha256,appended_entry_sha256}`; `verification={planning_ref,commit_oid,tree_oid,reflog_after_receipt_hash}`. Before recovery or phase advance, deterministic host code must run the generic operation semantic validator over every non-null receipt, recompute both digests from the embedded observation, and compare every observation field to the containing operation: recipe format/OID/byte hash; planning ref/checkpoint old/new/message plus the atomic keepalive verification; checkpoint count/prefix plus exactly one appended entry; and final ref/commit/tree plus the sibling reflog receipt hash. Foreign operation IDs, slot mismatch, extra/missing observation fields, self-consistent substituted observations and phase-prefix mismatches are rejected. The example, its reflog prefix vector and validator tests are golden vectors for these formulas; implementations may not substitute parsed/locale-formatted reflog text.

Every init/publication operation persists a closed `reflog_producer`. Host code launches Git with an empty inherited Git environment and exact `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`, `GIT_COMMITTER_DATE=@<timestamp_seconds> +0000`, `LC_ALL=C`, `TZ=UTC`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_CONFIG_GLOBAL=/dev/null`; the verified common Git directory is supplied explicitly through `--git-dir`, never `GIT_DIR`, `GIT_WORK_TREE` or `GIT_INDEX_FILE`. It passes `-c core.hooksPath=/dev/null` and object-format-neutral expected-old values to Git. Init/keepalive creation uses exact missing-old `update-ref --create-reflog`. Planning publication uses one `git update-ref --stdin --create-reflog -m <expected_update_message>` transaction containing both `verify <candidate_keepalive_ref> <snapshot_commit_oid>` and `update <planning_ref> <new_oid> <old_oid>` before prepare/commit; keepalive movement therefore cannot race between validation and planning CAS. The producer timestamp is recorded once per operation before phase prepared and is replayed unchanged after arbitrary delay. Ambient identity/date/config/hooks are rejected. Phase advance requires exact raw appended-entry bytes to match `planningReflogEntryDigest` or the init equivalent. Golden vectors use epoch zero only for reproducibility; runtime operations use their recorded operation timestamp.

Raw reflog-byte v1 supports only Git `files` ref storage. Preflight records `ref_storage_format=files`; reftable or an unprovable backend parks `planning_ref_capability_missing` before any Git side effect. The repository must pin `gc."refs/autosk/epics/*/planning".reflogExpire=never` and `gc."refs/autosk/epics/*/planning".reflogExpireUnreachable=never`; missing/unprovable retention also parks capability-missing. Unexpected prefix truncation remains foreign/corrupt evidence and is never silently adopted.

The phase=`prepared` example uses `before_entry_count=1`. Its exact raw reflog-prefix bytes are Base64 `MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCA2MWUxNTIxZWQ0OTg1MjkyZGU3MDVjNGE0OGRhYjc4OWE1YTUyMTgwIGF1dG9zay1mbG93IDxhdXRvc2tAZXhhbXBsZS5pbnZhbGlkPiAwICswMDAwCWF1dG9zay1mbG93IGluaXQgMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAwCg==`; the formula above yields `c69fb4cc6024c700bb4b14435bb8ffbdc6f57700cea07ef0bf1fd6a3d16cf03a`. The next invalidation prefix contains that init entry plus the exact base-to-publication entry, has `before_entry_count=2`, Base64 `MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCA2MWUxNTIxZWQ0OTg1MjkyZGU3MDVjNGE0OGRhYjc4OWE1YTUyMTgwIGF1dG9zay1mbG93IDxhdXRvc2tAZXhhbXBsZS5pbnZhbGlkPiAwICswMDAwCWF1dG9zay1mbG93IGluaXQgMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAwCjYxZTE1MjFlZDQ5ODUyOTJkZTcwNWM0YTQ4ZGFiNzg5YTVhNTIxODAgYzlkODMzNWI2MGY1NmQ5YjcyMzFkY2YwYWE4NmNiNjkyODI3ZmU3MiBhdXRvc2stZmxvdyA8YXV0b3NrQGV4YW1wbGUuaW52YWxpZD4gMCArMDAwMAlhdXRvc2stZmxvdyBwdWJsaXNoIDExMTExMTExLTExMTEtNDExMS04MTExLTExMTExMTExMTExMQo=` and digest `4092bb1a3420f7599206d42993e1722d777b7bd938cf49bcb7c22530d5200d9b`. The same prepared example pins commit-recipe digest `a68042085d3db95256488fa10c4bf9e204dbb3bc37f3188c3178b5d362eecebb`, exact commit OID `c9d8335b60f56d9b7231dcf0aa86cb692827fe72` and exact commit-bytes SHA-256 `97615cac0203c5871f7b178075a6121d2d1aa6222bdf9e06233818eb0db59e7f`.

For the example operation, typed `commit_object` observation `{object_bytes_sha256:"97615cac0203c5871f7b178075a6121d2d1aa6222bdf9e06233818eb0db59e7f",object_format:"sha1",object_oid:"c9d8335b60f56d9b7231dcf0aa86cb692827fe72"}` yields `observation_sha256=70f9035e1b61234acaf749d616a0b5b6c942c58d215acca0abb17953c7afb2b5`; its receipt preimage yields `receipt_hash=6f3d63fa022eb6c4143246c58b1f5ab391538ff0c1adc4460ad92689e88d00d2`.

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
| current operation absent, but append-only publication history contains the exact verified operation, candidate history contains its released keepalive, and live planning ref/commit/tree/reflog tail match the stored effective target | read back archived proof with zero Git writes and finish only the missing transition/projection; do not recreate an operation |
| current operation absent, but append-only publication history contains the exact voided operation and candidate history contains its audit-retained keepalive with matching pending anchor/recovery target | read back archived proof with zero Git writes and transition `prepare_anchor_impact` |
| active keepalive phase is `prepared`, `object_written`, `ref_created` or `verified` and its snapshot object/ref/receipt/closure proof is missing, moved or mismatched | park `planning_candidate_keepalive_invalid` before publication object or planning-ref side effects |
| phase=`prepared` or phase=`commit_created`, current controlling binding changed before ref movement, ref=expected parent and reflog prefix/count equal checkpoint | atomically set phase=`voided_before_ref`, terminal reason `binding_drift`, recovery target `prepare_anchor_impact`; keep original ArtifactPassRecord disposition/identity, set `publication_status=voided_before_ref`, keep the operation current and ensure pending anchor; repeat publication finalization before any object/ref side effect |
| phase=`prepared`, keepalive ref/receipt/complete snapshot closure exact, publication object absent, ref=expected parent | write exact commit object; verify OID; record `commit_created` |
| phase=`prepared`, keepalive ref/receipt/complete snapshot closure exact, expected publication object already exists, ref=expected parent and reflog prefix equals checkpoint | verify bytes/tree/parent/message; record `commit_created` |
| phase=`commit_created`, expected object was pruned, ref=expected parent and reflog prefix/count equal checkpoint | rewrite the persisted exact commit object bytes, require the same expected OID, retain `commit_created` and continue; this is reconstruction, not a new logical commit |
| phase=`commit_created`, ref=expected parent, keepalive ref=snapshot commit and reflog prefix equals checkpoint | atomically verify the keepalive ref and CAS planning ref from parent to expected commit in one update-ref transaction with `--create-reflog` and the operation-specific message; record `ref_advanced` only after ref/reflog observation |
| phase=`prepared` or phase=`commit_created`, ref=expected commit and exactly one new matching reflog entry follows the checkpoint | reconstruct a successful CAS receipt only after exact commit verification; record `ref_advanced` |
| phase=`ref_advanced`, expected commit/ref/reflog match the recorded operation but current controlling binding changed | verify against the recorded binding, atomically record historical publication `verified`, update planning head/tree/generation and `last_verified_reflog_tail`, ensure pending anchor and transition `prepare_anchor_impact`; no downstream draft/dispatch |
| phase=`ref_advanced`, ref=expected commit and current controlling bindings exact | verify ref, commit, parent, tree, exact commit bytes, trailers and reflog transition; record `verified` |
| phase=`verified`, keepalive still verified | prove closure and planning tail; resume monotonic audit transfer: create/verify audit while live remains, separately delete live by exact old OID, final-verify, then record release/audit receipts and remain in publication finalization |
| phase=`verified` with released keepalive and publication-drift pending anchor | repeat exact read-back/finalization and transition `prepare_anchor_impact` |
| phase=`verified` with released keepalive, metadata finalization incomplete | repeat only read-back/finalization and transition to the stored target; never create another commit or move the planning ref |
| phase=`voided_before_ref`, candidate keepalive operation phase=`verified` | resume monotonic audit-first transfer through `audit_ref_verified -> live_ref_deleted -> verified`, then record audit receipt and phase=`audit_retained`; never create a publication object or move planning ref |
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

An unaffected Published PASS never mutates its write-once publication operation. `rebuild_anchor` appends `planning_publication_rebinding` under `planning-publication-rebinding.schema.json`, binding old publication, old/new anchors, approved impact, unchanged tree/pathspec and previous rebind hash. Completion guards accept a historical publication at the current anchor only through the latest valid rebind chain; any byte/tree/pathspec mismatch requires a new descendant publication.

`approved_impact_digest = SHA-256("autosk-flow/planning-publication-rebinding/impact/v1\0" + canonical JSON approved_impact)` and `receipt_hash = SHA-256("autosk-flow/planning-publication-rebinding/v1\0" + canonical JSON rebinding-without-receipt_hash)`. Runtime validation requires `new_anchor_version > old_anchor_version` and binds project/Epic/ref key, prior published receipt, old/current planning commits and trees, prior chain head, canonical projection bytes/mode/blob, unchanged pathspec/tree and the approved unaffected decision.

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

Invalidation executes the full section 9 phase machine. Pre-CAS drift terminalizes publication/rebuild as `voided_before_ref`, then completes the monotonic audit-first transfer before `audit_retained` and archive. Post-CAS drift verifies the historical descendant, updates planning head/tree/generation and keeps both operations current until transfer verification proves audit-present/live-absent and durable release/audit receipts exist; only then may it close/archive. Ordinary verification follows the same `release_pending -> released -> archive` order. Foreign/ABA recovery resumes through `publish_planning_invalidation`; a voided operation never later writes/ref-advances and a post-CAS operation is never rewound.

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
- the open operation record and exact reconstruction recipe; an unreferenced pre-CAS publication commit object may be pruned and rewritten to the same OID from that recipe;
- append-only terminal planning publication/init/rebuild history and any voided pre-CAS object during its audit period;
- unexpired audit policy

are retained and protected from cleanup.

Candidate commit/tree/blob closure remains protected by the verified quarantine pack and live/audit custody. Once planning CAS succeeds, the planning ref retains the published commit and its reachable objects; pre-CAS publication objects alone are not an independent retention obligation.

Normal Ticket or Epic worktree cleanup does not delete the planning ref, a live candidate keepalive, audit candidate ref or typed append-only operation histories: `planning.init_history` retains terminal init operation/receipts, `planning.candidate_history` retains every released/audit-retained keepalive and its exact audit/release receipts, `planning.publication_history` retains artifact and invalidation operations/recipes/receipts, and `planning.rebuild_history` retains terminal anchor-rebuild dispositions and publication bindings. Cleanup first enumerates the live candidate ref namespace and requires an exact current/history operation for every ref; an orphan ref parks `planning_candidate_keepalive_invalid`.

Audit deletion is a separate typed `audit_candidate_housekeeping_op`, governed by `audit-candidate-housekeeping-operation.schema.json`. Before the helper call it persists exact audit ref/OID, retention-policy and reference-inventory digests, expiry, and an operator approval whose digest binds that complete intent. `operator_approval.digest = SHA-256("autosk-flow/audit-housekeeping-approval/v1\0" + canonical JSON {operation_id,audit_ref,expected_oid,retention_policy_digest,inventory_digest,expires_at_utc,operator_approval:{record_id,approved_by,approved_at_utc}})`. Its phases are `prepared -> ref_deleted -> tombstone_verified`. Only `prepared` may call `delete_expired_audit`; the helper request operation ID/ref/expected old OID and final journal evidence must match the prepared operation. `ref_deleted` records the committed helper receipt. Recovery from a lost response uses that journal and never repeats a logically different delete. The terminal `tombstone_receipt.receipt_hash = SHA-256("autosk-flow/audit-housekeeping-tombstone/v1\0" + canonical JSON receipt-without-receipt_hash)`; the receipt binds operation/ref/OID, helper receipt, inventory/policy digests and deletion time. Only `tombstone_verified` may archive the operation or allow object pruning. A crash after deletion but before the tombstone therefore resumes the same operation rather than treating absence as ordinary cleanup.

Git GC may prune the separate unreferenced publication commit object because its exact bytes remain in the protected operation, so retry rewrites those bytes to the same OID before CAS; it may not prune the candidate snapshot commit/tree/blob closure protected by the live or audit ref. Git GC must not make current or post-CAS audit-required planning objects unreachable. Planning, live candidate and audit candidate reflogs retain both scoped expiry values `never`; ordinary maintenance must not truncate their load-bearing prefixes. Unexpected truncation is explicit foreign/corrupt evidence, never normal adoption.

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
49. execute approved audit expiry through prepared, ref_deleted and tombstone_verified; crash after helper deletion and prove the same operation reconstructs its receipt and tombstone without a second delete.

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
