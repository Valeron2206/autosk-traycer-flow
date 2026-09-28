# Проект автономного autosk-flow для autosk v2

Статус: REVISION IN PROGRESS. Исторический PANEL PASS относится только к прежнему candidate `2b97752`; новый design gate ведётся в issue #39. Начата публикация runtime-компонентов; полный workflow и production-ready статус ещё не достигнуты.

## Цель

Реализовать автономное расширение autosk v2, которое переносит проверяемые гарантии рабочего процесса, но не зависит от Traycer, devflow, Obsidian или внешнего архитектурного навыка:

- адаптивное планирование через Brief, Core Flow, Tech Plan и Tickets;
- явное согласование человеком материальных решений до нормативного Brief, Core Flow, Tech Plan и панели Tickets;
- обязательную независимую панель GPT, Grok, Muse и Opus для каждого созданного планового артефакта;
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
16. Операционная truth защищена daemon workflow custody: model sessions не получают `.autosk`, task/comment/metadata/refs или raw CLI. Host writes требуют step-bound capability + expected protected metadata head; gate outcomes — write-once daemon receipts под result head. Preflight требует одновременно ADR-014 creation identity, ADR-023 authority/intent и ADR-025 custody; без любого model workflow не запускается. Процесс модели работает под учётной записью `autosk-model` (правило 19), и его сессия провайдера, `HOME` и конфигурация лежат в его собственном каталоге сессии, вне `.autosk`: хранилище `.autosk` принимает файл, только если он приватен uid'у autoskd. autoskd читает сессию провайдера оттуда как недоверенный ввод — разбирает и копирует, не принимая файл в своё хранилище; где этот каталог лежит под корнем проекта — открыто за #13 с #18 и #11 (`docs/contracts/platform-support.md` §5b, ADR-102).
17. Planning verdict не завершает артефакт сам по себе. `record_artifact_pass` создаёт recorded-unpublished binding и durable operation; только host-owned `publish_artifact_pass` может попросить ref-custody helper CAS-продвинуть `refs/autosk/epics/<epic_ref_key>/planning`, проверить descendant commit/tree и разрешить `select_next`. Target branch при этом не меняется.
18. Runtime-истиной комплекта Tickets является только schema-valid canonical `tickets.manifest.json` из exact verified Tickets publication commit. `README.md` и `Txx-*.md` — детерминированные renderer outputs; `dispatch_ticket_dag` не извлекает operational fields из Markdown.
19. Установка autosk-flow в проект включает один привилегированный шаг администратора: он создаёт непривилегированную учётную запись `autosk-model`, её группу с пользователем и механизм, которым autoskd запускает под ней процессы моделей и завершает их дерево целиком (`docs/contracts/platform-support.md` §5b, ADR-102). Всё остальное работает под учётной записью пользователя, и Git-каталог проекта остаётся обычным репозиторием пользователя: autoskd, helper `autosk-flow-ref-custody` — отдельный процесс со своим сокетом, журналом и nonce — и собственные инструменты пользователя; porcelain пользователя (удаление веток и тегов, `git config`, hooks, `fetch --prune`, `gc`) работает как в любом репозитории. По протоколу каждый ref под `refs/autosk/**` (planning, candidates, audit и staging Epic) и его reflog пишет только helper (ADR-095, §5a). От моделей эти refs закрывает ОС: `autosk-model` не открывает ни одного Git-каталога проекта, ни на чтение, ни на запись. От инструментов самого пользователя их защищает обнаружение: ref, сдвинутый мимо helper'а, находит следующий CAS helper'а, и flow паркуется, а не перезаписывает его; упакованный защищённый ref отвергает preflight helper'а. Target branch ОС от пользователя тоже не закрывает — её движение не через `integrateApproved` обнаруживается при CAS как чужое. Процесс модели пишет только файлы своего worktree и свой каталог сессии вне `.autosk` (правило 16) и не достаёт signer, secure store, keychain пользователя и токен RPC autoskd. В worktree модели porcelain пользователя не запускает hooks, которые написала модель: `config.worktree` задаёт `core.hooksPath=/dev/null` и `core.fsmonitor=false`. Чтобы Git пользователя не принял bare-репозиторий, который модель соберёт внутри своего worktree, задайте `safe.bareRepository=explicit` (`git config --global safe.bareRepository explicit`) и никогда не добавляйте `safe.directory` для worktree модели, тем более `*`. Установка, механизм запуска моделей под `autosk-model`, зонды проверок `security.ref_custody` и `security.model_account` (до зондов обе отвечают `unverifiable` и блокируют workflows, которые их требуют) и парковка проекта без доказанного helper'а при открытии, до первого побочного эффекта (`ref_custody_unavailable`), — обязательство #13 с #5; ничего из этого ещё не реализовано.

