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
  select_next -> dispatch_ticket_dag -> ticket_join
  -> accept -> integrate -> aggregate_verify -> cleanup -> done

recovery:
  rebuild_anchor -> draft_artifact | dispatch_arena | select_next | resume_repaired_tickets | ticket_join | human
  resume_repaired_tickets -> ticket_join
  repair_protocol_snapshot -> recorded pre-failure step | human
  integration_recovery -> integrate | human
~~~

Brief, Core Flow, Tech Plan и весь комплект Tickets — четыре значения current_artifact.kind и проходят один artifact cycle. Отдельных draft_tickets/tickets_panel steps нет.

Каноническая таблица переходов:

Перед вычислением любого gate parent-owned deterministic step вызывает `consumeAnchorCorrections`: читает новые immutable `anchor_correction` events из Epic comments, проверяет event id/hash/project/anchor provenance и как единственный writer merge'ит их в Epic pending_anchor. Model/Ticket/user paths не выполняют `metadata set` родительского Epic. Если event появился после текущего consume, он остаётся непрочитанным и блокирует следующий gate.

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
| dispatch_panel | четыре child tasks или exact-waived actual_roster полностью настроены/enrolled | panel_join |
| panel_join | pending_anchor, любой verdict=BLOCKED_ANCHOR или anchor version отличается | atomically ensure pending_anchor(reason, identity), human с park.reason=blocked_anchor |
| panel_join | child status=human | parent остаётся blocked; пользователь возобновляет child |
| panel_join | exact user waiver текущей identity, actual_roster содержит gate Lead вне author/fixer set, все listed seats status=done и bindings валидны | atomically current_cycle.full_panel_required=false, synthesize_panel |
| panel_join | roster меньше четырёх без waiver | human с park.reason=panel_waiver_required |
| panel_join | все четыре status=done, verdicts валидны, нет BLOCKED_ANCHOR/mismatch | atomically current_cycle.full_panel_required=false, synthesize_panel |
| panel_join | любой cancel/missing/invalid | human с park.reason=panel_join_invalid |
| synthesize_panel | требуется contest | dispatch_contest |
| synthesize_panel | подтверждены findings | fix_artifact |
| synthesize_panel | PASS | record_artifact_pass |
| dispatch_contest | все contest children настроены/enrolled и parent blocked | contest_join |
| contest_join | pending_anchor или disposition=BLOCKED_ANCHOR/mismatch | atomically ensure pending_anchor(reason, identity), human с park.reason=blocked_anchor |
| contest_join | child status=human | parent остаётся blocked; пользователь возобновляет child |
| contest_join | все originating seats status=done и dispositions валидны | synthesize_panel |
| contest_join | cancel/missing/invalid | human с park.reason=contest_join_invalid |
| fix_artifact | исправлены только confirmed findings без scope change | freeze_artifact с current_cycle.narrow=true |
| fix_artifact | изменился scope/anchor/load-bearing decision | freeze_artifact с current_cycle.narrow=false |
| dispatch_narrow_review | нет Lead семьи вне union author/fixer set | human с park.reason=no_external_panel_lead |
| dispatch_narrow_review | один Lead child настроен/enrolled и parent blocked | narrow_review_join |
| narrow_review_join | verdict=BLOCKED_ANCHOR, pending_anchor или anchor mismatch | atomically ensure pending_anchor(reason, identity), human с park.reason=blocked_anchor |
| narrow_review_join | child status=human | parent остаётся blocked; пользователь возобновляет child |
| narrow_review_join | Lead status=done, NOT_PASS/findings и round >= cap | human с park.reason=review_cap |
| narrow_review_join | Lead status=done, NOT_PASS/findings и round < cap | fix_artifact |
| narrow_review_join | Lead status=done, verdict PASS текущей identity | record_artifact_pass |
| narrow_review_join | cancel/missing/invalid | human с park.reason=narrow_join_invalid |
| record_artifact_pass | pending_anchor | human с park.reason=blocked_anchor; ничего не записано |
| record_artifact_pass | identity/anchor/roster или verdict binding невалидны | human с park.reason=artifact_pass_invalid; ничего не записано |
| record_artifact_pass | verdict binding текущей identity валиден; для tech_plan Arena block валиден | atomically artifact_pass[kind]=identity+verdict, arena fields обновлены, select_next |
| record_artifact_pass | tech_plan Arena block malformed | human с park.reason=arena_contract_invalid |
| dispatch_arena | candidates и judge task настроены/enrolled | arena_join |
| arena_join | pending_anchor или anchor mismatch | atomically ensure pending_anchor(reason, identity), human с park.reason=blocked_anchor |
| arena_join | менее двух live candidates, fallback requested или candidate roster недостаточен | human с park.reason=arena_fallback_required |
| arena_join | judge status=done, минимум два live candidates и judgment binding валиден | apply_arena_decision |
| arena_join | cancel/missing/invalid judgment | human с park.reason=arena_join_invalid |
| arena_join | child status=human | parent остаётся blocked; пользователь возобновляет child |
| apply_arena_decision | user/judge decision recorded для current_decision_id, включая fallback, и block entry rewritten applied/fallback с Decision Record/graft list ref | arena.decisions[id] terminal, current_decision_id=null, artifact_pass.tech_plan=null, kind=tech_plan, сохранить pre-arena identity, reexpression_required=true, review_cycles.tech_plan.narrow=false/full_panel_required=true, attempt+1, draft_artifact |
| rebuild_anchor | anchor_rebuild_op открыт | validate op binding; продолжить записанные per-ticket phases/dispositions без повторной классификации; phase=ready_to_transit повторяет только recorded target |
| rebuild_anchor | anchor_impact incomplete, current in-flight kind без current PASS не affected, upstream cascade нарушен, hash claimed-unaffected изменён или Ticket task re-binding не подтверждён | human с park.reason=anchor_impact_invalid |
| rebuild_anchor | любой affected Ticket status=work | human с park.reason=anchor_repair_ticket_live; никаких mutation, pending_anchor сохраняется |
| rebuild_anchor | affected Ticket status=human, но это не waiting_parent_anchor с suspension receipt и не blocked_anchor с обоснованным pending до absorption | human с park.reason=anchor_impact_invalid; никаких mutation |
| rebuild_anchor | affected planning kinds не пусты | bump anchor, re-bind unchanged unaffected passes, void affected bindings, current kind=earliest affected, current_cycle full required, draft_artifact |
| rebuild_anchor | planning kinds unchanged/re-bound, affected только Ticket code bindings, все affected Tickets status=human и каждый либо waiting_parent_anchor+suspension receipt, либо blocked_anchor+обоснованный pending до absorption | sole-writer bump/re-bind, clear consumed source pending, write Ticket receipts/anchors до resume, ready_to_transit(resume_repaired_tickets) |
| rebuild_anchor | planning kinds unchanged/re-bound, affected только Ticket code bindings, есть done/cancel/new/missing Ticket, нет status=work, а каждый оставшийся human Ticket имеет один из двух допустимых pre-rebuild recovery states | sole-writer bump/re-bind, clear consumed source pending, завершить replacements, ready_to_transit(resume_repaired_tickets) |
| rebuild_anchor | affected bindings пусты, active Arena decision pending/running | bump/re-bind, void old Arena run binding, arena attempt+1, dispatch_arena |
| rebuild_anchor | affected bindings пусты, planning phase без active Arena | bump/re-bind, select_next |
| rebuild_anchor | affected bindings пусты, execution/ticket_join phase | bump/re-bind Ticket task metadata, ticket_join |
| resume_repaired_tickets | Epic metadata/op writes sealed; Ticket anchors/receipts готовы | restore/add exact blocker edges, resume recorded human Tickets, больше не писать Epic metadata, transit ticket_join |
| dispatch_ticket_dag | old Ticket status=work | human с park.reason=ticket_join_invalid; live task не изменяется и не отменяется автоматически |
| dispatch_ticket_dag | suspended receipt не сопоставлен живому Ticket и не имеет valid superseded_by mapping | human с park.reason=ticket_edge_receipt_lost |
| dispatch_ticket_dag | old Ticket status=done/cancel/new/missing либо path/hash/base не совпадает с current tickets PASS, либо Ticket удалён | old task superseded: parent map исключает old task; cancel только допустимую non-live task; cleanup+close receipt; создать новую Ticket task из current PASS |
| dispatch_ticket_dag | matched receipt, но scope/dependency blockers/candidate reset не подтверждены из current tickets PASS | human с park.reason=ticket_join_invalid |
| dispatch_ticket_dag | все receipts matched/superseded и repair tasks настроены | завершить create/configure всех replacements; для matched human Ticket проверить recovery metadata+path/hash/base, переиздать scope/dependencies/attempt и очистить stale state; затем resume_repaired_tickets |
| ticket_join | unconsumed correction event, pending_anchor или anchor mismatch любого ожидаемого Ticket | consume/ensure pending_anchor(reason, identity, affected tickets), human с park.reason=blocked_anchor |
| ticket_join | любой ожидаемый Ticket status=new/work/human и соответствующий blocker отсутствует | восстановить exact blocker edge, transit ticket_join_wait |
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
~~~

