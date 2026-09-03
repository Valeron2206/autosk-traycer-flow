from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(relative: str, old: str, new: str, label: str) -> None:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{relative}: expected exactly one {label} marker, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


# README: canonical rule, package inventory and contract section.
replace_once(
    "README.md",
    "17. Planning verdict не завершает артефакт сам по себе. `record_artifact_pass` создаёт recorded-unpublished binding и durable operation; только host-owned `publish_artifact_pass` может CAS-продвинуть `refs/autosk/epics/<epic_ref_key>/planning`, проверить descendant commit/tree и разрешить `select_next`. Target branch при этом не меняется.\n\n## Состав пакета",
    "17. Planning verdict не завершает артефакт сам по себе. `record_artifact_pass` создаёт recorded-unpublished binding и durable operation; только host-owned `publish_artifact_pass` может CAS-продвинуть `refs/autosk/epics/<epic_ref_key>/planning`, проверить descendant commit/tree и разрешить `select_next`. Target branch при этом не меняется.\n18. Runtime-истиной комплекта Tickets является только schema-valid canonical `tickets.manifest.json` из exact verified Tickets publication commit. `README.md` и `Txx-*.md` — детерминированные renderer outputs; `dispatch_ticket_dag` не извлекает operational fields из Markdown.\n\n## Состав пакета",
    "README canonical Tickets rule",
)
replace_once(
    "README.md",
    "- [docs/contracts/epic-planning-ref.md](docs/contracts/epic-planning-ref.md) — нормативный контракт private planning ref, candidate keepalive всей Git object closure, commit-on-PASS, CAS и crash recovery для issue #5.\n- [diagrams/autosk-flow.drawio]",
    "- [docs/contracts/epic-planning-ref.md](docs/contracts/epic-planning-ref.md) — нормативный контракт private planning ref, candidate keepalive всей Git object closure, commit-on-PASS, CAS и crash recovery для issue #5.\n- [docs/contracts/tickets-manifest.md](docs/contracts/tickets-manifest.md) — нормативный контракт canonical machine-readable Tickets artifact, deterministic DAG/rendering и manifest-only dispatcher для issue #6.\n- [diagrams/autosk-flow.drawio]",
    "README package list",
)
replace_once(
    "README.md",
    "Проверка связи design-документов:\n\n```text\nnpm run validate:planning-ref\n```\n\n## Реестр миграционного паритета",
    "Проверка связи design-документов:\n\n```text\nnpm run validate:planning-ref\n```\n\n## Контракт canonical Tickets manifest\n\nIssue #6 фиксирует один `docs/autosk/epics/<epic-id>/tickets/tickets.manifest.json` как operational authority комплекта. Human-readable overview и Ticket Markdown генерируются pinned renderer и обязаны побайтово совпадать с manifest; изменение любой стороны создаёт новую alignment/candidate identity. Validated manifest, DAG, rendered document set и Ticket entries получают domain-separated digests в host-owned `TicketsValidationReceipt`. После отдельной Ticket Panel issue #5 публикует manifest и все views одним descendant commit; только этот verified commit разрешает `dispatch_ticket_dag`.\n\nПроверка:\n\n```text\nnpm run validate:tickets-manifest\n```\n\n## Реестр миграционного паритета",
    "README Tickets contract section",
)

