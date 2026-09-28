# Clean-room E2E and fault matrix contract

<!-- clean-room-e2e-contract:v1 -->

Status: issue #36 design contract — the architecture and the fault matrix, approved as a future release gate. The harness itself is runtime work and remains `required_for_v1` after design gate #39. Per the issue, the design is not required to carry disposable driver source; it **is** required to carry a complete `VerificationBatchContract` for every fault group.

## 1. Authority

An autonomous multi-project MVP cannot be declared on unit tests and a workflow graph that parses. This suite is the release gate, and it runs in a room built for the purpose:

- a fresh temporary HOME;
- no `.traycer`, no Traycer skills, binaries, config or sessions;
- only the pinned autoskd, the autosk-flow distribution, the governance bundle and fake provider executables installed;
- separate temporary project roots;
- no network and no real credentials;
- a controlled clock, controlled IDs and a fault injector;
- the supported macOS and Linux profiles, or equivalent CI jobs.

The closed JSON Schema is `resources/clean-room-e2e/fault-matrix.schema.json`.

## 2. Boundaries

Issue #24 owns the `VerificationBatchContract` this matrix instantiates; #18 owns the result envelope and the rule that a tool failure is never a product disposition; #9 owns staging and the final CAS the flow exercises; #13 the filesystem boundary the fault groups attack. This contract defines the room, the flow that must run in it, and what each fault must prove.

## 3. What must run

The full Planned flow, end to end, checked on **exact commits, trees, locks, receipts and evidence** — not on terminal status. A green status with the wrong tree is the failure this gate exists to catch.

```text
intake → human alignment → Brief + 4-seat Panel → Core Flow + Panel
→ Tech Plan + Panel → Tickets manifest + separate Panel → Ticket DAG
→ dependency-aware implementation → deterministic verification
→ cross-family review and fix → private staging integration
→ aggregate verification → acceptance → final target CAS → cleanup
```

Separately: the Quick flow, its classification, the absence of Planned gates it does not need, its mandatory verify and review, and promotion to Planned. An Arena run inside the Planned flow, as `docs/contracts/arena.md` decides it: a Tech Plan decision marked arena, two candidates of distinct families in isolated worktrees (`autosk-arena-candidate`), a judge of a third family that ranks and does not approve (`autosk-arena-judge`), the person's decision, and the re-expressed Tech Plan under a new full Panel. And two projects running in parallel with no leakage between them.

## 4. What a fault must prove

A fault group that reports success has proved nothing unless it can show all four:

| Proof | What it rules out |
| --- | --- |
| `application_proof` | the mutation or fault was never actually applied — a no-op injector that reports success |
| `red_killer` | the fault is not observable — a mutation nothing detects |
| `green_control` | the observation is not specific — an unmutated control that also fails |
| `restore_proof` | the room is not clean for the next fault — a restore that returned the branch name but not the ref, tree, blob, mode or task metadata |

The restore proof is the one most easily faked, so it is stated precisely: the same branch name with a different ref, tree, blob, mode or task metadata is **not** a restore.

## 5. The release gate

Fails on `mutation_not_applied`, `green_control_failed`, `restore_failed`, `timeout` and `indeterminate`.

None of those is a product verdict, and none of them may be recorded as one. A harness, tool or environment failure says nothing about the product — that rule comes from #18 and is not relaxed here. The gate refusing on `indeterminate` is the same rule read forwards: an outcome that could not be determined has not been determined.

## 6. Harness self-checks

The harness is a test subject too, and each of these must fail when it should:

- a no-op mutation whose injector reports success while the target state did not change;
- an expected killer that stays green;
- an unmutated green control that fails;
- the harness self-test failing;
- a crash before the mutation, after it, during observation, during restore, and after restore but before the receipt;
- a restore returning the same branch name with the wrong ref, tree, blob, mode or task metadata;
- ABA movement around the claimed recovery boundary;
- tool setup or execution failure separated from a product defect;
- a timeout, and an indeterminate outcome;
- an ephemeral helper left in the worktree after the run;
- the harness, config or mutation-set digest changing after evidence was minted;
- the full clean-room suite re-run after each restored fault batch.

## 7. One command

The suite runs from one canonical command in CI, with no real provider, no network and no credentials. An optional real-provider smoke test is documented and **not** run automatically — a gate that needs a live account is not a gate that can be trusted to run.

`npm run clean-room` prepares the pinned source, builds the binaries and drives the daemon; `npm run clean-room:faults` runs the fault harness, which needs neither, and the full run invokes it as its last step.

