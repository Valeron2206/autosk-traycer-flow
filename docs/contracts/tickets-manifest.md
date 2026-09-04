# Canonical Tickets manifest contract

<!-- tickets-manifest-contract:v1 -->

Status: issue #6 design contract. Runtime implementation remains `required_for_v1` after design gate #39.

## 1. Authority

Every Planned Epic publishes one machine-readable Tickets artifact:

```text
docs/autosk/epics/<epic-id>/tickets/tickets.manifest.json
```

The same candidate contains deterministic human views:

```text
tickets/README.md
tickets/T01-<slug>.md
...
```

The validated manifest from the exact verified Tickets publication commit is the only runtime authority for `dispatch_ticket_dag`, recovery, dependency composition and impact analysis. Markdown files are renderer outputs, not a second scheduler API. A task title, comment, prose-only field, stale worktree file or branch name never defines a Ticket.

The candidate is invalid when the manifest is absent, duplicated, unsupported, non-canonical or inconsistent with the exact rendered path/byte set.

## 2. Boundaries

Issue #5 publishes the artifact and supplies `planning_head`. Issue #7 composes execution bases. Issue #8 owns approved deltas. Issue #9 owns staging/final CAS. Issue #18 owns structured model-result envelopes and host-mediated result transitions around the Tickets cycle. Issue #23 owns verification recipes, issue #24 work-type/evidence contracts and issue #25 semantic revision decisions. This contract does not store runtime status, sessions, implementation commits, review results or worker assignments.

## 3. V1 root and Ticket records

The closed JSON Schema is `resources/tickets-manifest/tickets-manifest.schema.json`.

The root records:

- `schema_version=1` and `renderer_version=autosk-flow/ticket-markdown/v1`;
- immutable `epic_id`, `manifest_revision`, `previous_manifest_digest` and Git `object_format`;
- closed canonicalization, path-scope, review/verification policy and resource-limit identifiers;
- set goal, exclusions and exact governing-artifact references with closed kinds `brief|core_flow|tech_plan|decision|review_policy|verification|work_contract`;
- Tickets sorted by stable ID;
- exact stable `topological_order`;
- explicit retirement mappings for a revised set.

Each Ticket records:

- stable `id`, title, goal, `work_type`, in/out scope;
- closed file/directory path selectors;
- sorted `depends_on` plus one rationale per dependency;
- acceptance criteria with verification bindings and evidence classes;
- governing and material-decision references;
- documentation, security, migration, operations and observability impacts;
- risk/rollback and pinned review-policy reference;
- lineage relative to the immediately previous published manifest;
- one deterministic Markdown path.

Unknown fields and unknown versions fail closed.

## 4. Canonical bytes and identity

`autosk-flow/canonical-json/v1` means UTF-8 without BOM, NFC strings, no CR/NUL, recursively code-point-sorted object keys, two-space indentation, no floating-point values and exactly one trailing LF. Set-like arrays use specified stable ordering; semantic prose arrays preserve authored order. Parse and reserialize must be byte-identical.

Host validation calculates domain-separated SHA-256 values for:

```text
manifest bytes
each Ticket execution entry, excluding revision-only `lineage`
ordered DAG adjacency
deterministic rendered document path/hash set
complete Ticket set
```

The v1 byte preimages are normative:

```text
manifest_digest = SHA-256("autosk-flow/tickets-manifest/v1\0" || canonical_manifest_bytes)
ticket_entry_digest = SHA-256("autosk-flow/ticket-entry/v1\0" || canonical_ticket_entry_without_lineage)
dag_digest = SHA-256("autosk-flow/ticket-dag/v1\0" || canonical_json({adjacency,topological_order}))
rendered_document_set_digest = SHA-256("autosk-flow/ticket-doc-set/v1\0" || concat(path || "\0" || content_sha256 || "\0") in code-point path order)
ticket_set_digest = SHA-256("autosk-flow/ticket-set/v1\0" || manifest_digest || "\0" || dag_digest || "\0" || rendered_document_set_digest)
limits_digest = SHA-256("autosk-flow/ticket-limits/v1\0" || canonical_json(policy.limits))
```

`schema_sha256` hashes the exact distributed Schema bytes. `renderer_distribution_digest` and `validator_distribution_digest` hash, respectively, `"autosk-flow/ticket-renderer-distribution/v1\0"` or `"autosk-flow/ticket-validator-distribution/v1\0"` followed by the canonical code-point-ordered sequence `path || "\0" || blob_sha256 || "\0"` for every shipped implementation file. Changing a domain literal, path set, file byte or separator creates a new distribution identity. Section 16 pins golden vectors for these recipes.

