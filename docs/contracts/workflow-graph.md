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

Two design choices are load-bearing and are recorded here rather than left to a reader.

**A guard is the condition; there is no second mechanism.** A transition names the guards bound to it and their conjunction is what must hold. Two alternative ways to reach one step are two edges, not a disjunction inside one edge. This is what makes "the first false guard in canonical id order" a well-defined refusal rather than a description of some implementation's evaluation order.

**Predicates are enumerated, not expressed.** An expression language would need its own specification, its own parser and its own mutation coverage, and the cost of an error in it is a silently permitted transition. A guard names a predicate id and the enumeration says what state that predicate reads.

**A graph has as many entries as it is entered ways.** Reachability is judged from `first_step` together with every `entry_steps[].step`, and a step reachable from none of them is refused as orphaned. One entry was assumed when this contract was written; the autosk-flow graph registers eight workflows, seven of which start somewhere other than `first_step`, and its daemon also enters two repair steps out of band. Measured from `first_step` alone, fourteen live steps read as dead, so each entry states the reason it is entered and an entry naming an undeclared step is refused with `graph_entry_step_unknown`.

## 4. Canonical serialization

The digest is taken over the canonical serialization, not over the file bytes. Otherwise a line break or an indent added by an editor would park a good runtime as incompatible.

| Rule | Value |
| --- | --- |
| Output encoding | UTF-8 without a BOM |
| Object key order | by UTF-16LE code units, the same order the daemon uses for step names |
| Arrays that carry order | `transitions` and `resume_targets` are serialized exactly as declared |
| Arrays that do not | `steps`, `predicates`, `guards`, `caps`, `recovery`, a transition's `guards`, a step's `hooks`, a predicate's `reads`, `parks_at`, `handled_at` and `policy_rules` are sorted, so a reshuffle of a set does not move the digest |
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

A row names three things, and each of the three is one statement. `parks_at` is where the flow stops with this reason: the steps FROM which it stops — the step whose edge parked it, or whose own `no_transition_reason` did — plus a status step a parked task STANDS on. Both belong under one name because both are the stop, and the second is admitted by kind: a status step named here is accepted WITHOUT the graph having to park the reason there. An edge into a step that stops for a person moves the task there, and 207 of the 224 such edges move it to `human`, which declares no edges at all. `handled_at` is the rest of the steps a row names: where the reason is dealt with, and where resume leaves from, but where the graph never raises it — 23 of the 84 rows name 88 such steps between them, and 61 rows name none. `resume_targets` is where a user may resume.

The split is what makes either statement checkable. One field carrying both meanings could only ever be checked in one direction: `project_boundary_invalid` named 68 steps while the graph parks it at 18, and demanding equality would have called the other 50 a defect when they are simply where it is handled. With the two statements apart, each is checked against the graph. `parks_at` closes in BOTH directions — a step the graph parks a reason at and the row omits is refused, and a step the row lists where nothing in the graph parks it is refused too, with `handled_at` as the place to move it rather than a deletion. `handled_at` carries a negative statement, so it is checked as one: a step the graph does park the reason at is refused there, and a step named in both lists is refused outright, since each list would then say the opposite of the other. The status exemption is keyed on the kind and nothing else, and it is an accepted boundary rather than a proof that a given reason stops at a given status step. It is NOT the claim that a status step can never be one the graph parks from: an edge out of a status step into a human status step would put it there, and such a document is legal. What holds of this document is narrower and measured — none of its seven status references is a step the graph parks that reason from, so each rests on the exemption. Requiring evidence instead, that the status step be the landing of an edge carrying the reason, was measured and rejected: it accepts four of the seven and refuses three, all under `project_boundary_invalid`, which the daemon raises outside the graph wherever a task stands. And `done` is its own case: every one of the eleven edges into it carries a park reason, seven of them under the two reasons that name `done` here, but a landing counts as a park only when it has `status: "human"` and `done` has `status: "done"`, so the stop the plan describes there is not one this document can express — the open `Q-s5-ticket-done-has-no-way-out`, which this check does not settle.

Every entry in `resume_targets` must be a declared edge out of **one of** that reason's `parks_at` or `handled_at` steps, and all 538 of them are. The permission is that union and not the step the flow is at: a reason stopping at nine steps permits the edges leaving all nine, so a flow parked at one may resume into a step reachable only from another. Measured on this document, 207 of the 538 are an edge out of EVERY step their row names and 331 are not, and a live daemon was observed taking one of the 331. 114 hang on a `handled_at` step alone, so reading the rule over `parks_at` by itself would strip them. That is the rule, not a gap in it — a narrower one would be a rewrite of the recovery table rather than a repair, and `the union is deliberate` in the test suite is what makes an attempt to tighten it fail loudly.

Every park reason a document can produce — from a step's `no_transition_reason`, from a guard's `park_reason`, from a cap's `park_reason` — must have exactly one recovery row, and a row whose reason nothing produces is refused. The two graph-level reasons are the exception and carry no row: they park the flow wherever it already stands, so no single row could say where they resume from.

