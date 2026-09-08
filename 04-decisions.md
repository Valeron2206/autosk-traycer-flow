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

## ADR-035: интегрируется approved delta, а не полное дерево

- Решение: рецензируемая единица интеграции — неизменяемая `approved_delta` между точным base tree Ticket'а и reviewed candidate tree, ограниченная объявленным pathspec. Контракт: `docs/contracts/approved-delta.md`, схема `resources/approved-delta/approved-delta.schema.json`.
- Проблема: полное сравнение деревьев спрашивает «равно ли staging-дерево reviewed-дереву», и для второго независимого Ticket ответ — нет. Не потому, что что-то не так, а потому, что approved-работа первого уже там. Проверка сообщала о различии, которым является **наличие одобренной работы**, — ложный отрицательный ровно на том случае, ради которого DAG и существует.
- Delta — это больше, чем patch, и список полей не украшение. Каждый элемент — способ, которым два «одинаковых» изменения различаются по эффекту: смена режима `100644 → 100755` не имеет текстовой разницы вообще; symlink (`120000`) и обычный файл с теми же байтами — разные объекты; у бинарного blob нет осмысленной текстовой формы; gitlink (`160000`) указывает на коммит в другом репозитории; переименование с тем же blob — настоящее изменение, которое content-only взгляд видит как ничто.
- Интеграция доказывает не «применилось чисто» — это утверждение об инструменте, — а шесть утверждений о результате, из которых решающее четвёртое: разрешение конфликта не создало непроверенных байтов. Конфликт, разрешённый порождением нового содержимого, порождает байты, которых никто не рецензировал, и никакая аккуратность выбора не делает их рецензированными.
- Delta перепроверяется относительно staging base **в момент применения**, а не в момент одобрения: сдвинувшаяся база — другая база.
- Отказ, а не обход: коллизия с ignored/untracked файлом — fail closed, и ничего не удаляется, чтобы освободить место; чужое или неопределённое движение ref классифицируется отдельно и **не ретраится** — ретрай при неизвестном состоянии превращает один неопределённый исход в два; унаследованное Git-окружение (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` и прочие) нейтрализуется до любой операции.
- Вне области: cherry-pick как скрытый запасной путь, переписывание истории, автоматическое разрешение семантических конфликтов, обращение к `traycer-protocol` во время исполнения.
- Источники: issue #8; критерии приёмки — в разделе 11 контракта; валидатор `scripts/validate-approved-delta.mjs` и 19 тестов.

## ADR-036: приватный staging Epic и единственный финальный CAS target'а

- Решение: одобренные Tickets накапливаются на приватном ref `refs/autosk/epics/<epic-id>/staging`, а пользовательская целевая ветка двигается **один раз** — после агрегатной проверки и приёмки. Контракт: `docs/contracts/epic-staging.md`, схема `resources/epic-staging/epic-staging.schema.json`.
- Альтернатива — двигать target по одному Ticket'у. Отклонена: два Ticket'а, зелёных по отдельности, могут регрессировать вместе, а к моменту интеграции второго первый уже в пользовательской ветке. «Зелёный по отдельности» не является свойством множества, и агрегатная проверка существует именно поэтому.
- Цепочка `aggregate → acceptance → CAS → post-CAS` — это четыре звена об одном дереве. Если каждое звено окажется о слегка другом дереве, будет доставлено то, что никто не проверял. Поэтому агрегат привязан к точным staging commit/tree, конфигурации проверки и instruction lock; **любое изменение staging после PASS аннулирует привязку** — PASS относится к дереву, а не к намерению; приёмка называет ту же идентичность; после CAS перечитываются OID, дерево, containment и reflog, потому что успешный CAS не является доказательством того, что ref содержит задуманное.
- Command failure и environment failure — разные исходы и записываются по-разному. Их смешение делает «тесты упали» неотличимым от «машина не смогла их запустить», а утверждением о продукте является только первое.
- Закреплённая авто-политика держится той же привязкой, что и человек: суть в привязке, а не в том, кто её дал.
- Падение после агрегатного PASS и до CAS восстанавливается **без повторного запуска модели**: повторный запуск дал бы другие байты и молча отбросил бы одобрение, которое относилось к прежним.
- Чужое движение target переводит операцию в `human` и не трогает ref: перезапись — единственный исход, который нельзя отменить повторной попыткой.
- Промежуточных подвижек target по одному Ticket'у нет — ни как оптимизации, ни как запасного пути.
- Источники: issue #9; критерии приёмки — в разделе 10 контракта; валидатор `scripts/validate-epic-staging.mjs` и 20 тестов.

## ADR-037: проекция состояния для gate-задач вместо сравнения всего файла

- Решение: read-only рецензент защищается сравнением объявленной **проекции** состояния до и после прогона плюс проверкой происхождения всего, что вне проекции. Контракт: `docs/contracts/gate-store-projection.md`, схема `resources/gate-store-projection/gate-store-projection.schema.json`.
- Оба очевидных ответа неверны. Хешировать `task.json` и `comments.jsonl` целиком — и ответ одного рецензента отвергается как mutating из-за того, что **соседнее место завершилось** или демон обновил метку времени; четыре места работают параллельно, это не краевой случай, а нормальная форма панели. Хешировать слишком мало — и рецензент или драйвер меняет управляющий anchor, идентичность кандидата, свою роль, protocol lock или вердикт соседа, и этого никто не замечает.
- Двадцать три поля неизменны на время прогона; одиннадцать могут меняться и **сами по себе** никогда не делают вердикт недействительным. Оговорка «сами по себе» работает: поле из второго списка не индульгенция, оно лишь исключено из хеша проекции и по-прежнему подлежит проверке происхождения.
- Хеш проекции отвечает на вопрос «изменились ли защищённые поля». Он не может ответить «кто изменил незащищённые», а ошибка драйвера, записавшего правдоподобно выглядящее поле, — ровно тот случай, где эти вопросы расходятся. Поэтому каждое изменение вне проекции несёт запись журнала: актор, id операции, разрешённый набор полей, дайджесты до и после, порядковый номер и привязка к проекту. Изменение, которое никто не заявил, не считается принадлежащим демону — отказ по умолчанию.
- Изменение проекции — **блокирующий не-вердикт**, а не отказ и не повтор: ответ относится к другому вопросу, чем заданный. Порядок проверок сам является частью правила: изменение проекции отвергается до того, как вообще смотрят на происхождение, потому что никакая запись журнала не может сделать изменение управляющей идентичности приемлемым.
- `comments.jsonl` соседа не сравнивается одним хешем: замороженный префикс до контрольной точки anchor'а хешируется, разрешённые host-записи после него могут расти, а поздние находки обрабатываются отдельным жизненным циклом #16 — трактовать их как нарушение проекции значило бы парковать прогон вместо маршрутизации находки. Дописывание, переписывающее прежние байты, дописыванием не является.
- Источники: issue #15; критерии приёмки — в разделе 11 контракта; валидатор `scripts/validate-gate-store-projection.mjs` и 20 тестов.

## ADR-038: clean-room E2E как обязательный release gate и матрица отказов

- Решение: утверждены архитектура чистой комнаты и матрица отказов как будущий обязательный release gate. Автономный многопроектный MVP нельзя объявить готовым по unit-тестам и разобравшемуся графу workflow. Контракт: `docs/contracts/clean-room-e2e.md`, схема `resources/clean-room-e2e/fault-matrix.schema.json`, матрица `resources/clean-room-e2e/fault-matrix.v1.json` — шестнадцать групп по семи границам.
- Комната определяется отсутствием не меньше, чем присутствием: свежий временный HOME, никаких `.traycer`, никаких Traycer skills/binaries/config/sessions, только закреплённые autoskd, дистрибутив autosk-flow, governance bundle и поддельные исполняемые файлы провайдеров, отдельные корни проектов, отсутствие сети и настоящих учётных данных, управляемые часы, идентификаторы и инжектор отказов.
- Группа отказов, сообщившая об успехе, сама по себе не доказала ничего. Четыре доказательства нужны потому, что каждое исключает свой способ не доказать ничего: `application_proof` — отказ не был применён (инжектор-пустышка, рапортующий об успехе); `red_killer` — отказ ненаблюдаем; `green_control` — наблюдение неспецифично; `restore_proof` — комната не чиста для следующего отказа. Последнее подделать проще всего, поэтому сформулировано точно: то же имя ветки при другом ref, дереве, blob'е, режиме или метаданных задачи **восстановлением не является**.
- Gate падает на `mutation_not_applied`, `green_control_failed`, `restore_failed`, `timeout` и `indeterminate`. Ни один из них не является продуктовым вердиктом и не может быть записан как таковой — правило ADR-033 здесь не ослабляется. Отказ на `indeterminate` — то же правило, прочитанное вперёд: исход, который не удалось определить, не определён.
- Каждая граница, которую пересекает поток, обязана иметь хотя бы одну группу: граница без группы — это граница, которую никто не атаковал. И каждый исход, который gate обязан отвергать, обязан быть продемонстрирован хотя бы одной группой, иначе отказ — правило, за которым ничего нет. Валидатор проверяет обе полноты.
- Набор запускается одной канонической командой в CI без провайдера, сети и учётных данных. Опциональная проверка на живом провайдере документирована и **не** запускается автоматически: gate, которому нужен живой аккаунт, не является gate, на который можно положиться.
- Источники: issue #36; критерии приёмки — в разделе 10 контракта; валидатор `scripts/validate-clean-room-e2e.mjs` и 17 тестов.

## ADR-039: перечисленная матрица платформ вместо подразумеваемой переносимости

- Решение: поддерживаемое множество перечислено, а не подразумевается. Гарантии адаптера — не переносимые факты, а то, что конкретные системные вызовы делают на конкретных файловых системах, и утверждение «no-follow на каждом пройденном компоненте» верно лишь там, где эти вызовы существуют и ведут себя ожидаемо. Контракт: `docs/contracts/platform-support.md`, схема и матрица в `resources/platform-support/`. Закрывает критерии 1, 6 и 7 issue #13; стратегия и API — ADR-028.
- Среда вне матрицы **не получает ослабленный адаптер**. Она получает парковку до первого побочного эффекта. Проверка выполняется при открытии проекта, а не после первой неудачи: к тому моменту побочный эффект уже случился, и парковка становится отчётом вместо предотвращения.
- Три уровня, и различие существенно: `supported` — проверяется в CI на каждом изменении; `best_effort` — гарантии держатся, но проверка ручная или периодическая, поэтому регрессия обнаруживается поздно, и строка это признаёт; `unsupported` — одна или несколько гарантий не могут быть предоставлены, и адаптер отказывает, а не деградирует. Строка уровня `supported` без CI-подтверждения отвергается валидатором: непроверенное утверждение — не более слабое утверждение, а непроверенное, и в таблице их легко спутать.
- Файловые системы названы отдельно от ядер, потому что одно ядро даёт разные ответы: регистронезависимые тома (APFS по умолчанию, exFAT) — два имени, различающиеся регистром, это один файл; сетевые ФС — семантика `flock` и атомарность rename не локальные, а блокировка проекта зависит ровно от них; overlay — rename может быть неатомарным между слоями. Там, где случай не покрывается, строка говорит `unsupported` и называет отсутствующую гарантию, а не пишет `best_effort` в надежде.
- Упаковка: три бинарника рядом с демоном, никогда не setuid и не setgid, никогда в мирозаписываемый каталог — мирозаписываемый каталог установки является причиной парковки, а не предупреждением, потому что содержимое можно подменить между проверкой и запуском. Дайджест helper'а записывается при установке и входит в runtime identity (#10); обновление — это новый дайджест и, следовательно, новая идентичность.
- Названо честно: SHA, снятый до `exec`, **сам по себе не закрывает окно подмены**. Сужает его то, что демон держит helper открытым всё время жизни проекта (ADR-028), поэтому окно существует один раз на проект, а не один раз на операцию.
- Источники: issue #13, критерии 1, 6, 7; раздел 9 контракта; валидатор `scripts/validate-platform-support.mjs` и 16 тестов.

## ADR-040: grant подписывается хостом, preflight выполняется при загрузке расширения

- Решение: два незакрытых критерия #11 упирались не в объём работы, а в непринятые решения; оба принимаются здесь. Контракт: `docs/contracts/creation-grant.md`, схема `resources/creation-grant/creation-grant.schema.json`.
- **Почему одной валидации недостаточно.** Grant называет проект, родительскую задачу, сессию, workflow, шаг, визит шага, операцию, дайджест контекста и срок. Демон может сверить каждое поле со своим состоянием — но вызывающий внутри этой сессии знает их все, потому что они описывают сессию, в которой он работает. Написанный от руки grant с правильными значениями проходит. Чего демон определить не может — **кто его произвёл**, а именно на этом вопросе держится возможность: держать grant должно означать, что его выпустил хост, а не что вызывающий сумел заполнить форму.
- Хост подписывает каноническую сериализацию **привязки и слотов** ключом Ed25519, который сторона модели никогда не держит. Приватный ключ живёт только в памяти демона, не пишется в проект, не передаётся в переменной окружения и не уходит в дочерний процесс: процесс модели, способный прочитать ключ, мог бы чеканить grant'ы, — то же рассуждение, по которому в ADR-033 mutating-инструменты отсутствуют, а не запрещены.
- Подписываются **и слоты**, а не только привязка: список слотов — это то, что grant разрешает, и подделыватель, способный дописать слот, создал бы ребёнка, которого хост не авторизовал, предъявив при этом верную подпись.
- Отклонены: HMAC с общим секретом (стороне модели пришлось бы держать секрет, а проверять ей не нужно), таблица nonce (состояние, которое нужно хранить и истекать, а его потеря превращается в отказ всему), доверие транспорту (между SDK и вызывающим нет границы транспорта — в этом и проблема).
- **Preflight выполняется при загрузке расширения**, до построения реестра и до регистрации workflow, а не при первом использовании. Причина та же, что ставит проверку платформы на открытие проекта: проверка при первом использовании выполняется после того, как расширение уже принято, и отказ становится отчётом о работе, которая уже роздана.
- Пока точки входа расширения не существует, это решение, ожидающее своего места вызова, и issue говорит именно так, а не делает вид, что проверка подключена.
- Проверено, а не описано: валидатор проверяет **настоящую** подпись Ed25519 над поставленным примером, а тесты подделывают grant — дописанный слот, изменённое поле привязки, подпись другим ключом, повтор после истечения — и показывают, что проверка падает. Приватного ключа в репозитории нет: для проверки достаточно публичной половины.
- Источники: issue #11, критерии 5 и 6; раздел 9 контракта; валидатор `scripts/validate-creation-grant.mjs` и 16 тестов.

## ADR-041: один замороженный design candidate и аттестация, которая не может солгать

- Решение: design pack фиксируется как один кандидат — 50 файлов с точными дайджестами, `candidate_digest` над списком путей и байтов, таблица dispositions по всем issue групп A и B из #39, и аттестация, состояние которой **вычисляется**, а не записывается. Схема и кандидат — в `resources/design-candidate/`.
- Две вещи должны быть невозможны, и это первые два негативных теста самого #39. Первое — кандидат, изменившийся между местами: валидатор перечитывает байты design pack с диска и пересчитывает дайджест каждого файла, поэтому расхождение обнаруживается проверкой, а не внимательностью рецензента. Второе — аттестация, объявляющая PASS без четырёх настоящих вердиктов: `pass` требует по одному вердикту на каждое обязательное место, на **точном** маршруте и уровне размышления, каждый — `pass`, и каждый привязан к **этому** дайджесту кандидата.
- Три места из четырёх и молчание четвёртого дают `pending_final_panel`, а не PASS. Это случай, который округляют вверх чаще всего, и он закреплён тестом.
- Пониженный effort или подменённый маршрут — не уменьшенная панель, а другая: PASS от неё отвечает на вопрос, которого никто не задавал. Четыре маршрута владельца зафиксированы в схеме перечислением, поэтому подстановка не проходит проверку формы.
- Вердикты о другом кандидате не переносятся: PASS относится к байтам.
- По SOLO_BUILD (§2 промпта владельца) промежуточные панели отложены до итоговой приёмки, поэтому текущее состояние аттестации — `pending_final_panel`. Записать здесь что-либо иное было бы ровно тем «административным изменением статуса после панели», о котором предупреждает #39.
- `deferred_after_v1` требует follow-up issue, а отклонение — citable rationale: «сделаем позже» без определения текущей безопасной семантики закрытой диспозицией не является, и это правило #39 дословно.
- Источники: issue #39; валидатор `scripts/validate-design-candidate.mjs` и 16 тестов.

## ADR-042: транскрипт сессии читается окнами, а append не имеет предела

- Решение: `read_session_transcript`, `write_session_transcript` и `append_session_transcript` переводят транскрипт сессии через адаптер границы (патч `0024`, семнадцать операций). Чтение — окнами по 4 МиБ, дозапись — без ограничения размера.
- **Почему предел стоит именно на чтении, а не на записи.** Транскрипт дописывается столько, сколько живёт сессия. Операция «весь файл целиком» обязана нести предел размера — а предел на append-only файле это потолок, до которого длинная сессия однажды дорастает, после чего её собственная история перестаёт быть читаемой. Поэтому дозапись предела не имеет, чтение разбито на окна, а `readTranscript` склеивает их, и вызывающие видят тот же целый файл, что и раньше.
- Это закрывает критерий 4 #13 («отказ не оставляет частичного доверенного состояния») там, где он в действительности был открыт. Против подменённой символической ссылкой директории `sessions/` метод `create` писал заголовок транскрипта в цель ссылки и лишь затем получал отказ на записи меты. Две поставки назад туда попадали **оба** файла и `create` **завершался успехом**; после `0022` уходил ровно один; теперь первой отказывает запись транскрипта, и в цели не остаётся ничего.
- **Следствие чанкования, которое не очевидно.** Провод — это JSON, а `encoding/json` не переносит невалидный UTF-8: он подставляет U+FFFD. Окно заканчивается там, где кончается счётчик байт, поэтому обычный случай — разрезанный пополам символ, который дошёл бы до демона молча искажённым. Хелпер останавливает окно на границе символа, отказывает при смещении внутри символа и отказывает всему, что не восстанавливается сдвигом хвоста.
- Того же правила не хватало на чтениях целых файлов, которые пересекают этот же провод: документ с испорченным байтом доходил до демона с подставленным символом вместо него. Теперь такие чтения тоже отказывают — прежним классом `not_utf8`, а не новым.
- Новые операции — это другой контракт, поэтому ревизия протокола `3`. Она сверяется точно на строке готовности; константа демона остаётся единственным местом, где записано число, а тесты читают его из исходника, потому что поддельный хелпер со старой ревизией падает на готовности по причине, не имеющей отношения к тому, что эти тесты проверяют.
- Отклонено: выравнивание окна по переводу строки. Оно выглядит естественнее для JSONL, но строка длиннее окна остановила бы чтение навсегда, а строка транскрипта — это вывод модели, у которого верхней границы нет.
- `scan()` по-прежнему на обычном `fs` по ADR-028, реестр проектов — вне адаптера по той же ADR.
- Источники: issue #13, критерий 4; патч `0024`; `internal/storelock/transcript_test.go` и `daemon/core/test/store.singlewriter.test.ts`.

## ADR-043: проект держит собственную копию байтов дистрибутива

- Решение владельца от 2026-09-08 (комментарий в issue #10): критерий 3 закрывается **двумя идентичностями** — content-addressed хранилище держит байты дистрибутива, и отдельно записывается идентичность того, что фактически исполняется. Здесь реализована первая половина: байты. Патч `0025`, область `runtime/v1/dist/`, ревизия протокола `4`.
- **Почему записи о дистрибуции было недостаточно.** Индекс уже помнил, что дайджест *означал* — каноническую опись, над которой он взят. Это не позволяет Epic'у продолжать работу. У одного глобально установленного расширения на диске ровно одна копия, поэтому обновление забирает старый код сразу у всех проектов, и проект, закреплённый на прежнем дайджесте, оказывается закреплён на том, чего ни у кого нет.
- Байты кладутся в собственное хранилище проекта, ключом служит дайджест самих байт файла. Опись уже называет каждый файл его дайджестом, поэтому для сборки дерева достаточно блобов: второй структуры, обязанной согласовываться с описью, не заводится.
- Отдельная область, а не runtime-блобы рядом. Причины — свойства данных, а не кода: дистрибутив содержит произвольные файлы (изображения, скомпилированные артефакты, `.wasm`), поэтому текстом эти байты быть не обязаны, а runtime-блобы обязаны; и исходный файл регулярно больше восьмимегабайтной записи runtime-хранилища, поэтому предел у него свой.
- Раз это не текст, по проводу они идут base64 в отдельном поле `data_b64`. Всякая другая нагрузка на этом проводе — документ, который демон сам и записал; произвольные байты JSON-строка не переносит, `encoding/json` подставляет U+FFFD. Это ровно то искажение, которое пришлось закрыть патчем `0024` для транскрипта.
- Имя блоба **есть** его дайджест, поэтому блоб, не хэширующийся в собственное имя, отклоняется и при чтении, и при записи. Это и делает удержанные байты доказательством: дистрибутив можно собрать и показать, что он тот самый, под которым задача была допущена, а не только описать.
- Удержание — утверждение «всё или ничего». Дистрибутив без одного файла не является этим дистрибутивом, поэтому неудача записывает `bytes_held: false` с причиной, а не запись, которая говорит «держу» и не держит. Отсутствующий флаг означает **не держим**, а не «неизвестно». Следующее открытие проекта пробует снова: блобы адресуются содержимым, повторное удержание идемпотентно.
- Что удаляется, решается достижимостью, а не подсчётом ссылок. Блоб сохраняется, если его называет опись какой-либо оставшейся записи, — то же правило, по которому уже вычисляется множество referenced, и по той же причине. Опись, которую эта сборка прочитать не может, сохраняет всё: «я не могу определить, что в этом дистрибутиве» не является разрешением удалить его файлы.
- Порядок при забывании: сначала пишется индекс, потом отпускаются блобы. Прерывание между ними оставляет байты, на которые никто не ссылается, — их соберёт следующее забывание; обратный порядок оставил бы запись, утверждающую, что держит файлы, которых уже нет.
- Отложено во вторую половину: подмена импорта на удержанные байты и запись `execution_digest` того, что действительно загрузилось. Здесь этого нет, и обещание не делается.
- Источники: issue #10, критерий 3; решение владельца в комментарии к #10; патч `0025`; `internal/storelock/distblob_test.go`, `daemon/core/test/store.distbytes.test.ts`.

## ADR-044: удержанный дистрибутив восстанавливается по пути, названному его дайджестом

- Решение: удержанные байты (ADR-043) собираются обратно в дерево по адресу `runtime/v1/code/<digest>/`, и это делается при открытии проекта для каждой дистрибуции, на которую закреплена открытая задача, но которую реестр сейчас не предоставляет. Патч `0026`.
- **Почему путь — функция дайджеста.** Bun ключует модульный кэш по разрешённому пути, поэтому одно глобально установленное расширение — это ОДИН модуль для всех проектов, которые его импортируют, и проект, закреплённый на прежней версии, получил бы то, что загрузил первый импортёр. Дерево на дайджест даёт каждой версии собственный путь: две версии могут быть живы одновременно, и ни одна из них не догадка.
- Дерево собирается в промежуточном каталоге, и его идентичность **пересчитывается там**, до того как оно получает имя, из которого вызывающий импортирует. Дерево, опубликованное первым и проверенное вторым, — это дерево, которое между этими двумя моментами можно импортировать.
- Проверка не церемония. Опись может быть согласована сама с собой — она хэшируется в собственный дайджест — и при этом не быть этой дистрибуцией, потому что идентичность берётся над канонической очерёдностью. Отличить их можно только пересчётом собранного дерева, и это закреплено тестом.
- Уже собранное дерево **перепроверяется**, а не принимается по имени: каталог принадлежит проекту, в него можно писать. Подменённое дерево пересобирается из блобов, а не отдаётся вызывающему.
- Два предела названы, а не подразумеваются. Опись покрывает байты и цели ссылок, но не права доступа, поэтому восстановленное дерево побайтово идентично и приблизительно по метаданным. И дистрибуция, корень которой — один ФАЙЛ (обычная форма `.autosk/extensions/wf.js`), возвращается каталогом, содержащим этот файл: каноническая опись у них совпадает, поэтому дайджест сходится.
- **Дефект, найденный по дороге в собственном предыдущем патче.** `0025` считал корень дистрибуции каталогом и читал `wf.js/wf.js`, поэтому дистрибуция из одного файла — та самая форма, которую демон и поставляет, — молча никогда не удерживалась. Исправлено здесь, с регрессионным тестом.
- Вызывающий — проверка восстановления при открытии проекта, а не при dispatch. Задача, закреплённая на дистрибуции, которой у реестра больше нет, паркуется в обоих случаях; разница в том, узнает ли оператор при открытии, что код удержан и восстановим, или при dispatch — что его нет. Обновление расширения и есть тот момент, когда это надо выяснить: к моменту dispatch старые байты могли быть уже собраны подметанием.
- Неудача восстановления не мешает проекту открыться: задача припаркована, а это безопасное состояние.
- Источники: issue #10, критерии 3 и 6; решение владельца в комментарии к #10; патч `0026`; `daemon/core/test/store.distbytes.test.ts`, `daemon/core/test/engine.runtime-identity.test.ts`.

## ADR-045: проект обслуживает ту версию, под которой допущены его открытые задачи

- Решение: загрузчик импортирует восстановленное дерево (ADR-044) вместо установленного, когда установленные байты — не те, под которыми допущены открытые задачи проекта. Патч `0027`.
- Правило из трёх частей, каждая заслуживает своего места:
  1. Проект обслуживает **установленную** дистрибуцию, когда его открытые задачи закреплены на ней или когда открытых задач нет. Это обычный случай, и он не меняется.
  2. Когда под установленными байтами не допущено ничего открытого, а проект держит ту версию, под которой допущено, — обслуживается **удержанная**. Это и означает «Project A остаётся на v1, пока Project B начинает на v2» при одной глобально установленной копии: каталог установки общий, поэтому проект, которому нельзя двигаться, не может на него полагаться.
  3. Когда закреплено **несколько** удержанных версий сразу, не обслуживается ни одна. Открытые задачи, закреплённые на разных версиях, не могут быть удовлетворены одним реестром, а выбор между ними молча предпочёл бы одни задачи другим; обслуживается установленная версия, конфликт сообщается, и затронутые задачи паркуются, а не исполняются на версии, которую никто не выбирал.
- Смешанный случай — часть задач на установленной версии, часть на прежней удержанной — сохраняет установленную по той же причине: уход с неё увёл бы задачи, которые **на ней**, с их собственного кода.
- Загрузчик **переопределяет идентичность** подставленного дерева перед импортом. Хранилище проверило дерево, когда собирало его; это загрузчик отказывается принимать это на веру для кода, который собирается исполнить.
- Он не может знать, что две версии согласны в том, где их точка входа. Удержанное дерево, в котором нет установленной точки входа, не загружается и сообщает об этом, а не угадывает.
- Хранилище, которое не может ответить ни на один из двух вопросов, оставляет установленный код на месте: нечитаемое хранилище — причина обслуживать то, что есть, а не повод уронить проект.
- Отклонено: реестр с несколькими версиями одного workflow одновременно. Это изменило бы каждого потребителя `workflow(name)` и потребовало бы, чтобы dispatch выбирал версию по закреплению задачи; правило «одна версия на проект» даёт то, чего требует критерий 6, не трогая эту структуру.
- Источники: issue #10, критерии 3 и 6; решение владельца в комментарии к #10; патч `0027`; `daemon/core/test/extensions.loader.test.ts`, `daemon/core/test/extensions.reload.test.ts`.

## ADR-046: связывающий create принимается только с session-bound токеном

- Решение владельца от 2026-09-08 (комментарий в issue #10): критерий 7 закрывается требованием токена, привязанного к сессии, на связывающих вербах. Патч `0028`, `task.creation-binding` становится **v2**.
- **Дыра была не в валидации.** Каждое поле `task.create_bound` проверяется. Но все они описывают **проект**, поэтому create, сделанный моделью изнутри сессии, был неотличим от набранного в терминале, — а неатрибутируемый create не может нести runtime identity, под которой сессия была допущена. Собственная запись демона о том, «какой код породил эту задачу», просто обрывалась на этой границе.
- Токен — 256 бит случайности, живущие только в процессе демона. Он не пишется в проект, не выводится ни из чего угадываемого и **перестаёт существовать в момент, когда сессия завершается**: утёкший из завершённой сессии токен уже бесполезен — свойство, которого одна лишь подпись не даёт.
- Токен называет сессию в **одном** проекте. Принимать его в другом значило бы сделать его ключом ко всем проектам, открытым демоном.
- Отсутствующий, неверно типизированный и неизвестный токен — **один** отказ (`creation_unbound_call`), а не три. На проводе они означают одно и то же — вызывающий не привязан, — и различать их значило бы сообщать зондирующему, какая из его догадок была лучше оформлена.
- Путь: сессия отдаёт токен агенту как `ctx.sessionToken`, агент кладёт его в окружение потомка как `AUTOSK_SESSION_TOKEN` рядом с `AUTOSK_CWD`, Go-клиент отправляет его **только** на этом вербе — это секрет, и остальной части API он не нужен.
- Резервация записывает `created_by`: идентификатор сессии и идентичность, под которой она была допущена. `null` там означает «у сессии не было допуска»; **отсутствие** `created_by` означает «сессию никто не записал». Это разные утверждения, и парсер отказывает записи, которая их смешивает.
- **v2, а не добавление поля.** Обязательный новый параметр — это новая ревизия: вызывающий, написанный под v1, токена не шлёт, и каждый его вызов теперь отклоняется. Capability, версия которой не сдвинулась, позволила бы такому вызывающему считать себя поддержанным и выяснять обратное по одному отказу за раз.
- Цена, принятая владельцем: прямой вызов CLI `autosk` вне какой-либо сессии больше не создаёт связанную задачу.
- Отклонено: подписывать вызов ключом демона (ADR-040). Подпись доказала бы авторство, но не то, что сессия **ещё идёт**; отзыв при завершении — это ровно то свойство, которое здесь требуется.
- Источники: issue #10, критерий 7; решение владельца в комментарии к #10; патч `0028`; `daemon/core/test/engine.sessionToken.test.ts`, `daemon/core/test/rpc.creation.test.ts`, `daemon/core/test/store.creation-index.test.ts`, `internal/daemon/rpcclient/creation_test.go`.

## ADR-047: дайджест хелпера входит в runtime identity и расхождение паркует задачу

- Решение владельца от 2026-09-08: критерий 5 #13 закрывается строго — дайджест байт хелпера записывается в идентичность, под которой допущена задача, и расхождение **паркует** задачу до явной миграции. Патч `0029`.
- Ревизия протокола уже ловит изменившийся **контракт**. Это ловит изменившиеся **байты за неизменившимся контрактом**: тот же хелпер, говорящий на том же протоколе, собранный из другого исходника. Он — единственный писатель доверенного состояния, поэтому допустить задачу под одной сборкой и исполнять под другой это ровно та подмена, ради предотвращения которой существует вся остальная идентичность.
- Дайджест берётся с байт на диске по тому пути, который демон и запустил бы, и кэшируется по **сигнатуре самого файла**, а не по пути. Кэш по пути на время жизни процесса сообщал бы байты, которые были при старте, тогда как следующий запуск использовал бы те, что на диске, — дайджест, описывающий то, что никто не исполняет.
- Pin без дайджеста хелпера отвечается **точно так же**, как pin без графа: «предшествует проверке» и «поле удалили» неразличимы на задаче, которая уже несёт workflow, поэтому перезапуск переоформляет допуск, а всё остальное отказывает.
- Хелпер, которого нельзя прочитать, — это **отказ, а не падение**. Единственный вопрос, на который отвечает это решение, — можно ли задаче исполняться прямо сейчас; когда доверенного писателя нельзя даже опознать, ответ «нет», а исключение уронило бы вызывающего вместо парковки задачи.
- Отклонено (вариант, предложенный владельцу и им отвергнутый): записывать дайджест и только сообщать о расхождении. Запись без действия — это описание, а не гарантия, и она оставила бы задачу исполняться на другом писателе.
- Цена: обновление хелпера останавливает открытые задачи проекта до явного переоформления допуска. Это осознанный выбор владельца.
- Источники: issue #13, критерий 5; решение владельца от 2026-09-08; патч `0029`; `daemon/core/test/engine.runtime-identity.test.ts`.

## ADR-048: расписка записи артефакта вычисляет свою фазу и не становится вторым журналом статусов

- Решение: контракт расписки записи для issue #22 — `docs/contracts/artifact-write-receipt.md`, закрытая схема `resources/artifact-write-receipt/artifact-write-receipt.schema.json`, два рабочих примера, валидатор и 16 тестов.
- **Почему записи файла и `git status` недостаточно.** Они устанавливают, что *какие-то* байты сейчас там лежат. Шесть способов, которыми это отличается от «записаны те байты, которые предполагались», перечислены в самой issue и не экзотичны: обрыв, оставивший временный файл; синхронизация или форматтер платформы, переписавшие файл после записи; oversize или special-файл, принятый как обычный; метаданные задачи говорят «готово», а байты другие; конкурентный писатель затёр пользовательский файл; устаревшая pending-запись после перезапуска сочтена завершённой.
- Расписка существует **с фазы pending**, а не только при успехе. Расписка, появляющаяся только при удаче, не может описать случай, ради которого она и нужна, — запись, остановившуюся на полпути.
- **Фаза вычисляется из свидетельств в самой расписке, а не объявляется.** Расписка, несущая дайджест обратного чтения, не равный предполагаемому, не является verified, что бы она о себе ни говорила. Это закреплено тестом, и именно этот случай был бы отчётом об успехе там, где произошёл ровно тот отказ, ради которого расписка и заводится.
- **Расписка — не второй журнал статусов задачи** (критерий 6 #22). Она записывает **одну запись**: что предполагалось, что легло, согласуются ли они. У схемы нет полей `status`, `step`, `task_id`, и отсутствие поля сильнее договорённости его не писать. Проверяется по схеме, а не по примерам: пример без поля ничего не говорит о следующей расписке.
- **Карантин не уничтожает источник.** Карантин, удаляющий то, что не смог классифицировать, — это путь потери данных под именем безопасности. Путь карантина принадлежит проекту и никогда не является каноническим путём артефакта. Диспозиция — человеческая (`inspect`, `transform`, `reject`, `restore`), автоматического освобождения нет: всякое автоматическое освобождение — это решение о политике, принятое без того, кто несёт последствия.
- **«Побеждает последний писатель» отвергнуто.** Четыре источника могут расходиться: канонические байты и коммит, метаданные задачи, расписка, временный вывод модели. Выбирать самый свежий — значит выбирать тот процесс, который случайно закончил последним, то есть ровно тот отказ, который и диагностируется. Расхождение **паркует** workflow с отчётом, обязанным назвать **все четыре** источника, включая согласившиеся: отчёт, перечисляющий только выпадающий, не может быть проверен читателем, который ответа ещё не знает.
- Политика размера и режима **закреплена в расписке**, а не живёт в коде: политика, известная только сборке, сделала бы расписки разных сборок несравнимыми, а сравнимость позже — это и есть смысл расписки.
- Отложено и названо, а не подразумевается: сам адаптер, его операции хелпера и драйвер, применяющий предложенные моделью байты. Это runtime-работа, и контракт — то, против чего она будет строиться.
- Источники: issue #22; валидатор `scripts/validate-artifact-write-receipt.mjs` и 16 тестов; класс `artifact_write_receipt` в реестре #14.

## ADR-049: адаптер записи артефакта и третье состояние примирения

- Решение: запись канонического артефакта идёт через границу #13 — патч `0030`, две новые операции хелпера, ревизия протокола `5`. Контракт ADR-048 получил третье состояние примирения — `unreconciled`.
- **Условная запись.** `expected_previous` говорит, чем destination обязан быть **до** записи. Вызывающий, который не может сказать, что он замещает, — это вызывающий, который не заметит, что заместил что-то другое.
- **Обратное чтение — не перестраховка.** Агент синхронизации платформы или форматтер могут переписать файл через мгновение после записи, и единственный способ утверждать, что на диске предполагавшиеся байты, — посмотреть на них **после** публикации, а не довериться тому, что запись вернулась без ошибки.
- Каждый компонент пути открывается без следования по ссылке. Подменённый каталог где угодно на пути отвергается, а не отправляет запись в другое место, отчитываясь проектно-относительным именем.
- **Три названных предела, а не подразумеваемых.** По пути ничего не создаётся: отсутствующий родительский каталог — отказ, потому что создание каталогов по дороге к записи превращает опечатку в новое дерево. Хранилище недостижимо как артефакт: запись в `.autosk/` отсюда обошла бы все правила, которые соблюдают собственные операции хранилища. Oversize на этом слое — **отказ, а не карантин**: карантину нужно куда-то положить байты и записать куда, и расписка, говорящая `quarantined` до того, как это существует, описывала бы файл, которого никто не писал.
- **`unreconciled` — исправление собственного контракта, а не расширение.** Запись, которая легла и была перечитана, установила, что на диске, и ничего о трёх остальных источниках. Двухсостоянийная форма, с которой контракт был поставлен, не имела способа это сказать — и заставила бы свежую расписку заявить `agreed`, то есть сверку, которой никто не делал. Расписка остаётся `unreconciled` до сверки и `verified` не бывает.
- **Найденное по дороге:** валидатор искал ветку `diverged` по позиции в `oneOf`. Добавление состояния сдвинуло её, и две проверки замолчали бы. Теперь ветка ищется по тому, что она **говорит**, а не по тому, где стоит.
- Класс отказа читается из классифицированного кода хелпера, а не из сообщения: переформулированное сообщение не должно быть изменением поведения, и это третье место в этом репозитории, где чтение сообщения им бы стало.
- Не сделано и не заявлено: карантин, сверка четырёх источников, персистентность расписок и драйвер, применяющий предложенные моделью байты.
- Источники: issue #22, критерии 1, 2, 4, 7, 8; патч `0030`; `internal/storelock/artifact_test.go`, `daemon/core/test/store.artifacts.test.ts`.

## ADR-050: внешний источник получает собственную идентичность и снимок, который нельзя подменить ремонтом

- Решение: контракт снимка внешнего источника для issue #21 — `docs/contracts/external-source-snapshot.md`, закрытая схема, два рабочих примера, валидатор и 15 тестов. Класс `external_source_snapshot` добавлен в реестр #14.
- **Почему Git-идентичности недостаточно.** Не всякий нормативный вход лежит в Git: загрузки, внешние спецификации, экспорты API, скриншоты, сгенерированные отчёты и миграционные входы бывают изменяемыми и вне контроля версий, и tree OID о них не говорит ничего. Если место читает живой файл, следуют пять вещей: байты могут отличаться между местами; PASS не привязан к воспроизводимой версии; источник может исчезнуть или быть подменён ссылкой; у бинарника, изображения и PDF нет надёжной текстовой идентичности; уборка может удалить единственное доказательство.
- **Два дайджеста, а не один.** Записываются `snapshot_sha256` и `read_back_sha256`. Снимок, который никогда не перечитывали, доказывает, что запись вернулась, а не что байты на месте.
- **Где снимок жить не может.** Не внутри transient evidence root с коротким retention — это правило нарушается по невнимательности чаще прочих, потому что каталог доказательств ровно то место, где снимок выглядит уместным, и retention из #27 удалил бы единственную копию нормативного входа.
- **Дедупликация по содержимому допустима, но записи происхождения остаются раздельными.** Два источника, у которых случайно совпали байты, — всё ещё два источника, и слияние их записей лишило бы позднего читателя возможности сказать, откуда взялся любой из них.
- Бинарные байты хешируются **без текстовой нормализации**: дайджест, зависящий от концов строк, не является идентичностью PNG.
- Источник под чужим project root нельзя присоединить без явной операции импорта, записывающей смену владения. Прочитать чужой файл и назвать его своим — это тот отказ, который операция импорта и предотвращает.
- **Ремонт использует записанную идентичность, а не свежий источник.** Повторная чеканка молча подставила бы сегодняшние байты вместо тех, о которых был вердикт, — ровно тот отказ, ради предотвращения которого контракт существует, пришедший через путь ремонта.
- Строка таблицы дрейфа, которая протекает, названа: «ненормативное изменение не влияет **только** при детерминированном доказательстве». «Это же просто комментарий» — суждение; детерминированное доказательство — правило, дающее один и тот же ответ всем. Без него ненормативное изменение обрабатывается как нормативное.
- Чеканка снимка не должна делать проверяемое рабочее дерево грязным: чеканка, меняющая то, что проверяется, изменила предмет, который должна была описать.
- Отложено и названо: сама runtime-чеканка и проверка, операция импорта и хук ворот, выполняющий проверку дрейфа.
- Источники: issue #21; валидатор `scripts/validate-external-source-snapshot.mjs` и 15 тестов.

## Оставшиеся риски, не решения

1. Daemon workflow custody отклоняет model-side operational writes; OS-level read-only mount остаётся defense-in-depth для project store. Если измерения покажут side channel вне daemon API, добавить container mount отдельным этапом.
2. block/enroll и остальные child-task операции остаются многошаговыми, поэтому receipts и crash-matrix обязательны. Сам create становится идемпотентным через atomic daemon-owned creation_key+binding hash; полный write API рассматривается после MVP.
3. Pi auth check не понимает custom Cursor/Claude provider state. Готовность этих маршрутов подтверждается только live synthetic calls.
4. autosk не замораживает workflow graph. Protocol bytes будут pinned; исчезновение workflow/step корректно паркует task в human, но полная graph snapshot остаётся возможным будущим core enhancement.
5. autoskd использует общий FIFO worker pool для всех проектов. Изоляция и correctness не зависят от порядка, но равная latency между проектами не гарантируется; admission limit нужен только после измерения реального starvation.
