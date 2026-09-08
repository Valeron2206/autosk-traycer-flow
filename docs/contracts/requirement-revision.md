# Requirement revision contract

<!-- requirement-revision-contract:v1 -->

Status: issue #25 design contract. The revision path, its panels and the hand-off to the mechanical rebuild remain `required_for_v1`; this pins the classification, the order, the fate of implemented work and the trace.

## 1. Authority

A mechanical impact map can be perfectly consistent and still lock in the wrong product decision.

`anchor_rebuild_op` knows how to rebuild: which Tickets are replaced, which resume, which anchors move. What it cannot know is whether the change was allowed to reach the code before it reached the product layer. A requirement arriving mid-implementation is not a rebuild input — it is a change of what the work is for, and rebuilding around it makes the plan consistent with a decision nobody confirmed.

So a material change enters through a revision path whose subject is the **order in which meaning is changed**: the new user intent, then product artifacts, then technical artifacts, then the Tickets manifest, and only then the fate of work that is already implemented. The closed JSON Schema is `resources/requirement-revision/revision-record.schema.json`.

## 2. Boundaries

The mechanical rebuild is not this contract. It receives an approved impact plan and starts side effects only after it exists. Issue #35 owns the decision packet and what makes an answer applicable; #14 owns which panel each artifact class takes; #6 owns the Tickets manifest and #7 the base tree a Ticket is measured against. This contract owns classification, order, the disposition of implemented work, and the trace that ties them together.

## 3. Classification comes first, and is the cheapest thing to get wrong

Five kinds, closed:

- `product_behavior` — what the user gets;
- `technical_constraint` — architecture, dependency or platform constraint;
- `delivery_operations_security_data` — delivery profile, operations, security posture or data handling;
- `evidence_clarification` — the same requirement, said more precisely;
- `non_material_correction` — a typo, a broken link, a renamed reference.

The first three are material and take the full path. The last two do not, which is exactly why the classification is where the path is most easily skipped: calling a product change a "clarification" removes every panel from it in one word.

So the classification carries its rationale, and the two non-material kinds may not touch product or technical artifacts at all. A `evidence_clarification` that edits a Core Flow is refused (`revision_class_mismatch`) rather than reviewed leniently.

## 4. The order is the content

Twelve stages, in this order, each taking the previous stage's approved output as its input:

1. record the original instruction verbatim and a normalized change record;
2. confirm the intent with the user when it is not unambiguous;
3. update the Brief, Core Flows and the rest of the product layer;
4. **full panel** of the affected product artifacts;
5. update the Tech Plan, ADRs, migration and delivery decisions;
6. **full panel** of the affected technical artifacts;
7. regenerate the Tickets manifest — last;
8. a separate **Ticket panel**;
9. build the impact and disposition map over `new`, `work`, `human`, `done`, `staged` and `integrated` Tickets;
10. put the allowed options for already-implemented work to the user;
11. consistency sweep over every surviving artifact, acceptance criterion and reference;
12. hand the approved impact plan to the mechanical rebuild.

**A product change is not applied to code or Tickets first.** Any recorded Ticket or code side effect before stage 12 is refused (`revision_out_of_order`), and the refusal names the stage that was running.

Regenerating the manifest last is not an ordering preference. A manifest regenerated before the technical layer has settled is a manifest of the previous plan — and it does not look stale, it looks current, which is the whole problem.

## 5. The fate of implemented work is the user's decision

For work that is `staged` or `integrated`, four dispositions are allowed:

- `rework_current_ticket`;
- `correction_ticket`;
- `new_epic`;
- `intentional_defer`.

The model prepares them with their consequences and does not choose among them. A disposition for `staged` or `integrated` work without a reference to a real decision record is refused (`revision_decision_missing`) — including `intentional_defer`, which is the one most likely to be recorded as an observation rather than a choice.

A `work` Ticket is paused before its manifest entry is superseded. Replacing the requirement under a running Ticket leaves a model working from a plan that no longer exists, and its output will be reviewed against acceptance criteria it never saw.

## 6. History is not rewritten, and corrections have an order

The original instruction is kept verbatim, alongside the normalized record derived from it. A revision that edits the previous round's instruction is refused (`revision_instruction_rewritten`): the normalized record is the interpretation, and an interpretation that can silently replace its source cannot be checked against it.

Two rapid corrections need supersession semantics, not merge semantics. Each round names the round it supersedes; two rounds claiming the same predecessor are a fork (`revision_supersession_forked`), which is precisely the case where the second correction quietly reverts the first.

A closed or released Epic is not rewritten. A revision targeting one is refused (`revision_closed_epic`) and becomes change work with its own Epic — the released artifact remains what was released.

## 7. "Unaffected" is a proof, not an impression

Rebinding an artifact as unaffected — keeping its existing panel verdict rather than re-running it — requires that its own content digest is unchanged **and** that none of its declared dependencies changed digest. Anything else re-enters the panel (`revision_rebind_unproven`).

The reason to make this explicit is that the rebind is the only step in the path that saves work, so it is the one under pressure. "It looks unrelated" is a description of a reading, not evidence about a dependency graph.

## 8. The sweep reports what it searched

Surviving Tickets may not reference superseded acceptance criteria, ADRs or verification recipes. The sweep resolves every cross-reference in the surviving set against the post-revision artifacts and lists the stale ones (`revision_stale_reference`).

A sweep that found nothing records what it searched. "No stale references" from a sweep that resolved nothing is indistinguishable from a clean result, and reads better.

## 9. Crash and retry

The round id is minted before stage 1, so a crash between doing and recording is recognised as a replay rather than a second round (`revision_round_replay`). The anchor bump is idempotent per round: a retried round does not advance the anchor twice.

## 10. Refusal classes

- `revision_out_of_order`;
- `revision_class_mismatch`;
- `revision_decision_missing`;
- `revision_panel_missing`;
- `revision_manifest_early`;
- `revision_supersession_forked`;
- `revision_closed_epic`;
- `revision_rebind_unproven`;
- `revision_stale_reference`;
- `revision_round_replay`;
- `revision_instruction_rewritten`.

## 11. What this contract decides, and what it defers

Decided: the closed classification and what each kind may touch; the stage order and that no Ticket or code side effect precedes the approved impact plan; that the fate of staged and integrated work is a recorded user decision; the supersession semantics of rapid corrections; the proof an unaffected rebind needs; what the sweep must report; and the replay semantics of a round.

Deferred and named: the runtime that executes the stages, the panel dispatcher, and the mechanical rebuild that consumes the impact plan. Those are `required_for_v1` and are not claimed here.
