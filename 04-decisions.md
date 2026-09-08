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

- Решение: каждый Planned Epic создаёт private append-only `refs/autosk/epics/<epic_ref_key>/planning` от immutable planning base; `epic_ref_key` — domain-separated SHA-256 canonical project/Epic identity, а не display ID. Already-at-base принимается только по closed init Schema/example, matching ref-create receipt и exact sanitized reflog-producer proof. V1 поддерживает files ref storage with protected reflogs; reftable/unprovable backend fail-closed. Issue #5 packages a separate-account ref-custody helper, pins loose protected refs with gc.packRefs=false and rejects refs/autosk entries in packed-refs. До review/waiver host создаёт candidate-identity ref `refs/autosk/epics/<epic_ref_key>/candidates/<candidate_identity>`, который удерживает frozen snapshot commit и полную tree/blob closure от GC. Artifact verdict/waiver сначала получает status recorded_unpublished. Host-only `publish_artifact_pass` связывает verified keepalive, сохраняет полный object-format-aware recipe с exact commit bytes/signing binding/reflog checkpoint, пишет эти bytes, expected-old CAS-продвигает planning ref и read-back проверяет exact object/parent/tree/closure/author/committer/signature/trailers/reflog/current bindings; только phase=verified и atomic planning-ref verify + live-to-audit candidate ref transfer завершает kind и разрешает select_next. Pre-CAS drift терминально становится `voided_before_ref`, переводит keepalive в `audit_retained` и архивируется только после durable audit receipt; post-CAS drift проходит `release_pending`, durable release/audit receipt и только затем descendant invalidation. Anchor invalidation имеет тот же полный keepalive/phase adapter, non-empty projection mutations, stored effective target and golden vector; rewind/reset/force/rebase/adopt-current запрещены.
- Альтернатива: считать detached snapshot или metadata PASS достаточным; коммитить все planning docs одним commit в конце; двигать target после каждого PASS; при correction возвращать private ref назад.
- Обоснование: detached objects могут стать unreachable, dirty worktree смешивает артефакты, следующий author не имеет однозначной базы, а crash между object write и ref/metadata создаёт ambiguous outcome. Append-only planning line даёт reachable ordered history, exact `planning_head` для Tickets/staging и идемпотентное recovery без движения пользовательской ветки.
- Recovery: protected `planning_ref_init_op` имеет phases `prepared -> ref_created -> verified`; closed candidate_keepalive_op adds audit_retained/released terminal dispositions; protected `planning_publication_op` имеет immutable keepalive binding, typed payload, complete write-once recipe/exact publication commit bytes, reflog checkpoint and phases `prepared -> commit_created -> ref_advanced -> verified` or terminal `voided_before_ref`. Ref at expected commit after crash принимается only after byte/tree/parent/closure/signature/reflog verification; changed reflog prefix catches ABA, иной transition — `planning_ref_foreign_movement`, keepalive custody/closure failure — `planning_candidate_keepalive_invalid`, corrupt/indeterminate durable state — `planning_publication_corrupt`.
- Границы: issue #6 определяет Tickets manifest, #7 dependency bases, #8 approved deltas, #9 staging/final CAS, #14 generic artifact projection, #17 base/delivery policy, #25 semantic revision ordering.
- Источники:
  - issue #5;
  - `docs/contracts/epic-planning-ref.md`;
  - 01-core-flows.md, раздел «Публикация утверждённых артефактов в planning ref»;
  - 03-technical-plan.md, steps `init_planning_ref`, `publish_artifact_pass`, `publish_planning_invalidation`.

## ADR-027: canonical machine-readable Tickets manifest

