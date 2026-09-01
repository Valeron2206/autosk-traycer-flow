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
 -> init_planning_ref -> select_next

human alignment before normative planning:
  select_next -> clarify_alignment -> await_alignment (human)
  -> record_alignment -> draft_artifact

artifact full panel:
  draft_artifact -> draft_artifact | freeze_artifact -> dispatch_panel
  -> panel_join -> synthesize_panel -> record_artifact_pass -> publish_artifact_pass

tickets proposal and alignment:
  select_next -> draft_artifact -> present_tickets_breakdown
  -> await_alignment (human) -> record_alignment -> freeze_artifact

artifact fix:
  synthesize_panel -> fix_artifact -> freeze_artifact
  -> dispatch_narrow_review -> narrow_review_join
  -> record_artifact_pass -> publish_artifact_pass

contest:
  synthesize_panel -> dispatch_contest -> contest_join
  -> synthesize_panel

arena:
  select_next -> dispatch_arena -> arena_join
  -> apply_arena_decision -> clarify_alignment -> await_alignment (human)
  -> record_alignment -> draft_artifact
  -> freeze_artifact -> dispatch_panel -> panel_join -> synthesize_panel
  -> record_artifact_pass -> publish_artifact_pass

execution:
  select_next -> dispatch_ticket_dag -> resume_repaired_tickets -> ticket_join
  -> accept -> integrate -> aggregate_verify -> cleanup -> done
  aggregate_verify -> record_aggregate_remediation
  select_next -> record_aggregate_remediation
  record_aggregate_remediation -> record_aggregate_remediation | aggregate_verify | dispatch_ticket_dag | draft_artifact | present_tickets_breakdown

recovery:
  prepare_anchor_impact -> await_anchor_impact_approval (human)
  -> record_anchor_impact_approval -> rebuild_anchor
  rebuild_anchor -> publish_planning_invalidation | clarify_alignment | present_tickets_breakdown | draft_artifact | dispatch_arena | select_next | resume_repaired_tickets | ticket_join | human
  init_planning_ref -> select_next | human
  publish_artifact_pass -> select_next | human
  publish_planning_invalidation -> recorded rebuild target | human
  resume_repaired_tickets -> ticket_join
  panel_join_wait -> panel_join
  contest_join_wait -> contest_join
  narrow_review_join_wait -> narrow_review_join
  arena_join_wait -> arena_join
  ticket_join_wait -> ticket_join
  repair_protocol_snapshot -> recorded pre-failure step | human
  authority_recovery -> recorded pre-failure step | human
  integration_recovery -> integrate | human
  Quick integration_recovery -> integrate | cleanup | human
~~~

Brief, Core Flow, Tech Plan и весь комплект Tickets — четыре значения current_artifact.kind и проходят один artifact cycle. `clarify_alignment`, `await_alignment` и `record_alignment` общие, но проверяют закрытую схему текущего kind. `clarify_alignment` принимает только brief/core_flow/tech_plan. Tickets всегда сначала получают proposal bytes и входят через `present_tickets_breakdown`; subject/scope change во время ожидания возвращает туда же, а не в clarify. Отдельных tickets-panel steps нет.

Каноническая таблица переходов:

Перед вычислением gate parent вызывает `consumeAnchorCorrections`: daemon reconciles protected Epic intent head with ordered `appendIntentEvent` journal/comments, затем parent merge'ит новые schema/provenance-valid events в pending_anchor. Direct comment edit, reorder/delete или projection mismatch fail-closed. Invalid raw record пропускается только later schema-valid superseder + matching UserDecisionRecord. Event appended after current consume advances intent head and invalidates guard. Ticket_join suspension receipt ordering остаётся единственным edge exception.

У всех fan-out одинаковый deterministic join prologue. Если ожидаемый child имеет status=new/work/human, но его exact parent blocker отсутствует, join восстанавливает только этот edge и переходит в зарегистрированный `<join>_wait`. Исключение — точный Ticket handoff с human child, matching immutable event, final `edge_suspended` receipt и намеренно отсутствующим edge: `ticket_join` не восстанавливает blocker, а переводит correction в `blocked_anchor`. Незавершённый receipt исключением не считается. Пока хотя бы один обычный blocker активен, scheduler не запускает wait-step; когда все children terminal/removed, wait-step обязан перейти обратно в исходный join. Это правило действует для panel, contest, narrow, Arena, code review и Ticket joins и не позволяет AgentDefinition завершить onRun без transition.

