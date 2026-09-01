# Архитектурные решения

Статус всех решений: proposed, до принятия пользователем и PASS панели.

## ADR-001: расширение поверх autosk v2

- Решение: реализовать процесс как TypeScript extension без отдельного scheduler fork. Обязательные upstream primitive sets ровно три: creation identity ADR-014, signed authority/intent stack ADR-023 и daemon workflow custody ADR-025. Без любого preflight запрещает model workflow.
- Альтернатива: отдельный оркестратор или глубокая модификация scheduler.
- Обоснование: registerWorkflow, AgentDefinition, onTransit, blockers, sessions и sandbox уже дают необходимые примитивы. Extension сохраняет обновляемость upstream.
- Источники:
  - `wierdbytes/autosk@5163f00`: `daemon/sdk/src/workflow.ts`;
  - `wierdbytes/autosk@5163f00`: `daemon/core/src/extensions/registry.ts`.

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
  - README.md, канонические правила 1–2, и 01-core-flows.md, раздел «Четырёхмодельная панель».

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
  - `wierdbytes/autosk@5163f00`: `daemon/core/src/engine/engine.ts`;
  - `wierdbytes/autosk@5163f00`: `daemon/core/src/store/store.ts`.

## ADR-006: Git хранит нормативную правду

- Решение: Brief, Core Flow, Tech Plan, Decision Log и Tickets хранятся под `docs/autosk/epics` в Git-репозитории конкретного проекта. autosk metadata не заменяет их.
- Альтернатива: хранить документы внутри daemon runtime или task descriptions.
- Обоснование: Git даёт reviewable history и OID; runtime-файлы остаются операционным состоянием и могут очищаться.
- Источники:
  - раздел Traycer artifact synchronization в agent-selection-guide.md;
  - autosk docs/concepts.md.

## ADR-007: без второго ledger

- Решение: текущее состояние хранится в namespaced task metadata, comments и sessions. Отдельный run.json/status ledger не создаётся; bundle manifest и per-Epic protocol lock описывают immutable bytes, а не status.
- Альтернатива: собственный manifest/ledger рядом с autosk state.
- Обоснование: дублирующее состояние создаёт drift. Отдельные evidence records нужны только для байтов verdict/log и связываются hash.
- Источники:
  - autosk task/session model;
  - принцип Simplicity First.

## ADR-008: автоматическая компиляция замороженных инструкций

- Решение: autosk-native bundle содержит один Guide, exact 12 protocol files, canonical manifest/content digest и detached four-model attestation. Для Epic exact bundle копируется в project-owned immutable snapshot и фиксируется protocol.lock; проектные решения остаются в Epic artifacts/user instructions и не переопределяют governance.
- Альтернатива: полагаться на память модели, указывать ей путь без загрузки либо вручную копировать тексты.
- Обоснование: отдельный agent context обязан получить применимые правила, но пользователь не должен их переносить вручную. Snapshot защищает выполняющийся epic от обновления расширения.
- Источники:
  - piAgent firstMessage/task/comments rendering;
  - Traycer protocol snapshot и handoff rules.

## ADR-009: Arena/Judge внутри планирования

- Решение: Arena запускается только для pending entry в каноническом autosk-arena JSON block с ordered decisions array и rubric 3–6 критериев. record_artifact_pass механически ведёт монотонную map по decision_id. Default candidates — Grok и Codex; Judge — отдельный Kimi либо Opus вне candidate set.
- Альтернатива: Arena всей feature либо выбор подхода одним планировщиком.
- Обоснование: локальная Arena исследует конкретный спор без удвоения всей разработки. Judge рекомендует базу; material choice подтверждает пользователь или допустимая exact policy, затем изменённый Tech Plan получает новую полную панель, а итоговый код — обычный review.
- Источники:
  - 01-core-flows.md, раздел «Arena/Judge»;
  - 03-technical-plan.md, workflows `autosk-arena-candidate` и `autosk-arena-judge`.

## ADR-010: PASS только по точной идентичности