The full Tickets identity also binds project/Epic, anchor, planning parent commit/tree, candidate tree, alignment subject, protocol/runtime/project-instruction identities, governance mapping set and schema/validator/renderer distribution identities. These digests live in a host-owned `TicketsValidationReceipt`, not self-referentially inside the manifest.

Any bound change stales alignment, Panel verdict, publication and task-creation bindings.

## 5. Stable identifiers

Ticket IDs match `T[0-9]{2,6}`, are ASCII and unique, and are never reused for unrelated work in one Epic history. The cumulative `reserved_ticket_ids` ledger makes that history-wide rule machine-decidable from the exact previous manifest. A current ID present in the immediately previous manifest is valid only as `carry` or `revise` of that same predecessor; `new`, `replace`, `split_child` and `merge_result` cannot recycle any reserved prior ID. Acceptance IDs match `AC-<ticket-id>-<nnn>`. Every Ticket has exactly one Markdown path beginning with its ID. Path uniqueness is checked bytewise and under the supported filesystem case/Unicode collision policy.

Future tasks bind `{project, epic, manifest_digest, ticket_id, ticket_entry_digest}` through daemon-owned creation identity; editable titles and descriptions are not recovery identity.

## 6. Closed path-scope dialect

V1 accepts only:

```json
{"kind":"file","path":"src/session/store.ts"}
{"kind":"directory","path":"src/session"}
```

Paths are project-relative NFC strings with `/` separators. Empty, absolute, drive/UNC-prefixed, backslash, NUL, dot-segment and repeated-separator paths are invalid. Directory selectors include descendants on segment boundaries. Selectors are sorted and unique. Trusted host code translates selectors to Git argument arrays; models never construct shell pathspecs.

Two Tickets overlap when their selectors can address the same path under the conservative v1 NFC/lowercase collision key, including paths whose bytes differ only by case. In v1, overlapping Tickets must be ordered by a transitive dependency in one direction. Incomparable overlap is `tickets_scope_overlap_unordered`.

## 7. Dependency graph

Every dependency must resolve inside the same manifest, cannot be self-referential and must have a matching rationale of kind `semantic` or `scope_serialization`. The graph must be acyclic.

The root `topological_order` contains every Ticket exactly once and must equal iterative Kahn ordering with ASCII Ticket-ID tie-breaking among ready nodes. Topological ordering uses a deterministic binary min-heap and is bounded `O((V+E) log V)` independently of worker count. `depends_on` governs dispatch and future execution-base composition, not integration order alone.

## 8. Governing artifacts and unresolved decisions

Root governing references identify exact published files by stable ref ID, kind, relative path, commit OID and content SHA-256. Ticket references must resolve to this root set. Branch names, URLs, foreign projects, uncommitted files and comments are not governing authority.

Every Planned Ticket references current Tech Plan authority and applicable Brief/Core Flow/Decision/Verification authority. A Ticket that still requires an unresolved product, architecture, security, privacy, data, migration or delivery decision is invalid; only already permitted local reversible implementation choices remain to the implementer.

## 9. Acceptance and evidence mappings

Every Ticket has at least one observable AC and every AC has at least one closed binding:

```text
recipe
verification_batch
deterministic_check
manual_acceptance
```

Every binding has a non-null `source_ref` resolved in `governing_artifacts`. `recipe`, `verification_batch` and `deterministic_check` resolve to a pinned `kind=verification` artifact: recipe execution is owned by issue #23, batch/evidence closure by issue #24, and deterministic checks identify a command/runner contract inside those exact bytes. `manual_acceptance` resolves instead to a pinned `kind=decision` artifact carrying exact user authority and cannot replace an automatable safety check merely for convenience. Wrong-surface, stale, missing, tool-failed or indeterminate evidence never closes an AC.

A command appearing only in Markdown has no operational effect.

## 10. Work type, impacts and rollback

`work_type` is exactly `feature|bug-fix|refactoring|perf` and references issue #24 prerequisite contracts. Mixed incompatible work is split or escalated before Panel.

Each Ticket resolves documentation, security, migration, operations and observability impact as `required` with paths/rationale or `none` with rationale. `uncertain` is not Panel-ready.

Review policy requires one reviewer outside the complete author/fixer family set, forbids self-review, binds the exact candidate/evidence and leaves verdict/transitions host-mediated. Risk/rollback records include failure modes, rollback mode/steps, irreversibility and exact approval references where required. They do not authorize target movement.

## 11. Revisions and lineage