- Решение: каждый Tickets revision публикует один closed canonical `tickets.manifest.json`; human `README.md`/`Txx-*.md` являются pinned deterministic renderer outputs и входят в ту же frozen candidate/tree. Manifest-only dispatcher читает exact verified publication commit, validates `TicketsValidationReceipt`/digests и создаёт task/blocker graph только из canonical entries. Runtime status в manifest отсутствует.
- Identity: domain-separated manifest, Ticket-entry, DAG, rendered-document-set и full-set digests связываются с planning parent/candidate tree, alignment, protocol/runtime/project-instruction, schema/validator/renderer and mapping identities. Stable Kahn order, closed file/directory scope selectors, ordered-overlap rule, referential AC/evidence/governing refs and revision lineage fail closed.
- Альтернатива: parse free-form Markdown, вести JSON и Markdown как две независимо редактируемые истины либо строить blockers из task titles/comments.
- Обоснование: свободный текст не даёт воспроизводимого graph/recovery API; две редактируемые формы неизбежно расходятся. Canonical JSON даёт stable schema/errors/digests, а deterministic renderer сохраняет удобную human review surface без второго control plane.
- Границы: #5 публикует artifact, #7 использует DAG/entry digests для execution bases, #8/#9 отвечают за delta/staging, #18 — за structured model results и host-mediated transitions, #23/#24 — за evidence bindings, #25 — semantic revision dispositions.
- Источники: issue #6; `docs/contracts/tickets-manifest.md`; state machine `validate_tickets_manifest -> freeze_artifact -> Panel -> publish_artifact_pass -> dispatch_ticket_dag`.

## ADR-028: единый filesystem boundary adapter через долгоживущий native helper

- Решение: доверенное состояние проекта пишется **только** через native helper `autosk-store-lock`, и на открытый проект приходится **один долгоживущий** процесс helper'а, удерживающий межпроцессную блокировку проекта всё время, пока демон держит проект открытым. `withCreationLock` перестаёт быть «процесс на вызов» и становится использованием этого соединения. Под адаптер переводятся `task.json`, `comments.jsonl`, мета и transcript сессии; реестр проектов и RPC-токен остаются вне его, потому что живут в `$HOME`, а не в проекте, и получают собственные гарантии (эксклюзивная публикация, см. патч `0019`).
- Альтернатива 1 — helper на каждую запись. Отклонена по измерению: 8.9 мс на вызов (spawn + захват блокировки + одна операция, 20 вызовов). Сессия из ста сообщений — около сотни доверенных записей — заплатила бы почти секунду чистого spawn'а и полностью сериализовалась бы на одной блокировке.
- Альтернатива 2 — режим helper'а без блокировки, дающий файловые гарантии без взаимного исключения. Отклонена: гарантии no-follow/владельца/устройства она даёт, но два писателя одного файла снова становятся возможны, а именно этого требование #13 и не допускает.
- Альтернатива 3 — оставить расщепление. Отклонена телом #13 дословно: «Нельзя иметь безопасный adapter для одной подсистемы и обычный `fs.writeFile/rm` для другой trusted state».
- Обоснование: неприкосновенное свойство продукта уже гласит, что единственный владелец operational task state — autoskd. Удержание блокировки проекта на время его открытости и есть выражение этого владения на диске; оно устраняет spawn из каждой записи и даёт всем доверенным записям одни и те же гарантии.
- **Цена, которую это решение вводит, и её надо называть**: второй демон не сможет открыть тот же проект, пока первый его держит. Сегодня single-instance обеспечивается на уровне сокета; это распространяет исключение на проект. Смерть helper'а перестаёт быть событием одного вызова и требует явной семантики восстановления: проект либо закрывается, либо соединение переустанавливается, и до тех пор доверенные записи отвергаются, а не выполняются в обход.
- Границы: адаптер даёт no-follow на каждом пройденном компоненте, проверку типа/владельца/режима, проверку устройства и атомарную публикацию. Compare-and-swap он даёт **только** для индекса времени выполнения; для `task.json` и индекса создания его нет ни сейчас, ни по этому решению. Удаления и quarantine в протоколе отсутствуют и этим ADR не вводятся.
- Источники: issue #13; аудит контракта — [issuecomment-5578393704](https://github.com/Valeron2206/autosk-traycer-flow/issues/13#issuecomment-5578393704); границы покрытия — `docs/runtime/autosk-compatibility.md`, раздел «What the boundary adapter covers, and what it does not»; измерение — `withCreationLock` на 20 вызовах, 8.9 мс на вызов.

