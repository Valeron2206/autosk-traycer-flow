# Матрица программных возможностей autosk-flow

> Канонический источник — `resources/program-capabilities/matrix.v1.json`. Этот документ генерируется детерминированно и не является вторым roadmap или runtime-ledger.

## Назначение

Матрица классифицирует ровно GitHub issues #3–#39 по сроку обязательной реализации. Она отличается от Traycer parity registry: source registry отвечает, **что переносится**, а эта матрица — **к какой вехе обязан быть готов соответствующий program issue**.

Состояние issue/PR здесь намеренно не хранится. Текущий progress остаётся в GitHub и roadmap #40.

## Зафиксированная политика

- **required_for_v1:** The design disposition must be represented in issue #39 and every stated implementation/release obligation must be satisfied before the autonomous MVP, unless a reviewed split moves an exact non-critical remainder after v1.
- **planned_after_v1:** The capability is explicitly inactive in v1, remains mandatory for the full program, and starts at its recorded activation trigger after the autonomous MVP.
- **intentionally_deferred:** Allowed only with an immutable external blocker or explicit user decision, complete risk/owner/return trigger, and no claim of full completion.
- **Полная программа:** The program continues after the autonomous MVP until all planned_after_v1 work is complete; intentionally_deferred is not completion without a later explicit user disposition.
- **Эволюция матрицы:** Any new or split issue outside the pinned inventory requires a successor matrix version, refreshed issue inventory, and full panel before it can become required_for_v1 or release-blocking.

В source-parity registry диспозиция `intentionally_deferred` означает, что исходная возможность не активна в v1; её program-lifecycle эквивалент здесь — `planned_after_v1`. Только program capability matrix может освободить delivery obligation через собственный более строгий `intentionally_deferred`.

## Итог

| Класс | Количество | Значение |
| --- | ---: | --- |
| required_for_v1 | 31 | Design disposition входит в #39; implementation/release obligation блокирует autonomous MVP. |
| planned_after_v1 | 6 | Явно не входит в v1, но обязательно выполняется после #36 для полной программы. |
| intentionally_deferred | 0 | В v1 отсутствует; такой статус потребует отдельного immutable решения. |
| release_blocking | 31 | Невыполненная обязанность запрещает autonomous MVP release. |

## Все program issues

Поле `dependencies` задаёт implementation/execution ordering. Для design gate #39 predecessor edge означает наличие frozen design contract, а не завершённой implementation; обязанности до #39 задаются в `design_obligation_before_issue_39` каждой записи.

