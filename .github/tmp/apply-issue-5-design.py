from __future__ import annotations

from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[2]


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one {label} marker, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def write_text(relative: str, content: str) -> None:
    path = ROOT / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


CONTRACT = r'''# Epic planning ref and commit-on-PASS contract

<!-- planning-ref-contract:v1 -->

Status: issue #5 design contract. It becomes an accepted input to the repository-wide design candidate only after the exact tree containing it passes the required review and is merged. Runtime implementation remains a separate release-blocking obligation.

## 1. Purpose

Every approved planning artifact must become reachable, ordered Git history before the workflow may draft the next artifact or dispatch Tickets. A model verdict, waiver, task comment, detached snapshot commit, or metadata flag alone is not a published planning result.

The Planned workflow therefore owns one private, append-only Git line per Epic:

```text
refs/autosk/epics/<epic-uuid>/planning
```

The ref is internal control-plane state. It is never the user's target branch and is never selected by a human-readable slug. `<epic-uuid>` is the canonical immutable Epic identifier already bound to `project_root_sha256`; the ref name is derived by a closed encoder and rejects traversal, ref metacharacters, Unicode ambiguity, case-fold collisions, or user-provided path fragments.

## 2. Non-goals

This contract does not:

- define the machine-readable Tickets schema; issue #6 owns it;
- define dependency composition; issue #7 owns it;
- define approved-delta application; issue #8 owns it;
- define private staging and final target promotion; issue #9 owns them;
- authorize a model to move refs;
- move, merge, rebase, reset, or force-update the user's target branch;
- turn Git into a second task-status ledger.

## 3. Terms

- **Planning base** — the exact commit OID recorded for the Epic before the first planning artifact. Issue #17 later defines how delivery policy selects and validates that target/base; until then the value is still immutable input, not the current branch name.
- **Planning ref** — the private ref above.
- **Planning head** — the commit currently referenced by the verified planning ref.
- **Artifact candidate** — an exact tree built from the current verified planning head plus only the declared artifact pathspec.
- **Recorded PASS** — a valid panel or waiver disposition stored by `record_artifact_pass`, but not yet published.
- **Published PASS** — a recorded PASS whose exact candidate tree is the tree of a verified descendant commit at the planning ref.
- **Planning publication** — the host-owned operation that creates the approved commit, advances the private ref with compare-and-swap, reads it back, and marks publication verified.
- **Planning invalidation** — a descendant commit that removes or replaces the current projection of artifacts invalidated by an approved anchor-impact decision while preserving their prior accepted bytes in ancestry.

Every use of “artifact passed” or “planning kind completed” in the Planned state machine means **Published PASS**, not merely a reviewer verdict.

## 4. Initialization

Planned intake executes:

```text
intake
→ init_planning_ref
→ select_next
```

`init_planning_ref` is deterministic host code.

It:

1. resolves the canonical repository and project identity;
2. validates that `planning_base_oid` is a commit in that repository;
3. derives the exact private ref from the immutable Epic UUID;
4. persists a `planning_ref_init_op` before a Git side effect;
5. creates the ref only with CAS from the all-zero OID to `planning_base_oid`;
6. reads back the ref, commit and tree;
7. records `planning.base_oid`, `planning.head_oid`, `planning.head_tree_oid`, `planning.generation=0` and `planning.init_status=verified`;
8. only then transitions to `select_next`.

Retry semantics:

- ref absent + valid prepared operation: perform the CAS;
- ref already equals the recorded base: verify and finish idempotently;
- ref exists at any other OID: `planning_ref_foreign_movement`;
- expected base missing, not a commit, from another object store, or bound to another project/Epic: `planning_ref_init_invalid`;
- no delete/recreate, reset, force update, or “adopt current ref” fallback is allowed.

Quick-flow does not create a planning ref. Quick→Planned replacement creates a new Planned Epic and initializes its ref from the replacement's recorded original base.

## 5. Authoring and freeze base

Each Brief, Core Flow, Tech Plan, Tickets, and later registered behavior-defining artifact author worktree is created from the current verified planning head.

Before author dispatch and again before freeze, host code proves:

```text
candidate.base_commit_oid == planning.head_oid
candidate.base_tree_oid   == planning.head_tree_oid
current planning ref      == planning.head_oid
```

The candidate tree must equal the planning-head tree plus only declared pathspec changes. Dirty, ignored-new, untracked, submodule, mode, symlink, case-normalization, or out-of-scope changes are handled by the existing fail-closed freeze rules.

Mismatch before candidate mint parks with `planning_candidate_base_stale`; no panel child or PASS record is created. If the ref changes after mint, the candidate and every verdict bound to it are stale.

## 6. State-machine boundary

The successful artifact cycle is:

```text
draft_artifact
→ freeze_artifact
→ full panel or permitted narrow review
→ record_artifact_pass
→ publish_artifact_pass
→ select_next
```

`record_artifact_pass` remains responsible for model/waiver validation and Arena/Tickets-specific semantic checks. On success it atomically:

1. writes `artifact_pass[kind]` with `publication_status=recorded_unpublished`;
2. binds the disposition to the exact candidate, alignment, anchor, protocol, runtime and verdict/waiver identity;
3. creates one immutable `planning_publication_op` in phase `prepared`;
4. records the deterministic commit recipe and expected commit OID;
5. transitions only to `publish_artifact_pass`.

It does **not**:

- set the kind to completed;
- clear the current artifact;
- close Tickets remediation;
- dispatch Arena or Tickets;
- move the target branch;
- transition directly to `select_next`.

`select_next` has a recovery-first guard: any current valid recorded PASS whose publication is not verified routes to `publish_artifact_pass`. It considers a kind complete only when the operation is verified and the live planning ref still equals its published commit.

## 7. Planning publication operation

The protected Epic metadata contains exactly one open operation:

```json
{
  "schema": 1,
  "operation_id": "uuid",
  "operation_type": "artifact_pass",
  "project_root_sha256": "sha256",
  "epic_id": "uuid",
  "planning_ref": "refs/autosk/epics/<uuid>/planning",
  "artifact_kind": "brief",
  "artifact_identity": "sha256",
  "artifact_pathspec_digest": "sha256",
  "anchor_version": 1,
  "protocol_digest": "sha256",
  "runtime_lock_digest": "sha256",
  "project_instruction_digest": "sha256-or-null",
  "alignment_identity": "sha256",
  "governance_mapping_set_digest": "sha256",
  "verdict_or_waiver_digest": "sha256",
  "expected_parent_oid": "git-oid",
  "expected_parent_tree_oid": "git-oid",
  "candidate_tree_oid": "git-oid",
  "commit_recipe_digest": "sha256",
  "expected_commit_oid": "git-oid",
  "phase": "prepared",
  "recorded_target_step": "select_next",
  "created_at_utc": "whole-second UTC",
  "receipts": {
    "commit_object": null,
    "ref_cas": null,
    "verification": null
  }
}
```

Closed phases:

```text
prepared
→ commit_created
→ ref_advanced
→ verified
```

Fields preceding `phase` are write-once. Receipts are monotonic, operation-bound and written only by deterministic host code under daemon workflow custody. A retry may advance a phase or reconstruct a missing receipt from exact Git observations; it may not change the recipe, expected parent, candidate tree, expected commit, operation type or target step.

Only one planning-ref operation may be open for an Epic. A second operation, an unknown phase, a mutable identity field, or conflicting operation ID parks with `planning_publication_invalid`.

## 8. Deterministic commit recipe

Before writing a commit object, phase `prepared` stores the complete recipe:

- repository object format discovered from Git; OIDs are not assumed to be 40 hex;
- tree = exact candidate tree;
- one parent = exact expected planning head;
- author/committer identity = host identity pinned for the Epic by project/delivery configuration, never the model process;
- author/committer timestamps = the operation's persisted whole-second timestamp and persisted timezone;
- UTF-8 commit message with fixed line endings;
- sorted, closed trailers containing project hash, Epic ID, artifact kind, artifact identity, anchor version, protocol/runtime/instruction digests, verdict-or-waiver digest and operation ID.

The host constructs canonical commit bytes and asks the repository's Git implementation to calculate the expected OID. The expected OID is persisted before object publication. Writing the same bytes after a crash yields the same object.

The commit has no merge parent and cannot include changes outside the candidate tree. Model output may supply a human summary, but that text is normalized and cannot change the closed identity trailers after `prepared`.

## 9. CAS and verification

`publish_artifact_pass` executes the following idempotent state machine.

| Observation | Action |
| --- | --- |
| phase=`prepared`, object absent, ref=expected parent | write exact commit object; verify OID; record `commit_created` |
| phase=`prepared`, expected object already exists | verify bytes/tree/parent/message; record `commit_created` |
| phase=`commit_created`, ref=expected parent | CAS ref from parent to expected commit; record `ref_advanced` |
| phase=`prepared|commit_created`, ref=expected commit | reconstruct a successful CAS receipt only after exact commit verification; record `ref_advanced` |
| phase=`ref_advanced`, ref=expected commit | verify ref, commit, parent, tree, trailers and all current controlling bindings; record `verified` |
| phase=`verified`, metadata finalization incomplete | repeat only read-back/finalization; never create another commit or move the ref |
| ref is neither expected parent nor expected commit | park `planning_ref_foreign_movement` |
| expected object exists with impossible recipe mismatch, required object is corrupt/missing after a claimed durable phase, or observation is indeterminate | park `planning_publication_corrupt` |
| candidate/alignment/anchor/protocol/runtime/instruction/verdict binding changed before CAS | void recorded PASS, keep audit history and route through the appropriate correction/alignment cycle |
| a new correction appears after CAS | do not rewind; complete verification, then process it as a new anchor impact and descendant invalidation |

The CAS uses an exact expected-old value. No fetch-and-retry against a new parent, force update, rebase, merge, cherry-pick, or branch-name inference is allowed.

After phase `verified`, host atomically records:

- `planning.head_oid=expected_commit_oid`;
- `planning.head_tree_oid=candidate_tree_oid`;
- `planning.generation += 1`;
- `artifact_pass[kind].publication_status=verified`;
- `artifact_pass[kind].published_commit_oid`;
- `artifact_pass[kind].publication_operation_id`;
- Tickets remediation closure only when the verified publication is the current approved Tickets set;
- `current_artifact=null`;
- next step `select_next`.

## 10. Anchor invalidation without history rewrite

An approved anchor-impact decision never resets the planning ref.

Before redrafting an affected planning artifact, `rebuild_anchor` prepares a `planning_publication_op` with:

```text
operation_type=anchor_invalidation
recorded_target_step=clarify_alignment | present_tickets_breakdown | draft_artifact
```

The candidate invalidation tree is based on the current verified planning head and removes or replaces only the exact current projections declared affected by the approved impact map. For the four v1 named artifacts, stale canonical files are removed from the current tree; their accepted bytes remain reachable in earlier planning commits. Issue #14 generalizes the per-artifact projection rule.

`publish_planning_invalidation` uses the same deterministic recipe, CAS and verification adapter. Only after its descendant commit is verified may redrafting begin. The private ref is never rewound or force-updated.

A new accepted version later publishes another descendant commit. History therefore shows:

```text
base
→ Brief v1 PASS
→ Core Flow v1 PASS
→ Tech Plan v1 PASS
→ approved invalidation of Core Flow/Tech Plan
→ Core Flow v2 PASS
→ Tech Plan v2 PASS
→ Tickets PASS
```

## 11. Relationship to downstream issues

- **Issue #6:** the verified Tickets publication commit contains the frozen human-readable Tickets and canonical manifest. Its OID becomes the final `planning_head` for that Tickets version.
- **Issue #7:** every Ticket execution base starts from that exact verified `planning_head`, then composes approved transitive predecessor deltas.
- **Issue #8:** Ticket code is later represented as an approved delta relative to its execution base; planning publication never uses Ticket delta integration.
- **Issue #9:** the private staging line starts from the verified planning head and applies approved Ticket deltas. The target branch remains unchanged until aggregate PASS and final authorization.
- **Issue #10:** runtime/workflow/schema/helper identity used by this operation is pinned and included in the operation binding.
- **Issue #14:** Artifact Registry supplies pathspec, invalidation projection and publication policy for additional behavior artifacts.
- **Issue #17:** delivery profile supplies the trusted target/base and host commit identity policy.
- **Issue #25:** requirement revision supplies the approved semantic impact map; this contract performs only the crash-safe Git publication.

## 12. Retention and cleanup

The planning ref and every commit/object referenced by:

- an active Epic;
- current planning head;
- artifact PASS;
- candidate/verdict;
- Ticket execution base;
- staging/integration operation;
- release/design attestation;
- unexpired audit policy

are retained and protected from cleanup.

Normal Ticket or Epic worktree cleanup does not delete the planning ref. Deletion is a separate operator-approved Housekeeping action after reference inventory and retention expiry. It leaves a tombstone with project/Epic/ref/final-head identity. Git GC must not make current or audit-required planning objects unreachable.

## 13. Required runtime tests

Implementation of issue #5 is release-blocking and must include at least:

1. initialize from an absent ref;
2. retry when the ref already equals the recorded base;
3. reject a pre-existing mismatched ref;
4. publish Brief → Core Flow → Tech Plan → Tickets as a strict first-parent chain;
5. prove each author/freeze base equals current planning head;
6. prove target ref is unchanged;
7. crash before/after operation persist, object write, phase write, CAS, CAS receipt, verification and metadata finalization;
8. recover when ref advanced but phase/receipt did not;
9. reject foreign movement before and after object creation;
10. reject wrong parent/tree/message/operation trailers;
11. detect candidate, protocol, runtime, instruction, alignment or verdict drift;
12. preserve objects through Git GC while the private ref exists;
13. publish a descendant invalidation and later replacement without ref rewind;
14. isolate two Epics in one repository and equal Epic slugs in two project roots;
15. cover SHA-1 and SHA-256 object formats where the supported Git matrix permits;
16. reject invalid ref components, case/Unicode collisions, symlinked repository boundaries and inherited Git environment;
17. produce identical outcome with one or many retries.

## 14. Acceptance mapping for issue #5

- one private ref per Planned Epic: sections 1, 4;
- reachable commit after each artifact PASS: sections 6–9;
- next artifact based on current ref: section 5;
- final verified planning head before Tickets: sections 9, 11;
- no target movement: sections 2, 9, 11;
- planning documents included in final staging: section 11;
- cleanup retention: section 12;
- crash, retry, CAS, foreign movement, rebuild and GC tests: sections 9, 10, 13.

This contract is normative together with the state machine in `03-technical-plan.md`. If a summary or diagram differs, this document and the canonical transition table govern until the repository-wide issue #39 candidate consolidates them.
'''

