# Anchor pack slot contract

<!-- anchor-pack-contract:v1 -->

Status: ticket 15 design contract. This names the bytes a design panel's controlling anchor pack actually was, so that a later reader can recompute what the panel reviewed instead of trusting an ephemeral listing that lived on one machine.

## 1. Authority

A panel verdict binds "the anchor pack at anchor_version N", but before this contract nothing in the repository said which bytes that pack contained. The round record carried `anchor_version` and a `scope_identity` — and `scope_identity` is the SHA-256 of the snapshot's `identity.rows`, a manifest of absolute paths on the machine that ran the dispatch. That file never existed in the repository, so the bytes it named could never be recomputed by a later reader: an anchor version was a name with no named carrier.

The slot fixes this: `resources/anchor-pack/anchor-pack.v1.json` is a versioned repository resource that names every member of the pack — path inside the pack, SHA-256, size, and where the bytes come from — plus one aggregate `pack_digest` computed over a stated canonical form. The closed JSON Schema is `resources/anchor-pack/anchor-pack.schema.json`.

## 2. What the slot carries, and the limit stated plainly

The slot carries the pack's **identity**, not the pack's bytes. It does not vendor the six member files into the repository. What it makes true:

- the member list is enumerable — every member's path, digest and size is named;
- the aggregate `pack_digest` recomputes deterministically from the slot alone;
- two claims of one `anchor_version` carrying different bytes are detectable and refused;
- a member's `source` says where its bytes provably came from, where that can be proved.

It does **not** make every member's bytes recompute. Members divide by `source.kind`:

- `repo_file` — the member is byte-identical to a repository file at `commit`; the validator rebuilds it with `git cat-file` and the digest must match;
- `doc_sections` — the member is the verbatim text of the named document at `commit`, from the line starting with `from_heading` up to (not including) the line starting with `until_heading`, with the trailing newline run collapsed to one `\n`; the validator rebuilds and re-hashes it;
- `built` — the member was produced by the named builder script; the round-4 package's build inputs (clean-room and mutation reports) were not versioned, so the bytes do not recompute today; the validator checks only that the named builder exists;
- `authored` — the member was written for the dispatch and has no deterministic source; only its digest and size are pinned.

For the round-4 pack this means four of six members rebuild byte-exact from `frozen_commit` and two are pinned by digest alone — which is still strictly more than the zero members a later reader could recompute before the slot existed.

## 3. Canonical form

The slot's own bytes and its digest rule follow the governance-bundle canonical form:

- UTF-8, no BOM;
- LF line endings, trailing newline;
- member paths ordered as raw bytes;
- JSON serialised with two-space indent and a trailing newline;
- `pack_digest` is SHA-256 over `path\0sha256\n` for every member, in path order.

The canonical form governs the slot file and the digest computation. It is not a claim that member bytes were canonicalised — members are recorded as they were bound, digests and all.

## 4. One version, one byte set

`anchor_version` is the handle a verdict binds. If two packs claim the same `anchor_version` with different member bytes, the handle has stopped naming anything — a verdict against "version 2" would be unverifiable because nobody can say which pack it reviewed. The validator therefore refuses any set in which two packs share an `anchor_version` but not a member set, and the refusal is `anchor_pack_conflict`. Two packs with identical members claiming the same version are the same pack under two descriptions and are allowed.

## 5. The round record binding

A slot that no record references is a claim about nothing. The panel round record (`resources/design-candidate/panel/round-<round>.json`) carries two additive fields, `anchor_pack_slot` naming the slot's repository path and `anchor_pack_sha256` naming its `pack_digest`. The validator checks the record's `anchor_version`, `round`, `attempt`, `frozen_commit`, `scope_identity` and `candidate_digest` agree with the slot's, so the slot binds to the same dispatch the record froze — not merely to a file that happens to parse.

The record's `package_sha256` binds the slot's `pack/panel-package.md` member in both directions: the member must exist and carry exactly that digest. It is the only pin on the package's bytes — the build inputs were not versioned — so a record and a slot that disagree about it are two incompatible claims of one package.

## 6. Provenance is recorded, not invented

A member's `source` is evidence, not decoration. A byte-verifiable source must name the pack's own `frozen_commit` — a member whose bytes come from a real but different commit is a pack bound to bytes nobody froze, refused as `anchor_pack_source_unfrozen` even when every hash was honestly recomputed. A `repo_file` or `doc_sections` member whose named source does not rebuild to the member's digest is `anchor_pack_source_drifted`; one that cannot even be checked (missing object, absent builder) is `anchor_pack_source_unverifiable`, which is a refusal, not a pass — "I could not check it" is not "it is clean". A member whose `source` does not match its kind's required shape is `anchor_pack_source_malformed`.

## 7. Refusal classes

- `anchor_pack_digest_stale` — `pack_digest` does not recompute over the declared members;
- `anchor_pack_member_duplicated` — a member path appears more than once;
- `anchor_pack_source_malformed` — a `source` object does not carry exactly the fields its `kind` requires;
- `anchor_pack_source_unfrozen` — a byte-verifiable source names a commit that is not the pack's `frozen_commit`;
- `anchor_pack_source_unverifiable` — a byte-verifiable source cannot be checked at all, or a `built` member's builder is absent;
- `anchor_pack_source_drifted` — a byte-verifiable source rebuilds to bytes whose digest is not the member's;
- `anchor_pack_conflict` — two packs claim one `anchor_version` with different member bytes;
- `anchor_pack_round_unbound` — the panel round record does not reference this slot, its recorded fields disagree with it, or its `package_sha256` is not the digest of the slot's `pack/panel-package.md` member.

## 8. What this contract decides, and what it defers

Decided: the slot is the durable name of the round-4 anchor pack; the digest rule is the governance-bundle rule; the round record references the slot by path and digest.

Deferred: `controlling_anchor_digest` as parent-derived runtime state is a different mechanism owned elsewhere and is not implemented by this slot; whether future packs' `built` members should have their inputs versioned so the bytes recompute is a dispatch-pipeline question, not this contract's.
