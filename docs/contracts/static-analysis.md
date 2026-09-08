# Static analysis gate contract

<!-- static-analysis-contract:v1 -->

Status: issue #47 design contract. The adapter, the pilot and the webhook receiver remain `required_for_v1`; this pins the provider-neutral interface, the policy, the identities a result is bound to, and what may never be read as a PASS.

## 1. Authority

LLM agents produce a recognisable class of defects — unreliable constructions, security hotspots, duplication, dead code, complexity, thin coverage on new code — that a machine finds more cheaply and more reproducibly than a model review does. Finding them before the model review is what keeps model attention on the defects only a reader can find.

So autosk-flow gets a **deterministic static-analysis gate**: a provider-neutral contract with SonarQube as its first adapter. The closed JSON Schemas are `resources/static-analysis/static-analysis-policy.schema.json` and `resources/static-analysis/static-analysis-result.schema.json`.

**The analyzer is not a fifth model and does not drive the workflow.** It complements, and never replaces, deterministic tests and coverage, the four-model Panel on planning and behavior-defining artifacts, the single independent cross-family code review, aggregate verification, human acceptance and the final target CAS (`sonar_gate_replaces_review`). It is an external analyzer whose result the trusted host binds to an exact candidate identity.

## 2. Boundaries

Delivery and privacy decisions belong to #17 and #20 and are referenced here, not restated. Evidence is #27's, the doctor report #34's, canonical findings #16's, staging integration #8's and #9's. This contract owns the policy, the identities, the modes and the refusals.

## 3. Provider-neutral by construction

The interface names a provider, a server identity, a scanner identity and an analyzer set. Nothing in the schema is a Cloud-only or edition-only field, and no cloud, plan or edition is hard-coded (`sonar_provider_hardcoded`). SonarQube is the first adapter, not the interface.

A capability the provider does not offer is **absent, not approximated**. A Free plan that cannot analyse an arbitrary branch says so, and the run records that the mode is unavailable — it does not produce a PASS from a mode that did not run (`sonar_pass_without_analysis`).

## 4. Three enforcement states, and no silent downgrade

`disabled`, `advisory`, `required`.

- `disabled` — the runtime works without the analyzer and **does not claim a static-analysis PASS**;
- `advisory` — the result is recorded and does not block;
- `required` — a failing or missing result blocks.

A run may never quietly move down this ladder (`sonar_silent_downgrade`). If a `required` gate cannot run — the provider is down, the plan does not support the mode, the token is missing — the run parks with that fact. An unavailable required gate is not an advisory gate; it is a gate that did not run, and the difference is the whole point of having declared it required.

## 5. The policy is seven conditions, exactly

The `Sonar way for AI Code` gate, recorded exactly, with the four new-code conditions marked as such:

1. no new issues;
2. all new Security Hotspots reviewed;
3. new-code test coverage at least 80%;
4. new-code duplication at most 3%;
5. Security Rating `A`;
6. all Security Hotspots reviewed;
7. Reliability Rating no worse than `C`.

**Pull-request analysis applies conditions 1–4. Main-branch analysis applies all seven** (`sonar_mode_mismatch`). Computing the wrong set is not a stricter or looser gate — it is an answer about a different question.

**The small-change fudge factor is policy, and it is off by default** (`sonar_small_change_bypass`). A provider that skips coverage and duplication below a line threshold would let a stream of small agent edits pass a coverage requirement none of them met. If the provider cannot disable it, the host computes those two conditions itself and the policy records that compensation.

A policy is identified by its digest. A changed quality gate, quality profile or new-code definition mid-run makes the earlier result stale (`sonar_identity_stale`).

## 6. A result is bound to five identities

The candidate commit, tree and pathspec; the policy digest; the provider identity, meaning server, scanner and analyzer versions; the digests of every input report — coverage and any external SARIF or generic issue import; and the result's own analysis and task identity.

Any of those moving invalidates the result (`sonar_identity_stale`). This is where a stale PASS gets accepted in practice: the tree changes, the analysis id does not, and a green check from twenty minutes ago is still on the page.

**Input report provenance is recorded** (`sonar_report_provenance_missing`). A coverage report is a file someone produced; without its digest and the tree it was produced from, "coverage 84%" is a number with no subject. An imported external report carries the analyzer that produced it.

## 7. Dispositions are not the implementer's

A Security Hotspot review and a false-positive disposition are **not** made by the model that wrote the code (`sonar_disposition_by_implementer`). Model tools over the analyzer are read-only, and the model does not change dispositions, the policy or the profile. The reason is not distrust of a particular answer: the implementer has the strongest reason to believe its own code is safe, and this is the one place where that belief is recorded as a fact about the code.

Findings enter the canonical triage rather than a private one, and their dispositions live where every other finding's does.

## 8. Crash, retry and the webhook

A submission that succeeded with a lost response, a background task still pending, an API timeout, an outage, a rate limit: each leaves the operation recoverable and re-submittable under the same operation id, and none of them produces a PASS.

The webhook is authenticated (`sonar_webhook_unauthenticated`), matched to the analysis and project it claims (`sonar_webhook_foreign`), idempotent under replay (`sonar_webhook_replay`), and ignored when it arrives before the operation receipt exists (`sonar_result_without_receipt`) — a result for an operation the host has not recorded is a result about something the host did not ask for.

## 9. Delivery is decided, not assumed

Sending code or reports to a hosted analyzer is a delivery decision under #17 and a clearance question under #20, and it is recorded before the first submission (`sonar_delivery_undecided`). A paid or self-hosted capability activates only after a preflight and an approved delivery decision; nothing here authorises a purchase or a plan change.

The doctor reports the gate's readiness through the same preflight implementation, and the capability enters the reviewed successor matrix before it is counted in #39.

## 10. Refusal classes

- `sonar_gate_replaces_review`;
- `sonar_provider_hardcoded`;
- `sonar_silent_downgrade`;
- `sonar_pass_without_analysis`;
- `sonar_policy_not_exact`;
- `sonar_mode_mismatch`;
- `sonar_small_change_bypass`;
- `sonar_identity_stale`;
- `sonar_report_provenance_missing`;
- `sonar_disposition_by_implementer`;
- `sonar_webhook_unauthenticated`;
- `sonar_webhook_foreign`;
- `sonar_webhook_replay`;
- `sonar_result_without_receipt`;
- `sonar_delivery_undecided`.

## 11. What this contract decides, and what it defers

Decided: that the analyzer is a deterministic gate and not a fifth model; that the interface is provider-neutral and an unsupported mode is absent rather than approximated; the three enforcement states and that no run silently downgrades; the seven conditions and which four apply to a pull request; that the small-change fudge factor is off by default or compensated host-side; the five identities a result is bound to; that input reports carry provenance; that hotspot and false-positive dispositions are not the implementer's; the webhook's authentication, matching, idempotence and ordering; and that hosted delivery is a recorded decision.

Deferred and named: the adapter, the Free-plan pilot on the public repository, the webhook receiver, the offline fake provider for #36, and the doctor check. Those are `required_for_v1` and are not claimed here. **No account, plan or purchase is created by this contract.**
