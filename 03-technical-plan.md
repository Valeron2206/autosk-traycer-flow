# Технический план

## 1. Форма поставки

Создать отдельный TypeScript-пакет autosk-flow для autosk v2. Разрабатывать и проверять его как project-local extension в тестовом Git-репозитории. После PASS установить тот же проверенный source/version глобально, чтобы проекты не копировали процесс.

Пакет регистрирует собственные Planned, Quick, Ticket, Panel, Review и Arena workflows. `devflow` и Traycer runtime не являются dependencies или fallback. Канонические autosk-native Guide/protocol/schemas принадлежат расширению; exact migration baseline остаётся локальным вне public Git.

Каждый проект хранит только свои нормативные артефакты и операционное состояние внутри canonical root. Глобальная установка не содержит project documents, sessions, evidence или mutable integration state.

Перед любой записью расширение берёт canonical project root из `ctx.projectRoot` и считает `project_root_sha256`. Все проектные файлы пишутся под этим root; любые lookup/recovery ключи за пределами одного store включают `{project_root_sha256, task_id|operation_id}`. Task ID, branch name, epic ID или человекочитаемый slug без project-root hash не являются глобально уникальными. Obsidian MCP и `architecture-planning` не входят в preflight, prompts, tests или recovery.

## 2. Регистрируемые workflows

### autosk-planned

Родительская epic-задача:

~~~text
intake
 -> select_next

artifact full panel:
  draft_artifact -> freeze_artifact -> dispatch_panel
  -> panel_join -> synthesize_panel -> record_artifact_pass

artifact fix:
  synthesize_panel -> fix_artifact -> freeze_artifact
  -> dispatch_narrow_review -> narrow_review_join
  -> record_artifact_pass

contest:
  synthesize_panel -> dispatch_contest -> contest_join
  -> synthesize_panel

arena:
  select_next -> dispatch_arena -> arena_join
  -> apply_arena_decision -> draft_artifact -> freeze_artifact
  -> dispatch_panel

execution:
  select_next -> dispatch_ticket_dag -> resume_repaired_tickets -> ticket_join
  -> accept -> integrate -> aggregate_verify -> cleanup -> done

recovery:
  rebuild_anchor -> draft_artifact | dispatch_arena | select_next | resume_repaired_tickets | ticket_join | human
  resume_repaired_tickets -> ticket_join
  panel_join_wait -> panel_join
  contest_join_wait -> contest_join
  narrow_review_join_wait -> narrow_review_join
  arena_join_wait -> arena_join
  ticket_join_wait -> ticket_join
  repair_protocol_snapshot -> recorded pre-failure step | human
  integration_recovery -> integrate | human
~~~

Brief, Core Flow, Tech Plan и весь комплект Tickets — четыре значения current_artifact.kind и проходят один artifact cycle. Отдельных draft_tickets/tickets_panel steps нет.

Каноническая таблица переходов:

Перед вычислением любого gate parent-owned deterministic step вызывает `consumeAnchorCorrections`: читает новые immutable `anchor_correction` records из Epic comments, проверяет raw comment id/hash, event schema, project/anchor provenance и как единственный writer merge'ит валидные events в pending_anchor. Invalid raw record блокирует gate, кроме одного точного случая: более поздний schema-valid event с human approval содержит `{supersedes_raw_comment_id,supersedes_raw_hash}`. Тогда parent atomically записывает `correction_dispositions[raw_id]={raw_hash,status:superseded,by_event_id,approval_hash}`, продвигает watermark через exact raw record и впредь пропускает только его. Model/Ticket/user paths не выполняют `metadata set` родительского Epic. Если event появился после текущего consume, он остаётся непрочитанным и блокирует следующий gate. Единственное упорядочивающее исключение — `ticket_join` сначала классифицирует suspension receipt: незавершённый handoff восстанавливает edge и ждёт child recovery до consume, а валидный final handoff сохраняет edge снятым и только затем consume'ит его event.

У всех fan-out одинаковый deterministic join prologue. Если ожидаемый child имеет status=new/work/human, но его exact parent blocker отсутствует, join восстанавливает только этот edge и переходит в зарегистрированный `<join>_wait`. Исключение — точный Ticket handoff с human child, matching immutable event, final `edge_suspended` receipt и намеренно отсутствующим edge: `ticket_join` не восстанавливает blocker, а переводит correction в `blocked_anchor`. Незавершённый receipt исключением не считается. Пока хотя бы один обычный blocker активен, scheduler не запускает wait-step; когда все children terminal/removed, wait-step обязан перейти обратно в исходный join. Это правило действует для panel, contest, narrow, Arena, code review и Ticket joins и не позволяет AgentDefinition завершить onRun без transition.

