# Canonical finding registry contract

<!-- finding-registry-contract:v1 -->

Status: issue #16 design contract. Runtime implementation remains `required_for_v1` after design gate #39.

## 1. Authority

Four reviewers produce four answers. What turns them into one decision is this registry, not a synthesis step:

```text
docs/autosk/epics/<epic-id>/reviews/<candidate-identity>/findings.registry.json
```

`synthesize_panel` as prose is where reproducibility is lost — the same four answers can be summarised two ways, and nothing in the record says which was used. The registry replaces that with a deterministic pipeline: raw findings, a canonical merge, a triage with a citable basis, a contest, and a gate predicate that is computed rather than judged.

The single Code Review uses the same model with one originating seat. A review with one reviewer is not a different process; it is this one with a smaller set.

## 2. Boundaries

Issue #15 owns the immutable gate projection this registry is read into; #18 owns the structured result envelope a seat returns; #14 registers this artifact class; #6 owns the Tickets a debt item becomes; #25 owns propagation of a late requirement change. This contract does not store session state, model output, or the fixes themselves.

## 3. Raw findings

The closed JSON Schema is `resources/finding-registry/finding-registry.schema.json`.


Each seat returns findings under its own namespace. A raw finding records the seat, the task, session and attempt it came from, the seat's own `raw_id`, a severity on the shared scale, the precise claim, an evidence locator, the anchor or criterion it says is violated, the affected scope, and a proposed remedy.

The remedy is a proposal. It is recorded so a reviewer can be specific, and it is never binding: a finding says what is wrong, not what the implementation must be.

The severity scale is shared and closed: `critical`, `high`, `medium`, `low`. A seat that reports outside it is a malformed result, not a new severity.

## 4. Canonical merge

The host merges deterministically:

- raw IDs are namespaced by seat — `gpt:F1`, `grok:F2` — so two seats numbering from 1 do not collide;
- findings with the same root cause are merged into one canonical finding with a stable `canonical_id`;
- **every** originating seat and raw ID is kept, because the contest in §6 goes to all of them;
- the pre-triage severity is the **highest** any seat reported, so a merge cannot quietly downgrade by averaging;
- candidate supersession carries open canonical findings forward; a finding does not disappear because the candidate moved.

Determinism is the point: the same four answers must produce the same canonical set, so the merge is a function of the raw findings and nothing else — not of the order the seats replied in.

## 5. Triage

Four decisions, and three of them need a basis:

| Decision | What it requires |
| --- | --- |
| `confirmed` | nothing beyond the finding |
| `confirmed_higher_severity` | a stated reason |
| `confirmed_lower_severity` | a citable basis |
| `rejected` | a citable basis **and** one of `out_of_scope`, `intended_behavior`, `duplicate`, `reviewer_error` |

A citable basis is an anchor reference, an accepted decision reference, or a concrete factual proof. Without one, the finding stays `confirmed` at its reported severity. This is the rule that keeps triage from becoming a way to make findings go away: disagreeing is allowed, disagreeing without citing anything is not.

## 6. Contest

A contest goes to every originating seat, not only the loudest one, and it completes **before** any fix or pass decision.

Each originator gets one attempt. A seat that is unavailable forfeits its window — and forfeiting does not close a confirmed finding, because absence is not agreement. Disagreement that survives the contest escalates to the user rather than being resolved by the host.

A contest binds the candidate, the anchor, the canonical finding and the attempt. A contest answered about a superseded candidate does not apply to the current one.

## 7. The gate

Computed, not judged:

- zero open `confirmed` findings at `critical` or `high`;
- every confirmed `medium` has a disposition, `fixed` or `deferred`;
- a `deferred` medium creates a debt Ticket with identity, owner and reason, and stays open as tracked debt;
- `low` does not block — but a `low` that is really an understated `high` is caught by triage, not by the gate, which is why `confirmed_higher_severity` exists;
- a finding closes only on a re-review disposition of `resolved`. Having made an edit is not a disposition.

## 8. Late findings

By the state of the work the finding lands on:

- a late `critical` or `high` against the current scope and anchor **reopens** the pass;
- an unintegrated Ticket goes through fix, verify and review again;
- integrated code gets a correction Ticket from the current canonical base — not an amendment of history;
- a closed or released Epic gets its own change issue or Ticket;
- a late `medium` follows the ordinary disposition policy, and history is not rewritten to make it look like it was known earlier;
- a finding against a **superseded** identity is stale: it is recorded, and it does not block the current candidate.

## 9. Park reasons

Closed set: `unknown_severity`, `unmergeable_finding`, `missing_citable_basis`, `contest_incomplete`, `undispositioned_medium`, `missing_debt_ticket`, `stale_candidate_binding`, `originator_unknown`, `registry_drift`.

## 10. Required implementation tests

- duplicate findings from two, three and four families merge to one canonical finding with every originator kept;
- two seats disagreeing on severity produce the highest before triage;
- a rejection and a downgrade without a citable basis are refused, and the finding stays confirmed;
- mixed contest outcomes, and one originator unavailable — the forfeit does not close the finding;
- the candidate changes during a contest;
- a medium fixed, a medium deferred with its debt Ticket, and a medium left undispositioned blocking the PASS;
- a late critical before integration, after integration, and after release;
- a stale finding against a superseded identity does not block;
- an open finding survives a restart and a review replacement.

## 11. Acceptance mapping

| #16 criterion | Where it is met |
| --- | --- |
| All four seats use one severity scale and schema | §3 |
| Merge and dedup reproducible, provenance kept | §4 |
| No rejection or downgrade without a citable basis | §5 |
| Contest of all originators completes before fix or pass | §6 |
| An undispositioned medium blocks the PASS | §7 |
| A deferred medium creates a tracked debt Ticket | §7 |
| Candidate supersession carries open findings | §4 |
| A late blocking finding reopens the current work | §8 |
| Single Code Review uses the same model | §1 |
