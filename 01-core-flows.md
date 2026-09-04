# Core Flows

## 1. Вход и классификация

Пользователь создаёт задачу обычным сообщением. Координатор Opus фиксирует цель, применимые прошлые уточнения и границы, затем выбирает маршрут.

### Quick

Используется только когда одновременно выполняются условия:

- результат и границы однозначны;
- нет нового продуктового поведения или архитектурного выбора;
- не затрагиваются API-контракты, схема данных, безопасность, конкурентность или миграция;
- отдельные Brief, Core Flow, Tech Plan и комплект Tickets не нужны.

Маршрут:

~~~text
intake
  -> implementation
  -> verification
  -> freeze candidate
  -> cross-family code review
  -> human accept
  -> deterministic integration
  -> cleanup
~~~

Чисто редакционная Quick-правка может пропустить Code Review только через deterministic editorial classification с exact candidate identity и changed path set. Exemption запрещён для executable code, config/schema/security, prompts, governance bundle и любого behavior-defining документа. Любое другое изменение сохраняет независимую проверку, если пользователь явно её не отменил.

Quick classification проверяется не только на intake, а перед каждым переходом из implementation, verification, fix, freeze, review-result, accept и в integrate prologue до первого Git side effect. Completion/evidence records обязаны перечислять новые material questions и Planned-triggers. Если обнаружены behavior/API/schema/security/concurrency/migration изменения, неясная граница либо material scope expansion, `invalidate_quick_classification` запрещает дальнейшие Quick side effects и идемпотентно создаёт project-bound Planned replacement от исходного base. Текущий worktree передаётся replacement по exact ownership/evidence receipt и остаётся непроверенным, а не code candidate. Старый Quick получает `superseded_by`, outcome=reclassified и не может commit/integrate; грязный worktree не удаляется автоматически. Обычное расширение scope через `implementation_scope_invalid` допустимо только пока повторная классификация остаётся Quick.

### Planned

Используется, если присутствует хотя бы одно из следующего:

- новая возможность или заметное изменение поведения;
- несколько акторов, состояний, ветвей или способов отказа;
- архитектурный, API-, data-, security-, concurrency- или migration-выбор;
- несколько независимо проверяемых частей;
- неясные границы или дорогая ошибка.

### Параллельные проекты

До classification координатор разрешает ровно один canonical project root и project identity. Все создаваемые задачи, документы, worktree, sessions, snapshots и evidence получают эту identity.

Разные проекты могут выполняться одновременно через общий autoskd worker pool, но их графы не соединяются:

- parent/child и blocker edges допустимы только внутри одного проекта;
- проектный Brief/Core Flow/Tech Plan/Tickets пишутся только в Git этого проекта;
- provider session не переиспользуется между проектами;
- daemon policy projection и authority records принадлежат только своему project root;
- остановка, correction или cleanup проекта A не меняют задачи и файлы проекта B.

Если один пользовательский запрос затрагивает несколько репозиториев, координатор создаёт отдельный project-scoped Epic для каждого. Каждый Epic хранит общий opaque UUID correlation ID только для display/audit. Он не содержит и не разрешает task/session/evidence/path другого проекта; runtime не использует его для lookup, blockers, joins или recovery. Общего Ticket, общей session или общего mutable документа между проектами нет.

## 2. Адаптивное планирование

Полный граф возможностей:

~~~text
intake / classify
  -> Brief?       -> human framing alignment -> draft -> panel/fix/re-review -> record PASS -> publish planning commit
  -> Core Flow?   -> human behavior alignment -> draft -> panel/fix/re-review -> record PASS -> publish planning commit
  -> Tech Plan    -> human readiness alignment -> draft -> panel/fix/re-review -> record PASS -> publish planning commit
  -> Arena?       -> candidates -> Judge recommendation -> human readiness alignment
                  -> Decision Record / changed Tech Plan -> new full panel -> record PASS -> publish planning commit
  -> Tickets      -> draft + dependency view -> human breakdown alignment
                  -> separate panel/fix/re-review -> record PASS -> publish planning commit
  -> candidate_audit_transfer_op -> audit_ref_verified -> live_ref_deleted -> verified -> select_next
  -> verified planning_head
  -> ticket DAG execution
~~~

Brief и Core Flow пропускаются только по objective classification. Tech Plan и Tickets обязательны для Planned; запрос без нужды в Ticket breakdown относится к Quick. Если артефакт создан, его panel policy применяется автоматически.

### Brief

Нужен для новой инициативы, неоднозначной цели, существенной границы scope или нескольких заинтересованных сторон. Отвечает на «что», «зачем», «для кого», «что не входит» и «как выглядит успех». Технических решений не содержит.

### Core Flow

