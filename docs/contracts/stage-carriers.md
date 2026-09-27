# Stage carrier matrix and attribution echo contract

<!-- stage-carriers-contract:v1 -->

Status: issue #19 design contract. The prompt compiler and the echo check are `required_for_v1`; this pins the mapping, the attribution header and what a missing echo means.

## 1. Authority

The PromptEnvelope lists categories of context. It does not say which governance bytes each role and stage must actually receive, and without that there are two equally bad modes: send all thirteen governance files to every agent and drown the context, or fail to send the one playbook, Judge brief, verification template or writing rule that the role needed.

The governance files are the thirteen normative files of the governance bundle — one Guide and the twelve protocol files of 02 §5 — and the registry's `governance_files` is the one list of them (ADR-093). `validate:stage-carriers` holds it to the bundle tree of 02 §5 and 03 §3 and to the guide and protocol entries of the parity registry (`inactive_in_v1` exactly where that entry is `post_v1`); the bundle validator and the build CLI read their members from it. The envelope's role and stage contracts (02 §6) are the extension's own and are not governance files, and neither is this registry: it pins the bundle digest, so it cannot be a member of the bundle it pins.

A reference is not a delivery. "Read `protocol/playbooks/feature.md`" assumes the child can reach the bundle, that it reads the version the Epic is locked to, and that it read it at all. The orchestrator inserts the bytes, labels them, and the child echoes the labels back. The closed JSON Schema is `resources/stage-carriers/stage-carriers.schema.json`.

## 2. The matrix

A versioned registry maps every registered `role.stage` key to a lifecycle and three sets. The lifecycle is `required_for_v1` or `planned_after_v1`; a post-v1 key names the issue that put it after v1 (`decided_by`, `#N`, an issue the program matrix classifies `planned_after_v1`). A post-v1 key is registered so that its mapping is explicit and refused by the compiler (`carrier_mapping_unknown`) so that registering it does not make it dispatchable; a mapping that does not say it is `required_for_v1` is not dispatched. The implementer keys come from the v1 work types, one per type — `implementer.<type>` with `-` written `_` — and each carries its type's playbook. Every key carries the common protocol, the Guide and `protocol/principles-digest.md` (02 §6: every envelope opens with the pinned common protocol). The sets:

- `required` — bundle-relative files whose bytes are inserted;
- `anchors` — the logical anchors that must be present (ticket manifest entry, acceptance criteria, applicable project instructions, and so on);
- `forbidden` — fragments this key must never receive.

`forbidden` is not decoration. The Judge brief (`protocol/arena/judge-brief.md`) reaching an Arena candidate is the failure it exists to prevent, and a reviewer receiving write or tool instructions is the other one. The Judge brief is therefore forbidden to every key except `arena.judge`.

The Arena candidate and final implementer carry `protocol/playbooks/feature.md` whatever the Ticket's type: an Arena compares competing approaches to a decision that changes the Tech Plan (ADR-077), not a work type, and the synthesized result then goes through the ordinary cycle (README rule 4).

An unknown or missing mapping is **fail-closed, before the provider call**. Guessing a mapping is how a role silently receives someone else's context.

The registry is pinned per Epic like the bundle: the Epic's `protocol.lock.json` records `carrier_registry_digest`, `digest("autosk-flow/stage-carrier-registry/v1", registry)` over the parsed registry, and the compiler refuses a dispatch whose context does not carry that digest for the registry it is given (`carrier_bundle_unpinned`). A mapping edited under an open Epic changes the question the Epic answers as surely as a new bundle does.

## 3. Every governance file has a consumer

All thirteen governance files either appear in the `required` set of some `required_for_v1` key, or are explicitly marked `inactive_in_v1` with the issue or ADR that decided it. A file only post-v1 keys read has no consumer in v1. A file with neither is a file nobody can say why we ship. In the other direction, a `required_for_v1` key never carries an `inactive_in_v1` file.

CI checks this, because the coverage claim is only worth what re-checking it costs.

## 4. Attribution header

Every inserted fragment carries a canonical header:

- the bundle-relative path or logical id;
- the source file SHA-256;
- the section or range digest when an extract is used rather than the whole file;
- the protocol bundle digest;
- project, epic, task, role and stage;
- dispatch, round and attempt identity;
- the serialization version.

The bundle digest and the file digest are both there on purpose. The file digest says which bytes; the bundle digest says which release they came from, and the same bytes can appear in two releases whose surrounding rules differ.

## 5. Echo, and what its absence means

The child's structured result returns `received_attributions[]`. The host compares them field by field **before the result is recorded or transited**.

A missing or mismatched echo is a **blocking non-verdict** — not a fail, and not a retry of the same dispatch. The child answered a question the host cannot confirm it was asked, and neither "it passed" nor "it failed" is a truthful summary of that.

A retry mints a **new dispatch identity and fresh headers** and does not change the candidate. Reusing the dispatch identity would make the second attempt indistinguishable from the first in the record, which is precisely what the echo exists to make distinguishable.

## 6. Invariants

- no child needs filesystem access to the global bundle; the bytes travel with the prompt;
- the common panel and anchor bytes are **byte-identical** across seats. Only the role or lens contract differs, so a disagreement between seats is about the lens and not about what they were shown;
- deterministic order and a fixed prompt-size budget: the same stage with the same inputs serialises to the same bytes;
- the compiler does not read live or latest protocol after the Epic is locked. It reads the pinned bundle, because an Epic that silently upgraded its rules mid-flight has changed the question it is answering.

## 7. Refusal classes

- `carrier_mapping_unknown`;
- `carrier_file_missing`;
- `carrier_forbidden_fragment`;
- `carrier_bundle_unpinned`;
- `carrier_budget_exceeded`;
- `carrier_echo_missing`;
- `carrier_echo_mismatch`;
- `carrier_echo_wrong_scope`;
- `carrier_echo_duplicate`;
- `carrier_coverage_incomplete`.

## 8. What this contract decides, and what it defers

Decided: the matrix, its lifecycle marker and its three sets, fail-closed on an unknown or post-v1 key, full v1 consumer coverage, one governance file list, the attribution header, the echo comparison and what its absence means, and the invariants.

Deferred, and named: the prompt compiler, the budgeting, and the host-side echo check that calls this.
