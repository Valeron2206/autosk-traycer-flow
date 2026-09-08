# Structured model result contract

<!-- model-result-contract:v1 -->

Status: issue #18 design contract. Runtime implementation remains `required_for_v1` after design gate #39.

## 1. Authority

Every model-owned step runs the same way, and the shape is not negotiable per role:

```text
model run
  → exactly one structured result submission
  → host schema validation
  → project / anchor / runtime / protocol revalidation
  → filesystem, Git and evidence validation
  → immutable result record + read-back
  → deterministic transition selection
  → exactly one ctx.transit
```

The closed JSON Schema is `resources/model-result/model-result.schema.json`.

A model returns data. It does not move a task, edit metadata, write a comment as canonical state, or name the next step. The invariant this contract exists to keep is short: **a model's output is evidence, not an effect.** Free-form JSON inside prose is not a result — it is prose that happens to contain braces.

## 2. Boundaries

Issue #16 owns the finding registry a gate result feeds; #24 owns the verification-batch contract whose taxonomy is reproduced here rather than redefined; #26 owns provider adapters and their capabilities; #15 owns the immutable gate projection; #14 registers this artifact class. This contract does not define workflows, only what a step may return and what the host must check before anything moves.

## 3. Capabilities by role

Closed, and deliberately narrow:

| Role | May do |
| --- | --- |
| author, implementer | scoped workspace edit, read and exec tools, plus `submit_work_result` |
| gate roles | snapshot-rooted read tools, plus `submit_gate_result` |
| verifier | a deterministic runner, or scoped `submit_verification_result` |
| mediator, coordinator | only explicitly allowed host-mediated decision tools |

No role gets a generic `autosk task`, `step`, `comment` or `metadata` mutation tool. That is not a policy about how models should behave; it is the absence of the tool.

## 4. Result kinds

Seven closed, versioned kinds: `artifact_author`, `implementation`, `fix`, `verification`, `verification_batch`, `arena_candidate`, `requirement_analysis`.

An `implementation` result records the outcome — `ready_for_verification`, `blocked` or `needs_human` — a summary, the claimed changed paths, per-criterion evidence references, the tests and commands it reports having run, artifact impact, decisions, assumptions and escalations, and the protocol attribution echo.

It does **not** contain a next-step string. The transition is selected by the host from the outcome and the checks below; a model that could name its own next step would be moving the task with extra steps.

## 5. What the host checks before anything moves

- the result validates against its closed schema, and an unknown field or an out-of-enum value fails;
- the project, anchor, runtime identity and protocol are still the ones the step was dispatched under;
- **claimed changed paths are compared against the actual Git and filesystem state** — a claim is not evidence of itself;
- evidence references resolve;
- the record is written immutably and read back before the transition.

Failure at any point leaves the task where it was. An invalid or missing result does not clear a blocker and does not create a PASS. This is the criterion that makes the difference between a system that verifies and one that hopes.

## 6. Exactly one

Exactly one result submission per step, and exactly one transition per result.

- No submission at all: the step did not complete. It does not "probably succeed".
- Two submissions: the second is refused; the first stands, and the discrepancy is recorded.
- A provider that exits non-zero *after* a valid submission has still submitted — the exit code is not the result.
- A provider that exits `0` with no structured result has not submitted. Exit `0` is not a result, and free-form success text is not a result.

## 7. Verification batch

The verification-batch result keeps the closed product, tool and environment outcome taxonomy of issue #24 rather than inventing a second one. Three consequences follow, and each is a criterion:

- a **tool failure** or an **indeterminate** outcome is never mapped to a product disposition. "The harness broke" and "the product is wrong" are different facts, and a transition table that collapses them manufactures verdicts;
- a mutation-application proof, a green control and a restore receipt are all required — missing any of them means the batch did not demonstrate what it claims;
- a stale harness or mutation-set digest invalidates the batch rather than being tolerated as close enough.

## 8. Provider parity

Every provider adapter has the same semantics. The same fake result through the Opus, Astra, Grok and Muse adapters produces the same host behaviour, and a test says so — otherwise "the panel agreed" could mean four different pipelines agreed about four different things.

## 9. Identity

`result_schema_version` and the result kind are fields of the runtime lock, so a result accepted under one schema version is not silently reinterpreted under another.

## 10. Park reasons

Closed set: `no_result_submitted`, `multiple_results_submitted`, `schema_invalid`, `unknown_field`, `scope_mismatch`, `evidence_unresolved`, `stale_anchor`, `stale_runtime_identity`, `tool_failure_not_product_disposition`, `missing_application_proof`, `missing_green_control`, `missing_restore_receipt`, `stale_harness_digest`.

## 11. Required implementation tests

- no submission, and two submissions;
- free-form JSON in prose offered as a result;
- an invalid enum value and an unknown field;
- claimed paths that differ from Git;
- a model attempting an autosk mutation;
- a provider exiting non-zero after a valid submission;
- a crash before and after the record, and before and after the transition;
- a stale anchor and a stale runtime lock;
- a target-injection attempt in a result field;
- the same behaviour across four provider adapters;
- a verification harness exiting `0` with no structured result;
- a missing mutation-application proof, a missing green control, a missing restore receipt;
- a tool failure attempting a product PASS transition;
- a stale harness or mutation-set digest.

## 12. Acceptance mapping

| #18 criterion | Where it is met |
| --- | --- |
| No model changes task state directly | §1, §3 |
| Every model step has a closed result schema | §4 |
| Host validates scope, evidence and identity before transit | §5 |
| Exactly one result and exactly one transition | §6 |
| Provider adapters have the same semantics | §8 |
| Invalid or missing output clears nothing | §5, §6 |
| Result schema and version in the runtime lock | §9 |
| Verification batch keeps #24's taxonomy | §7 |
| Exit `0` or free-form text does not advance a gate | §6 |
| Tool failure is not a product disposition | §7 |
