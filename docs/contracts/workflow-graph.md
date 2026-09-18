# Declarative workflow graph contract

<!-- workflow-graph-contract:v1 -->

Status: issue #10 design contract. Runtime implementation remains `required_for_v1` after design gate #39.

## 1. Authority

Criterion 2 of issue #10 asks that `workflow_graph_digest` cover the steps, the transitions, the guards, the caps and the recovery targets of the workflow an Epic runs. Today it covers none of them, because there is nothing for it to cover: the workflow is code. Patch `0005` builds a digest from the extension's registered steps and their hook names and explicitly disclaims four of the five components; the transitions live in TypeScript control flow, and the ninety-five edges a reader can count are written in prose that the scraper discards.

The consequence is not academic. An Epic pins a governance bundle and a distribution digest, and a global update can still change which step follows which, when a guard lets the flow past, and where a parked flow may resume — without changing anything the Epic pinned. A digest over hook names cannot notice that, because the thing that changed was never in it.

So the workflow becomes data: one document that declares the graph, a canonical serialization of that document, and a digest over the serialization. What the runtime executes is then derivable from what the Epic pinned, and a difference between them is observable rather than a matter of reading two files and hoping.

## 2. Boundaries

This contract defines the document, its canonical serialization, its digest and the refusals a document earns. It does not define the runtime that executes the graph, the lock that binds an Epic to a graph, the generated prose views, or the migration of the existing flow into a document. Those are separate slices of the same plan and are named here only so that their absence is deliberate.

It also does not amend issue #10. The subject of a transition — who is entitled to take it — is closed inside guards rather than by adding a sixth component to the criterion.

## 3. Definition

A workflow graph is one JSON document. Every field is closed: an unknown field, an unknown `schema_version`, or a value outside a declared enumeration is refused rather than ignored.

"Closed" includes the key a language gives special meaning to. A member named `__proto__` is built as an own property of the parsed object, because assigning it would move the object's prototype instead: a closed schema reads own properties, so an assigned `__proto__` would be invisible to it and would then be dropped by the serializer — a document saying something the digest never covered.

| Component | Where it lives | What it decides |
| --- | --- | --- |
| Steps | `steps[]` | The states the flow can be at. A step is `agent`, which runs and declares which hooks it has, or `status`, which drives a task status and runs nothing. |
| Entries | `first_step`, `entry_steps[]` | Where the graph may be entered. `first_step` is mandatory and is the only entry a single-workflow graph needs; `entry_steps` names the rest, each with the reason it is entered. |
| Transitions | `transitions[]` | The edges. Each names `from`, `to`, a `priority` and the guards bound to it. |
| Guards | `guards[]`, referenced by id | The conditions. A guard names a predicate from a closed enumeration and the authority entitled to satisfy it. |
| Caps | `caps[]` | The bound on a named cycle, counted by the taking of one named transition. |
| Recovery | `recovery[]` | For each park reason, the steps it stops the flow from and where a user may resume it. |
| Views | `views[]` | The rendered tables this document is the source of: where each goes, its header, its rows, and which park reasons each row explains. |
| Decision options | `decision_options[]` | The closed vocabulary a view row's `rule` annotation draws on: the options a stated recovery rule may require, admit or exclude. |

Two design choices are load-bearing and are recorded here rather than left to a reader.

**A guard is the condition; there is no second mechanism.** A transition names the guards bound to it and their conjunction is what must hold. Two alternative ways to reach one step are two edges, not a disjunction inside one edge. This is what makes "the first false guard in canonical id order" a well-defined refusal rather than a description of some implementation's evaluation order.

**Predicates are enumerated, not expressed.** An expression language would need its own specification, its own parser and its own mutation coverage, and the cost of an error in it is a silently permitted transition. A guard names a predicate id and the enumeration says what state that predicate reads.

**A graph has as many entries as it is entered ways.** Reachability is judged from `first_step` together with every `entry_steps[].step`, and a step reachable from none of them is refused as orphaned. One entry was assumed when this contract was written; the autosk-flow graph registers eight workflows, six of which start somewhere other than `first_step`, and its daemon also enters two repair steps out of band. Measured from `first_step` alone, thirteen live steps read as dead, so each entry states the reason it is entered and an entry naming an undeclared step is refused with `graph_entry_step_unknown`.

