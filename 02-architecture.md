# Архитектура

## 1. Основной принцип

autosk v2 остаётся движком задач и переходов. Новая логика живёт в расширении autosk-flow. Мы не создаём второй daemon, вторую базу или универсальный язык workflow.

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

### autosk-flow extension

Отвечает за:

- классификацию Quick/Planned;
- последовательность плановых артефактов;
- создание дочерних задач панели, Arena и Tickets;
- компиляцию сообщений из замороженного протокола;
- проверку structured verdict;
- атомарную запись artifact PASS и механическое извлечение autosk-arena block;
- привязку PASS к hash/OID;
- лимиты раундов и human escalation;
- собственные Ticket workflows: implement, verify, freeze, review, fix, commit и integration;
- freeze, commit-on-pass и собственный детерминированный интеграционный адаптер.

`devflow` не входит в архитектуру. Расширение не импортирует, не вызывает и не отслеживает авторский workflow autosk; все нужные Ticket-стадии принадлежат `autosk-flow`.

### Pi-провайдеры

Выполняют только модельные роли. Author/implementer использует обычный разрешённый переход. Gate-роли не меняют workflow или task store напрямую: они возвращают structured result через единственный host-mediated `submit_gate_result`; driver записывает и перечитывает immutable record, после чего deterministic validator выполняет разрешённый переход.

### Git

Хранит нормативные артефакты и код. Git object database даёт tree/commit OID для неизменяемой идентичности. Branch name никогда не считается идентичностью.

### autosk-owned integration adapter

CAS/reflog-механика `integrate-approved` переносится вместе с тестами в пакет `autosk-flow` и вызывается как собственный executable/module. Исходная Traycer-команда используется только для миграционного сравнения. Runtime не обращается к `traycer-protocol`, `~/.traycer`, Traycer skills или Traycer sessions.

### Глобальное и проектное владение

Глобально устанавливаются только:

- исполняемый код расширения;
- схемы и provider defaults;
- автономный read-only governance bundle с manifest и digest.

Каждый canonical project root отдельно владеет:

- project policy metadata и user decisions;
- Brief, Core Flow, Tech Plan, Decision Log и Tickets;
- task metadata, blockers, comments и sessions;
- provider session directory;
- protocol snapshots и per-Epic lock;
- materialized PromptEnvelope/cache, если он сохраняется вне session transcript;
- worktree, evidence и integration recovery state.

Глобальный пакет никогда не записывает внутрь себя проектные данные. Проект A не может ссылаться на task/session/evidence path проекта B; cross-project blocker и cross-project PASS binding запрещены.

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

SDK пока предоставляет TasksAPI только для чтения. MVP создаёт и связывает дочерние задачи через ctx.exec с autosk CLI. Но текущий create не умеет атомарно сохранить неизменяемую identity: title, description и обычная metadata редактируемы. Поэтому MVP имеет один обязательный upstream prerequisite — optional daemon-owned `creation_key` в task.create/CLI. Полный write API остаётся отдельным улучшением и MVP не блокирует.

Параллельность не является гарантией correctness: worker pool глобальный и настраиваемый. Preflight рекомендует workers >= 4 и сообщает конкурирующую нагрузку; при меньшем значении места выполнятся последовательно, но gate останется тем же.

При нескольких активных проектах global FIFO не обещает равную latency: панель одного проекта может временно занять все worker slots. Это не разрешает cross-project state и не меняет gates. Preflight показывает общий worker budget и активные проекты; отдельный fairness/admission слой добавляется только при доказанном starvation.

## 4. Идемпотентный fan-out

Порядок dispatch выбран так, чтобы сбой не оставил невосстановимую блокировку:

1. parent фиксирует run_id, artifact identity и deterministic `creation_key = autosk-flow/v1/<project-hash>/<parent>/<run>/<seat-or-type>`;
2. для каждого места ищет ровно одну existing new-задачу по daemon-owned creation_key, не по title/description или human-editable metadata;
3. при отсутствии вызывает `autosk create --creation-key <key>` без workflow; daemon под project-level creation-key lock либо атомарно пишет key вместе с новой task, либо возвращает уже существующую task с тем же key;
4. записывает обычную metadata и готовит snapshot branch/worktree; key collision с другим immutable creation binding либо несогласованный partial child паркуют dispatch для явного recovery;
5. enroll каждого полностью настроенного child;
6. только после готовности всех children добавляет blockers parent;
7. parent переходит в join.

