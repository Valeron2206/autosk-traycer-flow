# Provider preflight contract

<!-- provider-preflight-contract:v1 -->

Status: issue #26 design contract. The preflight runner and the dispatch guard are `required_for_v1`; this pins what a route must prove before it can be used, and what makes it unusable.

## 1. Authority

Checking that a catalog lists a model and that a synthetic call returns does not establish that a route will do what the panel needs. A provider can accept the model id and drop the requested reasoning effort; return a warning nobody reads; offer no real read-only mode; hang with no timeout; leave an orphan; lose a resumable session; or take several routes down at once because they share a harness.

**A silent downgrade destroys the panel identity.** Four seats chosen for four different lenses are not four seats if two of them quietly ran at the provider's default effort. So a route is attested before it is used, the attestation expires, and anything the provider will not confirm is written down as a named residual risk rather than assumed.

The closed JSON Schema is `resources/provider-preflight/provider-preflight.schema.json`.

## 2. What a route record carries

Provider, harness and executable version; the exact model id; the requested effort **and** the effective effort as confirmed; auth and live smoke state; the supported permission and tool modes; the session resume mechanism and format; maximum prompt and output limits; idle and wall-clock timeouts; process-tree termination semantics; warning and drop detection; the provider failure-domain id; the last successful check and its expiry; privacy and telemetry constraints; and the named residual risks the API does not allow checking.

`effective_effort` is its own field, and `effort_confirmation` says how it was established: `observed`, `reported` or `unconfirmable`. Collapsing it into the requested effort is exactly the silent downgrade — the record would then say what was asked for and never what happened.

## 3. Runtime rules

1. A route never falls back to the provider's default model or effort. There is no silent substitution;
2. a warning about a dropped parameter makes the route **unavailable**, not degraded. A warning nobody acts on is a warning nobody needed to send;
3. when the effective effort cannot be confirmed, the risk is recorded explicitly and the route is admitted only under an accepted policy — never by default;
4. a read-only gate role on a full-access provider gets an isolated immutable workspace and capability-minimal tools. The provider's own permission mode is evidence, not a substitute;
5. every reply wait has an explicit idle **and** wall-clock budget. One without the other leaves the other unbounded;
6. retries are bounded and recorded per route and provider;
7. after an exhausted provider error, a new child on the **same failure domain** may not be created immediately. Retrying into the same outage is how a bounded retry becomes an unbounded one;
8. a failure domain is a property of the harness, not of the model. Cursor going down takes Grok and Kimi with it and leaves Codex and Claude alone, and the record says so by naming the domain rather than the vendor;
9. a replacement session carries a generation and a `replaces` binding, so two attempts can never be read as one;
10. stdout, stderr and diagnostics are redacted and bounded before they are stored.

## 4. Process lifecycle

- spawn without shell interpolation;
- stdin closed or controlled;
- a timeout kills the whole **process tree**, not the child it started;
- signal forwarding and cleanup are deterministic;
- no orphan survives the driver;
- a provider exit of zero without a valid structured result is a **failure**, not a pass. "The process ended" is not "the work was done";
- the synthetic smoke call contains no private project data.

## 5. Expiry and the runtime lock

An attestation has a `checked_at` and an `expires_at`, and an expired one is not an attestation. The capability registry version enters the runtime lock (#10), so a route whose registry changed mid-Epic is a change the Epic can notice rather than absorb.

## 5a. What the provider loads by itself

The prompt envelope is a pinned slice of the instruction lock. A file the
provider loads on its own would enter that envelope unpinned, and unpinned bytes
void the protocol hash and every PASS bound to it — silently, which is the part
that matters.

So the route record states the disposition rather than leaving it to be
observed: either the provider's own context loading is `disabled`, or it is
`enumerated_by_lock` and the record names the exact instruction-lock digest that
enumerates it. A route pinned to another Epic's lock says nothing about what
this one would load. "We did not see it load anything" is not one of the two
answers, and a record that gives neither is `route_auto_context_unpinned`.

## 6. Refusal classes

- `route_model_unsupported`;
- `route_effort_dropped`;
- `route_effort_unconfirmable`;
- `route_auth_expired`;
- `route_smoke_failed`;
- `route_permission_mode_unavailable`;
- `route_preflight_expired`;
- `route_failure_domain_down`;
- `route_retry_budget_exhausted`;
- `route_result_missing`;
- `route_session_generation_conflict`;
- `route_auto_context_unpinned`.

## 7. What this contract decides, and what it defers

Decided: the route record, the ten runtime rules, the process lifecycle requirements, expiry, and the closed refusal set.

Deferred, and named: the preflight runner, the fake providers the mandatory tests need, and the dispatch guard that reads an attestation.
