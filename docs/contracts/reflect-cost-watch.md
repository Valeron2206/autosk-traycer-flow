# Reflect and cost-watch contract

<!-- reflect-cost-watch-contract:v1 -->

Status: issue #29 design contract. The orchestrator, the three reviewer lenses and the registry writer remain `required_for_v1`; this pins what a pass may read, what may become a rule, and what the registry must detect.

## 1. Authority

`protocol/reflect/reviewer-brief.md` ships inside the governance bundle and no post-Epic Reflect workflow exists, so the brief is bundled-but-inactive.

Reflect exists so that rules change from observed failures and measured cost rather than growing after every theoretical critique. Without it governance only ever grows: a plausible gap becomes a rule, the rule creates a recurring false block, and nothing revisits it, because the artifact that would have measured the cost is the one nobody wrote. The closed JSON Schemas are `resources/reflect-pass/reflect-pass.schema.json` and `resources/reflect-pass/cost-watch-registry.schema.json`.

## 2. Boundaries

The exact-body clearance scan is #20's and is referenced here, not reimplemented. The four-model panel is #15's, the decision packet #35's, the artifact classes #14's. This contract owns what a pass is, what a reviewer may read, what may become a rule, and what the registry must detect.

## 3. A pass has an identity, and a retry is not a second pass

`reflect_pass_id` is minted before the pass starts. Re-running the same pass is idempotent under that id; a genuinely new pass over the same Epic is a new id that names the pass it follows (`reflect_pass_replay` when an id is reused for different inputs, and when a later pass does not cite its predecessor).

**Reflect does not change the outcome of a closed Epic** (`reflect_epic_outcome_changed`). It produces proposals about the rules, and a proposal is not a re-judgement of finished work.

## 4. Reviewers read the extract, and only the extract

The orchestrator assembles a sanitized retrospective extract: incidents, retries and extra rounds, false blocks, manual friction, repeated commands and tool gaps, and the exact evidence locators for each. Reviewers read that. They do not read raw transcripts, and they do not read sources the extract did not enumerate (`reflect_unlisted_source`).

Every extract carries a clearance reference from the #20 scan **and the digest of the bytes that clearance was granted over**, and the two must still describe the extract being dispatched (`reflect_extract_uncleared`). A reference alone would be a promise: "it contains no secrets" is a claim about bytes nobody scanned, and an extract edited after the scan is a different set of bytes with an older reference attached.

Three lenses run read-only and independently: judgment and decision quality, tooling and process friction, divergent and secondary effects. All three, because a pass missing one is not a smaller pass — it is a pass that cannot see the category it dropped (`reflect_lens_missing`).

## 5. A new rule needs an observed failure

Every accepted new rule cites an observed failure with a locator (`reflect_rule_without_observation`). A theoretical gap goes to the backlog with a decision note; it is not refused as wrong, it is refused as unproven. This is the whole mechanism: without it, every plausible critique becomes a permanent obligation, and the obligations are never removed because removing one requires an argument while adding one required only a worry.

The single exception is an **explicitly user-ordered import**, which still takes the full panel and records the decision that ordered it. An imported rule may later be relaxed or removed on measured cost like any other — being imported is not a permanent exemption from being wrong.

**Repeated manual friction becomes a tool, a template or a check, not prose** (`reflect_friction_not_tooled`). A recurring manual step written down as a rule is the same manual step with an obligation attached to it.

Findings from the three lenses are merged and deduplicated, then synthesised as `accepted`, `rejected` or `backlog`. For every existing rule the pass touches, it records `keep`, `relax` or `remove` with its history.

## 6. Accepted does not mean active

An accepted governance change becomes its own behavior-defining artifact and takes the full four-model panel before release. It does not reach the active bundle any other way (`reflect_bundle_changed_without_panel`). A Reflect pass is entitled to propose; the panel and the release decide.

## 7. The registry is append-only, and says so checkably

Every entry records the stable rule id, its section, name and history; the pass and Epic ids; the `keep`/`relax`/`remove` verdict; the evidence locators; the observed benefit and cost; the false-block and extra-round counts; a **prefix checkpoint** — the number of entries before it and the digest of exactly those entries; and the writer's lock and operation identity.

The checkpoint is what makes the concurrency claim checkable rather than asserted:

- a rewritten earlier entry changes the prefix digest of every entry after it (`costwatch_prefix_changed`);
- a removed tail is a length that no longer matches (`costwatch_truncated`);
- two appends built on the same prefix are a lost update, not two appends (`costwatch_lost_update`);
- an entry with no writer lock identity cannot be attributed to the operation that wrote it (`costwatch_lock_missing`);
- anything that does not parse is refused rather than partially read (`costwatch_malformed`).

Concurrent Epics append to one registry, which is why this is not decoration.

## 8. Governance has a size budget

Every guide or protocol edit records its lines and bytes, the previous approved baseline, the Epic-start baseline, the net delta, and — for positive growth — the rationale and the candidates considered for replacement or removal (`governance_growth_unjustified`).

Executable checks are preferred to prose, and the budget is where that preference becomes visible: a check that fails is evidence, and a paragraph that is not read is a paragraph that is not followed.

## 9. Refusal classes

- `reflect_pass_replay`;
- `reflect_epic_outcome_changed`;
- `reflect_unlisted_source`;
- `reflect_extract_uncleared`;
- `reflect_lens_missing`;
- `reflect_rule_without_observation`;
- `reflect_friction_not_tooled`;
- `reflect_bundle_changed_without_panel`;
- `costwatch_prefix_changed`;
- `costwatch_truncated`;
- `costwatch_lost_update`;
- `costwatch_lock_missing`;
- `costwatch_malformed`;
- `governance_growth_unjustified`.

## 10. What this contract decides, and what it defers

Decided: the identity of a pass and what a retry means; that reviewers read the cleared extract and nothing else; that all three lenses run; that a new rule needs an observed failure with a locator and a theoretical gap goes to the backlog; that repeated friction becomes tooling; that accepted is not active without the panel; the registry's append-only guarantee and the four things its checkpoint detects; and the governance size budget.

Deferred and named: the orchestrator that assembles the extract, the reviewer runtimes, the registry writer with its lock, and the panel dispatch for an accepted change. Those are `required_for_v1` and are not claimed here.