`creation_key` — write-once engine field, включённый в TaskView и защищённый от внешней reconcile-правки. Под одним canonical project root daemon обеспечивает его уникальность без второго ledger: create выполняет поиск/запись под project-level key lock. После сбоя retry находит задачу даже если её переименовали до metadata set. Child никогда не enroll до полной проверки metadata/session/sandbox. Recovery sweep может закрыть только собственную `new`-задачу с валидным creation_key; произвольную task без key он не трогает. Если primitive отсутствует, preflight останавливает autosk-flow до создания реальных задач; fallback на title/description запрещён.

## 5. Хранение

### Нормативная правда в Git

~~~text
<canonical-project-root>/
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

Если параллельно идут разные проекты, все документы и файлы конкретного проекта размещаются только внутри canonical `ctx.projectRoot` этого проекта. Проектные факты и решения фиксируются в Epics/Decision Logs либо user instructions; отдельного governance override слоя нет.

### Операционная правда в autosk

Используются существующие:

~~~text
<canonical-project-root>/.autosk/tasks/<task-id>/task.json
<canonical-project-root>/.autosk/tasks/<task-id>/comments.jsonl
<canonical-project-root>/.autosk/sessions/<session-id>.json
<canonical-project-root>/.autosk/sessions/<session-id>.jsonl
<canonical-project-root>/.autosk/autosk-flow/provider-sessions/
<canonical-project-root>/.autosk/autosk-flow/epics/<epic-id>/protocol.lock.json
~~~

Дополнительный status-ledger не создаётся. `bundle-manifest.json` описывает immutable governance bytes, а `protocol.lock.json` только связывает Epic с digest snapshot; они не дублируют task status. Машиночитаемая связь хранится в namespaced metadata.autosk_flow, а человекочитаемая сводка и ссылки на доказательства — в comments.

### Автономный governance bundle

Публичный пакет содержит только очищенную autosk-native версию:

~~~text
resources/governance/bundles/autosk-v1/
  agent-selection-guide.md
  protocol/
    principles-digest.md
    playbooks/
      feature.md
      bug-fix.md
      refactoring.md
      perf.md
    arena/
      arena-stage.md
      judge-brief.md
    verification/template.md
    autobuild/run-contract.md
    reflect/reviewer-brief.md
    writing/
      technical-writing.md
      unslop.md
  bundle-manifest.json
  bundle-attestation.json
~~~

Это один Guide и точные 12 protocol files. Canonical content digest считается как SHA-256 от domain separator, bundle id/version/provenance и ordered `{relative_path, file_sha256}` для этих 13 файлов; поля `contentDigest` и attestation в собственный preimage не входят. Manifest записывает получившийся digest, а его exact bytes получают отдельный manifest hash. `bundle-attestation.json` связывает четыре panel verdict hashes с уже неизменяемым content digest; запись PASS не меняет проверенную content identity. Активные тексты используют только autosk-native commands, roles и paths. Exact Traycer baseline остаётся локальным миграционным входом, не коммитится в публичный Git и никогда не читается runtime.

### Замороженный protocol snapshot

При старте Epic daemon-side AgentDefinition проверяет manifest/digest активного bundle и копирует exact bundle bytes в проект:

~~~text
<absolute-project-root>/.autosk/autosk-flow/protocol-snapshots/<sha256>/
  agent-selection-guide.md
  protocol/
  bundle-manifest.json
  bundle-attestation.json
~~~

`protocol.lock.json` записывает bundle id/version/content digest, detached attestation hash, snapshot path и SHA-256 каждого из 13 нормативных файлов. Перед каждым prompt compile, dispatch и resume расширение заново проверяет snapshot bytes, manifest, attestation и project-root binding именно против этого Epic lock. Несовпадение fail-closed паркует задачу с `protocol_lock_invalid`; repair разрешён только из content-addressed digest, указанного в lock, без подстановки current/latest bundle. Prompt compiler читает только уже проверенный project-owned snapshot через canonical ctx.projectRoot. Обновление расширения или работа соседнего проекта не меняют уже начатый Epic.

Installer/cache хранит bundle versions content-addressed по digest, пока существует хотя бы один project lock на эту версию. Garbage collection сначала инвентаризирует locks всех зарегистрированных roots и не удаляет referenced digest; это позволяет repair повреждённого project snapshot без подстановки latest bundle.

### Доказательства

~~~text
<absolute-project-root>/.autosk-evidence/<epic-id>/<task-id>/<round>/<agent>/
~~~

