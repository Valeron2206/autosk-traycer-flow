# Contributing

This repository contains a revision-in-progress specification and an executable runtime foundation. The owner authorized autonomous implementation before the final consolidated Panel: see `docs/development/solo-build.md` (DEV-2026-09-05-SOLO-BUILD). Historical reviews remain bound to their exact trees. Product gates and safety invariants in `03-technical-plan.md` remain mandatory; this development timing exception does not disable them.

## Pull requests

1. Build coherent slices on `implementation/solo-build`, preserving the integration PR and exact source history; create a separate branch only when isolation is needed.
2. Keep each pull request limited to one coherent change.
3. Explain the behavior changed and how it was verified.
4. Run deterministic tests and request CodeRabbit review when available; do not mistake a skipped automatic review for PASS.
5. Resolve or explicitly disposition every blocking finding before merge.

Draft pull requests are not reviewed automatically. A manual review can be requested with `@coderabbitai review`.

## Planning changes

Within the shipped product, changes to Brief, Core Flow, Tech Plan, Tickets, or another behavior-defining artifact follow the four-model panel rules in the specification. For this repository’s current development only, the operator deferred those intermediate panel runs until final acceptance; exact identities and findings are still retained.
A planning PASS is bound to the artifact kind, exact bytes and file hashes, pathspec, tree or snapshot OID, anchor version, and attempt.
Changing any bound field invalidates the prior PASS and requires a new four-model panel before implementation, except for the explicit hash-checked, human-approved re-binding defined in `03-technical-plan.md`.
A recorded planning verdict is not completion: `docs/contracts/epic-planning-ref.md` requires a verified host-owned descendant commit at the private Epic planning ref before `select_next`. Run `npm run validate:planning-ref` for changes touching this boundary.
Tickets additionally follow `docs/contracts/tickets-manifest.md`: edit the canonical manifest model, regenerate deterministic Markdown views, and never treat prose as dispatcher authority. Run `npm run validate:tickets-manifest` for changes touching this boundary.

## Commits

Use Conventional Commits with concise American English subjects, for example:

```text
docs: clarify review workflow
feat: add workflow extension skeleton
fix: preserve artifact identity binding
```

## Current phase

The runtime foundation is documented in `docs/runtime/foundation.md`; the native helper and actual Store patch are documented in `docs/runtime/native-host-boundary.md`. Native changes also require `npm run test:native:go`, `npm run test:native`, and the separately pinned upstream integration harness. Cross-compilation alone is not platform runtime evidence. Run `npm test` and the existing design validators for every slice. Production installation, full workflow support and release acceptance must not be claimed until their real adapters, platform tests and final #39 acceptance exist. Do not close mixed design/runtime issues on the strength of a design merge or isolated unit tests.
