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

## Итог

| Класс | Количество | Значение |
| --- | ---: | --- |
| required_for_v1 | 31 | Design disposition входит в #39; implementation/release obligation блокирует autonomous MVP. |
| planned_after_v1 | 6 | Явно не входит в v1, но обязательно выполняется после #36 для полной программы. |
| intentionally_deferred | 0 | В v1 отсутствует; такой статус потребует отдельного immutable решения. |
| release_blocking | 31 | Невыполненная обязанность запрещает autonomous MVP release. |

## Все program issues

| Issue | Priority | Lifecycle | Target | Gate role | Depends on | Release blocker |
| ---: | :---: | --- | --- | --- | --- | :---: |
| #3 Создать полный migration/parity registry Traycer → autosk-flow | P0 | required_for_v1 | phase_0_complete | phase_0_gate | — | yes |
| #4 Добавить human alignment gates перед Brief, Core Flow, Tech Plan и Tickets | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #3 | yes |
| #5 Добавить Epic planning ref и commit-on-PASS для каждого планового артефакта | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #3, #4 | yes |
| #6 Добавить канонический machine-readable Tickets manifest и JSON Schema | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #5 | yes |
| #7 Формировать execution base Ticket из approved transitive dependencies | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #5, #6 | yes |
| #8 Заменить full-tree equality на approved-delta integration и перенести adversarial CAS test suite | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #7 | yes |
| #9 Ввести private Epic staging ref и выполнять aggregate verification до final target CAS | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #8, #17 | yes |
| #10 Закреплять extension/workflow code identity на весь Epic и добавить явную миграцию | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #3 | yes |
| #11 Реализовать в autoskd атомарный creation_key + creation_binding_hash для idempotent child fan-out | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #10 | yes |
| #12 Зафиксировать project instruction set и запретить неявную model-specific загрузку | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #3, #4 | yes |
| #13 Зафиксировать реализуемую safeProjectFs стратегию для macOS/Linux | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #10 | yes |
| #14 Обобщить panel lifecycle на все behavior-defining artifacts | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #4, #12 | yes |
| #15 Определить immutable task-store projection для параллельных gate-задач | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #10, #11, #12, #18 | yes |
| #16 Реализовать canonical finding registry, merge/triage/contest и late-finding semantics | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #14, #15, #18 | yes |
| #17 Добавить project delivery profile preflight: branch policy, CI, signatures, DCO и integration mode | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #12 | yes |
| #18 Сделать все model-owned результаты структурированными, а transitions — host-mediated | P0 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #10, #12 | yes |
| #19 Реализовать stage→protocol carrier matrix и attribution echo для каждого handoff | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #3, #12, #14, #18, #37 | yes |
| #20 Добавить clearance manifest и fail-closed сканирование сериализованного handoff | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #19 | yes |
| #21 Добавить immutable snapshots и drift guard для внешних/non-Git источников | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #12, #13 | yes |
| #22 Портировать verified artifact writes: receipts, quarantine и reconciliation | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #13, #18 | yes |
| #23 Реализовать project verification doc workflow по protocol/verification/template.md | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #14, #19, #22 | yes |
| #24 Сделать work-type playbooks исполняемыми prerequisites и evidence gates | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #6, #19, #22, #23 | yes |
| #25 Реализовать requirement revision propagation: product → technical → Tickets → implemented work | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #4, #6, #14, #16, #35 | yes |
| #26 Усилить provider preflight: exact route/effort, capability isolation, time budgets и failure domains | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #19, #20 | yes |
| #27 Определить evidence lifecycle: schema, redaction, retention, tombstones и durable/transient classes | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #13, #20, #22 | yes |
| #28 Реализовать autosk-native Autobuild Generator/Evaluator workflow | P1 | planned_after_v1 | full_parity_post_v1 | post_v1_capability | #6, #16, #19, #20, #23, #24, #25, #26, #27, #32, #35, #36, #37 | no |
| #29 Реализовать Reflect + cost-watch для управляемой эволюции governance | P1 | planned_after_v1 | full_parity_post_v1 | post_v1_capability | #14, #16, #20, #26, #27, #36, #37 | no |
| #30 Добавить безопасный Housekeeping workflow для worktrees, snapshots и orphan state | P1 | planned_after_v1 | full_parity_post_v1 | post_v1_capability | #13, #27, #34, #36 | no |
| #31 Добавить отдельный Debate workflow для non-empirical one-way-door решений | P1 | planned_after_v1 | full_parity_post_v1 | post_v1_capability | #4, #14, #16, #19, #20, #26, #35, #36 | no |
| #32 Перенести bounded loop protocol и четыре обязательных escalation trigger | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #18, #24, #26 | yes |
| #33 Добавить user-approved Changeset Walkthrough, привязанный к final staging identity | P2 | planned_after_v1 | full_parity_post_v1 | post_v1_capability | #9, #20, #27, #35, #36 | no |
| #34 Добавить `autosk-flow doctor` для fail-fast проверки проекта, runtime и recovery state | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #10, #11, #12, #13, #17, #19, #20, #26, #27, #37 | yes |
| #35 Добавить human decision queue и детерминированный status/reporting contract | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #4, #12, #18 | yes |
| #36 Добавить clean-room E2E: полный flow без Traycer, multi-project isolation и crash recovery | P0 | required_for_v1 | autonomous_mvp | mvp_release_gate | #5, #6, #7, #8, #9, #10, #11, #12, #13, #14, #15, #16, #17, #18, #19, #20, #21, #22, #23, #24, #25, #26, #27, #32, #34, #35, #37, #39 | yes |
| #37 Реализовать governance bundle import/build/release lifecycle с аттестацией | P1 | required_for_v1 | autonomous_mvp | design_and_mvp_input | #3, #10, #12, #13, #14 | yes |
| #38 Расширить autosk extension SDK типизированным write API и убрать CLI из correctness-critical paths | P2 | planned_after_v1 | full_parity_post_v1 | post_v1_capability | #11, #18, #36 | no |
| #39 Пересобрать спецификацию и получить новый four-model PASS после архитектурных dispositions | P0 | required_for_v1 | design_ready | design_gate | #3, #4, #5, #6, #7, #8, #9, #10, #11, #12, #13, #14, #15, #16, #17, #18 | yes |

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

**Условие активации:** Begin after issue #36 closes or earlier only by explicit user request for the Debate capability.

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

**Условие активации:** Begin after issue #36 closes; promote an exact subset earlier if a v1 atomic guarantee cannot be implemented safely without it.

**Обязанность до #39:** Before #39 document the conditional escalation rule and ensure v1 never relies on a human-oriented untyped outcome for correctness.

**Работа после MVP:** None by default before MVP; immediately split/promote any required typed primitive that #11/#18 or another accepted contract cannot safely provide.

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

Inventory digest: `003899bce88cdc838541280461aa48713d4efcd8cba3b1c95c4749881aa12331`

Matrix digest: `e133b1c5244bc83a3fcf0abef0c000b6b82841f705ec0e97ad0e320bfe5747c7`