## Состав пакета

- [01-core-flows.md](01-core-flows.md) — маршруты задач, панели, арены и проверки.
- [02-architecture.md](02-architecture.md) — компоненты, границы ответственности и хранение.
- [03-technical-plan.md](03-technical-plan.md) — реализуемый план расширения autosk v2.
- [04-decisions.md](04-decisions.md) — предлагаемые ADR и оставшиеся риски; статус станет accepted только после решения пользователя и PASS панели.
- Контракты дизайна в `docs/contracts/`, по одному на решение: [anchor-pack](docs/contracts/anchor-pack.md),
  [approved-delta](docs/contracts/approved-delta.md), [arena](docs/contracts/arena.md),
  [artifact-registry](docs/contracts/artifact-registry.md),
  [artifact-write-receipt](docs/contracts/artifact-write-receipt.md),
  [autobuild-run](docs/contracts/autobuild-run.md), [bounded-loop](docs/contracts/bounded-loop.md),
  [clean-room-e2e](docs/contracts/clean-room-e2e.md),
  [clearance-manifest](docs/contracts/clearance-manifest.md),
  [creation-grant](docs/contracts/creation-grant.md), [debate](docs/contracts/debate.md),
  [delivery-profile](docs/contracts/delivery-profile.md), [doctor-report](docs/contracts/doctor-report.md),
  [epic-planning-ref](docs/contracts/epic-planning-ref.md), [epic-staging](docs/contracts/epic-staging.md),
  [evidence-manifest](docs/contracts/evidence-manifest.md),
  [execution-base](docs/contracts/execution-base.md),
  [external-source-snapshot](docs/contracts/external-source-snapshot.md),
  [finding-registry](docs/contracts/finding-registry.md),
  [gate-store-projection](docs/contracts/gate-store-projection.md),
  [governance-bundle](docs/contracts/governance-bundle.md), [housekeeping](docs/contracts/housekeeping.md),
  [human-decision](docs/contracts/human-decision.md),
  [integration-authorization](docs/contracts/integration-authorization.md),
  [material-decisions](docs/contracts/material-decisions.md), [model-result](docs/contracts/model-result.md),
  [platform-support](docs/contracts/platform-support.md),
  [project-instructions-lock](docs/contracts/project-instructions-lock.md),
  [provider-preflight](docs/contracts/provider-preflight.md),
  [reflect-cost-watch](docs/contracts/reflect-cost-watch.md),
  [refusal-vocabulary](docs/contracts/refusal-vocabulary.md),
  [requirement-revision](docs/contracts/requirement-revision.md),
  [runtime-identity-lock](docs/contracts/runtime-identity-lock.md),
  [sdk-write-api](docs/contracts/sdk-write-api.md), [stage-carriers](docs/contracts/stage-carriers.md),
  [static-analysis](docs/contracts/static-analysis.md),
  [tickets-manifest](docs/contracts/tickets-manifest.md), [verify-doc](docs/contracts/verify-doc.md),
  [walkthrough](docs/contracts/walkthrough.md), [work-type-gates](docs/contracts/work-type-gates.md),
  [workflow-factory](docs/contracts/workflow-factory.md), [workflow-graph](docs/contracts/workflow-graph.md).
  Список полон: `npm run validate:capabilities` сверяет его с каталогом в обе стороны.