- Решение: planning verdict связан с artifact snapshot; artifact/code candidate identity напрямую включает ordered `governance_mapping_set_digest` exact tree, отдельно от parent-derived controlling anchor. Code verdict также связан с base/pathspec/tree OID/anchor/controlling_anchor_digest/attempt и daemon gate-result receipt ID/hash/result head. Freeze, record_artifact_pass/publish_artifact_pass/record_code_verdict и commit/integration recompute mapping digest; drift voids verdict до side effect. До branch CAS host фиксирует exact commit recipe/OID; recovery accepts only that OID/parent/recipe.
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

## ADR-012: автономная детерминированная интеграция

- Решение: перенести проверенную CAS/reflog-логику и тесты integrate-approved в autosk-owned adapter. Target-ref CAS выполняет daemon `integrateApproved` под project authority mutex с expected dependency digest/secure heads и exact integration authorization; state file хранится под canonical project root `.autosk/autosk-flow`, вне worktree.
- Альтернатива: runtime-вызов Traycer binary либо новая prompt-driven merge-логика.
- Обоснование: перенос сохраняет доказанные failure contracts, но устраняет runtime-зависимость от Traycer и глобальный cross-project state.
- Источники:
  - 03-technical-plan.md, разделы «Commit on PASS» и «Integration»;
  - обязательная перед реализацией миграция CAS/reflog tests в публичный пакет с привязкой к exact source/version.

## ADR-013: human gate перед интеграцией

- Решение: accept — statusStep("human") после pass/waived review disposition и до движения target. Прямой переход из ticket_join, record_code_verdict или initial editorial exemption разрешает только signed `IntegrationAuthorizationRecord`, связанный с exact run, target/base, ordered commits, каждым expected-old/new ref transition, final tree, controlling digest и expiry. Project alignment policy integration не покрывает.
- Альтернатива: всегда автоматически интегрировать после PASS.
- Обоснование: review подтверждает кандидат, но не всегда разрешает изменение пользовательской ветки. Exact signed record совмещает acceptance и разрешение CAS без бессрочного project-level полномочия.
- Источники:
  - autosk statusStep human;
  - связанный разговор, этап Human / Merge.

## ADR-014: CLI orchestration с обязательным immutable creation key

- Решение: orchestration остаётся в extension и вызывает autosk CLI из ctx.exec, но task.create/CLI до MVP получает обязательную optional пару `creation_key + creation_binding_hash`: write-once daemon-owned fields, атомарно сохраняемые вместе с task. Key уникален внутри canonical project, hash связывает immutable project/parent/run/type/artifact/session/workflow target. `autosk create --creation-key ... --creation-binding-hash ...` возвращает existing task только при совпадении пары; mismatch — conflict. Title/description и human-editable metadata не участвуют в recovery. Остальные write methods TasksAPI остаются отдельным upstream ticket после измерений.
- Альтернатива: create → metadata set и поиск по marker в title/description.
- Обоснование: текущий autosk@5163f00 создаёт task с пустой metadata, а title/description изменяемы; crash или rename до metadata set делает текстовый marker недостоверным и допускает duplicate child. Узкий primitive закрывает именно доказанную дыру, не переносит workflow в core и не создаёт второй ledger.
- Источники:
  - daemon/sdk/src/agent.ts, read-only TasksAPI;
  - `wierdbytes/autosk@5163f00`: `cmd/autosk/create.go`, create без metadata/creation key;
  - `wierdbytes/autosk@5163f00`: `daemon/core/src/store/store.ts`, createTask пишет editable title/description и пустую metadata;
  - CodeRabbit finding на PR #2: rename до metadata set может скрыть child от retry.

## ADR-015: повторное ревью по exact session file

- Решение: каждая model-owned task имеет собственный session record. Первый Pi run сохраняет exact absolute session file; follow-up открывает его через `--session <path>`, независимо от worktree cwd. Panel/contest/narrow берут seat file, code review — отдельный reviewer file, Arena — раздельные candidate/Judge files. Author session никогда не копируется reviewer.
- Альтернатива: каждый раунд запускать полностью нового агента без истории либо держать один бесконечный autosk task.
- Обоснование: Pi фильтрует custom session-dir lookup по cwd, поэтому ID+dir недостаточны. Exact file сохраняет историю reviewer; replacement создаётся только при недоступности, повреждении session или обязательной смене роли и явно записывает replaces.
- Источники:
  - Traycer Handoff rules: повторное обращение к тому же child после final reply;
  - Pi session-id/resume surface;
  - autosk session/task separation.

