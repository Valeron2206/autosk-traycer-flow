# Artifact registry contract

<!-- artifact-registry-contract:v1 -->

Status: issue #14 design contract. Runtime implementation remains `required_for_v1` after design gate #39.

## 1. Authority

The registry is the list of artifact classes this project knows how to govern:

```text
resources/artifact-registry/artifact-registry.v1.json
```

It replaces the assumption that behaviour is defined by exactly four documents. README already requires a full panel for "any other document that affects behaviour"; the state machine enumerated `brief | core_flow | tech_plan | tickets` and nothing else. A Decision Log entry, an ADR, a migration plan or a verification recipe that changes behaviour therefore had no lifecycle to enter, and an artifact with no lifecycle does not skip its gate — it never had one.

Adding a class is one registry entry. It is not a new value in several `switch` statements, which is how the enumerations drift apart in the first place.

## 2. Boundaries

Issue #4 owns the human alignment gates the registry points at, #5 the planning ref an artifact is published on, #6 the Tickets manifest, #12 the instruction lock, #15 the immutable gate projection, #16 findings, #17 the delivery profile, #18 structured results, #25 requirement-change propagation. The registry says which lifecycle each class enters; it does not implement the lifecycle, and it stores no runtime status.

## 3. Classes

The closed JSON Schema is `resources/artifact-registry/artifact-registry.schema.json`.

Each class records:

- `class` — the stable identifier;
- `category` — `behavior_defining`, `governance_defining`, `explanatory`, or `runtime_evidence`;
- `author_roles` and the model-family policy for authoring it;
- `requires` — predecessor classes that must be approved first;
- `paths` — the path patterns or the manifest contract that identify instances;
- `review` — `full_panel` or `narrow_review`, with the condition;
- `identity_fields` — what binds an instance's identity;
- `carrier` — the stage-to-protocol carrier that delivers it;
- `schema` and `validator` — the closed schema and the validator that must pass;
- `impacts` — the classes invalidated when an instance changes;
- `publication` — planning ref, governance ref, or none;
- `model_execution_allowed` — whether a model may generate this class at all;
- `retention`;
- `human_approval`.

`behavior_pack` may cover several paths under one manifest. Its scope stays exact and machine-readable: a pack is a list of paths, not a directory that "roughly" means something.

## 4. The classifier

Four categories, and the decision is a function of the registry, not of a reviewer's judgement:

- `behavior_defining` — changes what the system does;
- `governance_defining` — changes how decisions are made or enforced;
- `explanatory` — describes without defining;
- `runtime_evidence` — records what happened.

An artifact matching no class, or matching two classes with different categories, **parks**. It is not classified as explanatory because nothing else fit.

The editorial exemption is deliberately narrow: it never applies to configuration, schemas, security rules, prompts, governance, migration or verification contracts, whatever the diff looks like. A typo fix in an ADR's prose is editorial; a typo fix in a schema's `pattern` is not, because the bytes that change are the bytes that decide.

## 5. Identity and the runtime lock

`registry_digest` is SHA-256 over the canonical serialisation of every class entry — content, not writing order, since a class list is a set. It is a field of the runtime lock, so a task admitted under one registry is not silently governed by another.

Changing a class entry mid-Epic is a correction: it creates an impact and invalidates approvals whose evidence depended on that class.

## 6. Impact closure

`impacts` is a directed graph over classes. When an instance changes, the affected closure is computed by walking it — not by a hand-maintained list that says which reviews to redo.

The graph must be acyclic. A cycle would make the closure either infinite or arbitrary, and "arbitrary" here means some approvals survive a change they depended on.

## 7. This repository governs itself

The `contract_document` class lists every contract in `docs/contracts/` **one by one**, and the validator fails when a contract is not listed.

Listing them by glob would defeat the purpose: a pattern matches a new contract automatically, and then "registered" stops meaning anything. Adding a contract has to *be* a registry change. That is what keeps the registry from being a document about documents, and it is the mechanism criterion 4 asks for.

A contract and the artifacts it defines are different classes, because their blast radii differ: changing one Tickets manifest affects one Epic, and changing the Tickets *contract* affects every manifest that will ever be written under it. So instance classes list instance paths, and `contract_document` impacts the classes its contracts define.

## 8. Park reasons

Closed set: `unknown_class`, `ambiguous_class`, `missing_predecessor`, `unregistered_artifact`, `registry_drift`, `cyclic_impact_graph`, `validator_missing`, `schema_missing`.

## 9. Required implementation tests

- an ADR that changes behaviour enters the full panel;
- an editorial typo in the same ADR does not;
- a change to a migration plan, and to a verification recipe;
- a governance bundle update;
- an artifact matching no class parks, and one matching two categories parks;
- a multi-file behaviour pack with an exact path list;
- upstream and downstream invalidation computed from the graph;
- a registry update during an active Epic invalidates the affected approvals only;
- a new contract added under `docs/contracts/` without a registry entry fails.

## 10. Acceptance mapping

| #14 criterion | Where it is met |
| --- | --- |
| Decision Log/ADR do not bypass the panel gate | §3 classes `decision_log`, `adr`; §4 |
| Verification doc, migration plan and delivery profile have a lifecycle | §3 entries for each |
| Editorial artifacts separated deterministically | §4 |
| A new class does not mean copying the state machine | §1, §3 |
| Anchor rebuild computes the closure from the graph | §6 |
| Full/narrow rules uniform across classes | §3 `review` |
| Unknown or ambiguous class parks | §4, §8 |
| Registry version and digest in the runtime lock | §5 |