# Core flow: clarify human and machine representations.
replace_once(
    "01-core-flows.md",
    "### Tickets\n\nСоздаются как вертикальные независимо проверяемые части. Каждый Ticket ссылается на конкретные пункты Brief, сценарии Core Flow и решения Tech Plan, содержит scope in/out, зависимости, критерии приёмки и требуемые доказательства.\n\nВесь комплект Tickets проходит отдельную четырёхмодельную панель. Панель проверяет и каждый Ticket, и согласованность набора.\n",
    "### Tickets\n\n<!-- tickets-manifest-contract:v1 -->\n\nСоздаются как вертикальные независимо проверяемые части. Каждый Ticket ссылается на exact published Brief/Core Flow/Tech Plan/Decision/Verification authority, содержит scope in/out, closed file/directory selectors, зависимости с rationale, observable acceptance criteria с evidence bindings, work type, impacts, review policy и rollback.\n\nОдин canonical `tickets.manifest.json` является runtime-истиной set/DAG. `README.md` и `Txx-*.md` генерируются pinned renderer из manifest и побайтово сверяются до freeze. Свободный Markdown, task title/comment или live worktree не используется для создания child/blocker edges. Host-owned `TicketsValidationReceipt` связывает exact manifest/DAG/rendered-set/Ticket-entry digests с planning parent, candidate tree, alignment, protocol/runtime/instruction identities.\n\nВесь manifest и его rendered views проходят одной frozen identity через отдельную четырёхмодельную Ticket Panel. После PASS issue #5 публикует их одним descendant planning commit. Только verified publication commit/head и current receipt разрешают manifest-only `dispatch_ticket_dag`. Полный контракт находится в `docs/contracts/tickets-manifest.md`.\n",
    "Core Tickets section",
)

# Architecture: ownership, projection and dispatcher boundary.
replace_once(
    "02-architecture.md",
    "- создание дочерних задач панели, Arena и Tickets;\n- компиляцию сообщений из замороженного протокола;",
    "- создание дочерних задач панели, Arena и Tickets;\n- schema/semantic validation canonical Tickets manifest, deterministic rendering human views и manifest-only reconstruction Ticket DAG;\n- компиляцию сообщений из замороженного протокола;",
    "architecture responsibilities",
)
replace_once(
    "02-architecture.md",
    "### autosk-owned integration adapter\n",
    "### Canonical Tickets manifest\n\n<!-- tickets-manifest-contract:v1 -->\n\nКомплект Tickets является одним behavior artifact с двумя представлениями: canonical `tickets.manifest.json` и deterministic Markdown views. Manifest — единственный scheduler/dispatcher input; views служат человеку и входят в тот же frozen candidate. `TicketsValidationReceipt` связывает schema/canonicalizer/renderer/validator identities, exact planning parent/candidate tree, set/DAG/entry/document digests и controlling locks. Receipt хранится как autoskd/evidence-owned immutable record, не как второй status ledger.\n\nПеред Ticket Panel deterministic validator проверяет closed Schema, canonical bytes, stable Kahn DAG, path-scope overlap/order, governing/evidence refs, lineage/limits и byte-identical renderer output. После verified issue #5 publication manifest-only dispatcher читает bytes из exact publication commit tree, а не live worktree, затем создаёт expected child/edge graph через daemon custody. Markdown disagreement блокирует до новой candidate identity; runtime никогда не выбирает prose.\n\n### autosk-owned integration adapter\n",
    "architecture Tickets section",
)
replace_once(
    "02-architecture.md",
    "    tickets/\n      T01-<slug>.md\n      T02-<slug>.md\n",
    "    tickets/\n      tickets.manifest.json\n      README.md\n      T01-<slug>.md\n      T02-<slug>.md\n",
    "architecture Git layout",
)
replace_once(
    "02-architecture.md",
    "Final Tickets publication фиксирует exact `planning_head` для downstream execution/staging.\n",
    "Final Tickets publication фиксирует exact `planning_head` для downstream execution/staging. Published tree содержит validated canonical manifest и exact renderer outputs; task/runtime state в них отсутствует.\n",
    "architecture final Tickets publication",
)