| Текущий шаг | Условие | Следующий шаг |
| --- | --- | --- |
| intake | classification валиден и workflow=autosk-planned | init_planning_ref |
| init_planning_ref | prepared init operation отсутствует, exact planning base/ref/project binding невалидны | human с park.reason=planning_ref_init_invalid; Git side effects отсутствуют |
| init_planning_ref | required object-format-neutral create/reflog capability unavailable | human с park.reason=planning_ref_capability_missing; draft/provider side effects отсутствуют |
| init_planning_ref | phase=prepared, ref отсутствует | exact missing-old-value CAS with operation-specific `--create-reflog` message; read ref/reflog; atomically phase=ref_created; init_planning_ref |
| init_planning_ref | phase=prepared|ref_created, ref=recorded base and exact operation-specific zero→base reflog entry exists | reconstruct receipt if needed; read-back commit/tree/ref/reflog; atomically phase=verified and planning.init_status=verified/head=base/generation=0; select_next |
| init_planning_ref | ref=base without matching persisted operation/reflog proof, ref differs, reflog has unknown/ABA entry | human с park.reason=planning_ref_foreign_movement; reset/delete/adopt запрещены |
| init_planning_ref | operation/receipt/claimed durable state corrupt or indeterminate | human с park.reason=planning_ref_init_invalid; no destructive recovery |
| freeze_artifact / Quick freeze / Ticket freeze | closed path-role classifier returns `unknown` for a document/governance surface, or `additional_normative` lacks exactly one valid governance mapping to current named manifest decision IDs, mapping/sidecar is orphaned, ambiguous or stale, or document contains extra unmapped normative content | human с park.reason=artifact_mapping_required; candidate/panel/PASS mint absent. `ordinary_implementation` source/config/schema/prompt/test/migration paths do not match this guard. Quick additionally invalidates classification if new material behavior exists; Ticket propagates parent correction |
| freeze_artifact / Quick freeze / Ticket freeze | every `additional_normative` path has valid current mapping, but ordered proof-set digest is not yet bound to current artifact/code candidate | atomically record exact-tree proofs in task-owned protected metadata, bind `governance_mapping_set_digest` to candidate identity and repeat same freeze step |
| await_alignment / record_alignment / present_tickets_breakdown / freeze_artifact / fix_artifact / record_artifact_pass | kind=tickets, aggregate_remediation phase=proposal_ready и current proposal digest != recorded new_ticket_set_digest | atomically phase=old_bindings_void, clear new digest, alignment_records.tickets=stale, artifact_pass.tickets=void, review cycle full required; draft_artifact до нового breakdown/panel |
| select_next | `aggregate_remediation.phase != closed` | record_aggregate_remediation; recorded prefix продолжается, old/partial new Tickets не dispatch'ятся |
| select_next | current artifact PASS/waiver имеет publication_status=recorded_unpublished либо open matching planning_publication_op phase != verified | publish_artifact_pass; kind ещё не завершён |
| select_next | первый required и ещё не passed kind среди brief, core_flow, tech_plan; действующий alignment record текущей project/Epic/kind/anchor/scope/subject identity отсутствует | записать kind, создать review_cycles[kind] если absent, clarify_alignment |
| select_next | первый required и ещё не passed kind среди brief, core_flow, tech_plan; действующий alignment record уже существует | записать kind, создать review_cycles[kind] если absent, draft_artifact |
| select_next | Tech Plan passed и существует arena.decisions entry status=pending | выбрать первый stable decision_id, записать current_decision_id, dispatch_arena |
| select_next | planning kinds passed, все Arena decisions terminal либо отсутствуют, Tickets ещё не passed | записать kind=tickets, создать review_cycles.tickets если absent, draft_artifact как proposal |
| select_next | Tickets passed и alignment_records.tickets current | dispatch_ticket_dag |
| select_next | Tickets artifact binding существует, но breakdown alignment отсутствует/stale | void stale pass/waived binding, present_tickets_breakdown |
| clarify_alignment | current daemon `UserDecisionRecord` signature/provenance/identity валиден | record_alignment с source=user_decision |
| clarify_alignment | daemon decision отсутствует; unresolved assumption отсутствует; classifier доказал policy-eligible classes и current project policy projection active с exact binding/rule/scope/constraints | record_alignment с source=project_policy |
| clarify_alignment | daemon decision отсутствует; classifier выдаёт human_required/forbidden/unknown/ambiguous либо packet содержит unresolved assumption | записать subject/scope/classifier proof, await_alignment и human с kind-specific `brief_alignment_required`, `core_flow_decision_required` или `tech_plan_readiness_required` |
| clarify_alignment | daemon decision отсутствует; classifier policy-eligible; policy candidate указан, но missing/revoked/expired/replaced/hash-mismatched либо не покрывает derived rules | await_alignment и human с park.reason=alignment_policy_out_of_scope |
| clarify_alignment | daemon decision и policy candidate отсутствуют | await_alignment и human с kind-specific alignment reason |
| await_alignment | statusStep human | bare resume запрещён; после нового daemon decision или current policy разрешён только `record_alignment`; после смены subject/scope — `clarify_alignment`, а для kind=tickets — `present_tickets_breakdown` |
| record_alignment | source не `user_decision\|project_policy`, daemon provenance отсутствует, Git/comment используется как authority, classifier proof invalid либо identity не совпадает | human с kind-specific reason либо park.reason=alignment_policy_out_of_scope; record не создаётся |
| record_alignment | прежний valid record не совпадает с current project/Epic/kind/anchor/scope/subject/classifier/policy/protocol и нового authority record текущей identity ещё нет | atomically status=stale, human с park.reason=alignment_record_stale |
| record_alignment | kind=tech_plan, Arena status=recommended, disposition=applied и daemon decision либо classifier-proven current policy разрешает recommendation | atomically записать alignment record + authority-bound Decision Record mirror, перевести entry в terminal applied, current_decision_id=null, затем draft_artifact |
| record_alignment | kind=tech_plan, Arena status=recommended, disposition=fallback и daemon `UserDecisionRecord` exact Arena identity валиден | atomically записать alignment record + authority-bound Decision Record mirror, перевести entry в terminal fallback, current_decision_id=null, затем draft_artifact |
| record_alignment | kind=brief/core_flow/tech_plan, active Arena recommended отсутствует; новый daemon decision либо re-resolved exact policy валиден для current identity | старый authority/approval hash остаётся audit evidence; atomically записать новый current record и перейти в draft_artifact |
| record_alignment | kind=brief/core_flow/tech_plan, active Arena recommended отсутствует; current alignment record уже валиден и identity byte-identical | идемпотентно draft_artifact без перезаписи record |
| record_alignment | kind=tickets, daemon-attributed breakdown approval либо re-resolved policy валидны для той же proposal/classifier identity | старый authority/approval hash остаётся audit evidence; atomically записать alignment_records.tickets, current_alignment=null, freeze_artifact |
| draft_artifact | current author worktree/base OID или live private planning ref не равны verified planning.head_oid/tree | human с park.reason=planning_candidate_base_stale; provider не вызывается, candidate/PASS отсутствуют |
| draft_artifact | provider/model недоступен после retry | human с park.reason=artifact_draft_provider_unavailable |
| draft_artifact | output missing/invalid или out-of-scope mutation | human с park.reason=artifact_draft_result_invalid либо artifact_draft_scope_invalid; normative bytes/PASS не создаются |
| draft_artifact | arena re-expression required, но Decision Record/graft list не отражены в новых Tech Plan bytes либо identity равна pre-arena | human с park.reason=arena_reexpression_missing |
| draft_artifact | kind=tickets, proposal bytes и dependency view записаны, scope чист; aggregate remediation absent/closed | present_tickets_breakdown |
| draft_artifact | kind=tickets, aggregate_remediation phase=old_bindings_void, new proposal bytes/DAG/scope valid | atomically записать new_ticket_set_digest + phase=proposal_ready, present_tickets_breakdown |
| draft_artifact | kind=tickets, aggregate_remediation phase=proposal_ready и current proposal digest совпадает | идемпотентно present_tickets_breakdown |
| draft_artifact | kind=tickets, aggregate_remediation phase=proposal_ready и proposal digest изменился | atomically clear new digest + phase=old_bindings_void, draft_artifact; approval/panel ещё отсутствуют |
| draft_artifact | kind=brief/core_flow/tech_plan, post-draft projected material manifest отличается от approved manifest либо projector/classifier proof изменён | atomically alignment status=stale, artifact остаётся non-normative proposal, clarify_alignment |
| draft_artifact | kind=brief/core_flow/tech_plan, alignment current, projected manifest byte-identical, bytes/scope чисты и Arena re-expression complete/not-required | freeze_artifact |
| present_tickets_breakdown | не показан полный set/DAG/scopes/outcomes/order/exclusions | await_alignment и human с park.reason=tickets_breakdown_alignment_required |
| present_tickets_breakdown | current Tickets subject совпадает с действующим alignment record | freeze_artifact |
| present_tickets_breakdown | current daemon breakdown decision совпадает с proposal/classifier identity | record_alignment с source=user_decision |
| present_tickets_breakdown | daemon decision отсутствует; classifier доказал scheduling-only и current exact policy покрывает rules при byte-identical set/scope/outcomes/dependencies/exclusions | record_alignment с source=project_policy |
| present_tickets_breakdown | daemon decision отсутствует; policy candidate указан, но invalid/current coverage не доказан | await_alignment и human с park.reason=alignment_policy_out_of_scope |
| present_tickets_breakdown | approval stale/mismatched либо daemon decision и policy candidate отсутствуют | await_alignment и human с park.reason=tickets_breakdown_alignment_required |
| freeze_artifact | alignment отсутствует/stale либо recomputed material manifest/projector/classifier не совпадает с current identity | human с park.reason=alignment_record_stale; Brief/Core Flow/Tech Plan возвращаются в clarify_alignment, Tickets — в present_tickets_breakdown |
| freeze_artifact | candidate.base_oid/base_tree или live planning ref не совпадают с verified planning head | human с park.reason=planning_candidate_base_stale; panel child/PASS не создаются |
| freeze_artifact | scope/pathspec/tree identity mint invalid или changed during mint | human с park.reason=artifact_freeze_invalid; panel child/PASS не создаются |
| freeze_artifact | panel waiver candidate указан, но daemon signature/identity/scope/expiry невалидны | human с park.reason=panel_waiver_required; panel child не создаётся |
| freeze_artifact | signed panel waiver mode=full_skip exact current artifact/alignment identity валиден | record_artifact_pass с disposition=waived; panel child не создаётся |
| freeze_artifact | current_cycle.full_panel_required=true или current_cycle.narrow=false | dispatch_panel |
| freeze_artifact | current_cycle.narrow=true, но scope/anchor/load-bearing decisions изменились | atomically current_cycle.narrow=false, current_cycle.full_panel_required=true, dispatch_panel |
| freeze_artifact | current_cycle.narrow=true, current_cycle.full_panel_required=false и scope/anchor/load-bearing decisions не изменились | dispatch_narrow_review |
| dispatch_panel | current alignment record отсутствует, stale либо не входит в controlling anchor pack | human с park.reason=alignment_record_stale; panel child не создаётся |
| dispatch_panel | нет gate-carrying семьи вне union author/fixer set | human с park.reason=no_external_panel_lead |
| dispatch_panel | route недоступен после retry и точного waiver ещё нет | human с park.reason=panel_waiver_required |
| dispatch_panel | четыре child tasks или exact-waived actual_roster полностью настроены/enrolled и parent имеет exact blockers всех children | panel_join |
| panel_join | pending_anchor, любой verdict=BLOCKED_ANCHOR или anchor version отличается | atomically ensure pending_anchor(reason, identity), human с park.reason=blocked_anchor |
| panel_join | любой child status=new/work/human | join prologue обеспечивает exact blocker, panel_join_wait; human child возобновляет пользователь |
| panel_join_wait | хотя бы один expected blocker активен | step не запускается scheduler |
| panel_join_wait | все expected blockers terminal/removed | panel_join |
| panel_join | signed panel waiver mode=reduced_roster текущей identity, actual_roster содержит external Lead, все listed seats done/bound | atomically current_cycle.full_panel_required=false, synthesize_panel |
| panel_join | roster меньше четырёх без waiver | human с park.reason=panel_waiver_required |
| panel_join | все четыре status=done, verdicts валидны, нет BLOCKED_ANCHOR/mismatch | atomically current_cycle.full_panel_required=false, synthesize_panel |
| panel_join | любой cancel/missing/invalid | human с park.reason=panel_join_invalid |
| synthesize_panel | требуется contest | dispatch_contest |
| synthesize_panel | подтверждены findings | fix_artifact |
| synthesize_panel | PASS | record_artifact_pass |
| dispatch_contest | canonical finding уже имеет terminal disposition той же candidate identity | human с park.reason=contest_join_invalid; новый contest child не создаётся |
| dispatch_contest | все contest children настроены/enrolled и parent имеет exact blockers всех children | contest_join |
| contest_join | pending_anchor или disposition=BLOCKED_ANCHOR/mismatch | atomically ensure pending_anchor(reason, identity), human с park.reason=blocked_anchor |
| contest_join | любой child status=new/work/human | join prologue обеспечивает exact blocker, contest_join_wait; human child возобновляет пользователь |
| contest_join_wait | хотя бы один expected blocker активен | step не запускается scheduler |
| contest_join_wait | все expected blockers terminal/removed | contest_join |
| contest_join | все originating seats status=done и dispositions валидны | atomically записать terminal disposition per finding/candidate, synthesize_panel |
| contest_join | cancel/missing/invalid | human с park.reason=contest_join_invalid |
| fix_artifact | provider/model недоступен после retry | human с park.reason=artifact_fix_provider_unavailable; findings/candidate identity сохранены |
| fix_artifact | model run завершился без valid completion record | human с park.reason=artifact_fix_result_invalid; bytes не нормативны |
| fix_artifact | обнаружена out-of-scope/unexpected mutation | human с park.reason=artifact_fix_scope_invalid; mutation inventory сохранён, PASS bindings не создаются |
| fix_artifact | alignment subject/material manifest изменился; kind=tickets | старый approval status=stale, current_cycle.narrow=false/full_panel_required=true, present_tickets_breakdown |
| fix_artifact | alignment subject/material manifest изменился; kind=brief/core_flow/tech_plan | старый approval status=stale, current_cycle.narrow=false/full_panel_required=true, clarify_alignment |
| fix_artifact | исправлены только confirmed findings без scope/alignment-subject change | freeze_artifact с current_cycle.narrow=true |
| fix_artifact | изменился scope/anchor/load-bearing decision | старый approval stale, current_cycle.narrow=false/full_panel_required=true, clarify_alignment либо present_tickets_breakdown для Tickets |
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
| record_artifact_pass | alignment record текущей identity отсутствует/stale | human с park.reason=alignment_record_stale; ничего не записано |
| record_artifact_pass | atomic pass-and-operation capability unavailable in pinned autoskd/SDK | human с park.reason=planning_ref_capability_missing; ArtifactPassRecord/publication operation/model or Git side effects отсутствуют |
| record_artifact_pass | pending_anchor | human с park.reason=blocked_anchor; ничего не записано |
| record_artifact_pass | kind=tech_plan и autosk-arena block missing/malformed/history mismatch | human с park.reason=arena_contract_invalid; ничего не записано |
| record_artifact_pass | disposition=waived, waiver revalidation failed | human с park.reason=panel_waiver_required; ничего не записано |
| record_artifact_pass | disposition=waived и signed panel waiver mode=full_skip exact current identity валиден | validate/merge Arena fields identically to pass; atomically artifact_pass[kind]={disposition:waived,identity,waiver_record_id,waiver_record_hash,publication_status:recorded_unpublished}; create immutable planning_publication_op phase=prepared with exact recipe/OID; publish_artifact_pass |
| record_artifact_pass | disposition=pass, identity/anchor/roster или verdict binding невалидны | human с park.reason=artifact_pass_invalid; ничего не записано |
| record_artifact_pass | disposition=pass, verdict binding текущей identity валиден; для tech_plan Arena block валиден | atomically artifact_pass[kind]={disposition:pass,identity,verdict_hash,publication_status:recorded_unpublished}, arena fields обновлены; create immutable planning_publication_op phase=prepared with exact recipe/OID; publish_artifact_pass |
| publish_artifact_pass | open operation absent/multiple, payload/identity/full recipe/expected parent/tree/OID changed, unknown phase or another non-terminal planning operation open | human с park.reason=planning_publication_invalid; ref movement отсутствует |
| publish_artifact_pass | locked delivery policy requires exact signed recipe but trusted signer/replayable signature bytes unavailable before prepared | human с park.reason=planning_signing_unavailable; object/ref side effects absent |
| publish_artifact_pass | phase=prepared and ref=expected parent and reflog prefix=checkpoint | write persisted exact commit_object_bytes; verify Git returns expected OID; atomically phase=commit_created; publish_artifact_pass |
| publish_artifact_pass | phase=prepared|commit_created and ref=expected commit with exact object bytes and one matching reflog transition | reconstruct monotonic receipts, atomically phase=ref_advanced; publish_artifact_pass |
| publish_artifact_pass | phase=commit_created and ref=expected parent and reflog prefix=checkpoint | expected-old CAS with operation message/create-reflog; read ref/reflog; atomically phase=ref_advanced; publish_artifact_pass |
| publish_artifact_pass | current binding drift before ref movement, ref=expected parent and reflog prefix=checkpoint | atomically phase=voided_before_ref, artifact_pass=void, preserve audit/object evidence; route correction/alignment cycle |
| publish_artifact_pass | current binding drift after expected ref transition is proven | finish exact publication verification; ensure pending_anchor; no downstream draft/dispatch before descendant invalidation |
| publish_artifact_pass | ref neither expected parent nor expected commit, reflog prefix changed while ref returned to parent, or unknown reflog transition exists | human с park.reason=planning_ref_foreign_movement; no reset/rebase/force/adopt fallback |
| publish_artifact_pass | claimed durable recipe/object/ref/reflog phase missing, corrupt or indeterminate | human с park.reason=planning_publication_corrupt; operation remains open for explicit recovery |
| publish_artifact_pass | phase=ref_advanced and ref/commit/exact bytes/parent/tree/signature/trailers/reflog/current bindings exact | atomically phase=verified, planning head/tree/generation, artifact_pass publication_status=verified/published_commit_oid/op_id; close current Tickets remediation only here; current_artifact=null; select_next |
| publish_artifact_pass | phase=verified and final metadata/transition incomplete | read-back same commit/ref/reflog, finalize only missing monotonic projection, select_next |
| publish_artifact_pass | phase=voided_before_ref | idempotently retain void disposition and recorded recovery target; operation is terminal and cannot move ref |
| dispatch_arena | candidates и judge task настроены/enrolled, Judge blocked candidates и parent имеет exact blockers всех Arena children | arena_join |
| arena_join | pending_anchor, anchor mismatch или любой candidate/judge result=BLOCKED_ANCHOR | atomically ensure pending_anchor(reason, identity), human с park.reason=blocked_anchor |
| arena_join | любой Arena child status=new/work/human | join prologue обеспечивает exact blocker, arena_join_wait; human child возобновляет пользователь |
| arena_join_wait | хотя бы один expected blocker активен | step не запускается scheduler |
| arena_join_wait | все expected blockers terminal/removed | arena_join |
| arena_join | менее двух live candidates, fallback requested или candidate roster недостаточен | human с park.reason=arena_fallback_required |
| arena_join | judge status=done, минимум два live candidates и judgment binding валиден | apply_arena_decision |
| arena_join | cancel/missing/invalid judgment | human с park.reason=arena_join_invalid |
| apply_arena_decision | judgment binding содержит base recommendation + graft list либо daemon `UserDecisionRecord` выбрал fallback | arena.decisions[id].status=recommended с recommendation/graft hashes, current_decision_id сохраняется, terminal Decision Record ещё отсутствует; artifact_pass.tech_plan=null, alignment_records.tech_plan stale, kind=tech_plan, сохранить pre-arena identity, reexpression_required=true, review_cycles.tech_plan.narrow=false/full_panel_required=true, attempt+1, clarify_alignment |
| prepare_anchor_impact | pending_anchor отсутствует, open rebuild op уже существует либо source/status snapshot не читается | human с park.reason=anchor_impact_invalid; rebuild side effects отсутствуют |
| prepare_anchor_impact | pending_anchor валиден | deterministic classify all planning PASS/current kind/Ticket bindings+statuses, применить cascade, записать immutable proposal/status snapshot/rule hashes и status=proposed; await_anchor_impact_approval, human с park.reason=anchor_impact_approval_required |
| await_anchor_impact_approval | statusStep human | bare resume запрещён; signed `UserDecisionRecord` exact proposal hash разрешает только record_anchor_impact_approval |
| record_anchor_impact_approval | signature/proposal identity invalid или authority отсутствует | human с park.reason=anchor_impact_approval_required; status остаётся proposed |
| record_anchor_impact_approval | correction/status/hash drift после proposal | atomically status=stale, prepare_anchor_impact; approval не записывается |
| record_anchor_impact_approval | authority и current snapshot валидны | atomically status=approved + approval record ID/hash, read-back, rebuild_anchor |
| rebuild_anchor | anchor_rebuild_op открыт | validate op binding; продолжить записанные per-ticket phases/dispositions без повторной классификации; phase=ready_to_transit повторяет только recorded target |
| rebuild_anchor | approved staged anchor_impact/daemon record отсутствуют либо proposal hash не совпадает | human с park.reason=anchor_impact_approval_required; side effects отсутствуют |
| rebuild_anchor | status snapshot/correction watermark изменились после approval | atomically anchor_impact.status=stale, prepare_anchor_impact; side effects отсутствуют |
| rebuild_anchor | approved anchor_impact incomplete, current in-flight kind без current PASS не affected, cascade нарушен, hash claimed-unaffected изменён или Ticket task re-binding не подтверждён | human с park.reason=anchor_impact_invalid |
| rebuild_anchor | любой Ticket expected execution set status=work | human с park.reason=anchor_repair_ticket_live; parent не пишет metadata ни affected, ни unaffected live Ticket, pending_anchor сохраняется |
| rebuild_anchor | affected Ticket status=human, но это не waiting_parent_anchor с suspension receipt и не blocked_anchor с обоснованным pending до absorption | human с park.reason=anchor_impact_invalid; никаких mutation |
| rebuild_anchor | affected planning kinds не пусты | bump anchor, re-bind unchanged unaffected passes/alignments only by approved impact; void affected bindings; prepare typed descendant planning_publication_op payload.kind=anchor_invalidation with ordered affected kinds, approved impact ID/hash, invalidation projection digest and recorded next target; publish_planning_invalidation |
| publish_planning_invalidation | payload/impact/projection/full recipe invalid, ref/reflog foreign, exact object/receipt corrupt or affected projection differs from approved impact | human с planning_publication_invalid, planning_ref_foreign_movement или planning_publication_corrupt; no rewind/force |
| publish_planning_invalidation | pre-CAS impact/anchor drift and ref/reflog still at checkpoint | terminal phase=voided_before_ref; prepare_anchor_impact; no ref movement |
| publish_planning_invalidation | same exact-byte/object/CAS/reflog/read-back phases verified | atomically planning head/tree/generation updated, invalidation op closed, current kind=earliest affected/current_cycle full required; recorded target clarify_alignment либо present_tickets_breakdown |
| rebuild_anchor | planning unchanged, affected Ticket code bindings, affected Tickets human in allowed recovery state | orchestrateChildBatch bound to anchor_rebuild_op/exact child heads writes receipts/anchors; ready_to_transit(resume_repaired_tickets) |
| rebuild_anchor | code-only replacement dispositions, no expected Ticket status=work | orchestrateChildBatch applies exact supersede/create/configure child patches to replacement_ready; no enroll/blockers; ready_to_transit |
| rebuild_anchor | affected bindings пусты, active Arena decision pending/running | bump/re-bind, void old Arena run binding, arena attempt+1, dispatch_arena |
| rebuild_anchor | affected bindings пусты, planning phase без active Arena | bump/re-bind, select_next |
| rebuild_anchor | affected bindings пусты, execution/ticket_join phase | bump/re-bind Ticket task metadata, ticket_join |
| resume_repaired_tickets | authority/dependency/intent-head reconciliation, `consumeAnchorCorrections`, current Tickets pass/alignment или controlling digest не прошли; pending_anchor появился | op остаётся открытой без phase movement; human с park.reason=blocked_anchor, resume/enroll/block side effects отсутствуют |
| resume_repaired_tickets | нет ровно одной open repair op (`anchor_rebuild_op` source=code_only либо `ticket_repair_op` source=`fresh\|current\|planning\|aggregate_unchanged`) | human с ticket_repair_op_invalid |
| resume_repaired_tickets | replacement уже enrolled либо имеет dependency/parent blocker до `child_resumed` всех recorded human Tickets | human с park.reason=ticket_repair_state_invalid; op остаётся открытой, mutation запрещена |
| resume_repaired_tickets | recorded replacement имеет phase вне `{replacement_ready,replacement_enrolled}`, creation_key/binding_hash/owner/scope mismatch либо required preparation incomplete | human с park.reason=ticket_repair_state_invalid; op остаётся открытой, phases не продвигаются |
| resume_repaired_tickets | recorded human recovery Ticket имеет transitive prerequisite в replacement set либо stable topological order/dependency plan нарушен | human с park.reason=ticket_repair_state_invalid; op остаётся открытой, mutation запрещена |
| resume_repaired_tickets | recorded human recovery Ticket не human+pending и прошлый resume не доказан consumed intent либо status/step после target | human с park.reason=ticket_repair_state_invalid; op остаётся открытой, phases не продвигаются |
| resume_repaired_tickets | repair op валидна, every replacement phase=`replacement_ready\|replacement_enrolled`, parent не имеет premature replacement blockers, semantic writes sealed | получить daemon `authorityGuard(expected_relevant_authority_projection_hash,expected_dependency_head,expected_intent_head,expected_digest)`; daemon reconciles global authority journal, then under project mutex performs recorded phases; unrelated authority record does not stale projection, competing append waits |
| dispatch_ticket_dag | current tickets alignment отсутствует/stale либо его subject hash не совпадает с PASS Ticket set/DAG | human с park.reason=alignment_record_stale; child create/blocker side effects отсутствуют |
| dispatch_ticket_dag | current controlling_anchor_digest не совпадает с Tickets pass/waived/parent binding | ensure pending_anchor, human с park.reason=blocked_anchor; op/task side effects отсутствуют |
| dispatch_ticket_dag | `aggregate_remediation` открыт либо set-changing remediation не завершил atomic void старого Tickets PASS/alignment | human с park.reason=aggregate_remediation_required; op/task side effects отсутствуют |
| dispatch_ticket_dag | ticket_repair_op открыт, но project/anchor/tickets pass-or-waived/expected-set binding mismatch | human с park.reason=ticket_repair_op_invalid; side effects отсутствуют |
| dispatch_ticket_dag | open op recorded disposition содержит old Ticket status=work | human с park.reason=ticket_join_invalid; live task не изменяется/не отменяется |
| dispatch_ticket_dag | open op recorded suspended receipt не сопоставлен live Ticket/valid superseded_by | human с park.reason=ticket_edge_receipt_lost |
| dispatch_ticket_dag | ticket_repair_op открыт и recorded human task/path/hash/recovery state/dependency closure mismatch | human с park.reason=ticket_repair_state_invalid; op остаётся открытой, mutation запрещена |
| dispatch_ticket_dag | ticket_repair_op открыт и replacement уже enrolled/work либо имеет dependency/parent blocker | human с park.reason=ticket_repair_state_invalid; op остаётся открытой, mutation запрещена |
| dispatch_ticket_dag | open op matched receipt, но scope/dependency/candidate reset не подтверждены | human с park.reason=ticket_join_invalid |
| dispatch_ticket_dag | ticket_repair_op открыт и не все replacements phase=replacement_ready | orchestrateChildBatch applies only op-recorded child patches with expected heads and receipts; enroll/blockers forbidden; then dispatch_ticket_dag |
| dispatch_ticket_dag | ticket_repair_op открыт, все human bindings валидны и replacements phase=replacement_ready | atomically phase=ready_to_transit/target=resume_repaired_tickets, transit resume_repaired_tickets |
| dispatch_ticket_dag | remediation closed target=dispatch_ticket_dag with unchanged_repair_map и no ticket_repair_op | create op source=aggregate_unchanged binding failure evidence/map; every affected Ticket forced replacement/current repair candidate, complete_old forbidden; dispatch_ticket_dag |
| dispatch_ticket_dag | no op and current Tickets pass/alignment valid | classify set and create op source=`fresh\|current\|planning`; no child mutation yet; dispatch_ticket_dag |
| ticket_join | human Ticket имеет schema/hash-valid event и receipt, edge отсутствует, но receipt ещё не final `edge_suspended` | восстановить exact blocker edge, transit ticket_join_wait; child возобновляется через complete_anchor_handoff до consume |
| ticket_join | human Ticket имеет schema/hash-valid event, но malformed/mismatched receipt | восстановить exact blocker edge, transit ticket_join_wait; child возобновляется через repair_anchor_handoff mode=receipt_only, event не дублируется |
| ticket_join | human Ticket имеет malformed/mismatched raw comment/event | восстановить exact blocker edge, transit ticket_join_wait; child возобновляется через repair_anchor_handoff mode=supersede_event, старый raw record не редактируется |
| ticket_join | human Ticket имеет matching immutable event + final `edge_suspended` receipt + waiting_parent_anchor=true и edge намеренно отсутствует | не восстанавливать edge; consume/ensure pending_anchor(reason, identity, affected Ticket), human с park.reason=blocked_anchor |
| ticket_join | authority dependency/current digest mismatch, другой unconsumed correction, pending_anchor или anchor mismatch | consume/ensure pending_anchor(reason, identity, affected tickets), human с park.reason=blocked_anchor |
| ticket_join | любой другой ожидаемый Ticket status=new/work/human и соответствующий blocker отсутствует | восстановить exact blocker edge, transit ticket_join_wait |
| ticket_join_wait | blockers ещё открыты | step не запускается scheduler |
| ticket_join_wait | blockers terminal/removed | ticket_join |
| ticket_join | все Tickets done + current code review disposition=pass\|waived + commit OID, signed `IntegrationAuthorizationRecord` exact run/target/base/ordered commits/resulting tree/digest current | integrate |
| ticket_join | все Tickets done + current code review disposition=pass\|waived + commit OID, integration authorization отсутствует/невалидна | accept statusStep("human") |
| ticket_join | cancel/missing/done без binding | human с park.reason=ticket_join_invalid |
| ticket_join | ожидаемый Ticket status=human | обеспечить exact blocker edge, transit ticket_join_wait; пользователь возобновляет child |
| accept | current controlling digest mismatch | ensure pending_anchor, human с blocked_anchor; acceptance stale |
| accept | resume --to integrate, current IntegrationAuthorizationRecord связывает current target OID, completed-prefix receipt и exact remaining transitions/digest, pending_anchor отсутствует | integrate |
| integrate | daemon integration operation receipt phase=pending/indeterminate | integration_recovery до проверки expiry или нового Git side effect |
| integrate | controlling digest/pending_anchor/anchor mismatch | atomically ensure pending_anchor(reason, identity), human с park.reason=blocked_anchor до Git side effect |
| integrate | все Tickets integrated и pending operation отсутствует | aggregate_verify |
| integrate | IntegrationAuthorizationRecord missing/mismatched/expired | atomically сохранить completed ref-transition prefix/current target OID в integration-state; accept statusStep("human") с park.reason=integration_authorization_required; target ref дальше не читается/не меняется |
| integrate | next integration step plan/current authorization валидны | вызвать daemon `integrateApproved(expected_relevant_authority_projection_hash,expected_dependency_head,expected_intent_head,expected_digest,authorization_id,target,expected_old,new_oid)`; daemon под mutex reconciles global journal, re-resolves relevant projection/heads/classifier/auth и Git CAS; success -> integrate |
| integrate | precondition | human с park.reason=integration_precondition |
| integrate | obstruction | human с park.reason=integration_obstruction |
| integrate | foreign movement/indeterminate/reattach | integration_recovery или human по классификации |
| integration_recovery | pending receipt + target/reflog proves exact new OID | daemon marks committed, atomically advances completed-prefix/current target; integrate (which may aggregate or require new authorization) |
| integration_recovery | pending receipt + operation-bound reflog proves CAS never occurred and no movement after recorded watermark; target exact expected_old | daemon marks not_applied; integrate without advancing prefix |
| integration_recovery | состояние осталось foreign/indeterminate | human или cancel; обычный retry запрещён |
| aggregate_verify | controlling digest mismatch или pending_anchor | human с park.reason=blocked_anchor |
| aggregate_verify | все epic-критерии PASS | cleanup |
| aggregate_verify | NOT_PASS | first durable write создаёт aggregate_remediation с creation key/binding, old set digest, evidence hash, phase=proposed; select_next/dispatch уже fail-closed; human с park.reason=aggregate_verify_failed |
| record_aggregate_remediation | exact signed choice/current failure identity отсутствуют, choice вне `external_retry\|unchanged_dispatch\|set_changing` либо evidence drift | human с park.reason=aggregate_remediation_required; старые Tickets bindings не используются для нового set |
| record_aggregate_remediation | phase=closed и recorded_target binding валиден | идемпотентно recorded_target |
| record_aggregate_remediation | phase=proposed, choice=external_retry и evidence доказывает external retry | atomically phase=closed + recorded_target=aggregate_verify, clear park, aggregate_verify |
| record_aggregate_remediation | phase=proposed, choice=unchanged_dispatch, set/DAG byte-identical и signed failure-bound repair map валиден | atomically phase=closed + recorded_target=dispatch_ticket_dag + unchanged_repair_map_hash/failure_evidence_hash, dispatch_ticket_dag |
| record_aggregate_remediation | phase=proposed, choice=set_changing и signed exact remediation/fix scope валидны | atomically phase=choice_recorded, record_aggregate_remediation |
| record_aggregate_remediation | phase=choice_recorded | одной parent metadata replacement void old PASS/alignment + phase=old_bindings_void, draft_artifact |
| record_aggregate_remediation | phase=old_bindings_void | draft_artifact |
| record_aggregate_remediation | phase=proposal_ready и current new set digest совпадает | present_tickets_breakdown |
| repair_protocol_snapshot | exact locked bundle bytes/manifest/attestation доступны и revalidation PASS | atomically re-mint snapshot той же identity, clear park, recorded pre-failure step |
| repair_protocol_snapshot | exact locked bundle недоступен | human с park.reason=protocol_lock_invalid; current latest не подставляется |
| repair_protocol_snapshot | requested migration меняет bundle identity | prepare_anchor_impact; affected candidates/PASS проходят full gates |
| repair_protocol_snapshot | unmatched/malformed repair state | human с park.reason=protocol_lock_invalid; side effects отсутствуют |
| authority_recovery | journal ahead secure head и tail contiguous, stored canonical challenge byte-exact signed от committed head | CAS-forward authority+nonce heads, только затем rebuild/publish projection и recorded pre-failure step |
| authority_recovery | journal ahead содержит invalid/replayed/non-contiguous uncommitted tail | atomically quarantine exact tail bytes/hash, truncate только suffix без applied effects до secure head, nonce остаётся consumed; recorded pre-failure step |
| authority_recovery | workflow=panel/contest/code-review/Arena child и committed restore невозможен либо recovery state malformed/unmatched | emit_blocked_anchor; host result read-back, validate/done, parent blocker снимается |
| authority_recovery | dependency/intent protected head ahead, committed event missing/changed или projection/head mismatch | restore exact committed dependency/intent bytes из durable backup и re-derive projection; head rollback/recompute from task metadata запрещены; иначе human с park.reason=authority_journal_truncated |
| authority_recovery | integration authorization file/head missing/changed/shortened | restore exact committed record/head binding or human integration_authorization_required; integration operation state cannot substitute authority |
| authority_recovery | secure head ahead, committed record missing/changed либо committed prefix shortened | восстановить exact signed committed bytes из durable backup и verify same head; иначе human с park.reason=authority_journal_truncated |
| authority_recovery | destructive lost-key/reset exact user-presence recovery valid | new authority generation, void all prior approvals, prepare_anchor_impact |
| authority_recovery | unmatched/malformed recovery state | human с park.reason=authority_journal_truncated; head rollback/recompute запрещены |
| cleanup | все sandboxes/snapshots удалены либо absent, dirty=false | done |
| cleanup | dirty=true при force=false | human с park.reason=cleanup_dirty |
| done | terminal | нет переходов |