## 4. Canonical serialization

The digest is taken over the canonical serialization, not over the file bytes. Otherwise a line break or an indent added by an editor would park a good runtime as incompatible.

| Rule | Value |
| --- | --- |
| Output encoding | UTF-8 without a BOM |
| Object key order | by UTF-16LE code units, the same order the daemon uses for step names |
| Arrays that carry order | `transitions` and `resume_targets` are serialized exactly as declared |
| Arrays that do not | `steps`, `predicates`, `guards`, `caps`, `recovery`, `decision_options`, a transition's `guards`, a step's `hooks`, a predicate's `reads`, `parks_at`, `handled_at`, `policy_rules`, a view's `cases` and a rule's `requires`, `admits` and `excludes` are sorted, so a reshuffle of a set does not move the digest |
| Whitespace | none is significant: no indentation and no space after a separator |
| Numbers | integers only, written without a leading zero, without a `+`, without a fractional part and without an exponent; `-0` is refused. `1` and `1e0` are one value and two writings, so exactly one of them is canonical. Integrality is read from the digits as written, never from the float they convert to: `1.00000000000000001` rounds to exactly 1 and `1e-4000` underflows to 0, and an implementation with exact decimal arithmetic would refuse both. Zero is zero at every exponent, so `0e1000000000` is 0 and `-0e1000000000` is refused; an exponent is a number in the input and never a length, so reading one must cost the size of the token and not the value of the exponent |
| Duplicate keys | refused by the **parse**, never by the schema |
| Names compared with the daemon | base64 of UTF-16LE, standard alphabet with padding |

The string rule, stated outside the table so that no cell has to carry a backslash:

```text
Escape only what JSON requires: the quote, the backslash, and the control
characters below U+0020 — by their short forms where those are defined and by
\u00XX otherwise. Everything else is written literally in UTF-8. For a character
that requires no escape, the literal writing and the \uXXXX writing describe one
value, and only the literal one is canonical.

An unpaired surrogate has no UTF-8 spelling and is refused in a string. It
survives only where names are compared, because there the encoding is UTF-16LE.
```

Duplicate keys are refused at the parse because a parsed object no longer carries them: `{"a":1,"a":2}` has already collapsed to one entry by the time any schema runs, so the information that the document said two different things is gone. A schema cannot refuse what it cannot see.

`resources/workflow-graph/canonical-reference.json` ships the reference: an input, its canonical bytes and its digest, together with the four forks the serialization has to settle — two writings of one integer, two writings of one string, a duplicate key, and a name carrying an unpaired surrogate. Two implementations are compared against that file and not against this section. A fork the reference does not exercise is left to whoever writes the second implementation, exactly as if the rule had never been written down.

The reference's document case is the shipped working example rewritten with reordered keys, reversed unordered arrays and a different indent. It therefore proves the digest the example carries, rather than proving a digest of its own.

## 5. Identity: two digests with different jobs

`workflow_graph_digest` covers the canonical serialization of this document: the structure. The distribution digest continues to cover the extension's code, which is where hook **bodies** live. A step declares which hooks it has because hook presence is structure; what a hook does is code, and a contract that tried to digest behaviour here would be claiming a guarantee it cannot keep.

`canonical_digest` inside the document is the recorded value of the first of these. It is computed over the canonical serialization of the document with that field removed, and a recorded value that does not recompute is `graph_digest_stale`.

## 6. Guards carry the subject

Criterion 2 names guards but does not say that a predicate may only inspect state. A guard record carries two parts:

| Part | What it fixes |
| --- | --- |
| `predicate` | what must be true of the recorded state |
| `authority` | who may take the transition: `human`, `agent`, or `policy` with the classifier rule ids the authorisation is bound to and the recorded scope it may not exceed |

This carries the product surface of the core flows across exactly: the decision points a person owns, the part of them a policy may close inside bounds recorded in advance, and the exclusions where a policy never closes a product decision or an acceptance.

Three options were weighed. Widening the criterion's text would be a material change to an obligation and would need an owner decision and its own record. A separate issue would mean designing guards twice. Putting the subject inside guards keeps one mechanism and leaves issue #10 unchanged, and that is what this contract does.

## 7. Caps