Каталог игнорируется Git по умолчанию и содержит только созданные проверками логи, screenshots и verdict records. В metadata хранится абсолютный canonical path и hash каждого принятого verdict/evidence record. Sandbox cwd для разрешения evidence path не используется. Сырые ответы модели остаются в session transcript.

### Состояние интеграции

Файл состояния integrate-approved принадлежит проекту, но лежит в ignored runtime-каталоге canonical root, а не в рабочем worktree:

~~~text
<canonical-project-root>/.autosk/autosk-flow/integration-state/<operation-id>.json
~~~

State file хранит canonical root и отказывается продолжать операцию при несовпадении. Worktree никогда не выбирается источником project identity.

### Изоляция параллельных проектов

Каждый deterministic step получает project identity из canonical autoskd/ctx.projectRoot и выполняет fail-closed boundary check до первого и перед каждым fs/Git/CLI/RPC side effect; onTransit повторяет проверку только как defense-in-depth. Обязательные guards:

- child task и parent имеют один project identity;
- blocker не может ссылаться на task другого проекта;
- provider session directory и evidence path начинаются с canonical root текущего проекта;
- artifact/PASS binding включает project identity;
- project policy/user decisions другого root не попадают в PromptEnvelope текущего проекта;
- cross-project correlation — только opaque UUID для display/audit; он не резолвится в task/session/path другого root;
- cleanup удаляет только paths, записанные текущим project/task metadata;
- общий worker pool может менять порядок запуска, но не владение состоянием.

Project filesystem adapter отклоняет traversal/symlink/junction и использует no-follow/fd-relative create/delete. Лексический prefix не считается доказательством принадлежности. Внешний Git worktree cache допускается только под `~/.autosk/worktrees/<project_root_sha256>/` с explicit owner binding и `AUTOSK_CWD` исходного проекта.

Параллельность между проектами не требует общей папки документов или глобальной памяти. Общими могут быть только provider credentials, worker capacity и read-only installed bundle.

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

Первый model run создаёт session ID/dir и сохраняет exact absolute Pi session file из get_state. Follow-up в другом worktree открывает только этот file через `--session <path>`; ID + directory не считаются cwd-independent resume binding. Session file обязан находиться в provider-sessions текущего project root.

## 7. Идентичность

### Плановый артефакт

~~~text
artifact identity =
  project identity
  + epic id
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
  project identity
  + ticket id
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
- review workspace лежит в `~/.autosk/worktrees/<project_root_sha256>/...` и ключуется project hash + task ID + role + attempt + snapshot commit;
- git worktree add получает точный commit OID, а не текущий HEAD;
- существующая ветка/path переиспользуется только после проверки source commit.

Внешний worktree cache — физическое исключение из правила «под canonical root», потому что Git не допускает вложенный worktree внутри рабочего дерева. Он остаётся логически project-owned за счёт project_root_sha256, metadata owner и обязательного `AUTOSK_CWD=ctx.projectRoot` для autosk CLI.

Текущий autosk не обеспечивает OS-level read-only mount на уровне engine. Поэтому gate-роли получают только custom snapshot-rooted read tools и единственный host-mediated `submit_gate_result`; прямой transit, mutating builtin tools, `autosk_task`, arbitrary comments и shell отключены. Submit tool принимает только закрытую схему результата текущей task и сам ничего не пишет. Deterministic tail GateAgent AgentDefinition повторно проверяет project boundary перед записью и каждым fs/RPC side effect, host-side записывает/read-back immutable record и лишь затем передаёт управление validator. Дополнительно:

1. reviewer child task получает отдельный pinned worktree, созданный из snapshot commit точного tree OID;
2. до и после сессии детерминированный шаг сравнивает HEAD, tree, status/untracked set и parent/sibling store hashes.

Любая неожиданная запись превращает результат в blocking non-verdict. Ограниченный набор capabilities предотвращает известные пути записи, а pre/post hashes остаются защитой от ошибки driver; контейнерный read-only mount можно добавить позже только если измерения покажут необходимость.

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
- Obsidian MCP и `architecture-planning` как обязательный/опциональный gate или источник runtime-контекста;
- devflow как dependency, child workflow или fallback;
- runtime-доступ к Traycer, `~/.traycer`, Traycer skills или `traycer_*` commands;
- общая для нескольких проектов папка документов, sessions, evidence или integration state;
- миграция autosk v0.1.6.