Each fault case does two things. It builds a fixture and makes the fault there — a symlink out of the project, a ref moved by the harness's own git command, an inherited `GIT_DIR`, a harness that prints success and exits 0 — and asks the pure host function that owns the boundary; no case runs a host driver or the daemon. And it runs a control: the same guard, asked about the state without the fault, has to stay silent. A guard that refuses everything would detect every fault and mean nothing by it, so a failed control demotes the row rather than being reported beside it. The run records, per case, the git commands that write a ref which the harness ran itself, fixture setup apart from the fault step.

The coverage table is derived from that run rather than declared next to it — the crash and identity harnesses' results as much as the fault harness's — and each group's state says how it was covered, read from its `injection` (§9), whether the run detected its fault, and whether a control was asked and stayed silent:

- `covered_by_real_fault` — the fault reached what answers for real (`real_path` or `measured_observation`), was detected, and its control stayed silent;
- `covered_without_control` — the same, with no control asked: the crash harness injects at a point in a write and never asks the un-faulted question;
- `covered_by_written_observation` — the guard was handed an observation the harness wrote (`written_observation`) and answered it: an answer to a described state, not to the fault;
- `control_failed` — the fault was detected and the control did not stay silent, so the detection says nothing;
- `not_covered` — no harness performed the group, or its fault was not detected.

Only `covered_by_real_fault` counts toward the release gate (#36); every other state is reported as what it is, with no row rounded up, and the run is complete only when every group is `covered_by_real_fault`. The command's exit status says whether every step ran, not whether the run is complete.

## 8. Park reasons

Closed set: `mutation_not_applied`, `green_control_failed`, `restore_failed`, `timeout`, `indeterminate`, `harness_self_test_failed`, `digest_changed_after_mint`, `ephemeral_helper_left`, `traycer_artifact_present`, `cross_project_leakage`.

## 9. The fault matrix

Every fault group in `resources/clean-room-e2e/fault-matrix.v1.json` carries its four proofs and its expected gate outcome. The validator refuses a group missing any of them, and refuses a matrix whose groups do not cover every boundary the flow crosses: task creation, session lifecycle, filesystem writes, ref movement, staging integration, aggregate verification and the final CAS.

Each group also says how its fault reaches what answers (`injection`, with a one-line `injection_note` that states what the run injects where it differs from the designed `description` and `fault`): `real_path` — the crash or identity harness makes the fault against the built daemon, which answers on its own path; `measured_observation` — a fault-harness case whose guard is handed no written observation field; `written_observation` — a case whose guard is handed the `written_fields` it names as literals. A fault-harness group names the host functions its case asks (`guards`). The validator holds these fields to `scripts/clean-room-faults.mjs`: a `real_path` group has no entry in its `CASES`, every other group has one; every literal the faulted guard call is handed — its argument and each `const` of the case it names — is declared as a written field or as a `fixed_inputs` entry held constant between the fault and its control, and every declared field is such a literal. That a non-literal field is read from the fixture after the fault is the case's own reading, not the validator's (debt 10h, ADR-094). The kind bounds the state a group can reach (§7): a `written_observation` group is at most `covered_by_written_observation` whatever its case detects, and only a `real_path` or `measured_observation` group can be `covered_by_real_fault`; the validator refuses a kind the coverage rule gives no state (debt 11f, ADR-100).

## 10. Acceptance mapping

| #36 criterion | Where it is met |
| --- | --- |
| Full Planned flow in a clean room | §1, §3 |
| Quick flow and promotion | §3 |
| Two projects in parallel with no leakage | §3, §8 |
| The fault matrix creates no duplicate or partial trusted state | §4, §9 |
| The target ref does not move before aggregate PASS and acceptance | §3, and #9's contract |
| Retained and removed objects match policy after success | §6 |
| One canonical command in CI | §7 |
| Every fault group is covered by an injected fault, or reported as not covered | §7 (only `covered_by_real_fault` counts toward the gate as covered by an injected fault; every other state reports what is missing), §9 |
| No real provider, network or credentials | §1, §7 |
| An optional real-provider smoke is documented, not automatic | §7 |
| Every fault group has a complete `VerificationBatchContract` before #39 | §4, §9 |
| Every mutation has application proof, red killer, green control and restore proof | §4 |
| Tool, harness or environment failure is not a product outcome | §5 |
| The gate fails on the five named outcomes | §5 |
