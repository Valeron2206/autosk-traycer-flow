# Autonomous development and final acceptance

Decision: `DEV-2026-09-05-SOLO-BUILD`.
Owner authorization: [roadmap #40](https://github.com/Valeron2206/autosk-traycer-flow/issues/40#issuecomment-5549421311).

The operator requested autonomous completion of this repository with intermediate
model panels postponed until the completed project is ready for final acceptance.
This development-only exception supersedes the old pre-implementation waiting rule
in #39. It does not change the product's governance policy.

## Development process

1. Read actual issues, contracts, code and dependencies; do not infer completion
   from a prior conversation, branch name or a claimed artifact.
2. Define the component contract before its implementation. Preserve acceptance
   criteria and a test/evidence mapping. Temporary harness source listings are not
   required in plans; the evidence contract in #24 is still required.
3. Implement and test in `implementation/solo-build`; keep coherent commits and an
   integration PR. Do not move main or issue a release while final acceptance is pending.
4. Keep deterministic, negative, fault/recovery and security checks active. Handle
   available CodeRabbit findings, but do not wait for four external model sessions
   after each development slice.
5. Finish all declared work, including the post-MVP program, then freeze the complete
   source/design/evidence candidate for the real final Panel. #39 remains open.

`IMPLEMENTED_AND_TESTED`, `PENDING_FINAL_PANEL`, and `ACCEPTED` are different
states. A component unit test is not proof of a full production workflow. Missing
credentials/platform access, upstream primitives or production adapters remain
explicit open obligations; a test double is never labeled a production port.

## Product invariants are unchanged

The shipped system must retain independent GPT/Grok/Kimi/Opus artifact and Ticket
panels, a separate cross-family Code Review, user-authorized material decisions,
exact candidate identities, and verification before delivery. No development flag
is read by runtime code to bypass those gates.

Only autoskd owns task state, scheduling and workflow transitions. The extension
must not create a second task database, daemon or scheduler. Runtime does not read
Traycer directories or call Traycer APIs. Oh My Pi remains a discussed, unselected
harness alternative. Sonar/static-analysis issue #47 remains an explicit scope
extension, not an unrecorded change to the historical matrix v1.

No force push, protected-check bypass, destructive user-data operation, secret
publication, paid subscription or production deployment is authorized by this
change in review timing. Historical PASS attestations remain bound to their old
exact trees.

## Return point

The current runnable foundation is described in [runtime/foundation.md](../runtime/foundation.md).
The historical capability matrix stays unchanged and authoritative for its pinned
classification. [implementation-map.md](implementation-map.md) is a source/test
coverage map, not another mutable runtime task ledger. Issues remain the program's
acceptance authority.