| Текущий шаг | Условие | Следующий шаг |
| --- | --- | --- |
| intake | classification валиден | select_next |
| select_next | первый required и ещё не passed kind среди brief, core_flow, tech_plan | записать kind, создать review_cycles[kind] если absent, draft_artifact |
| select_next | Tech Plan passed и существует arena.decisions entry status=pending | выбрать первый stable decision_id, записать current_decision_id, dispatch_arena |
| select_next | planning kinds passed, все Arena decisions terminal либо отсутствуют, Tickets ещё не passed | записать kind=tickets, создать review_cycles.tickets если absent, draft_artifact |
| select_next | Tickets passed | dispatch_ticket_dag |
| draft_artifact | arena re-expression required, но Decision Record/graft list не отражены в новых Tech Plan bytes либо identity равна pre-arena | human с park.reason=arena_reexpression_missing |
| draft_artifact | bytes записаны, scope чист и обязательная arena re-expression завершена либо не требуется | freeze_artifact |
| freeze_artifact | current_cycle.full_panel_required=true или current_cycle.narrow=false | dispatch_panel |
| freeze_artifact | current_cycle.narrow=true, но scope/anchor/load-bearing decisions изменились | atomically current_cycle.narrow=false, current_cycle.full_panel_required=true, dispatch_panel |
| freeze_artifact | current_cycle.narrow=true, current_cycle.full_panel_required=false и scope/anchor/load-bearing decisions не изменились | dispatch_narrow_review |
| dispatch_panel | нет gate-carrying семьи вне union author/fixer set | human с park.reason=no_external_panel_lead |
| dispatch_panel | route недоступен после retry и точного waiver ещё нет | human с park.reason=panel_waiver_required |
| dispatch_panel | четыре child tasks или exact-waived actual_roster полностью настроены/enrolled и parent имеет exact blockers всех children | panel_join |
| panel_join | pending_anchor, любой verdict=BLOCKED_ANCHOR или anchor version отличается | atomically ensure pending_anchor(reason, identity), human с park.reason=blocked_anchor |
| panel_join | любой child status=new/work/human | join prologue обеспечивает exact blocker, panel_join_wait; human child возобновляет пользователь |
| panel_join_wait | хотя бы один expected blocker активен | step не запускается scheduler |
| panel_join_wait | все expected blockers terminal/removed | panel_join |
| panel_join | exact user waiver текущей identity, actual_roster содержит gate Lead вне author/fixer set, все listed seats status=done и bindings валидны | atomically current_cycle.full_panel_required=false, synthesize_panel |
| panel_join | roster меньше четырёх без waiver | human с park.reason=panel_waiver_required |
| panel_join | все четыре status=done, verdicts валидны, нет BLOCKED_ANCHOR/mismatch | atomically current_cycle.full_panel_required=false, synthesize_panel |
| panel_join | любой cancel/missing/invalid | human с park.reason=panel_join_invalid |
| synthesize_panel | требуется contest | dispatch_contest |
| synthesize_panel | подтверждены findings | fix_artifact |
| synthesize_panel | PASS | record_artifact_pass |
| dispatch_contest | все contest children настроены/enrolled и parent имеет exact blockers всех children | contest_join |
| contest_join | pending_anchor или disposition=BLOCKED_ANCHOR/mismatch | atomically ensure pending_anchor(reason, identity), human с park.reason=blocked_anchor |
| contest_join | любой child status=new/work/human | join prologue обеспечивает exact blocker, contest_join_wait; human child возобновляет пользователь |
| contest_join_wait | хотя бы один expected blocker активен | step не запускается scheduler |
| contest_join_wait | все expected blockers terminal/removed | contest_join |
| contest_join | все originating seats status=done и dispositions валидны | synthesize_panel |
| contest_join | cancel/missing/invalid | human с park.reason=contest_join_invalid |
| fix_artifact | исправлены только confirmed findings без scope change | freeze_artifact с current_cycle.narrow=true |
| fix_artifact | изменился scope/anchor/load-bearing decision | freeze_artifact с current_cycle.narrow=false |
| dispatch_narrow_review | нет Lead семьи вне union author/fixer set | human с park.reason=no_external_panel_lead |
| dispatch_narrow_review | один Lead child настроен/enrolled и parent имеет exact blocker child | narrow_review_join |
| narrow_review_join | verdict=BLOCKED_ANCHOR, pending_anchor или anchor mismatch | atomically ensure pending_anchor(reason, identity), human с park.reason=blocked_anchor |
| narrow_review_join | Lead status=new/work/human | join prologue обеспечивает exact blocker, narrow_review_join_wait; human child возобновляет пользователь |
| narrow_review_join_wait | blocker активен | step не запускается scheduler |
| narrow_review_join_wait | blocker terminal/removed | narrow_review_join |
| narrow_review_join | Lead status=done, NOT_PASS/findings и round >= cap | human с park.reason=review_cap |
| narrow_review_join | Lead status=done, NOT_PASS/findings и round < cap | fix_artifact |
| narrow_review_join | Lead status=done, verdict PASS текущей identity | record_artifact_pass |
| narrow_review_join | cancel/missing/invalid | human с park.reason=narrow_join_invalid |
| record_artifact_pass | pending_anchor | human с park.reason=blocked_anchor; ничего не записано |
| record_artifact_pass | identity/anchor/roster или verdict binding невалидны | human с park.reason=artifact_pass_invalid; ничего не записано |
| record_artifact_pass | verdict binding текущей identity валиден; для tech_plan Arena block валиден | atomically artifact_pass[kind]=identity+verdict, arena fields обновлены, select_next |
| record_artifact_pass | tech_plan Arena block malformed | human с park.reason=arena_contract_invalid |
| dispatch_arena | candidates и judge task настроены/enrolled, Judge blocked candidates и parent имеет exact blockers всех Arena children | arena_join |
| arena_join | pending_anchor или anchor mismatch | atomically ensure pending_anchor(reason, identity), human с park.reason=blocked_anchor |
| arena_join | любой Arena child status=new/work/human | join prologue обеспечивает exact blocker, arena_join_wait; human child возобновляет пользователь |
| arena_join_wait | хотя бы один expected blocker активен | step не запускается scheduler |
| arena_join_wait | все expected blockers terminal/removed | arena_join |
| arena_join | менее двух live candidates, fallback requested или candidate roster недостаточен | human с park.reason=arena_fallback_required |
| arena_join | judge status=done, минимум два live candidates и judgment binding валиден | apply_arena_decision |
| arena_join | cancel/missing/invalid judgment | human с park.reason=arena_join_invalid |
| apply_arena_decision | user/judge decision recorded для current_decision_id, включая fallback, и block entry rewritten applied/fallback с Decision Record/graft list ref | arena.decisions[id] terminal, current_decision_id=null, artifact_pass.tech_plan=null, kind=tech_plan, сохранить pre-arena identity, reexpression_required=true, review_cycles.tech_plan.narrow=false/full_panel_required=true, attempt+1, draft_artifact |
| rebuild_anchor | anchor_rebuild_op открыт | validate op binding; продолжить записанные per-ticket phases/dispositions без повторной классификации; phase=ready_to_transit повторяет только recorded target |
| rebuild_anchor | anchor_impact incomplete, current in-flight kind без current PASS не affected, upstream cascade нарушен, hash claimed-unaffected изменён или Ticket task re-binding не подтверждён | human с park.reason=anchor_impact_invalid |
| rebuild_anchor | любой affected Ticket status=work | human с park.reason=anchor_repair_ticket_live; никаких mutation, pending_anchor сохраняется |
| rebuild_anchor | affected Ticket status=human, но это не waiting_parent_anchor с suspension receipt и не blocked_anchor с обоснованным pending до absorption | human с park.reason=anchor_impact_invalid; никаких mutation |
| rebuild_anchor | affected planning kinds не пусты | bump anchor, re-bind unchanged unaffected passes, void affected bindings, current kind=earliest affected, current_cycle full required, draft_artifact |
| rebuild_anchor | planning kinds unchanged/re-bound, affected только Ticket code bindings, все affected Tickets status=human и каждый либо waiting_parent_anchor+suspension receipt, либо blocked_anchor+обоснованный pending до absorption | sole-writer bump/re-bind, clear consumed source pending, write Ticket receipts/anchors до resume, ready_to_transit(resume_repaired_tickets) |
| rebuild_anchor | planning kinds unchanged/re-bound, affected только Ticket code bindings, есть replacement disposition, нет status=work; dependency closure каскадно перенесла в replacement каждого human с replacement prerequisite, а оставшиеся human имеют допустимое recovery state | sole-writer bump/re-bind, clear consumed source pending; replacements только create/configure до phase=replacement_ready, без enroll/dependency/parent blockers; ready_to_transit(resume_repaired_tickets) |
| rebuild_anchor | affected bindings пусты, active Arena decision pending/running | bump/re-bind, void old Arena run binding, arena attempt+1, dispatch_arena |
| rebuild_anchor | affected bindings пусты, planning phase без active Arena | bump/re-bind, select_next |
| rebuild_anchor | affected bindings пусты, execution/ticket_join phase | bump/re-bind Ticket task metadata, ticket_join |
| resume_repaired_tickets | нет ровно одной open repair op (`anchor_rebuild_op` source=code_only либо `ticket_repair_op` source=`fresh|current|planning`) для current project/anchor/expected set | human с park.reason=ticket_repair_op_invalid; side effects отсутствуют |
| resume_repaired_tickets | replacement уже enrolled либо имеет dependency/parent blocker до `child_resumed` всех recorded human Tickets | human с park.reason=ticket_repair_state_invalid; op остаётся открытой, mutation запрещена |
| resume_repaired_tickets | recorded replacement имеет phase вне `{replacement_ready,replacement_enrolled}`, create-time marker/owner/scope mismatch либо required preparation incomplete | human с park.reason=ticket_repair_state_invalid; op остаётся открытой, phases не продвигаются |
| resume_repaired_tickets | recorded human recovery Ticket имеет transitive prerequisite в replacement set либо stable topological order/dependency plan нарушен | human с park.reason=ticket_repair_state_invalid; op остаётся открытой, mutation запрещена |
| resume_repaired_tickets | recorded human recovery Ticket не human+pending и прошлый resume не доказан consumed intent либо status/step после target | human с park.reason=ticket_repair_state_invalid; op остаётся открытой, phases не продвигаются |
| resume_repaired_tickets | repair op валидна, every replacement phase=`replacement_ready|replacement_enrolled`, parent не имеет premature replacement blockers, semantic writes sealed | в stable topological order для каждого recorded human recovery Ticket materialize dependency edges только к уже processed prerequisites, atomically записать/read-back pending resume_intent + park.reason=anchor_resume_pending; ensure/read-back exact parent blocker, phase=edge_restored; resume либо доказать прошлый resume, phase=child_resumed. После всех human phases для replacement_ready attach remaining dependency blockers, enroll, add exact parent blocker и set replacement_enrolled; already replacement_enrolled только read-back binding. Atomically op phase=ready_to_join/target=ticket_join, transit ticket_join |
| dispatch_ticket_dag | ticket_repair_op открыт, но project/anchor/tickets PASS/expected-set binding mismatch | human с park.reason=ticket_repair_op_invalid; side effects отсутствуют |
| dispatch_ticket_dag | ticket_repair_op открыт и recorded human task/path/hash/recovery state/dependency closure mismatch | human с park.reason=ticket_repair_state_invalid; op остаётся открытой, mutation запрещена |
| dispatch_ticket_dag | ticket_repair_op открыт и replacement уже enrolled/work либо имеет dependency/parent blocker | human с park.reason=ticket_repair_state_invalid; op остаётся открытой, mutation запрещена |
| dispatch_ticket_dag | ticket_repair_op открыт и не все recorded replacements phase=replacement_ready | validate op/project/anchor/tickets binding; продолжить только записанные create/configure phases без enroll/blockers; затем dispatch_ticket_dag |
| dispatch_ticket_dag | ticket_repair_op открыт, все human bindings валидны и replacements phase=replacement_ready | atomically phase=ready_to_transit/target=resume_repaired_tickets, transit resume_repaired_tickets |
| dispatch_ticket_dag | old Ticket status=work | human с park.reason=ticket_join_invalid; live task не изменяется и не отменяется автоматически |
| dispatch_ticket_dag | suspended receipt не сопоставлен живому Ticket и не имеет valid superseded_by mapping | human с park.reason=ticket_edge_receipt_lost |
| dispatch_ticket_dag | old Ticket status=human и его direct/transitive prerequisite уже replacement | parent map исключает old human, receipt/edge закрывается как superseded без auto-cancel/resume; сам Ticket и downstream human dependents каскадно становятся configured replacements |
| dispatch_ticket_dag | old Ticket status=done/cancel/new/missing либо path/hash/base не совпадает с current tickets PASS, либо Ticket удалён | old task superseded: parent map исключает old task; cancel только допустимую non-live task; cleanup+close receipt; создать новую Ticket task из current PASS |
| dispatch_ticket_dag | matched receipt, но scope/dependency blockers/candidate reset не подтверждены из current tickets PASS | human с park.reason=ticket_join_invalid |
| dispatch_ticket_dag | fresh/current Tickets PASS либо planning repair, все receipts matched/superseded, human bindings/dependency closure валидны, ticket_repair_op отсутствует | atomically создать durable ticket_repair_op с closed source=`fresh|current|planning`, phase=prepared, exact human/replacement map и target=resume_repaired_tickets; fresh path использует empty human set и все новые Tickets как replacements; dispatch_ticket_dag |
| ticket_join | human Ticket имеет schema/hash-valid event и receipt, edge отсутствует, но receipt ещё не final `edge_suspended` | восстановить exact blocker edge, transit ticket_join_wait; child возобновляется через complete_anchor_handoff до consume |
| ticket_join | human Ticket имеет schema/hash-valid event, но malformed/mismatched receipt | восстановить exact blocker edge, transit ticket_join_wait; child возобновляется через repair_anchor_handoff mode=receipt_only, event не дублируется |
| ticket_join | human Ticket имеет malformed/mismatched raw comment/event | восстановить exact blocker edge, transit ticket_join_wait; child возобновляется через repair_anchor_handoff mode=supersede_event, старый raw record не редактируется |
| ticket_join | human Ticket имеет matching immutable event + final `edge_suspended` receipt + waiting_parent_anchor=true и edge намеренно отсутствует | не восстанавливать edge; consume/ensure pending_anchor(reason, identity, affected Ticket), human с park.reason=blocked_anchor |
| ticket_join | другой unconsumed correction event, pending_anchor или anchor mismatch любого ожидаемого Ticket | consume/ensure pending_anchor(reason, identity, affected tickets), human с park.reason=blocked_anchor |
| ticket_join | любой другой ожидаемый Ticket status=new/work/human и соответствующий blocker отсутствует | восстановить exact blocker edge, transit ticket_join_wait |
| ticket_join_wait | blockers ещё открыты | step не запускается scheduler |
| ticket_join_wait | blockers terminal/removed | ticket_join |
| ticket_join | все Tickets status=done + code PASS + commit OID, auto-integration policy валидна | integrate |
| ticket_join | все Tickets status=done + code PASS + commit OID, auto-policy отсутствует или невалидна | accept statusStep("human") |
| ticket_join | cancel/missing/done без binding | human с park.reason=ticket_join_invalid |
| ticket_join | ожидаемый Ticket status=human | обеспечить exact blocker edge, transit ticket_join_wait; пользователь возобновляет child |
| accept | resume --to integrate, user acceptance той же identity записан, pending_anchor отсутствует | integrate |
| integrate | pending_anchor или anchor mismatch | atomically ensure pending_anchor(reason, identity), human с park.reason=blocked_anchor |
| integrate | следующий Ticket успешно CAS-integrated, остались Tickets | integrate |
| integrate | все Tickets integrated | aggregate_verify |
| integrate | precondition | human с park.reason=integration_precondition |
| integrate | obstruction | human с park.reason=integration_obstruction |
| integrate | foreign movement/indeterminate/reattach | integration_recovery или human по классификации |
| integration_recovery | branch/ref/state снова однозначны и postflight валиден | integrate или aggregate_verify по recorded phase |
| integration_recovery | состояние осталось foreign/indeterminate | human или cancel; обычный retry запрещён |
| aggregate_verify | pending_anchor | human с park.reason=blocked_anchor |
| aggregate_verify | все epic-критерии PASS | cleanup |
| aggregate_verify | NOT_PASS | human с park.reason=aggregate_verify_failed и scoped integration-fix action |
| cleanup | все sandboxes/snapshots удалены либо absent, dirty=false | done |
| cleanup | dirty=true при force=false | human с park.reason=cleanup_dirty |
| done | terminal | нет переходов |

Строки каждого шага применяются строго сверху вниз; success-предикаты явно исключают BLOCKED_ANCHOR, mismatch, fallback и недостаточный roster. select_next считает kind passed только если artifact_pass binding совпадает с текущими anchor_version, protocol hash и artifact identity. Tickets не входят в planning-kind search и появляются только после того, как все arena.decisions terminal. Stable pending order задаёт порядок entries в нормативном block; terminal entry никогда не запускается повторно.

### autosk-quick

~~~text
intake -> implement -> verify -> freeze -> dispatch_review -> review_join -> record_code_verdict
       -> fix -> verify -> freeze -> dispatch_narrow_review -> review_join -> record_code_verdict
       -> freeze -> record_editorial_exemption -> accept
       -> accept -> integrate -> cleanup -> done
                     -> integration_recovery -> integrate | human
recovery: rebuild_code_anchor -> verify
          review_join_wait -> review_join
          repair_protocol_snapshot -> recorded pre-failure step | human
~~~

accept — statusStep("human"); при валидной auto-integration policy только record_code_verdict после повторной валидации может перейти сразу в integrate.

### autosk-ticket

Workflow одной реализации из утверждённого комплекта Tickets:

~~~text
implement -> verify -> freeze -> dispatch_review -> review_join -> record_code_verdict
          -> fix -> verify -> freeze -> dispatch_narrow_review -> review_join -> record_code_verdict
          -> commit_on_pass -> ticket_done
recovery: rebuild_code_anchor -> verify
          complete_anchor_handoff -> human
          repair_anchor_handoff -> human
          review_join_wait -> review_join
          repair_protocol_snapshot -> recorded pre-failure step | human
~~~

Зависимости между Ticket-задачами выражаются autosk blockers.

### autosk-code-review

Отдельная child task с отдельным task ID и pinned snapshot workspace:

~~~text
review_candidate -> validate_verdict -> done
repair_protocol_snapshot -> recorded pre-failure step | human
~~~

Parent Ticket блокируется review child и после разблокировки принимает только status=done плюс verdict binding текущего tree OID. Review child status=human продолжает блокировать parent и возобновляется отдельно; cancel или stale verdict снимают blocker, после чего review_join переводит parent в human.

Общая таблица Quick/Ticket review cycle:

| Текущий шаг | Условие | Следующий шаг |
| --- | --- | --- |
| implement | provider/model недоступен после retry | human с park.reason=implement_provider_unavailable |
| implement | model run завершился без valid completion record | human с park.reason=implementation_result_invalid |
| implement | обнаружена out-of-scope/unexpected mutation | human с park.reason=implementation_scope_invalid |
| implement | completion record и declared scope валидны, worktree не коммитился | verify |
| verify | runner/environment failure после retry | human с park.reason=verification_environment_failed |
| verify | evidence отсутствует, malformed или не привязан к candidate | human с park.reason=verification_record_invalid |
| verify | проверки нашли candidate defect и repair cycle ниже cap | сохранить verification findings, fix |
| verify | проверки нашли candidate defect и repair cycle достиг cap | human с park.reason=verification_cap |
| verify | evidence record валиден и проверки PASS | freeze |
| freeze | scope/identity/tree mint невалидны или candidate изменился во время mint | human с park.reason=freeze_candidate_invalid |
| freeze | pending_anchor или anchor mismatch | atomically ensure pending_anchor(reason, identity), human с park.reason=blocked_anchor |
| freeze | review_cycle.full_review_required=true и full_review_reason=anchor_rebuild | dispatch_review |
| freeze | workflow=autosk-quick, review_cycle.full_review_required=true, full_review_reason=initial, editorial classification валидна, pending_anchor отсутствует, changed paths/bytes не затрагивают executable/config/schema/security/prompt/governance behavior | record_editorial_exemption |
| freeze | review_cycle.full_review_required=true | dispatch_review |
| freeze | review_cycle.full_review_required=false и candidate создан после confirmed fixes | dispatch_narrow_review |
| dispatch_review / dispatch_narrow_review | нет reviewer семьи вне union author/fixer set | human с park.reason=no_external_reviewer |
| dispatch_review / dispatch_narrow_review | child настроен/enrolled, parent blocked | review_join |
| review_join | child new/work/human | join prologue обеспечивает exact blocker, review_join_wait; human child возобновляет пользователь |
| review_join_wait | blocker активен | step не запускается scheduler |
| review_join_wait | blocker terminal/removed | review_join |
| review_join | BLOCKED_ANCHOR, pending_anchor или anchor mismatch | atomically ensure pending_anchor(reason, identity), human с park.reason=blocked_anchor |
| review_join | cancel/missing/stale/invalid | human с park.reason=review_join_invalid |
| review_join | PASS/NOT_PASS verdict binding текущей identity валиден | record_code_verdict |
| record_code_verdict | pending_anchor | human с park.reason=blocked_anchor; ничего не записано |
| record_code_verdict | повторная identity/binding validation не прошла | human с park.reason=code_verdict_invalid; ничего не записано |
| record_code_verdict | NOT_PASS/findings и round >= cap | если full, atomically full_review_required=false/full_review_reason=null; human с review_cap |
| record_code_verdict | NOT_PASS/findings и round < cap | если full, atomically full_review_required=false/full_review_reason=null; fix |
| record_code_verdict | PASS и workflow=autosk-ticket | если full, atomically full_review_required=false/full_review_reason=null; commit_on_pass |
| record_code_verdict | PASS и workflow=autosk-quick, auto-integration policy валидна | если full, atomically full_review_required=false/full_review_reason=null; integrate |
| record_code_verdict | PASS и workflow=autosk-quick, auto-policy отсутствует или невалидна | если full, atomically full_review_required=false/full_review_reason=null; accept |
| fix | confirmed review или verification findings исправлены | verify |
| record_editorial_exemption | initial-only classification + exact candidate identity + changed path set записаны вместо review verdict; повторная deterministic проверка всё ещё editorial | atomically full_review_required=false/full_review_reason=null, accept |
| rebuild_code_anchor | parent_epic_task отсутствует (standalone Quick), pending anchor валиден | own anchor_version+1, clear pending_anchor, review_cycle.full_review_required=true/full_review_reason=anchor_rebuild, verify |
| rebuild_code_anchor | parent_epic_task задан, waiting_parent_anchor=false, correction обоснована | append immutable correction event, void Ticket review binding, receipt phase=event_appended, park.reason=anchor_handoff_incomplete, `await ctx.transit(human)`, затем exact unblock parent и receipt phase=edge_suspended/waiting_parent_anchor; Epic metadata не писать |
| complete_anchor_handoff | event hash/receipt валидны, Ticket human, parent edge ещё active | идемпотентно подтвердить human park, exact unblock parent, receipt phase=edge_suspended, park.reason=waiting_parent_anchor |
| repair_anchor_handoff | mode=receipt_only, raw event schema/hash валиден, bad receipt и parent edge active подтверждены | event не дублировать; atomically пометить bad Ticket receipt superseded_by, создать новый receipt для того же event; выполнить park→exact-unblock→final edge_suspended contract, Epic metadata не писать |
| repair_anchor_handoff | mode=supersede_event, human-approved bad raw comment/event hash и parent edge active подтверждены | append новый schema-valid event_id с exact `{supersedes_raw_comment_id,supersedes_raw_hash,approval_hash}`, atomically пометить старый Ticket receipt superseded_by, создать новый event_appended receipt; выполнить park→exact-unblock→final edge_suspended contract, Epic metadata не писать |
| rebuild_code_anchor | waiting_parent_anchor=true, Ticket anchor=parent anchor, pending_anchor=null, matching parent_rebuild_receipt, exact edge восстановлен и pending resume_intent совпадает с parent op/target/anchor/receipt | atomically resume_intent.state=consumed, suspension receipt state=edge_restored, waiting_parent_anchor=false, park.reason=null, review_cycle.full_review_required=true/full_review_reason=anchor_rebuild, verify |
| rebuild_code_anchor | waiting_parent_anchor=false, resume_intent.state=consumed, suspension receipt state=edge_restored, matching parent receipt/op/anchor и review reason=anchor_rebuild | metadata уже committed; идемпотентно transit verify без повторного consume/bump |
| rebuild_code_anchor | waiting_parent_anchor=true, edge active, но resume_intent absent/mismatch | human с park.reason=anchor_resume_intent_invalid |
| rebuild_code_anchor | parent_epic_task задан, waiting_parent_anchor=false, Ticket anchor=parent anchor, pending_anchor=null, matching parent_rebuild_receipt записан parent, suspended receipt отсутствует | review_cycle.full_review_required=true/full_review_reason=anchor_rebuild, verify |
| commit_on_pass | Ticket или parent epic pending_anchor / anchor mismatch | atomically ensure pending_anchor(reason, identity), human с blocked_anchor |
| commit_on_pass | current tree не равен approved tree | human с park.reason=candidate_changed |
| commit_on_pass | private branch уже указывает на approved tree | восстановить commit metadata, ticket_done |
| commit_on_pass | private branch на recorded base, CAS success | записать commit metadata, ticket_done |
| commit_on_pass | private branch на recorded base, CAS failed и ref всё ещё на base | human с park.reason=commit_cas_failed |
| commit_on_pass | private branch на другом OID/tree | human с park.reason=commit_foreign_movement |
| ticket_done | terminal | нет переходов |

Quick tail:

| Текущий шаг | Условие | Следующий шаг |
| --- | --- | --- |
| accept | resume --to integrate, acceptance той же identity, pending_anchor отсутствует | integrate |
| integrate | pending_anchor или anchor mismatch | ensure pending_anchor, human с blocked_anchor |
| integrate | success | cleanup |
| integrate | precondition | human с integration_precondition |
| integrate | obstruction | human с integration_obstruction |
| integrate | foreign movement/indeterminate/reattach | integration_recovery или human по классификации |
| integration_recovery | branch/ref/state однозначны и postflight валиден | integrate или cleanup по recorded phase |
| integration_recovery | foreign/indeterminate сохраняется | human; cancel отдельной status-операцией |
| cleanup | dirty=false и sandbox removed/absent | done |
| cleanup | dirty=true при force=false | human с cleanup_dirty |
| done | terminal | нет переходов |

### autosk-panel-seat

Одна задача одного места панели:

~~~text
review_artifact -> validate_verdict -> done
repair_protocol_snapshot -> recorded pre-failure step | human
~~~

Route, role и lens читаются из metadata. onTransit разрешает done только после появления verdict record правильной схемы и правильной artifact identity.

### autosk-contest-seat

Новая child task для каждого originating panel seat:

~~~text
review_disposition -> validate_disposition -> done
repair_protocol_snapshot -> recorded pre-failure step | human
~~~

Identity включает artifact identity, canonical finding IDs, proposed rejection/downgrade и originating seat. Обычный panel PASS не является contest disposition.

### autosk-arena-candidate

~~~text
build_candidate -> verify_candidate -> freeze_candidate -> done
repair_protocol_snapshot -> recorded pre-failure step | human
~~~

### autosk-arena-judge

Эта задача blocked_by кандидатскими задачами:

~~~text
judge -> validate_judgment -> done
repair_protocol_snapshot -> recorded pre-failure step | human
~~~

### Исчерпывающий contract дочерних workflows

Panel seat, contest seat, code reviewer и Judge сами не вызывают transit и не пишут comments/evidence. Модель может только передать один payload закрытой схемы через `submit_gate_result`. После завершения model run deterministic tail того же GateAgent AgentDefinition сначала снова вызывает `assertProjectBoundary`, затем перед каждым record fs/RPC side effect повторяет guard и в строгом порядке: проверяет envelope текущей task/session/identity, записывает immutable result record в project-owned storage, перечитывает его bytes/hash, сверяет pre/post snapshot и sibling-store hashes, затем вызывает `ctx.transit(validate_*)`. Модель и submit tool не владеют этой записью. Deterministic validate-step всегда завершает работу одним из двух переходов: `done` для валидного binding либо `human` с точной причиной. Возврат модели без submit и provider failure также явно паркуются, поэтому ни один child AgentDefinition не заканчивает onRun без transition.

| Workflow / текущий шаг | Условие | Следующий шаг |
| --- | --- | --- |
| panel-seat review_artifact / code-review review_candidate | provider недоступен после retry | human с park.reason=gate_provider_unavailable |
| panel-seat review_artifact / code-review review_candidate | model run завершился без единственного valid submit | human с park.reason=gate_result_missing |
| panel-seat review_artifact / code-review review_candidate | host принял один schema-valid payload и записал/read-back record | validate_verdict |
| validate_verdict | record/session/identity/snapshot/store hashes валидны | done |
| validate_verdict | record malformed/stale/binding mismatch | human с park.reason=gate_result_invalid |
| validate_verdict | snapshot либо parent/sibling store неожиданно изменён | human с park.reason=gate_snapshot_mutated |
| contest-seat review_disposition | provider недоступен после retry либо submit отсутствует | human с gate_provider_unavailable или gate_result_missing |
| contest-seat review_disposition | host записал и перечитал schema-valid disposition | validate_disposition |
| validate_disposition | finding/originating-seat/identity binding валиден и snapshot/store неизменны | done |
| validate_disposition | binding/record невалиден либо обнаружена mutation | human с gate_result_invalid или gate_snapshot_mutated |
| arena-judge judge | provider недоступен после retry либо submit отсутствует | human с gate_provider_unavailable или gate_result_missing |
| arena-judge judge | host записал и перечитал schema-valid judgment | validate_judgment |
| validate_judgment | anonymous roster/rubric/evidence/identity binding валиден и store неизменён | done |
| validate_judgment | binding/record невалиден либо обнаружена mutation | human с gate_result_invalid или gate_snapshot_mutated |
| arena-candidate build_candidate | provider/input/sandbox precondition невалидны | human с park.reason=arena_candidate_failed |
| arena-candidate build_candidate | candidate bytes и declared evidence записаны в isolated worktree | verify_candidate |
| verify_candidate | измеримые rubric checks PASS и evidence complete | freeze_candidate |
| verify_candidate | NOT_PASS, incomplete evidence или runner failure после retry | human с park.reason=arena_candidate_verify_failed |
| freeze_candidate | base/pathspec/tree OID и candidate binding повторно совпали | done |
| freeze_candidate | identity/scope изменились либо snapshot mint невалиден | human с park.reason=arena_candidate_freeze_invalid |

## 3. Минимальная структура расширения

~~~text
autosk-flow/
  package.json
  src/
    index.ts
    config.ts
    agents/
      resolved-pi-agent.ts
      gate-agent.ts
      deterministic-step.ts
    workflows/
      planned.ts
      quick.ts
      ticket.ts
      code-review.ts
      panel-seat.ts
      contest-seat.ts
      arena-candidate.ts
      arena-judge.ts
    orchestration/
      child-tasks.ts
      prompt-compiler.ts
      session-continuity.ts
      protocol-snapshot.ts
      anchor-rebuild.ts
      artifact-identity.ts
      record-artifact-pass.ts
      record-code-verdict.ts
      verdicts.ts
      submit-gate-result.ts
      freeze.ts
      pinned-worktree.ts
      commit-on-pass.ts
      integrate.ts
      integration-recovery.ts
    schemas/
      verdict.ts
      disposition.ts
      judgment.ts
      metadata.ts
  resources/
    governance/
      bundles/
        autosk-v1/
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
  tools/
    import-traycer-baseline.ts   # explicit local migration tool, not runtime
~~~

Exact imported Traycer baseline хранится только локально вне public Git. `import-traycer-baseline` читает явно переданные guide/protocol paths, требует regular Guide + exact 12 expected Markdown paths, игнорирует только `.DS_Store`, отклоняет любой другой unexpected entry/symlink, вычисляет hashes, создаёт diff proposal для нового autosk-native bundle и завершается. Он не устанавливает watcher и не добавляет runtime lookup в `~/.traycer`.

`bundle-manifest.json` содержит `schemaVersion`, `bundleId`, `bundleVersion`, provenance без личных paths, ordered map из 13 relative paths в SHA-256 и canonical content digest. Preimage digest — domain separator + canonical metadata + ordered file map; собственное поле `contentDigest` и attestation исключены, поэтому цикла нет. Exact manifest bytes хешируются отдельно. `bundle-attestation.json` хранит content digest и четыре verdict/session/record hashes; его создание не меняет проверенную content identity. Project-owned `protocol.lock.json` связывает content digest, exact manifest hash, attestation hash, project_root_sha256, Epic ID и snapshot path. Изменение governance byte/canonical manifest metadata создаёт новую content identity; изменение attestation не переписывает manifest.

## 4. Metadata contract

Все поля живут под одним namespace, чтобы не конфликтовать с autosk и другими extensions.

