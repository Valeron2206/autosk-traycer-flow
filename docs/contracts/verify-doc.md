# Project verification document contract

<!-- verify-doc-contract:v1 -->

Status: issue #23 design contract. The bootstrap, the coverage check and the self-proof runner are `required_for_v1`; this pins the recipe, the feature map, and the rule that keeps a document from being a deliverable before anyone has run it.

## 1. Authority

Without a verification document, different tickets verify the same behaviour by different routes; a command can be green while proving nothing about what a user sees; the safe environment, the cleanup and the expected evidence are undefined; drift is noticed by accident; and a feature can be closed through a manual path nobody named and nobody can repeat.

So each feature gets a recipe, the recipes are indexed by a machine-readable map, and **a recipe nobody has run is a draft**. The closed JSON Schema is `resources/verify-doc/feature-map.schema.json`.

## 2. A recipe has five parts, and each answers a different question

- **Launch** — the exact start, build and config steps;
- **Doctor** — the readiness checks, and how an infrastructure failure is classified;
- **Drive** — how to perform the user or system action;
- **Evidence** — the observable result, the capture format and the expected values;
- **Cleanup** — the teardown and restore.

`Doctor` is not a convenience. Without it an infrastructure failure and a product failure look the same, and the difference decides whether the ticket is wrong or the machine is.

`Evidence` names what is observed, not that something was observed. "The command exits 0" is not evidence of behaviour unless exit 0 is the behaviour.

## 3. Commands are exact

An existing or committed command is written **literally**, with its arguments, environment, exit and result semantics, and its cleanup. "The implementer will write a script" does not replace the exact invocation of a tool that already exists.

That is the boundary with #24: the `VerificationBatchContract` governs whether temporary scaffolding is *sufficient*, and it does not weaken this requirement. A recipe needing new disposable scaffolding cites the batch contract by identity and states the scaffolding's purpose, owner, lifecycle, invocation contract, expected red and green outcomes, product-versus-tool taxonomy, restore contract and evidence locations. A full listing of an unwritten helper is not required; a vague promise to write tooling later is not accepted in its place.

If the helper becomes committed reusable infrastructure, its code enters the ticket pathspec, gets tests and a cross-family code review, and the verify-doc records its exact canonical command and version.

## 4. Self-proof

A verification document is a deliverable only after its **own instructions have been executed end to end**, on a permitted surface, for at least one mapped feature. The evidence is bound to the exact document commit and tree, the environment and config identity, and the recipe id.

Until then it is a draft, whatever it says about itself. A document that has never been run is a plan for verifying, and this is the class of artefact where the difference matters most: it is the thing everything else is verified *against*.

After self-proof it goes through the ordinary behaviour-artifact panel lifecycle.

## 5. Surface

A recipe declares its surface: `local`, `ephemeral` or `shared`. A production or shared instance is refused without explicit permission recorded in the recipe, because "it only reads" is a claim about code that has not run yet.

## 6. Coverage, checked before dispatch

A ticket cites existing recipe ids. Behaviour with no recipe is not proven by an argument that it obviously works — coverage is checked **before** dispatch, so the gap is found while it is cheap.

Drift is fixed in the same ticket when the verify-doc paths are inside its scope, and produces a correction ticket otherwise. An `uncertain` documentation or verification impact counts as required until someone decides it is not.

## 7. Refusal classes

- `verify_recipe_missing`;
- `verify_recipe_incomplete`;
- `verify_command_not_exact`;
- `verify_never_executed`;
- `verify_self_proof_stale`;
- `verify_surface_not_permitted`;
- `verify_coverage_gap`;
- `verify_doc_drift`;
- `verify_infrastructure_failure_mislabeled`.

## 8. What this contract decides, and what it defers

Decided: the five-part recipe, exact commands, the boundary with #24, self-proof as the condition for being a deliverable, surface permission, and coverage checked before dispatch.

Deferred, and named: the bootstrap that creates the document, the coverage checker and the self-proof runner.
