# Архитектура

## 1. Основной принцип

autosk v2 остаётся движком задач и переходов. Новая логика живёт в расширении traycer-flow. Мы не создаём второй daemon, вторую базу или универсальный язык workflow.

Расширение использует существующие механизмы:

- TypeScript workflows и AgentDefinition;
- onTransit как единственную точку разрешения переходов;
- task metadata, blockers, comments и session transcripts;
- глобальный worker pool;
- piAgent и настроенные Pi-провайдеры;
- worktreeSandbox для обычного implementation workspace, OID-pinned sandbox helper для review/Arena и sandboxCleanupStep с явной force-policy;
- ctx.exec для детерминированных Git-команд и autosk CLI.

## 2. Границы ответственности

### autoskd

Без изменений отвечает за:

- хранение task.json, comments и sessions;
- статусы new, work, human, done и cancel;
- одну живую сессию на задачу;
- blockers и планирование только незаблокированных work-задач;
- атомарный переход после onTransit;
- счётчики step_visits;
- загрузку расширений и диагностику.

### traycer-flow extension

Отвечает за:

- классификацию Quick/Planned;
- последовательность плановых артефактов;
- создание дочерних задач панели, Arena и Tickets;
- компиляцию сообщений из замороженного протокола;
- проверку structured verdict;
- атомарную запись artifact PASS и механическое извлечение autosk-arena block;
- привязку PASS к hash/OID;
- лимиты раундов и human escalation;
- freeze, commit-on-pass и вызов интеграционного адаптера.

### Pi-провайдеры

Выполняют только модельные роли. Они не определяют состояние workflow напрямую: агент обязан записать структурированный результат и запросить один разрешённый переход.

### Git

Хранит нормативные артефакты и код. Git object database даёт tree/commit OID для неизменяемой идентичности. Branch name никогда не считается идентичностью.

### traycer-protocol

Сохраняется как проверенный детерминированный механизм интеграции. Расширение вычисляет входы и обрабатывает классифицированный результат, но не переписывает его CAS/reflog-логику на TypeScript в первой версии.

## 3. Почему панель — дочерние задачи

Одна workflow-задача autosk запускает только одну сессию за раз, поэтому параллельная панель строится на нативном графе задач:

~~~text
parent: dispatch_panel
  -> create gpt seat task
  -> create grok seat task
  -> create kimi seat task
  -> create opus seat task
  -> block parent by all four
  -> transit parent to panel_join

worker pool:
  gpt seat  ─┐
  grok seat ─┤
  kimi seat ─┼─> done + valid verdict -> parent join
  opus seat ─┘

parent: panel_join -> synthesis
~~~

Преимущества:

- четыре отдельных task IDs и session IDs;
- независимые контексты и transcripts;
- панель видна и восстанавливается после перезапуска;
- штатный worker pool по умолчанию имеет четыре места;
- parent не опрашивает состояние в цикле: blockers сами открывают fan-in.

SDK пока предоставляет TasksAPI только для чтения. MVP создаёт и связывает дочерние задачи через ctx.exec с autosk CLI. Операция делается идемпотентной через panel_run_id и детерминированные названия мест. Добавление write-методов в TasksAPI полезно как отдельное upstream-улучшение, но не блокирует MVP.

Параллельность не является гарантией correctness: worker pool глобальный и настраиваемый. Preflight рекомендует workers >= 4 и сообщает конкурирующую нагрузку; при меньшем значении места выполнятся последовательно, но gate останется тем же.

## 4. Идемпотентный fan-out

Порядок dispatch выбран так, чтобы сбой не оставил невосстановимую блокировку:

1. parent фиксирует run_id и artifact identity;
2. для каждого места ищет существующую задачу с тем же parent/run/seat;
3. при отсутствии создаёт new-задачу;
4. записывает metadata и готовит snapshot branch/worktree;
5. enroll каждого полностью настроенного child;
6. только после готовности всех children добавляет blockers parent;
7. parent переходит в join.

После сбоя повторный dispatch находит созданные задачи и не дублирует их. Если сбой произошёл после добавления blockers, уже enrolled children завершаются, parent разблокируется и заканчивает недостающие действия.

## 5. Хранение

### Нормативная правда в Git

~~~text
docs/autosk/epics/<epic-id>/
  brief.md
  core-flow.md
  tech-plan.md
  decision-log.md
  decisions/
    ADR-001-<slug>.md
  tickets/
    T01-<slug>.md
    T02-<slug>.md
~~~

Создаются только нужные файлы. Статусы выполнения и PASS в эти документы не записываются: это предотвратит рассинхронизацию нормативных текстов с autosk.

### Операционная правда в autosk

Используются существующие:

~~~text
.autosk/tasks/<task-id>/task.json
.autosk/tasks/<task-id>/comments.jsonl
.autosk/sessions/<session-id>.json
.autosk/sessions/<session-id>.jsonl
~~~

Дополнительный ledger или run-manifest не создаётся. Машиночитаемая связь хранится в namespaced metadata.traycer, а человекочитаемая сводка и ссылки на доказательства — в comments.