Единственный машинный enum ArtifactKind: brief | core_flow | tech_plan | tickets. Имена файлов могут содержать дефисы, metadata и переходы — никогда.

Каждая task metadata содержит неизменяемый project binding `{canonical_root, project_root_sha256}`. Parent/child, blocker, session, verdict и evidence binding с разными project_root_sha256 недействительны. Любая CLI/RPC операция получает canonical root явно; текущий shell cwd и branch name project identity не определяют.

Optional `correlation_id` — только UUID по закрытой схеме. В нём нет path/task/session/evidence refs; расширение никогда не выполняет lookup по этому полю.

Каждая model-owned задача, чей AgentDefinition вызывает resolvedPiAgent либо restricted gateAgent — Epic/Quick parent, Ticket implementer, panel/contest/narrow seat, code-review child, Arena candidate/Judge — имеет собственный autosk_flow.session record одной общей схемы. Reviewer/Judge session никогда не копируется из implementer/author task. Без собственного record enroll запрещён.

### Epic task

~~~json
{
  "autosk_flow": {
    "schema": 1,
    "project": {
      "canonical_root": "/absolute/project-root",
      "project_root_sha256": "..."
    },
    "mode": "planned",
    "epic_id": "epic-001",
    "correlation_id": null,
    "session": {
      "provider_session_id": "...",
      "provider_session_dir": "/absolute/project-root/.autosk/autosk-flow/provider-sessions",
      "provider_session_file": null,
      "generation": 1,
      "replaces": null
    },
    "anchor_version": 1,
    "pending_anchor": null,
    "anchor_impact": null,
    "anchor_rebuild_op": null,
    "ticket_repair_op": null,
    "correction_watermark": null,
    "correction_dispositions": {},
    "protocol": {
      "hash": "sha256",
      "snapshot_path": "/absolute/project-root/.autosk/autosk-flow/protocol-snapshots/sha256"
    },
    "classification": {
      "brief": true,
      "core_flow": true,
      "tech_plan": true,
      "tickets": true
    },
    "artifact_pass": {
      "brief": null,
      "core_flow": null,
      "tech_plan": null,
      "tickets": null
    },
    "arena": {
      "decisions": {},
      "current_decision_id": null
    },
    "current_artifact": {
      "kind": "tech_plan",
      "base_oid": "...",
      "pathspec": ["docs/autosk/epics/epic-001/tech-plan.md"],
      "tree_oid": "...",
      "snapshot_commit": "...",
      "file_hashes": {},
      "attempt": 1
    },
    "authorship": {
      "author_families": ["codex"],
      "fixer_families": []
    },
    "panel": {
      "run_id": "...",
      "seats": {
        "gpt": {
          "task_id": "...",
          "provider_session_id": "...",
          "provider_session_dir": "/absolute/project-root/.autosk/autosk-flow/provider-sessions",
          "provider_session_file": null,
          "generation": 1,
          "replaces": null
        }
      },
      "actual_roster": [],
      "status": "pending"
    },
    "review_sessions": {},
    "review_cycles": {
      "brief": {
        "round": 1,
        "last_round": 0,
        "cap": 10,
        "narrow": false,
        "full_panel_required": true,
        "open_findings": [],
        "contest_tasks": []
      }
    },
    "ticket_tasks": [],
    "park": null,
    "waivers": {
      "panel": null,
      "review": null,
      "auto_integrate": false
    }
  }
}
~~~

`anchor_rebuild_op` хранит закрытый `source=planning|code_only|arena|no_bindings`, `op_id`, consumed correction event IDs/watermark, pre-resume Epic/Ticket hashes, `from_version`, `to_version`, immutable dispositions каждого Ticket, stable topological order human recovery set/dependency plan, per-ticket phase (`prepared | replacement_ready | edge_restored | child_resumed | replacement_enrolled | superseded`), общую phase (`prepared | anchor_committed | ready_to_transit | resuming_children | ready_to_join`), recorded target и expected identity. Только source=code_only может иметь target=`resume_repaired_tickets`; остальные закрываются prologue своего planning/Arena/join target. Наличие открытой операции имеет приоритет над обычными guard-строками `rebuild_anchor`.

`ticket_repair_op` — общая parent-owned dispatch operation с закрытым `source=fresh|current|planning` для первичного/current Ticket DAG и planning repair после того, как прежний `anchor_rebuild_op` законно закрыт planning target prologue. На source=fresh human recovery set пуст, а все новые Tickets идут как configured replacements. Operation хранит project/anchor/tickets PASS binding, stable topological order exact human recovery set, replacements, dependency plan, per-task phases (`prepared | replacement_ready | edge_restored | child_resumed | replacement_enrolled`) и target=`resume_repaired_tickets`. Replacements не enroll'ятся и не получают dependency/parent blockers до `child_resumed` всех recorded human Tickets. `ticket_join` prologue закрывает ровно ту dispatch op, которая привела к нему.

`correction_dispositions` не редактирует comments и не превращается во второй inbox. Это parent-owned terminal map только для raw records, которые не могут пройти schema/hash validation: exact raw comment id/hash получает единственный status=`superseded`, ссылку на более поздний schema-valid human-approved event и approval hash. Watermark может пройти invalid raw record только в той же атомарной записи disposition; mismatch id/hash снова блокирует gate.

Epic `autosk_flow` metadata имеет единственного writer — parent deterministic steps. Пользователь, модели и Tickets публикуют correction events в append-only comments. Событие, пришедшее после consumed watermark, не конкурирует с metadata write и будет обработано следующим parent gate. Parent завершает все semantic anchor/binding writes до первого Ticket resume; после него пишет только монотонные active repair-op phases и закрывает op в `ticket_join` prologue.

### Ticket task

~~~json
{
  "autosk_flow": {
    "schema": 1,
    "project": {
      "canonical_root": "/absolute/project-root",
      "project_root_sha256": "..."
    },
    "parent_epic_task": "...",
    "session": {
      "provider_session_id": "...",
      "provider_session_dir": "/absolute/project-root/.autosk/autosk-flow/provider-sessions",
      "provider_session_file": null,
      "generation": 1,
      "replaces": null
    },
    "ticket_artifact": "docs/autosk/epics/epic-001/tickets/T01.md",
    "anchor_version": 1,
    "pending_anchor": null,
    "waiting_parent_anchor": false,
    "resume_intent": null,
    "parent_rebuild_receipt": null,
    "protocol_hash": "...",
    "authorship": {
      "author_families": ["grok"],
      "fixer_families": []
    },
    "scope": {
      "base_oid": "...",
      "pathspec": ["src/...", "test/..."]
    },
    "candidate": {
      "attempt": 1,
      "tree_oid": "...",
      "snapshot_commit": "..."
    },
    "review_cycle": {
      "round": 1,
      "last_round": 0,
      "cap": 10,
      "full_review_required": true,
      "full_review_reason": "initial"
    },
    "review_sessions": {},
    "review": {
      "task_id": "...",
      "session_id": "...",
      "reviewer_family": "codex",
      "verdict_hash": "...",
      "status": "pass"
    },
    "integration": null
  }
}
~~~

`parent_rebuild_receipt` — записываемое только родительским deterministic step доказательство `{op_id, parent_task_id, ticket_task_id, from_version, to_version, disposition}`. Для affected Ticket оно связывает поглощённый `pending_anchor` с конкретной перестройкой родителя. Старый receipt не проходит guard после следующего изменения версии.

`resume_intent` — parent-written recovery record `{op_id, target, anchor_version, receipt_hash, state}`. Parent одной атомарной pre-edge записью устанавливает `state=pending` и `park.reason=anchor_resume_pending`, перечитывает оба поля, после чего больше не пишет Ticket metadata. Только `rebuild_code_anchor` той же Ticket может атомарно изменить state на `consumed` вместе с очисткой waiting flag/park reason и нормализацией suspension receipt. Intent сохраняется до закрытия repair op/cleanup и позволяет отличить crash до resume от уже начатого child workflow без last-write-wins между двумя writers.

Receipt приостановленной blocker-связи содержит `{parent_task_id, ticket_task_id, blocker_id, blocked_id, ticket_artifact, ticket_hash, base_oid, state}`. `dispatch_ticket_dag` считает старую task совпавшей только при status=human с ожидаемым `blocked_anchor`/`waiting_parent_anchor` recovery metadata, равенстве пути, канонического hash байтов Ticket из текущего `tickets` PASS и точного execution base OID. Human task остаётся reusable только если ни одна её transitive prerequisite не классифицирована replacement; иначе она сама и её downstream human dependents каскадно становятся replacements. Совпавшей reusable task до resume заново выдаются только scope.base_oid/pathspec и dependency plan из текущего PASS; dependency edges разрешены лишь к уже processed reusable prerequisites или terminal unaffected tasks. Done/cancel/new/missing task, изменившийся Ticket/base и human с replacement prerequisite всегда получают configured-but-not-enrolled replacement; live work task автоматически не отменяется и паркует parent.

Для Ticket с parent_epic_task поле anchor_version всегда копируется из parent и изменяется только parent rebuild_anchor. Самостоятельный счётчик разрешён только standalone Quick.

### Panel seat task

Содержит parent_task, run_id, seat, route, role, author_families, собственную autosk_flow.session запись общей схемы и полную frozen artifact identity. Dispatcher копирует выбранный parent panel.seats record в child autosk_flow.session до enroll. Seat task не может изменить identity или session binding.

Route binding — исполняемый protocol data, а не свободный выбор агента:

| Author set | Lead | Дополнительные места |
| --- | --- | --- |
| Claude | GPT | Kimi intent, Grok feasibility, Opus supplementary architecture |
| Codex | Kimi | GPT supplementary intent, Grok feasibility, Opus architecture |
| Grok | GPT | Kimi intent, Grok supplementary feasibility, Opus architecture |
| Kimi | GPT | Kimi supplementary intent, Grok feasibility, Opus architecture |
| Human/outside | GPT | Kimi intent, Grok feasibility, Opus architecture |

Mixed author set выбирает Lead по мастер-порядку GPT -> Kimi -> Grok -> Opus, оставляя только семьи вне union author/fixer set и с доступным exact route. Если список пуст, dispatch запрещён и задача переходит в human. Выбранный Lead и его provider session фиксируются до первого dispatch и не меняются между раундами без формального replacement.

Code reviewer routing использует union author_families + fixer_families:

| Code author set | Порядок выбора reviewer |
| --- | --- |
| Claude only | GPT -> Kimi -> Grok |
| Codex only | Kimi -> Grok |
| Grok only | GPT -> Kimi |
| Kimi only | GPT -> Grok |
| Human/outside only | GPT -> Kimi -> Grok |
| Mixed | мастер-порядок GPT -> Kimi -> Grok, отфильтрованный до семей вне union author/fixer set |

Выбирается первый доступный exact route. Если внешней семьи нет, park.reason=no_external_reviewer; обычный same-family review запрещён. Пользователь может направить работу внешнему human reviewer, потребовать re-expression одним автором на новом candidate или дать точный review waiver.

## 5. Детали ключевых механизмов

### Classification

Opus предлагает classification и короткое обоснование. Детерминированный guard проверяет форму, явные пользовательские waivers и обязательные признаки Planned. Неопределённость выбирает Planned, а не Quick.

### Protocol snapshot

Перед первым модельным шагом:

1. открыть bundled `bundle-manifest.json` и потребовать один Guide плюс exact 12 protocol paths;
2. отклонить symlink, non-regular file, неизвестный или отсутствующий entry;
3. прочитать verified bytes, сверить per-file SHA-256 и общий bundle digest;
4. проверить detached attestation против уже вычисленного content digest;
5. через ctx.projectRoot получить absolute canonical destination, не sandbox cwd;
6. проверить, что destination находится внутри canonical project root текущей задачи;
7. атомарно записать immutable bundle snapshot и `protocol.lock.json` в namespaced каталог проекта;
8. записать bundle id/version/content digest, manifest/attestation hashes, absolute path и project_root_sha256 в metadata;
9. на каждом dispatch повторно проверить lock, snapshot hashes и project_root_sha256, не сравнивая с текущей установленной версией bundle.

Ни один шаг не ищет `~/.traycer`, `forCursor.md`, Traycer skill или Obsidian. Явный import tool завершается до сборки bundle и не доступен model/runtime workflows.

Провал lock/snapshot validation не выполняет model/fs side effects и паркует task с `protocol_lock_invalid`. Один common deterministic `repair_protocol_snapshot` зарегистрирован в каждом Planned, Quick, Ticket, panel/contest/code-review и Arena workflow; task сохраняет exact pre-failure step и после repair возвращается только в него. Repair восстанавливает bytes только из exact content-addressed bundle/attestation, записанных в lock. Если эта версия недоступна, требуется human reinstall exact bundle либо явная migration на новую bundle identity с anchor impact и полными gates; current installed latest молча не подставляется.