## 8a. Views

The resume contract used to be written three times: here as `recovery`, as the park table in the technical plan, and as the resume table in core flows. A fourth, partial copy exists and is not one of the rendered views: `resources/refusal-vocabulary/refusal-vocabulary.v1.json` carries `named_at` and `named_at_classes` for each reason and nothing else of the contract, extracted from the park table and checked against it by `validate:refusal-vocabulary`. Its fields are named for what they hold — the steps and classes the TABLE names for a reason — and deliberately not `parks_at`, because that is a different statement: four of the classes the table names split across this document's two lists, so `<deterministic_step>` under `project_boundary_invalid` covers 22 steps the graph parks it at and 46 where it is handled. One name could not have carried both. It is derived rather than hand-kept, which is why it is not a fourth place to drift — but it moves whenever the table does, and a change that widens a row has to re-extract it. Three hand-kept copies drift, and a check that notices drift makes it detectable rather than impossible. Two of the three are now rendered from this document, and `views[]` is what they are rendered from.

The rendered unit is the row, not the reason. A row can stand for several reasons — the park table joins three arena candidate failures behind one cell — and one reason appears in several rows under different qualifiers, as `blocked_anchor` does five times. So a view carries its rows and the reasons each row explains, rather than being derived from `recovery` by projection, which no projection could produce.

`rows` is order-carrying: the order is the table. Nothing else about a view is, and the canonical serialization leaves it as written for that reason.

Coverage is declared, not inferred. A `complete` view must explain every reason `recovery` declares. A `partial` view must name every reason it leaves out, and covered plus omitted must be exactly what the graph declares. That is what stops a reason from quietly ceasing to be explained: dropping one takes an edit to `omits` that a reviewer reads. A view is checked in both directions, because text equality alone would pass a document and a table that agree with each other and disagree with the vocabulary, and coverage alone would pass a table whose cells had been rewritten.

The park table is also checked at step granularity: every step the graph parks a reason at must be named by a row covering that reason, outright or through a step class it references. The reason-level check above cannot see this — a reason covered by rows that name only some of its steps passes it — and the shipped document had ten such steps under `blocked_anchor`, deterministic steps with no gate child that the row written for gate children could not reach. A reason a view omits is not asked, since omission is a decision the view already states.

A view row also binds to what it explains. `binds` is a sha256 over the canonical form of the recovery entries the row covers, so rewriting a reason's `resume_targets` or its `required_state` obliges a look at the sentence explaining it. Reason names alone were not enough: they stayed valid while the rule underneath them was rewritten, and nothing refused.

The shipped graph must carry both views, `park_table` rendered into `03-technical-plan.md` and `core_flows_resume` rendered into `01-core-flows.md`. Naming them here is what stops a view from being deleted out of the check's sight: with the roster gone, deleting one left the coverage and render checks with nothing to disagree with, and the table it renders stopped being checked at all.

`scripts/render-workflow-views.mjs` renders and checks; `--write` puts a view back in place. It fails when a rendered table is edited where it lands, and when this document is edited without re-rendering.

## 8b. Chains

Section 2's eight arrow-chain blocks are not rendered from this document and cannot be: it carries no chain layout, and there the indentation is load-bearing, because a continuation line attaches to the step whose part starts at or before its arrow column. They stay hand-drawn and are checked instead, by `scripts/check-workflow-chains.mjs`.

What is checked is reachability, not adjacency. The notation summarises paths — a chain drawing `select_next -> record_alignment` means the flow gets there, not that the graph declares that edge — so demanding adjacency fails on pairs that are the chains abbreviating rather than disagreeing. What a summary must not do is draw a step the flow cannot get to at all.

A drawn path the graph cannot walk is tolerated only by name, and the list is empty. Three entries lived in it while the owner decided what they were: each was a table row that states a success condition and what to record, then stops without saying where the flow goes, with the chain drawing the destination — `resume_repaired_tickets -> ticket_join`, `intake -> implement` in autosk-quick, and `invalidate_quick_classification -> done`. Read as an omission in the tables rather than as two statements disagreeing, so those three transitions are in the graph and nothing remains to tolerate.

The mechanism stays for the next such gap, which should not be settled by whoever finds it. Tolerating a divergence takes an owner decision and an entry in the list; a divergence that is not named fails, a name with no divergence behind it fails too, and this contract names whatever the list holds.

The `(human)` marks are checked as themselves. They are the only thing the chains state that the transition tables never do, so nothing else could catch a mark that has drifted from the step it marks.

## 9. Refusal classes