VALIDATOR = r'''#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CONTRACT_FILES = Object.freeze([
  "README.md",
  "01-core-flows.md",
  "02-architecture.md",
  "03-technical-plan.md",
  "04-decisions.md",
  "CONTRIBUTING.md",
  "docs/contracts/epic-planning-ref.md",
]);

const REQUIRED = Object.freeze({
  "README.md": [
    "docs/contracts/epic-planning-ref.md",
    "publish_artifact_pass",
    "refs/autosk/epics/<epic-uuid>/planning",
  ],
  "01-core-flows.md": [
    "<!-- planning-ref-contract:v1 -->",
    "record_artifact_pass",
    "publish_artifact_pass",
    "planning_ref_foreign_movement",
    "verified planning_head",
  ],
  "02-architecture.md": [
    "<!-- planning-ref-contract:v1 -->",
    "Planning publication adapter",
    "refs/autosk/epics/<epic-uuid>/planning",
    "planning_publication_op",
  ],
  "03-technical-plan.md": [
    "<!-- planning-ref-contract:v1 -->",
    "init_planning_ref",
    "publish_artifact_pass",
    "publish_planning_invalidation",
    "planning_publication_op",
    "recorded_unpublished",
    "planning_candidate_base_stale",
    "planning_ref_foreign_movement",
    "planning_publication_corrupt",
  ],
  "04-decisions.md": [
    "ADR-026: private Epic planning ref и commit-on-PASS",
    "refs/autosk/epics/<epic-uuid>/planning",
    "publish_artifact_pass",
  ],
  "CONTRIBUTING.md": [
    "docs/contracts/epic-planning-ref.md",
    "npm run validate:planning-ref",
  ],
  "docs/contracts/epic-planning-ref.md": [
    "<!-- planning-ref-contract:v1 -->",
    "prepared",
    "commit_created",
    "ref_advanced",
    "verified",
    "planning_ref_foreign_movement",
    "planning_publication_corrupt",
    "Issue #6",
    "Issue #7",
    "Issue #8",
    "Issue #9",
  ],
});

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function loadPlanningRefFiles(root = ROOT) {
  return Object.fromEntries(
    CONTRACT_FILES.map((relative) => [
      relative,
      readFileSync(path.join(root, relative), "utf8"),
    ]),
  );
}

export function validatePlanningRefDesign(files) {
  const errors = [];
  for (const relative of CONTRACT_FILES) {
    const text = files[relative];
    if (typeof text !== "string") {
      errors.push(`${relative}: missing`);
      continue;
    }
    for (const fragment of REQUIRED[relative]) {
      if (!text.includes(fragment)) errors.push(`${relative}: missing required fragment ${JSON.stringify(fragment)}`);
    }
  }

  const plan = files["03-technical-plan.md"] ?? "";
  const forbidden = [
    "record_artifact_pass | disposition=waived и signed panel waiver mode=full_skip exact current identity валиден | validate/merge Arena fields identically to pass; atomically artifact_pass[kind]={disposition:waived,identity,waiver_record_id,waiver_record_hash}; if kind=tickets and remediation phase=proposal_ready, verify new set digest and set phase=closed; select_next",
    "record_artifact_pass | disposition=pass, verdict binding текущей identity валиден; для tech_plan Arena block валиден | atomically artifact_pass[kind]={disposition:pass,identity,verdict_hash}, arena fields обновлены; if kind=tickets and remediation phase=proposal_ready, verify new set digest and set phase=closed; select_next",
  ];
  for (const fragment of forbidden) {
    if (plan.includes(fragment)) errors.push("03-technical-plan.md: direct record_artifact_pass → select_next transition remains");
  }

  const core = files["01-core-flows.md"] ?? "";
  if (!core.includes("recorded PASS не является завершённым артефактом")) {
    errors.push("01-core-flows.md: recorded-vs-published PASS distinction missing");
  }

  const contract = files["docs/contracts/epic-planning-ref.md"] ?? "";
  const phaseOrder = ["prepared", "commit_created", "ref_advanced", "verified"];
  let previous = -1;
  for (const phase of phaseOrder) {
    const current = contract.indexOf(phase);
    if (current < 0 || current <= previous) errors.push("planning publication phases are missing or not documented in monotonic order");
    previous = current;
  }

  return errors;
}

export function planningRefDesignDigest(files) {
  const payload = CONTRACT_FILES.map((relative) => `${relative}\0${sha256(files[relative] ?? "")}`).join("\0");
  return sha256(`autosk-flow/planning-ref-design/v1\0${payload}`);
}

function run() {
  const files = loadPlanningRefFiles();
  const errors = validatePlanningRefDesign(files);
  if (errors.length) {
    for (const error of errors) console.error(`ERROR: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`OK: planning-ref design contract v1; digest ${planningRefDesignDigest(files)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
'''