## ADR-029: pinned project instruction set вместо неявной provider-загрузки

- Решение: на старте Epic фиксируется неизменяемый `project-instructions.lock.json`. Обнаружение — чистая функция одного tree OID и закрытого списка имён; оно не читает рабочую копию, не читает `$HOME` и не идёт по symlink. Каждая model invocation получает только скомпилированный применимый срез из lock'а, а provider auto-context либо отключён, либо полностью перечислен lock'ом. Третьего состояния нет. Контракт: `docs/contracts/project-instructions-lock.md`, схема `resources/project-instructions/project-instructions-lock.schema.json`.
- Альтернатива 1 — оставить неявную загрузку как есть. Отклонена: три семьи читают три разных набора правил, и расхождение невидимо — в transcript'е нет записи о том, какой файл модель получила. PASS, который не может назвать байты инструкций, не является PASS об этом репозитории.
- Альтернатива 2 — просто отключить implicit context у всех провайдеров. Отклонена телом #12: обязательные ограничения репозитория тогда теряются, а не фиксируются.
- Альтернатива 3 — хранить только пути и читать файлы во время запуска. Отклонена: тогда идентичность candidate'а не связана с байтами, и правка файла между dispatch и review проходит незамеченной.
- Обоснование: `combined_digest` покрывает не только допущенный список, но и сам алгоритм обнаружения и закрытый список имён. Без этого lock мог бы сохранить идентичность, когда правило, породившее его, изменилось.
- Приоритет закреплён пятью рангами, и материальный конфликт паркует задачу в `human`, а не разрешается порядком загрузки. Причины парковки — закрытое множество; пять из них дополнительно записываются в сам lock как `excluded`, потому что это факты о дереве, а остальные — факты о запуске.
- Цена: набор поддерживаемых имён закрыт, поэтому новый инструкционный файл требует явного изменения контракта, а не просто появления в репозитории. Это и есть цель.
- Границы: контракт определяет, что может быть в срезе, а не как он сериализуется — это #19; проверка исходящего тела на утечки — #20; флаг отключения auto-context у провайдера — #26; реестр, в котором lock регистрируется, — #14.
- Источники: issue #12; критерии приёмки — в разделе 12 контракта; валидатор `scripts/validate-project-instructions-lock.mjs` и 21 тест, каждый из которых мутирует пример ровно в одном месте.

## ADR-030: delivery profile решается до первого implementation dispatch