# Technical plan: insert validator step and exact dispatcher guards.
replace_once(
    "03-technical-plan.md",
    "tickets proposal and alignment:\n  select_next -> draft_artifact -> present_tickets_breakdown\n  -> await_alignment (human) -> record_alignment -> freeze_artifact\n",
    "tickets proposal and alignment:\n  select_next -> draft_artifact -> present_tickets_breakdown\n  -> await_alignment (human) -> record_alignment -> validate_tickets_manifest\n  -> freeze_artifact\n",
    "technical workflow Tickets path",
)
replace_once(
    "03-technical-plan.md",
    "Brief, Core Flow, Tech Plan и весь комплект Tickets — четыре значения current_artifact.kind и проходят один artifact cycle.",
    "Brief, Core Flow, Tech Plan и весь комплект Tickets — четыре значения current_artifact.kind и проходят один artifact cycle. Для kind=tickets deterministic `validate_tickets_manifest` расположен после breakdown alignment и перед freeze; Panel candidate содержит canonical manifest, renderer outputs и `tickets_validation_receipt` одной identity.",
    "technical artifact-cycle paragraph",
)
replace_once(
    "03-technical-plan.md",
    "| select_next | Tickets passed и alignment_records.tickets current | dispatch_ticket_dag |",
    "| select_next | Tickets Published PASS current, exact publication tree содержит current canonical manifest/rendered set, `tickets_validation_receipt` current и alignment_records.tickets current | dispatch_ticket_dag |",
    "technical select-next Tickets row",
)
replace_once(
    "03-technical-plan.md",
    "| record_alignment | kind=tickets, daemon-attributed breakdown approval либо re-resolved policy валидны для той же proposal/classifier identity | старый authority/approval hash остаётся audit evidence; atomically записать alignment_records.tickets, current_alignment=null, freeze_artifact |",
    "| record_alignment | kind=tickets, daemon-attributed breakdown approval либо re-resolved policy валидны для той же proposal/classifier identity | старый authority/approval hash остаётся audit evidence; atomically записать alignment_records.tickets, current_alignment=null, validate_tickets_manifest |",
    "technical Tickets alignment row",
)
replace_once(
    "03-technical-plan.md",
    "| draft_artifact | current author worktree/base OID или live private planning ref не равны verified planning.head_oid/tree |",
    "| validate_tickets_manifest | kind!=tickets либо manifest/path set отсутствует, unsupported/noncanonical/schema-invalid, semantic/DAG/path-overlap/lineage/limit/ref validation fails, rendered path/bytes drift, or alignment/planning/runtime/protocol/instruction identity stale | human с park.reason=tickets_manifest_invalid либо tickets_manifest_stale; no candidate/Panel/task/blocker side effects |\n| validate_tickets_manifest | canonical manifest, stable DAG/topological order, exact rendered document set and all controlling identities current | host computes manifest/DAG/document-set/Ticket-entry digests, writes/read-backs immutable `tickets_validation_receipt`, freeze_artifact |\n| validate_tickets_manifest | retry finds exact current receipt and unchanged bytes/identities | read-back receipt/digests only; freeze_artifact |\n| draft_artifact | current author worktree/base OID или live private planning ref не равны verified planning.head_oid/tree |",
    "technical validator rows",
)
replace_once(
    "03-technical-plan.md",
    "| dispatch_ticket_dag | current tickets alignment отсутствует/stale либо его subject hash не совпадает с PASS Ticket set/DAG |",
    "| dispatch_ticket_dag | exact verified Tickets publication commit/tree, canonical manifest path, supported schema/renderer, current validation receipt or set/DAG/entry/rendered digests missing/mismatched/corrupt | human с park.reason=tickets_manifest_stale; zero child/blocker/enroll side effects |\n| dispatch_ticket_dag | recomputed manifest semantic/DAG/path/lineage validation fails or rendered views differ from publication tree | human с park.reason=tickets_manifest_invalid; zero child/blocker/enroll side effects |\n| dispatch_ticket_dag | current tickets alignment отсутствует/stale либо его subject hash не совпадает с PASS Ticket set/DAG |",
    "technical dispatcher manifest guards",
)
replace_once(
    "03-technical-plan.md",
    "### Panel seat task\n",
    "### Canonical Tickets manifest binding\n\n<!-- tickets-manifest-contract:v1 -->\n\nFor kind=tickets protected metadata records exactly one current `tickets_validation_receipt` containing planning parent/candidate tree, manifest/schema/canonicalizer/renderer/validator identities, manifest/DAG/rendered-set/full-set/Ticket-entry digests, exact rendered path/hash inventory, limits and alignment/protocol/runtime/instruction/mapping bindings. Mutable Ticket status/session/commit/review/integration fields are forbidden in manifest and receipt.\n\n`dispatch_ticket_dag` opens the exact verified publication commit tree and validates `docs/autosk/epics/<epic-id>/tickets/tickets.manifest.json`; it never parses rendered Markdown for operational values. Child creation binding includes manifest, entry, DAG and planning-head identities. Missing/corrupt/unsupported/stale inputs park before any child or edge side effect. Schemas, canonicalization, lineage, renderer and test matrix are normative in `docs/contracts/tickets-manifest.md`.\n\n### Panel seat task\n",
    "technical manifest binding section",
)
replace_once(
    "03-technical-plan.md",
    "- Tickets не исполняются без current Tickets Published PASS:",
    "- Tickets не исполняются без current schema-valid canonical manifest, byte-identical rendered document set, current TicketsValidationReceipt and current Tickets Published PASS:",
    "technical Tickets guard bullet",
)