Closed set: `graph_cap_transition_unknown`, `graph_digest_stale`, `graph_duplicate_key`, `graph_duplicate_name`, `graph_entry_step_unknown`, `graph_first_step_unknown`, `graph_guard_unknown`, `graph_lone_surrogate`, `graph_not_json`, `graph_number_not_canonical`, `graph_park_reason_ambiguous`, `graph_park_reason_reserved`, `graph_park_reason_unknown`, `graph_predicate_unknown`, `graph_priority_ambiguous`, `graph_recovery_handled_at_parks`, `graph_recovery_lists_overlap`, `graph_recovery_missing`, `graph_recovery_parks_at_incomplete`, `graph_recovery_parks_at_unproduced`, `graph_recovery_reason_unknown`, `graph_schema`, `graph_step_unknown`, `graph_step_unreachable`, `graph_terminal_step_leaves`, `no_transition_reason`, `resume_target_not_permitted`, `transition_not_declared`.

The set holds two kinds, because one contract owns both. The prefixed codes are design-time: the validator refuses a document. The three without the prefix are runtime park reasons the graph itself issues, which no edge and no step can carry — an undeclared pair has no edge, and therefore no guard on which to hang a reason.

Three of the design-time codes are about the document before its graph is read. `graph_not_json` is any parse failure other than the two the parse names itself; `graph_duplicate_key` and `graph_number_not_canonical` are those two. `graph_schema` is a shape refusal, including the ordinary case of a field the document is not allowed to carry. They are listed because a reachable refusal that is not declared is a set that reads as closed and is not: the test that guards this set runs a battery of malformed documents and compares the codes actually produced against the list above, rather than reading the list back to itself.

Two codes are about which reason a document may name, and they answer different questions. `graph_park_reason_unknown` is the code for a park reason nobody owns: the authoritative set for a step, a guard, a cap or a recovery row is the park reasons of `resources/refusal-vocabulary/refusal-vocabulary.v1.json`, and checking only the spelling would leave section 4's promise a sentence, because `totally_unknown_reason` has the right shape and belongs to no vocabulary.

`graph_park_reason_reserved` is the code for a reason that is owned, and owned by the graph. Owning a code and being allowed to name it are different questions. The three codes this contract owns are issued by the graph about itself, so a guard carrying `transition_not_declared` would be claiming an edge refused for a reason that exists precisely when there is no edge, and a guard carrying `no_transition_reason` would produce, from a schema-valid document, the code section 9 says no valid document can produce. The reserved three are refused everywhere except `graph_reasons`, where they are pinned.

None of the three belongs in `resources/refusal-vocabulary/refusal-vocabulary.v1.json`. That resource is the enumeration of park states of the **autosk workflow**, extracted from the resume table that owns it, and these are states of the graph runtime rather than of the workflow. Recording them there would assert the daemon parks a task with them, which it does not. They are owned and closed here, exactly as `docs/contracts/execution-base.md` owns and closes its own set.

Slice 5 built that runtime, and `docs/contracts/workflow-factory.md` is where it is specified. All three are produced by `src/host/workflow-factory.mjs`, which closes three further codes of its own. What that changes about `no_transition_reason` is only which half is checked where: the schema still makes it unreachable from a valid document, and this contract's own suite is what shows that; the factory's suite shows that a document which does reach the runtime without the field parks with the code rather than with `undefined`.

`no_transition_reason` is the reason a flow parks when it cannot leave a step and the step named no reason. The schema makes it unreachable rather than merely discouraged: `no_transition_reason` is required on every `agent` step, a `human` status step is itself the parked state, and `graph_terminal_step_leaves` refuses a `done` or `cancel` step that still declares outgoing edges. A code that no valid document can produce is the intended outcome; it is closed here so that a document which finds a way to produce it has a name for what it did.

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
- a `parks_at` naming a step where nothing in the graph parks the reason is refused, and the same step in `handled_at` is accepted, which pins the split as a move rather than a deletion; a status step there is accepted, which pins the one exemption
- a reason the graph parks at a step its row does not list is refused, whether the producer is a guard, a step's own `no_transition_reason` or a cap — and a row that lists MORE than the graph produces is accepted, because a reason can also be produced outside it
- a parking edge whose guards name two reasons, and one whose guards name none, are both refused at design time and not only at build
- two edges leaving one step at equal priority are refused

## 11. Acceptance mapping

| Criterion 2 component | Where it is covered | How it is checked |
| --- | --- | --- |
| steps | `steps[]` | schema, reachability from `first_step`, terminal steps declare no edges |
| transitions | `transitions[]` | every `from` and `to` names a declared step; priorities out of one step are distinct |
| guards | `guards[]` and the `guards` of each transition | every referenced guard exists and names a declared predicate |
| caps | `caps[]` | every `counted_transition` names a declared transition |
| recovery targets | `recovery[]` | every produced reason has one row; `parks_at` is exactly where the graph parks it, status steps aside; every resume target is an edge out of one of the steps that reason's row names |
| subject and authority | `guards[].authority` | schema: `policy` carries rules and scope, and nothing else may |
| the digest itself | `canonical_digest` | recomputed over the canonical serialization, with the reference pinning what canonical means |