The host always supplies lineage context as either an explicit proof that no prior Tickets publication exists or the exact previous published manifest context; candidate bytes cannot choose the initial branch. The initial manifest has `manifest_revision=1`, no previous digest and `reserved_ticket_ids` exactly equal to its current Ticket IDs, and is valid only with the host's no-prior proof. Every published revision carries the cumulative sorted union of all Ticket IDs ever published in the Epic; `max_reserved_ticket_ids` bounds that ledger. A new revision receives the exact previous published canonical manifest bytes, including that cumulative ledger, plus the prior validation identity (`manifest_digest` and ordered Ticket execution-entry digests), and `previous_manifest_digest` must match that context. A current ID present in the prior cumulative ledger but absent from the immediately previous Ticket set cannot reappear as `new`, `replace`, `split_child` or `merge_result`. The same strict byte parser rejects BOM, CRLF, duplicate keys and non-NFC strings in previous context before lineage is evaluated. Ticket lineage is one of:

```text
new | carry | revise | replace | split_child | merge_result
```

Predecessor IDs refer only to the immediately previous manifest. Every prior Ticket is accounted for by current lineage or an explicit retirement. `carry` requires the same ID and byte-identical execution-entry digest; `revise` keeps the ID and changes that digest; `replace` changes the ID; `split_child` maps one predecessor to at least two successors; `merge_result` maps at least two predecessors to one successor. Duplicate or mixed mappings fail closed. A matching `superseded` retirement may mirror replace/split/merge successors exactly; dropped/deferred retirements have no successors. No previous Ticket is silently dropped or ambiguously mapped.

Any set revision creates a new alignment subject, full Ticket Panel and descendant planning publication. Matching IDs do not copy task status automatically. Issue #25 owns user-approved dispositions of live/completed/staged work.

## 12. Deterministic human rendering

The pinned renderer creates one overview and one complete Markdown projection per Ticket. Trusted host code renders deterministic bytes in memory and compares them with the separately enumerated candidate inventory:

```text
expected path set == candidate path set
expected bytes    == candidate bytes
```

A missing, extra, renamed or one-byte-different document is invalid. The pre-freeze entry point `validateTicketsCandidateTree` reads the mutable proposal as raw bytes, rejects excessive JSON depth, and completes JSON Schema validation before deriving the Tickets directory or reading any rendered document. It then walks every existing path ancestor without following symlinks, applies host-owned hard caps to entry count, each regular file and the aggregate rendered set before retaining bytes, and detects identity drift before returning only a non-authoritative pending proof. After freeze computes a tree OID, the authoritative `validateTicketsCandidateGitTree` reads the manifest, inventory and blobs directly from that immutable Git tree by object ID and requires the tree OID width to match `object_format`; no live pathname can provide the final receipt. It invokes a host-owned absolute Git executable whose realpath/content identity is covered by the validator distribution/runtime lock and uses a closed environment that excludes caller `GIT_*` and candidate-controlled `PATH`. Both paths reject symlinks/non-regular/nested entries and pass an external inventory to the semantic validator. Schema-invalid nested shapes and non-object JSON roots return typed errors before graph, lineage, renderer or file-inventory code and cannot crash the host. A caller cannot omit the inventory or substitute freshly rendered bytes for the candidate files. The renderer normalizes free text to one line, escapes raw HTML and table delimiters, and neutralizes leading CommonMark block and link-reference markers so manifest text cannot forge headings, fences, metadata, overview rows or columns. Formatters may not rewrite generated files after validation. Human edits begin by changing the manifest model, then rerendering and minting a new identity.

## 13. Validation lifecycle

Before Panel, trusted host code performs in order:

1. externally bound manifest byte/depth limits, encoding and duplicate-key screening;
2. supported schema/renderer/canonicalizer checks and JSON Schema validation;
3. deterministic semantic errors with JSON pointers;
4. graph, indexed overlap and lineage validation;
5. governing/evidence reference validation;
6. exact candidate file enumeration under host-owned entry/per-file/aggregate limits and deterministic rendering comparison;
7. canonical digest calculation and a closed `record_kind=pending_validation_proof` record whose `candidate_tree_oid=null`;
8. freeze computes the exact candidate tree OID;
9. `validateTicketsCandidateGitTree` re-reads blobs directly from the exact frozen Git tree OID, revalidates every prior result, and the host durably writes/reads back one immutable `record_kind=final_validation_receipt` whose `candidate_tree_oid` equals that frozen tree;
10. current planning-parent/anchor/runtime/protocol/instruction/alignment checks and Panel dispatch.

Failure creates no Panel child, PASS, task or blocker.

The receipt is host/evidence-owned and is not stored inside the tree it identifies. All four Ticket Panel seats receive byte-identical manifest, rendered documents, validation receipt, governing pack and candidate identity. A fix changing any byte produces a new receipt and candidate.

