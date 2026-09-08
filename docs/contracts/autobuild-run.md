# Autobuild run contract

<!-- autobuild-run-contract:v1 -->

Status: issue #28 design contract. The workflow registration, the Generator/Evaluator sessions and the host-side enforcement remain `required_for_v1`; this pins what must be approved before a run starts, what may never change during one, and what stops it.

## 1. Authority

`protocol/autobuild/run-contract.md` ships inside the governance bundle and nothing registers the workflow, so the file is bundled-but-inactive: present in every attestation, absent from every run.

Autobuild is a loop that writes code, evaluates its own output and decides whether to keep going. That is worth having and is exactly the shape that consumes a budget without anyone deciding to spend it, so it is **opt-in**: an explicit user request, or a project policy approved in advance. There is no default that starts it. The closed JSON Schemas are `resources/autobuild-run/run-contract.schema.json` and `resources/autobuild-run/run-record.schema.json`.

## 2. Boundaries

The bounded loop of #32 governs a single iteration inside one step; this contract governs a run made of sprints, and it does not restate #32's triggers. Sufficiency of a verification batch belongs to #24, the canonical finding triage to #16, the human decision packet to #35, and a discovery that changes the requirement leaves through #25. A sprint is an ordinary Ticket, so #6, #7, #8 and #9 apply to it unchanged.

## 3. Nothing starts without an approved contract

The approval covers, and the record carries: the high-level spec; a **checkable finish predicate**; the permissions and the forbidden operations; the evaluation surface and recipes; the rubric with its non-negotiable criteria; the maximum sprints; the wall-clock budget; the cost and token budget; the maximum consecutive non-improving iterations; the negotiation and restart caps; the escape hatch; and the final acceptance and integration policy.

A run with no approved contract digest is refused (`autobuild_no_approved_contract`). Approval is of a **digest**, not of a description: an approval that does not name the bytes it approved cannot be checked against the bytes that ran.

A finish predicate that is not checkable is not a finish predicate. "Until the feature is good" terminates when someone decides to stop, which is the property being removed.

## 4. The rubric does not move after the result is seen

Rubric and limits are immutable for the life of an approved contract. Changing them requires a new contract version and a new approval, and the run that continues under them is a new run (`autobuild_rubric_mutated`).

This is the rule most worth writing down, because relaxing a criterion after seeing the output is indistinguishable — in the artifact — from having chosen a better criterion. The finish predicate is covered by the same rule from the other side: it is never weakened to declare success (`autobuild_predicate_weakened`), and the sprint that claims the run finished cites the predicate digest it was approved with.

## 5. Budgets are enforced by the host

Sprints, wall clock, cost, tokens, consecutive non-improving iterations, negotiation rounds and restarts are all counted and stopped **host-side** (`autobuild_budget_not_host_enforced` when a record claims otherwise, `autobuild_budget_exceeded` when a stop did not happen). A budget the model is asked to respect is a request; a budget the host enforces is a limit. The distinction matters most when the model believes it is one iteration away.

Non-improvement is computed, not judged: the improvement metric is derived from the rubric scores of the sprint and its predecessor, and a run that has not improved for the approved number of consecutive sprints stops (`autobuild_no_progress_cap`). Deterministic, so that "it is getting closer" is not an input.

## 6. Generator and Evaluator are two parties

They are separate tasks in separate sessions, drawn from **different eligible model families**, and the Evaluator is read-only: it does not edit the candidate, the Generator's workspace or the run state (`autobuild_pair_not_independent`, `autobuild_evaluator_wrote`).

Neither dispositions the other's findings. Both go to the canonical triage, because a pair that can dismiss each other's findings is one party with two names.

## 7. A sprint is an ordinary Ticket

With an id, `depends_on`, an execution base, a worktree, a review and an integration receipt. The normal Ticket, Panel, review and aggregate verification gates are not bypassed because the work came from Autobuild (`autobuild_gate_bypassed`). A run does not acquire permissions by being autonomous.

A dispatched sprint id is minted before dispatch, so a duplicate dispatch is recognised rather than run twice (`autobuild_sprint_replay`), and a restart continues the exact run and sprint identity rather than starting a similar one.

A stopped run is stopped (`autobuild_run_continued_after_stop`). This is also what an outage means: if either party can no longer answer, the run stops rather than letting the survivor do both jobs — a Generator that evaluates its own output is the arrangement the pair exists to prevent, and it arrives by accident rather than by decision.

## 8. A major discovery stops the run

A discovery that changes the product or the architecture is not a sprint fix. It stops the run and enters the requirement revision path (`autobuild_major_discovery`), because a loop that absorbs a product decision as an implementation detail decides it without anyone noticing that it was decided.

## 9. The decision trail is append-only and inert

Every proposal, evaluation, finding, metric, decision, expenditure and stop reason is appended and never rewritten (`autobuild_trail_rewritten`). The trail is what makes a run auditable after it ends, and a trail that can be edited afterwards documents the current opinion instead.

It is also **inert as data**. A field beginning with `=`, `+`, `-`, `@`, a tab or a carriage return is refused (`autobuild_trail_injection`): the trail is exported and read in spreadsheets, and a model-authored string is untrusted input there. This is not hypothetical formatting hygiene — the values in a trail are written by the two parties the run exists to supervise.

## 10. Durable state

The run id and contract digest; the current sprint and generation; the approved rubric and limits; the Generator and Evaluator session bindings; proposals, evaluations and findings; the improvement metric and the decision; time, cost and turns spent; the stop reason; and the linked Ticket, commit and evidence identities.

Every one of those is needed to answer "what happened, and may it resume" after a crash. A run whose state cannot answer that is not recoverable, whatever it recorded.

## 11. Refusal classes

- `autobuild_no_approved_contract`;
- `autobuild_rubric_mutated`;
- `autobuild_predicate_weakened`;
- `autobuild_budget_not_host_enforced`;
- `autobuild_budget_exceeded`;
- `autobuild_no_progress_cap`;
- `autobuild_negotiation_cap`;
- `autobuild_pair_not_independent`;
- `autobuild_evaluator_wrote`;
- `autobuild_gate_bypassed`;
- `autobuild_major_discovery`;
- `autobuild_sprint_replay`;
- `autobuild_trail_rewritten`;
- `autobuild_trail_injection`;
- `autobuild_run_continued_after_stop`.

## 12. What this contract decides, and what it defers

Decided: that the run is opt-in and starts only from an approved contract digest; the twelve things that approval covers; that the rubric, limits and finish predicate are immutable for the life of a contract; that budgets and non-improvement are host-side and computed; that the pair is independent and the Evaluator read-only; that a sprint is an ordinary Ticket with the ordinary gates; that a major discovery leaves through the revision path; and that the trail is append-only and inert.

Deferred and named: the workflow registration in autosk, the Generator and Evaluator runtimes, the negotiation protocol between them, and the host-side budget meter. Those are `required_for_v1` and are not claimed here.