### resolvedPiAgent

Небольшой wrapper в onRun:

1. читает current task metadata;
2. проверяет route и protocol snapshot;
3. компилирует firstMessage;
4. проверяет session binding: ID, project-owned directory и optional absolute provider_session_file;
5. для первого запуска создаёт штатный piAgent с `--session-id` + `--session-dir`; после запуска читает get_state и атомарно сохраняет exact absolute sessionFile;
6. для любого follow-up/full re-panel/narrow/contest открывает exact file через `--session <absolute-session-file>`; session ID без file не считается cwd-independent resume key;
7. проверяет, что session file лежит внутри project provider-sessions, а header model/family/role/session ID совпадают;
8. проксирует onSteer, onFollowup и onAbort текущему inner agent.

Для author/implementer wrapper сохраняет штатный driver и transit correction piAgent. GateAgent переиспользует тот же session launch/continuity слой, но подменяет tool allowlist и завершение run на описанный ниже host-mediated `submit_gate_result`; общий piAgent driver не форкается.

### Session continuity

Первый dispatch места создаёт provider_session_id и project-owned provider_session_dir. После фактического запуска exact provider_session_file становится главным resume binding. Следующая child task того же места получает ID/dir/file до enroll и открывает file независимо от нового worktree cwd. Если file отсутствует/повреждён, replacement создаёт новую generation и `replaces`; молчаливое создание второго jsonl с тем же ID запрещено. Сравнения между проектами всегда включают project_root_sha256.

Источники session record:

- Epic/Quick author и coordinator — собственный epic.session;
- Ticket implementer — собственный ticket.session;
- panel, Lead narrow и contest — соответствующий panel.seats[seat], причём contest использует originating seat;
- code-review child — stable review_sessions[reviewer_family] в Ticket/Quick metadata, создаваемый при первом dispatch_review;
- Arena candidates и Judge — раздельные arena.decisions[decision_id].sessions[role], создаваемые при первом dispatch этой развилки и переиспользуемые только для её retry.

Dispatcher никогда не копирует author/implementer session в reviewer или Judge. provider_session_id reviewer, Judge и gate-carrying seat обязан отличаться от session IDs всех author/fixer tasks данного scope; совпадение аннулирует dispatch/verdict.

Правила:

- full re-panel возобновляет четыре прежних seat sessions;
- narrow re-review возобновляет только Lead session;
- contest возобновляет sessions всех originating seats;
- session никогда не переиспользуется для другой model family или другой роли после lead rebinding;
- unavailable/corrupt session заменяется новым; metadata generation увеличивается, replaces указывает прежний session/task;
- replacement получает предыдущие canonical findings и dispositions явно, а не полагается на утраченную историю.

Task ID может быть новым для каждого раунда ради blockers и audit, provider_session_id остаётся тем же. Таким образом autosk сохраняет нативный task graph и одновременно переотправляет исправления тем же логическим агентам.

### Project boundary guard

Каждый deterministic AgentDefinition и deterministic host tail внутри GateAgent начинают с `assertProjectBoundary` и повторяют его непосредственно перед каждым fs/Git/CLI/RPC side effect. Это явно включает запись/read-back gate result после model run. `onTransit` выполняет только вторую defense-in-depth проверку; поздний отказ не считается защитой уже выполненной записи.

Guard проверяет project binding всех task/session/blocker/verdict/evidence refs, устанавливает `AUTOSK_CWD=ctx.projectRoot` для каждого autosk CLI процесса и использует `safeProjectFs`. Разрешённый root по умолчанию — canonical project root; единственное исключение — Git worktree operation под exact `~/.autosk/worktrees/<project_root_sha256>/`, тоже связанная metadata owner текущего проекта.

- canonical root получается через realpath один раз на run;
- каждый существующий path component проверяется через lstat и не может быть symlink/junction;
- `..`, absolute foreign path и prefix-only совпадение отклоняются;
- create/rename/delete выполняются fd-relative с no-follow semantics и post-check canonical parent;
- если платформа не даёт race-safe no-follow primitive, side effect fail-closed, а не ослабляется lexical check;
- ноль side effects допустим до успешного guard.

### Child tasks

Использовать ctx.exec с autosk CLI до появления write API в SDK:

- передать canonical project root каждой CLI/RPC операции и проверить project binding в прочитанной task view;
- до create искать exact deterministic marker в create-time title/description: `[autosk-flow:<project_root_sha256>:<parent-id>:<run-id>:<seat-or-type>]`;
- create без workflow, но уже с этим marker; metadata ещё не считается готовой;
- metadata set, включая обязательный собственный autosk_flow.session record из правильного role registry для любой model-owned task;
- при необходимости подготовить branch/worktree от точного snapshot/base;
- enroll после полной настройки;
- block parent только после готовности всего набора;
- для anchor repair снять ровно edge `autosk unblock <parent-id> <ticket-id>`, сохранив receipt; `--all` запрещён;
- при восстановлении сначала записать/read-back child resume_intent, затем вернуть ровно его edge командой `autosk block <parent-id> <ticket-id>` и только после этого выполнить `autosk resume <ticket-id> --to rebuild_code_anchor`; `--all` и resume без matching intent запрещены.

Каждая операция проверяет exit code и перечитывает созданную task view. Create-time marker позволяет найти task после crash до metadata set; task никогда не enroll до полной metadata/session/sandbox проверки. Retry переиспользует ровно один marker-matched child, а duplicate marker паркует dispatch. Recovery sweep закрывает только собственные `new` tasks с валидным marker и незавершённой metadata; произвольные unlabeled tasks не трогает. Совпавший run_id другого проекта никогда не считается той же операцией.

Эти команды являются доступными autosk CLI-операциями, а не действиями модели. Обычную human-задачу возобновляет пользователь; единственное автоматическое исключение — deterministic parent step для anchor repair с валидными parent rebuild и edge receipts. Preflight расширения в временном проекте обязан доказать точечный `block -> unblock -> block` и parent-initiated `resume --to rebuild_code_anchor`; отсутствие любой операции останавливает запуск до создания реальных задач.

Resume intent записывается до blocker. Crash до edge оставляет parent runnable и retry продолжает op. Crash после edge, но до resume оставляет parent blocked и child human с park.reason=anchor_resume_pending и exact target; пользователь возобновляет именно child, который валидирует intent и очищает его на входе. После normal resume child владеет прогрессом, а terminal blocker снова открывает parent. Только после обработки всех Tickets parent transits `ticket_join`, чей prologue закрывает op. Редкое crash-окно требует явного child resume, но не создаёт неразрешимой блокировки и не зависит от числа workers.

Все side effects — create/block/enroll/metadata, host-side gate result record, Git freeze, worktree preparation и integration — выполняются только guarded deterministic кодом AgentDefinition, где доступен current ctx и project boundary adapter. Model tool side effects отсутствуют. onTransit ничего не запускает и не пишет во внешние системы: он только читает task/metadata, проверяет guard и разрешает либо отклоняет один переход.

### Contest и anchor changes

После synthesis любое предложенное отклонение или снижение серьёзности finding создаёт contest child task каждому originating seat. Parent блокируется ими и не переходит к fix/PASS до валидных dispositions.

Новая пользовательская инструкция, изменение Decision Log или Ticket/verdict signal не пишет Epic metadata напрямую. Источник добавляет immutable structured `anchor_correction` event в comments родительского Epic: `{event_id, project_root_sha256, source_task/session, source_anchor, affected_identity, reason, payload_hash, supersedes_raw_comment_id?, supersedes_raw_hash?, approval_hash?}`. Supersedes-поля разрешены только парой с human approval. Parent deterministic gate проверяет/хеширует event, как единственный metadata writer merge'ит его в pending_anchor и записывает consumed event IDs/watermark либо exact terminal disposition invalid raw record. Поздний event остаётся в inbox до следующего gate и не может быть стёрт parent write.

Ticket correction соблюдает порядок: append accepted event → atomically park Ticket human/waiting с receipt → только затем exact unblock parent. Crash до park/unblock оставляет parent blocked, а Ticket recovery повторяет тот же event_id. `BLOCKED_ANCHOR` verdict проходит тот же event path. Редактирование comment после принятия не меняет event, потому gate связан с принятым record hash.

Явный deterministic AgentDefinition step rebuild_anchor:

1. если `anchor_rebuild_op` уже открыт, проверяет его task/from/to binding и продолжает только записанную phase и per-ticket dispositions; `pending_anchor` повторно не требуется, текущие Ticket status не переклассифицируют уже назначенные действия;
2. только для новой операции сначала consume'ит correction inbox, затем требует pending_anchor, human-approved anchor_impact и отсутствие живых review children;
3. требует классификацию каждого существующего planning PASS, каждого Ticket binding, status/recovery metadata каждой Ticket task и текущего in-flight kind; in-flight kind без current PASS всегда affected, kind с current PASS может быть unaffected_rebind;
4. применяет обязательный cascade brief -> core_flow -> tech_plan -> tickets -> Ticket code: downstream не может быть unaffected_rebind, если affected любой upstream kind;
5. для unaffected_rebind повторно проверяет неизменность bytes/tree и human approval, готовит binding новой anchor_version;
6. при неполной карте, нарушенном cascade, изменившемся claimed-unaffected hash или human Ticket вне двух допустимых pre-rebuild recovery states ничего не меняет и паркует anchor_impact_invalid; при любом affected Ticket status=work ничего не меняет, сохраняет pending_anchor и паркует anchor_repair_ticket_live;
7. один раз создаёт idempotent anchor_rebuild_op с from_version, to_version=from+1, dispositions и phase; retry продолжает тот же to_version и никогда не bump'ит второй раз;
8. пока Tickets ещё не resume'нуты, идемпотентно пишет их anchor_version=to_version: unaffected re-bind'ит code/commit binding; affected Ticket очищает только source pending, получает parent_rebuild_receipt/full_review_required; done/cancel/new/missing получает replacement phases и superseded_by. Несовпадение с записанным pre-resume Ticket state паркует anchor_impact_invalid;
9. как единственный Epic metadata writer устанавливает anchor_version=to_version, re-bind'ит planning PASS, void'ит active/affected bindings, очищает обработанный pending_anchor, сохраняет consumed correction watermark и переводит op в `anchor_committed`; events после watermark остаются в comments, op не закрывается;
10. если affected planning kinds не пусты, сохраняет repair map с ticket_artifact/hash/base, выбирает earliest affected kind, ставит full panel required и записывает target=`draft_artifact`; future dispatch_ticket_dag разрешит receipts только по строгому совпадению или superseded cleanup;
11. если affected лишь Ticket code bindings, выполняет все semantic anchor/binding writes и доводит replacements только до create/configure `replacement_ready`; enroll, dependency blockers и parent blockers запрещены до `child_resumed` всех recorded human Tickets; затем target=`resume_repaired_tickets`;
12. если affected bindings пусты, active Arena run void и target=`dispatch_arena`; иначе target=`select_next` либо `ticket_join` по записанной phase;
13. после всех side effects повторно проверяет receipts, отсутствие premature replacement blockers и то, что parent остаётся runnable, затем атомарно ставит `phase=ready_to_transit` и recorded target;
14. retry с `ready_to_transit` не требует pending_anchor и вызывает только тот же `ctx.transit(recorded_target)`;
15. каждый возможный target начинает deterministic prologue и проверяет фактический target/anchor/version. Обычный target атомарно закрывает op. `resume_repaired_tickets` вместо закрытия ставит phase=`resuming_children`, завершает human intent/edge/resume phases, только затем enroll'ит replacements и добавляет dependency/parent blockers, atomically ставит phase=`ready_to_join`/target=`ticket_join` и transits; лишь ticket_join prologue закрывает active repair op. Crash на любой границе продолжает записанную phase;
16. интеграция запрещена до нового PASS всех affected Tickets; новая identity идёт только в полную соответствующую panel/code-review gate.

Ticket anchor_version — производная копия parent Epic anchor, не самостоятельный счётчик. rebuild_code_anchor:

- для standalone Quick без parent_epic_task увеличивает собственный anchor и требует full Code Review;
- для Ticket append'ит immutable `anchor_correction` event в parent comments, но не пишет Epic metadata; в собственной Ticket metadata void'ит review binding, ставит waiting_parent_anchor=true и сохраняет receipt временного удаления blocker edge parent<-Ticket;
- Ticket остаётся human, но suspension позволяет parent в итоге дойти до ticket_join и blocked_anchor/rebuild_anchor;
- parent rebuild_anchor обновляет Ticket task metadata до единого to_version и оставляет affected human Tickets matching parent_rebuild_receipt; при code-only mixed impact replacements для done/cancel/new/missing доводятся только до `replacement_ready`. `resume_repaired_tickets` сначала выполняет human intent→edge→resume, затем enroll'ит replacements и добавляет blockers; ticket_join prologue закрывает op. Live work Ticket останавливает новую операцию. При planning impact future dispatch_ticket_dag создаёт отдельный ticket_repair_op и применяет тот же порядок;
- commit_on_pass и ticket_join требуют равенства Ticket anchor_version parent Epic anchor_version.