A cap counts the taking of one named transition and nothing else, so a retry after a tool or provider failure is not a round. The shipped `limit` is part of the document and therefore part of the digest. A user decision may authorise exceeding a limit for one Epic and scope; that authorisation is a decision record and not an edit here, so it does not move the digest and does not make one Epic's graph a different graph.

## 8. Recovery

A row names three things, and each of the three is one statement. `parks_at` is where the flow stops with this reason: the steps FROM which it stops — the step whose edge parked it, or whose own `no_transition_reason` did — plus a status step a parked task STANDS on. Both belong under one name because both are the stop, and the second is admitted by kind: a status step named here is accepted WITHOUT the graph having to park the reason there. An edge into a step that stops for a person moves the task there, and 207 of the 224 such edges move it to `human`, which declares no edges at all. `handled_at` is the rest of the steps a row names: where the reason is dealt with, and where resume leaves from, but where the graph never raises it — 24 of the 85 rows name 89 such steps between them, and 61 rows name none. `resume_targets` is where a user may resume.

The split is what makes either statement checkable. One field carrying both meanings could only ever be checked in one direction: `project_boundary_invalid` named 68 steps while the graph parks it at 22, and demanding equality would have called the other 46 a defect when they are simply where it is handled. With the two statements apart, each is checked against the graph. `parks_at` closes in BOTH directions — a step the graph parks a reason at and the row omits is refused, and a step the row lists where nothing in the graph parks it is refused too, with `handled_at` as the place to move it rather than a deletion. `handled_at` carries a negative statement, so it is checked as one: a step the graph does park the reason at is refused there, and a step named in both lists is refused outright, since each list would then say the opposite of the other. The status exemption is keyed on the kind and nothing else, and it is an accepted boundary rather than a proof that a given reason stops at a given status step. It is NOT the claim that a status step can never be one the graph parks from: an edge out of a status step into a human status step would put it there, and such a document is legal. What holds of this document is narrower and measured — none of its eight status references is a step the graph parks that reason from, so each rests on the exemption. Requiring evidence instead, that the status step be the landing of an edge carrying the reason, was measured and rejected: it accepts five of the eight and refuses three, all under `project_boundary_invalid`, which the daemon raises outside the graph wherever a task stands. And `done` is its own case: every one of the twelve edges into it carries a park reason, eight of them under the three reasons that name `done` here, but a landing counts as a park only when it has `status: "human"` and `done` has `status: "done"`, so the stop the plan describes there is expressed by the edge that arrives rather than by a park record — which is the answer `Q-s5-ticket-done-has-no-way-out` asked for: `ticket_done` declares the exit, carrying `ticket_completed`, the newest of the three reasons naming `done` here. That row is the document's one row no park can reach: every other reason on an edge into `done` is produced at an agent step, where a stop is actually recorded, while `ticket_completed` is produced nowhere at all — the row exists because the produced-reason bijection requires one for every guard's `park_reason`. What the row says beyond that is chosen, not forced: `done` declares no edges, so some `handled_at` step must lend the resume target, and `commit_on_pass` is the choice as the step the flow actually arrived from; the target itself is `human`, one of three the schema and the terminal rule admit — `rebuild_code_anchor` and `ticket_done` are the other two — and not a route a task will ever take.

Every entry in `resume_targets` must be a declared edge out of **one of** that reason's `parks_at` or `handled_at` steps, and all 534 of them are. The permission is that union and not the step the flow is at: a reason stopping at nine steps permits the edges leaving all nine, so a flow parked at one may resume into a step reachable only from another. Measured on this document, 207 of the 534 are an edge out of EVERY step their row names and 327 are not, and a live daemon was observed taking one of the 327. 114 hang on a `handled_at` step alone, so reading the rule over `parks_at` by itself would strip them. That is the rule, not a gap in it — a narrower one would be a rewrite of the recovery table rather than a repair, and `the union is deliberate` in the test suite is what makes an attempt to tighten it fail loudly. What the union lends is conditioned once more at resume time, where the factory contract is the authority: a lent target that is not itself a step the row names is permitted only once the park record carries a completion receipt for a lending `handled_at` step, watermarked to the producing steps' visit counts of the park it answers — the handling is what establishes the state the target presupposes, and entry alone is not completion. The union is unchanged; the missing piece was the check, not the width.

