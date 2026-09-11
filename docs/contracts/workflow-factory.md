# Workflow factory contract

<!-- workflow-factory-contract:v1 -->

Status: issue #10 design contract, slice 5 of six for criterion 2. It builds the workflow an extension registers from `resources/workflow-graph/workflow-graph.v1.json`; it does not define that document, which is `docs/contracts/workflow-graph.md`.

## 1. Authority

Criterion 2 asks that `workflow_graph_digest` cover steps, transitions, guards, caps and recovery targets. Slice 2 made those a document, slice 4 pinned the runtime's identity lock, and slice 5 patch `0032` put the document's digest inside the declared shape. None of that makes the document run: until this factory, the graph was a specification nothing executed, and a workflow whose behaviour came from hand-written code would be pinned to a document it need not obey.

This contract is the projection: no decision is taken here that the document does not state.

Not every declared field has a reader, and claiming otherwise is the kind of sentence this epic has already paid for. These do not: `caps` (section 6 says why, with numbers), `views` (rendered by slice 3, read by nobody at runtime), `entry_steps` (section 2), `guards[].authority` and `predicates[].reads` (they say who may take a transition and what state it inspects — both are the evaluator's business, and this factory does not evaluate), and `recovery[].parks_at` and `required_state` (design-time statements the graph validator checks). `graph_reasons` is pinned by the schema to two codes that are their own names, so reading it back would only compare a constant with itself.

## 2. What the engine actually calls

`WorkflowDefinition.onTransit(ctx, to)` is a **veto**, not a selector. The engine calls it for every transition — enroll, step to step, resume — with the target already chosen, and rejects the transition when it throws; the return value is discarded. `daemon/sdk/src/workflow.ts` says so, and `daemon/core/src/engine/transition.ts` builds the context it is handed.

The first writing of this factory returned a destination from `onTransit` and called that "the shape the daemon's `onTransit` expects". It was not, and nothing in this repository would have said so: a workflow built that way registers, enrolls, and then goes wherever the step body sends it, with the graph never consulted.

So the two operations sit either side of one hook:

| Moment | Who asks | What decides |
| --- | --- | --- |
| a step has finished its work | the step's own `onRun` | operation 1, selection |
| the engine is about to commit any transition | `onTransit` | the same document, against the target already named |
| the engine is about to commit a resume | `onTransit`, seeing a parked task | operation 2, the park reason's targets |

One function decides and the same document verifies. That is the only arrangement in which the choice and the check cannot disagree.

Enroll admits `first_step` and nothing else. The document's `entry_steps` are not alternative entries to this workflow: they are the first steps of the other workflows the plan registers and the two steps the daemon enters out of band, declared so reachability has its seeds. A factory that admitted them would be enrolling a task into one workflow at another workflow's beginning.

## 3. Operation 1: selection

Out of the current step, every declared edge whose guards all hold is a candidate, and the lowest priority among them wins. Priorities out of one step are distinct — `graph_priority_ambiguous` refuses a tie — so the winner is a function of the document and of the predicate answers, and of nothing else.

A guard that does not hold DISQUALIFIES its edge; it does not park the flow. A false guard is the ordinary way an alternative is not taken, and parking on it would stop a flow every time it chose the second of two paths.

Parking happens only when no edge is a candidate, and then the step's own `no_transition_reason` says why. The schema requires that field on every agent step, so a park with no reason is unreachable from a valid document; the code `no_transition_reason` is issued anyway when a document finds a way there, because `undefined` is not a reason anything can resume from.

## 4. Operation 2: resume

A parked flow may be resumed only at a target the PARK REASON permits, never at one the step permits. Two reasons can park at the same step and allow different targets, so reading permission off the step would let a resume that one reason forbids be laundered through another that was never the reason for this park. The shipped graph has such pairs, and a test walks them.

Permission is not additionally checked against the edges out of the step the flow stands at. That is deliberate and measured: of the 6245 `(named step, resume target)` pairs the document declares — a step being one its row names in `parks_at` or in `handled_at` — 5312 are not a declared edge out of that particular step. The rule the graph contract states, and that `scripts/validate-workflow-graph.mjs` enforces, is that a target is an edge out of ONE of them, so requiring an edge out of the current one would refuse most of the resumes the document sanctions.

One move needs no permission, and only one: re-entering the step the flow already stands at **when nothing recorded why it stopped**. That is the daemon's own park after an infrastructure failure, which carries no reason because the graph did not park it, and refusing it would strand such a task forever.

A RECORDED reason governs every target including the current step. The first writing of this rule left the exception unconditional, and round 1 of the review measured what that costs: `alignment_policy_out_of_scope` permits five targets and not `clarify_alignment`, a step it parks at, and an ordinary `autosk resume` re-ran that step anyway — the daemon recorded `status=work` and the step's counter went from 1 to 2. The justification offered for the exception was that re-entry grants nothing new, and that was not true either: re-entry runs the step's body and its effects again.

The reason itself is read from the task's metadata at `park.reason`. That is the plan's own notation: every recovery row's `required_state` is written `human с park.reason=<code>`. The daemon has no park reason of its own — `metadata` is free-form and opaque to it apart from the `step_visits` counter it maintains — so the factory records the reason with `autosk metadata set` before it parks, and a failed write throws rather than parking a task nothing could resume.

## 5. What a park reason is, and whose it is

Three of them come from the document and are relayed unchanged:

| Source | When it is named |
| --- | --- |
| a step's `no_transition_reason` | selection found no candidate |
| a guard's `park_reason` | the guard refused an EXPLICITLY REQUESTED target, **and** the guards of an edge the flow took into a parking step |
| a cap's `park_reason` | not issued here — see section 6 |

The second is the one this slice found a reader for, and round 1 of the review found the half that was still missing.

The schema wrote the field as "the reason named when this guard refuses an explicitly requested target", and the veto is the only place a target is requested by name. But a flow also stops by TAKING a declared edge into a step whose status is `human`, and the shipped graph draws 221 of those — that is how a flow ordinarily stops, not an edge case. The first writing recorded a reason only when selection found no candidate, so an ordinary park wrote nothing, and operation 2 then refused a resume the reason permits. Worse: a `park.reason` left by an EARLIER park stayed, so the next resume's permissions came from a stop that was already over.

The document does name the reason for those edges, and says so in the plan's own notation: `cond_002` ends "human с park.reason=planning_ref_capability_missing" and `guard_002`, the guard on `init_planning_ref -> human`, carries exactly that reason. Every one of the 221 parking edges is now guarded by guards naming one reason, so the answer is unambiguous.

Nine of them were not. Each was ONE condition with two or three candidate reasons: every guard on such an edge named the same predicate, so the document said "when this holds, park here" without saying which reason applied. Splitting the edge in the graph would have produced indistinguishable copies, because the predicate was the same on all of them — the discriminator was in the PLAN and not in the graph, which is what the repair carried across.

**Such a document is refused when the workflow is built, before anything runs.** Two weaker answers were tried and both were measured failing, which is why the refusal sits where it does.

Refusing when the edge is TAKEN does not work: the refusal fails the session, the engine then parks the task, and whatever an earlier park wrote is still in `park.reason`. Round 1 attempt 2 resumed such a task to a step that only the stale reason allowed and none of the ambiguous edge's own reasons would have.

Clearing the stale reason before refusing does not work either: round 1 attempt 3 injected a failure into that write and the hole came straight back, with the old reason surviving and the resume passing. Nothing inside a running step can close this, because the engine parks the task after the step gives up and the factory has no write that lands together with the position.

So the executable is refused at the point where it would be produced, and that refusal did its work: **the shipped `autosk_flow` document was not executable, and now is.** The nine were repaired in the document, by the rules the plan itself carries — four of them transcription of a split the plan already writes as separate rows. The refusal stays for the next document that cannot say why it stops, and the suite exercises it against an edge made ambiguous on purpose rather than against bytes that no longer are.

The design validator carries the same refusal now, as `graph_park_reason_ambiguous`. Refusing only at build was refusing after the document had already been shipped, pinned and digested — and the example in this repository proved the gap was not theoretical: it shipped with a parking edge carrying no guard at all, and the validator accepted it for as long as the check lived only here.

These reasons belong to the park vocabulary, which `resources/refusal-vocabulary/refusal-vocabulary.v1.json` enumerates and `03-technical-plan.md` §7 owns. They are not this contract's, and putting them in its closed set would make it look like the owner of eighty-four codes it merely passes on.

## 6. Caps are not enforced here, and the reason is measurable

The document counts the taking of one named transition. The engine's only durable counter is `metadata.step_visits[step]`: entries into a step, by any edge.

The two are not the same count, and for the shipped graph they are far apart. Cap `artifact_review_round` counts `t_231`, which is `narrow_review_join -> fix_artifact`; `fix_artifact` is entered by nine declared edges, seven of them self-loops. Cap `code_review_round` counts `t_443`, which is `record_code_verdict -> fix`; `fix` is entered by two. A cap enforced on entries would fire earlier than the document says, and by an amount that depends on how a flow arrived rather than on how many rounds it ran.

The alternative — counting takings in the workflow's own state — is available (the SDK names comments as a place to count) and is not durable in the write that moves the position, so a crash would double-count or lose a round. Between a cap that fires at the wrong time and a cap that is exact but not durable, this slice ships neither and says so. Enforcement is deferred with the measurement above; the document keeps declaring the caps, they stay inside the digest, and `graph_cap_transition_unknown` keeps checking that each names a real transition.

## 7. The shape the daemon sees is a function of the document

Measured where it is decided, and not composed out of three checks that each hold up one leg.

`scripts/verify-autosk-graph-digest.mjs` builds six documents that differ from a base by exactly one component — steps, transitions, guards, caps, recovery — installs each as an extension this factory builds, enrolls one task in each against a real daemon, and reads back the `metadata.runtime_identity.graph` the daemon pinned. Six digests, all distinct.

Its control is what makes it a measurement of criterion 2 rather than of six different workflows: what a declaration can express — step names, kinds, statuses, hooks — is byte-identical in all six, and the script asserts that too. So the digest did not move six ways because the declaration differed. It moved because the document's digest is inside the shape, and none of those five components is otherwise in it.

The three legs still hold it up underneath, each checked by its own command, and they are what would localise a break:

| Leg | What holds it |
| --- | --- |
| every one of the five components moves the document's `canonical_digest` | `npm test`, `test/runtime-workflow-factory.test.mjs` |
| the definition carries that digest, and the bodies of the steps do not move it | the same suite |
| the canonical shape serialises that digest, and serialises its absence too | `npm run validate:runtime-identity-lock`, requirements `definition_carries_document_digest` and `document_digest_in_shape`, plus `daemon/core/test/extensions.graph.test.ts` in the pinned series |

**The digest is computed here, not carried.** `buildWorkflow` hashes the document it was handed, and refuses one whose own `canonical_digest` describes different bytes. The first writing copied the field across, and round 1 of the review measured what that allows: six documents differing in a component each, all carrying the same stale digest, were accepted by a real daemon and pinned to one identity — `81e8f04e…` for all six. The shipped measurer passed anyway, because it recomputes the digest before registering, so the working path's guarantee was never the thing being tested. `npm run validate:workflow-graph` checks the file in this repository; it cannot check the object this function was called with, and that object is the boundary that matters.

The canonical form itself lives in `src/host/workflow-graph-canonical.mjs` for that reason. It was `scripts/validate-workflow-graph.mjs`'s while that validator was its only reader; a second implementation of "canonical" is precisely what slice 1 exists to prevent, so it moved rather than being copied, and the validator re-exports it.

Hook presence is part of that shape. No step in the shipped document declares `hooks`, so every agent step is built with `onRun` and nothing else; a document that declares more is refused at build time rather than built without them, because ignoring a declared hook would make the shape a function of this file instead of the document.

## 8. Counter durability, and the boundary it has

Established from the source before the crash test was written, which is the order the ticket requires.

`store.setPosition` bumps `metadata.step_visits[step]` in the SAME `mutateTask` write as the position, and `taskStore.writeTask` is one `atomicWrite` of `task.json` — a pid-scoped temporary, an fsync, a rename. The whole record lands in that one write or none of it does.

So the boundary is not a lost count against a moved position, which cannot happen. It is a repeated transition: a crash between `onTransit` returning and that write landing loses the whole transition, so the task stays at the old step with the old count and the step is entered again. **Execution of a transition is at-least-once; counting is exactly-once per durable entry.**

`scripts/verify-autosk-visits.mjs` stands on exactly that boundary, against a real daemon running a workflow this factory built, and the compatibility workflow runs it on every pull request.

The instrument is the window itself. `scripts/verify-autosk-crash.mjs` kills the native store writer, which is the right tool for the creation index and the wrong one here: `write_task` reaches `autosk-store-lock` only on the scoped creation path, and `setPosition` writes inside the daemon. So this test kills the daemon from the last workflow code that runs before the write — the graph's veto has passed, the engine has not yet committed, and SIGKILL to its own pid leaves nothing to unwind. The first writing of it armed the native writer and passed nothing, which is how the difference was found rather than assumed.

## 9. Refusal classes

Closed set: `guard_unknown`, `park_reason_ambiguous`, `predicate_unknown`, `step_unknown`.

Three of these are what the factory issues when the document reaches it malformed — a step, a guard or a predicate that nothing declares. Each has a design-time counterpart the graph validator issues over the document (`graph_step_unknown`, `graph_guard_unknown`, `graph_predicate_unknown`), and they are separate codes on purpose: at design time a document is refused, and at runtime a task is. A caller that cannot tell the two apart cannot tell a bad document from a good one loaded wrong.

`park_reason_ambiguous` is the fourth, and it is not about a malformed document but about an under-specified one: an edge that parks the task whose guards name more than one reason, or none. Section 5 says why picking one would be worse than refusing.

Four further codes the factory produces are owned and closed by `docs/contracts/workflow-graph.md`, which owns what the graph says about itself: `graph_digest_stale`, `no_transition_reason`, `resume_target_not_permitted` and `transition_not_declared`. They are produced here and declared there, and the suite asserts that each of the eight is closed by exactly one contract.

An undeclared predicate fails closed in both operations rather than reading as false. False is an answer, and the honest answer to an id nobody declared is that nobody can give one; answering "not a candidate" would look exactly like the edge correctly losing.

**Closure is decided when the document is read, not when a guard is evaluated.** `index` resolves every reference the graph makes — each edge's steps, each edge's guards, each guard's predicate — and refuses the document otherwise. The first writing put that check inside the evaluation of a guard, where it covered selection and the veto's ordinary path and missed the one operation that evaluates no guards at all: a resume answers from the park reason alone, so a document naming an undeclared predicate was admitted by exactly the operation the ticket names alongside the other. Closure is a property of the document, so it is decided once, where the document is read. The consequence a reader should expect is that `guard_unknown` and `predicate_unknown` now come out of `index` and `buildWorkflow` rather than out of an operation.

## 10. Required implementation tests

- each of the five components moves the digest the definition carries, and each moves it somewhere of its own
- the declared shape is identical whether or not step bodies are supplied
- a false guard leaves the next candidate by priority winning, and does not park
- twelve steps park with their own reason under an evaluator that answers false to everything
- a step with no reason and no way out parks with `no_transition_reason` rather than with `undefined`
- the counterexample of two reasons sharing a parking step with divergent targets, taken from the shipped document
- enroll admits the first step and refuses every other target
- a guard refusing a requested target names that guard's `park_reason`, and it is a reason the document declares a row for
- a status target is admitted exactly when selection parks, and refused when a candidate edge exists
- a parked flow is refused a status move and a forbidden step, however the guards would vote
- a parked flow re-enters the step it stands at with no reason recorded, and reaches nothing else that way
- an undeclared predicate and an undeclared guard refuse both operations
- a guard declaring no park reason refuses by name rather than with `undefined` as the code
- every code in the factory's declared set is produced by running it, and every one is closed by exactly one contract
- six documents differing by one component each are pinned to six distinct `workflow_graph_digest` values by a real daemon, while what their declarations express stays byte-identical
- a crash between the veto and the position write leaves the position and every counter where the crashed run found them, and the step whose transition was lost does its work again
- the built `onTransit` answers a parked task and a working one differently, and the built `onRun` moves where selection says or records its park reason before parking
- a park whose metadata write fails refuses instead of parking a task nothing could resume
- a declared edge into a parking step records the reason its guard names, replacing whatever an earlier park left, and that reason permits a resume at the step it stopped at
- the shipped document builds and every one of its parks names exactly one reason, while an edge made ambiguous is still refused and an edge with no reason at all is refused with a different detail
- a recorded reason refuses re-entry into a step it does not permit, while a park with no reason still admits it
- a document naming an undeclared predicate is refused when it is read, so no operation can be reached under it
- a document whose digest describes different bytes is refused, and one carrying no digest is computed rather than refused

Two of these run against a real daemon rather than in the suite, because what they measure is the daemon's: the six-document digest case is `scripts/verify-autosk-graph-digest.mjs`, for section 7, and the crash case is `scripts/verify-autosk-visits.mjs`, for section 8. The compatibility workflow runs both on every pull request. The rest are `test/runtime-workflow-factory.test.mjs`.

Both verifiers install the factory into a real project as an extension, and both must copy `src/host/workflow-graph-canonical.mjs` beside it. Moving that module out of the validator broke exactly this and neither verifier was re-run against the tree that moved it; the extension failed to load with `ERR_MODULE_NOT_FOUND` and both exited 1. A daemon-side test is only evidence when it is run after the change it is evidence for.

## 11. What this does not prove

That the predicates are answered correctly: the document says what state each reads and this factory does not evaluate them.

That the graph is the right graph. It proves the runtime obeys the document, not that the document describes the product. That is what the views of slice 3 and the chain check are for.

Building the runtime did surface one thing about the document, and it is recorded rather than repaired here. Exactly one agent step has no outgoing edge — `ticket_done`, entered from `commit_on_pass` — so a flow that reaches the end of a ticket parks, and the reason it parks with is `project_boundary_invalid`, the daemon's generic boundary check. Nothing in the graph validator asks an agent step where it goes, so nothing refused it. The suite names the step, so a second one added with no way out fails rather than joining it quietly; whether `ticket_done` should be a status step or lead to one is a change to the document and an owner's to make.

That caps hold. Section 6 says why, with the numbers.

That a workflow built here has run in the daemon. `scripts/verify-autosk-visits.mjs` drives a real one for the durability boundary; nothing here drives all seventy-two steps, and no count in this repository should be read as covering that.
