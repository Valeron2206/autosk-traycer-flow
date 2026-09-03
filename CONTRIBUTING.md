# Contributing

This repository contains a revision-in-progress design specification. Historical reviewed trees remain audit evidence, but only the future issue #39 candidate will authorize implementation decomposition. Changes must preserve the current gates and invariants defined in `03-technical-plan.md` and the linked normative contracts.

## Pull requests

1. Create a focused branch from the current `main`.
2. Keep each pull request limited to one coherent change.
3. Explain the behavior changed and how it was verified.
4. Wait for the automatic CodeRabbit review.
5. Resolve or explicitly disposition every blocking finding before merge.

Draft pull requests are not reviewed automatically. A manual review can be requested with `@coderabbitai review`.

## Planning changes

Changes to Brief, Core Flow, Tech Plan, Tickets, or another behavior-defining artifact follow the four-model panel rules in the specification.
A planning PASS is bound to the artifact kind, exact bytes and file hashes, pathspec, tree or snapshot OID, anchor version, and attempt.
Changing any bound field invalidates the prior PASS and requires a new four-model panel before implementation, except for the explicit hash-checked, human-approved re-binding defined in `03-technical-plan.md`.
A recorded planning verdict is not completion: `docs/contracts/epic-planning-ref.md` requires a verified host-owned descendant commit at the private Epic planning ref before `select_next`. Run `npm run validate:planning-ref` for changes touching this boundary.

## Commits

Use Conventional Commits with concise American English subjects, for example:

```text
docs: clarify review workflow
feat: add workflow extension skeleton
fix: preserve artifact identity binding
```

## Current phase

The repository currently contains a revision-in-progress specification plus design validators. Runtime build and installation commands will be documented only after issue #39 approves the consolidated implementation-ready candidate.
