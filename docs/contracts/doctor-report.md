# Doctor report contract

<!-- doctor-report-contract:v1 -->

Status: issue #34 design contract. The `autosk-flow doctor` command and the shared check library are `required_for_v1`; this pins the report, the check identity and the rule that keeps `warn` from becoming a pass.

## 1. Authority

`autosk-flow` depends on a long list of checkable capabilities: the daemon primitive and its version, governance and runtime locks, provider routes, the safe filesystem helper, Git and delivery policy, the scanner, the worker pool, schemas and durable operations. Discovering each of them through a runtime failure is expensive and opaque — the operator learns one broken thing at a time, in the order the workflow happened to touch them.

So there is one read-only command that checks all of them and answers in a machine-readable form. The closed JSON Schema is `resources/doctor-report/doctor-report.schema.json`.

## 2. Read-only, and what that costs

Doctor makes no change to the project. The single exception is a synthetic fixture it is explicitly asked to create, and that fixture lives **outside the project source tree**.

The cost is stated rather than hidden: some properties can only be established by doing the thing — a process-tree kill, a real provider dispatch — and doctor reports those as `unverifiable` with the reason, not as `pass`. A check that cannot be run has not passed.

`unverifiable` does not degrade the overall status, and that is a line rather than a loophole. Those properties can never be established read-only, so a status that degraded on them would be permanently yellow on a healthy project — and a permanently yellow status is one operators learn to ignore. The strictness lives where it bites instead: the reason is required, the count is reported beside the status, and a workflow that REQUIRES such a check cannot start. "We could not test it" never becomes "it passed" for anyone who depends on it.

## 3. Categories

`project_identity`, `daemon`, `governance`, `providers`, `git_delivery`, `security`, `scheduler`. Every check declares exactly one, so a workflow can require a category without enumerating its members and without silently missing a member added later.

## 4. `warn` is not readiness

The overall status is `pass`, `warn` or `fail`, and **`warn` never counts as ready**. Each workflow declares its own required check set; a required check that warns blocks that workflow, and a non-required check that warns does not. The difference lives in the workflow's declaration, never in the report — a report that decided who may proceed would be answering a question it was not asked.

A `fail` before model dispatch leaves no side effects. Discovering a problem must not create one.

## 5. A check result says where it came from

Every check carries an id, a category, a status, evidence, a remediation, and provenance: the tool and version that produced it, when it ran, and when it expires. An expired result is not a result — the daemon it describes may have been replaced since.

**Every `fail` carries a remediation or a park reason.** A failure with neither tells the operator that something is wrong and leaves them exactly where they were.

## 6. Redaction

Evidence is redacted before it is written. A doctor report is exactly the kind of file that gets pasted into an issue, and a token in the evidence of a check that found a token is the same leak the check exists to prevent.

The schema has no field for a raw secret, and evidence values are bounded.

## 7. One implementation, two callers

The workflow preflight and the `doctor` command run the **same** check implementations. Two implementations of one check agree until they do not, and the day they disagree is the day a workflow starts on a project doctor calls broken.

The preflight's required sets are keyed by the registered workflows the workflow graph names in `workflows[]`, and the model-step checks — `daemon.capabilities_pinned`, `security.signer_boundary` and `security.model_account` — are required of every workflow whose first step reaches an agent step (ADR-090, ADR-097, ADR-102). `autosk-flow doctor --workflow <name>` holds the report to exactly that workflow's set; it is the one caller of the required sets outside tests. The second caller, the dispatch gate that holds a workflow to its set before any model launch, is this issue's in matrix v1 (ADR-097), and no product code runs it yet. Its call before each model launch sits in the launch path, #18's, and the matrix orders #34 after #18 (ADR-102): the gate holds each workflow #18's entry point registers, and a launch path that ships before the gate's checks can pass launches nothing, because a required check that is `unverifiable` blocks.

`daemon.capabilities_pinned` hands the daemon's `meta.capabilities` report to `requireDaemonCapabilities` and decides nothing itself: two readings of one requirement agree until they do not. Doctor does not contact the daemon, so on a real host the check has no report and is `unverifiable`; and while ADR-023 and ADR-025 have no pinned revision, no report passes it. The call at extension load is the extension entry point's (#18), and what it checks is #11's (`docs/contracts/creation-grant.md` §5). `security.signer_boundary` never passes on a real host until the daemon reports a signer identity outside the model's process: the pinned daemon reports none, so every model workflow's set stays unsatisfied.

`security.model_account` proves the account model processes run under (`docs/contracts/platform-support.md` §5b), and `security.ref_custody`, which every workflow that reaches a step asking the ref-custody helper requires — `autosk-planned`, `autosk-quick` and `autosk-ticket`, as the graph derives them (`CUSTODY_STEP_CHECKS`) — proves the ref-custody helper those steps ask — its process, its socket and journal and the repository's pins (§5a). No probe of either exists in this repository: both are `unverifiable` on every host and name #13 — whose privileged install creates the model account, and which bootstraps the helper with #5 — as the owner of the probe. Once the custody probe exists, a helper or pins it cannot prove are a `fail` carrying `park_reason: ref_custody_unavailable`.

## 8. No Traycer

Doctor runs with no `~/.traycer`, no Traycer binaries and no Traycer paths. A check that shells out to one is a dependency the autonomous copy was built to remove.

## 9. Refusal classes

- `doctor_check_unverifiable`;
- `doctor_check_expired`;
- `doctor_remediation_missing`;
- `doctor_category_unknown`;
- `doctor_evidence_unredacted`;
- `doctor_required_set_unsatisfied`;
- `doctor_traycer_dependency`.

## 10. What this contract decides, and what it defers

Decided: the report shape, the category set, the provenance and expiry on every result, `warn` never being readiness, the remediation obligation, redaction, and one shared implementation.

Implemented since, outside this contract's decisions: the checks (`src/host/doctor-checks.mjs`), the CLI (`scripts/autosk-flow-doctor.mjs`) and the workflow preflight's required sets (`src/host/workflow-preflight.mjs`, ADR-090), the daemon capability check (ADR-097), and the model account and ref-custody checks, registered with no probe (ADR-102). Deferred, and named: the daemon's report of a signer identity (carried in matrix v1 by #4, ADR-092), the dispatch gate before a model launch (this issue's in matrix v1, ADR-097, called from #18's launch path, ADR-102), and the probes of the model account (#13) and of the ref-custody helper and the repository's pins (#13 with #5, ADR-102).
