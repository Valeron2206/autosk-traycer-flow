# Material decision manifest contract

<!-- material-decisions-contract:v1 -->

Status: issue #4 runtime contract. The rule is already in `01-core-flows.md` §2 — a planning artifact carries exactly one fenced `autosk-material-decisions` block, and unreferenced prose is not material authority. Panel round 1 found that the rule had no schema and no projector anybody could run, which makes "unreferenced prose is not authority" a sentence rather than a property.

## 1. Authority

A Brief, a Core Flow and a Tech Plan are read by people and by models, and prose is persuasive. Without a manifest, every sentence in a draft is a candidate constraint, and what a downstream Ticket implements is whatever its reader found convincing.

So the artifact declares its material decisions in one machine-readable block, its behaviour-defining sections reference those decisions by stable ID, and everything else is explanation. Explanation may be wrong without being a defect; a decision may not.

## 2. Boundaries

This contract decides what the block contains, what a section may reference, and what the projector compares. It does not decide who approves a decision (`docs/contracts/human-decision.md` and the alignment gates), nor what a Ticket does with one (`docs/contracts/tickets-manifest.md`).

## 3. One block, stable IDs

The closed JSON Schema is `resources/material-decisions/material-decision-manifest.schema.json`.

Exactly one fenced `autosk-material-decisions` block per artifact. Two blocks are refused (`material_manifest_duplicate`) rather than merged: merging would make the artifact's authority depend on which block a reader reached first.

Each decision carries a stable `decision_id`, the `statement` it fixes, its `kind` (`product_behavior`, `technical_constraint`, `delivery_operations_security_data`), the sections that depend on it, and — when it supersedes an earlier decision — the id it replaces. An ID is stable across drafts: reusing one for a different statement is how an approval survives the decision it was about.

## 4. Sections reference decisions; prose does not decide

Every behaviour-defining section names the decision IDs it rests on. A normative section that references none is refused (`material_section_unmapped`) — not because prose is forbidden, but because a section that decides something and cites nothing is exactly the authority this contract removes.

Unreferenced prose is explanation. It may be rewritten, shortened or deleted without a new approval, and it never enters an implementation constraint.

## 5. The projector compares, it does not interpret

After a draft, the projector parses the exact block and the exact section references and compares them with the approved manifest. Four outcomes are refusals, and each is its own class:

- a decision the approved manifest does not contain (`material_decision_unknown`);
- an approved decision the draft dropped (`material_decision_missing`);
- an approved decision whose statement changed (`material_decision_changed`);
- a normative section that maps to nothing (`material_section_unmapped`).

Only a byte-equivalent projection, or additions a classifier proves local and non-material, allow a freeze. "It reads the same" is not byte-equivalent, and a projector that accepted it would be interpreting.

The same comparison runs again after Arena and after every fix round, because a re-expression is a new draft.

## 6. Refusal classes

Closed set: `material_manifest_missing`, `material_manifest_duplicate`, `material_manifest_malformed`, `material_decision_unknown`, `material_decision_missing`, `material_decision_changed`, `material_section_unmapped`, `material_decision_id_reused`.

## 7. What this contract decides, and what it defers

Decided: one block per artifact, stable IDs, that sections reference decisions, what the projector compares, and that only byte-equivalence or a classifier-proven local addition allows a freeze.

Deferred, and named: the classifier that proves an addition local and non-material — it is the artifact registry's, and this contract consumes its verdict rather than restating it.
