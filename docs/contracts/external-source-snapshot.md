# External source snapshot contract

<!-- external-source-snapshot-contract:v1 -->

Status: issue #21 design contract. The mint/check runtime is `required_for_v1`; this pins what a snapshot must be able to prove.

## 1. Authority

Not every normative input is in Git. Uploads, external specs, API exports, screenshots, generated reports and migration inputs can be mutable and outside version control, and a Git tree OID says nothing about them.

If a seat reads the live file, five things follow, and the issue names all five: the bytes can differ between seats; a PASS is not tied to a reproducible version; the source can vanish or be replaced by a symlink; a binary, an image or a PDF has no reliable textual identity; and cleanup can delete the only evidence.

So an external source gets an identity of its own — a locator, an immutable project-owned snapshot, and digests of both — and a candidate cites the snapshot rather than the live path. The closed JSON Schema is `resources/external-source-snapshot/external-source-snapshot.schema.json`.

## 2. Boundaries

Issue #13 owns the filesystem boundary a snapshot is written through; #22 owns the verified write and its receipt; #10 the runtime identity; #14 registers this class; #27 owns retention of transient evidence — and §4 below says why a snapshot is not that. This contract defines the snapshot record and the drift check.

## 3. What a snapshot record carries

- `locator` — the canonical source locator, and `source_kind` (`file`, `upload`, `api_export`, `generated_report`, `migration_input`);
- `media_type`, `source_size`, `source_mode`;
- `provenance` — the project that owns it and how it arrived (`in_project`, `imported`);
- `source_sha256` — the live bytes at mint time;
- `snapshot_path` — the project-owned immutable copy;
- `snapshot_sha256` and `read_back_sha256` — what was written, and what was read back afterwards. Two fields, not one, because a snapshot that was never read back proves the write returned, not that the bytes are there;
- `manifest` — the ordered canonical listing when the source is a tree rather than one file;
- `operation_id` and `receipt_sequence` — the write that created it (#22);
- `clearance` — `cleared`, `redacted` or `restricted`, so a snapshot nobody may publish is not published by accident;
- `epic_id` and `anchor_version`;
- `lifecycle` — `present`, `missing`, `deleted` or `superseded`, with `superseded_by` when it is the last.

## 4. Where a snapshot may live, and where it may not

- outside the mutable planning or code worktree, because a snapshot that moves with the work is not a snapshot of anything;
- **not** inside a transient evidence root with a short retention. This is the rule most likely to be broken by accident, because an evidence directory is exactly where a snapshot looks like it belongs — and #27's retention would then delete the only copy of a normative input;
- under the canonical project root or audited content-addressed project storage;
- deduplicated by content if you like, but **provenance records stay separate**: two sources that happen to have the same bytes are still two sources, and collapsing their records would make a later reader unable to say where either came from;
- binary bytes are hashed **without text normalization**. A digest that depends on line endings is not an identity for a PNG;
- a source under another project root cannot be attached without an explicit import operation that records the ownership change. Reading someone else's file and calling it yours is the failure this prevents.

Creating a snapshot must not make the Git worktree under review dirty. A mint that changes what is being reviewed has changed the thing it was supposed to describe.

## 4a. How the mint reads

`lstat`, never `stat`. A symlink where a file was expected is the difference between snapshotting a project's file and snapshotting whatever it points at, and `stat` cannot tell them apart because it answers about the target. The same applies to the destination: the parent directory is resolved before the write, so a directory replaced by a symlink out of the project cannot turn an in-project path into an out-of-project write while the string still looks right.

The read-back is not a formality. A write that returned is a statement about a syscall; the second digest is the statement about the bytes. The record carries both because they are different claims, and a filesystem that truncates satisfies the first and fails the second.

## 5. Drift guard, immediately before acceptance

Checked at gate acceptance, not at mint, because the window that matters is between reading and deciding:

| Live source | Outcome |
| --- | --- |
| unchanged | continue |
| changed, normative | new anchor version and a full re-review — not a patch of the old verdict |
| unavailable, or identity uncertain | `human` |
| explicitly superseded | approved disposition plus a new snapshot |
| changed, non-normative | no effect **only** with a deterministic proof that it is non-normative |

The last row is the one that leaks. "It is only a comment change" is a judgement; a deterministic proof is a rule that produces the same answer for everyone. Without one, a non-normative change is treated as a normative change.

## 6. Repair uses the recorded identity, never the latest source

If a snapshot is found corrupt, it is restored to `snapshot_sha256` — the content that was recorded — and never re-minted from whatever the live source says now. Re-minting would silently substitute today's bytes for the ones a verdict was about, which is the whole failure this contract exists to prevent, arriving through the repair path.

## 7. Refusal classes

- `snapshot_source_unavailable`;
- `snapshot_source_not_regular` — a symlink, a directory or a device where a file was expected;
- `snapshot_identity_uncertain`;
- `snapshot_out_of_project` — a source under another project root, without an import;
- `snapshot_read_back_mismatch`;
- `snapshot_retention_conflict` — a path inside a transient evidence root;
- `snapshot_worktree_dirty` — the mint would change what is under review;
- `snapshot_clearance_missing`.

## 8. What this contract decides, and what it defers

Decided: the record, where a snapshot may live, the drift table, repair from the recorded identity, and the closed refusal set.

Deferred, and named: the mint/check runtime, the import operation, and the gate hook that runs the drift check. They are built against this.
