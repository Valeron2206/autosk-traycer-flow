# Governance bundle contract

<!-- governance-bundle-contract:v1 -->

Status: issue #37 design contract. The import/build/review/release CLI is `required_for_v1`; this pins the bundle, its attestation and what a release may never do.

## 1. Authority

The project needs its own autonomous copy of the Agent Selection Guide and the twelve protocol files. Copying them is not enough, and the issue says why: the Guide carries Traycer-specific commands and surfaces; some rules must become deterministic code and registries rather than staying prose; the source, the working adaptation and the released bundle must not be mixed; and an attestation without an exact build and review contract can only ever confirm itself.

So a bundle is built deterministically, reviewed on one frozen candidate, and released to content-addressed storage. The closed JSON Schema is `resources/governance-bundle/governance-bundle.schema.json`.

## 2. Three places, never one

- **baseline** — the imported Traycer source. Private, immutable, provenance-recorded, and never a runtime source of truth;
- **adaptation** — the working translation of the Guide and the twelve protocol files into autosk-native text; the rules that became code, the registries and the role contracts it produces live in the extension, not in the bundle;
- **release** — the built, reviewed, content-addressed bundle the runtime uses.

Mixing any two of these is the failure this separation exists to prevent, and the schema keeps them apart by making `stage` a required field with exactly those three values.

## 3. Deterministic build

One input must give one digest. That requires the canonical form to be stated rather than assumed:

- UTF-8, no BOM;
- LF line endings, and a trailing newline on every text member;
- paths compared and ordered as raw bytes, POSIX separators;
- JSON serialised with sorted keys, two-space indent, and a trailing newline;
- the content digest is `digest("autosk-flow/governance-bundle-content/v1", preimage)` — SHA-256 over the domain separator, a NUL and the preimage's `canonicalBytes` (`src/runtime/contracts.mjs`: compact JSON, sorted keys, NFC strings, a trailing LF — not the two-space form of the files above) — where the preimage is exactly `bundle_id`, `bundle_version`, `provenance` and `files`, the members' `{relative_path, file_sha256}` in path order (02 §5, 03 §3; ADR-093). The manifest's own digest field and the attestation are not in it.

**Timestamps are not in the digest.** A build that embedded the moment it ran could never be reproduced, and a digest nobody can recompute is a name, not an identity. The build time lives in the attestation, where it describes the event rather than the content.

## 4. Required inventory

`agent-selection-guide.md` and the twelve `protocol/` files of 02 §5, named individually in the manifest — a glob would let one go missing without the count changing. These thirteen are the members the digest is taken over, and their one list is `governance_files` in `resources/stage-carriers/stage-carriers.v1.json` (ADR-093): this validator takes its members from it, and the build command (`scripts/governance-bundle.mjs`, `npm run bundle:build`) hands it to the builder (`buildBundle` in `src/host/bundle-builder.mjs`) as the inventory the manifest is held to both ways, so a manifest cannot declare its own. The command reads only the members the manifest names, runs the stage, canonical-form, inventory and scan checks of §2–§5, prints the digest only for a bundle that passes them all, and with `--out` writes the candidate document. `bundle-manifest.json` and `bundle-attestation.json` travel with the members but are not among them: the manifest records the digest and the attestation binds verdicts to it, so neither can be in its preimage. The envelope's role and stage contracts and the stage-carriers registry are extension resources, not members; the registry pins the bundle digest, so it cannot be inside it.

A missing member and an extra member are both refusals. An extra one matters as much: a bundle that carries a file nobody declared is a bundle whose contents nobody can vouch for. A member path that repeats is refused as well: two members under one name still hash in input order, so a repeat would let one manifest yield two digests — and panel verdicts bind the digest.

## 5. Nothing Traycer-specific, nothing private

A candidate is scanned before it can be released:

- no `traycer_*` identifiers, no `.traycer` paths, no Traycer skill or surface assumptions;
- no absolute user paths — `/Users/…`, `/home/…`, `C:\…` — in any published member;
- no private session or rule-validation files.

This scan is fail-closed. A member the scanner cannot read is treated as failing, because "I could not check it" is not "it is clean".

## 6. Attestation binds a candidate, not a build

`bundle-attestation.json` names the exact candidate digest, the four panel verdicts with their routes and efforts, the tool and schema versions, and the release actor.

An attestation whose candidate digest is not the bundle's own is refused. That is the shape of a forged or stale attestation, and it is also what a fix produces: **a panel fix changes the digest**, so the verdicts collected before it are about a candidate that no longer exists and a new panel is required. Rounding that up is the temptation this rule removes.

The panel runner is `runBundlePanel` in `src/host/bundle-panel.mjs`: it builds the four seats from those `src/host/governance-bundle.mjs` pins (`REQUIRED_SEATS`) and refuses a substituted route or effort before any seat runs (`bundle_panel_incomplete`), and a seat that did not answer is recorded as unavailable, never as a verdict. `attestationErrors` in `src/host/governance-bundle.mjs` holds an attestation to the candidate digest and to those seats.

## 7. Release, rollback and active Epics

- a release is immutable and content-addressed. Releasing an existing digest again is idempotent, not a second release;
- the `current` pointer moves by compare-and-swap, so two concurrent releases cannot both win;
- **rollback creates a new current-pointer decision**; it never edits or deletes a release. History is added to;
- an Epic pinned to an old bundle keeps it, and the old version is retained while any lock references it;
- a new Epic uses the current bundle by default;
- moving an active Epic to a new bundle is a separate approved workflow, never a side effect of releasing.

These rules are functions in `src/host/governance-bundle.mjs` — `releaseAdmission`, `releasePointer`, `rollbackPlan`, `bundleForEpic` and `epicMigrationErrors` — over values their caller holds; the store and the pointer they decide about are deferred (§9).

## 8. Refusal classes

- `bundle_inventory_missing`;
- `bundle_inventory_extra`;
- `bundle_inventory_duplicate`;
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

Implemented since, outside this contract's decisions: the build command and the builder (§4), the panel runner and the attestation check (§6), and the release rules as functions (§7).

Deferred, and named: the importer — `import-traycer-baseline` of 03 §3, which reads the private Traycer baseline and proposes the adaptation — and the import, review and release commands (the command in the tree builds: it reads the members a manifest names under `--root` and takes `provenance` from that manifest as given); the thirteen members themselves and `resources/governance-bundle/bundle-manifest.v1.json`, which the build command reads by default and which do not exist yet (ADR-093); a panel run over a real candidate, since the runner of §6 has no caller outside tests; and the content-addressed release store, the `current` pointer and the retention of a version while a lock references it, which the functions of §7 decide about and nothing yet holds. They are built against this (debt 11f, ADR-100).
