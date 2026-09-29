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

В целевой pinned версии, после обязательных upstream sets ADR-014, ADR-023 и ADR-025, отвечает за:

- хранение task.json, comments и sessions;
- статусы new, work, human, done и cancel;
- одну живую сессию на задачу;
- blockers и планирование только незаблокированных work-задач;
- атомарный переход после onTransit;
- daemon-attributed append-only `UserDecisionRecord` с project/identity binding и actor provenance;
- trusted-client capability для записи пользовательских решений, не наследуемую model/extension subprocess;
- protected authority/dependency/intent/metadata/result heads, step-capability metadata CAS и gate-result receipts;
- счётчики step_visits;
- загрузку расширений и диагностику.

### autosk-flow extension

Отвечает за:

- классификацию Quick/Planned;
- последовательность плановых артефактов;
- подготовку human alignment/readiness packets и механическую проверку их approval identity;
- versioned fail-closed классификацию decision classes и разрешение только daemon-attributed user/policy records;
- создание дочерних задач панели, Arena и Tickets;
- schema/semantic validation canonical Tickets manifest, deterministic rendering human views и manifest-only reconstruction Ticket DAG;
- компиляцию сообщений из замороженного протокола;
- проверку structured verdict;
- запись валидированного artifact verdict как `recorded_unpublished` и механическое извлечение autosk-arena block;
- host-owned и crash-safe публикацию approved artifact commit в private Epic planning ref;
- привязку PASS к hash/OID и verified planning-head CAS receipt;
- лимиты раундов и human escalation;
- собственные Ticket workflows: implement, verify, freeze, review, fix, commit и integration;
- freeze, commit-on-pass и собственный детерминированный интеграционный адаптер.

`devflow` не входит в архитектуру. Расширение не импортирует, не вызывает и не отслеживает авторский workflow autosk; все нужные Ticket-стадии принадлежат `autosk-flow`.

### Pi-провайдеры

Выполняют только модельные роли. WorkAgent author/implementer возвращает submit_work_result, а переход/metadata CAS выполняет host с ADR-025 capability; model session не получает `.autosk`/CLI/decision capability. Gate-роли возвращают submit_gate_result, host append'ит daemon receipt и validator transits.

Закреплённая серия этого пока не обеспечивает, и это названо, а не скрыто. `autoskEnv` расширений `claude-agent` и `pi-agent` (патч `0028`) кладёт в окружение процесса модели `AUTOSK_SESSION_TOKEN` — учётные данные, которые принимает `task.create_bound`; factory пишет листья, по которым допускается resume (`park.reason`, `park.origin`, `park.receipts.<step>`), обычным `autosk metadata set`, а его может выполнить любой держатель CLI. Убрать токен из окружения модели — обязательство #11, писать листья resume только под step-capability metadata CAS — обязательство #18 (матрица v1, ADR-097); изменение отслеживает roadmap-задача #231.

Процесс модели работает не под учётной записью пользователя. Каждый процесс, который autoskd запускает для шага модели, работает под отдельной непривилегированной учётной записью `autosk-model`: её создаёт привилегированная установка, autoskd запускает процесс под ней механизмом, который эта установка настраивает (правило sudoers только для закреплённых runtime моделей или unit менеджера служб, но не setuid-бинарник проекта), механизм же завершает дерево её процессов целиком, потому что autoskd не может послать сигнал процессу другой uid; она пишет только файлы своего worktree и собственный каталог сессии вне `.autosk` — сессию провайдера, `HOME` и конфигурацию (§6), — ни одного Git-каталога проекта, не достаёт signer, secure store, keychain пользователя и токен RPC autoskd и не держит capability демона (`docs/contracts/platform-support.md` §5b, ADR-102). Закреплённая серия запускает процессы модели детьми autoskd под его uid, и ни один патч uid не сбрасывает. Учётную запись и механизм запуска несёт #13, окружение процесса модели — #11, путь запуска — #18; проверка `security.model_account` блокирует каждый model workflow, пока нет зонда #13.

### Git

Хранит нормативные артефакты и код. Git object database даёт tree/commit OID для неизменяемой идентичности. Branch name никогда не считается идентичностью.

Каждый Planned Epic владеет private append-only ref `refs/autosk/epics/<epic_ref_key>/planning`. Key — domain-separated SHA-256 canonical `{project_root_sha256,epic_id}`, в шестнадцатеричном нижнем регистре; имя ref'а сравнивается побайтово в expected-old CAS, поэтому кодировка входит в определение, а не остаётся соглашением о записи. Его verified head — единственная текущая Git-проекция принятых planning artifacts. До publication каждый frozen candidate владеет `refs/autosk/epics/<epic_ref_key>/candidates/<candidate_identity>`. Deterministic host adapter только формирует и авторизует exact requests; sole writer ref-custody helper выполняет каждый create/CAS/delete для `refs/autosk/**` и `logs/refs/autosk/**`. Target branch и чужие Epic refs не затрагиваются. Это одно правило и для staging ref Epic `refs/autosk/epics/<epic_ref_key>/staging` (`docs/contracts/epic-staging.md`): ref-custody helper пишет каждый ref под `refs/autosk/**`, включая staging ref; host только просит его, а target ref двигает только daemon `integrateApproved`. У staging ref три действия закрытого протокола helper — `create_staging`, `advance_staging`, `delete_staging`; host-драйверы (`createStaging`, `applyDelta`, `cleanupStaging`, `advanceRef` planning) формируют запрос через `askCustody` (`src/host/ref-custody.mjs`) и сами `update-ref` не выполняют; без helper запрос отвергается `planning_ref_capability_missing` (ADR-095).