Зависимости между Ticket-задачами выражаются autosk blockers.

### autosk-code-review

Отдельная child task с отдельным task ID и pinned snapshot workspace:

~~~text
review_candidate -> validate_verdict -> done
~~~

Parent Ticket блокируется review child и после разблокировки принимает только status=done плюс verdict binding текущего tree OID. Review child status=human продолжает блокировать parent и возобновляется отдельно; cancel или stale verdict снимают blocker, после чего review_join переводит parent в human.

Общая таблица Quick/Ticket review cycle:

| Текущий шаг | Условие | Следующий шаг |
| --- | --- | --- |
| implement | критерии проверены, worktree не коммитился | verify |
| verify | evidence record валиден | freeze |
| freeze | workflow=autosk-quick, editorial classification валидна, changed paths/bytes не затрагивают executable/config/schema/security/prompt/governance behavior | record_editorial_exemption |
| freeze | review_cycle.full_review_required=true | dispatch_review |
| freeze | review_cycle.full_review_required=false и candidate создан после confirmed fixes | dispatch_narrow_review |
| dispatch_review / dispatch_narrow_review | нет reviewer семьи вне union author/fixer set | human с park.reason=no_external_reviewer |
| dispatch_review / dispatch_narrow_review | child настроен/enrolled, parent blocked | review_join |
| review_join | child human | parent остаётся blocked; пользователь возобновляет child |
| review_join | BLOCKED_ANCHOR, pending_anchor или anchor mismatch | atomically ensure pending_anchor(reason, identity), human с park.reason=blocked_anchor |
| review_join | cancel/missing/stale/invalid | human с park.reason=review_join_invalid |
| review_join | PASS/NOT_PASS verdict binding текущей identity валиден | record_code_verdict |
| record_code_verdict | pending_anchor | human с park.reason=blocked_anchor; ничего не записано |
| record_code_verdict | повторная identity/binding validation не прошла | human с park.reason=code_verdict_invalid; ничего не записано |
| record_code_verdict | NOT_PASS/findings и round >= cap | если full, atomically full_review_required=false; human с review_cap |
| record_code_verdict | NOT_PASS/findings и round < cap | если full, atomically full_review_required=false; fix |
| record_code_verdict | PASS и workflow=autosk-ticket | если full, atomically full_review_required=false; commit_on_pass |
| record_code_verdict | PASS и workflow=autosk-quick, auto-integration policy валидна | если full, atomically full_review_required=false; integrate |
| record_code_verdict | PASS и workflow=autosk-quick, auto-policy отсутствует или невалидна | если full, atomically full_review_required=false; accept |
| fix | confirmed findings исправлены | verify |
| record_editorial_exemption | classification + exact candidate identity + changed path set записаны вместо review verdict; повторная deterministic проверка всё ещё editorial | accept |
| rebuild_code_anchor | parent_epic_task отсутствует (standalone Quick), pending anchor валиден | own anchor_version+1, clear pending_anchor, review_cycle.full_review_required=true, verify |
| rebuild_code_anchor | parent_epic_task задан, waiting_parent_anchor=false, correction обоснована | append immutable correction event, void Ticket review binding, receipt phase=event_appended, park.reason=anchor_handoff_incomplete, `await ctx.transit(human)`, затем exact unblock parent и receipt phase=edge_suspended/waiting_parent_anchor; Epic metadata не писать |
| complete_anchor_handoff | event hash/receipt валидны, Ticket human, parent edge ещё active | идемпотентно подтвердить human park, exact unblock parent, receipt phase=edge_suspended, park.reason=waiting_parent_anchor |
| rebuild_code_anchor | parent_epic_task задан, waiting_parent_anchor=true, Ticket anchor=parent anchor, pending_anchor=null, matching parent_rebuild_receipt записан parent, suspension receipt/edge восстановлен | waiting_parent_anchor=false, review_cycle.full_review_required=true, verify |
| rebuild_code_anchor | parent_epic_task задан, waiting_parent_anchor=false, Ticket anchor=parent anchor, pending_anchor=null, matching parent_rebuild_receipt записан parent, suspended receipt отсутствует | review_cycle.full_review_required=true, verify |
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
~~~