TEST = r'''import assert from "node:assert/strict";
import test from "node:test";

import {
  loadPlanningRefFiles,
  planningRefDesignDigest,
  validatePlanningRefDesign,
} from "../scripts/validate-planning-ref-design.mjs";

function fixture() {
  return structuredClone(loadPlanningRefFiles());
}

test("current planning-ref design contract is internally connected", () => {
  const files = fixture();
  assert.deepEqual(validatePlanningRefDesign(files), []);
  assert.match(planningRefDesignDigest(files), /^[0-9a-f]{64}$/u);
});

test("missing cross-document contract markers fail closed", () => {
  const files = fixture();
  files["03-technical-plan.md"] = files["03-technical-plan.md"].replace("planning_publication_op", "removed_operation");
  assert.match(validatePlanningRefDesign(files).join("\n"), /planning_publication_op/u);
});

test("direct record-artifact-pass to select-next regression is rejected", () => {
  const files = fixture();
  files["03-technical-plan.md"] += "\n| record_artifact_pass | disposition=pass, verdict binding текущей identity валиден; для tech_plan Arena block валиден | atomically artifact_pass[kind]={disposition:pass,identity,verdict_hash}, arena fields обновлены; if kind=tickets and remediation phase=proposal_ready, verify new set digest and set phase=closed; select_next |\n";
  assert.match(validatePlanningRefDesign(files).join("\n"), /direct record_artifact_pass/u);
});

test("publication phase documentation is monotonic", () => {
  const files = fixture();
  files["docs/contracts/epic-planning-ref.md"] = files["docs/contracts/epic-planning-ref.md"].replace(
    "prepared\n→ commit_created\n→ ref_advanced\n→ verified",
    "verified\n→ ref_advanced\n→ commit_created\n→ prepared",
  );
  assert.match(validatePlanningRefDesign(files).join("\n"), /monotonic order/u);
});

test("recorded and published PASS distinction is required", () => {
  const files = fixture();
  files["01-core-flows.md"] = files["01-core-flows.md"].replace(
    "recorded PASS не является завершённым артефактом",
    "PASS distinction removed",
  );
  assert.match(validatePlanningRefDesign(files).join("\n"), /recorded-vs-published/u);
});
'''