- [diagrams/autosk-flow.drawio](diagrams/autosk-flow.drawio) — редактируемая двухстраничная диаграмма.
- [diagrams/autosk-flow-workflow.png](diagrams/autosk-flow-workflow.png) — обзор workflow.
- [diagrams/autosk-flow-architecture.png](diagrams/autosk-flow-architecture.png) — global/project архитектура.

Диаграмма является производным обзором, а не нормативной машиной состояний. Gate связывается с четырьмя Markdown-артефактами и README; при расхождении действует 03-technical-plan.md. Диаграмма проверяется структурно и обновляется после принятых текстовых изменений.

## Граница текущей работы

По решению владельца SOLO_BUILD промежуточные панели разработки перенесены на финальную приёмку. Публикуются отдельные проверяемые изменения в порядке зависимостей roadmap #40. Обязательные панели внутри продукта сохраняются.

Что уже есть. Модули хоста в `src/host/` реализуют проверки контрактов — среди них [контракты создания дочерних задач](docs/runtime/creation-contracts.md) для #11/#38 — и каждый проходит мутационное тестирование (`npm run mutation-report`): модуль без своего runtime-теста и выживший мутант, которого никто не назвал, валят команду. Валидаторы дизайна (`npm run validate:*`) держат контракты, схемы, реестры и граф workflow друг у друга. Прогон чистой комнаты (`npm run clean-room`) собирает закреплённый autosk, проверяет на нём создание задач, восстановление после сбоя и подмену дистрибутива, запускает матрицу отказов и сообщает по каждой группе, как она покрыта (`docs/contracts/clean-room-e2e.md` §7).