- Решение: на старте Epic резолвится неизменяемый `delivery-profile.lock.json` из трёх источников с явным provenance — `project_config` (blob OID), `remote_discovery` (время наблюдения и срок годности), `human_decision` (id и scope решения). Если записанный режим интеграции adapter не поддерживает или обязательное поле осталось `unknown`, Epic останавливается **до первого implementation dispatch** с decision packet. Скрытого отката на локальный fast-forward нет. Контракт: `docs/contracts/delivery-profile.md`, схема `resources/delivery-profile/delivery-profile.schema.json`.
- Альтернатива 1 — выяснять правила доставки при первом push. Отклонена телом #17: к этому моменту уже есть approved commits, которые нельзя доставить без переписывания истории или повторного review.
- Альтернатива 2 — считать отсутствие обнаруженного правила разрешением. Отклонена: «мы не увидели protection rule» и «прямой push разрешён» — разные утверждения, поэтому `direct_push_allowed` записывается явно, а не выводится.
- Альтернатива 3 — покрывать digest'ом весь документ. Отклонена: тогда переформулировка обоснования аннулировала бы кандидата, который от неё не зависел. Digest покрывает ровно поля, названные в `binding_fields`, и валидатор его пересчитывает.
- Обоснование: обнаружение — это доказательство со сроком годности. Branch protection, прочитанная час назад, могла измениться; поэтому каждое `remote_discovery`-поле несёт `observed_at` и `expires_at`, а профиль с истёкшим обнаружением перерешается перед зависящей от него операцией, а не используется потому, что когда-то был верен.
- Тихая замена `merge` на `squash` или pull-request-профиля на локальное обновление — не починка, а другая доставка под тем же именем; обе отвергаются. Появившаяся в середине прогона обязательная проверка аннулирует staging-результат, который её не выполнял; исчезнувшая — не делает задним числом валидным прогон, который её провалил.
- Учётные данные: профиль записывает, что требуется класс учётных данных и где хост его ожидает, но никогда не значение. В схеме физически нет поля, способного хранить секрет, и это проверяется валидатором — утверждение о схеме сильнее политики, которая просит так не делать.
- Границы: #9 владеет приватным staging и единственным условным обновлением target; этот контракт говорит, какие из этих операций вообще разрешены. #26 владеет учётными данными и возможностями провайдера, #37 — governance release lifecycle. Развёртывание для реальных пользователей вне области v1.
- Источники: issue #17; критерии приёмки — в разделе 11 контракта; валидатор `scripts/validate-delivery-profile.mjs` и 22 теста.

## ADR-031: расширяемый artifact registry вместо четырёх зашитых видов

- Решение: список видов артефактов, которыми проект умеет управлять, хранится в `resources/artifact-registry/artifact-registry.v1.json`. Каждая запись задаёт категорию, роли автора, предшественников, пути, режим ревью, поля идентичности, carrier, схему и валидатор, граф влияния, цель публикации, право модели генерировать этот класс, retention и требование человеческого одобрения. Добавление класса — одна запись, а не новое значение в нескольких `switch`. Контракт: `docs/contracts/artifact-registry.md`.
- Альтернатива 1 — дописывать значения в перечисление `brief | core_flow | tech_plan | tickets`. Отклонена телом #14: именно так перечисления и расходятся между местами, а документ, меняющий поведение, но не имеющий жизненного цикла, gate не обходит — у него его никогда не было.
- Альтернатива 2 — считать всё незарегистрированное пояснительным. Отклонена: editorial-исключение никогда не распространяется на конфигурацию, схемы, правила безопасности, промпты, governance, миграцию и контракты проверки. Правка опечатки в прозе ADR — редакторская; правка опечатки в `pattern` схемы — нет, потому что меняются те самые байты, которые решают.
- Обоснование: реестр не был бы ничем, если бы не управлял артефактами самого репозитория. Класс `contract_document` перечисляет каждый контракт из `docs/contracts/` **поимённо**, и валидатор падает, если контракт не перечислен. Перечисление шаблоном отвергается отдельно: glob подхватил бы новый контракт автоматически, и слово «зарегистрирован» перестало бы что-либо значить.
- Контракт и определяемые им экземпляры — разные классы, потому что различается радиус поражения: изменение одного Tickets-манифеста затрагивает один Epic, изменение самого контракта — все манифесты, которые по нему когда-либо напишут.
- Один путь не может принадлежать двум классам: записи могут разойтись в режиме ревью и в графе влияния, и ничто не решит, какая применяется. Это `ambiguous_class`, и валидатор его отвергает.
- Граф влияния обязан быть ациклическим. Цикл сделал бы замыкание бесконечным либо произвольным, а «произвольное» здесь означает, что часть одобрений переживёт изменение, от которого они зависели.
- `registry_digest` входит в runtime lock и вычисляется канонически: список классов — множество, поэтому перестановка не считается изменением, а файл при этом обязан быть записан отсортированным.
- Источники: issue #14; критерии приёмки — в разделе 10 контракта; валидатор `scripts/validate-artifact-registry.mjs` и 21 тест.

