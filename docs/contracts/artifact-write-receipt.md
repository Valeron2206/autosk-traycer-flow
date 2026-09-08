# Artifact write receipt contract

<!-- artifact-write-receipt-contract:v1 -->

Status: issue #22 design contract. The host-owned write adapter is `required_for_v1`; this pins what a write must be able to prove before anything can be built to prove it.

## 1. Authority

Writing a file and then reading `git status` does not establish that the intended bytes reached the disk. It establishes that *some* bytes are there now. The six ways that differs are the ones issue #22 lists, and they are not exotic: a crash leaving a partial temp file, a platform sync or formatter rewriting the file after the write, an oversized or special file accepted as ordinary, task metadata saying "done" while the bytes say otherwise, a concurrent writer clobbering a file the user owns, and a stale pending write mistaken for a finished one after a restart.

A receipt is what turns "we wrote it" into a claim that can be checked later, by someone who was not there. The closed JSON Schema is `resources/artifact-write-receipt/artifact-write-receipt.schema.json`.

## 2. Boundaries

Issue #13 owns the filesystem boundary this adapter writes through; #10 the runtime identity a receipt cites; #14 registers this class; #15 owns what may not move during a gate run; #27 owns retention. This contract defines what one write must record and what makes it verified.

## 3. The write is a sequence, and the receipt names where it stopped

```text
prepare intent
→ validate destination and previous identity
→ write a same-directory temp
→ flush and fsync
→ atomic rename
→ read back, hash, check mode
→ record a pending receipt
→ reconcile against the projections
→ record a verified receipt
```

The receipt exists from the pending phase onward, not only at the end. A receipt that appeared only on success could not describe the case it is most needed for: a write that stopped halfway.

`phase` is therefore `pending`, `verified` or `quarantined`, and it is **computed from the evidence in the receipt**, never asserted. A receipt carrying a read-back digest that does not equal the intended one is not verified, whatever it says about itself.

## 4. Identity a receipt must carry

Every field below is required, because each one is something a later reader needs and cannot recover:

- `project_identity`, `epic_id`, `artifact_class` — whose artifact, and which class's rules apply;
- `destination` — the project-relative path, POSIX form, no `..` and no leading `/`;
- `expected_previous` — the destination's identity BEFORE the write: `{ state: "absent" }` or `{ state: "file", sha256, mode }`. This is what makes a write conditional rather than hopeful;
- `intended_sha256`, `intended_size` — the bytes the caller meant to write;
- `observed_sha256`, `observed_size`, `observed_mode` — what the read-back found. Absent while `pending`, because there is nothing observed yet;
- `operation_id` — the writer operation, so two writes of the same bytes are two receipts;
- `planning_base_oid`, `pathspec_digest` — the base and the scope the write belongs to;
- `runtime_identity` — the extension distribution, workflow shape and store helper the writer ran under (#10, #13). A receipt that cannot say which code wrote the file proves less than it appears to;
- `phase`, `quarantine`, `reconciliation`;
- `recorded_at`, `sequence`.

## 5. What a receipt is not

A receipt is not a second task-status ledger, and criterion 6 of #22 says so directly. It records **one write**: what was intended, what landed, and whether those agree. It does not record whether a step is done, whether a task may advance, or what the workflow decided. A reader that wants task status reads the task.

The rule this contract enforces: a receipt names no task status, no step, and no workflow position. The schema has no field for them, which is stronger than a convention not to write them.

## 6. Quarantine

An artifact that is oversized, special (not a regular single-linked file), malformed for its class, or whose policy cannot be determined does **not** get a pass. It is quarantined:

- the source is not destroyed — a quarantine that deletes what it could not classify is a data-loss path wearing a safety name;
- the quarantine path is project-owned and is never a canonical artifact path, so nothing downstream can mistake it for the artifact;
- disposition is human: `inspect`, `transform`, `reject`, `restore`. There is no automatic release, because every automatic release is a policy decision made without the person who owns the consequence;
- quarantined bytes carry identity and retention like anything else. They are evidence, not scratch.

`quarantine` is `{ state: "none" }` or `{ state: "held", reason, path, disposition }` where `disposition` is `pending` until a human records one.

## 7. Reconciliation, and why "last writer wins" is refused

Four sources can disagree about one artifact:

1. the canonical bytes on disk, and the commit they belong to;
2. the autosk task metadata;
3. this receipt;
4. temporary model output.

When they disagree, choosing the most recent one is choosing whichever process happened to finish last — which is exactly the failure being diagnosed. So `reconciliation` is `{ state: "agreed" }` or `{ state: "diverged", report }`, and a divergence **parks the workflow** with a report naming each source and what it said.

The report is required to name all four, including the ones that agreed. A divergence report that lists only the odd one out cannot be checked by a reader who does not already know the answer.

## 8. Refusal classes

Closed set, so a caller may branch on them:

- `write_destination_invalid` — the path escapes the project, is not POSIX-relative, or is not in the writer's scope;
- `write_previous_mismatch` — the destination is not what `expected_previous` says;
- `write_not_regular` — the destination or the temp is not a single-linked regular file;
- `write_too_large` — beyond the pinned size policy;
- `write_readback_mismatch` — the bytes on disk after the rename are not the intended ones;
- `write_mode_mismatch` — the mode after the rename is not the mode policy allows;
- `write_helper_unavailable` — the boundary adapter could not be used, so nothing was written;
- `write_out_of_scope` — an existing file the user owns, outside the declared pathspec;
- `receipt_stale_pending` — a pending receipt from a previous run, which is not evidence that its write completed.

## 9. Size and mode policy is pinned, not defaulted

`policy` carries `max_bytes` and `allowed_modes`, and both are part of the receipt. A policy that lived only in the code would make two receipts written by different builds incomparable, and the whole point of a receipt is that it can be read later.

## 10. What this contract decides, and what it defers

Decided: the receipt's fields, the computed phase, the closed refusal set, quarantine semantics, the four reconciliation sources and the refusal of last-writer-wins.

Deferred, and named rather than implied: the adapter itself, its helper operations, and the driver that applies model-proposed bytes. Those are runtime work, and this contract is what they will be built against.
