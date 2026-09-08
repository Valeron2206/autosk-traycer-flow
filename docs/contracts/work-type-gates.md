# Work-type prerequisites and verification batch contract

<!-- work-type-gates-contract:v1 -->

Status: issue #24 design contract. The pre-implementation validator and the post-result validator are `required_for_v1`; this pins the per-type prerequisites, the batch record and the closed outcome set. This document is the **canonical owner** of the scaffolding-sufficiency rule; #23, #27 and #36 reference it and do not restate it.

## 1. Authority

Four work-type playbooks ship in the governance bundle. Including their text in a prompt is not enough: a model can read a requirement and proceed to verification anyway. The requirements become typed fields with deterministic gates, or they are advice.

The closed JSON Schema is `resources/verification-batch/verification-batch.schema.json`.

## 2. `work_type` decides the contract

`work_type` is a required Tickets field, and each value brings its own prerequisites.

**`feature`** — before implementation: the chosen data shape or organizing structure; why it is a state machine, a table or a typed model rather than a set of booleans kept in sync; the rejected alternatives; tests for the new behaviour in the same ticket; per-criterion verification.

**`bug-fix`** — a fix ticket exists only when the root cause is established, a runtime evidence pointer is attached (a log, a trace, a debugger session or a minimised failing input), the repro is confirmed on a matching surface, and a failing regression test exists **before** the fix. With an unknown cause, a separate read-only debugging task comes first: **investigate-and-fix in one handoff is refused**, because a handoff that may change the code has no way to prove what the code did before it.

**`refactoring`** — before the change: a characterization test, snapshot or equivalence harness, and an exact behaviour pin. **Typecheck and lint are not a pin** — they constrain shape, not behaviour. A behaviour change discovered mid-refactor produces its own ticket. The end requires an equivalence proof on a real artifact or surface.

**`perf`** — before the baseline: the warm-up policy, the minimum repeat count, the spread statistic, the noise threshold, the exact command, workload and environment, and the hypothesis. The same method is used after. A delta inside the threshold is `inconclusive`, **never** a pass — and the threshold is fixed before the numbers exist, because a threshold chosen afterwards is a description of the result.

A ticket mixing incompatible work types is split or escalated. Bug investigation, refactor and feature are not silently glued into one unbounded ticket.

## 3. Where exact scaffolding code belongs

The exact listing of new throwaway verification scaffolding — mutation scripts, fault-injection drivers, disposable fixture generators, temporary harnesses, diagnostic probes, glue built to prove one batch — does **not** belong in a planning artifact by default. The planning artifact defines the **proof contract**; the code is built during implementation, where it immediately faces its own red and green controls and an ordinary code review if it is kept.

A missing listing is not a finding when the proof contract is complete and unambiguously executable. **Missing both the listing and a complete proof contract is a finding.**

Exactness stays in the plan for: production code, API, wire and schema contracts; state machines; security-critical canonical algorithms; Git, ref and migration transactions where the order of operations is part of the safety; an existing repository command the user must run literally; a committed reusable tool interface; minimal pseudocode without which two materially different semantics remain; and exact code the operator asked for.

Where a listing IS included, it becomes part of the normative candidate and is reviewed literally — executability, quoting, encoding, paths, exit codes, cleanup and recovery are all in scope.

If an operator's current disposition says to remove a listing, it is removed **completely**. Rewriting it, moving it to an appendix, hiding it under `<details>`, translating it to another language, or leaving equivalent pseudocode of the same implementation are all refused: each of those keeps the thing the disposition asked to remove. The obligation survives as a declarative contract, and the change creates a new planning-artifact identity.

## 4. The batch record

Every non-trivial mutation, fault, equivalence or performance batch has a machine-readable record: the batch id and purpose; the candidate identity (project, epic, ticket, base and candidate commit and tree, declared pathspec, and the anchor, runtime, protocol and project-instruction identities); the owner and lifecycle; the target; the preconditions; the input and output contract; the mutation and evidence matrix; the failure taxonomy; recovery; evidence locations and digests; repository verification; and the acceptance rule.

## 5. Outcomes are a closed set, and four of them are not failures of the product

`product_detected`, `product_not_detected`, `green_control_failed`, `mutation_not_applied`, `tool_setup_failed`, `tool_execution_failed`, `restore_failed`, `evidence_invalid`, `timeout`, `indeterminate`.

The invariants are the point:

- `tool_execution_failed` is **not** a survived mutation. The harness broke; the product was not tested;
- `mutation_not_applied` is **not** a product pass. Nothing was changed, so nothing was proven;
- `green_control_failed` **voids** the batch evidence. If the unmutated candidate fails its own controls, the red result means nothing;
- `restore_failed` blocks continuation and starts recovery;
- `indeterminate` never becomes a pass;
- a product defect and a tool crash have different outcomes and different recovery routes, because treating them alike sends someone to debug the wrong thing.

## 6. Red/green sufficiency

For every mutation or fault: proof it actually changed the target anchor or state; the expected killer and its red signature; a green control on the unmutated candidate; a harness self-test or a known killed mutation; a final run of the existing repository tests; and proof the original state was restored.

**A batch is not sufficient because a temporary script exited 0.** That is the sentence this section exists for.

## 7. Identity and staleness

For Git-backed candidates the comparison is over exact tree, blob, mode, symlink and gitlink identities — not an abstract "the working directory looks the same". For serialised non-Git artifacts it is byte-for-byte, when bytes are the canonical form.

A result binds to the exact candidate, environment, tool and harness digest, mutation-set digest, attempt and controlling policy. Changing any of them makes the old result **stale**, not merely old.

## 8. Ephemeral and committed scaffolding differ

`ephemeral`: created outside the product source tree or in a project-owned evidence root; never left undeclared in the worktree; its exact source, binary and config digests recorded in evidence; deleted only after a verified restore; and never a deliverable.

`committed reusable`: inside the ticket pathspec, with its own tests and an ordinary cross-family code review, part of the repository's verification infrastructure — and no longer covered by the exemption for temporary listings.

## 9. Refusal classes

- `worktype_missing`;
- `worktype_mixed`;
- `bugfix_root_cause_unknown`;
- `bugfix_investigate_and_fix_combined`;
- `refactor_behavior_pin_missing`;
- `perf_threshold_after_result`;
- `batch_contract_missing`;
- `batch_proof_contract_incomplete`;
- `batch_mutation_not_applied`;
- `batch_green_control_failed`;
- `batch_restore_unverified`;
- `batch_result_stale`;
- `batch_listing_disposition_evaded`.

## 10. What this contract decides, and what it defers

Decided: `work_type` as a typed gate with per-type prerequisites, where exact scaffolding code belongs, the batch record, the closed outcome set and its invariants, red/green sufficiency, staleness, and the two scaffolding lifecycles.

Deferred, and named: the pre-implementation validator, the post-result validator, and the stage-carrier delivery of playbook bytes.