Удаление blocker без suspension receipt или потеря обратного восстановления — blocking error.

### Structured verdict

Gate model возвращает JSON result только через `submit_gate_result`. Модель не пишет task comment/evidence и не вызывает transit. После model run host driver сначала проверяет envelope, затем записывает immutable verdict/disposition/judgment record, перечитывает exact bytes/hash и лишь после этого transits в deterministic validate-step. Для verdict validate_verdict проверяет:

- schema version;
- artifact/candidate identity;
- task/session/role;
- severity и уникальные finding IDs;
- evidence pointer;
- итог PASS, NOT_PASS или BLOCKED_ANCHOR;
- отсутствие неизвестных полей, меняющих смысл.

Комментарии autosk редактируемы, поэтому gate дополнительно хранит SHA-256 принятого verdict record и связывает его с session ID.

### Record artifact PASS и Arena markers

record_artifact_pass — deterministic AgentDefinition step, а не onTransit hook. Он:

1. повторно проверяет artifact identity, anchor, roster и verdict bindings; провал ничего не записывает и паркует artifact_pass_invalid;
2. для kind=tech_plan до любых записей извлекает не свободный текст, а единственный fenced JSON block autosk-arena с ordered decisions array и уникальными decision_id;
3. отсутствие блока допустимо только когда arena.decisions пуст; иначе это удаление terminal history и arena_contract_invalid;
4. новый decision_id допускается только со status=pending и rubric 3–6 критериев;
5. каждый уже известный pending decision может остаться pending либо стать applied/fallback только через apply_arena_decision;
6. каждый terminal decision_id обязан присутствовать ровно с тем же status и Decision Record binding; отсутствие, pending, applied↔fallback или другой record паркуют arena_contract_invalid;
7. после полной валидации одной атомарной операцией записывает artifact_pass[current_artifact.kind] = identity + verdict hash и merge-only обновляет в arena.decisions только нормативные поля `status`, `rubric_hash` и `decision_record`; `sessions` и уже записанные terminal bindings никогда не берутся из блока, не заменяются и не удаляются;
8. только после успешной атомарной записи переходит в select_next.

Разрешённые status каждого entry: pending, applied, fallback. apply_arena_decision обязан переписать выбранный entry и добавить Decision Record reference. Terminal status для decision_id неизменяем; новая спорная развилка получает новый decision_id и отдельную полную панель.

record_code_verdict выполняет аналогичную повторную валидацию code identity и session binding. Только после неё он записывает verdict hash; если review был full, в той же атомарной записи сбрасывает full_review_required=false, затем выбирает PASS/NOT_PASS переход. При провале не меняет flags и паркует code_verdict_invalid.

### Freeze

Детерминированный шаг использует временный Git index:

- проверяет base OID и pathspec;
- включает tracked, staged, unstaged и вложенные untracked files;
- отдельно выявляет ignored new files;
- отказывает на out-of-scope dirt;
- вычисляет tree OID;
- создаёт snapshot commit через git commit-tree без движения refs.

Для planning artifact current_cycle означает review_cycles[current_artifact.kind]; для Quick/Ticket — собственный review_cycle задачи. При первом выборе нового ArtifactKind select_next создаёт отдельный cycle с round=1, last_round=0, narrow=false, full_panel_required=true и пустыми findings. Это не reset другого cycle.

Review round увеличивает только freeze_artifact/freeze при создании новой candidate identity после fix. Операция ключуется attempt + tree OID: повтор после crash не увеличивает round второй раз. Внутри одного cycle дальнейшее значение обязано быть last_round+1. Понижение round или перезапись cycle с меньшим значением отклоняются; anchor rebuild не сбрасывает текущий cycle, новый cap задаёт только пользователь.

### Read-only review

Перед запуском создаётся отдельная autosk-code-review child task. pinnedWorktreeSandbox строит path/branch от snapshot commit с ключом `project_root_sha256 + reviewer task ID + role + attempt`. Из-за ограничений Git worktree он живёт во внешнем, но project-namespaced cache `~/.autosk/worktrees/<project_root_sha256>/...`; metadata owner остаётся current canonical root. Каждый autosk CLI subprocess получает `AUTOSK_CWD=ctx.projectRoot`, поэтому cwd worktree никогда не выбирает другой store.

Panel, contest, narrow Lead, code-review и Judge запускаются с explicit custom tool allowlist: snapshot-rooted read/grep/list + единственный `submit_gate_result`. Прямой transit, builtin bash/powershell/edit/write и `@autosk/pi-tools` task/comment mutations не загружаются; arbitrary autosk CLI недоступен. Submit payload сам ничего не пишет: после завершения model run host driver валидирует его, записывает/read-back immutable record и только затем transits в validate-step.

Штатный worktreeSandbox без предварительной привязки к OID для review запрещён. До и после записываются HEAD, HEAD tree, status/untracked set, а также hashes parent/sibling task metadata/comments. Любая неожиданная Git/store запись превращает ответ в blocking non-verdict; только engine-owned transit текущей reviewer task разрешён.

### Commit on PASS

После PASS:

1. повторно mint текущего implementation worktree;
2. требовать совпадение с approved tree OID;
3. прочитать private ticket branch до создания нового commit;
4. если branch уже указывает на commit с approved tree OID, восстановить этот commit OID в metadata и завершить идемпотентно;
5. если branch всё ещё на recorded base, создать финальный commit object и CAS обновить только private ticket branch;
6. если branch находится на другом tree/OID, перейти в human как foreign movement;
7. привести ticket worktree к чистому состоянию;
8. записать commit OID и повторно сверить branch/tree.

Модель refs не двигает.

### Integration

Детерминированный autosk-owned adapter:

1. берёт чистую целевую ветку и её recorded base OID;
2. строит merge commit без движения целевой ref;
3. вычисляет merge tree и сверяет approved tree;
4. вызывает bundled `autosk-flow integrate-approved`, перенесённый вместе с CAS/reflog tests и не зависящий от Traycer binary;
5. классифицирует exit: success, precondition, obstruction, foreign movement, indeterminate или reattach;
6. только success разрешает следующий Ticket.

State path создаётся отдельно для каждой operation под `<canonical-project-root>/.autosk/autosk-flow/integration-state/` и связывается с project_root_sha256. Никакой integration state не хранится в глобальной пользовательской папке или соседнем проекте.

## 6. onTransit guards

- current task project binding обязан совпадать с canonical ctx.projectRoot и project_root_sha256;
- parent, child, blocker, session, artifact, verdict, evidence и correlation refs другого проекта отклоняются; тот же assert уже обязан был пройти до side effects;
- protocol lock/snapshot обязан принадлежать текущему project/Epic и совпадать с manifest/content digest/detached attestation, записанными в самом immutable lock;
- current installed bundle сравнивается только при создании нового lock. Его более новая версия не инвалидирует и не перепривязывает открытый Epic;
- Planned implementation запрещён до PASS всех реально созданных плановых артефактов.
- Tickets не исполняются без отдельного tickets-panel PASS текущей версии набора.
- Panel seat не закрывается без валидного verdict той же identity.
- Каждый fan-out dispatch ставит exact parent blockers до перехода в join; любой join, увидевший nonterminal child без edge, восстанавливает его и переходит в парный wait-step вместо invalid classification.
- Panel join требует четыре ожидаемых child tasks в status=done и четыре валидных verdict bindings. Child human оставляет parent blocked; cancel/missing/invalid после разблокировки переводят parent в human.
- Сокращённый panel join допустим только с exact waiver той же identity, полным actual_roster и gate Lead вне author/fixer set.
- Любой pending_anchor, BLOCKED_ANCHOR или несовпадение anchor_version переводит parent в human с blocked_anchor; четыре PASS ничего не разрешают.
- Ровно одна active repair op допустима. anchor_rebuild_op с source=planning/code_only/arena/no_bindings имеет приоритет в rebuild_anchor, но только code_only разрешает resume target; ticket_repair_op с source=fresh/current/planning имеет приоритет в dispatch_ticket_dag. ready_to_transit допускает только recorded target. `resume_repaired_tickets` продолжает фазы выбранной op, а `ticket_join` prologue закрывает её. Unknown source, две open ops либо mismatched kind паркуют ticket_repair_op_invalid без side effects.
- Narrow review join требует ровно одного Lead child в status=done и verdict текущей identity; findings возвращают fix_artifact, PASS ведёт select_next, invalid terminal ведёт human.
- Contest join требует отдельную disposition каждого originating seat; снижение или отклонение finding без полного набора dispositions недействительно.
- Ticket join требует каждую ожидаемую Ticket task в status=done, действующий code PASS и commit OID. Terminal status сам по себе недостаточен.
- Arena не стартует без rubric 3–6 критериев и минимум двух разных candidate families.
- Judge не принадлежит candidate family и не получает family labels.
- Arena join требует judge status=done и judgment binding текущей arena identity. Child human оставляет parent blocked; cancel/missing/invalid ведут human.
- apply_arena_decision и planning rebuild_anchor выставляют current_cycle.full_panel_required=true. Пока флаг true, freeze может идти только в dispatch_panel; валидный full panel_join атомарно сбрасывает его в current_cycle, после чего fix этого же attempt может использовать Lead-only narrow re-review.
- Initial Quick cycle имеет full_review_required=true/full_review_reason=initial: единственное исключение из full review — exact initial editorial exemption без pending_anchor. rebuild_code_anchor меняет reason на anchor_rebuild; при этом freeze может идти только в dispatch_review. Только валидный full record_code_verdict либо initial editorial exemption атомарно сбрасывает flag/reason.
- Ticket с parent_epic_task не может самостоятельно увеличить anchor_version; commit/review/join требуют равенства parent anchor, а suspended blocker обязан иметь restore receipt.
- После anchor rebuild pending_anchor не содержит уже consumed correction events. Events после recorded watermark остаются в comments и на следующем gate создают новый blocked_anchor. Ticket signal всегда публикуется event + waiting receipt и не пишет Epic metadata. Normal human recovery получает parent_rebuild_receipt, replacement — superseded_by. Потерянный consumed event/hash, Ticket pre-resume mismatch или отсутствующий binding/receipt означает anchor_impact_invalid.
- Code review запрещён без verification record и candidate tree OID.
- Code reviewer family и panel Lead обязаны отсутствовать в полном author/fixer set.
- Reviewer/Judge/gate provider_session_id обязан отличаться от session IDs всех author/fixer tasks того же scope; совпадение запрещает dispatch и аннулирует verdict.
- Arena role session не переиспользуется между разными decision_id или model families; terminal decision сохраняет свою session map неизменной.
- Commit запрещён без действующего PASS текущего tree OID.
- select_next запрещён, пока record_artifact_pass не записал binding текущей identity; текстовый PASS сам по себе не считается.
- Integration запрещена без commit OID, approved tree, dependency completion и human/project permission.
- Terminal done запрещён до cleanup всех созданных sandboxes.
- Review cap читает монотонный current cycle round, а не resettable step_visits. Переход на новый review round после cap заменяется human.
- freeze отклоняет round меньше last_round и идемпотентно не увеличивает его повторно для того же attempt+tree OID.
- Bare resume после эскалации отклоняется без park.reason, явной target и требуемого recovery metadata.

## 7. Ошибки и восстановление

