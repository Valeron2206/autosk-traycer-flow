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
- `lifecycle` — whether v1 governs the class: `required_for_v1`, `planned_after_v1`, or `successor_matrix_candidate`;
- `decided_by` — for a class v1 does not govern, the issue that owns it, as `#N`; a `required_for_v1` class names none;
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

The lifecycle is held to the program matrix `resources/program-capabilities/matrix.v1.json` by the validator. Its first two values are the ones a carrier key carries (`docs/contracts/stage-carriers.md`); the third is for an issue the matrix does not classify, which no carrier key has. A `planned_after_v1` class names an issue the matrix puts after v1: Autobuild (#28), Reflect and cost-watch (#29), Housekeeping (#30), Debate (#31), Changeset Walkthrough (#33) and the typed SDK write API (#38) own seven such classes. A `successor_matrix_candidate` names an issue outside the matrix's #3–#39 inventory, which may not claim a lifecycle of matrix v1 and waits for a successor matrix to classify it: #47 owns two. A class a v1 workflow produces is `required_for_v1` — every workflow the workflow graph registers is v1's, so a class the graph's predicates read is one, and a `required_for_v1` class requires only `required_for_v1` classes. #14's obligation covers the `required_for_v1` classes; the others are registered so that their paths are known, and they govern nothing in v1.

## 4. The classifier

Four categories, and the decision is a function of the registry, not of a reviewer's judgement:

- `behavior_defining` — changes what the system does;
- `governance_defining` — changes how decisions are made or enforced;
- `explanatory` — describes without defining;
- `runtime_evidence` — records what happened.

An artifact matching no class, or matching two classes with different categories, **parks**. It is not classified as explanatory because nothing else fit.

So does an artifact whose class v1 does not govern. The owning class is chosen first, as for any path — the most specific pattern among classes of one category — and a path whose owner is not `required_for_v1` parks, naming the class, its `lifecycle` and its `decided_by`. The class is known to the registry and unknown to v1: the path is given no review, no approval and no publication, and a v1 class never takes a path that a more specific refused class owns.

Whatever parks a path, the park is one stop, `artifact_mapping_required` (§8), and what parked it is the park's `cause`: `unknown_class` when no class governs the path, `ambiguous_class` when classes of two categories claim it, and `class_not_v1` when its owner is a class v1 does not govern. Each cause has its own remedy before the task resumes: `unknown_class`, a registry entry that names the path; `ambiguous_class`, patterns narrowed until one class owns it; `class_not_v1`, the activation of the class by the issue that owns it (and, for an issue outside matrix v1, a successor matrix first; a class that names no lifecycle is given one in the registry). `classify:changeset` prints the remedy of each cause; §8 says where the task resumes.

The editorial exemption is deliberately narrow: it never applies to configuration, schemas, security rules, prompts, governance, migration or verification contracts, whatever the diff looks like. A typo fix in an ADR's prose is editorial; a typo fix in a schema's `pattern` is not, because the bytes that change are the bytes that decide.

## 5. Identity and the runtime lock

`registry_digest` is SHA-256 over the canonical serialisation of every class entry — content, not writing order, since a class list is a set. It is a field of the runtime lock, so a task admitted under one registry is not silently governed by another. A class's `lifecycle` is part of its entry, so bringing a class into v1 is a registry change like any other.

Changing a class entry mid-Epic is a correction: it creates an impact and invalidates approvals whose evidence depended on that class.

## 6. Impact closure

`impacts` is a directed graph over classes. When an instance changes, the affected closure is computed by walking it — not by a hand-maintained list that says which reviews to redo.

The graph must be acyclic. A cycle would make the closure either infinite or arbitrary, and "arbitrary" here means some approvals survive a change they depended on.

## 7. This repository governs itself

The `contract_document` class lists every contract in `docs/contracts/` **one by one**, and the validator fails when a contract is not listed.

Listing them by glob would defeat the purpose: a pattern matches a new contract automatically, and then "registered" stops meaning anything. Adding a contract has to *be* a registry change. That is what keeps the registry from being a document about documents, and it is the mechanism criterion 4 asks for.

A contract and the artifacts it defines are different classes, because their blast radii differ: changing one Tickets manifest affects one Epic, and changing the Tickets *contract* affects every manifest that will ever be written under it. So instance classes list instance paths, and `contract_document` impacts the classes its contracts define.

## 8. Park reasons

Closed set: `artifact_mapping_required`, `missing_predecessor`, `registry_drift`, `cyclic_impact_graph`, `validator_missing`, `schema_missing`.

The classifier parks with the first and with no other (round 8 of #39, R8-6; ADR-105). `artifact_mapping_required` is the workflow graph's stop for an artifact no lifecycle governs, and a parked path takes that reason's recovery row: the graph parks it at `freeze`, where a Quick's or a Ticket's code candidate is routed by its classes, and at `freeze_artifact`, where a planning artifact is, and the task stops in `human`. It resumes where the row permits, and the row is scoped to the step the park stood at and the edges out of it, so each stop is admitted into its own workflow's steps and lent none of another's (review of 12d, M1). A code candidate stopped at `freeze` — a Quick's or a Ticket's, which is where ordinary code or configuration no class governs stops — resumes into `freeze` once the registry names the path (an entry added, patterns narrowed, or the class activated by its issue), or stays in `human`; it is not lent the Epic's `draft_artifact`. A planning artifact stopped at `freeze_artifact` resumes into `freeze_artifact` again, into `draft_artifact` and is redrafted, or into `clarify_alignment` or `present_tickets_breakdown` and goes on to the alignment or Tickets-manifest handling by their own edges. What each cause needs before the resume is in §4: `unknown_class`, a registry entry; `ambiguous_class`, narrower patterns; `class_not_v1`, the owning issue's activation. The refusal vocabulary records the classifier, `src/host/artifact-classifier.mjs`, as the reason's producer and this contract as its owner.

The park carries its `cause`, closed too: `unknown_class` — no class governs the path, the refusal `01-core-flows.md` §2 and ADR-073 called `unregistered_artifact`, the cause's older name; `ambiguous_class` — classes of two categories claim it; `class_not_v1` — its owner is a class v1 does not govern, and the park names the class's `lifecycle` and `decided_by`. A cause is not a park reason: all three stop at the same row, and they differ only in what fixes the path — a registry entry, narrower patterns, or the issue that owns the class — which `classify:changeset` prints per cause. `impactClosure` refuses a class name the registry does not have with the same `unknown_class`, thrown to its caller rather than parked.

The other five are not stops a task parks at in this repository. The validator refuses a class that impacts one not registered and an impact graph with a cycle, and `impactClosure` throws `registry_drift` rather than return a partial closure, so no shipped registry reaches `registry_drift` or `cyclic_impact_graph` at runtime. `missing_predecessor`, `validator_missing` and `schema_missing` are the lifecycle's refusals #14's runtime owes: nothing here produces them, and the workflow graph has no row for them — a runtime that parks a task with one owes it a recovery row, as the classifier's park has.

## 9. Required implementation tests

- an ADR that changes behaviour enters the full panel;
- an editorial typo in the same ADR does not;
- a change to a migration plan, and to a verification recipe;
- a governance bundle update;
- an artifact matching no class parks, and one matching two categories parks;
- every park is `artifact_mapping_required` with its cause, and the workflow graph has a recovery row for it that parks at `freeze` and `freeze_artifact`;
- an artifact whose class is `planned_after_v1` or a `successor_matrix_candidate` parks, is routed to no review, approval or publication, and a `required_for_v1` class still classifies;
- a class v1 does not govern names an issue the matrix puts after v1, or one it does not classify, and a class a v1 workflow produces is `required_for_v1`;
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