Нужен при пользовательском поведении, состояниях, ветвях, ошибках и взаимодействии нескольких акторов. Фиксирует вход, действия, реакции системы, выходы и сценарную матрицу. Файлы, классы и технический стек не описывает.

### Tech Plan

Нужен, когда реализация должна принять техническое решение. Фиксирует компоненты, границы, интерфейсы, данные, безопасность, конкурентность, миграцию, проверку, эксплуатацию и откат. Не может молча изменить Brief или Core Flow.

### Tickets

<!-- tickets-manifest-contract:v1 -->

Создаются как вертикальные независимо проверяемые части. Каждый Ticket ссылается на exact published Brief/Core Flow/Tech Plan/Decision/Verification authority, содержит scope in/out, closed file/directory selectors, зависимости с rationale, observable acceptance criteria с evidence bindings, work type, impacts, review policy и rollback.

Один canonical `tickets.manifest.json` является runtime-истиной set/DAG. `README.md` и `Txx-*.md` генерируются pinned renderer из manifest и побайтово сверяются до freeze. Свободный Markdown, task title/comment или live worktree не используется для создания child/blocker edges. Host-owned `TicketsValidationReceipt` связывает exact manifest/DAG/rendered-set/Ticket-entry digests с planning parent, candidate tree, alignment, protocol/runtime/instruction identities.

Весь manifest и его rendered views проходят одной frozen identity через отдельную четырёхмодельную Ticket Panel. После PASS issue #5 публикует их одним descendant planning commit. Только verified publication commit/head и current receipt разрешают manifest-only `dispatch_ticket_dag`. Полный контракт находится в `docs/contracts/tickets-manifest.md`.

### Публикация утверждённых артефактов в planning ref

<!-- planning-ref-contract:v1 -->

У каждого Planned Epic есть одна приватная append-only линия `refs/autosk/epics/<epic_ref_key>/planning`. `epic_ref_key` — lowercase SHA-256 canonical project/Epic identity, а не display ID или пользовательский slug. Линия инициализируется exact recorded base до первого planning draft. Каждый следующий author worktree строится только от verified head этой линии.

До panel/waiver host сохраняет полную commit/tree/blob closure в helper-owned quarantine pack, затем создаёт `refs/autosk/epics/<epic_ref_key>/candidates/<candidate_identity>` на frozen snapshot commit. После verdict daemon capability v1 одной metadata CAS записывает recorded PASS, immutable `planning_publication_op` и подготовленные helper intents; recorded PASS не завершает artifact kind. `publish_artifact_pass` создаёт single-parent commit, CAS-продвигает planning ref и проверяет closure. Затем монотонный `candidate_audit_transfer_op` сначала создаёт/проверяет audit ref, пока live keepalive остаётся, потом отдельной expected-old CAS удаляет live и финально проверяет audit-present/live-absent. Только verified transfer создаёт Published PASS и разрешает `select_next`; audit ref хранится до approved retention expiry.

recorded PASS не является завершённым артефактом до verified Git publication и verified audit transfer.

Если process падает между exact recipe persist/read-back, object write, phase write, CAS, reflog receipt или metadata finalization, retry продолжает ту же operation, те же commit bytes и тот же expected commit OID. Ref/reflog, отличные от expected checkpoint/transition, включая move-away-and-back, считаются foreign movement и паркуют Epic с `planning_ref_foreign_movement`; rebase/reset/force/adopt-current запрещены. Candidate, созданный не от current verified head, получает `planning_candidate_base_stale` до panel. Drift до ref movement терминально закрывает operation как `voided_before_ref`; drift после доказанного CAS требует descendant invalidation.

Anchor rebuild не перемещает ref назад. Approved impact сначала публикует descendant invalidation commit через тот же CAS adapter, затем новые версии артефактов становятся следующими descendants. Прежние accepted bytes остаются в ancestry, но stale projection не остаётся current. После verified Tickets publication полученный commit становится `planning_head`, от которого issue #7 построит Ticket execution bases, а issue #9 — private staging. Пользовательская target branch на этой стадии не меняется.

Полный нормативный контракт, operation schema, recovery table, retention и test matrix находятся в `docs/contracts/epic-planning-ref.md`.

### Согласование решений человеком

В Planned-flow согласование человеком и модельная проверка — разные gates. Согласование отвечает на вопрос «это действительно решение пользователя?», а панель проверяет качество уже разрешённого решения. Модель не может одобрить своё предложение от имени пользователя и не может спрятать материальную неоднозначность в списке assumptions.

