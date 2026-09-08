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

Deferred, and named: the checks themselves, the CLI, and the workflow preflight that consumes a required set.