## ADR-032: canonical finding registry вместо синтеза панели прозой

- Решение: четыре ответа панели превращаются в одно решение детерминированным конвейером, а не сводкой. Raw findings по местам, канонический merge с сохранением всех originator'ов, triage с обязательным citable basis для отклонения и понижения, contest ко всем originator'ам до любых правок, и вычисляемый gate. Контракт: `docs/contracts/finding-registry.md`, схема `resources/finding-registry/finding-registry.schema.json`.
- Альтернатива 1 — оставить `synthesize_panel` как прозу. Отклонена: одни и те же четыре ответа сводятся двумя разными способами, и в записи не остаётся, какой был применён. Воспроизводимость теряется именно здесь.
- Альтернатива 2 — брать среднюю или наиболее частую severity. Отклонена: тогда четыре рецензента могут «доспорить» находку до более мягкой, чем сообщил любой из них. До triage severity — **максимум** из сообщённых.
- Альтернатива 3 — считать молчание согласием. Отклонена: место, не ответившее в окне contest, теряет своё окно, но подтверждённую находку это не закрывает. Отсутствие — не согласие.
- Обоснование: merge обязан быть функцией самих находок и ничего больше, поэтому ни одна raw finding не может остаться вне канонической — валидатор отвергает реестр, потерявший ответ рецензента. Отклонение или понижение без ссылки на anchor, принятое решение или конкретное фактическое доказательство не допускается: несогласие разрешено, несогласие без ссылки — нет.
- Gate вычисляется, а не заявляется: ноль открытых подтверждённых critical/high, у каждого подтверждённого medium — `fixed` либо `deferred`, отложенный medium создаёт tracked debt Ticket. Находка закрывается только диспозицией повторного ревью; факт внесения правки диспозицией не является.
- Поздние находки различаются по состоянию работы: critical/high по текущему scope переоткрывает pass; неинтегрированный Ticket проходит fix→verify→review; интегрированный код получает correction Ticket от текущей канонической базы; закрытый Epic — отдельный change issue. Находка по вытесненной идентичности записывается и не блокирует текущего кандидата.
- Одиночное Code Review использует ту же модель с одним originator: ревью с одним рецензентом — не другой процесс, а этот же с меньшим множеством.
- Источники: issue #16; критерии приёмки — в разделе 11 контракта; валидатор `scripts/validate-finding-registry.mjs` и 24 теста.

## ADR-033: результат модели — доказательство, а не действие

- Решение: каждый model-owned шаг устроен одинаково: ровно одна структурированная сдача результата, валидация по закрытой схеме, повторная проверка project/anchor/runtime/protocol, сверка заявленных путей с фактическим состоянием Git и файловой системы, неизменяемая запись с read-back, детерминированный выбор перехода и ровно один `ctx.transit`. Семь закрытых видов результата. Контракт: `docs/contracts/model-result.md`, схема `resources/model-result/model-result.schema.json`, таблица возможностей `resources/model-result/role-capabilities.v1.json`.
- Альтернатива 1 — дать моделям обычные mutating-инструменты и полагаться на инструкцию. Отклонена: правило, которое модель может не выполнить, не является гарантией. Ни одна роль не получает `autosk task/step/comment/metadata` — это отсутствие инструмента, а не просьба им не пользоваться.
- Альтернатива 2 — позволить результату называть следующий шаг. Отклонена: модель, называющая свой переход, двигает задачу окольным путём. Поля для этого нет, и схема, будучи закрытой, его отвергает.
- Альтернатива 3 — считать успехом exit `0` или свободный текст. Отклонена дословно критериями: exit `0` — не результат, свободный текст — не результат, а невалидный или отсутствующий результат не снимает блокеров и не создаёт PASS.
- Обоснование: заявленные изменённые пути сверяются с Git — заявление не является доказательством самого себя. Отказ на любом этапе оставляет задачу там же, где она была.
- Verification batch сохраняет закрытую таксономию #24: сбой инструмента или неопределённый исход **никогда** не отображается в продуктовую диспозицию. «Стенд сломался» и «продукт неверен» — разные факты, и таблица переходов, их смешивающая, изготавливает вердикты, которых никто не выносил. Доказательство применения мутаций, зелёный контроль и расписка о восстановлении требуются для PASS, но не для провалившегося прогона, который мог упасть до восстановления.
- Цена: набор видов результата и таблица возможностей закрыты, поэтому новая роль или новый вид требуют явного изменения контракта.
- Источники: issue #18; критерии приёмки — в разделе 12 контракта; валидатор `scripts/validate-model-result.mjs` и 19 тестов.

