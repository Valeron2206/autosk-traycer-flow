# Stage carrier matrix and attribution echo contract

<!-- stage-carriers-contract:v1 -->

Status: issue #19 design contract. The prompt compiler and the echo check are `required_for_v1`; this pins the mapping, the attribution header and what a missing echo means.

## 1. Authority

The PromptEnvelope lists categories of context. It does not say which governance bytes each role and stage must actually receive, and without that there are two equally bad modes: send all thirteen governance files to every agent and drown the context, or fail to send the one playbook, rubric, verification contract or reviewer brief that the role needed.

A reference is not a delivery. "Read `protocol/playbooks/feature.md`" assumes the child can reach the bundle, that it reads the version the Epic is locked to, and that it read it at all. The orchestrator inserts the bytes, labels them, and the child echoes the labels back. The closed JSON Schema is `resources/stage-carriers/stage-carriers.schema.json`.

## 2. The matrix

A versioned registry maps every registered `role.stage` key to three sets:

- `required` — bundle-relative files whose bytes are inserted;
- `anchors` — the logical anchors that must be present (ticket manifest entry, acceptance criteria, applicable project instructions, and so on);
- `forbidden` — fragments this key must never receive.

`forbidden` is not decoration. The Judge rubric reaching an Arena candidate is the failure it exists to prevent, and a reviewer receiving write or tool instructions is the other one.

An unknown or missing mapping is **fail-closed, before the provider call**. Guessing a mapping is how a role silently receives someone else's context.

## 3. Every governance file has a consumer

All thirteen governance files either appear in some key's `required` set, or are explicitly marked `inactive_in_v1` with the issue or ADR that decided it. A file with neither is a file nobody can say why we ship.

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

Decided: the matrix and its three sets, fail-closed on an unknown key, full consumer coverage, the attribution header, the echo comparison and what its absence means, and the invariants.

Deferred, and named: the prompt compiler, the budgeting, and the host-side echo check that calls this.