One boundary stands beside the union without narrowing it: a step with no outgoing edge may be where a row's tasks stand or where a resume lands, but never both in one row. `parks_at` records where the flow stops with the reason and `resume_targets` where it may move next; a task parked on such a step resuming INTO it arrives there again, and an arrival is never free — an agent step's body and effects run once more, the counter incident `workflow-factory.md` section 4 records, and a status step's re-entry lands the resume on a step with no way out while claiming the flow moved. `graph_recovery_terminal_resume` is the refusal. The rule is keyed on the missing exit and not on the overlap: a step WITH an outgoing edge may stand in both lists — the working example's `freeze_artifact` does — and a step without one stays a lawful target of every row that does not park there, which is how `done` remains a target of the ten rows that never park at it and `human` of the eighty rows whose park is an ordinary stop for a person; `ticket_done` stays a target of `commit_cas_failed` and `commit_foreign_movement` under the ordinary rule, since it has an exit now. The document carried the intersection on three rows — `project_boundary_invalid` at `done`, `human` and `ticket_done`, and `no_external_panel_lead` and `no_external_reviewer` at `human` — and measurement, not the rule, decided which half was wrong in each. `ticket_done` produces its reason through its own `no_transition_reason`, so completeness keeps it in `parks_at`; the `human` and `done` entries state where a task with the reason stands, the statement the status exemption admits and the rows' `required_state` already records. The targets were the half claiming a move the step cannot complete, so they are the half that left.

An outcome the document can name must have something that performs it, and `external_operations` is the one place a document says what. Every status the step schema admits is carried either by a step that drives it or by an entry there, and never by both: a status nothing carries lets the document promise an outcome no mechanism performs, and a status carried twice says the outcome is executed outside the workflow while an edge inside carries it. `graph_external_outcome_uncarried` is the refusal, and the statuses come from the schema's own enum rather than a list here, so the rule cannot drift from what a document is allowed to say. The document carried `human` and `done` by steps and `cancel` by nothing: `cond_272` said the outcome of an unresolved foreign movement is human or cancel, `t_367` drew the human half, the cancel half was drawn by nothing at all, and the three views that describe it — `commit_foreign_movement`, `foreign_movement`, `planning_ref_foreign_movement` — say it is a status operation and expressly **not** a workflow step. So the carrier could not be a step without contradicting the document, and what was missing was never a mechanism but a name for the one that already existed: `autosk resume <id> --to cancel`, the park-to-terminal relocation the pinned CLI documents. The views keep describing the operation and do not name it, which is what keeps the executor out of four copies of the table.

Every park reason a document can produce — from a step's `no_transition_reason`, from a guard's `park_reason`, from a cap's `park_reason` — must have exactly one recovery row, and a row whose reason nothing produces is refused. The two graph-level reasons are the exception and carry no row: they park the flow wherever it already stands, so no single row could say where they resume from.

## 8a. Views

The resume contract used to be written three times: here as `recovery`, as the park table in the technical plan, and as the resume table in core flows. A fourth, partial copy exists and is not one of the rendered views: `resources/refusal-vocabulary/refusal-vocabulary.v1.json` carries `named_at` and `named_at_classes` for each reason and nothing else of the contract, extracted from the park table and checked against it by `validate:refusal-vocabulary`. Its fields are named for what they hold — the steps and classes the TABLE names for a reason — and deliberately not `parks_at`, because that is a different statement: four of the classes the table names split across this document's two lists, so `<deterministic_step>` under `project_boundary_invalid` covers 22 steps the graph parks it at and 46 where it is handled. One name could not have carried both. It is derived rather than hand-kept, which is why it is not a fourth place to drift — but it moves whenever the table does, and a change that widens a row has to re-extract it. Three hand-kept copies drift, and a check that notices drift makes it detectable rather than impossible. Two of the three are now rendered from this document, and `views[]` is what they are rendered from.

The rendered unit is the row, not the reason. A row can stand for several reasons — the park table joins three arena candidate failures behind one cell — and one reason appears in several rows under different qualifiers, as `blocked_anchor` does six times. So a view carries its rows and the reasons each row explains, rather than being derived from `recovery` by projection, which no projection could produce.

`rows` is order-carrying: the order is the table. Nothing else about a view is, and the canonical serialization leaves it as written for that reason.

