# Runtime identity lock contract

<!-- runtime-identity-lock-contract:v1 -->

Status: issue #10 design contract, slice 4 of six for criterion 2. It checks a lock the pinned patch series already implements; it does not implement one.

## 1. Authority

An Epic pins a governance bundle and a distribution digest. Without a lock on the runtime identity, a task admitted under one distribution can finish under another: an extension reload swaps the registry between two steps, and the flow continues on code the task was never admitted to run.

Patches `0003` and `0005` close that. A task carries a pin — the workflow it is on, the digest of the distribution it was admitted under, and the digest of the shape that workflow declared — and a mismatch refuses with `extension_version_mismatch` rather than continuing.

What was missing is on this side. Nothing in this repository noticed if a later patch dropped any of it, so a guarantee the plan leans on lived only in code that nothing here read. This contract is that check.

## 2. Boundaries

This contract does not define the lock, the engine, or the refusal. Those are the patch series, and the manifest already pins their bytes.

It also does not claim the lock satisfies criterion 2 of issue #10. What a declaration can express is the steps a workflow declared and the agent hooks each step has, and patch `0005` says so in as many words: transitions, guards, caps and recovery targets are not in it.

Patch `0032` closes the gap without widening the declaration: a definition may carry the digest of the graph document it was built from, and the canonical shape serialises that digest and serialises its absence too. So the other three components reach the pinned identity through one field rather than through the declaration, and they reach it only for a workflow that was in fact built from the document — `docs/contracts/workflow-factory.md` is where that link is specified and `test/runtime-workflow-factory.test.mjs` is where it is checked. Two of these fourteen requirements hold that field in place; none of them proves any particular workflow used it.

## 3. How the check is anchored

Each requirement names one line, verbatim, and how many of it the series must leave in place. It is met when the whole series — every patch the manifest pins, each verified against its digest — leaves exactly that many.

**Counted across the series, not inside one patch.** The first writing of this check counted the additions of the patch that introduced a line, which asked what the series once did rather than what it now says: a later patch could replace the canonical serialization with a constant and the check would stay green, which is the one thing it exists to catch. A requirement still records which patch introduced it, as provenance, and that field decides nothing.

The alternative was to parse the TypeScript. This repository has twice paid for reading a source with regular expressions and calling the result a specification: once reading the plan's arrow chains, once reading its transition tables. A patch is bytes the manifest already covers, so anchoring to a line it leaves in place makes a requirement either met by covered bytes or failed.

Two consequences are deliberate. A requirement can be met by a line inside a comment, because a comment that stops being true is a change worth noticing. And the count matters: a line appearing twice where one was expected is a copy someone made, and the requirement has stopped describing what it checks.

**The requirement set and this contract are one set.** Every requirement here must be in the resource, and every requirement in the resource must be here. One direction was not enough: requiring only that a declared requirement is named let a requirement be deleted from the resource and resealed while this document kept promising it, so a guarantee could leave without touching the document that is under full panel review. That was also the whole argument for reviewing the resource narrowly, and it did not hold until both directions did.

## 4. What is required

| Requirement | What must hold |
| --- | --- |
| `refusal_declared` | The engine declares one refusal for a runtime identity that no longer matches the task's pin. |
| `decision_is_one_function` | One function decides whether a task may proceed on the identity it is pinned to. |
| `malformed_pin_refused` | A pin that cannot be read is refused rather than repaired or dropped. |
| `checked_at_enroll` | The decision runs when a task is enrolled. |
| `checked_at_resume` | The decision runs when a task is resumed. |
| `checked_between_steps` | The decision runs when the flow moves between two steps, and not only at enroll and resume. |
| `distribution_digest_compared` | The distribution digest the task was admitted under is compared against the one the registry serves now. |
| `graph_digest_compared` | The declared workflow shape is compared as well as the distribution. |
| `absent_shape_is_not_covered` | A pin carrying no shape where the registry has one is refused rather than treated as covered. |
| `shape_digest_declared` | The declared shape has a digest of its own. |
| `shape_digest_is_canonical` | The shape digest is computed from the canonical serialization, not merely alongside a function that could produce one. |
| `definition_carries_document_digest` | A workflow definition can carry the digest of the graph document it was built from. |
| `document_digest_in_shape` | The canonical shape serialises that digest, and serialises its absence too. |
| `canonical_sorts_steps` | The canonical serialization sorts the steps. |

Each carries, in the resource, what goes wrong when it stops holding. A requirement whose cost nobody can state is one nobody will defend when it becomes inconvenient.

### The anchors

This document carries them, not only the names, and the validator requires the resource to agree with it line for line. Name equality alone was not enough: a requirement kept its id, its prose and its row above while its anchor was swapped for another requirement's, which gutted the check and moved nothing under full panel review.

Each row is the requirement id, the count the series must leave, and the line, separated by tabs.

```text
refusal_declared	1	export const EXTENSION_VERSION_MISMATCH = "extension_version_mismatch";
decision_is_one_function	1	export function runtimeIdentityDecision(
malformed_pin_refused	1	    if (pinned.state === "malformed") {
checked_at_enroll	1	      restarting ? { state: "absent" } : pinned,
checked_at_resume	1	      readRuntimeIdentityPin(view.metadata),
checked_between_steps	1	      project.store.runtimeIdentityPin(taskId),
distribution_digest_compared	1	  if (current.distribution.digest !== pinned.pin.digest) {
graph_digest_compared	1	  if (current.graph !== pinned.pin.graph) {
absent_shape_is_not_covered	1	  if (pinned.pin.graph === undefined) {
shape_digest_declared	1	export function workflowGraphDigest(wf: WorkflowDefinition): string {
shape_digest_is_canonical	1	  return createHash("sha256").update(canonicalWorkflowGraph(wf), "utf8").digest("hex");
definition_carries_document_digest	1	  graphDigest?: string;
document_digest_in_shape	1	    `graph ${wf.graphDigest === undefined ? "-" : b64(wf.graphDigest)}`,
canonical_sorts_steps	1	  const steps = Object.entries(wf.steps).sort(([a], [b]) =>
```

Three of these anchor to a call rather than to a declaration, and the distinction is what the first two rounds of this slice were about. A patch can leave `canonicalWorkflowGraph` standing and stop calling it; it can leave a comment saying the identity is re-checked between steps and delete the check. What must survive is the use.

## 5. Refusal classes

Closed set: `lock_digest_stale`, `lock_duplicate_id`, `lock_not_json`, `lock_patch_digest_stale`, `lock_patch_unknown`, `lock_requirement_count`, `lock_requirement_unmet`, `lock_schema`.

`lock_patch_digest_stale` is worth its own class rather than being folded into the manifest's own check. The manifest catches a changed patch, but a requirement anchored to bytes this validator never read would be an assertion about a file it did not open — so it verifies the pin itself before reading the line.

## 6. What this does not prove

That the code is correct, that the upstream tests pass, or that the lock covers what criterion 2 asks. Correctness of the patched engine is proven by the upstream suite, which the compatibility workflow runs on every pull request; `daemon/core/test/engine.runtime-identity.test.ts` is where a reader should look for it.

A green result here means the series still carries every property in the table above — the count is whatever that table holds, and the validator prints it. The earlier writing of this sentence said "ten" while the table held twelve, which is the same habit this slice was about: a number in the shape of a measurement, kept by hand beside the thing it counts. It means nothing else, and reading it as more would be the failure this contract exists to prevent one level up.
