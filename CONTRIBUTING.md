# Contributing

This repository starts from an approved design specification. Implementation work must preserve the gates and invariants defined in `03-technical-plan.md`.

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

## Commits

Use Conventional Commits with concise American English subjects, for example:

```text
docs: clarify review workflow
feat: add workflow extension skeleton
fix: preserve artifact identity binding
```

## Current phase

The repository currently contains the approved specification only. Build, test, and installation commands will be documented when the implementation skeleton is introduced.
