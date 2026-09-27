# Human decision request and project status contract

<!-- human-decision-contract:v1 -->

Status: issue #35 design contract. The decision queue, the `status` projection and the answer path are `required_for_v1`; this pins the packet, what makes an answer applicable, and what a status may not become.

## 1. Authority

Hardening produces many legitimate `human` parks: alignment, panel waiver, provider unavailable, delivery conflict, requirement revision, integration uncertainty, evidence repair, runtime migration. The state alone is not enough. Parked with no packet, the user sees that something stopped and has to reconstruct what happened, what may be decided, and what will resume — from comments each step wrote in its own words.

So a park produces a machine-readable packet, and an answer becomes an immutable decision record. The closed JSON Schemas are `resources/human-decision/human-decision-request.schema.json` and `resources/human-decision/project-status.schema.json`.

## 2. The packet

A request carries its id; the project, epic, task and operation; the `park.reason`; the exact anchor, candidate, runtime, protocol and delivery identities; the observed facts; **why the automation is not entitled to decide**; the minimal set of questions; the allowed options with their consequences; a recommendation when one is justified; irreversible, destructive and security flags; the required approver; expiry and staleness conditions; the exact resume target; and evidence links.

`park_reason` is the task's `park.reason` itself: one of the recovery reasons of the workflow graph (`resources/workflow-graph/workflow-graph.v1.json`), which the request schema enumerates and `validate:human-decision` keeps equal to the graph's rows. The kinds named in §1 are families of those reasons, not values of the field. The resume target names a graph step that reason's recovery row permits.

Two of those are load-bearing in a way the rest are not.

*Why the automation may not decide* is required because a packet without it reads as a request for permission to do something obvious. If the reason cannot be written, the park is probably a bug rather than a decision.

*Consequences per option* are required because a list of options without them asks the user to choose between words. An option that is irreversible says so on the option, not in a preamble.

**No secret and no raw transcript content appears in a packet.** A decision packet is read in a terminal, pasted into chat and kept, and a transcript excerpt in it has left the boundary the transcript lived behind.

## 3. An answer applies to the identity it was asked about

A response is accepted only when the current identities still match the ones the request names. An answer to a question about a candidate that has since changed is not a stale answer to the same question — it is an answer to a different one.

**An answer is a daemon `UserDecisionRecord`, never a name** (ADR-023, `01-core-flows.md` §2). A response carries the record autoskd wrote after the signed user-presence challenge, and nothing else stands in for it: a response that names its own approver (`answered_by`) is refused, and so is one without a record, with `decision_approver_mismatch`. The queue (`src/host/decision-queue.mjs`, through `src/host/user-decision.mjs`) checks what the host can: the record has exactly the daemon schema's fields, each in its shape, `actor` is `user`, its signed bytes are byte for byte the canonical challenge it repeats (with the nonce hash and the bytes' hash), and its signature verifies under a key the project pinned; the record answers this request in this project (`request_id`, `project_root_sha256`), about this candidate (`anchor_version`, `subject_hash` = the request's `candidate`), issued while the question stood (not after now, not before the request's `created_at` when it has one), and its `payload_hash` is the domain-separated digest of exactly this answer (option, identities, and any normalisation and its confirmation) — or, when the chosen option names what it signs (`signed_payload_hash`, a 64-hex digest the packet carries on that option), exactly that digest: the Epic acceptance's `accept` signs the `IntegrationAuthorizationRecord` the packet presents field by field (`docs/contracts/integration-authorization.md` §1, ADR-096), and such an option is not answered by free text (`decision_packet_incomplete`) — a record about another request or candidate is `decision_identity_stale`, one that signed another answer `decision_approver_mismatch`. A second record carrying the same answer to a request already answered is `decision_identity_stale`: the question was decided by another record. Who answered is the role the verifier gives the signing key, compared with `required_approver`; when is the record's `issued_at`; and the answer and the decision record name the record by id, digest and provenance digest, so the decision digest binds it. The signature is verified by a verifier the caller hands in, and the default one verifies nothing: the pinned daemon reports no signer (ADR-090), so on a real host every answer is refused until the ADR-023 signer, its key pin and the verifier that reads it exist — ADR-023 work that matrix v1 gives to #4 (ADR-092). The tests sign with a key of their own and inject the verifier that knows it; the product has no other path.

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

Decided as well (debt 10e, ADR-091): that an answer is a daemon `UserDecisionRecord` checked as §3 says, and that without a verifier none is accepted.

Deferred, and named: the queue implementation, the CLI, the resume path that consumes a decision record, and the daemon side of the answer — the signer, the project key pin and the verifier the host is handed (ADR-023's daemon side, carried in matrix v1 by #4, ADR-092).