| Артефакт | Что предъявляется до продолжения | Когда разрешён следующий шаг | Причина остановки |
| --- | --- | --- | --- |
| Brief | цель/результат/affected/why/scope/non-goals/success/open questions как non-normative proposal + material decision manifest | framing/manifest подтверждены daemon `UserDecisionRecord`; policy не утверждает product framing | `brief_alignment_required` |
| Core Flow | полный behavior proposal: actions/states/happy/unhappy/errors/retry/cancel/partial success/rights/reactions + manifest | каждое material product решение manifest закрыто daemon `UserDecisionRecord` | `core_flow_decision_required` |
| Tech Plan | readiness + proposal manifest: open questions, alternatives, silent inferences, closed и планируемые material decisions | manifest подтверждён daemon record либо policy только для classifier-proven local/reversible rule | `tech_plan_readiness_required` |
| Tickets | полный набор, dependency graph, scope и independently verifiable outcome каждого Ticket, порядок/параллельность и exclusions | material breakdown подтверждён daemon record до Ticket Panel; policy может покрыть только scheduling при byte-identical set/scope/outcomes/dependencies/exclusions | `tickets_breakdown_alignment_required` |

Brief, Core Flow и Tech Plan до approval существуют только как structured proposal/`material_decision_manifest`, не нормативные prose bytes. Каждый artifact содержит ровно один fenced `autosk-material-decisions` JSON block; behavior-defining sections ссылаются только на его stable decision IDs. Prompt compiler/Tickets используют block, а unreferenced prose не является material authority и не попадает в implementation constraints. После draft deterministic projector парсит exact block/section refs и сравнивает с approved manifest. Missing/new/changed/unknown decision ID или unmapped normative section stales alignment и возвращает clarify; только byte-equivalent projection либо classifier-proven local/non-material additions допускают freeze. Тот же check повторяется после Arena/fix. Tickets используют полный breakdown/manifest до Ticket Panel.

`UserDecisionRecord` создаёт только autoskd после signed user-presence challenge. Project public-key pin создаётся trusted client при project init до model task и write-once. Daemon canonicalizes exact object `{project_root_sha256,record_id,nonce,expires_at,request_id,epic_id,task_id,anchor_version,subject_hash,payload_hash,previous_secure_head_hash,journal_sequence}`; `epic_id`/`task_id` всегда присутствуют как string или `null`, omission запрещён. Signature считается над domain separator + canonical bytes, которые сохраняются в record. Daemon commits authority+nonce heads before returning record/projection/effects.

Recovery: valid crash-tail is byte-verified then authority+nonce heads commit before projection; invalid tail had no effects/nonce reuse. Missing committed bytes fail-closed. Dependency/intent heads protect projections. Signer/secure state must be in a preflight-proven separate OS boundary or hardware enclave inaccessible to model accessibility/ptrace/keychain; no boundary, headless or unpinned project blocks model launch.

Модель может подготовить packet и recommendation, но обычная daemon connection без signature не создаёт `actor=user`. Git Decision Log/comment служит только человекочитаемым зеркалом, если его hash уже связан с signed daemon record; bare Git/comment bytes не являются approval source. Тот же канал обязателен для policy issuance/revocation, waiver, anchor-impact/supersedes approval и integration acceptance.

Каждый alignment record неизменяемо связывает `project identity + epic_id + artifact kind + anchor version + scope hash + subject hash + material_decision_manifest hash + UserDecisionRecord ID/hash/provenance + classifier/projector proof + current policy disposition|null + protocol hash`. Tickets manifest включает files/DAG/scopes/outcomes/order/exclusions; Tech Plan — readiness и все планируемые material decisions. Authority record, optional Git mirror, classifier/projector и policy proof входят в controlling anchor pack.

Изменение ответа, subject, classifier, scope, policy disposition или anchor делает record stale. Correction создаёт новую anchor version, проходит impact analysis и аннулирует затронутые candidate/verdict/PASS bindings; незатронутое можно перепривязать только через daemon-attributed impact record. Bare resume без current daemon decision record не проходит gate.

Обычные локальные, обратимые и нематериальные implementation choices не входят в alignment packet и не требуют вопроса пользователю. Autonomous policy нужна только для заранее перечисленного ограниченного класса решений, который иначе был бы material question. Она должна быть выдана через `UserDecisionRecord` и точно связана с project либо run, видами артефактов, classifier rule IDs, scope, constraints и собственным hash. Versioned deterministic classifier выводит decision classes из закрытых kind-specific полей packet; model-supplied label не доверяется, запрещённые классы имеют приоритет, а всё недоказанное fail-closed идёт пользователю. Policy может покрывать только перечисленные обратимые и непродуктовые решения. Материальные product/UX, architecture/one-way-door, security/privacy/data, destructive, delivery/release, scope-reduction, waiver и integration решения всегда требуют пользователя. Выход за policy даёт `alignment_policy_out_of_scope`; отсутствие или устаревание доказательства — `alignment_record_stale`. Такая policy не отменяет Panel, Code Review и human integration gate.