Строки каждого шага применяются строго сверху вниз; predicates взаимно исключаются и явно закрывают unmatched state. select_next считает kind завершённым только если artifact_pass disposition=pass|waived, publication_status=verified, published commit/tree совпадают с live private planning ref/head и binding совпадает с current anchor/protocol/runtime/instruction/artifact/alignment identity; waived branch дополнительно re-resolves authority. Tickets не входят в planning-kind search и появляются только после того, как все arena.decisions terminal. Stable pending order задаёт порядок entries; terminal entry не запускается повторно.

### Epic planning ref и commit-on-PASS

<!-- planning-ref-contract:v1 -->

Полный нормативный контракт находится в `docs/contracts/epic-planning-ref.md`. Planned Epic имеет private append-only `refs/autosk/epics/<epic_ref_key>/planning`; `init_planning_ref` CAS-создаёт его от immutable planning base. Каждый planning candidate обязан иметь base=current verified head. `record_artifact_pass` сохраняет только recorded-unpublished disposition и immutable recipe; `publish_artifact_pass` создаёт exact single-parent commit, expected-old CAS-продвигает ref и read-back проверяет commit/tree/parent/trailers до `verified`. Target ref не меняется.

`planning_ref_init_op` имеет phases `prepared -> ref_created -> verified` и требует operation-specific reflog proof before adopting a ref already at base. `planning_publication_op` имеет typed payload=`artifact_pass|anchor_invalidation`, full persisted/read-back exact commit recipe including `commit_object_bytes_base64`, phases `prepared -> commit_created -> ref_advanced -> verified`, terminal `voided_before_ref`, exact expected parent/tree/commit, `reflog_checkpoint` and monotonic receipts. Ref at expected commit after crash is accepted only after full object+reflog verification; changed prefix/ABA/other movement parks `planning_ref_foreign_movement`. Missing/corrupt claimed durable state parks `planning_publication_corrupt`. No re-sign/recompute-from-latest, rebase/reset/force/cherry-pick/adopt-current recovery exists.

Anchor rebuild first publishes a descendant invalidation through `publish_planning_invalidation`; only then may it redraft. Previous accepted bytes remain ancestry, stale projections are removed from the current tree, and later accepted versions append descendants. Verified Tickets publication supplies `planning_head` to issues #6–#9.

### autosk-quick

~~~text
intake -> implement -> verify -> freeze -> dispatch_review -> review_join -> record_code_verdict
       -> fix -> verify -> freeze -> dispatch_narrow_review -> review_join -> record_code_verdict
       -> freeze -> record_editorial_exemption -> accept
       -> accept -> integrate -> cleanup -> done
                     -> integration_recovery -> integrate | human
reclassification from intake/implement/verify/fix/freeze/record_code_verdict/accept/integrate-prologue:
  -> invalidate_quick_classification -> create/enroll autosk-planned replacement
  -> done(outcome=reclassified) | human
recovery: rebuild_code_anchor -> verify
          review_join_wait -> review_join
          repair_protocol_snapshot -> recorded pre-failure step | human
          authority_recovery -> recorded pre-failure step | human
~~~

accept — statusStep("human"); при валидном signed `IntegrationAuthorizationRecord` exact current candidate identity record_code_verdict либо current initial editorial exemption после повторной валидации могут перейти сразу в integrate. Project alignment policy этот переход не разрешает.

Quick metadata добавляет `quick_handoff=null|{op_id,project_root_sha256,source_task_id,run_id,intent_head,normalized_request_hash,classification_rules_hash,planned_trigger_hash,original_base_oid,declared_scope_hash,worktree_inventory_hash,candidate_hash?,review_hash?,acceptance_hash?,waiver_hash?,integration_authorization_hash?,replacement_creation_key,replacement_binding_hash,replacement_task_id,ownership_receipt_hash,phase}`. First `prepared` write atomically void'ит Quick review/accept/waiver/integration authorization, ставит `git_side_effects_forbidden=true` и связывает current heads/state before child create. Closed phases: `prepared -> replacement_created -> replacement_enrolled -> worktree_transferred -> complete`. Поля до phase write-once; retry только повышает phase и тот же creation key. `complete` разрешает outcome=reclassified, но не PASS/integration.

Closed Quick schema uses Ticket canonical names `project,session,run_id,anchor_version,controlling_anchor_digest,authority_dependencies,intent_head,pending_anchor,protocol_hash,authorship,scope,candidate,review_cycle,review_sessions,review,integration,integration_authorization` plus Quick fields; parent/ticket-only fields forbidden. Quick IntegrationAuthorization uses epic_id=null + run_id/quick_task_id.

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
          authority_recovery -> recorded pre-failure step | human
~~~

Зависимости между Ticket-задачами выражаются autosk blockers.

### autosk-code-review

Отдельная child task с отдельным task ID и pinned snapshot workspace:

~~~text
review_candidate -> validate_verdict -> done
repair_protocol_snapshot -> recorded pre-failure step | human
authority_recovery -> recorded pre-failure step | emit_blocked_anchor
emit_blocked_anchor -> validate_verdict -> done
~~~

Parent Ticket блокируется review child и после разблокировки принимает только status=done плюс verdict binding текущего tree OID. Review child status=human продолжает блокировать parent и возобновляется отдельно; cancel или stale verdict снимают blocker, после чего review_join переводит parent в human.

Общая таблица Quick/Ticket review cycle:

| Текущий шаг | Условие | Следующий шаг |
| --- | --- | --- |
| Quick intake/implement/verify/fix/freeze/record_code_verdict/accept | schema-valid planned_trigger либо полная повторная classification нарушает любое Quick condition | invalidate_quick_classification; обычный success/integration исход исключён |
| Quick/Ticket implement/verify/fix/freeze/dispatch_review/review_join/record_code_verdict/commit_on_pass | current controlling_anchor_digest отличается от task/candidate binding | ensure pending_anchor; Ticket with parent -> rebuild_code_anchor handoff, standalone Quick -> rebuild_code_anchor; candidate/verdict/waiver void |
| invalidate_quick_classification | open handoff существует и binding совпадает | продолжить recorded phase без нового replacement/base |
| invalidate_quick_classification | trigger/project/original-base/worktree receipt invalid либо creation collision | human с park.reason=quick_classification_invalid; Quick commit/integrate запрещены |
| invalidate_quick_classification | binding валиден | phase=prepared atomically записывает только handoff op + commit/integrate prohibition; idempotent create/configure/enroll Planned replacement от original base; transfer/read-back worktree ownership receipt; затем одной atomic записью `superseded_by` + outcome=reclassified + phase=complete |
| implement | provider/model недоступен после retry | human с park.reason=implement_provider_unavailable |
| implement | model run завершился без valid completion record | human с park.reason=implementation_result_invalid |
| implement | обнаружена out-of-scope/unexpected mutation | human с park.reason=implementation_scope_invalid |
| implement | completion record, включая closed `planned_triggers`/`material_questions`, и declared scope валидны, Quick classification всё ещё valid, worktree не коммитился | verify |
| verify | runner/environment failure после retry | human с park.reason=verification_environment_failed |
| verify | evidence отсутствует, malformed или не привязан к candidate | human с park.reason=verification_record_invalid |
| verify | проверки нашли candidate defect и repair cycle ниже cap | сохранить verification findings, fix |
| verify | проверки нашли candidate defect и repair cycle достиг cap | human с park.reason=verification_cap |
| verify | evidence record валиден, проверки PASS и Quick classification всё ещё valid | freeze |
| freeze | scope/identity/tree mint невалидны или candidate изменился во время mint | human с park.reason=freeze_candidate_invalid |
| freeze | pending_anchor или anchor mismatch | atomically ensure pending_anchor(reason, identity), human с park.reason=blocked_anchor |
| freeze | review waiver candidate указан, но daemon signature/identity/scope/expiry невалидны | human с park.reason=review_waiver_invalid; reviewer child не создаётся |
| freeze | daemon-attributed review waiver exact current candidate identity валиден | record_code_verdict с disposition=waived; reviewer child не создаётся |
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
| record_code_verdict | disposition=verdict и повторная identity/binding validation не прошла | human с park.reason=code_verdict_invalid; ничего не записано |
| record_code_verdict | disposition=waived и waiver revalidation failed | human с park.reason=review_waiver_invalid; ничего не записано |
| record_code_verdict | disposition=waived, daemon review waiver current identity валиден, workflow=autosk-ticket | atomically review={status:waived,waiver_record_id,waiver_record_hash,waived_review_mode:full\|narrow,waived_review_reason}, full flags reset; commit_on_pass |
| record_code_verdict | disposition=waived, daemon review waiver current identity валиден, workflow=autosk-quick, classification valid, signed IntegrationAuthorizationRecord exact candidate валиден | atomically review={status:waived,waiver_record_id,waiver_record_hash,waived_review_mode:full\|narrow,waived_review_reason}, full flags reset; integrate |
| record_code_verdict | disposition=waived, daemon review waiver current identity валиден, workflow=autosk-quick, classification valid, integration authorization отсутствует/невалидна | atomically review={status:waived,waiver_record_id,waiver_record_hash,waived_review_mode:full\|narrow,waived_review_reason}, full flags reset; accept |
| record_code_verdict | NOT_PASS/findings и round >= cap | если full, atomically full_review_required=false/full_review_reason=null; human с review_cap |
| record_code_verdict | NOT_PASS/findings и round < cap | если full, atomically full_review_required=false/full_review_reason=null; fix |
| record_code_verdict | PASS и workflow=autosk-ticket | если full, atomically full_review_required=false/full_review_reason=null; commit_on_pass |
| record_code_verdict | PASS и workflow=autosk-quick, classification всё ещё valid, signed IntegrationAuthorizationRecord exact candidate валиден | если full, atomically full_review_required=false/full_review_reason=null; integrate |
| record_code_verdict | PASS и workflow=autosk-quick, classification всё ещё valid, integration authorization отсутствует или невалидна | если full, atomically full_review_required=false/full_review_reason=null; accept |
| fix | provider/model недоступен после retry | human с park.reason=fix_provider_unavailable; findings/candidate identity сохранены |
| fix | model run завершился без valid completion record | human с park.reason=fix_result_invalid; verify не запускается |
| fix | обнаружена out-of-scope/unexpected mutation | human с park.reason=fix_scope_invalid; mutation inventory сохранён |
| fix | confirmed review или verification findings исправлены | verify |
| record_editorial_exemption | pending_anchor появился после freeze | human с park.reason=blocked_anchor; exemption не записан |
| record_editorial_exemption | повторная deterministic проверка больше не editorial | сохранить full_review_required=true/full_review_reason=initial, dispatch_review |
| record_editorial_exemption | classification/identity/path set current, повторная проверка editorial, signed IntegrationAuthorizationRecord exact candidate валиден | atomically full flags reset + exemption record, integrate |
| record_editorial_exemption | classification/identity/path set current, повторная проверка editorial, integration authorization отсутствует/невалидна | atomically full flags reset + exemption record, accept |
| rebuild_code_anchor | parent_epic_task отсутствует (standalone Quick), pending anchor валиден | own anchor_version+1, clear pending_anchor, review_cycle.full_review_required=true/full_review_reason=anchor_rebuild, verify |
| rebuild_code_anchor | parent_epic_task задан, waiting_parent_anchor=false, correction обоснована | daemon appendIntentEvent под project mutex + intent-head commit, void Ticket review binding, receipt phase=event_appended, park human, затем exact unblock parent; Epic metadata не писать |
| complete_anchor_handoff | event hash/receipt валидны, Ticket human, parent edge ещё active | идемпотентно подтвердить human park, exact unblock parent, receipt phase=edge_suspended, park.reason=waiting_parent_anchor |
| repair_anchor_handoff | mode=receipt_only, raw event schema/hash валиден, bad receipt и parent edge active подтверждены | event не дублировать; atomically пометить bad Ticket receipt superseded_by, создать новый receipt для того же event; выполнить park→exact-unblock→final edge_suspended contract, Epic metadata не писать |
| repair_anchor_handoff | mode=supersede_event, daemon-attributed user record связывает bad raw comment/event hash и parent edge active подтверждён | append новый schema-valid event_id с exact `{supersedes_raw_comment_id,supersedes_raw_hash,user_decision_record_id,user_decision_record_hash}`, atomically пометить старый Ticket receipt superseded_by, создать новый event_appended receipt; выполнить park→exact-unblock→final edge_suspended contract, Epic metadata не писать |
| rebuild_code_anchor | waiting_parent_anchor=true, Ticket anchor=parent anchor, pending_anchor=null, matching parent_rebuild_receipt, exact edge восстановлен и pending resume_intent совпадает с parent op/target/anchor/receipt | atomically resume_intent.state=consumed, suspension receipt state=edge_restored, waiting_parent_anchor=false, park.reason=null, review_cycle.full_review_required=true/full_review_reason=anchor_rebuild, verify |
| rebuild_code_anchor | waiting_parent_anchor=false, resume_intent.state=consumed, suspension receipt state=edge_restored, matching parent receipt/op/anchor и review reason=anchor_rebuild | metadata уже committed; идемпотентно transit verify без повторного consume/bump |
| rebuild_code_anchor | waiting_parent_anchor=true, edge active, но resume_intent absent/mismatch | human с park.reason=anchor_resume_intent_invalid |
| rebuild_code_anchor | parent_epic_task задан, waiting_parent_anchor=false, Ticket anchor=parent anchor, pending_anchor=null, matching parent_rebuild_receipt записан parent, suspended receipt отсутствует | review_cycle.full_review_required=true/full_review_reason=anchor_rebuild, verify |
| commit_on_pass | Ticket или parent epic pending_anchor / anchor mismatch | atomically ensure pending_anchor(reason, identity), human с blocked_anchor |
| commit_on_pass | current tree не равен approved tree | human с park.reason=candidate_changed |
| commit_on_pass | private branch exact expected commit OID и parent/base/canonical recipe совпадают | восстановить commit metadata, ticket_done |
| commit_on_pass | private branch на recorded base, exact expected commit object создан и CAS success | записать expected commit OID/recipe hash, ticket_done |
| commit_on_pass | private branch на recorded base, CAS failed и ref всё ещё на base | human с park.reason=commit_cas_failed |
| commit_on_pass | private branch на любом другом OID, включая same approved tree с другим parent/recipe | human с park.reason=commit_foreign_movement |
| ticket_done | terminal | нет переходов |