Enforceable boundary: the canonical project common Git directory is the single object/ref database for target, planning, candidate, audit and staging refs; it is not a second repository, and it is the installing user's ordinary repository (ADR-102). Each worktree keeps its own `HEAD`, index and worktree state in its own per-worktree Git directory under the common one, behind its gitfile and `commondir` link. The model account `autosk-model` cannot open either Git directory, for reads or for writes, or invoke Git mutations: every model process runs under it (`docs/contracts/platform-support.md` §5b), and the bootstrap closes the Git directory to every other account. The installing user's account writes objects, ordinary refs and each worktree's `HEAD` and index: autoskd runs in it and mediates ordinary project Git operations, and so does the user, who is the principal. The ref-custody helper, a process of the installing user, is the sole writer of `refs/autosk/**` and their reflogs by protocol: the OS keeps the model account off them, and what keeps the installing user's own tools off them is detection — every helper action is an expected-old CAS under its journal, a protected ref moved outside it parks rather than being overwritten, and a protected entry in `packed-refs` is refused by its preflight (§5a). The OS does not keep the principal off the target ref either: a move of it by anything but the daemon's `integrateApproved` is foreign movement, detected at the CAS (ADR-099, ADR-102). Linux/macOS bootstrap proves the pins and peer credentials; unsupported layouts fail before workflow effects. The helper, its non-privileged bootstrap and who may then write the project's `.git` are the install record `ref_custody_service` of `docs/contracts/platform-support.md` §5a, owned by #13 with #5, and the model account is the install record `model_account` of §5b, owned by #13 with #11 and #18. The ref-custody policy's schema admits this profile — the helper as the installing user, the Git directory the user's at mode `0700`, the probes' `project-account` the model account — beside its committed example, which predates ADR-102 and changes only when #5 signs the goldens it binds again (§5a). A project without a proven helper and pins parks `ref_custody_unavailable` at project open.

Issue #5 owns the packaged `autosk-flow-ref-custody` component (`src/git/ref-custody-helper.ts`, client and closed protocol). Its Unix socket accepts only the daemon capability. Before every socket call, autoskd atomically persists one helper intent with action/operation, request ID, nonce, body hash, topology and a fsynced under-lock pre-execution observation. Retry looks up that intent and journal rather than minting a second request: the host's request carries the asking operation's `owner_operation_id` and `request_id`, the same pair on a retry, and the intent is found by it (ADR-108). Live-to-audit custody is monotonic: create/verify and fsync/read-back audit while live remains, record `audit_ref_verified`, then separately delete live by expected-old, record `live_ref_deleted`, and final-verify audit-present/live-absent. Candidate closure is protected by a helper-owned quarantine pack until a canonical live or audit ref is verified.

Files-backend packing is closed inside that single common Git directory. Maintenance and GC — the installing user's own `git gc` among them — see the same object database as planning refs, so verified planning/live/audit refs retain their closures. Protected refs remain loose with `gc.packRefs=false`, which the bootstrap pins; a protected entry the user's `git pack-refs --all` writes anyway is refused by the helper's preflight (`packed_refs_drift`, `docs/contracts/platform-support.md` §5a), and the model account runs no maintenance, having no access to the Git directory.

### Planning publication adapter

<!-- planning-ref-contract:v1 -->

Общий adapter обслуживает `init_planning_ref`, `publish_artifact_pass` и `publish_planning_invalidation`. До side effect он сохраняет и read-back проверяет полный object-format-aware recipe с exact commit bytes, expected OID, signing-policy binding и reflog checkpoint. Затем пишет только эти bytes, выполняет expected-old CAS private ref с operation-specific reflog entry, читает ref/commit/tree/reflog обратно и монотонно продвигает `planning_publication_op` через `prepared -> commit_created -> ref_advanced -> verified` либо terminal `voided_before_ref`. Model process не получает ref capability. Foreign/ABA/indeterminate movement не ретраится как обычная ошибка и не разрешается rebase/reset/force fallback.

### Canonical Tickets manifest

<!-- tickets-manifest-contract:v1 -->

Комплект Tickets является одним behavior artifact с двумя представлениями: canonical `tickets.manifest.json` и deterministic Markdown views. Manifest — единственный scheduler/dispatcher input; views служат человеку и входят в тот же frozen candidate. `TicketsValidationReceipt` связывает schema/canonicalizer/renderer/validator identities, exact planning parent/candidate tree, set/DAG/entry/document digests и controlling locks. Receipt хранится как autoskd/evidence-owned immutable record, не как второй status ledger.

Перед Ticket Panel host-only pre-freeze `validateTicketsCandidateTree` без следования symlink ancestors сначала проверяет raw manifest, nesting depth и closed Schema, а только затем перечисляет внешнюю file inventory с host-owned entry/per-file/aggregate pre-read caps; он выдаёт schema-valid `record_kind=pending_validation_proof` с `candidate_tree_oid=null` и не является authority. Deterministic validator fail-closed останавливается на Schema-invalid nested shapes до graph/renderer/inventory, проверяет canonical bytes, declared limits, heap-backed stable Kahn DAG, indexed output-sensitive case-collision path-scope overlap/order with bounded pair count and precomputed reachability, governing/evidence refs, exact previous-manifest context для revision lineage и byte-identical injection-safe renderer output whose headings and free-text body insertions are one-line normalized. После вычисления frozen tree `freeze_artifact` вызывает authoritative `validateTicketsCandidateGitTree`, который читает blobs напрямую из immutable Git tree по OID, повторяет validation и создаёт внешний host-owned `record_kind=final_validation_receipt`, где `candidate_tree_oid` равен frozen tree; mutable pathname не может породить final receipt. После verified issue #5 publication manifest-only dispatcher читает bytes из exact publication commit tree, а не live worktree, затем создаёт expected child/edge graph через daemon custody. Markdown disagreement блокирует до новой candidate identity; runtime никогда не выбирает prose.

### autosk-owned integration adapter

CAS/reflog-механика `integrate-approved` переносится вместе с тестами в пакет `autosk-flow` и вызывается как собственный executable/module. Target ref Epic и Quick двигает только daemon `integrateApproved`, вызывая эту механику под project mutex; host-функция `swapTarget` — сама expected-old CAS-механика, и в host у неё нет вызывающих: приватный staging ref двигает ref-custody helper по запросу `applyDelta` (ADR-088, ADR-095). Исходная Traycer-команда используется только для миграционного сравнения. Runtime не обращается к `traycer-protocol`, `~/.traycer`, Traycer skills или Traycer sessions.