| Ситуация | Поведение |
| --- | --- |
| Provider/model отсутствует | повтор по контракту; затем human, без автоматической подмены или сокращения панели |
| Gate model не вызвал submit либо вернул invalid payload | child human с gate_result_missing/gate_result_invalid; accepted verdict не создаётся |
| Gate snapshot/store изменился | child human с gate_snapshot_mutated и blocking non-verdict |
| Arena candidate build/verify/freeze не завершён | child human с точной arena_candidate_* причиной; candidate не считается live |
| Project boundary/path guard не прошёл | human с project_boundary_invalid; side effects count=0 |
| Child create завершился частично | повторный dispatch находит задачи по parent/run/seat |
| Duplicate/malformed create-time marker | human с child_dispatch_marker_invalid; ни один child не enroll |
| Child task parked human | parent остаётся blocked; оператор возобновляет child в его существующем workflow либо cancel делает join ответственным за parent park; только anchor-repair parent step может автоматически resume Ticket по валидным receipts |
| Один seat cancel/unavailable | parent переходит в human; сокращённый roster требует явного waiver |
| Ticket cancel/done без binding | parent переходит в human; такой Ticket не считается завершённым |
| Crash после Ticket human park и до exact unblock parent | Ticket остаётся human с anchor_handoff_incomplete; parent безопасно остаётся blocked |
| ticket_join обнаружил malformed/mismatched handoff | exact edge восстанавливается; valid event + bad receipt использует receipt_only без нового event, invalid raw event использует human-approved supersede_event |
| Affected Ticket ещё status=work во время rebuild_anchor | parent паркуется с anchor_repair_ticket_live до любых rebuild writes; pending_anchor сохраняется |
| Artifact изменён после verdict | verdict void, новый attempt |
| Arena decision не re-expressed в новых Tech Plan bytes | human с arena_reexpression_missing |
| Correction event schema/hash/project invalid | human с correction_event_invalid; raw record не проходит watermark без exact later human-approved superseder/disposition |
| Protocol lock/snapshot повреждён | human с protocol_lock_invalid; model/fs side effects не выполняются |
| Implementer provider/output/scope невалиден | human с implement_provider_unavailable, implementation_result_invalid или implementation_scope_invalid; Epic blocker остаётся активным |
| Verification runner/evidence невалиден | human с verification_environment_failed или verification_record_invalid; candidate/PASS не меняются |
| Verification defect исчерпал cap либо freeze identity невалидна | human с verification_cap или freeze_candidate_invalid |
| Crash после edge до child resume | parent safely blocked; child human с durable anchor_resume_pending и exact resume_intent/target, который пользователь возобновляет без изменения графа |
| Anchor version изменена | void active-cycle verdicts и bindings из human-approved anchor_impact; unchanged planning PASS живут только через явный hash-checked re-binding; affected scope получает новый full gate |
| Extension обновлена во время epic | продолжается pinned protocol snapshot; исчезнувший workflow паркуется human |
| Reviewer изменил snapshot | blocking non-verdict, новый isolated review |
| Loop cap достигнут | human, без автоматического PASS |
| Integration obstruction | ничего не удалять; переместить помеху восстанавливаемо только по решению человека |
| Foreign movement/indeterminate | остановка и расследование; повтор запрещён |
| Daemon restart | tasks, blockers, metadata и sessions восстанавливают позицию; idempotent steps завершают незаконченные действия |

Resume contract:

| park.reason | Существующий workflow step | Требование |
| --- | --- | --- |
| panel_join_invalid | dispatch_panel | invalid child IDs записаны, attempt+1; старые bindings void |
| gate_provider_unavailable | исходный gate model step | exact route снова проходит synthetic smoke; прежняя session продолжается либо explicit replacement записан |
| gate_result_missing / gate_result_invalid | исходный gate model step | invalid/nonexistent result не принят; attempt+1 и та же logical reviewer session с явным reminder схемы |
| gate_snapshot_mutated | исходный gate model step | новый immutable pinned snapshot того же candidate identity создан, pre-hashes совпадают, прежний response остаётся non-verdict |
| arena_candidate_failed / arena_candidate_verify_failed / arena_candidate_freeze_invalid | соответствующий build/verify/freeze step | тот же candidate attempt восстановим и identity неизменна; иначе новая Arena attempt через parent |
| project_boundary_invalid | исходный deterministic step | project binding/path исправлены и повторный pre-side-effect assert PASS |
| child_dispatch_marker_invalid | исходный dispatch step | duplicate закрыт/исследован, остаётся один valid create-time marker |
| panel_waiver_required | dispatch_panel или panel_join | retry отсутствующего route либо waiver текущей identity и actual roster |
| contest_join_invalid | dispatch_contest | invalid disposition tasks записаны, attempt+1 |
| narrow_join_invalid | dispatch_narrow_review | прежний Lead child закрыт, новый attempt |
| review_join_invalid | dispatch_review или dispatch_narrow_review | invalid review child закрыт, новый attempt и сохранён narrow/full mode |
| code_verdict_invalid | freeze | старый review binding void, новый candidate/review attempt |
| protocol_lock_invalid | repair_protocol_snapshot | common deterministic step зарегистрирован в Planned, Quick, Ticket, panel/contest/code-review и Arena workflows; exact locked content digest/manifest/attestation доступен для atomic re-mint; иначе reinstall exact bundle либо явная migration с full gates |
| arena_reexpression_missing | draft_artifact | Decision Record/graft list отражены в новых Tech Plan bytes и identity отличается от pre-arena |
| correction_event_invalid | human decision, затем исходный gate | append schema-valid superseding event с exact raw id/hash + approval; parent atomically записывает terminal disposition, продвигает watermark и не редактирует старый comment |
| ticket_repair_op_invalid | dispatch_ticket_dag для source=fresh/current/planning либо rebuild_anchor для source=code_only | open op отсутствует/двойная/source или binding не совпадает; человек выбирает единственную exact op и void'ит конфликтующую без side effects |
| ticket_repair_state_invalid | recorded source step `dispatch_ticket_dag` или `resume_repaired_tickets` | human-approved exact repair disposition записана в open op; premature blockers сняты либо invalid Ticket superseded/replaced, phases не понижены |
| blocked_anchor, autosk-planned | rebuild_anchor | полный human-approved anchor_impact; recorded target выбирается только из draft_artifact, dispatch_arena, select_next, resume_repaired_tickets или ticket_join; resume_repaired_tickets — промежуточный target, op закрывает ticket_join prologue |
| anchor_impact_invalid | rebuild_anchor | исправленная полная impact map и повторно проверенные unchanged hashes |
| anchor_repair_ticket_live | rebuild_anchor | anchor_rebuild_op=null; каждый affected live run завершился в human/done/cancel; status/impact map перечитаны; pending_anchor сохранён; rebuild writes отсутствуют |
| anchor_handoff_incomplete | complete_anchor_handoff | event/receipt hash валидны, Ticket human и exact parent edge ещё active |
| waiting_parent_anchor с malformed/mismatched event/receipt | repair_anchor_handoff | mode=receipt_only переиспользует valid event; mode=supersede_event требует human approval и exact raw id/hash; bad immutable record сохраняется |
| blocked_anchor, standalone Quick | rebuild_code_anchor | own anchor bump, старые review bindings void, затем verify/freeze/full code review |
| blocked_anchor, Ticket with parent | rebuild_code_anchor | propagate pending to parent, suspend blocker with receipt, ждать parent rebuild_anchor |
| waiting_parent_anchor | rebuild_code_anchor | parent rebuild завершён, Ticket anchor=parent, local pending=null, receipt restored |
| anchor_resume_pending | rebuild_code_anchor | exact parent edge active, resume_intent совпадает с op/anchor/receipt/target и child всё ещё human |
| anchor_resume_intent_invalid | rebuild_code_anchor | bad intent сохранён как evidence; human записал точный replacement intent либо отменил repair operation |
| blocked_anchor, Ticket pending already absorbed by parent | rebuild_code_anchor | Ticket anchor=parent, local pending=null, matching parent_rebuild_receipt, no suspended receipt |
| implement_provider_unavailable | implement | exact route снова проходит synthetic smoke; прежняя session продолжается либо explicit replacement записан |
| implementation_result_invalid | implement | invalid result сохранён, attempt+1, completion schema повторно выдана той же logical session |
| implementation_scope_invalid | implement | out-of-scope dirt сохранён как evidence и устранён/явно расширен человеком до нового attempt |
| verification_environment_failed | verify | runner/environment восстановлен и candidate identity неизменна |
| verification_record_invalid | verify | evidence record пересоздан для той же candidate identity |
| verification_cap | fix | новый user-approved cap и verification findings сохранены |
| freeze_candidate_invalid | freeze | scope/candidate identity повторно mint'ится; stale review binding void |
| artifact_pass_invalid | freeze_artifact | старые bindings void, attempt+1, сохранённый full/narrow mode |
| review_cap | fix_artifact для Planned; fix для Quick/Ticket | новый user-approved cap, сохранённые findings и identity |
| arena_join_invalid | dispatch_arena | новый arena attempt; старые judgments void |
| arena_fallback_required | apply_arena_decision | пользователь выбрал fallback decision; review_cycles.tech_plan narrow=false/full required |
| arena_contract_invalid | fix_artifact | исправленный autosk-arena block, review_cycles.tech_plan.narrow=false/full_panel_required=true |
| ticket_join_invalid | dispatch_ticket_dag | repair map для missing/cancelled/unbound Tickets |
| ticket_edge_receipt_lost | dispatch_ticket_dag | receipt сопоставлен live Ticket или valid superseded_by, старый sandbox учтён |
| candidate_changed | fix | approved findings/identity сохранены, новый candidate attempt |
| commit_cas_failed | commit_on_pass | ref всё ещё на recorded base, причина lock/storage устранена |
| commit_foreign_movement | commit_on_pass | private branch снова однозначен после расследования; cancel — отдельная status-операция |
| aggregate_verify_failed | dispatch_ticket_dag или aggregate_verify | scoped integration-fix Ticket либо повтор доказанного внешнего сбоя |
| no_external_reviewer | dispatch_review или dispatch_narrow_review | external human reviewer, re-expression либо точный user waiver записан; режим сохраняется |
| no_external_panel_lead | dispatch_panel или dispatch_narrow_review | external human Lead либо точный user waiver записан; roster full/narrow сохраняется |
| cleanup_dirty | cleanup | force=true разрешён явно или состояние сохранено |
| integration_obstruction | integrate | восстановимое перемещение помехи записано |
| integration_precondition | integrate | нарушенное предусловие устранено, base/tree повторно записаны и доказательство приложено |
| foreign_movement / indeterminate | integration_recovery | обычный retry запрещён; cancel — отдельная status-операция, не workflow step |

## 8. Проверки

### Unit

- classification rules и waivers;
- переходы: каждый зарегистрированный step имеет исчерпывающие взаимно исключающие исходы;
- select_next precedence для optional artifacts, Arena и Tickets;
- canonical ArtifactKind enum и artifact_pass binding;
- независимый review_cycles entry для каждого ArtifactKind;
- atomic record_artifact_pass, включая malformed autosk-arena без частичной записи;
- prompt compilation из одного snapshot;
- bundle manifest требует один Guide и exact 12 protocol paths, regular files и совпадающие hashes/digest;
- canonical bundle digest и detached attestation проходят golden vectors без self-hash cycle;
- editorial classifier отклоняет config/schema/security/prompt/governance и behavior-defining paths;
- freeze precedence различает initial editorial exemption и anchor_rebuild forced full review через full_review_reason;
- Quick/Ticket implement, verify и freeze имеют взаимно исключающие success/fix/human exits для provider/output/scope/evidence/environment/identity failures;
- каждый workflow graph регистрирует common repair_protocol_snapshot и возвращает только в recorded pre-failure step;
- create-time child marker однозначно кодирует project/parent/run/seat и обнаруживает duplicate marker;
- correction event schema/id/hash/watermark не допускает повторное consume;
- correction disposition пропускает только exact raw id/hash с later valid human-approved superseder и атомарно двигает watermark;
- repair_anchor_handoff receipt_only/supersede_event predicates взаимно исключаются; receipt_only не append'ит event;
- anchor_rebuild_op/ticket_repair_op взаимно исключаются; closed source enums допускают planning/code_only/arena/no_bindings для первой и fresh/current/planning для второй, но resume target только anchor code_only или ticket op; step имеет success/fail-closed исход для каждого status/phase;
- resume_intent pending/consumed guards идемпотентны при crash до edge, до resume и до transit verify;
- metadata schema требует autosk_flow.session для каждой model-owned task;
- каждый project-local файл и recovery key привязан к canonical project root hash;
- project binding обязателен для parent/child/blocker/session/verdict/evidence refs;
- identity/hash canonicalization;
- verdict schema и stale binding;
- author-family routing;
- code reviewer matrix для single/mixed author+fixer sets;
- onTransit graph и cap=10;
- idempotent child discovery;
- exit classification integration adapter.

### Integration

