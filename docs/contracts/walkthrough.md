# Changeset walkthrough contract

<!-- walkthrough-contract:v1 -->

Status: issue #33 design contract. The generator, the offer point and the writing-quality pass remain `required_for_v1`; this pins when a walkthrough may exist, what its facts are checked against, and what it may never become.

## 1. Authority

After a complex implementation the user has PASS records and verification evidence. What they do not necessarily have is a semantic guide: what changed, why, and in what order it is worth reading.

A walkthrough is that guide. It is **explanatory and never behavior-defining**: it creates no PASS, replaces no verification and no evidence, and declining one has no effect on any correctness gate (`walkthrough_creates_pass`, `walkthrough_decline_blocked`). The closed JSON Schema is `resources/walkthrough/walkthrough.schema.json`.

## 2. Boundaries

Aggregate verification is #9's, evidence #27's, the clearance scan #20's, and the artifact classes #14's. This contract owns when a walkthrough is offered, what it must contain, what its facts are validated against, and when it stops being current.

## 3. Offered, not produced

After an aggregate PASS, a walkthrough is **offered** for changes that are large, subtle or risky. It is generated only after the user asks for one or accepts the offer (`walkthrough_without_consent`).

The reason to write this down is that an explanatory artifact nobody asked for is not free: it is one more document that can drift, and drift in an explanation is worse than absence, because a reader trusts it. A small change gets no offer, and a declined offer ends there.

## 4. Bound to the exact staging identity

The artifact lives at `docs/autosk/epics/<epic-id>/walkthroughs/<final-staging-oid>.md` and records the exact final staging commit and tree (`walkthrough_not_bound_to_staging`).

**A semantic change to staging makes the walkthrough stale**, and a stale walkthrough is never shown as current (`walkthrough_stale`). This is the property that makes it safe to trust: an explanation of a tree that no longer exists reads exactly like an explanation of the tree that does.

After the final CAS, a **target binding may be added without changing any semantic claim** — the digest over the semantic sections must be identical across that revision, or it is a new walkthrough rather than a binding (`walkthrough_claims_changed_by_binding`). Adding the target identity is bookkeeping; changing what the document says about the change is not.

## 5. Content, and the order it is read in

Semantic change areas and how they relate; the decisions, assumptions and trade-offs; the gotchas, edge cases and unexpected constraints; the verification actually performed on that exact staging state; the remaining and manual checks; links to Tickets, ADRs, the manifest, evidence, staging and final target identities; known debt, waivers and follow-ups; and rollback or operator notes where they apply.

**The review order is risk-based, not alphabetical** (`walkthrough_order_not_risk_based`). Product, correctness, security and architecture risk come first; mechanical detail comes last. A file-order walkthrough is a directory listing with prose attached, and it spends the reader's attention in the order the filesystem happened to choose.

**Performed and remaining checks are separated explicitly** (`walkthrough_checks_not_separated`). A performed check cites evidence at that exact staging state; a remaining or manual check is listed as remaining, never quietly counted as done. The two lists answer different questions — what is known, and what someone still has to do — and merging them loses the second.

## 6. Facts are validated, not written

Every OID, Ticket id, command, evidence link and status is checked against the canonical records (`walkthrough_fact_mismatch`). On any mismatch the artifact is **not published as current** (`walkthrough_published_with_mismatch`).

Deterministic validation is the point. A walkthrough is the one artifact whose whole value is that a person believes it without re-deriving it, so it is the one where a confident sentence with a wrong commit id does the most damage.

## 7. Nothing private crosses into it

No raw private logs, no secrets, no personal or client data, and no absolute user paths (`walkthrough_uncleared_content`, `walkthrough_absolute_path`). Absolute paths are called out separately because they are the leak that survives review: they look like context rather than like data, and they carry a username.

## 8. Lifecycle

```text
aggregate PASS
→ offer walkthrough
→ user approves or declines
→ generate from frozen records
→ deterministic fact validation
→ optional writing-quality review
→ publish explanatory artifact
```

## 9. Refusal classes

- `walkthrough_without_consent`;
- `walkthrough_not_bound_to_staging`;
- `walkthrough_stale`;
- `walkthrough_claims_changed_by_binding`;
- `walkthrough_fact_mismatch`;
- `walkthrough_published_with_mismatch`;
- `walkthrough_order_not_risk_based`;
- `walkthrough_checks_not_separated`;
- `walkthrough_creates_pass`;
- `walkthrough_absolute_path`;
- `walkthrough_uncleared_content`;
- `walkthrough_decline_blocked`.

## 10. What this contract decides, and what it defers

Decided: that a walkthrough is explanatory, creates no PASS and blocks nothing when declined; that it is offered after an aggregate PASS and generated only on consent; that it is bound to the exact final staging identity and goes stale on a semantic change; that a target binding may not change a semantic claim; that the review order is risk-based; that performed and remaining checks are separate; that every fact is validated against canonical records and a mismatch prevents publication as current; and that absolute paths and private content never appear.

Deferred and named: the generator, the offer heuristic for "substantive", the writing-quality review and the publication path. Those are `required_for_v1` and are not claimed here.