## ADR-016: изоляция параллельных проектов по canonical project root

- Решение: все project resources привязаны к canonical `ctx.projectRoot`; любой ключ за пределами одного store использует project_root_sha256. Boundary guard проходит до каждого side effect и запрещает traversal/symlink. Внешний Git worktree cache — единственное физическое исключение и тоже namespaced project hash.
- Альтернатива: использовать `<project-slug>`, epic ID или task ID как глобальный ключ.
- Обоснование: autoskd может держать несколько открытых проектов в одном daemon и общем worker pool; task/session IDs и slug не должны смешивать операции разных root.
- Источники:
  - daemon/core/src/project/resolve.ts, canonicalize + walk-up до ближайшего `.autosk`;
  - daemon/core/src/store/paths.ts, per-project `.autosk` layout;
  - daemon/core/src/engine/engine.ts, global queue over registered projects.

## ADR-017: Obsidian MCP исключён из целевого процесса

- Решение: Obsidian MCP и локальный навык `architecture-planning` не входят в preflight, prompts, tests, review gates, runtime или Definition of Done autosk-flow.
- Альтернатива: оставить Obsidian как обязательную или опциональную архитектурную сверку.
- Обоснование: autosk-flow должен быть автономным расширением autosk; личный vault не должен становиться скрытой зависимостью процесса или публичного пакета.
- Источники:
  - прямое решение пользователя: Obsidian MCP не используем.

## ADR-018: без devflow и Traycer runtime

- Решение: `autosk-flow` регистрирует собственные Planned, Quick, Ticket, Review, Panel и Arena workflows. `devflow`, `~/.traycer`, `traycer_*`, Traycer skills и Traycer sessions не используются ни как dependency, ни как fallback.
- Альтернатива: orchestration layer над авторским devflow и вызовы локальных Traycer tools.
- Обоснование: чужой flow имеет собственный lifecycle и может изменяться независимо; такая связь нарушает автономность и делает поведение Ticket неуправляемым нашей спецификацией.
- Источники:
  - прямое решение пользователя: devflow нам не нужен;
  - разговор «Проектирование autosk v2».

## ADR-019: публичный автономный bundle, приватный migration baseline

- Решение: public Git содержит только очищенный autosk-native Guide + exact 12-file protocol + manifest + detached panel attestation. Exact imported Traycer baseline хранится локально вне Git и используется только явным import/diff tool до сборки новой bundle version.
- Альтернатива: публиковать exact baseline или читать его из `~/.traycer` во время runtime.
- Обоснование: active bundle должен быть воспроизводимым и автономным, но публичный репозиторий не должен раскрывать личные пути, Traycer API и локальные инструкции. Автоматической синхронизации нет.
- Источники:
  - разговор «Проектирование autosk v2»;
  - решение публиковать только обезличенную спецификацию.

## ADR-020: single-writer Epic metadata через correction inbox

- Решение: только deterministic owning steps с ADR-025 step-capability + expected protected metadata head пишут `autosk_flow`; model/Ticket connections rejected. Dependency/intent/result journals have protected heads, metadata carries projections/refs. Ticket resume starts after parent CAS write.
- Альтернатива: current last-write-wins metadata set, tool convention or concurrent model writes.
- Обоснование: existing autosk lacks expected-hash ownership; ADR-025 is mandatory because append-only intent alone does not protect verdict/review/repair state.
- Источники:
  - autosk metadata/comment store behavior;
  - full re-panel finding G-H-02.

## ADR-021: capability-minimal gate agents