Route, role и lens читаются из metadata. onTransit разрешает done только после появления verdict record правильной схемы и правильной artifact identity.

### autosk-contest-seat

Новая child task для каждого originating panel seat:

~~~text
review_disposition -> validate_disposition -> done
~~~

Identity включает artifact identity, canonical finding IDs, proposed rejection/downgrade и originating seat. Обычный panel PASS не является contest disposition.

### autosk-arena-candidate

~~~text
build_candidate -> verify_candidate -> freeze_candidate -> done
~~~

### autosk-arena-judge

Эта задача blocked_by кандидатскими задачами:

~~~text
judge -> validate_judgment -> done
~~~

## 3. Минимальная структура расширения

~~~text
autosk-flow/
  package.json
  src/
    index.ts
    config.ts
    agents/
      resolved-pi-agent.ts
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

Каждая задача, чей AgentDefinition вызывает resolvedPiAgent — Epic/Quick parent, Ticket implementer, panel/contest/narrow seat, code-review child, Arena candidate/Judge — имеет собственный autosk_flow.session record одной общей схемы. Reviewer/Judge session никогда не копируется из implementer/author task. Без собственного record enroll запрещён.

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

`anchor_rebuild_op` хранит `op_id`, consumed correction event IDs/watermark, pre-resume Epic/Ticket hashes, `from_version`, `to_version`, immutable dispositions каждого Ticket, per-ticket phase, общую phase (`prepared | anchor_committed | ready_to_transit`), recorded target и expected identity. Наличие открытой операции имеет приоритет над обычными guard-строками `rebuild_anchor`; закрыть её может только общий deterministic prologue уже достигнутого recorded target.