Project-bound policy и её issuance/revocation dispositions имеют один project-level source, который каждый gate перечитывает; Epic хранит только reference/hash, а не самостоятельную active-копию. Issue #4 определяет только четыре named alignment lifecycles, approval identity и этот минимальный provenance primitive. Расширяемый Artifact Registry остаётся issue #14, полная очередь/UI/status решений — issue #35, а propagation на уже реализованную работу — issue #25.

До issue #14 закрытый path-role classifier делит created/changed files на `canonical_artifact | governance_mapping_sidecar | ordinary_implementation | additional_normative | unknown`. Source/config/schema/prompt/test/migration files из declared implementation scope относятся к `ordinary_implementation` и продолжают обычный code-review lifecycle; model label не может понизить deterministic `additional_normative` или `unknown`. Плановый/управляющий документ outside the four canonical artifacts является non-normative mirror только с одним mapping на `brief|core_flow|tech_plan|tickets` и current decision IDs: embedded block для text format либо schema-valid companion JSON для non-embeddable bytes. Ordered mapping proof set digest входит прямо в artifact/code candidate identity. Missing, ambiguous, stale, orphan sidecar или extra normative content parks `artifact_mapping_required`; panel/PASS/candidate mint запрещены until decision is expressed and aligned in the named lifecycle.

Quick-flow не получает эти состояния, пока его объективная классификация остаётся валидной. Обнаруженная материальная неоднозначность делает Quick-классификацию невалидной и возвращает запрос в Planned intake.

## 3. Четырёхмодельная панель

Каждое место — отдельная autosk-задача и отдельная Pi-сессия. Все четыре задачи создаются до начала ожидания результатов.

| Место | Маршрут | Фокус |
| --- | --- | --- |
| Lead | GPT-5.6 Sol max | противоречия, исполнимость, проверяемость, машина состояний |
| Feasibility | Grok 4.6 xhigh | соответствие реальному коду и платформе, скрытые предположения |
| Intent | Kimi K3 max | намерение пользователя, scope creep, переусложнение |
| Architecture | Opus 5 max | целостность архитектуры, зависимости, отказоустойчивость |

Для обычного Opus-authored артефакта Lead — GPT. Роли исполняются по фактическому author set:

| Автор артефакта | Lead / gate | Intent | Feasibility | Architecture |
| --- | --- | --- | --- | --- |
| Opus/Claude | GPT | Kimi | Grok | Opus supplementary |
| GPT/Codex | Kimi | GPT supplementary | Grok | Opus |
| Grok | GPT | Kimi | Grok supplementary | Opus |
| Kimi | GPT | Kimi supplementary | Grok | Opus |
| Human/outside family | GPT | Kimi | Grok | Opus |

Lead обязан быть другой семьёй относительно всех авторов и всех агентов, реально исправлявших артефакт. Для mixed authorship применяется мастер-порядок GPT, затем Kimi, Grok, Opus, отфильтрованный до семей вне полного author/fixer set. Если такой семьи нет, процесс переходит человеку.

Все места получают:

- одинаковый зафиксированный anchor pack;
- одинаковую идентичность артефакта;
- одинаковую шкалу серьёзности и формат ответа;
- разные ролевые линзы.

Синтез начинается только после валидного ответа каждого из четырёх мест. Замена маршрута и автоматическое сокращение состава запрещены. После исчерпания retry недоступная child task остаётся human и держит parent blocked; пользователь возобновляет её либо cancel разблокирует parent, после чего join паркует уже parent. Продолжить с сокращённым составом можно только по явному решению пользователя для текущего scope.

Итоговая шкала:

- Critical и High блокируют;
- Medium должен быть исправлен либо явно отложен с обоснованием;
- Low проходит лёгкий разбор и не блокирует сам по себе.

Замечания объединяются в канонические IDs. Отклонение или снижение серьёзности оспаривается у всех исходных авторов замечания. Исправляет исходный автор артефакта. Узкую повторную проверку проводит Lead по всем подтверждённым замечаниям. Существенное изменение scope запускает новую полную панель.

Contest disposition терминален для canonical finding ID и exact candidate identity. Повторно оспорить уже dispositioned finding нельзя; новые evidence/root cause получают новый finding ID и обычный review round. Contest не образует собственный бесконечный цикл.

Повторные обращения идут тем же логическим агентам:

- за каждым местом панели закреплён provider session ID;
- исправленную версию получает тот же Lead session;
- contest получает тот же session каждого originating seat;
- новая полная панель использует те же четыре seat sessions, если роли и cross-family условия не изменились;
- reviewer/Judge sessions всегда отдельны от author/implementer sessions;
- новый session создаётся только при недоступности, повреждении истории или обязательной смене роли; replacement записывает, кого он заменил.

