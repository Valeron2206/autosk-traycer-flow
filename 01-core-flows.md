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
- project policy hash принадлежит только metadata своего проекта;
- остановка, correction или cleanup проекта A не меняют задачи и файлы проекта B.

Если один пользовательский запрос затрагивает несколько репозиториев, координатор создаёт отдельный project-scoped Epic для каждого. Каждый Epic хранит общий opaque UUID correlation ID только для display/audit. Он не содержит и не разрешает task/session/evidence/path другого проекта; runtime не использует его для lookup, blockers, joins или recovery. Общего Ticket, общей session или общего mutable документа между проектами нет.

## 2. Адаптивное планирование

Полный граф возможностей:

~~~text
intake / classify
  -> Brief?       -> human framing alignment -> draft -> four-model panel -> fix -> narrow re-review
  -> Core Flow?   -> human behavior alignment -> draft -> four-model panel -> fix -> narrow re-review
  -> Tech Plan    -> human readiness alignment -> draft -> four-model panel -> fix -> narrow re-review
  -> Arena?       -> candidates -> Judge recommendation -> human readiness alignment
                  -> Decision Record / changed Tech Plan -> new full four-model panel
  -> Tickets      -> draft + dependency view -> human breakdown alignment
                  -> separate four-model panel -> fix -> narrow re-review
  -> ticket DAG execution
~~~

Этап пропускается только если его артефакт не нужен. Если артефакт создан, панель включается автоматически.

### Brief

Нужен для новой инициативы, неоднозначной цели, существенной границы scope или нескольких заинтересованных сторон. Отвечает на «что», «зачем», «для кого», «что не входит» и «как выглядит успех». Технических решений не содержит.

### Core Flow

Нужен при пользовательском поведении, состояниях, ветвях, ошибках и взаимодействии нескольких акторов. Фиксирует вход, действия, реакции системы, выходы и сценарную матрицу. Файлы, классы и технический стек не описывает.

### Tech Plan

Нужен, когда реализация должна принять техническое решение. Фиксирует компоненты, границы, интерфейсы, данные, безопасность, конкурентность, миграцию, проверку, эксплуатацию и откат. Не может молча изменить Brief или Core Flow.

### Tickets

Создаются как вертикальные независимо проверяемые части. Каждый Ticket ссылается на конкретные пункты Brief, сценарии Core Flow и решения Tech Plan, содержит scope in/out, зависимости, критерии приёмки и требуемые доказательства.

Весь комплект Tickets проходит отдельную четырёхмодельную панель. Панель проверяет и каждый Ticket, и согласованность набора.

### Согласование решений человеком

В Planned-flow согласование человеком и модельная проверка — разные gates. Согласование отвечает на вопрос «это действительно решение пользователя?», а панель проверяет качество уже разрешённого решения. Модель не может одобрить своё предложение от имени пользователя и не может спрятать материальную неоднозначность в списке assumptions.

| Артефакт | Что предъявляется до продолжения | Когда разрешён следующий шаг | Причина остановки |
| --- | --- | --- | --- |
| Brief | цель и ожидаемый результат; затронутые стороны; причина работы; scope и non-goals; критерий успеха; открытые материальные вопросы | framing подтверждён пользователем либо покрыт точной policy; только затем создаётся нормативный Brief | `brief_alignment_required` |
| Core Flow | действия и видимые состояния; happy/unhappy paths; ошибки, повторы, отмена и partial success; права акторов и реакции системы | каждое материальное продуктовое решение закрыто пользователем; только затем создаётся нормативный Core Flow | `core_flow_decision_required` |
| Tech Plan | readiness record: открытые вопросы, существенно разные реализации, silent inferences и уже закрытые решения | readiness подтверждена; реализация не должна изобретать оставшееся материальное решение | `tech_plan_readiness_required` |
| Tickets | полный набор, dependency graph, scope и independently verifiable outcome каждого Ticket, порядок/параллельность и exclusions | breakdown подтверждён до Ticket Panel; изменение набора или графа требует нового согласования | `tickets_breakdown_alignment_required` |