- Решение: panel, contest, narrow, code-review и Judge получают только snapshot-rooted read tools и единственный host-mediated `submit_gate_result`. Прямой transit, shell, edit/write, `autosk_task` и sibling comment mutations отсутствуют. После model run deterministic tail GateAgent повторяет project guard перед каждым side effect, валидирует submit, записывает и перечитывает immutable record, затем validator выполняет переход.
- Альтернатива: полный стандартный Pi tool set плюс post-check Git worktree.
- Обоснование: Git dirt check не обнаруживает mutation live `.autosk` store. Gate agent не должен иметь capability менять объект, который проверяет.
- Источники:
  - autosk Pi tools/runtime behavior;
  - full re-panel finding G-H-03.

## ADR-022: human alignment до нормативного planning artifact

- Решение: до prose draft Brief/Core Flow/Tech Plan получают structured proposal и canonical `material_decision_manifest`; approval связывает manifest, daemon authority, classifier/projector и policy. После draft/Arena/fix manifest повторно извлекается из exact bytes; mismatch stales alignment до freeze/panel. Tickets сначала создаются как proposal и связывают полный breakdown/DAG manifest до Ticket Panel. Модельная панель остаётся отдельным последующим gate.
- Автономный режим: пользователь может заранее выдать exact project/run policy только для перечисленных локальных, обратимых и непродуктовых decision classes. Материальные product/UX, architecture/one-way-door, security/privacy/data, destructive, delivery/release, scope-reduction, waiver и integration решения policy не покрывает. Policy имеет те же identity, staleness и audit guarantees и не отменяет Panel, Code Review или integration acceptance.
- Альтернатива: разрешить планировщику фиксировать assumptions и считать PASS панели подтверждением намерения пользователя либо использовать один бессрочный флаг autonomous.
- Обоснование: панель может доказать внутреннее качество решения, но не право модели принять его. Точная identity не позволяет повторно применить старое approval после изменения ответа, scope, anchor или Ticket DAG; ограниченная policy сохраняет автономность для заранее разрешённых мелких решений без скрытого расширения полномочий.
- Источники:
  - issue #4, human alignment gates;
  - 01-core-flows.md, раздел «Согласование решений человеком»;
  - 03-technical-plan.md, alignment state и metadata contracts.

## ADR-023: daemon-attributed user authority

- Решение: trusted init pin'ит signer key; autoskd сохраняет exact canonical challenge bytes, коммитит authority+nonce heads до projection/effects. Dependency `add|supersede` и intent journals имеют protected heads. `authorityGuard`/`integrateApproved` под project mutex reconciles global authority journal, но сравнивают relevant Epic authority projection + dependency/intent heads, поэтому unrelated project decision не stales Epic; competing appends ждут. Invalid tail never had effects/nonce reuse; missing committed bytes fail-closed. Git/comments/metadata — projections.
- Альтернатива: считать user-authored любой Git/comment запись с подходящим текстом либо проверять наличие TTY.
- Обоснование: signer и secure store обязаны работать в separate OS security boundary (privileged helper/separate account or hardware-backed enclave) недоступной model process. Sandbox profile запрещает model accessibility/ptrace/keychain access; deployment без доказуемой boundary/headless signer fail-closed. Boundary tests cover signer and secure-state access. Issue #35 only adds UI.
- Источники:
  - issue #4, invariant «модель не подтверждает своё решение»;
  - first panel findings feasibility-01 и arch-02;
  - second panel finding arch-01;
  - 02-architecture.md, daemon/user decision boundary.

## ADR-024: Quick reclassification через Planned replacement

- Решение: Quick classification перепроверяется на каждом pre-integration gate. Planned-trigger запускает idempotent `invalidate_quick_classification`: первый durable handoff record связывает current intent head, candidate/review/accept/waiver/integration hashes и atomically void'ит Quick review/accept/authorization + запрещает Git read/commit/integrate до child create. Затем один Planned replacement создаётся от original base по daemon creation key; retry продолжает тот же record. Old Quick завершается outcome=reclassified только после read-back replacement/ownership receipt.
- Альтернатива: разрешить material scope expansion внутри Quick либо менять workflow текущей task in place.
- Обоснование: продолжение Quick обходит четыре alignment/panel gates; in-place switch не поддержан доказанным autosk primitive и усложняет recovery. Replacement сохраняет точную lineage, не доверяет ранним bytes и восстанавливается после crash без duplicate Epic.
- Источники:
  - issue #4, Quick exemption only while classification valid;
  - first panel findings intent-01 и arch-01;
  - 03-technical-plan.md, Quick reclassification.