Каждый повтор получает новую artifact identity, diff, canonical findings и dispositions. Продолжение старой сессии не переносит старый PASS на новые bytes.

## 4. Arena/Judge

Arena включается, когда Tech Plan помечает решение как arena и задаёт причину плюс 3–6 измеримых критериев, либо когда пользователь просит её явно.

~~~text
approved arena framing
  -> candidate A: Grok, isolated worktree
  -> candidate B: Codex, isolated worktree
  -> optional candidate C only with written reason
  -> Judge from a family outside candidate set
  -> base recommendation + graft list
  -> human readiness alignment / record_alignment
  -> final implementer re-expresses selected ideas
  -> updated Decision Record / Tech Plan
  -> new full four-model panel of the changed plan
~~~

Кандидаты не видят критерии судьи и работы друг друга. Судья получает анонимные A/B/C, ничего не исполняет в кандидатских worktree и оценивает поведенческие критерии по представленным доказательствам. Пробел доказательств закрывает отдельная проверка на замороженном snapshot.

Менее двух живых кандидатов из разных семей завершает Arena без победителя. Координатор всегда паркует задачу в human с arena_fallback_required. Fallback выбирает exact daemon `UserDecisionRecord`; autonomous policy его не закрывает. После записи решения Tech Plan получает новую identity, narrow=false и полную четырёхмодельную панель.

Judge ранжирует варианты и выдаёт рекомендацию, но не утверждает материальное решение от имени пользователя. Изменённый readiness packet проходит тот же human alignment; exact policy допустима только в заранее записанном обратимом непродуктовом scope. После этого implementer re-expresses выбранные идеи, а Reviewer позднее принимает или отклоняет конкретный итоговый код. Эти роли не объединяются.

Изменение Tech Plan после Arena создаёт новую artifact identity и аннулирует прежний PASS. Lead-only narrow re-review применяется только к исправлению уже подтверждённых panel findings без изменения scope; результат Arena под это исключение не попадает.

## 5. Исполнение Tickets

После PASS комплекта Tickets собственный workflow `autosk-flow` создаёт autosk-задачу на каждый Ticket. `devflow` не вызывается и не является fallback:

- зависимости Ticket превращаются в blockers;
- fresh и repair dispatch используют одну durable ticket_repair_op: сначала create/configure всего набора, затем materialize blockers/enroll и перейти в join;
- human recovery Ticket с зависимостью от replacement сам каскадно становится replacement, поэтому его нельзя запустить раньше prerequisite;
- независимые Tickets выполняются параллельно;
- каждая задача получает свежий worktree от записанного base OID;
- исполнитель по умолчанию — Grok 4.6 xhigh;
- bug-fix сначала воспроизводится красной проверкой;
- исполнитель проверяет критерии, но не коммитит и не двигает refs.

Родительская epic-задача блокируется всеми Ticket-задачами. Она продолжает работу только когда каждая ожидаемая Ticket-задача имеет status=done, current review disposition=pass|waived и commit binding. Ticket status=human продолжает блокировать parent. cancel/missing/done без binding снимают blocker, но join паркует parent.

Каждый Ticket/candidate/verdict связывает `controlling_anchor_digest` с daemon-owned current dependency projection и protected `dependency_head`: current authority/policy/waiver IDs и re-resolved terminal dispositions, manifests, classifier/projector, anchor/protocol, плюс exact Epic `intent_head`. Global authority head всегда reconciles journal integrity, но unrelated project record не сравнивается как Epic generation. Project metadata хранит только projection/head refs; direct edit не совпадает с protected head. Current set меняется только daemon `add|supersede`; supersede void'ит old bindings. Live wrapper и каждый side-effect prologue re-resolves relevant authority projection + dependency/intent heads. Mismatch идёт через blocked-anchor rebuild.

Единственное исключение: Ticket с correction вызывает daemon `appendIntentEvent`, который под project mutex append'ит immutable `anchor_correction` comment и двигает Epic intent head; direct comment-file write authority не получает. Затем Ticket пишет waiting receipt, durable park human и только после этого exact-unblock'ит parent. Ticket никогда не пишет Epic metadata. Parent consume'ит head-bound events в pending_anchor. Остальной resume/replacement порядок сохраняет intent→edge→resume; новый event после consume меняет head и блокирует следующий guard.

## 6. Freeze, Review и исправления

После проверки детерминированный шаг:

1. проверяет scope и ignored/untracked files;
2. вычисляет candidate tree OID через временный Git index;
3. для Tickets повторно читает exact tree, сверяет pending validation proof и финализирует host-owned `TicketsValidationReceipt` с `candidate_tree_oid`, равным вычисленному tree OID; receipt не входит в самоидентифицируемое дерево;
4. создаёт недвигающий refs snapshot commit;
5. фиксирует base OID, pathspec, tree OID, anchor version и attempt;
6. передаёт frozen identity в следующий `dispatch_review`; уже этот отдельный шаг создаёт review-task с новым task ID и OID-pinned рабочей копией.

Маршрут проверяющего выбирается по union фактических author и fixer families:

| Авторский набор | Порядок reviewer |
| --- | --- |
| Claude | GPT, затем Kimi, затем Grok |
| Codex | Kimi, затем Grok |
| Grok | GPT, затем Kimi |
| Kimi | GPT, затем Grok |
| Human/outside | GPT, затем Kimi, затем Grok |
| Mixed | мастер-порядок GPT, затем Kimi, затем Grok; оставить только семьи вне полного author/fixer set |

Если внешней семьи нет, Code Review не запускается молча: задача переходит человеку для human review, re-expression кандидата либо точного waiver.

~~~text
review PASS
  -> recompute identity
  -> commit-on-pass by CAS

review findings
  -> author fixes original worktree
  -> verify
  -> mint new tree OID
  -> narrow re-review
~~~

Узкая повторная проверка охватывает открытые findings, разницу с предыдущим кандидатом и непосредственно затронутые связи. Лимит полного цикла — 10 раундов, после чего задача переходит человеку.

## 7. Принятие, интеграция и завершение

По умолчанию после PASS всех Tickets epic-задача останавливается human. Пропустить её может только signed `IntegrationAuthorizationRecord` exact run/candidate: target/base, ordered ref transitions, completed-prefix receipt, final tree, controlling digest и expiry. Если record истёк после частичного CAS, workflow сохраняет exact prefix и возвращается в accept; новый record начинается от current target OID и покрывает remaining transitions. Project policy integration не разрешает.

После разрешения:

1. Tickets интегрируются в порядке зависимостей;
2. merge OID строится без движения целевой ветки;
3. approved tree сверяется повторно;
4. daemon `integrateApproved` под mutex сначала пишет durable pending operation receipt, затем revalidates и выполняет target CAS, после чего commits outcome receipt; crash recovery resolves exact ref/reflog before checking authorization expiry;
5. запускается aggregate verification всего epic;
6. worktree и временные snapshot сначала очищаются с force=false; dirty workspace сохраняется для решения человеком;
7. epic переходит в done.

Любое расхождение base/tree, внешнее движение ветки, неясный reflog, конфликт или неполное доказательство переводит задачу в human. История не переписывается автоматически.

## 8. Возобновление из human

Bare resume запрещён для эскалаций, где требуется решение: он может вернуть задачу в тот же park-step без изменения условий. Пользователь выбирает явную цель и предварительно записывает требуемое решение.