Brief, Core Flow и Tech Plan нельзя записать как нормативные артефакты до действующего alignment record. Tickets сначала создаются как предложение, показываются вместе с dependency view и становятся допустимым входом Ticket Panel только после записи approval.

Каждый alignment record неизменяемо связывает `project identity + epic_id + artifact kind + anchor version + scope hash + subject hash + decision record hash + policy hash|null + protocol hash`. `subject hash` для Tickets включает канонический набор файлов, dependency graph, scopes, outcomes, порядок и exclusions; для Tech Plan — весь readiness record. Источником бывает только явное решение пользователя либо заранее выданная project/run policy. Ответы пользователя и record входят в controlling anchor pack.

Изменение ответа, subject, scope, policy или anchor делает record stale. Correction создаёт новую anchor version, проходит impact analysis и аннулирует затронутые candidate/verdict/PASS bindings; незатронутое можно перепривязать только через существующее явное human-approved правило. Bare resume без нового decision record не проходит gate.

Обычные локальные, обратимые и нематериальные implementation choices не входят в alignment packet и не требуют вопроса пользователю. Autonomous policy нужна только для заранее перечисленного ограниченного класса решений, который иначе был бы material question. Она должна быть заранее одобрена пользователем и точно связана с project/run, Epic, видами артефактов, классами решений, scope, constraints и собственным hash. Policy может покрывать только перечисленные обратимые и непродуктовые решения. Материальные product/UX, architecture/one-way-door, security/privacy/data, destructive, delivery/release, scope-reduction, waiver и integration решения всегда требуют пользователя. Выход за policy даёт `alignment_policy_out_of_scope`; отсутствие или устаревание доказательства — `alignment_record_stale`. Такая policy не отменяет Panel, Code Review и human integration gate.

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

Менее двух живых кандидатов из разных семей завершает Arena без победителя. Координатор всегда паркует задачу в human с arena_fallback_required. Fallback выбирает пользователь; после записи решения Tech Plan получает новую identity, narrow=false и полную четырёхмодельную панель.

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

Родительская epic-задача блокируется всеми Ticket-задачами. Она продолжает работу только когда каждая ожидаемая Ticket-задача имеет status=done и валидный PASS/commit binding. Ticket status=human продолжает блокировать parent и исправляется в дочерней задаче. cancel, отсутствующая задача или done без binding снимают blocker, но join затем переводит parent в human.

Единственное исключение: Ticket с correction append'ит immutable `anchor_correction` event в comments родительского Epic, записывает собственный waiting receipt, сначала подтверждённо паркуется human и только затем exact-unblock'ит parent. Ticket никогда не пишет Epic metadata. `ticket_join` не возвращает намеренно снятый edge при exact final receipt: он сначала переводит correction в blocked_anchor. Незавершённый receipt, напротив, восстанавливает edge и возобновляется через `complete_anchor_handoff`. Parent deterministic gate как единственный writer consume'ит events в pending_anchor. При code-only impact rebuild заканчивает все semantic anchor/binding writes и переходит в `resume_repaired_tickets`. Этот step до восстановления blocker записывает/read-back в Ticket долговечный `resume_intent` с exact op/target, затем возвращает edge и resume'ит child. Crash после edge до resume оставляет parent безопасно blocked, а human Ticket — с единственной явной целью `rebuild_code_anchor`; пользователь возобновляет его без перестройки графа. После resume parent пишет только монотонные фазы recovery operation и закрывает её при входе в ticket_join. Crash после нового event не теряет его из-за append-only inbox. Planning dispatch создаёт отдельную durable repair operation и готовит replacements без enroll/blockers; только после resume всех matched human Tickets он enroll'ит replacements и ставит blockers. Потерянный receipt или event hash блокирует процесс.

## 6. Freeze, Review и исправления

После проверки детерминированный шаг:

1. проверяет scope и ignored/untracked files;
2. вычисляет candidate tree OID через временный Git index;
3. создаёт недвигающий refs snapshot commit;
4. фиксирует base OID, pathspec, tree OID, anchor version и attempt;
5. создаёт отдельную review-задачу с новым task ID и OID-pinned рабочей копией из snapshot.

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

По умолчанию после PASS всех Tickets epic-задача останавливается в статусе human перед изменением целевой ветки. Пользователь может заранее включить auto-integration для конкретного проекта или запуска.

После разрешения:

1. Tickets интегрируются в порядке зависимостей;
2. merge OID строится без движения целевой ветки;
3. approved tree сверяется повторно;
4. autosk-flow integrate-approved выполняет CAS и проверяет reflog;
5. запускается aggregate verification всего epic;
6. worktree и временные snapshot сначала очищаются с force=false; dirty workspace сохраняется для решения человеком;
7. epic переходит в done.

Любое расхождение base/tree, внешнее движение ветки, неясный reflog, конфликт или неполное доказательство переводит задачу в human. История не переписывается автоматически.

## 8. Возобновление из human

Bare resume запрещён для эскалаций, где требуется решение: он может вернуть задачу в тот же park-step без изменения условий. Пользователь выбирает явную цель и предварительно записывает требуемое решение.

