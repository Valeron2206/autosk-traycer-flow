# Human decision request and project status contract

<!-- human-decision-contract:v1 -->

Status: issue #35 design contract. The decision queue, the `status` projection and the answer path are `required_for_v1`; this pins the packet, what makes an answer applicable, and what a status may not become.

## 1. Authority

Hardening produces many legitimate `human` parks: alignment, panel waiver, provider unavailable, delivery conflict, requirement revision, integration uncertainty, evidence repair, runtime migration. The state alone is not enough. Parked with no packet, the user sees that something stopped and has to reconstruct what happened, what may be decided, and what will resume — from comments each step wrote in its own words.

So a park produces a machine-readable packet, and an answer becomes an immutable decision record. The closed JSON Schemas are `resources/human-decision/human-decision-request.schema.json` and `resources/human-decision/project-status.schema.json`.

## 2. The packet

A request carries its id; the project, epic, task and operation; the `park.reason`; the exact anchor, candidate, runtime, protocol and delivery identities; the observed facts; **why the automation is not entitled to decide**; the minimal set of questions; the allowed options with their consequences; a recommendation when one is justified; irreversible, destructive and security flags; the required approver; expiry and staleness conditions; the exact resume target; and evidence links.

Two of those are load-bearing in a way the rest are not.

*Why the automation may not decide* is required because a packet without it reads as a request for permission to do something obvious. If the reason cannot be written, the park is probably a bug rather than a decision.

*Consequences per option* are required because a list of options without them asks the user to choose between words. An option that is irreversible says so on the option, not in a preamble.

**No secret and no raw transcript content appears in a packet.** A decision packet is read in a terminal, pasted into chat and kept, and a transcript excerpt in it has left the boundary the transcript lived behind.

## 3. An answer applies to the identity it was asked about

A response is accepted only when the current identities still match the ones the request names. An answer to a question about a candidate that has since changed is not a stale answer to the same question — it is an answer to a different one.

- a stale answer is refused, and says which identity moved;
- a duplicate answer is **idempotent**: the same answer to the same request produces the same decision record and no second side effect;
- a correction while a request is pending updates or voids the request rather than racing it;
- a free-text answer is normalised, and shown back for confirmation when it changes material scope. Silently interpreting free text is how a user's "sure, but only for the docs" becomes an approval for everything.

## 4. Status is a projection, never a ledger

`status` is read-only, and its single source of truth is the daemon plus the immutable records it references. It does not maintain its own state.

The rule that keeps it honest: **a status is a view of records that exist**, so anything it shows can be traced to one. A separate mutable ledger would be a second source of truth obliged to agree with the first, and this repository has already established what those do.

A snapshot shows the active Epics and stages; artifact PASS and approval state; panel seats, attempts and unavailable routes; ticket DAG progress and blockers; open findings and debt; open durable operations and recovery phase; provider, time and cost budgets; planning, staging and target identities; pending decisions; and the exact next safe action.

Waivers, debt and open findings are shown explicitly, not left in comment history — a waiver nobody can see is a waiver nobody weighed.

## 5. Cross-project isolation

A status for project A never contains project B. Not as a count, not as a name. The projection is built from one project's records, and a field that could hold another project's identity is the shape of the leak.

## 6. Refusal classes

- `decision_identity_stale`;
- `decision_request_voided`;
- `decision_option_unknown`;
- `decision_approver_mismatch`;
- `decision_expired`;
- `decision_packet_incomplete`;
- `decision_packet_contains_transcript`;
- `status_cross_project_leak`.

## 7. What this contract decides, and what it defers

Decided: the packet and its two load-bearing fields, identity-bound answers, idempotent duplicates, void-on-correction, the status projection and its single source of truth, and cross-project isolation.

Deferred, and named: the queue implementation, the CLI, and the resume path that consumes a decision record.