- два project roots одновременно создают Epics с одинаковыми epic/task/run labels без collision;
- одинаковые reviewer task IDs двух проектов создают разные external worktree paths по project_root_sha256 и всегда используют `AUTOSK_CWD=ctx.projectRoot`;
- документы, project policy metadata, protocol locks, sessions, evidence и integration state двух проектов остаются в своих roots;
- общий worker pool может чередовать проекты, но не меняет project binding и не создаёт cross-project blockers;
- update installed bundle v1→v2 не влияет на активные Epics с v1 locks; новый Epic получает v2;
- bundle GC не удаляет digest, пока хотя бы один registered project lock его использует; corrupted snapshot re-mint'ится из exact cached digest;
- crash до/после child metadata set находит child по create-time marker и не enroll'ит duplicate/orphan;
- Ticket append events H1/H2 одновременно с parent rebuild не теряются: parent sole writer consume'ит только recorded watermark;
- Ticket никогда не вызывает Epic metadata writer: correction публикуется только append-only event, а любые Ticket-side metadata set parent Epic отклоняются;
- rebuild_anchor завершает semantic anchor/binding writes до `resume_repaired_tickets`; после первого Ticket resume parent пишет только монотонные edge_restored/child_resumed/ready_to_join phases, а ticket_join prologue закрывает op;
- Ticket park→unblock crash оставляет parent blocked и восстанавливается через complete_anchor_handoff; crash после unblock до final receipt заставляет ticket_join вернуть edge и дождаться того же child recovery;
- malformed/mismatched handoff не направляется в незарегистрированный recovery: ticket_join возвращает edge; receipt_only не дублирует valid event, supersede_event создаёт новый immutable event и parent disposition;
- ticket_join при missing blocker создаёт edge, transits ticket_join_wait и не завершает onRun без ctx.transit;
- ticket_join не восстанавливает intentionally suspended edge только при exact final event/receipt binding; затем consume'ит correction и паркуется blocked_anchor;
- gate role получает только snapshot-rooted read tools и `submit_gate_result`; host driver принимает ровно один payload, записывает/read-back record до validate transit, а missing/invalid/mutating run паркуется с точной причиной;
- запуск с временным HOME без `.traycer`, devflow и Obsidian проходит Quick и Planned smoke;
- initial editorial Quick проходит record_editorial_exemption, но тот же path после rebuild_code_anchor с reason=anchor_rebuild обязательно идёт в full review;
- corrupted protocol snapshot в Planned, Quick, Ticket, panel/contest/code-review и Arena tasks имеет существующий repair_protocol_snapshot target и возвращается в точный pre-failure step;
- implementer provider/missing output/scope mutation, verify environment/evidence failure и freeze identity mismatch получают документированный park/recovery и не снимают Epic blocker;
- active bundle и prompt compiler не выполняют filesystem/process lookup Traycer;
- четыре child tasks создаются до parent join;
- panel и Arena dispatch не переходят в join до установки exact blockers; missing blocker при running/human child ведёт в panel_join_wait/arena_join_wait, а не в invalid park;
- при workers>=4 свободный pool запускает независимые seats параллельно; при меньшем pool результат не меняется;
- parent не запускается, пока blocker открыт;
- pending_anchor блокирует panel/contest/narrow/review/Arena/Ticket joins и integrate до rebuild;
- partial anchor_impact re-bind'ит ровно unchanged planning passes и void'ит ровно affected bindings;
- Ticket-scoped BLOCKED_ANCHOR propagates to parent with a suspension receipt;
- code-only anchor repair для каждого human Ticket записывает/read-back resume_intent, восстанавливает suspended edge и затем resume'ит child; planning repair применяет тот же intent→edge→resume порядок;
- affected Ticket whose pending was absorbed before suspension resumes through the matching parent_rebuild_receipt path and cannot stall between guards;
- planning repair resolves every suspended receipt by resume or superseded cleanup; unmatched receipt parks ticket_edge_receipt_lost;
- planning repair reuses an old Ticket only when it is human in the expected recovery state and artifact path, canonical ticket hash and execution base match; it reissues scope/dependency plan, а edges materializes after human child_resumed, otherwise replaces any non-live task;
- mixed code-only repair создаёт/configure replacements только до replacement_ready, затем `resume_repaired_tickets` восстанавливает/resume'ит human Tickets и лишь после child_resumed enroll'ит replacements, добавляет blockers и transits ticket_join;
- code-only repair never resumes done/cancel/new/missing affected Tickets; it creates replacement repair tasks with fresh dependency blockers instead, while status=work parks without automatic cancellation;
- code-only replacement repair сначала закрывает old new task/sandbox и доводит replacement до configured replacement_ready без enroll/blockers; после human child_resumed выполняет enroll, dependency blockers и parent blocker, поэтому parent достижим в resume step;
- crash-matrix до human resume продолжает active repair op на unblocked parent либо оставляет exact anchor_resume_pending child; только после всех human child_resumed допускаются replacement blockers, и old/new implementations не runnable одновременно;
- crash после anchor_committed, после intent до edge, после edge до resume, после normal resume до child_resumed phase и после transit до target prologue сохраняет тот же op/to_version; intent-before-edge retry автоматический, edge-before-resume требует точного user resume child, дальнейшие фазы продолжаются идемпотентно;
- crash после resume_intent consumed/waiting flag cleared и до transit verify повторно входит в идемпотентный consumed guard и не застревает на rebuild_code_anchor;
- planning dispatch создаёт отдельный ticket_repair_op до replacement preparation; переход dispatch_ticket_dag→resume_repaired_tickets зарегистрирован, op закрывает только ticket_join;
- fresh Ticket DAG использует ту же ticket_repair_op с empty human set; все Tickets проходят replacement_ready→enrolled/blockers→ticket_join без repair-only precondition;
- human recovery Ticket с прямой/транзитивной зависимостью от replacement каскадно классифицируется replacement до создания op; workers=1 и workers>=4 дают одинаковый DAG;
- resume_repaired_tickets при cancel/new/missing recorded human до доказанного resume паркует ticket_repair_state_invalid и не продвигает phases;
- parent atomically записывает park.reason=anchor_resume_pending вместе с pending resume_intent до edge; 01/03 resume contracts используют одно имя;
- malformed raw correction с later valid human-approved superseder получает parent-owned terminal disposition, watermark проходит exact raw id/hash, и следующий gate не повторяет correction_event_invalid;
- valid correction event с bad receipt получает replacement receipt без duplicate correction event/pending impact;
- rebuild_anchor никогда не записывает dispatch_ticket_dag как direct target: planning repair идёт через draft/select_next, code-only repair завершается ticket_join;
- новый pending_anchor, появившийся после создания op, не очищается старой перестройкой и блокирует дальнейшие gates после target prologue до следующего rebuild;
- consumed correction IDs не применяются дважды; event после watermark переживает parent metadata write и запускает следующий blocked_anchor;
- новый Ticket anchor signal append'ит parent correction event, park'ится human и только затем suspend'ит edge; прямой Epic metadata write запрещён;
- superseded done/cancel/new/missing Tickets не удаляют correction events и не конкурируют с единственным Epic metadata writer;
- ticket_join with any expected Ticket in new/work leaves parent blocked and cannot integrate or park as invalid;
- child human продолжает блокировать parent; cancel разблокирует, но join паркует parent;
- restart на каждой границе dispatch не создаёт дублей;
- full re-panel, narrow re-review и contest возобновляют правильные provider session IDs;
- первый child сохраняет exact provider_session_file; follow-up из другого worktree открывает его через `--session <file>` и не создаёт второй same-id jsonl;
- reviewer/Judge session IDs никогда не совпадают с author/implementer sessions; narrow/contest при этом переиспользуют правильный review seat;
- session replacement увеличивает generation и сохраняет replaces;
- cancel/human/done без binding не проходит join и переводит parent в human;
- waived roster проходит только с exact identity и внешним gate Lead;
- administrative done/cancel не обходят panel/ticket gate;
- изменённый artifact/tree аннулирует PASS;
- reviewer write обнаруживается;
- reviewer task использует отдельный task ID и pinned OID workspace;
- preflight на реальном autosk CLI доказывает точечные unblock/block и parent-initiated resume --to; extension не стартует, если хотя бы одна операция отсутствует;
- crash до edge повторяет intent/edge idempotently; crash после edge до resume оставляет child human с anchor_resume_pending и восстанавливается точным user resume; normal resume очищает intent и после всех children parent transits ticket_join;
- workers=1 и crash после intent, после edge и после resume дают тот же state outcome; ни один recovery step не удерживает worker в ожидании parent;
- Arena judge cancel/missing/invalid не проходит arena_join;
- applied/fallback arena status того же decision_id не понижается обратно в pending;
- две Arena decisions имеют непересекающиеся role session IDs; retry одной decision переиспользует только её map;
- record_artifact_pass сохраняет arena.decisions[*].sessions и terminal bindings byte-for-byte при merge нормативных полей;
- commit CAS failure без ref movement имеет отдельный recoverable park;
- accept без auto-policy действительно паркует human; resume требует acceptance той же identity;
- dependency DAG запускает только готовые Tickets;
- sandboxCleanupStep вызывается с force=false; dirty worktree не удаляется без явного разрешения.

### Adversarial

- forged child/blocker/verdict с project_root_sha256 соседнего проекта;
- forged project binding в `submit_gate_result` даёт ноль result-record writes по fake adapter counters и паркует gate child;
- path traversal или symlink из project runtime в другой project root;
- forged boundary metadata даёт ноль вызовов fs/Git/CLI/RPC side effects по fake adapter counters;
- `$HOME/.autosk` существует, reviewer cwd — external worktree, но autosk CLI с AUTOSK_CWD пишет только current project store;
- одинаковые task/session IDs в двух project stores;
- отсутствие `~/.traycer`, переименование source baseline после установки и запрет `traycer_*` subprocess;
- установленный devflow отсутствует либо несовместим — autosk-flow behavior не меняется;
- Obsidian MCP/skill отсутствует — ни один gate или prompt не меняется;
- forged PASS comment без session binding;
- изменение nested untracked и ignored file;
- смена anchor version во время review;
- duplicate/late panel verdict;
- downgrade/reject без contest originating seats;
- mixed authorship без внешней reviewer family;
- reset step_visits не сбрасывает autosk_flow review cap;
- bare resume без recovery metadata;
- каждая resume target существует среди зарегистрированных steps;
- forged repair map, где reusable human зависит от replacement, fail-closed паркует ticket_repair_state_invalid до enroll/resume;
- downgrade/reject проходит отдельный contest-seat workflow и полный disposition join;
- protocol/evidence path разрешается от ctx.projectRoot, а не sandbox cwd;
- crash после commit-on-pass CAS восстанавливает commit metadata по approved tree;
- прямое понижение planning current_cycle.round или Ticket review_cycle.round отклоняется;
- branch movement до и после CAS;
- crash после merge и до reattach;
- protocol snapshot corruption;
- workflow reload с исчезнувшим step.

### Live provider smoke

Перед использованием — синтетическая задача без приватного проекта для каждого exact Pi route. Каталог моделей сам по себе недостаточен.

Multi-project preflight дополнительно печатает canonical root/hash текущего проекта, все project-owned output roots, общий worker budget и число активных проектов. Несовпадение root либо output path вне root останавливает dispatch; нехватка workers только предупреждает о последовательном исполнении.

## 9. Последовательность реализации

### Slice 1 — безопасный фундамент

- отдельный extension package;
- autosk-native Guide + exact 12-file governance bundle + manifest/digest;
- local-only explicit Traycer import/diff tool, недоступный runtime;
- config + exact model preflight;
- project-scoped protocol lock/snapshot и prompt compiler;
- metadata/verdict schemas;
- multi-project isolation tests и no-Traycer/no-devflow/no-Obsidian smoke;
- idempotent project bootstrap: versioned docs создаются on demand, `.autosk/` и `.autosk-evidence/` добавляются в project `.gitignore` без перезаписи существующих правил;
- deterministic helpers и тесты.

### Slice 2 — Quick

- worktree implementation;
- verify/freeze;
- отдельная review child task на OID-pinned snapshot;
- fix/narrow review;
- human accept и cleanup.

Это первый end-to-end proof.

### Slice 3 — Planning и Panel

- adaptive Brief/Core Flow/Tech Plan;
- four child seats + blockers + join;
- synthesis/contest/fix/narrow review;
- отдельная tickets panel.

### Slice 4 — Ticket DAG и Integration

- создание Ticket-задач с blockers;
- commit-on-pass;
- autosk-owned integration adapter с перенесёнными CAS/reflog tests;
- aggregate verification и recovery tests.

### Slice 5 — Arena/Judge

- candidate worktrees;
- blind judge outside candidate set;
- evidence-gap verification;
- graft by re-expression;
- новая полная panel для изменённого Tech Plan.

Arena входит в целевую архитектуру, но реализуется после доказанного обычного пути, чтобы её сбои не маскировали ошибки базового оркестратора.

## 10. Критерии готовности к кодированию

- пакет прошёл четырёхмодельную панель;
- все Critical/High закрыты, Medium исправлены или явно отложены;
- пользователь принял положения из 04-decisions.md;
- все четыре Pi route прошли live smoke;
- создан отдельный тестовый Git-репозиторий, не рабочий проект пользователя;
- autosk v2 установлен только после фиксации версии и rollback-плана.