Quick `integrate` prologue до любого чтения target ref или другого Git side effect заново запускает тот же closed classifier, что implement completion: normalized latest user request/instructions, project identity, original base, declared scope, actual changed paths/bytes, completion evidence, rules version и protected intent head. Это не чтение сохранённого `planned_triggers`. Новый trigger сначала выполняет `invalidate_quick_classification`; prepared handoff уже void'ит review/accept/waiver/integration authorization и запрещает Git reads, поэтому old Quick не продолжает.

Quick tail:

Эта таблица — единственная каноническая для Quick `integrate`; pending receipt безусловно разрешается раньше reclassification, authorization и handoff. Общая Quick/Ticket строка выше к integrate не применяется.

| Текущий шаг | Условие | Следующий шаг |
| --- | --- | --- |
| integrate | daemon integration operation receipt phase=pending/indeterminate | integration_recovery before Quick reclassification/auth check |
| accept | Quick classification invalid либо planned_trigger появился до integration | invalidate_quick_classification |
| accept | controlling digest mismatch | ensure pending_anchor, human с blocked_anchor; acceptance stale |
| accept | resume --to integrate, signed `IntegrationAuthorizationRecord` exact Quick run/candidate/target/base/single ref transition/tree/dependency digest current, Quick classification valid, pending_anchor отсутствует | integrate |
| integrate | до первого Git side effect Quick classification invalid либо появился planned_trigger | invalidate_quick_classification; target ref не читался/не менялся |
| integrate | controlling digest/pending_anchor/anchor mismatch | ensure pending_anchor, human с blocked_anchor |
| integrate | IntegrationAuthorizationRecord missing/mismatched/expired | accept statusStep("human"); target ref не читался/не менялся |
| integrate | daemon `integrateApproved(expected_relevant_authority_projection_hash,expected_dependency_head,expected_intent_head,expected_digest,authorization_id,target,expected_old,new_oid)` под project mutex вернул success | cleanup |
| integrate | precondition | human с integration_precondition |
| integrate | obstruction | human с integration_obstruction |
| integrate | foreign movement/indeterminate/reattach | integration_recovery или human по классификации |
| integration_recovery | pending receipt proves exact new OID | finalize daemon receipt/prefix, cleanup |
| integration_recovery | operation-bound reflog proves CAS never occurred, no movement after watermark, target=expected_old | mark not_applied, integrate |
| integration_recovery | target returned new→expected_old, reflog absent/ambiguous or post-watermark movement | human foreign/indeterminate; retry forbidden |
| integration_recovery | foreign/indeterminate сохраняется | human; cancel отдельной status-операцией |
| cleanup | dirty=false и sandbox removed/absent | done |
| cleanup | dirty=true при force=false | human с cleanup_dirty |
| done | terminal | нет переходов |

### autosk-panel-seat

Одна задача одного места панели:

~~~text
review_artifact -> validate_verdict -> done
repair_protocol_snapshot -> recorded pre-failure step | human
authority_recovery -> recorded pre-failure step | emit_blocked_anchor
emit_blocked_anchor -> validate_verdict -> done
~~~

Route, role и lens читаются из metadata. onTransit разрешает done только после появления verdict record правильной схемы и правильной artifact identity.

### autosk-contest-seat

Новая child task для каждого originating panel seat:

~~~text
review_disposition -> validate_disposition -> done
repair_protocol_snapshot -> recorded pre-failure step | human
authority_recovery -> recorded pre-failure step | emit_blocked_anchor
emit_blocked_anchor -> validate_disposition -> done
~~~

Identity включает artifact identity, canonical finding IDs, proposed rejection/downgrade и originating seat. Обычный panel PASS не является contest disposition.

### autosk-arena-candidate

~~~text
build_candidate -> verify_candidate -> freeze_candidate -> done
repair_protocol_snapshot -> recorded pre-failure step | human
authority_recovery -> recorded pre-failure step | emit_blocked_anchor
emit_blocked_anchor -> done
~~~

### autosk-arena-judge

Эта задача blocked_by кандидатскими задачами:

~~~text
judge -> validate_judgment -> done
repair_protocol_snapshot -> recorded pre-failure step | human
authority_recovery -> recorded pre-failure step | emit_blocked_anchor
emit_blocked_anchor -> validate_judgment -> done
~~~

### Исчерпывающий contract дочерних workflows

Panel seat, contest seat, code reviewer и Judge сами не вызывают transit и не пишут comments/evidence. Модель может только передать один payload закрытой схемы через `submit_gate_result`. После model run deterministic tail повторяет project/head guards. Recoverable journal failure идёт в common authority_recovery; current digest mismatch либо unrecoverable head failure вызывает host-owned `emit_blocked_anchor`, который пишет/read-back immutable `BLOCKED_ANCHOR` result текущей identity и завершает child через validate/done. Parent blocker снимается, join видит exact result и входит blocked_anchor. Для обычного payload tail записывает/read-back result и transits validate_*. Модель/submit tool записью не владеют; missing submit/provider failure также имеют явный transition.

Closed BLOCKED_ANCHOR result: `{reviewed_candidate_identity,expected_relevant_authority_projection_hash,expected_dependency_head,expected_intent_head,observed_binding,mismatch_reason,task_id,session_id,host_result_hash}`. Validate-step проверяет frozen candidate/task/session binding и exact mismatch proof; observed current identity не подменяет reviewed identity. Такой result никогда не считается PASS.

| Workflow / текущий шаг | Условие | Следующий шаг |
| --- | --- | --- |
| любой panel/contest/code-review/Arena model step | secure-head inconsistency классифицирован как recoverable | authority_recovery; success возвращает exact pre-failure step |
| любой panel/contest/code-review/Arena model step либо authority_recovery | current controlling/head binding mismatch или repair fail-closed | host `emit_blocked_anchor`: immutable BLOCKED_ANCHOR result current identity, затем соответствующий validate/done; child не остаётся human blocker |
| validate_verdict / validate_disposition / validate_judgment / arena blocked-result tail | schema/hash/current identity BLOCKED_ANCHOR record валиден | done; parent join consume'ит result и паркуется blocked_anchor |
| panel-seat review_artifact / code-review review_candidate | provider недоступен после retry | human с park.reason=gate_provider_unavailable |
| panel-seat review_artifact / code-review review_candidate | model run завершился без единственного valid submit | human с park.reason=gate_result_missing |
| panel-seat review_artifact / code-review review_candidate | host принял один schema-valid payload и записал/read-back record | validate_verdict |
| validate_verdict | record/session/identity/snapshot/store hashes валидны | done |
| validate_verdict | record malformed/stale/binding mismatch | human с park.reason=gate_result_invalid |
| validate_verdict | snapshot/immutable creation-session binding изменён либо обнаружена non-custody store mutation | human с park.reason=gate_snapshot_mutated; valid parallel sibling custody receipt не считается mutation |
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
      human-alignment.ts
      decision-classifier.ts
      material-decision-projector.ts
      user-decision-client.ts
      user-presence-signer.ts
      authority-recovery.ts
      project-policy.ts
      quick-reclassification.ts
      anchor-rebuild.ts
      artifact-identity.ts
      planning-ref.ts
      planning-publication.ts
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
      user-decision.ts
      alignment.ts
      material-decision-manifest.ts
      autonomous-policy.ts
      quick-handoff.ts
      planning-publication.ts
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

Other planning/governance documents do not add ArtifactKind. Versioned closed classifier evaluates every created/changed path with precedence `canonical_artifact -> governance_mapping_sidecar -> additional_normative -> ordinary_implementation -> unknown`. `additional_normative` is selected for documentation/diagram/spec/ADR/requirements/design/policy/governance surfaces or an escalated completion declaration; model output may escalate but never downgrade it. `ordinary_implementation` is selected only for declared implementation-scope source/config/schema/prompt/test/migration paths not claimed by a higher rule. Unknown document/governance paths fail closed; ordinary implementation continues code review without mapping.

Closed mapping record: `{path_hash,content_hash,path_role,target_kind,decision_id_refs,mapping_rule_version,mapping_payload_hash,proof_hash,status:current|stale}`. Text formats contain exactly one `autosk-governance-mapping` block. Non-embeddable bytes use `<path>.autosk-governance-mapping.json`, which binds exact target path/content hash and is classified as a sidecar only when its target exists and schema/hash match; otherwise it is orphaned and fails closed. Classifier/projector verifies target in the four-value enum, all refs current in named manifest and no unmapped normative section.

`governance_mapping_set_digest = SHA-256("autosk-flow/governance-mapping-set/v1" + canonical ordered current proof records)`; ordering is by normalized target path and the empty set has a fixed golden value. The digest is derived from the exact candidate tree and classifier version, stored in task-owned protected metadata, and enters artifact identity or code candidate identity directly, not `controlling_anchor_digest`. Every freeze, reviewer dispatch/join, record_artifact_pass/publish_artifact_pass/record_code_verdict, commit_on_pass and integration recomputes it; mismatch voids candidate/verdict before side effects.

В mode=planned classification fields `tech_plan` и `tickets` имеют schema const=true; optional только brief/core_flow. `tickets=false` делает metadata invalid и требует возврата в intake/Quick reclassification, поэтому select_next не имеет silent skip branch.

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
    "planning": {
      "epic_ref_key": "sha256",
      "ref": "refs/autosk/epics/<epic_ref_key>/planning",
      "base_oid": "...",
      "head_oid": "...",
      "head_tree_oid": "...",
      "generation": 0,
      "init_status": "verified",
      "init_operation": null,
      "publication_operation": null
    },
    "session": {
      "provider_session_id": "...",
      "provider_session_dir": "/absolute/project-root/.autosk/autosk-flow/provider-sessions",
      "provider_session_file": null,
      "generation": 1,
      "replaces": null
    },
    "anchor_version": 1,
    "controlling_anchor_digest": "...",
    "authority_dependencies": {
      "head_sequence": 1,
      "head_hash": "...",
      "projection_hash": "...",
      "current": []
    },
    "intent_head": {
      "sequence": 1,
      "head_hash": "..."
    },
    "pending_anchor": null,
    "anchor_impact": null,
    "anchor_rebuild_op": null,
    "ticket_repair_op": null,
    "aggregate_remediation": null,
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
    "alignment_policy": {
      "policy_id": "policy-001",
      "project_policy_record_id": "policy-001",
      "issuance_record_id": "udr-policy-001",
      "expected_policy_hash": "..."
    },
    "current_alignment": null,
    "alignment_records": {
      "brief": {
        "schema": 1,
        "kind": "brief",
        "status": "valid",
        "source": "user_decision",
        "user_decision_record_id": "udr-brief-001",
        "user_decision_record_hash": "...",
        "actor_provenance_hash": "...",
        "decision_mirror_ref": "docs/autosk/epics/epic-001/decision-log.md#brief-framing",
        "decision_mirror_hash": "...",
        "subject_record_ref": "docs/autosk/epics/epic-001/decision-log.md#brief-framing-packet",
        "material_decision_manifest_ref": "docs/autosk/epics/epic-001/decision-log.md#brief-material-decisions",
        "material_decision_manifest_hash": "...",
        "answer_hashes": {},
        "classifier": {
          "version": 1,
          "hash": "...",
          "rule_ids": ["brief.goal.material"],
          "inputs_hash": "..."
        },
        "projector": {
          "version": 1,
          "hash": "...",
          "inputs_hash": "..."
        },
        "subject_hash": "...",
        "scope_hash": "...",
        "anchor_version": 1,
        "policy_hash": null,
        "approval_identity": "...",
        "created_at": "2026-08-31T00:00:00Z",
        "stale_reason": null
      },
      "core_flow": null,
      "tech_plan": null,
      "tickets": null
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
    "integration_authorization": null,
    "waivers": {
      "panel": null,
      "review": null
    }
  }
}
~~~

`current_alignment` хранит non-normative proposal: `kind`, `scope_hash`, `subject_record_ref/hash`, canonical `material_decision_manifest_ref/hash`, hash полного user-visible представления, classifier proof `{version,hash,rule_ids,inputs_hash,derived_classes}` и projector proof `{version,hash,inputs_hash}`. Модель может добавить reported classes/reasoning, но они не участвуют в разрешении. Ref восстанавливает exact proposal bytes после restart. Закрытая schema зависит от kind:

- Brief: goal, expected outcome, affected parties, why, scope, non-goals, success criterion, open questions и full framing material manifest;
- Core Flow: actions, visible states, happy/unhappy paths, errors, retry, cancel, partial success, actor rights, system reactions и full behavior material manifest;
- Tech Plan: open questions, materially different implementations, silent inferences, closed/planned decisions и full technical material manifest;
- Tickets: canonical tickets manifest, user-visible breakdown bytes, ordered canonical ticket file hashes, dependency graph, per-Ticket scope/outcome, execution order/parallelism и exclusions.

`UserDecisionRecord` имеет закрытую daemon-owned схему `{schema,record_id,project_root_sha256,actor:user,request_id,epic_id?,task_id?,anchor_version,subject_hash,payload_hash,signed_challenge_canonical_b64,signed_challenge_hash,challenge_nonce_hash,challenge_expires_at,signer_public_key_id,signature,journal_sequence,previous_record_hash,previous_secure_head_hash,issued_at,target_record_id?,terminal_disposition?}`. Decoded bytes byte-exact equal canonical object `{project_root_sha256,record_id,nonce,expires_at,request_id,epic_id,task_id,anchor_version,subject_hash,payload_hash,previous_secure_head_hash,journal_sequence}`; epic_id/task_id keys always present string|null, omission/alias forbidden. Signature = domain separator + bytes. Daemon commits nonce+head before projection/effects; restart verifies stored bytes.

Rollback-resistant authority/nonce/integration-authorization, workflow-scope dependency/intent and task-keyed metadata/result heads contain only hashes/counters. Quick uses `scope_id=quick:<task-id>`. Direct file edit cannot advance heads.

Project policy record имеет закрытую схему `{schema,policy_id,binding_level,project_root_sha256,epic_id?,run_id?,artifact_kinds,allowed_rule_ids,allowed_decision_classes,scope_hash,constraints_hash,issuance_record_id,policy_hash,expires_at}`. Issuance и каждый revoke/replace — отдельные `UserDecisionRecord`; project-level daemon projection детерминированно выводит current `active|revoked|expired|replaced`. `binding_level=project` требует null Epic/run, `binding_level=run` — exact Epic/run. Epic metadata хранит только ref/expected hash и при каждом gate перечитывает projection, поэтому старый cache не переживает revoke.

`approval_identity` — SHA-256 domain-separated canonical JSON из `project_root_sha256`, `epic_id`, `kind`, `anchor_version`, `scope_hash`, `subject_hash`, material manifest hash, user decision record ID/hash/provenance, classifier/projector version+hash+inputs, current policy issuance+terminal-disposition hashes либо null и `protocol.hash`. Само поле identity в preimage не входит. `answer_hashes` — ordered map exact payload fields из daemon record.

Alignment record content write-once. Source enum закрыт: `user_decision|project_policy`. Единственные последующие dispositions — монотонные `valid -> stale|void`; прежние authority/mirror hashes сохраняются. Смена answer, proposal/manifest, classifier/projector proof, scope, anchor, current policy disposition/expiry или protocol делает record stale. Новый record не ссылается на старую anchor version. `record_alignment` пишет source=project_policy только при current policy binding и classifier-proven allowed rules.

Обычные локальные, обратимые и нематериальные implementation choices не добавляются в packet и не требуют ни user decision, ни policy. Autonomous policy — отдельное разрешение только для заранее перечисленного ограниченного класса material questions, а не panel/review waiver или integration authorization. `policy_hash` исключает собственное поле и terminal dispositions. Модель не может назначить rule/class, расширить kinds/rules/classes/scope/constraints/expiry или снять revoke. Forbidden product/UX, architecture/one-way-door, security/privacy/data, destructive, delivery/release, scope-reduction, waiver и integration rules имеют приоритет; всё не доказанное deterministic classifier'ом идёт пользователю.

`waivers.panel` и `waivers.review` — null либо references на signed daemon record exact identity; boolean/comment и project policy недействительны. Panel waiver payload имеет closed `mode=full_skip|reduced_roster` и actual roster для второго; consumer принимает только свой mode. Review waiver всегда exact full-skip current tree, а resulting disposition сохраняет `waived_review_mode=full|narrow` и исходный reason. Каждый consumer перечитывает authority непосредственно перед side effect.

`integration_authorization` — daemon-owned signed record stored at `.autosk/autosk-flow/integration-authorizations/<scope-id>/<record-id>.json`, chained under protected `integration_authorization_head`: `{schema,record_id,scope_id,project_root_sha256,epic_id|null,quick_task_id?,run_id,target_ref,initial_target_oid,completed_prefix_receipt_hash?,remaining_start_index,ordered_ticket_commit_oids,ordered_ref_transitions,final_tree_oid,integration_plan_hash,relevant_authority_projection_hash,dependency_head_hash,intent_head_hash,controlling_anchor_digest,classifier_proof_hash,expires_at,terminal_disposition,previous_authorization_head_hash,user_decision_record_id,user_decision_record_hash}`. Autoskd resolves by scope+ID and verifies file/head/expiry/revoke/replace. Missing/changed bytes restore only exact committed record or return integration_authorization_required. integration-state stores operation state only.

`artifact_pass[kind]` — historical field name с closed `disposition=pass|waived`: обе ветви связывают current artifact/alignment identity, но первая содержит verdict hash/roster, вторая — signed waiver record ID/hash и никогда не называется model PASS. Обе сначала имеют `publication_status=recorded_unpublished`; kind не completed. Только matching `planning_publication_op` phase=verified добавляет `published_commit_oid`, `publication_operation_id` и status=verified after exact live-ref read-back. Code review аналогично хранит `status=pass|waived` с взаимоисключающими verdict/waiver bindings, но не использует planning publication.

`anchor_impact` — staged proposal, а не свободный user map: `{proposal_id,from_anchor_version,pending_anchor_hash,correction_watermark,status_snapshot_hash,cascade_rules_hash,planning_dispositions,ticket_dispositions,proposal_hash,status:proposed|approved|stale,approval_record_id?,approval_record_hash?}`. `prepare_anchor_impact` единолично пишет proposed map без rebuild side effects. Trusted client подписывает exact proposal hash; `record_anchor_impact_approval` проверяет signature/current snapshot и atomically ставит approved + authority hashes. Любая новая correction/status/hash change делает proposal stale и требует нового prepare/approval.