write_text("docs/contracts/epic-planning-ref.md", CONTRACT)
write_text("scripts/validate-planning-ref-design.mjs", VALIDATOR)
write_text("test/validate-planning-ref-design.test.mjs", TEST)

# README
readme = ROOT / "README.md"
replace_once(
    readme,
    "- привязку PASS к точной версии артефакта или Git tree OID;\n",
    "- привязку PASS к точной версии артефакта или Git tree OID;\n"
    "- публикацию каждого утверждённого планового артефакта в приватную per-Epic Git-линию до продолжения workflow;\n",
    "README goal bullet",
)
replace_once(
    readme,
    "16. Операционная truth защищена daemon workflow custody: model sessions не получают `.autosk`, task/comment/metadata/refs или raw CLI. Host writes требуют step-bound capability + expected protected metadata head; gate outcomes — write-once daemon receipts под result head. Preflight требует одновременно ADR-014 creation identity, ADR-023 authority/intent и ADR-025 custody; без любого model workflow не запускается.\n\n## Состав пакета",
    "16. Операционная truth защищена daemon workflow custody: model sessions не получают `.autosk`, task/comment/metadata/refs или raw CLI. Host writes требуют step-bound capability + expected protected metadata head; gate outcomes — write-once daemon receipts под result head. Preflight требует одновременно ADR-014 creation identity, ADR-023 authority/intent и ADR-025 custody; без любого model workflow не запускается.\n"
    "17. Planning verdict не завершает артефакт сам по себе. `record_artifact_pass` создаёт recorded-unpublished binding и durable operation; только host-owned `publish_artifact_pass` может CAS-продвинуть `refs/autosk/epics/<epic-uuid>/planning`, проверить descendant commit/tree и разрешить `select_next`. Target branch при этом не меняется.\n\n## Состав пакета",
    "README canonical rule",
)
replace_once(
    readme,
    "- [04-decisions.md](04-decisions.md) — предлагаемые ADR и оставшиеся риски; статус станет accepted только после решения пользователя и PASS панели.\n",
    "- [04-decisions.md](04-decisions.md) — предлагаемые ADR и оставшиеся риски; статус станет accepted только после решения пользователя и PASS панели.\n"
    "- [docs/contracts/epic-planning-ref.md](docs/contracts/epic-planning-ref.md) — нормативный контракт private planning ref, commit-on-PASS, CAS и crash recovery для issue #5.\n",
    "README package list",
)
replace_once(
    readme,
    "## Реестр миграционного паритета\n",
    "## Контракт Epic planning ref\n\n"
    "`docs/contracts/epic-planning-ref.md` фиксирует issue #5: Planned Epic создаёт приватный `refs/autosk/epics/<epic-uuid>/planning`, каждый approved artifact публикуется отдельным first-parent descendant commit, а `select_next` видит kind завершённым только после read-back verified CAS. Recorded verdict/waiver без публикации не является planning PASS. Anchor rebuild не rewinds ref и использует descendant invalidation commit; target branch остаётся неизменной до будущего staging/final-CAS contract issues #8–#9.\n\n"
    "Проверка связи design-документов:\n\n"
    "```text\nnpm run validate:planning-ref\n```\n\n"
    "## Реестр миграционного паритета\n",
    "README planning-ref section",
)

