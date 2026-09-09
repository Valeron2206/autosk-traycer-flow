# Arena contract

<!-- arena-contract:v1 -->

Status: issue #4 runtime contract. `01-core-flows.md` §4 describes the path; panel round 2 found that the path which changes a Tech Plan had neither a contract nor a schema, while Debate — the path Arena is chosen *instead of* — had both.

## 1. Authority

Arena is the empirical branch of one decision: when an artifact could be built whose existence answers the question, it is built rather than argued about. Two implementers work the same framing in isolation, a judge from a third family ranks what they produced, and a person decides what to keep.

Everything here exists because that arrangement has three ways to become theatre — candidates that saw each other, a judge that approves rather than ranks, and a "winner" that never re-enters the plan — and each is refused rather than discouraged.

## 2. Boundaries

This contract decides what a running Arena must satisfy and what its block records. It does not decide when to open one (`01-core-flows.md` §4 and the Tech Plan's own framing), it does not decide between Arena and Debate (`docs/contracts/debate.md` §3 owns that question), and it does not review code (that is the code-review path, later and separately).

## 3. Framing is closed before any candidate starts

The closed JSON Schema is `resources/arena/arena-block.schema.json`.

An Arena opens on an approved framing: a reason and **three to six measurable criteria**. Fewer than three is not a comparison; more than six is a survey, and a judge ranking on a dozen axes is choosing which ones to weigh — a decision nobody delegated. Criteria added after a candidate started are refused (`arena_framing_changed`): a criterion written once the work exists is a criterion written to fit it.

## 4. Isolation is a property, not an instruction

Candidates run in separate worktrees, from two distinct families, and see neither the judge's criteria nor each other's work. A candidate whose transcript, workspace or prompt contains another candidate's output is refused (`arena_candidate_contaminated`) — not downgraded, because two candidates that saw each other are one candidate with extra steps.

Fewer than two live candidates from distinct families ends the Arena with no winner. The coordinator parks in `human` with `arena_fallback_required`, and the fallback is chosen by an exact daemon `UserDecisionRecord`; an autonomous policy does not close it.

## 5. The judge ranks, and ranking is not approving

The judge comes from a family outside the candidate set, receives anonymised A/B/C, executes nothing in a candidate worktree, and scores the behavioural criteria against the evidence presented. A judge from a candidate's family is refused (`arena_judge_family_conflict`); so is a judgment that names a winner without scoring every declared criterion (`arena_judgment_incomplete`).

A judge that "approves" rather than ranks is refused (`arena_judgment_is_not_approval`). The recommendation is an input to a person's decision, and a role that both produced the ranking and closed the decision would be the model approving its own material choice — the one thing §2 of the core flows forbids everywhere else.

Where the evidence has a gap, it is closed by a separate check on the frozen snapshot rather than by the judge's inference.

## 6. A decision that is not re-expressed did not happen

After the person's decision, the final implementer re-expresses the selected ideas in the Tech Plan. Grafting a candidate's bytes wholesale is not re-expression: the plan is the artifact under panel, and a plan nobody rewrote is a plan nobody read.

A Tech Plan whose bytes are unchanged after an Arena decision is refused (`arena_reexpression_missing`), and the identity must differ from the pre-Arena one.

## 7. Changing a Tech Plan invalidates its PASS

An Arena result creates a new artifact identity and voids the previous PASS. `narrow=false`: the Lead-only narrow re-review exists for fixing findings the panel already confirmed without changing scope, and an Arena result is a scope change by construction. A block that claims the narrow exemption is refused (`arena_narrow_exemption_claimed`).

## 8. The block

The extension extracts an `autosk-arena` block mechanically, so it is machine-readable or it is nothing. A malformed or absent block where the Tech Plan declared an Arena decision is `arena_contract_invalid`; the repair is `fix_artifact` with `narrow=false` and a new full panel.

## 9. Refusal classes

Closed set: `arena_framing_changed`, `arena_candidate_contaminated`, `arena_fallback_required`, `arena_judge_family_conflict`, `arena_judgment_incomplete`, `arena_judgment_is_not_approval`, `arena_reexpression_missing`, `arena_narrow_exemption_claimed`, `arena_contract_invalid`.

## 10. What this contract decides, and what it defers

Decided: the framing bound, isolation as a refusal rather than a rule, the judge's family and the limit of what a ranking is, re-expression as a property of the bytes, and that an Arena result never takes the narrow path.

Deferred, and named: the four candidate-lifecycle park reasons (`arena_candidate_failed`, `arena_candidate_verify_failed`, `arena_candidate_freeze_invalid`, `arena_join_invalid`) belong to the child-workflow lifecycle in `03-technical-plan.md` §7 and are owned there, not restated here. A reason declared by two documents has no single owner, which is what `refusal-vocabulary.md` §6 refuses.