Epic `autosk_flow` metadata имеет единственного writer — parent deterministic steps. Пользователь, модели и Tickets публикуют correction events в append-only comments. Событие, пришедшее после consumed watermark, не конкурирует с metadata write и будет обработано следующим parent gate. Parent завершает все Epic/Ticket metadata writes и transit в `resume_repaired_tickets` до первого Ticket resume.

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
      "full_review_required": true
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

Receipt приостановленной blocker-связи содержит `{parent_task_id, ticket_task_id, blocker_id, blocked_id, ticket_artifact, ticket_hash, base_oid, state}`. `dispatch_ticket_dag` считает старую task совпавшей только при status=human с ожидаемым `blocked_anchor`/`waiting_parent_anchor` recovery metadata, равенстве пути, канонического hash байтов Ticket из текущего `tickets` PASS и точного execution base OID. Совпавшей task заново выдаются scope.base_oid, scope.pathspec и dependency blockers из текущего PASS. Done/cancel/new/missing task, изменившийся Ticket или base всегда получают replacement, даже если имя файла сохранилось; live work task автоматически не отменяется и паркует parent.

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

Провал lock/snapshot validation не выполняет model/fs side effects и паркует task с `protocol_lock_invalid`. `repair_protocol_snapshot` восстанавливает bytes только из exact content-addressed bundle/attestation, записанных в lock. Если эта версия недоступна, требуется human reinstall exact bundle либо явная migration на новую bundle identity с anchor impact и полными gates; current installed latest молча не подставляется.

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