# Core flows
core = ROOT / "01-core-flows.md"
replace_once(
    core,
    "  -> Brief?       -> human framing alignment -> draft -> four-model panel -> fix -> narrow re-review\n"
    "  -> Core Flow?   -> human behavior alignment -> draft -> four-model panel -> fix -> narrow re-review\n"
    "  -> Tech Plan    -> human readiness alignment -> draft -> four-model panel -> fix -> narrow re-review\n"
    "  -> Arena?       -> candidates -> Judge recommendation -> human readiness alignment\n"
    "                  -> Decision Record / changed Tech Plan -> new full four-model panel\n"
    "  -> Tickets      -> draft + dependency view -> human breakdown alignment\n"
    "                  -> separate four-model panel -> fix -> narrow re-review\n"
    "  -> ticket DAG execution",
    "  -> Brief?       -> human framing alignment -> draft -> panel/fix/re-review -> record PASS -> publish planning commit\n"
    "  -> Core Flow?   -> human behavior alignment -> draft -> panel/fix/re-review -> record PASS -> publish planning commit\n"
    "  -> Tech Plan    -> human readiness alignment -> draft -> panel/fix/re-review -> record PASS -> publish planning commit\n"
    "  -> Arena?       -> candidates -> Judge recommendation -> human readiness alignment\n"
    "                  -> Decision Record / changed Tech Plan -> new full panel -> publish planning commit\n"
    "  -> Tickets      -> draft + dependency view -> human breakdown alignment\n"
    "                  -> separate panel/fix/re-review -> record PASS -> publish planning commit\n"
    "  -> verified planning_head\n"
    "  -> ticket DAG execution",
    "core planning graph",
)
replace_once(
    core,
    "Весь комплект Tickets проходит отдельную четырёхмодельную панель. Панель проверяет и каждый Ticket, и согласованность набора.\n\n### Согласование решений человеком",
    "Весь комплект Tickets проходит отдельную четырёхмодельную панель. Панель проверяет и каждый Ticket, и согласованность набора.\n\n"
    "### Публикация утверждённых артефактов в planning ref\n\n"
    "<!-- planning-ref-contract:v1 -->\n\n"
    "У каждого Planned Epic есть одна приватная append-only линия `refs/autosk/epics/<epic-uuid>/planning`. Она инициализируется exact recorded base до первого planning draft. Каждый следующий author worktree строится только от verified head этой линии.\n\n"
    "После panel/narrow verdict `record_artifact_pass` ещё не завершает kind: он записывает `publication_status=recorded_unpublished` и immutable `planning_publication_op`. Детерминированный host step `publish_artifact_pass` создаёт single-parent commit с exact candidate tree, CAS-продвигает planning ref от ожидаемого parent, перечитывает ref/commit/tree/identity и только затем ставит publication `verified` и возвращает workflow в `select_next`. Поэтому recorded PASS не является завершённым артефактом до Git publication.\n\n"
    "Если process падает между object write, phase write, CAS, receipt или metadata finalization, retry продолжает ту же operation и тот же expected commit OID. Ref, отличный от expected parent и expected commit, считается foreign movement и паркует Epic с `planning_ref_foreign_movement`; rebase/reset/force/adopt-current запрещены. Candidate, созданный не от current verified head, получает `planning_candidate_base_stale` до panel.\n\n"
    "Anchor rebuild не перемещает ref назад. Approved impact сначала публикует descendant invalidation commit через тот же CAS adapter, затем новые версии артефактов становятся следующими descendants. Прежние accepted bytes остаются в ancestry, но stale projection не остаётся current. После verified Tickets publication полученный commit становится `planning_head`, от которого issue #7 построит Ticket execution bases, а issue #9 — private staging. Пользовательская target branch на этой стадии не меняется.\n\n"
    "Полный нормативный контракт, operation schema, recovery table, retention и test matrix находятся в `docs/contracts/epic-planning-ref.md`.\n\n"
    "### Согласование решений человеком",
    "core planning publication section",
)

# Architecture
architecture = ROOT / "02-architecture.md"
replace_once(
    architecture,
    "- атомарную запись artifact PASS и механическое извлечение autosk-arena block;\n"
    "- привязку PASS к hash/OID;\n",
    "- запись валидированного artifact verdict как `recorded_unpublished` и механическое извлечение autosk-arena block;\n"
    "- host-owned и crash-safe публикацию approved artifact commit в private Epic planning ref;\n"
    "- привязку PASS к hash/OID и verified planning-head CAS receipt;\n",
    "architecture extension responsibilities",
)
replace_once(
    architecture,
    "### Git\n\n"
    "Хранит нормативные артефакты и код. Git object database даёт tree/commit OID для неизменяемой идентичности. Branch name никогда не считается идентичностью.\n\n"
    "### autosk-owned integration adapter",
    "### Git\n\n"
    "Хранит нормативные артефакты и код. Git object database даёт tree/commit OID для неизменяемой идентичности. Branch name никогда не считается идентичностью.\n\n"
    "Каждый Planned Epic владеет private append-only ref `refs/autosk/epics/<epic-uuid>/planning`. Его verified head — единственная текущая Git-проекция принятых planning artifacts; detached snapshot object и metadata verdict без ref publication недостаточны. Ref создаёт и CAS-продвигает только deterministic host adapter. Target branch, другие Epic refs и refs другого canonical project root не затрагиваются.\n\n"
    "### Planning publication adapter\n\n"
    "<!-- planning-ref-contract:v1 -->\n\n"
    "Общий adapter обслуживает `init_planning_ref`, `publish_artifact_pass` и `publish_planning_invalidation`. Он строит object-format-aware deterministic commit recipe, пишет exact commit object, выполняет expected-old CAS private ref, читает ref/commit/tree обратно и монотонно продвигает `planning_publication_op` через `prepared -> commit_created -> ref_advanced -> verified`. Model process не получает ref capability. Foreign/indeterminate movement не ретраится как обычная ошибка и не разрешается rebase/reset/force fallback.\n\n"
    "### autosk-owned integration adapter",
    "architecture Git planning adapter",
)
replace_once(
    architecture,
    "- Brief, Core Flow, Tech Plan, Decision Log и Tickets;\n"
    "- task metadata, blockers, comments и sessions;\n",
    "- Brief, Core Flow, Tech Plan, Decision Log и Tickets;\n"
    "- private per-Epic planning refs и reachable publication/invalidation commits;\n"
    "- task metadata, blockers, comments и sessions;\n",
    "architecture project ownership",
)
replace_once(
    architecture,
    "Создаются только нужные файлы. Статусы выполнения и PASS в эти документы не записываются: это предотвратит рассинхронизацию нормативных текстов с autosk.\n",
    "Текущая принятая проекция этих файлов определяется verified head `refs/autosk/epics/<epic-uuid>/planning`. Каждый artifact PASS получает отдельный single-parent descendant commit; следующий author base обязан совпадать с этим head. Detached snapshot commit остаётся review identity, но не считается опубликованным. Anchor invalidation создаёт новый descendant commit, а не rewrites history. Final Tickets publication фиксирует exact `planning_head` для downstream execution/staging.\n\n"
    "Создаются только нужные файлы. Статусы выполнения и PASS в эти документы не записываются: это предотвратит рассинхронизацию нормативных текстов с autosk.\n",
    "architecture normative Git truth",
)
replace_once(
    architecture,
    "Дополнительный task/status-ledger не создаётся. Trusted client only displays/signs exact challenge.",
    "`planning_ref_init_op` и `planning_publication_op` живут в protected namespaced Epic metadata и содержат только operation identity, expected Git observations, phases и receipts. Они не дублируют содержание артефактов или task status. Git ref/object database остаётся source of truth для опубликованной planning line; metadata связывает её с workflow state.\n\n"
    "Дополнительный task/status-ledger не создаётся. Trusted client only displays/signs exact challenge.",
    "architecture operation storage",
)
replace_once(
    architecture,
    "artifact identity =\n"
    "  project identity\n"
    "  + epic id\n"
    "  + artifact kind\n"
    "  + base commit OID\n",
    "artifact identity =\n"
    "  project identity\n"
    "  + epic id\n"
    "  + artifact kind\n"
    "  + private planning ref name\n"
    "  + expected verified planning head OID\n"
    "  + base commit OID\n",
    "architecture artifact identity",
)