| Issue | Priority | Lifecycle | Target | Gate role | Depends on | Release blocker | Full program |
| ---: | :---: | --- | --- | --- | --- | :---: | :---: |
| #3 Создать полный migration/parity registry Traycer → autosk-flow | P0 | required_for_v1 | phase_0_complete | phase_0_gate | — | yes | yes |
| #4 Добавить human alignment gates перед Brief, Core Flow, Tech Plan и Tickets | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #3, #10 | yes | yes |
| #5 Добавить Epic planning ref и commit-on-PASS для каждого планового артефакта | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #3, #4 | yes | yes |
| #6 Добавить канонический machine-readable Tickets manifest и JSON Schema | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #5 | yes | yes |
| #7 Формировать execution base Ticket из approved transitive dependencies | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #5, #6 | yes | yes |
| #8 Заменить full-tree equality на approved-delta integration и перенести adversarial CAS test suite | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #7 | yes | yes |
| #9 Ввести private Epic staging ref и выполнять aggregate verification до final target CAS | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #4, #8, #17, #18 | yes | yes |
| #10 Закреплять extension/workflow code identity на весь Epic и добавить явную миграцию | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #3 | yes | yes |
| #11 Реализовать в autoskd атомарный creation_key + creation_binding_hash для idempotent child fan-out | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #10 | yes | yes |
| #12 Зафиксировать project instruction set и запретить неявную model-specific загрузку | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #3, #4 | yes | yes |
| #13 Зафиксировать реализуемую safeProjectFs стратегию для macOS/Linux | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #10 | yes | yes |
| #14 Обобщить panel lifecycle на все behavior-defining artifacts | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #4, #12 | yes | yes |
| #15 Определить immutable task-store projection для параллельных gate-задач | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #10, #11, #12, #18 | yes | yes |
| #16 Реализовать canonical finding registry, merge/triage/contest и late-finding semantics | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #14, #15, #18 | yes | yes |
| #17 Добавить project delivery profile preflight: branch policy, CI, signatures, DCO и integration mode | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #12 | yes | yes |
| #18 Сделать все model-owned результаты структурированными, а transitions — host-mediated | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #4, #10, #11, #12 | yes | yes |
| #19 Реализовать stage→protocol carrier matrix и attribution echo для каждого handoff | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #3, #12, #14, #18, #37 | yes | yes |
| #20 Добавить clearance manifest и fail-closed сканирование сериализованного handoff | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #19 | yes | yes |
| #21 Добавить immutable snapshots и drift guard для внешних/non-Git источников | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #12, #13 | yes | yes |
| #22 Портировать verified artifact writes: receipts, quarantine и reconciliation | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #13, #18 | yes | yes |
| #23 Реализовать project verification doc workflow по protocol/verification/template.md | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #14, #19, #22 | yes | yes |
| #24 Сделать work-type playbooks исполняемыми prerequisites и evidence gates | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #6, #19, #22, #23 | yes | yes |
| #25 Реализовать requirement revision propagation: product → technical → Tickets → implemented work | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #4, #6, #14, #16, #35 | yes | yes |
| #26 Усилить provider preflight: exact route/effort, capability isolation, time budgets и failure domains | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #19, #20 | yes | yes |
| #27 Определить evidence lifecycle: schema, redaction, retention, tombstones и durable/transient classes | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #13, #20, #22 | yes | yes |
| #28 Реализовать autosk-native Autobuild Generator/Evaluator workflow | P1 | planned_after_v1 | full_parity_post_v1 | post_v1_capability | #6, #16, #19, #20, #23, #24, #25, #26, #27, #32, #35, #36, #37 | no | yes |
| #29 Реализовать Reflect + cost-watch для управляемой эволюции governance | P1 | planned_after_v1 | full_parity_post_v1 | post_v1_capability | #14, #16, #20, #26, #27, #36, #37 | no | yes |
| #30 Добавить безопасный Housekeeping workflow для worktrees, snapshots и orphan state | P1 | planned_after_v1 | full_parity_post_v1 | post_v1_capability | #13, #27, #34, #36 | no | yes |
| #31 Добавить отдельный Debate workflow для non-empirical one-way-door решений | P1 | planned_after_v1 | full_parity_post_v1 | post_v1_capability | #4, #14, #16, #19, #20, #26, #35, #36 | no | yes |
| #32 Перенести bounded loop protocol и четыре обязательных escalation trigger | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #18, #24, #26 | yes | yes |
| #33 Добавить user-approved Changeset Walkthrough, привязанный к final staging identity | P2 | planned_after_v1 | full_parity_post_v1 | post_v1_capability | #9, #20, #27, #35, #36 | no | yes |
| #34 Добавить `autosk-flow doctor` для fail-fast проверки проекта, runtime и recovery state | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #4, #10, #11, #12, #13, #17, #19, #20, #26, #27, #37 | yes | yes |
| #35 Добавить human decision queue и детерминированный status/reporting contract | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #4, #12, #18 | yes | yes |
| #36 Добавить clean-room E2E: полный flow без Traycer, multi-project isolation и crash recovery | P0 | required_for_v1 | autonomous_mvp | mvp_release_gate | #5, #6, #7, #8, #9, #10, #11, #12, #13, #14, #15, #16, #17, #18, #19, #20, #21, #22, #23, #24, #25, #26, #27, #32, #34, #35, #37, #39 | yes | yes |
| #37 Реализовать governance bundle import/build/release lifecycle с аттестацией | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #3, #10, #12, #13, #14 | yes | yes |
| #38 Расширить autosk extension SDK типизированным write API и убрать CLI из correctness-critical paths | P2 | planned_after_v1 | full_parity_post_v1 | post_v1_capability | #11, #18, #36 | no | yes |
| #39 Пересобрать спецификацию и получить новый four-model PASS после архитектурных dispositions | P0 | required_for_v1 | design_ready | design_gate | #3, #4, #5, #6, #7, #8, #9, #10, #11, #12, #13, #14, #15, #16, #17, #18 | yes | yes |

## Примитивы, которых требует preflight

