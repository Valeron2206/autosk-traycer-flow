# Evidence manifest contract

<!-- evidence-manifest-contract:v1 -->

Status: issue #27 design contract. Cleanup, retention and the gate checks that read a manifest are `required_for_v1`; this pins what an evidence record is and what it may never become.

## 1. Authority

The plan gives evidence a path — `.autosk-evidence/<epic>/<task>/<round>/<agent>/` — and stops. A path is not a lifecycle. Without one, six things follow, and the issue lists all six: cleanup deletes the evidence a PASS rests on; raw provider output keeps a secret forever; missing or corrupt evidence fails to invalidate the gate that depends on it; a truncated record turns a diagnostic into a misleading one; two projects share a path; and retention changes retroactively with no trail.

So evidence is typed, and each type carries its own durability. The closed JSON Schema is `resources/evidence-manifest/evidence-manifest.schema.json`.

## 2. Boundaries

Issue #21 owns external source snapshots — which are **not** transient evidence and may not live under an evidence root; #22 owns the verified write; #24 owns the `VerificationBatchContract` a harness run cites; #15 owns what may not move during a gate run; #14 registers this class. This contract defines the record, the retention rules and the tombstone.

## 3. Classes and durability

| Class | Durability |
| --- | --- |
| `verdict` | durable |
| `verification` | durable to the release or audit horizon |
| `verification_harness_run` | durable until the dependent gate closes, or the release horizon |
| `restoration_receipt` | durable whenever a batch mutated product or fixture state |
| `mutation_fixture`, `temporary_harness_source`, `temporary_harness_binary` | transient, or durable under an explicit policy or an active reference |
| `integration_receipt` | durable |
| `protocol_runtime_instruction_lock` | durable |
| `human_approval_waiver` | durable |
| `provider_raw_output` | restricted |
| `temporary_log`, `screenshot`, `profile`, `worktree_trace` | expirable |
| `quarantined_sensitive` | never stored or opened without an explicit decision |

`durability` is not free text and not a per-record opinion: it is derived from the class, and a record whose durability contradicts its class is refused. Otherwise "this one is durable" becomes a thing a producer can assert about a class the policy says is transient.

## 4. What a record carries

Project, epic, task, round, attempt and agent; the candidate and anchor identity; the producer tool, its version and its config digest; media type, size, hash and mode; the clearance manifest it was redacted under; the source command, recipe and environment identity; created and expires; references and dependents; the storage owner and path binding; the durability class; deletion and tombstone status; and the truncation policy together with the ORIGINAL size.

The last pair is one field too many only if truncation never happens. A record that was cut to fit and does not say so is a diagnostic that reads as complete, which is worse than a missing one — the reader has no reason to doubt it.

## 5. A harness run proves it ran

A `verification_harness_run` cites the exact `VerificationBatchContract` digest (#24), the candidate base, commit, tree and pathspec identities, the harness source, binary and config digests, the mutation or fault set digest, and the toolchain and environment identity. Then, for the run itself:

- proof that each mutation or fault was actually applied;
- the expected killer and the observed red signature;
- the required green controls and their outcomes;
- the closed batch outcome;
- the before and after product tree, blob and mode identities, or the non-Git byte identities;
- the restore operation and its receipt;
- which ephemeral artifacts were retained and which deleted;
- tool and environment failures recorded **separately** from product outcomes.

Storing only a final `PASS` is refused. A PASS with no proof that the mutation was applied, that the killer fired, that the green controls passed and that the original state was restored is a claim about a run nobody can distinguish from a run that did nothing.

## 6. Outcomes that are not a product PASS

`mutation_not_applied`, `green_control_failed`, `tool_error`, `tool_timeout`, `restore_failed`, `timeout` and `indeterminate` are outcomes in their own right. None of them may be recorded as, rolled up into, or reported alongside a product PASS.

This is the rule most likely to be violated with good intentions: a harness that could not run is not a product that passed, and a batch that timed out is not a batch that succeeded quietly.

## 7. Cleanup and retention

- an inventory of references is built **first**. Deleting before knowing what points at what is how a PASS loses its evidence;
- active or referenced evidence is never deleted, whatever its class says;
- expired transient evidence is deleted through the safe filesystem adapter (#13), not with an ordinary unlink;
- a tombstone records the hash, the reason, the time and the actor or operation. Evidence may go away; it may not go away silently;
- missing durable evidence invalidates the dependent gate or integration and parks `human`;
- raw provider output is never copied into public Git;
- retention is pinned per Epic. Changing it requires a versioned decision, so a shorter retention cannot be applied to evidence that was produced under a longer one;
- an artifact that cannot be redacted is not stored at all. The escalation is a decision, not a quiet write;
- an ephemeral harness is not deleted until the restore is verified and a sufficient durable receipt is recorded;
- `restore_failed` keeps every diagnostic that is safe to keep and forbids ordinary cleanup until a recovery decision;
- a committed reusable harness lives as repository content and is not duplicated indefinitely into an evidence root.

## 8. Refusal classes

- `evidence_class_durability_conflict`;
- `evidence_referenced_deletion`;
- `evidence_missing_durable`;
- `evidence_corrupt`;
- `evidence_truncated_as_complete`;
- `evidence_cross_project_path`;
- `evidence_retention_retroactive`;
- `evidence_unredactable`;
- `evidence_restore_unverified`;
- `evidence_tool_outcome_as_product`.

## 9. What this contract decides, and what it defers

Decided: the classes and their durability, the record, the harness-run proof obligations, the outcomes that are not a PASS, the retention rules, the tombstone, and the closed refusal set.

Deferred, and named: the cleanup runtime, the reference inventory, and the gate hook that refuses on missing durable evidence.