# Technical plan
plan = ROOT / "03-technical-plan.md"
replace_once(
    plan,
    "intake\n -> select_next",
    "intake\n -> init_planning_ref -> select_next",
    "planned workflow initialization",
)
replace_once(
    plan,
    "artifact full panel:\n"
    "  draft_artifact -> draft_artifact | freeze_artifact -> dispatch_panel\n"
    "  -> panel_join -> synthesize_panel -> record_artifact_pass",
    "artifact full panel:\n"
    "  draft_artifact -> draft_artifact | freeze_artifact -> dispatch_panel\n"
    "  -> panel_join -> synthesize_panel -> record_artifact_pass -> publish_artifact_pass",
    "full panel publication path",
)
replace_once(
    plan,
    "artifact fix:\n"
    "  synthesize_panel -> fix_artifact -> freeze_artifact\n"
    "  -> dispatch_narrow_review -> narrow_review_join\n"
    "  -> record_artifact_pass",
    "artifact fix:\n"
    "  synthesize_panel -> fix_artifact -> freeze_artifact\n"
    "  -> dispatch_narrow_review -> narrow_review_join\n"
    "  -> record_artifact_pass -> publish_artifact_pass",
    "narrow publication path",
)
replace_once(
    plan,
    "recovery:\n"
    "  prepare_anchor_impact -> await_anchor_impact_approval (human)\n"
    "  -> record_anchor_impact_approval -> rebuild_anchor\n"
    "  rebuild_anchor -> clarify_alignment | present_tickets_breakdown | draft_artifact | dispatch_arena | select_next | resume_repaired_tickets | ticket_join | human",
    "recovery:\n"
    "  prepare_anchor_impact -> await_anchor_impact_approval (human)\n"
    "  -> record_anchor_impact_approval -> rebuild_anchor\n"
    "  rebuild_anchor -> publish_planning_invalidation | clarify_alignment | present_tickets_breakdown | draft_artifact | dispatch_arena | select_next | resume_repaired_tickets | ticket_join | human\n"
    "  init_planning_ref -> select_next | human\n"
    "  publish_artifact_pass -> select_next | human\n"
    "  publish_planning_invalidation -> recorded rebuild target | human",
    "planned recovery graph",
)
replace_once(
    plan,
    "| intake | classification валиден | select_next |\n",
    "| intake | classification валиден и workflow=autosk-planned | init_planning_ref |\n"
    "| init_planning_ref | prepared init operation отсутствует, exact planning base/ref/project binding невалидны | human с park.reason=planning_ref_init_invalid; Git side effects отсутствуют |\n"
    "| init_planning_ref | ref отсутствует либо уже равен recorded planning base и init operation binding валиден | persist exact operation before side effect; CAS create from zero OID when absent; read-back commit/tree/ref; atomically planning.init_status=verified/head=base/generation=0; select_next |\n"
    "| init_planning_ref | ref существует на OID, отличном от recorded base | human с park.reason=planning_ref_foreign_movement; reset/delete/adopt запрещены |\n",
    "planned intake transitions",
)
replace_once(
    plan,
    "| select_next | `aggregate_remediation.phase != closed` | record_aggregate_remediation; recorded prefix продолжается, old/partial new Tickets не dispatch'ятся |\n",
    "| select_next | `aggregate_remediation.phase != closed` | record_aggregate_remediation; recorded prefix продолжается, old/partial new Tickets не dispatch'ятся |\n"
    "| select_next | current artifact PASS/waiver имеет publication_status=recorded_unpublished либо open matching planning_publication_op phase != verified | publish_artifact_pass; kind ещё не завершён |\n",
    "select-next publication recovery",
)
replace_once(
    plan,
    "| draft_artifact | provider/model недоступен после retry | human с park.reason=artifact_draft_provider_unavailable |\n",
    "| draft_artifact | current author worktree/base OID или live private planning ref не равны verified planning.head_oid/tree | human с park.reason=planning_candidate_base_stale; provider не вызывается, candidate/PASS отсутствуют |\n"
    "| draft_artifact | provider/model недоступен после retry | human с park.reason=artifact_draft_provider_unavailable |\n",
    "draft planning base guard",
)
replace_once(
    plan,
    "| freeze_artifact | alignment отсутствует/stale либо recomputed material manifest/projector/classifier не совпадает с current identity | human с park.reason=alignment_record_stale; Brief/Core Flow/Tech Plan возвращаются в clarify_alignment, Tickets — в present_tickets_breakdown |\n",
    "| freeze_artifact | alignment отсутствует/stale либо recomputed material manifest/projector/classifier не совпадает с current identity | human с park.reason=alignment_record_stale; Brief/Core Flow/Tech Plan возвращаются в clarify_alignment, Tickets — в present_tickets_breakdown |\n"
    "| freeze_artifact | candidate.base_oid/base_tree или live planning ref не совпадают с verified planning head | human с park.reason=planning_candidate_base_stale; panel child/PASS не создаются |\n",
    "freeze planning base guard",
)
replace_once(
    plan,
    "| record_artifact_pass | disposition=waived и signed panel waiver mode=full_skip exact current identity валиден | validate/merge Arena fields identically to pass; atomically artifact_pass[kind]={disposition:waived,identity,waiver_record_id,waiver_record_hash}; if kind=tickets and remediation phase=proposal_ready, verify new set digest and set phase=closed; select_next |\n",
    "| record_artifact_pass | disposition=waived и signed panel waiver mode=full_skip exact current identity валиден | validate/merge Arena fields identically to pass; atomically artifact_pass[kind]={disposition:waived,identity,waiver_record_id,waiver_record_hash,publication_status:recorded_unpublished}; create immutable planning_publication_op phase=prepared with exact recipe/OID; publish_artifact_pass |\n",
    "waived record publication",
)
replace_once(
    plan,
    "| record_artifact_pass | disposition=pass, verdict binding текущей identity валиден; для tech_plan Arena block валиден | atomically artifact_pass[kind]={disposition:pass,identity,verdict_hash}, arena fields обновлены; if kind=tickets and remediation phase=proposal_ready, verify new set digest and set phase=closed; select_next |\n",
    "| record_artifact_pass | disposition=pass, verdict binding текущей identity валиден; для tech_plan Arena block валиден | atomically artifact_pass[kind]={disposition:pass,identity,verdict_hash,publication_status:recorded_unpublished}, arena fields обновлены; create immutable planning_publication_op phase=prepared with exact recipe/OID; publish_artifact_pass |\n"
    "| publish_artifact_pass | open operation absent/multiple, identity/recipe/expected parent/tree/OID changed, unknown phase or another planning operation open | human с park.reason=planning_publication_invalid; ref movement отсутствует |\n"
    "| publish_artifact_pass | phase=prepared and ref=expected parent | write/verify exact deterministic commit object; atomically phase=commit_created; publish_artifact_pass |\n"
    "| publish_artifact_pass | phase=prepared|commit_created and ref=expected commit with exact object bytes | reconstruct monotonic receipt, atomically phase=ref_advanced; publish_artifact_pass |\n"
    "| publish_artifact_pass | phase=commit_created and ref=expected parent | expected-old CAS to expected commit; read ref; atomically phase=ref_advanced; publish_artifact_pass |\n"
    "| publish_artifact_pass | ref neither expected parent nor expected commit | human с park.reason=planning_ref_foreign_movement; no reset/rebase/force/adopt fallback |\n"
    "| publish_artifact_pass | claimed durable object/ref phase missing, corrupt or indeterminate | human с park.reason=planning_publication_corrupt; operation remains open for explicit recovery |\n"
    "| publish_artifact_pass | phase=ref_advanced and ref/commit/parent/tree/trailers/current bindings exact | atomically phase=verified, planning head/tree/generation, artifact_pass publication_status=verified/published_commit_oid/op_id; close current Tickets remediation only here; current_artifact=null; select_next |\n"
    "| publish_artifact_pass | phase=verified and final metadata/transition incomplete | read-back same commit/ref, finalize only missing monotonic projection, select_next |\n",
    "pass record and publication transitions",
)
replace_once(
    plan,
    "| rebuild_anchor | affected planning kinds не пусты | bump anchor, re-bind unchanged unaffected passes/alignments только по exact daemon-attributed impact approval, void affected bindings и alignment records, current kind=earliest affected, current_cycle full required, clarify_alignment; для affected Tickets после proposal — present_tickets_breakdown |\n",
    "| rebuild_anchor | affected planning kinds не пусты | bump anchor, re-bind unchanged unaffected passes/alignments только по exact daemon-attributed impact approval, void affected bindings/alignment records; prepare descendant planning_publication_op type=anchor_invalidation from current verified head with exact affected projection and recorded next target; publish_planning_invalidation |\n"
    "| publish_planning_invalidation | operation invalid, ref foreign, object/receipt corrupt or affected projection differs from approved impact | human с planning_publication_invalid, planning_ref_foreign_movement или planning_publication_corrupt; no rewind/force |\n"
    "| publish_planning_invalidation | same object/CAS/read-back phases verified | atomically planning head/tree/generation updated, invalidation op closed, current kind=earliest affected/current_cycle full required; recorded target clarify_alignment либо present_tickets_breakdown |\n",
    "anchor planning invalidation",
)
replace_once(
    plan,
    "Строки каждого шага применяются строго сверху вниз; predicates взаимно исключаются и явно закрывают unmatched state. select_next считает kind завершённым только если artifact_pass disposition=pass|waived и binding совпадает с current anchor/protocol/artifact/alignment identity; waived branch дополнительно re-resolves authority.",
    "Строки каждого шага применяются строго сверху вниз; predicates взаимно исключаются и явно закрывают unmatched state. select_next считает kind завершённым только если artifact_pass disposition=pass|waived, publication_status=verified, published commit/tree совпадают с live private planning ref/head и binding совпадает с current anchor/protocol/runtime/instruction/artifact/alignment identity; waived branch дополнительно re-resolves authority.",
    "select-next completion definition",
)
replace_once(
    plan,
    "### autosk-quick\n",
    "### Epic planning ref и commit-on-PASS\n\n"
    "<!-- planning-ref-contract:v1 -->\n\n"
    "Полный нормативный контракт находится в `docs/contracts/epic-planning-ref.md`. Planned Epic имеет private append-only `refs/autosk/epics/<epic-uuid>/planning`; `init_planning_ref` CAS-создаёт его от immutable planning base. Каждый planning candidate обязан иметь base=current verified head. `record_artifact_pass` сохраняет только recorded-unpublished disposition и immutable recipe; `publish_artifact_pass` создаёт exact single-parent commit, expected-old CAS-продвигает ref и read-back проверяет commit/tree/parent/trailers до `verified`. Target ref не меняется.\n\n"
    "`planning_publication_op` имеет operation_type=`artifact_pass|anchor_invalidation`, write-once identity/recipe, phases `prepared -> commit_created -> ref_advanced -> verified`, exact expected parent/tree/commit and monotonic receipts. Ref at expected commit after crash is accepted only after full object verification; any other movement parks `planning_ref_foreign_movement`. Missing/corrupt claimed durable state parks `planning_publication_corrupt`. No rebase/reset/force/cherry-pick/adopt-current recovery exists.\n\n"
    "Anchor rebuild first publishes a descendant invalidation through `publish_planning_invalidation`; only then may it redraft. Previous accepted bytes remain ancestry, stale projections are removed from the current tree, and later accepted versions append descendants. Verified Tickets publication supplies `planning_head` to issues #6–#9.\n\n"
    "### autosk-quick\n",
    "technical planning section",
)
replace_once(
    plan,
    "      artifact-identity.ts\n"
    "      record-artifact-pass.ts\n",
    "      artifact-identity.ts\n"
    "      planning-ref.ts\n"
    "      planning-publication.ts\n"
    "      record-artifact-pass.ts\n",
    "extension structure planning modules",
)
replace_once(
    plan,
    "      quick-handoff.ts\n"
    "      metadata.ts\n",
    "      quick-handoff.ts\n"
    "      planning-publication.ts\n"
    "      metadata.ts\n",
    "schema structure planning module",
)
replace_once(
    plan,
    "    \"epic_id\": \"epic-001\",\n"
    "    \"correlation_id\": null,\n"
    "    \"session\": {",
    "    \"epic_id\": \"epic-001\",\n"
    "    \"correlation_id\": null,\n"
    "    \"planning\": {\n"
    "      \"ref\": \"refs/autosk/epics/<epic-uuid>/planning\",\n"
    "      \"base_oid\": \"...\",\n"
    "      \"head_oid\": \"...\",\n"
    "      \"head_tree_oid\": \"...\",\n"
    "      \"generation\": 0,\n"
    "      \"init_status\": \"verified\",\n"
    "      \"init_operation\": null,\n"
    "      \"publication_operation\": null\n"
    "    },\n"
    "    \"session\": {",
    "Epic planning metadata",
)
replace_once(
    plan,
    "`artifact_pass[kind]` — historical field name с closed `disposition=pass|waived`: обе ветви связывают current artifact/alignment identity, но первая содержит verdict hash/roster, вторая — signed waiver record ID/hash и никогда не называется model PASS. Code review аналогично хранит `status=pass|waived` с взаимоисключающими verdict/waiver bindings.",
    "`artifact_pass[kind]` — historical field name с closed `disposition=pass|waived`: обе ветви связывают current artifact/alignment identity, но первая содержит verdict hash/roster, вторая — signed waiver record ID/hash и никогда не называется model PASS. Обе сначала имеют `publication_status=recorded_unpublished`; kind не completed. Только matching `planning_publication_op` phase=verified добавляет `published_commit_oid`, `publication_operation_id` и status=verified after exact live-ref read-back. Code review аналогично хранит `status=pass|waived` с взаимоисключающими verdict/waiver bindings, но не использует planning publication.",
    "artifact pass metadata semantics",
)
replace_once(
    plan,
    "Every freeze, reviewer dispatch/join, record_artifact_pass/record_code_verdict, commit_on_pass and integration recomputes it;",
    "Every freeze, reviewer dispatch/join, record_artifact_pass/publish_artifact_pass/record_code_verdict, commit_on_pass and integration recomputes it;",
    "mapping recomputation publication",
)

