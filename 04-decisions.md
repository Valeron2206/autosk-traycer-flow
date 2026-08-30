# Архитектурные решения

Статус всех решений: proposed, до принятия пользователем и PASS панели.

## ADR-001: расширение поверх autosk v2

- Решение: реализовать процесс как TypeScript extension; autoskd core не форкать в MVP.
- Альтернатива: отдельный оркестратор или глубокая модификация scheduler.
- Обоснование: registerWorkflow, AgentDefinition, onTransit, blockers, sessions и sandbox уже дают необходимые примитивы. Extension сохраняет обновляемость upstream.
- Источники:
  - [LOCAL_SOURCE]
  - [LOCAL_SOURCE]

## ADR-002: два пользовательских маршрута

- Решение: Quick для задач без плановых артефактов и Planned для остальных.
- Альтернатива: всегда полный процесс либо один упрощённый процесс.
- Обоснование: первый вариант переусложняет мелкие задачи, второй теряет гарантии на дорогих изменениях.
- Источники:
  - явное пользовательское правило: полный Traycer-flow для сложных/рисковых задач, простой путь для мелких;
  - 01-core-flows.md.

## ADR-003: панель каждого созданного планового артефакта

- Решение: Brief, Core Flow, Tech Plan и комплект Tickets получают отдельную четырёхмодельную панель.
- Альтернатива: одна панель на весь planning pack либо один критик.
- Обоснование: разные артефакты отвечают на разные вопросы; PASS одного не доказывает корректность следующего. Tickets могут потерять требования при декомпозиции.
- Источники:
  - текущее пользовательское уточнение о панели по умолчанию;
  - разговор «Описание механизмов контроля»;
  - [LOCAL_SOURCE], раздел Plan critique panel.

## ADR-004: строгий roster из четырёх моделей

- Решение: по умолчанию требуются GPT, Grok, Kimi и отдельный Opus. После retry недоступное место паркует процесс в human. Сокращённый roster разрешает только пользователь для конкретного scope.
- Альтернатива: автоматическая деградация до одного критика по старому guide.
- Обоснование: это прямое более новое требование пользователя для целевого autosk-flow; молчаливая деградация выглядела бы как выполненная панель.
- Источники:
  - текущее пользовательское уточнение;
  - exact routes из Pi model catalog, проверенные 2026-08-30.

## ADR-005: fan-out через дочерние autosk-задачи

- Решение: каждое место панели и каждый Arena candidate — отдельная task/session; fan-in строится blockers. Child human продолжает блокировать parent; join принимает только done плюс валидный binding.
- Альтернатива: четыре Pi-процесса внутри одного composite AgentDefinition.
- Обоснование: отдельные task/session IDs дают независимую историю, восстановление и прозрачность. Текущий scheduler уже не запускает blocked work-задачи. Четыре worker по умолчанию улучшают latency, но correctness не зависит от фактической параллельности.
- Источники:
  - [LOCAL_SOURCE]
  - [LOCAL_SOURCE]

## ADR-006: Git хранит нормативную правду

- Решение: Brief, Core Flow, Tech Plan, Decision Log и Tickets хранятся под docs/autosk/epics в Git. autosk metadata не заменяет их.
- Альтернатива: хранить документы внутри daemon runtime или task descriptions.
- Обоснование: Git даёт reviewable history и OID; runtime-файлы остаются операционным состоянием и могут очищаться.
- Источники:
  - раздел Traycer artifact synchronization в agent-selection-guide.md;
  - autosk docs/concepts.md.

## ADR-007: без второго ledger

- Решение: текущее состояние хранится в namespaced task metadata, comments и sessions. Отдельный run.json/status ledger не создаётся.
- Альтернатива: собственный manifest/ledger рядом с autosk state.
- Обоснование: дублирующее состояние создаёт drift. Отдельные evidence records нужны только для байтов verdict/log и связываются hash.
- Источники:
  - autosk task/session model;
  - принцип Simplicity First.

## ADR-008: автоматическая компиляция замороженных инструкций

- Решение: один global protocol bundle копируется в task-scoped snapshot под абсолютным исходным projectRoot; PromptEnvelope собирается daemon-side до запуска sandbox по роли.
- Альтернатива: полагаться на память модели, указывать ей путь без загрузки либо вручную копировать тексты.
- Обоснование: отдельный agent context обязан получить применимые правила, но пользователь не должен их переносить вручную. Snapshot защищает выполняющийся epic от обновления расширения.
- Источники:
  - piAgent firstMessage/task/comments rendering;
  - Traycer protocol snapshot и handoff rules.

## ADR-009: Arena/Judge внутри планирования

- Решение: Arena запускается только для pending entry в каноническом autosk-arena JSON block с ordered decisions array и rubric 3–6 критериев. record_artifact_pass механически ведёт монотонную map по decision_id. Default candidates — Grok и Codex; Judge — отдельный Kimi либо Opus вне candidate set.
- Альтернатива: Arena всей feature либо выбор подхода одним планировщиком.
- Обоснование: локальная Arena решает конкретный спор без удвоения всей разработки. Judge выбирает базу, но изменённый Tech Plan получает новую полную панель, а итоговый код — обычный review.
- Источники:
  - [LOCAL_SOURCE]
  - [LOCAL_SOURCE]