Driver и transit correction штатного piAgent не копируются.

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

Каждый deterministic AgentDefinition начинает с `assertProjectBoundary` и повторяет его непосредственно перед каждым fs/Git/CLI/RPC side effect. `onTransit` выполняет только вторую defense-in-depth проверку; поздний отказ не считается защитой уже выполненной записи.

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
- для anchor repair снять ровно edge `autosk unblock <parent-id> <ticket-id>`, сохранив receipt, и вернуть его `autosk block <parent-id> <ticket-id>`; `--all` запрещён;
- после восстановления edge возобновить human Ticket через `autosk resume <ticket-id> --to rebuild_code_anchor`.

Каждая операция проверяет exit code и перечитывает созданную task view. Create-time marker позволяет найти task после crash до metadata set; task никогда не enroll до полной metadata/session/sandbox проверки. Retry переиспользует ровно один marker-matched child, а duplicate marker паркует dispatch. Recovery sweep закрывает только собственные `new` tasks с валидным marker и незавершённой metadata; произвольные unlabeled tasks не трогает. Совпавший run_id другого проекта никогда не считается той же операцией.

Эти команды являются доступными autosk CLI-операциями, а не действиями модели. Обычную human-задачу возобновляет пользователь; единственное автоматическое исключение — deterministic parent step для anchor repair с валидными parent rebuild и edge receipts. Preflight расширения в временном проекте обязан доказать точечный `block -> unblock -> block` и parent-initiated `resume --to rebuild_code_anchor`; отсутствие любой операции останавливает запуск до создания реальных задач.

Возвращённый blocker запрещает новый dispatch parent, но не отменяет уже работающую parent session и не запрещает ей завершить единственный `ctx.transit`. Поэтому порядок остаётся таким: restore edge, resume child, parent transit `ticket_join`; integration-test фиксирует именно этот межпроцессный сценарий.

Все side effects — create/block/enroll/metadata, Git freeze, worktree preparation и integration — выполняются только deterministic AgentDefinition steps, где доступен ctx.exec. onTransit ничего не запускает и не пишет во внешние системы: он только читает task/metadata, проверяет guard и разрешает либо отклоняет один переход.

### Contest и anchor changes

После synthesis любое предложенное отклонение или снижение серьёзности finding создаёт contest child task каждому originating seat. Parent блокируется ими и не переходит к fix/PASS до валидных dispositions.

