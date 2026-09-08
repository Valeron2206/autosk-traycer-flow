# Governance bundle contract

<!-- governance-bundle-contract:v1 -->

Status: issue #37 design contract. The import/build/review/release CLI is `required_for_v1`; this pins the bundle, its attestation and what a release may never do.

## 1. Authority

The project needs its own autonomous copy of the Agent Selection Guide and the twelve protocol files. Copying them is not enough, and the issue says why: the Guide carries Traycer-specific commands and surfaces; some rules must become deterministic code and registries rather than staying prose; the source, the working adaptation and the released bundle must not be mixed; and an attestation without an exact build and review contract can only ever confirm itself.

So a bundle is built deterministically, reviewed on one frozen candidate, and released to content-addressed storage. The closed JSON Schema is `resources/governance-bundle/governance-bundle.schema.json`.

## 2. Three places, never one

- **baseline** — the imported Traycer source. Private, immutable, provenance-recorded, and never a runtime source of truth;
- **adaptation** — the working translation into autosk-native rules, registries and role contracts;
- **release** — the built, reviewed, content-addressed bundle the runtime uses.

Mixing any two of these is the failure this separation exists to prevent, and the schema keeps them apart by making `stage` a required field with exactly those three values.

## 3. Deterministic build

One input must give one digest. That requires the canonical form to be stated rather than assumed:

- UTF-8, no BOM;
- LF line endings, and a trailing newline on every text member;
- paths compared and ordered as raw bytes, POSIX separators;
- JSON serialised with sorted keys, two-space indent, and a trailing newline;
- the aggregate digest is taken over `path\0sha256\n` for every member, in path order.

**Timestamps are not in the digest.** A build that embedded the moment it ran could never be reproduced, and a digest nobody can recompute is a name, not an identity. The build time lives in the attestation, where it describes the event rather than the content.

## 4. Required inventory

`agent-selection-guide.md`, `protocol/**` (the twelve files, named individually in the manifest — a glob would let one go missing without the count changing), the role and stage contracts, the stage-carriers registry, `bundle-manifest.json` and `bundle-attestation.json`.

A missing member and an extra member are both refusals. An extra one matters as much: a bundle that carries a file nobody declared is a bundle whose contents nobody can vouch for.

## 5. Nothing Traycer-specific, nothing private

A candidate is scanned before it can be released:

- no `traycer_*` identifiers, no `.traycer` paths, no Traycer skill or surface assumptions;
- no absolute user paths — `/Users/…`, `/home/…`, `C:\…` — in any published member;
- no private session or rule-validation files.

This scan is fail-closed. A member the scanner cannot read is treated as failing, because "I could not check it" is not "it is clean".

## 6. Attestation binds a candidate, not a build

`bundle-attestation.json` names the exact candidate digest, the four panel verdicts with their routes and efforts, the tool and schema versions, and the release actor.

An attestation whose candidate digest is not the bundle's own is refused. That is the shape of a forged or stale attestation, and it is also what a fix produces: **a panel fix changes the digest**, so the verdicts collected before it are about a candidate that no longer exists and a new panel is required. Rounding that up is the temptation this rule removes.

## 7. Release, rollback and active Epics

- a release is immutable and content-addressed. Releasing an existing digest again is idempotent, not a second release;
- the `current` pointer moves by compare-and-swap, so two concurrent releases cannot both win;
- **rollback creates a new current-pointer decision**; it never edits or deletes a release. History is added to;
- an Epic pinned to an old bundle keeps it, and the old version is retained while any lock references it;
- a new Epic uses the current bundle by default;
- moving an active Epic to a new bundle is a separate approved workflow, never a side effect of releasing.

## 8. Refusal classes

- `bundle_inventory_missing`;
- `bundle_inventory_extra`;
- `bundle_not_canonical`;
- `bundle_traycer_reference`;
- `bundle_private_path`;
- `bundle_scan_unreadable`;
- `bundle_attestation_mismatch`;
- `bundle_panel_incomplete`;
- `bundle_release_conflict`;
- `bundle_stage_mixed`.

## 9. What this contract decides, and what it defers

Decided: the three stages, the canonical form and what the digest covers, the required inventory, the fail-closed scan, what an attestation binds, and the release, rollback and retention rules.

Deferred, and named: the CLI, the importer, the builder and the panel runner. They are built against this.