`anchor_rebuild_op` хранит закрытый `source=planning|code_only|arena|no_bindings`, `op_id`, consumed correction event IDs/watermark, pre-resume Epic/Ticket hashes, `from_version`, `to_version`, immutable dispositions каждого Ticket, stable topological order human recovery set/dependency plan, per-ticket phase (`prepared | replacement_ready | edge_restored | child_resumed | replacement_enrolled | superseded`), общую phase (`prepared | anchor_committed | ready_to_transit | resuming_children | ready_to_join`), recorded target и expected identity. Только source=code_only может иметь target=`resume_repaired_tickets`; остальные закрываются prologue своего planning/Arena/join target. Наличие открытой операции имеет приоритет над обычными guard-строками `rebuild_anchor`.

`ticket_repair_op` source=fresh|current|planning|aggregate_unchanged. Aggregate source binds failure evidence + repair map and forbids complete_old for affected Tickets; fresh verify/review/commit required. Before mutation op stores exact set/dependency map/phases. Resume/enroll/block remain authority-guarded.

`aggregate_remediation` durable op: `{creation_key,creation_binding_hash,old_ticket_set_digest,failure_evidence_hash,phase,choice,recorded_target?,unchanged_repair_map_hash?,fix_scope_hash?,new_ticket_set_digest?,choice_record_id?,choice_record_hash?}`. Closed phase always stores target for crash retry. Unchanged repair map forces fresh affected code candidates; set-changing phases void approval before new proposal.

`correction_dispositions` не редактирует comments и не превращается во второй inbox. Это parent-owned terminal map только для raw records, которые не могут пройти schema/hash validation: exact raw comment id/hash получает единственный status=`superseded`, ссылку на более поздний schema-valid event и daemon `UserDecisionRecord` ID/hash. Watermark может пройти invalid raw record только в той же атомарной записи disposition; mismatch raw/authority identity снова блокирует gate.

Epic `autosk_flow` metadata имеет единственного writer — parent deterministic steps. Модели и Tickets публикуют untrusted/schema-checked correction events в append-only comments; trusted client сначала создаёт `UserDecisionRecord`, затем event может ссылаться на его ID/hash. Comment без authority record не получает actor=user semantics. Событие после consumed watermark не конкурирует с metadata write и будет обработано следующим parent gate. Parent завершает все semantic anchor/binding writes до первого Ticket resume; после него пишет только монотонные active repair-op phases и закрывает op в `ticket_join` prologue.

Authority dependency history is an append-only daemon journal, not mutable Epic metadata. Each record is `add` or `supersede` with Epic/current-anchor binding and previous dependency head. `supersede(old,new)` requires exact current signed authority/re-bind, advances protected head and forces old candidate/PASS/alignment/integration authorization stale before new bindings. Current dependency projection contains only unsuperseded records; history remains audit evidence. Revoked current dependency blocks until re-alignment/supersede; revoked historical dependency cannot satisfy a guard and does not deadlock a new exact binding.

`controlling_anchor_digest` = canonical hash protected dependency head + current projection/terminal dispositions + four alignment/material-manifest/classifier/projector bindings + protected Epic intent head/consumed watermark + anchor version + protocol. Authority record bytes first reconcile against authority head; only current Epic dependencies enter the digest, so unrelated project decisions do not stale it. Metadata projection/head mismatch fails closed. Ticket dispatch copies all head hashes/digest into task/candidate/verdict/commit; mismatch aborts live sessions and routes to rebuild.

`authorityGuard(expected_relevant_authority_projection_hash,expected_dependency_head,expected_intent_head,expected_digest)` — daemon connection-bound project mutex. Daemon reconciles global authority head for integrity, then compares only relevant current projection + Epic heads. Competing appends wait; resume/enroll/block accept token. `integrateApproved` uses same mutex and CAS. Unrelated project authority append therefore does not stale an Epic after re-resolution.

Workflow custody exposes `mutateAutoskFlow(own_step_capability,expected_head,patch)`, `orchestrateChildBatch(parent_step_capability,op_id,[{child_id,expected_head,allowed_patch}])` and `appendGateResult`. Batch capability is daemon-minted only for current parent repair/dispatch step, binds exact child creation identities/heads/closed patch schema, single-use, and records monotonic per-child receipts. It never impersonates a child workflow step. WorkAgent has no raw shell/.autosk/CLI.

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
    "run_id": "run-001",
    "session": {
      "provider_session_id": "...",
      "provider_session_dir": "/absolute/project-root/.autosk/autosk-flow/provider-sessions",
      "provider_session_file": null,
      "generation": 1,
      "replaces": null
    },
    "ticket_artifact": "docs/autosk/epics/epic-001/tickets/T01.md",
    "anchor_version": 1,
    "controlling_anchor_digest": "...",
    "authority_dependencies": {
      "head_sequence": 1,
      "head_hash": "...",
      "projection_hash": "...",
      "current": []
    },
    "intent_head": {"sequence": 1, "head_hash": "..."},
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
      "snapshot_commit": "...",
      "governance_mapping_set_digest": "...",
      "controlling_anchor_digest": "..."
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
      "gate_result_receipt_id": "...",
      "gate_result_receipt_hash": "...",
      "result_head_hash": "...",
      "controlling_anchor_digest": "...",
      "status": "pass"
    },
    "integration_authorization": null,
    "integration": null
  }
}
~~~

`parent_rebuild_receipt` — записываемое только родительским deterministic step доказательство `{op_id, parent_task_id, ticket_task_id, from_version, to_version, disposition}`. Для affected Ticket оно связывает поглощённый `pending_anchor` с конкретной перестройкой родителя. Старый receipt не проходит guard после следующего изменения версии.

`resume_intent` — parent-written recovery record `{op_id, target, anchor_version, receipt_hash, state}`. Parent одной атомарной pre-edge записью устанавливает `state=pending` и `park.reason=anchor_resume_pending`, перечитывает оба поля, после чего больше не пишет Ticket metadata. Только `rebuild_code_anchor` той же Ticket может атомарно изменить state на `consumed` вместе с очисткой waiting flag/park reason и нормализацией suspension receipt. Intent сохраняется до закрытия repair op/cleanup и позволяет отличить crash до resume от уже начатого child workflow без last-write-wins между двумя writers.

Receipt приостановленной blocker-связи содержит `{parent_task_id,ticket_task_id,blocker_id,blocked_id,ticket_artifact,ticket_hash,base_oid,state}`. `dispatch_ticket_dag` reuse'ит human task только при expected recovery metadata, exact path/hash bytes из current Tickets pass-or-waived binding и execution base; dependency prerequisite classified replacement каскадно делает downstream human replacements. Scope/pathspec/dependency plan reissue происходят только по recorded op. Done/cancel/new/missing или changed Ticket/base получают configured-not-enrolled replacement; live work не отменяется.

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

### Quick reclassification

Quick classification identity включает normalized request, project, original base, declared scope и closed rules version. `implement` completion и каждый следующий deterministic gate обязаны повторно вычислить её и принять closed `planned_triggers`: behavior/API/schema/security/concurrency/migration, material question, expensive ambiguity или material scope expansion. Модель может сообщить trigger, но не может его очистить; deterministic rules также выводят trigger из changed paths, completion/evidence и новых user instructions.

`invalidate_quick_classification` — idempotent deterministic step. Он создаёт durable handoff с project/original-base/trigger/worktree receipt и daemon-owned creation key, atomically запрещает Quick commit/integration, затем создаёт и enroll'ит `autosk-planned` replacement от original base. Уже изменённый worktree получает immutable inventory/hash и exact ownership-transfer receipt в evidence-retention set replacement; он сохраняется как untrusted evidence и не становится planning/code candidate без будущих gates. Только после read-back replacement + ownership receipt старый Quick получает `superseded_by` и terminal outcome=`reclassified`; это не PASS. Crash retry продолжает ту же phase и не создаёт второй Epic. Если handoff нельзя доказать, Quick остаётся human с `quick_classification_invalid` и запрещёнными commit/integration.

`implementation_scope_invalid` может продолжить Quick только после повторной классификации exact expanded scope. Любой Planned-trigger выбирает reclassification, а не «user расширил scope» внутри Quick. Общий Artifact Registry здесь не создаётся: это переход только между двумя существующими режимами.

### Human alignment и readiness

`clarify_alignment` компилирует закрытый packet текущего ArtifactKind и показывает все материальные вопросы без предлагаемого «ответа по умолчанию». Versioned deterministic classifier сам выводит `decision_classes` и `rule_ids` из закрытых kind-specific fields. Model labels — только untrusted input; forbidden rules имеют приоритет, а unknown/ambiguous classification fail-closed ведёт в `await_alignment`. Classifier version/hash, rule IDs и inputs hash входят в subject/approval identity.

До approval deterministic projector строит canonical `material_decision_manifest` из structured proposal: stable decision IDs, kind-specific field path, normalized choice/constraint, affected actors/contracts/data/security/delivery, reversibility proof ref и classifier rule. Artifact schema требует ровно один fenced `autosk-material-decisions` JSON block; behavior-defining sections содержат только refs на known decision IDs. Prompt compiler и Ticket trace читают material authority только из этого block. Unreferenced prose non-normative и не переносится в implementation prompt. После draft/Arena/fix projector парсит exact block+refs: missing/new/changed/unknown ID, duplicate block, unmapped normative section или classifier drift atomically stales alignment до freeze. Лишь byte-identical manifest либо classifier-proven local/non-material entry проходят.

Classifier precedence закрыт: Brief goal/scope/success и Core Flow user-visible behavior/rights/errors всегда `human_required`; Tech Plan public API/data/security/privacy/one-way-door/migration/delivery fields всегда `human_required`; Tickets set/scope/outcome/dependency/exclusion changes всегда `human_required`. Только Tech Plan internal choice с machine-checkable rollback/reversibility proof и без перечисленных affected fields либо Tickets scheduling при byte-identical set/scope/outcome/dependencies/exclusions может получить `local_reversible_implementation`. Любое отсутствующее proof, неизвестное поле или конфликт правил даёт `unknown -> human`, даже если модель сообщила allowed label.

`await_alignment` — human status step. Signer/secure store runs in mandatory separate OS security boundary or hardware enclave. Model sandbox lacks signer RPC, keychain, accessibility and ptrace entitlement; boundary preflight actively probes and blocks unsupported deployment. Client only signs exact challenge; daemon journals/head-commits before actor=user. Headless/no boundary remains human.

`record_alignment` — deterministic step. До записи он:

1. перечитывает canonical project/Epic/anchor, proposal subject/scope/material-manifest и classifier/projector hashes;
2. разрешает exact daemon record, проверяет actor=user, signature/pinned key/nonce/expiry/journal-chain/identity и optional Git mirror hash; model-authored Git/comment bytes отклоняет;
3. запускает deterministic decision classifier и отклоняет model self-approval, assumption, unknown/ambiguous/forbidden class и любое расширение policy;
4. для source=project_policy перечитывает единую project-level daemon projection, issuance/revocation chain, expiry и hash; Epic cache сам по себе не принимается;
5. вычисляет domain-separated `approval_identity`, записывает record атомарно и перечитывает его;
6. включает user record/provenance, mirror hash, classifier proof и re-resolved policy status в controlling anchor pack;
7. только после этого разрешает draft для Brief/Core Flow/Tech Plan или freeze для уже показанного Tickets proposal.

Correction во время `await_alignment` сначала проходит `consumeAnchorCorrections`. Если она меняет answer record, packet, classifier input/version, scope или current policy status, parent создаёт pending anchor impact, следующая версия помечает старый record stale и снова входит в `clarify_alignment` либо `present_tickets_breakdown`. Affected candidate/verdict/PASS bindings void; unchanged re-binding разрешён только existing daemon-attributed human impact contract.

Issue #4 задаёт только четыре named gates, approval/provenance primitive и anchor hook. Generic Artifact Registry принадлежит #14, HumanDecisionRequest queue/UI/status — #35, а полный revision propagation на уже реализованные Tickets — #25. Минимальный trusted-client write path нужен до #35, но не включает list/show/status UI.

Quick workflow не регистрирует alignment steps. Если на intake либо позже обнаружен material question/Planned-trigger, он проходит `invalidate_quick_classification`; уже сделанные bytes остаются untrusted evidence, а Planned replacement начинает с original base.

Перед каждым authority consumer daemon reconciles project journal/projection against secure heads. `authority_recovery` не принимает короткий committed prefix как truth: exact missing committed records восстанавливаются из durable backup. Valid crash-tail CAS-forward'ится; invalid/replayed/non-contiguous uncommitted suffix quarantine'ится и отсекается до secure head. Lost-key/destructive reset требует user-presence decision, создаёт новую project authority generation и void'ит all prior approvals; обычный resume запрещён.

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
8. перед model launch и каждым tool/process/fs adapter call reconciles secure heads, re-resolves полный authority dependency set и controlling_anchor_digest; mismatch прерывает stale live run без daemon-authored Epic comment, bytes остаются untrusted;
9. проксирует onSteer, onFollowup и onAbort текущему inner agent.

Author/implementer запускается через WorkAgent: custom worktree fs/test adapters only, no raw shell, arbitrary autosk CLI, canonical-root `.autosk`, task/comment/metadata or refs. Model returns submit_work_result; host with custody capability performs state transition.

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

Использовать ctx.exec с autosk CLI после появления обязательного upstream creation-key primitive; полный TasksAPI write surface не требуется:

- передать canonical project root каждой CLI/RPC операции и проверить project binding в прочитанной task view;
- вычислить exact deterministic `creation_key = autosk-flow/v1/<project_root_sha256>/<parent-id>/<run-id>/<seat-or-type>` и `creation_binding_hash = SHA-256(canonical project/parent/run/type/artifact/session/workflow-target binding)`; для Quick Planned replacement binding дополнительно включает handoff op ID и hash current intent/candidate/review/accept/waiver/integration state, поэтому retry не создаёт другую replacement и не оставляет old Quick live;
- вызвать create без workflow через `autosk create --creation-key <key> --creation-binding-hash <sha256>`; daemon atomically persists оба write-once поля вместе с task, возвращает existing только при совпадении пары или conflict при hash mismatch;
- metadata set, включая обязательный собственный autosk_flow.session record из правильного role registry для любой model-owned task;
- при необходимости подготовить branch/worktree от точного snapshot/base;
- enroll после полной настройки;
- block parent только после готовности всего набора;
- для anchor repair снять ровно edge `autosk unblock <parent-id> <ticket-id>`, сохранив receipt; `--all` запрещён;
- при восстановлении сначала записать/read-back child resume_intent, затем вернуть ровно его edge командой `autosk block <parent-id> <ticket-id>` и только после этого выполнить `autosk resume <ticket-id> --to rebuild_code_anchor`; `--all` и resume без matching intent запрещены.

Каждая операция проверяет exit code и перечитывает task view с daemon-owned creation_key+binding hash. Daemon сериализует одинаковый key под project-level lock и обеспечивает ровно одну task без отдельного index/ledger; title/description и human-editable metadata в recovery lookup не участвуют. Retry переиспользует existing child только при совпадении пары даже после rename до metadata set. Key с другим binding hash возвращает conflict и паркует dispatch; task никогда не enroll до полной metadata/session/sandbox проверки. Recovery sweep закрывает только собственные `new` tasks с валидной парой и незавершённой metadata; произвольные tasks без неё не трогает. Совпавший run_id другого проекта не совпадает из-за project hash.

Эти команды являются доступными autosk CLI-операциями, а не действиями модели. Pinned source proof `wierdbytes/autosk@5163f00`: `cmd/autosk/create.go` оставляет status=new без workflow; `cmd/autosk/enroll.go` делает new->work; `cmd/autosk/block.go` реализует exact block/unblock; `cmd/autosk/resume.go` — resume --to. `daemon/core/src/engine/session.ts`, `SessionRuntime.transit/commitTransit`, commit'ит task position первой записью, затем transcript/session done и возвращает Promise в продолжающийся `onRun`; `onRunSettled` видит `transited=true`. Поэтому `await ctx.transit(human)` гарантирует durable park до следующей строки, а crash до subsequent unblock оставляет parent blocked.

Preflight во временном проекте обязан доказать dormant create, configure-before-run, enroll new->work, rename retry, exact block/unblock, resume --to и continuation ordering: test step делает `await transit(human)`, перечитывает status=human, затем пишет marker/unblock; crash injection между commitTransit и marker оставляет blocker active. Drift останавливает запуск.

Resume intent записывается до blocker. Crash до edge оставляет parent runnable и retry продолжает op. Crash после edge, но до resume оставляет parent blocked и child human с park.reason=anchor_resume_pending и exact target; пользователь возобновляет именно child, который валидирует intent и очищает его на входе. После normal resume child владеет прогрессом, а terminal blocker снова открывает parent. Только после обработки всех Tickets parent transits `ticket_join`, чей prologue закрывает op. Редкое crash-окно требует явного child resume, но не создаёт неразрешимой блокировки и не зависит от числа workers.

Все operational side effects выполняет deterministic host с custody capability `{task_id,workflow,step,expected_metadata_head}`. Daemon CAS-двигает protected metadata head и отклоняет wrong task/step/stale writer; model token/CLI не получает.

### Contest и anchor changes

После synthesis любое предложенное отклонение или снижение серьёзности finding создаёт contest child task каждому originating seat. Parent блокируется ими и не переходит к fix/PASS до валидных dispositions.

Новая пользовательская инструкция, Decision Log change или Ticket/verdict signal не пишет Epic metadata. Источник вызывает daemon `appendIntentEvent`; под project mutex daemon append'ит normalized event/comment, CAS-двигает Epic intent head и только затем возвращает success. Event schema содержит source/anchor/affected identity/payload/superseder authority. Parent merge'ит head-bound events в pending_anchor. Direct comment-file mutation не двигает head; late append invalidates any older guard token.

Ticket correction соблюдает порядок: append accepted event → atomically park Ticket human/waiting с receipt → только затем exact unblock parent. Crash до park/unblock оставляет parent blocked, а Ticket recovery повторяет тот же event_id. `BLOCKED_ANCHOR` verdict проходит тот же event path. Редактирование comment после принятия не меняет event, потому gate связан с принятым record hash.