# Decisions: add ADR-027.
replace_once(
    "04-decisions.md",
    "## Оставшиеся риски, не решения\n",
    "## ADR-027: canonical machine-readable Tickets manifest\n\n- Решение: каждый Tickets revision публикует один closed canonical `tickets.manifest.json`; human `README.md`/`Txx-*.md` являются pinned deterministic renderer outputs и входят в ту же frozen candidate/tree. Manifest-only dispatcher читает exact verified publication commit, validates `TicketsValidationReceipt`/digests и создаёт task/blocker graph только из canonical entries. Runtime status в manifest отсутствует.\n- Identity: domain-separated manifest, Ticket-entry, DAG, rendered-document-set и full-set digests связываются с planning parent/candidate tree, alignment, protocol/runtime/project-instruction, schema/validator/renderer and mapping identities. Stable Kahn order, closed file/directory scope selectors, ordered-overlap rule, referential AC/evidence/governing refs and revision lineage fail closed.\n- Альтернатива: parse free-form Markdown, вести JSON и Markdown как две независимо редактируемые истины либо строить blockers из task titles/comments.\n- Обоснование: свободный текст не даёт воспроизводимого graph/recovery API; две редактируемые формы неизбежно расходятся. Canonical JSON даёт stable schema/errors/digests, а deterministic renderer сохраняет удобную human review surface без второго control plane.\n- Границы: #5 публикует artifact, #7 использует DAG/entry digests для execution bases, #8/#9 отвечают за delta/staging, #23/#24 — evidence bindings, #25 — semantic revision dispositions.\n- Источники: issue #6; `docs/contracts/tickets-manifest.md`; state machine `validate_tickets_manifest -> freeze_artifact -> Panel -> publish_artifact_pass -> dispatch_ticket_dag`.\n\n## Оставшиеся риски, не решения\n",
    "ADR-027 insertion",
)

# Contributing rules.
replace_once(
    "CONTRIBUTING.md",
    "A recorded planning verdict is not completion: `docs/contracts/epic-planning-ref.md` requires a verified host-owned descendant commit at the private Epic planning ref before `select_next`. Run `npm run validate:planning-ref` for changes touching this boundary.\n",
    "A recorded planning verdict is not completion: `docs/contracts/epic-planning-ref.md` requires a verified host-owned descendant commit at the private Epic planning ref before `select_next`. Run `npm run validate:planning-ref` for changes touching this boundary.\nTickets additionally follow `docs/contracts/tickets-manifest.md`: edit the canonical manifest model, regenerate deterministic Markdown views, and never treat prose as dispatcher authority. Run `npm run validate:tickets-manifest` for changes touching this boundary.\n",
    "CONTRIBUTING Tickets rule",
)

# Package and CI.
package_path = ROOT / "package.json"
package = json.loads(package_path.read_text(encoding="utf-8"))
package["scripts"]["validate:tickets-manifest"] = "node scripts/validate-tickets-manifest-design.mjs"
package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

replace_once(
    ".github/workflows/validate-traycer-parity.yml",
    "      - name: Validate Epic planning-ref design contract\n        run: npm run validate:planning-ref\n\n      - name: Validate pull-request file scope",
    "      - name: Validate Epic planning-ref design contract\n        run: npm run validate:planning-ref\n\n      - name: Validate canonical Tickets manifest design contract\n        run: npm run validate:tickets-manifest\n\n      - name: Validate pull-request file scope",
    "CI Tickets validation step",
)

print("Synchronized issue #6 contract across authoritative design files.")