# Decisions
decisions = ROOT / "04-decisions.md"
replace_once(
    decisions,
    "- Решение: planning verdict связан с artifact snapshot; artifact/code candidate identity напрямую включает ordered `governance_mapping_set_digest` exact tree, отдельно от parent-derived controlling anchor. Code verdict также связан с base/pathspec/tree OID/anchor/controlling_anchor_digest/attempt и daemon gate-result receipt ID/hash/result head. Freeze, record_artifact_pass/record_code_verdict и commit/integration recompute mapping digest; drift voids verdict до side effect. До branch CAS host фиксирует exact commit recipe/OID; recovery accepts only that OID/parent/recipe.",
    "- Решение: planning verdict связан с artifact snapshot; artifact/code candidate identity напрямую включает ordered `governance_mapping_set_digest` exact tree, отдельно от parent-derived controlling anchor. Code verdict также связан с base/pathspec/tree OID/anchor/controlling_anchor_digest/attempt и daemon gate-result receipt ID/hash/result head. Freeze, record_artifact_pass/publish_artifact_pass/record_code_verdict и commit/integration recompute mapping digest; drift voids verdict до side effect. До branch CAS host фиксирует exact commit recipe/OID; recovery accepts only that OID/parent/recipe.",
    "ADR-010 publication recompute",
)
replace_once(
    decisions,
    "## Оставшиеся риски, не решения\n",
    "## ADR-026: private Epic planning ref и commit-on-PASS\n\n"
    "- Решение: каждый Planned Epic создаёт private append-only `refs/autosk/epics/<epic-uuid>/planning` от immutable planning base. Artifact verdict/waiver сначала получает status recorded_unpublished. Host-only `publish_artifact_pass` строит object-format-aware deterministic single-parent commit, expected-old CAS-продвигает ref и read-back проверяет exact parent/tree/trailers/current bindings; только phase=verified завершает kind и разрешает select_next. Anchor invalidation также публикуется descendant commit через тот же adapter; rewind/reset/force/rebase/adopt-current запрещены.\n"
    "- Альтернатива: считать detached snapshot или metadata PASS достаточным; коммитить все planning docs одним commit в конце; двигать target после каждого PASS; при correction возвращать private ref назад.\n"
    "- Обоснование: detached objects могут стать unreachable, dirty worktree смешивает артефакты, следующий author не имеет однозначной базы, а crash между object write и ref/metadata создаёт ambiguous outcome. Append-only planning line даёт reachable ordered history, exact `planning_head` для Tickets/staging и идемпотентное recovery без движения пользовательской ветки.\n"
    "- Recovery: protected `planning_publication_op` имеет write-once recipe и phases `prepared -> commit_created -> ref_advanced -> verified`. Ref at expected commit after crash принимается только после byte/tree/parent verification; иной OID — `planning_ref_foreign_movement`, corrupt/indeterminate durable state — `planning_publication_corrupt`.\n"
    "- Границы: issue #6 определяет Tickets manifest, #7 dependency bases, #8 approved deltas, #9 staging/final CAS, #14 generic artifact projection, #17 base/delivery policy, #25 semantic revision ordering.\n"
    "- Источники:\n"
    "  - issue #5;\n"
    "  - `docs/contracts/epic-planning-ref.md`;\n"
    "  - 01-core-flows.md, раздел «Публикация утверждённых артефактов в planning ref»;\n"
    "  - 03-technical-plan.md, steps `init_planning_ref`, `publish_artifact_pass`, `publish_planning_invalidation`.\n\n"
    "## Оставшиеся риски, не решения\n",
    "ADR-026 insertion",
)