`prepare_anchor_impact` выполняет read-only first pass: consume correction inbox, инвентаризирует каждый planning PASS/current kind/Ticket binding+status, применяет pinned cascade rules и пишет immutable proposed map/hash/status snapshot. Он не bump'ит anchor, не меняет PASS/Ticket и не создаёт repair op. `await_anchor_impact_approval` показывает exact map; trusted client подписывает proposal hash. `record_anchor_impact_approval` — единственный writer approved disposition. Новая correction либо status/hash drift делает proposal stale.

Явный deterministic AgentDefinition step rebuild_anchor:

1. если `anchor_rebuild_op` уже открыт, проверяет его task/from/to binding и продолжает только записанную phase и per-ticket dispositions; `pending_anchor` повторно не требуется, текущие Ticket status не переклассифицируют уже назначенные действия;
2. для новой операции требует staged `anchor_impact.status=approved`, signed daemon record exact proposal hash/current identity и отсутствие живых review children; missing approval паркует без side effects;
3. перечитывает каждый planning PASS/current kind/Ticket binding+status и требует byte-identical proposal status snapshot/correction watermark; drift помечает proposal stale и возвращает prepare_anchor_impact без переклассификации;
4. проверяет pinned cascade rules hash и map: in-flight kind без current PASS affected; downstream не unaffected_rebind после affected brief -> core_flow -> tech_plan -> tickets -> Ticket code;
5. для unaffected_rebind повторно проверяет неизменность bytes/tree и alignment subject/authority/classifier/current-policy hashes против approved proposal и готовит binding новой anchor_version;
6. при неполной карте, нарушенном cascade, изменившемся claimed-unaffected hash или human Ticket вне двух допустимых pre-rebuild recovery states ничего не меняет и паркует anchor_impact_invalid; при любом Ticket expected execution set status=work ничего не меняет, сохраняет pending_anchor и паркует anchor_repair_ticket_live;
7. один раз создаёт idempotent anchor_rebuild_op с from_version, to_version=from+1, dispositions и phase; retry продолжает тот же to_version и никогда не bump'ит второй раз;
8. только после того как все expected Tickets human/done/cancel/new/missing, идемпотентно пишет их anchor_version=to_version: unaffected parked/done re-bind'ит code/commit binding; affected human Ticket очищает только source pending, получает parent_rebuild_receipt/full_review_required; done/cancel/new/missing получает replacement phases и superseded_by. Parent никогда не пишет metadata status=work Ticket; несовпадение с записанным pre-resume state паркует anchor_impact_invalid;
9. как единственный Epic metadata writer устанавливает anchor_version=to_version, re-bind'ит unchanged planning PASS/alignment records, void'ит active/affected PASS и alignment bindings, очищает обработанный pending_anchor, сохраняет consumed correction watermark и переводит op в `anchor_committed`; events после watermark остаются в comments, op не закрывается;
10. если affected planning kinds не пусты, сохраняет repair map с ticket_artifact/hash/base, выбирает earliest affected kind, ставит full panel required и записывает target=`clarify_alignment`; для already-drafted affected Tickets target=`present_tickets_breakdown`. Future dispatch_ticket_dag разрешит receipts только по строгому совпадению или superseded cleanup;
11. если affected лишь Ticket code bindings, выполняет все semantic anchor/binding writes и доводит replacements только до create/configure `replacement_ready`; enroll, dependency blockers и parent blockers запрещены до `child_resumed` всех recorded human Tickets; затем target=`resume_repaired_tickets`;
12. если affected bindings пусты, active Arena run void и target=`dispatch_arena`; иначе target=`select_next` либо `ticket_join` по записанной phase;
13. после всех side effects повторно проверяет receipts, отсутствие premature replacement blockers и то, что parent остаётся runnable, затем атомарно ставит `phase=ready_to_transit` и recorded target;
14. retry с `ready_to_transit` не требует pending_anchor и вызывает только тот же `ctx.transit(recorded_target)`;
15. каждый target проверяет actual target/anchor/version. `resume_repaired_tickets` reconciles global authority journal + relevant projection/dependency/intent heads, then under `authorityGuard(expected_relevant_authority_projection_hash,expected_dependency_head,expected_intent_head,expected_digest)` continues phases; ticket_join closes op. Crash resumes under new exact guard;
16. интеграция запрещена до нового PASS всех affected Tickets; новая identity идёт только в полную соответствующую panel/code-review gate.

Ticket anchor_version — производная копия parent Epic anchor, не самостоятельный счётчик. rebuild_code_anchor:

- для standalone Quick без parent_epic_task увеличивает собственный anchor и требует full Code Review;
- для Ticket вызывает daemon appendIntentEvent (comment + intent-head commit), но не пишет Epic metadata; в собственной Ticket metadata void'ит review binding, ставит waiting_parent_anchor=true и сохраняет receipt временного удаления blocker edge parent<-Ticket;
- Ticket остаётся human, но suspension позволяет parent в итоге дойти до ticket_join и blocked_anchor/rebuild_anchor;
- parent rebuild_anchor обновляет только human/terminal Ticket metadata до единого to_version и оставляет affected human Tickets matching parent_rebuild_receipt; любой live work Ticket, включая claimed-unaffected, останавливает операцию до writes. При code-only mixed impact replacements для done/cancel/new/missing доводятся только до `replacement_ready`. `resume_repaired_tickets` после dependency recheck под authority guard выполняет intent→edge→resume, затем enroll/block; ticket_join prologue закрывает op. При planning impact future dispatch_ticket_dag создаёт отдельный ticket_repair_op и применяет тот же порядок;
- commit_on_pass и ticket_join требуют равенства Ticket anchor_version parent Epic anchor_version.

Удаление blocker без suspension receipt или потеря обратного восстановления — blocking error.

### Structured verdict

Gate model возвращает JSON только через `submit_gate_result`. Host валидирует envelope и через workflow-custody capability append'ит daemon write-once result receipt в protected result journal, затем read-back receipt/head и transits validate-step. Task metadata хранит только receipt ref; join перечитывает daemon receipt. validate проверяет:

- schema version;
- artifact/candidate identity;
- task/session/role;
- severity и уникальные finding IDs;
- evidence pointer;
- итог PASS, NOT_PASS или BLOCKED_ANCHOR;
- отсутствие неизвестных полей, меняющих смысл.

Editable comment/transcript/evidence bytes не являются verdict source. Receipt связывает project, child task, session, role, frozen identity, outcome, payload hash, journal sequence/previous result head и daemon provenance.

### Record artifact PASS и Arena markers

record_artifact_pass — deterministic AgentDefinition step, а не onTransit hook. Он:

1. повторно проверяет artifact/alignment identity и anchor; для disposition=pass — каждый daemon gate-result receipt/protected head + roster binding, для disposition=waived — signed daemon waiver exact identity. Metadata/comment/transcript hash без receipt отклоняется;
2. для kind=tech_plan до любых записей извлекает не свободный текст, а единственный fenced JSON block autosk-arena с ordered decisions array и уникальными decision_id;
3. отсутствие блока допустимо только когда arena.decisions пуст; иначе это удаление terminal history и arena_contract_invalid;
4. новый decision_id допускается только со status=pending и rubric 3–6 критериев;
5. каждый уже известный pending decision может остаться pending; `apply_arena_decision` единолично создаёт transient metadata status=recommended, а только `record_alignment` с user/exact-policy approval переводит его в applied/fallback;
6. каждый terminal decision_id обязан присутствовать ровно с тем же status и Decision Record binding; отсутствие, pending, applied↔fallback или другой record паркуют arena_contract_invalid;
7. после полной валидации одной атомарной операцией записывает artifact_pass[current_artifact.kind] с closed `disposition=pass|waived`, identity и ровно verdict hash либо waiver record ID/hash; merge-only обновляет arena.decisions только нормативными `status`, `rubric_hash`, `decision_record`; sessions/terminal bindings из блока не заменяются;
8. только после успешной атомарной записи переходит в select_next.

Разрешённые metadata status каждого entry: pending, recommended, applied, fallback. `recommended` — transient host-owned status и не допускается в нормативном autosk-arena block: он блокирует draft до `record_alignment`. Только `record_alignment` добавляет Decision Record reference и делает status applied/fallback. Terminal status для decision_id неизменяем; новая спорная развилка получает новый decision_id и отдельную полную панель.

record_code_verdict выполняет аналогичную повторную валидацию code identity, включая recomputed `governance_mapping_set_digest`. Для disposition=verdict он требует session/verdict binding; для disposition=waived — signed daemon review waiver exact candidate identity и записывает `review.status=waived` с authority hashes. Только после валидной branch он сбрасывает full_review_required и выбирает переход. При провале flags не меняются и task паркуется code_verdict_invalid либо review_waiver_invalid.

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

Panel, contest, narrow Lead, code-review и Judge получают snapshot-rooted read/grep/list + submit_gate_result. Host writes daemon custody receipt; model task/comment/CLI/transit отсутствуют.

Штатный worktreeSandbox без OID запрещён. Host сравнивает HEAD/tree/status/untracked и immutable creation/session bindings. Parallel sibling daemon lifecycle/result receipts с valid provenance/version разрешены; full mutable sibling store hash не сравнивается. Любая другая Git/store mutation — blocking non-verdict.

### Commit on PASS

После PASS:

1. повторно mint worktree/approved tree и recompute exact `governance_mapping_set_digest`; mismatch с reviewed candidate запрещает branch side effect;
2. до CAS зафиксировать canonical commit recipe: recorded parent/base, tree, message bytes, author/committer identity и timestamps; `git commit-tree` вычисляет exact expected commit OID;
3. если private branch уже exact expected OID и parent/recipe совпадают, восстановить metadata идемпотентно;
4. если branch на recorded base, CAS update только к expected OID;
5. любой другой OID, даже с approved tree, — commit_foreign_movement;
6. привести ticket worktree к чистому состоянию;
7. записать commit OID и повторно сверить branch/tree.

Модель refs не двигает.

### Integration

Детерминированный autosk-owned adapter:

1. берёт чистую целевую ветку и её recorded base OID;
2. строит merge commit без движения целевой ref;
3. вычисляет merge tree и сверяет approved tree;
4. daemon under mutex writes pending operation receipt binding authorization, expected_old/new, heads, prefix and pre-CAS reflog watermark before Git CAS;
5. performs update-ref, then marks committed/not_applied; crash recovery uses operation-bound reflog. not_applied requires proof CAS never occurred and no later movement; new→old/ambiguous is foreign;
6. only committed advances prefix/next Ticket; foreign/indeterminate parks.

State path создаётся отдельно для каждой operation под `<canonical-project-root>/.autosk/autosk-flow/integration-state/` и связывается с project_root_sha256. Никакой integration state не хранится в глобальной пользовательской папке или соседнем проекте.

## 6. onTransit guards

- current task project binding обязан совпадать с canonical ctx.projectRoot и project_root_sha256;
- parent, child, blocker, session, artifact, verdict, evidence, user-decision, policy и correlation refs другого проекта отклоняются; тот же assert уже обязан был пройти до side effects;
- protocol lock/snapshot обязан принадлежать текущему project/Epic и совпадать с manifest/content digest/detached attestation, записанными в самом immutable lock;
- authority/correction journal heads обязаны совпадать с rollback-resistant secure heads; short/deleted/regressed chain блокирует любой approval/policy/waiver/accept/integrate consumer до authority_recovery;
- implement/verify/fix/freeze/review/record/commit/repair и parent dispatch/join/accept/integrate/aggregate требуют protected current dependency projection/head + intent head в controlling_anchor_digest; mismatch aborts live model adapter and enters blocked-anchor handoff before side effects;
- every autosk_flow metadata mutation requires daemon step-capability + expected protected metadata head; model connection, same-UID file/CLI edit and stale host writer are rejected;
- panel/code/Arena/contest joins and record_artifact_pass accept only daemon gate-result receipt bound to child/session/frozen identity/outcome and protected result head;
- current installed bundle сравнивается только при создании нового lock. Его более новая версия не инвалидирует и не перепривязывает открытый Epic;
- Planned implementation запрещён до current artifact binding каждого реально созданного артефакта: disposition=pass с verdict либо disposition=waived с signed exact daemon waiver.
- Нормативный draft Brief/Core Flow/Tech Plan запрещён без valid alignment proposal/manifest identity. Freeze/panel дополнительно требуют, чтобы post-draft material projection exact bytes совпадал с approved manifest и project/Epic/kind/anchor/scope/user-record/classifier/projector/policy/protocol identity. Tickets до approval только proposal.
- `record_alignment` принимает только daemon-attributed `UserDecisionRecord` либо exact current project policy projection; Git/comment authorship, model label/self-approval, assumption, unknown/ambiguous/forbidden class и material decision за пределами policy отклоняются.
- `freeze_artifact`, full/narrow Panel dispatch/join и `record_artifact_pass` требуют current alignment + recomputed material manifest в controlling anchor pack. Изменившийся user record, subject/manifest, classifier/projector input/version, scope, anchor или policy disposition делает его stale раньше model fan-out.
- every freeze runs the closed path-role classifier; ordinary implementation proceeds to code review, while additional normative documents require current mapping proof and direct candidate-bound `governance_mapping_set_digest`; unknown/orphan/ambiguous/stale mapping blocks candidate/panel/PASS.
- Tickets не исполняются без current Tickets artifact disposition=pass|waived; waived требует signed full-skip authority current identity.
- Ticket Panel не стартует, а `dispatch_ticket_dag` не создаёт child/blocker side effects без breakdown approval того же canonical Ticket set/DAG/scopes/outcomes/order/exclusions subject hash. Panel PASS не заменяет этот approval.
- Quick-flow не проверяет alignment records, пока classification остаётся valid. Каждый pre-integration gate повторяет closed rules; Planned-trigger исключает обычный переход и ведёт только в `invalidate_quick_classification`. Quick с open/failed handoff не может commit/integrate.
- Panel seat не закрывается без валидного verdict той же identity.
- Каждый fan-out dispatch ставит exact parent blockers до перехода в join; любой join, увидевший nonterminal child без edge, восстанавливает его и переходит в парный wait-step вместо invalid classification.
- Panel join требует четыре ожидаемых child tasks в status=done и четыре валидных verdict bindings. Child human оставляет parent blocked; cancel/missing/invalid после разблокировки переводят parent в human.
- Сокращённый panel join допустим только с daemon-attributed exact waiver той же identity, полным actual_roster и gate Lead вне author/fixer set.
- Любой pending_anchor, BLOCKED_ANCHOR или несовпадение anchor_version переводит parent в human с blocked_anchor; четыре PASS ничего не разрешают.
- rebuild_anchor не вычисляет map после approval: только prepare_anchor_impact пишет proposal; signed approval связывает proposal hash, а watermark/status drift возвращает prepare до side effects.
- One active repair op; ticket_repair source includes aggregate_unchanged and must carry failure/map binding. Unknown/duplicate/mismatch parks without effects.
- Narrow review join требует ровно одного Lead child в status=done и verdict текущей identity; findings возвращают fix_artifact, PASS ведёт select_next, invalid terminal ведёт human.
- Contest join требует отдельную disposition каждого originating seat; снижение или отклонение finding без полного набора dispositions недействительно.
- Ticket join требует каждую expected Ticket done, current code review disposition=pass|waived, controlling digest и commit OID. Terminal status сам по себе недостаточен.
- Arena не стартует без rubric 3–6 критериев и минимум двух разных candidate families.
- Judge не принадлежит candidate family и не получает family labels.
- Arena join требует judge status=done и judgment binding текущей arena identity. Child human оставляет parent blocked; cancel/missing/invalid ведут human.
- Arena status=recommended не является пользовательским решением и блокирует normative Tech Plan draft/panel до current alignment record; terminal applied/fallback может создать только record_alignment.
- apply_arena_decision и planning rebuild_anchor выставляют current_cycle.full_panel_required=true. Пока флаг true, freeze может идти только в dispatch_panel; валидный full panel_join атомарно сбрасывает его в current_cycle, после чего fix этого же attempt может использовать Lead-only narrow re-review.
- Initial Quick cycle имеет full_review_required=true/full_review_reason=initial: единственное исключение из full review — exact initial editorial exemption без pending_anchor. rebuild_code_anchor меняет reason на anchor_rebuild; при этом freeze может идти только в dispatch_review. Только валидный full record_code_verdict либо initial editorial exemption атомарно сбрасывает flag/reason.
- Ticket с parent_epic_task не может самостоятельно увеличить anchor_version; commit/review/join требуют равенства parent anchor, а suspended blocker обязан иметь restore receipt.
- После anchor rebuild pending_anchor не содержит уже consumed correction events. Events после recorded watermark остаются в comments и на следующем gate создают новый blocked_anchor. Ticket signal всегда публикуется event + waiting receipt и не пишет Epic metadata. Normal human recovery получает parent_rebuild_receipt, replacement — superseded_by. Потерянный consumed event/hash, Ticket pre-resume mismatch или отсутствующий binding/receipt означает anchor_impact_invalid.
- Code review запрещён без verification record и candidate tree OID.
- Code reviewer family и panel Lead обязаны отсутствовать в полном author/fixer set.
- Reviewer/Judge/gate provider_session_id обязан отличаться от session IDs всех author/fixer tasks того же scope; совпадение запрещает dispatch и аннулирует verdict.
- Arena role session не переиспользуется между разными decision_id или model families; terminal decision сохраняет свою session map неизменной.
- Commit запрещён без действующего review disposition=pass|waived текущего tree OID; waived branch требует current daemon waiver revalidation.
- select_next запрещён, пока record_artifact_pass не записал binding текущей identity; текстовый PASS сам по себе не считается.
- Integration запрещена без commit OID, approved tree, dependency completion и daemon-attributed human/current project permission.
- Terminal done запрещён до cleanup всех созданных sandboxes; единственное reclassified-исключение требует exact read-back ownership-transfer receipt в Planned replacement retention set, поэтому worktree остаётся учтён и не удаляется.
- Review cap читает монотонный current cycle round, а не resettable step_visits. Переход на новый review round после cap заменяется human.
- freeze отклоняет round меньше last_round и идемпотентно не увеличивает его повторно для того же attempt+tree OID.
- Bare resume после эскалации отклоняется без park.reason, явной target и требуемого recovery metadata.

## 7. Ошибки и восстановление