Какие из этих операций вообще разрешены в конкретном репозитории, решает delivery profile, зафиксированный до первого implementation dispatch (ADR-030, issue #17). Локальный CAS над target ref — не умолчание: проект может требовать pull request, merge queue, подписанные коммиты или DCO, и это выясняется до того, как появятся approved commits, а не при первом отказанном push. Неподдерживаемый режим останавливает Epic с decision packet, а не переключает доставку на скрытый запасной путь.

### Глобальное и проектное владение

Глобально устанавливаются только:

- исполняемый код расширения;
- схемы и provider defaults;
- автономный read-only governance bundle с manifest и digest.

Каждый canonical project root отдельно владеет:

- daemon-attributed user decision journal и единый project policy/revocation projection;
- Decision Log/policy mirrors;
- Brief, Core Flow, Tech Plan, Decision Log и Tickets;
- private per-Epic planning refs и reachable publication/invalidation commits;
- task metadata, blockers, comments и sessions;
- provider session directory;
- protocol snapshots и per-Epic lock;
- materialized PromptEnvelope/cache, если он сохраняется вне session transcript;
- worktree, evidence и integration recovery state.

Глобальный пакет никогда не записывает внутрь себя проектные данные. Проект A не может ссылаться на task/session/evidence path проекта B; cross-project blocker и cross-project PASS binding запрещены.

Единственное integrity-исключение к project root — daemon secure store с `{authority_head,dependency_head,intent_head,consumed_nonce_head,integration_authorization_head,metadata_head,result_head}` hashes/counters без decision/task payload. Workflow scope — Epic либо Quick; custody heads task-keyed. `integration_authorization_head` — один на проект и служит целостности (anti-rollback), а цепочка `IntegrationAuthorizationRecord` — по scope: `previous_scope_authorization_hash` называет предыдущую запись того же `scope_id`, и запись другого Epic или Quick-прогона эту не делает stale (`docs/contracts/integration-authorization.md` §5, ADR-103).

## 3. Почему панель — дочерние задачи

Одна workflow-задача autosk запускает только одну сессию за раз, поэтому параллельная панель строится на нативном графе задач:

~~~text
parent: dispatch_panel
  -> create lead seat task
  -> create feasibility seat task
  -> create intent seat task
  -> create architecture seat task
  -> block parent by all four
  -> transit parent to panel_join

worker pool:
  lead seat         ─┐
  feasibility seat  ─┤
  intent seat       ─┼─> done + valid verdict -> parent join
  architecture seat ─┘

parent: panel_join -> synthesis
~~~

На диаграмме места названы ролями (линзами) панели из 01 §3, а не моделями: маршрут и effort каждого места задаёт только `REQUIRED_PANEL` в `scripts/validate-provider-preflight.mjs`, а семью — `resources/panel-roster/family-partition.v1.json`; какая семья займёт место Lead, вычисляется по author/fixer set (01 §3).

Преимущества:

- четыре отдельных task IDs и session IDs;
- независимые контексты и transcripts;
- панель видна и восстанавливается после перезапуска;
- штатный worker pool по умолчанию имеет четыре места;
- parent не опрашивает состояние в цикле: blockers сами открывают fan-in.

Upstream autosk на закреплённом коммите не даёт three required surfaces сам по себе: creation identity ADR-014, signed authority/intent ADR-023 и workflow custody/receipts ADR-025. **Закреплённая серия патчей** `compat/autosk/patches/` поверх этого коммита поставляет из трёх только первую: атомарное создание задачи и creation binding (`0001`, `0028`), о которых демон сообщает как о capability `task.creation-binding` v2 (отчёт о capabilities — `0013`, ревизия 2 — `0028`). Кроме неё серия поставляет runtime snapshot store и admission по идентичности дистрибуции (`0002`, `0003`, `0005`, `0025`–`0027`, `0029`), подпись creation grant и адаптер записи артефактов (`0023`, `0030`), store-lock helper, его протокол и доверенную запись состояния (`0016`–`0022`, `0024`). ADR-023 и ADR-025 серия **не** поставляет: ни `UserDecisionRecord` journal с protected authority/dependency/intent/result heads и `authorityGuard`/`integrateApproved`, ни step-capability metadata CAS, `orchestrateChildBatch` и gate-result receipts нет ни в одном патче и ни в одном модуле этого репозитория. Нет и ref-custody helper из §2 (`src/git/ref-custody-helper.ts`): store-lock helper — другой процесс с другой задачей. Эти три поверхности — обязательства фазы реализации (#40), а не поставленные возможности. Кто их несёт в v1, записано в матрице (`preflight_primitives` в `resources/program-capabilities/matrix.v1.json`, ADR-092): демонскую сторону ADR-023 — signer, `UserDecisionRecord` journal и protected heads — несёт #4, `authorityGuard`/`integrateApproved` — #9, ADR-025 целиком — #18; эти три записи — `required_for_v1`, примитивы поставляются патчами `0052`+; ref-custody helper — #5. Typed SDK write API #38 остаётся `planned_after_v1`: он позже открывает те же гарантии через SDK, а v1 получает их через более узкие методы демона. Validator матрицы сверяет этот список в обе стороны с двумя наборами — `REQUIRED_DAEMON_CAPABILITIES` и `MODEL_STEP_CHECKS`; проверки фаз preflight — реализованные проверки хоста (#34), им владелец в этом списке не нужен. Доставляемая версия — это upstream **плюс** серия, и обе идентичности закрепляются вместе: `manifest.v1.json` фиксирует upstream commit и SHA-256 каждого патча, а clean-room воспроизводит из них ровно одно дерево.

MVP preflight по-прежнему запрещает любой model workflow, если хоть один primitive отсутствует в фактически загруженной сборке: наличие патча в серии — не то же самое, что его присутствие в том, что запущено. `REQUIRED_DAEMON_CAPABILITIES` (`src/host/daemon-preflight.mjs`) называет все три. Закреплён только `task.creation-binding` v2 с методом `task.create_bound`. У `authority.user-decision` (ADR-023) и `workflow.custody` (ADR-025) ещё нет ни ревизии, ни методов, и ни один отчёт демона их не удовлетворяет, поэтому до их спецификации preflight отказывает любому демону, в том числе собранному из серии, с `daemon_capability_missing`. Требование не параметризуется: вызывающий не может передать более узкий набор. Вызов preflight при загрузке расширения (`docs/contracts/creation-grant.md` §5), то есть до любого model launch и child create, — в матрице v1 место этого вызова — точка входа расширения #18, а функцию и то, что она проверяет, несёт #11 (ADR-097): точки входа расширения пока нет, и этот вызов не делает ни один путь запуска. Вне тестов `requireDaemonCapabilities` вызывает только проверка doctor `daemon.capabilities_pinned`: она отдаёт функции переданный ей отчёт `meta.capabilities` и сама ничего не решает; read-only doctor демон не спрашивает, поэтому на реальном хосте проверка `unverifiable`. Её, как и `security.signer_boundary`, требует каждый workflow, чей первый шаг достигает agent step (`MODEL_STEP_CHECKS`). General TasksAPI write surface остаётся отдельным улучшением.

Параллельность не является гарантией correctness: worker pool глобальный и настраиваемый. Preflight рекомендует workers >= 4 и сообщает конкурирующую нагрузку; при меньшем значении места выполнятся последовательно, но gate останется тем же.

При нескольких активных проектах global FIFO не обещает равную latency: панель одного проекта может временно занять все worker slots. Это не разрешает cross-project state и не меняет gates. Preflight показывает общий worker budget и активные проекты.

Взаимная блокировка при этом невозможна по построению, и это не наблюдение, а свойство: места панели — **листья**. Место не создаёт детей, не ждёт другого места и не удерживает slot между ответами; родитель ждёт мест, но сам slot при этом не занимает. Поэтому четыре места, занятые чужим проектом, задерживают панель, но не образуют цикла ожидания — исчерпание slot'ов даёт latency, а не deadlock. Гарантия сформулирована здесь, потому что «пул глобальный» без неё читается как liveness-риск.

Отдельный fairness/admission слой добавляется только при доказанном starvation: очередь честная по порядку поступления, и приоритет без наблюдаемого голодания — это политика, которую некому обосновать.

## 4. Идемпотентный fan-out

Порядок dispatch выбран так, чтобы сбой не оставил невосстановимую блокировку:

1. parent фиксирует run_id, artifact identity, deterministic `creation_key = autosk-flow/v1/<project-hash>/<parent>/<run>/<seat-or-type>` и SHA-256 canonical immutable creation binding (project/parent/run/type/artifact/session/workflow target);
2. для каждого места ищет ровно одну existing new-задачу по daemon-owned key+binding hash, не по title/description или human-editable metadata;
3. при отсутствии вызывает `autosk create --creation-key <key> --creation-binding-hash <sha256>` без workflow; daemon под project-level creation-key lock атомарно пишет оба поля вместе с task, возвращает existing только при совпадении обоих или отвечает conflict;
4. записывает обычную metadata и готовит snapshot branch/worktree; key collision с другим binding hash либо несогласованный partial child паркуют dispatch для явного recovery;
5. enroll каждого полностью настроенного child;
6. только после готовности всех children добавляет blockers parent;
7. parent переходит в join.

`creation_key` и `creation_binding_hash` — write-once engine fields. Daemon serializes key and rejects hash mismatch. Retry finds renamed new task. Child never enrolls before custody/session/sandbox validation. Если любой ADR-014/023/025 primitive отсутствует, preflight останавливает autosk-flow до model launch/child create; mutable fallback запрещён.

Activation surface подтверждён pinned `wierdbytes/autosk@5163f00`: `cmd/autosk/create.go` без `--workflow` оставляет task status=new, а `cmd/autosk/enroll.go` отдельно выполняет `enroll <id> --workflow NAME [--step STEP]` и переводит new в work. Preflight доказывает оба состояния до real fan-out.

## 5. Хранение

### Нормативная правда в Git

~~~text
<canonical-project-root>/
  docs/autosk/policies/
    <policy-id>.md
  docs/autosk/epics/<epic-id>/
    brief.md
    core-flow.md
    tech-plan.md
    decision-log.md
    decisions/
      ADR-001-<slug>.md
    tickets/
      tickets.manifest.json
      README.md
      T01-<slug>.md
      T02-<slug>.md
~~~

Текущая принятая проекция этих файлов определяется verified head `refs/autosk/epics/<epic_ref_key>/planning`. Каждый artifact PASS получает отдельный single-parent descendant commit; следующий author base обязан совпадать с этим head. Detached snapshot commit остаётся review identity, но не считается опубликованным; verified candidate keepalive делает его полную object closure reachable до planning-ref verification и exact-old release. Anchor invalidation создаёт новый descendant commit, а не rewrites history. Final Tickets publication фиксирует exact `planning_head` для downstream execution/staging. Published tree содержит validated canonical manifest и exact renderer outputs; task/runtime state в них отсутствует.

Создаются только нужные файлы. Статусы выполнения и PASS в эти документы не записываются: это предотвратит рассинхронизацию нормативных текстов с autosk.

Если параллельно идут разные проекты, все документы и файлы конкретного проекта размещаются только внутри canonical `ctx.projectRoot` этого проекта. `docs/autosk/policies` — человекочитаемое project-level зеркало issuance/revocation; Epic Decision Log зеркалит только Epic-scoped решения. Git bytes принимаются как нормативный текст лишь после hash-binding к daemon-attributed record и сами по себе не дают approval.

### Операционная правда в autosk

Целевое хранение использует существующий project store и два узких upstream record types для user authority/policy projection:

~~~text
<canonical-project-root>/.autosk/tasks/<task-id>/task.json
<canonical-project-root>/.autosk/tasks/<task-id>/comments.jsonl
<canonical-project-root>/.autosk/sessions/<session-id>.json
<canonical-project-root>/.autosk/sessions/<session-id>.jsonl
<canonical-project-root>/.autosk/user-decisions/<record-id>.json
<canonical-project-root>/.autosk/autosk-flow/alignment-policies/<policy-id>.json
<canonical-project-root>/.autosk/autosk-flow/authority-dependencies/<scope-id>.jsonl
<canonical-project-root>/.autosk/autosk-flow/intent-events/<scope-id>.jsonl
<canonical-project-root>/.autosk/autosk-flow/integration-authorizations/<scope-id>/<record-id>.json
<canonical-project-root>/.autosk/autosk-flow/gate-results/<child-task-id>.jsonl
<canonical-project-root>/.autosk/autosk-flow/provider-sessions/
<canonical-project-root>/.autosk/autosk-flow/epics/<epic-id>/protocol.lock.json
~~~

`planning_ref_init_op`, `candidate_keepalive_op`, `candidate_audit_transfer_op` и `planning_publication_op` живут в protected namespaced Epic metadata. Transfer operation сохраняется до первого helper call и содержит operation ID, phase, helper intent key, audit-ref/live-delete prefix receipts и final verification; crash between `audit_ref_verified` and `live_ref_deleted` resumes this exact record. Verified operations обновляют `planning.last_verified_reflog_tail`. Terminal records переходят в append-only containers: init — `planning.init_history`, released/audit-retained keepalive — `planning.candidate_history`, audit transfer — `planning.audit_transfer_history`, artifact/invalidation publication — `planning.publication_history`, rebuild — `planning.rebuild_history`. Git refs/objects remain source of truth; metadata binds them to workflow state.

Publication metadata retains the typed payload, immutable bindings, complete commit_recipe, exact commit bytes, expected commit OID, effective target and reflog checkpoint.

Дополнительный task/status-ledger не создаётся. Trusted client only displays/signs exact challenge. Production signer/secure store runs in separate OS security boundary (privileged helper/separate account or hardware enclave); the model sandbox — the model account `autosk-model` the privileged install creates (`docs/contracts/platform-support.md` §5b, #13) — is denied accessibility/ptrace/keychain. Deployment without a **declared** boundary, or headless/unpinned project, blocks model launch. What blocks is precise, and it is less than the word *enforceable* suggests: `security.signer_boundary` in `autosk-flow doctor` refuses an undeclared boundary, a declared endpoint that does not exist, and a failed probe, and a passing probe means only that the declared endpoint was refused to the probing process (`EACCES`/`EPERM`) and that the daemon reports a separate signing identity. No daemon of the series reports one — the pinned `meta.capabilities` names only `task.creation-binding`, and ADR-023's signer is not delivered — so on a real host the check never passes and blocks every model workflow; no operator variable stands in for the report (ADR-090). `workflow-preflight` requires it of every workflow in the graph's `workflows[]` whose first step reaches an agent step — all eight today, because every entry step is itself an agent step. Beside the boundary every such workflow requires `daemon.capabilities_pinned`, which hands the daemon's `meta.capabilities` report to `requireDaemonCapabilities`; the read-only doctor has no report, so on a real host that check is `unverifiable` (ADR-097); and `security.model_account`, which proves the model account and is `unverifiable` until #13's probe of it exists (ADR-102). The preflight's required sets have one caller outside tests, `autosk-flow doctor --workflow <name>` (through `requiredFor` and `readiness`); `preflight`, `admits` and `assertAdmits` have no product caller. The dispatch gate that holds a workflow to its set before any model launch is #34's in matrix v1, the `requireDaemonCapabilities` call at extension load is the extension entry point's (#18), and the function and what it checks are #11's (ADR-097); the gate's call before each model launch is the launch path's, #18's (ADR-102). Neither call has a call site yet, because the extension entry point does not exist. A passing signer check does not establish that no path exists. Only a platform attestation of process isolation — sandbox profile, entitlements, a seccomp/LSM profile — signed by something other than the daemon whose boundary it attests would establish that, and it is not here. See `01-core-flows.md` §2, which states the same limit; the two documents must not disagree about the strength of the one guarantee the whole user-authority chain rests on.

Daemon сохраняет canonical signed challenge bytes, append'ит signed record и CAS-обновляет rollback-resistant authority/nonce heads до публикации projection или workflow effect. Signature связывает project, record ID/raw nonce/expiry, request/Epic/task/anchor/subject/payload, previous head и exact next sequence. Recovery принимает journal-ahead только после byte-exact signature verification и head/nonce CAS; invalid tail не имел applied effects, quarantine'ится и не освобождает nonce. Project/Epic dependency journal имеет daemon-only `add|supersede` append и protected dependency head; normalized user instruction/correction append имеет protected intent head. Metadata — проверяемая projection этих journals. Store содержит только hashes/counters, не task status или payload, поэтому не является вторым ledger.

Project policy issuance/revocation используют signed UserDecisionRecords; trusted client policy bytes authority не получают. Autoskd derives the single projection after journal/head commit. Git/comments are mirrors. Model-to-signer/secure-state OS boundary is a mandatory preflight assertion rather than a residual same-UID assumption — and an assertion is what it is. The preflight refuses an undeclared or unprobeable boundary; it does not attest isolation, and the attestation that would is named as deferred rather than implied.

`IntegrationAuthorizationRecord` authoritative source is daemon-owned file above plus protected `integration_authorization_head`. The record is required for every Epic target CAS, and one mechanism makes it (ADR-088, ADR-096): the host composes it before the question from the staging identity — which binds the controlling anchor digest and the authority, dependency and intent heads — and from what the plan names (run, integration plan, classifier proof, the head of its scope's chain it chains from, expiry); the user's UserDecisionRecord signs its payload at the acceptance stop, v1's one acceptance authority — a pinned auto-policy is held to the same binding, under which it adds no autonomy, and no v1 graph edge reaches it; an unattended acceptance needs a different binding, #28's post-v1 design work (ADR-103); the verified decision completes it with its id and digest, and the acceptance names it by id and digest. The host composes and verifies; autoskd stores it and chains it within its scope, under one `integration_authorization_head` per project kept for integrity, and `integrateApproved` checks the heads it names against the ones in force, which the scope's own acceptance does not move (`docs/contracts/integration-authorization.md` §3, §5, ADR-103). Record identity binds scope, record ID, content hash, expiry, terminal revoke/replace disposition, authority/dependency/intent heads and integration plan. Restart lookup resolves by scope+record ID and reconciles file/head before use. Missing/changed/shortened record or head mismatch fail-closed — for Quick to `integration_authorization_required` at accept; for an Epic to `acceptance_missing` at accept_staging, or to `acceptance_stale` at integrate_staging when the record lapses before the CAS, resumed at accept_staging; recovery restores exact committed bytes only. `integration-state/<operation-id>.json` stores the CAS operation and its outcome only and never substitutes authorization authority; the target moves by one CAS, so there is no completed part of a plan to store.

`bundle-manifest.json` описывает immutable governance bytes, а `protocol.lock.json` только связывает Epic с digest snapshot; они не дублируют task status. Машиночитаемая workflow-связь остаётся в namespaced metadata.autosk_flow, а человекочитаемая сводка и ссылки на доказательства — в comments.

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

Это один Guide и точные 12 protocol files — **13 нормативных файлов**. Список этих файлов в репозитории один: `governance_files` реестра носителей `resources/stage-carriers/stage-carriers.v1.json` (ADR-093). `validate:stage-carriers` сверяет его с деревом выше, с деревом 03 §3 и с guide/protocol записями реестра паритета, `validate:governance-bundle` берёт из него обязательных членов, а CLI сборки (`scripts/governance-bundle.mjs`) — inventory, которому обязан совпасть manifest. `autobuild/run-contract.md` и `reflect/reviewer-brief.md` входят в bundle как неактивные bytes: `inactive_in_v1` (#28, #29), и ни один носитель v1 их не получает. Role и stage contracts из §6 и сам реестр носителей — ресурсы расширения, а не члены bundle: реестр закрепляет digest bundle и потому не может входить в его preimage. `bundle-manifest.json` и `bundle-attestation.json` в это число не входят: манифест записывает получившийся digest и потому не может входить в его собственный preimage, а attestation связывает вердикты с уже неизменяемой content identity. Canonical content digest считается как SHA-256 от domain separator, bundle id/version/provenance и ordered `{relative_path, file_sha256}` для этих 13 файлов; поля `contentDigest` и attestation в собственный preimage не входят. Manifest записывает получившийся digest, а его exact bytes получают отдельный manifest hash. `bundle-attestation.json` связывает четыре panel verdict hashes с уже неизменяемым content digest; запись PASS не меняет проверенную content identity. Активные тексты используют только autosk-native commands, roles и paths. Exact Traycer baseline остаётся локальным миграционным входом, не коммитится в публичный Git и никогда не читается runtime.

### Замороженный protocol snapshot

При старте Epic daemon-side AgentDefinition проверяет manifest/digest активного bundle и копирует exact bundle bytes в проект:

~~~text
<canonical-project-root>/.autosk/autosk-flow/protocol-snapshots/<sha256>/
  agent-selection-guide.md
  protocol/
  bundle-manifest.json
  bundle-attestation.json
~~~

`protocol.lock.json` записывает bundle id/version/content digest, detached attestation hash, snapshot path и SHA-256 каждого из тех же 13 нормативных файлов, что входят в content digest, — манифест и attestation в эти 13 не входят ни здесь, ни там. Тот же lock закрепляет то, что bundle не покрывает: `carrier_registry_digest` — `digest('autosk-flow/stage-carrier-registry/v1', …)` реестра носителей, по которому компилятор решает, какие файлы получает каждая роль (`compileCarrier` отказывает с `carrier_bundle_unpinned` реестру с другим digest; такой отказ паркуется как `protocol_lock_invalid`, одна причина на одно расхождение), и digest каждого role и stage contract конверта (§6), поскольку они ресурсы расширения, а не члены bundle (ADR-093). Перед каждым prompt compile, dispatch и resume расширение заново проверяет snapshot bytes, manifest, attestation и project-root binding именно против этого Epic lock. Несовпадение fail-closed паркует задачу с `protocol_lock_invalid`; repair разрешён только из content-addressed digest, указанного в lock, без подстановки current/latest bundle. Prompt compiler читает только уже проверенный project-owned snapshot через canonical ctx.projectRoot. Обновление расширения или работа соседнего проекта не меняют уже начатый Epic.

Installer/cache хранит bundle versions content-addressed по digest, пока существует хотя бы один project lock на эту версию. Garbage collection сначала инвентаризирует locks всех зарегистрированных roots и не удаляет referenced digest; это позволяет repair повреждённого project snapshot без подстановки latest bundle.

### Доказательства

~~~text
<canonical-project-root>/.autosk-evidence/<epic-id>/<task-id>/<round>/<agent>/
~~~

`<canonical-project-root>` — тот же разрешённый корень, который проверяют guard'ы изоляции этого раздела, а не любой абсолютный путь, оказавшийся у вызывающей стороны: F005 существует именно потому, что символическая ссылка делает эти два написания разными. Каталог игнорируется Git и содержит logs/screenshots/evidence mirrors. Accepted verdict authority — daemon gate-result receipt + protected result head; metadata хранит receipt ref и optional evidence path/hash. Editable evidence/session transcript не является outcome source.

### Состояние интеграции

Файл состояния integrate-approved принадлежит проекту, но лежит в ignored runtime-каталоге canonical root, а не в рабочем worktree:

~~~text
<canonical-project-root>/.autosk/autosk-flow/integration-state/<operation-id>.json
~~~

State file хранит only CAS operation/outcome and canonical root. Authorization authority is resolved separately from daemon `integration-authorizations/<scope-id>/<record-id>.json` under protected head; operation state cannot substitute it.

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

Строка «pinned project instruction set» ниже — не свободный текст, а
скомпилированный срез из `project-instructions.lock.json`, зафиксированного на
старте Epic (ADR-029, issue #12). Файл, который провайдер загрузил бы сам, в
конверт не попадает: auto-context либо отключён, либо целиком перечислен lock'ом.

~~~text
pinned common protocol
+ role contract
+ stage contract
+ pinned project instruction set (compiled slice, ADR-029)
+ current daemon-attributed user decisions and accepted corrections
+ current alignment record and re-resolved project policy proof, если применимо
+ approved and recomputed material-decision manifests
+ decision-log extract
+ relevant planning artifacts
+ scope identity / artifact identity
+ known operational facts
+ allowed transitions
+ exact response schema
~~~

Для панели common protocol, anchor pack, artifact bytes и scale byte-identical. Отличаются только role contract и model route.

Controlling anchor pack включает daemon authority, optional mirror, alignment record, approved + post-draft recomputed material manifests, classifier/projector proofs и re-resolved policy status. Изменение любого из них создаёт pending anchor impact; affected candidate/verdict/PASS не переживают смену. Полное распространение на уже выполненные Tickets проектируется отдельно.

Граница текущего слоя узкая: четыре named alignment lifecycles и минимальный trusted user-authority primitive принадлежат issue #4. Issue #14 обобщает artifact classes/impact graph, issue #35 строит HumanDecisionRequest queue, answer/status CLI и UI, issue #25 распространяет поздние изменения на уже реализованную работу. Ни registry, ни общий decision dashboard здесь не создаются.

Небольшой resolvedPiAgent wrapper строит firstMessage во время onRun, затем делегирует штатному piAgent. Это позволяет выбрать модель и snapshot из task metadata без копирования pi-agent driver и без изменения autoskd.

Первый model run создаёт session ID/dir и сохраняет exact absolute Pi session file из get_state. Follow-up в другом worktree открывает только этот file через `--session <path>`; ID + directory не считаются cwd-independent resume binding. Session file обязан находиться под текущим project root, но не в `provider-sessions/` из §5: процесс модели работает под учётной записью `autosk-model` и держит session file, свой `HOME` и конфигурацию провайдера в собственном каталоге сессии вне `.autosk`, потому что хранилище `.autosk` принимает файл, только если он приватен uid'у autoskd. autoskd читает session file оттуда как недоверенный ввод — разбирает и копирует, не принимая чужой файл в своё хранилище. Где каталог сессии лежит под canonical project root и с какими правами — открыто за #13 с #18 и #11 (`docs/contracts/platform-support.md` §5b, ADR-102).

## 7. Идентичность

### Плановый артефакт

~~~text
artifact identity =
  project identity
  + epic id
  + artifact kind
  + private planning ref name
  + expected verified planning head OID
  + base commit OID
  + declared pathspec
  + candidate tree OID
  + artifact sha256 set
  + governance mapping set digest
  + anchor version
  + protocol hash
  + attempt
~~~

### Согласование человеком

~~~text
alignment approval identity =
  SHA-256("autosk-flow/alignment-approval/v1" + canonical JSON of
    project_root_sha256
    + epic id
    + artifact kind
    + anchor version
    + scope hash
    + subject hash
    + approved material manifest hash
    + projector version/hash/inputs proof
    + user decision record id/hash/provenance
    + decision-classifier version/hash
    + current policy issuance/disposition hashes or null
    + protocol hash)
~~~

Хост вычисляет её ровно так (`alignmentIdentity` в `src/host/alignment-gates.mjs`, ADR-091): `digest('autosk-flow/alignment-approval/v1', facts)` канонического объекта двенадцати полей `project_root_sha256`, `epic_id`, `kind`, `anchor_version`, `scope_hash`, `subject_hash`, `material_manifest_hash`, `projector` (`version`, `hash`, `inputs_hash`), `user_decision` (`record_id`, `record_hash`, `provenance_hash` записи `UserDecisionRecord`, либо `null` у policy), `classifier` (`version`, `hash`), `policy` (`issuance_hash`, `disposition_hash` либо `null`), `protocol_hash`; digest — SHA-256 от `domain\0` и канонических байтов (`digest` в `src/runtime/contracts.mjs`). У approval есть источник: `user_decision` и `policy` могут быть непусты вместе (решение пользователя при действующей policy), пусты оба — нет. Пакет спрашивает о том же preimage без `user_decision`, которого до ответа нет, под своим доменом `autosk-flow/alignment-question/v1`, и `subject_hash` подписанной записи равен этому digest'у. Gate пересчитывает identity записи из фактов, действующих сейчас, и её собственного решения, поэтому смена любого поля делает её stale.

Post-draft projection is a separate staleness check over exact artifact bytes; it is not an approval-identity preimage field.

Поле `approval_identity` не входит в собственный preimage. Для всех four kinds canonical material manifest перечисляет planned material decisions до prose draft. Artifact содержит один fenced `autosk-material-decisions` block; material section refs указывают stable IDs. Prompt compiler/Ticket trace используют block, а unreferenced prose не является authority. После draft/Arena/fix projector парсит exact block+refs; mismatch/unknown/unmapped stales approval до freeze. Tickets manifest также связывает files/DAG/scopes/outcomes/order/exclusions. Любое несовпадение provenance/projection/identity делает approval stale.

### Кодовый кандидат

~~~text
candidate identity =
  project identity
  + ticket id
  + base commit OID
  + declared pathspec
  + candidate tree OID
  + governance mapping set digest
  + anchor version
  + controlling anchor digest
  + attempt
~~~

`governance_mapping_set_digest` — domain-separated SHA-256 canonical ordered set доказательств только для дополнительных плановых/управляющих документов в exact candidate tree; пустой set имеет канонический digest. Роль пути для этого набора определяет реестр артефактов: путь, которым управляет класс реестра, получает lifecycle этого класса, и для source/config/schema/prompt/test/migration путей из declared implementation scope это `source_change` — они не требуют mapping и в набор не входят. Пятизначный path-role classifier `01-core-flows.md` §2 остаётся описанием того, какой lifecycle подразумевался для роли, пока её не внесли в реестр, и входом идентичности не является: идентичность не может зависеть от правила, которое `01-core-flows.md` §2 объявляет недостижимым. Text artifact хранит embedded mapping block, non-embeddable artifact — связанный companion JSON; orphan/mismatch sidecar fail-closed. Digest не входит в parent-derived `controlling_anchor_digest`: он вычисляется из exact tree и версии реестра (`registry_digest`) и напрямую входит в artifact/code candidate, а значит также в verdict binding. Freeze, record_artifact_pass/record_code_verdict и commit/integration заново вычисляют set; любое отличие делает прежний verdict stale.

### Verdict

~~~text
verdict binding =
  candidate/artifact identity
  + reviewer task id
  + reviewer session id
  + reviewer family
  + daemon gate-result receipt id/hash/result head
~~~

Перед commit и integration identity вычисляется заново. Совпадение текста комментария PASS без этих полей ничего не разрешает.

`scope-id` закрыт: `epic:<epic-id>` для Planned и `quick:<task-id>` для standalone Quick. `controlling_anchor_digest` связывает scope-keyed dependency head/current projection, intent head, manifests/classifier/projector, anchor и protocol. appendIntentEvent выбирает stream по этой identity. Global authority journal reconciles integrity; unrelated scope не stales projection. Direct metadata/comment edit расходится с protected heads.

Authority/dependency/user-instruction/correction appends, graph repair mutations и Git target-ref CAS имеют одну daemon-owned точку линеаризации. `authorityGuard(expected_relevant_authority_projection_hash,expected_dependency_head,expected_intent_head,digest)` держит project mutex; daemon reconciles global authority head for integrity, но сравнивает only current Epic projection so unrelated record не stales it. Собственная приёмка интеграции scope в эту projection и в dependency/intent heads scope не входит, и это класс: каждый ответ на любой пакет приёмки scope — accept или refuse, повторные включительно — и каждая `IntegrationAuthorizationRecord` его; при коммите демон узнаёт его по виду запроса, на который решение отвечает, одним правилом для обоих видов scope (ADR-112): пакет Epic, запаркованный с `acceptance_missing` на `accept_staging` (scope `epic:<epic-id>`), или пакет Quick-прогона, запаркованный с `integration_authorization_required` на `accept` (scope `quick:<task-id>`), а не по payload. Коммит такого решения двигает только глобальные authority и nonce heads, запись record — `integration_authorization_head`, поэтому `integrateApproved` сравнивает названные record'ом heads с действующими без неё, а любое другое решение, включая отзыв или замену приёмки, учитывается (`docs/contracts/integration-authorization.md` §3, ADR-103). `integrateApproved` под тем же mutex re-resolves projection/heads/classifier/auth record и выполняет Git update-ref; он — единственный writer target ref Epic и Quick, а приватный staging ref, как каждый ref под `refs/autosk/**`, пишет ref-custody helper по запросу host (ADR-088, ADR-095). Competing append ждёт mutex; lock не хранит task status.

Третий upstream primitive — daemon workflow custody. Own-task mutation uses step-capability + expected metadata head. Parent repair uses `orchestrateChildBatch` capability bound to parent task/workflow/step/op ID, exact child IDs+expected heads and closed allowed patches; daemon CAS-updates child heads and records monotonic phases. It cannot mint a child-owned step capability. Gate result advances result head. WorkAgent has worktree-scoped adapters only.

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
2. до и после сессии детерминированный шаг сравнивает HEAD, tree, status/untracked set и immutable creation/session bindings; параллельные sibling lifecycle/result writes допускаются только как daemon custody receipts с monotonic provenance/version, full live sibling store hash не считается immutable.

Любая неожиданная запись превращает результат в blocking non-verdict. Ограниченный набор capabilities предотвращает известные пути записи, а pre/post hashes остаются защитой от ошибки driver; контейнерный read-only mount можно добавить позже только если измерения покажут необходимость.

## 9. Модели

<!-- panel-roster-historical:v1 -->

**Таблица ниже — историческое целевое намерение, а не действующий состав панели.** Действующий состав задаёт только `REQUIRED_PANEL` в `scripts/validate-provider-preflight.mjs` — маршрут для панели берётся оттуда, из таблицы его брать нельзя. Расхождение построчно, замер 2026-09-21:

| Роль | Записано здесь | `REQUIRED_PANEL` на тот день | Итог |
| --- | --- | --- | --- |
| GPT critique/review | `openai-codex/gpt-5.6-sol:max` | `openai-codex/gpt-6-astra` / `high` | разошлись модель и effort |
| Opus coordination/architecture | `pi-claude-code-provider/opus:max` | `anthropic/claude-opus-5` / `max` | разошлись харнесс и модель |
| Grok implementation/feasibility | `cursor/cursor-grok-4.6:xhigh` | `cursor/cursor-grok-4.6` / `xhigh` | совпадает точно |
| Kimi intent/scope | `cursor/kimi-k3:max` | `meta/muse-spark-1.3-contributor` / `max` | разошлись харнесс и модель |

Три из четырёх записанных маршрутов `family-partition.v1.json` не относит ни к одному семейству — собранная по этой таблице панель получает отказ `partitionErrors`.

Целевые Pi route specs (историческая запись, не действующий состав):

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