Coverage is declared, not inferred. A `complete` view must explain every reason `recovery` declares. A `partial` view must name every reason it leaves out, and covered plus omitted must be exactly what the graph declares. That is what stops a reason from quietly ceasing to be explained: dropping one takes an edit to `omits` that a reviewer reads. A view is checked in both directions, because text equality alone would pass a document and a table that agree with each other and disagree with the vocabulary, and coverage alone would pass a table whose cells had been rewritten.

The park table is also checked at step granularity: every step the graph parks a reason at must be named by a row covering that reason, outright or through a step class it references. The reason-level check above cannot see this — a reason covered by rows that name only some of its steps passes it — and the shipped document had ten such steps under `blocked_anchor`, deterministic steps with no gate child that the row written for gate children could not reach. A reason a view omits is not asked, since omission is a decision the view already states.

A view row also binds to what it explains. `binds` is a sha256 over the canonical form of the recovery entries the row covers, so rewriting a reason's `resume_targets` or its `required_state` obliges a look at the sentence explaining it. Reason names alone were not enough: they stayed valid while the rule underneath them was rewritten, and nothing refused.

`binds` proves the rows explain the same entries; it cannot prove they state the same rule, because the digest covers the entries and not the sentences. That gap shipped a contradiction once: one row offered a policy path its bound sibling allowed no room for, and every check passed because none of them read rules. So a row in a shared group also declares the rule its text states — `rule.requires` names the options the text makes necessary, `rule.admits` the options it offers as sufficient, and `rule.excludes` the options it declares unacceptable or absent — over `decision_options`, the vocabulary the document registers once. The registry is closed in both directions: an annotation naming an id outside it is refused with `view_option_unknown`, and an id no row names is refused with `view_option_unused`, so the set stays exactly the options in play and cannot grow ahead of the rows.

Comparability is decided by the binding, never by which view a row sits in. Rows sharing one `binds` over a non-empty `covers` state the same decision, and every row of such a group must carry `rule`: one without it is `view_rule_missing`, because a missing annotation is exactly the silent divergence the mechanism exists to catch. The rows sharing a `binds` over an empty `covers` bind no entries and therefore no rule — the grouping is degenerate, not a shared decision — so that group is never compared and never asked. Two comparable rows conflict when either offers what the other excludes, and a row whose own offers meet its own exclusions is the same refusal read on one row; both are `view_rule_conflict`.

Where one `binds` group names more than one decision, its rows split by `case`, taken from the view's own `cases` list: `blocked_anchor` binds ten rows over six cases and `waiting_parent_anchor` three over two. Only rows in one case are compared — a gate-child row and a planned-anchor row are different decisions that happen to share a binding, not two statements of one rule. A row carrying a case its view does not register is refused with `view_case_unknown`, and a row in a cased group carrying none is refused with `view_case_missing`, because an uncased row would otherwise escape the comparison silently.

Three residuals remain, and they are named rather than closed. Text can drift from its annotation — the check compares what is declared, so a row whose prose quietly stops matching its `rule` is the same human residual `covers` already carries, detectable by review and not by construction. An option nobody declares is invisible: a contradiction stated in vocabulary absent from `decision_options` has no id to name itself. And `requires` against `requires` never conflicts — two rows demanding different options are compatible statements of one rule, so an exclusivity the text carries only implicitly, as two requirements that cannot hold together, is not seen.

The shipped graph must carry both views, `park_table` rendered into `03-technical-plan.md` and `core_flows_resume` rendered into `01-core-flows.md`. Naming them here is what stops a view from being deleted out of the check's sight: with the roster gone, deleting one left the coverage and render checks with nothing to disagree with, and the table it renders stopped being checked at all.

`scripts/render-workflow-views.mjs` renders and checks; `--write` puts a view back in place. It fails when a rendered table is edited where it lands, and when this document is edited without re-rendering.

## 8b. Chains

Section 2's eight arrow-chain blocks are not rendered from this document and cannot be: it carries no chain layout, and there the indentation is load-bearing, because a continuation line attaches to the step whose part starts at or before its arrow column. They stay hand-drawn and are checked instead, by `scripts/check-workflow-chains.mjs`.