| Ситуация | Поведение |
| --- | --- |
| Provider/model отсутствует | повтор по контракту; затем human, без автоматической подмены или сокращения панели |
| Brief framing не подтверждён | normative draft отсутствует; Epic human с brief_alignment_required |
| Core Flow содержит незакрытое решение поведения | normative draft/freeze запрещены; Epic human с core_flow_decision_required |
| Tech Plan readiness содержит open question или silent inference | draft запрещён; Epic human с tech_plan_readiness_required |
| Tickets proposal изменился после approval | прежний alignment record stale; Ticket Panel/dispatch запрещены до нового breakdown approval |
| Git/comment заявляет user approval без matching daemon record | authority source отклонён; kind-specific human park, side effects отсутствуют |
| Decision classifier unknown/ambiguous либо model label расходится с derived rules | fail-closed human; policy coverage не применяется |
| Autonomous policy не совпадает с rule/class/scope/constraints или затрагивает forbidden material class | human с alignment_policy_out_of_scope; policy не расширяется автоматически |
| Project policy revoked/expired/replaced после Epic cache | cache игнорируется, alignment stale, human с alignment_policy_out_of_scope |
| Authority/correction journal короче secure head либо record удалён | fail-closed human с authority_journal_truncated; policy/alignment/waiver/integration consumers запрещены |
| Quick обнаружил Planned-trigger после intake | дальнейшие Quick gates/integration запрещены; idempotent Planned handoff либо human с quick_classification_invalid |
| Anchor impact proposal создан, но не подписан | human с anchor_impact_approval_required; anchor/PASS/Ticket side effects ещё не выполнялись |
| Gate model не вызвал submit либо вернул invalid payload | child human с gate_result_missing/gate_result_invalid; accepted verdict не создаётся |
| Gate child обнаружил authority/dependency/intent mismatch | host пишет current-identity BLOCKED_ANCHOR result, child done; parent join снимает blocker и паркуется blocked_anchor |
| Gate snapshot/store изменился | child human с gate_snapshot_mutated и blocking non-verdict |
| Arena candidate build/verify/freeze не завершён | child human с точной arena_candidate_* причиной; candidate не считается live |
| Project boundary/path guard не прошёл | human с project_boundary_invalid; side effects count=0 |
| Child create завершился частично | повторный dispatch находит задачу по daemon-owned creation_key даже после rename до metadata set |
| Duplicate/malformed/colliding creation_key или binding hash mismatch | human с child_creation_key_invalid; ни один child не enroll |
| Child task parked human | parent остаётся blocked; оператор возобновляет child в его существующем workflow либо cancel делает join ответственным за parent park; только anchor-repair parent step может автоматически resume Ticket по валидным receipts |
| Один seat cancel/unavailable | parent переходит в human; сокращённый roster требует явного waiver |
| Ticket cancel/done без binding | parent переходит в human; такой Ticket не считается завершённым |
| Crash после Ticket human park и до exact unblock parent | Ticket остаётся human с anchor_handoff_incomplete; parent безопасно остаётся blocked |
| ticket_join обнаружил malformed/mismatched handoff | exact edge восстанавливается; valid event + bad receipt использует receipt_only без нового event, invalid raw event использует daemon-attributed supersede_event |
| Любой Ticket expected execution set ещё status=work во время rebuild_anchor | parent паркуется с anchor_repair_ticket_live до любых rebuild writes; pending_anchor сохраняется; parent не пишет claimed-unaffected live Ticket |
| Artifact изменён после verdict | verdict void, новый attempt |
| Arena decision не re-expressed в новых Tech Plan bytes | human с arena_reexpression_missing |
| Correction event schema/hash/project invalid | human с correction_event_invalid; raw record не проходит watermark без exact later daemon-attributed superseder/disposition |
| Protocol lock/snapshot повреждён | human с protocol_lock_invalid; model/fs side effects не выполняются |
| Implementer provider/output/scope невалиден | human с implement_provider_unavailable, implementation_result_invalid или implementation_scope_invalid; Epic blocker остаётся активным |
| Verification runner/evidence невалиден | human с verification_environment_failed или verification_record_invalid; candidate/PASS не меняются |
| Verification defect исчерпал cap либо freeze identity невалидна | human с verification_cap или freeze_candidate_invalid |
| Crash после edge до child resume | parent safely blocked; child human с durable anchor_resume_pending и exact resume_intent/target, который пользователь возобновляет без изменения графа |
| Anchor version изменена | void active-cycle verdicts и bindings из daemon-attributed anchor_impact; unchanged planning PASS живут только через явный hash-checked re-binding; affected scope получает новый full gate |
| Extension обновлена во время epic | продолжается pinned protocol snapshot; исчезнувший workflow паркуется human |
| Reviewer изменил snapshot | blocking non-verdict, новый isolated review |
| Loop cap достигнут | human, без автоматического PASS |
| Integration obstruction | ничего не удалять; переместить помеху восстанавливаемо только по решению человека |
| Foreign movement/indeterminate | остановка и расследование; повтор запрещён |
| Daemon restart | tasks, blockers, metadata и sessions восстанавливают позицию; idempotent steps завершают незаконченные действия |

Resume contract:

| park.reason | Существующий workflow step | Требование |
| --- | --- | --- |
| brief_alignment_required | record_alignment | current framing packet и matching daemon `UserDecisionRecord` либо re-resolved exact active policy |
| core_flow_decision_required | record_alignment | каждое material behavior decision закрыто daemon record; model self-approval отсутствует |
| tech_plan_readiness_required | record_alignment | current readiness record, classifier proof и daemon decision/current policy совпадают |
| tickets_breakdown_alignment_required | record_alignment | current Ticket set/DAG/scopes/outcomes/order/exclusions показаны и daemon approval subject hash совпадает |
| alignment_policy_out_of_scope | clarify_alignment for brief/core_flow/tech_plan; present_tickets_breakdown for tickets | trusted client signs only exact challenge; autoskd commits UserDecisionRecord then issues current daemon policy projection. Direct client policy bytes/stale signed policy rejected |
| alignment_record_stale | clarify_alignment для brief/core_flow/tech_plan; present_tickets_breakdown для tickets | новая anchor version/daemon impact disposition и current authority/alignment/classifier record; старые candidate/verdict/PASS bindings void или явно re-bound как unchanged |
| artifact_mapping_required | clarify_alignment for mapped brief/core_flow/tech_plan; present_tickets_breakdown for tickets; invalidate_quick_classification for Quick | decision expressed in named manifest and aligned; external document reduced to verified non-normative mirror with current mapping proof, or removed from behavior-defining scope |
| quick_classification_invalid | invalidate_quick_classification | schema-valid trigger, original base/worktree receipt и одна daemon-owned creation binding Planned replacement; Quick commit/integrate остаются запрещены |
| panel_join_invalid | dispatch_panel | invalid child IDs записаны, attempt+1; старые bindings void |
| gate_provider_unavailable | исходный gate model step | exact route снова проходит synthetic smoke; прежняя session продолжается либо explicit replacement записан |
| gate_result_missing / gate_result_invalid | исходный gate model step | invalid/nonexistent result не принят; attempt+1 и та же logical reviewer session с явным reminder схемы |
| gate_snapshot_mutated | исходный gate model step | новый immutable pinned snapshot того же candidate identity создан, pre-hashes совпадают, прежний response остаётся non-verdict |
| gate BLOCKED_ANCHOR | parent join после child done | immutable blocked result current identity; join ensures pending_anchor и не оставляет human child blocker |
| arena_candidate_failed / arena_candidate_verify_failed / arena_candidate_freeze_invalid | соответствующий build/verify/freeze step | тот же candidate attempt восстановим и identity неизменна; иначе новая Arena attempt через parent |
| project_boundary_invalid | исходный deterministic step | project binding/path исправлены и повторный pre-side-effect assert PASS |
| authority/dependency/intent journal truncated, projection/head mismatch или invalid uncommitted tail | authority_recovery | valid authority tail verified from stored challenge then heads commit before projection; invalid suffix without effects quarantine; missing committed dependency/intent/authority bytes restored only from exact backup or fail-closed |
| child_creation_key_invalid | исходный dispatch step | daemon-owned key+binding hash исправлены; остаётся ровно одна matching task, title/description не используются |
| panel_waiver_required | freeze_artifact для full skip; dispatch_panel/panel_join для reduced roster | retry route либо daemon-attributed waiver current identity; reduced roster также фиксирует actual roster/external Lead |
| review_waiver_invalid | freeze | новый signed daemon review waiver exact current candidate identity либо обычный dispatch_review; stale waiver сохранён |
| contest_join_invalid | dispatch_contest | invalid disposition tasks записаны, attempt+1 |
| narrow_join_invalid | dispatch_narrow_review | прежний Lead child закрыт, новый attempt |
| review_join_invalid | dispatch_review или dispatch_narrow_review | invalid review child закрыт, новый attempt и сохранён narrow/full mode |
| code_verdict_invalid | freeze | старый review binding void, новый candidate/review attempt |
| protocol_lock_invalid | repair_protocol_snapshot | common deterministic step зарегистрирован в Planned, Quick, Ticket, panel/contest/code-review и Arena workflows; exact locked content digest/manifest/attestation доступен для atomic re-mint; иначе reinstall exact bundle либо явная migration с full gates |
| arena_reexpression_missing | draft_artifact | Decision Record/graft list отражены в новых Tech Plan bytes и identity отличается от pre-arena |
| correction_event_invalid | trusted-client decision, затем исходный gate | append schema-valid superseding event с exact raw id/hash + daemon record ID/hash; parent atomically записывает terminal disposition, продвигает watermark и не редактирует старый comment |
| ticket_repair_op_invalid | dispatch_ticket_dag for fresh/current/planning/aggregate_unchanged or rebuild_anchor code_only | exact single op/source/binding required; conflicting op voided without child effects |
| ticket_repair_state_invalid | recorded source step `dispatch_ticket_dag` или `resume_repaired_tickets` | daemon-attributed exact repair disposition записана в open op; premature blockers сняты либо invalid Ticket superseded/replaced, phases не понижены |
| blocked_anchor, autosk-planned | prepare_anchor_impact | pending_anchor current; step deterministicly stages full map/status/cascade hash без rebuild side effects |
| anchor_impact_approval_required | record_anchor_impact_approval | signed daemon `UserDecisionRecord` exact staged proposal hash; step atomically records approved status только при unchanged snapshot/watermark |
| anchor_impact_invalid | prepare_anchor_impact | malformed/stale proposal сохраняется как evidence; новая полная map вычисляется deterministic step, не пользователем |
| anchor_repair_ticket_live | rebuild_anchor | anchor_rebuild_op=null; каждый Ticket expected set, включая claimed-unaffected, завершился в human/done/cancel; status/impact map перечитаны; pending_anchor сохранён; rebuild writes отсутствуют |
| anchor_handoff_incomplete | complete_anchor_handoff | event/receipt hash валидны, Ticket human и exact parent edge ещё active |
| waiting_parent_anchor с malformed/mismatched event/receipt | repair_anchor_handoff | mode=receipt_only переиспользует valid event; mode=supersede_event требует daemon user record и exact raw id/hash; bad immutable record сохраняется |
| blocked_anchor, standalone Quick | rebuild_code_anchor | own anchor bump, старые review bindings void, затем verify/freeze/full code review |
| blocked_anchor, Ticket with parent | rebuild_code_anchor | propagate pending to parent, suspend blocker with receipt, ждать parent rebuild_anchor |
| waiting_parent_anchor | rebuild_code_anchor | parent rebuild завершён, Ticket anchor=parent, local pending=null, receipt restored |
| anchor_resume_pending | rebuild_code_anchor | exact parent edge active, resume_intent совпадает с op/anchor/receipt/target и child всё ещё human |
| anchor_resume_intent_invalid | rebuild_code_anchor | bad intent сохранён как evidence; human записал точный replacement intent либо отменил repair operation |
| blocked_anchor, Ticket pending already absorbed by parent | rebuild_code_anchor | Ticket anchor=parent, local pending=null, matching parent_rebuild_receipt, no suspended receipt |
| implement_provider_unavailable | implement | exact route снова проходит synthetic smoke; прежняя session продолжается либо explicit replacement записан |
| implementation_result_invalid | implement | invalid result сохранён, attempt+1, completion schema повторно выдана той же logical session |
| implementation_scope_invalid | implement либо invalidate_quick_classification | out-of-scope dirt сохранён как evidence; expanded scope повторно классифицирован; Planned-trigger никогда не продолжает Quick |
| fix_provider_unavailable / fix_result_invalid / fix_scope_invalid | fix | тот же candidate/findings identity, attempt+1; provider/output/scope evidence исправлены, старый PASS не создаётся |
| artifact_fix_provider_unavailable / artifact_fix_result_invalid / artifact_fix_scope_invalid | fix_artifact | тот же artifact candidate/findings identity, attempt+1; invalid bytes остаются non-normative |
| artifact_draft_provider_unavailable / artifact_draft_result_invalid / artifact_draft_scope_invalid | draft_artifact | same proposal/alignment identity, attempt+1; invalid/out-of-scope bytes remain non-normative |
| artifact_freeze_invalid | freeze_artifact | scope/pathspec/tree re-minted for same current artifact/alignment; no panel child or PASS from failed mint |
| verification_environment_failed | verify | runner/environment восстановлен и candidate identity неизменна |
| verification_record_invalid | verify | evidence record пересоздан для той же candidate identity |
| verification_cap | fix | новый daemon-attributed cap decision и verification findings сохранены |
| freeze_candidate_invalid | freeze | scope/candidate identity повторно mint'ится; stale review binding void |
| artifact_pass_invalid | freeze_artifact | старые bindings void, attempt+1, сохранённый full/narrow mode |
| review_cap | fix_artifact для Planned; fix для Quick/Ticket | новый daemon-attributed cap decision, сохранённые findings и identity |
| arena_join_invalid | dispatch_arena | новый arena attempt; старые judgments void |
| arena_fallback_required | apply_arena_decision | daemon `UserDecisionRecord` выбрал fallback; review_cycles.tech_plan narrow=false/full required |
| arena_contract_invalid | fix_artifact | исправленный autosk-arena block, review_cycles.tech_plan.narrow=false/full_panel_required=true |
| ticket_join_invalid | dispatch_ticket_dag | repair map для missing/cancelled/unbound Tickets |
| ticket_edge_receipt_lost | dispatch_ticket_dag | receipt сопоставлен live Ticket или valid superseded_by, старый sandbox учтён |
| candidate_changed | fix | approved findings/identity сохранены, новый candidate attempt |
| commit_cas_failed | commit_on_pass | ref всё ещё на recorded base, причина lock/storage устранена |
| commit_foreign_movement | commit_on_pass | private branch снова однозначен после расследования; cancel — отдельная status-операция |
| aggregate_verify_failed / aggregate_remediation_required | record_aggregate_remediation | resume same creation key/binding and phase; external retry/unchanged close op, set-changing continues choice_recorded -> old_bindings_void -> proposal_ready -> breakdown/full Panel |
| no_external_reviewer | freeze для signed full-skip waiver; dispatch_review/narrow для external human/re-expression | waiver resume обязательно проходит freeze consumer; режим сохраняется |
| no_external_panel_lead | freeze_artifact для signed full-skip waiver; dispatch_panel/narrow для external human Lead | waiver resume обязательно проходит freeze_artifact consumer; full/narrow сохраняется |
| cleanup_dirty | cleanup | force=true разрешён явно или состояние сохранено |
| integration_authorization_required | accept | новый signed record связывает current target OID, completed-prefix receipt, exact remaining transitions, final tree, relevant authority/dependency/intent bindings и expiry |
| integration_obstruction | integrate | восстановимое перемещение помехи записано |
| integration_precondition | integrate | нарушенное предусловие устранено, base/tree повторно записаны и доказательство приложено |
| foreign_movement / indeterminate | integration_recovery | обычный retry запрещён; cancel — отдельная status-операция, не workflow step |

## 8. Проверки

### Unit