### Замороженный протокол

Глобальное расширение содержит канонический protocol bundle. При старте epic daemon-side AgentDefinition разрешает исходный ctx.projectRoot и копирует нужные байты в:

~~~text
<absolute-project-root>/.autosk/traycer-flow/protocol-snapshots/<sha256>/
~~~

В metadata записываются hash и абсолютный canonical path. Prompt compiler читает его через ctx.projectRoot до запуска sandboxed Pi; он никогда не резолвит snapshot относительно reviewer worktree. Все последующие сообщения этого epic собираются только из snapshot. Обновление глобального расширения не меняет уже начатый процесс.

### Доказательства

~~~text
<absolute-project-root>/.autosk-evidence/<epic-id>/<task-id>/<round>/<agent>/
~~~

Каталог игнорируется Git по умолчанию и содержит только созданные проверками логи, screenshots и verdict records. В metadata хранится абсолютный canonical path и hash каждого принятого verdict/evidence record. Sandbox cwd для разрешения evidence path не используется. Сырые ответы модели остаются в session transcript.

### Состояние интеграции

Файл состояния команды integrate-approved обязан лежать вне репозитория и всех worktree:

~~~text
~/.autosk/traycer-flow/integration-state/<project-slug>/<operation-id>.json
~~~

## 6. Компилятор сообщений

Пользователь и координатор не копируют протокол вручную. Для каждого запуска расширение собирает PromptEnvelope:

~~~text
pinned common protocol
+ role contract
+ stage contract
+ current user instructions and accepted corrections
+ decision-log extract
+ relevant planning artifacts
+ scope identity / artifact identity
+ known operational facts
+ allowed transitions
+ exact response schema
~~~

Для панели common protocol, anchor pack, artifact bytes и scale byte-identical. Отличаются только role contract и model route.

Небольшой resolvedPiAgent wrapper строит firstMessage во время onRun, затем делегирует штатному piAgent. Это позволяет выбрать модель и snapshot из task metadata без копирования pi-agent driver и без изменения autoskd.

## 7. Идентичность

### Плановый артефакт

~~~text
artifact identity =
  epic id
  + artifact kind
  + base commit OID
  + declared pathspec
  + candidate tree OID
  + artifact sha256 set
  + anchor version
  + protocol hash
  + attempt
~~~

### Кодовый кандидат

~~~text
candidate identity =
  ticket id
  + base commit OID
  + declared pathspec
  + candidate tree OID
  + anchor version
  + attempt
~~~

### Verdict

~~~text
verdict binding =
  candidate/artifact identity
  + reviewer task id
  + reviewer session id
  + reviewer family
  + verdict record hash
~~~

Перед commit и integration identity вычисляется заново. Совпадение текста комментария PASS без этих полей ничего не разрешает.

## 8. Worktree identity и read-only review

Штатный worktreeSandbox ключуется только projectRoot + taskId и сам создаёт новую ветку от текущего состояния репозитория. Он не умеет выбирать base OID или snapshot commit, поэтому сам по себе не обеспечивает нужную identity.

Расширение добавляет структурно совместимый pinnedWorktreeSandbox:

- implementation workspace создаётся от записанного base OID;
- каждый reviewer и Arena candidate получает отдельный child task ID;
- review workspace имеет путь, зависящий от role, attempt и snapshot commit;
- git worktree add получает точный commit OID, а не текущий HEAD;
- существующая ветка/path переиспользуется только после проверки source commit.

Текущий autosk не обеспечивает права «только чтение» на уровне engine. Поэтому защита состоит из двух слоёв:

1. reviewer child task получает отдельный pinned worktree, созданный из snapshot commit точного tree OID;
2. до и после сессии детерминированный шаг сравнивает HEAD, tree, status и untracked set.

Любая запись превращает результат в blocking non-verdict. На первом этапе это обнаружение, а не абсолютное предотвращение; контейнерный read-only mount можно добавить позже только если измерения покажут необходимость.

## 9. Модели

Целевые Pi route specs:

| Роль | Route |
| --- | --- |
| GPT critique/review | openai-codex/gpt-5.6-sol:max |
| Opus coordination/architecture | pi-claude-code-provider/opus:max |
| Grok implementation/feasibility | cursor/cursor-grok-4.6:xhigh |
| Kimi intent/scope | cursor/kimi-k3:max |

Перед каждым epic preflight проверяет наличие exact route и делает короткий синтетический вызов без приватного кода. Наличие модели в каталоге не считается доказательством готовой авторизации.

## 10. Что сознательно не строится

- отдельный daemon поверх autoskd;
- отдельная БД или копия task status;
- скрытый универсальный workflow DSL;
- обязательная Arena для каждого решения;
- четырёхмодельная проверка каждого code diff;
- автоматическое редактирование refs моделью;
- cost dashboard и метрики ради метрик;
- постоянная глобальная память модели;
- ручное дублирование всего протокола в каждом comment;
- миграция autosk v0.1.6.