| Причина | Реальный workflow step | Обязательное состояние |
| --- | --- | --- |
| Brief framing не согласован | record_alignment | полный framing decision record пользователя либо exact policy той же identity |
| Core Flow содержит открытое решение поведения | record_alignment | пользователь закрыл каждое материальное решение; model self-approval запрещён |
| Tech Plan не готов из-за open question или silent inference | record_alignment | текущий readiness record подтверждён пользователем либо exact policy |
| Ticket breakdown не согласован | record_alignment | показаны текущие Ticket set/DAG/scopes/outcomes/order/exclusions и записано approval |
| Alignment policy не покрывает решение | clarify_alignment | новое решение пользователя либо новая exact policy; расширять policy модель не может |
| Alignment record устарел | clarify_alignment для Brief/Core Flow/Tech Plan; present_tickets_breakdown для Tickets | новая anchor version и decision/alignment record текущих subject/scope hashes |
| Недоступная panel child | review_artifact | тот же route, новый attempt; parent остаётся blocked |
| Недоступная code-review child | review_candidate | тот же route, новый attempt; parent остаётся blocked |
| Invalid/cancelled panel child | dispatch_panel | invalid child IDs, attempt+1 |
| Сокращённая панель | dispatch_panel или panel_join | retry отсутствующего route либо waiver с artifact identity и фактическим roster |
| Invalid contest disposition | dispatch_contest | invalid child IDs, attempt+1 |
| Invalid narrow-review child | dispatch_narrow_review | новый Lead child и attempt |
| Invalid code-review child | dispatch_review или dispatch_narrow_review | новый review child, сохранённый режим и attempt |
| Code verdict revalidation failed | freeze | старый review binding void, новый candidate/review attempt |
| BLOCKED_ANCHOR, Planned | rebuild_anchor | полная human-approved anchor_impact; step re-bind'ит unchanged, void'ит affected и идёт planning либо Ticket repair |
| Invalid anchor impact map | rebuild_anchor | полная карта и повторно проверенные unchanged hashes |
| BLOCKED_ANCHOR, standalone Quick | rebuild_code_anchor | own anchor bump, затем verify/freeze/full review |
| BLOCKED_ANCHOR, Ticket with parent | rebuild_code_anchor | propagate pending в parent, suspend blocker с receipt, ждать parent rebuild_anchor |
| Waiting for parent anchor | rebuild_code_anchor | parent rebuild завершён, Ticket anchor=parent, local pending=null, receipt восстановлен |
| Anchor resume pending | rebuild_code_anchor | exact parent edge active; pending resume_intent совпадает с op/anchor/receipt/target и child остаётся human |
| Parent absorbed live Ticket anchor before suspension | rebuild_code_anchor | Ticket anchor=parent, local pending=null, matching parent_rebuild_receipt, active blocker edge добавлен |
| Affected done/cancel/new/missing Ticket, code-only repair | rebuild_anchor | consume correction events; old task исключить, superseded_by записать, replacement только создать/configure; после resume human Tickets следующий step enroll'ит replacement и ставит blockers |
| Affected done/cancel/new/missing Ticket, planning repair | dispatch_ticket_dag | создать отдельную ticket_repair_op и подготовить replacements без enroll/blockers; затем resume human Tickets, после чего enroll/block replacements |
| Invalid/open duplicate Ticket repair operation | dispatch_ticket_dag, rebuild_anchor или resume_repaired_tickets по op kind | human выбирает одну exact op; premature blockers сняты, immutable phases не понижены |
| Affected work Ticket (anchor_repair_ticket_live) | rebuild_anchor после завершения live run | status/impact перечитаны; pending_anchor сохранён; автоматическая mutation/cancel запрещена |
| Artifact PASS revalidation failed | freeze_artifact | старые bindings void, attempt+1, сохранённый full/narrow mode |
| Лимит review | fix_artifact для Planned; fix для Quick/Ticket | новый user-approved cap, сохранённые findings и identity |
| Invalid Arena/Judge | dispatch_arena | новый arena attempt |
| Arena fallback | apply_arena_decision | пользователь выбрал fallback; следующая панель полная |
| Invalid autosk-arena block | fix_artifact | исправленный block, narrow=false и новая полная panel |
| Invalid Ticket set execution | dispatch_ticket_dag | repair map для конкретных Tickets |
| Lost suspended Ticket receipt | dispatch_ticket_dag | receipt сопоставлен live Ticket или valid superseded_by, старый sandbox учтён |
| Candidate changed before commit | fix | approved findings/identity сохранены, новый candidate attempt |
| Commit CAS failed without movement | commit_on_pass | ref всё ещё на recorded base, причина lock/storage устранена |
| Private ticket branch moved | commit_on_pass | branch снова однозначен после расследования; cancel — отдельная status-операция |
| Aggregate verification failed | dispatch_ticket_dag или aggregate_verify | scoped integration-fix Ticket либо доказанный внешний сбой |
| Нет внешней code-review family | dispatch_review или dispatch_narrow_review | human reviewer, re-expression либо точный waiver; режим сохраняется |
| Нет внешней panel Lead family | dispatch_panel или dispatch_narrow_review | external human Lead либо точный waiver; full/narrow сохраняется |
| Dirty cleanup | cleanup | явное force-разрешение либо сохранённое восстановимое состояние |
| Integration obstruction | integrate | помеха перемещена восстанавливаемо и записано доказательство |
| Integration precondition | integrate | предусловие устранено, base/tree повторно записаны и доказательство приложено |
| Foreign movement / indeterminate | integration_recovery | явное решение после расследования; cancel выполняется отдельной status-операцией, обычный retry запрещён |

onTransit отклоняет resume, если причина park и требуемые metadata не соответствуют выбранной цели.

## 9. Разрешённые исключения

| Исключение | Кто может разрешить | Как фиксируется |
| --- | --- | --- |
| Не создавать Brief/Core Flow | координатор по объективной классификации | classification в metadata |
| Не создавать плановые артефакты для Quick | координатор | mode=quick |
| Автономно закрыть alignment question | только пользователь заранее | exact project/run policy с kind, decision classes, scope, constraints, user decision ref и policy hash |
| Пропустить панель существующего артефакта | только пользователь | panel waiver с точным scope |
| Пропустить Code Review | только пользователь; строго редакционная Quick-правка освобождена deterministic rules | review waiver либо editorial classification + exact identity/path set; governance не editorial |
| Сократить панель из-за недоступности | только пользователь | unavailable seat, причина, явный waiver и фактический roster |
| Auto-integration | пользователь или заранее принятая project policy | policy hash в metadata |
| Превысить 10 раундов | пользователь | human resume с новым cap |
