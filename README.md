# Проект автономного autosk-flow для autosk v2

Статус: REVISION IN PROGRESS. Исторический PANEL PASS относится только к прежнему candidate `2b97752`; новый design gate ведётся в issue #39. Реализация runtime ещё не начата.

## Цель

Реализовать автономное расширение autosk v2, которое переносит проверяемые гарантии рабочего процесса, но не зависит от Traycer, devflow, Obsidian или внешнего архитектурного навыка:

- адаптивное планирование через Brief, Core Flow, Tech Plan и Tickets;
- явное согласование человеком материальных решений до нормативного Brief, Core Flow, Tech Plan и панели Tickets;
- обязательную независимую панель GPT, Grok, Kimi и Opus для каждого созданного планового артефакта;
- отдельную обязательную панель комплекта Tickets;
- Arena/Judge для отмеченных конкурирующих решений;
- отдельные worktree для авторов, кандидатов и проверяющих;
- привязку PASS к точной версии артефакта или Git tree OID;
- публикацию каждого утверждённого планового артефакта в приватную per-Epic Git-линию до продолжения workflow;
- независимую межсемейную проверку кода;
- исправления с узкой повторной проверкой;
- детерминированную интеграцию с проверкой движения ветки;
- простой маршрут для задач, которым плановые артефакты не нужны;
- безопасную параллельную работу в нескольких проектах без смешивания их документов, сессий и evidence.

## Канонические правила

1. Если Brief, Core Flow, Tech Plan, Tickets или другой плановый/управляющий нормативный документ создан/изменён, панель обязательна. До generic registry из issue #14 закрытый классификатор отличает такой документ от обычных файлов реализации и fail-closed связывает его с одним из четырёх named lifecycles; если однозначной классификации нет, panel/PASS запрещены. Обычные source/config/schema/prompt/test/migration files остаются кодовым кандидатом и проходят Code Review, а не artifact mapping.
2. Tickets проходят собственную панель после декомпозиции и до реализации. Это новое целевое правило для autosk и сознательно строже текущего текста Traycer guide, где Tickets могли входить в панель Tech Plan.
3. Панель и Code Review — разные механизмы. Панель проверяет плановые артефакты четырьмя моделями; код проверяет одна модель другой семьи относительно автора.
4. Arena/Judge не даёт PASS и не заменяет human alignment, панель или Code Review. Judge рекомендует базовый подход; материальный выбор сначала подтверждает пользователь, после чего синтезированный результат проходит обычный цикл.
5. Каждый PASS связан с неизменяемой identity. Re-binding на новую anchor version разрешён только при unchanged bytes/tree и closed daemon-attributed impact record, который доказывает отсутствие affected upstream kind. Missing/open/unknown impact stales PASS.
6. Пользователь не копирует инструкции вручную. Расширение фиксирует версию протокола и автоматически собирает точный пакет для каждого агента.
7. autoskd остаётся единственным владельцем операционного состояния задач. Отдельная база, второй оркестратор и второй журнал состояния не создаются.
8. `autosk-flow` самостоятельно выполняет planning и Ticket lifecycle. `devflow` не устанавливается, не вызывается и не является fallback.
9. Traycer используется только как локальный одноразовый источник миграции Guide и protocol. Runtime не читает `~/.traycer`, не вызывает `traycer_*` и не требует Traycer skills.
10. Код расширения и активный governance bundle глобальны. Все проектные документы, snapshots, tasks, sessions, evidence и integration state принадлежат конкретному canonical project root.
11. Obsidian MCP и навык `architecture-planning` исключены из процесса и не входят в preflight, prompts или Definition of Done.
12. Child fan-out требует daemon-owned write-once пару `creation_key + creation_binding_hash`, атомарно сохранённую при task.create. Изменяемые title/description/metadata не используются как recovery identity; без primitive preflight останавливает workflow.
13. Модель не подтверждает собственное материальное решение. Brief/Core Flow/Tech Plan/Tickets use canonical material manifest. Любой иной плановый/управляющий normative artifact до issue #14 обязан fail-closed войти в подходящий named lifecycle; unknown mapping blocks draft/panel/PASS. Mapping proof digest входит прямо в identity проверяемого кандидата и не подменяется parent anchor digest.
14. Источником пользовательского решения служит signed daemon `UserDecisionRecord`: trusted init pin'ит key, client подписывает exact nonce challenge, daemon append'ит hash-chain journal и CAS-обновляет rollback-resistant secure head. Short/deleted prefix fail-closed; workflow TOFU/re-pin и text mirrors не дают authority.
15. Quick освобождён от planning gates только пока его classification валидна. Planned-trigger, найденный на любом шаге до integration, детерминированно останавливает Quick и создаёт project-bound Planned replacement; расширить material scope и продолжить Quick нельзя.
16. Операционная truth защищена daemon workflow custody: model sessions не получают `.autosk`, task/comment/metadata/refs или raw CLI. Host writes требуют step-bound capability + expected protected metadata head; gate outcomes — write-once daemon receipts под result head. Preflight требует одновременно ADR-014 creation identity, ADR-023 authority/intent и ADR-025 custody; без любого model workflow не запускается.
17. Planning verdict не завершает артефакт сам по себе. `record_artifact_pass` создаёт recorded-unpublished binding и durable operation; только host-owned `publish_artifact_pass` может CAS-продвинуть `refs/autosk/epics/<epic_ref_key>/planning`, проверить descendant commit/tree и разрешить `select_next`. Target branch при этом не меняется.

