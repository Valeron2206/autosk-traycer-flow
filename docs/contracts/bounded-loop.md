# Bounded iteration loop contract

<!-- bounded-loop-contract:v1 -->

Status: issue #32 design contract. The loop controller and the escalation router are `required_for_v1`; this pins the iteration record, the four triggers, and the separation between a product iteration and a tool retry.

## 1. Authority

Iterating is how work gets done, and unbounded iterating is how a budget disappears. Without one typed contract a model can repeat the same failing approach, continue after the answer turns out to be outside the ticket, ignore evidence that killed its own premise, work around a missing permission, claim progress with no observable change, and spend the provider budget until an external cap stops it.

The closed JSON Schema is `resources/iteration-result/iteration-result.schema.json`. The verification outcome vocabulary belongs to #24 and is referenced, not restated.

## 2. Each iteration records what it did and what changed

The iteration id and number; the hypothesis or goal; the action performed; the exact changed state and paths; the verification and evidence; the outcome; the remaining blockers; the next proposed action; a progress digest; the provider, time and cost consumption; and the anchor and runtime identity.

The progress digest is what makes a no-op detectable. Everything else can be written by a model that did nothing.

## 3. Four triggers, and why each is a stop rather than a warning

1. **Repeated failure** — the same root approach, command or outcome recurred with no new evidence and no materially different hypothesis. Trying again is not a hypothesis;
2. **Decision beyond scope** — continuing needs a product, architecture, security, data, migration or delivery decision the ticket and the decision log do not grant. The model does not get to make it by proceeding;
3. **Premise invalidated** — new facts contradict a governing artifact, an acceptance criterion, the root-cause hypothesis or the execution base. The work may still be worth doing, but not on the question it started from;
4. **Permissions or recovery gap** — missing privileges, secrets, external access, a destructive recovery or an environment change are needed. **The model does not widen its own tool scope to get past this**, which is the failure mode this trigger exists for.

On a trigger the model returns a structured escalation and the host routes it deterministically. There is no "try once more" outside the cap.

## 4. Progress is observed, not asserted

Progress is decided by comparing Git, filesystem, evidence and result identities. **The same output text is not progress.** Formatting and logging changes that move no acceptance criterion are not improvement.

A repeat is allowed only with a new hypothesis or new evidence and remaining budget. Hard caps per ticket and per run are pinned **before** dispatch, because a cap chosen while iterating is a cap chosen by whoever is iterating.

## 5. A tool retry is not a product iteration

The verification outcomes come from #24. Their consequence here:

- `product_detected` and `product_not_detected` are about the product;
- `mutation_not_applied`, `green_control_failed`, `tool_setup_failed`, `tool_execution_failed`, `restore_failed`, `evidence_invalid`, `timeout` and `indeterminate` are **not evidence about product behaviour**;
- a tool retry does **not** advance the product iteration counter, and spends its own separately pinned tool-retry budget. Two budgets, because a harness that will not start should not consume the attempts the product was given;
- progress and repetition are judged against the previous iteration **of the same kind**. Two budgets, and two histories: a tool retry interleaved between two identical product attempts must not make them look like different ones;
- the same tool failure repeating with no new diagnosis activates **Repeated failure** anyway. The exemption is for retrying a flaky tool, not for retrying a broken one forever;
- `restore_failed` immediately activates **Permissions or recovery gap** and blocks the next product mutation. Continuing to mutate a product that was not restored compounds the state nobody can now describe;
- `indeterminate` does not advance a gate and is not read as "no defect found";
- changing the candidate, harness or mutation-set identity voids the previous result and starts a new attempt — without repeating a side effect that already happened;
- a committed reusable harness is fixed as an ordinary code ticket. An ephemeral one may be rebuilt inside the batch only while the contract is unchanged and with a newly recorded digest.

## 6. Crash and retry

A crash between doing the work and recording the result must not double the counter or the side effect. The iteration id is minted before the action, so a replay is recognised rather than repeated.

## 7. Refusal classes

- `loop_repeated_failure`;
- `loop_decision_beyond_scope`;
- `loop_premise_invalidated`;
- `loop_permission_gap`;
- `loop_no_progress`;
- `loop_budget_exhausted`;
- `loop_tool_budget_exhausted`;
- `loop_restore_blocked`;
- `loop_indeterminate_not_advanceable`;
- `loop_counter_replay`.

## 8. What this contract decides, and what it defers

Decided: the iteration record, the four triggers, observed progress, the two budgets, the tool-retry separation and its exceptions, and replay safety.

Deferred, and named: the loop controller, the escalation router and the report the user sees.