## ADR-010: PASS только по точной идентичности

- Решение: planning verdict связан с artifact snapshot; code verdict — с base/pathspec/tree OID/anchor/attempt. Отдельный deterministic record_artifact_pass атомарно записывает PASS перед select_next. Перед commit/integration identity пересчитывается. commit-on-pass сначала распознаёт уже выполненный CAS по approved tree и восстанавливает metadata после crash.
- Альтернатива: считать достаточным последний комментарий PASS или имя ветки.
- Обоснование: branch и файлы изменяемы; OID и hash обнаруживают stale verdict.
- Источники:
  - разделы Anchor for review и Verdict binding в agent-selection-guide.md;
  - Git object model.

## ADR-011: отдельный межсемейный Code Review

- Решение: после реализации код проверяет отдельная child task на OID-pinned snapshot; gate-carrying модель выбирается детерминированной таблицей и отсутствует в полном author/fixer set. Для Grok-authored кода это GPT Sol.
- Альтернатива: повторно запускать всю панель или позволить автору проверять себя.
- Обоснование: панель и Code Review решают разные задачи; четыре проверки каждого diff не дают соразмерной пользы.
- Источники:
  - раздел Cross-model review в agent-selection-guide.md;
  - разговор «Описание механизмов контроля».

## ADR-012: детерминированная интеграция существующим инструментом

- Решение: переиспользовать traycer-protocol integrate-approved как adapter subprocess. State file хранить вне repo/worktrees.
- Альтернатива: prompt-driven merge или новая TypeScript-реализация CAS/reflog.
- Обоснование: существующий инструмент уже закрывает crash resume, foreign movement, obstruction, reattach и reflog continuity. Переписывание увеличит риск без пользовательской ценности.
- Источники:
  - [LOCAL_SOURCE]
  - bin.zip tests.

## ADR-013: human gate перед интеграцией

- Решение: accept — statusStep("human") после PASS и до движения целевой ветки. Auto-integration policy позволяет ticket_join перейти сразу в integrate; иначе только resume --to integrate с acceptance той же identity.
- Альтернатива: всегда автоматически интегрировать после PASS.
- Обоснование: review подтверждает кандидат, но не всегда разрешает изменение пользовательской ветки. Явная policy убирает повторный вопрос для доверенных проектов.
- Источники:
  - autosk statusStep human;
  - связанный разговор, этап Human / Merge.

## ADR-014: сначала extension-only, write API позже

- Решение: MVP создаёт и управляет child tasks через autosk CLI из ctx.exec с идемпотентным run_id. Кроме create/metadata/enroll/block используются точечный unblock, обратный block и resume --to для единственного автоматического случая anchor repair. Добавление TasksAPI write methods оформить отдельным upstream ticket после измерений.
- Альтернатива: менять core до первого end-to-end proof.
- Обоснование: CLI предоставляет нужные операции; preflight подтверждает их на временных задачах до запуска workflow. Ранний core patch расширит scope до доказательства необходимости.
- Источники:
  - daemon/sdk/src/agent.ts, read-only TasksAPI;
  - docs/cli.md, create/block/unblock/metadata/enroll/resume --to;
  - daemon/core/src/engine/session.ts, commit текущего transit не отклоняется из-за вновь добавленного blocker.

## ADR-015: повторное ревью тем же логическим агентом

- Решение: каждая model-owned task имеет собственный session record общей схемы и общий absolute session directory под исходным projectRoot. Panel/contest/narrow берут seat session, code review — отдельный review session по reviewer family, Arena — раздельные candidate/Judge sessions. Author session никогда не копируется reviewer. Оба поля передаются Pi как session-id/session-dir. Full re-panel возобновляет четыре seat sessions, narrow re-review — Lead, contest — originating seats.
- Альтернатива: каждый раунд запускать полностью нового агента без истории либо держать один бесконечный autosk task.
- Обоснование: прежний reviewer помнит собственные findings и не переоткрывает весь scope; новые task IDs сохраняют blockers, аудит и независимое завершение раундов. Replacement создаётся только при недоступности, повреждении session или обязательной смене роли и явно записывает replaces.
- Источники:
  - Traycer Handoff rules: повторное обращение к тому же child после final reply;
  - Pi session-id/resume surface;
  - autosk session/task separation.

## Оставшиеся риски, не решения

1. Read-only сейчас обнаруживается post-check, а не гарантируется permissions. Каждый reviewer уже изолирован отдельным child task и pinned worktree; если реальные writes повторятся, добавить container read-only mount отдельным этапом.
2. child-task orchestration через несколько CLI-операций не транзакционно. Идемпотентность и crash-matrix обязательны; create/block/enroll выполняются только AgentDefinition steps, write API рассматривается после MVP.
3. Pi auth check не понимает custom Cursor/Claude provider state. Готовность этих маршрутов подтверждается только live synthetic calls.
4. autosk не замораживает workflow graph. Protocol bytes будут pinned; исчезновение workflow/step корректно паркует task в human, но полная graph snapshot остаётся возможным будущим core enhancement.
5. Obsidian architecture vault не был доступен в текущей сессии. Перед публикацией архитектуры в vault потребуется отдельная сверка через Obsidian MCP.