## Состав пакета

- [01-core-flows.md](01-core-flows.md) — маршруты задач, панели, арены и проверки.
- [02-architecture.md](02-architecture.md) — компоненты, границы ответственности и хранение.
- [03-technical-plan.md](03-technical-plan.md) — реализуемый план расширения autosk v2.
- [04-decisions.md](04-decisions.md) — предлагаемые ADR и оставшиеся риски; статус станет accepted только после решения пользователя и PASS панели.
- [docs/contracts/epic-planning-ref.md](docs/contracts/epic-planning-ref.md) — нормативный контракт private planning ref, candidate keepalive всей Git object closure, commit-on-PASS, CAS и crash recovery для issue #5.
- [diagrams/autosk-flow.drawio](diagrams/autosk-flow.drawio) — редактируемая двухстраничная диаграмма.
- [diagrams/autosk-flow-workflow.png](diagrams/autosk-flow-workflow.png) — обзор workflow.
- [diagrams/autosk-flow-architecture.png](diagrams/autosk-flow-architecture.png) — global/project архитектура.

Диаграмма является производным обзором, а не нормативной машиной состояний. Gate связывается с четырьмя Markdown-артефактами и README; при расхождении действует 03-technical-plan.md. Диаграмма проверяется структурно и обновляется после принятых текстовых изменений.

## Граница текущей работы

Сейчас обновляется и повторно проверяется только проектный пакет. Код расширения и governance bundle ещё не создаются. Реализация начнётся после четырёх PASS новой точной версии.

## Контракт Epic planning ref

`docs/contracts/epic-planning-ref.md` фиксирует issue #5: Planned Epic создаёт приватный `refs/autosk/epics/<epic_ref_key>/planning`, где key детерминированно выводится из project/Epic identity; каждый approved artifact публикуется отдельным first-parent descendant commit, а `select_next` видит kind завершённым только после read-back verified CAS. Recorded verdict/waiver без публикации не является planning PASS. Anchor rebuild не rewinds ref и использует descendant invalidation commit; target branch остаётся неизменной до будущего staging/final-CAS contract issues #8–#9.

Проверка связи design-документов:

```text
npm run validate:planning-ref
```

## Реестр миграционного паритета

Issue #3 добавляет только проверяемое сопоставление миграционных источников с будущими autosk-native компонентами. Это не заявление о готовом runtime:

- Mapping coverage: 100% (37/37)
- Implemented parity: 0% (0/37)
- Verified parity: 0% (0/37)

Машиночитаемый реестр находится в `resources/traycer-parity/registry.v1.json`, закрытая схема — рядом в `registry.schema.json`, а человекочитаемая сводка — в `docs/traycer-parity-registry.md`. Исходные приватные bytes, домашние пути, sessions и transcripts не публикуются. Символические ссылки на Traycer встречаются только как миграционные locators или явные запреты runtime-зависимости.

Проверка не требует внешних пакетов:

```text
npm test
npm run validate:migration
```

Шесть записей отнесены к `post_v1`: Autobuild, Reflect, Debate, Housekeeping и Changeset Walkthrough остаются неактивными до соответствующих issues. Два отсутствующих архива сохранены как открытые source-evidence gaps, а не объявлены найденными.

## Матрица программных возможностей

Source parity и program delivery — разные измерения. Каноническая issue-level матрица отдельно классифицирует ровно issues #3–#39:

- `required_for_v1`: 31 — design disposition входит в #39, а невыполненная implementation/release obligation блокирует autonomous MVP;
- `planned_after_v1`: 6 — Autobuild (#28), Reflect (#29), Housekeeping (#30), Debate (#31), Changeset Walkthrough (#33) и полный typed SDK write API (#38) явно не обещаются v1, но остаются обязательными после #36;
- `intentionally_deferred`: 0 — ни одна program capability не снята с обязательств.

В source-parity registry одноимённая диспозиция `intentionally_deferred` означает только неактивный в v1 миграционный target; её program-lifecycle эквивалент — `planned_after_v1`. Освободить delivery obligation может только более строгая диспозиция program matrix.

Машиночитаемая матрица находится в `resources/program-capabilities/matrix.v1.json`, pinned issue inventory и закрытые схемы — рядом, а детерминированная сводка — в `docs/program-capability-matrix.md`. Матрица не хранит текущий open/closed/PR state и не становится вторым roadmap: живой progress остаётся в GitHub issue #40.

Проверка:

```text
npm run validate:capabilities
```

Изменение lifecycle classification является behavior-defining program decision и требует нового reviewed candidate.

Новый program issue, split или promotion за пределами pinned #3–#39 не может стать v1/release blocker молча: сначала выпускается successor matrix version с обновлённым issue inventory и новой полной панелью.

## Источники

- исходный код [wierdbytes/autosk](https://github.com/wierdbytes/autosk);
- разговоры «Описание механизмов контроля» и «Проектирование autosk v2»;
- локальные Agent Selection Guide и 12 protocol files как одноразовый миграционный источник, не публикуемый в исходном виде и не используемый runtime.