Новая пользовательская инструкция, изменение Decision Log или Ticket/verdict signal не пишет Epic metadata напрямую. Источник добавляет immutable structured `anchor_correction` event в comments родительского Epic: `{event_id, project_root_sha256, source_task/session, source_anchor, affected_identity, reason, payload_hash}`. Parent deterministic gate проверяет/хеширует event, как единственный metadata writer merge'ит его в pending_anchor и записывает consumed event IDs/watermark. Поздний event остаётся в inbox до следующего gate и не может быть стёрт parent write.

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
11. если affected лишь Ticket code bindings, сначала до конца выполняет replacement phases и все Epic/Ticket metadata writes, затем target=`resume_repaired_tickets`; никакой Ticket не resume внутри rebuild_anchor;
12. если affected bindings пусты, active Arena run void и target=`dispatch_arena`; иначе target=`select_next` либо `ticket_join` по записанной phase;
13. после всех side effects и повторной проверки receipts/blockers атомарно ставит `phase=ready_to_transit` и recorded target;
14. retry с `ready_to_transit` не требует pending_anchor и вызывает только тот же `ctx.transit(recorded_target)`;
15. каждый возможный target начинает deterministic prologue: проверяет, что task действительно вошла в recorded target с нужным anchor/version, и только затем атомарно закрывает anchor_rebuild_op. Crash после transit до prologue повторяет prologue, а не rebuild;
16. интеграция запрещена до нового PASS всех affected Tickets; новая identity идёт только в полную соответствующую panel/code-review gate.

Ticket anchor_version — производная копия parent Epic anchor, не самостоятельный счётчик. rebuild_code_anchor:

- для standalone Quick без parent_epic_task увеличивает собственный anchor и требует full Code Review;
- для Ticket пишет pending_anchor proposal в parent Epic, void'ит собственный review binding, ставит waiting_parent_anchor=true и сохраняет receipt временного удаления blocker edge parent<-Ticket;
- Ticket остаётся human, но suspension позволяет parent в итоге дойти до ticket_join и blocked_anchor/rebuild_anchor;
- parent rebuild_anchor обновляет Ticket task metadata до единого to_version и оставляет affected human Tickets matching parent_rebuild_receipt; при code-only mixed impact сначала полностью создаёт/закрывает replacement phases для affected done/cancel/new/missing Tickets, только затем обеспечивает active edges и возобновляет human Tickets в rebuild_code_anchor, после чего переходит ticket_join; live work Ticket останавливает новую операцию; при planning impact suspension хранится до будущего dispatch_ticket_dag, который также завершает replacements до human resume;
- commit_on_pass и ticket_join требуют равенства Ticket anchor_version parent Epic anchor_version.

Удаление blocker без suspension receipt или потеря обратного восстановления — blocking error.

### Structured verdict

Reviewer обязан добавить JSON verdict в task comment или evidence record перед transit. validate_verdict проверяет:

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