After PASS/waiver, issue #5 publishes manifest and views in one Tickets commit; it becomes `planning_head` only after publication and candidate-custody verification.

## 14. Dispatcher authority

`dispatch_ticket_dag` reads the manifest by exact path from the verified Tickets publication commit/tree, never from the live worktree. It revalidates schema/renderer, receipt, set/DAG/entry digests and current controlling identities, then creates children and blockers exclusively from canonical entries.

Creation identity includes project, Epic, manifest digest, Ticket ID, entry digest, DAG digest and planning head. The actual child/edge set is compared with the expected graph before enrollment. Recovery uses daemon receipts and never reparses Markdown.

Missing, stale, corrupt or unsupported input parks with a typed reason and zero child/blocker side effects.

## 15. Stable errors, limits and migration

Every error contains stable `code`, the smallest available RFC 6901 instance `json_pointer`, message, related pointers and canonical evidence. JSON Schema failures translate the validator instance path into that pointer rather than storing it only in free-form message text. Sorting is by code-point pointer, code and evidence bytes. Required classes cover JSON/canonical/version/limit errors; duplicate IDs; dangling/self/cyclic dependencies; invalid topo order; invalid/colliding/overlapping paths; AC/evidence/governing/impact/lineage errors; rendered-path/byte drift; and stale receipts.

The host checks raw manifest bytes and JSON nesting depth against externally bound hard caps before recursive validation, then rechecks the manifest-declared `max_manifest_bytes`. Resource limits also bound Tickets, cumulative reserved Ticket IDs through `max_reserved_ticket_ids`, total edges, dependencies per Ticket, selectors per Ticket, ACs per Ticket, bindings per AC, each generated Markdown document, the aggregate rendered set through `max_total_rendered_document_bytes`, and enumerated selector-overlap work through `max_scope_overlap_pairs`; same-Ticket and repeated-selector matches count because they consume validation work even when they deduplicate to one or zero cross-Ticket pairs. Candidate inventory additionally has host-owned entry, per-file and aggregate caps that cannot be relaxed by candidate bytes. Scope overlap discovery costs `O(S log S + P + (V + E) ceil(V / 32))` time and `O(V ceil(V / 32) + U)` memory, where `S` is total selectors, `P` is the bounded number of enumerated overlapping selector pairs, `V/E` are DAG vertices/edges and `U <= P` is the deduplicated cross-Ticket pair count; reachability lookup is constant-time after that index. Very large valid sets preserve identical graph/digests with one or many workers.

Unknown schema versions fail closed. Migration is a pure pinned `vN -> vN+1` transformation with before/after identities, explicit semantic decision where needed, fresh alignment, full Ticket Panel and new planning publication. Active Epics never reinterpret old bytes under a new parser.

## 16. Required implementation tests

Issue #6 design validators test at minimum:

- missing/duplicate/malformed IDs, AC IDs and unknown fields/versions;
- dangling/self/deep-cycle dependencies and stable topo ties;
- absolute/traversal/backslash/NUL/dot/collision paths;
- ordered versus unordered scope overlap, including case-collision aliases;
- missing/mismatched rationales, AC evidence, governing refs and impacts;
- irreversible rollback without approval;
- missing/extra/renamed/one-byte-drift rendered docs, symlinked ancestors and pre-read byte limits;
- key order, CRLF, BOM, non-NFC, duplicate JSON keys, malformed nested shapes and extra fields;
- initial revision numbering, prior-ID reservation and revised carry/revise/replace/split/merge/retirement lineage;
- digest golden vectors;
- valid-at-limit and limit+1 sets;
- renderer resistance to heading/table structural injection;
- upgrade/downgrade/unknown version rejection and cross-project/candidate receipt-binding rejection.

Runtime implementation issues #7, #8 and #9 must additionally test workers=1 versus workers>=4 graph identity, stale alignment/planning/candidate/runtime/protocol/instruction/receipt handling, crashes around receipt/child/blocker/enrollment/final graph projection, idempotent retry with one child per Ticket, and proof at the dispatcher seam that operational fields are never read from Markdown. Those downstream tests do not convert this issue #6 design disposition into runtime completion.

## 17. Acceptance mapping

- versioned JSON Schema and receipt: sections 3 and 13;
- one manifest plus human views candidate: sections 1 and 12;
- manifest-only dispatcher: section 14;
- JSON-pointer errors: section 15;
- digest in artifact/task/execution-base identity: sections 4, 5 and 14;
- migration: section 15;
- reproducible graph after restart: sections 7, 14 and 16.

This document and the canonical transition table in `03-technical-plan.md` are normative. Summaries and diagrams may omit internal detail but may not contradict them.