What is checked is reachability, not adjacency. The notation summarises paths — a chain drawing `select_next -> record_alignment` means the flow gets there, not that the graph declares that edge — so demanding adjacency fails on pairs that are the chains abbreviating rather than disagreeing. What a summary must not do is draw a step the flow cannot get to at all.

A drawn path the graph cannot walk is tolerated only by name, and the list is empty. Three entries lived in it while the owner decided what they were: each was a table row that states a success condition and what to record, then stops without saying where the flow goes, with the chain drawing the destination — `resume_repaired_tickets -> ticket_join`, `intake -> implement` in autosk-quick, and `invalidate_quick_classification -> done`. Read as an omission in the tables rather than as two statements disagreeing, so those three transitions are in the graph and nothing remains to tolerate.

The mechanism stays for the next such gap, which should not be settled by whoever finds it. Tolerating a divergence takes an owner decision and an entry in the list; a divergence that is not named fails, a name with no divergence behind it fails too, and this contract names whatever the list holds.

The `(human)` marks are checked as themselves. They are the only thing the chains state that the transition tables never do, so nothing else could catch a mark that has drifted from the step it marks.

## 9. Refusal classes

Closed set: `graph_cap_transition_unknown`, `graph_digest_stale`, `graph_duplicate_key`, `graph_duplicate_name`, `graph_entry_step_unknown`, `graph_external_outcome_uncarried`, `graph_first_step_unknown`, `graph_guard_unknown`, `graph_lone_surrogate`, `graph_not_json`, `graph_number_not_canonical`, `graph_park_reason_ambiguous`, `graph_park_reason_reserved`, `graph_park_reason_unknown`, `graph_predicate_unknown`, `graph_priority_ambiguous`, `graph_recovery_handled_at_parks`, `graph_recovery_lists_overlap`, `graph_recovery_missing`, `graph_recovery_parks_at_incomplete`, `graph_recovery_parks_at_unproduced`, `graph_recovery_reason_unknown`, `graph_recovery_terminal_resume`, `graph_schema`, `graph_step_stranded`, `graph_step_unknown`, `graph_step_unreachable`, `graph_terminal_step_leaves`, `no_transition_reason`, `resume_target_not_permitted`, `transition_not_declared`.

The set holds two kinds, because one contract owns both. The prefixed codes are design-time: the validator refuses a document. The three without the prefix are runtime park reasons the graph itself issues, which no edge and no step can carry — an undeclared pair has no edge, and therefore no guard on which to hang a reason.

Three of the design-time codes are about the document before its graph is read. `graph_not_json` is any parse failure other than the two the parse names itself; `graph_duplicate_key` and `graph_number_not_canonical` are those two. `graph_schema` is a shape refusal, including the ordinary case of a field the document is not allowed to carry. They are listed because a reachable refusal that is not declared is a set that reads as closed and is not: the test that guards this set runs a battery of malformed documents and compares the codes actually produced against the list above, rather than reading the list back to itself.

Two codes are about which reason a document may name, and they answer different questions. `graph_park_reason_unknown` is the code for a park reason nobody owns: the authoritative set for a step, a guard, a cap or a recovery row is the park reasons of `resources/refusal-vocabulary/refusal-vocabulary.v1.json`, and checking only the spelling would leave section 4's promise a sentence, because `totally_unknown_reason` has the right shape and belongs to no vocabulary.

`graph_park_reason_reserved` is the code for a reason that is owned, and owned by the graph. Owning a code and being allowed to name it are different questions. The three codes this contract owns are issued by the graph about itself, so a guard carrying `transition_not_declared` would be claiming an edge refused for a reason that exists precisely when there is no edge, and a guard carrying `no_transition_reason` would produce, from a schema-valid document, the code section 9 says no valid document can produce. The reserved three are refused everywhere except `graph_reasons`, where they are pinned.

None of the three belongs in `resources/refusal-vocabulary/refusal-vocabulary.v1.json`. That resource is the enumeration of park states of the **autosk workflow**, extracted from the resume table that owns it, and these are states of the graph runtime rather than of the workflow. Recording them there would assert the daemon parks a task with them, which it does not. They are owned and closed here, exactly as `docs/contracts/execution-base.md` owns and closes its own set.