Panel, contest, narrow Lead, code-review и Judge запускаются с explicit custom tool allowlist: snapshot-rooted read/grep/list + current-task transit. Builtin bash/powershell/edit/write и `@autosk/pi-tools` task/comment mutations не загружаются; arbitrary autosk CLI недоступен. Structured verdict возвращается через driver и записывается host-side после завершения model run.

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
- Panel join требует четыре ожидаемых child tasks в status=done и четыре валидных verdict bindings. Child human оставляет parent blocked; cancel/missing/invalid после разблокировки переводят parent в human.
- Сокращённый panel join допустим только с exact waiver той же identity, полным actual_roster и gate Lead вне author/fixer set.
- Любой pending_anchor, BLOCKED_ANCHOR или несовпадение anchor_version переводит parent в human с blocked_anchor; четыре PASS ничего не разрешают.
- Открытый anchor_rebuild_op имеет приоритет над обычной классификацией: rebuild_anchor продолжает только его записанную phase, ready_to_transit допускает только recorded target, а target prologue закрывает op после проверки фактического входа.
- Narrow review join требует ровно одного Lead child в status=done и verdict текущей identity; findings возвращают fix_artifact, PASS ведёт select_next, invalid terminal ведёт human.
- Contest join требует отдельную disposition каждого originating seat; снижение или отклонение finding без полного набора dispositions недействительно.
- Ticket join требует каждую ожидаемую Ticket task в status=done, действующий code PASS и commit OID. Terminal status сам по себе недостаточен.
- Arena не стартует без rubric 3–6 критериев и минимум двух разных candidate families.
- Judge не принадлежит candidate family и не получает family labels.
- Arena join требует judge status=done и judgment binding текущей arena identity. Child human оставляет parent blocked; cancel/missing/invalid ведут human.
- apply_arena_decision и planning rebuild_anchor выставляют current_cycle.full_panel_required=true. Пока флаг true, freeze может идти только в dispatch_panel; валидный full panel_join атомарно сбрасывает его в current_cycle, после чего fix этого же attempt может использовать Lead-only narrow re-review.
- rebuild_code_anchor выставляет Ticket/Quick review_cycle.full_review_required=true. Пока флаг true, freeze может идти только в dispatch_review; только валидный record_code_verdict полного review сбрасывает флаг.
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
| Project boundary/path guard не прошёл | human с project_boundary_invalid; side effects count=0 |
| Child create завершился частично | повторный dispatch находит задачи по parent/run/seat |
| Duplicate/malformed create-time marker | human с child_dispatch_marker_invalid; ни один child не enroll |
| Child task parked human | parent остаётся blocked; оператор возобновляет child в его существующем workflow либо cancel делает join ответственным за parent park; только anchor-repair parent step может автоматически resume Ticket по валидным receipts |
| Один seat cancel/unavailable | parent переходит в human; сокращённый roster требует явного waiver |
| Ticket cancel/done без binding | parent переходит в human; такой Ticket не считается завершённым |
| Crash после Ticket human park и до exact unblock parent | Ticket остаётся human с anchor_handoff_incomplete; parent безопасно остаётся blocked |
| Affected Ticket ещё status=work во время rebuild_anchor | parent паркуется с anchor_repair_ticket_live до любых rebuild writes; pending_anchor сохраняется |
| Artifact изменён после verdict | verdict void, новый attempt |
| Arena decision не re-expressed в новых Tech Plan bytes | human с arena_reexpression_missing |
| Correction event schema/hash/project invalid | human с correction_event_invalid; event не consume'ится |
| Protocol lock/snapshot повреждён | human с protocol_lock_invalid; model/fs side effects не выполняются |
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
| project_boundary_invalid | исходный deterministic step | project binding/path исправлены и повторный pre-side-effect assert PASS |
| child_dispatch_marker_invalid | исходный dispatch step | duplicate закрыт/исследован, остаётся один valid create-time marker |
| panel_waiver_required | dispatch_panel или panel_join | retry отсутствующего route либо waiver текущей identity и actual roster |
| contest_join_invalid | dispatch_contest | invalid disposition tasks записаны, attempt+1 |
| narrow_join_invalid | dispatch_narrow_review | прежний Lead child закрыт, новый attempt |
| review_join_invalid | dispatch_review или dispatch_narrow_review | invalid review child закрыт, новый attempt и сохранён narrow/full mode |
| code_verdict_invalid | freeze | старый review binding void, новый candidate/review attempt |
| protocol_lock_invalid | repair_protocol_snapshot | exact locked content digest/manifest/attestation доступен для atomic re-mint; иначе reinstall exact bundle либо явная migration с full gates |
| arena_reexpression_missing | draft_artifact | Decision Record/graft list отражены в новых Tech Plan bytes и identity отличается от pre-arena |
| correction_event_invalid | human decision, затем исходный gate | event исправляется только новой append-записью; старый record не редактируется и не consume'ится |
| blocked_anchor, autosk-planned | rebuild_anchor | полный human-approved anchor_impact; recorded target выбирается только из draft_artifact, dispatch_arena, select_next или ticket_join по impact/phase |
| anchor_impact_invalid | rebuild_anchor | исправленная полная impact map и повторно проверенные unchanged hashes |
| anchor_repair_ticket_live | rebuild_anchor | anchor_rebuild_op=null; каждый affected live run завершился в human/done/cancel; status/impact map перечитаны; pending_anchor сохранён; rebuild writes отсутствуют |
| anchor_handoff_incomplete | complete_anchor_handoff | event/receipt hash валидны, Ticket human и exact parent edge ещё active |
| blocked_anchor, standalone Quick | rebuild_code_anchor | own anchor bump, старые review bindings void, затем verify/freeze/full code review |
| blocked_anchor, Ticket with parent | rebuild_code_anchor | propagate pending to parent, suspend blocker with receipt, ждать parent rebuild_anchor |
| waiting_parent_anchor | rebuild_code_anchor | parent rebuild завершён, Ticket anchor=parent, local pending=null, receipt restored |
| blocked_anchor, Ticket pending already absorbed by parent | rebuild_code_anchor | Ticket anchor=parent, local pending=null, matching parent_rebuild_receipt, no suspended receipt |
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
- create-time child marker однозначно кодирует project/parent/run/seat и обнаруживает duplicate marker;
- correction event schema/id/hash/watermark не допускает повторное consume;
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
- rebuild_anchor завершает Epic metadata и transit до `resume_repaired_tickets`; после первого Ticket resume parent metadata writer больше не вызывается;
- Ticket park→unblock crash оставляет parent blocked и восстанавливается через complete_anchor_handoff;
- ticket_join при missing blocker создаёт edge, transits ticket_join_wait и не завершает onRun без ctx.transit;
- gate role не получает bash/edit/write/autosk_task и не может изменить parent/sibling store; structured verdict записывает host driver;
- запуск с временным HOME без `.traycer`, devflow и Obsidian проходит Quick и Planned smoke;
- active bundle и prompt compiler не выполняют filesystem/process lookup Traycer;
- четыре child tasks создаются до parent join;
- при workers>=4 свободный pool запускает независимые seats параллельно; при меньшем pool результат не меняется;
- parent не запускается, пока blocker открыт;
- pending_anchor блокирует panel/contest/narrow/review/Arena/Ticket joins и integrate до rebuild;
- partial anchor_impact re-bind'ит ровно unchanged planning passes и void'ит ровно affected bindings;
- Ticket-scoped BLOCKED_ANCHOR propagates to parent with a suspension receipt;
- code-only anchor repair restores any suspended edge before Ticket resume and parent transit; planning repair keeps the edge suspended until dispatch_ticket_dag, which also restores before resume;
- affected Ticket whose pending was absorbed before suspension resumes through the matching parent_rebuild_receipt path and cannot stall between guards;
- planning repair resolves every suspended receipt by resume or superseded cleanup; unmatched receipt parks ticket_edge_receipt_lost;
- planning repair reuses an old Ticket only when it is human in the expected recovery state and artifact path, canonical ticket hash and execution base match; it reissues scope/dependency blockers and clears stale candidate state, otherwise replaces any non-live task;
- mixed code-only repair creates/enrolls replacement tasks and resumes human recovery Tickets inside the current rebuild_anchor session before parent transits to ticket_join;
- code-only repair never resumes done/cancel/new/missing affected Tickets; it creates replacement repair tasks with fresh dependency blockers instead, while status=work parks without automatic cancellation;
- code-only replacement repair first suspends the old edge, closes every old new task and recorded sandbox, then prepares/swaps/enrolls the replacement and finally adds its parent blocker; crash at each phase resumes the same op, and old/new implementations cannot run together;
- crash-matrix после каждой mixed replacement phase либо продолжает anchor_rebuild_op на unblocked parent, либо безопасно ждёт уже enrolled replacement; не остаётся open old-new blocker или одновременно runnable old/new task;
- crash после anchor_committed, после любого child blocker, перед recorded transit и после transit до target prologue продолжает тот же op/to_version; ready_to_transit не требует pending_anchor и не переклассифицирует изменившиеся child statuses;
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
- уже работающий parent после восстановления blocker edge успешно завершает ctx.transit в ticket_join, а новый parent dispatch остаётся заблокирован child status;
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
