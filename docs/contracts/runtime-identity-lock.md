# Runtime identity lock contract

<!-- runtime-identity-lock-contract:v1 -->

Status: issue #10 design contract, slice 4 of six for criterion 2. It checks a lock the pinned patch series already implements; it does not implement one.

## 1. Authority

An Epic pins a governance bundle and a distribution digest. Without a lock on the runtime identity, a task admitted under one distribution can finish under another: an extension reload swaps the registry between two steps, and the flow continues on code the task was never admitted to run.

Patches `0003` and `0005` close that. A task carries a pin — the workflow it is on, the digest of the distribution it was admitted under, and the digest of the shape that workflow declared — and a mismatch refuses with `extension_version_mismatch` rather than continuing.

What was missing is on this side. Nothing in this repository noticed if a later patch dropped any of it, so a guarantee the plan leans on lived only in code that nothing here read. This contract is that check.

## 2. Boundaries

This contract does not define the lock, the engine, or the refusal. Those are the patch series, and the manifest already pins their bytes.

It also does not claim the lock satisfies criterion 2 of issue #10. The shape digest covers the steps a workflow declared and the agent hooks each step has, and patch `0005` says so in as many words: transitions, guards, caps and recovery targets are not in it. The document that does cover all five is `resources/workflow-graph/workflow-graph.v1.json`, and nothing reads it at runtime until the factory of slice 5. Until then this contract checks that what exists keeps existing, and says plainly that it is two of the five.

## 3. How the check is anchored

Each requirement names one line a named patch must add, verbatim, and how many times. It is met when that patch — verified against the digest the manifest pins — adds exactly that line exactly that many times.

The alternative was to parse the TypeScript. This repository has twice paid for reading a source with regular expressions and calling the result a specification: once reading the plan's arrow chains, once reading its transition tables. A patch is bytes the manifest already covers, so anchoring to a line it adds makes a requirement either met by covered bytes or failed.

Two consequences are deliberate. A requirement can be met by a line inside a comment, because a comment that stops being true is a change worth noticing. And the count matters: a line appearing twice where one was expected is a copy someone made, and the requirement has stopped describing what it checks.

## 4. What is required

| Requirement | What must hold |
| --- | --- |
| `refusal_declared` | The engine declares one refusal for an identity that no longer matches the pin. |
| `decision_is_one_function` | One function decides whether a task may proceed on the identity it is pinned to. |
| `malformed_pin_refused` | A pin that cannot be read is refused, not repaired and not dropped. |
| `checked_between_steps` | The identity is re-checked when the flow moves between two steps, not only at enroll and resume. |
| `distribution_digest_compared` | The distribution digest the task was admitted under is compared against the one served now. |
| `graph_digest_compared` | The declared workflow shape is compared as well as the distribution. |
| `absent_shape_is_not_covered` | A pin carrying no shape where the registry has one is refused, not read as agreement. |
| `shape_digest_declared` | The declared shape has a digest of its own. |
| `shape_digest_is_canonical` | That digest is over a canonical serialization, not over an incidental writing. |
| `canonical_sorts_steps` | The canonical serialization sorts the steps, because their order carries no meaning and `Object.entries` would not report the author's order for integer-like names anyway. |

Each carries, in the resource, what goes wrong when it stops holding. A requirement whose cost nobody can state is one nobody will defend when it becomes inconvenient.

## 5. Refusal classes

Closed set: `lock_digest_stale`, `lock_duplicate_id`, `lock_not_json`, `lock_patch_digest_stale`, `lock_patch_unknown`, `lock_requirement_count`, `lock_requirement_unmet`, `lock_schema`.

`lock_patch_digest_stale` is worth its own class rather than being folded into the manifest's own check. The manifest catches a changed patch, but a requirement anchored to bytes this validator never read would be an assertion about a file it did not open — so it verifies the pin itself before reading the line.

## 6. What this does not prove

That the code is correct, that the upstream tests pass, or that the lock covers what criterion 2 asks. Correctness of the patched engine is proven by the upstream suite, which the compatibility workflow runs on every pull request; `daemon/core/test/engine.runtime-identity.test.ts` is where a reader should look for it.

A green result here means the series still carries the ten properties above. It means nothing else, and reading it as more would be the failure this contract exists to prevent one level up.