Чего ещё нет: примитивов демона ADR-023 (подписанный журнал `UserDecisionRecord`, `authorityGuard`, `integrateApproved`) и ADR-025 (metadata CAS, `orchestrateChildBatch`, gate-result receipts) — закреплённая серия поставляет только ADR-014; signer'а, поэтому сегодня ни одно решение пользователя не принимается ни на одном хосте; ref-custody helper'а и его непривилегированного bootstrap (единственный привилегированный шаг дизайна принадлежит учётной записи модели: её установка, механизм запуска и зонд, #13); точки входа расширения, которая регистрирует workflows графа и вычисляет его предикаты. Это то, что пакет финальной панели перечисляет в разделе «What is not claimed», и матрица v1 называет владельца каждого пункта.

[Совместимая версия autosk](docs/runtime/autosk-compatibility.md) собирается из закреплённого upstream commit и проверяемой серии патчей этого репозитория. CI проверяет реальное создание задач, восстановление после остановки процесса и состав трёх бинарников. Это поставка предпосылки Store; полное расширение и подключение ограниченного SDK ещё не завершены.

## Контракт Epic planning ref

`docs/contracts/epic-planning-ref.md` фиксирует issue #5: Planned Epic создаёт приватный `refs/autosk/epics/<epic_ref_key>/planning`, где key детерминированно выводится из project/Epic identity; каждый approved artifact публикуется отдельным first-parent descendant commit, а `select_next` видит kind завершённым только после read-back verified CAS. Recorded verdict/waiver без публикации не является planning PASS. Anchor rebuild не rewinds ref и использует descendant invalidation commit; target branch остаётся неизменной до будущего staging/final-CAS contract issues #8–#9.

Проверка связи design-документов:

```text
npm run validate:planning-ref
```

## Контракт canonical Tickets manifest

Issue #6 фиксирует один `docs/autosk/epics/<epic-id>/tickets/tickets.manifest.json` как operational authority комплекта. Human-readable overview и Ticket Markdown генерируются pinned renderer и обязаны побайтово совпадать с его output из manifest; изменение любой стороны создаёт новую alignment/candidate identity. Validated manifest, DAG, rendered document set и Ticket entries получают domain-separated digests в host-owned `TicketsValidationReceipt`. После отдельной Ticket Panel issue #5 публикует manifest и все views одним descendant commit; только этот verified commit разрешает `dispatch_ticket_dag`.

Проверка:

```text
npm run validate:tickets-manifest
npm run validate:tickets-manifest -- --candidate-root <tree-root> --manifest-path docs/autosk/epics/<epic-id>/tickets/tickets.manifest.json
```

The candidate-tree form reads and compares the actual on-disk Markdown inventory; it does not compare renderer output with itself.

## Реестр миграционного паритета

Issue #3 добавляет только проверяемое сопоставление миграционных источников с будущими autosk-native компонентами. Это не заявление о готовом runtime:

- Mapping coverage: 100% (37/37)
- Implemented parity: 0% (0/37)
- Verified parity: 0% (0/37)

Машиночитаемый реестр находится в `resources/traycer-parity/registry.v1.json`, закрытая схема — рядом в `registry.schema.json`, а человекочитаемая сводка — в `docs/traycer-parity-registry.md`. Исходные приватные bytes, домашние пути, sessions и transcripts не публикуются. Символические ссылки на Traycer встречаются только как миграционные locators или явные запреты runtime-зависимости.

Проверка требует одну devDependency, acorn, точной версией, установленную через npm ci:

```text
npm ci
npm test
npm run validate:migration
```

Шесть записей отнесены к `post_v1`: Autobuild (две — workflow и протокол `autobuild/run-contract.md`), Reflect (протокол `reflect/reviewer-brief.md`), Debate, Housekeeping и Changeset Walkthrough остаются неактивными до соответствующих issues. Оба протокольных файла всё же входят в v1 governance bundle как неактивные bytes: `inactive_in_v1` в реестре носителей, и ни один носитель v1 их не получает (ADR-093). Два отсутствующих архива сохранены как открытые source-evidence gaps, а не объявлены найденными.

## Матрица программных возможностей

Source parity и program delivery — разные измерения. Каноническая issue-level матрица отдельно классифицирует ровно issues #3–#39:

- `required_for_v1`: 31 — design disposition входит в #39, а невыполненная implementation/release obligation блокирует autonomous MVP;
- `planned_after_v1`: 6 — Autobuild (#28), Reflect (#29), Housekeeping (#30), Debate (#31), Changeset Walkthrough (#33) и полный typed SDK write API (#38) явно не обещаются v1, но остаются обязательными после #36;
- `intentionally_deferred`: 0 — ни одна program capability не снята с обязательств.

Каждую capability, без которой preflight не запускает model workflow, несёт запись `required_for_v1` (ADR-092): `task.creation-binding` — #11, `authority.user-decision` (ADR-023) — #4 и #9, `workflow.custody` (ADR-025) — #18, `security.signer_boundary` — #4, #18 и #34, `daemon.capabilities_pinned` — #11 (функция `requireDaemonCapabilities` и то, что она проверяет), #18 (её вызов при загрузке расширения) и #34 (проверка doctor и gate перед model launch; ADR-097), `security.model_account` — #11, #13, #18 и #34 (ADR-102): #11 — окружение процесса модели, #13 — учётная запись `autosk-model`, механизм запуска под ней и зонд, #18 — путь запуска под этой учётной записью, #34 — gate. Вызов gate'а перед каждым model launch несёт путь запуска #18 у каждой из трёх проверок шага модели, а наборы и допуск gate'а — #34, и матрица ставит #34 после #18 (ADR-102). Демонские примитивы ADR-023 и ADR-025 поставляются патчами `0052`+; #38 остаётся полным typed SDK поверх них после v1.

Точки исполнения, на которых стоит граф workflow, несёт #18 (`enforcement_points`, ADR-097): механизм evaluator'а — таблицу от id каждого предиката к его реализации и оба места решения, предикат и `guards[].authority`, — и точку входа расширения, которая собирает и регистрирует все восемь workflows графа; смысл каждого предиката остаётся за записью его домена. Среди workflows оба workflow Arena/Judge — `autosk-arena-candidate` и `autosk-arena-judge`, — поэтому Arena/Judge входит в v1 и её runtime тоже несёт #18 (`graph.arena-runtime`, `docs/contracts/arena.md`); сквозной прогон Arena входит в E2E #36. Токен сессии вне окружения модели — обязательство #11, листья resume только под metadata CAS — #18; изменение отслеживает #231.

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
