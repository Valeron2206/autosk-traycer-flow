# Supported platform and helper packaging contract

<!-- platform-support-contract:v1 -->

Status: issue #13 design contract, completing criteria 1, 6 and 7. The strategy and API contract are ADR-028; this fixes the OS and filesystem matrix, the packaging and permissions, and what an unsupported environment does. Runtime implementation of the remaining boundary work stays `required_for_v1` after design gate #39.

## 1. Authority

The boundary adapter's guarantees are not portable facts. They are what specific syscalls do on specific filesystems, and a claim like "no-follow on every traversed component" is true only where the calls it rests on exist and behave.

So the supported set is enumerated rather than implied. The closed JSON Schema is `resources/platform-support/platform-support.schema.json`, and the matrix is `resources/platform-support/platform-support.v1.json`.

An environment outside the matrix does not get a weaker adapter. It gets a park, before the first side effect.

## 2. Boundaries

ADR-028 chose the strategy and the helper's API. Issue #10 owns runtime identity, into which the helper's version and digest are bound. Issue #26 owns provider capability. This contract fixes: which platforms are supported and on what evidence, how the helper is packaged and permissioned, and what happens where it is not supported.

## 3. What a supported platform means

A row in the matrix is a claim with evidence behind it, not an aspiration. Each records:

- OS and architecture;
- the filesystem families verified on it;
- the syscall family the guarantees rest on — `openat2`, `*at` plus `O_NOFOLLOW`, `RENAME_NOREPLACE`, `RenameatxNp`;
- which of the adapter's guarantees hold: no-follow per component, type check, owner check, mode check, device check, no-replace rename;
- how it is verified: CI job, manual smoke, or not verified;
- the support level.

Three levels, and the difference matters:

- **`supported`** — verified in CI on every change, all guarantees hold;
- **`best_effort`** — the guarantees hold but verification is manual or periodic. A regression here is found late, and the row says so;
- **`unsupported`** — one or more guarantees cannot be provided. The adapter refuses rather than degrading.

A guarantee listed as holding on a row with `not_verified` evidence is refused by the validator. An unverified claim is not a weaker claim; it is an unchecked one, and the two are easy to confuse in a table.

## 4. Filesystems, not just kernels

The same kernel gives different answers on different filesystems, so the matrix names them. Cases that are called out because they break assumptions rather than syscalls:

- **case-insensitive** volumes (APFS by default, exFAT): two names that differ in case are one file, so a path check that compares bytes can pass while the operation targets another entry;
- **network filesystems** (NFS, SMB): `flock` semantics and rename atomicity are not the local ones, and the project lock is exactly what depends on them;
- **overlay and container filesystems**: a rename may not be atomic across layers;
- **filesystems without `O_NOFOLLOW` support at every component**: the guarantee has no local implementation.

Where a case cannot be given, the row says `unsupported` and names the guarantee that is missing. It does not say `best_effort` and hope.

## 5. Packaging and permissions

The helper ships as three binaries beside the daemon — `bin/autosk`, `bin/autoskd`, `bin/autosk-store-lock` — built in CI for each supported platform, with the LICENSE retained.

- **permissions**: the helper is executable and owned by the installing user; it is never setuid, never setgid, and never installed into a world-writable directory. A world-writable install directory is a park reason, not a warning, because anything there can be replaced between the check and the run;
- **install**: the helper's digest is recorded at install and bound into runtime identity (#10). A helper whose digest does not match the recorded one is refused;
- **upgrade**: a new helper is a new digest, and therefore a new runtime identity. Tasks pinned to the old one are not silently migrated — that is #10's migration path, not a packaging detail;
- **rollback**: the previous helper and its digest remain available until retention ends, so a rollback is a pin change rather than a rebuild;
- **the digest is checked before each launch and the launched binary is the one that was checked** — a SHA taken before `exec` does not close the replacement window on its own, which is stated here rather than claimed away. The narrowing is that the daemon holds the helper open for the life of the project (ADR-028), so the window exists once per project rather than once per operation.

## 6. Unsupported environments park before the first side effect

The check runs at project open, before any trusted write. It does not run after the first failure, because by then the side effect has happened and the park is a report rather than a prevention.

Parking names the platform, the filesystem, the missing guarantee, and what the operator can do. "Unsupported environment" alone is not a park reason.

## 7. Park reasons

Closed set: `unsupported_platform`, `unsupported_filesystem`, `missing_guarantee`, `world_writable_install`, `helper_digest_mismatch`, `helper_not_executable`, `setuid_helper`, `unverified_claim`.

## 8. Required implementation tests

- each supported row exercised in CI on its platform;
- a case-insensitive volume where two names differ only in case;
- a network filesystem where `flock` semantics differ;
- an overlay filesystem where rename is not atomic across layers;
- a world-writable install directory;
- a setuid helper binary;
- a helper whose digest does not match the recorded one;
- an unsupported platform parking before any trusted write;
- an upgrade producing a new identity, and a rollback restoring the old pin.

## 9. Acceptance mapping

| #13 criterion | Where it is met |
| --- | --- |
| Supported OS and filesystem matrix fixed | §3, §4, and the matrix resource |
| macOS is really supported and verified | the matrix's `evidence` column, CI rows |
| An impossible guarantee is not masked by a lexical prefix check | §3, ADR-028 |
| Packaging, permissions, install, upgrade and rollback described | §5 |
| An unsupported environment parks before the first side effect | §6 |