# Contributing
contributing = ROOT / "CONTRIBUTING.md"
replace_once(
    contributing,
    "This repository starts from an approved design specification. Implementation work must preserve the gates and invariants defined in `03-technical-plan.md`.",
    "This repository contains a revision-in-progress design specification. Historical reviewed trees remain audit evidence, but only the future issue #39 candidate will authorize implementation decomposition. Changes must preserve the current gates and invariants defined in `03-technical-plan.md` and the linked normative contracts.",
    "contributing status",
)
replace_once(
    contributing,
    "Changing any bound field invalidates the prior PASS and requires a new four-model panel before implementation, except for the explicit hash-checked, human-approved re-binding defined in `03-technical-plan.md`.\n",
    "Changing any bound field invalidates the prior PASS and requires a new four-model panel before implementation, except for the explicit hash-checked, human-approved re-binding defined in `03-technical-plan.md`.\n"
    "A recorded planning verdict is not completion: `docs/contracts/epic-planning-ref.md` requires a verified host-owned descendant commit at the private Epic planning ref before `select_next`. Run `npm run validate:planning-ref` for changes touching this boundary.\n",
    "contributing planning publication",
)
replace_once(
    contributing,
    "The repository currently contains the approved specification only. Build, test, and installation commands will be documented when the implementation skeleton is introduced.",
    "The repository currently contains a revision-in-progress specification plus design validators. Runtime build and installation commands will be documented only after issue #39 approves the consolidated implementation-ready candidate.",
    "contributing current phase",
)

# package.json
package_path = ROOT / "package.json"
package = json.loads(package_path.read_text(encoding="utf-8"))
scripts = package["scripts"]
if "validate:planning-ref" in scripts:
    raise SystemExit("package.json already has validate:planning-ref")
new_scripts = {}
for key, value in scripts.items():
    new_scripts[key] = value
    if key == "validate:capabilities":
        new_scripts["validate:planning-ref"] = "node scripts/validate-planning-ref-design.mjs"
package["scripts"] = new_scripts
package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

# CI
workflow = ROOT / ".github/workflows/validate-traycer-parity.yml"
replace_once(
    workflow,
    "      - name: Validate program capability matrix\n"
    "        run: npm run validate:capabilities\n\n"
    "      - name: Validate pull-request file scope",
    "      - name: Validate program capability matrix\n"
    "        run: npm run validate:capabilities\n\n"
    "      - name: Validate Epic planning-ref design contract\n"
    "        run: npm run validate:planning-ref\n\n"
    "      - name: Validate pull-request file scope",
    "CI planning validation step",
)

print("Applied issue #5 design contract and validators.")