## ADR-034: execution base Ticket'а как состояние, а не расписание

- Решение: у каждого Ticket есть записанный `execution_base`: `planning_head` плюс approved deltas всех транзитивных предшественников в стабильном топологическом порядке. Рабочая копия создаётся только после проверки точного commit и tree. Контракт: `docs/contracts/execution-base.md`, схема `resources/execution-base/execution-base.schema.json`.
- Проблема, которую это закрывает: ребро зависимости планирует время запуска, но само по себе не переносит код предшественника в Git-базу зависимого Ticket. `T2 depends_on T1` мог быть собран от `planning_head`, где коммита `C1` нет, и исполнитель узнавал об этом, не найдя API, который план велел использовать. DAG оставался графом расписания, а не сборки состояния.
- Альтернатива 1 — вычислять замыкание из живого графа. Отклонена: два прогона одного Epic тогда могут дать разные базы. Замыкание считается из **замороженного** манифеста.
- Альтернатива 2 — сортировать порядок композиции. Отклонена, и это отличает данный digest от остальных в этом репозитории: множества там сортируются, здесь — нет. Diamond, применённый в двух порядках, даёт два дерева, поэтому два порядка — это две базы, и digest, скрывший бы это, заявлял бы детерминизм, которого у композиции нет.
- Альтернатива 3 — разрешать модели сводить семантический конфликт предшественников. Отклонена: это решение, а модель его принимать не просили. Конфликт, отсутствующая привязка или несовместимые пересекающиеся deltas уходят в `human`.
- Обоснование: изменение любого предшественника сдвигает digest базы, поэтому аннулирование потомков механично, а не основано на оценке «изменение выглядело небольшим». Создание композиции идемпотентно: падение после создания объекта, но до записи метаданных, не создаёт вторую базу и не теряет объект.
- Пользовательский target ref при композиции не двигается вообще.
- Источники: issue #7; критерии приёмки — в разделе 11 контракта; валидатор `scripts/validate-execution-base.mjs` и 16 тестов.

## Оставшиеся риски, не решения

1. Daemon workflow custody отклоняет model-side operational writes; OS-level read-only mount остаётся defense-in-depth для project store. Если измерения покажут side channel вне daemon API, добавить container mount отдельным этапом.
2. block/enroll и остальные child-task операции остаются многошаговыми, поэтому receipts и crash-matrix обязательны. Сам create становится идемпотентным через atomic daemon-owned creation_key+binding hash; полный write API рассматривается после MVP.
3. Pi auth check не понимает custom Cursor/Claude provider state. Готовность этих маршрутов подтверждается только live synthetic calls.
4. autosk не замораживает workflow graph. Protocol bytes будут pinned; исчезновение workflow/step корректно паркует task в human, но полная graph snapshot остаётся возможным будущим core enhancement.
5. autoskd использует общий FIFO worker pool для всех проектов. Изоляция и correctness не зависят от порядка, но равная latency между проектами не гарантируется; admission limit нужен только после измерения реального starvation.