Slice 5 built that runtime, and `docs/contracts/workflow-factory.md` is where it is specified. All three are produced by `src/host/workflow-factory.mjs`, which closes five further codes of its own. What that changes about `no_transition_reason` is only which half is checked where: the schema still makes it unreachable from a valid document, and this contract's own suite is what shows that; the factory's suite shows that a document which does reach the runtime without the field parks with the code rather than with `undefined`.

`no_transition_reason` is the reason a flow parks when it cannot leave a step and the step named no reason. The schema makes it unreachable rather than merely discouraged: `no_transition_reason` is required on every `agent` step, a `human` status step is itself the parked state, `graph_terminal_step_leaves` refuses a `done` or `cancel` step that still declares outgoing edges, and `graph_step_stranded` refuses an `agent` step that declares none — a step that can only ever park is a flow with nowhere to go, which is the defect `ticket_done` shipped with until it declared its exit to `done`. A code that no valid document can produce is the intended outcome; it is closed here so that a document which finds a way to produce it has a name for what it did.

## 10. Required implementation tests

- the working example is accepted and the refused example is refused
- every refusal class in section 9 is produced by a test, and the two runtime codes are proved unreachable from a schema-valid document rather than merely unused
- the codes a battery of malformed documents actually produces are compared against section 9, so a reachable and undeclared code fails the suite
- the duplicate key is refused by the parse, and a test shows the schema does not see it
- a member named `__proto__` arrives as an own property and is refused by the schema
- a fraction that rounds to an integer and an exponent that underflows to zero are both refused, while `1`, `1.0`, `1e0` and `10e-1` still converge
- a token with a huge positive exponent is refused by its value and not by exhausting memory, and zero is still zero at that exponent
- the authoritative park-reason set is read for each check and handed out as a fresh set, so a caller cannot widen what a later check accepts
- a park reason no vocabulary owns is refused, and the two graph-level codes cannot be renamed
- each reserved graph-level code is refused on a step, a guard and a cap, with a matching recovery row present, so the refusal is not a missing row wearing another name
- the canonical reference reproduces byte for byte, and each of its four forks is exercised
- a resume target that is not a declared edge out of ANY step its reason's row names is refused, and one that is an edge out of one of them but not another is accepted, which pins the union
- a step with no outgoing edge named in both `parks_at` and `resume_targets` of one row is refused, while the same step in either list alone — and a step WITH an exit in both lists — is accepted, so the rule is the missing exit and not the overlap, and a terminal step stays a lawful target of every row that does not park there
- an `agent` step with no outgoing edge is refused outright — it can only ever park — and the shipped document names the one that did before it declared its exit
- a status the step schema admits and nothing carries is refused, a status carried by a step and declared an external operation at once is refused, and two entries for one status are refused, while the shipped document and the working example — each of which carries every status it may name — are accepted
- a `parks_at` naming a step where nothing in the graph parks the reason is refused, and the same step in `handled_at` is accepted, which pins the split as a move rather than a deletion; a status step there is accepted, which pins the one exemption
- a reason the graph parks at a step its row does not list is refused, whether the producer is a guard, a step's own `no_transition_reason` or a cap — and a row that lists MORE than the graph produces is accepted, because a reason can also be produced outside it
- a parking edge whose guards name two reasons, and one whose guards name none, are both refused at design time and not only at build
- two edges leaving one step at equal priority are refused

## 11. Acceptance mapping

| Criterion 2 component | Where it is covered | How it is checked |
| --- | --- | --- |
| steps | `steps[]` | schema, reachability from `first_step`, terminal steps declare no edges, agent steps declare a way out |
| transitions | `transitions[]` | every `from` and `to` names a declared step; priorities out of one step are distinct |
| guards | `guards[]` and the `guards` of each transition | every referenced guard exists and names a declared predicate |
| caps | `caps[]` | every `counted_transition` names a declared transition |
| recovery targets | `recovery[]` | every produced reason has one row; `parks_at` is exactly where the graph parks it, status steps aside; every resume target is an edge out of one of the steps that reason's row names; no step with no way out stands in both of a row's lists |
| subject and authority | `guards[].authority` | schema: `policy` carries rules and scope, and nothing else may |
| external operations | `external_operations[]` | one entry per status, the status is one a step may drive, and no step drives a status declared here |
| the digest itself | `canonical_digest` | recomputed over the canonical serialization, with the reference pinning what canonical means |