## ADR-025: daemon workflow custody

- Решение: own-task writes use step-capability+expected head. Parent repair/dispatch uses separate `orchestrateChildBatch` capability bound to parent step/op, exact child set/heads and closed patch schema; daemon records monotonic child receipts and never mints forged child step capability. Gate outcome is write-once receipt/head. WorkAgent is worktree-only.
- Альтернатива: доверять tool allowlist, same-UID filesystem и self-consistent metadata/hash bytes.
- Обоснование: model с shell иначе может подделать PASS, очистить pending_anchor или заменить repair op после pre/post check. Human authority и Git dirt этого не обнаруживают.
- Источники:
  - v6 panel findings architecture-02 и SUPPLEMENTARY-01;
  - ADR-020/021;
  - 02-architecture.md, operational truth и gate custody.

## ADR-026: private Epic planning ref и commit-on-PASS

- Решение: каждый Planned Epic создаёт private append-only `refs/autosk/epics/<epic-uuid>/planning` от immutable planning base. Artifact verdict/waiver сначала получает status recorded_unpublished. Host-only `publish_artifact_pass` строит object-format-aware deterministic single-parent commit, expected-old CAS-продвигает ref и read-back проверяет exact parent/tree/trailers/current bindings; только phase=verified завершает kind и разрешает select_next. Anchor invalidation также публикуется descendant commit через тот же adapter; rewind/reset/force/rebase/adopt-current запрещены.
- Альтернатива: считать detached snapshot или metadata PASS достаточным; коммитить все planning docs одним commit в конце; двигать target после каждого PASS; при correction возвращать private ref назад.
- Обоснование: detached objects могут стать unreachable, dirty worktree смешивает артефакты, следующий author не имеет однозначной базы, а crash между object write и ref/metadata создаёт ambiguous outcome. Append-only planning line даёт reachable ordered history, exact `planning_head` для Tickets/staging и идемпотентное recovery без движения пользовательской ветки.
- Recovery: protected `planning_publication_op` имеет write-once recipe и phases `prepared -> commit_created -> ref_advanced -> verified`. Ref at expected commit after crash принимается только после byte/tree/parent verification; иной OID — `planning_ref_foreign_movement`, corrupt/indeterminate durable state — `planning_publication_corrupt`.
- Границы: issue #6 определяет Tickets manifest, #7 dependency bases, #8 approved deltas, #9 staging/final CAS, #14 generic artifact projection, #17 base/delivery policy, #25 semantic revision ordering.
- Источники:
  - issue #5;
  - `docs/contracts/epic-planning-ref.md`;
  - 01-core-flows.md, раздел «Публикация утверждённых артефактов в planning ref»;
  - 03-technical-plan.md, steps `init_planning_ref`, `publish_artifact_pass`, `publish_planning_invalidation`.

## Оставшиеся риски, не решения

1. Daemon workflow custody отклоняет model-side operational writes; OS-level read-only mount остаётся defense-in-depth для project store. Если измерения покажут side channel вне daemon API, добавить container mount отдельным этапом.
2. block/enroll и остальные child-task операции остаются многошаговыми, поэтому receipts и crash-matrix обязательны. Сам create становится идемпотентным через atomic daemon-owned creation_key+binding hash; полный write API рассматривается после MVP.
3. Pi auth check не понимает custom Cursor/Claude provider state. Готовность этих маршрутов подтверждается только live synthetic calls.
4. autosk не замораживает workflow graph. Protocol bytes будут pinned; исчезновение workflow/step корректно паркует task в human, но полная graph snapshot остаётся возможным будущим core enhancement.
5. autoskd использует общий FIFO worker pool для всех проектов. Изоляция и correctness не зависят от порядка, но равная latency между проектами не гарантируется; admission limit нужен только после измерения реального starvation.
