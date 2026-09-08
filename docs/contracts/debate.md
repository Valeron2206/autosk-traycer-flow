# Debate contract

<!-- debate-contract:v1 -->

Status: issue #31 design contract. The workflow registration, the participant and mediator runtimes and the round driver remain `required_for_v1`; this pins when a Debate may start, what a roster has to be, and what a synthesis may claim.

## 1. Authority

Arena answers questions that a built artifact can settle. There is no autosk-native equivalent for the questions it cannot: values, priorities and trade-offs, where no cheap empirical test exists.

Without one, those questions go somewhere worse. They are sent to Arena, which answers a different question well; or one orchestrator decides alone with no independent positions; or they are recorded as assumptions, which is how a decision becomes invisible; or they block the project with no compact packet a person could decide from. The closed JSON Schema is `resources/debate/debate-manifest.schema.json`.

**Panel and finding contest are not substitutes.** A Panel criticises a candidate artifact; a contest tests one specific finding; a Debate explores the space of positions *before* there is a decision to criticise.

## 2. Boundaries

The decision packet is #35's, the four-model Panel #15's, the requirement revision path #25's, and the clearance scan #20's. This contract owns when a Debate may start, what its roster and rounds must be, and what its synthesis may claim.

## 3. Arena or Debate, decided by one question

**Is there an artifact whose construction would answer this?** If yes, it is an Arena question and a Debate is refused (`debate_empirical_question`). The classifier is recorded with the manifest, not left to judgement at dispatch time, because the temptation runs one way: a Debate is cheaper to start than a prototype and produces something that reads like an answer.

## 4. Two gates, in order

A Debate starts only on an **explicit user request**. The orchestrator may propose one at an escalation; it does not start one (`debate_started_without_request`).

Then two approvals, and the second cannot precede the first (`debate_gate_missing`):

1. the question and the roster of perspectives;
2. the exact model routes, the roles, the round cap and the budget.

Splitting them is deliberate. The first asks whether this is the right question and whether the positions are the right ones; the second asks what it will cost and who will speak. Answering both at once means answering the second without having settled the first.

## 5. A roster is three to five distinct positions

Distinct perspectives, each with its own participant task and session, each stating a stance that differs from every other (`debate_roster_not_diverse`). Fewer than three is not a debate; more than five produces synthesis nobody reads. The routes are exactly the ones approved at the second gate — a substituted route is a different participant.

**Round 1 positions are independent.** No participant sees another's round-1 answer before writing its own (`debate_round_one_contaminated`), because the first thing a model does with a visible position is agree with it.

**Later rounds cross-examine specific claims.** Each position after round 1 cites the claim or assumption it addresses (`debate_no_cross_examination`). Without that, round two is round one repeated more confidently.

Participants do not edit each other. A participant that is unavailable or degraded gets a **user-visible disposition** (`debate_unavailability_undisclosed`): a debate that quietly continued with three of five seats answered a question nobody asked.

## 6. The mediator shows disagreement

Synthesis after every round records what is agreed, what is disputed, the minority views and the unresolved assumptions. A synthesis that claims consensus while positions still disagree is refused (`debate_false_consensus`), and minority views are never dropped as the rounds converge (`debate_minority_dropped`).

This is the failure mode a mediator has: summarising is easier when the summary is clean, and a clean summary of a real disagreement is a false one. The unresolved assumptions are the most valuable part of the artifact precisely because they are the part that did not resolve.

The Debate stops when the recommendation stabilises or the cap is reached. Rounds and budget are **host-enforced** (`debate_cap_not_host_enforced`, `debate_cap_exceeded`); a cap the participants are asked to respect is a suggestion.

## 7. A Debate decides nothing by itself

It produces no code PASS, and it does not stand in for a Panel or a review (`debate_used_as_review_bypass`).

An irreversible or high-impact recommendation goes back to the user as a decision packet, and the final disposition is `accepted` only with the user's decision recorded (`debate_accepted_without_user`). An accepted decision then enters the Decision Log and the ordinary artifact and impact lifecycle — and when it changes the product or the architecture, it enters the requirement revision path rather than being applied directly (`debate_impact_not_revised`).

Every input and output passes identity and clearance (`debate_input_uncleared`). A restart continues the exact round with the exact participants (`debate_restart_identity_changed`); a debate resumed with a different roster is a new debate that would inherit the earlier rounds' authority.

## 8. Artifacts

```text
docs/autosk/epics/<id>/debates/<slug>/
  debate-manifest.json
  rounds/<n>/participants/<role>.md
  rounds/<n>/synthesis.md
  final-synthesis.md
```

The manifest carries the question, the scope, the perspective definitions, the model and session identities, the rounds, the budgets, the source anchors and the final user disposition.

## 9. Refusal classes

- `debate_started_without_request`;
- `debate_empirical_question`;
- `debate_gate_missing`;
- `debate_roster_not_diverse`;
- `debate_round_one_contaminated`;
- `debate_no_cross_examination`;
- `debate_false_consensus`;
- `debate_minority_dropped`;
- `debate_cap_not_host_enforced`;
- `debate_cap_exceeded`;
- `debate_used_as_review_bypass`;
- `debate_accepted_without_user`;
- `debate_impact_not_revised`;
- `debate_restart_identity_changed`;
- `debate_unavailability_undisclosed`;
- `debate_input_uncleared`.

## 10. What this contract decides, and what it defers

Decided: the one question that separates Arena from Debate; that a Debate starts only on an explicit user request; the two gates and their order; the roster's size, distinctness and route fidelity; that round 1 is independent and later rounds cross-examine named claims; that the mediator records disagreement and keeps minority views; that rounds and budget are host-enforced; that a Debate produces no PASS and replaces no review; that `accepted` requires the user's decision; and that a material accepted decision enters the revision path.

Deferred and named: the workflow registration, the participant and mediator runtimes, the round driver and the packet hand-off. Those are `required_for_v1` and are not claimed here.