- classification rules и waivers;
- Planned metadata требует tech_plan=true и tickets=true; false invalid, а optional остаются brief/core_flow;
- переходы: каждый зарегистрированный step имеет исчерпывающие взаимно исключающие исходы;
- select_next precedence для optional artifacts, Arena и Tickets;
- закрытые alignment packet schemas для Brief, Core Flow, Tech Plan и Tickets;
- `UserDecisionRecord` signature/nonce/expiry/hash-chain/idempotency/reconcile guards; model subprocess не получает `UserPresenceSigner`;
- approval identity golden vectors связывают project/Epic/kind/anchor/scope/subject/user-record/classifier/policy/protocol и исключают self-hash;
- alignment record допускает только монотонные valid -> stale|void dispositions; смена любого identity input отклоняет старый record;
- deterministic decision classifier проверяет precedence/proofs, игнорирует model labels и fail-closed классифицирует unknown/ambiguous;
- material-decision projector golden vectors для four kinds; pre-draft manifest и post-draft exact-byte projection совпадают либо alignment stale;
- autonomous policy validator перечитывает project projection, требует exact project/run/kind/rule/class/scope/constraints/issuance binding и отклоняет revoke/expiry/replace/forbidden class;
- Quick classification проверяется на каждом pre-integration gate; handoff op/creation key/retry создают ровно один Planned replacement и никогда не интегрируют old Quick bytes;
- Quick handoff prepared binding includes intent head + candidate/review/accept/waiver/integration hashes and atomically voids them before child create or any Git read;
- canonical ArtifactKind enum и artifact_pass binding;
- path-role classifier golden vectors distinguish ordinary source/config/schema/prompt/test/migration changes from additional normative documents; model declaration can escalate but cannot downgrade;
- embedded and companion-sidecar mapping proofs are deterministic, ordered and bound by `governance_mapping_set_digest`; unknown/stale/orphan/extra normative content fails closed;
- mapping digest drift between freeze->review, review->record_code_verdict and review->commit_on_pass invalidates the candidate/verdict before side effects;
- независимый review_cycles entry для каждого ArtifactKind;
- atomic record_artifact_pass, включая malformed autosk-arena без частичной записи;
- artifact/code `pass|waived` dispositions взаимоисключаемы; waiver branch требует signed current authority и создаёт ноль review children;
- Arena state допускает только host path pending -> recommended -> record_alignment -> applied/fallback; recommended запрещён в normative block и не запускает draft/panel;
- prompt compilation из одного snapshot;
- bundle manifest требует один Guide и exact 12 protocol paths, regular files и совпадающие hashes/digest;
- canonical bundle digest и detached attestation проходят golden vectors без self-hash cycle;
- editorial classifier отклоняет config/schema/security/prompt/governance и behavior-defining paths;
- freeze precedence различает initial editorial exemption и anchor_rebuild forced full review через full_review_reason;
- record_editorial_exemption recheck non-editorial routes dispatch_review; signed exact IntegrationAuthorizationRecord mirrors record_code_verdict behavior, project policy rejected;
- Planned draft_artifact/fix_artifact/freeze_artifact и Quick/Ticket implement/verify/fix/freeze имеют mutually exclusive success/human exits for provider/output/scope/evidence/environment/identity failures;
- каждый workflow graph регистрирует common repair_protocol_snapshot и возвращает только в recorded pre-failure step;
- daemon-owned creation_key и creation_binding_hash write-once; key кодирует project/parent/run/seat, hash связывает artifact/session/workflow target;
- concurrent create с одним creation_key возвращает один task ID; тот же key с другим binding fail-closed;
- correction event schema/id/hash/watermark не допускает повторное consume;
- contest disposition terminal per canonical finding/candidate; re-contest same ID rejected и не обходит round cap;
- correction disposition пропускает только exact raw id/hash с later valid daemon-attributed superseder и атомарно двигает watermark;
- repair_anchor_handoff receipt_only/supersede_event predicates взаимно исключаются; receipt_only не append'ит event;
- anchor_rebuild_op/ticket_repair_op взаимно исключаются; closed source enums допускают planning/code_only/arena/no_bindings для первой и fresh/current/planning для второй, но resume target только anchor code_only или ticket op; step имеет success/fail-closed исход для каждого status/phase;
- prepare_anchor_impact -> signed decision -> record_anchor_impact_approval -> rebuild order; approval-before-map и stale snapshot невозможны;
- resume_intent pending/consumed guards идемпотентны при crash до edge, до resume и до transit verify;
- metadata schema требует autosk_flow.session для каждой model-owned task;
- каждый project-local файл и recovery key привязан к canonical project root hash;
- project binding обязателен для parent/child/blocker/session/verdict/evidence refs;
- protected dependency/intent heads, current dependency projection и closed controlling_anchor_digest входят в Ticket/candidate/verdict/commit bindings и re-resolve at every side-effect boundary;
- canonical signed-challenge bytes survive restart golden vectors; authority projection/effects are impossible before authority+nonce head commit;
- integration authorization restart lookup verifies daemon file/protected head/content/expiry/revoke/replace; operation state cannot satisfy authority;
- model-process boundary tests deny signer RPC/keychain/accessibility/ptrace and secure-state reads; unsupported deployment/headless blocks model launch;
- direct dependency projection removal/reorder fails protected-head reconciliation; add/supersede current-set golden vectors preserve history without accepting revoked current records;
- aggregate_remediation creation key/binding и phases fail-closed on every crash prefix; set-changing void precedes new proposal/breakdown;
- waived code disposition сохраняет waived_review_mode/reason;
- authorityGuard serializes resume/enroll/block batch, а integrateApproved serializes target CAS with authority/dependency/instruction/correction append;
- gate child authority mismatch emits validated BLOCKED_ANCHOR and reaches done, so parent join cannot remain blocked by human child;
- daemon workflow custody rejects model/stale-host autosk_flow metadata/comment mutations; gate receipt replacement/truncation conflicts with protected result head;
- orchestrateChildBatch accepts only current parent step/op exact child set, expected heads and closed repair patches; wrong child/field/stale head/forged child capability rejected;
- parallel panel seats accept daemon-attributed sibling lifecycle/result versions without comparing mutable full sibling stores;
- standalone Quick uses scope_id=quick:<task-id> dependency/intent journals and appendIntentEvent advances that head;
- identity/hash canonicalization;
- verdict schema и stale binding;
- author-family routing;
- code reviewer matrix для single/mixed author+fixer sets;
- onTransit graph и cap=10;
- idempotent child discovery;
- exit classification integration adapter.

### Integration

- Brief framing не подтверждён: normative Brief bytes не создаются, Epic получает `brief_alignment_required`;
- model-written Decision Log/comment с `source=user` без daemon record не создаёт alignment/waiver/policy/acceptance;
- Core Flow содержит неразрешённое решение поведения: Epic паркуется `core_flow_decision_required`, assumption не проходит;
- Tech Plan readiness выявляет silent inference: `draft_artifact` запрещён до нового user decision/alignment record;
- model добавляет после readiness approval irreversible migration/delete-on-upgrade: post-draft manifest mismatch возвращает clarify до freeze/panel;
- Brief/Core Flow/Arena/fix bytes с новым material decision одинаково stale alignment; classifier-proven non-material prose edit manifest не меняет;
- unreferenced prose с destructive/API instruction не входит в PromptEnvelope/Ticket trace; duplicate/unknown manifest block/ref fail-closed;
- Tickets изменены после approval: прежний subject/approval становится stale и новый Ticket Panel не запускается;
- Ticket Panel PASS без current breakdown approval не разрешает `dispatch_ticket_dag` и создаёт ноль child/blocker side effects;
- signed full panel waiver current artifact identity проходит freeze_artifact -> record_artifact_pass(disposition=waived) без panel child; stale waiver паркуется;
- signed code-review waiver current tree identity проходит freeze -> record_code_verdict(status=waived) без reviewer child; tree change void'ит waiver;
- full и narrow review waivers сохраняют различимые waived_review_mode/reason в immutable disposition;
- exact autonomous policy разрешает продолжение только для записанных project/run/kind/rule/class/scope/constraints и не отменяет Panel/Code Review/integration gate;
- project alignment policy никогда не заполняет integration_authorization; только signed exact run/candidate record пропускает accept;
- project policy, выданная в Epic A и отозванная daemon record, сразу блокирует cached use в Epic B;
- planning policy revoke changes current dependency projection/head, aborts next tool call and prevents stale review/commit; exact supersede requires re-alignment/new bindings, revoke after Ticket done blocks join/integrate;
- daemon supersede from policy to exact user decision advances dependency head, voids old bindings, keeps history audit-only and makes current projection unambiguous; revoked current dependency blocks, revoked superseded history does not satisfy or deadlock guard;
- delete terminal revoke/correction/projection record: secure head detects shortened chain and all authority consumers fail-closed;
- forged/replayed journal-ahead suffix quarantine'ится до secure head и не оставляет authority consumers в dead end;
- crash-tail record cannot authorize any draft/freeze/repair/integration until stored challenge signature verifies and authority+nonce heads commit;
- correction во время `await_alignment` повышает anchor version через impact flow, void'ит affected candidate/verdict/PASS и перезапускает соответствующий alignment/artifact cycle;
- Judge recommendation без current Tech Plan alignment остаётся recommended и не создаёт нормативный draft, Decision Record или panel child;
- Quick-flow не блокируется alignment states, пока classification valid; Planned-trigger на intake/implement/verify/fix/freeze/review/accept/integrate-prologue создаёт один replacement Planned Epic от original base;
- material scope expansion через `implementation_scope_invalid` не продолжает Quick; modified worktree сохраняется только как untrusted evidence;
- два project roots одновременно создают Epics с одинаковыми epic/task/run labels без collision;
- одинаковые reviewer task IDs двух проектов создают разные external worktree paths по project_root_sha256 и всегда используют `AUTOSK_CWD=ctx.projectRoot`;
- документы, user decision records, project policy projections, protocol locks, sessions, evidence и integration state двух проектов остаются в своих roots;
- общий worker pool может чередовать проекты, но не меняет project binding и не создаёт cross-project blockers;
- update installed bundle v1→v2 не влияет на активные Epics с v1 locks; новый Epic получает v2;
- bundle GC не удаляет digest, пока хотя бы один registered project lock его использует; corrupted snapshot re-mint'ится из exact cached digest;
- rename/description edit после create до metadata set не меняет creation_key; retry находит existing child и не создаёт duplicate/orphan;
- reconcile отвергает external task.json edit/remove любого creation field; отсутствие CLI/RPC pair primitive останавливает preflight до child create;
- Ticket append events H1/H2 одновременно с parent rebuild не теряются: parent sole writer consume'ит только recorded watermark;
- user instruction/correction append racing authorityGuard/integrateApproved waits on the same project mutex; guard binds exact intent head and Quick classifier proof;
- Ticket никогда не вызывает Epic metadata writer: correction публикуется только append-only event, а любые Ticket-side metadata set parent Epic отклоняются;
- rebuild_anchor завершает semantic anchor/binding writes до `resume_repaired_tickets`; после первого Ticket resume parent пишет только монотонные edge_restored/child_resumed/ready_to_join phases, а ticket_join prologue закрывает op;
- claimed-unaffected status=work Ticket блокирует rebuild до human/done/cancel; parent не теряет его concurrent candidate metadata;
- Ticket park→unblock crash оставляет parent blocked и восстанавливается через complete_anchor_handoff; crash после unblock до final receipt заставляет ticket_join вернуть edge и дождаться того же child recovery;
- malformed/mismatched handoff не направляется в незарегистрированный recovery: ticket_join возвращает edge; receipt_only не дублирует valid event, supersede_event создаёт новый immutable event и parent disposition;
- ticket_join при missing blocker создаёт edge, transits ticket_join_wait и не завершает onRun без ctx.transit;
- ticket_join не восстанавливает intentionally suspended edge только при exact final event/receipt binding; затем consume'ит correction и паркуется blocked_anchor;
- gate role получает только snapshot-rooted read tools и `submit_gate_result`; host driver принимает ровно один payload, записывает/read-back record до validate transit, а missing/invalid/mutating run паркуется с точной причиной;
- gate role current-head mismatch produces host BLOCKED_ANCHOR result/done and lets parent join park blocked_anchor instead of looping gate_result_missing;
- same-UID author attempts metadata set/review PASS/comment replacement/arbitrary autosk CLI: daemon rejects without step capability and result receipt;
- запуск с временным HOME без `.traycer`, devflow и Obsidian проходит Quick и Planned smoke;
- initial editorial Quick проходит record_editorial_exemption, но тот же path после rebuild_code_anchor с reason=anchor_rebuild обязательно идёт в full review;
- editorial classification drift between freeze and record step cannot stall or accept: it dispatches full review; signed exact integration authorization integrates only after full Quick reclassification;
- corrupted protocol snapshot в Planned, Quick, Ticket, panel/contest/code-review и Arena tasks имеет существующий repair_protocol_snapshot target и возвращается в точный pre-failure step;
- implementer provider/missing output/scope mutation, verify environment/evidence failure и freeze identity mismatch получают документированный park/recovery и не снимают Epic blocker;
- active bundle и prompt compiler не выполняют filesystem/process lookup Traycer;
- четыре child tasks создаются до parent join;
- panel и Arena dispatch не переходят в join до установки exact blockers; missing blocker при running/human child ведёт в panel_join_wait/arena_join_wait, а не в invalid park;
- при workers>=4 свободный pool запускает независимые seats параллельно; при меньшем pool результат не меняется;
- parent не запускается, пока blocker открыт;
- pending_anchor блокирует panel/contest/narrow/review/Arena/Ticket joins и integrate до rebuild;
- partial anchor_impact re-bind'ит ровно unchanged planning passes и void'ит ровно affected bindings;
- prepare_anchor_impact stages proposal before user approval; correction/Ticket status change while waiting stales approval and recomputes map без anchor bump;
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
- aggregate remediation crash after proposed/choice/void/proposal phases always resumes same creation binding; select_next/dispatch reject every non-closed prefix;
- Tickets proposal drift during await_alignment/panel fix/freeze/PASS resets remediation to old_bindings_void before any approval/PASS consumer and repeats draft→breakdown→full panel;
- policy revoke between replacement_ready and resume_repaired_tickets rejects authorityGuard before resume/enroll/block; revoke waits while a valid guarded batch executes;
- fresh Ticket DAG использует ту же ticket_repair_op с empty human set; все Tickets проходят replacement_ready→enrolled/blockers→ticket_join без repair-only precondition;
- human recovery Ticket с прямой/транзитивной зависимостью от replacement каскадно классифицируется replacement до создания op; workers=1 и workers>=4 дают одинаковый DAG;
- resume_repaired_tickets при cancel/new/missing recorded human до доказанного resume паркует ticket_repair_state_invalid и не продвигает phases;
- parent atomically записывает park.reason=anchor_resume_pending вместе с pending resume_intent до edge; 01/03 resume contracts используют одно имя;
- malformed raw correction с later valid daemon-attributed superseder получает parent-owned terminal disposition, watermark проходит exact raw/id/authority hashes, и следующий gate не повторяет correction_event_invalid;
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
- preflight доказывает dormant create/configure/enroll, exact block/unblock/resume --to и `await transit(human)` durable-commit-before-continuation/crash window;
- crash до edge повторяет intent/edge idempotently; crash после edge до resume оставляет child human с anchor_resume_pending и восстанавливается точным user resume; normal resume очищает intent и после всех children parent transits ticket_join;
- workers=1 и crash после intent, после edge и после resume дают тот же state outcome; ни один recovery step не удерживает worker в ожидании parent;
- Arena judge cancel/missing/invalid не проходит arena_join;
- applied/fallback arena status того же decision_id не понижается обратно в pending;
- две Arena decisions имеют непересекающиеся role session IDs; retry одной decision переиспользует только её map;
- record_artifact_pass сохраняет arena.decisions[*].sessions и terminal bindings byte-for-byte при merge нормативных полей;
- commit CAS failure без ref movement имеет отдельный recoverable park;
- private branch same-tree/different-parent commit is foreign movement; only precomputed expected commit OID/recipe recovers crash CAS;
- accept без signed exact IntegrationAuthorizationRecord действительно паркует human; resume требует authorization той же identity;
- Planned authorization expiry after partial transition stores prefix/current ref and requires new record for remaining transitions before further Git read;
- authority revoke racing target update cannot commit between revalidation and CAS: integrateApproved serializes both under the project mutex, crash outcome resolves by exact target ref/reflog;
- pending CAS followed by external new→expected_old ABA or ambiguous/missing operation-bound reflog is foreign/indeterminate, never not_applied/retry;
- aggregate NOT_PASS set-changing choice atomically voids old Tickets PASS/alignment before present_tickets_breakdown; select_next cannot redispatch old DAG;
- dependency DAG запускает только готовые Tickets;
- sandboxCleanupStep вызывается с force=false; dirty worktree не удаляется без явного разрешения.

### Adversarial

- модель подделывает user source/approval для собственного material decision;
- model shell пишет Git Decision Log/comment/projection, открывает ordinary daemon connection и пытается получить actor=user без valid signer/challenge;
- model помечает product behavior как `local_reversible_implementation`, но deterministic classifier выводит human_required;
- model сохраняет readiness summary, но вставляет в prose новый material API/data/destructive decision, отсутствующий в approved manifest;
- Quick/Ticket changes ordinary implementation source/config/schema/prompt/test/migration files; freeze does not require governance mapping and proceeds to code review;
- Quick/Ticket creates a fifth planning/governance document without mapping, with orphan sidecar or new unmapped decision; freeze creates no candidate/review/PASS and routes named lifecycle correction;
- mapping proof/rule version changes after freeze or review while tree bytes otherwise match; record_code_verdict/commit_on_pass rejects the stale digest;
- stale Epic cache пытается применить revoked project policy;
- model edits Epic metadata projection to remove/reorder dependency; protected dependency head mismatch blocks every consumer;
- re-bind policy->user decision without daemon supersede tries to keep old candidate PASS; current dependency projection/head mismatch voids it;
- model удаляет tail revocation/correction record и пытается заставить daemon принять valid old prefix;
- restart receives authority crash-tail whose nonce hash exists but canonical challenge bytes/request/anchor differ; signature verification fails and no effect was exposed;
- authority changes between implement->verify, review->commit, resume_repaired_tickets mutations, last Ticket->join и integrateApproved CAS while IntegrationAuthorizationRecord exists;
- user instruction or correction append races Quick reclassification/graph batch/Git CAS; shared mutex and expected intent head serialize one winner;
- user пытается approve hand-authored impact map, не созданную prepare_anchor_impact, либо replay'ит signature после status drift;
- forged/stale panel или review waiver пытается пройти consumer without current signed record;
- policy hash валиден, но artifact kind, decision class, scope, constraints, expiry или user-decision binding не совпадает;
- crash before/after Planned replacement create/enroll при Quick reclassification не создаёт duplicate и не разрешает Quick integrate;
- stale Tickets approval подставлен к другому DAG с теми же именами Ticket;
- bare resume из await_alignment без нового decision record;
- correction после record_alignment и до panel dispatch меняет answer hash;
- forged Arena transition pending/recommended напрямую в applied/fallback без record_alignment;
- forged child/blocker/verdict с project_root_sha256 соседнего проекта;
- forged project binding в `submit_gate_result` даёт ноль result-record writes по fake adapter counters и паркует gate child;
- path traversal или symlink из project runtime в другой project root;
- forged boundary metadata даёт ноль вызовов fs/Git/CLI/RPC side effects по fake adapter counters;
- `$HOME/.autosk` существует, reviewer cwd — external worktree, но autosk CLI с AUTOSK_CWD пишет только current project store;
- одинаковые task/session IDs в двух project stores;
- одинаковый local run/seat в двух projects создаёт разные creation_key по project_root_sha256;
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
- crash после commit-on-pass CAS восстанавливает metadata только по precomputed expected commit OID/parent/recipe;
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

- три upstream sets: creation-key pair; signed authority/dependency/intent stack; workflow custody with step-bound metadata CAS and protected gate-result receipts/head;
- compatibility preflight fail-closed запрещает model workflow без всех трёх primitives;
- authority preflight: unpinned/headless blocked; model-process probes cannot access signer RPC/keychain/accessibility/ptrace or secure heads across OS boundary; rogue TOFU/replay/forge fail; journal/head/dependency/intent races fail-closed;
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
- whole-lifecycle classification guard и idempotent Quick→Planned replacement handoff;
- verify/freeze;
- отдельная review child task на OID-pinned snapshot;
- fix/narrow review;
- human accept и cleanup.

Это первый end-to-end proof.

### Slice 3 — Planning и Panel

- adaptive Brief/Core Flow/Tech Plan;
- human alignment/readiness packets, records, exact autonomous policy и anchor-impact guards;
- Tickets proposal presentation и breakdown approval до Ticket Panel;
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
- upstream creation-key+binding-hash primitive реализован/протестирован в зафиксированной версии autosk; fallback на title/description отсутствует;
- pinned autosk реализует all three upstream sets, включая result head/receipt and model-side metadata/CLI rejection; replay/forge/projection-edit/verdict-replace/intent-race tests fail-closed;
- все четыре Pi route прошли live smoke;
- создан отдельный тестовый Git-репозиторий, не рабочий проект пользователя;
- autosk v2 установлен только после фиксации версии и rollback-плана.