Preflight отказывает любому model workflow без каждой из этих capabilities (`REQUIRED_DAEMON_CAPABILITIES` в `src/host/daemon-preflight.mjs`, `MODEL_STEP_CHECKS` в `src/host/workflow-preflight.mjs`). Поэтому каждую несёт хотя бы одна запись `required_for_v1`, и `implementation_obligation_before_mvp` каждой такой записи называет её; validator сверяет список с этими двумя наборами в обе стороны, а каждая поверхность принадлежит одному владельцу и названа в его обязательстве. Проверки фаз (`PHASE_CHECKS`) — проверки хоста, которые doctor реализует сам (#34), и этой таблицей не покрываются (ADR-092).

| Capability | Kind | ADR | Carried by | Surfaces | Delivery |
| --- | --- | --- | --- | --- | --- |
| `authority.user-decision` | daemon_capability | ADR-023 | #4, #9 | signer key pin (#4); UserDecisionRecord journal (#4); authority/nonce heads (#4); dependency/intent heads (#4); authorityGuard (#9); integrateApproved (#9) | compat/autosk patches 0052+; the capability moves into PINNED_DAEMON_CAPABILITIES with a revision and methods once specified |
| `daemon.capabilities_pinned` | model_step_check | ADR-097 | #11, #18, #34 | `requireDaemonCapabilities` and what it checks (#11); `requireDaemonCapabilities` at extension load (#18); daemon capability check (#34); dispatch gate before any model launch (#34) | the check is the doctor's (src/host/doctor-checks.mjs) and hands a report to requireDaemonCapabilities (src/host/daemon-preflight.mjs, #11); the call at extension load comes with #18's entry point and the dispatch gate with #34's; no report passes the check before ADR-023 and ADR-025 are pinned |
| `security.signer_boundary` | model_step_check | ADR-090 | #4, #34 | signer in a separate OS boundary (#4); signer boundary probe (#34); dispatch gate before any model launch (#34) | the signer and its daemon report ship with authority.user-decision in compat/autosk patches 0052+; the check is the doctor's (src/host/doctor-checks.mjs) |
| `task.creation-binding` | daemon_capability | ADR-014 | #11 | task.create_bound (#11); session token kept out of the model environment (#11) | compat/autosk patches 0001 and 0028, pinned as v2 with method task.create_bound; a later compat/autosk patch takes the session token out of the model environment (roadmap #231) |
| `workflow.custody` | daemon_capability | ADR-025 | #18 | step-capability metadata CAS (#18); write-once gate-result receipts (#18); orchestrateChildBatch (#18); park.origin writer (#18); resume leaves under metadata CAS (#18) | compat/autosk patches 0052+; the capability moves into PINNED_DAEMON_CAPABILITIES with a revision and methods once specified, and the host writes the resume leaves only through the metadata CAS it provides (roadmap #231) |

## Точки исполнения, на которых стоит граф

Граф workflow (`resources/workflow-graph/workflow-graph.v1.json`) объявляет то, что исполняет только продуктовый код: предикаты, которые кто-то должен вычислить, guards, чей `authority` называет человека или policy, workflows, которые кто-то должен собрать и зарегистрировать, и workflows Arena, чей runtime решает её контракт. `validate:capabilities` выводит эти точки из самого графа (`enforcementRequirements`) и держит их к матрице по тому же правилу, что примитивы preflight: каждую несёт запись `required_for_v1`, чьё `implementation_obligation_before_mvp` называет её и свои поверхности, запись, которая её называет, — среди владельцев, а владелец точки с workflows называет каждый из них; владелец runtime Arena — один и тот же в матрице, в строке статуса контракта Arena и в реестре parity (ADR-097). Смысл каждого предиката остаётся за записью его домена.

| Point | Read from | ADR | Carried by | Surfaces | Delivery |
| --- | --- | --- | --- | --- | --- |
| `graph.arena-runtime` | graph_workflows | ADR-077 | #18 | Arena runtime (#18) | the host-mediated candidate and judge steps of the Arena workflows the graph registers, as docs/contracts/arena.md decides them: candidates isolated from each other, a judge of a third family that ranks and does not approve, the person's decision re-expressed in the Tech Plan |
| `graph.guard-authority` | graph_guard_authority | ADR-091 | #18 | guard authority evaluator (#18) | extension product code that admits human authority only as a UserDecisionRecord #4's verifier accepts, and policy authority only within the rules and scope the guard records (ADR-023, ADR-091) |
| `graph.predicate-evaluation` | graph_predicates | ADR-082 | #18 | table from each predicate id to its implementation (#18) | extension product code that binds each predicate id to the implementation in its domain record's module and hands the table to buildWorkflow (src/host/workflow-factory.mjs), which applies it at both decision sites |
| `graph.workflow-registration` | graph_workflows | ADR-090 | #18 | extension entry point (#18) | extension product code that builds each workflow the graph registers with buildWorkflow and registers it with the daemon, after the capability refusal at extension load |

## Planned after v1

### #28 — [P1] Реализовать autosk-native Autobuild Generator/Evaluator workflow

**Почему после v1:** Autobuild is an advanced opt-in Generator/Evaluator loop and is not required to prove the core Planned/Quick autonomous MVP.

**Риск:** Deferring it means hands-off iterative build campaigns remain unavailable at v1, but core correctness and manual Ticket orchestration remain intact.

**Условие активации:** Begin after issue #36 closes and the autonomous MVP release is attested.

**Обязанность до #39:** Before #39 mark the workflow and bundled protocol as inactive_in_v1 with an explicit post-v1 contract and no readiness claim.

**Работа после MVP:** None before MVP; after #36 implement the approved run contract, budgets, sprint Tickets, evaluation and recovery.

### #29 — [P1] Реализовать Reflect + cost-watch для управляемой эволюции governance

**Почему после v1:** Reflect and cost-watch govern long-term protocol evolution but are not required for the first correct autonomous workflow release.

**Риск:** Without it v1 relies on manual retrospectives and governance growth is not automatically measured.

**Условие активации:** Begin after issue #36 closes and at least one completed Epic provides retrospective evidence.

**Обязанность до #39:** Before #39 document inactive_in_v1 status and the rule that no automatic governance mutation is implied.

**Работа после MVP:** None before MVP; after #36 implement sanitized retrospectives, cost-watch and panel-governed bundle changes.

### #30 — [P1] Добавить безопасный Housekeeping workflow для worktrees, snapshots и orphan state

**Почему после v1:** Housekeeping is an operator convenience for stale/orphan state; safe end-of-Epic cleanup and retention correctness remain v1 requirements elsewhere.

**Риск:** Operators may need manual cleanup after v1, but deferring automated inventory is safer than shipping premature destructive logic.

**Условие активации:** Begin after issue #36 closes and safeProjectFs/evidence retention are proven in production-like E2E.

**Обязанность до #39:** Before #39 distinguish mandatory scoped cleanup from the inactive post-v1 host-wide Housekeeping workflow.

**Работа после MVP:** None before MVP beyond safe scoped cleanup; after #36 implement inventory/classification/approval/revalidation deletion.

### #31 — [P1] Добавить отдельный Debate workflow для non-empirical one-way-door решений

**Почему после v1:** Debate addresses non-empirical one-way-door trade-offs and is optional beyond the core alignment/Panel/Arena lifecycle.

**Риск:** V1 must escalate such questions to a human without structured multi-perspective debate.

**Условие активации:** Begin after issue #36 closes and the autonomous MVP release is attested.

**Обязанность до #39:** Before #39 mark Debate inactive_in_v1 and preserve the human-decision fallback without false capability claims.

**Работа после MVP:** None before MVP; after #36 implement two approval gates, participant rounds, mediator synthesis and impact handoff.

### #33 — [P2] Добавить user-approved Changeset Walkthrough, привязанный к final staging identity

**Почему после v1:** Changeset Walkthrough is explanatory UX after a verified result and does not participate in correctness of the core release.

**Риск:** Users will not receive an auto-generated semantic review guide in v1, but all canonical evidence remains accessible.

**Условие активации:** Begin after issue #36 closes and final staging/status APIs are stable.

**Обязанность до #39:** Before #39 mark the artifact explanatory and inactive_in_v1, with no effect on completion or PASS.

**Работа после MVP:** None before MVP; after #36 implement user opt-in generation, fact validation and staging/target identity binding.

### #38 — [P2] Расширить autosk extension SDK типизированным write API и убрать CLI из correctness-critical paths

**Почему после v1:** A complete typed extension write API is a post-MVP control-plane improvement when the accepted v1 primitives can be proven through narrower daemon APIs.

**Риск:** Keeping CLI boundaries longer increases parsing/process complexity; if any v1 atomic guarantee cannot be met, the necessary subset must be promoted before MVP.

**Условие активации:** Begin after issue #36 closes and the autonomous MVP release is attested.

**Обязанность до #39:** Before #39 document that any conditional SDK promotion requires an explicit user decision, a successor matrix classification, and a new full panel.

**Работа после MVP:** No implementation before MVP. If a v1 atomic guarantee cannot be met, record an explicit user decision, split the exact typed primitive into a successor matrix, classify it required_for_v1, and pass a new full panel before implementation. The daemon primitives the v1 preflight requires are not this issue's: they are carried by #4, #9 and #18 through narrower daemon methods (ADR-092), and this issue later exposes them through the typed SDK.

## Намеренно отложенные

В версии matrix.v1 нет `intentionally_deferred`: пользователь требует полную программу, поэтому расширенные capabilities запланированы после v1, а не сняты с обязательств.

## Ключевые gates

- **#3 — Phase 0 gate:** source-level migration/parity inventory должен оставаться полным и проверяемым.
- **#39 — Design gate:** implementation backlog создаётся только после нового four-model PASS одного exact candidate.
- **#36 — MVP release gate:** clean-room E2E без Traycer должен пройти после всех `required_for_v1` implementation obligations.
- После #36 программа продолжается по `planned_after_v1`; MVP и полный parity — разные вехи.

## Проверка

```bash
npm test
npm run validate:capabilities
```

Inventory digest: `9a5b76cb38138afe2aea39c04a15b5b967823c9163b408b9fe2f10fe566927a2`

Matrix digest: `d331305b77069d6a167313dbf3029632220e99dc0089bb658dea992e80bb992f`