| Причина | Реальный workflow step | Обязательное состояние |
| --- | --- | --- |
| Brief framing не согласован | record_alignment | полный daemon `UserDecisionRecord` framing либо current exact policy той же identity |
| Core Flow содержит открытое решение поведения | record_alignment | daemon record закрыл каждое material решение; model self-approval запрещён |
| Tech Plan не готов из-за open question или silent inference | record_alignment | readiness/classifier proof подтверждены daemon record либо current exact policy |
| Ticket breakdown не согласован | record_alignment | показаны current Ticket set/DAG/scopes/outcomes/order/exclusions и daemon approval совпадает |
| Alignment policy не покрывает решение | clarify_alignment для Brief/Core Flow/Tech Plan; present_tickets_breakdown для Tickets | trusted client подписывает only exact nonce challenge; autoskd journal/head-bind'ит новый UserDecisionRecord и только из него daemon issues exact policy projection |
| Alignment record устарел | clarify_alignment для Brief/Core Flow/Tech Plan; present_tickets_breakdown для Tickets | новая anchor version, daemon impact disposition и current authority/alignment/classifier hashes |
| tickets_manifest_invalid | validate_tickets_manifest до freeze; present_tickets_breakdown после publication | post-publication recovery voids old Tickets candidate/receipt/PASS bindings and retains them as audit evidence; corrected manifest/views проходят новый alignment, validation, freeze, full Panel и replacement publication до dispatch_ticket_dag; child/blocker/enrollment side effects до этого отсутствуют |
| tickets_manifest_stale | validate_tickets_manifest до freeze; present_tickets_breakdown после publication | post-publication recovery voids and retains old Tickets candidate/receipt/PASS records, then runs a new artifact cycle; freeze creates a new immutable receipt bound to the new exact tree and only that receipt becomes current before Panel, replacement publication and dispatch |
| planning_ref_init_invalid | init_planning_ref | corruption with otherwise valid base restores exact committed bytes; invalid/missing/non-commit/cross-store base requires a new daemon-attributed intake/base-selection record and a fresh init operation while preserving prior audit evidence; no adopt/reset |
| planning_ref_capability_missing | recorded planning recovery step: init_planning_ref, freeze_artifact, rebuild_anchor, synthesize_panel, narrow_review_join, record_artifact_pass, publish_artifact_pass, publish_planning_invalidation or cleanup | pinned required ref/reflog/helper or atomic PASS+prepared-operation capability passes synthetic preflight; identity unchanged |
| planning_ref_foreign_movement | init_planning_ref or publish_artifact_pass or publish_planning_invalidation according to recorded operation_type; freeze_artifact, fix_artifact, record_artifact_pass, rebuild_anchor, synthesize_panel, narrow_review_join or cleanup according to the recorded candidate_keepalive_op, candidate_supersession_op or audit_candidate_housekeeping_op; with no open operation use the recorded detecting gate, only after signed investigation disposition | exact operation type/ID when present, detecting gate and ref/reflog observations bound; ordinary retry/adopt/reset forbidden; unresolved movement permits only separate cancel status operation |
| planning_candidate_keepalive_invalid | freeze_artifact, fix_artifact, rebuild_anchor, synthesize_panel, narrow_review_join, record_artifact_pass, publish_artifact_pass for artifact operation or publish_planning_invalidation for anchor_invalidation, or cleanup according to recorded candidate/operation state | exact candidate keepalive ref/create or audit/release receipt and complete object closure restored or candidate explicitly superseded; cleanup and publication remain blocked until namespace inventory matches metadata/history |
| planning_candidate_base_stale | draft_artifact for Brief/Core Flow/Tech Plan; present_tickets_breakdown for Tickets | stale candidate/verdict absent or void; author base re-minted from current verified planning head |
| planning_publication_invalid | record_artifact_pass or rebuild_anchor recorded pre-failure step | no-ref-side-effect proof plus exact committed operation recovery, or conflicting operation explicitly voided; otherwise remain human |
| planning_publication_corrupt | publish_artifact_pass or publish_planning_invalidation recorded operation kind | committed recipe/receipt restored, or missing pre-CAS object rewritten from exact persisted bytes with unchanged checkpoint |
| planning_signing_unavailable | record_artifact_pass | trusted signer produced exact replayable signature bytes under current locked policy before PASS/operation/object/ref side effects |
| Quick classification invalid, Planned handoff не завершён | invalidate_quick_classification | schema-valid planned_trigger, исходный base/worktree receipt и idempotent creation binding Planned replacement; Quick integration запрещена |
| Недоступная panel child | review_artifact | тот же route, новый attempt; parent остаётся blocked |
| Недоступная code-review child | review_candidate | тот же route, новый attempt; parent остаётся blocked |
| Invalid/cancelled panel child | dispatch_panel | invalid child IDs, attempt+1 |
| Сокращённая панель | dispatch_panel или panel_join | retry отсутствующего route либо waiver с artifact identity и фактическим roster |
| Invalid contest disposition | dispatch_contest | invalid child IDs, attempt+1 |
| Invalid narrow-review child | dispatch_narrow_review | новый Lead child и attempt |
| Invalid code-review child | dispatch_review или dispatch_narrow_review | новый review child, сохранённый режим и attempt |
| Code verdict revalidation failed | freeze | старый review binding void, новый candidate/review attempt |
| BLOCKED_ANCHOR, Planned | prepare_anchor_impact | deterministic step строит/stages full map + status/cascade hashes без side effects |
| Anchor impact ждёт approval | record_anchor_impact_approval | daemon `UserDecisionRecord` подписал exact staged proposal; step record'ит approved только при unchanged status/watermark |
| Invalid/stale anchor impact map | prepare_anchor_impact | новая карта вычисляется step; пользователь не hand-author'ит dispositions |
| BLOCKED_ANCHOR, standalone Quick | rebuild_code_anchor | own anchor bump, затем verify/freeze/full review |
| BLOCKED_ANCHOR, Ticket with parent | rebuild_code_anchor | propagate pending в parent, suspend blocker с receipt, ждать parent rebuild_anchor |
| Waiting for parent anchor | rebuild_code_anchor | parent rebuild завершён, Ticket anchor=parent, local pending=null, receipt восстановлен |
| Anchor resume pending | rebuild_code_anchor | exact parent edge active; pending resume_intent совпадает с op/anchor/receipt/target и child остаётся human |
| Parent absorbed live Ticket anchor before suspension | rebuild_code_anchor | Ticket anchor=parent, local pending=null, matching parent_rebuild_receipt, active blocker edge добавлен |
| Affected done/cancel/new/missing Ticket, code-only repair | rebuild_anchor | consume correction events; old task исключить, superseded_by записать, replacement только создать/configure; после resume human Tickets следующий step enroll'ит replacement и ставит blockers |
| Affected done/cancel/new/missing Ticket, planning repair | dispatch_ticket_dag | создать отдельную ticket_repair_op и подготовить replacements без enroll/blockers; затем resume human Tickets, после чего enroll/block replacements |
| Invalid/open duplicate Ticket repair operation | dispatch_ticket_dag, rebuild_anchor или resume_repaired_tickets по op kind | human выбирает одну exact op; premature blockers сняты, immutable phases не понижены |
| Любой expected work Ticket, включая claimed-unaffected (anchor_repair_ticket_live) | rebuild_anchor после завершения live run | все expected Tickets human/terminal; status/impact перечитаны; pending_anchor сохранён; parent metadata write/cancel live Ticket запрещены |
| Artifact PASS revalidation failed | freeze_artifact | старые bindings void, attempt+1, сохранённый full/narrow mode |
| Лимит review | fix_artifact для Planned; fix для Quick/Ticket | новый daemon-attributed cap decision, сохранённые findings и identity |
| Invalid Arena/Judge | dispatch_arena | новый arena attempt |
| Arena fallback | apply_arena_decision | пользователь выбрал fallback; следующая панель полная |
| Invalid autosk-arena block | fix_artifact | исправленный block, narrow=false и новая полная panel |
| Invalid Ticket set execution | dispatch_ticket_dag | repair map для конкретных Tickets |
| Lost suspended Ticket receipt | dispatch_ticket_dag | receipt сопоставлен live Ticket или valid superseded_by, старый sandbox учтён |
| Candidate changed before commit | fix | approved findings/identity сохранены, новый candidate attempt |
| Commit CAS failed without movement | commit_on_pass | ref всё ещё на recorded base, причина lock/storage устранена |
| Private ticket branch moved | commit_on_pass | branch снова однозначен после расследования; cancel — отдельная status-операция |
| Aggregate verification failed | record_aggregate_remediation | external_retry repeats evidence; unchanged set/DAG creates failure-bound repair map and fresh code candidates/review for affected Tickets (old done bindings forbidden); set-changing voids Tickets approval then new proposal/breakdown/full Panel |
| Нет внешней code-review family | freeze для signed full-skip waiver; dispatch_review/narrow для external human/re-expression | recovery возвращается к реальному waiver consumer, режим сохраняется |
| Нет внешней panel Lead family | freeze_artifact для signed full-skip waiver; dispatch_panel/narrow для external human Lead | recovery возвращается к waiver consumer, full/narrow сохраняется |
| Dirty cleanup | cleanup | явное force-разрешение либо сохранённое восстановимое состояние |
| Integration authorization missing/expired | accept | pending CAS receipt сначала resolved; новый signed record связывает current target, completed prefix, remaining transitions, final tree и current heads |
| Integration obstruction | integrate | помеха перемещена восстанавливаемо и записано доказательство |
| Integration precondition | integrate | предусловие устранено, base/tree повторно записаны и доказательство приложено |
| Foreign movement / indeterminate | integration_recovery | явное решение после расследования; cancel выполняется отдельной status-операцией, обычный retry запрещён |

onTransit отклоняет resume, если причина park и требуемые metadata не соответствуют выбранной цели.

## 9. Разрешённые исключения

| Исключение | Кто может разрешить | Как фиксируется |
| --- | --- | --- |
| Не создавать Brief/Core Flow | координатор по объективной классификации | classification в metadata |
| Не создавать плановые артефакты для Quick | координатор, пока classification валидна на каждом gate | mode=quick + current classification identity |
| Автономно закрыть alignment question | только пользователь заранее | client signs exact challenge; autoskd commits UserDecisionRecord and issues exact project/run policy projection with kind/rules/classes/scope/constraints/hash |
| Пропустить панель существующего артефакта | только пользователь | daemon `UserDecisionRecord` panel waiver с точным scope |
| Пропустить Code Review | только пользователь; строго редакционная Quick-правка освобождена deterministic rules | daemon review waiver либо editorial classification + exact identity/path set; governance не editorial |
| Сократить панель из-за недоступности | только пользователь | unavailable seat, причина, daemon waiver и фактический roster |
| Integration authorization | пользователь подписал exact run/candidate integration packet | `IntegrationAuthorizationRecord` ID/hash; project alignment policy запрещена |
| Превысить 10 раундов | пользователь | daemon cap decision + human resume |
